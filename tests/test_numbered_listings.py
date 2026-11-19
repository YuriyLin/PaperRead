"""Regression tests for Issue #159: numbered code listings as figures and bare TeX pseudocode layout checks."""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread import checks, engines, numbered_listings, translate
from tests.test_translate import make_ws


class NumberedListingsTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_read_listings_detects_numbered_code_followed_by_figure_caption(self):
        (self.ws.root / "extract" / "page-001.txt").write_text(
            "1 int main() {\n"
            "2   int x := 1;\n"
            "3   return foo(x);\n"
            "4 }\n"
            "Figure 2: Example code listing.\n",
            encoding="utf-8",
        )
        listings = numbered_listings.read_listings(self.ws.root / "extract", 1)
        self.assertIn("2", listings)
        code, caption = listings["2"]
        self.assertIn("return foo(x);", code)
        self.assertEqual(caption, "Figure 2: Example code listing.")

    def test_read_listings_ignores_plain_numbered_prose(self):
        (self.ws.root / "extract" / "page-001.txt").write_text(
            "1 First step of the proof.\n"
            "2 Second step of the proof.\n"
            "3 Third step of the proof.\n"
            "Figure 2: Not a listing.\n",
            encoding="utf-8",
        )
        self.assertEqual(numbered_listings.read_listings(self.ws.root / "extract", 1), {})

    def test_translate_pages_retries_when_model_omits_listing_figure(self):
        (self.ws.root / "extract" / "page-001.txt").write_text(
            "1 int main() {\n"
            "2   int x := 1;\n"
            "3   return foo(x);\n"
            "4 }\n"
            "Figure 2: Example code listing.\n",
            encoding="utf-8",
        )
        calls = []
        outputs = iter([
            json.dumps({
                "blocks": [
                    {"id": "p1-1", "type": "para", "page": 1, "en": "Some prose.", "zh": "一段正文。"},
                ]
            }),
            json.dumps({
                "blocks": [
                    {"id": "p1-1", "type": "para", "page": 1, "en": "Some prose.", "zh": "一段正文。"},
                    {"id": "fig2", "type": "figure", "page": 1, "num": "2", "src": "", "box": [0.1, 0.2, 0.9, 0.5], "caption_en": "Figure 2: Example code listing.", "caption_zh": "圖 2：程式碼範例。"},
                ]
            }),
        ])

        def fake_run(cfg, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            calls.append(prompt)
            return next(outputs)

        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(translate.figures, "crop", return_value="figures/crop-1-fig2.webp"), \
             mock.patch.object(engines, "run", fake_run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)

        self.assertEqual(failed, {})
        self.assertEqual(len(calls), 2)
        self.assertIn("p.1 Figure 2: Example code listing.", calls[0])
        blocks = self.ws.load("paper")["blocks"]
        self.assertEqual([b["id"] for b in blocks], ["p1-1", "fig2"])

    def test_checks_flags_bare_textbf_and_quad_pseudocode_layout(self):
        block = {
            "id": "p1-1",
            "type": "para",
            "en": r"\textbf{Algorithm 1} \quad $x \leftarrow 1$",
            "zh": r"\textbf{演算法 1} \quad $x \leftarrow 1$",
        }
        bad, warn = checks.block_problems([block])
        problems = bad + warn
        self.assertTrue(any("伪代码" in p or "裸露" in p or "textbf" in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main()
