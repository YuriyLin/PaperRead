"""Tests for offline HTML prerendering of tables and figures in build.py."""
import unittest

from easyread import build


class TableBuildTest(unittest.TestCase):
    def test_prerender_paper_renders_full_html_tables_with_notes_and_indent(self):
        paper = {
            "meta": {"title_zh": "測試論文", "page_count": 1},
            "blocks": [
                {
                    "id": "tab1",
                    "type": "table",
                    "page": 1,
                    "align": "lr",
                    "head": ["Method", "Score"],
                    "rows": [
                        ["Baseline", "0.80"],
                        ["  + Ours", "0.92\n(+0.12)"],
                        ["Note: bold indicates best.", ""],
                    ],
                    "caption_zh": "表 1：實驗結果",
                }
            ],
        }
        html = build._prerender_paper(paper, {}, {})
        self.assertIn('<table class="tbl">', html)
        self.assertIn('style="text-align:right">0.80</td>', html)
        self.assertIn("\u00a0\u00a0+ Ours", html)
        self.assertIn('<span class="sub">(+0.12)</span>', html)
        self.assertIn('<div class="caption table-note">', html)
        self.assertIn("表 1", html)

    def test_collect_math_items_scans_table_cells(self):
        paper = {
            "blocks": [
                {
                    "id": "tab1",
                    "type": "table",
                    "head": ["Metric $M_1$"],
                    "rows": [["$\\alpha$", "0.5"]],
                    "caption_zh": "表 $T_1$",
                }
            ]
        }
        items = build._collect_math_items(paper, {})
        texs = {item["tex"] for item in items}
        self.assertIn("M_1", texs)
        self.assertIn("\\alpha", texs)
        self.assertIn("T_1", texs)


if __name__ == "__main__":
    unittest.main()
