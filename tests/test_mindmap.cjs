const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function createMindmapEnv(customWindow = {}) {
  const listeners = new Map();
  const docElement = {
    dataset: { theme: "light" },
    style: {},
  };

  const document = {
    documentElement: docElement,
    body: {
      appendChild(child) { return child; },
      removeChild() {},
    },
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: "",
        classList: {
          add(c) { el.className = (el.className + " " + c).trim(); },
          remove(c) { el.className = el.className.split(/\s+/).filter(x => x !== c).join(" "); },
          toggle(c, force) {
            const has = el.className.split(/\s+/).includes(c);
            const next = force != null ? force : !has;
            if (next) el.classList.add(c); else el.classList.remove(c);
            return next;
          },
          contains(c) { return el.className.split(/\s+/).includes(c); },
        },
        style: {},
        innerHTML: "",
        textContent: "",
        children: [],
        appendChild(child) { el.children.push(child); return child; },
        remove() {},
        addEventListener(evt, fn) {
          if (!el._listeners) el._listeners = new Map();
          if (!el._listeners.has(evt)) el._listeners.set(evt, []);
          el._listeners.get(evt).push(fn);
        },
        removeEventListener(evt, fn) {
          if (!el._listeners || !el._listeners.has(evt)) return;
          const arr = el._listeners.get(evt);
          const idx = arr.indexOf(fn);
          if (idx >= 0) arr.splice(idx, 1);
        },
        dispatchEvent(evt) {
          const arr = el._listeners?.get(evt.type) || [];
          for (const fn of arr) fn(evt);
        },
        querySelector(selector) {
          if (selector === "[data-mm-zoom]") return { textContent: "100%" };
          if (selector === ".dialog") return el._dialog || el.children.find(c => c.className.includes("dialog")) || null;
          if (selector === "#mmModalStage") return el._stage || { innerHTML: "", classList: { add() {} }, appendChild() {} };
          return null;
        },
        querySelectorAll() { return []; },
        closest(selector) {
          if (el.dataset && selector.includes("data-mm-act")) {
            return el.dataset.mmAct ? el : null;
          }
          return null;
        },
      };
      return el;
    },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners.has(evt)) return;
      const arr = listeners.get(evt);
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };

  const PR = {
    t: (s) => s,
    esc: (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    titleHtml: (s) => `<span class="katex-title">${s}</span>`,
    md: (s) => `<span class="md">${s}</span>`,
    icon: (name) => `<svg class="icon-${name}"></svg>`,
  };

  const win = {
    PR,
    document,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn) => { fn(); return 1; },
    ...customWindow,
  };

  const code = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/mindmap-view.js"), "utf8");
  vm.runInNewContext(code, { window: win, document, PR, console, setTimeout: win.setTimeout });

  return { PR, win, document, listeners };
}

test("parseToData parses single-root Mermaid mindmap and sets default collapsed state on level 1 branches", () => {
  const { PR } = createMindmapEnv();
  const mermaid = `
mindmap
  root((注意力機制與模型架構))
    問題定義
      長距離依賴
      計算複雜度
    方法設計
      自注意力 (Self-Attention)
      ["多頭機制與 $O(N^2)$"]
    核心發現
      BLEU 得分提升 $3.5$
  `;

  const data = PR.mindmap.parseToData(mermaid, "備用標題");
  assert.equal(data.nodeData.id, "me-root");
  assert.equal(data.nodeData.topic, "注意力機制與模型架構");
  assert.equal(data.nodeData.expanded, true);
  assert.equal(data.nodeData.children.length, 3);

  // 第一層主分支：預設收合狀態 (expanded: false)，以符合側欄單側收合與大視窗雙側收合
  const [q, m, r] = data.nodeData.children;
  assert.equal(q.topic, "問題定義");
  assert.equal(q.expanded, false);
  assert.equal(q.children.length, 2);
  assert.equal(q.children[0].topic, "長距離依賴");
  assert.equal(q.children[1].topic, "計算複雜度");

  assert.equal(m.topic, "方法設計");
  assert.equal(m.expanded, false);
  assert.equal(m.children.length, 2);
  assert.equal(m.children[0].topic, "自注意力 (Self-Attention)");
  assert.equal(m.children[1].topic, "多頭機制與 $O(N^2)$");

  assert.equal(r.topic, "核心發現");
  assert.equal(r.expanded, false);
  assert.equal(r.children[0].topic, "BLEU 得分提升 $3.5$");
});

test("parseToData wraps multiple top branches into virtual root and defaults children to collapsed", () => {
  const { PR } = createMindmapEnv();
  const mermaid = `
mindmap
  研究背景
    現有瓶頸
  實驗結果
    準確率 $98.2\%$
  `;

  const data = PR.mindmap.parseToData(mermaid, "大語言模型推理論文");
  assert.equal(data.nodeData.id, "me-root");
  assert.equal(data.nodeData.topic, "大語言模型推理論文");
  assert.equal(data.nodeData.expanded, true);
  assert.equal(data.nodeData.children.length, 2);
  assert.equal(data.nodeData.children[0].topic, "研究背景");
  assert.equal(data.nodeData.children[0].expanded, false);
  assert.equal(data.nodeData.children[1].topic, "實驗結果");
  assert.equal(data.nodeData.children[1].expanded, false);
});

test("getTheme generates matching theme variables for light and dark modes", () => {
  const { PR } = createMindmapEnv();
  const light = PR.mindmap.getTheme(false);
  const dark = PR.mindmap.getTheme(true);

  assert.equal(light.type, "light");
  assert.equal(dark.type, "dark");
  assert.equal(light.cssVar["--bgcolor"], "#f6f3ec");
  assert.equal(dark.cssVar["--bgcolor"], "#1a1917");
  assert.equal(light.palette.length, 8);
  assert.equal(dark.palette.length, 8);
});

test("mount initializes MindElixir, uses PR.md for rich math/formatting, and handles toolbar actions & node click toggle", () => {
  let initedData = null;
  let scaledVal = null;
  let centered = false;
  let currentSide = 1;
  let expandedTpc = null;

  class FakeMindElixir {
    constructor(opts) {
      this.opts = opts;
      this.scaleVal = 1;
      this.nodeData = { children: [{ id: "n1" }] };
    }
    init(data) { initedData = data; }
    scale(val) { scaledVal = val; this.scaleVal = val; }
    scaleFit() {}
    toCenter() { centered = true; }
    initSide() { currentSide = 2; }
    initRight() { currentSide = 1; }
    findEle(id) { return { id }; }
    expandNode(tpc) { expandedTpc = tpc; }
    expandNodeAll() {}
    destroy() {}
  }

  const { PR, document } = createMindmapEnv({ MindElixir: FakeMindElixir });
  const container = document.createElement("div");

  const ctrl = PR.mindmap.mount(container, {
    data: { nodeData: { id: "me-root", topic: "Root", children: [] } },
    direction: 1,
    zoomControls: true,
    showDirBtn: true,
    showModalBtn: true,
    onOpenModal: () => {},
  });

  assert.ok(ctrl);
  assert.equal(initedData.nodeData.topic, "Root");

  // 測試 markdown 鉤子呼叫了 PR.md 進行數學公式與 Markdown 渲染
  const rendered = ctrl.instance.opts.markdown("**複雜度** $O(N^2)$");
  assert.match(rendered, /class="md"/);

  const toolbar = container.children.find(c => c.className === "mm-toolbar");
  assert.ok(toolbar);

  // 檢查按鈕文字改為「詳細檢視」
  assert.match(toolbar.innerHTML, /詳細檢視/);
  // 檢查新樹狀分支 SVG 圖示（非原本的 plus/minus）
  assert.match(toolbar.innerHTML, /data-mm-act="expand-all"/);
  assert.match(toolbar.innerHTML, /data-mm-act="collapse-main"/);
  assert.match(toolbar.innerHTML, /viewBox="0 0 20 20"/);

  // 模擬縮小按鈕
  toolbar.onclick({
    target: { closest: () => ({ dataset: { mmAct: "zoom-in" } }) },
  });
  assert.equal(scaledVal, 1.15);

  // 模擬切換佈局按鈕
  toolbar.onclick({
    target: { closest: () => ({ dataset: { mmAct: "toggle-dir" } }) },
  });
  assert.equal(currentSide, 2);

  // 模擬點擊節點主體收合／展開 (Item 6)
  const canvasWrap = container.children.find(c => c.className === "mm-canvas-host");
  assert.ok(canvasWrap);
  const fakeTpc = {
    tagName: "ME-TPC",
    parentElement: { tagName: "ME-PARENT" },
    nodeObj: { id: "node-1", children: [{ id: "sub-1" }] },
    closest: (sel) => (sel === "me-tpc" ? fakeTpc : null),
  };
  canvasWrap.dispatchEvent({
    type: "click",
    target: fakeTpc,
  });
  assert.equal(expandedTpc, fakeTpc);

  ctrl.destroy();
});

test("openModal opens fullscreen dialog, supports theme toggling and closes via Escape or close button", () => {
  let modalMounted = false;
  let modalDir = 0;
  let changedTheme = null;
  class FakeMindElixirModal {
    constructor(opts) {
      this.opts = opts;
      modalDir = opts.direction;
      modalMounted = true;
    }
    init() {}
    destroy() { modalMounted = false; }
    scaleFit() {}
    toCenter() {}
    changeTheme(theme) { changedTheme = theme; }
  }

  const { PR, document, listeners } = createMindmapEnv({ MindElixir: FakeMindElixirModal });
  const backdrop = document.createElement("div");
  backdrop.id = "mindmapDlg";
  const dialog = document.createElement("div");
  dialog.className = "dialog";
  backdrop.appendChild(dialog);
  PR.$ = (sel) => (sel === "#mindmapDlg" ? backdrop : null);

  const mindData = { nodeData: { id: "me-root", topic: "大視窗論文心智圖", children: [{ id: "c1", expanded: true, children: [] }] } };
  PR.mindmap.openModal(mindData, { title: "大視窗論文心智圖" });

  assert.ok(backdrop.classList.contains("open"));
  assert.ok(modalMounted);
  // 大視窗預設雙側放射佈局 (direction === 2)
  assert.equal(modalDir, 2);
  assert.match(dialog.innerHTML, /大視窗論文心智圖/);
  // 檢查包含主題切換按鈕
  assert.match(dialog.innerHTML, /data-mm-modal="theme"/);

  // 模擬點擊主題切換按鈕
  backdrop.onclick({
    target: { closest: (sel) => (sel === '[data-mm-modal="theme"]' ? true : null) },
  });
  assert.ok(changedTheme);
  assert.equal(changedTheme.type, "dark");
  assert.equal(document.documentElement.dataset.theme, "dark");

  // 觸發 Escape 關閉
  const keyHandlers = listeners.get("keydown") || [];
  assert.ok(keyHandlers.length > 0);
  keyHandlers[0]({ key: "Escape" });

  assert.equal(backdrop.classList.contains("open"), false);
  assert.equal(modalMounted, false);
});

test("PR.mindmap exports exportPngBlob and exportPngBase64 methods with KaTeX styles", async () => {
  let passedStyles = null;
  class FakeExportME {
    constructor(opts) {
      this.opts = opts;
    }
    init(data) { this.data = data; }
    findEle() { return { id: "me-root" }; }
    expandNodeAll() {}
    destroy() {}
    async exportPng(isText, styles) {
      passedStyles = styles;
      return new Uint8Array([1, 2, 3]);
    }
  }

  const { PR } = createMindmapEnv({ MindElixir: FakeExportME });
  assert.equal(typeof PR.mindmap.exportPngBlob, "function");
  assert.equal(typeof PR.mindmap.exportPngBase64, "function");

  const blob = await PR.mindmap.exportPngBlob({
    nodeData: { id: "me-root", topic: "「$X^2$-VLM」", children: [] }
  });
  assert.ok(blob);
  assert.ok(passedStyles);
  assert.match(passedStyles, /\.katex/);
  assert.match(passedStyles, /display: none !important/);
});

test("planner does not destroy or reset rendered mindmap on repeated research-task-update ticks from background tasks", async () => {
  const prEvents = new Map();
  let renderPanelCalls = 0;
  let destroyCalls = 0;
  let mindmapApiCalls = 0;

  const mindmapView = {
    innerHTML: "",
    children: [],
    replaceChildren(...nodes) { this.children = nodes; this.innerHTML = ""; },
    setAttribute() {},
    append(node) { this.children.push(node); },
    querySelector(sel) {
      if (sel === ".rp-map-loading" && this.innerHTML.includes("rp-map-loading")) {
        return { textContent: "" };
      }
      return null;
    },
  };
  const deepView = {
    innerHTML: "",
    children: [],
    replaceChildren(...nodes) { this.children = nodes; this.innerHTML = ""; },
    setAttribute() {},
    append(node) { this.children.push(node); },
    querySelector(sel) {
      if (sel === ".rp-map-loading" && this.innerHTML.includes("rp-map-loading")) {
        return { textContent: "" };
      }
      return null;
    },
  };
  const statusOptions = {
    dataset: {},
    style: { setProperty() {} },
    append() {},
    querySelectorAll() { return []; },
  };
  const mapBtn = { disabled: false, textContent: "", setAttribute() {}, removeAttribute() {} };
  const deepBtn = { disabled: false, textContent: "", setAttribute() {}, removeAttribute() {} };
  const expandBtn = { style: { display: "none" } };
  const deepExpandBtn = { style: { display: "none" } };

  const researchPanel = {
    innerHTML: "",
    children: [mindmapView],
    querySelector(sel) {
      if (sel === "#rp-mindmap") return mindmapView;
      if (sel === "#rp-deep-report") return deepView;
      if (sel === "#rp-status-options") return statusOptions;
      if (sel === "#rp-map-generate") return mapBtn;
      if (sel === "#rp-deep-generate") return deepBtn;
      if (sel === "#rp-map-expand") return expandBtn;
      if (sel === "#rp-deep-expand") return deepExpandBtn;
      return null;
    },
  };

  const PR = {
    pid: "paper-1",
    side: null,
    state: { paper: { meta: { title_zh: "測試論文" } }, item: { status: "reading" } },
    t: (s) => s,
    esc: (s) => String(s || ""),
    titleHtml: (s) => String(s || ""),
    titleText: (s) => String(s || ""),
    icon: () => "<svg></svg>",
    openSide(side) { PR.side = side; },
    $: (sel) => (sel === "#researchpanel" ? researchPanel : null),
    on(evt, fn) { prEvents.set(evt, fn); },
    emit(evt, payload) { prEvents.get(evt)?.(payload); },
    mindmap: {
      renderPanel() {
        renderPanelCalls++;
        return {
          destroy() { destroyCalls++; },
        };
      },
      parseToData: () => ({}),
      openModal() {},
    },
    api: async (url) => {
      if (url.endsWith("/mindmap")) {
        mindmapApiCalls++;
        return {
          mermaid: "mindmap\n  root((Root))\n    Branch",
          model: "GPT",
          task: { id: "mm-task-1", kind: "mindmap", paper_id: "paper-1", state: "completed" },
        };
      }
      if (url.endsWith("/deep-analysis")) {
        return {
          report: { markdown: "## Analysis" },
          task: { id: "deep-task-1", kind: "deep-analysis", paper_id: "paper-1", state: "completed" },
        };
      }
      return { statuses: [{ id: "reading", label: "閱讀中" }] };
    },
  };

  const document = {
    addEventListener() {},
    createElement(tag) {
      return { tagName: tag.toUpperCase(), className: "", style: {}, dataset: {}, classList: { toggle() {} }, setAttribute() {}, append() {} };
    },
  };
  const win = {
    PR,
    document,
    location: { search: "" },
    URLSearchParams,
    setTimeout: (fn) => fn(),
  };

  const plannerCode = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/planner.js"), "utf8");
  vm.runInNewContext(plannerCode, { window: win, document, PR, URLSearchParams, setTimeout: win.setTimeout });

  // Open research panel -> renders mindmap once
  PR.toggleResearch(true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(renderPanelCalls, 1);
  assert.equal(destroyCalls, 0);
  assert.equal(mindmapApiCalls, 1);

  // Simulate background task polling emitting research-task-update every 2s while mindmap is already completed
  for (let i = 0; i < 5; i++) {
    PR.emit("research-task-update", {
      mindmap: { id: "mm-task-1", kind: "mindmap", paper_id: "paper-1", state: "completed" },
      deepAnalysis: { id: "deep-task-1", kind: "deep-analysis", paper_id: "paper-1", state: "completed" },
      smartAnnotate: { id: "sa-task-1", kind: "smart-annotate", paper_id: "paper-1", state: "running" },
    });
    await new Promise((r) => setImmediate(r));
  }

  // Mindmap must NOT be destroyed or re-rendered during background polling
  assert.equal(renderPanelCalls, 1);
  assert.equal(destroyCalls, 0);
  assert.equal(mindmapApiCalls, 1);

  // Calling toggleResearch(true) while already open must not wipe and re-render the panel either
  PR.toggleResearch(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(renderPanelCalls, 1);
  assert.equal(destroyCalls, 0);
});
