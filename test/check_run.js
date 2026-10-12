// Diagnose one specimen's corrections the way the app does them, next to the Python
// output (_corr CSV) and the correction stored in the raw file.
// usage: node test/check_run.js <data folder> <specimen prefix, e.g. AB24CD101-27>
const fs = require("node:fs");
const path = require("node:path");
const L = require("../src/lib/curlib.js");

const [root, prefix] = process.argv.slice(2);
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
  r.curveIm = r.im ? L.parseCurve(fs.readFileSync(r.im, "latin1")) : null;
  const rp = L.findRecordPath(r.main, files);
  r.record = rp ? L.parseRecord(fs.readFileSync(rp, "latin1")) : null;
  r.time = r.record ? r.record.start : null;
  r.dry = L.looksLikeDryRun(r, r.record);
}
const dry = runs.filter((r) => r.dry);
const stat = (a) => {
  const v = a.filter((x) => x != null && Number.isFinite(x));
  return `min ${Math.min(...v).toFixed(2)}  max ${Math.max(...v).toFixed(2)}  first ${v[0].toFixed(2)}`;
};
for (const r of runs.filter((x) => !x.dry && x.stem.startsWith(prefix))) {
  const cands = dry.filter((d) => d.kind === r.kind).map((d) => ({ run: d, time: d.time }));
  const pick = L.pairDryRun(r.time, cands, "nearest").run;
  const spec = { mode: "smooth", n: 5 };
  const cin = L.correctCurve(r.curve, pick.curve, spec);
  const cout = r.curveIm && pick.curveIm ? L.correctCurve(r.curveIm, pick.curveIm, spec) : null;
  console.log(`\n${r.stem}  (${r.kind}, measured ${new Date(r.time).toISOString().slice(0, 10)})  -> ${pick.stem}`);
  console.log(`  raw TSUSC            ${stat(r.curve.rows.map((x) => x.tsusc))}`);
  console.log(`  holder trace         ${stat(cin.holder)}`);
  console.log(`  app  chi_in          ${stat(cin.csusc)}`);
  if (cout) console.log(`  app  chi_out         ${stat(cout.csusc)}`);
  console.log(`  stored in raw file   ${stat(r.curve.rows.map((x) => x.csusc))}   (header holder tag: ${r.curve.emptyTag || "-"})`);
  const lab = L.runLabel(r.stem, path.basename(r.dir));
  const csv = path.join(L.outputDir(r.dir), `${lab.spec}-${lab.piece}${lab.run}.csv`);
  if (fs.existsSync(csv)) {
    const [head, ...rows] = fs.readFileSync(csv, "utf8").trim().split(/\r?\n/);
    const cols = head.split(","), ci = cols.indexOf("chi_in_1e6SI"), co = cols.indexOf("chi_out_1e6SI");
    const pin = rows.map((l) => +l.split(",")[ci]), pout = co >= 0 ? rows.map((l) => +l.split(",")[co]) : null;
    console.log(`  python chi_in        ${stat(pin)}   max |app - python| ${Math.max(...pin.map((v, i) => Math.abs(v - cin.csusc[i]))).toFixed(3)}`);
    if (pout && cout) console.log(`  python chi_out       ${stat(pout)}   max |app - python| ${Math.max(...pout.map((v, i) => Math.abs(v - cout.csusc[i]))).toFixed(3)}`);
  }
}
