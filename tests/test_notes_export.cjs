const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/notespanel.js"), "utf8");
const exportSource = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/export.js"), "utf8");

function loadReader({ notes, blocks, entries = [] }) {
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
  vm.runInNewContext(source, { window: { PR, addEventListener() {} }, document: { addEventListener() {}, querySelector() { return noopNode; }, querySelectorAll() { return []; } }, location: { search: "" }, URLSearchParams });
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

test("page-side AI explanations do not gain a quote from the export checkbox", () => {
  const PR = loadReader({ blocks: [{ id: "p1", type: "para", en: "Original", zh: "譯文" }], notes: {}, entries: [
    { id: "answer", anchor: "p1", quote: "原文", body: "說明", kind: "reply" },
  ] });
  const markdown = PR.notesMarkdown({ paper: false, note: false, highlight: false, question: false, ai: true, chat: false, quote: true }, [], { order: ["ai"], chat: [] });
  assert.ok(!markdown.includes("「原文」"));
  assert.match(markdown, /說明/);
});

function loadExporter({ configured = false, selectedPath = "C:\\Vault", desktop = true, ink = {} } = {}) {
  const requests = [];
  const fields = [{ dataset: { exp: "paper" }, checked: true }];
  const dialogContent = {};
  const dialog = {
    closed: false,
    classList: { add() {}, remove() { dialog.closed = true; } },
    addEventListener(_event, handler) { dialog.click = handler; },
    querySelector() { return dialogContent; },
  };
  const button = {
    disabled: false,
    innerHTML: "匯出至 Obsidian Vault",
    hasAttribute(name) { return name === "data-exp-vault"; },
  };
  const PR = {
    state: { paper: { meta: { title_en: "Paper" }, blocks: [] }, reader: { paper_note: { body: "note" }, notes: {}, ink }, discussion: { entries: [] } },
    ls: { get: (_key, fallback) => fallback, set() {} },
    $: () => dialog,
    $$: () => fields,
    t: (text, values) => values ? text.replace(/\{(\w+)\}/g, (_match, key) => values[key]) : text,
    api: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === "/api/research/v1/status") return { configured };
      if (path === "/api/library/pick-folder") return { path: selectedPath };
      return {};
    },
    notesMarkdown: () => "# Notes",
    pid: "paper-id",
    toast() {},
  };
  const window = { PR, ...(desktop ? { easyreadDesktop: { pickFolder: async () => selectedPath } } : {}) };
  vm.runInNewContext(exportSource, { window });
  return {
    requests,
    button,
    dialog,
    click: () => dialog.click({ target: { closest: (selector) => selector === "[data-exp-vault]" ? button : null } }),
  };
}

test("Obsidian note export prompts for a vault, saves it, then exports", async () => {
  const app = loadExporter();
  await app.click();
  assert.deepEqual(app.requests.map((request) => request.path), [
    "/api/research/v1/status", "/api/research/v1/setup", "/api/research/v2/export/obsidian",
  ]);
  assert.equal(app.requests[1].options.body.vault, "C:\\Vault");
  assert.equal(app.dialog.closed, true);
});

test("canceling vault selection keeps the export dialog usable", async () => {
  const app = loadExporter({ selectedPath: null });
  await app.click();
  assert.deepEqual(app.requests.map((request) => request.path), ["/api/research/v1/status"]);
  assert.equal(app.button.disabled, false);
  assert.equal(app.button.innerHTML, "匯出至 Obsidian Vault");
  assert.equal(app.dialog.closed, false);
});

test("browser note export uses the server folder picker", async () => {
  const app = loadExporter({ desktop: false });
  await app.click();
  assert.deepEqual(app.requests.map((request) => request.path), [
    "/api/research/v1/status", "/api/library/pick-folder", "/api/research/v1/setup", "/api/research/v2/export/obsidian",
  ]);
});

test("configured vault exports without prompting for another folder", async () => {
  const app = loadExporter({ configured: true });
  await app.click();
  assert.deepEqual(app.requests.map((request) => request.path), [
    "/api/research/v1/status", "/api/research/v2/export/obsidian",
  ]);
});

test("Obsidian export warns about handwritten strokes but excludes deleted strokes from the count", async () => {
  const app = loadExporter({ configured: true, ink: {
    one: { id: "one" }, two: { id: "two" }, gone: { id: "gone", deleted: true },
  } });
  await app.click();
  const docs = app.requests.find(request => request.path === "/api/research/v2/export/obsidian").options.body.documents;
  assert.ok(docs.every(doc => doc.body.includes("本次匯出未包含 2 筆手寫註記。")));
});

/* ---------- Paper Notes Saving & Debounce ---------- */
function noteReader() {
  const events = { panel: {}, window: {}, document: {} }, commits = [];
  const textarea = { id: "paperNote", value: "", matches: () => false };
  const panel = { addEventListener: (type, fn) => events.panel[type] = fn };
  const PR = {
    state: { reader: {}, paper: {}, discussion: {} },
    $: s => s === "#paperNote" ? textarea : s === "#notespanel" ? panel : null,
    debounce(fn) { const delayed = () => {}; delayed.flush = fn; delayed.cancel = () => {}; return delayed; },
    ls: { set() {} }, paperNoteEditor: { update() {} },
    commit(op) { commits.push(op); PR.state.reader.paper_note = { body: op.body }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/notespanel.js"), "utf8"), {
    window: { PR, addEventListener: (type, fn) => events.window[type] = fn },
    document: { hidden: true, addEventListener: (type, fn) => events.document[type] = fn },
    location: { search: "" }, URLSearchParams,
  });
  PR.renderNotesPanel = () => {};
  return { PR, events, textarea, commits, input(text) { textarea.value = text; events.panel.input({ target: textarea }); } };
}

test("leaving, hiding and switching panels save the current editor body before the debounce", () => {
  for (const event of ["pagehide", "beforeunload", "visibilitychange", "panel"]) {
    const r = noteReader();
    r.input("# 最新笔记\n- 尚未等待自动保存");
    assert.equal(r.commits.length, 0);
    if (event === "panel") r.PR.finishPanelNote();
    else (r.events.window[event] || r.events.document[event])();
    assert.equal(r.commits.length, 1);
    assert.equal(r.commits[0].body, r.textarea.value);
    r.PR.finishPanelNote();
    assert.equal(r.commits.length, 1);
  }
});

test("export and tab switching flush the latest text synchronously", () => {
  for (const selector of ["[data-np]", "[data-np-act]"]) {
    const r = noteReader();
    let exported;
    r.PR.openExport = () => exported = r.PR.state.reader.paper_note.body;
    r.input("最后一行");
    const button = { dataset: { np: "notes", npAct: "md" } };
    r.events.panel.click({ target: { closest: s => s === selector ? button : null } });
    assert.equal(r.PR.state.reader.paper_note.body, "最后一行");
    if (selector === "[data-np-act]") assert.equal(exported, "最后一行");
  }
});

test("clearing a saved note persists an empty body", () => {
  const r = noteReader();
  r.PR.state.reader.paper_note = { body: "原来的内容" };
  r.input(""); r.PR.finishPanelNote();
  assert.equal(r.commits[0].body, "");
});

/* ---------- Notehelp Completion & Notifications ---------- */
function setupNotehelpContext() {
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

  const npCode = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/notespanel.js"), "utf8");
  vm.runInNewContext(npCode, context);

  const nhCode = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/notehelp.js"), "utf8");
  vm.runInNewContext(nhCode, context);

  return { PR, toasts, notifications, topbarButton, panelListeners, context };
}

test("openPaperNotes switches tab to paper and ensures notes panel is open", () => {
  const { PR } = setupNotehelpContext();
  assert.equal(PR.side, null);
  PR.openPaperNotes();
  assert.equal(PR.side, "notes");
  assert.equal(PR.notesPanelOpen(), true);
});

test("when notehelp finishes, toast is displayed with action callback to view notes", async () => {
  const env = setupNotehelpContext();
  const { PR, toasts, topbarButton, panelListeners, context } = env;

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
  assert.equal(topbarButton.classList.contains("is-running"), false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, "AI 筆記起草已完成");
  assert.ok(toasts[0].action, "should have action button");
  assert.equal(toasts[0].action.label, "查看結果");

  PR.side = null;
  toasts[0].action.fn();
  assert.equal(PR.side, "notes");
});

test("when document is hidden and notehelp completes, desktop notification is sent", async () => {
  const env = setupNotehelpContext();
  const { PR, toasts, notifications, panelListeners, context } = env;
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

/* ---------- Note Libraries & Mindmap Conversion ---------- */
function noteLibraries() {
  const PR = {
    t: s => s,
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    tex: (s, display) => '<math display="' + display + '">' + s + '</math>',
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/vendor/note-libraries.js'), 'utf8'), {
    window: { PR }, self: {}, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  return PR.noteLibraries;
}
const textNode = value => ({ type: 'text', text: value });
const paraNode = value => ({ type: 'paragraph', content: [textNode(value)] });
const headingNode = (value, level = 1) => ({ type: 'heading', attrs: { level }, content: [textNode(value)] });
const listNode = (...items) => ({ type: 'bulletList', content: items.map(content => ({ type: 'listItem', content })) });

test('Markmap keeps paragraphs, nested lists and lower headings under their heading', () => {
  const { toMindMap } = noteLibraries();
  const doc = { content: [headingNode('方法'), paraNode('问题说明'), listNode([paraNode('数据'), listNode([paraNode('训练集')], [paraNode('测试集')])]), headingNode('结果', 2), paraNode('主要结论'), headingNode('待办'), paraNode('复现实验')] };
  const map = toMindMap(doc, '论文');
  assert.deepEqual(Array.from(map.children, n => n.content), ['方法', '待办']);
  const method = map.children[0];
  assert.deepEqual(Array.from(method.children, n => n.content), ['问题说明', '数据', '结果']);
  assert.deepEqual(Array.from(method.children[1].children, n => n.content), ['训练集', '测试集']);
  assert.equal(method.children[2].children[0].content, '主要结论');
  assert.equal(map.children[1].children[0].content, '复现实验');
});

test('a single title becomes the root, while a prose-only note still has content', () => {
  const { toMindMap } = noteLibraries();
  const map = toMindMap({ content: [headingNode('阅读笔记'), paraNode('第一段'), paraNode('第二段')] }, '论文');
  assert.equal(map.content, '阅读笔记');
  assert.deepEqual(Array.from(map.children, n => n.content), ['第一段', '第二段']);
  assert.equal(toMindMap({ content: [paraNode('没有标题的笔记')] }, '论文').children[0].content, '没有标题的笔记');
  assert.equal(toMindMap({ content: [paraNode('')] }, '论文').children.length, 0);
});

test('formatting, equations and code remain visible without interpreting literal HTML', () => {
  const { toMindMap } = noteLibraries();
  const map = toMindMap({ content: [
    { type: 'paragraph', content: [{ ...textNode('<img>'), marks: [{ type: 'bold' }] }, { type: 'inlineMath', attrs: { latex: 'x=y' } }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
    { type: 'codeBlock', content: [textNode('# code\n<script>')] },
  ] }, '论文');
  assert.equal(map.children[0].content, '<strong>&lt;img&gt;</strong><math display="false">x=y</math>');
  assert.equal(map.children[1].content, '<math display="true">E=mc^2</math>');
  assert.equal(map.children[2].content, '<pre><code># code\n&lt;script&gt;</code></pre>');
});

test('ordered lists, tasks, tables and images keep their note content', () => {
  const { toMindMap } = noteLibraries();
  const map = toMindMap({ content: [
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paraNode('步骤')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paraNode('已完成')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paraNode('方法')] }, { type: 'tableCell', content: [paraNode('DPO')] }] }] },
    { type: 'image', attrs: { alt: '实验图', src: '/image.png' } },
  ] }, '论文');
  assert.equal(map.children[0].content, '3. 步骤');
  assert.equal(map.children[1].content, '☑ 已完成');
  assert.ok(map.children[2].content.includes('<td>方法</td><td>DPO</td>'));
  assert.ok(map.children[3].content.includes('src="/image.png"'));
  assert.ok(map.children[3].content.includes('alt="实验图"'));
});

test('source ranges distinguish repeated text and follow nested list positions', () => {
  const { toMindMap, findMapNode } = noteLibraries();
  const map = toMindMap({ content: [headingNode('标题'), paraNode('相同内容'), paraNode('相同内容')] }, '论文');
  assert.equal(map.children[0].payload.from, 4);
  assert.equal(map.children[1].payload.from, 10);
  assert.equal(findMapNode(map, 11).node, map.children[1]);
  assert.equal(findMapNode(map, 5).node, map.children[0]);
  const nested = toMindMap({ content: [listNode([paraNode('父项'), listNode([paraNode('子项')])])] }, '论文');
  const match = findMapNode(nested, 9);
  assert.equal(match.node.content, '子项');
  assert.equal(match.node.payload.from, 8);
  assert.equal(match.ancestors[1].content, '父项');
});

test('node positions move with inserted content, while atomic equations use one position', () => {
  const { toMindMap, findMapNode } = noteLibraries();
  const map = toMindMap({ content: [{ type: 'blockMath', attrs: { latex: 'x=1' } }, paraNode('内容')] }, '论文');
  assert.equal(map.children[0].payload.from, 0);
  assert.equal(map.children[0].payload.to, 1);
  assert.equal(map.children[1].payload.from, 1);
  const changed = toMindMap({ content: [paraNode('新增段落'), { type: 'blockMath', attrs: { latex: 'x=1' } }, paraNode('内容')] }, '论文');
  assert.equal(changed.children[1].payload.from, 6);
  assert.equal(findMapNode(changed, 8).node.content, '内容');
});

test('multi-paragraph quotations form one map node with the full source range', () => {
  const { toMindMap } = noteLibraries();
  const map = toMindMap({ content: [{ type: 'blockquote', content: [paraNode('First paragraph'), paraNode('Second paragraph')] }] }, 'Paper');
  assert.equal(map.children.length, 1);
  assert.equal(map.children[0].content, '<p>First paragraph</p><p>Second paragraph</p>');
  assert.equal(map.children[0].payload.type, 'blockquote');
});
