"""Program correctness of an offline experiment, not document accuracy."""
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pdfplumber

from easyread import table_extract, tables
from scripts.table_qa.benchmark import FIXTURES, block_from_truth, load_manifest
from scripts.table_qa.provenance import canonical, absolute, reference_for_table, sequence, verify_block


class CellProvenanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, sources, cases = load_manifest()
        case = next(c for c in cases if c['id'] == 'ruled_times')
        cls.source = sources[case['source']]
        cls.path = cls.source['resolved_path']
        cls.truth = case['ground_truth']['tables'][0]

    def setUp(self):
        self.block = block_from_truth(self.truth)
        self.reference = reference_for_table(self.source, self.truth)

    def verify(self, block=None, reference=None, path=None):
        return verify_block(path or self.path, block or self.block, reference or self.reference)

    def refresh(self):
        self.block['table_geometry_source'] = tables.source_token(self.block)

    def assertRejected(self, result, code=None):
        self.assertFalse(result['valid'], result)
        if code:
            self.assertIn(code, [i['code'] for i in result['issues']], result)

    def test_real_pdf_correct_cells_have_ordered_source_evidence(self):
        result = self.verify()
        self.assertTrue(result['valid'], result['issues'])
        self.assertEqual(len(result['cells']), 12)
        self.assertEqual(result['cells']['rows:1:1']['source'], '12.50')

    def test_source_and_candidate_are_not_mutated(self):
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        block, ref = copy.deepcopy(self.block), copy.deepcopy(self.reference)
        self.verify()
        self.assertEqual(self.block, block)
        self.assertEqual(self.reference, ref)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_number_permutation_preserving_counter_is_rejected_even_after_rehash(self):
        self.block['rows_en'][1][1] = '21.50'
        self.refresh()
        self.assertEqual(Counter('12.50'), Counter('21.50'))
        self.assertRejected(self.verify(), 'numeric_sequence_mismatch')

    def test_two_numeric_cells_swapped_with_same_table_counter_are_rejected(self):
        rows = self.block['rows_en']
        before = Counter(''.join(c for r in rows for c in r))
        rows[0][1], rows[1][1] = rows[1][1], rows[0][1]
        self.refresh()
        self.assertEqual(before, Counter(''.join(c for r in rows for c in r)))
        self.assertRejected(self.verify(), 'ordered_text_mismatch')

    def test_label_exchange_and_character_reordering_are_rejected(self):
        for kind in ('swap', 'reorder'):
            with self.subTest(kind=kind):
                self.block = block_from_truth(self.truth)
                rows = self.block['rows_en']
                if kind == 'swap':
                    rows[0][0], rows[1][0] = rows[1][0], rows[0][0]
                else:
                    rows[0][0] = 'ahlpA'
                self.refresh()
                self.assertRejected(self.verify(), 'ordered_text_mismatch')

    def test_swapping_text_and_boxes_together_cannot_rebind_trusted_slots(self):
        rows, boxes = self.block['rows_en'], self.block['table_cell_boxes']
        rows[0][1], rows[1][1] = rows[1][1], rows[0][1]
        a, b = 'rows:0:1', 'rows:1:1'
        boxes[a], boxes[b] = boxes[b], boxes[a]
        self.refresh()
        self.assertRejected(self.verify(), 'cell_geometry_binding_mismatch')

    def test_stale_geometry_token_is_rejected(self):
        self.block['rows_en'][1][1] = '21.50'
        self.assertRejected(self.verify(), 'stale_geometry_token')

    def test_existing_matrix_check_accepts_injection_but_provenance_rejects(self):
        with pdfplumber.open(self.path) as pdf:
            page = pdf.pages[0]
            table = page.find_tables()[0]
            changed = table.extract(x_tolerance=2, y_tolerance=2)
            changed[2][1] = '21.50'
            with patch.object(table, 'extract', return_value=changed):
                head, rows, _ = table_extract._matrix(page, table, 'lines')
        self.block['head_en'], self.block['rows_en'] = head, rows
        self.refresh()
        self.assertRejected(self.verify(), 'numeric_sequence_mismatch')

    def test_punctuation_percent_footnotes_signs_and_citations_are_literal(self):
        path = FIXTURES.parent / 'provenance-symbols.pdf'
        annotation = json.loads(path.with_suffix('.json').read_text(encoding='utf-8'))
        ref = reference_for_table(annotation, annotation['table'])
        good = block_from_truth(annotation['table'])
        self.assertTrue(verify_block(path, good, ref)['valid'])
        for bad in ('1.25%*** [1]', '-125%*** [1]', '-1.25*** [1]', '-1.25%** [1]',
                    '-1.25%*** [2]', '-1.25***% [1]', '\u22121.25%*** [1]', '-1 .25%*** [1]'):
            with self.subTest(bad=bad):
                candidate = copy.deepcopy(good)
                candidate['rows_en'][0][1] = bad
                candidate['table_geometry_source'] = tables.source_token(candidate)
                self.assertRejected(verify_block(path, candidate, ref))

    def test_missing_or_duplicated_digits_are_rejected(self):
        for bad in ('12.5', '12.500'):
            with self.subTest(bad=bad):
                self.block['rows_en'][1][1] = bad
                self.refresh()
                self.assertRejected(self.verify())

    def test_whitespace_does_not_rewrite_source_or_numeric_token_boundaries(self):
        self.block['head_en'][0][0] = '  Measure\n'
        self.refresh()
        self.assertTrue(self.verify()['valid'])
        self.block['rows_en'][1][1] = '1 2.50'
        self.refresh()
        self.assertRejected(self.verify(), 'numeric_sequence_mismatch')

    def test_only_explicit_latin_ligatures_fold(self):
        for char, text in zip('\ufb00\ufb01\ufb02\ufb03\ufb04\ufb05\ufb06', ('ff','fi','fl','ffi','ffl','st','st')):
            with self.subTest(char=char):
                self.assertEqual(canonical(char), canonical(text))
        for a,b in [('\u00b2','2'), ('\u00b5','\u03bc'), ('\u2212','-'), ('1.20','1.2'), ('***','**'), ('\u2020','*')]:
            self.assertNotEqual(canonical(a), canonical(b))

    def test_pdf_digest_page_and_bounds_are_independent_of_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'changed.pdf'
            path.write_bytes(self.path.read_bytes() + b'\n')
            self.assertRejected(self.verify(path=path), 'pdf_hash_mismatch')
        for page in (True, 2, 0):
            with self.subTest(page=page):
                self.block['page'] = page
                self.assertRejected(self.verify(), 'page_identity_mismatch')
        self.block['page'] = 1
        self.reference['page_bbox'] = [20, 30, 632, 822]
        self.assertRejected(self.verify(), 'page_bounds_mismatch')

    def test_missing_extra_or_wrong_page_boxes_are_rejected(self):
        original = copy.deepcopy(self.block)
        for change in ('missing', 'extra', 'wrongpage'):
            with self.subTest(change=change):
                self.block = copy.deepcopy(original)
                boxes = self.block['table_cell_boxes']
                if change == 'missing':
                    boxes.pop('rows:0:1')
                elif change == 'extra':
                    boxes['rows:9:9'] = boxes['rows:0:1']
                else:
                    boxes['rows:0:1']['page'] = 2
                self.assertRejected(self.verify())

    def test_incomplete_reference_cannot_hide_an_unverified_slot(self):
        self.reference['cells'].pop('rows:0:1')
        self.block['table_cell_boxes'].pop('rows:0:1')
        self.assertRejected(self.verify(), 'incomplete_reference_slots')

    def test_invalid_normalized_coordinates_fail_closed(self):
        for box in ([0,0,float('nan'),1], [0,0,float('inf'),1], [-.1,0,.2,.2],
                    [False,0,.2,.2], [.3,.2,.1,.4], [0,0,0,1]):
            with self.subTest(box=box):
                self.block['table_cell_boxes']['rows:0:1']['box'] = box
                self.assertRejected(self.verify())

    def test_referenced_cells_cannot_overlap_or_omit_source_glyphs(self):
        for kind in ('overlap', 'clip'):
            with self.subTest(kind=kind):
                ref = copy.deepcopy(self.reference)
                box = ref['cells']['rows:0:0']
                if kind == 'overlap':
                    box[2] += 20
                else:
                    box[0] = 52
                result = self.verify(reference=ref)
                self.assertRejected(result, 'overlapping_reference_cells' if kind == 'overlap' else 'source_glyph_coverage_mismatch')

    def test_unknown_notes_and_matrix_shape_are_not_silently_ignored(self):
        self.block['footnotes_en'] = ['Note: not referenced']
        self.refresh()
        self.assertRejected(self.verify(), 'footnotes_not_covered_by_reference')
        self.block = block_from_truth(self.truth)
        self.block['rows_en'][0].append('extra')
        self.refresh()
        self.assertRejected(self.verify(), 'matrix_shape_mismatch')

    def test_multiline_cells_are_read_in_geometric_order(self):
        _, sources, cases = load_manifest()
        case = next(c for c in cases if c['id'] == 'ruled_multiline')
        truth = case['ground_truth']['tables'][0]
        source = sources[case['source']]
        result = verify_block(source['resolved_path'], block_from_truth(truth), reference_for_table(source, truth))
        self.assertTrue(result['valid'], result['issues'])
        self.assertEqual(result['cells']['rows:0:0']['source'], 'Alpha\nsubgroup')

    def test_ambiguous_glyph_layout_and_overprinted_glyphs_fail_closed(self):
        c = {'text':'1', 'x0':10, 'x1':15, 'top':10, 'bottom':20, 'size':10}
        for chars in ([c,dict(c)], [dict(c,upright=False)], [dict(c,text='\ufffd')],
                      [c,dict(c,x0=16,x1=20,size=5)], [c,dict(c,x0=12,x1=17,text='2')]):
            with self.subTest(chars=chars), self.assertRaises(ValueError):
                sequence(chars)

    def test_coordinate_conversion_preserves_nonzero_origin(self):
        self.assertEqual(absolute([.1,.2,.5,.8], [20,30,620,830]), [80,190,320,670])


if __name__ == '__main__':
    unittest.main()
