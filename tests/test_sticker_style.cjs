const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { lucideSvg } = require('../easyread/web/js/reader/sticker-style.js');
test('Lucide stroke styling preserves geometry and supports color and width', () => {
  const svg=fs.readFileSync(path.join(__dirname,'../easyread/web/stickers/science/atom.svg'),'utf8');
  const styled=lucideSvg(svg,'#336699',3.25);
  assert.match(styled,/color="#336699"/); assert.match(styled,/stroke-width="3.25"/);
  assert.match(styled,/preserveAspectRatio="none"/);
  assert.equal((styled.match(/<path/g)||[]).length,(svg.match(/<path/g)||[]).length);
  assert.match(styled,/stroke="currentColor"/);
  assert.equal(lucideSvg(svg,'red" onload="x',2),null);
  assert.equal(lucideSvg(svg,'#000000',Infinity),null);
  assert.equal(lucideSvg(svg,'#000000',5),null);
});
