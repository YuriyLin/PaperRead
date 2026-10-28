const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { shellUrl } = require('../electron/desktop-tabs.cjs');

test('desktop startup preserves the paper target inside the tab shell', () => {
  const url = new URL(shellUrl('http://127.0.0.1:8765', '/open?id=abc&block=p1'));
  assert.equal(url.pathname, '/web/tabs.html');
  assert.equal(url.searchParams.get('open'), '/open?id=abc&block=p1');
});

test('only same-origin shell children inherit desktop calls, without quit listeners', () => {
  const source = fs.readFileSync(path.join(__dirname, '../easyread/web/js/common/desktop-bridge.js'), 'utf8');
  const pickFolder = () => 'folder';
  for (const origin of ['http://127.0.0.1:8765', 'https://example.com']) {
    const parent = { location: { origin }, easyreadTabs: {}, easyreadDesktop: { pickFolder, onBeforeQuit() {} } };
    const window = { parent };
    vm.runInNewContext(source, { window, location: { origin: 'http://127.0.0.1:8765' } });
    if (origin.startsWith('https:')) assert.equal(window.easyreadDesktop, undefined);
    else {
      assert.equal(window.easyreadDesktop.pickFolder(), 'folder');
      assert.equal(window.easyreadDesktop.onBeforeQuit, undefined);
    }
  }
});

test('preload reports a failed or rejected tab save to the main process', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  let bridge, listener;
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
    ipcRenderer: { on(_name, callback) { listener = callback; }, send(...args) { sent.push(args); }, removeListener() {} },
  };
  vm.runInNewContext(source, { require: () => electron, process: { platform: 'win32' } });
  bridge.onBeforeQuit(async () => [true, false]);
  await listener();
  assert.equal(sent.at(-1)[1].ok, false);
  bridge.onBeforeQuit(async () => { throw new Error('offline'); });
  await listener();
  assert.equal(sent.at(-1)[1].error, 'offline');
  bridge.onBeforeQuit(async () => [true, true]);
  await listener();
  assert.equal(sent.at(-1)[1].ok, true);
});
