const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const settled = () => new Promise(resolve => setImmediate(resolve));
function reader({ mode = "server", chars = [["P", .1, .2, .2, .3], ["D", .2, .2, .3, .3]], ok = true } = {}) {
  const events = new Map(), requests = [], documentEvents = new Map(), observers = [];
  let selected = null;
  class Element {
    constructor(tag = "div") { this.tag = tag; this.children = []; this.style = {}; this.isConnected = true; this.clientWidth = 300; this.className = ""; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.firstChild; }
    get classList() { return { contains: value => this.className.split(" ").includes(value) }; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    replaceWith(node) { const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = node; node.parentElement = parent; }
    setAttribute(name, value) { this[name] = value; }
    querySelector(selector) { for (const node of this.children) { if (selector === "img" ? node.tag === "img" : node.className === selector.slice(1)) return node; const child = node.querySelector(selector); if (child) return child; } return null; }
    getContext() { return { measureText: text => ({ width: text.length * 10 }) }; }
  }
  const figure = new Element("figure"), image = new Element("img");
  figure.className = "orig-page"; figure.id = "orig-1"; figure.append(image);
  const PR = { state: { paper: { meta: { pages: [{ n: 1, w: 600, h: 800 }] } } }, store: { mode },
    imageUrl: name => "/p/paper/" + name, t: text => text, $$: () => [figure], on: (name, callback) => events.set(name, callback) };
  const document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element("text"), {textContent:text}), createDocumentFragment: () => new Element("fragment"), addEventListener: (name, callback) => documentEvents.set(name, callback) };
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/pdf-text.js"), "utf8"), {
    window: { PR }, document, ResizeObserver: Observer, IntersectionObserver: Observer,
    getSelection: () => selected,
    fetch: async url => { requests.push(url); return { ok, json: async () => chars }; },
  });
  events.get("rendered")();
  const root = figure.querySelector(".pdf-page-surface")?.querySelector(".pdf-text-layer");
  const resize = observers[0], observer = observers[1];
  return { PR, root, figure, image, requests, resize, observer, events, documentEvents, Element,
    selection: value => { selected = value; },
    async visible(value) { observer.callback([{ target: root, isIntersecting: value }]); await settled(); } };
}

test("original pages load characters only near the viewport, scale and reuse cached text", async () => {
  const r = reader(); assert.equal(r.requests.length, 0);
  assert.equal(r.root.parentElement.children[0], r.image);
  await r.visible(true);
  assert.deepEqual(r.requests, ["/p/paper/extract/page-001.chars.json?selection=2"]);
  assert.match(r.root.firstChild.style.cssText, /transform:scale\(0.5\)/);
  const spans = r.root.firstChild.firstChild.children;
  assert.equal(spans.map(span => span.textContent).join(""), "PD");
  assert.match(spans[0].style.cssText, /left:60px;top:160px/);
  r.root.clientWidth = 450; r.resize.callback([{ target: r.root }]);
  assert.equal(r.root.firstChild.style.transform, "scale(0.75)");
  await r.visible(false); assert.equal(r.root.firstChild, null);
  await r.visible(true); assert.equal(r.requests.length, 1);
});

test("only selection within this PDF page suppresses its paragraph jump", async () => {
  const r = reader(); await r.visible(true);
  assert.equal(r.PR.pdfTextSelectionIn(r.figure), false);
  r.selection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: node => node === r.root }) });
  assert.equal(r.PR.pdfTextSelectionIn(r.figure), true);
  const other = new r.Element();
  r.selection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: node => node === other }) });
  assert.equal(r.PR.pdfTextSelectionIn(r.figure), false);
  r.selection({ isCollapsed: true, rangeCount: 1 });
  assert.equal(r.PR.pdfTextSelectionIn(r.figure), false);
});

test("selection is preserved offscreen and copy uses character text without layout line breaks", async () => {
  const r = reader(); await r.visible(true);
  const range = { intersectsNode: () => true, startContainer: { nodeType: 1, closest: () => true }, cloneContents: () => ({ textContent: "PDF\r\ntext" }) };
  r.selection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range });
  await r.visible(false); assert.ok(r.root.firstChild);
  const copied = {};
  r.documentEvents.get("copy")({ clipboardData: { setData: (type, value) => { copied[type] = value; } }, preventDefault: () => { copied.prevented = true; } });
  assert.deepEqual(copied, { "text/plain": "PDF\ntext", prevented: true });
});

test("character coordinates retain a line break between separate PDF text lines", async () => {
  const r = reader({ chars: [["A", .1, .1, .2, .2], ["B", .1, .3, .2, .4]] });
  await r.visible(true);
  assert.equal(r.root.firstChild.firstChild.children.map(node => node.textContent).join(""), "A\nB");
});

test("synthetic zero-width PDF spaces and newlines remain text without creating extra line breaks", async () => {
  const r = reader({ chars: [
    ["Hello", .1, .1, .3, .2], [" ", 0, 0, 0, 0],
    ["world", .4, .1, .6, .2], ["\r", 0, 0, 0, 0], ["\n", 0, 0, 0, 0],
    ["Next", .1, .3, .3, .4],
  ] });
  await r.visible(true);
  const children = r.root.firstChild.firstChild.children;
  assert.equal(children.map(node => node.textContent).join(""), "Hello world\r\nNext");
  assert.equal(children[1].tag, "text");
});

test("empty or unavailable text leaves the original image usable", async () => {
  for (const options of [{ chars: [] }, { ok: false }, { chars: {} }]) {
    const r = reader(options); await r.visible(true);
    assert.equal(r.root.style.pointerEvents, "none");
    assert.ok(r.root.parentElement.title);
    assert.equal(r.root.parentElement.children[0], r.image);
  }
});

test("static exports do not request server-only text and sidebar pages reuse the same layer", async () => {
  const offline = reader({ mode: "static" }); assert.equal(offline.root, undefined); assert.equal(offline.requests.length, 0);
  const r = reader(), page = new r.Element(), image = new r.Element("img");
  page.className = "pv-page"; page.append(image);
  r.PR.attachPdfText(page, image, 1);
  assert.ok(page.querySelector(".pdf-text-layer")); assert.equal(page.children[0], image);
  r.PR.attachPdfText(page, image, 1); assert.equal(page.children.length, 2);
  r.root.isConnected = false; r.events.get("rendered")();
  assert.equal(r.observer.targets.has(r.root), false);
});
