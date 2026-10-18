const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const windowState = require("./window-state.cjs");
const { URL } = require("url");
const http = require("http");
const startup = require("./startup-feedback.cjs");
const { registerUpdates } = require("./desktop-updates.cjs");
const deepLink = require("./deep-link.cjs");

// 新版使用 PaperRead 資料夾；第一次升級時把舊版 EasyRead 的桌面偏好
// 搬到新位置，避免改名後像是全新安裝。搬移失敗時保留舊資料，不覆蓋任何內容。
const appData = app.getPath("appData");
const reviewProfile = (process.env.PAPERREAD_TEST_PROFILE || process.env.PAPERREAD_REVIEW_MODE) ? require("./test-profile.cjs").testProfile(process.env, appData) : null;
const paperReadUserData = path.join(appData, "PaperRead");
const legacyUserData = path.join(appData, "EasyRead");
if (!reviewProfile && !fs.existsSync(paperReadUserData) && fs.existsSync(legacyUserData)) {
  try { fs.renameSync(legacyUserData, paperReadUserData); } catch (_) { /* legacy data remains recoverable */ }
}
app.setPath("userData", reviewProfile ? reviewProfile.userData : paperReadUserData);
startup.mark(app, "electron-entry");

// 桌面版自己的幾句報錯跟系統語言走（介面語言由後端決定，見 easyread/i18n.py）
const isZh = () => true; // PaperRead desktop defaults to Traditional Chinese.
let backend;
let mainWindow;
let backendReady;
let windowOpening = false;
let backendUrl;
let quitting = false;
let pendingOpen = deepLink.fromArgv(process.argv);

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function packagedBackend() {
  const name = process.platform === "win32" ? "easyread-backend.exe" : "easyread-backend";
  return path.join(process.resourcesPath, "backend", name);
}

function backendCommand() {
  if (app.isPackaged) {
    const executable = packagedBackend();
    if (!fs.existsSync(executable)) {
      throw new Error(isZh() ? `找不到打包後的 PaperRead 後端：${executable}` : `Bundled PaperRead backend not found: ${executable}`);
    }
    return { command: executable, args: ["serve", "--port", "0"], cwd: os.homedir() };
  }

  const root = projectRoot();
  const python = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  const command = fs.existsSync(python) ? python : (process.platform === "win32" ? "python" : "python3");
  return { command, args: ["-m", "easyread", "serve", "--port", "0"], cwd: root };
}

// macOS / Linux 從啟動臺、桌面圖示開啟時，拿不到終端裡配的 PATH（Homebrew、npm 全域性目錄），
// 後端會找不到 claude / codex。向使用者的登入 shell 要一份 PATH 補上。
function startBackend() {
  // On macOS an app can stay alive after its last window closes. Reopening
  // the window must reuse that backend, rather than orphaning the old one.
  if (backendReady) return backendReady;
  backendReady = (async () => {
  const launch = backendCommand();
  const env = { ...process.env, ...(reviewProfile ? reviewProfile.env : {}), PYTHONUTF8: "1", EASYREAD_SYSTEM_LANG: app.getLocale() };  // 後端按它決定介面語言
  startup.mark(app, "shell-path-start");
  const shellPath = await startup.loginShellPath(process.platform);
  startup.mark(app, "shell-path-ready");
  if (quitting) throw new Error(isZh() ? "啟動已取消" : "Startup cancelled");
  if (shellPath) {
    env.PATH = [...new Set([...shellPath.split(":"), ...(env.PATH || "").split(":")].filter(Boolean))].join(":");
  }
  if (process.platform !== "win32") {
    const fallback = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    env.PATH = [...new Set([...(env.PATH || "").split(":"), ...fallback.filter(p => fs.existsSync(p))].filter(Boolean))].join(":");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error((isZh() ? "PaperRead 後端啟動超時。" : "PaperRead backend timed out while starting. ") + output.slice(-500)));
      stopBackend();
    }, 30000);

    startup.mark(app, "backend-spawn");
    backend = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.match(/PaperRead\s+已(?:启动|啟動)：\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) { startup.mark(app, "backend-http-ready"); backendUrl = match[1]; finish(resolve, match[1]); }
    });
    backend.stderr.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
    });
    backend.once("error", (error) => finish(reject, error));
    backend.once("exit", (code, signal) => {
      if (!settled) finish(reject, new Error((isZh() ? `PaperRead 後端退出（code=${code}, signal=${signal}）。` : `PaperRead backend exited (code=${code}, signal=${signal}). `) + output.slice(-500)));
      backend = undefined;
      backendReady = undefined;
      backendUrl = undefined;
    });
  });
  })();
  backendReady.catch(() => { backendReady = undefined; });
  return backendReady;
}

function backendJson(endpoint, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(endpoint, backendUrl), {
      method: token ? "POST" : "GET",
      headers: token ? { "X-Token": token, "Content-Type": "application/json", "Content-Length": 2 } : {},
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", part => { body += part; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(isZh() ? "後端關閉超時，請稍後重試" : "Backend shutdown timed out. Try again later.")));
    req.on("error", reject);
    req.end(token ? "{}" : undefined);
  });
}

async function stopBackendGracefully() {
  const child = backend;
  if (!child) return;
  const info = await backendJson("/api/library");
  await backendJson("/api/shutdown", info.token);
  // 後端清掉佔用標記、關閉 HTTP 服務後才啟動新程序。
  if (backend !== child) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", exited); reject(new Error(isZh() ? "後端尚未退出，請稍後重試" : "The backend has not exited yet. Try again later.")); }, 8000);
    function exited() { clearTimeout(timer); resolve(); }
    child.once("exit", exited);
  });
}

/* 退出前先让页面把没落盘的东西写回去再停后端；页面没应就照常退出 */
function savePageState() {
  const wc = mainWindow && mainWindow.webContents;
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed()) || typeof wc.send !== "function") return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    function done() {
      clearTimeout(timer);
      if (ipcMain && typeof ipcMain.removeListener === "function") {
        ipcMain.removeListener("easyread:page-saved", saved);
      }
      resolve();
    }
    function saved(event) {
      if (event && event.sender === wc && event.senderFrame === wc.mainFrame) done();
    }
    timer = setTimeout(done, 1200);
    if (ipcMain && typeof ipcMain.on === "function") {
      ipcMain.on("easyread:page-saved", saved);
    }
    try {
      wc.send("easyread:before-quit");
    } catch {
      done();
    }
  });
}

function trustedWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      !backendUrl || new URL(event.senderFrame.url).origin !== backendUrl) {
    throw new Error("Untrusted IPC sender");
  }
}

ipcMain.handle("easyread:pick-folder", async event => {
  trustedWindow(event);
  if (reviewProfile?.kind === "GeminiResults") throw new Error("Folder access is disabled in the Gemini result viewer");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] || null;
});
ipcMain.handle("easyread:save-file", async (event, options = {}) => {
  trustedWindow(event);
  if (reviewProfile?.kind === "GeminiResults") throw new Error("External file export is disabled in the Gemini result viewer");
  const filename = typeof options.filename === "string" && options.filename.trim() ? options.filename.trim() : "PaperRead-export.md";
  const encoded = typeof options.contentBase64 === "string" ? options.contentBase64 : "";
  if (!encoded || encoded.length > 160 * 1024 * 1024) throw new Error("匯出內容無效或過大");
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: Array.isArray(options.filters) && options.filters.length ? options.filters : [{ name: "All files", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, Buffer.from(encoded, "base64"));
  return { canceled: false, path: result.filePath };
});
ipcMain.handle("easyread:relaunch", async event => {
  trustedWindow(event);
  await stopBackendGracefully();
  app.relaunch();
  app.exit(0);
});

function stopBackend() {
  backendReady = undefined;
  if (backend && !backend.killed) {
    if (process.platform === "win32") {
      // PyInstaller's one-file launcher creates a child process. Killing only
      // the launcher would leave the local HTTP service running after exit.
      try {
        execFileSync("taskkill", ["/pid", String(backend.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (_) {
        // The process may already have exited while the window was closing.
      }
    } else {
      backend.kill();
    }
    backend = undefined;
  }
}

// 視窗還在啟動時先記下，後端就緒後 createWindow 直接開啟這篇
function openLink(target) {
  if (!target) return;
  if (!mainWindow || windowOpening || !backendUrl) {
    pendingOpen = target;
    if (!mainWindow && app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.loadURL(new URL(target, backendUrl).href);
}

async function createWindow() {
  if (windowOpening || mainWindow) return;
  windowOpening = true;
  const state = windowState.options();
  mainWindow = new BrowserWindow({
    ...state.opts,
    minWidth: 960,
    minHeight: 680,
    icon: path.join(__dirname, "assets", "paperread.ico"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  if (reviewProfile) {
    mainWindow.webContents.on("page-title-updated", event => {
      event.preventDefault();
      mainWindow.setTitle(reviewProfile.kind === "GeminiResults"
        ? "PaperRead [Gemini results / Mock — real models blocked]" : "PaperRead [Mock — real models blocked]");
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (reviewProfile?.kind === "GeminiResults") return { action: "deny" };
    if (/^https?:/i.test(target)) shell.openExternal(target);
    if (/^obsidian:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  // A native context menu is separate from the application Edit menu.
  // Electron does not emit this event when the page prevents contextmenu,
  // so the library's and reader's custom menus keep working.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags || {};
    const items = params.isEditable
      ? [{ role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo },
         { type: "separator" }, { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy },
         { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll" }]
      : params.selectionText.trim() ? [{ role: "copy" }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  windowState.track(mainWindow);
  const openingWindow = mainWindow;
  mainWindow.once("ready-to-show", () => {
    if (mainWindow !== openingWindow) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
  });
  mainWindow.on("close", event => {
    if (process.platform !== "darwin" && !quitting && backend) {
      event.preventDefault();
      app.quit();  // before-quit saves while the renderer is still alive.
    }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  try {
    await openingWindow.loadURL(startup.loadingUrl(isZh()));
    if (mainWindow !== openingWindow || quitting) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
    startup.mark(app, "startup-window-visible");
    const url = await startBackend();
    if (mainWindow !== openingWindow || quitting) return;
    const first = pendingOpen ? new URL(pendingOpen, url).href : url;
    pendingOpen = undefined;
    await openingWindow.loadURL(first);
    startup.mark(app, "library-loaded");
  } catch (error) {
    if (mainWindow !== openingWindow || quitting) return;
    startup.mark(app, "startup-failed");
    dialog.showErrorBox(isZh() ? "PaperRead 啟動失敗" : "PaperRead failed to start", error.message);
    app.quit();
  } finally {
    windowOpening = false;
    // 載入文獻庫期間又點了 easyread:// 連結，openLink 只記下了它，這裡補開
    if (pendingOpen && mainWindow === openingWindow && !quitting) openLink(pendingOpen);
  }
}

// Keep the web application's own header at the top of the content area. The
// default Electron File/Edit/View/Window strip would otherwise create a second
// toolbar row above it. The macOS menu is at the top of the screen and
// its Edit roles provide Cmd+C/V/X/A/Z.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  // macOS 用 open-url 傳連結，可能早於 ready
  app.on("open-url", (event, link) => {
    event.preventDefault();
    openLink(deepLink.openPath(link));
  });
  app.whenReady().then(() => {
    if (!reviewProfile) deepLink.register(app, process);
    registerUpdates({
      app, ipcMain, updater: require("electron-updater").autoUpdater, trustedWindow,
      repository: reviewProfile ? "" : process.env.EASYREAD_UPDATE_REPOSITORY || "",
      getWindow: () => mainWindow,
      prepareInstall: stopBackendGracefully,
      recover: async () => {
        if (backend) return;  // 後端沒停（正在翻譯、拒絕關閉）：頁面別重新整理，彈窗留著顯示原因
        const url = await startBackend();
        if (mainWindow) await mainWindow.loadURL(url);
      },
    });
    return createWindow();
  });
  app.on("before-quit", event => {
    if (quitting) return;
    quitting = true;
    if (!backend) return;
    event.preventDefault();
    savePageState().then(stopBackendGracefully).catch(stopBackend).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("second-instance", (_event, argv) => {
    const target = deepLink.fromArgv(argv);
    if (target) return void openLink(target);
    if (!mainWindow) return void createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  process.on("exit", stopBackend);
}
