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

test('table renders reparse button when PR.canAsk() is true and omits when false', () => {
  const blocks = [{ id: 'tab1', type: 'table', page: 1, align: 'lr', head: [['A', 'B']], rows: [['1', '2']], caption_zh: '表 1' }];
  assert.doesNotMatch(render(blocks), /tbl-reparse-btn/);
  const { PR, html } = (() => {
    const paperEl = { innerHTML: '' };
    const p = {
      t: s => s, icon: n => `<i data-i="${n}"></i>`, titleOf: m => m.title_en || '',
      state: { paper: { meta: { title_en: 'T', pages: [{ n: 1 }] }, translation: { done_pages: [1] }, blocks }, reader: { edits: {} }, discussion: { entries: [] }, layout: {}, item: {}, job: {} },
      $: sel => sel === '#paper' ? paperEl : null, $$: () => [], esc: String, md: String, plain: String,
      textFor: () => '表 1', agentText: () => '表 1', editOf: () => null, isEnKey: () => false, hasZh: () => true,
      blockKeys: b => [b.id + '#caption'], imageUrl: s => s, canAsk: () => true, pageCapHtml: () => '', store: { mode: 'server' },
      usageShort: () => '', emit() {}, on() {}, fitWide() {},
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/common/markup.js'), 'utf8'), { window: { PR: p } });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/render.js'), 'utf8'), {
      window: { PR: p },
      document: { documentElement: { dataset: {} }, body: { classList: { toggle() {} } }, getElementById: () => null, createElement: () => ({ innerHTML: '', firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }) },
      console,
    });
    p.renderPaper();
    return { PR: p, html: paperEl.innerHTML };
  })();
  assert.match(html, /class="table-media"/);
  assert.match(html, /class="tbl-reparse-btn" data-t="reparse-table"/);
});

test('generic short nouns, formula labels, and data-table row names stay single-line while prose and sublines wrap', () => {
  const proseHtml = render([
    {
      id: 'tab_prose',
      type: 'table',
      page: 1,
      head: [['司法管轄區', '社會法律語境中之定義', '在 AI 治理之應用']],
      rows: [
        ['Singapore', 'Model AI Governance Framework on Agentic AI with long explanation.', 'Human agency and oversight principles.'],
      ],
    },
    {
      id: 'tab_concept',
      type: 'table',
      page: 1,
      head: [['Component', 'Definition', 'Application']],
      rows: [
        ['Relational order', 'The level of society constituted by emergent interactions.', 'Governing the space between human and machine.'],
      ],
    },
    {
      id: 'tab_wide',
      type: 'table',
      page: 1,
      align: 'lrrrrrr',
      head: [['Reward', 'mAP', 'GP', 'GR', 'Cel', 'Logo', 'OVDEval']],
      rows: [
        ['Base 3B', '11.4', '45.33', '31.85', '7.7', '13.8', '21.46'],
        ['$s_{ovd} \\cdot \\mathrm{mAP}$', '21.1', '67.34', '43.84', '55.0', '34.6', '31.01'],
        ['$s_{ovd}$', '0.92\n(+0.12)', '1.0', '1.0', '1.0', '1.0', '1.0'],
      ],
    },
  ]);
  assert.match(proseHtml, /<th class="cell-nowrap">司法管轄區<\/th>/);
  assert.match(proseHtml, /<th>社會法律語境中之定義<\/th>/);
  assert.match(proseHtml, /<td class="cell-nowrap">Singapore<\/td>/);
  assert.match(proseHtml, /<td>Model AI Governance Framework/);
  assert.match(proseHtml, /<td>Relational order<\/td>/);
  assert.match(proseHtml, /<th class="cell-nowrap" style="text-align:left">Reward<\/th>/);
  assert.match(proseHtml, /<th class="cell-nowrap" style="text-align:right">OVDEval<\/th>/);
  assert.match(proseHtml, /<td class="cell-nowrap" style="text-align:left">Base 3B<\/td>/);
  assert.match(proseHtml, /<td class="cell-nowrap" style="text-align:left"><code[^>]*>s_\{ovd\} \\cdot \\mathrm\{mAP\}<\/code><\/td>/);
  assert.match(proseHtml, /<td style="text-align:right">0\.92/);
});

test('multi-group academic tables emit tbl-group row dividers without affecting short tables', () => {
  const shortHtml = render([{
    id: 'tab_short',
    type: 'table',
    page: 1,
    head: [['Method', 'Score']],
    rows: [['Baseline', '80.0'], ['Ours', '90.0']],
  }]);
  assert.doesNotMatch(shortHtml, /tbl-group/);

  const multiGroupHtml = render([{
    id: 'tab_t3',
    type: 'table',
    page: 9,
    head: [['', 'N', 'PPL', 'BLEU']],
    rows: [
      ['base', '6', '4.92', '25.8'],
      ['(A)', '1', '5.29', '24.9'],
      ['', '4', '5.00', '25.5'],
      ['(B)', '16', '5.16', '25.1'],
      ['', '32', '5.01', '25.4'],
      ['big', '6', '4.33', '26.4'],
    ],
  }]);
  assert.match(multiGroupHtml, /<tbody><tr><td[^>]*>base<\/td>.*?<tr class="tbl-group"><td[^>]*>\(A\)<\/td>.*?<tr><td><\/td><td[^>]*>4<\/td>.*?<tr class="tbl-group"><td[^>]*>\(B\)<\/td>.*?<tr><td><\/td><td[^>]*>32<\/td>.*?<tr class="tbl-group"><td[^>]*>big<\/td>/);
});
