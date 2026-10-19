/*
 * curlib.js -- file parsing and empty-holder correction for KLY5 / MFK
 * thermomagnetic runs (.cur = high-T furnace, .clw = low-T cryostat).
 *
 * The empty-holder correction:
 *
 *   holder   = the empty holder's TSUSC smoothed (running mean, N points, default 5),
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
  /** Transitions below what the instruments reach (liquid-nitrogen cryostat: about
   *  -196 deg C), shown as markers at the cold edge: [from, to (deg C), description, label] */
  const OFF_SCALE = {
    LT: [[-243.15, -239.15, "Besnus transition (monoclinic pyrrhotite), 30–34 K – below the cryostat's range", "Besnus 30–34 K"]],
  };

  /** Paramagnetic and diamagnetic rock-forming minerals: mean volume susceptibility near
   *  room temperature (x 10^-6 SI) and Weiss temperature theta (K; 0 = Curie law, null =
   *  temperature-independent). Paramagnetic values estimated from a typical FeO content
   *  (k ~ density x 25.2 x wt% Fe2+, Rochette 1987), within the ranges of Hunt et al. 1995. */
  const MINERALS = [
    { id: "biotite", name: "Biotite", k: 1000, theta: 0, note: "≈ 16 wt% FeO" },
    { id: "amphibole", name: "Hornblende", k: 850, theta: 0, note: "≈ 14 wt% FeO" },
    { id: "chlorite", name: "Chlorite", k: 700, theta: 0, note: "≈ 13 wt% FeO" },
    { id: "muscovite", name: "Muscovite / sericite", k: 120, theta: 0, note: "≈ 2 wt% FeO" },
    { id: "pyroxene", name: "Pyroxene", k: 700, theta: 0, note: "augite, ≈ 10 wt% FeO" },
    { id: "garnet", name: "Garnet", k: 2700, theta: 0, note: "almandine" },
    { id: "siderite", name: "Siderite", k: 4000, theta: 0, note: "" },
    { id: "pyrite", name: "Pyrite", k: 30, theta: 0, note: "low-spin Fe²⁺: nearly none" },
    { id: "quartz", name: "Quartz", k: -14, theta: null, note: "diamagnetic" },
    { id: "feldspar", name: "Feldspars", k: -13, theta: null, note: "diamagnetic" },
    { id: "calcite", name: "Calcite", k: -12, theta: null, note: "diamagnetic" },
  ];
  /** A monzogranite mode (porphyry intrusion, I-type: biotite + hornblende), vol %. */
  const MONZOGRANITE = { quartz: 30, feldspar: 60, biotite: 7, amphibole: 3 };

  /** Where Hopkinson peaks are looked for: just below the Curie points of pyrrhotite
   *  (~320-340 deg C) and magnetite (580 deg C). [from, to (deg C), mineral] */
  const HOPKINSON_WINDOWS = [[250, 360, "Po"], [500, 600, "Mag"]];

  // ------------------------------------------------------------------ names
  function basename(p) { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop(); }
  function dirname(p) { const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")); return i < 0 ? "" : p.slice(0, i); }
  function joinPath(dir, name) { return dir.replace(/[\\/]+$/, "") + "\\" + name; }
  function extOf(p) { const b = basename(p); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i).toLowerCase(); }
  function stemOf(p) { const b = basename(p); const i = b.lastIndexOf("."); return i < 0 ? b : b.slice(0, i); }

  /** Key that ignores case and separators: the raw data is not consistent about them
   *  (AB24CD117-13+15+16-L1.clw vs AB24CD117-13+15+16L1.KLT). */
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
   *  AB24CD117-13+15+16-L1.clw and AB24CD117-13+15+16L1_Im.clw are one run. */
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

  /** An empty-holder run (empty furnace / cryostat measurement)? The instrument record
   *  says so in its Note column ("EMPTY"); the names are a fallback. */
  function looksLikeDryRun(run, record) {
    if (record && /^empty$/i.test((record.note || "").trim())) return true;
    if (DRY_NAME_RE.test(run.stem)) return true;
    // in a holder folder, or in a dated folder inside one (holder_corrections/20261013/)
    return DRY_DIR_RE.test(basename(run.dir)) || DRY_DIR_RE.test(basename(dirname(run.dir)));
  }

  // ------------------------------------------------------------------ folder housekeeping
  /** The date written in a name -- 20261013 (YYYYMMDD) or 260901 (YYMMDD); the last such
   *  number counts ("TX_holder_correction_2026_260224" -> 24 Feb 2026). -> ms (noon) or null */
  function dateFromName(name) {
    const hits = String(name).match(/(?<!\d)(\d{8}|\d{6})(?!\d)/g);
    if (!hits) return null;
    const s = hits[hits.length - 1], full = s.length === 8 ? s : "20" + s;
    const y = +full.slice(0, 4), m = +full.slice(4, 6), d = +full.slice(6, 8);
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = new Date(y, m - 1, d, 12);
    return t.getMonth() === m - 1 ? t.getTime() : null;
  }
  const ymd = (t, full) => {
    const d = new Date(t), y = String(d.getFullYear());
    return (full ? y : y.slice(2)) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  };
  /** Standard name of an empty-holder folder measured on t: TX_holder_correction_YYYYMMDD */
  function holderDirName(t) { return "TX_holder_correction_" + ymd(t, true); }
  /** Standard stem of an empty-holder run, as the instrument names them: DRHOTSTUFF261013
   *  (furnace) / MRFREEZE20261013 (cryostat). */
  function holderFileStem(kind, t) { return kind === "HT" ? "DRHOTSTUFF" + ymd(t, false) : "MRFREEZE" + ymd(t, true); }
  /** A specimen folder's raw / corrected subfolders (the layout cureval_correct.py makes):
   *  AB24CD105_TX -> AB24CD105_TX_raw, AB24CD105_TX_corr */
  function specimenSubdirs(folderName) {
    const spec = String(folderName).replace(/_TX$/i, "");
    return { spec, raw: spec + "_TX_raw", corr: spec + "_TX_corr" };
  }
  /** True when fileSpec is folderSpec with 1-3 letters missing (AB24105 vs AB24CD105). */
  function missingLetters(fileSpec, folderSpec) {
    const a = String(fileSpec).toLowerCase(), b = String(folderSpec).toLowerCase();
    if (a === b || a.length >= b.length || b.length - a.length > 3 || !a) return false;
    let i = 0;
    for (const c of b) if (i < a.length && c === a[i]) i++;
    return i === a.length;
  }

  const RUN_RE = /^(.+?)[- ]?([HL]\d+)$/i;
  /** Split "AB24CD101-27H1" into specimen / piece / run label. The specimen ID leads the
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
   *  (AB24CD112-30SH1 -> "30S"). The same piece from different specimens gets the part of
   *  the specimen ID that differs ("101 · 31", "112 · 31"); the same piece twice for one
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

  /** What gets subtracted: the empty holder's TSUSC, smoothed per `spec` --
   *  {mode: "smooth", n} running mean over n points (a bare number means the same),
   *  {mode: "stored"} the smoothing already stored in the file's CSUSC column (running
   *  mean of n when the file has none), {mode: "none"} the measured values as they are. */
  function holderValues(rows, spec) {
    if (spec == null || typeof spec === "number") spec = { mode: "smooth", n: spec || 5 };
    const ts = rows.map((r) => r.tsusc);
    if (spec.mode === "none") return ts;
    if (spec.mode === "stored" && hasStoredSmoothing(rows)) return rows.map((r) => r.csusc);
    return runningMean(ts, spec.n || 5);
  }

  function hasStoredSmoothing(rows) { return rows.some((r) => Math.abs(r.csusc) > 5e-3); }

  /** Width of the running mean that reproduces the file's stored smoothing, or 0. */
  function storedSmoothingN(rows) {
    if (!hasStoredSmoothing(rows)) return 0;
    const ts = rows.map((r) => r.tsusc);
    for (let n = 1; n <= 31; n += 2) {
      const sm = runningMean(ts, n);
      if (sm.every((v, i) => Math.abs(v - rows[i].csusc) < 0.006)) return n;
    }
    return 0;
  }

  /** Least-squares fit of chi = chi0 + C / (T - theta), T in kelvin (temps in deg C), theta
   *  fixed: a paramagnetic part C / (T - theta) on top of a temperature-independent chi0
   *  (ferromagnetic + diamagnetic).
   *  -> { chi0, C, theta, n, rms, r2, seC (standard error of C) }, or null with fewer than 4 points. */
  function hyperbolaFit(temps, chis, theta = 0) {
    const n = temps.length;
    if (n < 4) return null;
    const xs = temps.map((t) => 1 / (t + 273.15 - theta));
    if (xs.some((x) => !(x > 0))) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = chis.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, sst = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (chis[i] - my); sst += (chis[i] - my) ** 2; }
    if (!(sxx > 0)) return null;
    const C = sxy / sxx, chi0 = my - C * mx;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (chis[i] - chi0 - C * xs[i]) ** 2;
    return { chi0, C, theta, n, rms: Math.sqrt(sse / n), r2: sst > 0 ? 1 - sse / sst : 1,
             seC: n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity };
  }

  /** Value of a fitted hyperbola at t (deg C). */
  function hyperbolaAt(fit, t) { return fit.chi0 + fit.C / (t + 273.15 - fit.theta); }

  /** Noise of a curve from its second differences (robust: median absolute deviation). */
  function noiseSigma(ys) {
    const d = [];
    for (let i = 1; i < ys.length - 1; i++) d.push(ys[i - 1] - 2 * ys[i] + ys[i + 1]);
    if (!d.length) return 0;
    const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const m = med(d);
    return (1.4826 * med(d.map((v) => Math.abs(v - m)))) / Math.sqrt(6);
  }

  /** Where a corrected run is paramagnetic on top of a constant: stretches of the heating
   *  (low-T: warming) branch that follow chi = chi0 + C / (T - theta) (Hrouda's hyperbola
   *  method), as candidates to fit. Only the heating branch: once a run has been heated,
   *  new minerals (magnetite) have formed, so cooling branches are not fitted.
   *  The branch is followed in measurement order: a stretch grows while the hyperbola
   *  fitted to it also predicts the next 8 deg C within the tolerance (4 x noise, 4 % of
   *  chi); where the curve stays outside it for 8 deg C it leaves the hyperbola -- a
   *  mineral forming or breaking down, or a Curie point. A low-T warming branch is also
   *  offered as a whole (the usual fit for cryostat runs). Kept are stretches of 60 deg C or
   *  more with a well-determined C > 0 whose hyperbola, extrapolated to room temperature,
   *  stays below the measured chi (what is left there is ferromagnetic). The first 8 deg C
   *  (start-up) and points beyond the empty holder's range are left out.
   *  -> [{ from, to, lo, hi, fit, n, whole, atStart, departure: { t, dir } | null, share }]
   *     from / to: first / last temperature in measurement order; departure: where the
   *     curve leaves the hyperbola after the stretch's start; share: the paramagnetic part
   *     at the point nearest refT: { t, para, measured, fraction, se } */
  function paraCandidates(corr, { theta = 0, refT = 25 } = {}) {
    const out = [];
    const lowT = !corr.temp.some((t) => t > 150);
    {
      const all = [];
      for (let i = 0; i < corr.temp.length; i++) if (corr.segment[i] === "heating") all.push(i);
      if (all.length < 12) return out;
      const t0 = corr.temp[all[0]];
      const idx = all.filter((i) => Math.abs(corr.temp[i] - t0) >= 8 && !(corr.outside && corr.outside[i]));
      const T = idx.map((i) => corr.temp[i]), X = idx.map((i) => corr.csusc[i]);
      const n = T.length;
      if (n < 12) return out;
      const span = Math.max(...T) - Math.min(...T);
      const sigma = noiseSigma(X);
      const need = Math.max(5, Math.round((8 * n) / (span || 1)));      // points in 8 deg C
      const grow = Math.max(2, need >> 1), MIN_SPAN = 60;
      const kRef = nearestIndex(T, refT), tRef = T[kRef], mRef = X[kRef];
      const fitOf = (a, b) => hyperbolaFit(T.slice(a, b + 1), X.slice(a, b + 1), theta);
      // first point from j0 on that starts `need` consecutive points on one side of the band
      const leaves = (fit, j0, j1) => {
        let side = 0, start = -1, count = 0;
        for (let j = j0; j <= j1; j++) {
          const f = hyperbolaAt(fit, T[j]), d = X[j] - f, tl = Math.max(4 * sigma, 0.04 * Math.abs(f));
          const s = d > tl ? 1 : d < -tl ? -1 : 0;
          if (s && s === side) count++;
          else if (s) { side = s; start = j; count = 1; } else { side = 0; count = 0; }
          if (count >= need) return { j: start, dir: side };
        }
        return null;
      };
      const xr = 1 / (tRef + 273.15 - theta);
      const physical = (f) => f && f.C > 0 && f.C >= 5 * f.seC &&
        f.chi0 + f.C * xr - mRef <= Math.max(4 * sigma, 0.25 * Math.abs(mRef)) &&
        !(mRef > 0 && (f.seC * xr) / mRef > 0.3);
      const add = (j, end, f, dep, whole) => {
        const para = f.C * xr;
        out.push({
          from: T[j], to: T[end], lo: Math.min(T[j], T[end]), hi: Math.max(T[j], T[end]), fit: f, n: end - j + 1,
          whole, atStart: j === 0, departure: dep ? { t: T[dep.j], dir: dep.dir } : null,
          share: { t: tRef, para, measured: mRef, fraction: mRef > 0 ? para / mRef : null, se: mRef > 0 ? (f.seC * xr) / mRef : null },
        });
      };
      if (lowT) {
        const f = fitOf(0, n - 1);
        if (physical(f)) add(0, n - 1, f, leaves(f, 0, n - 1), true);
      }
      let j = 0;
      while (j + need < n) {
        // grow while the hyperbola fitted so far also predicts the next 8 deg C
        let k = Math.min(n - 1, j + Math.max(8, need * 2) - 1);
        let fit = fitOf(j, k);
        if (!fit || leaves(fit, j, k)) { j += grow; continue; }
        let dep = null;
        for (;;) {
          dep = leaves(fit, j, Math.min(n - 1, k + need));
          if (dep || k >= n - 1) break;
          k = Math.min(n - 1, k + grow);
          fit = fitOf(j, k);
        }
        const end = dep ? Math.max(j, Math.min(k, dep.j - 1)) : k;
        const f = end === k ? fit : fitOf(j, end);
        if (Math.abs(T[end] - T[j]) >= MIN_SPAN && physical(f)) {
          // a stretch that is (nearly) the whole low-T branch adds nothing to the whole-branch fit
          const w = out.find((c) => c.whole);
          if (!(w && Math.min(w.hi, Math.max(T[j], T[end])) - Math.max(w.lo, Math.min(T[j], T[end])) >= 0.85 * (w.hi - w.lo))) add(j, end, f, dep, false);
          j = end + 1;
        } else j = dep && dep.j > j ? Math.max(j + grow, dep.j - need) : j + grow;
      }
    }
    return out;
  }

  /** Susceptibility of a mineral mix at t (deg C): the sum of vol-fraction x chi, the
   *  paramagnetic minerals following Curie-Weiss from their value at refT.
   *  mix: [{ pct, k, theta }] (theta null: temperature-independent) */
  function mixChi(mix, t, refT = 25) {
    let s = 0;
    for (const m of mix) {
      const f = (m.pct || 0) / 100;
      if (!f) continue;
      if (m.theta == null || !(m.k > 0)) { s += f * m.k; continue; }
      const d = t + 273.15 - m.theta;
      s += d > 0.5 ? (f * m.k * (refT + 273.15 - m.theta)) / d : 0;
    }
    return s;
  }

  // ------------------------------------------------------------------ curve features
  /** Each branch in temperature order, chi lightly smoothed (centred mean of 5). */
  function branchesByT(temps, chis, segment) {
    const out = [];
    for (const branch of ["heating", "cooling"]) {
      const idx = [];
      for (let i = 0; i < temps.length; i++) if (segment[i] === branch && Number.isFinite(chis[i])) idx.push(i);
      if (idx.length < 15) continue;
      idx.sort((a, b) => temps[a] - temps[b]);
      const raw = idx.map((i) => chis[i]);
      const Y = raw.map((_, k) => {
        const a = Math.max(0, k - 2), b = Math.min(raw.length - 1, k + 2);
        let s = 0;
        for (let j = a; j <= b; j++) s += raw[j];
        return s / (b - a + 1);
      });
      out.push({ branch, idx, T: idx.map((i) => temps[i]), Y, sigma: noiseSigma(raw) });
    }
    return out;
  }

  /** Hopkinson peaks: a maximum of chi just below a Curie point -- above the curve 40-120
   *  deg C colder by 4 % or more, and followed within 60 deg C by a drop to 60 % or less --
   *  near the pyrrhotite or magnetite Curie point only (HOPKINSON_WINDOWS).
   *  -> [{ t, chi, branch, i, mineral }] (i: index in the run) */
  function hopkinsonPeaks(temps, chis, segment) {
    const out = [];
    for (const { branch, idx, T, Y, sigma } of branchesByT(temps, chis, segment)) {
      let last = null;
      for (let k = 0; k < T.length; k++) {
        const t = T[k], y = Y[k];
        if (!(y > 0)) continue;
        let isMax = true, minAfter = Infinity, sum = 0, cnt = 0;
        for (let j = 0; j < T.length; j++) {
          const d = T[j] - t;
          if (Math.abs(d) <= 15 && Y[j] > y) { isMax = false; break; }
          if (d > 0 && d <= 60) minAfter = Math.min(minAfter, Y[j]);
          if (d >= -120 && d <= -40) { sum += Y[j]; cnt++; }
        }
        if (!isMax || !(minAfter <= 0.6 * y) || cnt < 3) continue;
        const base = sum / cnt;
        if (!(y >= 1.04 * base && y - base >= 4 * sigma)) continue;
        if (last && t - last.t < 15) continue;
        const win = HOPKINSON_WINDOWS.find(([a, b]) => t >= a && t <= b);
        if (!win) continue;
        last = { t, chi: chis[idx[k]], branch, i: idx[k], mineral: win[2] };
        out.push(last);
      }
    }
    return out;
  }

  /** Steepest changes of chi with temperature (Curie points, Verwey steps): the steepest
   *  spot of each stretch where chi changes by 25 % or more within 30 deg C.
   *  -> [{ t, branch, dir }] (dir -1: chi falls with rising temperature, +1: rises) */
  function steepChanges(temps, chis, segment) {
    const out = [];
    for (const { branch, T, Y, sigma } of branchesByT(temps, chis, segment)) {
      const at = (t) => {          // Y at temperature t (linear between neighbours)
        let j = 0;
        while (j < T.length - 1 && T[j + 1] < t) j++;
        if (j >= T.length - 1 || T[j + 1] === T[j]) return Y[Math.min(j, Y.length - 1)];
        const f = Math.max(0, Math.min(1, (t - T[j]) / (T[j + 1] - T[j])));
        return Y[j] + f * (Y[j + 1] - Y[j]);
      };
      const scale = Math.max(...Y.map(Math.abs)) || 1;
      const hits = [];
      for (let k = 0; k < T.length; k++) {
        const t = T[k];
        if (t - 15 < T[0] || t + 15 > T[T.length - 1]) continue;
        // the first 25 deg C a branch runs through are start-up (furnace / cryostat settling)
        if (branch === "heating" ? t - T[0] < 25 : T[T.length - 1] - t < 25) continue;
        const a = at(t - 15), b = at(t + 15), d = b - a;
        if (Math.abs(d) >= 0.25 * Math.max(Math.abs(a), Math.abs(b)) && Math.abs(d) >= Math.max(6 * sigma, 0.08 * scale)) hits.push({ t, d });
      }
      // one per stretch of consecutive hits: the steepest
      let group = [];
      const flush = () => {
        if (!group.length) return;
        const best = group.reduce((p, q) => (Math.abs(q.d) > Math.abs(p.d) ? q : p));
        out.push({ t: best.t, branch, dir: best.d < 0 ? -1 : 1 });
        group = [];
      };
      for (const hgt of hits) {
        if (group.length && (hgt.t - group[group.length - 1].t > 15 || Math.sign(hgt.d) !== Math.sign(group[0].d))) flush();
        group.push(hgt);
      }
      flush();
    }
    return out;
  }

  /** Sort rank of a run code in experiment order: L1, H1, L2, H2, L3 ... (others last). */
  function runRank(code) {
    const m = /^([HL])(\d+)$/i.exec(code || "");
    return m ? +m[2] * 2 + (m[1].toUpperCase() === "H" ? 1 : 0) : 1e6;
  }

  /** The candidate to show by default: a low-T warming branch as a whole, the stretch a
   *  heating starts with (before the sample changes), else the longest stretch. */
  function defaultParaCandidate(cands) {
    return cands.find((c) => c.whole) || cands.find((c) => c.atStart) || [...cands].sort((a, b) => b.n - a.n)[0] || null;
  }

  /** Index of the value nearest to target. */
  function nearestIndex(values, target) {
    let k = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - target) < Math.abs(values[k] - target)) k = i;
    return k;
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

  /** Empty-holder lookup for one branch: below the branch's first point / beyond its last
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
  function holderTrace(holderRows, sampleTemps, smooth) {
    const hT = holderRows.map((r) => r.temp);
    const hS = holderValues(holderRows, smooth);
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
   * Correct one curve against one empty-holder run. `smooth`: see holderValues.
   * @returns {{temp,time,tsusc,holder,csusc,nsusc,segment,outside,stored,stats}}
   */
  function correctCurve(sample, holder, smooth) {
    const rows = sample.rows;
    const temp = rows.map((r) => r.temp);
    const time = rows.map((r) => r.time);
    const tsusc = rows.map((r) => r.tsusc);
    const h = holderTrace(holder.rows, temp, smooth);
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

  /** Correct a run: in-phase against the empty holder, out-of-phase (_Im) against the
   *  empty holder's own _Im file -- never against its in-phase curve. cout is null when
   *  either _Im file is missing. Both are smoothed the same way (see holderValues).
   *  -> { cin, cout } */
  function correctRun(curve, curveIm, holder, holderIm, smooth) {
    return {
      cin: correctCurve(curve, holder, smooth),
      cout: curveIm && holderIm ? correctCurve(curveIm, holderIm, smooth) : null,
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

  /** The specimen notes file for runs in runDir: <X>_raw/ and <X>_corr/ share <X>_notes.json
   *  beside them, any other folder gets <folder>/<folder>_notes.json. */
  function notesPath(runDir) {
    const name = basename(runDir);
    if (/_(raw|corr)$/i.test(name)) return joinPath(dirname(runDir), name.replace(/_(raw|corr)$/i, "") + "_notes.json");
    return joinPath(runDir, name + "_notes.json");
  }

  /** Notes file text: JSON with every non-ASCII character escaped, so it survives the
   *  Latin-1 file I/O unchanged. file: { notes: {stem: text}, marks: {stem: [mark]},
   *  links: {stem: {item: target}}, acks: {stem: {notice: value}} } -- marks are annotations
   *  on the plot, links tie a note item to a point of a curve, acks are notices marked OK. */
  function notesText(file) {
    const byName = (o, keep) => {
      const out = {};
      for (const k of Object.keys(o || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) if (keep(o[k])) out[k] = o[k];
      return out;
    };
    const doc = { app: "TX Studio", about: "Notes per run, plot annotations and links, edited in TX Studio",
      notes: byName(file.notes, (v) => !!v),
      marks: byName(file.marks, (v) => Array.isArray(v) && v.length),
      links: byName(file.links, (v) => v && Object.keys(v).length),
      acks: byName(file.acks, (v) => v && Object.keys(v).length) };
    return JSON.stringify(doc, null, 2).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\r\n";
  }

  /** -> { notes, marks, links, acks }, or null when the text is not a TX Studio notes file. */
  function parseNotes(text) {
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== "object" || !d.notes || typeof d.notes !== "object" || Array.isArray(d.notes)) return null;
      const notes = {}, marks = {}, links = {}, acks = {};
      for (const [k, v] of Object.entries(d.notes)) if (typeof v === "string" && v.trim()) notes[k] = v;
      for (const [k, v] of Object.entries(d.marks || {})) {
        const ok = Array.isArray(v) ? v.filter((m) => m && typeof m.text === "string" && Number.isInteger(m.i)) : [];
        if (ok.length) marks[k] = ok;
      }
      for (const [k, v] of Object.entries(d.links || {})) if (v && typeof v === "object" && !Array.isArray(v)) links[k] = v;
      for (const [k, v] of Object.entries(d.acks || {})) if (v && typeof v === "object" && !Array.isArray(v)) acks[k] = v;
      return { notes, marks, links, acks };
    } catch { return null; }
  }

  return {
    COL, REF_LINES, OFF_SCALE, MINERALS, MONZOGRANITE, HOPKINSON_WINDOWS,
    dateFromName, holderDirName, holderFileStem, specimenSubdirs, missingLetters,
    basename, dirname, joinPath, extOf, stemOf, loose, isCurveFile, isRecordFile, kindOf, isIm, mainStem,
    parseCurve, parseRecord, findRecordPath, runId, groupRuns, looksLikeDryRun, runLabel, overlayTags,
    runningMean, holderValues, hasStoredSmoothing, storedSmoothingN, nearestIndex,
    hyperbolaFit, hyperbolaAt, noiseSigma, paraCandidates, defaultParaCandidate, mixChi,
    hopkinsonPeaks, steepChanges, runRank,
    segments, holderTrace, correctCurve, correctRun, pairDryRun,
    writeCurve, runCsv, outputDir, notesPath, notesText, parseNotes, round,
  };
});
