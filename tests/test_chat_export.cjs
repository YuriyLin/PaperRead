const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('chat export invokes API, saveBase64, and toggles button disabled', async () => {
  let apiCalls = [];
  let savedFiles = [];
  let toasted = [];
  const fakeButton = { disabled: false };

  const PR = {
    pid: 'test_paper',
    t: (s, p) => p ? s.replace(/\{(\w+)\}/g, (_, k) => p[k]) : s,
    api: async (url, opts) => {
      apiCalls.push({ url, opts });
      return {
        filename: 'test-paper-answer.md',
        mime: 'text/markdown;charset=utf-8',
        data: Buffer.from('# Question\n\n## Answer').toString('base64')
      };
    },
    saveBase64: async (filename, data, filters) => {
      savedFiles.push({ filename, data, filters });
      return true;
    },
    toast: (msg) => { toasted.push(msg); }
  };

  const code = fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/chat-export.js'), 'utf8');
  const context = { window: { PR }, Uint8Array, atob: (str) => Buffer.from(str, 'base64').toString('binary') };
  vm.createContext(context);
  vm.runInContext(code, context);

  await PR.exportChatMarkdown('thread_123', 'msg_456', fakeButton);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, '/api/p/test_paper/chat-export');
  assert.equal(apiCalls[0].opts.body.thread, 'thread_123');
  assert.equal(apiCalls[0].opts.body.id, 'msg_456');

  assert.equal(savedFiles.length, 1);
  assert.equal(savedFiles[0].filename, 'test-paper-answer.md');
  assert.equal(savedFiles[0].filters[0].extensions[0], 'md');

  assert.equal(fakeButton.disabled, false);
  assert.equal(toasted.length, 1);
  assert.match(toasted[0], /test-paper-answer\.md/);
});

test('chat export handles error gracefully and restores button state', async () => {
  let toasted = [];
  const fakeButton = { disabled: false };

  const PR = {
    pid: 'test_paper',
    t: (s, p) => p ? s.replace(/\{(\w+)\}/g, (_, k) => p[k]) : s,
    api: async () => {
      throw new Error('Network error');
    },
    saveBase64: async () => true,
    toast: (msg) => { toasted.push(msg); }
  };

  const code = fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/chat-export.js'), 'utf8');
  const context = { window: { PR }, Uint8Array, atob: (str) => Buffer.from(str, 'base64').toString('binary') };
  vm.createContext(context);
  vm.runInContext(code, context);

  await PR.exportChatMarkdown('thread_123', 'msg_456', fakeButton);

  assert.equal(fakeButton.disabled, false);
  assert.equal(toasted.length, 1);
  assert.match(toasted[0], /Network error/);
});

test('exportChatObsidian checks unconfigured vault, runs setup, and exports to 03-閱讀標註/<paper>/單則回答', async () => {
  let apiCalls = [];
  let toasted = [];
  const fakeButton = { disabled: false, innerHTML: 'Export' };

  let configured = false;
  const PR = {
    pid: 'p123',
    state: {
      paper: {
        meta: {
          title_zh: '測試論文標題',
          title_en: 'Test Paper Title'
        }
      }
    },
    t: (s, p) => p ? s.replace(/\{(\w+)\}/g, (_, k) => p[k]) : s,
    api: async (url, opts = {}) => {
      apiCalls.push({ url, opts });
      if (url === '/api/research/v1/status') {
        return { configured };
      }
      if (url === '/api/research/v1/setup') {
        configured = true;
        return { ok: true };
      }
      if (url === '/api/p/p123/chat-export') {
        return {
          filename: 'Test-Paper-Answer.md',
          stem: 'Test-Paper-Answer',
          subject: '測試問題主題',
          markdown: '# 測試問題主題\n\n內容',
          attachments: [{ filename: 'assets/fig1.png', content_base64: 'FAKE' }]
        };
      }
      if (url === '/api/research/v2/export/obsidian') {
        return { written: ['Research/03-閱讀標註/測試論文標題/單則回答/Test-Paper-Answer.md'], updated: [], conflicts: [] };
      }
      return {};
    },
    toast: (msg) => { toasted.push(msg); }
  };

  const context = {
    window: {
      PR,
      easyreadDesktop: {
        pickFolder: async () => 'C:\\Vault'
      }
    },
    Uint8Array,
    atob: (str) => Buffer.from(str, 'base64').toString('binary')
  };

  const code = fs.readFileSync(path.join(__dirname, '../easyread/web/js/reader/chat-export.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context);

  await PR.exportChatObsidian('t1', 'm1', fakeButton);

  // Check API calls: status check, setup, chat-export, and export/obsidian
  assert.equal(apiCalls.length, 4);
  assert.equal(apiCalls[0].url, '/api/research/v1/status');
  assert.equal(apiCalls[1].url, '/api/research/v1/setup');
  assert.equal(apiCalls[1].opts.body.vault, 'C:\\Vault');
  assert.equal(apiCalls[2].url, '/api/p/p123/chat-export');
  assert.equal(apiCalls[3].url, '/api/research/v2/export/obsidian');

  const exportedDoc = apiCalls[3].opts.body.documents[0];
  assert.equal(exportedDoc.id, 'paper:p123:chat:m1');
  assert.equal(exportedDoc.kind, 'annotations');
  assert.equal(exportedDoc.subfolder, '測試論文標題/單則回答');
  assert.equal(exportedDoc.filename, 'Test-Paper-Answer');
  assert.equal(exportedDoc.attachments.length, 1);
  assert.equal(fakeButton.disabled, false);
  assert.ok(toasted.some(t => t.includes('已連結 Obsidian Vault')));
  assert.ok(toasted.some(t => t.includes('已匯出單則回答至 Obsidian Vault')));
});
