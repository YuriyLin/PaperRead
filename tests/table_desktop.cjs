// Actual Electron renderer + local backend smoke test. No Playwright or model.
// First prepare_table_review.py, then start_table_review.ps1 -DebugPort 9339.
// Run: node tests/table_desktop.cjs. Requires Node >=22 (built-in WebSocket).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.paperread-local-test', 'desktop-review');
const OUTPUT = path.join(PROFILE, 'verification');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9339/json/list')).json();
  const pages = targets.filter(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
  assert.equal(pages.length, 1, 'Exactly one test renderer');
  const origin = new URL(pages[0].url).origin;
  const library = await (await fetch(origin + '/api/library')).json();
  assert.ok(JSON.stringify(library).includes('PaperRead Table Review (Mock)'), 'Explicit mock library required');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); if (message.error) p.reject(new Error(p.method + ': ' + message.error.message)); else p.resolve(message.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('Timed out: ' + method)); }, 15000).unref();
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await evaluate('window.PR?.flushPending ? PR.flushPending() : Promise.resolve()');
    await call('Page.navigate', { url: origin + '/read/table-review?review=' + Date.now() });
    await delay(750);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      await delay(100);
      ready = await evaluate('!!(window.PR?.state?.paper && document.querySelector(".table-cell-text.zh"))');
      if (ready) break;
    }
    assert.ok(ready, 'Reader rendered');
    const paperPath = path.join(PROFILE, 'library', 'table-review', 'paper.json');
    const before = fs.readFileSync(paperPath);
    const checks = await evaluate(`(async () => {
      const checks = [], wait = ms => new Promise(r => setTimeout(r, ms));
      const ok = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
      ok(PR.pid === 'table-review' && PR.state.engine === 'none', 'isolated mock paper and offline engine');
      const uid = PR.uid; let noteSeq = 0;
      PR.uid = prefix => prefix === 'n' ? 'desktop-smoke-' + (++noteSeq) : uid(prefix);
      const en = document.querySelector('[data-table-side="en"]'), zh = document.querySelector('[data-table-side="zh"]');
      const visible = () => [...document.querySelector('.table-pair').children].filter(x => !x.hidden).map(x => x.dataset.tableSide).join(',');
      const modes = [() => PR.setView('original'), () => PR.setView('translation'), () => PR.setBiOrder('original'), () => PR.setBiOrder('translation')];
      const expected = ['en', 'zh', 'en,zh', 'zh,en'];
      for (let repeat = 0; repeat < 3; repeat++) for (let i = 0; i < modes.length; i++) {
        modes[i](); ok(visible() === expected[i] && document.querySelector('[data-table-side="en"]') === en && document.querySelector('[data-table-side="zh"]') === zh, 'mode ' + expected[i] + ' pass ' + repeat);
      }
      const cell = (side, slot) => document.querySelector('[data-table-side="' + side + '"] [data-cell-id="tab1#cell:' + slot + '"]');
      const select = async (first, last = first) => {
        getSelection().removeAllRanges();
        const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.childNodes.length);
        getSelection().addRange(range); first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await wait(30);
        return PR.readSelection();
      };
      PR.setView('translation');
      let selected = await select(cell('zh', 'rows:0:1'));
      ok(selected.key === 'tab1#cell:rows:0:1' && selected.table_source === PR.tableSource(PR.blockById.tab1), 'Chinese cell selection retains exact ID and source');
      PR.selectionAction('highlight', 'blue');
      const highlight = PR.myNotes().at(-1);
      ok(highlight.key === selected.key && !!document.querySelector('mark[data-note="' + highlight.id + '"]'), 'cell highlight rendered');
      ok(PR.state.reader.notes[cell('en', 'rows:0:1').dataset.mirror]?.key === highlight.key, 'highlight mirrors only to matching English cell');
      selected = await select(cell('zh', 'rows:0:1'), cell('zh', 'rows:0:2'));
      ok(selected.parts?.length === 2 && selected.parts.every(p => p.table_source), 'multiple cells retain separate addresses');
      PR.selectionAction('note');
      const note = PR.myNotes().at(-1), textarea = document.querySelector('.card[data-note="' + note.id + '"] textarea');
      ok(!!textarea, 'multi-cell annotation editor opens'); textarea.value = 'Desktop mock note'; PR.closeNoteEditor();
      ok(PR.state.reader.notes[note.id].body === 'Desktop mock note', 'annotation editor saves');
      PR.setView('original'); PR.prefs.pen = 'underline';
      await select(cell('en', 'rows:1:0')); PR.selectionAction('highlight', 'green');
      const underline = PR.myNotes().at(-1);
      ok(underline.side === 'en' && underline.style === 'underline' && !!cell('en', 'rows:1:0').querySelector('mark.s-ul'), 'English cell underline retains side');
      PR.setView('translation'); PR.prefs.pen = 'marker';
      const key = 'tab1#cell:rows:1:0', source = PR.tableSource(PR.blockById.tab1);
      const target = cell('zh', 'rows:1:0'); target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const editor = target.querySelector('textarea'); ok(!!editor, 'double-click opens Chinese cell editor');
      editor.value = '桌面修訂控制組'; target.querySelector('[data-e="save"]').click();
      ok(PR.state.reader.edits[key]?.zh === '桌面修訂控制組' && PR.state.reader.edits[key].table_source === source, 'cell edit saved separately with source fingerprint');
      ok(cell('en', 'rows:1:0').textContent === 'Control', 'English cell remains unchanged');
      PR.editZh(cell('en', 'rows:1:0'));
      ok(!cell('en', 'rows:1:0').querySelector('textarea'), 'English cell cannot be edited');
      const oldEnglish = PR.blockById.tab1.rows_en[1][0];
      PR.blockById.tab1.rows_en[1][0] = 'Changed source'; PR.renderBlock('tab1'); PR.applyMarks('tab1');
      ok(PR.quoteLost(underline.id) && !cell('en', 'rows:1:0').querySelector('mark.hl'), 'changed source does not relocate old underline');
      ok(PR.textFor(key) !== '桌面修訂控制組' && PR.isStale(key), 'changed source retains personal edit as stale without applying it');
      PR.blockById.tab1.rows_en[1][0] = oldEnglish; PR.renderBlock('tab1'); PR.applyMarks('tab1');
      const openPage = PR.openPage; let located;
      PR.openPage = (...args) => { located = args; return openPage(...args); };
      PR.openTableCell(key, source); await wait(200);
      ok(located[2]?.box?.length === 4 && document.querySelector('.pv-hl.on'), 'original PDF cell navigation persists after panel layout');
      PR.openTableCell(key, 'stale'); ok(located[2] === false, 'stale source uses page-only PDF fallback'); PR.openPage = openPage;
      PR.openSide(null);
      PR.blockById.tab1.table_status = 'fallback'; PR.renderBlock('tab1');
      ok(!document.querySelector('#b-tab1 table.tbl') && document.querySelector('#b-tab1 .table-placeholder'), 'unreliable table displays PDF fallback instead of a matrix');
      PR.blockById.tab1.table_status = 'ready'; PR.renderBlock('tab1'); PR.applyMarks('tab1');
      const originalFetch = window.fetch; let request;
      window.fetch = async (url, options) => {
        if (String(url).endsWith('/chat') && options?.method === 'POST') {
          request = JSON.parse(options.body);
          return new Response(JSON.stringify({t:'Mock table explanation'}) + '\\n' + JSON.stringify({done:true,id:'mock-answer'}) + '\\n');
        }
        return originalFetch(url, options);
      };
      PR.chatAsk({ anchor: 'tab1', key, quote: 'Control', side: 'en', table_source: source, text: 'Explain this cell (Mock)' });
      for (let i = 0; i < 50 && !request; i++) await wait(50);
      window.fetch = originalFetch;
      ok(request?.refs?.[0]?.key === key && request.refs[0].side === 'en' && request.refs[0].table_source === source, 'Ask AI request preserves cell evidence through mock streaming transport');
      PR.openSide(null);
      const pick = {note:true,highlight:true,question:true,quote:true};
      const markdown = PR.notesMarkdown(pick, [], {order:['note','highlight'],chat:[]});
      ok(markdown.includes('tab1#cell:rows:0:1') && markdown.includes('Desktop mock note') && markdown.includes('桌面修訂控制組') && markdown.includes('World Bank'), 'Markdown contains bilingual table, annotations, edits and source');
      const documents = [{id:'paper:table-review:annotations',kind:'annotations',paper_id:'table-review',title:'Table desktop review',body:markdown}];
      const exported = await PR.api('/api/research/v2/export/obsidian', {method:'POST',body:{documents}});
      const repeated = await PR.api('/api/research/v2/export/obsidian', {method:'POST',body:{documents}});
      ok(!exported.conflicts.length && repeated.updated.length === 1, 'isolated Vault export is repeatable');
      ok(await PR.flushPending(), 'reader changes persisted to isolated backend');
      PR.setBiOrder('translation');
      window.__desktopReview = {checks, key, source, note:note.id, highlight:highlight.id, underline:underline.id};
      return checks;
    })()`);
    assert.deepEqual(fs.readFileSync(paperPath), before, 'All interactions preserve source paper bytes');
    checks.push('source paper bytes unchanged');
    const saved = JSON.parse(fs.readFileSync(path.join(PROFILE, 'library', 'table-review', 'reader.json')));
    assert.equal(saved.edits['tab1#cell:rows:1:0'].zh, '桌面修訂控制組');
    checks.push('reader edit verified on disk');
    const vault = path.join(PROFILE, 'vault', 'Research', '03-閱讀標註', 'Table desktop review.md');
    assert.ok(fs.readFileSync(vault, 'utf8').includes('tab1#cell:rows:0:1'));
    checks.push('Vault Markdown verified on disk');
    fs.mkdirSync(OUTPUT, { recursive: true });
    const screenshot = async name => {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUTPUT, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    for (const [name, action] of [['original', "PR.setView('original')"], ['translation', "PR.setView('translation')"], ['english-first', "PR.setBiOrder('original')"], ['chinese-first', "PR.setBiOrder('translation')"]]) {
      await evaluate(action); await delay(200);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), name + ' page does not overflow');
      checks.push(name + ' desktop layout contains horizontal overflow');
      await screenshot(name);
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(300);
    assert.ok(await evaluate('innerWidth <= 720 && document.documentElement.scrollWidth <= innerWidth'), 'Narrow desktop layout contains table overflow');
    checks.push('narrow desktop table layout'); await screenshot('narrow-desktop');
    await call('Emulation.clearDeviceMetricsOverride');
    await call('Page.reload'); await delay(1000);
    assert.equal(await evaluate('PR.textFor("tab1#cell:rows:1:0")'), '桌面修訂控制組');
    checks.push('edit survives actual renderer reload');
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(OUTPUT, 'summary.json'), JSON.stringify({checks:checks.length,passed:checks,errors}, null, 2));
    console.log(JSON.stringify({checks:checks.length,errors,output:OUTPUT}));
  } finally { ws.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
