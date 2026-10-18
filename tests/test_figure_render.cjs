const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function reader(block, edits = {}) {
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits }, paper: { blocks: [block] } },
    // common/util.js supplies this in the reader; figures have no reading-table text nodes.
    $$: () => [],
    on() {}, emit() {}, esc: String, md: String, t: s => s, imageUrl: s => '/p/test/' + s, hashText: s => s,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/render.js'), 'utf8'), {
    window: { PR }, document: {
      getElementById: () => node,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
    },
  });
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  return { PR, html };
}

test('read-first figure keeps a clickable original-page placeholder', () => {
  const { PR, html } = reader({ id: 'fig1', type: 'figure', src: 'figures/a.webp', image_en: 'Accuracy', caption_en: 'Figure 1' });
  assert.match(html, /class="fig-placeholder"/);
  assert.match(html, /圖表保留於原文/);
  assert.doesNotMatch(html, /src="/);
  assert.doesNotMatch(html, /Accuracy/);
  assert.equal(PR.hasZh(PR.blockById.fig1), false);
});

test('translated figure does not render image text or reader edits', () => {
  const { PR, html } = reader({ id: 'fig1', type: 'figure', image_en: 'Accuracy', image_zh: 'translated', caption_en: 'Figure 1' }, {
    'fig1#image': { zh: 'my wording', base: 'old translation' },
  });
  assert.match(html, /class="fig-placeholder"/);
  assert.doesNotMatch(html, /Accuracy|translated|my wording|stale-tag/);
  assert.deepEqual(Array.from(PR.blockKeys(PR.blockById.fig1)), ['fig1#caption']);
});

test('legacy figure without image text retains its page placeholder', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', page: 2, caption_zh: 'caption' });
  assert.match(html, /fig-placeholder/);
  assert.match(html, /第 \{n\} 頁/);
  assert.doesNotMatch(html, /figure-translation/);
});
