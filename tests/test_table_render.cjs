const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function render(blocks, options = {}) {
  let markup = "", readingNodes = [];
  const paperEl = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      readingNodes = [...value.matchAll(/class="table-reading-text" data-reading-block="([^"]+)"/g)].map((m) => ({
        dataset: { readingBlock: m[1] }, children: [],
        replaceChildren() { this.children = []; },
        appendChild(child) { this.children.push(child); },
      }));
    },
  };
  const bodyClass = new Set();
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    titleOf: (m) => m.title_en || "",
    state: {
      paper: { meta: { title_en: "Table test", pages: [{ n: 1, img: "pages/page-001.webp" }] }, translation: { done_pages: [1] }, blocks },
      reader: { edits: options.edits || {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: options.job || {},
    },
    $: (sel) => sel === "#paper" ? paperEl : null,
    $$: (sel, scope) => sel === ".table-reading-text" ? scope?.readingNodes || readingNodes : [],
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    md: (s) => PR.esc(s),
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
    canAsk: () => options.canAsk === true,
    store: { mode: "file" },
    usageShort: () => "",
    emit() {},
    on() {},
    fitWide() {},
    hashText: (text) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16); },
  };
  const context = {
    window: { PR },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle: (key, on) => on ? bodyClass.add(key) : bodyClass.delete(key) } },
      getElementById: (id) => options.nodes?.[id] || null,
      createElement: (tag) => tag === "div" && options.createDiv ? options.createDiv() : tag === "p" ? {
        textContent: "",
        set innerHTML(value) { throw new Error("Model text must use textContent"); },
      } : ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
    katex: require("../easyread/web/vendor/katex/katex.min.js"), URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/render.js"), "utf8"), context);
  PR.renderPaper();
  return options.inspect ? { html: paperEl.innerHTML, PR, bodyClass, readingNodes: () => readingNodes, currentHtml: () => markup } : paperEl.innerHTML;
}

function bilingual(overrides = {}) {
  return {
    id: "tab1", type: "table", page: 1, table_schema: 1, align: "lrr",
    head: [["LEGACY_HEADER"]], rows: [["LEGACY_BODY"]],
    head_en: [["Variable", "Estimate", "p value"]],
    rows_en: [["Treatment", "0.123***\n(0.045)", "0.007"]],
    head_zh: [["變數", "估計值", "p 值"]],
    rows_zh: [["處理", "0.123***\n(0.045)", "0.007"]],
    footnotes_en: ["Standard errors in parentheses."],
    footnotes_zh: ["括號內為標準誤。"],
    caption_en: "Regression results", caption_zh: "迴歸分析結果",
    ...overrides,
  };
}

function reading(overrides = {}) {
  return {
    id: "read1", type: "table", page: 1, table_status: "fallback", caption_pos: "above",
    caption_en: "Table 1: Statistics", caption_zh: "Statistics translation",
    table_reading: { version: 1, source: { segments: [{ id: "s-one" }, { id: "s-two" }] } },
    table_reading_zh: [{ id: "s-one", zh: "FIRST" }, { id: "s-two", zh: "SECOND" }],
    ...overrides,
  };
}

test("reading fallback uses whole language sides and safe ordered text nodes without cells", () => {
  const b = reading(), before = JSON.stringify(b), r = render([b], { inspect: true });
  assert.match(r.html, /table-pair table-reading-pair/);
  assert.match(r.html, /data-table-side="en"/);
  assert.match(r.html, /data-table-side="zh"/);
  assert.equal((r.html.match(/class="fig-placeholder table-placeholder"/g) || []).length, 1);
  assert.match(r.html, /class="btn sm line table-pdf-check" data-t="page"/);
  assert.match(r.html, /閱讀輔助翻譯，非逐格驗證表格/);
  assert.deepEqual(r.readingNodes()[0].children.map((p) => p.textContent), ["FIRST", "SECOND"]);
  assert.doesNotMatch(r.html, /FIRST|SECOND|data-cell-id|#cell:|<table/);
  assert.equal(r.PR.tableCell("read1#cell:rows:0:0"), null);
  assert.equal(r.PR.hasZh(b), true);
  assert.equal(JSON.stringify(b), before);
});

test("verified inline PDF preview and large PDF placeholder are mutually exclusive", () => {
  const r = render([reading({ table_reading_preview: "data:image/webp;base64,UklGRg==" })]);
  assert.match(r, /class="table-source-preview" data-t="page"/);
  assert.match(r, /<img src="data:image\/webp;base64,UklGRg=="/);
  assert.doesNotMatch(r, /table-placeholder/);
  assert.match(r, /table-pdf-check/);
  for (const src of [undefined, '', 'javascript:alert(1)', 'https://example.com/stale.webp', 'data:image/svg+xml;base64,AAAA']) {
    const fallback = render([reading({ table_reading_preview: src })]);
    assert.doesNotMatch(fallback, /<img/);
    assert.equal((fallback.match(/class="fig-placeholder table-placeholder"/g) || []).length, 1);
    assert.match(fallback, /table-pdf-check/);
  }
});

test("paper redraw replaces preview and fallback without stale media", () => {
  const b = reading(), r = render([b], { inspect: true });
  for (let i = 0; i < 2; i++) {
    b.table_reading_preview = "data:image/webp;base64,UklGRg==";
    r.PR.renderPaper();
    assert.equal((r.currentHtml().match(/class="table-source-preview"/g) || []).length, 1);
    assert.doesNotMatch(r.currentHtml(), /table-placeholder/);
    delete b.table_reading_preview;
    r.PR.renderPaper();
    assert.doesNotMatch(r.currentHtml(), /table-source-preview/);
    assert.equal((r.currentHtml().match(/class="fig-placeholder table-placeholder"/g) || []).length, 1);
  }
});

test("all four reading modes keep actual preview/fallback markup exclusive and ordered", () => {
  for (const preview of [undefined, "data:image/webp;base64,UklGRg=="]) {
    const html = render([reading({ table_reading_preview: preview })]);
    const enStart = html.indexOf('data-table-side="en"');
    const zhStart = html.indexOf('data-table-side="zh"');
    const pair = { children: [], closest: () => null };
    const side = (name, content) => ({
      content, hidden: false,
      get nextElementSibling() { return pair.children[pair.children.indexOf(this) + 1]; },
      before(other) { pair.children.splice(pair.children.indexOf(other), 1); pair.children.splice(pair.children.indexOf(this), 0, other); },
      after(other) { pair.children.splice(pair.children.indexOf(other), 1); pair.children.splice(pair.children.indexOf(this) + 1, 0, other); },
      name,
    });
    const en = side("en", html.slice(enStart, zhStart)), zh = side("zh", html.slice(zhStart));
    pair.children = [en, zh];
    pair.querySelector = (s) => s.includes('"en"') ? en : zh;
    const PR = { state: {}, on() {}, el: () => ({ addEventListener() {} }),
      $$: () => [pair], prefs: { mode: "zh", lead: "translation", biOrder: "translation" } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/reading-language.js"), "utf8"), {
      window: { PR }, document: { body: { append() {} }, addEventListener() {} },
    });
    for (let i = 0; i < 2; i++) {
      for (const [mode, first, expected] of [
        ["zh", "translation", ["zh"]], ["bi", "translation", ["zh", "en"]],
        ["bi", "original", ["en", "zh"]], ["zh", "original", ["en"]],
      ]) {
        Object.assign(PR.prefs, { mode, lead: first, biOrder: first });
        PR.applyTableReadingLanguage();
        assert.deepEqual(pair.children.filter(n => !n.hidden).map(n => n.name), expected);
        const visible = pair.children.filter(n => !n.hidden).map(n => n.content).join("");
        assert.equal((visible.match(/table-placeholder/g) || []).length, !preview && expected.includes("en") ? 1 : 0);
        assert.equal((visible.match(/class="table-source-preview"/g) || []).length, preview && expected.includes("en") ? 1 : 0);
        assert.equal(visible.includes("table-pdf-check"), expected.includes("zh"));
      }
    }
  }
});

test("reading model HTML remains literal text and never enters markup", () => {
  const attack = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  const b = reading(); b.table_reading_zh[0].zh = attack;
  const r = render([b], { inspect: true });
  assert.equal(r.readingNodes()[0].children[0].textContent, attack);
  assert.doesNotMatch(r.html, /onerror|<script>|alert\(1\)/);
});

test("missing, malformed and backend-revoked reading results retain PDF fallback", () => {
  for (const change of [{ table_reading: undefined }, { table_reading_zh: undefined },
    { table_reading_zh: [] }, { table_reading_zh: [{ id: "wrong", zh: "BAD" }] },
    { table_reading_zh: [{ id: "s-one", zh: "" }, { id: "s-two", zh: "SECOND" }] }]) {
    const r = render([reading(change)], { inspect: true });
    assert.doesNotMatch(r.html, /table-reading-pair|<table/);
    assert.equal(r.readingNodes().length, 0);
    assert.match(r.html, /table-placeholder/);
  }
});

test("paper reload removes revoked reading nodes rather than reusing old Chinese", () => {
  const b = reading(), r = render([b], { inspect: true });
  assert.equal(r.readingNodes().length, 1);
  delete b.table_reading; delete b.table_reading_zh;
  r.PR.renderPaper();
  assert.equal(r.readingNodes().length, 0);
  assert.doesNotMatch(r.currentHtml(), /table-reading-pair|FIRST|SECOND/);
});

test("ready structured tables keep cell UI even if optional reading data exists", () => {
  const r = render([bilingual({ ...reading(), id: "tab1", table_status: "ready" })], { inspect: true });
  assert.match(r.html, /<table class="tbl"/);
  assert.match(r.html, /data-cell-id/);
  assert.doesNotMatch(r.html, /table-reading-pair/);
  assert.equal(r.readingNodes().length, 0);
});

test("single block redraw mounts text nodes and drops revoked content", () => {
  const nodes = {};
  const blockNode = (markup = "") => ({
    markup,
    classList: { contains: () => false, add() {} }, querySelector: () => null,
    readingNodes: markup.includes('class="table-reading-text"') ? [{
      dataset: { readingBlock: "read1" }, children: [],
      replaceChildren() { this.children = []; }, appendChild(p) { this.children.push(p); },
    }] : [],
    replaceWith(fresh) { nodes['b-read1'] = fresh; },
  });
  nodes['b-read1'] = blockNode();
  const b = reading(), r = render([b], { inspect: true, nodes,
    createDiv: () => ({ set innerHTML(html) { this.firstChild = blockNode(html); } }),
  });
  b.table_reading_zh[0].zh = "UPDATED";
  r.PR.renderBlock("read1");
  assert.equal(nodes['b-read1'].readingNodes[0].children[0].textContent, "UPDATED");
  b.table_reading_preview = "data:image/webp;base64,UklGRg==";
  r.PR.renderBlock("read1");
  assert.match(nodes['b-read1'].markup, /table-source-preview/);
  assert.doesNotMatch(nodes['b-read1'].markup, /table-placeholder/);
  delete b.table_reading_preview;
  r.PR.renderBlock("read1");
  assert.doesNotMatch(nodes['b-read1'].markup, /table-source-preview/);
  assert.equal((nodes['b-read1'].markup.match(/class="fig-placeholder table-placeholder"/g) || []).length, 1);
  delete b.table_reading; delete b.table_reading_zh;
  r.PR.renderBlock("read1");
  assert.equal(nodes['b-read1'].readingNodes.length, 0);
});

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

test("the reader offers an explicit table-only action and disables it during active jobs", () => {
  assert.match(render([bilingual()], { canAsk: true }), /data-t="translate-tables"/);
  for (const state of ["queued", "running", "confirm"]) {
    assert.doesNotMatch(render([bilingual()], { canAsk: true, job: { state } }), /data-t="translate-tables"/);
  }
  assert.doesNotMatch(render([bilingual()]), /data-t="translate-tables"/);
});

test("a verified cached table is immediately readable after reopening without an API call", () => {
  const block = bilingual({ table_status: "ready", table_cache: { source_hash: "mock-source", translation_hash: "mock-translation" } });
  const before = JSON.stringify(block);
  for (let i = 0; i < 3; i++) {
    const html = render([block]);
    assert.match(html, /0\.123/);
    assert.match(html, /data-table-side="en"/);
    assert.match(html, /data-table-side="zh"/);
  }
  assert.equal(JSON.stringify(block), before);
});

test("one malformed block does not blank the rest of the reader", () => {
  const html = render([
    { id: "bad", type: "list", page: 1, items: "not-an-array" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_MALFORMED_BLOCK" },
  ]);
  assert.match(html, /AFTER_MALFORMED_BLOCK/);
  assert.match(html, /bad/);
});

test("explicit bilingual tables render two complete versions without changing legacy data", () => {
  const blocks = [bilingual()];
  const before = JSON.stringify(blocks);
  const html = render(blocks);
  assert.equal((html.match(/<table class="tbl">/g) || []).length, 2);
  const [translated, original] = html.split('data-table-side="en"');
  assert.match(translated, /變數[\s\S]*處理[\s\S]*括號內為標準誤。[\s\S]*迴歸分析結果/);
  assert.match(original, /Variable[\s\S]*Treatment[\s\S]*Standard errors in parentheses\.[\s\S]*Regression results/);
  assert.doesNotMatch(html, /LEGACY_HEADER|LEGACY_BODY|data-view=|data-order=/);
  assert.equal(JSON.stringify(blocks), before);
  assert.match(html, /id="b-tab1" data-id="tab1"/);
  assert.equal((html.match(/data-key="tab1#caption"/g) || []).length, 1);
  assert.equal((html.match(/0\.123\*\*\*/g) || []).length, 2);
  assert.equal((html.match(/\(0\.045\)/g) || []).length, 2);
});

test("descriptive, correlation and hypothesis tables retain their supplied values and dimensions", () => {
  const fixtures = [
    { head_en: [["Measure", "Mean", "SD"]], head_zh: [["指標", "平均數", "標準差"]], rows_en: [["Age", "31.20", "4.50"]], rows_zh: [["年齡", "31.20", "4.50"]] },
    { head_en: [["", "X", "Y"]], head_zh: [["", "X", "Y"]], rows_en: [["X", "1.000", "−0.32**"], ["Y", "−0.32**", "1.000"]], rows_zh: [["X", "1.000", "−0.32**"], ["Y", "−0.32**", "1.000"]] },
    { head_en: [["Test", "Statistic", "p"]], head_zh: [["檢定", "統計量", "p"]], rows_en: [["Welch t", "2.45", "<0.05"]], rows_zh: [["Welch t 檢定", "2.45", "<0.05"]] },
  ];
  for (const fixture of fixtures) {
    const html = render([bilingual(fixture)]);
    assert.equal((html.match(/<tbody>/g) || []).length, 2);
    assert.equal((html.match(/<td /g) || []).length, fixture.rows_en.length * fixture.rows_en[0].length * 2);
    assert.doesNotMatch(html, /table-placeholder/);
  }
});

test("incomplete or mismatched translations keep the full source and an explicit PDF fallback", () => {
  for (const override of [
    { rows_zh: undefined }, { rows_zh: [["wrong column count"]] },
    { footnotes_zh: [] }, { caption_zh: undefined },
  ]) {
    const html = render([bilingual(override)]);
    assert.equal((html.match(/<table class="tbl">/g) || []).length, 1);
    assert.match(html, /Treatment/);
    assert.match(html, /表格譯文尚未完整提供/);
    assert.match(html, /table-placeholder" data-t="page"/);
  }
});

test("unverified, merged and cross-page tables safely retain the existing PDF entry", () => {
  for (const override of [
    { table_schema: undefined }, { table_schema: 2 }, { table_schema: true },
    { rows_en: [["bad dimensions"]] }, { rows_en: [["Treatment", 0.123, "0.007"]] },
    { table_status: "unreliable" },
    { footnotes_en: null }, { table_status: 0 },
    { table_spans: [{ section: "head", row: 0, col: 0, colspan: 3 }] },
    { table_segments: [{ page: 1 }, { page: 2 }] }, { table_spans: "malformed" },
  ]) {
    const html = render([bilingual(override)]);
    assert.doesNotMatch(html, /<table class="tbl">|Treatment/);
    assert.match(html, /table-placeholder" data-t="page"/);
  }
});

test("rectangular multiple header rows render without inferring merged cells", () => {
  const html = render([bilingual({ head_en: [["Model", "Model", "Model"], ["Variable", "Estimate", "p value"]], head_zh: [["模型", "模型", "模型"], ["變數", "估計值", "p 值"]] })]);
  assert.equal((html.match(/<th /g) || []).length, 12);
  assert.doesNotMatch(html, /rowspan=|colspan=/);
});

test("caption edits remain authoritative and table-only translations enable existing mode controls", () => {
  const block = bilingual();
  const result = render([block], { inspect: true, edits: { "tab1#caption": { zh: "我的表題" } } });
  assert.match(result.html, /我的表題/);
  assert.doesNotMatch(result.html, /迴歸分析結果/);
  assert.deepEqual(Array.from(result.PR.blockKeys(block)), ["tab1#caption"]);
  const tableOnly = render([bilingual({ caption_en: "", caption_zh: "" })], { inspect: true });
  assert.equal(tableOnly.PR.hasZh(tableOnly.PR.blockById.tab1), true);
  assert.equal(tableOnly.bodyClass.has("en-only"), false);
});

test("supplied table text and fallback explanations cannot inject HTML", () => {
  const html = render([bilingual({ rows_en: [["<script>bad()</script>", "1", "2"]] })]);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const fallback = render([bilingual({ table_status: "unreliable", table_issue: '<img src=x onerror="bad()">' })]);
  assert.match(fallback, /&lt;img/);
  assert.doesNotMatch(fallback, /<img src=x/);
});

test("table formulas use the existing KaTeX renderer and retain literal variable notation in storage", () => {
  const block = bilingual({ rows_en: [["$\\beta_1$", "$\\begin{aligned}a&=1\\\\\nb&=2\\end{aligned}$", "$p < 0.01$"]], rows_zh: [["$\\beta_1$", "$\\begin{aligned}a&=1\\\\\nb&=2\\end{aligned}$", "$p < 0.01$"]] });
  const before = JSON.stringify(block);
  const html = render([block]);
  assert.match(html, /class="katex"/);
  assert.match(html, /application\/x-tex/);
  assert.doesNotMatch(html, /katex-error/);
  assert.equal(JSON.stringify(block), before);
});

test("both table languages share exact cell IDs including headers and footnotes", () => {
  const { html, PR } = render([bilingual()], { inspect: true });
  for (const key of ["tab1#cell:head:0:0", "tab1#cell:rows:0:0", "tab1#cell:note:0"]) {
    assert.equal(html.split('data-cell-id="' + key + '"').length - 1, 2);
    assert.equal(PR.tableCell(key).key, key);
  }
  for (const key of ["tab1#cell:rows:01:0", "tab1#cell:rows:99:0", "tab1#cell:note:0:0", "tab1#cell:head:0"]) assert.equal(PR.tableCell(key), null);
});

test("cell PDF navigation validates exact geometry and safely falls back to page only", () => {
  const b = bilingual(), { PR } = render([b], { inspect: true });
  const key = "tab1#cell:rows:0:0", calls = [];
  PR.openPage = (...args) => calls.push(args);
  const source = PR.tableSource(b);
  b.table_geometry_source = source;
  const loc = { page: 1, box: [.1, .2, .4, .3] };
  b.table_cell_boxes = { "rows:0:0": loc };
  PR.openTableCell(key, source); assert.equal(calls.at(-1)[2], loc);
  PR.openTableCell(key, "old"); assert.equal(calls.at(-1)[2], false);
  b.table_cell_boxes["rows:0:0"] = { page: 2, box: [.1, .2, .4, .3] };
  PR.openTableCell(key, source); assert.equal(calls.at(-1)[2], false);
  b.table_status = "fallback";
  PR.openTableCell(key, source); assert.equal(calls.at(-1)[2], false);
});

test("reader cell edits remain separate from source and do not attach after source changes", () => {
  const b = bilingual(), key = "tab1#cell:rows:0:0";
  const { PR } = render([b], { inspect: true });
  const source = PR.tableSource(b), before = JSON.stringify(b);
  PR.state.reader.edits[key] = { zh: "個人修訂", base: PR.hashText(PR.agentText(key)), table_source: source };
  assert.equal(PR.textFor(key), "個人修訂");
  assert.equal(PR.isStale(key), false);
  assert.equal(JSON.stringify(b), before);
  b.rows_en[0][0] = "Changed source";
  assert.equal(PR.isStale(key), true);
  assert.equal(PR.textFor(key), b.rows_zh[0][0]);
  assert.equal(PR.editOf(key).zh, "個人修訂");
});

