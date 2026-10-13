// Paramagnetic candidates (hyperbola chi = chi0 + C / (T - theta) stretches, see
// CurLib.paraCandidates) of the runs in a data folder, corrected against their nearest
// empty holder.
// usage: node test/para_fit.js <data folder> [<run stem prefix> ...]
const fs = require("node:fs");
const path = require("node:path");
const L = require("../src/lib/curlib.js");

const args = process.argv.slice(2);

const [root, ...prefixes] = args.filter((a) => !a.startsWith("--"));
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
const f1 = (v) => (v == null ? "  -  " : v.toFixed(v < 10 && v > -10 ? 2 : 0));
for (const run of runs.filter((r) => !r.dry && (!prefixes.length || prefixes.some((p) => r.stem.startsWith(p))))) {
  const pick = L.pairDryRun(run.time, runs.filter((d) => d.dry && d.kind === run.kind).map((d) => ({ run: d, time: d.time })), "nearest");
  if (!pick) continue;
  const c = L.correctCurve(run.curve, pick.run.curve, { mode: "stored", n: 5 });
  const t0 = Date.now();
  const cands = L.paraCandidates(c);
  const def = L.defaultParaCandidate(cands);
  console.log(`${run.stem}  (${run.kind}, ${c.temp.length} pts, ${Date.now() - t0} ms)`);
  if (!cands.length) console.log("    no paramagnetic stretch");
  for (const k of cands) {
    const s = k.share;
    console.log(`    ${k.from.toFixed(0).padStart(5)} -> ${k.to.toFixed(0).padStart(5)} C  n=${String(k.n).padStart(4)}` +
      `  chi0=${f1(k.fit.chi0).padStart(6)} C=${k.fit.C.toFixed(0).padStart(6)} R2=${k.fit.r2.toFixed(3)}` +
      `  para ${s.fraction == null ? "  -" : ((100 * s.fraction).toFixed(0) + "±" + (100 * s.se).toFixed(0) + "%").padStart(7)} at ${s.t.toFixed(0)} C` +
      (k.departure ? `  leaves at ${k.departure.t.toFixed(0)} C (${k.departure.dir > 0 ? "above" : "below"})` : "") + (k.whole ? "  [whole]" : k.atStart ? "  [start]" : "") + (k === def ? "  <- default" : ""));
  }
}
