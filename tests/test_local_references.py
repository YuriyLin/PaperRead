"""Tests for local bibliography/references parsing (no LLM calls)."""
from __future__ import annotations

import json
import shutil
import threading
import unittest
from unittest import mock

from easyread import engines, local_references, translate
from tests.test_translate import make_ws


class LocalReferencesUnitTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(5)
        self.cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        self.patches = [
            mock.patch.object(translate.pdfwork, "locate", lambda root: None),
            mock.patch.object(translate, "tex_problems", lambda tex: []),
            mock.patch.object(translate.netcheck, "problem", return_value=None),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_pure_ref_pages_skip_llm_and_merge_wrapped_entries(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("Introduction to the paper and methods." * 3, encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text("Experiments and final conclusion here." * 3, encoding="utf-8")
        (self.ws.root / "extract" / "page-003.txt").write_text(
            "References\n\n"
            "[1] Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS 2017.\n"
            "[2] Devlin, J., Chang, M.-W. BERT: Pre-training of deep bidirec-\n"
            "tional transformers for language under-",
            encoding="utf-8",
        )
        (self.ws.root / "extract" / "page-004.txt").write_text(
            "standing. NAACL 2019.\n"
            "[3] Brown, T. et al. Language models are few-shot learners. NeurIPS 2020.\n",
            encoding="utf-8",
        )
        (self.ws.root / "extract" / "page-005.txt").write_text(
            "Appendix A: Additional Proofs\n\nTheorem 1 follows directly from Lemma 2.",
            encoding="utf-8",
        )

        called_pages = []

        def fake_run(cfg, prompt, root, images=None, cancel=None, meter=None, json_mode=False):
            import re
            m = re.search(r"(?:這次只處理第|这次只处理第) ([\d, ]+) (?:頁|页)", prompt)
            pg = int(m[1].split(",")[0])
            called_pages.append(pg)
            if pg == 5:
                return json.dumps({
                    "blocks": [
                        {"id": "sA", "type": "heading", "level": 1, "appendix": True, "page": 5, "en": "Appendix A: Additional Proofs", "zh": "附錄 A：補充證明"},
                        {"id": "p5-1", "type": "para", "page": 5, "en": "Theorem 1 follows directly from Lemma 2.", "zh": "定理 1 可由引理 2 直接推出。"},
                    ]
                })
            return json.dumps({"blocks": [{"id": f"p{pg}-1", "type": "para", "page": pg, "en": f"Body {pg}", "zh": f"譯文 {pg}"}]})

        with mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3, 4, 5], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        # Pure reference pages 3 and 4 MUST NOT trigger LLM calls; page 5 Appendix MUST resume LLM calls.
        self.assertEqual(called_pages, [1, 2, 5])
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 3, 4, 5])
        self.assertEqual(paper["translation"].get("en_pages", []), [])
        refs = paper["references"]
        self.assertEqual([r["id"] for r in refs], ["1", "2", "3"])
        self.assertIn("bidirectional transformers for language understanding", refs[1]["text"])
        self.assertEqual([b["type"] for b in paper["blocks"]], ["para", "para", "references", "heading", "para"])
        self.assertEqual(paper["blocks"][2]["page"], 3)

    def test_split_page_sends_only_prose_before_references_to_llm(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("Main body content on page 1." * 3, encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text(
            "Conclusion. Our method significantly improves accuracy across benchmarks.\n\n"
            "References\n\n"
            "Al-Busaidi, A. S. (2024). Paper title about LLMs. Journal of AI.\n"
            "Available at: https://example.com/paper\n\n"
            "Smith, J. and Lee, K. (2023). Another study on reading systems.",
            encoding="utf-8",
        )
        prompts_seen = []

        def fake_run(cfg, prompt, root, images=None, cancel=None, meter=None, json_mode=False):
            prompts_seen.append(prompt)
            import re
            pg = int(re.search(r"(?:這次只處理第|这次只处理第) ([\d, ]+) (?:頁|页)", prompt)[1].split(",")[0])
            if pg == 2:
                self.assertIn("Conclusion. Our method significantly improves accuracy", prompt)
                self.assertNotIn("Al-Busaidi", prompt)
                return json.dumps({
                    "blocks": [
                        {"id": "p2-1", "type": "para", "page": 2, "en": "Conclusion. Our method significantly improves accuracy across benchmarks.", "zh": "結論。我們的方法顯著提升了準確率。"},
                    ]
                })
            return json.dumps({"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "Main body", "zh": "正文"}]})

        with mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        paper = self.ws.load("paper")
        self.assertEqual(len(paper["references"]), 2)
        self.assertEqual(paper["references"][0]["id"], "Al-Busaidi-2024")
        self.assertIn("Available at: https://example.com/paper", paper["references"][0]["text"])
        self.assertEqual(paper["references"][1]["id"], "Smith-2023")
        self.assertEqual([b["type"] for b in paper["blocks"]], ["para", "para", "references"])

    def test_dotted_and_alpha_key_styles(self):
        dotted = local_references.parse_entries([
            (3, "1. Alpha, A. First paper, 2020.\n2. Beta, B. Second paper, 2021."),
        ])
        self.assertEqual([e["id"] for e in dotted], ["1", "2"])
        alpha = local_references.parse_entries([
            (4, "[JYW+24] Jin et al. Title one. 2024.\n[AB23a] Alice & Bob. Title two. 2023."),
        ])
        self.assertEqual([e["id"] for e in alpha], ["JYW+24", "AB23a"])

    def test_disabled_flag_skips_local_parser(self):
        (self.ws.root / "extract" / "page-001.txt").write_text("Intro text.", encoding="utf-8")
        (self.ws.root / "extract" / "page-002.txt").write_text("References\n[1] Some citation.", encoding="utf-8")
        cfg = dict(self.cfg, local_references=False)
        calls = []

        def fake_run(cfg_, prompt, root, images=None, cancel=None, meter=None, json_mode=False):
            import re
            pg = int(re.search(r"(?:這次只處理第|这次只处理第) ([\d, ]+) (?:頁|页)", prompt)[1].split(",")[0])
            calls.append(pg)
            if pg == 2:
                return json.dumps({
                    "references": [{"id": "1", "text": "Some citation."}],
                    "blocks": [{"id": "refs", "type": "references", "page": 2, "en": "References", "zh": "參考文獻"}],
                })
            return json.dumps({"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "Intro text.", "zh": "引言"}]})

        with mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1, 2], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        self.assertEqual(calls, [1, 2])


if __name__ == "__main__":
    unittest.main()
