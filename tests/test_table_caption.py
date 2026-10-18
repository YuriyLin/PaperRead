"""Caption regex boundaries; no PDF extraction or model calls."""
import unittest

from easyread.table_extract import _CAPTION


class CaptionRegexTest(unittest.TestCase):
    def test_existing_caption_formats(self):
        for caption, number in (
            ("Table 1 Statistics", "1"),
            ("Table 1: Statistics", "1"),
            ("Table 1. Statistics", "1"),
            ("table A1: Statistics", "A1"),
            ("Table 1.2: Statistics", "1.2"),
            ("Table 1-2: Statistics", "1-2"),
        ):
            with self.subTest(caption=caption):
                self.assertEqual(_CAPTION.match(caption).group(1), number)

    def test_dash_caption_separators(self):
        for dash in ("\u2013", "\u2014"):
            with self.subTest(dash=dash):
                self.assertEqual(_CAPTION.match(f"Table 1{dash}Statistics").group(1), "1")

    def test_number_followed_by_letters_is_not_a_caption(self):
        self.assertIsNone(_CAPTION.match("Table 1abc"))
