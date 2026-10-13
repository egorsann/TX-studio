// Compile the Windows host (host/TXStudio.cs) with the C# compiler that ships with .NET
// Framework 4.8, next to the three WebView2 SDK DLLs it needs. The SDK package is fetched
// from nuget.org on first use (checked against its SHA-512) and cached in .cache/.
//   node scripts/build-host.js <output dir>
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const WEBVIEW2_VERSION = "1.0.4258.31";
const root = path.join(__dirname, "..");
const cache = path.join(root, ".cache", `webview2-${WEBVIEW2_VERSION}`);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "tx-studio-build" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(res.headers.location));
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function webview2Sdk() {
  const marker = path.join(cache, "lib", "net462", "Microsoft.Web.WebView2.Core.dll");
  if (fs.existsSync(marker)) return cache;
  const id = "microsoft.web.webview2";
  console.log(`fetching WebView2 SDK ${WEBVIEW2_VERSION} ...`);
  const pkg = await get(`https://api.nuget.org/v3-flatcontainer/${id}/${WEBVIEW2_VERSION}/${id}.${WEBVIEW2_VERSION}.nupkg`);
  const reg = JSON.parse((await get(`https://api.nuget.org/v3/registration5-semver1/${id}/${WEBVIEW2_VERSION}.json`)).toString());
  const leaf = JSON.parse((await get(reg.catalogEntry)).toString());
  const digest = crypto.createHash("sha512").update(pkg).digest("base64");
  if (leaf.packageHash && leaf.packageHash !== digest) throw new Error("WebView2 SDK package hash mismatch");
  fs.mkdirSync(cache, { recursive: true });
  const nupkg = path.join(cache, "package.zip");
  fs.writeFileSync(nupkg, pkg);
  execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", nupkg, "-C", cache]);
  return cache;
}

async function buildHost(outDir) {
  const sdk = await webview2Sdk();
  const fw = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
  const csc = path.join(fw, "csc.exe");
  if (!fs.existsSync(csc)) throw new Error(".NET Framework 4.8 C# compiler not found: " + csc);
  fs.mkdirSync(outDir, { recursive: true });
  const dlls = [path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.Core.dll"),
                path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll"),
                path.join(sdk, "runtimes", "win-x64", "native", "WebView2Loader.dll")];
  for (const d of dlls) fs.copyFileSync(d, path.join(outDir, path.basename(d)));
  execFileSync(csc, ["/nologo", "/target:winexe", "/platform:x64", "/optimize+",
    `/out:${path.join(outDir, "TX Studio.exe")}`,
    `/win32icon:${path.join(root, "src", "icon.ico")}`,
    `/win32manifest:${path.join(root, "host", "app.manifest")}`,
    "/r:System.Web.Extensions.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll",
    `/r:${dlls[0]}`, `/r:${dlls[1]}`,
    path.join(root, "host", "TXStudio.cs")], { stdio: "inherit" });
  return outDir;
}

module.exports = { buildHost };
if (require.main === module) {
  buildHost(path.resolve(process.argv[2] || path.join(root, "build", "host")))
    .then((d) => console.log("built " + path.join(d, "TX Studio.exe")))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
