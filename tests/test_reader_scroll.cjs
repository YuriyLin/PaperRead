const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("store.poll skips remote emit when reader is skipped due to local outbox and preserves item on 404", async () => {
  let remoteEmitted = 0;
  let fetchCalls = [];
  const PR = {
    pid: "p1",
    t: (s) => s,
    ls: { get: () => [{ op: "progress", block: "p1-1" }], set() {} },
    emit(ev) { if (ev === "remote") remoteEmitted++; },
    on() {},
    nowIso: () => "2026-11-16T00:00:00Z",
    uid: () => "id1",
  };
  const fetch = async (url) => {
    fetchCalls.push(url);
    if (url.endsWith("/state")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "t1",
          paper: { meta: {}, blocks: [] },
          discussion: { entries: [] },
          reader: { edits: {}, notes: {}, rev: 1 },
          layout: {},
          item: { meta_override: { title_zh: "KeepMe" } },
          job: {},
          versions: { paper: "v1", discussion: "v1", layout: "v1", reader: "r1", job: "j1", item: "i1" },
          engine: "openai",
        }),
      };
    }
    if (url.endsWith("/versions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ paper: "v1", discussion: "v1", layout: "v1", reader: "r2", job: "j1", item: "i2" }),
      };
    }
    if (url.endsWith("/part/item")) {
      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }
    return { ok: true, status: 200, json: async () => ({ version: "x", data: {} }) };
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/store.js"), "utf8"), {
    window: { PR, addEventListener() {} },
    document: { hidden: false, addEventListener() {}, getElementById: () => null },
    location: { pathname: "/read/p1" },
    navigator: { onLine: true },
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  await PR.load();
  await PR.poll();
  assert.equal(remoteEmitted, 0);
  assert.equal(PR.state.item.meta_override.title_zh, "KeepMe");
  assert.equal(PR.state.versions.item, "i1");
  assert.ok(fetchCalls.some((u) => u.endsWith("/part/item")));
});

test("rerenderKeepingPlace preserves block measured height and show-en class", () => {
  const mkNode = (id, height, clsList = []) => {
    const cls = new Set(clsList);
    return {
      dataset: { id },
      offsetHeight: height,
      style: {},
      classList: {
        contains: (c) => cls.has(c),
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (f ? cls.add(c) : cls.delete(c))),
      },
      getBoundingClientRect: () => ({ top: 120 }),
    };
  };
  let nodes = [mkNode("p1-1", 420, ["show-en", "current"])];
  let scrolledBy = null;
  const paperEl = { innerHTML: "", lang: "" };
  const PR = {
    t: (s) => s,
    icon: () => "",
    titleOf: (m) => m.title_en || "",
    readingBlock: () => "p1-1",
    state: {
      paper: { meta: { title_en: "T", pages: [{ n: 1, img: "p1.webp" }] }, translation: { done_pages: [1] }, blocks: [{ id: "p1-1", type: "para", page: 1, en: "Hi", zh: "你好" }] },
      reader: { edits: {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: {},
    },
    $: (sel) => (sel === "#paper" ? paperEl : null),
    $$: (sel) => (sel === "#paper > .blk[data-id]" ? nodes : []),
    esc: String,
    md: String,
    plain: String,
    textFor: () => "你好",
    agentText: () => "你好",
    editOf: () => null,
    isEnKey: () => false,
    hasZh: () => true,
    blockKeys: (b) => [b.id],
    imageUrl: (r) => r,
    canAsk: () => false,
    store: { mode: "file" },
    usageShort: () => "",
    buildCiteIndex() {},
    emit() {},
    on() {},
    fitWide() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/render.js"), "utf8"), {
    window: { PR, scrollBy: (x, y) => { scrolledBy = [x, y]; } },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
      getElementById: (id) => (id === "b-p1-1" ? nodes[0] : null),
      createElement: () => ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
  });

  const origRenderPaper = PR.renderPaper;
  PR.renderPaper = function () {
    origRenderPaper();
    nodes = [mkNode("p1-1", 0, [])];
  };
  PR.rerenderKeepingPlace();
  assert.equal(nodes[0].style.containIntrinsicSize, "auto 420px");
  assert.equal(nodes[0].classList.contains("show-en"), true);
  assert.equal(nodes[0].classList.contains("current"), true);
  assert.deepEqual(scrolledBy, [0, 0]);
});
