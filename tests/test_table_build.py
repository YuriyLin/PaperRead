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

    def test_prerender_table_applies_cell_nowrap_to_short_labels_only(self):
        paper = {
            "meta": {"title_zh": "測試論文", "page_count": 1},
            "blocks": [
                {
                    "id": "tab1",
                    "type": "table",
                    "page": 1,
                    "head": [["司法管轄區", "社會法律語境中之定義", "主要架構"]],
                    "rows": [["Singapore", "Model AI Governance Framework with long description.", "Framework summary text"]],
                },
                {
                    "id": "tab5",
                    "type": "table",
                    "page": 2,
                    "align": "lrrrrr",
                    "head": [["Reward", "mAP", "GP", "GR", "Cel", "OVDEval"]],
                    "rows": [[r"$s_{ovd} \cdot \mathrm{mAP}$", "21.1", "67.34", "43.84", "55.0", "31.01"]],
                },
            ],
        }
        html = build._prerender_paper(paper, {}, {})
        self.assertIn('<th class="cell-nowrap">司法管轄區</th>', html)
        self.assertIn('<th>社會法律語境中之定義</th>', html)
        self.assertIn('<td class="cell-nowrap">Singapore</td>', html)
        self.assertIn('<td>Model AI Governance Framework with long description.</td>', html)
        self.assertIn('<th class="cell-nowrap" style="text-align:left">Reward</th>', html)
        self.assertIn('<td class="cell-nowrap" style="text-align:left">', html)

    def test_prerender_table_marks_row_group_dividers(self):
        paper = {
            "meta": {"title_zh": "測試論文", "page_count": 1},
            "blocks": [
                {
                    "id": "tab3",
                    "type": "table",
                    "page": 9,
                    "head": [["", "N", "PPL", "BLEU"]],
                    "rows": [
                        ["base", "6", "4.92", "25.8"],
                        ["(A)", "1", "5.29", "24.9"],
                        ["", "4", "5.00", "25.5"],
                        ["(B)", "16", "5.16", "25.1"],
                        ["big", "6", "4.33", "26.4"],
                    ],
                },
            ],
        }
        html = build._prerender_paper(paper, {}, {})
        self.assertIn('<tr class="tbl-group"><td class="cell-nowrap">(A)</td>', html)
        self.assertIn('<tr class="tbl-group"><td class="cell-nowrap">(B)</td>', html)
        self.assertIn('<tr class="tbl-group"><td class="cell-nowrap">big</td>', html)
        self.assertIn('<tr><td></td><td class="cell-nowrap">4</td>', html)


if __name__ == "__main__":
    unittest.main()
