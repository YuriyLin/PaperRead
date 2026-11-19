"""Regression tests for custom_prompt, OutputLimitReached recovery, footnote normalization, and Issue #10 (/part/item)."""
import http.client
import json
import shutil
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread import engines, openai_api, prompts, server, translate
from tests.test_translate import make_ws


class Issue9And10PythonTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_prompt_appends_custom_prompt_and_keeps_upstream_table_rules(self):
        prompt = prompts.translate(
            self.ws,
            [1],
            "text",
            "",
            custom_prompt="法學專有名詞請保持一致",
        )
        self.assertIn("Table 2:", prompt)
        self.assertIn("法學專有名詞請保持一致", prompt)

    def test_normalize_keeps_table_blocks_for_upstream_rendering(self):
        raw = {
            "blocks": [
                {
                    "id": "tab1",
                    "type": "table",
                    "page": 1,
                    "head": ["Author", "Score"],
                    "rows": [["Alice", "0.95"]],
                    "caption_zh": "作者得分",
                }
            ]
        }
        out = translate._normalize(raw, [1], set())
        self.assertEqual(len(out["blocks"]), 1)
        self.assertEqual(out["blocks"][0]["type"], "table")
        self.assertEqual(out["blocks"][0]["rows"], [["Alice", "0.95"]])

    def test_normalize_converts_footnote_type_to_para(self):
        raw = {
            "blocks": [
                {"id": "ref6", "type": "footnote", "page": 9, "num": "6", "en": "See SPC.", "zh": "見最高人民法院。"},
                {"id": "x1", "type": "weird_type", "page": 9, "en": "Text.", "zh": "文字。"},
                {"id": "empty1", "type": "weird_type", "page": 9},
            ]
        }
        out = translate._normalize(raw, [9], set())
        self.assertEqual(len(out["blocks"]), 2)
        self.assertEqual(out["blocks"][0]["type"], "para")
        self.assertEqual(out["blocks"][0]["role"], "footnote")
        self.assertEqual(out["blocks"][1]["type"], "para")
        self.assertEqual(translate._problems(out), [])

    def test_single_page_output_limit_splits_into_structure_and_fill_with_custom_prompt(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("A short sentence.", encoding="utf-8")
        calls = []
        outputs = iter([
            None,
            {"blocks": [{"id": "p1-1", "page": 1, "type": "para", "en": "A short sentence."}]},
            {"zh": {"p1-1": "短句。"}},
        ])

        def fake_run(cfg, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            calls.append(prompt)
            item = next(outputs)
            if item is None:
                raise openai_api._truncated()
            return json.dumps(item)

        cfg = {
            "engine": "openai",
            "batch_pages": 1,
            "concurrency": 1,
            "custom_prompt": "請使用台灣法律用語",
            "openai": {"preset": "ollama", "vision": False},
        }
        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        self.assertEqual(len(calls), 3)
        self.assertNotIn("請使用台灣法律用語", calls[1])
        self.assertIn("請使用台灣法律用語", calls[2])
        paper = self.ws.load("paper")
        self.assertEqual(paper["blocks"][0]["zh"], "短句。")
        self.assertEqual(paper["translation"]["en_pages"], [])

    def test_single_page_output_limit_resumes_en_page_and_preserves_existing_retranslation(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("A short sentence.", encoding="utf-8")
        outputs = iter([
            None,
            {"blocks": [{"id": "p1-1", "page": 1, "type": "para", "en": "A short sentence."}]},
            None,
            {"zh": {"p1-1": "短句。"}},
            None,
        ])

        def fake_run(cfg, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            item = next(outputs)
            if item is None:
                raise openai_api._truncated()
            return json.dumps(item)

        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_run):
            failed1 = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertIn(1, failed1)
            self.assertNotIn("每次交给模型的页数", failed1[1])
            self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [1])

            failed2 = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertEqual(failed2, {})
            before = self.ws.load("paper")["blocks"]

            failed3 = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertIn(1, failed3)
            self.assertEqual(self.ws.load("paper")["blocks"], before)

    def test_part_item_endpoint_returns_200(self):
        self.ws.patch_item({"meta_override": {"title_zh": "自訂標題"}})
        lib = mock.MagicMock()
        lib.ws.return_value = self.ws
        loc = mock.MagicMock()
        loc.status = "idle"
        app = mock.MagicMock()
        app.lib = lib
        app.location = loc
        app.token = "tok"

        app.hosts = server.allowed_hosts("127.0.0.1")

        import http.server
        handler_cls = type("TestHandler", (server.Handler,), {"app": app})
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        conn = None
        try:
            conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
            conn.request("GET", f"/api/p/{self.ws.id}/part/item")
            resp = conn.getresponse()
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertEqual(body["data"]["meta_override"]["title_zh"], "自訂標題")
            self.assertTrue(body["version"])
        finally:
            if conn:
                conn.close()
            srv.shutdown()
            srv.server_close()

    def test_retranslation_uses_staged_fallback_and_restores_on_failure(self):
        self.ws.update("paper", lambda p: p.update({
            "blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "Old text.", "zh": "舊譯文。"}],
            "translation": {"done_pages": [1], "en_pages": []},
        }))
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}

        # Case A: staged fallback fails during fill -> original blocks & done_pages must be restored
        calls_a = []
        def fake_fail_fill(cfg_, prompt, root, images, cancel, meter, **kwargs):
            calls_a.append(prompt)
            if len(calls_a) == 1:
                raise engines.OutputLimitReached("truncated")
            if len(calls_a) == 2:
                return json.dumps({"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "New text."}]})
            raise engines.EngineError("fill failed")

        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_fail_fill):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertIn(1, failed)
            paper = self.ws.load("paper")
            self.assertEqual(paper["blocks"][0]["zh"], "舊譯文。")
            self.assertEqual(paper["translation"]["done_pages"], [1])
            self.assertEqual(paper["translation"]["en_pages"], [])

        # Case B: staged fallback succeeds -> new translation replaces old
        calls_b = []
        def fake_ok(cfg_, prompt, root, images, cancel, meter, **kwargs):
            calls_b.append(prompt)
            if len(calls_b) == 1:
                raise engines.OutputLimitReached("truncated")
            if len(calls_b) == 2:
                return json.dumps({"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "New text."}]})
            return json.dumps({"zh": {"p1-1": "新譯文。"}})

        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_ok):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
            self.assertEqual(failed, {})
            self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"], "新譯文。")

    def test_fill_batch_splits_on_output_limit_and_retries_missing(self):
        self.ws.update("paper", lambda p: p.update({
            "blocks": [
                {"id": "p1-1", "type": "para", "page": 1, "en": "One."},
                {"id": "p1-2", "type": "para", "page": 1, "en": "Two."},
                {"id": "p1-3", "type": "para", "page": 1, "en": "Three."},
            ],
            "translation": {"done_pages": [1], "en_pages": [1]},
        }))
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        calls = []

        def fake_run(cfg_, prompt, root, images, cancel, meter, **kwargs):
            calls.append(prompt)
            if len(calls) == 1:
                raise engines.OutputLimitReached("too long")
            if '"p1-1"' in prompt and '"p1-2"' not in prompt:
                return json.dumps({"zh": {"p1-1": "一。"}})
            if '"p1-2"' in prompt and '"p1-3"' in prompt:
                return json.dumps({"zh": {"p1-2": "二。"}})  # deliberately miss p1-3
            if '"p1-3"' in prompt:
                return json.dumps({"zh": {"p1-3": "三。"}})
            raise AssertionError("unexpected prompt")

        with mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        blocks = self.ws.load("paper")["blocks"]
        self.assertEqual([b["zh"] for b in blocks], ["一。", "二。", "三。"])
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [])

    def test_prefer_staged_persists_across_pages_in_same_job(self):
        (self.ws.root / "extract" / "page-002.txt").write_text("Second page.", encoding="utf-8")
        self.ws.update("paper", lambda p: p["meta"].update({
            "page_count": 2,
            "pages": [{"n": 1, "w": 600, "h": 800}, {"n": 2, "w": 600, "h": 800}],
        }))
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        modes = []

        def fake_run(cfg_, prompt, root, images, cancel, meter, **kwargs):
            is_struct = "整理要求（不翻譯）" in prompt or "整理要求（不翻译）" in prompt
            is_fill = "原文已經整理成塊" in prompt or "原文已经整理成块" in prompt
            modes.append("struct" if is_struct else "fill" if is_fill else "single")
            if len(modes) == 1:
                raise engines.OutputLimitReached("truncated")
            if is_struct:
                pg = 1 if ("只處理第 1 頁" in prompt or "只处理第 1 页" in prompt) else 2
                return json.dumps({"blocks": [{"id": f"p{pg}-1", "type": "para", "page": pg, "en": f"Page {pg}."}]})
            pg = 1 if "p1-1" in prompt else 2
            return json.dumps({"zh": {f"p{pg}-1": f"第{pg}頁。"}})

        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1, 2], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        # Page 1: single (truncated) -> struct -> fill. Page 2: directly struct -> fill (no single!).
        self.assertEqual(modes, ["single", "struct", "fill", "struct", "fill"])

    def test_glossary_filtering_for_large_glossary(self):
        from easyread import prompts
        (self.ws.root / "extract" / "page-001.txt").write_text("We study attention mechanism here.", encoding="utf-8")
        glossary = [{"en": f"unused term {i}", "zh": f"無關詞 {i}"} for i in range(30)]
        glossary[3] = {"en": "attention mechanism", "zh": "注意力機制"}
        self.ws.update("paper", lambda p: p.__setitem__("glossary", glossary))
        ctx = prompts._context(self.ws, [1])
        self.assertIn("attention mechanism = 注意力機制", ctx)
        self.assertNotIn("unused term 0", ctx)
        self.assertIn("unused term 29", ctx)  # recent 10 retained

    def test_structure_split_page_on_output_limit(self):
        (self.ws.root / "extract" / "page-001.txt").write_text(
            "Para one.\n\nPara two.\n\nPara three.\n\nPara four.",
            encoding="utf-8",
        )
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        calls = []

        def fake_run(cfg_, prompt, root, images, cancel, meter, **kwargs):
            calls.append(prompt)
            is_struct = "整理要求（不翻譯）" in prompt or "整理要求（不翻译）" in prompt
            if not is_struct and "原文已經整理成塊" not in prompt and "原文已经整理成块" not in prompt:
                raise engines.OutputLimitReached("single stage truncated")
            if is_struct:
                if "Para one." in prompt and "Para four." in prompt:
                    raise engines.OutputLimitReached("full structure truncated")
                if "Para one." in prompt:
                    return json.dumps({"blocks": [
                        {"id": "p1-1", "type": "para", "page": 1, "en": "Para one."},
                        {"id": "p1-2", "type": "para", "page": 1, "en": "Para two."},
                    ]})
                if "Para three." in prompt:
                    return json.dumps({"blocks": [
                        {"id": "p1-3", "type": "para", "page": 1, "en": "Para three."},
                        {"id": "p1-4", "type": "para", "page": 1, "en": "Para four."},
                    ]})
                raise AssertionError(f"unexpected struct prompt: {prompt[-200:]}")
            return json.dumps({"zh": {"p1-1": "第一段。", "p1-2": "第二段。", "p1-3": "第三段。", "p1-4": "第四段。"}})

        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        blocks = self.ws.load("paper")["blocks"]
        self.assertEqual([b["zh"] for b in blocks], ["第一段。", "第二段。", "第三段。", "第四段。"])

    def test_page_text_strips_watermarks_and_running_headers(self):
        from easyread import prompts
        bodies = {
            1: (
                "First page introduces relational protocols in Asian AI governance.\n\n"
                "Cross-cultural norms shape how users interact with autonomous agents.\n\n"
                "Legal scholarship increasingly focuses on co-developmental human-machine ties.\n\n"
                "Second paragraph discusses foundational constitutional principles."
            ),
            2: (
                "Comparative analysis examines China, Singapore, and India.\n\n"
                "Each jurisdiction adopts distinct administrative registration or soft-law tools.\n\n"
                "Judicial interpretation mediates between innovation incentives and public trust.\n\n"
                "Regulatory frameworks balance innovation and accountability."
            ),
            3: (
                "Empirical findings highlight multi-stakeholder dialogue norms.\n\n"
                "Public consultations reveal varying expectations across demographic groups.\n\n"
                "Technical safeguards must align with procedural fairness guarantees.\n\n"
                "Judicial oversight remains essential for redress."
            ),
            4: "Standalone short page body.",
        }
        for pg in (1, 2, 3, 4):
            (self.ws.root / "extract" / f"page-{pg:03d}.txt").write_text(
                f"Journal Name {100 + pg}\n\n{bodies[pg]}\n\n"
                f"{100 + pg} Author Name\n"
                f"{pg}\n"
                "https://www.cambridge.org/core/terms. https://doi.org/10.1017/test\n"
                "Downloaded from https://www.cambridge.org/core. IP address: 1.2.3.4, subject to terms",
                encoding="utf-8",
            )
        cleaned2 = prompts.page_text(self.ws, 2)
        self.assertIn("Comparative analysis examines China, Singapore, and India.", cleaned2)
        self.assertIn("Regulatory frameworks balance innovation and accountability.", cleaned2)
        self.assertNotIn("Journal Name", cleaned2)
        self.assertNotIn("Author Name", cleaned2)
        self.assertNotIn("Downloaded from", cleaned2)
        self.assertNotIn("cambridge.org/core/terms", cleaned2)
        cleaned4 = prompts.page_text(self.ws, 4)
        self.assertIn("Standalone short page body.", cleaned4)
        self.assertNotIn("Journal Name", cleaned4)
        self.assertNotIn("Downloaded from", cleaned4)

    def test_hallucinated_references_before_references_page_are_dropped(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("Body text on page 1.", encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text("References\n\n[1] Real ref.", encoding="utf-8")
        self.ws.update("paper", lambda p: p["meta"].update({"page_count": 2, "pages": [{"n": 1, "w": 600, "h": 800}, {"n": 2, "w": 600, "h": 800}]}))
        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}

        def fake_run(cfg_, prompt, root, images, cancel, meter, **kwargs):
            return json.dumps({
                "references": [{"id": "1", "text": "Fake hallucinated ref"}],
                "blocks": [
                    {"id": "p1-1", "type": "para", "page": 1, "en": "Body text on page 1.", "zh": "第一頁正文。"},
                    {"id": "refs-1", "type": "references", "page": 1, "en": "References", "zh": "參考文獻"},
                ],
            })

        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        paper = self.ws.load("paper")
        self.assertEqual([b["type"] for b in paper["blocks"]], ["para"])
        self.assertEqual(paper.get("references", []), [])

    def test_align_table_head_strips_leading_empty_column(self):
        from easyread import paperdata
        paperdata.merge_blocks(self.ws, {"blocks": [{
            "id": "tab3", "type": "table", "page": 1,
            "head": [["", "Jurisdiction", "Framework", "Pillars"]],
            "rows": [["Singapore", "MGF", "Risk evaluation"]],
        }]}, done=[1], replace_pages=[1])
        self.assertEqual(self.ws.load("paper")["blocks"][0]["head"], [["Jurisdiction", "Framework", "Pillars"]])
        paperdata.fill_zh(self.ws, {"zh": {"tab3#head": [["", "司法管轄區", "主要架構", "核心支柱"]]}}, [1], {"tab3#head"})
        self.assertEqual(self.ws.load("paper")["blocks"][0]["head"], [["司法管轄區", "主要架構", "核心支柱"]])

    def test_reconcile_float_numbers_fixes_misnumbered_table(self):
        (self.ws.root / "extract" / "page-005.txt").write_text(
            "Intro.\n\nTable 2. Indian Seven Sutras\n\nTrust is the foundation.",
            encoding="utf-8",
        )
        blocks = [{"id": "tab3-2", "type": "table", "page": 5, "num": "3",
                   "caption_en": "Table 3. Indian Seven Sutras", "caption_zh": "表 3. 印度七經",
                   "head": [["A", "B"]], "rows": [["1", "2"]]}]
        translate._reconcile_float_numbers(blocks, self.ws.root / "extract")
        self.assertEqual(blocks[0]["num"], "2")
        self.assertEqual(blocks[0]["caption_en"], "Table 2. Indian Seven Sutras")
        self.assertEqual(blocks[0]["caption_zh"], "表 2. 印度七經")

    def test_float_order_respects_page_boundary(self):
        from easyread import float_order
        blocks = [
            {"id": "p5-1", "type": "para", "page": 5},
            {"id": "tab3", "type": "table", "page": 6},
            {"id": "p6-1", "type": "para", "page": 6},
        ]
        # Even if p5-1 was mis-located on page 6 below tab3, tab3 (page 6) must not move before page 5 blocks.
        layout = {
            "p5-1": {"page": 6, "box": [0.1, 0.5, 0.9, 0.6], "src": "text"},
            "tab3": {"page": 6, "box": [0.1, 0.08, 0.9, 0.25], "src": "caption"},
            "p6-1": {"page": 6, "box": [0.1, 0.3, 0.9, 0.4], "src": "text"},
        }
        self.assertIsNone(float_order.order(blocks, layout))

    def test_collect_reference_blocks_groups_bibliography_and_keeps_prose(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("Intro text.", encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text("Acknowledgements.\n\nReferences\n\nAl-Busaidi (2024). Title.", encoding="utf-8")
        self.ws.update("paper", lambda p: p["meta"].update({"page_count": 2, "pages": [{"n": 1, "w": 600, "h": 800}, {"n": 2, "w": 600, "h": 800}]}))
        data = {
            "blocks": [
                {"id": "p2-1", "type": "para", "page": 2, "en": "Acknowledgements. Thanks to everyone.", "zh": "致謝。"},
                {"id": "h2-1", "type": "heading", "page": 2, "en": "References", "zh": "參考文獻"},
                {"id": "p2-2", "type": "para", "page": 2, "en": "Al-Busaidi, A. S. (2024). Paper title.", "zh": "Al-Busaidi 論文"},
                {"id": "p2-3", "type": "para", "page": 2, "en": "Available at: https://example.com (Accessed: June 2026).", "zh": "網址"},
            ],
            "references": [],
        }
        translate._collect_reference_blocks(self.ws, data, [2])
        self.assertEqual([b["type"] for b in data["blocks"]], ["para", "references"])
        self.assertEqual(data["blocks"][0]["id"], "p2-1")
        self.assertEqual(len(data["references"]), 1)
        self.assertEqual(data["references"][0]["id"], "Al-Busaidi-2024")
        self.assertIn("Available at: https://example.com", data["references"][0]["text"])


if __name__ == "__main__":
    unittest.main()
