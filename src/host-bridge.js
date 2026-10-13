// window.api for the WebView2 host (host/TXStudio.cs): the same calls the Electron preload
// offers, sent to the host as messages {id, method, args} and answered by id.
(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.api) return;
  const pending = new Map(), listeners = {};
  let seq = 0;
  wv.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.event) { (listeners[m.event] || []).forEach((fn) => fn()); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  const send = (method, args, extra) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    if (extra) wv.postMessageWithAdditionalObjects({ id, method, args }, extra);
    else wv.postMessage({ id, method, args });
  });
  const call = (method) => (...args) => send(method, args);
  window.api = {
    pickFolder: call("pickFolder"),
    saveDialog: call("saveDialog"),
    exists: call("exists"),
    startupPath: call("startupPath"),
    scan: call("scan"),
    dryRunFiles: call("dryRunFiles"),
    readTexts: call("readTexts"),
    writeText: call("writeText"),
    writeBase64: call("writeBase64"),
    reveal: call("reveal"),
    openPath: call("openPath"),
    getSettings: call("getSettings"),
    setSettings: call("setSettings"),
    setTheme: call("setTheme"),
    watch: call("watch"),
    onFsChanged: (fn) => { (listeners["fs-changed"] = listeners["fs-changed"] || []).push(fn); },
    pathForFile: (file) => send("pathForFile", [], [file]).catch(() => null),
    platform: "win32",
    nativeFrame: true,           // the host uses the normal Windows title bar
  };
})();
