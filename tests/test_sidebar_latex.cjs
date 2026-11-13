const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function source(rel) {
  return fs.readFileSync(path.join(__dirname, "../easyread/web/js", rel), "utf8");
}

function setupSidebarTest() {
  const listeners = new Map();
  const nodes = new Map();
  const getNode = (sel) => {
    if (!nodes.has(sel)) {
      nodes.set(sel, {
        innerHTML: "",
        value: "",
        style: { setProperty() {}, getPropertyValue() { return "248px"; } },
        dataset: {},
        contains() { return false; },
        matches() { return false; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(name, fn) { listeners.set(name, fn); },
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        appendChild() {},
        setAttribute() {},
        getAttribute() { return null; },
      });
    }
    return nodes.get(sel);
  };

  const sideNode = getNode("#side");
  const vendorKatex = require(path.join(__dirname, "../easyread/web/vendor/katex/katex.min.js"));

  const PR = {
    t: (s) => s,
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    icon: (name) => `<svg class="i i-${name}"></svg>`,
    relTime: () => "刚刚",
    lang: "en",
    $: (sel) => getNode(sel),
    $$: () => [],
    el: (tag, attrs = {}) => ({ tag, ...attrs, addEventListener() {} }),
    ls: { get: (k, fallback) => fallback, set() {} },
    lib: {
      items: [],
      cats: () => [],
      isOpen: () => true,
      selected: null,
      view: "all",
      tag: null,
      side: { pinned: [], hidden: [] },
      VIEWS: [["all", "All"]],
      inCat: () => false,
      renderSide: null,
    }
  };

  const documentMock = {
    createElement: (tag) => getNode(tag),
    querySelector: (sel) => getNode(sel),
    querySelectorAll: () => [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener() {},
    body: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    activeElement: { matches() { return false; } }
  };

  const context = {
    PR,
    katex: vendorKatex,
    window: { PR, katex: vendorKatex, addEventListener() {} },
    document: documentMock,
    location: { href: "" },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
  };

  vm.runInNewContext(source("common/util.js"), context);
  vm.runInNewContext(source("common/markup.js"), context);
  vm.runInNewContext(source("library/cat-tree.js"), context);
  vm.runInNewContext(source("library/sidebar.js"), context);
  vm.runInNewContext(source("library/sidebar-tree.js"), context);

  return { PR, node: sideNode };
}

test("sidebar Recent and Pinned render LaTeX titles with KaTeX in English interface", () => {
  const { PR, node } = setupSidebarTest();
  PR.lang = "en";

  const p1 = {
    id: "p-vlm",
    title_en: "X$^2$-VLM: All-In-One Pre-trained Model for Vision-Language Tasks",
    title_zh: "X^2-VLM 统一视觉语言模型",
    target: "zh",
    last_opened: "2026-10-28T01:00:00Z",
    added: "2026-10-28T00:00:00Z",
    archived: false,
    progress: 0.5
  };

  PR.lib.items = [p1];
  PR.renderSide();

  // 1. Check HTML output contains KaTeX markup inside .srow.paper
  assert.ok(node.innerHTML.includes('class="katex"'), "Sidebar should contain rendered KaTeX class");
  assert.ok(node.innerHTML.includes('<annotation encoding="application/x-tex">^2</annotation>'), "KaTeX should format superscript 2");
  assert.ok(node.innerHTML.includes('-VLM</span>'), "Surrounding text -VLM should remain intact");

  // 2. Check title hover attribute does not contain raw $ or HTML tags
  assert.ok(node.innerHTML.includes('title="X^2-VLM: All-In-One Pre-trained Model for Vision-Language Tasks'), "Tooltip title should use clean titleText");
  assert.ok(!node.innerHTML.includes('title="X$^2$'), "Tooltip title should not contain raw $ tags");
});

test("sidebar catTree leafRow renders LaTeX titles with KaTeX", () => {
  const { PR } = setupSidebarTest();
  PR.lang = "en";

  const p1 = {
    id: "p-math",
    title_en: "Attention $O(N^2)$: Quadratic Cost",
    title_zh: "注意力机制",
    target: "zh",
    tags: ["NLP"],
    archived: false
  };

  PR.lib.items = [p1];
  PR.catTree = {
    rows: (cats, items) => [{ type: "paper", item: items[0], depth: 1 }]
  };

  const html = PR.sideTreeHtml(["NLP"], {
    catRow: () => "",
    addRow: () => "",
    skip: () => false,
  });

  assert.ok(html.includes('class="katex"'), "Folder leafRow should contain KaTeX markup");
  assert.ok(html.includes('<annotation encoding="application/x-tex">O(N^2)</annotation>'), "KaTeX should format O(N^2)");
  assert.ok(html.includes('title="Attention O(N^2): Quadratic Cost"'), "Tooltip title should have clean titleText");
});

function makeMockElement() {
  return {
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    setAttribute: () => {},
    style: {}
  };
}

test('PR.deriveShortTitle correctly derives short titles from long or structured titles', () => {
  const utilCode = fs.readFileSync(path.join(__dirname, '../easyread/web/js/common/util.js'), 'utf8');
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

  // 2. Question mark splitting (user scenario)
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
  assert.equal(res.short, 'VLMs 諂媚現象研究');
});

test('reader header H1 supports editing and saveMetaTitle updates meta, document.title, and bar-title', async () => {
  const utilCode = fs.readFileSync(path.join(__dirname, '../easyread/web/js/common/util.js'), 'utf8');
  const editorCode = fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/editor.js'), 'utf8');

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
