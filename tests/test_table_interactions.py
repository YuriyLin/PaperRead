"""Phase C evidence, persistence, real-PDF fallback and offline guard tests."""
import copy
import hashlib
import json
import os
import subprocess
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import pdfplumber

from easyread import chat, config, engines, prompts, tables, table_extract, table_translate
from easyread.research import obsidian_export
from easyread.store import Workspace, write_json_atomic
from tests.test_bilingual_tables import bilingual_table
from tests.test_table_translation import make_table_pdf, mock_translation


class TableInteractionTest(unittest.TestCase):
    def test_addresses_are_language_independent_and_reject_invalid_slots(self):
        b = bilingual_table()
        before = copy.deepcopy(b)
        for key in ("tab1#cell:head:0:0", "tab1#cell:rows:0:1", "tab1#cell:note:0"):
            self.assertEqual(tables.cell_ref(b, key)["key"], key)
        for key in ("other#cell:rows:0:0", "tab1#cell:rows:01:0", "tab1#cell:rows:-1:0",
                    "tab1#cell:note:0:0", "tab1#cell:head:0", "tab1#cell:rows:9:0"):
            self.assertIsNone(tables.cell_ref(b, key), key)
        self.assertEqual(b, before)

    def test_source_token_ignores_translation_but_detects_source_reordering(self):
        b = bilingual_table()
        token = tables.source_token(b)
        b["rows_zh"][0][0] = "個人翻譯"
        self.assertEqual(tables.source_token(b), token)
        b["rows_en"][0].reverse()
        self.assertNotEqual(tables.source_token(b), token)

    def test_multi_cell_context_keeps_more_than_twelve_selected_cells(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = Workspace(Path(temp))
            b = bilingual_table()
            b["rows_en"] = [[f"row {i}", str(i)] for i in range(20)]
            b["rows_zh"] = [[f"資料列 {i}", str(i)] for i in range(20)]
            write_json_atomic(ws.paper_path, {"meta": {}, "blocks": [b]})
            refs = [{"anchor": "tab1", "key": f"tab1#cell:rows:{i}:1", "quote": str(i), "table_source": tables.source_token(b)} for i in range(20)]
            text = chat._context(ws, "tab1", "0", refs)
            self.assertEqual(text.count("Selected cell:"), 20)
            self.assertIn("tab1#cell:rows:19:1", text)

    def test_cell_context_contains_headers_row_numbers_notes_and_both_languages(self):
        b = bilingual_table()
        text = tables.context(b, "tab1#cell:rows:0:1", tables.source_token(b))
        for value in ("Selected cell", "Selected row", "Coefficient", "係數", "0.123***", "(0.045)", "Standard errors", "PDF page 1"):
            self.assertIn(value, text)
        self.assertIn("source changed", tables.context(b, "tab1#cell:rows:0:1", "old"))

    def test_fallback_never_fabricates_a_selected_cell(self):
        for patch in ({"table_status": "fallback"}, {"table_spans": [{}]}, {"table_segments": [{}]}):
            b = {**bilingual_table(), **patch}
            self.assertIsNone(tables.cell_ref(b, "tab1#cell:rows:0:0"))
            self.assertIn("inspect the original PDF", tables.context(b))

    def test_notes_edits_and_source_fingerprints_persist_without_changing_paper(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = Workspace(Path(temp))
            b = bilingual_table()
            write_json_atomic(ws.paper_path, {"blocks": [b]})
            original = ws.paper_path.read_bytes()
            source = tables.source_token(b)
            key = "tab1#cell:rows:0:0"
            ws.apply_reader_ops([{"op": "edit", "block": key, "zh": "實驗組", "base": "base", "table_source": source},
                                 {"op": "note", "note": {"id": "n1", "anchor": "tab1", "key": key,
                                  "quote": "Treatment", "side": "en", "table_source": source, "kind": "highlight", "style": "underline"}}])
            reloaded = Workspace(Path(temp)).load("reader")
            self.assertEqual(reloaded["edits"][key]["table_source"], source)
            self.assertEqual(reloaded["notes"]["n1"]["side"], "en")
            self.assertEqual(ws.paper_path.read_bytes(), original)

    def test_chat_and_note_answer_include_precise_table_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = Workspace(Path(temp))
            b = bilingual_table()
            write_json_atomic(ws.paper_path, {"meta": {}, "blocks": [b]})
            ref = {"anchor": "tab1", "key": "tab1#cell:rows:0:1", "table_source": tables.source_token(b), "quote": "0.123***", "side": "en"}
            for text in (chat._context(ws, "tab1", ref["quote"], [ref]), prompts.answer(ws, {**ref, "body": "解釋係數"})):
                self.assertIn("Selected cell", text)
                self.assertIn("Coefficient", text)
                self.assertIn("(0.045)", text)

    def test_extraction_records_normalized_cell_and_footnote_geometry(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.pdf"
            make_table_pdf(path)
            with pdfplumber.open(path) as pdf:
                b = table_extract.extract_page(pdf.pages[0], 1).sources[0]
            self.assertEqual(b["table_geometry_source"], tables.source_token(b))
            self.assertEqual(len(b["table_cell_boxes"]), 11)
            for loc in b["table_cell_boxes"].values():
                x0, y0, x1, y1 = loc["box"]
                self.assertTrue(0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1)
                self.assertEqual(loc["page"], 1)

    def test_cached_table_refreshes_missing_geometry_without_model_call(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = Workspace(Path(temp))
            make_table_pdf(ws.source_pdf)
            write_json_atomic(ws.paper_path, {"meta": {"pages": [{"n": 1}]}, "blocks": []})
            with mock.patch.object(engines, "run", side_effect=mock_translation):
                table_translate.translate_missing(ws, {"engine": "openai"})
            ws.update("paper", lambda p: p["blocks"][0].pop("table_cell_boxes"))
            with mock.patch.object(engines, "run", side_effect=AssertionError("Cache must not call a model")):
                result = table_translate.translate_missing(ws, {"engine": "openai"})
            self.assertEqual(result["cached"], 1)
            self.assertIn("rows:0:0", ws.load("paper")["blocks"][0]["table_cell_boxes"])

    def test_real_nist_fixture_hash_source_values_and_safe_fallback(self):
        folder = Path(__file__).parent / "fixtures" / "tables"
        manifest = json.loads((folder / "nist-tn-2113.json").read_text(encoding="utf-8"))
        path = folder / manifest["fixture"]
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), manifest["fixture_sha256"])
        with pdfplumber.open(path) as pdf:
            for case in manifest["cases"]:
                page = pdf.pages[case["page"] - 1]
                for token in case["tokens"]:
                    self.assertIn(token, page.extract_text())
                result = table_extract.extract_page(page, case["page"])
                self.assertEqual(result.sources, [])
                self.assertTrue(any(case["reason"].lower() in issue.lower() for issue in result.issues), result.issues)
                self.assertTrue(any(b["num"] == case["table"] for b in result.unresolved))

    def test_offline_profile_blocks_models_before_transport_and_does_not_save_settings(self):
        with mock.patch.dict(os.environ, {"PAPERREAD_OFFLINE_TEST": "1"}), mock.patch.object(config, "read_json", return_value={}), \
                mock.patch.object(engines.netcheck, "problem", side_effect=AssertionError("No transport")):
            self.assertEqual(config.load()["engine"], config.DEFAULTS["engine"])
            self.assertFalse(config.load()["auto_translate"])
            with self.assertRaises(engines.EngineError):
                engines.run({"engine": "openai"}, "test", Path("."))
            with self.assertRaises(engines.EngineError):
                list(chat.stream({"engine": "openai"}, "test", Path("."), threading.Event()))


class VaultTableTest(unittest.TestCase):
    def test_export_rejects_a_research_folder_junction_outside_vault(self):
        with tempfile.TemporaryDirectory() as temp:
            root, outside = Path(temp) / "vault", Path(temp) / "outside"
            root.mkdir()
            outside.mkdir()
            link = root / "Research"
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
            else:
                link.symlink_to(outside, target_is_directory=True)
            with mock.patch.object(obsidian_export, "vault_path", return_value=root), self.assertRaises(ValueError):
                obsidian_export.export_to_vault([{"id": "paper:p1:annotations", "kind": "annotations", "title": "Table", "body": "table"}])
            self.assertEqual(list(outside.iterdir()), [])

    def test_repeat_export_preserves_bom_crlf_and_user_content_around_managed_table(self):
        doc = {"id": "paper:p1:annotations", "kind": "annotations", "title": "Tables", "body": "| Variable | 係數 |\n| --- | --- |\n| Treatment | 0.123*** |"}
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(obsidian_export, "vault_path", return_value=Path(temp)):
            first = obsidian_export.export_to_vault([doc])
            path = Path(temp) / first["written"][0]
            content = path.read_text(encoding="utf-8").replace("\n", "\r\n")
            path.write_bytes(("\ufeff" + content + "\r\nUSER TAIL\r\n").encode("utf-8"))
            obsidian_export.export_to_vault([{**doc, "body": doc["body"] + "\n\nCell ID: `tab1#cell:rows:0:1`"}])
            raw = path.read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
            self.assertTrue(raw.endswith(b"\r\nUSER TAIL\r\n"))
            self.assertIn(b"0.123***", raw)

    def test_duplicate_managed_markers_conflict_and_reserved_content_is_rejected(self):
        doc = {"id": "paper:p1:annotations", "kind": "annotations", "title": "Tables", "body": "table"}
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(obsidian_export, "vault_path", return_value=Path(temp)):
            first = obsidian_export.export_to_vault([doc])
            path = Path(temp) / first["written"][0]
            path.write_bytes(path.read_bytes() + obsidian_export.MANAGED_START.encode())
            before = path.read_bytes()
            self.assertEqual(len(obsidian_export.export_to_vault([doc])["conflicts"]), 1)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(ValueError):
                obsidian_export.export_to_vault([{**doc, "body": obsidian_export.MANAGED_END}])
