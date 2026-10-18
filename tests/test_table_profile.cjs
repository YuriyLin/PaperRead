const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { testProfile } = require('../electron/test-profile.cjs');

test('review profile requires explicit absolute opt-in and overrides backend data paths', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paperread-profile-'));
  try {
    const appData = path.join(base, 'appdata'), home = path.join(base, 'user');
    assert.equal(testProfile({}, appData, home), null);
    assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: 'relative' }, appData, home), /absolute/);
    const root = path.join(base, 'review');
    const result = testProfile({ PAPERREAD_TEST_PROFILE: root, EASYREAD_HOME: 'do not use' }, appData, home);
    assert.equal(result.userData, path.join(root, 'desktop'));
    assert.equal(result.env.EASYREAD_HOME, path.join(root, 'home'));
    assert.equal(result.env.EASYREAD_LIBRARY, path.join(root, 'library'));
    assert.equal(result.env.PAPERREAD_OFFLINE_TEST, '1');
    assert.equal(fs.existsSync(root), false);
    for (const reserved of [appData, path.join(appData, 'PaperRead'), path.join(appData, 'EasyRead', 'child'), home, path.join(home, 'PaperRead'), path.parse(base).root]) {
      assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: reserved }, appData, home), /separate/);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('review profile resolves existing junctions before accepting isolation', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paperread-profile-'));
  try {
    const formal = path.join(base, 'appdata', 'PaperRead'); fs.mkdirSync(formal, { recursive: true });
    const link = path.join(base, 'alias'); fs.symlinkSync(formal, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: path.join(link, 'child') }, path.join(base, 'appdata'), path.join(base, 'user')), /separate/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('real and unknown modes fail closed before profile creation or fallback', () => {
  const root = path.join(os.tmpdir(), 'paperread-mode-must-not-create-' + process.pid);
  for (const mode of ['RealModelValidation', 'real', 'unknown']) {
    assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: root, PAPERREAD_REVIEW_MODE: mode,
      PAPERREAD_OFFLINE_TEST: '0' }, os.tmpdir()), /blocked/);
    assert.equal(fs.existsSync(root), false);
  }
  assert.throws(() => testProfile({ PAPERREAD_REVIEW_MODE: 'Mock' }, os.tmpdir()), /requires/);
});

test('review profile rejects redirected data directories, including a test Vault', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paperread-children-'));
  try {
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    for (const area of ['home', 'library', 'desktop', 'vault']) {
      const root = path.join(base, area); fs.mkdirSync(root);
      fs.symlinkSync(outside, path.join(root, area), process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: root }, path.join(base, 'appdata'), path.join(base, 'user')), /redirect/);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Gemini results retain Mock mode and never create real model authority', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paperread-gemini-profile-'));
  try {
    const result = testProfile({ PAPERREAD_TEST_PROFILE: path.join(base, 'results'), PAPERREAD_REVIEW_KIND: 'GeminiResults' },
      path.join(base, 'appdata'), path.join(base, 'user'));
    assert.equal(result.kind, 'GeminiResults');
    assert.equal(result.env.PAPERREAD_REVIEW_MODE, 'Mock');
    assert.equal(result.env.PAPERREAD_OFFLINE_TEST, '1');
    assert.throws(() => testProfile({ PAPERREAD_TEST_PROFILE: base, PAPERREAD_REVIEW_MODE: 'GeminiValidation' }, base), /blocked/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
