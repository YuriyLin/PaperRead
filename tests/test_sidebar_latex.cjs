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
