const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeMockElement() {
  return {
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    setAttribute: () => {},
    style: {}
  };
}

test('PR.deriveShortTitle correctly derives short titles from long or structured titles', () => {
  const utilCode = fs.readFileSync(path.join(__dirname, '../../easyread/web/js/common/util.js'), 'utf8');
  const prObj = { t: (s) => s };
  const sandbox = {
    PR: prObj,
    document: {
      documentElement: { dataset: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      createElement: makeMockElement,
      body: { appendChild: () => {} }
    },
    navigator: {},
    location: { origin: 'http://localhost:8765' },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn) => setTimeout(fn, 10),
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(utilCode, sandbox);
  const PR = sandbox.window.PR;

  // 1. Colon splitting
  assert.equal(PR.deriveShortTitle('直接偏好優化：你的語言模型暗藏獎勵模型', true), '直接偏好優化');
  assert.equal(PR.deriveShortTitle('Direct Preference Optimization: Your Language Model', false), 'Direct Preference Optimization');

  // 2. Question mark splitting (user's scenario)
  assert.equal(PR.deriveShortTitle('視覺語言模型是否失去了信心？VLMs 諂媚現象研究', true), 'VLMs 諂媚現象研究');

  // 3. Short title <= 16 chars without separators stays as-is
  assert.equal(PR.deriveShortTitle('大語言模型對齊研究', true), '大語言模型對齊研究');

  // 4. Over 16 chars without separator is truncated with ellipsis (15 chars + …)
  assert.equal(PR.deriveShortTitle('這是一個非常非常非常非常非常非常非常長的論文大標題', true), '這是一個非常非常非常非常非常非…');

  // 5. PR.titles derives short title when meta_override.title_zh exists but short_zh is old
  const item = {
    title_zh: '視覺語言模型是否失去了信心？VLMs 諂媚現象研究',
    title_en: 'Study on VLMs',
    short_zh: '舊阿諛標題',
    target: 'zh-TW',
    meta_override: {
      title_zh: '視覺語言模型是否失去了信心？VLMs 諂媚現象研究'
    }
  };
  PR.lang = 'zh-TW';
  const res = PR.titles(item);
  assert.equal(res.main, '視覺語言模型是否失去了信心？VLMs 諂媚現象研究');
  assert.equal(res.short, 'VLMs 諂媚現象研究'); // Not '舊阿諛標題'!
});

test('reader header H1 supports editing and saveMetaTitle updates meta, document.title, and bar-title', async () => {
  const utilCode = fs.readFileSync(path.join(__dirname, '../../easyread/web/js/common/util.js'), 'utf8');
  const editorCode = fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/editor.js'), 'utf8');

  let apiCalls = [];
  let broadcastCalls = [];

  class MockBroadcastChannel {
    constructor(name) { this.name = name; }
    postMessage(msg) { broadcastCalls.push(msg); }
    close() {}
  }

  const mockBarTitle = { innerHTML: '' };
  const mockDoc = {
    title: '',
    documentElement: { dataset: {} },
    querySelector: (sel) => {
      if (sel === '.bar-title') return mockBarTitle;
      return null;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: makeMockElement,
    body: { appendChild: () => {} }
  };

  const prObj = {
    t: (s) => s,
    pid: 'p123',
    store: { mode: 'server' },
    state: {
      paper: {
        meta: {
          title_zh: '舊標題：副標題',
          short_zh: '舊短標題'
        }
      },
      item: {
        meta_override: {}
      }
    },
    toast: () => {},
    titleText: (s) => s,
    titleHtml: (s) => s
  };

  const sandbox = {
    PR: prObj,
    document: mockDoc,
    BroadcastChannel: MockBroadcastChannel,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn) => setTimeout(fn, 10),
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(utilCode, sandbox);
  vm.runInContext(editorCode, sandbox);

  const PR = sandbox.window.PR;
  PR.api = async (url, opts) => {
    apiCalls.push({ url, opts, body: opts && opts.body ? opts.body : null });
    return { ok: true };
  };
  PR.updateTitle = function () {
    const m = PR.state.paper.meta || {};
    const titleVal = m.short_zh || m.title_zh || m.title_en || '论文';
    sandbox.document.title = titleVal + ' · PaperRead';
    mockBarTitle.innerHTML = titleVal;
  };

  // Test saving a new title via saveMetaTitle
  await PR.saveMetaTitle('title_zh', '視覺語言模型是否失去了信心？VLMs 諂媚現象研究');

  // Verify S.paper.meta updated
  assert.equal(PR.state.paper.meta.title_zh, '視覺語言模型是否失去了信心？VLMs 諂媚現象研究');
  assert.equal(PR.state.paper.meta.short_zh, 'VLMs 諂媚現象研究');

  // Verify document.title and bar-title updated immediately
  assert.equal(sandbox.document.title, 'VLMs 諂媚現象研究 · PaperRead');
  assert.equal(mockBarTitle.innerHTML, 'VLMs 諂媚現象研究');

  // Verify API call sent
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, '/api/p/p123/item');
  assert.equal(JSON.stringify(apiCalls[0].body.meta_override), JSON.stringify({
    title_zh: '視覺語言模型是否失去了信心？VLMs 諂媚現象研究',
    short_zh: 'VLMs 諂媚現象研究'
  }));

  // Verify BroadcastChannel sent
  assert.equal(broadcastCalls.length, 1);
  assert.equal(broadcastCalls[0].type, 'pr:paper-updated');
  assert.equal(broadcastCalls[0].pid, 'p123');
  assert.equal(broadcastCalls[0].title_zh, '視覺語言模型是否失去了信心？VLMs 諂媚現象研究');
  assert.equal(broadcastCalls[0].short_zh, 'VLMs 諂媚現象研究');
});
