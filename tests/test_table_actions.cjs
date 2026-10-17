const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

function reader(fail = false, pages = "9") {
  const clicks = [], requests = [], toasts = [];
  let polls = 0;
  const PR = {
    pid: "mock-paper", state: { paper: { meta: {} }, reader: { notes: { n1: { body: "My note" } } } },
    blockById: {}, t: s => s, esc: String, on() {}, $() { return null; },
    throttle: fn => fn,
    toast: t => toasts.push(t), poll: () => polls++,
    promptText: async () => pages,
    api: async (url, request) => { requests.push({ url, request }); if (fail) throw Error("Mock failure"); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../easyread/web/js/reader/actions.js"), "utf8"), {
    window: { PR, addEventListener() {} }, document: { addEventListener: (name, handler) => { if (name === "click") clicks.push(handler); } },
    getSelection: () => ({ toString: () => "" }),
  });
  return { PR, requests, toasts, polls: () => polls, click() {
    const button = { dataset: { t: "translate-tables" }, closest: s => s === "#paper" ? {} : null };
    const target = { closest(s) { return s === "[data-t]" ? button : s.includes("#margin") ? {} : null; } };
    for (const handler of clicks) handler({ target });
  } };
}

test("table-only click posts only the explicit table task and preserves local reader state", async () => {
  const r = reader(), before = JSON.stringify(r.PR.state);
  r.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].url, "/api/p/mock-paper/translate");
  assert.deepEqual(JSON.parse(JSON.stringify(r.requests[0].request)), { method: "POST", body: { tables_only: true, pages: "9" } });
  assert.equal(r.polls(), 1);
  assert.equal(JSON.stringify(r.PR.state), before);
});

test("table-only queue errors are shown without retrying or submitting a body translation", async () => {
  const r = reader(true);
  r.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.requests.length, 1);
  assert.equal(r.polls(), 0);
  assert.deepEqual(r.toasts, ["Mock failure"]);
});

test("cancelled or empty table page selection never submits an all-pages task", async () => {
  for (const pages of [null, "", "   "]) {
    const r = reader(false, pages);
    r.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.requests.length, 0);
    assert.equal(r.polls(), 0);
  }
});
