// Electron main process: window, file-system access and settings for the renderer.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;

const SKIP_DIRS = new Set(["AppData", "@eaDir", "#recycle", ".snapshot", "__pycache__", "node_modules",
  ".venv", "venv", ".git", "$RECYCLE.BIN", "System Volume Information"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 30000;
const DRY_DIR_RE = /holder|empty|dry[ _-]?run|blank/i;
const TITLEBAR = { light: { color: "#f3f4f6", symbolColor: "#1f2937" }, dark: { color: "#16181d", symbolColor: "#e5e7eb" } };

let win = null;
let watcher = null;
const savedPaths = new Set();            // paths the user picked in a save dialog

// ------------------------------------------------------------------ settings
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// ------------------------------------------------------------------ scanning
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function scanTree(root) {
  let count = 0;
  async function walk(dir, depth) {
    const node = { name: path.basename(dir) || dir, path: dir, dir: true, children: [] };
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return node;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return node; }
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      count++;
      if (e.isDirectory()) dirs.push(e.name); else if (e.isFile()) files.push(e.name);
    }
    dirs.sort(collator.compare); files.sort(collator.compare);
    for (const d of dirs) node.children.push(await walk(path.join(dir, d), depth + 1));
    for (const f of files) node.children.push({ name: f, path: path.join(dir, f), dir: false });
    return node;
  }
  return walk(root, 0);
}

// Dry-run folders near the opened folder: directories named like "holder", "empty" or
// "dry run" in the folder itself and up to three levels above it (holder_corrections
// usually sits beside the specimen folders, so opening one specimen still finds it).
async function findDryRunFiles(root) {
  const out = new Set();
  const seen = new Set();
  async function collect(dir, depth) {
    if (seen.has(dir)) return; seen.add(dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /\.(cur|clw|kht|klt)$/i.test(e.name)) out.add(p);
      else if (e.isDirectory() && depth < 3 && !SKIP_DIRS.has(e.name)) await collect(p, depth + 1);
    }
  }
  let anc = root;
  for (let up = 0; up <= 3; up++) {
    let entries = [];
    try { entries = await fsp.readdir(anc, { withFileTypes: true }); } catch { /* unreadable */ }
    for (const e of entries) {
      if (e.isDirectory() && DRY_DIR_RE.test(e.name) && !SKIP_DIRS.has(e.name)) await collect(path.join(anc, e.name), 0);
    }
    if (DRY_DIR_RE.test(path.basename(anc))) await collect(anc, 0);
    const parent = path.dirname(anc);
    if (parent === anc || anc === app.getPath("home")) break;
    anc = parent;
  }
  return [...out];
}

async function listCurveFiles(dir) {
  const out = [];
  async function walk(d, depth) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && /\.(cur|clw|kht|klt)$/i.test(e.name)) out.push(p);
      else if (e.isDirectory() && depth < 4 && !SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
    }
  }
  await walk(dir, 0);
  return out;
}

// ------------------------------------------------------------------ writing guard
/** Output only ever goes into a *_corr folder, to a path the user picked in a save
 *  dialog, or to a specimen notes file (*_notes.json): raw measurement files can never
 *  be overwritten. */
function writable(p) {
  const full = path.resolve(p);
  return savedPaths.has(full) || /_corr$/i.test(path.basename(path.dirname(full))) || /_notes\.json$/i.test(full);
}

// ------------------------------------------------------------------ window
function createWindow() {
  const s = loadSettings();
  const b = s.bounds || { width: 1440, height: 900 };
  const dark = s.theme === "dark" || (s.theme !== "light" && nativeTheme.shouldUseDarkColors);
  win = new BrowserWindow({
    ...b,
    minWidth: 960,
    minHeight: 600,
    title: "TX Studio",
    backgroundColor: dark ? "#111317" : "#ffffff",
    titleBarStyle: "hidden",
    titleBarOverlay: { ...(dark ? TITLEBAR.dark : TITLEBAR.light), height: 40 },
    icon: path.join(__dirname, "src", process.platform === "win32" ? "icon.ico" : "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: !process.env.CS_SCRIPT,
    },
  });
  if (process.env.CS_SCRIPT) {
    // scripted (test) runs render off-screen so they never pop up over the user's work
    win.setBounds({ x: -20000, y: 0, width: 1440, height: 900 });
    win.setSkipTaskbar(true);
  } else if (s.maximized) win.maximize();
  win.once("ready-to-show", () => (process.env.CS_SCRIPT ? win.showInactive() : win.show()));
  win.loadFile(path.join(__dirname, "src", "index.html"));

  const remember = () => {
    const cur = loadSettings();
    cur.maximized = win.isMaximized();
    if (!cur.maximized) cur.bounds = win.getBounds();
    saveSettings(cur);
  };
  win.on("close", remember);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

// ------------------------------------------------------------------ ipc
ipcMain.handle("pick-folder", async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { title: "Open data folder", defaultPath: start || undefined,
    properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("save-dialog", async (_e, opts) => {
  const r = await dialog.showSaveDialog(win, opts || {});
  if (r.canceled || !r.filePath) return null;
  savedPaths.add(path.resolve(r.filePath));
  return r.filePath;
});
ipcMain.handle("exists", (_e, p) => fs.existsSync(p));
// a folder (or a .cur/.clw) given on the command line / dropped on the shortcut
const startupArg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith("-") && a !== "." && fs.existsSync(a));
ipcMain.handle("startup-path", () => (startupArg ? path.resolve(startupArg) : null));
ipcMain.handle("scan", (_e, root) => scanTree(root));
ipcMain.handle("dry-run-files", (_e, root) => findDryRunFiles(root));
ipcMain.handle("list-curve-files", (_e, dir) => listCurveFiles(dir));
ipcMain.handle("read-texts", (_e, paths) =>
  Promise.all(paths.map((p) => fsp.readFile(p, "latin1").catch(() => null))));
ipcMain.handle("write-text", async (_e, p, text) => {
  if (!writable(p)) throw new Error("refusing to write outside a *_corr folder: " + p);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text, "latin1");
  return true;
});
ipcMain.handle("write-base64", async (_e, p, b64) => {
  if (!writable(p)) throw new Error("refusing to write outside a *_corr folder: " + p);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.from(b64, "base64"));
  return true;
});
ipcMain.handle("reveal", (_e, p) => shell.showItemInFolder(p));
// tidying a data folder (asked first in the app): renames in place, moves one level down,
// never deletes or overwrites -- same guards as the Windows host
const RUN_FILE = /\.(cur|clw|kht|klt)$/i;
ipcMain.handle("rename-dir", async (_e, from, to) => {
  const src = path.resolve(from), dst = path.resolve(to);
  if (path.dirname(src).toLowerCase() !== path.dirname(dst).toLowerCase()) throw new Error("a folder is only renamed in place");
  if (!/^TX_holder_correction_\d{8}$/.test(path.basename(dst))) throw new Error("not an empty-holder folder name");
  if (fs.existsSync(dst)) throw new Error(path.basename(dst) + " already exists");
  await fsp.rename(src, dst);
  return true;
});
ipcMain.handle("rename-files", async (_e, pairs) => {
  const todo = pairs.map(([a, b]) => [path.resolve(a), path.resolve(b)]);
  for (const [a, b] of todo) {
    if (!fs.existsSync(a)) throw new Error("no such file: " + a);
    if (path.dirname(a).toLowerCase() !== path.dirname(b).toLowerCase()) throw new Error("a file is only renamed in place");
    if (!RUN_FILE.test(a) || !RUN_FILE.test(b)) throw new Error("only run files are renamed");
    if (fs.existsSync(b)) throw new Error(path.basename(b) + " already exists");
  }
  for (const [a, b] of todo) await fsp.rename(a, b);
  return true;
});
ipcMain.handle("organize-runs", async (_e, dir, rawName, corrName) => {
  const ok = (n, suffix) => typeof n === "string" && n.toLowerCase().endsWith(suffix) && !/[\\/:*?"<>|]/.test(n) && n.length > suffix.length;
  if (!ok(rawName, "_raw") || !ok(corrName, "_corr")) throw new Error("bad folder names");
  const raw = path.join(dir, rawName), corr = path.join(dir, corrName);
  const files = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && RUN_FILE.test(e.name)).map((e) => e.name);
  for (const f of files) if (fs.existsSync(path.join(raw, f))) throw new Error(f + " already exists in " + rawName);
  await fsp.mkdir(raw, { recursive: true });
  await fsp.mkdir(corr, { recursive: true });
  const moved = [];
  for (const f of files) { await fsp.rename(path.join(dir, f), path.join(raw, f)); moved.push(path.join(raw, f)); }
  return moved;
});
ipcMain.handle("open-path", (_e, p) => shell.openPath(p));
ipcMain.handle("open-url", (_e, u) => (String(u).toLowerCase().startsWith("https://") ? shell.openExternal(u) : Promise.reject(new Error("not an https address"))));
ipcMain.handle("settings-get", () => loadSettings());
ipcMain.handle("settings-set", (_e, patch) => { const s = { ...loadSettings(), ...patch }; saveSettings(s); return s; });
ipcMain.handle("set-theme", (_e, theme) => {
  nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system";
  const dark = nativeTheme.shouldUseDarkColors;
  if (win) {
    win.setTitleBarOverlay({ ...(dark ? TITLEBAR.dark : TITLEBAR.light), height: 40 });
    win.setBackgroundColor(dark ? "#111317" : "#ffffff");
  }
  return dark;
});
ipcMain.handle("watch", (_e, root) => {
  if (watcher) { watcher.close(); watcher = null; }
  if (!root) return false;
  let timer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (ev, file) => {
      if (file && !/\.(cur|clw|kht|klt)$/i.test(file) && path.extname(file)) return;
      if (file && !path.extname(file) && ev === "change") return;     // a folder's timestamp (a file in it was written)
      clearTimeout(timer);
      timer = setTimeout(() => win && win.webContents.send("fs-changed"), 800);
    });
  } catch { return false; }
  return true;
});

// Dev aid: CS_SCRIPT=steps.json runs [{js, wait, shot}] steps in the renderer, saving
// screenshots, then quits. CS_USERDATA isolates settings for such runs.
if (process.env.CS_USERDATA) app.setPath("userData", process.env.CS_USERDATA);
async function runScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const st of steps) {
    try {
      if (st.js) {
        const r = await win.webContents.executeJavaScript(st.js);
        if (r !== undefined) console.log("[script]", JSON.stringify(r));
      }
      const input = st.inputJs ? await win.webContents.executeJavaScript(st.inputJs) : st.input || [];
      for (const ev of input) {                     // real mouse/keyboard input, e.g. drags
        win.webContents.sendInputEvent(ev);
        await new Promise((res) => setTimeout(res, ev.delay || 16));
      }
      if (st.wait) await new Promise((res) => setTimeout(res, st.wait));
      if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    } catch (err) { console.log("[script error]", err.message); }
  }
  app.quit();
}

app.setAppUserModelId("TXStudio");
app.whenReady().then(() => {
  const s = loadSettings();
  nativeTheme.themeSource = s.theme === "dark" || s.theme === "light" ? s.theme : "system";
  createWindow();
  if (process.env.CS_SCRIPT) win.webContents.once("did-finish-load", () => runScript(process.env.CS_SCRIPT));
  win.webContents.on("console-message", (e) => {
    const lvl = e.level ?? e.params?.level;
    if (process.env.CS_SCRIPT && (lvl === "error" || lvl === "warning" || lvl >= 2)) console.log("[renderer]", e.message ?? e.params?.message);
  });
});
app.on("window-all-closed", () => app.quit());
