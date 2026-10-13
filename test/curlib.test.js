// node --test test/   (real-data checks are skipped when the data folder is absent)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../src/lib/curlib.js");

// Real-data checks: point TX_TEST_DATA (or test/data-path.local, not committed) at a
// folder holding holder_corrections/ and <SPEC>_TX/<SPEC>_TX_raw/ runs.
const LOCAL = path.join(__dirname, "data-path.local");
const DATA = process.env.TX_TEST_DATA ||
  (fs.existsSync(LOCAL) ? fs.readFileSync(LOCAL, "utf8").trim() : "");
const HAVE = !!DATA && fs.existsSync(DATA);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test("running mean: edge points copied from the nearest full window", () => {
  const v = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(L.runningMean(v, 5), [3, 3, 3, 4, 5, 5, 5]);
  assert.deepEqual(L.runningMean([1, 2], 5), [1.5, 1.5]);
});

test("empty-holder smoothing modes", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((v, i) => ({ temp: i, tsusc: v, csusc: 0 }));
  assert.deepEqual(L.holderValues(rows, { mode: "none" }), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(L.holderValues(rows, { mode: "smooth", n: 5 }), [3, 3, 3, 4, 5, 5, 5]);
  assert.deepEqual(L.holderValues(rows, 5), [3, 3, 3, 4, 5, 5, 5]);
  assert.deepEqual(L.holderValues(rows, { mode: "stored", n: 3 }), L.runningMean([1, 2, 3, 4, 5, 6, 7], 3));  // nothing stored
  assert.equal(L.storedSmoothingN(rows), 0);
  const sm = L.runningMean(rows.map((r) => r.tsusc), 3);
  rows.forEach((r, i) => { r.csusc = sm[i]; });
  assert.equal(L.storedSmoothingN(rows), 3);
  assert.deepEqual(L.holderValues(rows, { mode: "stored" }), sm);
});

// synthetic corrected run: chi(T) on a heating (and optional cooling) branch, with a
// small deterministic wobble standing in for noise
function synthRun(temps, chi, wobble = 0.01) {
  const segment = L.segments(temps);
  return { temp: temps, csusc: temps.map((t, i) => chi(t, segment[i]) + wobble * Math.sin(i * 2.3)), segment, outside: temps.map(() => false) };
}
const ramp = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => a + i * step);

test("hyperbola fit recovers chi0 and C", () => {
  const T = ramp(-190, 20, 2), f = L.hyperbolaFit(T, T.map((t) => 1.5 + 400 / (t + 273.15 + 5)), -5);
  assert.ok(Math.abs(f.chi0 - 1.5) < 1e-9 && Math.abs(f.C - 400) < 1e-6 && f.r2 > 0.999999);
  assert.ok(Math.abs(L.hyperbolaAt(f, 25) - (1.5 + 400 / 303.15)) < 1e-9);
  assert.equal(L.nearestIndex([-190, -50, 0.3], 25), 2);
});

test("paramagnetic candidates: heating stretch ends where a new mineral forms", () => {
  // paramagnetic (chi0 = 1, C = 900) until 350 deg C, then chi climbs above the hyperbola
  const temps = [...ramp(25, 700, 2.5), ...ramp(697.5, 30, 2.5)];
  const corr = synthRun(temps, (t, seg) => 1 + 900 / (t + 273.15) + (seg === "cooling" ? 5 : t > 350 ? 0.03 * (t - 350) : 0));
  const cands = L.paraCandidates(corr);
  assert.equal(cands.length, 1, "cooling is never fitted, only the heating stretch");
  const c = L.defaultParaCandidate(cands);
  assert.ok(c.atStart && c.lo < 40 && Math.abs(c.hi - 350) < 15, `stretch ${c.lo}..${c.hi}`);
  assert.equal(c.departure.dir, 1);
  assert.ok(Math.abs(c.departure.t - 355) < 15, `departure at ${c.departure.t}`);
  assert.ok(Math.abs(c.fit.C - 900) < 40 && Math.abs(c.fit.chi0 - 1) < 0.1);
  const t = c.share.t, para = 900 / (t + 273.15);
  assert.ok(Math.abs(c.share.fraction - para / (1 + para)) < 0.02, `share ${c.share.fraction}`);
});

test("paramagnetic candidates: low-T warming branch as a whole; flat curves give none", () => {
  const T = ramp(-195, 15, 1.5);
  const c = L.defaultParaCandidate(L.paraCandidates(synthRun(T, (t) => 3 + 400 / (t + 273.15))));
  assert.ok(c.whole && c.departure === null);
  assert.ok(Math.abs(c.share.fraction - (400 / (T[T.length - 1] + 273.15)) / (3 + 400 / (T[T.length - 1] + 273.15))) < 0.01);
  assert.equal(L.paraCandidates(synthRun(T, () => 50, 0.3)).length, 0, "temperature-independent chi is not paramagnetic");
});

test("fixed-width parse copes with touching columns", () => {
  const txt = "  TEMP    TSUSC     CSUSC NSUSC       BULKS    FERRT    FERRB   TIMERHOTSTUFF\n" +
              "  26.6    -43.7     -0.66-0.019         0.0      0.0      0.0      0      0.0\n";
  const c = L.parseCurve(txt);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].csusc, -0.66);
  assert.equal(c.rows[0].nsusc, -0.019);
  assert.equal(c.emptyTag, "RHOTSTUFF");
});

test("run labels", () => {
  assert.deepEqual(L.runLabel("AB24CD101-27H1", "AB24CD101_TX_raw"), { spec: "AB24CD101", piece: "27", run: "H1" });
  assert.deepEqual(L.runLabel("AB24CD115-22+23-L2", "AB24CD115_TX_raw"), { spec: "AB24CD115", piece: "22+23", run: "L2" });
  assert.equal(L.outputDir("C:\\a\\X_TX\\X_TX_raw"), "C:\\a\\X_TX\\X_TX_corr");
  // specimen ID from the file name when the folder doesn't carry it
  assert.deepEqual(L.runLabel("AB24CD112-30SH1", "any folder"), { spec: "AB24CD112", piece: "30S", run: "H1" });
  assert.deepEqual(L.runLabel("AB24CD101-9-10L2", "any folder"), { spec: "AB24CD101", piece: "9-10", run: "L2" });
});

// ---- real data (any folder of runs with empty holders; nothing below names a file)
function loadRuns() {
  const files = walk(DATA);
  const runs = L.groupRuns(files.filter(L.isCurveFile));
  for (const r of runs) {
    r.curve = L.parseCurve(fs.readFileSync(r.main, "latin1"));
    const rp = L.findRecordPath(r.main, files);
    r.record = rp ? L.parseRecord(fs.readFileSync(rp, "latin1")) : null;
    r.time = r.record ? r.record.start : null;
    r.out = /_corr$/i.test(path.basename(r.dir));
    r.dry = !r.out && L.looksLikeDryRun(r, r.record);
  }
  return runs.filter((r) => !r.out && r.curve.rows.length);
}

test("stored empty-holder smoothing is a running mean the app reproduces exactly", { skip: !HAVE }, () => {
  const holders = loadRuns().filter((r) => r.dry && L.hasStoredSmoothing(r.curve.rows));
  assert.ok(holders.length >= 1);
  for (const h of holders) assert.ok(L.storedSmoothingN(h.curve.rows) > 0, path.basename(h.main));
});

test("empty holders detected; pairing picks the nearest / latest-before holder", { skip: !HAVE }, () => {
  const runs = loadRuns();
  const dry = runs.filter((r) => r.dry);
  assert.ok(dry.length >= 1);
  let n = 0;
  for (const s of runs.filter((r) => !r.dry && r.time != null)) {
    const cands = dry.filter((d) => d.kind === s.kind && d.time != null).map((d) => ({ run: d, time: d.time }));
    if (!cands.length) continue;
    const near = L.pairDryRun(s.time, cands, "nearest");
    assert.equal(Math.abs(near.time - s.time), Math.min(...cands.map((c) => Math.abs(c.time - s.time))));
    const pre = L.pairDryRun(s.time, cands, "preceding");
    if (cands.some((c) => c.time <= s.time)) assert.ok(pre.time <= s.time);
    n++;
  }
  assert.ok(n >= 1);
});

test("correction agrees with the CSUSC stored in the files (same holder)", { skip: !HAVE }, () => {
  const runs = loadRuns();
  const dry = runs.filter((r) => r.dry);
  let n = 0;
  for (const s of runs.filter((r) => !r.dry && r.curve.emptyTag && L.hasStoredSmoothing(r.curve.rows))) {
    // the header names the holder it was corrected with (its last 9 characters)
    const h = dry.find((d) => d.kind === s.kind && d.stem.slice(-9).toUpperCase() === s.curve.emptyTag.toUpperCase());
    if (!h) continue;
    const corr = L.correctCurve(s.curve, h.curve, { mode: "stored" });
    assert.ok(corr.stats.compare.mean < 0.07, `${path.basename(s.main)} mean ${corr.stats.compare.mean}`);
    n++;
  }
  assert.ok(n >= 1, `checked ${n}`);
});

test("written file round-trips and keeps untouched columns", { skip: !HAVE }, () => {
  const runs = loadRuns();
  const s = runs.find((r) => !r.dry && runs.some((d) => d.dry && d.kind === r.kind));
  const h = runs.find((d) => d.dry && d.kind === s.kind);
  const corr = L.correctCurve(s.curve, h.curve, 5);
  const back = L.parseCurve(L.writeCurve(s.curve, corr, h.stem));
  assert.equal(back.rows.length, s.curve.rows.length);
  assert.equal(back.emptyTag, h.stem.slice(-9));
  back.rows.forEach((r, i) => {
    assert.equal(r.temp, s.curve.rows[i].temp);
    assert.equal(r.tsusc, s.curve.rows[i].tsusc);
    assert.equal(r.time, s.curve.rows[i].time);
    assert.equal(r.tail, s.curve.rows[i].tail);
    assert.equal(r.csusc, corr.csusc[i]);
  });
});

test("pairing rules on made-up dates", () => {
  const day = 86400000, at = (d) => new Date(2024, 0, d).getTime();
  const cands = [{ run: "jan02", time: at(2) }, { run: "jan20", time: at(20) }, { run: "undated", time: null }];
  assert.equal(L.pairDryRun(at(10), cands, "nearest").run, "jan02");
  assert.equal(L.pairDryRun(at(17), cands, "nearest").run, "jan20");
  assert.equal(L.pairDryRun(at(17), cands, "preceding").run, "jan02");
  assert.equal(L.pairDryRun(at(1), cands, "preceding").run, "jan02");     // nothing earlier: nearest
  assert.equal(L.pairDryRun(null, cands, "nearest").run, "jan20");        // undated run: newest holder
  assert.ok(day > 0);
});

test("runs pair across inconsistent separators", () => {
  const p = (n) => String.raw`C:\d\ ` .trim() + n;
  const runs = L.groupRuns([p("X-13+15+16-L1.clw"), p("X-13+15+16L1_Im.clw"), p("X-6H1.cur"), p("X-6H1_Im.cur")]);
  assert.equal(runs.length, 2);
  const lt = runs.find((r) => r.kind === "LT");
  assert.equal(lt.main, p("X-13+15+16-L1.clw"));
  assert.equal(lt.im, p("X-13+15+16L1_Im.clw"));
  assert.equal(lt.stem, "X-13+15+16-L1");
});

test("empty-holder lookup: first bracketing pair, end values outside", () => {
  const rows = (pairs) => pairs.map(([temp, tsusc]) => ({ temp, tsusc }));
  // heating holder with a temperature wobble at 30 -> 29 -> 31; smoothing off (N = 1)
  const h = rows([[20, 0], [30, 10], [29, 12], [31, 14], [40, 20], [35, 30], [25, 40]]);
  const tr = L.holderTrace(h, [10, 30.5, 45, 38, 20], 1).trace;
  assert.equal(tr[0], 0);                                   // colder than first point
  assert.ok(Math.abs(tr[1] - 13.5) < 1e-5);                 // first rising pair 29..31 (sorted interp would give 12)
  assert.equal(tr[2], 20);                                  // hotter than last heating point
  assert.equal(tr[3], 30);                                  // cooling branch starts at 35: hotter -> its first value
  assert.equal(tr[4], 40);                                  // colder than last cooling point
});

test("overlay tags: piece, made unique only where needed", () => {
  const it = (id, stem) => ({ id, ...L.runLabel(stem, "x"), kind: /H\d$/.test(stem) ? "HT" : "LT" });
  const tags = L.overlayTags([it(1, "AB24CD112-30SH1"), it(2, "AB24CD101-9-10L2"), it(3, "AB24CD101-27L1"),
    it(4, "AB24CD101-27L2"), it(5, "AB24CD101-27H1"), it(6, "AB24CD101-31H1"), it(7, "AB24CD112-31H1")]);
  assert.equal(tags.get(1), "30S");
  assert.equal(tags.get(2), "9-10");
  assert.equal(tags.get(3), "27 L1");          // same piece, same type -> run code
  assert.equal(tags.get(4), "27 L2");
  assert.equal(tags.get(5), "27");             // H1 differs by type (colour) already
  assert.equal(tags.get(6), "101 · 31");       // same piece, two specimens -> differing part
  assert.equal(tags.get(7), "112 · 31");
});
