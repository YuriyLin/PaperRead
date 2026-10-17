"""Phase A: stored table structure and compatibility; no recognition or model calls."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from easyread import build, checks, paperdata, tables, traditional
from easyread.store import Workspace, write_json_atomic


def bilingual_table():
    return {
        "id": "tab1", "type": "table", "page": 1, "table_schema": 1,
        "head": [["Legacy mixed header"]], "rows": [["舊資料"]],
        "head_en": [["Variable", "Coefficient"]],
        "rows_en": [["Treatment", "0.123***\n(0.045)"]],
        "head_zh": [["變數", "係數"]],
        "rows_zh": [["處理", "0.123***\n(0.045)"]],
        "footnotes_en": ["Standard errors in parentheses; *** p < 0.01."],
        "footnotes_zh": ["括號內為標準誤；*** p < 0.01。"],
        "caption_en": "Table 1: Regression", "caption_zh": "表 1：迴歸分析",
    }


class BilingualTableFormatTest(unittest.TestCase):
    def test_regular_table_and_untranslated_source_are_valid(self):
        block = bilingual_table()
        self.assertIsNone(paperdata.block_shape_problem(block))
        for field in ("head_zh", "rows_zh", "footnotes_zh"):
            block.pop(field)
        self.assertIsNone(paperdata.block_shape_problem(block))

    def test_legacy_language_is_never_inferred(self):
        for head in ("Method", "方法", "Method 方法"):
            block = {"id": "old", "type": "table", "head": [[head]], "rows": [["1.20"]]}
            before = copy.deepcopy(block)
            self.assertFalse(tables.is_bilingual(block))
            self.assertIsNone(paperdata.block_shape_problem(block))
            traditional.normalize({"blocks": [block]})
            self.assertEqual(block, before)

    def test_bad_versions_shapes_cells_and_footnotes_are_rejected(self):
        changes = [
            {"table_schema": True}, {"table_schema": 2},
            {"head_en": ["flat", "head"]}, {"rows_en": []},
            {"rows_en": [["Treatment", 0.123]]},
            {"rows_en": [["Treatment"]]}, {"rows_zh": [["處理"]]},
            {"rows_zh": [["處理", "1"], ["額外列", "2"]]},
            {"head_zh": []}, {"footnotes_en": "not a list"},
            {"footnotes_zh": [17]}, {"footnotes_zh": []},
            {"table_spans": "untrusted structure"}, {"table_segments": ["page 2"]},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.assertIsNotNone(paperdata.block_shape_problem({**bilingual_table(), **change}))

    def test_new_fields_require_an_explicit_version_and_complete_matrix_pair(self):
        for field in ("table_schema", "head_en", "rows_en", "head_zh", "rows_zh"):
            block = bilingual_table()
            block.pop(field)
            with self.subTest(field=field):
                self.assertIsNotNone(paperdata.block_shape_problem(block))

    def test_multiple_header_rows_and_complex_structure_metadata_round_trip(self):
        block = bilingual_table()
        block["head_en"].insert(0, ["Model", "Model"])
        block["head_zh"].insert(0, ["模型", "模型"])
        block["table_spans"] = [{"section": "head", "row": 0, "col": 0, "rowspan": 1, "colspan": 2}]
        block["table_segments"] = [{"page": 1, "box": [0.1, 0.2, 0.9, 0.8], "row_start": 0, "row_end": 1}]
        self.assertIsNone(paperdata.block_shape_problem(block))
        self.assertEqual(json.loads(json.dumps(block)), block)

    def test_checks_include_both_table_languages_and_footnotes(self):
        block = bilingual_table()
        block["rows_en"][0][0] = "$\\beta_1$"
        block["footnotes_zh"][0] = "$p < 0.01$"
        problems, tex = checks.block_problems([block])
        self.assertFalse(problems)
        self.assertIn(("tab1", "\\beta_1", False), tex)
        self.assertIn(("tab1", "p < 0.01", False), tex)
        self.assertFalse(checks.tex_problems(tex))
        block["rows_zh"][0][1] = "\x0crac"
        self.assertTrue(checks.block_problems([block])[0])

    def test_normalization_only_changes_explicit_translation(self):
        block = bilingual_table()
        block["head_zh"] = [["变量", "系数"]]
        block["rows_zh"][0][0] = "处理"
        block["footnotes_zh"] = ["标准误差；*** p < 0.01。"]
        before = copy.deepcopy(block)
        traditional.normalize({"blocks": [block]})
        for field in ("head", "rows", "head_en", "rows_en", "footnotes_en"):
            self.assertEqual(block[field], before[field])
        self.assertEqual(block["head_zh"], [["變數", "係數"]])
        self.assertEqual(block["rows_zh"][0][1], "0.123***\n(0.045)")
        self.assertIn("標準誤差", block["footnotes_zh"][0])


class BilingualTableStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Workspace(Path(self.temp.name))
        write_json_atomic(self.ws.paper_path, {
            "schema": 2, "meta": {"target": "zh-TW", "title_en": "Mock paper", "pages": []},
            "translation": {"done_pages": [1], "en_pages": []}, "blocks": [],
        })
        self.ws.apply_reader_ops([
            {"op": "note", "note": {"id": "n1", "anchor": "tab1", "key": "tab1#caption", "quote": "迴歸", "body": "我的筆記"}},
            {"op": "progress", "block": "tab1", "ratio": 0.4, "off": 0.2},
            {"op": "edit", "block": "tab1#caption", "zh": "自訂表題"},
        ])

    def test_save_preserves_ids_legacy_data_reader_state_and_page_cache(self):
        reader_before = self.ws.reader_path.read_bytes()
        block = bilingual_table()
        paperdata.merge_blocks(self.ws, {"blocks": [block]})
        saved = self.ws.load("paper")
        self.assertEqual(saved["blocks"][0], block)
        self.assertEqual(saved["translation"], {"done_pages": [1], "en_pages": []})
        self.assertEqual(self.ws.reader_path.read_bytes(), reader_before)

    def test_invalid_translation_cannot_replace_a_saved_table(self):
        block = bilingual_table()
        paperdata.merge_blocks(self.ws, {"blocks": [block]})
        before = self.ws.paper_path.read_bytes()
        with self.assertRaises(ValueError):
            paperdata.merge_blocks(self.ws, {"blocks": [{**block, "rows_zh": [["wrong column count"]]}]})
        self.assertEqual(self.ws.paper_path.read_bytes(), before)

    def test_explicit_upgrade_retains_legacy_fields_and_pdf_metadata(self):
        for replace in (None, [1]):
            for legacy_head in ([["旧表头"]], ["malformed", "legacy"]):
                with self.subTest(replace=replace, legacy_head=legacy_head):
                    legacy = {"id": "tab1", "type": "table", "page": 1, "head": legacy_head,
                              "rows": [["旧文字", "1.20"]], "box": [0.1, 0.2, 0.8, 0.9]}
                    self.ws.update("paper", lambda p: p.update(blocks=[legacy]))
                    incoming = bilingual_table()
                    reader_before = self.ws.reader_path.read_bytes()
                    paperdata.merge_blocks(self.ws, {"blocks": [incoming]}, replace_pages=replace)
                    saved = self.ws.load("paper")["blocks"][0]
                    for field in ("head", "rows", "box"):
                        self.assertEqual(saved[field], legacy[field])
                    self.assertEqual(saved["rows_en"], incoming["rows_en"])
                    self.assertIsNone(paperdata.block_shape_problem(saved))
                    self.assertEqual(self.ws.reader_path.read_bytes(), reader_before)

    def test_offline_build_includes_both_languages_and_the_shared_mode_handler(self):
        paperdata.merge_blocks(self.ws, {"blocks": [bilingual_table()]})
        output = build.build(self.ws, self.ws.root / "offline.html", lang="en")
        html = output.read_text(encoding="utf-8")
        self.assertIn('"head_en"', html)
        self.assertIn('"rows_zh"', html)
        self.assertIn('data-table-side', html)
        self.assertIn('PR.setBiOrder', html)

    def test_source_only_replacement_does_not_inherit_a_previous_translation(self):
        original = bilingual_table()
        paperdata.merge_blocks(self.ws, {"blocks": [original]})
        replacement = bilingual_table()
        replacement["rows_en"][0][1] = "0.200***\n(0.050)"
        for field in ("head_zh", "rows_zh", "footnotes_zh"):
            replacement.pop(field)
        paperdata.merge_blocks(self.ws, {"blocks": [replacement]})
        saved = self.ws.load("paper")["blocks"][0]
        self.assertEqual(saved["rows_en"], replacement["rows_en"])
        self.assertNotIn("rows_zh", saved)
        self.assertEqual(saved["head"], original["head"])


if __name__ == "__main__":
    unittest.main()
