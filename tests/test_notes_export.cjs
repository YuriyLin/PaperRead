const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/notespanel.js"), "utf8");

function loadReader({ notes, blocks, entries = [], tables = false }) {
  const noopNode = { addEventListener() {}, classList: { add() {}, remove() {} }, contains() { return false; } };
  const PR = {
    state: { paper: { meta: {}, blocks }, reader: { notes }, discussion: { entries } },
    ls: { get: (_key, fallback) => fallback, set() {} },
    $: () => noopNode,
    $$: () => [],
    on() {},
    t: (text, values) => values ? text.replace(/\{(\w+)\}/g, (_match, key) => values[key]) : text,
    myNotes: () => Object.values(notes).filter((note) => !note.deleted),
    anchorOfEntry: (entry) => entry.anchor || "head",
    order: {},
    blockById: Object.fromEntries(blocks.map((block) => [block.id, block])),
    editOf: () => null,
    plain: (text) => text || "",
    textFor: (id) => PR.blockById[id]?.zh || "",
    esc: (text) => String(text || ""),
    mdBlocks: (text) => text,
    HL_COLORS: [["yellow", "黃"], ["green", "綠"], ["blue", "藍"], ["pink", "紅"]],
    debounce: (fn) => { fn.flush = fn; fn.cancel = () => {}; return fn; },
  };
  if (tables) {
    PR.hashText = () => "source";
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/render.js"), "utf8"), { window: { PR } });
    PR.blockById = Object.fromEntries(blocks.map(b => [b.id, b]));
  }
  vm.runInNewContext(source, { window: { PR }, document: { querySelector() { return noopNode; }, querySelectorAll() { return []; } } });
  return PR;
}

test("export includes Chinese quote for accepted smart highlights and legacy English highlights", () => {
  const blocks = [{
    id: "p1", type: "para", en: "We propose a method. It is fast.", zh: "我們提出一個方法。它很快。",
    sents: [[20, 9], [34, 15]],
  }];
  const PR = loadReader({ blocks, notes: {
    smart: { id: "smart", anchor: "p1", key: "p1", quote: "我們提出一個方法。", side: "zh", kind: "highlight", body: "提出可介接不同前端的解碼器。", ai_generated: true },
    legacy: { id: "legacy", anchor: "p1", key: "p1", quote: "It is fast.", kind: "highlight" },
  } });
  const markdown = PR.notesMarkdown({ paper: false, note: false, highlight: true, question: false, ai: false, chat: false, quote: true }, [], { order: ["highlight"], chat: [] });
  assert.match(markdown, /「我們提出一個方法。」/);
  assert.match(markdown, /「它很快。」/);
  assert.match(markdown, /引用（中文譯文）/);
  assert.match(markdown, /我的注記：\*\* 提出可介接不同前端的解碼器/);
});

test("table Markdown exports bilingual evidence, selected ID and safe literal cell content", () => {
  const block = { id: "tab1", num: "1", type: "table", page: 3, table_schema: 1,
    caption_en: "Table 1: Tests", caption_zh: "表 1：檢定", head_en: [["Variable", "Value"]], head_zh: [["變數", "數值"]],
    rows_en: [["A | B <tag>", "-0.123***\n(0.045)"]], rows_zh: [["甲 | 乙 <tag>", "-0.123***\n(0.045)"]],
    footnotes_en: ["Source: NIST"], footnotes_zh: ["來源：NIST"] };
  const note = { id: "n1", anchor: "tab1", key: "tab1#cell:rows:0:1", quote: "-0.123***", side: "en", table_source: "source", kind: "highlight", body: "檢查標準誤" };
  const PR = loadReader({ blocks: [block], notes: { n1: note }, tables: true });
  PR.pid = "paper-test";
  const pick = { highlight: true, quote: true };
  const text = PR.notesMarkdown(pick, [], { order: ["highlight"], chat: [] });
  for (const token of ["tab1#cell:rows:0:1", "Variable", "變數", "-0.123***<br>(0.045)", "Source: NIST", "&#124;", "&lt;tag&gt;", "easyread://open?id=paper-test&block=tab1"]) assert.ok(text.includes(token), token);
  assert.equal((text.match(/## 表格/g) || []).length, 1);
  const withoutQuote = PR.notesMarkdown({ ...pick, quote: false }, [], { order: ["highlight"] });
  assert.ok(!withoutQuote.includes("(0.045)"));
  assert.ok(withoutQuote.includes("檢查標準誤"));
  note.table_source = "old";
  assert.match(PR.notesMarkdown(pick, [], { order: ["highlight"] }), /來源已變更/);
  block.rows_en[0][1] = block.rows_zh[0][1] = "$\\begin{aligned}a&=1\\\\b&=2\\end{aligned}$ $|x| < 0.01$";
  const formulas = PR.notesMarkdown(pick, [], { order: ["highlight"] });
  assert.ok(formulas.includes("$\\begin{aligned}a&=1\\\\b&=2\\end{aligned}$"));
  assert.ok(formulas.includes("$\\vert x\\vert  \\lt  0.01$"));
  assert.ok(!formulas.includes("a&amp;="));
});

test("page-side AI explanations do not gain a quote from the export checkbox", () => {
  const PR = loadReader({ blocks: [{ id: "p1", type: "para", en: "Original", zh: "譯文" }], notes: {}, entries: [
    { id: "answer", anchor: "p1", quote: "原文", body: "說明", kind: "reply" },
  ] });
  const markdown = PR.notesMarkdown({ paper: false, note: false, highlight: false, question: false, ai: true, chat: false, quote: true }, [], { order: ["ai"], chat: [] });
  assert.ok(!markdown.includes("「原文」"));
  assert.match(markdown, /說明/);
});
