const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

async function desktop(platform = "darwin", lock = true, ready = true, argv = [], env = {}) {
  const app = new EventEmitter();
  const paths = {};
  Object.assign(app, {
    setPath(name, value) { paths[name] = value; }, getPath: () => "/tmp", getLocale: () => "zh-CN", isPackaged: true,
    requestSingleInstanceLock: () => lock, whenReady: () => Promise.resolve(), isReady: () => true,
    setAsDefaultProtocolClient(scheme) { this.protocol = scheme; },
    quit() { this.quitCalled = true; this.emit("before-quit", { preventDefault() {} }); },
    relaunch() { this.relaunched = true; }, exit() { this.exited = true; },
  });
  const windows = [], launches = [], menus = [], stages = [], handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.mainFrame = { url: "http://127.0.0.1:9876/" };
      this.webContents.isDestroyed = () => false;
      this.webContents.send = channel => { queueMicrotask(() => ipcMain.emit("easyread:page-saved", { sender: this.webContents, senderFrame: this.webContents.mainFrame })); };
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(w => !w.closed); }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    setTitle(title) { this.title = title; }
    focus() { this.focused = true; }
    isMinimized() { return false; }
    close() { this.closed = true; this.emit("closed"); }
  }
  const Menu = {
    buildFromTemplate(items) { return { items, popup() { menus.push(items); } }; },
    setApplicationMenu(menu) { app.menu = menu; },
  };
  const childProcess = {
    execFileSync: () => "__PATH__/usr/bin:/bin__PATH__",
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit("exit", 0, "SIGTERM"); };
      launches.push({ command, args, options, child });
      if (ready) queueMicrotask(() => child.stdout.emit("data", "PaperRead 已啟動：http://127.0.0.1:9876\n"));
      return child;
    },
  };
  const proc = new EventEmitter();
  Object.assign(proc, { platform, env, resourcesPath: "/tmp/Resources", argv: ["EasyRead.exe", ...argv] });
  const fakeRequire = name => name === "electron" ? { app, BrowserWindow: Window, Menu, ipcMain, dialog: { showErrorBox() {}, showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/chosen"] }) }, shell: {} }
    : name === "child_process" ? childProcess : name === "fs" ? { existsSync: () => true }
    : name === "http" ? { request(url, options, callback) {
      const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; callback(res);
        res.emit("data", JSON.stringify(url.pathname === "/api/library" ? { token: "test-token" } : { ok: true }));
        res.emit("end");
        if (url.pathname === "/api/shutdown") launches[launches.length - 1].child.kill();
      }); return req;
    } }
    : name === "./startup-feedback.cjs" ? { ...require("../electron/startup-feedback.cjs"), mark(_app, stage) { stages.push(stage); }, loginShellPath: async () => "/usr/bin:/bin" }
    : name === "./desktop-updates.cjs" ? { registerUpdates() {} }
    : name === "./deep-link.cjs" ? require("../electron/deep-link.cjs")
    : name === "./test-profile.cjs" ? require("../electron/test-profile.cjs")
    : name === "electron-updater" ? { autoUpdater: {} }
    : name === "./window-state.cjs" ? { options: () => ({ opts: { width: 1440, height: 960 }, maximized: false }), track() {} }
    : require(name);
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  vm.runInNewContext(source, { require: fakeRequire, process: proc, __dirname: "/tmp/electron", setTimeout, clearTimeout, console });
  const settled = async () => {
    // createWindow awaits several microtask turns: loading screen, backend
    // readiness, and the final navigation.  Drain them so assertions observe
    // the same stable state on every runner.
    for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  await settled();
  return { app, windows, launches, menus, handlers, stages, settled, paths };
}

test("isolated desktop restarts reuse the same profile and leave saved model settings intact", async () => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paperread-model-profile-'));
  try {
    const profile = path.join(base, 'review');
    fs.mkdirSync(path.join(profile, 'home'), { recursive: true });
    const configPath = path.join(profile, 'home', 'config.json');
    const saved = JSON.stringify({ engine: 'codex', codex: { model: 'gpt-6.1-sol' }, chat: { default: 'sonnet' } });
    fs.writeFileSync(configPath, saved);
    for (let launch = 0; launch < 2; launch++) {
      const d = await desktop('win32', true, true, [], { PAPERREAD_TEST_PROFILE: profile, EASYREAD_HOME: 'unused' });
      try {
        const env = d.launches[0].options.env;
        assert.equal(d.paths.userData, path.join(profile, 'desktop'));
        assert.equal(env.EASYREAD_HOME, path.join(profile, 'home'));
        assert.equal(env.EASYREAD_LIBRARY, path.join(profile, 'library'));
        assert.equal(env.PAPERREAD_OFFLINE_TEST, '1');
        assert.equal(env.PAPERREAD_REVIEW_MODE, 'Mock');
        let prevented = false;
        d.windows[0].webContents.emit('page-title-updated', { preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.match(d.windows[0].title, /Mock.*blocked/);
        assert.equal(fs.readFileSync(configPath, 'utf8'), saved);
      } finally { d.app.quit(); await d.settled(); }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Gemini result desktop denies folder picking and file export while preserving offline backend', async () => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paperread-gemini-desktop-'));
  const d = await desktop('win32', true, true, [], { PAPERREAD_TEST_PROFILE: base, PAPERREAD_REVIEW_KIND: 'GeminiResults' });
  try {
    assert.equal(d.launches[0].options.env.PAPERREAD_REVIEW_MODE, 'Mock');
    const contents = d.windows[0].webContents, event = { sender: contents, senderFrame: contents.mainFrame };
    await assert.rejects(d.handlers.get('easyread:pick-folder')(event), /disabled/);
    await assert.rejects(d.handlers.get('easyread:save-file')(event), /disabled/);
    contents.emit('page-title-updated', { preventDefault() {} });
    assert.match(d.windows[0].title, /Gemini results.*Mock.*blocked/);
  } finally { d.app.quit(); await d.settled(); fs.rmSync(base, { recursive: true, force: true }); }
});

test("macOS keeps native editing roles and offers input context actions", async () => {
  const d = await desktop();
  assert.deepEqual(Array.from(d.app.menu.items, x => x.role), ["appMenu", "editMenu", "windowMenu"]);
  d.windows[0].webContents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: { canPaste: true } });
  assert.ok(d.menus[0].some(x => x.role === "paste" && x.enabled));
  d.app.quit();
});

test("reopening a macOS window reuses one backend, even during repeated activation", async () => {
  const d = await desktop();
  d.windows[0].close();
  d.app.emit("activate"); d.app.emit("activate");
  await d.settled();
  assert.equal(d.launches.length, 1);
  assert.equal(d.windows.length, 2);
  d.app.emit("second-instance");
  assert.equal(d.windows[1].focused, true);
  d.app.quit();
  await d.settled();
  assert.equal(d.launches[0].child.killed, true);
});

test("a second app instance exits before starting a backend", async () => {
  const d = await desktop("darwin", false);
  assert.equal(d.app.quitCalled, true);
  assert.equal(d.launches.length, 0);
});

test("Windows retains its existing menu behavior", async () => {
  const d = await desktop("win32");
  assert.equal(d.app.menu, null);
  d.app.quit();
});

test("the startup window is visible while the backend is still starting", async () => {
  const d = await desktop("darwin", true, false);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].shown, true);
  assert.match(d.windows[0].url, /^data:text\/html/);
  assert.ok(d.stages.indexOf("startup-window-visible") < d.stages.indexOf("backend-spawn"));
  d.launches[0].child.stdout.emit("data", "PaperRead 已啟動：http://127.0.0.1:9876\n");
  await d.settled();
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  assert.ok(d.stages.includes("library-loaded"));
  d.app.quit(); await d.settled();
});

test("login shell discovery yields without blocking and tolerates shell errors", async () => {
  const { loginShellPath } = require("../electron/startup-feedback.cjs");
  let callback;
  const pending = loginShellPath("darwin", "/bin/zsh", (_shell, _args, options, done) => {
    assert.equal(options.timeout, 5000); callback = done;
  });
  assert.ok(pending instanceof Promise);
  callback(null, "noise\n__PATH__/usr/local/bin:/usr/bin__PATH__\n");
  assert.equal(await pending, "/usr/local/bin:/usr/bin");
  assert.equal(await loginShellPath("darwin", "/bin/zsh", (_s, _a, _o, done) => done(new Error("timeout"))), "");
  assert.equal(await loginShellPath("win32", "", () => { throw new Error("unexpected shell"); }), "");
});


test("cloud library IPC restricts folder picking and relaunch to the local main frame", async () => {
  const d = await desktop();
  const sender = d.windows[0].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(await d.handlers.get("easyread:pick-folder")(event), "/tmp/chosen");
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender, senderFrame: { url: "https://example.com" } }), /Untrusted/);
  await d.handlers.get("easyread:relaunch")(event);
  assert.equal(d.launches[0].child.killed, true);
  assert.equal(d.app.relaunched, true);
  assert.equal(d.app.exited, true);
});

const SHA = "a".repeat(64);

test("paper links open the paper once the backend is ready", async () => {
  const d = await desktop("win32", true, true, [`easyread://open?sha256=${SHA}&block=p3-2`]);
  await d.settled();
  assert.equal(d.app.protocol, "paperread");
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}&block=p3-2`);
  d.app.quit();
});

test("a link from a second instance reuses the open window", async () => {
  const d = await desktop("win32");
  await d.settled();
  d.app.emit("second-instance", {}, ["EasyRead.exe", "easyread://open?id=abc123def456"]);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/open?id=abc123def456");
  assert.equal(d.windows[0].focused, true);
  d.app.quit();
});

test("macOS open-url links are handled and unknown links ignored", async () => {
  const d = await desktop();
  await d.settled();
  d.app.emit("open-url", { preventDefault() {} }, "easyread://other?id=abc123def456");
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  d.app.emit("open-url", { preventDefault() {} }, `easyread://open?sha256=${SHA}&block=<x>`);
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}`);
  d.app.quit();
});
