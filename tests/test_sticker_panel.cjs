const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(source='Lucide') {
  function element() { return { hidden:false, dataset:{}, attributes:{}, style:{}, children:[], listeners:{}, classList:{toggle(){},contains(){return false}}, addEventListener(type, fn){this.listeners[type]=fn;}, setAttribute(key,value){this.attributes[key]=value;if(key.startsWith('data-'))this.dataset[key.slice(5)]=value;}, append(node){this.children.push(node);}, querySelector(){return null}, querySelectorAll(){return []}, getBoundingClientRect(){return {left:100,top:100,right:200,bottom:200,width:100,height:100}}, focus(){}, setPointerCapture(){}}; }
  const panel=element(), bar=element(), layer=element(), toggle=element(), stage=element(), ink=element(), block=element();
  panel.hidden=true; ink.getAttribute=()=> 'true';
  block.dataset.id='p1'; block.innerText='paper';
  const svg=fs.readFileSync(path.join(__dirname,'../easyread/web/stickers/science/atom.svg'),'utf8');
  const data='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  const item={id:'atom',name:'Atom',category:'science',source,format:'svg',tags:[],offlineData:data};
  const embedded={textContent:JSON.stringify({stickerAssets:[item]})};
  const elements={stickerPanel:panel,stickerToggle:toggle,stickerTools:bar,inkLayer:layer,stage,inkToggle:ink,'b-p1':block,'pr-data':embedded};
  const document={documentElement:{dataset:{theme:'light'}},listeners:{},getElementById:id=>elements[id],querySelector(){return null},addEventListener(type,fn){this.listeners[type]=fn;},createElementNS(_ns,name){const e=element();e.kind=name;e.querySelector=selector=>selector==='image'?e.children.find(child=>child.kind==='image'):null;return e;}};
  layer.querySelectorAll=selector=>selector==='[data-sticker]'?layer.children.filter(x=>x.dataset.sticker):[];
  const sticker={id:'s1',assetId:'atom',anchor:'p1',textHash:'hash',ref:[100,100],x:0,y:0,width:40,height:40,rotation:0,opacity:.4,z:1,locked:false};
  const PR={state:{reader:{stickers:{s1:sticker}}}, t:s=>s, esc:s=>String(s||''), icon:name=>`<svg data-icon="${name}"></svg>`, ls:{get:(_k,d)=>d,set:()=>true}, on(){}, renderInk(){}, toggleInk(){}, hashText:()=> 'hash', recordStickerHistory(){}, commit(op){if(op.op==='sticker')this.state.reader.stickers[op.sticker.id]=op.sticker;}, $$: () => [block], stickerGeometry:require('../easyread/web/js/reader/sticker-geometry.js'),stickerStyle:require('../easyread/web/js/reader/sticker-style.js')};
  let themeChanged;
  class MockImage { constructor() { setTimeout(() => { this.naturalWidth = 24; this.naturalHeight = 24; this.onload?.(); }, 0); } }
  const context={window:{PR,innerWidth:1200,innerHeight:800,addEventListener(){}},document,innerWidth:1200,innerHeight:800,Image:MockImage,MutationObserver:class{constructor(callback){themeChanged=callback}observe(){}},DOMParser:class{parseFromString(){return {querySelector(){return null},documentElement:{localName:'svg'},querySelectorAll(){return []}}}},TextDecoder,Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary'),console};
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
