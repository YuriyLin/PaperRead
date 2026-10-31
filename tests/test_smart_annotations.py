import tempfile
import unittest
from pathlib import Path

from easyread import langs, paperdata, smart_annotations
from easyread.store import Workspace, empty_reader, write_json_atomic


class SmartAnnotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        write_json_atomic(root / "paper.json", {
            "meta": {"title_zh": "測試論文"},
            "blocks": [
                {"id": "h1", "type": "heading", "zh": "方法"},
                {"id": "p1", "type": "para", "page": 2, "zh": "我們提出一個新的方法。我們比較結果。", "en": "We propose a new method. We compare results.", "sents": [[24, 11], [44, 18]]},
            ],
        })
        write_json_atomic(root / "reader.json", empty_reader())
        self.ws = Workspace(root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_candidate_uses_exact_source_location_and_rejects_unknown_color(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "highlight", "color": "yellow",
            "note": "方法核心", "reason": "作者的主要方法主張", "confidence": 0.9,
        }, sources, "test-model", "", "2026-01-01")
        self.assertTrue(candidate["locatable"])
        self.assertEqual(candidate["page"], 2)
        self.assertEqual(candidate["quote"], "新的方法")
        self.assertEqual(candidate["source_en_hash"], smart_annotations.text_hash("We propose a new method. We compare results."))
        self.assertEqual(candidate["source_zh_hash"], smart_annotations.text_hash("我們提出一個新的方法。我們比較結果。"))
        self.assertIsNone(smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "highlight", "color": "purple",
        }, sources, "test-model", "", "2026-01-01"))

    def test_prompt_uses_target_language_and_single_quote(self):
        paper = self.ws.load("paper")
        sources = smart_annotations._sources(paper)
        prompt_tw = smart_annotations._prompt("測試論文", "auto", "", sources, meta={"target": "zh-TW"})
        self.assertIn("quote 必須逐字從對應區塊的 TEXT 複製", prompt_tw)
        self.assertIn('"quote"', prompt_tw)
        self.assertIn("繁體中文（臺灣用語）", prompt_tw)
        self.assertIn("TEXT: 我們提出一個新的方法。我們比較結果。", prompt_tw)
        self.assertNotIn("ZH: ", prompt_tw)
        self.assertNotIn("EN: ", prompt_tw)

        prompt_ja = smart_annotations._prompt("測試論文", "auto", "", sources, meta={"target": "ja"}, prior_notes=["[方法] 提出新架構"])
        self.assertIn(langs.reply_language_rule({"target": "ja"}), prompt_ja)
        self.assertIn("前段已標註之論點摘要", prompt_ja)
        self.assertIn("[方法] 提出新架構", prompt_ja)

    def test_sources_integrate_user_edits_from_reader(self):
        paper = {
            "meta": {"title_zh": "測試"},
            "blocks": [
                {"id": "p1", "type": "para", "page": 1, "zh": "原始譯文", "en": "Original English"},
                {"id": "l1", "type": "list", "page": 1, "items_en": ["Item 1"], "items_zh": ["項目一"]},
                {"id": "fig1", "type": "figure", "page": 2, "caption_en": "Figure 1", "caption_zh": "圖一"},
            ],
        }
        reader = {
            "edits": {
                "p1": {"zh": "使用者修改後的段落譯文"},
                "l1#0": {"zh": "使用者修改後的清單譯文"},
                "fig1#caption": {"zh": "使用者修改後的圖表標題"},
            }
        }
        sources = smart_annotations._sources(paper, reader)
        by_key = {s["key"]: s for s in sources}
        self.assertEqual(by_key["p1"]["zh"], "使用者修改後的段落譯文")
        self.assertEqual(by_key["l1#0"]["zh"], "使用者修改後的清單譯文")
        self.assertEqual(by_key["fig1#caption"]["zh"], "使用者修改後的圖表標題")

    def test_aligned_en_location_finds_english_anchor_from_translation_quote(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "highlight", "color": "yellow",
            "note": "方法核心", "reason": "主要主張",
        }, sources, "test-model", "", "2026-01-01")
        self.assertTrue(candidate["locatable"])
        self.assertEqual(candidate["quote"], "新的方法")
        self.assertEqual(candidate["side"], "zh")
        # 即使模型只回傳單一中文 quote，後端仍透過 sents 反查出對應的英文原句並存入 source_quote_en
        self.assertEqual(candidate["source_quote_en"], "We propose a new method.")

    def test_location_ignores_sentence_alignment_marker(self):
        source = [{"anchor": "p", "key": "p", "page": 1, "section": "", "zh": "", "en": "A first claim‖ and a second claim."}]
        located = smart_annotations._locate("A first claim and a second claim.", "p", source, "en")
        self.assertIsNotNone(located)
        self.assertEqual(located["side"], "en")

    def test_locate_numbers_and_formulas_shared_across_languages(self):
        sources = [
            {"anchor": "p1", "key": "p1", "page": 1, "section": "", "en": "Dimension is $d_{\\text{model}} = 512$ with $N = 6$.", "zh": "維度為 $d_{\\text{model}} = 512$，層數為 $N = 6$。"},
            {"anchor": "p2", "key": "p2", "page": 2, "section": "", "en": "Another $512$ occurs here.", "zh": "此處亦有 $512$。"},
        ]
        # Number or formula verbatim in both zh and en on suggested block must locate cleanly
        loc_zh_formula = smart_annotations._locate("$d_{\\text{model}} = 512$", "p1", sources, "zh", "p1")
        self.assertIsNotNone(loc_zh_formula)
        self.assertEqual(loc_zh_formula["side"], "zh")
        self.assertEqual(loc_zh_formula["quote"], "$d_{\\text{model}} = 512$")

        loc_zh_num = smart_annotations._locate("512", "p1", sources, "zh", "p1")
        self.assertIsNotNone(loc_zh_num)
        self.assertEqual(loc_zh_num["side"], "zh")
        self.assertEqual(loc_zh_num["quote"], "512")

        loc_en_num = smart_annotations._locate("512", "p1", sources, "en", "p1")
        self.assertIsNotNone(loc_en_num)
        self.assertEqual(loc_en_num["side"], "en")

        # Refresh rebase should maintain locatable for numbers/formulas
        cand = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "$d_{\\text{model}} = 512$", "type": "underline", "color": "green", "side": "zh",
        }, sources, "test-model", "", "2026-01-01")
        self.assertTrue(cand["locatable"])
        refreshed = smart_annotations._refresh_annotation(cand, sources)
        self.assertTrue(refreshed["locatable"])
        self.assertFalse(refreshed["source_stale"])

    def test_accept_creates_one_formal_note_and_repeat_is_idempotent(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "underline", "color": "red", "note": "重點",
        }, sources, "test-model", "", "2026-01-01")
        self.ws.apply_reader_ops([{"op": "ai_annotation", "annotation": candidate, "at": "2026-01-01T00:00:00+08:00"}])
        smart_annotations.apply_action(self.ws, {"action": "accept", "id": candidate["annotation_id"]})
        smart_annotations.apply_action(self.ws, {"action": "accept", "id": candidate["annotation_id"]})
        reader = self.ws.load("reader")
        self.assertEqual(len(reader["notes"]), 1)
        self.assertEqual(reader["notes"][next(iter(reader["notes"]))]["style"], "underline")
        self.assertEqual(reader["ai_annotations"][candidate["annotation_id"]]["status"], "accepted")

    def test_unlocatable_candidate_cannot_be_accepted(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "模型捏造的句子", "type": "highlight", "color": "yellow",
        }, sources, "test-model", "", "2026-01-01")
        self.assertFalse(candidate["locatable"])
        self.ws.apply_reader_ops([{"op": "ai_annotation", "annotation": candidate, "at": "2026-01-01T00:00:00+08:00"}])
        with self.assertRaises(ValueError):
            smart_annotations.apply_action(self.ws, {"action": "accept", "id": candidate["annotation_id"]})

    def test_english_quote_survives_translation_and_updates_formal_note(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote_en": "We propose a new method", "quote_zh": "我們提出一個新的方法。", "type": "highlight", "color": "green", "side": "en",
            "note": "方法核心",
        }, sources, "test-model", "", "2026-01-01")
        self.ws.apply_reader_ops([{"op": "ai_annotation", "annotation": candidate, "at": "2026-01-01T00:00:00+08:00"}])
        smart_annotations.apply_action(self.ws, {"action": "accept", "id": candidate["annotation_id"]})

        paperdata.set_block_text(self.ws, "p1", "這是重新翻譯後的第一句。這是重新翻譯後的第二句。", [[24, 12], [44, 24]])
        reader = self.ws.load("reader")
        refreshed = reader["ai_annotations"][candidate["annotation_id"]]
        self.assertTrue(refreshed["locatable"])
        self.assertEqual(refreshed["side"], "zh")
        self.assertEqual(refreshed["quote"], "這是重新翻譯後的第一句。")
        note = next(iter(reader["notes"].values()))
        self.assertFalse(note.get("stale", False))

    def test_legacy_english_annotation_is_migrated_to_translation(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        current = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote_en": "We propose a new method", "quote_zh": "我們提出一個新的方法。",
            "type": "highlight", "color": "green", "note": "方法核心",
        }, sources, "test-model", "", "2026-01-01")
        # 模擬舊版資料：只保存英文 quote，沒有 source_quote_* 欄位。
        legacy = dict(current, side="en", quote="We propose a new method")
        legacy.pop("source_quote_en", None)
        legacy.pop("source_quote_zh", None)
        self.ws.apply_reader_ops([{"op": "ai_annotation", "annotation": legacy, "at": "2026-01-01T00:00:00+08:00"}])
        smart_annotations.apply_action(self.ws, {"action": "accept", "id": legacy["annotation_id"]})

        result = smart_annotations.refresh_after_translation(self.ws)
        self.assertGreaterEqual(result["updated"], 1)
        reader = self.ws.load("reader")
        refreshed = reader["ai_annotations"][legacy["annotation_id"]]
        self.assertEqual(refreshed["side"], "zh")
        self.assertEqual(refreshed["quote"], "我們提出一個新的方法。")
        note = next(iter(reader["notes"].values()))
        self.assertEqual(note["side"], "zh")
        self.assertEqual(note["quote"], "我們提出一個新的方法。")

    def test_old_translation_quote_is_marked_stale_after_retranslation(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        candidate = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "highlight", "color": "yellow", "side": "zh",
            "note": "舊譯文中的方法",
        }, sources, "test-model", "", "2026-01-01")
        self.ws.apply_reader_ops([{"op": "ai_annotation", "annotation": candidate, "at": "2026-01-01T00:00:00+08:00"}])
        paperdata.set_block_text(self.ws, "p1", "重新翻譯後的另一種說法。")
        refreshed = self.ws.load("reader")["ai_annotations"][candidate["annotation_id"]]
        self.assertFalse(refreshed["locatable"])
        self.assertEqual(refreshed["stale_reason"], "translation_changed")

    def test_sources_include_list_items_and_captions_and_exclude_headings(self):
        paper = {
            "meta": {"title_zh": "測試"},
            "blocks": [
                {"id": "h1", "type": "heading", "zh": "介紹", "en": "Introduction"},
                {"id": "l1", "type": "list", "page": 1, "items_en": ["First contribution.", "Second contribution."], "items_zh": ["第一個貢獻。", "第二個貢獻。"]},
                {"id": "fig1", "type": "figure", "page": 3, "caption_en": "Figure 1: System architecture.", "caption_zh": "圖 1：系統架構。"},
            ],
        }
        sources = smart_annotations._sources(paper)
        keys = [s["key"] for s in sources]
        self.assertEqual(keys, ["l1#0", "l1#1", "fig1#caption"])
        selected = smart_annotations._selected_sources(sources, ["h1"])
        self.assertEqual(len(selected), 3)
        cand = smart_annotations._candidate(self.ws.id, {
            "anchor": "l1", "key": "l1#1", "quote_en": "Second contribution.", "quote_zh": "第二個貢獻。",
            "type": "highlight", "color": "yellow", "note": "貢獻二",
        }, sources, "test-model", "", "2026-01-01")
        self.assertTrue(cand["locatable"])
        self.assertEqual(cand["key"], "l1#1")
        self.assertEqual(cand["quote"], "第二個貢獻。")

    def test_loose_match_handles_weak_model_citations_ellipsis_and_minor_typos(self):
        sources = [{
            "anchor": "p2", "key": "p2", "page": 4, "section": "Experiments", "section_id": "h1",
            "en": "Our **Adaptive-Router** [12, 15] reduces latency by 42.5% compared to the baseline model on ImageNet.",
            "zh": "我們的 **Adaptive-Router** [12, 15] 在 ImageNet 上比基線模型降低了 42.5% 的延遲。",
            "sents": None,
        }]
        # 1. Stripped markdown + omitted inline citation [12, 15]
        loc_cite = smart_annotations._locate(
            "Our Adaptive-Router reduces latency by 42.5% compared to the baseline model",
            "p2", sources, "en"
        )
        self.assertIsNotNone(loc_cite)
        self.assertIn("[12, 15]", loc_cite["quote"])

        # 2. Ellipsis truncation ("前半...後半")
        loc_ellipsis = smart_annotations._locate(
            "Our Adaptive-Router ... compared to the baseline model on ImageNet.",
            "p2", sources, "en"
        )
        self.assertIsNotNone(loc_ellipsis)
        self.assertTrue(loc_ellipsis["quote"].startswith("Our **Adaptive-Router**"))
        self.assertTrue(loc_ellipsis["quote"].endswith("ImageNet."))

        # 3. Minor 1-char typo by weak model ("basline" instead of "baseline")
        loc_typo = smart_annotations._locate(
            "reduces latency by 42.5% compared to the basline model on ImageNet.",
            "p2", sources, "en"
        )
        self.assertIsNotNone(loc_typo)
        self.assertIn("baseline model on ImageNet.", loc_typo["quote"])

    def test_dedupe_prefers_locatable_and_allows_short_underline_inside_highlight(self):
        unlocatable = {
            "annotation_id": "ai-1", "anchor": "p1", "key": "p1", "side": "zh",
            "quote": "我們提出一個新的方法。", "type": "highlight", "color": "yellow",
            "locatable": False, "confidence": 0.95,
        }
        locatable = {
            "annotation_id": "ai-2", "anchor": "p1", "key": "p1", "side": "zh",
            "quote": "我們提出一個新的方法。", "type": "highlight", "color": "yellow",
            "locatable": True, "confidence": 0.75,
        }
        short_term = {
            "annotation_id": "ai-3", "anchor": "p1", "key": "p1", "side": "zh",
            "quote": "新的方法", "type": "underline", "color": "blue",
            "locatable": True, "confidence": 0.85,
        }
        deduped = smart_annotations._dedupe([unlocatable, locatable, short_term])
        ids = [item["annotation_id"] for item in deduped]
        self.assertIn("ai-2", ids)
        self.assertNotIn("ai-1", ids)
        self.assertIn("ai-3", ids)

    def test_reject_all_marks_suggested_items_rejected(self):
        sources = smart_annotations._sources(self.ws.load("paper"))
        c1 = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "新的方法", "type": "underline", "color": "blue", "note": "術語",
        }, sources, "test-model", "", "2026-01-01")
        c2 = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "我們比較結果。", "type": "highlight", "color": "green", "note": "實驗",
        }, sources, "test-model", "", "2026-01-01")
        self.ws.apply_reader_ops([
            {"op": "ai_annotation", "annotation": c1, "at": "2026-01-01T00:00:00+08:00"},
            {"op": "ai_annotation", "annotation": c2, "at": "2026-01-01T00:00:00+08:00"},
        ])
        res = smart_annotations.apply_action(self.ws, {"action": "reject_all"})
        self.assertEqual(res["rejected"], 2)
        reader = self.ws.load("reader")
        self.assertEqual(reader["ai_annotations"][c1["annotation_id"]]["status"], "rejected")
        self.assertEqual(reader["ai_annotations"][c2["annotation_id"]]["status"], "rejected")

    def test_generate_invokes_on_progress_and_saves_incrementally(self):
        from unittest.mock import patch
        progress_calls = []

        def on_prog(done, total, saved):
            progress_calls.append((done, total, saved))

        mock_response = '{"annotations":[{"anchor":"p1","key":"p1","quote":"新的方法","type":"highlight","color":"yellow","note":"方法核心","reason":"重要主張","confidence":0.9}]}'

        with patch("easyread.engines.run", return_value=mock_response):
            result = smart_annotations.generate(self.ws, on_progress=on_prog)

        self.assertEqual(result["count"], 1)
        self.assertTrue(len(progress_calls) >= 2)
        # 初始呼叫 (0, total, 0)
        self.assertEqual(progress_calls[0][0], 0)
        # 完成時呼叫 (1, 1, 1)
        self.assertEqual(progress_calls[-1], (1, 1, 1))
        # 驗證 reader.json 已經寫入
        reader = self.ws.load("reader")
        self.assertEqual(len(reader.get("ai_annotations", {})), 1)

    def test_engines_parse_json_preserves_single_backslash_latex_commands(self):
        from easyread.engines import parse_json
        raw = r'{"items": [{"anchor": "p1", "quote_en": "where $\frac{\beta}{\theta} + \nabla f(\rho) = \text{const}$"}]}'
        parsed = parse_json(raw)
        quote_en = parsed["items"][0]["quote_en"]
        self.assertIn(r"\frac", quote_en)
        self.assertIn(r"\beta", quote_en)
        self.assertIn(r"\theta", quote_en)
        self.assertIn(r"\nabla", quote_en)
        self.assertIn(r"\rho", quote_en)
        self.assertIn(r"\text", quote_en)


    def test_manual_overlap_detection_and_selective_batch_actions(self):
        # 1. User has a manual note in reader
        self.ws.apply_reader_ops([{
            "op": "note",
            "note": {
                "id": "manual-1", "anchor": "p1", "key": "p1", "side": "zh",
                "quote": "我們提出一個新的方法", "color": "yellow", "kind": "highlight",
                "body": "我的重點筆記",
            },
            "at": "2026-10-30T10:00:00Z"
        }])
        reader = self.ws.load("reader")
        manual_notes = smart_annotations._manual_notes_by_anchor(reader)
        self.assertIn("p1", manual_notes)
        self.assertEqual(len(manual_notes["p1"]), 1)

        sources = smart_annotations._sources(self.ws.load("paper"), reader)
        src = next(s for s in sources if s["anchor"] == "p1")

        # 2. Overlapping AI candidate
        overlap_cand = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "我們提出一個新的方法", "color": "green", "type": "highlight"
        }, sources, "m", "p", "2026-10-30T10:05:00Z")
        self.assertIsNotNone(overlap_cand)
        smart_annotations._detect_manual_overlap(overlap_cand, src, manual_notes)
        self.assertTrue(overlap_cand.get("manual_overlap"))
        self.assertEqual(overlap_cand.get("overlap_quote"), "我們提出一個新的方法")

        # 3. Non-overlapping AI candidate
        clean_cand = smart_annotations._candidate(self.ws.id, {
            "anchor": "p1", "quote": "我們比較結果", "color": "yellow", "type": "underline"
        }, sources, "m", "p", "2026-10-30T10:05:00Z")
        self.assertIsNotNone(clean_cand)
        smart_annotations._detect_manual_overlap(clean_cand, src, manual_notes)
        self.assertFalse(clean_cand.get("manual_overlap"))

        # Put both into ai_annotations
        self.ws.apply_reader_ops([
            {"op": "ai_annotation", "annotation": overlap_cand, "at": "2026-10-30T10:05:00Z"},
            {"op": "ai_annotation", "annotation": clean_cand, "at": "2026-10-30T10:05:00Z"},
        ])

        # 4. Default accept_all does NOT accept overlapping candidate
        res = smart_annotations.apply_action(self.ws, {"action": "accept_all", "include_overlap": False})
        self.assertEqual(res.get("accepted"), 1)
        r_after = self.ws.load("reader")
        self.assertEqual(r_after["ai_annotations"][clean_cand["annotation_id"]]["status"], "accepted")
        self.assertEqual(r_after["ai_annotations"][overlap_cand["annotation_id"]]["status"], "pending")
        # Manual note is never overwritten or deleted
        self.assertIn("manual-1", r_after["notes"])
        self.assertEqual(r_after["notes"]["manual-1"]["body"], "我的重點筆記")

        # 5. reject_overlaps rejects only the overlapping item
        res_rej = smart_annotations.apply_action(self.ws, {"action": "reject_overlaps"})
        self.assertEqual(res_rej.get("rejected"), 1)
        r_rej = self.ws.load("reader")
        self.assertEqual(r_rej["ai_annotations"][overlap_cand["annotation_id"]]["status"], "rejected")

    def test_intensity_modes_and_semantics(self):
        self.assertIn("concise", smart_annotations.INTENSITY_MODES)
        self.assertIn("standard", smart_annotations.INTENSITY_MODES)
        self.assertIn("detailed", smart_annotations.INTENSITY_MODES)

        paper = self.ws.load("paper")
        sources = smart_annotations._sources(paper)
        prompt_concise = smart_annotations._prompt("測試論文", "auto", "", sources, intensity="concise")
        self.assertIn("精簡模式", prompt_concise)
        self.assertIn("核心主張", prompt_concise)
        self.assertIn("關鍵詞", prompt_concise)

        prompt_detailed = smart_annotations._prompt("測試論文", "auto", "", sources, intensity="detailed")
        self.assertIn("詳細模式", prompt_detailed)

    def test_research_task_external_registry(self):
        from easyread.research import tasks as rtasks
        task_id = "test-smart-annotate-1"
        registered = rtasks.register_external(task_id, "smart-annotate", scope="test-scope", key="paper-1", paper_id="paper-1", title="Test Paper")
        self.assertEqual(registered["id"], task_id)
        self.assertEqual(registered["kind"], "smart-annotate")
        self.assertEqual(registered["state"], "queued")

        updated = rtasks.update_external(task_id, state="running", done=1, total=5, message="正在分析第 2 / 5 批...")
        self.assertEqual(updated["state"], "running")
        self.assertEqual(updated["done"], 1)
        self.assertEqual(updated["total"], 5)

        done = rtasks.update_external(task_id, state="completed", done=5, total=5, message="完成", result={"count": 12})
        self.assertEqual(done["state"], "completed")

        items = rtasks.list_tasks(scope="test-scope")
        found = next((t for t in items if t["id"] == task_id), None)
        self.assertIsNotNone(found)
        self.assertEqual(found["state"], "completed")


if __name__ == "__main__":
    unittest.main()
