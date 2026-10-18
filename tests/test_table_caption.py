"""Caption boundaries with synthetic pages; no model calls."""
import unittest
from unittest import mock

from easyread.table_extract import _CAPTION, extract_page


class CaptionRegexTest(unittest.TestCase):
    def test_existing_caption_formats(self):
        for caption, number in (
            ("Table 1 Statistics", "1"),
            ("Table 1", "1"),
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


class SplitCaptionTest(unittest.TestCase):
    def extract(self, title="Implications of ICT for ethical public service values",
                gap=2, x=45, label="Table 1", bounds=(0, 0, 600, 800), ruled=True,
                prose=False):
        import tempfile
        from pathlib import Path
        import pdfplumber
        from pypdf import PdfWriter
        from pypdf.generic import RectangleObject
        from tests.test_table_translation import make_table_pdf

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "split.pdf"
            kwargs = {}
            if prose:
                kwargs = {"rows": [["Ethical actions", "Public trust", "Reveal reasoning"],
                                    ["Other actions", "Public values", "Explain decisions"]]}
            make_table_pdf(path, caption=label, ruled=ruled, **kwargs)
            writer = PdfWriter(clone_from=str(path))
            page = writer.pages[0]
            page.mediabox = page.cropbox = RectangleObject(bounds)
            if title is not None:
                content = page["/Contents"].get_object()
                # Label bottom is 57.277; title height is 9 points.
                y = 800 - (57.277 + gap) - 7.137
                content.set_data(content.get_data() +
                                 f'\nBT /F1 9 Tf {x} {y} Td ({title}) Tj ET'.encode('ascii'))
            writer.write(path)
            with pdfplumber.open(path) as pdf:
                return extract_page(pdf.pages[0], 7)

    def test_split_caption_preserves_source_and_geometry(self):
        for ruled in (True, False):
            with self.subTest(ruled=ruled):
                result = self.extract(ruled=ruled)
                self.assertEqual(result.issues, [])
                block = result.sources[0]
                self.assertEqual(block['caption_en'],
                                 'Table 1 Implications of ICT for ethical public service values')
                self.assertEqual((block['num'], block['page']), ('1', 7))
                self.assertEqual(block['rows_en'][1], ['Control', '-0.50', '0.060'])
                self.assertEqual(len(block['footnotes_en']), 2)
                self.assertEqual(len(block['table_cell_boxes']), 11)
                self.assertEqual(block['table_evidence']['method'], 'lines' if ruled else 'text')
                self.assertTrue(block['table_evidence']['glyphs_verified'])

    def test_rejects_references_distant_misaligned_and_incomplete_titles(self):
        for kwargs in ({'title': 'provides an overview of results'},
                       {'title': 'Shows the results'},
                       {'title': 'Results are described in the text.'},
                       {'label': 'See Table 1'}, {'gap': 16}, {'x': 100},
                       {'title': None}, {'title': 'Table 2'}, {'title': 'Summary'}):
            with self.subTest(kwargs=kwargs):
                result = self.extract(**kwargs)
                self.assertEqual((result.sources, result.unresolved, result.issues), ([], [], []))

    def test_nonstandard_page_preserves_normalized_locations(self):
        result = self.extract(bounds=(20, 30, 740, 930))
        self.assertFalse(result.issues)
        block = result.sources[0]
        self.assertEqual(block['table_source_box'],
                         [round(v, 6) for v in (25 / 720, 210 / 900, 520 / 720, 291 / 900)])
        self.assertEqual(block['table_cell_boxes']['head:0:0']['page'], 7)

    def test_unreliable_borderless_table_has_explicit_fallback(self):
        result = self.extract(ruled=False, prose=True)
        self.assertFalse(result.sources)
        self.assertEqual(len(result.unresolved), 1)
        block = result.unresolved[0]
        self.assertEqual((block['num'], block['page'], block['table_status']), ('1', 7, 'fallback'))
        self.assertIn('Implications of ICT', block['caption_en'])
        self.assertTrue(block['table_issue'])
        self.assertEqual(result.issues, ['Table 1: ' + block['table_issue']])
