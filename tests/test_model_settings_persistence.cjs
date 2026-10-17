const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const clone = value => JSON.parse(JSON.stringify(value));
function settings(overrides = {}) {
  let config = { engine: 'claude', claude: { model: 'opus' }, codex: {}, openai: {}, page_cap: 100, auto_translate: false, ...overrides };
  let chat = { default: 'sonnet', models: [
    { id: 'opus', name: 'Claude Opus', engine: 'claude', model: 'opus', ready: false, hint: 'Claude missing' },
    { id: 'sonnet', name: 'Claude Sonnet', engine: 'claude', model: 'sonnet', ready: false },
    { id: 'gpt', name: 'GPT-6.1-Sol', engine: 'codex', model: 'gpt-6.1-sol', ready: true, reasoning_effort: 'high', service_tier: 'fast' },
  ] };
  const classes = new Set(), events = {}, posts = [], toasts = [];
  const dialog = { innerHTML: '' };
  const status = { dataset: {} };
  const dlg = { querySelector: () => dialog, addEventListener: (name, fn) => { events[name] = fn; },
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } };
  let menu, hold, fail;
  const PR = {
    t: (key, args = {}) => key.replace(/\{(\w+)\}/g, (_, k) => args[k] ?? k), esc: String, icon: () => '',
    $: selector => selector === '#settingsDlg' ? dlg : selector === '#modelSaveStatus' ? status : null,
    $$: () => [], features: {}, keymap: {}, ls: { get: (_key, fallback) => fallback }, emit() {},
    toast: message => toasts.push(message), menu: (_button, items) => { menu = items; },
    async api(url, options) {
      if (options?.method === 'POST') {
        const body = clone(options.body); posts.push({ url, body });
        if (hold) { const gate = hold; hold = null; await gate; }
        if (fail === url) { fail = null; throw new Error('mock disk failure'); }
        if (url === '/api/config') { config = { ...config, ...body }; return { config: clone(config) }; }
        if (url === '/api/chat/models') { chat = { models: body.models, default: body.default }; return clone(chat); }
        throw new Error('Unexpected POST: ' + url);
      }
      if (url === '/api/config') return { config: clone(config), presets: [] };
      if (url === '/api/chat/models') return clone(chat);
      if (url === '/api/engines') return { found: { claude: { found: false }, codex: { found: true } },
        models: { claude: { models: [{ id: 'opus' }, { id: 'sonnet' }] },
          codex: { default: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }] } } };
      throw new Error('Unexpected GET: ' + url);
    },
  };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {} };
  for (const file of ['settings.js', 'settings-models.js', 'settings-chat.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../easyread/web/js/common', file), 'utf8'), context);
  }
  const choose = async (id, label = '设为翻译') => {
    const index = PR.settingsState.chat.models.findIndex(m => m.id === id);
    const button = { dataset: { cm: 'more', i: String(index) } };
    await PR.settingsTabs.chat.click({ target: { closest: selector => selector === '[data-cm]' ? button : null } }, PR.settingsState);
    const action = menu.find(item => item.label === label);
    assert.ok(action && !action.disabled, 'Card action is enabled');
    action.fn();
  };
  return { PR, posts, toasts, choose, dialog, events, dlg,
    holdNext: promise => { hold = promise; }, failNext: url => { fail = url; },
    saved: () => clone({ config, chat }) };
}

test('Codex translation card saves and survives closing/reopening without changing Ask AI default', async () => {
  const h = settings();
  await h.PR.openSettings();
  await h.choose('gpt');
  h.events.click({ target: { closest: selector => selector === '#setCancel' } });
  assert.equal(h.dlg.classList.contains('open'), false);
  await h.PR.openSettings();
  assert.equal(h.PR.settingsState.cfg.engine, 'codex');
  assert.equal(h.PR.settingsState.cfg.codex.model, 'gpt-6.1-sol');
  assert.equal(h.PR.settingsState.cfg.codex.reasoning_effort, 'high');
  assert.equal(h.PR.settingsState.cfg.codex.service_tier, 'fast');
  assert.equal(h.PR.settingsState.chat.default, 'sonnet');
  assert.deepEqual(h.saved().chat.models.map(m => m.id), ['opus', 'sonnet', 'gpt']);
  assert.match(h.dialog.innerHTML, /翻译：GPT-6.1-Sol/);
  assert.deepEqual(h.posts.map(p => p.url), ['/api/chat/models', '/api/config']);
  assert.equal(h.toasts.length, 0);
});

test('Mock settings preserve none and show the backend prohibition without creating a Claude selection', async () => {
  const h = settings({ engine: 'none', review_policy: { mode: 'Mock', real_model_allowed: false, reason: 'Real models blocked' } });
  await h.PR.openSettings();
  assert.equal(h.PR.settingsState.cfg.engine, 'none');
  assert.equal(h.saved().config.engine, 'none');
  assert.equal(h.posts.length, 0);
  assert.match(h.dialog.innerHTML, /Mock.*Real models blocked/);
});

test('queued saves keep snapshots in order and reopening waits for the final selection', async () => {
  const h = settings();
  await h.PR.openSettings();
  let release;
  h.holdNext(new Promise(resolve => { release = resolve; }));
  await h.choose('gpt');
  await h.choose('opus');
  await h.choose('gpt');
  let reopened = false;
  const opening = h.PR.openSettings().then(() => { reopened = true; });
  await Promise.resolve();
  assert.equal(reopened, false);
  release();
  await opening;
  assert.deepEqual(h.posts.filter(p => p.url === '/api/config').map(p => p.body.engine), ['codex', 'claude', 'codex']);
  assert.equal(h.saved().config.engine, 'codex');
  assert.equal(h.PR.settingsState.cfg.engine, 'codex');
  assert.equal(h.saved().chat.default, 'sonnet');
});

test('a failed save reports an error and the next save can recover', async () => {
  const h = settings();
  await h.PR.openSettings();
  h.failNext('/api/config');
  await h.choose('gpt');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /mock disk failure/);
  assert.equal(h.PR.settingsState.modelSavePhase, 'error');
  assert.equal(h.saved().config.engine, 'claude');
  await h.PR.saveModelSettings();
  assert.equal(h.saved().config.engine, 'codex');
  assert.equal(h.PR.settingsState.modelSavePhase, 'saved');
});
