const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Minimal DOM surfaces, as in the other reader tests. Real mode/ordering and
// caption lookup functions run unchanged; moving nodes preserves their identity.
function node(classes = "", dataset = {}) {
  const names = new Set(classes.split(" ").filter(Boolean));
  return {
    dataset, children: [], parentElement: null, hidden: false, style: {},
    classList: { contains: (c) => names.has(c), add: (c) => names.add(c), toggle(c, on) { if (on) names.add(c); else names.delete(c); } },
    append(child) { child.parentElement = this; this.children.push(child); },
    get nextElementSibling() { return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null; },
    before(other) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(other), 1);
      siblings.splice(siblings.indexOf(this), 0, other);
    },
    after(other) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(other), 1);
      siblings.splice(siblings.indexOf(this) + 1, 0, other);
    },
    addEventListener() {},
    closest(selector) { return selector === ".table-pair" ? this.pair || null : null; },
  };
}

function reader(reading = false) {
  const pair = node("table-pair"), zh = node("table-version", { tableSide: "zh" }), en = node("table-version", { tableSide: "en" });
  const originalCaption = node("en", { tableCaption: "true" }), translatedCaption = node("zh", { tableCaption: "true", key: "tab1#caption" });
  originalCaption.pair = translatedCaption.pair = pair;
  originalCaption.parentElement = node("caption"); originalCaption.parentElement.append(originalCaption);
  translatedCaption.parentElement = node("caption"); translatedCaption.parentElement.append(translatedCaption);
  pair.append(zh); pair.append(en);
  en.content = { head: "Variable", rows: "Treatment 0.123*** (0.045)", notes: "Standard errors" };
  zh.content = { head: "變數", rows: "處理 0.123*** (0.045)", notes: "標準誤" };
  if (reading) {
    pair.classList.add("table-reading-pair");
    en.content = { pdfEntry: true };
    zh.content = { paragraphs: ["FIRST", "SECOND"], pdfEntry: true };
  }
  pair.querySelector = (s) => ({ '[data-table-side="en"]': en, '[data-table-side="zh"]': zh, '.zh[data-key]': translatedCaption, '.en[data-table-caption]': originalCaption })[s] || null;
  const menu = node(), body = node(); body.append = () => {};
  let calls = 0;
  const forbidden = () => { calls++; throw new Error("No translation, API or rerender is allowed during a mode switch"); };
  const PR = {
    prefs: { mode: "zh", lead: "translation", biOrder: "translation" },
    state: { paper: { meta: { target: "zh-TW" } }, item: {}, reader: { progress: { block: "tab1", ratio: 0.5 }, notes: { n1: { key: "tab1#caption", quote: "迴歸" } } } },
    t: (s) => s, targetName: (s) => s, esc: String, el: () => menu,
    on() {}, $: () => null,
    $$: (s) => s === "#paper .table-pair" ? [pair] : s === "#paper .en" ? [originalCaption] : [],
    setPref(k, value) { this.prefs[k] = value; body.classList.toggle("mode-bi", this.prefs.mode === "bi"); this.applyReadingLanguage(); },
    api: forbidden, renderPaper: forbidden,
  };
  const context = { window: { PR }, document: { body, addEventListener() {} }, fetch: forbidden };
  for (const script of ["reading-language.js", "sentences.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/" + script), "utf8"), context);
  }
  const visible = () => pair.children.filter((n) => !n.hidden).map((n) => n.dataset.tableSide);
  return { PR, pair, en, zh, visible, originalCaption, translatedCaption, calls: () => calls };
}

test("the existing reading controls show complete tables in all four modes", () => {
  const r = reader(), before = JSON.stringify(r.PR.state);
  const source = r.en, translation = r.zh, contents = [r.en.content, r.zh.content];
  for (let i = 0; i < 3; i++) {
    r.PR.setView("original"); assert.deepEqual(r.visible(), ["en"]);
    r.PR.setView("translation"); assert.deepEqual(r.visible(), ["zh"]);
    r.PR.setBiOrder("original"); assert.deepEqual(r.visible(), ["en", "zh"]);
    r.PR.setBiOrder("translation"); assert.deepEqual(r.visible(), ["zh", "en"]);
  }
  assert.equal(r.en, source); assert.equal(r.zh, translation);
  assert.equal(r.en.content, contents[0]); assert.equal(r.zh.content, contents[1]);
  assert.equal(JSON.stringify(r.PR.state), before);
  assert.equal(r.calls(), 0);
});

test("reading fallback uses all four existing modes without translating or changing source order", () => {
  const r = reader(true), content = r.zh.content, before = JSON.stringify(r.PR.state);
  for (let i = 0; i < 3; i++) {
    r.PR.setView("original"); assert.deepEqual(r.visible(), ["en"]);
    r.PR.setView("translation"); assert.deepEqual(r.visible(), ["zh"]);
    r.PR.setBiOrder("original"); assert.deepEqual(r.visible(), ["en", "zh"]);
    r.PR.setBiOrder("translation"); assert.deepEqual(r.visible(), ["zh", "en"]);
  }
  assert.equal(r.zh.content, content);
  assert.deepEqual(content.paragraphs, ["FIRST", "SECOND"]);
  assert.equal(r.en.content.pdfEntry, true);
  assert.equal(content.pdfEntry, true);
  assert.equal(JSON.stringify(r.PR.state), before);
  assert.equal(r.calls(), 0);
});

test("single language and bilingual order preferences remain independent", () => {
  const r = reader();
  r.PR.setBiOrder("original");
  r.PR.setView("translation");
  assert.equal(r.PR.prefs.biOrder, "original");
  r.PR.setView("both"); assert.deepEqual(r.visible(), ["en", "zh"]);
  assert.equal(r.PR.prefs.lead, "translation");
  r.PR.applyReadingLanguage(); assert.deepEqual(r.visible(), ["en", "zh"]);
});

test("caption notes retain their original key and language pairing after whole tables move", () => {
  const r = reader();
  for (const order of ["original", "translation"]) {
    r.PR.setBiOrder(order);
    assert.equal(r.PR.zhOfEl(r.originalCaption), r.translatedCaption);
    assert.equal(r.PR.enOfZh(r.translatedCaption), r.originalCaption);
    assert.equal(r.PR.noteEl(r.translatedCaption, "en"), r.originalCaption);
    assert.equal(r.PR.noteEl(r.translatedCaption, "zh"), r.translatedCaption);
    assert.equal(r.translatedCaption.dataset.key, "tab1#caption");
  }
});

test("the existing per-block original expansion reveals the other complete version", () => {
  const r = reader();
  r.PR.setView("translation");
  r.pair.closest = (s) => s === ".show-en" ? {} : null;
  r.PR.applyTableReadingLanguage(); assert.deepEqual(r.visible(), ["zh", "en"]);
  assert.equal(r.PR.readingView(), "translation");
  r.pair.closest = () => null;
  r.PR.applyTableReadingLanguage(); assert.deepEqual(r.visible(), ["zh"]);
  assert.equal(r.calls(), 0);
});
