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
  assert.deepEqual(L.runLabel("ER26PB002-27H1", "ER26PB002_TX_raw"), { spec: "ER26PB002", piece: "27", run: "H1" });
  assert.deepEqual(L.runLabel("ER26PB015-22+23-L2", "ER26PB015_TX_raw"), { spec: "ER26PB015", piece: "22+23", run: "L2" });
  assert.equal(L.outputDir("C:\\a\\X_TX\\X_TX_raw"), "C:\\a\\X_TX\\X_TX_corr");
  // specimen ID from the file name when the folder doesn't carry it
  assert.deepEqual(L.runLabel("ER26PB012-30SH1", "any folder"), { spec: "ER26PB012", piece: "30S", run: "H1" });
  assert.deepEqual(L.runLabel("ER26PB002-9-10L2", "any folder"), { spec: "ER26PB002", piece: "9-10", run: "L2" });
});

test("smoothing reproduces every smoothed holder file exactly", { skip: !HAVE }, () => {
  const holders = walk(path.join(DATA, "holder_corrections")).filter(L.isCurveFile);
  assert.ok(holders.length >= 4);
  for (const p of holders) {
    const c = L.parseCurve(fs.readFileSync(p, "latin1"));
    const s = L.runningMean(c.rows.map((r) => r.tsusc), 5);
    const worst = Math.max(...s.map((v, i) => Math.abs(v - c.rows[i].csusc)));
    assert.ok(worst < 0.006, `${path.basename(p)}: worst ${worst}`);
  }
});

test("dry runs detected, pairing picks the nearest-in-time holder", { skip: !HAVE }, () => {
  const files = walk(DATA);
  const runs = L.groupRuns(files.filter(L.isCurveFile));
  const recs = new Map();
  for (const r of runs) {
    const rp = L.findRecordPath(r.main, files);
    r.record = rp ? L.parseRecord(fs.readFileSync(rp, "latin1")) : null;
    r.dry = L.looksLikeDryRun(r, r.record);
  }
  const dry = runs.filter((r) => r.dry);
  assert.equal(dry.length, 4);
  const sample = runs.find((r) => /ER26PB012-31H1/.test(r.main) && /_raw/.test(r.main));
  const cands = dry.filter((d) => d.kind === sample.kind).map((d) => ({ run: d, time: d.record.start }));
  const pick = L.pairDryRun(sample.record.start, cands, "nearest");
  assert.match(pick.run.stem, /260901/);
  const pre = L.pairDryRun(new Date(2026, 7, 30).getTime(), cands, "preceding");
  assert.equal(pre.run.stem, "DRHOTSTUFF");
});

test("correction agrees with the CSUSC stored in the files (same holder)", { skip: !HAVE }, () => {
  const feb = path.join(DATA, "holder_corrections", "TX_holder_correction_2026_260224");
  const H = { HT: L.parseCurve(fs.readFileSync(path.join(feb, "DRHOTSTUFF.cur"), "latin1")),
              LT: L.parseCurve(fs.readFileSync(path.join(feb, "MRFREEZ.clw"), "latin1")) };
  const raws = walk(DATA).filter((p) => /_raw/.test(p) && L.isCurveFile(p) && !L.isIm(p));
  let n = 0;
  for (const p of raws) {
    const s = L.parseCurve(fs.readFileSync(p, "latin1"));
    if (!/HOTSTUFF|FREEZ$/i.test(s.emptyTag)) continue;           // stored vs Feb holder only
    const corr = L.correctCurve(s, H[L.kindOf(p)], 5);
    if (!corr.stats.compare) continue;                          // file carries no stored correction
    assert.ok(corr.stats.compare.mean < 0.07, `${path.basename(p)} mean ${corr.stats.compare.mean}`);
    n++;
  }
  assert.ok(n >= 4, `checked ${n}`);
});

test("written file round-trips and keeps untouched columns", { skip: !HAVE }, () => {
  const dir = path.join(DATA, "ER26PB002_TX", "ER26PB002_TX_raw");
  const p = path.join(dir, "ER26PB002-27H1.cur");
  const s = L.parseCurve(fs.readFileSync(p, "latin1"));
  const h = L.parseCurve(fs.readFileSync(path.join(DATA, "holder_corrections", "TX_holder_correction_260901", "DRHOTSTUFF260901.cur"), "latin1"));
  const corr = L.correctCurve(s, h, 5);
  const txt = L.writeCurve(s, corr, "DRHOTSTUFF260901");
  const back = L.parseCurve(txt);
  assert.equal(back.rows.length, s.rows.length);
  assert.equal(back.emptyTag, "UFF260901");
  back.rows.forEach((r, i) => {
    assert.equal(r.temp, s.rows[i].temp);
    assert.equal(r.tsusc, s.rows[i].tsusc);
    assert.equal(r.time, s.rows[i].time);
    assert.equal(r.tail, s.rows[i].tail);
    assert.equal(r.csusc, corr.csusc[i]);
  });
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

test("dry-run lookup: first bracketing pair, end values outside", () => {
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
  const tags = L.overlayTags([it(1, "ER26PB012-30SH1"), it(2, "ER26PB002-9-10L2"), it(3, "ER26PB002-27L1"),
    it(4, "ER26PB002-27L2"), it(5, "ER26PB002-27H1"), it(6, "ER26PB002-31H1"), it(7, "ER26PB012-31H1")]);
  assert.equal(tags.get(1), "30S");
  assert.equal(tags.get(2), "9-10");
  assert.equal(tags.get(3), "27 L1");          // same piece, same type -> run code
  assert.equal(tags.get(4), "27 L2");
  assert.equal(tags.get(5), "27");             // H1 differs by type (colour) already
  assert.equal(tags.get(6), "002 · 31");       // same piece, two specimens -> differing part
  assert.equal(tags.get(7), "012 · 31");
});
