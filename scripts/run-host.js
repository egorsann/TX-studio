// Build the Windows host and run it against the source tree (no packaging step).
//   npm run host [-- <folder to open>]
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildHost } = require("./build-host.js");

const root = path.join(__dirname, "..");
buildHost(path.join(root, "build", "host")).then((dir) => {
  spawn(path.join(dir, "TX Studio.exe"), process.argv.slice(2), {
    env: { ...process.env, TXS_APPDIR: root, TXS_DEVTOOLS: "1" }, detached: true, stdio: "ignore",
  }).unref();
}).catch((e) => { console.error(e.message); process.exit(1); });
