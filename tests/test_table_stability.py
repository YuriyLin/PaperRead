"""Isolated stability acceptance; local PDFs and fake responses, no live models."""
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfWriter

from easyread import config, engines, pdfwork, reader_data, table_extract, table_policy, table_reading, table_translate
from easyread.library import Library
from easyread.store import Workspace, write_json_atomic
from scripts.table_qa.benchmark import FIXTURES
from tests.test_table_translation import mock_translation

REPO = Path(__file__).resolve().parents[1]


class IsolatedTableStabilityTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.enter = self.stack.enter_context
        parent = REPO / '.paperread-local-test'
        parent.mkdir(exist_ok=True)
        self.root = Path(self.enter(tempfile.TemporaryDirectory(prefix='stability-', dir=parent))).resolve()
        self.enter(mock.patch.dict(os.environ, {
            'PAPERREAD_TEST_PROFILE': str(self.root), 'PAPERREAD_REVIEW_MODE': 'Mock',
            'PAPERREAD_OFFLINE_TEST': '1', 'PAPERREAD_DISABLE_TABLE_EXTRACTION': '0',
            'EASYREAD_HOME': str(self.root / 'home'), 'EASYREAD_LIBRARY': str(self.root / 'library')}))
        (self.root / 'home').mkdir()
        self.settings = self.root / 'home' / 'config.json'
        self.settings.write_text('{"engine":"openai","auto_translate":false,"sentinel":"keep"}', encoding='utf-8')
        for name, path in [('HOME', self.root/'home'), ('PROJECT', self.root/'home'),
                           ('CONFIG_PATH', self.settings), ('LEGACY_HOME', self.root/'legacy'),
                           ('LOG_PATH', self.root/'home'/'test.log')]:
            self.enter(mock.patch.object(config, name, path))
        self.enter(mock.patch.object(engines, 'run', side_effect=AssertionError('Live model forbidden')))
        self.enter(mock.patch.object(engines, '_popen', side_effect=AssertionError('Live CLI forbidden')))
        self.enter(mock.patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')))
        self.lib = Library(self.root / 'library')
        self.cfg = {'engine': 'openai'}

    def imported(self, name='ruled_times'):
        data = (FIXTURES / 'regression' / f'{name}.pdf').read_bytes()
        ws, created = self.lib.create_from_pdf(data, name + '.pdf')
        self.assertTrue(created)
        self.assertEqual(ws.source_pdf.read_bytes(), data)
        return ws

    def legacy(self):
        ws = self.imported()
        self.body = {'id':'body1','type':'para','page':1,'en':'Original body','zh':'Existing translation'}
        self.other = {'id':'body2','type':'para','page':2,'en':'Other page','zh':'Other translation'}
        self.old_table = {'id':'tab1','type':'table','page':1,'num':'1',
                          'caption_en':'Table 1: Estimates','caption_zh':'Existing caption',
                          'head':[['Legacy heading']], 'rows':[['Legacy value']], 'box':[.1,.1,.9,.5]}
        ws.update('paper', lambda p: p.update(meta={**p['meta'],'pages':[{'n':1},{'n':2}]},
                  blocks=[self.body,self.old_table,self.other],translation={'done_pages':[1,2],'en_pages':[]}))
        write_json_atomic(ws.root/'layout.json', {'sentinel':'original geometry'})
        ws.apply_reader_ops([{'op':'note','note':{'id':'n1','anchor':'tab1','quote':'Legacy value','body':'Existing note'}}])
        return ws

    def protected(self, ws):
        return {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (ws.source_pdf,ws.reader_path,ws.root/'layout.json',self.settings)}

    def assert_retained(self, ws, protected, *, translated_caption=False):
        self.assertEqual(self.protected(ws), protected)
        paper = ws.load('paper')
        self.assertEqual(paper['blocks'][0],self.body)
        self.assertEqual(paper['blocks'][-1],self.other)
        self.assertEqual(paper['translation']['done_pages'],[1,2])
        table = next(b for b in paper['blocks'] if b['id']=='tab1')
        for key,value in self.old_table.items():
            if key == 'caption_zh' and translated_caption:
                self.assertTrue(table[key])  # Successful explicit retranslation may update its caption.
                continue
            self.assertEqual(table[key],value)

    def test_new_import_plain_ruled_and_borderless_use_existing_pipeline(self):
        for name,expected in [('natural_prose_no_caption',0),('ruled_times',1),('borderless_times',1)]:
            with self.subTest(name=name):
                ws = self.imported(name)
                runner = mock.Mock(side_effect=mock_translation)
                result = table_translate.translate_missing(ws,self.cfg,pages=[1],run=runner)
                self.assertEqual(result['translated'],expected)
                self.assertEqual(runner.call_count,expected)
                self.assertEqual(ws.source_pdf.read_bytes(),(FIXTURES/'regression'/f'{name}.pdf').read_bytes())

    def test_captioned_prose_is_rejected_before_model_or_reading_fallback(self):
        ws = self.imported('natural_prose_captioned')
        runner = mock.Mock(side_effect=AssertionError('No model for a split source word'))
        with mock.patch.object(table_reading,'recognize_source',side_effect=AssertionError('No reading fallback')):
            result = table_translate.translate_missing(ws,self.cfg,pages=[1],run=runner)
        runner.assert_not_called()
        self.assertIn('Borderless grid splits a source word',result['failed']['table-p1-1'])
        block = ws.load('paper')['blocks'][0]
        self.assertEqual(block['table_status'],'fallback')
        self.assertNotIn('rows_en',block)

    def test_unlabelled_continuation_is_recorded_as_release_blocker(self):
        # Characterize the remaining defect without fabricating a continuation
        # heuristic: a first-page result cannot establish document completeness.
        ws = self.imported('continued_unlabelled')
        source = table_extract.recognize(ws,{'page':1,'num':'1','caption_en':'Table 1: Estimates'})
        self.assertEqual(len(source['rows_en']),3)
        with pdfplumber.open(ws.source_pdf) as pdf:
            self.assertIn('Delta',pdf.pages[1].extract_text())
        self.assertNotIn('Delta',str(source['rows_en']))

    def test_scanned_pdf_never_invents_a_matrix_or_calls_model(self):
        image = Image.new('RGB',(240,300),'white')
        draw = ImageDraw.Draw(image)
        draw.text((15,15),'Table 1: scan',fill='black')
        draw.rectangle((15,45,220,170),outline='black')
        data = io.BytesIO()
        image.save(data,format='PDF')
        ws,_ = self.lib.create_from_pdf(data.getvalue(),'scanned.pdf')
        runner = mock.Mock(side_effect=AssertionError('No OCR/model'))
        self.assertEqual(table_translate.translate_missing(ws,self.cfg,pages=[1],run=runner)['translated'],0)
        runner.assert_not_called()
        self.assertEqual(ws.load('paper')['blocks'],[])
        self.assertEqual(pdfwork.extract_text(ws.source_pdf,ws.root/'extract'),1)
        self.assertFalse((ws.root/'extract/page-001.txt').read_text().strip())

    def test_corrupt_and_password_protected_sources_do_not_damage_other_papers(self):
        safe = self.legacy()
        protected, paper = self.protected(safe),safe.paper_path.read_bytes()
        writer = PdfWriter(clone_from=str(safe.source_pdf))
        writer.encrypt('not-the-password')
        encrypted = io.BytesIO()
        writer.write(encrypted)
        for label,data in [('corrupt',b'%PDF-1.7\ninvalid broken objects\n%%EOF'),('encrypted',encrypted.getvalue())]:
            with self.subTest(label=label):
                ws,_ = self.lib.create_from_pdf(data,label+'.pdf')
                before = {p:p.read_bytes() for p in (ws.source_pdf,ws.paper_path,ws.reader_path,self.settings)}
                runner = mock.Mock(side_effect=AssertionError('No model'))
                with self.assertRaises(Exception):
                    table_translate.translate_missing(ws,self.cfg,pages=[1],run=runner)
                runner.assert_not_called()
                self.assertEqual({p:p.read_bytes() for p in before},before)
                self.assert_retained(safe,protected)
                self.assertEqual(safe.paper_path.read_bytes(),paper)

    def test_non_pdf_import_is_rejected_before_creating_an_item(self):
        before = set(self.lib.root.iterdir())
        with self.assertRaises(ValueError):
            self.lib.create_from_pdf(b'not a pdf','invalid.pdf')
        self.assertEqual(set(self.lib.root.iterdir()),before)

    def test_old_translations_and_notes_survive_reopen_and_failed_table_job(self):
        ws = self.legacy()
        protected = self.protected(ws)
        reopened = self.lib.ws(ws.id)
        projected,_ = reader_data.reader_paper(reopened)
        self.assertEqual(projected,reopened.load('paper'))
        result = table_translate.translate_missing(reopened,self.cfg,pages=[1],run=lambda *a,**k: '{"zh":{}}')
        self.assertTrue(result['failed'])
        self.assert_retained(reopened,protected)

    def test_real_process_exit_and_fresh_process_restart_preserve_data(self):
        ws = self.legacy()
        before, protected = ws.paper_path.read_bytes(),self.protected(ws)
        code = '''import os,sys
from pathlib import Path
from easyread.store import Workspace
from easyread import table_translate
def crash(*args,**kwargs): os._exit(71)
table_translate.translate_missing(Workspace(Path(sys.argv[1])),{'engine':'openai'},pages=[1],run=crash)
'''
        stopped = subprocess.run([sys.executable,'-c',code,str(ws.root)],cwd=REPO,capture_output=True,timeout=30)
        self.assertEqual(stopped.returncode,71,stopped.stderr.decode(errors='replace'))
        self.assertEqual(ws.paper_path.read_bytes(),before)
        self.assert_retained(ws,protected)
        code = '''import sys
from pathlib import Path
from easyread.store import Workspace
from easyread import table_translate
from tests.test_table_translation import mock_translation
r=table_translate.translate_missing(Workspace(Path(sys.argv[1])),{'engine':'openai'},pages=[1],run=mock_translation)
assert r['translated']==1,r
'''
        restarted = subprocess.run([sys.executable,'-c',code,str(ws.root)],cwd=REPO,capture_output=True,timeout=30)
        self.assertEqual(restarted.returncode,0,restarted.stderr.decode(errors='replace'))
        self.assert_retained(Workspace(ws.root),protected,translated_caption=True)

    def test_cancellation_before_commit_keeps_existing_data(self):
        ws = self.legacy()
        protected,before = self.protected(ws),ws.paper_path.read_bytes()
        cancel = threading.Event()
        def interrupted(*args,**kwargs):
            result = mock_translation(*args,**kwargs)
            cancel.set()
            return result
        with self.assertRaises(engines.Cancelled):
            table_translate.translate_missing(ws,self.cfg,pages=[1],cancel=cancel,run=interrupted)
        self.assertEqual(ws.paper_path.read_bytes(),before)
        self.assert_retained(ws,protected)

    def test_disabled_public_and_private_parsers_stop_before_pdf_io(self):
        self.enter(mock.patch.dict(os.environ,{'PAPERREAD_DISABLE_TABLE_EXTRACTION':'1'}))
        ws = mock.Mock()
        ws.source_pdf.read_bytes.side_effect = AssertionError('PDF read while disabled')
        with mock.patch('pdfplumber.open',side_effect=AssertionError('Parser while disabled')):
            self.assertEqual(table_extract.extract_page(None,1).issues,[table_policy.DISABLED])
            for call in (lambda:table_extract._matrix(None,None,'text'),
                         lambda:table_extract.recognize(ws,{}),
                         lambda:table_reading._extract(None,{},''),
                         lambda:table_reading.recognize_source(ws,{}),
                         lambda:table_translate._discover(ws,[1],'',None),
                         lambda:table_translate.translate_missing(ws,self.cfg,pages=[1])):
                with self.assertRaisesRegex(ValueError,table_policy.DISABLED):
                    call()
        ws.load.assert_not_called()
        ws.update.assert_not_called()
        ws.source_pdf.read_bytes.assert_not_called()

    def test_disable_applies_to_reader_cache_hits_without_writing_saved_data(self):
        ws = self.legacy()
        # Use real preexisting reading evidence via the existing merged fixture.
        from tests.test_table_translation import make_table_pdf
        from tests.test_table_reading_translation import response
        make_table_pdf(ws.source_pdf,merged=True)
        ws.update('paper',lambda p:p['blocks'][1].update(caption_en='Table 1: Statistics'))
        table_translate.translate_missing(ws,self.cfg,pages=[1],run=response)
        reader_data.reader_paper(ws)  # Prime verification/preview caches.
        before = {p:p.read_bytes() for p in (ws.paper_path,ws.reader_path,ws.source_pdf,self.settings)}
        with mock.patch.dict(os.environ,{'PAPERREAD_DISABLE_TABLE_EXTRACTION':'true'}), \
             mock.patch.object(reader_data,'_digest',side_effect=AssertionError('No PDF digest')), \
             mock.patch.object(table_reading,'verify_source',side_effect=AssertionError('No cache bypass')):
            projected,_ = reader_data.reader_paper(ws)
            block = projected['blocks'][1]
            for field in reader_data._FIELDS:
                self.assertNotIn(field,block)
            self.assertEqual(block['rows'],self.old_table['rows'])
            with self.assertRaisesRegex(ValueError,table_policy.DISABLED):
                table_translate.translate_missing(ws,self.cfg,pages=[1])
        self.assertEqual({p:p.read_bytes() for p in before},before)
        self.assertIn('table_reading',reader_data.reader_paper(ws)[0]['blocks'][1])


if __name__ == '__main__':
    unittest.main()
