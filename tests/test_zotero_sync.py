from pathlib import Path
import hashlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from easyread.bulk import api
from easyread.bulk.runner import Migration
from easyread.library import Library
from easyread.zotero.reader import Entry, Snapshot


class ZoteroSyncTest(unittest.TestCase):
    def test_preview_and_sync_preserve_existing_and_ask_before_reimport(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lib = Library(root / 'library')
            jobs = SimpleNamespace(enqueue=mock.Mock())
            migration = Migration(SimpleNamespace(lib=lib, jobs=jobs))
            migration._save_cats = mock.Mock()
            old_pdf = b'%PDF-1.4 old\n%%EOF'
            new_pdf = b'%PDF-1.4 new\n%%EOF'
            old = root / 'old.pdf'; old.write_bytes(old_pdf)
            new = root / 'new.pdf'; new.write_bytes(new_pdf)
            old_ws, _ = lib.create_from_pdf(old_pdf, old.name)
            old_ws.update('item', lambda item: item.update(tags=['Personal']))
            entries = [Entry(key='OLD', meta={'title_en': 'Old'}, pdf=old, cats=['Zotero']),
                       Entry(key='NEW', meta={'title_en': 'New'}, pdf=new)]
            snap = Snapshot(entries, [])
            def run(selected=()):
                migration.status = {'state': 'running', 'existing': 0, 'imported': 0, 'done': 0, 'skipped': [], 'failed': []}
                migration._run(snap, True, False, sync=True, lib=lib, jobs=jobs, selected=set(selected))
                self.assertEqual(migration.status['state'], 'done')
            run()
            self.assertEqual(old_ws.load('item')['tags'], ['Personal'])
            self.assertEqual(migration.status['imported'], 1)
            lib.trash(old_ws.id)
            with mock.patch('easyread.bulk.runner.read', return_value=(snap, str(root))):
                preview = migration.sync_preview(str(root))
            digest = hashlib.sha256(old_pdf).hexdigest()
            self.assertEqual(preview['deleted'], [{'sha256': digest, 'title': 'Old'}])
            run()
            self.assertIsNone(lib.ws(digest[:12]))
            self.assertEqual(len(migration.status['skipped']), 1)
            run([digest])
            self.assertIsNotNone(lib.ws(digest[:12]))
            self.assertEqual(migration.status['imported'], 1)
            self.assertEqual(old.read_bytes(), old_pdf)
            self.assertEqual(new.read_bytes(), new_pdf)
            self.assertTrue(any((lib.root / '.trash').glob(digest[:12] + '-*')))
            other = Library(root / 'other-library')
            other_migration = Migration(SimpleNamespace(lib=other, jobs=jobs))
            with mock.patch('easyread.bulk.runner.read', return_value=(snap, str(root))):
                self.assertEqual(other_migration.sync_preview(str(root))['deleted'], [])


    def test_sync_api_guards_library_switch_and_saves_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lib = Library(root / 'library')
            app = SimpleNamespace(lib=lib, jobs=SimpleNamespace(enqueue=mock.Mock()))
            folder = root / 'zotero'; folder.mkdir(); (folder / 'zotero.sqlite').write_bytes(b'')
            token = hashlib.sha256(str(lib.root).encode('utf-8')).hexdigest()
            with mock.patch.object(api.prefs, 'load', return_value={}), \
                 mock.patch.object(api.prefs, 'save') as save, \
                 mock.patch.object(Migration, 'sync_preview', return_value={'deleted': [], 'library_token': token}), \
                 mock.patch.object(Migration, 'start', return_value={'state': 'running'}) as start:
                api.post(app, '/api/zotero/sync-preview', {'path': str(folder)})
                self.assertEqual(save.call_args.args[0]['import']['zotero_sync']['path'], str(folder))
                with self.assertRaisesRegex(ValueError, '文獻庫已變更'):
                    api.post(app, '/api/zotero/sync', {'path': str(folder), 'library_token': 'old'})
                start.assert_not_called()
                result = api.post(app, '/api/zotero/sync', {'path': str(folder), 'library_token': token, 'selected': []})
                self.assertEqual(result['state'], 'running')
                self.assertEqual(start.call_args.kwargs['library_token'], token)

    def test_sync_errors_support_english(self):
        with mock.patch('easyread.i18n.lang', return_value='en'), \
             mock.patch.object(api.prefs, 'load', return_value={}):
            with self.assertRaisesRegex(ValueError, 'Set up the Zotero folder first'):
                api.post(SimpleNamespace(), '/api/zotero/sync', {})
            with tempfile.TemporaryDirectory() as tmp:
                lib = Library(Path(tmp) / 'library')
                migration = Migration(SimpleNamespace(lib=lib, jobs=object()))
                with self.assertRaisesRegex(ValueError, 'Invalid sync selection'):
                    migration.start('zotero', tmp, sync=True, selected=['invalid'])

    def test_rejects_invalid_selection_before_reading_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Library(Path(tmp) / 'library')
            migration = Migration(SimpleNamespace(lib=lib, jobs=object()))
            with mock.patch('easyread.bulk.runner.read') as read:
                with self.assertRaises(ValueError):
                    migration.start('zotero', tmp, sync=True, selected=['invalid'])
                read.assert_not_called()


if __name__ == '__main__':
    unittest.main()
