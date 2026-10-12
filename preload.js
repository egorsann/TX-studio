// Narrow bridge between the renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickFolder: (start) => ipcRenderer.invoke("pick-folder", start),
  saveDialog: (opts) => ipcRenderer.invoke("save-dialog", opts),
  exists: (p) => ipcRenderer.invoke("exists", p),
  startupPath: () => ipcRenderer.invoke("startup-path"),
  scan: (root) => ipcRenderer.invoke("scan", root),
  dryRunFiles: (root) => ipcRenderer.invoke("dry-run-files", root),
  listCurveFiles: (dir) => ipcRenderer.invoke("list-curve-files", dir),
  readTexts: (paths) => ipcRenderer.invoke("read-texts", paths),
  writeText: (p, text) => ipcRenderer.invoke("write-text", p, text),
  writeBase64: (p, b64) => ipcRenderer.invoke("write-base64", p, b64),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  getSettings: () => ipcRenderer.invoke("settings-get"),
  setSettings: (patch) => ipcRenderer.invoke("settings-set", patch),
  setTheme: (t) => ipcRenderer.invoke("set-theme", t),
  watch: (root) => ipcRenderer.invoke("watch", root),
  onFsChanged: (fn) => ipcRenderer.on("fs-changed", fn),
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
