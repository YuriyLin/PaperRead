const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hitPath } = require('../easyread/web/js/reader/ink-eraser.js');
function line(x1,y1,x2,y2) {
 const len=Math.hypot(x2-x1,y2-y1);
 return {getBoundingClientRect:()=>({left:Math.min(x1,x2),right:Math.max(x1,x2),top:Math.min(y1,y2),bottom:Math.max(y1,y2)}),getAttribute:()=>2,getScreenCTM:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),getTotalLength:()=>len,getPointAtLength:d=>({x:x1+(x2-x1)*d/len,y:y1+(y2-y1)*d/len})};
}
test('eraser catches the edge of its radius and the full swept pointer path',()=>{
 const path=line(0,0,100,0);
 assert.equal(hitPath(path,{x:50,y:10},{x:50,y:10},10),true);
 assert.equal(hitPath(path,{x:50,y:13},{x:50,y:13},10),false);
 assert.equal(hitPath(path,{x:50,y:-20},{x:50,y:20},4),true);
});
test('eraser checks transformed SVG coordinates and distant strokes',()=>{
 const path=line(0,0,10,0);
 path.getBoundingClientRect=()=>({left:100,right:120,top:50,bottom:50});
 path.getScreenCTM=()=>({a:2,b:0,c:0,d:2,e:100,f:50});
 assert.equal(hitPath(path,{x:110,y:55},{x:110,y:55},5),true);
 assert.equal(hitPath(path,{x:20,y:20},{x:20,y:20},5),false);
});

test('one eraser gesture removes intersected strokes as one undoable action',()=>{
 const fs=require('node:fs'), vm=require('node:vm');
 const events={}, toolEvents={}, toggleEvents={};
 const paths=[{dataset:{stroke:'a'},x:10},{dataset:{stroke:'b'},x:30}];
 const layer={style:{},classList:{toggle(){},remove(){}},setAttribute(){},replaceChildren(){},append(){},addEventListener(k,f){events[k]=f},setPointerCapture(){},querySelectorAll(){return paths.filter(p=>!PR.state.reader.ink[p.dataset.stroke].deleted)}};
 const button={setAttribute(){}};
 const tools={hidden:true,addEventListener(k,f){toolEvents[k]=f},querySelector(){return button}};
 const toggle={addEventListener(k,f){toggleEvents[k]=f},setAttribute(){}};
 const stage={clientWidth:100,scrollHeight:100,scrollTop:0,getBoundingClientRect(){return {left:0,top:0}}};
 const document={body:{append(){}},getElementById(id){return id==='inkLayer'?layer:id==='inkTools'?tools:id==='inkToggle'?toggle:stage},createElement(){return {style:{}}},createElementNS(){return {dataset:{},setAttribute(){}}},addEventListener(){}};
 const ink={a:{id:'a'},b:{id:'b'}};
 const PR={state:{reader:{ink,stickers:{}}},inkEraser:{hitPath(path,a,b,r){return path.x>=Math.min(a.x,b.x)-r && path.x<=Math.max(a.x,b.x)+r}}, $$:()=>[],debounce:f=>f,on(){},t:s=>s,commit(op){if(op.op==='ink_del')ink[op.id]={...ink[op.id],deleted:true};if(op.op==='ink')ink[op.stroke.id]={...op.stroke,deleted:false}}};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/ink.js','utf8'),{window:{PR,addEventListener(){}},document,ResizeObserver:class{observe(){}},Date,Math,Number});
 toggleEvents.click(); toolEvents.click({target:{closest:()=>({dataset:{},hasAttribute:n=>n==='data-ink-erase',setAttribute(){}})}});
 events.pointerdown({button:0,clientX:10,clientY:0,pointerId:1,preventDefault(){}});
 events.pointermove({buttons:1,clientX:30,clientY:0}); events.pointerup({});
 assert.equal(ink.a.deleted,true); assert.equal(ink.b.deleted,true);
 assert.equal(PR.inkHistory(false),true); assert.equal(ink.a.deleted,false); assert.equal(ink.b.deleted,false); assert.equal(PR.inkHistory(false),false);
});

test('eraser button opens the size control and selecting a pen exits eraser mode',()=>{
 const fs=require('node:fs'), vm=require('node:vm'), toolEvents={}, documentEvents={}, toggleEvents={};
 const layer={classList:{toggle(){},remove(){}},style:{},addEventListener(){},setAttribute(){},replaceChildren(){}};
 const attrs={}, button={setAttribute(k,v){attrs[k]=v}}, popup={hidden:true};
 const tools={hidden:true,addEventListener(k,f){toolEvents[k]=f},querySelector(s){if(s==='[data-ink-erase]') return button;if(s==='[data-eraser-size]')return popup;return null},querySelectorAll(){return []}};
 const toggle={addEventListener(k,f){toggleEvents[k]=f},setAttribute(){}};
 const stage={clientWidth:100,scrollHeight:100,getBoundingClientRect(){return {left:0,top:0}}};
 const document={getElementById(id){return id==='inkLayer'?layer:id==='inkTools'?tools:id==='inkToggle'?toggle:stage},addEventListener(k,f){documentEvents[k]=f}};
 const PR={state:{reader:{ink:{},stickers:{}}},$$:()=>[],debounce:f=>f,on(){},t:s=>s,commit(){},setStickerMode(){}};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/ink.js','utf8'),{window:{PR,addEventListener(){}},document,ResizeObserver:class{observe(){}},Date,Math,Number});
 toggleEvents.click();
 const eraser={dataset:{},hasAttribute:n=>n==='data-ink-erase',setAttribute(){}};
 toolEvents.click({target:{closest:()=>eraser}});
 assert.equal(attrs['aria-pressed'],'true'); assert.equal(attrs['aria-expanded'],'true'); assert.equal(popup.hidden,false);
 documentEvents.pointerdown({target:{closest:()=>null}}); assert.equal(popup.hidden,true); assert.equal(attrs['aria-pressed'],'true');
 toolEvents.click({target:{closest:()=>eraser}}); assert.equal(popup.hidden,false);
 const pen={dataset:{inkColor:'#2878c8'},hasAttribute:()=>false}; toolEvents.click({target:{closest:()=>pen}});
 assert.equal(attrs['aria-pressed'],'false'); assert.equal(popup.hidden,true);
});

test('one grouped sticker operation undoes and redoes every member together',()=>{
 const fs=require('node:fs'), vm=require('node:vm'), events={};
 const layer={classList:{toggle(){},remove(){}},style:{},addEventListener(k,f){events[k]=f},setAttribute(){},replaceChildren(){},append(){}};
 const tools={hidden:true,addEventListener(){},querySelector(){return null},querySelectorAll(){return []}};
 const toggle={addEventListener(){},setAttribute(){}};
 const stage={clientWidth:100,scrollHeight:100,getBoundingClientRect(){return {left:0,top:0}}};
 const document={getElementById(id){return id==='inkLayer'?layer:id==='inkTools'?tools:id==='inkToggle'?toggle:stage},addEventListener(){}};
 const beforeA={id:'a',x:0}, beforeB={id:'b',x:20}, afterA={id:'a',x:8}, afterB={id:'b',x:28};
 const stickers={a:afterA,b:afterB};
 const PR={state:{reader:{ink:{},stickers}},$$:()=>[],debounce:f=>f,on(){},t:s=>s,toast(){},commit(op){if(op.op==='sticker')stickers[op.sticker.id]={...op.sticker,deleted:false};if(op.op==='sticker_del')stickers[op.id]={...stickers[op.id],deleted:true};}};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/ink.js','utf8'),{window:{PR,addEventListener(){}},document,ResizeObserver:class{observe(){}},Date,Math,Number});
 PR.recordStickerBatchHistory([{id:'a',before:beforeA,after:afterA},{id:'b',before:beforeB,after:afterB}]);
 assert.equal(PR.inkHistory(false),true); assert.equal(stickers.a.x,0); assert.equal(stickers.b.x,20);
 assert.equal(PR.inkHistory(true),true); assert.equal(stickers.a.x,8); assert.equal(stickers.b.x,28);
});

test('one mixed sticker and ink selection operation undoes and redoes together',()=>{
 const fs=require('node:fs'), vm=require('node:vm');
 const layer={classList:{toggle(){},remove(){}},style:{},addEventListener(){},setAttribute(){},replaceChildren(){},append(){}};
 const tools={hidden:true,addEventListener(){},querySelector(){return null},querySelectorAll(){return []}};
 const toggle={addEventListener(){},setAttribute(){}};
 const stage={clientWidth:100,scrollHeight:100,getBoundingClientRect(){return {left:0,top:0}}};
 const document={getElementById(id){return id==='inkLayer'?layer:id==='inkTools'?tools:id==='inkToggle'?toggle:stage},addEventListener(){}};
 const beforeSticker={id:'s',x:0}, afterSticker={id:'s',x:8}, beforeInk={id:'i',points:[[1,1]]}, afterInk={id:'i',points:[[9,1]]};
 const stickers={s:afterSticker}, ink={i:afterInk};
 const PR={state:{reader:{ink,stickers}},$$:()=>[],debounce:f=>f,on(){},t:s=>s,toast(){},commit(op){if(op.op==='sticker')stickers[op.sticker.id]={...op.sticker,deleted:false};if(op.op==='sticker_del')stickers[op.id]={...stickers[op.id],deleted:true};if(op.op==='ink')ink[op.stroke.id]={...op.stroke,deleted:false};if(op.op==='ink_del')ink[op.id]={...ink[op.id],deleted:true};}};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/ink.js','utf8'),{window:{PR,addEventListener(){}},document,ResizeObserver:class{observe(){}},Date,Math,Number});
 PR.recordSelectionHistory([{id:'s',before:beforeSticker,after:afterSticker}],[{id:'i',before:beforeInk,after:afterInk}]);
 assert.equal(PR.inkHistory(false),true); assert.equal(stickers.s.x,0); assert.deepEqual(ink.i.points,[[1,1]]);
 assert.equal(PR.inkHistory(true),true); assert.equal(stickers.s.x,8); assert.deepEqual(ink.i.points,[[9,1]]);
});
