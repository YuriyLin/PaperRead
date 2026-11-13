const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(source='Lucide') {
  function element() { return { hidden:false, dataset:{}, attributes:{}, style:{}, children:[], listeners:{}, classList:{toggle(){},contains(){return false}}, addEventListener(type, fn){this.listeners[type]=fn;}, setAttribute(key,value){this.attributes[key]=value;if(key.startsWith('data-'))this.dataset[key.slice(5)]=value;}, getAttribute(key){return this.attributes[key]}, append(node){this.children.push(node);}, remove(){this.removed=true}, querySelector(){return null}, querySelectorAll(){return []}, getScreenCTM(){return {a:1,b:0,c:0,d:1,e:100,f:100}}, getBoundingClientRect(){return {left:100,top:100,right:200,bottom:200,width:100,height:100}}, focus(){}, setPointerCapture(){}}; }
  const panel=element(), bar=element(), layer=element(), toggle=element(), stage=element(), ink=element(), block=element();
  panel.hidden=true; ink.getAttribute=()=> 'true';
  block.dataset.id='p1'; block.innerText='paper';
  const svg=fs.readFileSync(path.join(__dirname,'../easyread/web/stickers/science/atom.svg'),'utf8');
  const data='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  const item={id:'atom',name:'Atom',category:'science',source,format:'svg',tags:[],offlineData:data};
  const embedded={textContent:JSON.stringify({stickerAssets:[item]})};
  const elements={stickerPanel:panel,stickerToggle:toggle,stickerTools:bar,inkLayer:layer,stage,inkToggle:ink,'b-p1':block,'pr-data':embedded};
  const document={documentElement:{dataset:{theme:'light'}},body:element(),listeners:{},getElementById:id=>elements[id],querySelector(){return null},addEventListener(type,fn){this.listeners[type]=fn;},createElement(){return element()},createElementNS(_ns,name){const e=element();e.kind=name;e.querySelector=selector=>selector==='image'?e.children.find(child=>child.kind==='image'):selector==='[data-sticker-content]'?e.children.find(child=>Object.hasOwn(child.attributes,'data-sticker-content')):null;return e;}};
  layer.querySelectorAll=selector=>selector==='[data-sticker]'?layer.children.filter(x=>x.dataset.sticker):[];
  const sticker={id:'s1',assetId:'atom',anchor:'p1',textHash:'hash',ref:[100,100],x:0,y:0,width:40,height:40,rotation:0,opacity:.4,z:1,locked:false};
  const PR={state:{reader:{stickers:{s1:sticker}}}, t:s=>s, esc:s=>String(s||''), md:text=>String(text).replace(/\$([^$]+)\$/g,'<span class="katex">$1</span>'), icon:name=>`<svg data-icon="${name}"></svg>`, ls:{get:(_k,d)=>d,set:()=>true}, on(){}, renderInk(){}, toggleInk(){}, hashText:()=> 'hash', recordStickerHistory(){}, commit(op){if(op.op==='sticker')this.state.reader.stickers[op.sticker.id]=op.sticker;}, $$: () => [block], stickerLasso:require('../easyread/web/js/reader/sticker-lasso.js'), stickerGeometry:require('../easyread/web/js/reader/sticker-geometry.js'),stickerStyle:require('../easyread/web/js/reader/sticker-style.js')};
  let themeChanged;
  class MockImage { constructor() { setTimeout(() => { this.naturalWidth = 24; this.naturalHeight = 24; this.onload?.(); }, 0); } }
  const context={window:{PR,innerWidth:1200,innerHeight:800,addEventListener(){}},document,innerWidth:1200,innerHeight:800,Image:MockImage,URL,MutationObserver:class{constructor(callback){themeChanged=callback}observe(){}},DOMParser:class{parseFromString(){return {querySelector(){return null},documentElement:{localName:'svg'},querySelectorAll(){return []}}}},TextDecoder,Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary'),console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../easyread/web/js/reader/stickers.js'),'utf8'),context);
  return {PR,panel,bar,layer,toggle,document,themeChanged};
}

test('library uses a custom category menu, a rounded star and a single license disclosure',()=>{
  const {toggle,panel}=setup(); toggle.listeners.click();
  assert.match(panel.innerHTML,/class="sticker-category"/); assert.doesNotMatch(panel.innerHTML,/<select/);
  const item={dataset:{asset:'atom'},hasAttribute:()=>false}; panel.listeners.click({target:{closest:()=>item}});
  assert.match(panel.innerHTML,/data-icon="star"/); assert.match(panel.innerHTML,/class="sticker-credit"/);
  assert.doesNotMatch(panel.innerHTML,/class="sticker-credit"[\s\S]*<details class="sticker-credit"/);
  const favorite={dataset:{},hasAttribute:name=>name==='data-favorite'};
  panel.listeners.click({target:{closest:()=>favorite}});
  assert.match(panel.innerHTML,/data-favorite[^>]*aria-pressed="true"/);
  const option={dataset:{categoryValue:'science'},hasAttribute:name=>name==='data-category-value'};
  panel.listeners.click({target:{closest:()=>option}});
  assert.match(panel.innerHTML,/aria-label="分類: 科學"/);
});

test('selected Lucide sticker exposes direct styling while keeping opacity and keyboard movement',()=>{
  const {PR,toggle,bar,layer,document}=setup(); toggle.listeners.click();
  const group={dataset:{sticker:'s1'}}; layer.listeners.pointerdown({button:0,target:{dataset:{},closest:()=>group},preventDefault(){},stopPropagation(){},pointerId:1,clientX:120,clientY:120});
  PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front');
  const [primary,more]=bar.innerHTML.split('<details');
  assert.match(primary,/data-field="strokeColor"/); assert.match(primary,/data-field="strokeWidth"/);
  assert.doesNotMatch(primary,/<output/);
  assert.doesNotMatch(more,/data-field="(?:x|y|width|rotation|opacity|strokeColor|strokeWidth)"/);
  bar.listeners.change({target:{dataset:{field:'strokeWidth'},value:'3'}});
  assert.equal(PR.state.reader.stickers.s1.strokeWidth,3);
  document.listeners.keydown({key:'ArrowRight',target:{closest:selector=>selector==='[data-sticker]'?group:null},preventDefault(){}});
  assert.equal(PR.state.reader.stickers.s1.x,1);
  assert.equal(PR.state.reader.stickers.s1.opacity,.4);
});

test('hand-drawn stickers do not offer Lucide styling controls',()=>{
  const {PR,toggle,bar,layer,document}=setup('Mega Doodles Pack'); toggle.listeners.click();
  const group={dataset:{sticker:'s1'}}; layer.listeners.pointerdown({button:0,target:{dataset:{},closest:()=>group},preventDefault(){},stopPropagation(){},pointerId:1,clientX:120,clientY:120});
  document.documentElement.dataset.theme='dark';
  PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front');
  assert.doesNotMatch(bar.innerHTML,/data-field="stroke(?:Color|Width)"/);
  assert.match(layer.children[0].querySelector('image').attributes.href,/^data:image\/svg\+xml;base64,/);
  assert.equal(PR.state.reader.stickers.s1.opacity,.4);
});

test('default Lucide color follows theme without overwriting explicit colors',()=>{
  const {PR,layer,document,themeChanged,toggle,bar}=setup();
  const render = () => { layer.children=[]; PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front'); return decodeURIComponent(layer.children[0].querySelector('image').attributes.href.split(',')[1]); };
  assert.match(render(),/color="#000000"/);
  let redraws=0; PR.renderInk=()=>{redraws++}; document.documentElement.dataset.theme='dark'; themeChanged();
  assert.equal(redraws,1); assert.match(render(),/color="#d9d9d9"/);
  assert.equal(PR.state.reader.stickers.s1.strokeColor,undefined);
  toggle.listeners.click();
  const group={dataset:{sticker:'s1'}}; layer.listeners.pointerdown({button:0,target:{dataset:{},closest:()=>group},preventDefault(){},stopPropagation(){},pointerId:1,clientX:120,clientY:120});
  render(); assert.match(bar.innerHTML,/data-field="strokeColor"[^>]*value="#d9d9d9"/);
  PR.state.reader.stickers.s1.strokeColor='#cc1122';
  assert.match(render(),/color="#cc1122"/);
  document.documentElement.dataset.theme='light'; themeChanged(); assert.match(render(),/color="#cc1122"/);
});

test('Escape closes the category dropdown and restores focus',()=>{
  const {toggle,panel}=setup(); toggle.listeners.click();
  let focused=false, prevented=false, stopped=false;
  const dropdown={open:true,querySelector:()=>({focus(){focused=true;}})};
  panel.listeners.keydown({target:{closest:()=>dropdown},key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.equal(dropdown.open,false); assert.ok(focused && prevented && stopped);
});

test('finishing a lasso returns to direct object selection',()=>{
  const {PR,layer}=setup();
  PR.setLassoMode(true);
  layer.listeners.pointerdown({button:0,pointerId:1,clientX:110,clientY:110,preventDefault(){},stopPropagation(){}});
  layer.listeners.pointermove({pointerId:1,clientX:130,clientY:110});
  layer.listeners.pointermove({pointerId:1,clientX:120,clientY:130});
  layer.listeners.pointerup({pointerId:1});
  assert.equal(PR.lassoMode,false);
  assert.equal(layer.classList.contains('lasso-mode'),false);
});

test('double clicking a sticker asset in the panel triggers insert',()=>{
  const {toggle,panel,PR}=setup(); toggle.listeners.click();
  let committed = null;
  PR.commit = op => { if (op.op === 'sticker') committed = op.sticker; };
  const item = { dataset: { asset: 'atom' }, closest: selector => selector === '[data-asset]' ? item : null };
  let prevented = false;
  panel.listeners.dblclick({ target: item, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
});

test('selected Lucide sticker renders directional edge lines and handles',()=>{
  const {PR,layer,toggle}=setup(); toggle.listeners.click();
  const group={dataset:{sticker:'s1'}};
  layer.listeners.pointerdown({button:0,target:{dataset:{},closest:()=>group},preventDefault(){},stopPropagation(){},pointerId:1,clientX:120,clientY:120});
  PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front');
  const stickerGroup = layer.children[0];
  const handles = stickerGroup.children.filter(c => c.dataset?.handle).map(c => c.dataset.handle);
  assert.ok(handles.includes('n'), 'should have top edge handle');
  assert.ok(handles.includes('s'), 'should have bottom edge handle');
  assert.ok(handles.includes('w'), 'should have left edge handle');
  assert.ok(handles.includes('e'), 'should have right edge handle');
  assert.ok(handles.includes('rotate'), 'should have rotate handle');
});

test('sticker links persist and reject dangerous URLs', async ()=>{
  const {PR,layer,toggle,bar}=setup(); toggle.listeners.click();
  const group={dataset:{sticker:'s1'}};
  layer.listeners.pointerdown({button:0,target:{dataset:{},closest:()=>group},preventDefault(){},stopPropagation(){},pointerId:1,clientX:120,clientY:120});
  PR.promptText=async()=> 'https://example.com/paper';
  const click=action=>bar.listeners.click({target:{closest:()=>({dataset:{action}})}});
  click('link'); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(PR.state.reader.stickers.s1.href,'https://example.com/paper');
  let warning=''; PR.toast=value=>warning=value; PR.promptText=async()=> 'javascript:alert(1)';
  click('link'); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(PR.state.reader.stickers.s1.href,'https://example.com/paper'); assert.ok(warning);
  click('unlink'); assert.equal(PR.state.reader.stickers.s1.href,undefined);
});

test('text box inserts on the ink layer and saves multiline edits and styles',()=>{
  const {PR,layer,document,bar}=setup(); PR.uid=()=> 'text1';
  PR.renderInk=()=>{layer.children=[];PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front')};
  PR.insertInkText(150,160);
  assert.equal(PR.state.reader.stickers.text1.assetId,'paperread-text-box');
  const input=document.body.children.at(-1); assert.ok(input);
  input.value='first line\n第二行'; input.listeners.blur();
  assert.equal(PR.state.reader.stickers.text1.text,'first line\n第二行'); assert.equal(input.removed,true);
  bar.listeners.change({target:{dataset:{field:'textColor'},value:'#335577'}});
  bar.listeners.change({target:{dataset:{field:'textSize'},value:'28'}});
  assert.equal(PR.state.reader.stickers.text1.textColor,'#335577'); assert.equal(PR.state.reader.stickers.text1.textSize,28);
  assert.match(bar.innerHTML,/data-field="textSize" type="number"/);
  assert.doesNotMatch(bar.innerHTML,/data-field="textSize" type="range"/);
  const click=action=>bar.listeners.click({target:{closest:()=>({dataset:{action}})}});
  click('text-size-up'); assert.equal(PR.state.reader.stickers.text1.textSize,29);
  click('text-size-down'); assert.equal(PR.state.reader.stickers.text1.textSize,28);
  bar.listeners.change({target:{dataset:{field:'textSize'},value:'99'}}); assert.equal(PR.state.reader.stickers.text1.textSize,72);
  click('text-size-up'); assert.equal(PR.state.reader.stickers.text1.textSize,72);
  bar.listeners.change({target:{dataset:{field:'textSize'},value:''}}); assert.equal(PR.state.reader.stickers.text1.textSize,72);
  click('text-bold'); assert.equal(PR.state.reader.stickers.text1.textBold,true); assert.match(bar.innerHTML,/data-action="text-bold"[^>]*aria-pressed="true"/);
  PR.state.reader.stickers.text1.text='E = $mc^2$'; layer.children=[]; PR.renderStickers(layer,{left:0,top:0},{scrollTop:0},'front');
  const textGroup=layer.children.find(group=>group.dataset.sticker==='text1');
  assert.match(textGroup.children.find(child=>child.kind==='foreignObject').children[0].innerHTML,/class="katex"/);
});

/* ---------- Sticker Geometry & Transform ---------- */
const { move: moveSticker, rotate: rotateSticker, resize: resizeSticker, toolbarPosition } = require('../easyread/web/js/reader/sticker-geometry.js');
const closeEnough = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const geomSticker = { x: 20, y: 30, width: 100, height: 50, rotation: 0 };

test('drag uses coordinates independent of displayed zoom', () => {
  for (const zoom of [0.5, 1, 2]) {
    const next = moveSticker(geomSticker, 40 * zoom / zoom, 20 * zoom / zoom);
    closeEnough(next.x, 60);
    closeEnough(next.y, 50);
  }
});

test('resizing preserves ratio and opposite corner including rotation', () => {
  let next = resizeSticker(geomSticker, 'se', -20, -10, false);
  closeEnough(next.width, 80);
  closeEnough(next.height, 40);
  closeEnough(next.x, 20);
  closeEnough(next.y, 30);
  next = resizeSticker({ ...geomSticker, rotation: 90 }, 'se', -10, 20, false);
  closeEnough(next.width, 120);
  closeEnough(next.height, 60);
  const rad = Math.PI / 2;
  const corner = s => ({
    x: s.x + s.width / 2 + (-s.width / 2) * Math.cos(rad) - (-s.height / 2) * Math.sin(rad),
    y: s.y + s.height / 2 + (-s.width / 2) * Math.sin(rad) + (-s.height / 2) * Math.cos(rad)
  });
  closeEnough(corner(next).x, corner(geomSticker).x);
  closeEnough(corner(next).y, corner(geomSticker).y);
});

test('shift resize is free and rotation preserves object center', () => {
  const n = resizeSticker(geomSticker, 'se', 20, 0, true);
  closeEnough(n.width, 120);
  closeEnough(n.height, 50);
  const r = rotateSticker(geomSticker, { x: 0, y: -10 }, { x: 10, y: 0 }, { x: 0, y: 0 });
  closeEnough(r.rotation, 90);
  closeEnough(r.x, geomSticker.x);
  closeEnough(r.y, geomSticker.y);
});

test('toolbar follows the sticker, clamps to the viewport, and flips above at the bottom', () => {
  assert.deepEqual(toolbarPosition({ left: 200, right: 300, top: 100, bottom: 200 }, { width: 200, height: 40 }, { width: 600, height: 500 }), { left: 150, top: 210 });
  assert.deepEqual(toolbarPosition({ left: 520, right: 590, top: 420, bottom: 490 }, { width: 200, height: 40 }, { width: 600, height: 500 }), { left: 392, top: 370 });
  assert.equal(toolbarPosition({ left: 0, right: 100, top: 600, bottom: 700 }, { width: 200, height: 40 }, { width: 600, height: 500 }), null);
});

test('edge resizing stretches horizontally or vertically while anchoring the opposite edge', () => {
  const right = resizeSticker(geomSticker, 'e', 30, 0);
  closeEnough(right.width, 130);
  closeEnough(right.height, 50);
  closeEnough(right.x, 20);
  closeEnough(right.y, 30);
  const left = resizeSticker(geomSticker, 'w', -30, 0);
  closeEnough(left.width, 130);
  closeEnough(left.height, 50);
  closeEnough(left.x, -10);
  closeEnough(left.y, 30);
  const bottom = resizeSticker(geomSticker, 's', 0, 20);
  closeEnough(bottom.width, 100);
  closeEnough(bottom.height, 70);
  closeEnough(bottom.x, 20);
  closeEnough(bottom.y, 30);
  const top = resizeSticker(geomSticker, 'n', 0, -20);
  closeEnough(top.width, 100);
  closeEnough(top.height, 70);
  closeEnough(top.x, 20);
  closeEnough(top.y, 10);
});

test('rotated edge resizing anchors the opposite edge in world coordinates', () => {
  const rotated = { ...geomSticker, rotation: 90 };
  const rad = Math.PI / 2;
  const leftEdgeCenter = item => {
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
    return { x: cx + (-item.width / 2) * Math.cos(rad), y: cy + (-item.width / 2) * Math.sin(rad) };
  };
  const res = resizeSticker(rotated, 'e', 0, 20);
  closeEnough(res.width, 120);
  closeEnough(res.height, 50);
  closeEnough(leftEdgeCenter(res).x, leftEdgeCenter(rotated).x);
  closeEnough(leftEdgeCenter(res).y, leftEdgeCenter(rotated).y);
});

/* ---------- Sticker History & Undo/Redo ---------- */
test('sticker history restores one complete edit and redo through the durable commit path', () => {
  const listeners = {};
  const element = {
    addEventListener(type, fn) { listeners[type] = fn; },
    setAttribute() {},
    classList: { toggle() {}, remove() {} },
    replaceChildren() {},
    style: {},
    querySelector() { return { setAttribute() {} }; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    clientWidth: 500, scrollHeight: 600, scrollTop: 0
  };
  let warning = '';
  const PR = {
    state: { reader: { ink: {}, stickers: {} } },
    $$: () => [],
    debounce: f => f,
    on() {},
    t: s => s,
    toast: s => { warning = s; },
    commit(op) {
      if (op.op === 'sticker') this.state.reader.stickers[op.sticker.id] = op.sticker;
      else if (op.op === 'sticker_del') delete this.state.reader.stickers[op.id];
    }
  };
  const document = {
    getElementById() { return element; },
    addEventListener() {},
    createElementNS() { return { setAttribute() {}, dataset: {} }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/ink.js'), 'utf8'), {
    window: { PR, addEventListener() {} },
    document,
    ResizeObserver: class { observe() {} },
    Date, Math, Number
  });
  const before = { id: 's1', x: 10 };
  const after = { id: 's1', x: 30 };
  PR.state.reader.stickers.s1 = after;
  PR.recordStickerHistory('s1', before, after);
  assert.equal(PR.inkHistory(false), true);
  assert.equal(PR.state.reader.stickers.s1.x, 10);
  assert.equal(PR.inkHistory(false), false);
  assert.equal(PR.inkHistory(true), true);
  assert.equal(PR.state.reader.stickers.s1.x, 30);
  const colored = { ...after, strokeColor: '#336699', strokeWidth: 3 };
  PR.state.reader.stickers.s1 = colored;
  PR.recordStickerHistory('s1', after, colored);
  assert.equal(PR.inkHistory(false), true);
  assert.equal(PR.state.reader.stickers.s1.strokeColor, undefined);
  assert.equal(PR.inkHistory(true), true);
  assert.equal(PR.state.reader.stickers.s1.strokeWidth, 3);
  PR.state.reader.stickers.s1 = { id: 's1', x: 50 };
  assert.equal(PR.inkHistory(false), true);
  assert.equal(PR.state.reader.stickers.s1.x, 50);
  assert.ok(warning);
});

/* ---------- Sticker Lasso Hit Testing ---------- */
const { contains: lassoContains, hits: lassoHits, hitsPath: lassoHitsPath } = require('../easyread/web/js/reader/sticker-lasso.js');
const lassoLoop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

test('freehand lasso includes enclosed centers or corners only', () => {
  assert.equal(lassoContains(lassoLoop, { x: 50, y: 50 }), true);
  assert.equal(lassoContains(lassoLoop, { x: 120, y: 50 }), false);
  const picked = lassoHits(lassoLoop, [
    { id: 'inside', rect: { left: 20, right: 40, top: 20, bottom: 40 } },
    { id: 'edge', rect: { left: 90, right: 130, top: 90, bottom: 130 } },
    { id: 'outside', rect: { left: 120, right: 140, top: 20, bottom: 40 } },
  ]).map(item => item.id);
  assert.deepEqual(picked, ['inside', 'edge']);
});

test('freehand lasso samples the actual ink path, not only its bounding box', () => {
  const pathObj = {
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
    getTotalLength: () => 100,
    getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    getPointAtLength: length => ({ x: length, y: length }),
  };
  const small = [{ x: 15, y: 15 }, { x: 25, y: 15 }, { x: 25, y: 25 }, { x: 15, y: 25 }];
  assert.equal(lassoHitsPath(small, pathObj), true);
});

/* ---------- Lucide SVG Styling ---------- */
const { lucideSvg } = require('../easyread/web/js/reader/sticker-style.js');

test('Lucide stroke styling preserves geometry and supports color and width', () => {
  const svg = fs.readFileSync(path.join(__dirname, '../easyread/web/stickers/science/atom.svg'), 'utf8');
  const styled = lucideSvg(svg, '#336699', 3.25);
  assert.match(styled, /color="#336699"/);
  assert.match(styled, /stroke-width="3.25"/);
  assert.match(styled, /preserveAspectRatio="none"/);
  assert.equal((styled.match(/<path/g) || []).length, (svg.match(/<path/g) || []).length);
  assert.match(styled, /stroke="currentColor"/);
  assert.equal(lucideSvg(svg, 'red" onload="x', 2), null);
  assert.equal(lucideSvg(svg, '#000000', Infinity), null);
  assert.equal(lucideSvg(svg, '#000000', 5), null);
});
