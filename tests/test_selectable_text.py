"""Selectable PDF text preserves synthetic whitespace and refreshes stale caches."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from easyread.selectable_text import page_file
from scripts.smoke_backend import probe_pdf


class SelectableTextTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / "source.pdf"
        self.source.write_bytes(probe_pdf())

    def test_spaces_survive_and_cache_is_reused(self):
        cache = page_file(self.root, self.source, 1)
        rows = json.loads(cache.read_text(encoding="utf-8"))
        self.assertIn("PaperRead packaging smoke test.", "".join(row[0] for row in rows))
        self.assertTrue(any(row[0] == " " for row in rows))
        with patch("easyread.selectable_text.open_pdf", side_effect=AssertionError("cache missed")):
            self.assertEqual(page_file(self.root, self.source, 1), cache)

    def test_changed_source_invalidates_cache(self):
        cache = page_file(self.root, self.source, 1)
        self.source.write_bytes(probe_pdf().replace(b"packaging", b"selection"))
        page_file(self.root, self.source, 1)
        rows = json.loads(cache.read_text(encoding="utf-8"))
        self.assertIn("PaperRead selection smoke test.", "".join(row[0] for row in rows))

    def test_invalid_page_does_not_write_cache(self):
        with self.assertRaises(ValueError):
            page_file(self.root, self.source, 2)
        self.assertFalse((self.root / "extract/select-v2-002.json").exists())
