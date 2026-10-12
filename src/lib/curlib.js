/*
 * curlib.js -- file parsing and dry-run (empty holder) correction for KLY5 / MFK
 * thermomagnetic runs (.cur = high-T furnace, .clw = low-T cryostat).
 *
 * The empty-holder correction:
 *
 *   holder   = running mean of the dry run's TSUSC, N points (default 5),
 *              first/last N/2 points copied from the nearest full window, rounded 0.01
 *              -- bit-exact against every smoothed holder file tested
 *   CSUSC(i) = TSUSC(i) - holder(T(i))      heating and cooling branches kept separate,
 *              linear between the first bracketing pair (see branchLookup)
 *   NSUSC(i) = CSUSC(i) / max(CSUSC)        signed (algebraic) maximum
 *
 * UMD: require()-able from Node (tests) and a plain <script> in the renderer.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CurLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Fixed-width columns of .cur/.clw files (0-based [start, end)).
  const COL = {
    TEMP: [0, 6], TSUSC: [6, 15], CSUSC: [15, 25], NSUSC: [25, 31],
    BULKS: [31, 43], FERRT: [43, 52], FERRB: [52, 61], TIME: [61, 68], TAIL: [68, 77],
  };
  const NUM_RE = /-?\d+\.\d+|-?\d+/g;

  // Transition temperatures to read curves against (deg C): Curie/Neel points after
  // Hunt, Moskowitz & Banerjee (1995), Dunlop & Ozdemir (1997).
  // [temperature, name, short label shown above the plot]
  const REF_LINES = {
    HT: [[320, "pyrrhotite Curie point", "Po"], [580, "magnetite Curie point", "Mag"], [675, "hematite Néel point", "Hem"]],
    LT: [[-153, "Verwey transition (magnetite)", "T<sub>V</sub>"], [-13, "Morin transition (hematite)", "T<sub>M</sub>"]],
  };

  // ------------------------------------------------------------------ names
  function basename(p) { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop(); }
  function dirname(p) { const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")); return i < 0 ? "" : p.slice(0, i); }
  function joinPath(dir, name) { return dir.replace(/[\\/]+$/, "") + "\\" + name; }
  function extOf(p) { const b = basename(p); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i).toLowerCase(); }
  function stemOf(p) { const b = basename(p); const i = b.lastIndexOf("."); return i < 0 ? b : b.slice(0, i); }

  /** Key that ignores case and separators: the raw data is not consistent about them
   *  (ER26PB017-13+15+16-L1.clw vs ER26PB017-13+15+16L1.KLT). */
  function loose(s) { return s.toLowerCase().replace(/[^0-9a-z]/g, ""); }

  function isCurveFile(p) { const e = extOf(p); return e === ".cur" || e === ".clw"; }
  function isRecordFile(p) { const e = extOf(p); return e === ".kht" || e === ".klt"; }
  function kindOf(p) { return extOf(p) === ".cur" ? "HT" : "LT"; }
  function isIm(p) { return /_im$/i.test(stemOf(p)); }
  function mainStem(p) { return stemOf(p).replace(/_im$/i, ""); }

  // ------------------------------------------------------------------ parsing
  /** Parse a .cur/.clw text. Fixed-width first (columns can touch, e.g.
   *  "-0.66-0.019"), token fallback for odd files. */
  function parseCurve(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const header = lines[0] || "";
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;
      let r = fixedRow(ln);
      if (!r) r = tokenRow(ln);
      if (r) rows.push(r);
    }
    return {
      header,
      rows,
      // the header carries the last 9 chars of the empty-holder file name after TIME
      emptyTag: header.length > 68 ? header.slice(68).trim() : "",
    };
  }

  function fixedRow(ln) {
    const f = (k) => parseFloat(ln.slice(COL[k][0], COL[k][1]));
    const temp = f("TEMP"), tsusc = f("TSUSC"), csusc = f("CSUSC"), nsusc = f("NSUSC"), time = f("TIME");
    if (![temp, tsusc, csusc, time].every(Number.isFinite)) return null;
    return { temp, tsusc, csusc, nsusc: Number.isFinite(nsusc) ? nsusc : 0, time,
             tail: ln.slice(COL.TAIL[0]).trim(), raw: ln };
  }

  function tokenRow(ln) {
    const t = ln.match(NUM_RE);
    if (!t || t.length < 8) return null;
    return { temp: +t[0], tsusc: +t[1], csusc: +t[2], nsusc: +t[3], time: +t[7],
             tail: t.slice(8).join(" "), raw: null };
  }

  /** Parse a .KHT/.KLT instrument record: whitespace table with a header row. */
  function parseRecord(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    if (!lines.length) return null;
    const cols = lines[0].trim().split(/\s+/);
    const idx = (n) => cols.indexOf(n);
    const first = lines.length > 1 ? lines[1].trim().split(/\s+/) : [];
    const last = lines.length > 1 ? lines[lines.length - 1].trim().split(/\s+/) : [];
    const get = (row, n) => (idx(n) >= 0 && row.length > idx(n) ? row[idx(n)] : null);
    // Note is the last column and may be blank or contain spaces
    const noteAt = idx("Note");
    const note = noteAt >= 0 && first.length > noteAt ? first.slice(noteAt).join(" ") : "";
    return {
      spec: get(first, "SpecName"),
      mode: get(first, "Mode"),
      field: num(get(first, "Field")),
      freq: num(get(first, "Freq")),
      instrument: get(first, "InstName"),
      note,
      start: dateTime(get(first, "Date"), get(first, "Time")),
      end: dateTime(get(last, "Date"), get(last, "Time")),
      points: lines.length - 1,
    };
  }

  function num(s) { const v = parseFloat(s); return Number.isFinite(v) ? v : null; }

  /** "26-08-2026" + "12:23:08" -> epoch ms (local time), or null */
  function dateTime(d, t) {
    if (!d) return null;
    const m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(d);
    if (!m) return null;
    const [hh, mm, ss] = (t || "0:0:0").split(":").map((x) => parseInt(x, 10) || 0);
    return new Date(+m[3], +m[2] - 1, +m[1], hh, mm, ss).getTime();
  }

  /** The .KHT/.KLT record beside a .cur/.clw (same stem, _Im off, separators loose). */
  function findRecordPath(curvePath, siblingPaths) {
    const want = extOf(curvePath) === ".cur" ? ".kht" : ".klt";
    const key = loose(mainStem(curvePath));
    const dir = dirname(curvePath).toLowerCase();
    let hit = null;
    for (const p of siblingPaths) {
      if (extOf(p) !== want || dirname(p).toLowerCase() !== dir) continue;
      if (stemOf(p) === mainStem(curvePath)) return p;
      if (loose(stemOf(p)) === key) hit = p;
    }
    return hit;
  }

  // ------------------------------------------------------------------ runs
  /** Run identity of a .cur/.clw path: folder + separator-blind stem + extension, so
   *  ER26PB017-13+15+16-L1.clw and ER26PB017-13+15+16L1_Im.clw are one run. */
  function runId(p) {
    return (dirname(p) + "\\" + loose(mainStem(p)) + extOf(p)).toLowerCase();
  }

  /** Group .cur/.clw paths into runs: one in-phase file + optional _Im partner. */
  function groupRuns(paths) {
    const runs = new Map();
    for (const p of paths) {
      if (!isCurveFile(p)) continue;
      const key = runId(p);
      let r = runs.get(key);
      if (!r) {
        r = { id: key, dir: dirname(p), stem: mainStem(p), kind: kindOf(p), main: null, im: null };
        runs.set(key, r);
      }
      if (isIm(p)) r.im = p; else { r.main = p; r.stem = mainStem(p); }
    }
    // an orphan _Im file still shows up, as its own run
    for (const r of runs.values()) if (!r.main) { r.main = r.im; r.im = null; r.imOnly = true; }
    return [...runs.values()];
  }

  const DRY_NAME_RE = /hotstuff|freez|frosty|empty|dry[ _-]?run|blank/i;
  const DRY_DIR_RE = /holder|empty|dry[ _-]?run|blank/i;

  /** A dry run (empty holder / furnace / cryostat measurement)? The instrument record
   *  says so in its Note column ("EMPTY"); the names are a fallback. */
  function looksLikeDryRun(run, record) {
    if (record && /^empty$/i.test((record.note || "").trim())) return true;
    if (DRY_NAME_RE.test(run.stem)) return true;
    return DRY_DIR_RE.test(basename(run.dir));
  }

  const RUN_RE = /^(.+?)[- ]?([HL]\d+)$/i;
  /** Split "ER26PB002-27H1" into specimen / piece / run label. The specimen ID leads the
   *  file name (lab convention): taken from the folder name when it matches, otherwise
   *  the file name's first "-"-separated part. */
  function runLabel(stem, folderName) {
    let spec = (folderName || "").replace(/_TX(_raw|_corr)?$/i, "").replace(/_(raw|corr)$/i, "");
    let rest = stem;
    if (spec && rest.toLowerCase().startsWith(spec.toLowerCase() + "-")) rest = rest.slice(spec.length + 1);
    else {
      const m = /^([^-\s]+)-(.+)$/.exec(stem);
      spec = m ? m[1] : "";
      rest = m ? m[2] : stem;
    }
    const m = RUN_RE.exec(rest);
    return m ? { spec, piece: m[1], run: m[2].toUpperCase() } : { spec, piece: rest, run: "" };
  }

  /** Short, unique tags for overlaid runs: the piece between specimen ID and run code
   *  (ER26PB012-30SH1 -> "30S"). The same piece from different specimens gets the part of
   *  the specimen ID that differs ("002 · 31", "012 · 31"); the same piece twice for one
   *  run type (27L1, 27L2) gets the run code ("27 L1"). items: {id, spec, piece, run, kind}
   *  -> Map id -> tag. */
  function overlayTags(items) {
    const text = new Map(items.map((i) => [i.id, i.piece]));
    const dupes = (key) => {
      const m = new Map();
      for (const i of items) { const k = key(i); if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
      return [...m.values()].filter((g) => g.length > 1);
    };
    for (const g of dupes((i) => text.get(i.id))) {
      const specs = [...new Set(g.map((i) => i.spec || ""))];
      if (specs.length < 2) continue;
      let pre = specs.reduce((a, b) => { let k = 0; while (k < a.length && a[k] === b[k]) k++; return a.slice(0, k); });
      while (pre && /\d/.test(pre[pre.length - 1])) pre = pre.slice(0, -1);   // don't split a number
      for (const i of g) text.set(i.id, `${(i.spec || "").slice(pre.length) || i.spec} · ${text.get(i.id)}`);
    }
    for (const g of dupes((i) => text.get(i.id) + "|" + i.kind)) {
      for (const i of g) if (i.run) text.set(i.id, `${text.get(i.id)} ${i.run}`);
    }
    return text;
  }

  // ------------------------------------------------------------------ correction
  /** Running mean: N-point centred window over TSUSC, edges copied from the
   *  nearest full window, rounded to 0.01. */
  function runningMean(values, n) {
    n = Math.max(1, n | 0);
    if (n % 2 === 0) n += 1;
    const N = values.length, h = n >> 1, out = values.slice();
    if (N < n) {
      const m = values.reduce((a, b) => a + b, 0) / (N || 1);
      return values.map(() => round(m, 2));
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += values[i];
    for (let i = h; i < N - h; i++) {
      if (i > h) s += values[i + h] - values[i - h - 1];
      out[i] = s / n;
    }
    for (let i = 0; i < h; i++) { out[i] = out[h]; out[N - 1 - i] = out[N - 1 - h]; }
    return out.map((v) => round(v, 2));
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f + (v >= 0 ? 1e-9 : -1e-9)) / f; }

  function argmax(a) { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; }

  /** Heating/cooling split at the maximum temperature (low-T runs only warm up, so
   *  they come out as one heating branch). */
  function segments(temps) {
    const k = argmax(temps);
    return temps.map((_, i) => (i <= k ? "heating" : "cooling"));
  }

  /** Linear interpolation, clamped to the end values; xs need not be sorted. */
  function makeInterp(xs, ys) {
    const o = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    const X = o.map((i) => xs[i]), Y = o.map((i) => ys[i]);
    return (x) => {
      if (!X.length) return NaN;
      if (x <= X[0]) return Y[0];
      if (x >= X[X.length - 1]) return Y[Y.length - 1];
      let lo = 0, hi = X.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X[m] <= x) lo = m; else hi = m; }
      return X[hi] === X[lo] ? Y[lo] : Y[lo] + (Y[hi] - Y[lo]) * (x - X[lo]) / (X[hi] - X[lo]);
    };
  }

  /** Dry-run lookup for one branch: below the branch's first point / beyond its last
   *  point the end value is used; otherwise the FIRST pair in measurement order that
   *  brackets T (rising pairs when heating, falling pairs when cooling) is interpolated
   *  linearly. Single precision throughout, matching the values stored in the files. */
  function branchLookup(temps, values, heating) {
    const F = Math.fround;
    const xh = temps.map(F), yh = values.map(F), n = xh.length;
    if (!n) return () => NaN;
    return (t) => {
      const x = F(t);
      if (heating ? !(xh[0] < x) : !(x < xh[0])) return yh[0];
      if (heating ? xh[n - 1] <= x : x <= xh[n - 1]) return yh[n - 1];
      for (let j = 1; j < n; j++) {
        const inside = heating ? xh[j - 1] <= x && x < xh[j] : xh[j] < x && x <= xh[j - 1];
        if (!inside) continue;
        const a = F(F(yh[j] - yh[j - 1]) / F(xh[j] - xh[j - 1]));
        const b = F(yh[j] - F(a * xh[j]));
        return F(F(a * x) + b);
      }
      return makeInterp(xh, yh)(x);       // no bracketing pair: plain interpolation
    };
  }

  /** The smoothed holder trace evaluated at the sample's temperatures, heating and
   *  cooling branches kept separate (the furnace/cryostat behaves differently on the
   *  way up and down). */
  function holderTrace(holderRows, sampleTemps, smoothN) {
    const hT = holderRows.map((r) => r.temp);
    const hS = runningMean(holderRows.map((r) => r.tsusc), smoothN);
    const hk = argmax(hT), sk = argmax(sampleTemps);
    const heat = branchLookup(hT.slice(0, hk + 1), hS.slice(0, hk + 1), true);
    const coolT = hT.slice(hk + 1), coolS = hS.slice(hk + 1);
    const cool = coolT.length ? branchLookup(coolT, coolS, false) : heat;
    const tmin = Math.min(...hT), tmax = Math.max(...hT);
    const trace = sampleTemps.map((t, i) => (i <= sk ? heat(t) : cool(t)));
    const outside = sampleTemps.map((t) => (t < tmin - 0.05 ? -1 : t > tmax + 0.05 ? 1 : 0));
    return { trace, smoothed: hS, tmin, tmax, outside };
  }

  /**
   * Correct one curve against one dry run.
   * @returns {{temp,time,tsusc,holder,csusc,nsusc,segment,outside,stored,stats}}
   */
  function correctCurve(sample, holder, smoothN) {
    const rows = sample.rows;
    const temp = rows.map((r) => r.temp);
    const time = rows.map((r) => r.time);
    const tsusc = rows.map((r) => r.tsusc);
    const h = holderTrace(holder.rows, temp, smoothN);
    const csusc = tsusc.map((v, i) => round(Math.fround(Math.fround(v) - h.trace[i]), 2));
    const smax = Math.max(...csusc);
    const nsusc = csusc.map((v) => (smax ? round(v / smax, 3) : 0));

    const storedC = rows.map((r) => r.csusc);
    const hasStored = storedC.some((v) => Math.abs(v) > 5e-3);
    let compare = null;
    if (hasStored) {
      const d = storedC.map((v, i) => Math.abs(v - csusc[i]));
      compare = { mean: d.reduce((a, b) => a + b, 0) / d.length, max: Math.max(...d) };
    }
    const cold = h.outside.filter((x) => x < 0).length, warm = h.outside.filter((x) => x > 0).length;
    return {
      temp, time, tsusc, holder: h.trace, csusc, nsusc,
      segment: segments(temp), outside: h.outside,
      stored: hasStored ? { csusc: storedC, nsusc: rows.map((r) => r.nsusc) } : null,
      stats: { n: rows.length, cold, warm, holderTmin: h.tmin, holderTmax: h.tmax, compare },
    };
  }

  /** Pick the dry run for a sample: same kind (HT/LT) and component, nearest in time
   *  (or latest at/before the sample with rule "preceding"). The holder trace drifts,
   *  so a February dry run is a poor baseline for a September sample. */
  function pairDryRun(sampleTime, candidates, rule) {
    if (!candidates.length) return null;
    const dated = candidates.filter((c) => c.time != null);
    if (sampleTime == null || !dated.length) {
      return [...candidates].sort((a, b) => (b.time || 0) - (a.time || 0))[0];
    }
    if (rule === "preceding") {
      const before = dated.filter((c) => c.time <= sampleTime);
      if (before.length) return before.sort((a, b) => b.time - a.time)[0];
    }
    return dated.sort((a, b) => Math.abs(a.time - sampleTime) - Math.abs(b.time - sampleTime))[0];
  }

  // ------------------------------------------------------------------ writing
  function fmt(v, w, d) { return v.toFixed(d).padStart(w); }

  /** Re-emit a .cur/.clw file with new CSUSC/NSUSC. Every other column of each line
   *  (TEMP, TSUSC, FERRT, FERRB, TIME and the trailing parameter column) is kept as it
   *  was; BULKS is zeroed because it derives from the old CSUSC. The header's EMPTY
   *  field names the dry run. */
  function writeCurve(sample, corr, dryRunStem) {
    const hdr = sample.header.padEnd(68).slice(0, 68) + dryRunStem.slice(-9).padStart(9);
    const out = [hdr];
    sample.rows.forEach((r, i) => {
      const raw = r.raw || synthRow(r);
      out.push(raw.slice(0, 15) + fmt(corr.csusc[i], 10, 2) + fmt(corr.nsusc[i], 6, 3) +
               fmt(0, 12, 1) + raw.slice(43));
    });
    return out.join("\r\n") + "\r\n";
  }

  function synthRow(r) {
    return fmt(r.temp, 6, 1) + fmt(r.tsusc, 9, 1) + fmt(r.csusc, 10, 2) + fmt(r.nsusc, 6, 3) +
           fmt(0, 12, 1) + fmt(0, 9, 1) + fmt(0, 9, 1) + fmt(r.time, 7, 0) + "".padStart(9);
  }

  /** Tidy CSV of one run, one row per measured point: the lab's established columns
   *  in their order (segment "warming" for runs that only warm up), then the raw and dry-run
   *  values. Same columns for every run so per-folder CSVs concatenate. */
  function runCsv(meta, corrIn, corrOut) {
    const head = ["piece", "run", "mode", "temp_C", "time_s", "segment", "chi_in_1e6SI",
                  "chi_in_norm", "chi_out_1e6SI", "chi_raw_1e6SI", "holder_1e6SI"];
    const lines = [head.join(",")];
    const k = argmax(corrIn.temp), n = corrIn.temp.length;
    const oneWay = k === 0 || k === n - 1;
    corrIn.temp.forEach((t, i) => {
      lines.push([csvq(meta.piece), csvq(meta.run), meta.kind === "LT" ? "low-T" : "high-T",
                  t, Math.round(corrIn.time[i]), oneWay ? "warming" : corrIn.segment[i],
                  corrIn.csusc[i], corrIn.nsusc[i], corrOut ? corrOut.csusc[i] : "",
                  corrIn.tsusc[i], round(corrIn.holder[i], 2)].join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function csvq(s) { s = String(s == null ? "" : s); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  /** Where corrected output goes: <X>_raw/ -> sibling <X>_corr/, otherwise a
   *  <folder>_corr/ inside the run's folder (the lab's established layout). */
  function outputDir(runDir) {
    const name = basename(runDir);
    if (/_raw$/i.test(name)) return joinPath(dirname(runDir), name.replace(/_raw$/i, "_corr"));
    return joinPath(runDir, name + "_corr");
  }

  return {
    COL, REF_LINES,
    basename, dirname, joinPath, extOf, stemOf, loose, isCurveFile, isRecordFile, kindOf, isIm, mainStem,
    parseCurve, parseRecord, findRecordPath, runId, groupRuns, looksLikeDryRun, runLabel, overlayTags,
    runningMean, segments, holderTrace, correctCurve, pairDryRun,
    writeCurve, runCsv, outputDir, round,
  };
});
