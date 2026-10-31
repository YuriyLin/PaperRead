const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function setupContext() {
  const toasts = [];
  const notifications = [];
  const topbarButton = {
    classList: {
      classes: new Set(),
      toggle(cls, val) {
        if (val) this.classes.add(cls);
        else this.classes.delete(cls);
      },
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); },
    }
  };

  const panelListeners = {};
  const panelElement = {
    innerHTML: "",
    contains() { return false; },
    addEventListener(type, fn) { panelListeners[type] = fn; },
    querySelector() { return null; }
  };

  const PR = {
    state: {
      reader: { paper_note: { body: "" } },
      paper: { meta: { title_zh: "注意力機制論文", title_en: "Attention Is All You Need" }, blocks: [] },
      discussion: { entries: [] }
    },
    pid: "test-paper",
    token: "mock-token",
    store: { mode: "server" },
    icon() { return ""; },
    paperNoteEditor: {
      html() { return ""; },
      destroy() {},
      mount() {},
      getBody: () => "",
      setBody() {},
      focus() {}
    },
    side: null,
    t(key) { return key; },
    esc(s) { return String(s || ""); },
    plain(s) { return String(s || ""); },
    myNotes() { return []; },
    feature() { return true; },
    canChat() { return true; },
    openSide(s) { PR.side = s; },
    toast(msg, action) { toasts.push({ msg, action }); },
    commit(op) { if (op.op === "paper_note") PR.state.reader.paper_note.body = op.body; },
    debounce(fn) {
      const f = (...args) => fn(...args);
      f.flush = () => {};
      f.cancel = () => {};
      return f;
    },
    ls: { get(k, def) { return def; }, set() {} },
    $: s => {
      if (s === '#bar [data-act="notes"]' || s === '[data-act="notes"]') return topbarButton;
      if (s === "#notespanel") return panelElement;
      if (s === "#notespanel .np-ai") return { scrollIntoView() {} };
      if (s === "#paperNote") return null;
      return null;
    },
    $$: () => [],
    autosize: () => {},
    errorText(e) { return String(e && e.message || e); },
    mdBlocks(t) { return t; },
  };

  class MockNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notifications.push(this);
    }
    close() {}
  }
  MockNotification.permission = "granted";

  const context = {
    window: {
      PR,
      Notification: MockNotification,
      addEventListener() {},
      removeEventListener() {},
      focus() {}
    },
    document: {
      hidden: false,
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    },
    Notification: MockNotification,
    location: { search: "" }, URLSearchParams,
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
  };

  // Run notespanel.js
  const npCode = fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/notespanel.js"), "utf8");
  vm.runInNewContext(npCode, context);

  // Run notehelp.js
  const nhCode = fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/notehelp.js"), "utf8");
  vm.runInNewContext(nhCode, context);

  return { PR, toasts, notifications, topbarButton, panelListeners, context };
}

test("openPaperNotes switches tab to paper and ensures notes panel is open", () => {
  const { PR } = setupContext();
  assert.equal(PR.side, null);
  PR.openPaperNotes();
  assert.equal(PR.side, "notes");
  assert.equal(PR.notesPanelOpen(), true);
});

test("when notehelp finishes, toast is displayed with action callback to view notes", async () => {
  const env = setupContext();
  const { PR, toasts, topbarButton, panelListeners, context } = env;

  // Mock fetch response for notehelp
  context.fetch = async () => {
    return {
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              const text = '{"t": "# 讀書筆記草稿\\n- 核心問題"}\n{"done": true}\n';
              return { done: false, value: new TextEncoder().encode(text) };
            }
          };
        }
      }
    };
  };

  const fakeEvent = {
    target: {
      closest(sel) {
        if (sel === "[data-nh]") return { dataset: { nh: "draft" } };
        return null;
      }
    }
  };

  assert.ok(panelListeners.click, "click listener should be attached to #notespanel");
  await panelListeners.click(fakeEvent);

  // Assert topbar indicator was cleared after finish
  assert.equal(topbarButton.classList.contains("is-running"), false);

  // Assert toast was called with completion message
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, "AI 筆記起草已完成");
  assert.ok(toasts[0].action, "should have action button");
  assert.equal(toasts[0].action.label, "查看結果");

  // Clicking the action should open paper notes
  PR.side = null;
  toasts[0].action.fn();
  assert.equal(PR.side, "notes");
});

test("when document is hidden and notehelp completes, desktop notification is sent", async () => {
  const env = setupContext();
  const { PR, toasts, notifications, panelListeners, context } = env;

  // Set document hidden
  context.document.hidden = true;

  context.fetch = async () => {
    return {
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              const text = '{"t": "點評內容"}\n';
              return { done: false, value: new TextEncoder().encode(text) };
            }
          };
        }
      }
    };
  };

  await panelListeners.click({
    target: { closest: sel => sel === "[data-nh]" ? { dataset: { nh: "review" } } : null }
  });

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, "AI 筆記點評已完成");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "AI 筆記點評已完成");
  assert.equal(notifications[0].options.body, "注意力機制論文");
});
