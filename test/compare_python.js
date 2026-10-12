// Compare TX Studio's per-run CSV with one written by an earlier Python correction script.
// usage: node test/compare_python.js <run.cur|clw> <holder.cur|clw> <python.csv>
const fs = require("node:fs");
const path = require("node:path");
const L = require("../src/lib/curlib.js");

const [runPath, holderPath, pyCsv] = process.argv.slice(2);
const read = (p) => L.parseCurve(fs.readFileSync(p, "latin1"));
const run = read(runPath), holder = read(holderPath);
const im = runPath.replace(/(\.\w+)$/, "_Im$1"), him = holderPath.replace(/(\.\w+)$/, "_Im$1");
const cin = L.correctCurve(run, holder, 5);
const cout = fs.existsSync(im) && fs.existsSync(him) ? L.correctCurve(read(im), read(him), 5) : null;
const ours = L.runCsv({ ...L.runLabel(L.stemOf(runPath), path.basename(path.dirname(runPath))), kind: L.kindOf(runPath) }, cin, cout);

const table = (txt) => {
  const [head, ...rows] = txt.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const a = table(ours), b = table(fs.readFileSync(pyCsv, "utf8"));
console.log("rows", a.length, b.length, "| python columns:", Object.keys(b[0]).join(","));
let worst = {};
for (const col of Object.keys(b[0])) {
  let diff = 0, mism = 0;
  a.forEach((r, i) => {
    const x = r[col], y = b[i][col];
    if (isNaN(+x) || isNaN(+y) || x === "" || y === "") { if (String(x) !== String(y)) mism++; }
    else diff = Math.max(diff, Math.abs(+x - +y));
  });
  worst[col] = mism ? `${mism} text mismatches` : `max |Δ| ${diff.toFixed(3)}`;
}
console.log(worst);
