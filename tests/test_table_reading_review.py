"""Persistent review preparation, using only the isolated desktop profile."""
import os
import shutil
import subprocess
import sys
import unittest
import uuid

from scripts import prepare_table_reading_review as review


class ReadingReviewTest(unittest.TestCase):
    def test_paths_cannot_escape_or_select_other_papers(self):
        with self.assertRaises(ValueError):
            review.safe_path(review.ROOT / "library" / "paper.json")
        with self.assertRaises(ValueError):
            review.prepare("../other")

    def test_persistent_pipeline_cache_projection_and_no_transport(self):
        paper_id = "table-reading-review-test-" + uuid.uuid4().hex
        room = review.PROFILE / "library" / paper_id
        self.addCleanup(self.remove_fixture, room)
        # Separate process ensures config imports bind to the review home, never
        # to the parent test runner's configuration or previously imported modules.
        code = r'''
import copy
import os
from unittest import mock
from scripts import prepare_table_reading_review as review
os.environ.update(EASYREAD_HOME=str(review.PROFILE / "home"),
                  EASYREAD_LIBRARY=str(review.PROFILE / "library"),
                  PAPERREAD_TEST_PROFILE=str(review.PROFILE),
                  PAPERREAD_REVIEW_MODE="Mock", PAPERREAD_OFFLINE_TEST="1")
from easyread import engines, reader_data, tables
from easyread.store import Workspace, write_json_atomic
with mock.patch.object(engines, "run", side_effect=AssertionError("No default model transport")) as transport, \
     mock.patch("socket.socket.connect", side_effect=AssertionError("No network")), \
     mock.patch("subprocess.Popen", side_effect=AssertionError("No external CLI")):
    first = review.prepare(PAPER_ID)
    assert first["first"]["reading_translated"] == 1
    assert first["local_response_calls"] == 1
    ws = Workspace(review.PROFILE / "library" / PAPER_ID)
    saved = ws.load("paper")
    b = saved["blocks"][0]
    assert b["table_status"] == "fallback" and "rows_en" not in b
    source = b["table_reading"]["source"]["segments"]
    zh = b["table_reading_zh"]
    assert [s["id"] for s in source] == [s["id"] for s in zh]
    assert all(tables.protected(s["en"]) == tables.protected(v["zh"]) for s, v in zip(source, zh))
    assert any("處理組" in v["zh"] for v in zh)
    assert any("控制組" in v["zh"] for v in zh)
    reader = ws.load("reader")
    reader["notes"] = {"keep": {"body": "review annotation"}}
    write_json_atomic(ws.reader_path, reader)
    before = {name: (ws.root / name).read_bytes() for name in
              ("source.pdf", "paper.json", "reader.json", "discussion.json", "item.json", "layout.json")}
    again = review.prepare(PAPER_ID)
    assert again["first"]["reading_cached"] == 1
    assert again["local_response_calls"] == 0
    assert all((ws.root / name).read_bytes() == value for name, value in before.items())
    # D2.5 must still reject forged evidence, including on a warmed verifier.
    forged = copy.deepcopy(saved)
    forged["blocks"][0]["table_reading"]["source"]["segments"][0]["en"] = "Invented"
    projected, _ = reader_data.reader_paper(ws, forged)
    assert "table_reading_zh" not in projected["blocks"][0]
    assert ws.load("paper") == saved
    transport.assert_not_called()
'''
        result = subprocess.run([sys.executable, "-B", "-c",
                                 "PAPER_ID = " + repr(paper_id) + "\n" + code],
                                cwd=review.ROOT, capture_output=True, text=True,
                                encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @staticmethod
    def remove_fixture(room):
        # Never clean a computed directory without verifying its final target.
        allowed = (review.PROFILE / "library").resolve()
        if (room.parent.resolve() != allowed or room.resolve() != allowed / room.name or
                not room.name.startswith("table-reading-review-test-")):
            raise ValueError("Unsafe test cleanup path")
        if room.exists():
            shutil.rmtree(room)


if __name__ == "__main__":
    unittest.main()
