const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function setup() {
  const calls = [];
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../easyread/web/i18n/en.json"), "utf8"));
  const PR = { target: "zh", esc: String, toast() {},
    t: (s, args = {}) => (en[s] || s).replace(/\{(\w+)\}/g, (_, k) => args[k]),
    api: async (url, opts) => calls.push({ url, ...opts }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/page-cap.js"), "utf8"), { window: { PR } });
  const job = { state: "confirm", total: 80, page_cap: 30, scope: "body", read: true, model: { kind: "codex", model: "chosen" }, target: "ja",
    pages: Array.from({ length: 80 }, (_, i) => i + 1), cap_check: true };
  const button = (action) => ({ dataset: { pageCap: action }, closest: () => ({ querySelectorAll: () => [] }) });
  return { PR, calls, job, button };
}

test("both confirmation surfaces use translated labels with the original task limit", () => {
  const { PR, job } = setup();
  const html = PR.pageCapHtml(job);
  assert.equal((html.match(/data-page-cap=/g) || []).length, 3);
  assert.match(html, /30/);
  assert.doesNotMatch(html, /[一-鿿]/);
  assert.equal(PR.pageCapHtml({ state: "done" }), "");
});

test("confirm-all keeps scope, reading mode, model and target", async () => {
  const { PR, job, button, calls } = setup();
  let refreshed = 0;
  await PR.handlePageCap(button("all"), "paper1", job, async () => refreshed++);
  assert.equal(calls[0].body.scope, "body");
  assert.equal(calls[0].body.confirmed, true);
  assert.equal(calls[0].body.read, true);
  assert.equal(calls[0].body.model, job.model);
  assert.equal(calls[0].body.target, "ja");
  assert.equal(refreshed, 1);
});

test("first-pages submits a range and deferring only calls cancel", async () => {
  const { PR, job, button, calls } = setup();
  await PR.handlePageCap(button("first"), "paper1", job, async () => {});
  assert.equal(calls[0].body.scope, "range:1-30");
  assert.equal(calls[0].body.confirmed, undefined);
  await PR.handlePageCap(button("skip"), "paper1", job, async () => {});
  assert.equal(calls[1].url, "/api/p/paper1/cancel");
  assert.equal(Object.keys(calls[1].body).length, 0);
});

test("shared confirmation hides first-pages when the frozen plan has no pages before the limit", async () => {
  const { PR, job, button, calls } = setup();
  job.pages = Array.from({ length: 80 }, (_, i) => i + 31);
  for (const read of [true, false]) {
    job.read = read;
    const html = PR.pageCapHtml(job);
    assert.match(html, /data-page-cap="all"/);
    assert.match(html, /data-page-cap="skip"/);
    assert.doesNotMatch(html, /data-page-cap="first"/);
  }
  await PR.handlePageCap(button("first"), "paper1", job, async () => {});
  assert.equal(calls.length, 0);
});

test("page limit options include a translated page unit and keep numeric values", () => {
  const PR = {
    settingsTabs: {}, esc: String, icon: () => "", $: () => ({ addEventListener() {} }),
    t: (key, args = {}) => key === "{n} 页" ? args.n + " pages" : key,
    opt: (items, selected) => items.map(([value, label]) => '<option value="' + value + '"' +
      (value === selected ? " selected" : "") + '>' + label + '</option>').join(""),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/settings-chat.js"), "utf8"), { window: { PR } });
  const state = { pinned: true, transChecked: true, cfg: { engine: "claude", claude: {}, page_cap: 60 }, chat: { models: [] } };
  const html = PR.settingsTabs.chat.render(state);
  const options = html.match(/data-k="page_cap">([\s\S]*?)<\/select>/)[1];
  for (const limit of [30, 60, 100, 200]) {
    assert.match(options, new RegExp('value="' + limit + '"(?: selected)?>' + limit + ' pages<'));
  }
  assert.match(options, /value="60" selected/);
  assert.match(options, /value="0">/);
});
