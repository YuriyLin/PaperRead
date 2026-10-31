const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function setup() {
  const listeners = {};
  const element = () => ({
    style: {}, events: {}, classList: {add(){}, remove(){}},
    addEventListener(k, fn) { this.events[k] = fn; }, setAttribute(){},
  });
  const image = {...element(), naturalWidth: 1600, naturalHeight: 1200, complete: true};
  const viewport = {...element(), clientWidth: 800, clientHeight: 600, scrollLeft: 0, scrollTop: 0, setPointerCapture(){}};
  const label = element();
  const source = {...element(), src: 'figure.webp', alt: 'Figure 1', focus(){this.focused = true;}, matches(){return true;}};
  const dialog = {...element(), querySelector(s){return s === 'img' ? image : s.includes('scroll') ? viewport : label;},
    showModal(){this.open = true;}, close(){this.open = false; this.events.close();}};
  const document = {createElement: () => dialog, body: {appendChild(){}}, querySelectorAll: () => [source],
    addEventListener(k, fn){listeners[k] = fn;}};
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    on(){},
    toast(){},
    imageUrl: rel => '/p/demo/' + rel,
    state: {
      paper: {meta: {pages: [{n: 3, img: 'pages/page-003.webp'}]}},
      layout: {fig3: {page: 3, box: [0.16, 0.45, 0.84, 0.85]}},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/figure-zoom.js'), 'utf8'), {window:{PR}, document, Date});
  const event = extra => ({preventDefault(){this.prevented = true;}, stopImmediatePropagation(){this.stopped = true;}, ...extra});
  const click = () => listeners.click(event({target:{closest: () => source}}));
  const action = key => dialog.events.click(event({target:{closest: () => ({dataset:{zoom:key}})}}));
  return {listeners, source, image, viewport, dialog, label, event, click, action};
}

test('click opens a fitted image; controls zoom, reset, and restore focus on close', () => {
  const r = setup(); r.click();
  assert.equal(r.dialog.open, true);
  assert.equal(r.image.src, 'figure.webp');
  assert.ok(parseInt(r.image.style.width) <= 800);
  r.action('actual'); assert.equal(r.image.style.width, '1600px');
  r.action('in'); assert.equal(r.image.style.width, '2000px');
  r.action('out'); assert.equal(r.image.style.width, '1600px');
  for (let i=0; i<30; i++) r.action('in');
  assert.equal(r.image.style.width, '6400px');
  r.action('fit'); assert.ok(parseInt(r.image.style.width) <= 800);
  r.action('close'); assert.equal(r.dialog.open, false); assert.equal(r.source.focused, true);
});

test('Ctrl-wheel zooms and dragging pans enlarged details', () => {
  const r = setup(); r.click(); r.action('actual');
  const wheel = r.event({ctrlKey:true, deltaY:-1}); r.viewport.events.wheel(wheel);
  assert.equal(wheel.prevented, true); assert.equal(r.image.style.width, '2000px');
  r.viewport.scrollLeft = 100; r.viewport.scrollTop = 50;
  r.viewport.events.pointerdown(r.event({button:0, pointerId:1, clientX:300, clientY:200}));
  r.viewport.events.pointermove({clientX:200, clientY:150});
  assert.equal(r.viewport.scrollLeft, 200); assert.equal(r.viewport.scrollTop, 100);
  r.viewport.events.pointerup(); r.viewport.events.pointermove({clientX:0, clientY:0});
  assert.equal(r.viewport.scrollLeft, 200);
});

test('keyboard opens figures and viewer keys do not trigger underlying reader shortcuts', () => {
  const r = setup();
  r.listeners.keydown(r.event({key:'Enter', target:r.source}));
  assert.equal(r.dialog.open, true);
  const key = r.event({key:'j'}); r.listeners.keydown(key); assert.equal(key.stopped, true);
  r.listeners.keydown(r.event({key:'Escape'})); assert.equal(r.dialog.open, false);
});

test('placeholder zoom button opens the full original page in lightbox, scrolls to figure position, and restores focus on Escape', () => {
  const r = setup();
  const zoomBtn = {dataset: {zoomPage: '3', zoomBlock: 'fig3'}, focus() { this.focused = true; }};
  const ev = r.event({target: {closest: s => s === '[data-zoom-page]' ? zoomBtn : null}});
  r.listeners.click(ev);
  assert.equal(ev.prevented, true);
  assert.equal(ev.stopped, true);
  assert.equal(r.dialog.open, true);
  assert.equal(r.image.src, '/p/demo/pages/page-003.webp');
  assert.equal(r.image.alt, '原文第 3 页');
  assert.ok(r.viewport.scrollTop > 0);
  r.listeners.keydown(r.event({key: 'Escape'}));
  assert.equal(r.dialog.open, false);
  assert.equal(zoomBtn.focused, true);
});
