"""D1 local source evidence, no translation or network."""
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import paperdata, table_reading, tables
from easyread.table_extract import UnreliableTable
from tests.test_table_translation import make_table_pdf


class ReadingSourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = SimpleNamespace(source_pdf=Path(self.tmp.name) / 'source.pdf')
        make_table_pdf(self.ws.source_pdf, merged=True)
        self.block = {'id': 't1', 'type': 'table', 'page': 1, 'num': '1',
                      'caption_en': 'Table 1: Statistics', 'table_status': 'fallback',
                      'table_cache': {'old': 'unchanged'}}

    def evidence(self):
        self.block['table_reading'] = table_reading.recognize_source(self.ws, self.block)
        return self.block['table_reading']

    def test_valid_source_is_stable_and_not_a_matrix(self):
        before = copy.deepcopy(self.block)
        r = self.evidence()
        self.assertEqual(r, table_reading.recognize_source(self.ws, self.block))
        table_reading.verify_source(self.ws, self.block)
        self.assertIsNone(paperdata.block_shape_problem(self.block))
        self.assertFalse(tables.is_bilingual(self.block))
        self.assertIsNone(tables.cell_ref(self.block, 't1#cell:rows:0:0'))
        self.assertEqual({k: self.block[k] for k in before}, before)

    def test_invalid_boxes_and_duplicate_ids(self):
        baseline = copy.deepcopy(self.evidence())
        for box in ([-.1, .1, .9, .9], [0, 0, float('nan'), 1], [True, 0, 1, 1], [.8, .2, .1, .9]):
            r = copy.deepcopy(baseline)
            r['source']['box'] = box
            self.block['table_reading'] = r
            self.assertIsNotNone(paperdata.block_shape_problem(self.block))
        r = copy.deepcopy(baseline)
        r['source']['segments'].append(copy.deepcopy(r['source']['segments'][0]))
        r['source_hash'] = table_reading._hash(r['source'])
        self.block['table_reading'] = r
        self.assertIsNotNone(paperdata.block_shape_problem(self.block))

    def test_segment_outside_region_and_wrong_identity(self):
        baseline = copy.deepcopy(self.evidence())
        for field, value in [('page', 2), ('num', '2'), ('caption_en', 'Other')]:
            self.block[field] = value
            self.assertIsNotNone(paperdata.block_shape_problem(self.block))
            self.block[field] = baseline['source'][field]
        seg = baseline['source']['segments'][0]
        seg['box'] = [0, 0, .01, .01]
        seg['id'] = 's-' + table_reading._hash([seg['en'], seg['box']])
        baseline['source_hash'] = table_reading._hash(baseline['source'])
        self.block['table_reading'] = baseline
        self.assertIsNotNone(paperdata.block_shape_problem(self.block))

    def test_changed_pdf_and_rehashed_forgery_rejected(self):
        self.evidence()
        make_table_pdf(self.ws.source_pdf, merged=True, rows=[['Different', '1', '2'], ['Control', '3', '4']])
        with self.assertRaises(UnreliableTable):
            table_reading.verify_source(self.ws, self.block)
        r = self.evidence()
        seg = r['source']['segments'][0]
        seg['en'] = 'Invented source'
        seg['id'] = 's-' + table_reading._hash([seg['en'], seg['box']])
        r['source_hash'] = table_reading._hash(r['source'])
        self.assertIsNone(paperdata.block_shape_problem(self.block))
        with self.assertRaises(UnreliableTable):
            table_reading.verify_source(self.ws, self.block)

    def test_math_and_uncertain_identity_fall_back(self):
        make_table_pdf(self.ws.source_pdf, rows=[['x_i = 2', '1', '2'], ['Control', '3', '4']])
        with self.assertRaises(UnreliableTable):
            table_reading.recognize_source(self.ws, self.block)
        self.block['num'] = '2'
        with self.assertRaises(UnreliableTable):
            table_reading.recognize_source(self.ws, self.block)

    def test_legacy_format_unchanged(self):
        for b in (self.block, {'id': 'old', 'type': 'table', 'head': [['Legacy']], 'rows': [['1']]}):
            before = copy.deepcopy(b)
            self.assertIsNone(paperdata.block_shape_problem(b))
            self.assertIsNone(tables.shape_problem(b))
            self.assertEqual(b, before)

    def test_reading_does_not_bypass_legacy_validation(self):
        self.evidence()
        self.block['head'] = 'invalid flat header'
        self.assertIsNotNone(paperdata.block_shape_problem(self.block))

    def test_undecodable_and_mixed_size_glyphs_rejected(self):
        import pdfplumber
        for change in ({'text': '\ufffd'}, {'size': 4}, {'fontname': 'Symbol'}):
            with pdfplumber.open(self.ws.source_pdf) as pdf:
                page = pdf.pages[0]
                # A real table glyph, after the caption.
                char = next(c for c in page.chars if c['top'] > 80 and c['text'].strip())
                char.update(change)
                with self.assertRaises(UnreliableTable):
                    table_reading._extract(page, self.block, 'a' * 64)

    def test_ambiguous_candidates_rejected(self):
        import pdfplumber
        with pdfplumber.open(self.ws.source_pdf) as pdf:
            page = pdf.pages[0]
            found = page.find_tables()
            with mock.patch.object(page, 'find_tables', return_value=found + found):
                with self.assertRaises(UnreliableTable):
                    table_reading._extract(page, self.block, 'a' * 64)


if __name__ == '__main__':
    unittest.main()
