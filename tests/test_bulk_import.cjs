const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = file => fs.readFileSync(path.join(__dirname, "../easyread/web/js/", file), "utf8");

test("pickFolder uses desktop picker when in Electron", async () => {
  const PR = {};
  const context = {
    window: {
      PR,
      easyreadDesktop: {
        pickFolder: async () => "/selected/desktop/folder",
      },
    },
  };
  vm.runInNewContext(source("common/pick-folder.js"), context);

  assert.equal(typeof PR.pickFolder, "function");
  const result = await PR.pickFolder({ title: "选择文件夹" });
  assert.equal(result, "/selected/desktop/folder");
});

test("pickFolder calls backend /api/library/pick-folder in browser mode", async () => {
  const calls = [];
  const PR = {
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (url === "/api/library/pick-folder") {
        return { supported: true, path: "/selected/browser/folder" };
      }
      return {};
    },
    t: s => s,
  };
  const context = {
    window: { PR },
  };
  vm.runInNewContext(source("common/pick-folder.js"), context);

  const result = await PR.pickFolder({ title: "选择文件夹" });
  assert.equal(result, "/selected/browser/folder");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/library/pick-folder");
  assert.equal(calls[0].opts.body.title, "选择文件夹");
});

test("pickFolder falls back to promptText if system picker not supported", async () => {
  let promptArgs = null;
  const PR = {
    api: async () => ({ supported: false }),
    promptText: async (args) => {
      promptArgs = args;
      return "/manually/entered/folder";
    },
    t: s => s,
  };
  const context = {
    window: { PR },
  };
  vm.runInNewContext(source("common/pick-folder.js"), context);

  const result = await PR.pickFolder({ title: "输入文件夹" });
  assert.equal(result, "/manually/entered/folder");
  assert.equal(promptArgs.title, "输入文件夹");
});

test("openFolderImport launches folder pick and scans selected directory", async () => {
  const dlg = {
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    querySelector: () => ({ innerHTML: "" }),
    addEventListener: () => {},
  };
  const apiCalls = [];
  const PR = {
    $: (sel) => sel === "#bulkDlg" ? dlg : { addEventListener: () => {} },
    esc: s => s,
    t: s => s,
    pickFolder: async () => "/user/papers/folder",
    api: async (url, opts) => {
      apiCalls.push({ url, opts });
      if (url === "/api/migrate/status") return { state: "idle" };
      if (url === "/api/migrate/scan") return { path: "/user/papers/folder", with_pdf: 12, collections: 2 };
      return {};
    },
    lib: { useServerSide: () => {}, load: () => {} },
  };

  const context = {
    window: { PR },
    document: { addEventListener: () => {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
  };
  vm.runInNewContext(source("library/bulk-import.js"), context);

  assert.equal(typeof PR.openFolderImport, "function");
  await PR.openFolderImport();

  assert.ok(apiCalls.some(c => c.url === "/api/migrate/scan" && c.opts.body.path === "/user/papers/folder"));
});

test("Zotero sync asks which deleted papers to reimport", async () => {
  const handlers = {}, calls = [], selected = [{ dataset: { syncId: "a".repeat(64) } }];
  const box = { innerHTML: "", querySelectorAll: () => selected };
  let open = false;
  const dlg = {
    classList: { add() { open = true; }, remove() { open = false; }, contains() { return open; } },
    querySelector: () => box,
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const PR = {
    $: () => dlg, esc: s => String(s), t: s => s, toast() {},
    lib: { useServerSide() {}, load() {} }, loadPrefs: async () => ({}),
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (url === "/api/migrate/status") return { state: "idle" };
      if (url === "/api/zotero/sync-config") return { config: { path: "/zotero" } };
      if (url === "/api/zotero/sync-preview") return { deleted: [{ sha256: "a".repeat(64), title: "Previously deleted" }], library_token: "library" };
      if (url === "/api/zotero/sync") return { state: "running" };
      return {};
    },
  };
  vm.runInNewContext(source("library/bulk-import.js"), { window: { PR }, setTimeout() {}, clearTimeout() {} });
  await PR.openZoteroSync();
  assert.match(box.innerHTML, /Previously deleted/);
  assert.equal(calls.some(x => x.url === "/api/zotero/sync"), false);
  const button = { disabled: false, dataset: { z: "sync-start" } };
  await handlers.click({ target: { closest: () => button } });
  const request = calls.find(x => x.url === "/api/zotero/sync");
  assert.equal(request.opts.body.library_token, "library");
  assert.deepEqual(Array.from(request.opts.body.selected), ["a".repeat(64)]);
});

test("Zotero sync setup, review and results use English translations", async () => {
  const dictionary = JSON.parse(fs.readFileSync(path.join(__dirname, "../easyread/web/i18n/en.json"), "utf8"));
  const handlers = {}, calls = [], box = { innerHTML: "", querySelectorAll: () => [] };
  let open = false, started = false;
  const dlg = {
    classList: { add() { open = true; }, remove() { open = false; }, contains() { return open; } },
    querySelector: () => box,
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const PR = {
    $: () => dlg, esc: s => String(s), t: (s, vars) => (dictionary[s] || s).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? ""), toast() {},
    lib: { useServerSide() {}, load() {} }, loadPrefs: async () => ({}),
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (url === "/api/migrate/status") return started ? { state: "done", source: "zotero", sync: true, imported: 1, existing: 1, skipped: [], failed: [] } : { state: "idle" };
      if (url === "/api/zotero/detect") return { candidates: [{ path: "/zotero", base: "" }] };
      if (url === "/api/zotero/sync-config") return { config: { path: "/zotero" } };
      if (url === "/api/zotero/sync-preview") return { deleted: [{ sha256: "a".repeat(64), title: "Previously deleted" }], library_token: "library" };
      if (url === "/api/zotero/sync") { started = true; return { state: "running", source: "zotero", sync: true }; }
      return {};
    },
  };
  vm.runInNewContext(source("library/bulk-import.js"), { window: { PR }, setTimeout() {}, clearTimeout() {} });
  await PR.openZotero(true);
  assert.match(box.innerHTML, /Sync Zotero/);
  assert.match(box.innerHTML, /Linked attachment base folder/);
  assert.match(box.innerHTML, /Only new PDFs are imported/);
  assert.doesNotMatch(box.innerHTML, /[\u3400-\u9fff]/);
  await PR.openZoteroSync();
  assert.match(box.innerHTML, /These papers were previously deleted/);
  assert.match(box.innerHTML, /Start sync/);
  assert.doesNotMatch(box.innerHTML, /[\u3400-\u9fff]/);
  const button = { disabled: false, dataset: { z: "sync-start" } };
  await handlers.click({ target: { closest: () => button } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(box.innerHTML, /Sync complete/);
  assert.match(box.innerHTML, /already present, skipped/);
  assert.doesNotMatch(box.innerHTML, /[\u3400-\u9fff]/);
});
