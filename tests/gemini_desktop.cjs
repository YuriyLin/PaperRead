// Source Electron + isolated backend + real reader. Only the Python fixture uses
// model transport, patched to a fake HTTP response before any request is made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const fixture = JSON.parse(execFileSync(path.join(ROOT, '.venv/Scripts/python.exe'),
    [path.join(ROOT, 'tests/gemini_desktop_fixture.py')], { cwd: ROOT, encoding: 'utf8', windowsHide: true }));
  assert.ok(path.resolve(fixture.profile).startsWith(path.join(ROOT, '.paperread-local-test', 'gemini-desktop-smoke-')));
  const output = path.join(fixture.profile, 'verification'); fs.mkdirSync(output);
  const paperPath = path.join(fixture.profile, 'library', fixture.paper, 'paper.json');
  const before = fs.readFileSync(paperPath, 'utf8');
  assert.equal(JSON.parse(before).meta.validation_evidence.transport, 'mock');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const checks = [], errors = [], httpRequests = [];
  let origin, child, connection, sequence = 0, pending = new Map();
  const env = { ...process.env, PAPERREAD_TEST_PROFILE: fixture.profile, PAPERREAD_REVIEW_MODE: 'Mock',
    PAPERREAD_REVIEW_KIND: 'GeminiResults', PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); connection.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP timed out: ' + method)); }, 15000).unref();
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const ready = async () => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate('!!(window.PR?.state?.paper && document.querySelector(".table-pair"))')) return;
      await delay(100);
    }
    throw Error('Reader did not become ready');
  };
  const ok = (condition, label) => { assert.ok(condition, label); checks.push(label); };
  try {
    child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [ROOT,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
      { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let target;
    for (let i = 0; i < 200; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        target = list.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
        if (target) break;
      } catch (_) {}
      await delay(100);
    }
    ok(!!target, 'isolated Electron renderer starts');
    origin = new URL(target.url).origin;
    const library = await (await fetch(origin + '/api/library')).json();
    ok(library.items.some(p => p.id === fixture.paper), 'backend uses fresh synthetic validation library');
    connection = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { connection.onopen = resolve; connection.onerror = reject; });
    connection.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      if (message.method === 'Network.requestWillBeSent') httpRequests.push(message.params.request.url);
      if (message.id) { const task = pending.get(message.id); pending.delete(message.id);
        if (task) message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); }
    };
    await call('Runtime.enable'); await call('Network.enable');
    await call('Page.navigate', { url: origin + '/read/' + fixture.paper });
    await delay(250); await ready();
    const identity = await evaluate('({engine:PR.state.engine,source:PR.state.paper.meta.validation_source,status:PR.state.paper.blocks[0].table_status})');
    ok(identity.engine === 'none', 'result viewer keeps no live translation engine');
    ok(identity.source.test_pdf_page === 1 && identity.source.original_paper_page === 9, 'test and original page numbers stay separate');
    ok(identity.status === 'ready', 'validated bilingual native table block is ready');
    await evaluate('window.validationNodes=[document.querySelector("[data-table-side=en]"),document.querySelector("[data-table-side=zh]")]');
    for (const [name, action, expected] of [
      ['original', "PR.setView('original')", 'en'], ['translation', "PR.setView('translation')", 'zh'],
      ['english-first', "PR.setBiOrder('original')", 'en,zh'], ['chinese-first', "PR.setBiOrder('translation')", 'zh,en']]) {
      await evaluate(action);
      const state = await evaluate(`({order:[...document.querySelector('.table-pair').children].filter(e=>!e.hidden).map(e=>e.dataset.tableSide).join(','),
        same:validationNodes[0]===document.querySelector('[data-table-side=en]')&&validationNodes[1]===document.querySelector('[data-table-side=zh]'),
        en:document.querySelector('[data-table-side=en]').textContent,zh:document.querySelector('[data-table-side=zh]').textContent})`);
      ok(state.order === expected && state.same, name + ' uses existing complete DOM');
      ok(state.en.includes('-0.50') && state.zh.includes('-0.50') && state.en.includes('0.045') && state.zh.includes('0.045'), name + ' preserves numbers');
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
    }
    const statuses = await evaluate(`(async()=>{const r=[];for(const url of ['/api/p/${fixture.paper}/translate','/api/config','/api/import','/api/research/vault']){
      const response=await fetch(url,{method:'POST',headers:{'X-Token':PR.token,'Content-Type':'application/json'},body:'{}'});r.push(response.status)}return r})()`);
    ok(statuses.every(s => s === 403), 'model, settings, import and Vault POST routes are blocked: ' + statuses.join(','));
    await evaluate('PR.flushPending()'); await delay(400);
    await call('Page.reload', { ignoreCache: true }); await delay(250); await ready();
    ok(await evaluate('!!document.querySelector("[data-table-side=zh] .table-cell-text")'), 'renderer reload reads saved Chinese table');
    await call('Page.navigate', { url: origin + '/' }); await delay(200);
    await call('Page.navigate', { url: origin + '/read/' + fixture.paper }); await delay(250); await ready();
    ok(await evaluate('PR.state.paper.blocks[0].table_cache.validation.http_attempts===1'), 'reopening reads durable translation cache');
    ok(fs.readFileSync(paperPath, 'utf8') === before, 'mode switches and reopening preserve paper and cache bytes');
    ok(httpRequests.every(url => !/^https?:/.test(url) || url.startsWith(origin + '/')), 'renderer only uses isolated loopback backend');
    ok(errors.length === 0, 'no renderer exceptions');
    const summary = { checks: checks.length, failures: 0, checksPassed: checks, output, profile: fixture.profile };
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    if (origin) {
      try { const state = await (await fetch(origin + '/api/library')).json();
        await fetch(origin + '/api/shutdown', { method: 'POST', headers: { 'X-Token': state.token }, body: '{}' }); } catch (_) {}
    }
    if (connection) connection.close();
    if (child) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
