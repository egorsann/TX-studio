// Values at the hot end of one run: app (each smoothing mode) vs the earlier Python CSV.
// usage: node test/check_hot.js <data folder> <run stem, e.g. AB24CD112-31H1>
const fs = require("node:fs");
const path = require("node:path");
const L = require("../src/lib/curlib.js");

const [root, stem] = process.argv.slice(2);
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(root);
const runs = L.groupRuns(files.filter(L.isCurveFile)).filter((r) => !/_corr$/i.test(path.basename(r.dir)));
for (const r of runs) {
  r.curve = L.parseCurve(fs.readFileSync(r.main, "latin1"));
  const rp = L.findRecordPath(r.main, files);
  r.record = rp ? L.parseRecord(fs.readFileSync(rp, "latin1")) : null;
  r.time = r.record ? r.record.start : null;
  r.dry = L.looksLikeDryRun(r, r.record);
}
const run = runs.find((r) => r.stem === stem);
const h = L.pairDryRun(run.time, runs.filter((d) => d.dry && d.kind === run.kind).map((d) => ({ run: d, time: d.time })), "nearest").run;
const modes = { "mean 5": { mode: "smooth", n: 5 }, "from file": { mode: "stored" }, "none": { mode: "none" } };
const res = Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, L.correctCurve(run.curve, h.curve, m)]));
const lab = L.runLabel(run.stem, path.basename(run.dir));
const csv = path.join(L.outputDir(run.dir), `${lab.spec}-${lab.piece}${lab.run}.csv`);
const py = fs.existsSync(csv) ? fs.readFileSync(csv, "utf8").trim().split(/\r?\n/).slice(1).map((l) => +l.split(",")[6]) : null;
console.log(`${run.stem} corrected with ${h.stem}`);
console.log("   i   T      TSUSC   holder(mean5)  " + Object.keys(modes).map((k) => k.padStart(10)).join("") + (py ? "    python" : ""));
const k = run.curve.rows.map((x) => x.temp).indexOf(Math.max(...run.curve.rows.map((x) => x.temp)));
for (let i = Math.max(0, k - 8); i <= Math.min(run.curve.rows.length - 1, k + 4); i++) {
  const row = run.curve.rows[i];
  console.log(`${String(i).padStart(4)} ${row.temp.toFixed(1).padStart(6)} ${row.tsusc.toFixed(1).padStart(8)} ${res["mean 5"].holder[i].toFixed(2).padStart(12)}   ` +
    Object.keys(modes).map((m) => res[m].csusc[i].toFixed(2).padStart(10)).join("") + (py ? py[i].toFixed(2).padStart(10) : ""));
}
const hot = (a) => a.filter((_, i) => run.curve.rows[i].temp > 600);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("\nmean corrected chi above 600 C: " + Object.keys(modes).map((m) => `${m} ${mean(hot(res[m].csusc)).toFixed(2)}`).join(" | ") + (py ? ` | python ${mean(hot(py)).toFixed(2)}` : ""));
