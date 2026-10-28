const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke("easyread:pick-folder"),
  saveFile: (options) => ipcRenderer.invoke("easyread:save-file", options),
  relaunch: () => ipcRenderer.invoke("easyread:relaunch"),
  updateState: () => ipcRenderer.invoke("easyread:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("easyread:update-download"),
  installUpdate: () => ipcRenderer.invoke("easyread:update-install"),
  openDetachedWindow: (token, bounds) => ipcRenderer.invoke("easyread:detach-window", token, bounds),
  closeCurrentWindow: () => ipcRenderer.invoke("easyread:close-current-window"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("easyread:update-state", listener);
    return () => ipcRenderer.removeListener("easyread:update-state", listener);
  },
  /* 退出软件前来一下：页面写完回一声，主进程才停后端（见 main.cjs） */
  onBeforeQuit: (callback) => {
    const listener = async () => {
      try {
        const result = await callback();
        const ok = result !== false && !(Array.isArray(result) && result.some(value => value === false));
        ipcRenderer.send("easyread:page-saved", { ok });
      } catch (error) {
        ipcRenderer.send("easyread:page-saved", { ok: false, error: error.message });
      }
    };
    ipcRenderer.on("easyread:before-quit", listener);
    return () => ipcRenderer.removeListener("easyread:before-quit", listener);
  },
});
