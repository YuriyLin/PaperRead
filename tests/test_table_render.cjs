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

test("tables render as full HTML tables with alignment, indentation, sublines, and notes", () => {
  const html = render([
    {
      id: "tab1",
      type: "table",
      page: 1,
      align: "lr",
      head: ["Method", "Score"],
      rows: [
        ["Baseline", "0.80"],
        ["  + Ours", "0.92\n(+0.12)"],
        ["Note: bold indicates best.", ""],
      ],
      caption_zh: "表 1：結果",
    },
    { id: "p1", type: "para", page: 1, zh: "AFTER_TABLE" },
  ]);
  assert.match(html, /<table class="tbl">/);
  assert.match(html, /<th[^>]*>Method<\/th>/);
  assert.match(html, /<td[^>]*style="text-align:right">0\.80<\/td>/);
  assert.match(html, /\u00a0\u00a0\+ Ours/);
  assert.match(html, /<span class="sub">\(&#43;0\.12\)|<span class="sub">\(\+0\.12\)/);
  assert.match(html, /class="caption table-note"/);
  assert.match(html, /表 1<\/span>：結果/);
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

function figureReader(block, edits = {}, pages = []) {
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits }, paper: { meta: { pages }, blocks: [block] } },
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

test('figure with src renders cropped image and cropped zoom button without image translation', () => {
  const { PR, html } = figureReader({ id: 'fig1', type: 'figure', page: 2, src: 'figures/a.webp', image_en: 'Accuracy', image_zh: '準確率', caption_en: 'Figure 1' });
  assert.match(html, /<img src="\/p\/test\/figures\/a\.webp"/);
  assert.match(html, /data-zoom-src="\/p\/test\/figures\/a\.webp"/);
  assert.doesNotMatch(html, /figure-translation/);
  assert.doesNotMatch(html, /Accuracy/);
  assert.deepEqual(Array.from(PR.blockKeys(PR.blockById.fig1)), ['fig1#caption']);
  assert.equal(PR.hasZh(PR.blockById.fig1), false);
});

test('figure without src falls back to page button', () => {
  const { html } = figureReader({ id: 'fig1', type: 'figure', page: 2, caption_zh: 'caption' });
  assert.match(html, /fig-missing/);
  assert.match(html, /data-zoom-page="2"/);
  assert.doesNotMatch(html, /figure-translation/);
});

test('single-column cropped figure uses 3x native width so CSS max-width fills reading column', () => {
  const { html } = figureReader(
    { id: 'fig2', type: 'figure', page: 3, src: 'figures/b.webp', abox: [0.5174, 0.0816, 0.9059, 0.265] },
    {},
    [{ n: 3, w: 612, h: 792 }]
  );
  assert.match(html, /style="width:713px"/);
});

test('very tall narrow figure caps height while staying at least print width', () => {
  const { html } = figureReader(
    { id: 'fig_tall', type: 'figure', page: 1, src: 'figures/tall.webp', abox: [0.1, 0.05, 0.35, 0.80] },
    {},
    [{ n: 1, w: 612, h: 792 }]
  );
  // minW = 0.25 * 612 * 4/3 = 204, 3x width = 459, 3x height = 1782 -> capped at 720 * (459/1782) = 185 -> clamped up to minW 204
  assert.match(html, /style="width:204px"/);
});


