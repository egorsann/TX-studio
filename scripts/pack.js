// Build a portable Windows folder + zip: dist/TX-Studio-win32-x64[.zip]
// No extra tools: the Electron runtime from node_modules is copied, renamed, and the app
// is placed in resources/app (where Electron looks before its default app). The zip also
// carries "Install TX Studio.cmd" for a one-double-click per-user install.
//   npm run pack
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const outName = "TX-Studio-win32-x64";
const dist = path.join(root, "dist");
const out = path.join(dist, outName);
const electronDist = path.join(root, "node_modules", "electron", "dist");
const KEEP_LOCALES = new Set(["en-US.pak", "de.pak"]);   // Chromium UI strings (menus, dialogs)

if (!fs.existsSync(path.join(electronDist, "electron.exe"))) {
  console.error("node_modules/electron is missing - run npm install first");
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Electron runtime, renamed
fs.cpSync(electronDist, out, { recursive: true });
fs.renameSync(path.join(out, "electron.exe"), path.join(out, `${pkg.productName}.exe`));
fs.rmSync(path.join(out, "resources", "default_app.asar"), { force: true });
for (const f of fs.readdirSync(path.join(out, "locales"))) {
  if (!KEEP_LOCALES.has(f)) fs.rmSync(path.join(out, "locales", f));
}

// the app
const app = path.join(out, "resources", "app");
const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(app, rel), { recursive: true });
fs.mkdirSync(app, { recursive: true });
["main.js", "preload.js", "src", "README.md", "LICENSE",
 path.join("node_modules", "plotly.js-dist-min", "plotly.min.js")].forEach(copy);
const { name, productName, version, description, main, license } = pkg;
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name, productName, version, description, main, license }, null, 2));

// installer + instructions (Windows line endings)
const crlf = (from, to) =>
  fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/\r?\n/g, "\r\n"));
const inst = path.join(root, "scripts", "installer");
crlf(path.join(inst, "Install TX Studio.cmd"), path.join(out, "Install TX Studio.cmd"));
crlf(path.join(inst, "START HERE.txt"), path.join(out, "START HERE.txt"));
crlf(path.join(inst, "install.ps1"), path.join(out, "resources", "install.ps1"));

const zip = path.join(dist, `${outName}.zip`);
fs.rmSync(zip, { force: true });
execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"),
  ["-a", "-c", "-f", zip, "-C", dist, outName], { stdio: "inherit" });

const size = (p) => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).reduce((a, f) => a + size(path.join(p, f)), 0) : fs.statSync(p).size;
console.log(`${out}  (${(size(out) / 1048576).toFixed(0)} MB)`);
console.log(`${zip}  (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
