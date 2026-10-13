// Build the Windows release: dist/TX-Studio-win32-x64[.zip]
// The app is a ~40 KB host exe (host/TXStudio.cs, built with the .NET Framework compiler
// that ships with Windows) showing the web UI in the system's Edge WebView2 runtime --
// no bundled browser. The zip also carries "Install TX Studio.cmd" for a per-user install.
//   npm run pack
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildHost } = require("./build-host.js");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const outName = "TX-Studio-win32-x64";
const dist = path.join(root, "dist");
const out = path.join(dist, outName);
const app = path.join(out, "resources", "app");

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  await buildHost(out);

  // the web UI (Electron's main.js / preload.js are only for running from source)
  const copy = (rel, to = rel) => fs.cpSync(path.join(root, rel), path.join(app, to), { recursive: true });
  copy("src");
  copy(path.join("node_modules", "plotly.js-basic-dist-min", "plotly-basic.min.js"));
  copy("README.md");
  copy("LICENSE");
  const { name, productName, version, description, license } = pkg;
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name, productName, version, description, license }, null, 2));

  // licences of what is redistributed
  const sdk = path.join(root, ".cache", fs.readdirSync(path.join(root, ".cache")).find((d) => d.startsWith("webview2-")));
  const notices = ["TX Studio - MIT licence, see resources/app/LICENSE", "",
    "Microsoft Edge WebView2 SDK (Microsoft.Web.WebView2.*.dll, WebView2Loader.dll)", "-".repeat(78),
    fs.readFileSync(path.join(sdk, "LICENSE.txt"), "utf8").trim(), "",
    "plotly.js (resources/app/node_modules/plotly.js-basic-dist-min)", "-".repeat(78),
    fs.readFileSync(path.join(root, "node_modules", "plotly.js-basic-dist-min", "LICENSE"), "utf8").trim(), ""];
  fs.writeFileSync(path.join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\r\n").replace(/\r?\n/g, "\r\n"));

  // installer + instructions (Windows line endings)
  const crlf = (from, to) => fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/\r?\n/g, "\r\n"));
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
  console.log(`${out}  (${(size(out) / 1048576).toFixed(1)} MB)`);
  console.log(`${zip}  (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
