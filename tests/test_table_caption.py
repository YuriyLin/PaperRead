"""Caption boundaries with synthetic pages; no model calls."""
import unittest
from unittest import mock

from easyread.table_extract import _CAPTION, extract_page


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


class CaptionLineTest(unittest.TestCase):
    def extract_caption(self, text, font="TimesLTStd-Roman"):
        page = mock.Mock()
        page.bbox = page.cropbox = (0, 0, 600, 800)
        page.chars = [{"top": 50, "bottom": 60, "x0": 20, "fontname": font}]
        page.find_tables.return_value = []
        # Stop after caption selection: geometry is outside these tests' scope.
        page.crop.side_effect = ValueError("caption reached geometry")
        line = {"text": text, "top": 50, "bottom": 60,
                "words": [{"x1": 45}, {"x1": 60}]}
        with mock.patch("easyread.table_extract._lines", return_value=[line]):
            return extract_page(page, 9)

    def test_roman_caption_separators(self):
        for separator in (".", ":", "\u2013", "\u2014"):
            for space in ("", " "):
                with self.subTest(separator=separator, space=space):
                    result = self.extract_caption(f"Table 1{space}{separator}Summary Statistics")
                    self.assertEqual(len(result.unresolved), 1)
                    self.assertEqual(result.unresolved[0]["num"], "1")
                    self.assertEqual(result.issues, ["Table 1: caption reached geometry"])

    def test_existing_bold_caption(self):
        result = self.extract_caption("Table 1 Statistics", "TimesLTStd-Bold")
        self.assertEqual(len(result.unresolved), 1)

    def test_body_references_are_not_captions(self):
        for text in ("Table 1 contains summary statistics.",
                     "Table 1 shows the results: estimates follow.",
                     "See Table 1 for results.", "Table 1abc"):
            with self.subTest(text=text):
                result = self.extract_caption(text)
                self.assertEqual(result.sources, [])
                self.assertEqual(result.unresolved, [])
                self.assertEqual(result.issues, [])
