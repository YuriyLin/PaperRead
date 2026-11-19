const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...names) { names.forEach((n) => set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    toggle(name, force) {
      if (force === undefined) {
        if (set.has(name)) { set.delete(name); return false; }
        set.add(name); return true;
      }
      if (force) set.add(name); else set.delete(name);
      return !!force;
    },
    contains(name) { return set.has(name); },
  };
}

function makeElement(tag = "div") {
  const attrs = {};
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
    hidden: false,
    disabled: false,
    draggable: false,
    tabIndex: 0,
    title: "",
    value: "",
    children: [],
    childNodes: [],
    parentNode: null,
    classList: makeClassList(),
    _innerHTML: "",
    _textContent: "",
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); },
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = String(v); },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === "id") this.id = String(v);
    },
    getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return k in attrs; },
    matches(sel) {
      if (sel === ".media-image img") return this.tagName === "IMG" && this._isMediaImg;
      if (sel === ":popover-open") return false;
      return false;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === ".dock-group" && cur.className.includes("dock-group")) return cur;
        if (sel === ".dock-split" && cur.className.includes("dock-split")) return cur;
        if (sel === ".dock-add" && cur.className.includes("dock-add")) return cur;
        if (sel === ".dock-tab" && cur.className.includes("dock-tab")) return cur;
        if (sel === "[data-open]" && cur.dataset?.open !== undefined) return cur;
        if (sel === "[data-dock-pin]" && cur.dataset?.dockPin !== undefined) return cur;
        if (sel === "[data-media-crop]" && cur.dataset?.mediaCrop !== undefined) return cur;
        if (sel === "[data-media-go]" && cur.dataset?.mediaGo !== undefined) return cur;
        if (sel === "[data-media-page]" && cur.dataset?.mediaPage !== undefined) return cur;
        if (sel === "[data-crop]" && cur.dataset?.crop !== undefined) return cur;
        if (sel === "[data-close]" && cur.dataset?.close !== undefined) return cur;
        if (sel === "[data-key]" && cur.dataset?.key !== undefined) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === "object") {
          n.parentNode = this;
          this.children.push(n);
          this.childNodes.push(n);
        }
      }
    },
    insertBefore(n, ref) {
      if (!n) return n;
      n.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx < 0) { this.children.push(n); this.childNodes.push(n); }
      else { this.children.splice(idx, 0, n); this.childNodes.splice(idx, 0, n); }
      return n;
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.childNodes = [];
      this.append(...nodes);
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
        this.parentNode = null;
      }
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      event.target ||= this;
      event.preventDefault ||= () => { event.defaultPrevented = true; };
      event.stopPropagation ||= () => { event.stopped = true; };
      event.stopImmediatePropagation ||= () => { event.stoppedImmediate = true; };
      for (const fn of listeners[type] || []) fn.call(this, event);
      if (this["on" + type]) this["on" + type](event);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (matchesSimple(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    contains(node) {
      let cur = node;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
      return false;
    },
    focus() { this._focused = true; },
    insertAdjacentHTML(_pos, html) { this._innerHTML += String(html); },
    togglePopover() { this._popoverOpen = !this._popoverOpen; },
    showPopover() { this._popoverOpen = true; },
    hidePopover() { this._popoverOpen = false; },
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; },
  };
  return el;
}

function matchesSimple(el, sel) {
  if (!el || !sel) return false;
  if (sel === "img") return el.tagName === "IMG";
  if (sel === "select") return el.tagName === "SELECT";
  if (sel === "p") return el.tagName === "P";
  if (sel === "svg") return el.tagName === "SVG";
  if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("[data-")) {
    const m = sel.match(/^\[data-(\w+)="([^"]+)"\]$/);
    if (m) return el.dataset[m[1]] === m[2];
  }
  return false;
}

function setupHarness() {
  const docListeners = {};
  const body = makeElement("body");
  const dock = makeElement("aside"); dock.id = "readerDock"; dock.hidden = true;
  const dockBtn = makeElement("button"); dockBtn.dataset.act = "dock";
  const pageview = makeElement("section"); pageview.id = "pageview";
  const notespanel = makeElement("section"); notespanel.id = "notespanel";
  const chatpanel = makeElement("section"); chatpanel.id = "chatpanel";
  const researchpanel = makeElement("section"); researchpanel.id = "researchpanel";
  body.append(dock, dockBtn, pageview, notespanel, chatpanel, researchpanel);

  const bySel = {
    "#readerDock": dock,
    '[data-act="dock"]': dockBtn,
    "#pageview": pageview,
    "#notespanel": notespanel,
    "#chatpanel": chatpanel,
    "#researchpanel": researchpanel,
  };

  const document = {
    body,
    activeElement: null,
    createElement(tag) {
      const el = makeElement(tag);
      // Support simple innerHTML templates used by figure-crop.js & reader-dock.js
      Object.defineProperty(el, "innerHTML", {
        get() { return this._innerHTML; },
        set(html) {
          this._innerHTML = String(html);
          this.children = [];
          this.childNodes = [];
          if (this._innerHTML.includes("dock-head")) {
            const head = makeElement("div"); head.className = "dock-head";
            const tabs = makeElement("div"); tabs.className = "dock-tabs";
            const split = makeElement("button"); split.className = "btn dock-split";
            const add = makeElement("button"); add.className = "btn dock-add";
            const menu = makeElement("div"); menu.className = "dock-menu";
            const list = makeElement("div"); list.className = "menu-list";
            menu.append(list);
            head.append(tabs, split, add, menu);
            const content = makeElement("div"); content.className = "dock-content";
            this.append(head, content);
          } else if (this._innerHTML.includes("crop-dialog")) {
            const dlg = makeElement("div"); dlg.className = "dialog crop-dialog";
            const sel = makeElement("select"); sel.id = "cropPage"; sel.value = "1";
            const stage = makeElement("div"); stage.className = "crop-stage";
            const img = makeElement("img");
            const box = makeElement("div"); box.className = "crop-box";
            stage.append(img, box);
            const status = makeElement("p"); status.className = "hint crop-status";
            const save = makeElement("button"); save.dataset.crop = "save";
            const close = makeElement("button"); close.dataset.crop = "close";
            const reset = makeElement("button"); reset.dataset.crop = "reset";
            dlg.append(sel, stage, status, close, save);
            if (this._innerHTML.includes('data-crop="reset"')) dlg.append(reset);
            this.append(dlg);
          } else if (this._innerHTML.includes("media-preview")) {
            const preview = makeElement("div"); preview.className = "media-preview";
            const img = makeElement("img"); img._isMediaImg = true;
            const cap = makeElement("div"); cap.className = "media-caption";
            preview.append(img, cap);
            this.append(preview);
          } else if (this._innerHTML.includes("dock-mindmap-stage")) {
            const stage = makeElement("div"); stage.className = "dock-mindmap-stage";
            this.append(stage);
          }
        },
      });
      return el;
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      event.preventDefault ||= () => { event.defaultPrevented = true; };
      event.stopPropagation ||= () => { event.stopped = true; };
      event.stopImmediatePropagation ||= () => { event.stoppedImmediate = true; };
      for (const fn of docListeners[type] || []) fn(event);
    },
  };

  const calls = { popovers: [], hidePopover: 0, api: [], poll: 0, toasts: [], jumpTo: [], openPage: [], mindmapRenders: [], researchRenders: 0 };
  const fig1 = {
    id: "fig1",
    type: "figure",
    num: "1",
    page: 1,
    src: "figures/crop-1-abc.webp",
    abox: [0.1, 0.1, 0.5, 0.5],
    caption_en: "Architecture overview",
    caption_zh: "架構總覽",
  };
  const tab1 = {
    id: "tab1",
    type: "table",
    num: "1",
    page: 2,
    caption_en: "Results",
    caption_zh: "實驗結果",
  };

  const events = new Map();
  const PR = {
    pid: "demo-paper",
    paperKey: "demo-paper",
    $: (sel) => bySel[sel] || null,
    $$: () => [],
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k]) : s),
    esc: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    plain: (s) => String(s ?? ""),
    icon: (name) => `<svg class="i" data-icon="${name}"></svg>`,
    imageUrl: (rel) => "/p/demo-paper/" + rel,
    textFor: (key) => (key === "fig1#caption" ? "架構總覽" : ""),
    readingView: () => "both",
    originalFirst: () => false,
    feature: () => true,
    chatView: () => true,
    store: { mode: "server" },
    blockById: { fig1, tab1 },
    state: {
      paper: {
        meta: { title_zh: "測試論文", pages: [{ n: 1, img: "pages/page-001.webp" }] },
        blocks: [fig1, tab1],
      },
      reader: { paper_note: { body: "" } },
      job: { state: "done" },
    },
    debounce: (fn) => fn,
    on(name, fn) { (events.get(name) || events.set(name, []).get(name)).push(fn); },
    emit(name, arg) { for (const fn of events.get(name) || []) fn(arg); },
    renderResearchPanel() { calls.researchRenders++; researchpanel.append(makeElement("div")); },
    fitWide() {},
    renderMargin() {},
    setSideSpace() {},
    popover(anchor, html, opts) { calls.popovers.push({ anchor, html, opts }); },
    hidePopover() { calls.hidePopover++; },
    jumpTo(id) { calls.jumpTo.push(id); },
    openPage(page, id) { calls.openPage.push({ page, id }); },
    toast(msg) { calls.toasts.push(msg); },
    mindmap: {
      renderPanel(container, data, opts) {
        calls.mindmapRenders.push({ container, data, opts });
      },
    },
    async api(url, opts) {
      calls.api.push({ url, opts });
      if (url.endsWith("/mindmap")) {
        return { mermaid: "mindmap\n  root((Demo Mindmap))", model: "test-model" };
      }
      return { block: fig1 };
    },
    async poll() { calls.poll++; },
  };

  const ctx = {
    window: { PR },
    innerWidth: 1280,
    innerHeight: 800,
    document,
    ResizeObserver: class { observe() {} },
    CSS: { escape: (s) => s },
    console,
  };
  for (const file of ["media-preview.js", "reader-dock.js", "dock-resources.js", "figure-crop.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader", file), "utf8");
    vm.runInNewContext(code, ctx);
  }
  return { PR, dock, body, document, calls, fig1 };
}

test("media-preview hover renders upstream actions and handles pin, crop, and image error", () => {
  const { PR, document, calls, fig1 } = setupHarness();
  const anchor = makeElement("a");
  PR.media.hover(anchor, fig1);
  assert.equal(calls.popovers.length, 1);
  const { html } = calls.popovers[0];
  assert.ok(html.includes('data-dock-pin="fig1"'));
  assert.ok(html.includes('data-media-crop="fig1"'));
  assert.ok(html.includes('data-media-go="fig1"'));
  assert.ok(html.includes('data-media-page="1"'));

  const pinBtn = makeElement("button");
  pinBtn.dataset.dockPin = "fig1";
  document.dispatch("click", { target: pinBtn });
  assert.equal(calls.hidePopover, 1);
  assert.equal(PR.dockVisible("fig:fig1"), true);

  const img = makeElement("img");
  img._isMediaImg = true;
  const errSpan = makeElement("span");
  const wrap = makeElement("div");
  wrap.append(img, errSpan);
  Object.defineProperty(img, "nextElementSibling", { get: () => errSpan });
  document.dispatch("error", { target: img });
  assert.equal(img.hidden, true);
  assert.equal(errSpan.hidden, false);
});

test("reader-dock and dock-resources pin figure, render gallery, and close tab", () => {
  const { PR, dock } = setupHarness();
  assert.equal(dock.hidden, true);
  PR.toggleDock();
  assert.equal(dock.hidden, false);
  assert.equal(PR.side, "pages");

  PR.pinDockFigure("fig1");
  assert.equal(PR.side, "fig:fig1");
  assert.equal(PR.dockVisible("fig:fig1"), true);

  PR.openSide("gallery");
  assert.equal(PR.side, "gallery");
  assert.equal(PR.dockVisible("gallery"), true);

  PR.closeDockTab("fig:fig1");
  assert.equal(PR.dockVisible("fig:fig1"), false);
});

test("reader-dock uses standalone top/bottom split icon, omits split from + menu, and renders research mindmap as 心智圖", async () => {
  const { PR, dock, calls } = setupHarness();
  PR.toggleDock();

  const splitBtn = dock.querySelector(".dock-split");
  const addBtn = dock.querySelector(".dock-add");
  const menuList = dock.querySelector(".menu-list");
  assert.ok(splitBtn, "standalone .dock-split button exists in dock header");
  assert.equal(splitBtn.disabled, true, "cannot split with only one tab");

  PR.openSide("map");
  await new Promise((r) => setTimeout(r, 0));
  const mapTab = dock.querySelectorAll(".dock-tab").find((t) => (t._innerHTML || t.textContent || "").includes("心智圖"));
  assert.ok(mapTab, "dock map tab displays 心智圖");
  assert.equal(
    dock.querySelectorAll(".dock-tab").some((t) => (t._innerHTML || "").includes("思維導圖") || (t._innerHTML || "").includes("思维导图")),
    false
  );
  assert.ok(calls.api.some((c) => c.url === "/api/research/v2/paper/demo-paper/mindmap"));
  assert.equal(calls.mindmapRenders.length, 1);
  assert.ok(calls.mindmapRenders[0].data.mermaid.includes("Demo Mindmap"));

  dock.dispatch("click", { target: addBtn });
  const menuText = menuList.children.map((c) => `${c.dataset?.open || ""} ${c._innerHTML} ${c.textContent}`).join("\n");
  assert.doesNotMatch(menuText, /分欄|分栏|columns/);

  assert.equal(splitBtn.disabled, false, "split enabled when 2+ tabs exist");
  const groups = dock.querySelectorAll(".dock-group");
  assert.equal(groups.length, 2);
  assert.equal(groups[1].hidden, true);
  dock.dispatch("click", { target: splitBtn });
  assert.equal(dock.classList.contains("split"), true);
  assert.equal(groups[1].hidden, false);

  dock.dispatch("click", { target: splitBtn });
  assert.equal(dock.classList.contains("split"), false);
  assert.equal(groups[1].hidden, true);
});

test("figure-crop modal drags box, saves to /api/p/<id>/figure-crop, and supports reset", async () => {
  const { PR, body, calls, fig1 } = setupHarness();
  fig1.manual_crop = { src: "figures/old.webp" };
  PR.cropFigure("fig1");

  const backdrop = body.children.find((c) => c.className.includes("crop-backdrop"));
  assert.ok(backdrop, "crop modal appended to body");
  const img = backdrop.querySelector("img");
  const stage = backdrop.querySelector(".crop-stage");
  const saveBtn = backdrop.querySelector('[data-crop="save"]');
  const resetBtn = backdrop.querySelector('[data-crop="reset"]');
  assert.ok(resetBtn, "reset button shown when manual_crop is present");

  img.onload();
  assert.equal(saveBtn.disabled, false);

  // Drag a new crop box [0.25, 0.2, 0.75, 0.8] on 400x300 stage
  stage.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 60 });
  stage.dispatch("pointermove", { clientX: 300, clientY: 240 });
  stage.dispatch("pointerup", {});

  await backdrop.onclick({ target: saveBtn });
  assert.equal(calls.api.length, 1);
  assert.equal(calls.api[0].url, "/api/p/demo-paper/figure-crop");
  assert.equal(calls.api[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.api[0].opts.body)), {
    id: "fig1",
    page: 1,
    box: [0.25, 0.2, 0.75, 0.8],
    reset: false,
  });
  assert.equal(calls.poll, 1);
  assert.equal(calls.toasts.length, 1);

  // Re-open and test reset
  PR.cropFigure("fig1");
  const backdrop2 = body.children.find((c) => c.className.includes("crop-backdrop"));
  const resetBtn2 = backdrop2.querySelector('[data-crop="reset"]');
  await backdrop2.onclick({ target: resetBtn2 });
  assert.equal(calls.api.length, 2);
  assert.equal(calls.api[1].opts.body.reset, true);
});

test("dock mindmap reloads on research-task-update and research tab renders when opened from dock", async () => {
  const { PR, dock, calls } = setupHarness();
  PR.toggleDock();
  PR.openSide("map");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.mindmapRenders.length, 1);

  // Task completes while map tab is visible (previously had no task sig)
  PR.emit("research-task-update", { mindmap: { id: "t2", state: "completed", paper_id: "demo-paper" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.mindmapRenders.length, 2);

  // Switch away to research tab from dock: should trigger renderResearchPanel
  PR.openSide("research");
  assert.equal(calls.researchRenders, 1);

  // Another task completes while map tab is hidden; switching back reloads map
  PR.emit("research-task-update", { mindmap: { id: "t3", state: "completed", paper_id: "demo-paper" } });
  PR.openSide("map");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.mindmapRenders.length, 3);
  assert.equal(dock.hidden, false);
});
