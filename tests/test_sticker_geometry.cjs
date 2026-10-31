const { test } = require('node:test');
const assert = require('node:assert/strict');
const { move, rotate, resize, toolbarPosition } = require('../easyread/web/js/reader/sticker-geometry.js');
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);
const sticker = { x:20, y:30, width:100, height:50, rotation:0 };
test('drag uses coordinates independent of displayed zoom', () => {
  for (const zoom of [0.5, 1, 2]) { const next=move(sticker,40*zoom/zoom,20*zoom/zoom); close(next.x,60); close(next.y,50); }
});
test('resizing preserves ratio and opposite corner including rotation', () => {
  let next=resize(sticker,'se',-20,-10,false); close(next.width,80); close(next.height,40); close(next.x,20); close(next.y,30);
  next=resize({...sticker,rotation:90},'se',-10,20,false); close(next.width,120); close(next.height,60);
  const rad=Math.PI/2;
  const corner = s => ({ x:s.x+s.width/2 + (-s.width/2)*Math.cos(rad)-(-s.height/2)*Math.sin(rad), y:s.y+s.height/2+(-s.width/2)*Math.sin(rad)+(-s.height/2)*Math.cos(rad) });
  close(corner(next).x,corner(sticker).x); close(corner(next).y,corner(sticker).y);
});
test('shift resize is free and rotation preserves object center', () => {
  const n=resize(sticker,'se',20,0,true); close(n.width,120); close(n.height,50);
  const r=rotate(sticker,{x:0,y:-10},{x:10,y:0},{x:0,y:0}); close(r.rotation,90); close(r.x,sticker.x); close(r.y,sticker.y);
});
test('toolbar follows the sticker, clamps to the viewport, and flips above at the bottom', () => {
  assert.deepEqual(toolbarPosition({left:200,right:300,top:100,bottom:200},{width:200,height:40},{width:600,height:500}),{left:150,top:210});
  assert.deepEqual(toolbarPosition({left:520,right:590,top:420,bottom:490},{width:200,height:40},{width:600,height:500}),{left:392,top:370});
  assert.equal(toolbarPosition({left:0,right:100,top:600,bottom:700},{width:200,height:40},{width:600,height:500}),null);
});
test('edge resizing stretches horizontally or vertically while anchoring the opposite edge', () => {
  const right = resize(sticker, 'e', 30, 0);
  close(right.width, 130); close(right.height, 50); close(right.x, 20); close(right.y, 30);
  const left = resize(sticker, 'w', -30, 0);
  close(left.width, 130); close(left.height, 50); close(left.x, -10); close(left.y, 30);
  const bottom = resize(sticker, 's', 0, 20);
  close(bottom.width, 100); close(bottom.height, 70); close(bottom.x, 20); close(bottom.y, 30);
  const top = resize(sticker, 'n', 0, -20);
  close(top.width, 100); close(top.height, 70); close(top.x, 20); close(top.y, 10);
});
test('rotated edge resizing anchors the opposite edge in world coordinates', () => {
  const rotated = { ...sticker, rotation: 90 };
  const rad = Math.PI / 2;
  const leftEdgeCenter = item => {
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
    return { x: cx + (-item.width / 2) * Math.cos(rad), y: cy + (-item.width / 2) * Math.sin(rad) };
  };
  const res = resize(rotated, 'e', 0, 20);
  close(res.width, 120); close(res.height, 50);
  close(leftEdgeCenter(res).x, leftEdgeCenter(rotated).x);
  close(leftEdgeCenter(res).y, leftEdgeCenter(rotated).y);
});
