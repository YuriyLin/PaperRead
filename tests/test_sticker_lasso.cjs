const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contains, hits, hitsPath } = require('../easyread/web/js/reader/sticker-lasso.js');

const loop=[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
test('freehand lasso includes enclosed centers or corners only',()=>{
  assert.equal(contains(loop,{x:50,y:50}),true);
  assert.equal(contains(loop,{x:120,y:50}),false);
  const picked=hits(loop,[
    {id:'inside',rect:{left:20,right:40,top:20,bottom:40}},
    {id:'edge',rect:{left:90,right:130,top:90,bottom:130}},
    {id:'outside',rect:{left:120,right:140,top:20,bottom:40}},
  ]).map(item=>item.id);
  assert.deepEqual(picked,['inside','edge']);
});
test('freehand lasso samples the actual ink path, not only its bounding box',()=>{
  const path={
    getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:100}),
    getTotalLength:()=>100,
    getScreenCTM:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),
    getPointAtLength:length=>({x:length,y:length}),
  };
  const small=[{x:15,y:15},{x:25,y:15},{x:25,y:25},{x:15,y:25}];
  assert.equal(hitsPath(small,path),true);
});
