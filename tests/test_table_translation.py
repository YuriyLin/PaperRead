"""Phase B: real synthetic PDFs, local extraction and mock-only model calls."""
import copy
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import pdfplumber
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, RectangleObject

from easyread import engines, store, table_extract, table_translate, tables, translate_api
from easyread.store import Workspace, write_json_atomic


def make_table_pdf(path, *, head=None, rows=None, ruled=True, merged=False, caption="Table 1: Statistics", notes=True):
    """Vector PDF fixtures with real fonts, positions and optional ruling."""
    head = head if head is not None else [["Variable", "Mean", "SD"]]
    rows = rows if rows is not None else [["Treatment", "1.20", "0.045"], ["Control", "-0.50", "0.060"]]
    matrix = head + rows
    width = len(matrix[0])
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    fonts = {}
    for name, font in (("F1", "Helvetica"), ("F2", "Helvetica-Bold")):
        fonts[NameObject('/' + name)] = writer._add_object(DictionaryObject({
            NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
            NameObject('/BaseFont'): NameObject('/' + font)}))
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject(fonts)})
    ops = []

    def text(x, y, value, font='F1', size=10):
        escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        ops.append(f'BT /{font} {size} Tf {x} {y} Td ({escaped}) Tj ET')

    text(45, 745, caption, 'F2', 11)
    top, height, cw = 720, 27, 165
    for i, row in enumerate(matrix):
        for j, value in enumerate(row):
            text(50 + j * cw, top - i * height - 18, value, 'F2' if i < len(head) else 'F1')
    bottom = top - len(matrix) * height
    if ruled:
        for i in range(len(matrix) + 1):
            y = top - i * height
            ops.append(f'45 {y} m {45 + width * cw} {y} l S')
        for j in range(width + 1):
            x = 45 + j * cw
            ops.append(f'{x} {bottom} m {x} {top - height if merged and j == 1 else top} l S')
    if notes:
        text(45, bottom - 14, 'Note: Standard errors in parentheses; *** p < 0.01.', size=9)
        text(45, bottom - 27, 'Source: World Bank (2020).', size=9)
    content = DecodedStreamObject()
    content.set_data('\n'.join(ops).encode('ascii'))
    page[NameObject('/Contents')] = writer._add_object(content)
    writer.write(path)


def mock_translation(cfg, prompt, cwd, images=None, cancel=None, meter=None):
    data = json.loads(prompt[prompt.index('{"glossary"'):])
    translations = {}
    for key, text in data['cells'].items():
        # Preserve every mask while translating all ordinary text. This is a
        # deterministic test double, not a model or a production dictionary.
        tokens = re.findall(r'⟦PR\d+⟧', text)
        translations[key] = '翻译内容 ' + ' '.join(tokens)
    return json.dumps({'zh': translations}, ensure_ascii=False)


def process_table_job(root, ready, start, output):
    """A separate interpreter also uses an explicit Mock, never a model API."""
    def run(*args, **kw):
        with (Path(root) / 'mock-calls.txt').open('a', encoding='utf-8') as stream:
            stream.write('mock\n')
        return mock_translation(*args, **kw)
    with mock.patch.object(engines, 'run', side_effect=run), \
            mock.patch.object(engines, '_popen', side_effect=AssertionError('Live CLI is forbidden')), \
            mock.patch('socket.socket.connect', side_effect=AssertionError('Network is forbidden')):
        (Path(root) / ready).touch()
        deadline = time.monotonic() + 10
        while not (Path(root) / start).exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Test worker start timed out')
            threading.Event().wait(.05)
        result = table_translate.translate_missing(Workspace(Path(root)), {'engine': 'openai'}, cancel=threading.Event())
        write_json_atomic(Path(root) / output, result)


class ExtractionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'source.pdf'

    def extract(self, **kw):
        make_table_pdf(self.path, **kw)
        with pdfplumber.open(self.path) as pdf:
            return table_extract.extract_page(pdf.pages[0], 1)

    def test_descriptive_statistics_and_sources_are_exact(self):
        result = self.extract()
        self.assertFalse(result.issues)
        b = result.sources[0]
        self.assertEqual(b['head_en'], [['Variable', 'Mean', 'SD']])
        self.assertEqual(b['rows_en'], [['Treatment', '1.20', '0.045'], ['Control', '-0.50', '0.060']])
        self.assertEqual(b['footnotes_en'], ['Note: Standard errors in parentheses; *** p < 0.01.', 'Source: World Bank (2020).'])
        self.assertTrue(b['table_evidence']['glyphs_verified'])
        self.assertTrue(all(0 <= n <= 1 for n in b['table_source_box']))

    def test_regression_coefficients_standard_errors_and_stars(self):
        rows = [['Treatment', '-0.123***', '(0.045)'], ['Control', '1.200**', '(0.060)']]
        result = self.extract(head=[['Variable', 'Coefficient', 'SE']], rows=rows)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['rows_en'], rows)

    def test_regression_standard_errors_on_separate_rows_keep_empty_cells(self):
        rows = [['Treatment', '-0.123***', '1.200**'], ['', '(0.045)', '(0.060)'],
                ['Control', '0.100', '0.200'], ['', '(0.010)', '(0.020)']]
        result = self.extract(head=[['Variable', 'Model A', 'Model B']], rows=rows)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['rows_en'], rows)

    def test_correlation_matrix_preserves_blank_triangle(self):
        rows = [['Treatment', '1.000', ''], ['Control', '-0.123*', '1.000']]
        result = self.extract(head=[['Variable', 'Treatment', 'Control']], rows=rows)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['rows_en'], rows)

    def test_hypothesis_tests_and_confidence_intervals(self):
        rows = [['H1', 'p < 0.001', '[0.12, 0.34]'], ['H2', 'p = 0.050', '[-0.01, 0.02]']]
        result = self.extract(head=[['Hypothesis', 'p value', '95% CI']], rows=rows)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['rows_en'], rows)

    def test_multiple_rectangular_header_rows(self):
        head = [['Variable', 'Model A', 'Model B'], ['', 'Mean', 'SD']]
        result = self.extract(head=head)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['head_en'], head)

    def test_general_textual_table_uses_explicit_bold_header(self):
        rows = [['Treatment', 'Positive', 'Supported'], ['Control', 'Negative', 'Rejected']]
        result = self.extract(rows=rows)
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['rows_en'], rows)

    def test_aligned_borderless_table(self):
        result = self.extract(ruled=False, rows=[['Treatment', '1.20', '0.045'], ['Control', '-0.50', '0.060'], ['Total', '0.70', '0.055']])
        self.assertFalse(result.issues)
        self.assertEqual(result.sources[0]['table_evidence']['method'], 'text')
        self.assertEqual(result.sources[0]['rows_en'][1], ['Control', '-0.50', '0.060'])

    def test_merged_cells_never_become_a_flat_table(self):
        result = self.extract(merged=True)
        self.assertFalse(result.sources)
        self.assertTrue(result.issues)

    def test_continued_table_falls_back(self):
        result = self.extract(caption='Table 1: Statistics (continued)')
        self.assertFalse(result.sources)
        self.assertIn('Continued', result.issues[0])

    def test_missing_caption_is_not_guessed(self):
        result = self.extract(caption='Descriptive statistics')
        self.assertFalse(result.sources)

    def test_conflicting_table_number_and_caption_is_rejected(self):
        make_table_pdf(self.path)
        ws = mock.Mock()
        ws.source_pdf = self.path
        with self.assertRaises(table_extract.UnreliableTable):
            table_extract.recognize(ws, {'page': 1, 'num': '2', 'caption_en': 'Table 1: Statistics'})

    def test_no_header_evidence_is_rejected(self):
        result = self.extract(head=[], rows=[['Treatment', '1.20', '0.04'], ['Control', '0.50', '0.02']])
        self.assertFalse(result.sources)

    def test_hidden_cropped_table_cannot_be_recognized(self):
        make_table_pdf(self.path)
        writer = PdfWriter(clone_from=str(self.path))
        writer.pages[0].cropbox = RectangleObject([0, 0, 600, 500])
        cropped = self.path.with_name('cropped.pdf')
        writer.write(cropped)
        with pdfplumber.open(cropped) as pdf:
            self.assertFalse(table_extract.extract_page(pdf.pages[0], 1).sources)

    def test_following_page_continuation_rejects_the_first_fragment(self):
        make_table_pdf(self.path)
        continuation = self.path.with_name('continuation.pdf')
        make_table_pdf(continuation, caption='Table 1: Statistics (continued)')
        writer = PdfWriter()
        writer.append(self.path)
        writer.append(continuation)
        combined = self.path.with_name('combined.pdf')
        writer.write(combined)
        ws = mock.Mock()
        ws.source_pdf = combined
        with self.assertRaises(table_extract.UnreliableTable):
            table_extract.recognize(ws, {'page': 1, 'num': '1', 'caption_en': 'Table 1: Statistics'})


class ConsistencyTest(unittest.TestCase):
    def block(self, text):
        return {'id': 't1', 'type': 'table', 'table_schema': 1, 'head_en': [['Value']], 'head_zh': [['數值']],
                'rows_en': [[text]], 'rows_zh': [[text]], 'footnotes_en': [], 'footnotes_zh': []}

    def test_exact_statistical_notation_and_formulas_pass(self):
        for text in ('-0.123***\n(0.045)', 'p < 0.001', '[-0.12, 0.34]', '1.20e-05', '1,250',
                     '$\\beta_1 = -0.12$', 'x_i', '95%', '†', 'R²', '0.050'):
            with self.subTest(text=text):
                self.assertIsNone(tables.translation_problem(self.block(text)))

    def test_changed_sign_precision_exponent_interval_marker_or_formula_fails(self):
        for source, target in (('-0.12', '0.12'), ('0.050', '0.05'), ('1.2e-05', '1.2e05'),
                               ('p < 0.01', 'p > 0.01'), ('[0.1, 0.2]', '[0.2, 0.1]'),
                               ('0.12***', '0.12**'), ('$\\beta_1$', '$\\beta_2$'),
                               ('x_i', 'x_j'), ('(0.04)', '0.04'), ('1,000', '1000')):
            b = self.block(source)
            b['rows_zh'] = [[target]]
            with self.subTest(source=source, target=target):
                self.assertIsNotNone(tables.translation_problem(b))

    def test_caption_footnote_numbers_and_additional_values_are_checked(self):
        b = self.block('1.20')
        b.update(caption_en='Table 1: Results', caption_zh='表 2：結果')
        self.assertIsNotNone(tables.translation_problem(b))
        b.update(caption_zh='表 1：結果', footnotes_en=['Source: data (2020)'], footnotes_zh=['來源：資料 (2021)'])
        self.assertIsNotNone(tables.translation_problem(b))
        b.update(footnotes_zh=['來源：資料 (2020)'])
        b['head_zh'] = [['數值 99']]
        self.assertIsNotNone(tables.translation_problem(b))

    def test_formulas_and_intervals_inside_text_are_literal_invariants(self):
        for source, target in (('Effect x - y', '效果 x + y'), ('CI [0.1, 0.2]', '區間 [0.1; 0.2]'),
                               ('Coefficient β₁', '係數 β₂'), ('Note p < 1.2e-03', '註 p < 1.2e03')):
            block = self.block(source)
            block['rows_zh'] = [[target]]
            with self.subTest(source=source):
                self.assertIsNotNone(tables.translation_problem(block))


class TableJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        make_table_pdf(self.ws.root / 'source.pdf')
        self.legacy = {'id': 'tab1', 'type': 'table', 'page': 1, 'num': '1', 'caption_en': 'Table 1: Statistics',
                       'caption_zh': '舊表題', 'head': [['舊混合表頭']], 'rows': [['舊翻譯']],
                       'box': [0.1, 0.2, 0.9, 0.6]}
        self.body = {'id': 'p1', 'type': 'para', 'page': 1, 'en': 'Completed body.', 'zh': '已完成的正文。'}
        write_json_atomic(self.ws.paper_path, {'meta': {'pages': [{'n': 1}], 'page_count': 1, 'target': 'zh-TW'},
                         'translation': {'done_pages': [1], 'en_pages': [], 'scope': '全文'},
                         'blocks': [self.body, self.legacy], 'glossary': []})
        self.ws.apply_reader_ops([{'op': 'note', 'note': {'id': 'n1', 'anchor': 'tab1', 'body': '我的筆記'}},
                                  {'op': 'progress', 'block': 'tab1', 'ratio': .5}])
        write_json_atomic(self.ws.root / 'layout.json', {'tab1': {'page': 1, 'box': self.legacy['box']}})
        self.cfg = {'engine': 'openai', 'openai': {'vision': False}}
        self.model = mock.patch.object(engines, 'run', side_effect=mock_translation).start()
        self.addCleanup(mock.patch.stopall)

    def run_job(self, **kw):
        return table_translate.translate_missing(self.ws, self.cfg, cancel=threading.Event(), **kw)

    def table(self):
        return next(b for b in self.ws.load('paper')['blocks'] if b['id'] == 'tab1')

    def test_only_tables_change_and_legacy_reader_layout_page_state_are_preserved(self):
        before = {n: (self.ws.root / f'{n}.json').read_bytes() for n in ('reader', 'layout')}
        result = self.run_job()
        self.assertEqual(result['translated'], 1, result)
        self.assertEqual(self.ws.load('paper')['blocks'][0], self.body)
        self.assertEqual(self.ws.load('paper')['translation'], {'done_pages': [1], 'en_pages': [], 'scope': '全文'})
        for n, raw in before.items():
            self.assertEqual((self.ws.root / f'{n}.json').read_bytes(), raw)
        table = self.table()
        for k in ('id', 'head', 'rows', 'box'):
            self.assertEqual(table[k], self.legacy[k])
        self.assertIsNone(tables.translation_problem(table))
        self.assertIn('翻譯內容', table['head_zh'][0][0])
        self.assertEqual(table['rows_en'][0][1:], table['rows_zh'][0][1:])
        self.assertEqual(len(table['footnotes_zh']), 2)

    def test_repeated_runs_and_workspace_reopen_use_persistent_cache(self):
        self.assertEqual(self.run_job()['translated'], 1)
        self.ws = Workspace(self.ws.root)
        for _ in range(3):
            self.assertEqual(self.run_job()['cached'], 1)
        self.assertEqual(self.model.call_count, 1)

    def test_complete_bilingual_table_without_phase_b_cache_needs_no_model(self):
        self.run_job()
        self.ws.update('paper', lambda p: p['blocks'][1].pop('table_cache'))
        self.model.reset_mock()
        self.assertEqual(self.run_job()['translated'], 1)
        self.model.assert_not_called()

    def test_duplicate_concurrent_submissions_call_model_once(self):
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.run_job(), range(2)))
        self.assertEqual(sum(r['translated'] for r in results), 1)
        self.assertEqual(sum(r['cached'] for r in results), 1)
        self.assertEqual(self.model.call_count, 1)

    def test_separate_processes_share_the_table_lock_and_cache(self):
        processes = []
        try:
            for i in range(2):
                processes.append(subprocess.Popen([sys.executable, '-c',
                    'import sys; from tests.test_table_translation import process_table_job; process_table_job(*sys.argv[1:])',
                    str(self.ws.root), f'ready-{i}', 'start', f'result-{i}.json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            deadline = time.monotonic() + 10
            while not all((self.ws.root / f'ready-{i}').exists() for i in range(2)) and time.monotonic() < deadline:
                threading.Event().wait(.05)
            self.assertTrue(all((self.ws.root / f'ready-{i}').exists() for i in range(2)))
            (self.ws.root / 'start').touch()
            for p in processes:
                stdout, stderr = p.communicate(timeout=15)
                self.assertEqual(p.returncode, 0, stderr.decode(errors='replace'))
            results = [self.ws.load(f'result-{i}') for i in range(2)]
            self.assertEqual(sum(r['translated'] for r in results), 1)
            self.assertEqual(sum(r['cached'] for r in results), 1)
            self.assertEqual((self.ws.root / 'mock-calls.txt').read_text(encoding='utf-8'), 'mock\n')
            self.model.assert_not_called()
        finally:
            for p in processes:
                if p.poll() is None:
                    p.terminate()
                p.communicate(timeout=5)

    def test_missing_table_blocks_are_discovered_without_retranslating_body(self):
        self.ws.update('paper', lambda p: p.update(blocks=[self.body]))
        result = self.run_job()
        self.assertEqual(result['translated'], 1, result)
        blocks = self.ws.load('paper')['blocks']
        self.assertEqual(blocks[0], self.body)
        self.assertEqual(blocks[1]['id'], 'table-p1-1')
        self.assertEqual(self.run_job()['cached'], 1)

    def test_appendix_table_ids_remain_safe_reader_anchors(self):
        self.ws.update('paper', lambda p: p.update(blocks=[self.body]))
        make_table_pdf(self.ws.root / 'source.pdf', caption='Table A1.2: Statistics')
        self.assertEqual(self.run_job()['translated'], 1)
        block = self.ws.load('paper')['blocks'][1]
        self.assertEqual(block['num'], 'A1.2')
        self.assertEqual(block['id'], 'table-p1-A1-2')

    def test_failed_masks_retry_and_keep_all_prior_data(self):
        self.model.side_effect = lambda *a, **kw: json.dumps({'zh': {}})
        result = self.run_job()
        self.assertEqual(result['fallback'], 1)
        self.assertEqual(self.model.call_count, 2)
        self.assertEqual(self.table()['rows'], self.legacy['rows'])
        self.assertEqual(self.table()['caption_zh'], self.legacy['caption_zh'])
        self.assertNotIn('rows_zh', self.table())

    def test_tampered_values_after_restoring_masks_are_rejected(self):
        def bad(*args, **kw):
            result = json.loads(mock_translation(*args, **kw))
            result['zh']['head:0:0'] += ' 999'
            return json.dumps(result)
        self.model.side_effect = bad
        self.assertEqual(self.run_job()['fallback'], 1)
        self.assertNotIn('table_cache', self.table())

    def test_transient_failure_retries_and_then_caches(self):
        def run(*args, **kw):
            if self.model.call_count == 1:
                raise engines.EngineError('temporary error')
            return mock_translation(*args, **kw)
        self.model.side_effect = run
        self.assertEqual(self.run_job()['translated'], 1)
        self.assertEqual(self.model.call_count, 2)
        self.assertEqual(self.run_job()['cached'], 1)

    def test_cancel_after_model_response_does_not_save_translation(self):
        cancel = threading.Event()
        def run(*args, **kw):
            text = mock_translation(*args, **kw)
            cancel.set()
            return text
        self.model.side_effect = run
        before = copy.deepcopy(self.table())
        with self.assertRaises(engines.Cancelled):
            table_translate.translate_missing(self.ws, self.cfg, cancel=cancel)
        self.assertEqual(self.table(), before)
        self.model.side_effect = mock_translation
        self.assertEqual(self.run_job()['translated'], 1)

    def test_cancel_before_start_calls_no_model(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(engines.Cancelled):
            table_translate.translate_missing(self.ws, self.cfg, cancel=cancel)
        self.model.assert_not_called()

    def test_concurrent_table_edit_discards_stale_response(self):
        def run(*args, **kw):
            self.ws.update('paper', lambda p: p['blocks'][1].update(caption_zh='較新的表題'))
            return mock_translation(*args, **kw)
        self.model.side_effect = run
        result = self.run_job()
        self.assertIn('Stale', result['failed']['tab1'])
        self.assertEqual(self.table()['caption_zh'], '較新的表題')
        self.assertNotIn('rows_zh', self.table())

    def test_pdf_changes_during_response_discards_stale_response(self):
        def run(*args, **kw):
            make_table_pdf(self.ws.root / 'source.pdf', rows=[['Treatment', '9.20', '0.045'], ['Control', '-0.50', '0.060']])
            return mock_translation(*args, **kw)
        self.model.side_effect = run
        self.assertIn('Stale', self.run_job()['failed']['tab1'])
        self.assertNotIn('rows_zh', self.table())

    def test_source_change_invalidates_cache_and_archives_previous_translation(self):
        self.run_job()
        previous = copy.deepcopy(self.table())
        make_table_pdf(self.ws.root / 'source.pdf', rows=[['Treatment', '9.20', '0.045'], ['Control', '-0.50', '0.060']])
        self.assertEqual(self.run_job()['translated'], 1)
        table = self.table()
        self.assertEqual(table['rows_zh'][0][1], '9.20')
        self.assertEqual(table['table_history'][0], previous)
        self.assertNotEqual(table['table_cache']['source_hash'], previous['table_cache']['source_hash'])

    def test_tampered_translation_cache_is_repaired(self):
        self.run_job()
        self.ws.update('paper', lambda p: p['blocks'][1]['rows_zh'][0].__setitem__(1, '99.9'))
        result = self.run_job()
        self.assertEqual(result['translated'], 1, result)
        self.assertEqual(self.table()['rows_zh'][0][1], '1.20')

    def test_partial_translation_reuses_verified_cells_and_only_requests_missing(self):
        self.run_job()
        table = self.table()
        table['rows_zh'][0][0] = ''
        table.pop('table_cache')
        self.ws.update('paper', lambda p: p['blocks'].__setitem__(1, table))
        self.model.reset_mock()
        self.assertEqual(self.run_job()['translated'], 1)
        cells = json.loads(self.model.call_args.args[1].split('\n')[-1])['cells']
        self.assertEqual(set(cells), {'rows:0:0'})

    def test_structural_fallback_keeps_pdf_and_uses_reading_only(self):
        from tests.test_table_reading_translation import response
        self.model.side_effect = response
        make_table_pdf(self.ws.root / 'source.pdf', merged=True)
        result = self.run_job()
        self.assertEqual(result['fallback'], 1)
        self.assertEqual(self.table()['table_status'], 'fallback')
        self.assertEqual(self.table()['box'], self.legacy['box'])
        self.assertEqual(result['reading_translated'], 1)
        self.model.assert_called_once()

    def test_unsafe_spans_and_segments_cannot_be_flattened(self):
        for field in ('table_spans', 'table_segments'):
            with self.subTest(field=field):
                self.ws.update('paper', lambda p: p['blocks'].__setitem__(1, {**self.legacy, field: [{'page': 1}]}))
                self.assertEqual(self.run_job()['fallback'], 1)
        self.model.assert_not_called()

    def test_quota_failure_does_not_retry(self):
        self.model.side_effect = engines.EngineError('insufficient_quota')
        self.assertEqual(self.run_job()['fallback'], 1)
        self.assertEqual(self.model.call_count, 1)

    def test_page_subset_does_not_touch_other_tables(self):
        result = self.run_job(pages=[])
        self.assertEqual(result['translated'], 0)
        self.assertEqual(self.table(), self.legacy)
        self.model.assert_not_called()

    def test_missing_unsupported_table_gets_a_pdf_placeholder(self):
        from tests.test_table_reading_translation import response
        self.model.side_effect = response
        self.ws.update('paper', lambda p: p.update(blocks=[self.body]))
        make_table_pdf(self.ws.root / 'source.pdf', merged=True)
        result = self.run_job()
        self.assertEqual(result['fallback'], 1)
        block = self.ws.load('paper')['blocks'][1]
        self.assertEqual(block['table_status'], 'fallback')
        self.assertEqual(block['page'], 1)
        self.assertNotIn('rows_en', block)
        self.assertEqual(result['reading_translated'], 1)
        self.model.assert_called_once()

    def test_missing_mask_duplicate_mask_and_echo_are_rejected(self):
        for change in ('drop', 'duplicate', 'echo'):
            def run(cfg, prompt, *args):
                cells = json.loads(prompt.split('\n')[-1])['cells']
                if change == 'echo':
                    return json.dumps({'zh': cells})
                data = json.loads(mock_translation(cfg, prompt, *args))
                key = next(k for k, v in data['zh'].items() if '⟦PR' in v)
                token = re.search(r'⟦PR\d+⟧', data['zh'][key]).group()
                data['zh'][key] = data['zh'][key].replace(token, '' if change == 'drop' else token + token)
                return json.dumps(data)
            self.model.side_effect = run
            with self.subTest(change=change):
                self.assertEqual(self.run_job()['fallback'], 1)
                self.assertNotIn('table_cache', self.table())

    def test_post_normalization_and_glossary_are_revalidated(self):
        self.ws.update('paper', lambda p: p.update(glossary=[{'en': 'Variable', 'zh': '變數 99'}]))
        self.assertEqual(self.run_job()['translated'], 1)
        self.assertNotIn('99', self.table()['head_zh'][0][0])
        self.ws.update('paper', lambda p: p['blocks'].__setitem__(1, self.legacy.copy()))
        real = table_translate.traditional.normalize
        def normalize(data):
            real(data)
            data['blocks'][0]['rows_zh'][0][1] = '999'
        with mock.patch.object(table_translate.traditional, 'normalize', side_effect=normalize):
            self.assertEqual(self.run_job()['fallback'], 1)
            self.assertNotIn('table_cache', self.table())


class StorageRetryTest(unittest.TestCase):
    def test_transient_windows_read_permission_is_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'paper.json'
            write_json_atomic(path, {'ok': True})
            original = open
            calls = []
            def opening(*args, **kw):
                calls.append(1)
                if len(calls) == 1:
                    raise PermissionError('atomic replace')
                return original(*args, **kw)
            with mock.patch('builtins.open', side_effect=opening), mock.patch.object(store.time, 'sleep'):
                self.assertEqual(store.read_json(path), {'ok': True})
            self.assertEqual(len(calls), 2)


class TableEntryTest(unittest.TestCase):
    def test_cli_table_only_flag_never_runs_body_translation(self):
        from easyread import cli
        result = {'translated': 0, 'cached': 1, 'fallback': 0, 'failed': {}, 'issues': []}
        ws = mock.Mock()
        with mock.patch.object(cli, 'find', return_value=ws), \
                mock.patch.object(cli, 'running_server', return_value=None), \
                mock.patch.object(cli.config, 'load', return_value={'engine': 'openai'}), \
                mock.patch.object(cli, 'out'), \
                mock.patch('easyread.translate.translate_pages') as body, \
                mock.patch.object(table_translate, 'translate_missing', return_value=result) as only:
            cli.main(['translate', 'mock-paper', '--tables-only', '--pages', '1-2'])
        body.assert_not_called()
        self.assertEqual(only.call_args.args[2], [1, 2])

    def test_cli_rejected_table_queue_does_not_fall_back_to_model(self):
        import argparse
        import urllib.error
        from easyread import cli
        ws = mock.Mock()
        ws.id = 'mock-paper'
        token = mock.Mock()
        token.read.return_value = b'{"token":"mock-token"}'
        error = urllib.error.HTTPError('http://localhost/mock', 409, 'Already queued', {}, None)
        with mock.patch.object(cli, 'find', return_value=ws), \
                mock.patch.object(cli, 'running_server', return_value='http://localhost'), \
                mock.patch.object(cli.urllib.request, 'urlopen', side_effect=[token, error]), \
                mock.patch.object(table_translate, 'translate_missing') as only:
            with self.assertRaises(urllib.error.HTTPError):
                cli.cmd_translate(argparse.Namespace(id=ws.id, pages=None, tables_only=True))
        only.assert_not_called()

    def test_api_queues_table_only_job_without_body_page_selection(self):
        jobs = mock.Mock()
        ws = mock.Mock()
        ws.load.return_value = {'meta': {'page_count': 5}, 'translation': {'done_pages': [1, 2]}}
        self.assertEqual(translate_api.enqueue(jobs, ws, {'tables_only': True}), {'ok': True})
        jobs.enqueue.assert_called_once_with(ws, pages=None, tables_only=True)

    def test_table_page_range_is_validated(self):
        jobs, ws = mock.Mock(), mock.Mock()
        ws.load.return_value = {'meta': {'page_count': 5}}
        with self.assertRaises(ValueError):
            translate_api.enqueue(jobs, ws, {'tables_only': True, 'pages': '4-6'})
        jobs.enqueue.assert_not_called()

    def test_bulk_table_job_uses_existing_queue_without_body_translation(self):
        from tests.test_jobs import JobsTest
        setup = JobsTest()
        setup.setUp()
        self.addCleanup(setup.doCleanups)
        result = {'translated': 1, 'cached': 0, 'failed': {}, 'fallback': 0, 'issues': []}
        with mock.patch('easyread.jobs.config.load', return_value={'engine': 'openai'}), \
                mock.patch('easyread.jobs.translate.translate_pages') as body, \
                mock.patch.object(table_translate, 'translate_missing', return_value=result) as only:
            setup.jobs.enqueue(setup.ws, tables_only=True)
            setup.drain()
        body.assert_not_called()
        only.assert_called_once()
        self.assertEqual(setup.ws.load('job')['type'], 'tables')
        self.assertEqual(setup.ws.load('job')['state'], 'done')
        self.assertEqual(setup.ws.load('job')['table_result'], result)

    def test_restart_keeps_table_job_type_and_skips_body(self):
        from tests.test_jobs import JobsTest
        from easyread.jobs import Jobs
        setup = JobsTest()
        setup.setUp()
        self.addCleanup(setup.doCleanups)
        write_json_atomic(setup.ws.root / 'job.json', {'state': 'running', 'type': 'tables', 'tables_only': True})
        with mock.patch('easyread.jobs.threading.Thread.start'):
            setup.jobs = Jobs(setup.lib)
        with mock.patch('easyread.jobs.config.load', return_value={'engine': 'openai'}), \
                mock.patch('easyread.jobs.translate.translate_pages') as body, \
                mock.patch.object(table_translate, 'translate_missing', return_value={'translated': 0, 'cached': 1, 'fallback': 0, 'failed': {}, 'issues': []}):
            setup.drain()
        body.assert_not_called()
        self.assertEqual(setup.ws.load('job')['state'], 'done')

    def test_page_cap_confirmation_preserves_table_only_type(self):
        from tests.test_jobs import JobsTest
        setup = JobsTest()
        setup.setUp()
        self.addCleanup(setup.doCleanups)
        setup.ws.update('paper', lambda p: p.update(meta={'pages': [{'n': n} for n in range(1, 4)], 'page_count': 3}))
        setup.jobs.enqueue(setup.ws, tables_only=True)
        with mock.patch('easyread.jobs.config.load', return_value={'engine': 'openai', 'page_cap': 1}), \
                mock.patch.object(table_translate, 'translate_missing') as only:
            setup.drain()
        only.assert_not_called()
        self.assertEqual(setup.ws.load('job')['state'], 'confirm')
        translate_api.enqueue(setup.jobs, setup.ws, {'scope': 'range:1-1'})
        self.assertTrue(setup.ws.load('job')['tables_only'])
        self.assertEqual(setup.ws.load('job')['pages'], [1])
        setup.jobs._write(setup.ws, state='confirm', tables_only=True, pages=[1, 2, 3])
        translate_api.enqueue(setup.jobs, setup.ws, {'confirmed': True})
        self.assertTrue(setup.ws.load('job')['tables_only'])
        self.assertEqual(setup.ws.load('job')['pages'], [1, 2, 3])


if __name__ == '__main__':
    unittest.main()
