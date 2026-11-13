const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function render(blocks) {
  const paperEl = { innerHTML: "" };
  const bodyClass = new Set();
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    icon: () => "",
    titleOf: (m) => m.title_en || "",
    state: {
      paper: { meta: { title_en: "Table test", pages: [{ n: 1, img: "pages/page-001.webp" }] }, translation: { done_pages: [1] }, blocks },
      reader: { edits: {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: {},
    },
    $: (sel) => sel === "#paper" ? paperEl : null,
    $$: () => [],
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    md: (s) => String(s == null ? "" : s),
    plain: (s) => String(s == null ? "" : s),
    textFor: (key) => {
      const [id, field] = String(key).split("#");
      const b = blocks.find(x => x.id === id) || {};
      return field === "caption" ? (b.caption_zh || b.caption_en || "") : (b.zh || b.en || "");
    },
    agentText: (key) => PR.textFor(key),
    editOf: () => null,
    isEnKey: () => false,
    hasZh: (b) => !!(b && (b.zh || b.caption_zh)),
    blockKeys: (b) => b.type === "table" || b.type === "figure" ? [b.id + "#caption"] : [b.id],
    imageUrl: (rel) => rel,
    canAsk: () => false,
    store: { mode: "file" },
    usageShort: () => "",
    emit() {},
    on() {},
    fitWide() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), { window: { PR } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/render.js"), "utf8"), {
    window: { PR },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
      getElementById: () => null,
      createElement: () => ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
  });
  PR.renderPaper();
  return paperEl.innerHTML;
}

test("tables keep their caption and become clickable original-page placeholders", () => {
  const html = render([
    { id: "tab1", type: "table", page: 1, head: ["Method", "Score"], rows: [["A", "0.8"]], caption_zh: "表 1：結果" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_TABLE" },
  ]);
  assert.match(html, /class="fig-placeholder table-placeholder" data-t="page"/);
  assert.match(html, /表格保留於原文/);
  assert.match(html, /表格位於原文第 1 頁（點擊查看）/);
  assert.match(html, /表 1<\/span>：結果/);
  assert.doesNotMatch(html, /<table class="tbl"|Method|Score|0\.8/);
  assert.match(html, /AFTER_TABLE/);
});

test("one malformed block does not blank the rest of the reader", () => {
  const html = render([
    { id: "bad", type: "list", page: 1, items: "not-an-array" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_MALFORMED_BLOCK" },
  ]);
  assert.match(html, /AFTER_MALFORMED_BLOCK/);
  assert.match(html, /bad/);
});

function figureReader(block, edits = {}) {
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits }, paper: { blocks: [block] } },
    on() {}, emit() {}, esc: String, md: String, t: s => s, imageUrl: s => '/p/test/' + s, hashText: s => s,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/render.js'), 'utf8'), {
    window: { PR }, document: {
      getElementById: () => node,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
    },
  });
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  return { PR, html };
}

test('read-first figure keeps a clickable original-page placeholder', () => {
  const { PR, html } = figureReader({ id: 'fig1', type: 'figure', src: 'figures/a.webp', image_en: 'Accuracy', caption_en: 'Figure 1' });
  assert.match(html, /class="fig-placeholder"/);
  assert.match(html, /圖表保留於原文/);
  assert.doesNotMatch(html, /src="/);
  assert.doesNotMatch(html, /Accuracy/);
  assert.equal(PR.hasZh(PR.blockById.fig1), false);
});

test('translated figure does not render image text or reader edits', () => {
  const { PR, html } = figureReader({ id: 'fig1', type: 'figure', image_en: 'Accuracy', image_zh: 'translated', caption_en: 'Figure 1' }, {
    'fig1#image': { zh: 'my wording', base: 'old translation' },
  });
  assert.match(html, /class="fig-placeholder"/);
  assert.doesNotMatch(html, /Accuracy|translated|my wording|stale-tag/);
  assert.deepEqual(Array.from(PR.blockKeys(PR.blockById.fig1)), ['fig1#caption']);
});

test('legacy figure without image text retains its page placeholder', () => {
  const { html } = figureReader({ id: 'fig1', type: 'figure', page: 2, caption_zh: 'caption' });
  assert.match(html, /fig-placeholder/);
  assert.match(html, /第 \{n\} 頁/);
  assert.doesNotMatch(html, /figure-translation/);
});

