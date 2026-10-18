"""Corpus integrity / evaluator correctness, not an assertion of PDF accuracy."""
import json
from collections import Counter
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import pdfplumber

from scripts.table_qa import benchmark
from scripts.table_qa.provenance import canonical, center_inside


class FrozenBenchmarkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest, cls.sources, cls.cases = benchmark.load_manifest()

    def test_original_cases_are_pinned_and_have_complete_truth(self):
        self.assertEqual(len(self.cases), 27)  # 22 synthetic + 4 real pages + 1 sealed holdout.
        synthetic = [c for c in self.cases if self.sources[c['source']]['publisher_group'] == 'synthetic-independent-writer-v1']
        self.assertEqual(len(synthetic), 22)
        self.assertEqual({tag for c in self.cases for tag in c['categories']},
                         {'ruled','borderless','borderless_statistical','concept','cross_page','merged_cells','ordinary_prose','ambiguous'})
        for case in self.cases:
            self.assertEqual(len(case['truth_sha256']), 64)
            self.assertIn('expected_fallback', case['ground_truth'])
            self.assertIn('annotation_method', case['ground_truth'])

    def test_grouping_counts_documents_not_pages_or_synthetic_variants(self):
        regression = [s for s in self.sources.values() if s['split'] == 'regression']
        self.assertEqual(len({s['source_document_group'] for s in regression}), 3)
        nist = [c for c in self.cases if c['source'] == 'nist-tn-2113']
        self.assertEqual(len(nist), 3)
        holdout = [s for s in self.sources.values() if s['split'] == 'holdout']
        self.assertEqual({s['publisher_group'] for s in holdout}, {'W3C'})
        self.assertFalse({s['publisher_group'] for s in regression} & {s['publisher_group'] for s in holdout})

    def test_holdout_cannot_be_evaluated_by_default_or_named_split(self):
        with patch.object(benchmark, 'assess_case', return_value={}) as assess:
            with self.assertRaisesRegex(ValueError, 'holdout_sealed'):
                benchmark.run(split='holdout')
            assess.assert_not_called()
        visited = []

        def record(case, source):
            visited.append(source['split'])
            return {'id':case['id'], 'source_document_group':source['source_document_group'],
                    'publisher_group':source['publisher_group'],
                    'primary_category':case['primary_category'],
                    'categories':case['categories'], 'outcome':'not_evaluated',
                    'accepted':False,'exact_cells':False,'reason':'mock',
                    'page_sources':[],'page_unresolved':[],'page_issues':[]}

        with patch.object(benchmark, 'assess_case', side_effect=record):
            result = benchmark.run()
        self.assertEqual(visited, ['regression'] * 26)
        self.assertFalse(result['holdout_evaluated'])

    def corrupt(self, mutation):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'tables'
            shutil.copytree(benchmark.FIXTURES.parent, folder)
            root = folder / 'benchmark-v1'
            manifest = json.loads((root/'manifest.json').read_text(encoding='utf-8'))
            mutation(root, manifest)
            (root/'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            benchmark.load_manifest(root)

    def test_pdf_and_ground_truth_tampering_are_detected(self):
        for field in ('path','truth'):
            def mutate(root, manifest):
                entry = manifest['sources'][0] if field=='path' else manifest['cases'][0]
                path = root / entry[field]
                path.write_bytes(path.read_bytes()+b'\n')
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'hash_mismatch'):
                self.corrupt(mutate)

    def test_same_source_or_publisher_cannot_leak_into_holdout(self):
        for field in ('source_document_group','publisher_group'):
            def mutate(root, manifest):
                manifest['sources'][-1][field] = manifest['sources'][0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'split_leakage'):
                self.corrupt(mutate)

    def test_identical_pdf_cannot_cross_splits_under_different_metadata(self):
        def mutate(root, manifest):
            first, last = manifest['sources'][0], manifest['sources'][-1]
            last['path'], last['sha256'] = first['path'], first['sha256']
            last['source_document_group'], last['publisher_group'] = 'renamed-document', 'renamed-publisher'
        with self.assertRaisesRegex(ValueError, 'duplicate_pdf_split_leakage'):
            self.corrupt(mutate)

    def test_incomplete_cell_labels_are_detected_even_if_truth_hash_is_updated(self):
        def mutate(root, manifest):
            case = manifest['cases'][0]
            path = root / case['truth']
            truth = json.loads(path.read_text(encoding='utf-8'))
            truth['tables'][0]['cells'].pop()
            path.write_text(json.dumps(truth),encoding='utf-8')
            case['truth_sha256'] = benchmark.sha256(path)
        with self.assertRaisesRegex(ValueError, 'incomplete_cell_ground_truth'):
            self.corrupt(mutate)

    def test_runner_uses_frozen_inputs_not_the_original_generator(self):
        import scripts.evaluate_table_generalization as old
        with patch.object(old, 'write_pdf', side_effect=AssertionError('never regenerate truth')):
            # Execute one predeclared case, not the holdout.
            case = next(c for c in self.cases if c['id']=='ruled_times')
            result = benchmark.assess_case(case, self.sources[case['source']])
        self.assertEqual(result['outcome'], 'correct')
        self.assertTrue(result['fidelity']['valid'])

    def test_observation_drift_is_separate_from_known_quality_failures(self):
        result = benchmark.run()
        # Keep the original P0 snapshot. Only the reviewed word-boundary guard
        # is allowed to change a known failure, rather than refreshing truth.
        self.assertEqual({c['id'] for c in result['observation_changes']}, {'natural_prose_captioned'})
        self.assertEqual(result['case_count'], 26)
        self.assertEqual(result['summary'].get('false_positive', 0), 0)
        self.assertEqual(result['summary'].get('cell_misalignment', 0), 0)
        self.assertEqual(result['summary'].get('correct', 0), 7)
        # The unlabeled continuation remains an explicit release blocker.
        self.assertGreater(result['summary'].get('unsafe_structure_accept', 0), 0)
        self.assertEqual(sum(sum(v.values()) for v in result['by_primary_category'].values()), 26)

    def test_regression_annotations_do_not_duplicate_source_glyphs(self):
        audited = 0
        for case in self.cases:
            source = self.sources[case['source']]
            if source['split'] != 'regression':
                continue  # Keep holdout outside extraction/fidelity tests.
            with pdfplumber.open(source['resolved_path']) as pdf:
                for table in case['ground_truth']['tables']:
                    page = pdf.pages[table['page'] - 1]
                    region = [c for c in page.chars if c['text'].strip() and center_inside(c, table['box'])]
                    total = Counter()
                    for cell in table['cells']:
                        source_text = ''.join(c['text'] for c in region if center_inside(c, cell['box']))
                        # Visible text can differ from raw glyphs hidden by
                        # overpainting. Such exceptions must be explicit truth.
                        annotation = cell.get('source_glyph_text', cell['text'])
                        with self.subTest(case=case['id'], row=cell['row'], col=cell['col']):
                            self.assertEqual(Counter(canonical(source_text)), Counter(canonical(annotation)))
                        total.update(canonical(annotation))
                        audited += 1
                    self.assertEqual(total, Counter(canonical(''.join(c['text'] for c in region))))
        self.assertGreater(audited, 1900)


if __name__ == '__main__':
    unittest.main()
