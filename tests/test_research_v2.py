from __future__ import annotations

import json
import tempfile
import unittest
import io
import urllib.error
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import planning_store, research_v2


class FakeWorkspace:
    def __init__(self, identity, status="unread"):
        self.id = identity
        self.values = {
            "item": {"status": status, "tags": []},
            "paper": {"meta": {"pages": []}},
            "job": {"state": "idle"},
        }

    def load(self, name):
        return self.values.get(name)

    def patch_item(self, fields):
        self.values["item"].update(fields)
        return self.values["item"]


class FakeLibrary:
    def __init__(self, root):
        self.root = root
        self.workspaces = {}
        self.fetch_result = (b"%PDF-test", "test.pdf", {})

    def list(self):
        return [dict(ws.values["item"], id=ws.id) for ws in self.workspaces.values()]

    def all(self):
        return list(self.workspaces.values())

    def ws(self, identity):
        return self.workspaces.get(identity)

    def fetch(self, ref):
        if isinstance(self.fetch_result, Exception):
            raise self.fetch_result
        return self.fetch_result

    def create_from_pdf(self, data, filename, metadata):
        ws = FakeWorkspace("imported-paper")
        ws.values["paper"]["meta"]["pages"] = []
        ws.values["paper"]["meta"].update(metadata)
        self.workspaces[ws.id] = ws
        return ws, True


class ResearchV2Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.lib = FakeLibrary(self.root)
        self.app = SimpleNamespace(lib=self.lib, jobs=SimpleNamespace(enqueue=mock.Mock()))
        planning_store.init(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_five_builtin_states_and_custom_state_deletion_moves_both_record_types(self):
        builtin = planning_store.statuses(self.root)
        self.assertEqual([x["id"] for x in builtin], ["unread", "reading", "organizing", "done", "paused"])
        custom = builtin + [{"id": "custom-review", "label": "待確認", "color": "#123456"}]
        planning_store.save_statuses(self.root, custom)
        planning_store.upsert_saved(self.root, "doi:10.1/test", {"title": "Paper"})
        planning_store.update_saved(self.root, "doi:10.1/test", status="custom-review")
        ws = FakeWorkspace("library-paper", "custom-review")
        self.lib.workspaces[ws.id] = ws

        result = research_v2.post(self.app, "/statuses", {"statuses": builtin, "moves": {"custom-review": "done"}})

        self.assertEqual([x["id"] for x in result["statuses"]], ["unread", "reading", "organizing", "done", "paused"])
        self.assertEqual(ws.values["item"]["status"], "done")
        self.assertEqual(planning_store.saved(self.root, "doi:10.1/test")["status"], "done")

    def test_invalid_status_update_does_not_mutate_paper_state(self):
        ws = FakeWorkspace("library-paper", "unread")
        self.lib.workspaces[ws.id] = ws
        values = planning_store.statuses(self.root) + [{"id": "custom-review", "label": "待確認", "color": "#123456"}]
        planning_store.save_statuses(self.root, values)
        with self.assertRaises(ValueError):
            research_v2.post(self.app, "/statuses", {"statuses": values[:-1], "moves": {"custom-review": "missing"}})
        self.assertEqual(ws.values["item"]["status"], "unread")

    def test_plan_validation_and_item_update_keep_status_independent(self):
        ws = FakeWorkspace("library-paper", "unread")
        self.lib.workspaces[ws.id] = ws
        fields = {"id": ws.id, "status": "reading", "interested": True,
                  "reading_plan": {"start_date": "2026-10-10", "due_date": "2026-10-11",
                                   "reminders": {"start_enabled": True, "start_time": "08:30"}},
                  "tags": ["3D Vision"]}
        research_v2.post(self.app, "/item", fields)
        saved_item = ws.values["item"]
        self.assertEqual(saved_item["status"], "reading")
        self.assertTrue(saved_item["interested"])
        self.assertTrue(saved_item["starred"])
        self.assertEqual(saved_item["reading_plan"]["reminders"]["start_time"], "08:30")
        self.assertEqual(saved_item["tags"], ["3D Vision"])
        with self.assertRaisesRegex(ValueError, "不能晚於"):
            research_v2._normalize_plan({"start_date": "2026-10-12", "due_date": "2026-10-11"})
        with self.assertRaisesRegex(ValueError, "提醒時間"):
            research_v2._normalize_plan({"reminders": {"start_time": "28:99"}})

    def test_abstract_reconstruction_and_missing_citation_count(self):
        work = research_v2._work({"id": "https://openalex.org/W1", "title": "A paper",
                                  "abstract_inverted_index": {"reading": [1], "Research": [0]},
                                  "cited_by_count": None})
        self.assertEqual(work["abstract"], "Research reading")
        self.assertIsNone(work["cited_by_count"])

    def test_candidate_is_separate_from_reading_queue_and_summary_survives_reload(self):
        paper = {"doi": "10.1234/example", "title": "Candidate Paper", "abstract": "Evidence"}
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            added = research_v2.post(self.app, "/candidate", {"paper": paper})
        self.assertEqual(added["candidate"]["paper"]["title"], "Candidate Paper")
        self.assertEqual(added["candidate"]["summary_status"], "queued")
        self.assertEqual(planning_store.candidate_summary_queue(self.root)[0]["paper_key"], "doi:10.1234/example")
        self.assertEqual(planning_store.get_saved(self.root), [])
        self.assertEqual(self.app.jobs.enqueue.call_count, 0)
        saved = research_v2.post(self.app, "/candidate", {"action": "save-summary", "paper": paper,
            "summary_markdown": "## Summary\n\nEvidence-based.", "model": "test-model"})
        self.assertEqual(saved["candidate"]["summary_markdown"], "## Summary\n\nEvidence-based.")
        self.assertEqual(planning_store.summaries_list(self.root)[0]["summary_model"], "test-model")
        research_v2.post(self.app, "/candidate", {"action": "remove", "paper": paper})
        self.assertEqual(planning_store.candidates(self.root), [])
        self.assertEqual(planning_store.summaries_list(self.root)[0]["summary_markdown"], "## Summary\n\nEvidence-based.")
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            research_v2.post(self.app, "/candidate", {"action": "add", "paper": paper})
        self.assertEqual(planning_store.candidates(self.root)[0]["summary_markdown"], "## Summary\n\nEvidence-based.")
        self.assertEqual(planning_store.candidates(self.root)[0]["summary_status"], "ready")

    def test_summary_can_move_to_trash_and_restore_without_removing_candidate(self):
        paper = {"doi": "10.1234/trash-summary", "title": "Trash Summary Paper", "abstract": "Source."}
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            research_v2.post(self.app, "/candidate", {"paper": paper})
        key = "doi:10.1234/trash-summary"
        planning_store.candidate_save_summary(self.root, key, "## Saved summary", "fast-model")

        moved = planning_store.summary_move_to_trash(self.root, key)

        self.assertEqual(moved["summary_markdown"], "## Saved summary")
        self.assertEqual(planning_store.summaries_list(self.root), [])
        self.assertEqual(len(planning_store.summary_trash_items(self.root)), 1)
        candidate = planning_store.candidates(self.root)[0]
        self.assertEqual(candidate["summary_status"], "")
        self.assertEqual(candidate["summary_markdown"], "")
        self.assertEqual(planning_store.candidate_summary_queue(self.root), [])

        trash_id = planning_store.summary_trash_items(self.root)[0]["name"]
        self.assertTrue(planning_store.summary_trash_restore(self.root, trash_id))
        self.assertEqual(planning_store.summaries_list(self.root)[0]["summary_markdown"], "## Saved summary")
        self.assertEqual(planning_store.candidates(self.root)[0]["summary_status"], "ready")
        self.assertEqual(planning_store.summary_trash_items(self.root), [])

    def test_summary_trash_restore_rejects_duplicate_and_purge_is_scoped(self):
        paper = {"doi": "10.1234/trash-conflict", "title": "Conflict Paper", "abstract": "Source."}
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            research_v2.post(self.app, "/candidate", {"paper": paper})
        key = "doi:10.1234/trash-conflict"
        planning_store.candidate_save_summary(self.root, key, "Old summary", "model")
        planning_store.summary_move_to_trash(self.root, key)
        planning_store.candidate_save_summary(self.root, key, "New summary", "model")
        trash_id = planning_store.summary_trash_items(self.root)[0]["name"]
        with self.assertRaisesRegex(ValueError, "已有摘要"):
            planning_store.summary_trash_restore(self.root, trash_id)
        self.assertEqual(planning_store.summary_trash_purge(self.root, trash_id), 1)
        self.assertEqual(planning_store.summaries_list(self.root)[0]["summary_markdown"], "New summary")
        self.assertEqual(planning_store.summary_trash_empty(self.root), 0)

    def test_candidate_endpoint_accepts_trailing_slash(self):
        paper = {"doi": "10.1234/slash", "title": "Slash Route Paper"}
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            added = research_v2.post(self.app, "/candidate/", {"paper": paper})
        self.assertEqual(added["candidate"]["paper"]["title"], "Slash Route Paper")

    def test_search_expansion_prefers_a_configured_fast_model(self):
        cfg = {"chat": {"default": "opus", "models": [
            {"id": "opus", "name": "Claude Opus", "engine": "claude"},
            {"id": "haiku-fast", "name": "Claude Haiku Fast", "engine": "claude"},
        ]}}
        self.assertEqual(research_v2._fast_model_id(cfg), "haiku-fast")

    def test_candidate_summary_worker_batches_queued_papers(self):
        papers = [
            {"doi": "10.1234/one", "title": "Paper One", "abstract": "First source abstract."},
            {"doi": "10.1234/two", "title": "Paper Two", "abstract": "Second source abstract."},
        ]
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            for paper in papers:
                research_v2.post(self.app, "/candidate", {"paper": paper})
        queued = planning_store.candidate_summary_queue(self.root, 5)
        result = json.dumps([{"paper_key": item["paper_key"], "summary_markdown": "## 已整理\n\n來源摘要整理。"} for item in queued], ensure_ascii=False)
        with mock.patch.object(research_v2._time, "sleep"), \
             mock.patch("easyread.chat_models.engine_cfg", return_value=({}, {"name": "fast-test"})), \
             mock.patch("easyread.engines.for_translation", return_value={}), \
             mock.patch("easyread.engines.run", return_value=result) as run:
            research_v2._summary_worker(self.app)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(len(planning_store.summaries_list(self.root)), 2)
        self.assertTrue(all(item["summary_status"] == "ready" for item in planning_store.candidates(self.root)))

    def test_interrupted_summary_jobs_are_requeued_and_semantic_scholar_is_disabled(self):
        paper = {"doi": "10.1234/recovery", "title": "Recovery Paper", "abstract": "Source."}
        with mock.patch.object(research_v2, "_ensure_summary_worker"):
            research_v2.post(self.app, "/candidate", {"paper": paper})
        key = planning_store.candidates(self.root)[0]["paper_key"]
        planning_store.candidate_summary_status(self.root, key, "running")
        self.assertEqual(planning_store.recover_candidate_summaries(self.root), 1)
        self.assertEqual(planning_store.candidates(self.root)[0]["summary_status"], "queued")
        with self.assertRaisesRegex(ValueError, "不支援的搜尋類型"):
            research_v2.get(self.app, research_v2.PREFIX + "/search?kind=semantic&q=test")

    def test_mindmap_cache_lookup_uses_same_evidence_hash_as_generation(self):
        ws = FakeWorkspace("paper-map")
        ws.values["paper"] = {"meta": {"title_en": "Paper"}, "blocks": [
            {"id": "s1", "type": "paragraph", "page": 1, "en": "A finding."}]}
        self.lib.workspaces[ws.id] = ws
        source_hash = research_v2.sha256(json.dumps([
            {"id": "s1", "type": "paragraph", "page": 1, "text": "A finding."}], ensure_ascii=False).encode()).hexdigest()
        cache_key = "mindmap:" + research_v2.sha256(source_hash.encode()).hexdigest()
        planning_store.cache_put(self.root, cache_key, {"mermaid": "mindmap\n  root((Paper))", "source_sha256": source_hash})
        result = research_v2.get(self.app, research_v2.PREFIX + "/paper/paper-map/mindmap")
        self.assertTrue(result["cached"])
        self.assertIn("mindmap", result["mermaid"])

    def test_mindmap_post_always_regenerates_instead_of_reusing_cache(self):
        from easyread import chat_models, engines
        ws = FakeWorkspace("paper-refresh")
        ws.values["paper"] = {"meta": {"title_en": "Paper"}, "blocks": [
            {"id": "s1", "type": "paragraph", "page": 1, "en": "A finding."}]}
        self.lib.workspaces[ws.id] = ws
        cfg = {"engine": "openai", "openai": {}, "chat": {"models": []}}
        model = {"name": "test-model", "id": "test-model"}
        with mock.patch.object(research_v2.config, "load", return_value=cfg), \
             mock.patch.object(chat_models, "engine_cfg", return_value=(cfg, model)), \
             mock.patch.object(engines, "for_translation", side_effect=lambda value: value), \
             mock.patch.object(engines, "run", side_effect=["mindmap\n  root((First))", "mindmap\n  root((Second))"]) as run:
            first = research_v2.post(self.app, "/paper/paper-refresh/mindmap", {})
            second = research_v2.post(self.app, "/paper/paper-refresh/mindmap", {})
        self.assertFalse(first["cached"])
        self.assertFalse(second["cached"])
        self.assertNotEqual(first["mermaid"], second["mermaid"])
        self.assertIn("generated_at", second)
        self.assertEqual(run.call_count, 2)

    def test_publication_venue_is_not_replaced_by_the_public_pdf_repository(self):
        work = research_v2._work({"id": "https://openalex.org/W1", "title": "Paper",
            "primary_location": {"source": {"display_name": "CVPR"}},
            "best_oa_location": {"source": {"display_name": "arXiv"}, "pdf_url": "https://arxiv.org/pdf/1234"}})
        self.assertEqual(work["venue"], "CVPR")
        self.assertEqual(work["pdf_url"], "https://arxiv.org/pdf/1234")

    def test_openalex_retries_a_transient_error_but_not_unknown_ids(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"results": []}'
        temporary = urllib.error.HTTPError("https://api.openalex.org/works", 503, "unavailable", {}, io.BytesIO())
        with mock.patch.object(research_v2.urllib.request, "urlopen", side_effect=[temporary, response]) as request, mock.patch.object(research_v2._time, "sleep"):
            self.assertEqual(research_v2._openalex("/works"), {"results": []})
        self.assertEqual(request.call_count, 2)
        unknown = urllib.error.HTTPError("https://api.openalex.org/works/W1", 404, "not found", {}, io.BytesIO())
        with mock.patch.object(research_v2.urllib.request, "urlopen", side_effect=unknown) as request, mock.patch.object(research_v2._time, "sleep"):
            with self.assertRaisesRegex(ValueError, "HTTP 404"):
                research_v2._openalex("/works/W1")
        self.assertEqual(request.call_count, 1)

    def test_source_filter_is_validated_and_passed_to_openalex(self):
        response = {"results": [], "meta": {"count": 0}}
        with mock.patch.object(research_v2, "_openalex", return_value=response) as call:
            research_v2._search_works(self.root, "vision", source_id="https://openalex.org/S137773608")
        self.assertIn("primary_location.source.id:S137773608", call.call_args.args[1]["filter"])
        with self.assertRaisesRegex(ValueError, "出版來源識別"):
            research_v2._search_works(self.root, "vision", source_id="Sbad")
        with self.assertRaisesRegex(ValueError, "四位數"):
            research_v2._search_works(self.root, "vision", year_from="19")
        with self.assertRaisesRegex(ValueError, "起始年份"):
            research_v2._search_works(self.root, "vision", year_from="2025", year_to="2024")

    def test_paper_mode_resolves_openalex_urls_and_dois_exactly(self):
        raw = {"id": "https://openalex.org/W123", "title": "Exact paper"}
        with mock.patch.object(research_v2, "_openalex", return_value=raw) as call:
            result = research_v2._identifier_search(self.root, "https://openalex.org/W123")
        self.assertEqual(call.call_args.args[0], "/works/W123")
        self.assertEqual(result["results"][0]["title"], "Exact paper")

        with mock.patch.object(research_v2, "_openalex", return_value=raw) as call:
            research_v2._identifier_search(self.root, "doi:10.1234/example")
        self.assertEqual(call.call_args.args[0], "/works/https://doi.org/10.1234%2Fexample")

    def test_source_terms_split_acronyms_and_preserve_full_names(self):
        self.assertEqual(research_v2._source_terms("ICCV ECCV CVPR cvpr"), ["ICCV", "ECCV", "CVPR"])
        self.assertEqual(research_v2._source_terms("CVPR"), ["CVPR"])
        self.assertEqual(research_v2._source_terms("Nature Communications, Science；ICCV ECCV"),
                         ["Nature Communications", "Science", "ICCV", "ECCV"])
        with self.assertRaisesRegex(ValueError, "10 組"):
            research_v2._source_terms(",".join(f"Source {i}" for i in range(11)))

    def test_major_conference_and_journal_aliases_include_miccai(self):
        self.assertEqual(research_v2.SOURCE_ALIASES["MICCAI"], "Medical Image Computing and Computer Assisted Intervention")
        self.assertIn("MICCAI", research_v2._source_terms("MICCAI"))
        self.assertIn("TPAMI", research_v2.SOURCE_ALIASES)

    def test_miccai_remains_selectable_when_openalex_has_no_source_record(self):
        with mock.patch.object(research_v2, "_openalex", return_value={"results": []}):
            result = research_v2._source_search(self.root, "MICCAI")
        self.assertEqual(result["results"][0]["id"], "venue:miccai")
        self.assertEqual(result["results"][0]["name"], research_v2.SOURCE_ALIASES["MICCAI"])
        self.assertTrue(result["results"][0]["suggested"])

    def test_crossref_venue_search_filters_to_selected_publication(self):
        payload = {"message": {"total-results": 1, "items": [{
            "DOI": "10.1234/miccai", "title": ["Medical Image Segmentation"],
            "author": [{"given": "A", "family": "Researcher"}], "container-title": ["MICCAI"],
            "issued": {"date-parts": [[2025]]}, "type": "proceedings-article", "URL": "https://doi.org/10.1234/miccai"
        }, {
            "DOI": "10.1234/handbook", "title": ["A segmentation handbook"],
            "container-title": ["Handbook of Medical Image Computing and Computer Assisted Intervention"],
            "issued": {"date-parts": [[2025]]}, "type": "book", "URL": "https://doi.org/10.1234/handbook"
        }]}}
        with mock.patch.object(research_v2, "_external_json", return_value=payload) as request:
            result = research_v2.get(self.app, research_v2.PREFIX + "/search?kind=crossref&q=segmentation&venues=MICCAI&year_from=2024")
        self.assertEqual(result["results"][0]["venue"], "MICCAI")
        self.assertEqual(result["results"][0]["year"], "2025")
        self.assertEqual(len(result["results"]), 1)
        self.assertIn("query.container-title", research_v2.urllib.parse.parse_qs(research_v2.urllib.parse.urlparse(request.call_args.args[0]).query))

    def test_dblp_search_does_not_use_unsupported_venue_operator_and_filters_metadata(self):
        payload = {"result": {"hits": {"@total": "2", "hit": [
            {"info": {"title": "Video Understanding", "venue": "CVPR", "year": "2025", "authors": {"author": []}}},
            {"info": {"title": "Video Understanding Workshop", "venue": "CVPR Workshops", "year": "2025", "authors": {"author": []}}},
        ]}}}
        with mock.patch.object(research_v2, "_external_json", return_value=payload) as request:
            result = research_v2._dblp_search(self.root, "video understanding", ["CVPR"])
        query = research_v2.urllib.parse.parse_qs(research_v2.urllib.parse.urlparse(request.call_args.args[0]).query)["q"][0]
        self.assertEqual(query, "video understanding")
        self.assertNotIn("venue:", query)
        self.assertEqual([work["venue"] for work in result["results"]], ["CVPR"])
        self.assertEqual(result["source"], "DBLP")

    def test_openalex_search_serves_recent_cache_without_duplicate_upstream_call(self):
        payload = {"results": [{"id": "https://openalex.org/W11", "title": "Cached Paper"}], "meta": {"count": 1}}
        with mock.patch.object(research_v2, "_openalex", return_value=payload) as request:
            first = research_v2._search_works(self.root, "cache check")
            second = research_v2._search_works(self.root, "cache check")
        self.assertEqual(request.call_count, 1)
        self.assertFalse(first.get("cached", False))
        self.assertTrue(second["cached"])
        self.assertEqual(second["results"][0]["title"], "Cached Paper")

    def test_source_lookup_resolves_multiple_acronyms_and_marks_exact_conferences(self):
        cvpr = {"id": "https://openalex.org/S1", "display_name": "Computer Vision and Pattern Recognition", "type": "conference", "works_count": 20000}
        eccv = {"id": "https://openalex.org/S2", "display_name": "European Conference on Computer Vision", "type": "conference", "works_count": 27}
        workshop = {"id": "https://openalex.org/S3", "display_name": "Computer Vision and Pattern Recognition Workshops", "type": "conference"}
        def responses(_path, params):
            return {"results": {"CVPR": [cvpr, workshop], "ECCV": [], "European Conference on Computer Vision": [eccv]}[params["search"]]}
        with mock.patch.object(research_v2, "_openalex", side_effect=responses) as call:
            result = research_v2._source_search(self.root, "CVPR ECCV")
        self.assertEqual(result["queries"], ["CVPR", "ECCV"])
        self.assertEqual(call.call_count, 3)
        by_id = {s["id"]: s for s in result["results"]}
        self.assertTrue(by_id[cvpr["id"]]["suggested"])
        self.assertTrue(by_id[eccv["id"]]["suggested"])
        self.assertFalse(by_id[workshop["id"]]["suggested"])
        self.assertIn("ECCV", result["warning"])

    def test_multiple_source_filters_use_or_and_support_source_only_search(self):
        with mock.patch.object(research_v2, "_openalex", return_value={"results": [], "meta": {"count": 0}}) as call:
            result = research_v2.get(self.app, research_v2.PREFIX + "/search?source_ids=S2%7Chttps%3A%2F%2Fopenalex.org%2FS1%7CS2&year_from=2025&page=2")
        params = call.call_args.args[1]
        self.assertIn("primary_location.source.id:S1|S2", params["filter"])
        self.assertIn("from_publication_date:2025-01-01", params["filter"])
        self.assertNotIn("search", params)
        self.assertEqual(params["sort"], "publication_date:desc")
        self.assertEqual(params["page"], 2)
        self.assertEqual(result["source_ids"], ["S1", "S2"])
        with mock.patch.object(research_v2, "_openalex") as call:
            with self.assertRaisesRegex(ValueError, "出版來源識別"):
                research_v2._search_works(self.root, "vision", source_ids="S1|Sbad")
            call.assert_not_called()

    def test_multi_source_partial_failure_does_not_hide_failed_query(self):
        def responses(_path, params):
            if params["search"] == "ICCV":
                raise ValueError("OpenAlex offline")
            return {"results": [{"id": "https://openalex.org/S1", "display_name": "CVPR", "type": "conference"}]}
        with mock.patch.object(research_v2, "_openalex", side_effect=responses):
            result = research_v2._source_search(self.root, "ICCV CVPR")
        self.assertEqual(result["failed_queries"], ["ICCV"])
        self.assertEqual({x["id"] for x in result["results"]}, {"https://openalex.org/S1", "venue:iccv"})
        self.assertIn("查詢失敗", result["warning"])

    def test_unindexed_exact_doi_returns_not_found_instead_of_a_service_error(self):
        def not_found_then_empty(path, *_args, **_kwargs):
            if path.startswith("/works/https://doi.org/"):
                raise ValueError("OpenAlex 查詢失敗（HTTP 404），請稍後重試。")
            return {"results": [], "meta": {"count": 0}}
        with mock.patch.object(research_v2, "_openalex", side_effect=not_found_then_empty):
            result = research_v2._identifier_search(self.root, "doi:10.48550/arXiv.1706.03762")
        self.assertEqual(result["reason"], "not-found")
        self.assertEqual(result["results"], [])

    def test_category_seed_doi_keeps_the_full_identifier(self):
        with mock.patch.object(research_v2, "_openalex", return_value={"id": "https://openalex.org/W7"}) as call:
            research_v2._resolve_seed({"doi": "10.1234/part-one/part-two"})
        self.assertEqual(call.call_args.args[0], "/works/https://doi.org/10.1234%2Fpart-one%2Fpart-two")

    def test_category_recommendations_use_confirmed_seeds_and_rank_shared_neighbors(self):
        first = FakeWorkspace("seed-one"); first.values["item"].update({"tags": ["Vision"], "title_en": "Visual representation", "openalex_id": "https://openalex.org/W1"})
        second = FakeWorkspace("seed-two"); second.values["item"].update({"tags": ["Vision"], "title_en": "Visual feature learning", "openalex_id": "https://openalex.org/W2"})
        self.lib.workspaces.update({first.id: first, second.id: second})
        works = {
            "/works/W1": {"id": "https://openalex.org/W1", "title": "Visual representation", "abstract_inverted_index": {"visual": [0], "representation": [1]}, "related_works": ["https://openalex.org/W3", "https://openalex.org/W4"]},
            "/works/W2": {"id": "https://openalex.org/W2", "title": "Visual feature learning", "abstract_inverted_index": {"visual": [0], "feature": [1]}, "related_works": ["https://openalex.org/W3"]},
            "/works/W3": {"id": "https://openalex.org/W3", "title": "Visual representation and feature learning", "abstract_inverted_index": {"visual": [0], "feature": [1], "representation": [2]}},
            "/works/W4": {"id": "https://openalex.org/W4", "title": "Unrelated sequence modeling", "abstract_inverted_index": {"language": [0], "sequence": [1]}},
        }
        with mock.patch.object(research_v2, "_openalex", side_effect=lambda path, *_a, **_k: works[path]):
            result = research_v2.get(self.app, research_v2.PREFIX + "/category-recommendations?category=Vision&seeds=seed-one%2Cseed-two")
        self.assertEqual([x["openalex_id"] for x in result["results"]], ["https://openalex.org/W3", "https://openalex.org/W4"])
        self.assertEqual(result["results"][0]["seed_ids"], ["seed-one", "seed-two"])

    def test_category_recommendations_do_not_treat_unresolved_seeds_as_no_matches(self):
        ws = FakeWorkspace("unidentified"); ws.values["item"].update({"tags": ["Vision"], "title_en": "A specific paper with no identifier"})
        self.lib.workspaces[ws.id] = ws
        with mock.patch.object(research_v2, "_openalex", return_value={"results": [{"title": "A different paper"}]}):
            result = research_v2.get(self.app, research_v2.PREFIX + "/category-recommendations?category=Vision&seeds=unidentified")
        self.assertEqual(result["reason"], "unresolved")
        self.assertEqual(result["results"], [])

    def test_recommendations_exclude_papers_in_other_categories_and_metadata_only_queue(self):
        seed = FakeWorkspace("seed"); seed.values["item"].update({"tags": ["Vision"], "openalex_id": "https://openalex.org/W1"})
        elsewhere = FakeWorkspace("elsewhere"); elsewhere.values["item"].update({"tags": ["Other"], "openalex_id": "https://openalex.org/W2"})
        self.lib.workspaces.update({seed.id: seed, elsewhere.id: elsewhere})
        planning_store.upsert_saved(self.root, "openalex:W3", {"openalex_id": "https://openalex.org/W3", "title": "Queued"})
        def results(path, *_args, **_kwargs):
            if path == "/works/W1":
                return {"id": "https://openalex.org/W1", "title": "Seed", "related_works": ["https://openalex.org/W2", "https://openalex.org/W3", "https://openalex.org/W4"]}
            return {"id": "https://openalex.org/" + path.rsplit("/", 1)[-1], "doi": "10.1234/" + path.rsplit("/", 1)[-1], "title": path}
        with mock.patch.object(research_v2, "_openalex", side_effect=results):
            result = research_v2.get(self.app, research_v2.PREFIX + "/category-recommendations?category=Vision")
        self.assertEqual([x["openalex_id"] for x in result["results"]], ["https://openalex.org/W4"])

    def test_reference_lists_are_paginated_instead_of_silently_truncated(self):
        ids = [f"https://openalex.org/W{i}" for i in range(1, 26)]
        def fake_openalex(path, *_args, **_kwargs):
            if path == "/works/W100":
                return {"id": path, "referenced_works": ids}
            if path == "/works":
                return {"results": [{"id": ident, "title": ident.rsplit("/", 1)[-1]} for ident in ids[20:]]}
            return {"id": path, "title": path.rsplit("/", 1)[-1]}
        with mock.patch.object(research_v2, "_openalex", side_effect=fake_openalex):
            result = research_v2.get(self.app, research_v2.PREFIX + "/work/W100?relation=references&page=2")
        self.assertEqual(result["count"], 25)
        self.assertEqual(result["page"], 2)
        self.assertEqual([x["title"] for x in result["results"]], ["W21", "W22", "W23", "W24", "W25"])
        self.assertFalse(result["has_more"])

    def test_relation_network_failure_preserves_cached_results_instead_of_empty_list(self):
        def responses(path, *_args, **_kwargs):
            return {"id": "https://openalex.org/W1", "referenced_works": ["https://openalex.org/W2"]} if path == "/works/W1" else {"results": [{"id": "https://openalex.org/W2", "title": "Source"}]}
        url = research_v2.PREFIX + "/work/W1?relation=references"
        with mock.patch.object(research_v2, "_openalex", side_effect=responses):
            first = research_v2.get(self.app, url)
        with mock.patch.object(research_v2, "_openalex", side_effect=ValueError("OpenAlex offline")):
            later = research_v2.get(self.app, url)
            with self.assertRaisesRegex(ValueError, "offline"):
                research_v2.get(self.app, research_v2.PREFIX + "/work/W999?relation=references")
        self.assertTrue(later["stale"])
        self.assertEqual(later["results"], first["results"])

    def test_work_relation_resolves_doi_identifier_to_openalex_id_and_returns_seed_metadata(self):
        resolved_seed = {
            "id": "https://openalex.org/W99",
            "title": "Resolved Seed Paper",
            "doi": "https://doi.org/10.1234/test-doi",
        }
        def fake_openalex(path, params=None, *_args, **_kwargs):
            if path == "/works/W99":
                return {
                    "id": "https://openalex.org/W99", "title": "Resolved Seed Paper", "related_works": ["https://openalex.org/W101"],
                    "keywords": [{"display_name": "Computer Vision"}, {"display_name": "Image Segmentation"}],
                    "primary_topic": {"display_name": "Semantic Segmentation"}, "topics": [{"display_name": "Visual Attention"}]
                }
            if path == "/works":
                return {"results": [{"id": "https://openalex.org/W101", "title": "Related Result", "publication_year": 2024}]}
            return {"results": []}

        with mock.patch.object(research_v2, "_resolve_seed", return_value=resolved_seed) as resolve, \
             mock.patch.object(research_v2, "_openalex", side_effect=fake_openalex):
            result = research_v2.get(self.app, research_v2.PREFIX + "/work/doi%3A10.1234%2Ftest-doi?relation=related&start_title=Custom%20Title")
        self.assertEqual(resolve.call_count, 1)
        self.assertEqual(result["seed_id"], "W99")
        self.assertEqual(result["seed_title"], "Custom Title")
        self.assertEqual(result["seed_doi"], "https://doi.org/10.1234/test-doi")
        self.assertEqual(result["seed_keywords"], ["Computer Vision", "Image Segmentation"])
        self.assertEqual(result["seed_topics"], ["Semantic Segmentation", "Visual Attention"])
        self.assertEqual(result["relation"], "related")
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["results"][0]["title"], "Related Result")

    def test_work_relation_rejects_unresolvable_identifier(self):
        with mock.patch.object(research_v2, "_resolve_seed", return_value=None):
            with self.assertRaisesRegex(ValueError, "找不到對應的 OpenAlex 論文識別資料"):
                research_v2.get(self.app, research_v2.PREFIX + "/work/doi%3A10.9999%2Funknown?relation=related")

    def test_work_cited_by_includes_seed_metadata(self):
        def fake_openalex(path, params=None, *_args, **_kwargs):
            return {"results": [{"id": "https://openalex.org/W200", "title": "Citing Paper", "publication_year": 2025}], "meta": {"count": 1}}

        with mock.patch.object(research_v2, "_openalex", side_effect=fake_openalex):
            result = research_v2.get(self.app, research_v2.PREFIX + "/work/W50?relation=cited-by&start_title=Seed%20Title&start_doi=10.1234/seed")
        self.assertEqual(result["seed_id"], "W50")
        self.assertEqual(result["seed_title"], "Seed Title")
        self.assertEqual(result["seed_doi"], "10.1234/seed")
        self.assertEqual(result["relation"], "cited-by")
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["results"][0]["title"], "Citing Paper")

    def test_legacy_schedule_data_is_preserved_but_reminder_api_is_retired(self):
        plan = {"start_date": "2026-10-08", "due_date": "2026-10-20",
                "reminders": {"start_enabled": True, "start_time": "09:00"}}
        ws = FakeWorkspace("paper", "unread")
        ws.values["item"]["reading_plan"] = plan
        self.lib.workspaces[ws.id] = ws
        self.assertIsNone(research_v2.get(self.app, research_v2.PREFIX + "/reminders"))
        self.assertEqual(ws.values["item"]["reading_plan"], plan)
        saved = planning_store.upsert_saved(self.root, "doi:10.1234/legacy", {"title": "Legacy"}, plan=plan)
        self.assertEqual(planning_store.saved(self.root, saved["paper_key"])["plan"], plan)

    def test_pdf_download_links_metadata_plan_and_manual_state_without_translation(self):
        paper = {"openalex_id": "https://openalex.org/W1", "title": "Paper", "authors": "A. Author",
                 "pdf_url": "https://example.org/paper.pdf"}
        record = planning_store.upsert_saved(self.root, "openalex:W1", paper, ["Vision"],
                                             {"start_date": "2026-10-10"}, True, paper["pdf_url"])
        planning_store.update_saved(self.root, record["paper_key"], status="reading")
        research_v2._background_download(self.app, record["paper_key"])
        saved = planning_store.saved(self.root, record["paper_key"])
        item = self.lib.ws(saved["library_id"]).values["item"]
        self.assertEqual(saved["pdf_state"], "imported")
        self.assertEqual(item["status"], "reading")
        self.assertEqual(item["reading_plan"]["start_date"], "2026-10-10")
        self.assertEqual(item["tags"], ["Vision"])
        self.app.jobs.enqueue.assert_called_once()
        self.assertEqual(self.app.jobs.enqueue.call_args.kwargs, {"translate_after": False, "read": False})

    def test_duplicate_pdf_job_claim_is_idempotent(self):
        planning_store.upsert_saved(self.root, "doi:10.1/paper", {"title": "Paper"})
        self.assertTrue(planning_store.claim_pdf_download(self.root, "doi:10.1/paper"))
        self.assertFalse(planning_store.claim_pdf_download(self.root, "doi:10.1/paper"))

    def test_manual_pdf_attach_uses_the_same_idempotent_job_claim(self):
        paper = {"title": "Paper", "doi": "10.1/paper"}
        record = planning_store.upsert_saved(self.root, "doi:10.1/paper", paper,
                                             ["Vision"], {"due_date": "2026-10-20"})
        planning_store.update_saved(self.root, record["paper_key"], status="paused", manual_order=300)
        result = research_v2.attach_pdf(self.app, record["paper_key"], b"%PDF-manual", "paper.pdf")
        self.assertEqual(result["id"], "imported-paper")
        self.assertEqual(planning_store.saved(self.root, record["paper_key"])["pdf_state"], "imported")
        item = self.lib.ws("imported-paper").values["item"]
        self.assertEqual(item["reading_plan"]["due_date"], "2026-10-20")
        self.assertEqual(item["tags"], ["Vision"])
        self.assertEqual(item["status"], "paused")
        self.assertEqual(item["manual_order"], 300)

    def test_follow_route_is_retired_without_deleting_existing_follow_data(self):
        follow = planning_store.add_follow(self.root, "topic", "vision")
        previous = [{"id": "https://openalex.org/W1", "title": "Earlier"}]
        planning_store.update_follow(self.root, follow["id"], "2026-10-01T09:00:00", previous)
        with self.assertRaisesRegex(ValueError, "不支援"):
            research_v2.post(self.app, "/follow", {"action": "refresh", "id": follow["id"]})
        saved = planning_store.get_follows(self.root)[0]
        self.assertEqual(saved["last_checked"], "2026-10-01T09:00:00")
        self.assertEqual(saved["results"], previous)

    def test_author_search_route_is_retired(self):
        for kind in ("authors", "author-works"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "不支援"):
                research_v2.get(self.app, research_v2.PREFIX + "/search?kind=" + kind + "&q=vision")

    def test_failed_pdf_download_keeps_queued_record_and_error(self):
        paper = {"title": "Paper", "pdf_url": "https://example.org/paper.pdf"}
        record = planning_store.upsert_saved(self.root, "doi:10.1/paper", paper, pdf_url=paper["pdf_url"])
        self.lib.fetch_result = ValueError("network offline")
        research_v2._background_download(self.app, record["paper_key"])
        failed = planning_store.saved(self.root, record["paper_key"])
        self.assertEqual(failed["pdf_state"], "failed")
        self.assertIn("network offline", failed["pdf_error"])
        self.assertIsNone(failed["library_id"] or None)

    def test_milestone_dates_and_author_follow_are_validated(self):
        with self.assertRaisesRegex(ValueError, "結束日期"):
            planning_store.add_milestone(self.root, {"title": "Lab meeting", "start_date": "2026-10-12", "end_date": "2026-10-11"})
        with self.assertRaisesRegex(ValueError, "OpenAlex 作者"):
            planning_store.add_follow(self.root, "author", "A/1 OR filter")
        follow = planning_store.add_follow(self.root, "author", "https://openalex.org/authors/A123", "Test Author")
        self.assertEqual(follow["value"], "A123")

    def test_unwrap_json_list_handles_varied_model_structures(self):
        self.assertEqual(research_v2._unwrap_json_list([{"id": "W1"}]), [{"id": "W1"}])
        self.assertEqual(research_v2._unwrap_json_list({"reading_path": [{"id": "W1"}]}), [{"id": "W1"}])
        self.assertEqual(research_v2._unwrap_json_list({"items": [{"id": "W2"}]}), [{"id": "W2"}])
        self.assertEqual(research_v2._unwrap_json_list({"id": "W3"}), [{"id": "W3"}])
        self.assertIsNone(research_v2._unwrap_json_list("not a list"))
        self.assertIsNone(research_v2._unwrap_json_list(None))

    @mock.patch.object(research_v2, "_search_works", return_value={"results": []})
    def test_reading_path_unwraps_dict_and_resolves_candidates(self, _search):
        papers = [
            {"id": "https://openalex.org/W100", "title": "Paper Foundations", "year": 2021},
            {"id": "https://openalex.org/W200", "title": "Paper Core", "year": 2023},
        ]
        model_output = json.dumps({
            "reading_path": [
                {"id": "W100", "role": "基礎入門", "reason": "建立概念", "priority": 1},
                {"id": "https://openalex.org/W200", "role": "起點核心", "reason": "核心方法", "priority": 2},
                {"id": "W100", "role": "基礎入門", "reason": "重複項目", "priority": 3},
            ]
        }, ensure_ascii=False)
        with mock.patch("easyread.chat_models.engine_cfg", return_value=({}, {"name": "test-model"})), \
             mock.patch("easyread.engines.for_translation", return_value={}), \
             mock.patch("easyread.engines.run", return_value=model_output):
            result = research_v2.post(self.app, "/reading-path", {
                "papers": papers,
                "topic": "Video LLM",
                "goal": "建立基礎概念",
            })
        self.assertIn("results", result)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["results"][0]["role"], "基礎入門")
        self.assertEqual(result["results"][0]["paper"]["title"], "Paper Foundations")
        self.assertEqual(result["results"][1]["paper"]["title"], "Paper Core")

    def test_reading_path_expands_seed_paper_references_and_related(self):
        start_paper = {
            "id": "https://openalex.org/W_START",
            "title": "Start Paper",
            "year": 2024,
            "referenced_works": ["https://openalex.org/W_REF1"],
            "related_works": ["https://openalex.org/W_REL1"],
        }
        ref_work = {"id": "https://openalex.org/W_REF1", "title": "Reference Paper", "publication_year": 2020}
        rel_work = {"id": "https://openalex.org/W_REL1", "title": "Related Paper", "publication_year": 2024}

        def mock_openalex(path, params=None, *args, **kwargs):
            p = params or {}
            filt = str(p.get("filter") or "")
            if "W_REF1" in filt or "W_REL1" in filt:
                return {"results": [ref_work, rel_work]}
            return {"results": []}

        model_output = json.dumps([
            {"id": "W_REF1", "role": "基礎背景", "reason": "先讀參考文獻", "priority": 1},
            {"id": "W_START", "role": "起點核心", "reason": "當前論文", "priority": 2},
            {"id": "W_REL1", "role": "延伸探索", "reason": "後續延伸", "priority": 3},
        ], ensure_ascii=False)

        with mock.patch.object(research_v2, "_openalex", side_effect=mock_openalex), \
             mock.patch("easyread.chat_models.engine_cfg", return_value=({}, {"name": "test-model"})), \
             mock.patch("easyread.engines.for_translation", return_value={}), \
             mock.patch("easyread.engines.run", return_value=model_output):
            result = research_v2.post(self.app, "/reading-path", {
                "start_paper": start_paper,
                "goal": "深入目前論文",
            })
        self.assertIn("results", result)
        self.assertEqual(len(result["results"]), 3)
        self.assertEqual(result["results"][0]["paper"]["title"], "Reference Paper")
        self.assertEqual(result["results"][1]["paper"]["title"], "Start Paper")
        self.assertEqual(result["results"][2]["paper"]["title"], "Related Paper")

    def test_ai_query_unwraps_dict_wrapper(self):
        model_output = json.dumps({"suggestions": ["video LLM reasoning", "multimodal chain of thought"]})
        with mock.patch("easyread.chat_models.engine_cfg", return_value=({}, {"name": "test-model"})), \
             mock.patch("easyread.engines.for_translation", return_value={}), \
             mock.patch("easyread.engines.run", return_value=model_output):
            result = research_v2.post(self.app, "/ai-query", {"query": "影片推理"})
        self.assertEqual(result["suggestions"], ["video LLM reasoning", "multimodal chain of thought"])

    def test_ai_query_distills_keywords_from_title_and_abstract(self):
        model_output = json.dumps(["Masked Image Segmentation", "Transformer Architecture", "Universal Representation"])
        captured_prompt = []

        def fake_run(cfg, prompt, root, tools, cb, meter):
            captured_prompt.append(prompt)
            return model_output

        with mock.patch("easyread.chat_models.engine_cfg", return_value=({}, {"name": "test-model"})), \
             mock.patch("easyread.engines.for_translation", return_value={}), \
             mock.patch("easyread.engines.run", side_effect=fake_run):
            result = research_v2.post(self.app, "/ai-query", {
                "title": "Mask2Former: Masked-attention Mask Transformer for Universal Image Segmentation",
                "abstract": "We present Mask2Former, an architecture capable of addressing any image segmentation task."
            })
        self.assertEqual(result["suggestions"], ["Masked Image Segmentation", "Transformer Architecture", "Universal Representation"])
        self.assertIn("Mask2Former", captured_prompt[0])
        self.assertIn("去除自創的模型代號", captured_prompt[0])


if __name__ == "__main__":
    unittest.main()
