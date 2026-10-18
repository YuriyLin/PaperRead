"""Isolated PDF geometry regressions; no library or model access."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pdfplumber
from pypdf import PdfWriter
from pypdf.generic import RectangleObject

from easyread import table_extract, table_reading
from tests.test_table_translation import make_table_pdf


class TableCropTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'source.pdf'

    def pdf(self, bounds, crop=None, **kwargs):
        make_table_pdf(self.path, **kwargs)
        writer = PdfWriter(clone_from=str(self.path))
        writer.pages[0].mediabox = RectangleObject(bounds)
        writer.pages[0].cropbox = RectangleObject(crop or bounds)
        writer.write(self.path)

    def test_rounded_cropbox_uses_original_page_and_preserves_geometry(self):
        self.pdf([0, 0, 595.276, 841.89], [0, 0, 595.28, 841.89])
        with pdfplumber.open(self.path) as pdf:
            page = pdf.pages[0]
            self.assertEqual(page.bbox, (0, 0, 595.276, 841.89))
            with mock.patch.object(page, 'crop', side_effect=AssertionError('Full-page crop is unnecessary')):
                result = table_extract.extract_page(page, 1)
                block = result.sources[0]
                reading = table_reading._extract(page, block, 'a' * 64)
            page.cropbox = page.bbox
            baseline = table_extract.extract_page(page, 1)
            self.assertEqual(result, baseline)
            self.assertEqual(reading, table_reading._extract(page, block, 'a' * 64))
            self.assertEqual(block['rows_en'], [['Treatment', '1.20', '0.045'], ['Control', '-0.50', '0.060']])
            self.assertEqual(len(block['table_cell_boxes']), 11)

    def test_non_a4_and_nonzero_origin_keep_absolute_cell_locations(self):
        for bounds in ([0, 0, 720, 900], [20, 30, 740, 930]):
            with self.subTest(bounds=bounds):
                self.pdf(bounds)
                with pdfplumber.open(self.path) as pdf:
                    page = pdf.pages[0]
                    table = page.find_tables()[0]
                    block = table_extract.extract_page(page, 1).sources[0]
                    for key, box in [('table_source_box', table.bbox)]:
                        expected = [round((box[i] - page.bbox[i % 2]) /
                                          (page.width if i % 2 == 0 else page.height), 6) for i in range(4)]
                        self.assertEqual(block[key], expected)
                    cell = table.rows[0].cells[0]
                    normalized = block['table_cell_boxes']['head:0:0']['box']
                    self.assertEqual(normalized, [round((cell[i] - page.bbox[i % 2]) /
                                                       (page.width if i % 2 == 0 else page.height), 6) for i in range(4)])

    def test_borderless_keeps_local_crop_and_exact_values(self):
        self.pdf([0, 0, 595.276, 841.89], [0, 0, 595.28, 841.89], ruled=False)
        with pdfplumber.open(self.path) as pdf:
            page = pdf.pages[0]
            with mock.patch.object(page, 'crop', wraps=page.crop) as crop:
                result = table_extract.extract_page(page, 1)
            self.assertFalse(result.issues)
            self.assertEqual(result.sources[0]['table_evidence']['method'], 'text')
            self.assertEqual(result.sources[0]['rows_en'][1], ['Control', '-0.50', '0.060'])
            self.assertEqual(crop.call_count, 1)

    def test_captioned_prose_is_not_a_table(self):
        self.pdf([0, 0, 600, 800], ruled=False,
                 head=[['Ordinary', 'paragraph', 'heading']],
                 rows=[['These are', 'ordinary words', 'without data'],
                       ['More prose', 'continues here', 'in sentences']])
        with pdfplumber.open(self.path) as pdf:
            result = table_extract.extract_page(pdf.pages[0], 1)
        self.assertFalse(result.sources)
        self.assertEqual(result.unresolved[0]['table_status'], 'fallback')

    def test_invalid_or_empty_visible_region_safely_retains_pdf(self):
        self.pdf([0, 0, 600, 800])
        with pdfplumber.open(self.path) as pdf:
            page = pdf.pages[0]
            for box in ((700, 0, 800, 800), (0, 0, 0, 800), (0, 0, float('nan'), 800)):
                with self.subTest(box=box):
                    page.cropbox = box
                    result = table_extract.extract_page(page, 1)
                    self.assertFalse(result.sources)
                    self.assertTrue(result.issues)
                    with self.assertRaises(table_extract.UnreliableTable):
                        table_reading._extract(page, {'num': '1'}, 'a' * 64)

    def test_local_crop_intersects_nonzero_bounds_and_rejects_empty(self):
        page = mock.Mock(bbox=(20, 30, 740, 930))
        table_extract._crop(page, (0, 40, 750, 200))
        page.crop.assert_called_once_with((20, 40, 740, 200))
        with self.assertRaises(table_extract.UnreliableTable):
            table_extract._crop(page, (20, 950, 740, 970))


if __name__ == '__main__':
    unittest.main()
