const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  let observer;
  const document = { listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.isConnected = true; this.hidden = false; }
    get classList() { return { contains: name => this.className === name }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] || null; }
    append(n) { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(x => x !== n); this.children.push(n); n.parentElement = this; }
    before(n) { const p = this.parentElement, i = p.children.indexOf(this); p.children.splice(i, 0, n); n.parentElement = p; }
    remove() { this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.isConnected = false; }
    addEventListener(k, f) { this.listeners[k] = f; }
    dispatchEvent(e) { this.listeners[e.type]?.(e); return true; }
    matches(s) { return s === 'select' && this.tagName === 'SELECT'; }
    closest(s) { return this.matches(s) ? this : this.parentElement?.closest(s); }
    querySelectorAll(s) { if (s === 'select') return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); if (s === 'button:not(:disabled)') return this.children.filter(c => c.tagName === 'BUTTON' && !c.disabled); return []; }
    querySelector(s) { if (s === '.pr-dropdown-trigger') return this.children.find(c => c.className === 'pr-dropdown-trigger'); if (s === '.pr-dropdown-value') return this.valueNode; if (s === '[aria-selected="true"]:not(:disabled)') return this.children.find(c => c.attrs['aria-selected'] === 'true' && !c.disabled); if (s === 'button:not(:disabled)') return this.children.find(c => c.tagName === 'BUTTON' && !c.disabled); return null; }
    set innerHTML(value) { this.valueNode = { textContent: '' }; }
    focus() { document.activeElement = this; }
    contains(n) { return this === n || this.children.some(c => c.contains(n)); }
    getBoundingClientRect() { return { left: 20, top: 20, bottom: 50, width: 100, height: 100 }; }
  }
  class Select extends Element {
    constructor() { super('select'); this.options = [{textContent:'First',selected:true}, {textContent:'Second',selected:false}, {textContent:'Disabled',disabled:true}]; this._index = 0; this.size = 0; this.labels = []; }
    get selectedIndex() { return this._index; }
    set selectedIndex(v) { this._index = v; this.options.forEach((o,i) => o.selected = i === v); }
    get value() { return String(this._index); }
    set value(v) { this.selectedIndex = Number(v); }
    get selectedOptions() { return this.options.filter(x => x.selected); }
  }
  document.body = new Element('body');
  document.createElement = tag => new Element(tag);
  const select = new Select(); document.body.append(select);
  document.querySelectorAll = s => document.body.querySelectorAll(s);
  const context = { document, window:{ innerWidth:800, innerHeight:600, addEventListener(){} }, HTMLSelectElement:Select, Event:class {constructor(type, options){this.type=type;this.bubbles=options.bubbles;}}, MutationObserver:class { constructor(f){observer=f;} observe(){} } };
  vm.runInNewContext(fs.readFileSync('easyread/web/js/common/dropdown.js', 'utf8'), context);
  return { select, document, observer, Element };
}

test('selection updates the original value and fires existing change handlers', () => {
  const {select, document} = setup(), box = select.parentElement, trigger = box.querySelector('.pr-dropdown-trigger');
  let changes = 0; select.addEventListener('change', () => changes++);
  trigger.listeners.click();
  const menu = document.body.children.at(-1);
  assert.equal(menu.children[2].disabled, true);
  menu.children[1].listeners.click();
  assert.equal(select.selectedIndex, 1); assert.equal(changes, 1); assert.equal(trigger.valueNode.textContent, 'Second');
  select.value = '0'; assert.equal(trigger.valueNode.textContent, 'First');
});

test('dynamic controls are enhanced and hidden/disabled state is reflected', () => {
  const {select, document, observer, Element} = setup();
  select.hidden = true; select.disabled = true;
  observer([{target:select,addedNodes:[]}]);
  assert.equal(select.parentElement.hidden, true); assert.equal(select.parentElement.querySelector('.pr-dropdown-trigger').disabled, true);
  const wrapper = new Element('div'); document.body.append(wrapper);
  const extra = new select.constructor(); wrapper.append(extra);
  observer([{target:wrapper,addedNodes:[extra]}]);
  assert.equal(extra.parentElement.className, 'pr-dropdown');
});

test('keyboard navigation skips disabled options and Escape restores focus', () => {
  const {select, document} = setup(), trigger = select.parentElement.querySelector('.pr-dropdown-trigger');
  trigger.listeners.click();
  let prevented = false;
  document.listeners.keydown({key:'ArrowDown', preventDefault(){prevented = true;}});
  assert.equal(document.activeElement.textContent, 'Second');
  document.listeners.keydown({key:'ArrowDown', preventDefault(){}});
  assert.equal(document.activeElement.textContent, 'First');
  document.listeners.keydown({key:'Escape', preventDefault(){}});
  assert.equal(document.activeElement, trigger); assert.equal(trigger.attrs['aria-expanded'], 'false'); assert.equal(prevented, true);
});
