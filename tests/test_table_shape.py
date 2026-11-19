"""Regression tests for malformed table shapes in translation and saved paper data."""
import threading
import unittest
from unittest import mock

from easyread import checks, engines, paperdata, translate
from tests.test_translate import make_ws


class TableShapeValidationTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_flat_head_is_reported_by_checks(self):
        block = {
            "id": "tab1",
            "type": "table",
            "page": 1,
            "head": ["Method", "Score"],
            "rows": [["A", "0.8"]],
        }
        problems, _ = checks.block_problems([block])
        self.assertTrue(any("二维数组" in problem for problem in problems), problems)

    def test_merge_rejects_flat_head_without_marking_page_done(self):
        block = {
            "id": "tab1",
            "type": "table",
            "page": 1,
            "head": ["Method", "Score"],
            "rows": [["A", "0.8"]],
        }
        with self.assertRaises(ValueError):
            paperdata.merge_blocks(self.ws, {"blocks": [block]}, done=[1], replace_pages=[1])
        paper = self.ws.load("paper")
        self.assertEqual(paper.get("blocks", []), [])
        self.assertEqual(paper.get("translation", {}).get("done_pages", []), [])

    def test_fill_translation_rejects_flat_head(self):
        self.ws.update("paper", lambda p: p.update({
            "blocks": [{
                "id": "tab1",
                "type": "table",
                "page": 1,
                "head": [["Method", "Score"]],
                "rows": [["A", "0.8"]],
            }],
            "translation": {"done_pages": [], "en_pages": [1]},
        }))
        with self.assertRaises(ValueError):
            paperdata.fill_zh(
                self.ws,
                {"zh": {"tab1#head": ["方法", "分数"]}},
                [1],
                {"tab1#head"},
            )
        self.assertEqual(self.ws.load("paper")["blocks"][0]["head"], [["Method", "Score"]])

    def test_translation_page_fails_instead_of_saving_flat_head(self):
        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None, json_mode=False):
            return '{"blocks":[{"id":"tab1","type":"table","page":1,"head":["Method","Score"],"rows":[["A","0.8"]]}]}'

        cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        with mock.patch.object(translate.pdfwork, "locate", lambda root: None), \
             mock.patch.object(translate, "tex_problems", lambda tex: []), \
             mock.patch.object(engines, "run", run):
            failed = translate.translate_pages(self.ws, cfg, [1], threading.Event(), lambda *a: None)
        self.assertIn(1, failed)
        paper = self.ws.load("paper")
        self.assertEqual(paper.get("blocks", []), [])
        self.assertEqual(paper.get("translation", {}).get("done_pages", []), [])


if __name__ == "__main__":
    unittest.main()
