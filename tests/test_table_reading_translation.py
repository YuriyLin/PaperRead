"""D2 jobs use real synthetic PDFs and fake model responses only."""
import json
import os
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread import engines, table_reading, table_translate
from easyread.store import Workspace, write_json_atomic
from tests.test_table_translation import make_table_pdf


def response(cfg, prompt, cwd, images, cancel, meter):
    data = json.loads(prompt.split("\n", 1)[1])
    return json.dumps({"segments": [{"id": s["id"], "zh": "\u7ffb\u8b6f " + " ".join(re.findall(r"\[\[READING\d+\]\]", s["en"]))} for s in data["segments"]]})


class ReadingJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        make_table_pdf(self.ws.source_pdf, merged=True)
        self.block = {"id": "t1", "type": "table", "page": 1, "num": "1", "caption_en": "Table 1: Statistics", "table_status": "fallback", "table_cache": {"old": "keep"}}
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": 1}]}, "blocks": [self.block]})
        self.cfg = {"engine": "openai", "openai": {"model": "fake"}}

    def job(self, run=response, **kwargs):
        return table_translate.translate_missing(self.ws, self.cfg, run=run, **kwargs)

    def saved(self):
        return self.ws.load("paper")["blocks"][0]

    def test_translation_cache_and_parameter_invalidation(self):
        runner = mock.Mock(side_effect=response)
        self.assertEqual(self.job(runner)["reading_translated"], 1)
        b = self.saved()
        self.assertEqual(b["table_status"], "fallback")
        self.assertEqual(b["table_cache"], self.block["table_cache"])
        self.assertNotIn("rows_en", b)
        self.assertEqual([s["id"] for s in b["table_reading_zh"]], [s["id"] for s in b["table_reading"]["source"]["segments"]])
        self.assertEqual(self.job(runner)["reading_cached"], 1)
        self.assertEqual(runner.call_count, 1)
        self.cfg["openai"]["model"] = "other"
        self.assertEqual(self.job(runner)["reading_translated"], 1)
        self.assertEqual(runner.call_count, 2)

    def test_reordered_missing_duplicate_and_invented_data_rejected(self):
        for mode in ("reverse", "missing", "duplicate", "number", "formula", "mask"):
            def bad(*args):
                data = json.loads(response(*args))
                a = data["segments"]
                if mode == "reverse": a.reverse()
                elif mode == "missing": a.pop()
                elif mode == "duplicate": a[1] = a[0]
                elif mode == "number": a[0]["zh"] += " 999"
                elif mode == "formula": a[0]["zh"] += " x=2"
                else: a[-1]["zh"] = "\u7ffb\u8b6f"
                return json.dumps(data)
            with self.subTest(mode=mode):
                self.assertTrue(self.job(bad)["failed"])
                self.assertNotIn("table_reading_cache", self.saved())

    def test_cache_rechecks_pdf_and_not_only_hash(self):
        self.job()
        with mock.patch.object(table_reading, "verify_source", side_effect=ValueError("source changed")):
            runner = mock.Mock(side_effect=AssertionError("No model"))
            self.assertTrue(self.job(runner)["failed"])
            runner.assert_not_called()
        make_table_pdf(self.ws.source_pdf, merged=True, rows=[["New label", "2", "3"], ["Other", "4", "5"]])
        self.assertEqual(self.job()["reading_translated"], 1)

    def test_cancel_does_not_commit(self):
        cancel = threading.Event()
        def cancelled(*args):
            cancel.set()
            return response(*args)
        with self.assertRaises(engines.Cancelled):
            self.job(cancelled, cancel=cancel)
        self.assertNotIn("table_reading_cache", self.saved())

    def test_pdf_changed_during_response_is_not_committed(self):
        def changed(*args):
            text = response(*args)
            make_table_pdf(self.ws.source_pdf, merged=True, rows=[["Changed", "2", "3"], ["Other", "4", "5"]])
            return text
        self.assertTrue(self.job(changed)["failed"])
        self.assertNotIn("table_reading_cache", self.saved())

    def test_unisolatable_formula_keeps_pdf_without_model(self):
        make_table_pdf(self.ws.source_pdf, merged=True, rows=[["x_i = 2", "1", "2"], ["Other", "3", "4"]])
        runner = mock.Mock(side_effect=AssertionError("No model"))
        self.assertTrue(self.job(runner)["failed"])
        runner.assert_not_called()

    def test_stale_block_does_not_commit(self):
        def stale(*args):
            self.ws.update("paper", lambda p: p["blocks"][0].update(user_edit="changed"))
            return response(*args)
        self.assertTrue(self.job(stale)["failed"])
        self.assertNotIn("table_reading_cache", self.saved())

    def test_structured_success_and_api_error_do_not_select_reading(self):
        make_table_pdf(self.ws.source_pdf)
        with mock.patch.object(table_translate, "_translate_reading", side_effect=AssertionError("No fallback")):
            with mock.patch.object(table_translate, "_translate", side_effect=engines.EngineError("quota")):
                self.assertTrue(self.job()["failed"])
            from tests.test_table_translation import mock_translation
            self.assertEqual(self.job(mock_translation)["translated"], 1)

    def test_ambiguous_source_never_calls_model(self):
        with mock.patch.object(table_translate.table_extract, "recognize", side_effect=table_translate.table_extract.UnreliableTable("Missing or ambiguous table geometry")):
            runner = mock.Mock(side_effect=AssertionError("No model"))
            self.assertTrue(self.job(runner)["failed"])
            runner.assert_not_called()

    def test_offline_blocks_default_transport(self):
        with mock.patch.dict(os.environ, {"PAPERREAD_OFFLINE_TEST": "1"}), mock.patch.object(engines, "_run", side_effect=AssertionError("No transport")) as transport:
            self.assertTrue(self.job(None)["failed"])
            transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
