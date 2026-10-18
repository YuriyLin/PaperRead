"""Reader source projection across HTTP polling and embedded HTML; no models."""
import copy
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread import build, reader_data, server, table_reading, table_translate
from easyread.store import Workspace, write_json_atomic
from tests.test_table_translation import make_table_pdf
from tests.test_table_reading_translation import response
from tests.test_bilingual_tables import bilingual_table


class ReaderProjectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        make_table_pdf(self.ws.source_pdf, merged=True)
        block = {'id': 't1', 'type': 'table', 'page': 1, 'num': '1',
                 'caption_en': 'Table 1: Statistics', 'table_status': 'fallback'}
        write_json_atomic(self.ws.paper_path, {'meta': {'pages': [{'n': 1, 'img': 'pages/missing.webp'}]}, 'blocks': [block]})
        table_translate.translate_missing(self.ws, {'engine': 'openai'}, run=response)
        with reader_data._lock:
            reader_data._verified.clear()
        self.before = self.ws.paper_path.read_bytes()

    def assert_hidden(self, paper):
        b = paper['blocks'][0]
        self.assertEqual(b['table_status'], 'fallback')
        for key in reader_data._FIELDS:
            self.assertNotIn(key, b)

    def route(self, action):
        handler = object.__new__(server.Handler)
        handler.path = '/api/p/test/' + action
        handler.app = SimpleNamespace(lib=SimpleNamespace(ws=lambda _: self.ws), token='test',
                                      location=SimpleNamespace(status='busy'))
        handler._json = lambda code, data: data
        with mock.patch.object(server.research_api, 'get', return_value=None), \
                mock.patch.object(server.research_v2, 'get', return_value=None), \
                mock.patch.object(server.library_api, 'get', return_value=None), \
                mock.patch.object(server.config, 'load', return_value={'engine': 'none'}):
            return handler._get()

    def offline(self, **kwargs):
        # Page image fixtures are unnecessary for this data-only build test.
        original = self.ws.load('paper')
        original['meta']['pages'] = []
        html = build.build(self.ws, self.ws.root / 'offline.html', extra={'paper': original, **kwargs}, lang='en').read_text(encoding='utf-8')
        return json.loads(re.search(r'<script id="pr-data" type="application/json">(.*?)</script>', html, re.S).group(1))['paper']

    def test_all_live_paths_use_same_projection_and_version(self):
        safe, version = reader_data.reader_paper(self.ws)
        self.assertIn('table_reading_zh', safe['blocks'][0])
        state = self.route('state')
        part = self.route('part/paper')
        self.assertEqual(state['paper'], safe)
        self.assertEqual(part['data'], safe)
        self.assertEqual(state['versions']['paper'], version)
        self.assertEqual(part['version'], version)
        self.assertEqual(self.route('versions')['paper'], version)
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)

    def test_success_cache_still_hashes_actual_pdf_and_revalidates_changes(self):
        with mock.patch.object(table_reading, 'verify_source', wraps=table_reading.verify_source) as verify:
            _, old = reader_data.reader_paper(self.ws)
            reader_data.reader_paper(self.ws)
            self.assertEqual(verify.call_count, 1)
            make_table_pdf(self.ws.source_pdf, merged=True, rows=[['New', '2', '3'], ['Other', '4', '5']])
            safe, new = reader_data.reader_paper(self.ws)
            self.assert_hidden(safe)
            self.assertNotEqual(old, new)
            self.assertEqual(self.route('versions')['paper'], new)
            self.assert_hidden(self.route('part/paper')['data'])
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)

    def test_failed_verification_missing_pdf_and_offline_consistency(self):
        with mock.patch.object(table_reading, 'verify_source', side_effect=ValueError('unreliable')):
            self.assert_hidden(self.route('state')['paper'])
            self.assert_hidden(self.offline())
        self.ws.source_pdf.unlink()
        self.assert_hidden(self.route('part/paper')['data'])
        self.assert_hidden(self.offline())
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)

    def test_invalid_translation_order_identity_and_notation(self):
        base = self.ws.load('paper')
        for change in ('reverse', 'id', 'number', 'cache', 'source'):
            p = copy.deepcopy(base)
            b = p['blocks'][0]
            if change == 'reverse': b['table_reading_zh'].reverse()
            elif change == 'id': b['table_reading_zh'][0]['id'] = 'fake'
            elif change == 'number': b['table_reading_zh'][0]['zh'] += ' 999'
            elif change == 'source': b['table_reading']['source']['segments'][0]['en'] = 'invented'
            else: b['table_reading_cache']['translation_hash'] = 'fake'
            if change != 'cache':
                b['table_reading_cache']['translation_hash'] = table_translate._hash(b['table_reading_zh'])
            self.assert_hidden(reader_data.reader_paper(self.ws, p)[0])
            self.assert_hidden(self.offline(paper=p))
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)

    def test_legacy_structured_and_caller_data_unchanged(self):
        paper = {'meta': {}, 'blocks': [bilingual_table(), {'type': 'table', 'head': [['Old']], 'rows': [['1']]}]}
        before = copy.deepcopy(paper)
        with mock.patch.object(reader_data, '_digest', side_effect=AssertionError('No PDF needed')):
            safe, _ = reader_data.reader_paper(self.ws, paper)
        self.assertEqual(safe, before)
        safe['blocks'][0]['head_en'][0][0] = 'edit'
        self.assertEqual(paper, before)

    def test_valid_offline_projection_matches_live(self):
        live = self.route('state')['paper']
        offline = self.offline()
        self.assertEqual(live['blocks'], offline['blocks'])
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)

    def test_same_size_and_timestamp_pdf_change_cannot_hit_cache(self):
        reader_data.reader_paper(self.ws)
        path = self.ws.source_pdf
        stat = path.stat()
        data = path.read_bytes()
        changed = data.replace(b'Treatment', b'Treatxxxx')
        self.assertNotEqual(data, changed)
        self.assertEqual(len(data), len(changed))
        path.write_bytes(changed)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assert_hidden(reader_data.reader_paper(self.ws)[0])

    def test_rehashed_forgery_requires_real_source_verification(self):
        p = self.ws.load('paper')
        reader_data.reader_paper(self.ws)  # Warm the original valid evidence.
        r = p['blocks'][0]['table_reading']
        seg = r['source']['segments'][0]
        seg['en'] = 'Invented heading'
        seg['id'] = 's-' + table_reading._hash([seg['en'], seg['box']])
        r['source_hash'] = table_reading._hash(r['source'])
        p['blocks'][0]['table_reading_zh'][0]['id'] = seg['id']
        p['blocks'][0]['table_reading_cache']['translation_hash'] = table_translate._hash(p['blocks'][0]['table_reading_zh'])
        with mock.patch.object(table_reading, 'verify_source', wraps=table_reading.verify_source) as verify:
            self.assert_hidden(reader_data.reader_paper(self.ws, p)[0])
            verify.assert_called_once()

    def test_pdf_change_during_verification_is_rejected(self):
        original = table_reading.verify_source
        def changed(ws, block):
            original(ws, block)
            ws.source_pdf.write_bytes(ws.source_pdf.read_bytes() + b'\n% changed')
        with mock.patch.object(table_reading, 'verify_source', side_effect=changed):
            self.assert_hidden(reader_data.reader_paper(self.ws)[0])
        self.assertEqual(self.ws.paper_path.read_bytes(), self.before)
