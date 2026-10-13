/* TX Studio renderer: folder sidebar, curve viewer, automatic empty-holder correction. */
"use strict";
const L = window.CurLib;
// `api` is the global the preload bridge exposes (window.api)

// ====================================================================== helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ICON = {
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  folder: '<svg class="ficon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg class="ficon" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
};
const DAY = 86400000;
const fmtDate = (t) => (t == null ? "—" : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
const fmtDateTime = (t) => (t == null ? "—" : `${fmtDate(t)}, ${new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
const fmtShort = (t) => (t == null ? "" : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
const fmtDays = (ms) => { const d = Math.round(Math.abs(ms) / DAY); return d === 0 ? "same day" : `${d} day${d === 1 ? "" : "s"} ${ms < 0 ? "before" : "after"}`; };
const isoDate = (t) => (t == null ? "undated" : new Date(t).toISOString().slice(0, 10));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ====================================================================== state
const DEFAULTS = {
  smoothN: 5, rule: "nearest", view: "corrected", comp: "in",
  heating: true, cooling: true, markers: false, refs: true, stored: false, para: false, paraTheta: 0,
  model: false, modelMix: null, modelProps: {}, modelY: {},
  onlyCurves: true, showCorr: false, showIm: false, theme: "system", sideW: 300, dryOpen: true,
  overrides: {}, dryOverrides: {}, holderSmooth: {}, paraPick: {}, expanded: {}, lastSel: {}, lastRoot: null,
};
const state = {
  root: null, tree: null,
  runs: new Map(),          // id -> run (everything parsed, incl. external empty holders)
  dry: [],                  // empty-holder runs available for pairing
  visible: [],              // run ids in sidebar order (keyboard navigation)
  selected: [], anchor: null,
  expanded: new Set(),
  notes: new Map(),         // notes file (lower-case path) -> { path, notes: {key: text}, foreign, dirty }
  s: { ...DEFAULTS },
  loading: false,
};

function saveSettings(patch) {
  Object.assign(state.s, patch);
  persist();
}
const persist = debounce(() => {
  const { overrides, dryOverrides, expanded, lastSel, ...rest } = state.s;
  api.setSettings({ ...rest, overrides, dryOverrides, expanded, lastSel });
}, 300);

// ====================================================================== loading
let loadSeq = 0;
async function openFolder(root, { quiet = false } = {}) {
  if (!root) return;
  const seq = ++loadSeq;
  const stale = () => seq !== loadSeq;      // a newer openFolder() started meanwhile
  if (!(await api.exists(root))) { toast(`Folder not found: ${root}`); return; }
  state.loading = true;
  setStatus(h("span", {}, h("span", { class: "spinner" }), "  Scanning ", h("b", {}, L.basename(root)), "…"));
  const keepSel = state.root === root ? state.selected.slice() : null;
  try {
    const tree = await api.scan(root);
    if (stale()) return;
    const treeFiles = [];
    (function walk(n) { for (const c of n.children || []) c.dir ? walk(c) : treeFiles.push(c.path); })(tree);
    const extra = await api.dryRunFiles(root);
    if (stale()) return;
    const inTree = new Set(treeFiles.map((p) => p.toLowerCase()));
    const external = extra.filter((p) => !inTree.has(p.toLowerCase()));

    const curveFiles = treeFiles.filter(L.isCurveFile);
    const extCurves = external.filter(L.isCurveFile);
    const recordFiles = [...treeFiles, ...external].filter(L.isRecordFile);
    const byDir = new Map();
    for (const p of recordFiles) {
      const k = L.dirname(p).toLowerCase();
      if (!byDir.has(k)) byDir.set(k, []);
      byDir.get(k).push(p);
    }
    const runs = [...L.groupRuns(curveFiles).map((r) => ({ ...r, external: false })),
                  ...L.groupRuns(extCurves).map((r) => ({ ...r, external: true }))];
    for (const r of runs) r.recordPath = L.findRecordPath(r.main, byDir.get(r.dir.toLowerCase()) || []);

    const wanted = [];
    for (const r of runs) { wanted.push(r.main); if (r.im) wanted.push(r.im); if (r.recordPath) wanted.push(r.recordPath); }
    const texts = new Map();
    for (let i = 0; i < wanted.length; i += 150) {
      const chunk = wanted.slice(i, i + 150);
      const got = await api.readTexts(chunk);
      if (stale()) return;
      chunk.forEach((p, j) => texts.set(p, got[j]));
    }

    state.runs = new Map();
    for (const r of runs) {
      const t = texts.get(r.main);
      if (t == null) continue;
      r.curve = L.parseCurve(t);
      if (!r.curve.rows.length) continue;
      r.curveIm = r.im && texts.get(r.im) ? L.parseCurve(texts.get(r.im)) : null;
      if (r.curveIm && r.curveIm.rows.length !== r.curve.rows.length) r.curveIm = null;
      r.record = r.recordPath && texts.get(r.recordPath) ? L.parseRecord(texts.get(r.recordPath)) : null;
      r.time = r.record ? r.record.start : null;
      r.out = /_corr$/i.test(L.basename(r.dir));
      r.label = L.runLabel(r.stem, L.basename(r.dir));
      const ov = state.s.dryOverrides[r.main];
      r.autoDry = !r.out && L.looksLikeDryRun(r, r.record);
      r.dry = ov != null ? ov : r.autoDry;
      if (r.external && !r.dry) continue;          // outside the folder: only empty holders matter
      state.runs.set(r.id, r);
    }
    // newest measuring day first; high-T before low-T within a day
    state.dry = [...state.runs.values()].filter((r) => r.dry && !r.out)
      .sort((a, b) => (dayOf(b.time) || 0) - (dayOf(a.time) || 0) || a.kind.localeCompare(b.kind) || (b.time || 0) - (a.time || 0));
    const notes = await loadNotes();
    if (stale()) return;
    state.notes = notes;

    const firstOpen = state.root !== root;
    state.root = root;
    state.tree = tree;
    const exp = state.s.expanded[root];
    if (firstOpen) state.expanded = exp ? new Set(exp) : defaultExpanded(tree);
    saveSettings({ lastRoot: root });
    api.watch(root);

    renderCrumb();
    renderTree();
    renderDryPanel();
    $("#btnExportAll").disabled = !samples().length;

    let sel = (keepSel || []).filter((id) => state.runs.has(id));
    if (!sel.length) {
      const last = state.s.lastSel[root];
      if (last && state.runs.has(last)) sel = [last];
    }
    if (!sel.length) { const first = state.visible.find((id) => !state.runs.get(id).dry); if (first) sel = [first]; }
    select(sel, { scroll: true });
    setStatus(quiet ? "Folder changed — rescanned" : `Opened ${L.basename(root)}`);
  } catch (err) {
    console.error(err);
    setStatus("Could not read folder");
    toast(`Could not read folder: ${err.message || err}`);
  } finally {
    if (!stale()) { state.loading = false; renderStatusRight(); }
  }
}

function defaultExpanded(tree) {
  const s = new Set();
  (function walk(n, depth) {
    for (const c of n.children || []) if (c.dir) {
      if (depth < 3 && !/_corr$/i.test(c.name) && !/holder|empty|dry/i.test(c.name)) s.add(c.path);
      walk(c, depth + 1);
    }
  })(tree, 0);
  return s;
}

const samples = () => [...state.runs.values()].filter((r) => !r.dry && !r.out && !r.external);

// ====================================================================== pairing / correction
function candidatesFor(run) {
  return state.dry.filter((d) => d.kind === run.kind && d.id !== run.id);
}
function dryFor(run) {
  const cands = candidatesFor(run);
  if (!cands.length) return null;
  const ov = state.s.overrides[run.main];
  if (ov) { const d = cands.find((c) => c.main === ov); if (d) return { dry: d, auto: false }; }
  const pick = L.pairDryRun(run.time, cands.map((c) => ({ run: c, time: c.time })), state.s.rule);
  return pick ? { dry: pick.run, auto: true } : null;
}
function correctionFor(run) {
  if (run.dry) return null;
  const pair = dryFor(run);
  if (!pair) return null;
  const spec = smoothFor(pair.dry);
  const { cin, cout } = L.correctRun(run.curve, run.curveIm, pair.dry.curve, pair.dry.curveIm, spec);
  return { pair, cin, cout, spec };
}

// ====================================================================== empty-holder smoothing
// Each empty holder is smoothed before it is subtracted: running mean over N points, the
// smoothing stored in the file, or none. The choice is kept per holder file.
const hasStored = (d) => L.hasStoredSmoothing(d.curve.rows);
function storedN(d) {
  if (d._storedN === undefined) d._storedN = L.storedSmoothingN(d.curve.rows);
  return d._storedN;
}
function smoothFor(d) {
  const saved = state.s.holderSmooth[d.main];
  if (saved && (saved.mode !== "stored" || hasStored(d))) return saved;
  if (!saved && hasStored(d)) return { mode: "stored", n: storedN(d) > 1 ? storedN(d) : state.s.smoothN || 5 };
  return { mode: "smooth", n: (saved && saved.n) || state.s.smoothN || 5 };
}
function describeSmoothing(d, spec = smoothFor(d)) {
  if (spec.mode === "none") return "not smoothed";
  if (spec.mode === "stored") return storedN(d) > 1 ? `smoothing from file (running mean, ${storedN(d)} pts)` : "smoothing from file";
  return `running mean, ${spec.n} pts`;
}
function setHolderSmooth(d, spec) {
  state.s.holderSmooth[d.main] = spec;
  persist();
  renderViewer(); renderDryPanel(); renderStatusRight();
}

// ====================================================================== specimen notes
// One note per run file (27H1, 27L1 and 27L2 each have their own), ;-separated items,
// kept in a small <specimen>_notes.json beside the raw folder (see CurLib.notesPath), so it
// travels with the data. A file of that name that is not a TX Studio notes file is never
// overwritten.
const pieceOf = (r) => (r.label.run ? `${r.label.spec}|${r.label.piece}`.toLowerCase() : null);
const noteKey = (r) => r.stem;
const notesFileFor = (r) => state.notes.get(L.notesPath(r.dir).toLowerCase());
function noteOf(r) { const f = notesFileFor(r); return (f && f.notes[noteKey(r)]) || ""; }
const noteItems = (text) => text.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);

async function loadNotes() {
  const byPath = new Map();
  for (const r of state.runs.values()) {
    const p = L.notesPath(r.dir), k = p.toLowerCase();
    if (!byPath.has(k)) byPath.set(k, { path: p, runs: [] });
    byPath.get(k).runs.push(r);
  }
  const files = [...byPath.values()];
  const texts = files.length ? await api.readTexts(files.map((f) => f.path)) : [];
  const m = new Map();
  files.forEach(({ path: p, runs }, i) => {
    const old = state.notes.get(p.toLowerCase());
    if (old && old.dirty) { m.set(p.toLowerCase(), old); return; }       // edit not written yet
    const notes = texts[i] == null ? {} : L.parseNotes(texts[i]);
    // notes of v0.6 were per piece ("AB24CD101-27"): each run of that piece starts with a copy
    if (notes) for (const k of Object.keys(notes)) {
      if (runs.some((r) => r.stem === k)) continue;
      const piece = runs.filter((r) => r.label.spec && r.label.run && `${r.label.spec}-${r.label.piece}` === k);
      if (!piece.length) continue;
      for (const r of piece) if (!notes[r.stem]) notes[r.stem] = notes[k];
      delete notes[k];
    }
    m.set(p.toLowerCase(), { path: p, notes: notes || {}, foreign: texts[i] != null && !notes });
  });
  return m;
}

const noteTimers = new Map();
const renderTreeSoon = debounce(() => renderTree(), 150);
function setNote(r, text) {
  const f = notesFileFor(r);
  if (!f) return;
  if (f.foreign) { toast(`${L.basename(f.path)} exists but is not a TX Studio notes file – left unchanged`); return; }
  const key = noteKey(r), v = text.trim();
  if ((f.notes[key] || "") === v) return;
  if (v) f.notes[key] = v; else delete f.notes[key];
  f.dirty = true;
  renderTreeSoon();
  clearTimeout(noteTimers.get(f.path));
  noteTimers.set(f.path, setTimeout(() => writeNotes(f), 800));
}
async function writeNotes(f) {
  clearTimeout(noteTimers.get(f.path));
  noteTimers.delete(f.path);
  if (!f.dirty) return;
  f.dirty = false;
  try {
    await api.writeText(f.path, L.notesText(f.notes));
    setStatus(`Notes saved · ${L.basename(f.path)}`);
  } catch (err) {
    f.dirty = true;
    toast(`Could not save the notes: ${err.message || err}`);
  }
}
const flushNotes = () => { for (const f of state.notes.values()) if (f.dirty) writeNotes(f); };

const NOTE_TAGS = ["paramagnetic", "magnetite", "hematite", "pyrrhotite", "goethite", "pyrite", "siderite",
  "Verwey", "Morin", "Besnus", "Hopkinson", "alteration", "check"];

function notesCard(r) {
  const f = notesFileFor(r);
  const card = h("div", { class: "card" }, h("h3", {}, h("span", { class: "grow" }, "Notes"),
    h("span", { class: "delta" }, r.label.run ? `${r.label.piece} ${r.label.run}` : r.stem)));
  const ta = h("textarea", { rows: 2, class: "note-input", spellcheck: "false",
    placeholder: "Classify this run, items separated by ;  e.g. paramagnetic; magnetite forms ≈ 400 °C" });
  ta.value = noteOf(r);
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight + 2) + "px"; };
  ta.addEventListener("input", () => { setNote(r, ta.value); fit(); markTags(); });
  ta.addEventListener("blur", flushNotes);
  ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); ta.blur(); } });
  requestAnimationFrame(fit);
  // one-click tags: add / remove a word from the note
  const has = (t) => new RegExp(`(^|[;,\\s])${t}($|[;,\\s])`, "i").test(ta.value);
  const tags = h("div", { class: "note-tags" });
  const markTags = () => { for (const b of tags.children) b.classList.toggle("on", has(b.textContent)); };
  for (const t of NOTE_TAGS) {
    tags.append(h("button", { class: "note-tag", title: `Add / remove “${t}”`, onclick: () => {
      const parts = noteItems(ta.value);
      const i = parts.findIndex((x) => x.toLowerCase() === t.toLowerCase());
      if (i >= 0) parts.splice(i, 1);
      else if (has(t)) { toast(`“${t}” is already part of the note`); return; } else parts.push(t);
      ta.value = parts.join("; ");
      setNote(r, ta.value); fit(); markTags();
    } }, t));
  }
  markTags();
  card.append(ta, tags);
  if (f && f.foreign) card.append(note("warn", `<code>${esc(L.basename(f.path))}</code> already exists and is not a TX Studio notes file, so notes are not saved there.`));
  else if (f) card.append(h("div", { class: "delta", style: "margin-top:6px" }, h("span", {}, "Shown after the name in the sidebar (Alt + hover: one item per line) · saved to "),
    h("a", { class: "link", title: f.path, onclick: () => api.reveal(f.path) }, L.basename(f.path))));
  return card;
}

// ====================================================================== paramagnetic fit
// chi = chi0 + C / (T - theta) fitted where the heating / warming curve is paramagnetic on
// top of a constant (CurLib.paraCandidates). Only L1 and the heating of H1: once a piece
// has been heated, new minerals (magnetite) have formed.
/** -> null when the fit applies to this run, else why not. */
function paraBlocked(r) {
  const m = /^([HL])(\d+)$/i.exec(r.label.run || "");
  if (m) {
    if (+m[2] < 2) return null;
    return m[1].toUpperCase() === "L"
      ? `${m[0].toUpperCase()} is measured after the heating – magnetite has formed by then, so no paramagnetic fit.`
      : `${m[0].toUpperCase()} is a repeated heating – the sample changed in the first one, so no paramagnetic fit.`;
  }
  // other names: a low-T run measured after a high-T run of the same piece
  if (r.kind === "LT" && r.time != null && pieceOf(r) &&
      [...state.runs.values()].some((x) => x.kind === "HT" && !x.dry && x.time != null && x.time < r.time && pieceOf(x) === pieceOf(r))) {
    return "Measured after this piece was heated – magnetite has formed by then, so no paramagnetic fit.";
  }
  return null;
}

/** -> { blocked } | { cands, active, isDefault } for a sample run (null without a correction). */
function paraInfo(r, res = correctionFor(r)) {
  if (!res) return null;
  const blocked = paraBlocked(r);
  if (blocked) return { blocked };
  const cands = L.paraCandidates(res.cin, { theta: state.s.paraTheta || 0 });
  const def = L.defaultParaCandidate(cands);
  // the stretch picked earlier: the candidate that overlaps it best
  const pick = state.s.paraPick[r.main];
  let active = null, best = 0;
  if (pick) for (const c of cands) {
    const iou = (Math.min(c.hi, pick[1]) - Math.max(c.lo, pick[0])) / (Math.max(c.hi, pick[1]) - Math.min(c.lo, pick[0]));
    if (iou > best) { best = iou; active = c; }
  }
  active = active || def;
  return { cands, active, def };
}

// ---------------------------------------------------------------------- mineral model
// The susceptibility a mineral mode (granite by default) would have, as a curve over
// temperature (CurLib.mixChi); its absolute level is unknown for a furnace / cryostat sample,
// so the curve's Y position is set by a slider or fitted to the measured χ.
function mineralMix() {
  const pct = state.s.modelMix || L.GRANITE, props = state.s.modelProps || {};
  return L.MINERALS.map((m) => ({ ...m, ...(props[m.id] || {}), pct: pct[m.id] || 0 }));
}
const mixIsGranite = () => !state.s.modelMix && !Object.keys(state.s.modelProps || {}).length;

/** χ at 25 °C of the model fitted (one scale factor, least squares) to the measured
 *  heating curve over the stretch c. */
function modelFitY25(corr, c) {
  const mix = mineralMix(), m25 = L.mixChi(mix, 25);
  let num = 0, den = 0;
  for (let i = 0; i < corr.temp.length; i++) {
    if (corr.segment[i] !== "heating" || corr.temp[i] < c.lo || corr.temp[i] > c.hi) continue;
    const m = L.mixChi(mix, corr.temp[i]);
    num += m * corr.csusc[i]; den += m * m;
  }
  return den > 0 && m25 ? (num / den) * m25 : null;
}

/** -> { y25, at(t), m25, para25, scale, fitted } for a run with paramagnetic stretch c. */
function modelInfo(run, res, c) {
  const mix = mineralMix(), m25 = L.mixChi(mix, 25);
  if (!m25) return null;
  const set = state.s.modelY[run.main];
  const y25 = set != null ? set : modelFitY25(res.cin, c);
  if (y25 == null) return null;
  const scale = y25 / m25;
  const para25 = L.mixChi(mix.filter((m) => m.theta != null && m.k > 0), 25);
  return { y25, at: (t) => scale * L.mixChi(mix, t), m25, para25, scale, fitted: set == null, name: mixIsGranite() ? "granite" : "your mode" };
}

const fmtT = (t) => `${Math.round(t)}`.replace("-", "−");
const rangeText = (c) => `${fmtT(c.lo)} … ${fmtT(c.hi)} °C`;
const pctText = (c) => (c.share.fraction == null ? "χ ≤ 0" : `${Math.round(100 * c.share.fraction)} %`);

function pickPara(r, c, pi) {
  if (c === pi.def) delete state.s.paraPick[r.main]; else state.s.paraPick[r.main] = [c.lo, c.hi];
  persist();
  renderViewer();
  jumpToStretch(c.lo, c.hi, rangeText(c));
}

/** Zoom so the stretch lo..hi fills the plot (χ scaled to the heating curves and the fits,
 *  not to a cooling curve far above them), then flash its band. */
function jumpToStretch(lo, hi, label) {
  const pad = Math.max(5, (hi - lo) * 0.08);
  zoomToRange(lo - pad, hi + pad, () => showBand(lo, hi, label, true), (tr) => tr.isPara || /^(heating|warming)/.test(tr.name || ""));
}

/** Hover rows: a stretch row shades its range on the plot; click picks it and zooms there. */
function stretchRow(cls, kids, lo, hi, label, onclick) {
  const row = h("button", { class: cls }, ...kids);
  row.addEventListener("mouseenter", () => showBand(lo, hi, label));
  row.addEventListener("mouseleave", () => hideBand());
  row.addEventListener("focus", () => showBand(lo, hi, label));
  row.addEventListener("blur", () => hideBand());
  row.addEventListener("click", onclick);
  return row;
}

function thetaField() {
  const inp = h("input", { type: "number", step: 1, value: state.s.paraTheta || 0 });
  inp.addEventListener("change", () => { saveSettings({ paraTheta: Number(inp.value) || 0 }); renderViewer(); });
  return h("div", { class: "field", style: "margin-top:12px" }, h("label", {}, "Weiss temperature θ"),
    h("div", { class: "num" }, inp, h("span", { class: "delta", style: "margin-left:6px" }, "K · 0 = Curie law, fine for most paramagnetic minerals")));
}

function paraCard(r) {
  const card = h("div", { class: "card" }, h("h3", {}, "Paramagnetic fit"));
  card.append(h("p", { class: "card-intro" },
    "χ = χ₀ + C / (T − θ) fitted where the curve is paramagnetic on top of a constant χ₀ (Hrouda's hyperbola method) – L1 and the heating of H1 only."));
  const res = correctionFor(r);
  const pi = res && paraInfo(r, res);
  if (!res) { card.append(note("info", "Needs an empty-holder correction first.")); return card; }
  if (pi.blocked) { card.append(note("info", pi.blocked)); return card; }
  if (!pi.cands.length) {
    card.append(note("info", `No stretch of the ${r.kind === "LT" ? "warming" : "heating"} curve of 60 °C or more follows a hyperbola – ferromagnetic behaviour dominates.`));
    card.append(thetaField());
    return card;
  }
  const c = pi.active, sh = c.share, f = c.fit;
  const big = h("div", { class: "para-big" });
  if (sh.fraction == null) big.append(h("b", {}, "χ ≤ 0"), h("span", {}, ` at ${fmtT(sh.t)} °C – diamagnetic overall`));
  else big.append(h("b", {}, `${Math.round(100 * sh.fraction)} %`), h("span", {}, " paramagnetic"),
    h("span", { class: "delta" }, ` ± ${Math.max(1, Math.round(100 * sh.se))} % · at ${fmtT(sh.t)} °C`));
  card.append(big);
  card.append(h("dl", { class: "kv" },
    h("dt", {}, "Paramagnetic χ"), h("dd", {}, `${sh.para.toFixed(2)}  (C = ${f.C.toFixed(0)} K)`),
    h("dt", {}, "Constant χ₀"), h("dd", {}, f.chi0.toFixed(2)),
    h("dt", {}, "Measured χ"), h("dd", {}, sh.measured.toFixed(2)),
    h("dt", {}, "Fitted"), h("dd", {}, `${rangeText(c)} · ${c.n} pts`),
    h("dt", {}, "Fit R²"), h("dd", {}, f.r2.toFixed(3))));
  if (sh.fraction != null && sh.fraction > 1.02) {
    card.append(note("info", "Above 100 %: χ₀ is negative – a diamagnetic matrix (quartz, calcite) takes away part of the paramagnetic signal."));
  }
  const d = c.departure;
  if (d) {
    const at = `<b>${fmtT(d.t)} °C</b>`;
    card.append(note("info", r.kind === "HT"
      ? (d.dir > 0 ? `The heating curve leaves the hyperbola at ${at}, χ rising above it – a magnetic mineral forming (e.g. magnetite from pyrite, siderite or clays).`
                   : `The heating curve leaves the hyperbola at ${at}, χ falling below it – a Curie point, or a mineral breaking down.`)
      : `The warming curve departs from the hyperbola at ${at} (χ ${d.dir > 0 ? "above" : "below"} it) – a ferromagnetic contribution changing there.`));
  }
  // the candidates: hover shades the stretch, click uses it and zooms there
  const list = h("div", { class: "cand-list" }, h("div", { class: "cand-head" },
    pi.cands.length === 1 ? "Stretch that follows a hyperbola" : `${pi.cands.length} stretches follow a hyperbola – click one to use it`));
  for (const k of pi.cands) {
    list.append(stretchRow(`cand${k === c ? " on" : ""}`, [
      h("span", { class: "cand-range" }, rangeText(k)),
      h("span", { class: "cand-what" }, k.whole ? "whole branch" : k.atStart ? "from the start" : ""),
      h("span", { class: "cand-pct" }, pctText(k))], k.lo, k.hi, rangeText(k), () => pickPara(r, k, pi)));
  }
  card.append(list, modelSection(r, res, c), thetaField());
  return card;
}

let modelOpen = false;           // the mode table starts folded; stays as set while the app runs

/** Mineral model block of the paramagnetic card: on / off, the Y slider (the model's χ at
 *  25 °C), auto-fit over the active stretch, and the mode with each mineral's χ and θ. */
function modelSection(r, res, c) {
  const box = h("div", { class: "model-box" });
  const on = h("input", { type: "checkbox", checked: !!state.s.model });
  on.addEventListener("change", () => { saveSettings({ model: on.checked }); renderViewer(); });
  box.append(h("label", { class: "model-head" }, on, h("span", {}, "Mineral model"),
    h("span", { class: "delta" }, mixIsGranite() ? "· granite mode" : "· your mode")));
  if (!state.s.model) return box;
  const mi = modelInfo(r, res, c);
  if (!mi) box.append(note("info", "This mode has no paramagnetic minerals – set some in the table below."));
  else {
    const top = Math.max(1, ...res.cin.csusc.filter(Number.isFinite).map(Math.abs)) * 2;
    const sl = h("input", { type: "range", class: "model-slider", min: 0, max: top, step: top / 1000, value: mi.y25,
      title: "Moves the model curve up or down: its χ at 25 °C" });
    const val = h("span", { class: "model-val" }), info = h("div", { class: "delta", style: "margin-top:4px" });
    const show = (y25, fitted) => {
      const scale = y25 / mi.m25, para = scale * mi.para25, m = c.share.measured;
      val.textContent = `${y25.toFixed(2)}${fitted ? " · fitted" : ""}`;
      info.textContent = `Its paramagnetic minerals give χ ${para.toFixed(2)} at 25 °C` +
        (m > 0 ? ` = ${Math.round((100 * para) / m)} % of the measured ${m.toFixed(2)} (${fmtT(c.share.t)} °C)` : "") +
        ` · rock of this mode ${mi.m25.toFixed(0)} ×10⁻⁶ SI, scaled ×${scale.toPrecision(2)}`;
    };
    let raf = 0;
    sl.addEventListener("input", () => {
      state.s.modelY[r.main] = +sl.value;
      show(+sl.value, false);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => drawPlot(state.selected.map((id) => state.runs.get(id)).filter(Boolean)));
      persist();
    });
    const fit = h("button", { class: "btn", title: "Fit the model's Y position to the measured χ over the active stretch (least squares)",
      onclick: () => { delete state.s.modelY[r.main]; persist(); renderViewer(); } }, "Auto-fit");
    show(mi.y25, mi.fitted);
    box.append(h("div", { class: "field", style: "margin:8px 0 0" }, h("label", {}, "Y position – χ at 25 °C ", val),
      h("div", { class: "model-row" }, sl, fit)), info);
  }
  // the mode: vol % per mineral, its room-temperature χ and Weiss temperature
  const det = h("details", { class: "model-mode" });
  det.open = modelOpen;
  det.addEventListener("toggle", () => { modelOpen = det.open; });
  const mix = mineralMix(), sum = mix.reduce((a, m) => a + (m.pct || 0), 0);
  det.append(h("summary", {}, `Mode (vol %) · sum ${Math.round(sum)} %${Math.abs(sum - 100) > 0.5 ? " – not 100" : ""}`));
  const tbl = h("div", { class: "model-table" }, h("span", { class: "delta" }, "Mineral"), h("span", { class: "delta" }, "vol %"),
    h("span", { class: "delta" }, "χ ×10⁻⁶ SI"), h("span", { class: "delta" }, "θ (K)"));
  const setMix = (id, key, v) => {
    if (key === "pct") state.s.modelMix = { ...(state.s.modelMix || L.GRANITE), [id]: v };
    else state.s.modelProps = { ...(state.s.modelProps || {}), [id]: { ...((state.s.modelProps || {})[id] || {}), [key]: v } };
    persist(); renderViewer();
  };
  const num = (v, id, key, step) => {
    const inp = h("input", { type: "number", step, value: v });
    inp.addEventListener("change", () => setMix(id, key, Number(inp.value) || 0));
    return inp;
  };
  for (const m of mix) {
    tbl.append(h("span", {}, m.name), num(m.pct, m.id, "pct", 0.5), num(m.k, m.id, "k", 1),
      m.theta == null ? h("span", { class: "delta" }, "–") : num(m.theta, m.id, "theta", 1));
  }
  det.append(tbl, h("div", { class: "delta", style: "margin-top:6px" },
    "Typical mean χ of each mineral (not the deviatoric K′ of AMS); θ = 0 K follows the Curie law. ",
    h("a", { class: "link", onclick: () => { state.s.modelMix = null; state.s.modelProps = {}; persist(); renderViewer(); } }, "Reset to granite")));
  box.append(det);
  return box;
}

/** Overlays: each run's fitted stretch and share; hover / click as on a single run. */
function paraOverlayCard(runs) {
  const tags = overlayLabels(runs);
  const card = h("div", { class: "card" }, h("h3", {}, "Paramagnetic fit"));
  const list = h("div", { class: "cand-list" });
  for (const r of runs.filter((x) => !x.dry)) {
    const pi = paraInfo(r);
    const color = r.kind === "LT" ? "var(--warm)" : "var(--heat)";
    const tag = h("span", { class: "run-tag", style: `color:${color};border-color:${color}` }, tags.get(r.id));
    const c = pi && pi.active;
    if (!c) {
      list.append(h("div", { class: "cand off", title: pi && pi.blocked ? pi.blocked : "" }, tag,
        h("span", { class: "cand-what" }, !pi ? "no empty holder" : pi.blocked ? "after heating" : "no hyperbola stretch")));
      continue;
    }
    list.append(stretchRow("cand", [tag, h("span", { class: "cand-range" }, rangeText(c)), h("span", { class: "cand-pct" }, pctText(c))],
      c.lo, c.hi, `${tags.get(r.id)} · ${rangeText(c)}`, () => jumpToStretch(c.lo, c.hi, `${tags.get(r.id)} · ${rangeText(c)}`)));
  }
  card.append(list, thetaField());
  return card;
}

// ====================================================================== sidebar
function renderCrumb() {
  const c = $("#crumb");
  c.innerHTML = "";
  if (!state.root) return;
  const parts = state.root.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-3);
  c.append(h("span", {}, (parts.length > 3 ? "… › " : "") + tail.slice(0, -1).join(" › ") + (tail.length > 1 ? " › " : "")), h("b", {}, tail[tail.length - 1]));
  c.title = `${state.root}\nClick to show in Explorer`;
}

function viewNode(node, q) {
  // -> { node, dirs:[view], runs:[run], others:[file], count } or null when hidden
  const s = state.s;
  const dirs = [], files = [], others = [];
  let count = 0;
  for (const c of node.children || []) {
    if (c.dir) {
      if (!s.showCorr && /_corr$/i.test(c.name)) continue;
      const v = viewNode(c, q);
      if (v) { dirs.push(v); count += v.count; }
    } else if (L.isCurveFile(c.path)) {
      const run = state.runs.get(runIdFor(c.path));
      if (!run) continue;
      if (L.isIm(c.path) && run.main !== c.path && !s.showIm) continue;
      if (q && !run.stem.toLowerCase().includes(q) && !noteOf(run).toLowerCase().includes(q)) continue;
      files.push({ path: c.path, run, im: L.isIm(c.path) && run.main !== c.path });
      if (!(L.isIm(c.path) && run.main !== c.path)) count++;
    } else if (!s.onlyCurves && !q) {
      others.push(c);
    }
  }
  if ((s.onlyCurves || q) && !count && node !== state.tree) return null;
  // the runs of one piece in experiment order (L1, H1, L2 ...), the pieces in their
  // (alphabetical) order; runs whose names don't parse grouped by the day they were measured
  const firstAt = new Map();
  files.forEach((f, i) => { const g = groupOf(f.run); if (!firstAt.has(g)) firstAt.set(g, i); });
  files.sort((a, b) => firstAt.get(groupOf(a.run)) - firstAt.get(groupOf(b.run))
    || L.runRank(a.run.label.run) - L.runRank(b.run.label.run)
    || (a.run.time || 0) - (b.run.time || 0) || a.im - b.im);
  return { node, dirs, files, others, count };
}

const dayOf = (t) => (t == null ? null : new Date(t).setHours(0, 0, 0, 0));
/** Sidebar group of a run: its specimen piece, else the day it was measured. */
const groupOf = (r) => pieceOf(r) || (r.time != null ? `day:${dayOf(r.time)}` : `id:${r.id.toLowerCase()}`);

const runIdFor = (p) => L.runId(p);

function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  state.visible = [];
  if (!state.tree) return;
  const q = $("#search").value.trim().toLowerCase();
  const v = viewNode(state.tree, q);
  const frag = document.createDocumentFragment();
  if (v) emit(v, 0, frag, q);
  if (!frag.childNodes.length) {
    frag.append(h("div", { class: "none" }, q ? `No runs match “${q}”` : "No .cur / .clw files in this folder"));
  }
  tree.append(frag);
  markSelection();
}

function emit(v, depth, out, q) {
  for (const d of v.dirs) {
    // compact single-child chains: AB24CD101_TX / AB24CD101_TX_raw
    let cur = d; const names = [d.node.name];
    while (!cur.files.length && !cur.others.length && cur.dirs.length === 1) { cur = cur.dirs[0]; names.push(cur.node.name); }
    const open = q ? true : state.expanded.has(cur.node.path);
    const row = h("div", { class: `row dirrow${open ? " open" : ""}`, role: "treeitem", style: `padding-left:${6 + depth * 14}px`,
      title: cur.node.path, onclick: () => toggleDir(cur.node.path),
      oncontextmenu: (e) => dirMenu(e, cur.node.path) });
    row.innerHTML = ICON.chev + ICON.folder;
    // the folder that directly holds runs is bold; folders that only hold folders are not
    const name = h("span", { class: "name" });
    if (names.length > 1) name.append(h("span", { class: "dir-parent" }, names.slice(0, -1).join(" / ")), h("span", { class: "dir-sep" }, " / "));
    name.append(h("span", { class: cur.files.length ? "dir-leaf has-runs" : "dir-leaf" }, names[names.length - 1]));
    row.append(name, h("span", { class: "meta" }, cur.count || ""));
    out.append(row);
    if (open) emit(cur, depth + 1, out, q);
  }
  // Runs of one specimen piece (27L1, 27H1, 27L2 ...) share a faint band; bands alternate
  // per group like Finder's row stripes (see viewNode for the order).
  const keys = v.files.map((f) => groupOf(f.run));
  let band = -1;
  for (let fi = 0; fi < v.files.length; fi++) {
    const f = v.files[fi];
    const r = f.run;
    if (fi === 0 || keys[fi] !== keys[fi - 1]) band++;
    const banded = band % 2 === 1;
    const first = fi === 0 || keys[fi] !== keys[fi - 1], last = fi === keys.length - 1 || keys[fi] !== keys[fi + 1];
    const cls = `row filerow${r.out ? " out" : ""}${banded ? " band" : ""}${banded && first ? " band-first" : ""}${banded && last ? " band-last" : ""}`;
    const row = h("div", { class: cls, role: "treeitem", dataset: { id: r.id },
      style: `padding-left:${20 + depth * 14}px`, title: runTooltip(r) });
    row.append(h("span", { class: `pill ${r.kind === "HT" ? "ht" : "lt"}` }, r.kind));
    const nt = noteOf(r);
    row.append(withMatch(h("span", { class: nt ? "name has-note" : "name" }), L.basename(f.path).replace(/\.(cur|clw)$/i, ""), q));
    // the run's note, faded, right after the name (Alt + hover: one item per line)
    if (nt) row.append(withMatch(h("span", { class: "note-text" }), noteItems(nt).join(" · "), q));
    row.addEventListener("mouseenter", (e) => { peek = { row, r }; if (e.altKey) showPeek(); });
    row.addEventListener("mousemove", (e) => { if (e.altKey) { if (!$(".note-peek")) showPeek(); } else hidePeek(); });
    row.addEventListener("mouseleave", () => { peek = null; hidePeek(); });
    if (r.dry) row.append(h("span", { class: "pill dry", title: `Empty-holder run – smoothed (${describeSmoothing(r)}) and subtracted from the other runs` }, "EMPTY"));
    if (r.out) row.append(h("span", { class: "pill out", title: "Exported output" }, "OUT"));
    if (r.curveIm && !f.im && !state.s.showIm) row.append(h("span", { class: "pill im", title: "Out-of-phase (imaginary, χ″) data merged in from the _Im file – shown by the Out-of-phase / Both views" }, "Im"));
    if (f.im) row.append(h("span", { class: "pill im" }, "_Im"));
    row.append(h("span", { class: "meta" }, fmtShort(r.time)));
    row.addEventListener("click", (e) => clickRun(r.id, e));
    row.addEventListener("contextmenu", (e) => runMenu(e, r));
    out.append(row);
    if (!f.im) state.visible.push(r.id);
  }
  for (const o of v.others) {
    const row = h("div", { class: "row muted", style: `padding-left:${20 + depth * 14}px`, title: o.path });
    row.innerHTML = ICON.file;
    row.append(h("span", { class: "name" }, o.name));
    out.append(row);
  }
}

// Alt + hover over a run: its notes, one item per line, in a panel right of the sidebar
let peek = null;              // { row, r } under the mouse
function showPeek() {
  hidePeek();
  if (!peek || !peek.row.isConnected) return;
  const items = noteItems(noteOf(peek.r));
  const el = h("div", { class: "note-peek" }, h("div", { class: "note-peek-head" }, peek.r.stem),
    ...(items.length ? items.map((t) => h("div", { class: "note-peek-item" }, t)) : [h("div", { class: "delta" }, "No notes – add them in the inspector")]));
  document.body.append(el);
  const rr = peek.row.getBoundingClientRect(), side = $("#sidebar").getBoundingClientRect();
  el.style.left = side.right + 8 + "px";
  el.style.top = Math.max(8, Math.min(rr.top - 4, innerHeight - el.offsetHeight - 8)) + "px";
}
function hidePeek() { $$(".note-peek").forEach((e) => e.remove()); }

/** el holding text, with the first occurrence of q marked */
function withMatch(el, text, q) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) el.textContent = text;
  else el.innerHTML = esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  return el;
}

function runTooltip(r) {
  const lines = [L.basename(r.main)];
  if (r.time) lines.push(`Measured ${fmtDateTime(r.time)}`);
  if (r.record && r.record.note) lines.push(`Instrument note: ${r.record.note}`);
  if (r.dry) lines.push(`Empty holder – ${describeSmoothing(r)}, used to correct the other runs`);
  if (r.curveIm) lines.push("Out-of-phase (_Im) data merged in");
  return lines.join("\n");
}

function toggleDir(p) {
  if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p);
  state.s.expanded[state.root] = [...state.expanded];
  persist();
  renderTree();
}

function markSelection() {
  const sel = new Set(state.selected);
  for (const row of $$(".row[data-id]")) {
    row.classList.toggle("sel", sel.has(row.dataset.id));
    row.classList.toggle("focus", row.dataset.id === state.anchor);
  }
}

function clickRun(id, e) {
  if (e.ctrlKey || e.metaKey) {
    const s = new Set(state.selected);
    if (s.has(id) && s.size > 1) s.delete(id); else s.add(id);
    state.anchor = id;
    select([...s], { keepAnchor: true });
  } else if (e.shiftKey && state.anchor) {
    const a = state.visible.indexOf(state.anchor), b = state.visible.indexOf(id);
    if (a >= 0 && b >= 0) select(state.visible.slice(Math.min(a, b), Math.max(a, b) + 1), { keepAnchor: true });
    else select([id]);
  } else select([id]);
}

function select(ids, { scroll = false, keepAnchor = false } = {}) {
  state.selected = ids.filter((id) => state.runs.has(id));
  if (!keepAnchor) state.anchor = state.selected[state.selected.length - 1] || null;
  if (state.root && state.selected.length === 1) { state.s.lastSel[state.root] = state.selected[0]; persist(); }
  markSelection();
  if (scroll) {
    const row = $(`.row[data-id="${CSS.escape(state.anchor || "")}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  renderViewer();
}

function renderDryPanel() {
  const list = $("#dryList");
  list.innerHTML = "";
  $("#dryCount").textContent = state.dry.length;
  $("#dryPanel").classList.toggle("open", state.s.dryOpen);
  if (!state.dry.length) {
    list.append(h("div", { class: "row muted", style: "padding-left:10px" }, "None found – right-click a run to mark it"));
  }
  // empty holders measured on the same day share a band (Finder-style stripes)
  const days = state.dry.map((d) => dayOf(d.time));
  let band = -1;
  state.dry.forEach((d, i) => {
    if (i === 0 || days[i] !== days[i - 1]) band++;
    const banded = band % 2 === 1, first = i === 0 || days[i] !== days[i - 1], last = i === days.length - 1 || days[i] !== days[i + 1];
    const used = samples().filter((r) => { const p = dryFor(r); return p && p.dry.id === d.id; }).length;
    const cls = `row filerow${banded ? " band" : ""}${banded && first ? " band-first" : ""}${banded && last ? " band-last" : ""}`;
    const row = h("div", { class: cls, dataset: { id: d.id }, style: "padding-left:10px", title: `${d.main}\n${runTooltip(d)}` },
      h("span", { class: `pill ${d.kind === "HT" ? "ht" : "lt"}` }, d.kind),
      h("span", { class: "name" }, d.stem),
      h("span", { class: "meta", title: `${describeSmoothing(d)} · used by ${used} run(s)` },
        `${fmtShort(d.time)} · ${used}×${smoothFor(d).mode === "none" ? " · raw" : ""}`));
    row.addEventListener("click", (e) => clickRun(d.id, e));
    row.addEventListener("contextmenu", (e) => runMenu(e, d));
    list.append(row);
  });
  markSelection();
}

// ====================================================================== context menus
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(e, items) {
  e.preventDefault();
  closeMenu();
  menuEl = h("div", { class: "ctx" });
  for (const it of items) {
    if (it === "-") { menuEl.append(h("div", { class: "sep" })); continue; }
    menuEl.append(h("button", { disabled: it.disabled, onclick: () => { closeMenu(); it.run(); } }, it.label));
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + "px";
  menuEl.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + "px";
}
function runMenu(e, r) {
  if (!state.selected.includes(r.id)) select([r.id]);
  const sel = state.selected.map((id) => state.runs.get(id));
  showMenu(e, [
    r.dry
      ? { label: "Not an empty holder", run: () => setDry(r, false) }
      : { label: "Use as empty holder", run: () => setDry(r, true), disabled: r.out },
    ...(r.dry !== r.autoDry ? [{ label: "Reset empty-holder detection", run: () => setDry(r, null) }] : []),
    "-",
    { label: sel.length > 1 ? `Export ${sel.length} corrected runs` : "Export corrected run", run: () => exportRuns(sel),
      disabled: !sel.some((x) => !x.dry && !x.out) },
    { label: "Show in Explorer", run: () => api.reveal(r.main) },
  ]);
}
function dirMenu(e, p) {
  showMenu(e, [
    { label: "Open this folder", run: () => openFolder(p) },
    { label: "Export all runs in this folder", run: () => exportRuns(samples().filter((r) => (r.dir + "\\").toLowerCase().startsWith((p + "\\").toLowerCase()))) },
    { label: "Show in Explorer", run: () => api.openPath(p) },
  ]);
}
function setDry(r, val) {
  if (val == null) delete state.s.dryOverrides[r.main]; else state.s.dryOverrides[r.main] = val;
  persist();
  openFolder(state.root, { quiet: true });
}

// ====================================================================== viewer
function renderViewer() {
  const runs = state.selected.map((id) => state.runs.get(id)).filter(Boolean);
  $("#empty").classList.toggle("hidden", !!state.root && runs.length > 0);
  $("#viewer").classList.toggle("hidden", !runs.length);
  $("#inspector").classList.toggle("hidden", !runs.length);
  if (!state.root) { $("#empty").classList.remove("hidden"); return; }
  if (!runs.length) {
    $("#empty .empty-card h1").textContent = state.runs.size ? "Pick a run" : "No runs here";
    $("#empty .empty-card p").textContent = state.runs.size
      ? "Select a run in the sidebar. Ctrl/Shift-click to overlay several; ↑ ↓ flips through them."
      : "This folder has no .cur / .clw files. Open another folder.";
    return;
  }
  const one = runs.length === 1 ? runs[0] : null;
  // header
  $("#runTitle").textContent = one ? one.stem : `${runs.length} runs overlaid`;
  const sub = $("#runSub");
  sub.innerHTML = "";
  const bits = [];
  if (one) {
    bits.push(h("span", { class: `pill ${one.kind === "HT" ? "ht" : "lt"}` }, one.kind === "HT" ? "high-T furnace" : "low-T cryostat"));
    if (one.dry) bits.push(h("span", { class: "pill dry" }, "empty holder"));
    if (one.time) bits.push(fmtDateTime(one.time));
    bits.push(`${one.curve.rows.length} points`);
    if (!one.dry) {
      const p = dryFor(one);
      bits.push(p ? h("span", {}, "corrected with ", h("b", {}, p.dry.stem)) : h("span", { style: "color:var(--warn)" }, "no empty-holder run available – uncorrected"));
    }
  } else {
    const kinds = new Set(runs.map((r) => r.kind));
    bits.push([...kinds].map((k) => (k === "HT" ? "high-T" : "low-T")).join(" + "));
  }
  bits.forEach((b, i) => { if (i) sub.append(h("span", { class: "dot" })); sub.append(b); });

  // toolbar state
  for (const b of $$("#segView button")) b.classList.toggle("on", b.dataset.v === state.s.view);
  for (const b of $$("#segComp button")) b.classList.toggle("on", b.dataset.c === state.s.comp);
  for (const b of $$(".chips .chip")) b.classList.toggle("on", !!state.s[b.dataset.t]);
  // high-T runs heat, low-T runs warm up
  const hasHT = runs.some((r) => r.kind === "HT"), hasLT = runs.some((r) => r.kind === "LT");
  const heatChip = $('.chip[data-t="heating"]');
  heatChip.lastChild.textContent = hasHT && hasLT ? "Heating / warming" : hasLT ? "Warming" : "Heating";
  heatChip.querySelector(".sw.heat").classList.toggle("hidden", !hasHT);
  heatChip.querySelector(".sw.warm").classList.toggle("hidden", !hasLT);
  const anyIm = runs.some((r) => r.curveIm);
  $$("#segComp button").forEach((b) => { b.disabled = b.dataset.c !== "in" && !anyIm; });
  const anyStored = runs.some((r) => !r.dry && r.curve.rows.some((x) => Math.abs(x.csusc) > 5e-3));
  $("#chipStored").classList.toggle("hidden", !anyStored);
  const allDry = runs.every((r) => r.dry);
  $$("#segView button").forEach((b) => { b.disabled = allDry && b.dataset.v !== "corrected" && b.dataset.v !== "raw"; });

  drawPlot(runs);
  renderInspector(runs);
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function seriesFor(run, comp, view, res) {
  // -> { temp, time, segment, y, label, extra:[{name,y,style}] }
  const curve = comp === "out" ? run.curveIm : run.curve;
  if (!curve) return null;
  const rows = curve.rows;
  const temp = rows.map((r) => r.temp), time = rows.map((r) => r.time);
  const segment = L.segments(temp);
  const raw = rows.map((r) => r.tsusc);
  if (run.dry) {
    return { temp, time, segment, y: raw, smooth: L.holderValues(rows, smoothFor(run)), dry: true };
  }
  const corr = res ? (comp === "out" ? res.cout : res.cin) : null;
  if (!corr) return { temp, time, segment, y: raw, uncorrected: true, raw };
  const y = view === "norm" ? corr.nsusc
    : view === "inverse" ? corr.csusc.map((v) => (Math.abs(v) < 1e-3 ? null : 1 / v))
    : corr.csusc;
  return { temp, time, segment, y, raw, holder: corr.holder, outside: corr.outside, corr,
           stored: corr.stored ? (view === "norm" ? corr.stored.nsusc : view === "inverse" ? corr.stored.csusc.map((v) => (Math.abs(v) < 1e-3 ? null : 1 / v)) : corr.stored.csusc) : null };
}

/** Tag per selected run for overlays (see CurLib.overlayTags). */
function overlayLabels(runs) {
  return L.overlayTags(runs.map((r) => ({ id: r.id, spec: r.label.spec, piece: r.label.piece || r.stem, run: r.label.run, kind: r.kind })));
}

/** Pin each tag to its curve where that curve is clear of the other curves and of the
 *  tags already placed (greedy, in normalised plot coordinates). */
//   obstacles: curves to keep clear of that get no tag; placed: labels already on the plot
//   one: put a single label on whichever target has the clearest spot
// Each candidate is the label's own box (text width x height, above or below the anchor),
// scored by how clear it stays of every curve and of the other labels.
function placeTags(targets, tags, theme, { obstacles = [], placed: already = [], one = false } = {}) {
  const ok = (v) => v != null && Number.isFinite(v);
  const all = [...targets, ...obstacles];
  const xsAll = all.flatMap((t) => t.xs), ysAll = all.flatMap((t) => t.ys).filter(ok);
  if (!xsAll.length || !ysAll.length) return [];
  const x0 = Math.min(...xsAll), xw = Math.max(...xsAll) - x0 || 1;
  const y0 = Math.min(...ysAll), yw = Math.max(...ysAll) - y0 || 1;
  const sz = ($("#plot")._fullLayout || {})._size || {};
  const PW = sz.w || 800, PH = sz.h || 600;                     // plot area in px
  const OFF = 29 / PH;                                          // leader (20 px) + half a label
  const half = (text) => [(String(text).replace(/<[^>]+>/g, "").length * 6.6 + 12) / 2 / PW, 11 / PH];
  const norm = (t) => t.xs.map((x, i) => [(x - x0) / xw, ok(t.ys[i]) ? (t.ys[i] - y0) / yw : null, i]).filter((p) => p[1] != null);
  const curves = targets.map(norm), blocks = obstacles.map(norm);
  const placed = already.map((a) => {
    const [hx, hy] = half(a.text || "");
    return { x: (a.x - x0) / xw, y: (a.y - y0) / yw + (a.ay < 0 ? OFF : -OFF), hx, hy };
  });
  const out = [];
  let overall = null;
  const label = (t, best) => ({
    x: t.xs[best.i], y: t.ys[best.i], xref: "x", yref: t.yaxis, text: t.text || tags.get(t.run.id),
    showarrow: true, arrowhead: 0, arrowwidth: 1, arrowcolor: t.color, ax: 0, ay: best.up ? -20 : 20, standoff: 1,
    font: { size: 11, color: t.color }, bgcolor: theme.bg, bordercolor: t.color, borderwidth: 1, borderpad: 2,
    hovertext: t.hover || t.run.stem,
  });
  targets.forEach((t, ti) => {
    const pts = curves[ti];
    if (pts.length < 2) return;
    const [hx, hy] = half(t.text || tags.get(t.run.id));
    const others = [...(one ? [] : curves.filter((_, ci) => ci !== ti)), ...blocks, pts];
    let best = null;
    for (const f of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const [px, py, i] = pts[Math.round(f * (pts.length - 1))];
      for (const up of [true, false]) {
        const tx = px, ty = py + (up ? OFF : -OFF);
        if (ty + hy > 1.02 || ty - hy < -0.02) continue;
        // < 1 means overlap: box distance in units of the boxes' half sizes
        let dTag = 3;
        for (const q of placed) dTag = Math.min(dTag, Math.max(Math.abs(tx - q.x) / (hx + q.hx), Math.abs(ty - q.y) / (hy + q.hy)));
        let clear = 3;
        for (const c of others) for (const [cx, cy] of c) clear = Math.min(clear, Math.max(Math.abs(cx - tx) / hx, Math.abs(cy - ty) / hy));
        const score = Math.min(dTag, 2) * 2 + Math.min(clear, 2) * 3 - Math.abs(f - 0.5) * 0.3;
        if (!best || score > best.score) best = { score, i, tx, ty, up, hx, hy };
      }
    }
    if (!best) return;
    if (one) { if (!overall || best.score > overall.best.score) overall = { t, best }; return; }
    placed.push({ x: best.tx, y: best.ty, hx, hy });
    out.push(label(t, best));
  });
  if (one && overall) out.push(label(overall.t, overall.best));
  return out;
}

function drawPlot(runs, exportTheme) {
  const s = state.s;
  const theme = exportTheme || {
    text: cssVar("--text"), text2: cssVar("--text-2"), text3: cssVar("--text-3"), line: cssVar("--line"), line2: cssVar("--line-2"),
    bg: cssVar("--bg"), heat: cssVar("--heat"), warm: cssVar("--warm"), cool: cssVar("--cool"), para: cssVar("--para"), warnSoft: cssVar("--warn-soft"),
    zero: cssVar("--zero"), model: cssVar("--model"),
  };
  const multi = runs.length > 1;
  const comps = s.comp === "both" ? ["in", "out"] : [s.comp];
  const view = s.view;
  const traces = [], shapes = [], annotations = [];
  let xmin = Infinity, xmax = -Infinity, hasY2 = false;
  const kinds = new Set(), legendSeen = new Set();

  // Overlays keep the run-type colours; each curve gets a tag naming its file instead
  // (see overlayLabels), and the legend lists the types, not the files.
  const tags = multi ? overlayLabels(runs) : null;
  const labelComp = comps[0];
  const tagTargets = [], paraTargets = [], targets = [];
  const addTrace = (t, generic, full) => {
    t.name = generic;
    if (multi) {
      t.legendgroup = generic;
      t.showlegend = !legendSeen.has(generic);
      legendSeen.add(generic);
    }
    t.hovertemplate = t.hovertemplate.replace("%{fullData.name}", esc(full).replace(/%/g, "%%"));
    t.meta = full;
    traces.push(t);
  };

  runs.forEach((run) => {
    kinds.add(run.kind);
    const res = correctionFor(run);
    for (const comp of comps) {
      const sr = seriesFor(run, comp, view, res);
      if (!sr) continue;
      const yaxis = comp === "out" && comps.length > 1 ? "y2" : "y";
      if (yaxis === "y2") hasY2 = true;
      const compTag = comps.length > 1 ? (comp === "out" ? " χ″" : " χ′") : "";
      for (const seg of ["heating", "cooling"]) {
        if (!s[seg]) continue;
        const idx = sr.segment.map((g, i) => (g === seg ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) continue;
        const color = seg === "cooling" ? theme.cool : run.kind === "LT" ? theme.warm : theme.heat;
        const segName = run.kind === "LT" && seg === "heating" ? "warming" : seg;
        const xs = idx.map((i) => sr.temp[i]);
        const cd = idx.map((i) => sr.time[i] / 60);
        xmin = Math.min(xmin, ...xs); xmax = Math.max(xmax, ...xs);
        const outBoth = comp === "out" && comps.length > 1;      // out-of-phase beside in-phase: dotted
        const dash = seg === "cooling" ? (outBoth ? "dashdot" : "dash") : (outBoth ? "dot" : "solid");
        const hover = `<b>%{fullData.name}</b><br>T = %{x:.1f} °C<br>${view === "inverse" ? "1/χ" : view === "norm" ? "χ/χmax" : "χ"} = %{y:.${view === "norm" ? 3 : view === "inverse" ? 4 : 2}f}<br>t = %{customdata:.0f} min<extra></extra>`;
        const full = (g) => (multi ? `${run.stem} – ${g}` : g);
        const group = multi ? undefined : run.id + seg;
        if (sr.dry || view === "raw") {
          // the measured curve (sample or empty holder) …
          const ym = idx.map((i) => (sr.dry ? sr.y[i] : sr.raw[i]));
          const g1 = segName + compTag + (sr.dry ? " (measured)" : " (raw)");
          addTrace({ x: xs, y: ym, customdata: cd, type: "scatter", mode: sr.dry ? "markers" : s.markers ? "lines+markers" : "lines", isData: true,
            line: { color, width: s.markers ? 1 : 1.6, dash }, marker: { color, size: s.markers && !sr.dry ? 6 : 4, opacity: sr.dry ? 0.55 : 1 },
            yaxis, hovertemplate: hover, legendgroup: group }, g1, full(g1));
          if (multi && comp === labelComp && !sr.dry) tagTargets.push({ run, color, xs, ys: ym, yaxis });
          // … and what gets subtracted
          const hy = sr.dry ? sr.smooth : sr.holder;
          if (hy) {
            const yh = idx.map((i) => hy[i]);
            const g2 = (sr.dry ? `${segName} – ${describeSmoothing(run)}` : `empty holder – ${segName}`) + compTag;
            addTrace({ x: xs, y: yh, customdata: cd, type: "scatter", mode: "lines",
              line: { color: sr.dry ? color : theme.text2, width: sr.dry ? 2.2 : 1.6, dash: sr.dry ? dash : "dot" },
              yaxis, hovertemplate: hover, legendgroup: group }, g2, full(g2));
            if (multi && comp === labelComp && sr.dry) tagTargets.push({ run, color, xs, ys: yh, yaxis });
          }
          if (!sr.dry && view === "raw") {
            const res2 = res && (comp === "out" ? res.cout : res.cin);
            const g3 = segName + compTag + " (corrected)";
            if (res2) addTrace({ x: xs, y: idx.map((i) => res2.csusc[i]), customdata: cd, type: "scatter", mode: "lines",
              line: { color, width: 1, dash: "dash" }, opacity: 0.5, yaxis, hovertemplate: hover, legendgroup: group, visible: "legendonly" }, g3, full(g3));
          }
          continue;
        }
        const yv = idx.map((i) => sr.y[i]);
        const g = segName + compTag + (sr.uncorrected ? " (uncorrected)" : "");
        addTrace({ x: xs, y: yv, customdata: cd, type: "scatter", mode: s.markers ? "lines+markers" : "lines", isData: true,
          line: { color, width: s.markers ? (outBoth ? 0.8 : 1) : (outBoth ? 1.3 : 2), dash }, marker: { color, size: 6 },
          opacity: outBoth ? 0.75 : 1, yaxis, hovertemplate: hover, legendgroup: group }, g, full(g));
        if (multi && comp === labelComp) tagTargets.push({ run, color, xs, ys: yv, yaxis });
        if (s.stored && sr.stored && comp === "in") {
          const g4 = `stored correction – ${segName}`;
          addTrace({ x: xs, y: idx.map((i) => sr.stored[i]), customdata: cd, type: "scatter", mode: "lines",
            line: { color: theme.text, width: 1, dash: "dot" }, yaxis, hovertemplate: hover, legendgroup: group }, g4, full(g4));
        }
      }
      // paramagnetic fit chi0 + C/(T - theta): solid over the fitted stretch, dashed where
      // extrapolated; a ring where the heating curve leaves it
      if (s.para && comp === "in" && sr.corr && view !== "raw") {
        const pi = paraInfo(run, res);
        const c = pi && pi.active;
        if (c) {
          const smax = Math.max(...sr.corr.csusc);
          const tf = (v) => (view === "norm" ? v / smax : view === "inverse" ? (Math.abs(v) < 1e-3 ? null : 1 / v) : v);
          const line = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
          const xa = line(Math.min(...sr.temp), Math.max(...sr.temp), 160), xf = line(c.lo, c.hi, 60);
          const ya = xa.map((t) => tf(L.hyperbolaAt(c.fit, t))), yf = xf.map((t) => tf(L.hyperbolaAt(c.fit, t)));
          const law = c.fit.theta ? `C/(T − ${c.fit.theta} K)` : "C/T";
          const gp = `paramagnetic fit χ₀ + ${law}`;
          const fullName = `${multi ? `${run.stem} – ` : ""}${gp}, ${pctText(c)} at ${fmtT(c.share.t)} °C`;
          const hov = `<b>%{fullData.name}</b><br>T = %{x:.1f} °C<br>${view === "inverse" ? "1/χ" : view === "norm" ? "χ/χmax" : "χ"} = %{y:.${view === "norm" ? 3 : view === "inverse" ? 4 : 2}f}<extra></extra>`;
          const grp = multi ? gp : run.id + "para";
          addTrace({ x: xa, y: ya, type: "scatter", mode: "lines", line: { color: theme.para, width: 1.6, dash: "dash" }, yaxis, isPara: true,
            hovertemplate: hov, legendgroup: grp }, gp, fullName);
          addTrace({ x: xf, y: yf, type: "scatter", mode: "lines", line: { color: theme.para, width: 3 }, opacity: 0.85, yaxis, isPara: true,
            hovertemplate: hov, legendgroup: grp, showlegend: false }, gp, `${fullName} (fitted stretch)`);
          if (c.departure) {
            const hi = sr.segment.map((g, i) => (g === "heating" ? i : -1)).filter((i) => i >= 0);
            const k = hi[L.nearestIndex(hi.map((i) => sr.temp[i]), c.departure.t)];
            traces.push({ x: [sr.temp[k]], y: [sr.y[k]], type: "scatter", mode: "markers", yaxis, isPara: true, showlegend: false,
              marker: { symbol: "circle-open", size: 13, color: theme.para, line: { width: 2.2, color: theme.para } },
              hovertemplate: `<b>${esc(multi ? run.stem + " – " : "")}leaves the hyperbola</b><br>T = %{x:.0f} °C, χ ${c.departure.dir > 0 ? "above" : "below"} it<extra></extra>` });
          }
          paraTargets.push({ run, color: theme.para, xs: xa, ys: ya, yaxis, text: `para ${pctText(c)}`, hover: fullName });
          if (c.departure) targets.push({ t: c.departure.t, label: "leaves hyperbola" });
          // the mineral model: its paramagnetic curve, moved up / down with the Y slider
          const mi = !multi && s.model ? modelInfo(run, res, c) : null;
          if (mi) {
            addTrace({ x: xa, y: xa.map((t) => tf(mi.at(t))), type: "scatter", mode: "lines", line: { color: theme.model, width: 2, dash: "dot" }, yaxis, isPara: true,
              hovertemplate: hov, legendgroup: run.id + "model" }, "mineral model", `mineral model (${mi.name}), Y at 25 °C = ${mi.y25.toFixed(2)}`);
            paraTargets.push({ run, color: theme.model, xs: xa, ys: xa.map((t) => tf(mi.at(t))), yaxis, text: `${mi.name} model`, hover: `mineral model (${mi.name})`, model: true });
          }
        }
      }
      // features found in the curve: Hopkinson peaks (labelled) and steep changes, both
      // also targets for the jump arrows at the plot edges
      // Hopkinson peaks show most clearly in the out-of-phase curve, so both components
      // are searched; each is labelled on the curve that shows it
      if (!sr.dry) {
        const base = sr.corr ? sr.corr.csusc : sr.raw || sr.y;
        const shown = (g) => !!s[g === "cooling" ? "cooling" : "heating"];
        // at the tip: the highest plotted point of that branch within 10 °C; heating's label
        // leans left, cooling's right, so the two don't cover each other at one Curie point
        const label = (pk, text, hovertext) => {
          if (view === "inverse") return;
          const ys = view === "raw" ? sr.raw : sr.y;
          let k = -1;
          sr.temp.forEach((t, i) => { if (sr.segment[i] === pk.branch && Math.abs(t - pk.t) <= 10 && ys[i] != null && (k < 0 || ys[i] > ys[k])) k = i; });
          if (k < 0) return;
          const cool = pk.branch === "cooling";
          annotations.push({ x: sr.temp[k], y: ys[k], xref: "x", yref: yaxis, text, showarrow: true, arrowhead: 0, arrowwidth: 1,
            arrowcolor: cool ? theme.cool : theme.heat, ax: cool ? 26 : -26, ay: -14, standoff: 2, font: { size: 9.5, color: theme.text2 },
            bgcolor: theme.bg, borderpad: 1, hovertext });
        };
        // one label per Curie point: on cooling only where heating has no peak near it
        // (a mineral that formed during the heating)
        const once = (pks) => pks.filter((p) => shown(p.branch) &&
          !(p.branch === "cooling" && shown("heating") && pks.some((q) => q.branch === "heating" && Math.abs(q.t - p.t) < 25)));
        if (run.kind === "HT") {
          const own = once(L.hopkinsonPeaks(sr.temp, base, sr.segment));
          for (const pk of own) {
            targets.push({ t: pk.t, label: "Hopkinson" });
            label(pk, "Hopkinson", `Hopkinson peak at ${fmtT(pk.t)} °C (${comp === "out" ? "out-of-phase" : "in-phase"}, ${pk.branch}): χ peaks just below a Curie point`);
          }
          // in-phase alone: the peaks only the out-of-phase curve shows
          if (comp === "in" && comps.length === 1 && res && res.cout) {
            for (const pk of once(L.hopkinsonPeaks(res.cout.temp, res.cout.csusc, res.cout.segment))) {
              if (own.some((o) => Math.abs(o.t - pk.t) < 25)) continue;
              targets.push({ t: pk.t, label: "χ″ Hopkinson" });
              label(pk, "χ″ Hopkinson", `The out-of-phase curve peaks at ${fmtT(pk.t)} °C (${pk.branch}) – a Hopkinson peak; E shows it`);
            }
          }
        }
        if (comp === "in") for (const st of L.steepChanges(sr.temp, base, sr.segment)) {
          if (shown(st.branch)) targets.push({ t: st.t, label: st.dir < 0 ? "χ drop" : "χ rise" });
        }
      }
      // shade what lies outside the empty holder's temperature range (held, not interpolated)
      if (!multi && sr.corr && comp === comps[0]) {
        const st = sr.corr.stats, tmin = Math.min(...sr.temp), tmax = Math.max(...sr.temp);
        const band = (x0, x1, label) => {
          shapes.push({ type: "rect", xref: "x", yref: "paper", x0, x1, y0: 0, y1: 1, fillcolor: theme.warnSoft, opacity: 0.7, line: { width: 0 }, layer: "below" });
          annotations.push({ x: (x0 + x1) / 2, y: 0.02, xref: "x", yref: "paper", text: label, showarrow: false, font: { size: 10, color: theme.text3 }, yanchor: "bottom" });
        };
        if (st.warm && tmax > st.holderTmax + 0.05) band(st.holderTmax, tmax, "beyond empty holder");
        if (st.cold && tmin < st.holderTmin - 0.05) band(tmin, st.holderTmin, "beyond empty holder");
      }
    }
  });
  if (multi) annotations.push(...placeTags(tagTargets, tags, theme));
  // label the paramagnetic fit(s) where they are clear of the data curves and the file
  // tags: "para 61 %" for a single run; in overlays every run has its own fit, so each
  // gets "<tag> · para 33 %"
  if (paraTargets.length) {
    const curves = traces.filter((t) => !t.isPara && t.visible !== "legendonly" && (t.yaxis || "y") === "y").map((t) => ({ xs: t.x, ys: t.y }));
    if (multi) paraTargets.forEach((t) => { t.text = `${tags.get(t.run.id)} · ${t.text}`; });
    const fits = paraTargets.filter((t) => !t.model), models = paraTargets.filter((t) => t.model);
    annotations.push(...placeTags(fits, tags, theme, { obstacles: curves, placed: annotations.filter((a) => a.showarrow), one: !multi }));
    if (models.length) annotations.push(...placeTags(models, tags, theme, { obstacles: curves, placed: annotations.filter((a) => a.showarrow), one: true }));
  }

  if (s.refs && Number.isFinite(xmin)) {
    // dotted line in the plot, a small clickable chip just above it (click = zoom there)
    for (const k of kinds) for (const [t, label, abbr] of L.REF_LINES[k] || []) {
      if (t < xmin || t > xmax) continue;
      targets.push({ t, label: abbr.replace(/<sub>(.*?)<\/sub>/g, "$1"), ref: true });
      shapes.push({ type: "line", xref: "x", yref: "paper", x0: t, x1: t, y0: 0, y1: 1, line: { color: theme.text3, width: 1, dash: "dot" }, layer: "below" });
      annotations.push({ name: `ref:${t}`, x: t, y: 1, xref: "x", yref: "paper", yanchor: "bottom", yshift: 3, text: abbr,
        hovertext: `${label}, ${t} °C – click to zoom here`, showarrow: false, captureevents: !exportTheme,
        font: { size: 10.5, color: theme.text2 }, bgcolor: theme.bg, bordercolor: theme.line2, borderwidth: 1, borderpad: 2 });
    }
    // transitions colder than the instrument reaches: an arrow at the cold edge
    for (const k of kinds) for (const [a, b, label, abbr] of L.OFF_SCALE[k] || []) {
      if (b < xmin) targets.push({ t: (a + b) / 2, label: abbr, off: true, title: label });
    }
  }

  const yTitle = { corrected: "χ  (10⁻⁶ SI)", raw: "χ, uncorrected  (10⁻⁶ SI)", norm: "χ / χ<sub>max</sub>", inverse: "1/χ  (10⁶ SI⁻¹)" }[view];
  // a high-contrast zero line, so negative susceptibility stands out at once
  const axis = { gridcolor: theme.line, zerolinecolor: theme.zero, zerolinewidth: 1, linecolor: theme.line2, showline: true, ticks: "outside", tickcolor: theme.line2, ticklen: 4, automargin: true };
  const layout = {
    paper_bgcolor: exportTheme ? theme.bg : "rgba(0,0,0,0)", plot_bgcolor: exportTheme ? theme.bg : "rgba(0,0,0,0)",
    font: { family: getComputedStyle(document.body).fontFamily, size: 12, color: theme.text },
    margin: { l: 70, r: hasY2 ? 70 : 34, t: exportTheme ? 64 : 26, b: 84 },
    xaxis: { ...axis, zeroline: false, title: { text: "Temperature (°C)", standoff: 8 } },
    yaxis: { ...axis, title: { text: comps.length > 1 ? yTitle.replace("χ", "χ′") : s.comp === "out" ? yTitle.replace("χ", "χ″") : yTitle, standoff: 8 }, zeroline: view !== "norm" },
    legend: { orientation: "h", x: 0, xanchor: "left", y: 0, yref: "container", yanchor: "bottom", bgcolor: "rgba(0,0,0,0)", font: { size: 11.5 }, itemwidth: 36 },
    modebar: { bgcolor: "rgba(0,0,0,0)", color: theme.text3, activecolor: theme.text, orientation: "v" },
    hovermode: "closest",
    hoverlabel: { bgcolor: theme.bg, bordercolor: theme.line2, font: { color: theme.text, size: 12 } },
    shapes, annotations,
    uirevision: state.selected.join("|") + view + s.comp,
    dragmode: "pan",
  };
  if (hasY2) {
    // out-of-phase on its own scale at the right; both zeros at the same height, so the
    // curves don't seem to shift between the In-phase / Out-of-phase / Both views
    layout.yaxis2 = { ...axis, overlaying: "y", side: "right", showgrid: false, zeroline: view !== "norm",
      title: { text: yTitle.replace("χ", "χ″") + "  · right axis", standoff: 8 } };
    const span = (ax) => {
      const ys = traces.filter((t) => (t.yaxis || "y") === ax && t.visible !== "legendonly").flatMap((t) => t.y).filter((v) => v != null && Number.isFinite(v));
      if (!ys.length) return null;
      const a = Math.min(...ys), b = Math.max(...ys), pad = (b - a) * 0.06 || Math.abs(a) * 0.05 || 1;
      return [a - pad, b + pad];
    };
    const r1 = span("y"), r2 = span("y2");
    if (r1 && r2) [layout.yaxis.range, layout.yaxis2.range] = alignZeros(r1, r2);
  }
  if (exportTheme) {
    layout.title = { text: runs.length === 1 ? runs[0].stem : runs.map((r) => r.stem).join(", "), x: 0.01, xanchor: "left", font: { size: 15 } };
    return { data: traces, layout };
  }
  Plotly.react("plot", traces, layout, {
    responsive: true, displaylogo: false, scrollZoom: true, doubleClick: "autosize",
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toImage", "zoom2d", "pan2d"],
  });
  const gd = $("#plot");
  // jump targets, nearest first per temperature (a feature within 6 °C of another is one target)
  const uniq = [];
  for (const t of targets.sort((a, b) => (b.ref ? 1 : 0) - (a.ref ? 1 : 0))) if (!uniq.some((u) => Math.abs(u.t - t.t) < 6)) uniq.push(t);
  gd._targets = uniq.sort((a, b) => a.t - b.t);
  gd._dataRange = Number.isFinite(xmin) ? [xmin, xmax] : null;
  $$(".plot-wrap .ref-temp, .plot-wrap .ref-preview").forEach((e) => e.remove());
  if (!gd._refClicks) {
    gd._refClicks = true;
    gd.on("plotly_clickannotation", (ev) => {
      const name = ev.annotation && ev.annotation.name;
      if (name && name.startsWith("ref:")) zoomToTemp(+name.slice(4));
    });
    // moving the plot clears the temperature label of the last jump
    gd.on("plotly_relayout", () => { $$(".plot-wrap .ref-temp").forEach((e) => e.remove()); updateJumpers(); });
    // hovering a transition label previews its line
    gd.addEventListener("mouseover", (e) => {
      const g = e.target.closest && e.target.closest(".annotation");
      const a = g && (gd.layout.annotations || [])[+g.getAttribute("data-index")];
      if (a && a.name && a.name.startsWith("ref:")) showRefPreview(+a.name.slice(4));
    });
    gd.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".annotation")) $$(".plot-wrap .ref-preview").forEach((x) => x.remove()); });
  }
  requestAnimationFrame(updateJumpers);
}

/** Two y ranges widened so that zero sits at the same height on both axes. */
function alignZeros(r1, r2) {
  const f = ([a, b]) => (a >= 0 ? 0 : b <= 0 ? 1 : -a / (b - a));     // zero's height, 0 = bottom
  const F = Math.max(f(r1), f(r2));
  const fit = ([a, b]) => {
    if (F <= 0) return [Math.min(0, a), b];
    if (F >= 1) return [a, Math.max(0, b)];
    const top = Math.max(b, (-a * (1 - F)) / F);
    return [(-F * top) / (1 - F), top];
  };
  return [fit(r1), fit(r2)];
}

// ====================================================================== plot mouse
// Right-drag draws a zoom box (a flat box zooms x only, a narrow one y only), middle-drag
// pans; left-drag pans through Plotly's own dragmode; double-click / Esc zoom back out.
function plotGeom() {
  const gd = $("#plot"), fl = gd._fullLayout;
  if (!fl || !fl.xaxis || !fl._size) return null;
  const r = gd.getBoundingClientRect(), sz = fl._size;
  const ys = [["yaxis", fl.yaxis.range.slice()]];
  if (gd.layout.yaxis2 && fl.yaxis2) ys.push(["yaxis2", fl.yaxis2.range.slice()]);
  return { left: r.left + sz.l, top: r.top + sz.t, w: sz.w, h: sz.h, x: fl.xaxis.range.slice(), ys };
}
const guiRelayout = (update) => (Plotly._guiRelayout || Plotly.relayout)($("#plot"), update);
const shownTraces = () => ($("#plot").data || []).filter((tr) => tr.visible !== false && tr.visible !== "legendonly");
/** Zoom onto the data around temperature t: ±12 % of the plotted temperature span
 *  (at least ±15 °C), χ fitted to the visible curves inside that window. */
function zoomToTemp(t) {
  const xs = shownTraces().flatMap((tr) => tr.x);
  if (!xs.length) return;
  const half = Math.max(15, (Math.max(...xs) - Math.min(...xs)) * 0.12);
  zoomToRange(t - half, t + half, () => { flashLine(t); markTemp(t); });
}

/** Zoom to temperatures lo..hi, χ fitted to the visible curves inside (only those passing
 *  fitTo, when given and any do); then done(). */
function zoomToRange(lo, hi, done, fitTo) {
  let shown = shownTraces();
  if (!shown.length) return;
  if (fitTo && shown.some(fitTo)) shown = shown.filter(fitTo);
  const u = { "xaxis.range": [lo, hi] };
  for (const [ax, key] of [["y", "yaxis"], ["y2", "yaxis2"]]) {
    const ys = [];
    for (const tr of shown) {
      if ((tr.yaxis || "y") !== ax) continue;
      tr.x.forEach((x, i) => { const y = tr.y[i]; if (x >= lo && x <= hi && y != null && Number.isFinite(y)) ys.push(y); });
    }
    if (!ys.length) continue;
    const a = Math.min(...ys), b = Math.max(...ys), pad = (b - a) * 0.08 || Math.abs(a) * 0.05 || 1;
    u[key + ".range"] = [a - pad, b + pad];
  }
  if (u["yaxis.range"] && u["yaxis2.range"]) [u["yaxis.range"], u["yaxis2.range"]] = alignZeros(u["yaxis.range"], u["yaxis2.range"]);
  Promise.resolve(guiRelayout(u)).then(() => requestAnimationFrame(() => done && done()));
}

/** Pixel x of temperature t on the plot, relative to .plot-wrap (null outside the view). */
function plotX(t) {
  const g = plotGeom();
  if (!g || t < Math.min(...g.x) || t > Math.max(...g.x)) return null;
  const wr = $(".plot-wrap").getBoundingClientRect();
  return { x: g.left + ((t - g.x[0]) / (g.x[1] - g.x[0])) * g.w - wr.left, top: g.top - wr.top, h: g.h };
}

/** The temperature of the transition / feature jumped to, in yellow on the temperature
 *  axis; it stays until the plot is moved (see the plotly_relayout handler). */
function markTemp(t) {
  $$(".plot-wrap .ref-temp").forEach((e) => e.remove());
  const p = plotX(t);
  if (!p) return;
  const el = h("div", { class: "ref-temp" }, `${fmtT(t)} °C`);
  Object.assign(el.style, { left: p.x + "px", top: p.top + p.h - 21 + "px" });
  $(".plot-wrap").append(el);
}

/** Faint yellow line where a hovered transition label would zoom to. */
function showRefPreview(t) {
  $$(".plot-wrap .ref-preview").forEach((e) => e.remove());
  const p = plotX(t);
  if (!p) return;
  const el = h("div", { class: "ref-preview" });
  Object.assign(el.style, { left: p.x - 1.5 + "px", top: p.top + "px", height: p.h + "px" });
  $(".plot-wrap").append(el);
}

/** When the view doesn't show everything: an arrow at each edge naming the nearest
 *  transition or curve feature beyond it (click = jump there). Transitions colder than
 *  the instrument reaches (Besnus) always sit at the cold edge. */
function updateJumpers() {
  const gd = $("#plot"), wrap = $(".plot-wrap");
  $$(".plot-wrap .jump").forEach((e) => e.remove());
  const g = plotGeom(), all = gd._targets || [];
  if (!g || !all.length || $("#viewer").classList.contains("hidden")) return;
  const x0 = Math.min(...g.x), x1 = Math.max(...g.x), wr = wrap.getBoundingClientRect();
  const left = all.filter((t) => t.t < x0 - 0.5).pop(), right = all.find((t) => t.t > x1 + 0.5);
  for (const [t, side] of [[left, "left"], [right, "right"]]) {
    if (!t) continue;
    const label = t.off ? t.label : `${t.label} ${fmtT(t.t)} °C`;
    const el = h("button", { class: `jump ${side}`, title: t.title || `Jump to ${t.label} at ${fmtT(t.t)} °C` },
      side === "left" ? `‹ ${label}` : `${label} ›`);
    el.addEventListener("click", () => {
      if (!t.off) return zoomToTemp(t.t);
      const r = gd._dataRange;              // off-scale: show the coldest part of the run
      if (r) zoomToRange(r[0] - 3, r[0] + Math.max(30, (r[1] - r[0]) * 0.15), () => toast(t.title));
    });
    el.style.top = g.top - wr.top + 6 + "px";
    if (side === "left") el.style.left = g.left - wr.left + 6 + "px";
    else el.style.right = wr.right - (g.left + g.w) + 6 + "px";
    wrap.append(el);
  }
}

/** Run a view change keeping the temperature zoom (χ refitted to what is then visible). */
function keepXZoom(change) {
  const gd = $("#plot"), fl = gd._fullLayout;
  const zoomed = fl && fl.xaxis && gd.layout && gd.layout.xaxis && gd.layout.xaxis.autorange === false;
  const r = zoomed ? fl.xaxis.range.slice() : null;
  change();
  if (r) zoomToRange(Math.min(...r), Math.max(...r));
}

/** Briefly light up the vertical marker at temperature t in yellow, then fade it out
 *  (an overlay on the plot; clicking again restarts it). */
function flashLine(t) {
  const g = plotGeom();
  if (!g || t < Math.min(...g.x) || t > Math.max(...g.x)) return;
  const wrap = $(".plot-wrap"), wr = wrap.getBoundingClientRect();
  const px = g.left + ((t - g.x[0]) / (g.x[1] - g.x[0])) * g.w;
  wrap.querySelectorAll(".ref-flash").forEach((e) => e.remove());
  const el = h("div", { class: "ref-flash" });
  Object.assign(el.style, { left: px - wr.left - 2 + "px", top: g.top - wr.top + "px", height: g.h + "px" });
  el.addEventListener("animationend", () => el.remove());
  wrap.append(el);
}

/** Shade the temperatures lo..hi on the plot (a paramagnetic stretch under the mouse);
 *  a stretch outside the current view shows as a strip at that edge. flash: fade out. */
function showBand(lo, hi, label, flash = false) {
  const g = plotGeom();
  if (!g) return;
  const wrap = $(".plot-wrap"), wr = wrap.getBoundingClientRect();
  const px = (t) => g.left + ((t - g.x[0]) / (g.x[1] - g.x[0])) * g.w;
  let a = Math.min(px(lo), px(hi)), b = Math.max(px(lo), px(hi));
  const side = b < g.left ? "left" : a > g.left + g.w ? "right" : null;
  if (side) { a = side === "left" ? g.left : g.left + g.w - 7; b = a + 7; }
  a = Math.max(a, g.left); b = Math.min(b, g.left + g.w);
  hideBand();
  const el = h("div", { class: `para-band${side ? ` off ${side}` : ""}${flash ? " flash" : ""}` },
    h("span", {}, side === "left" ? `‹ ${label}` : side === "right" ? `${label} ›` : label));
  Object.assign(el.style, { left: a - wr.left + "px", width: Math.max(2, b - a) + "px", top: g.top - wr.top + "px", height: g.h + "px" });
  if (flash) el.addEventListener("animationend", () => el.remove());
  wrap.append(el);
}
function hideBand() { $$(".plot-wrap .para-band").forEach((e) => e.remove()); }

function resetZoom() {
  const gd = $("#plot");
  if (!gd._fullLayout || !gd._fullLayout.xaxis) return;
  const u = { "xaxis.autorange": true, "yaxis.autorange": true };
  if (gd.layout.yaxis2) u["yaxis2.autorange"] = true;
  guiRelayout(u);
}

// Alt held over the plot: a faint vertical line at the mouse, with the temperature and the
// χ and measuring time of every curve there, read out at the top (the axis is at the bottom)
function wireCrosshair() {
  const wrap = $(".plot-wrap");
  const line = h("div", { class: "xhair hidden" }), box = h("div", { class: "xhair-box hidden" });
  wrap.append(line, box);
  let lastX = null;
  const hide = () => { line.classList.add("hidden"); box.classList.add("hidden"); };
  const show = (cx) => {
    const g = plotGeom();
    if (!g || $("#viewer").classList.contains("hidden") || cx < g.left || cx > g.left + g.w) return hide();
    const wr = wrap.getBoundingClientRect();
    const T = g.x[0] + ((cx - g.left) / g.w) * (g.x[1] - g.x[0]);
    const dec = state.s.view === "norm" ? 3 : state.s.view === "inverse" ? 4 : 2;
    const sym = state.s.view === "inverse" ? "1/χ" : state.s.view === "norm" ? "χ/χmax" : "χ";
    box.innerHTML = "";
    box.append(h("div", { class: "xhair-t" }, `${T.toFixed(1)} °C`));
    for (const tr of shownTraces()) {
      if (!tr.isData) continue;
      for (let i = 0; i < tr.x.length - 1; i++) {        // first stretch of the curve spanning T
        const a = tr.x[i], b = tr.x[i + 1];
        if (a === b || (T - a) * (T - b) > 0 || tr.y[i] == null || tr.y[i + 1] == null) continue;
        const f = (T - a) / (b - a), y = tr.y[i] + f * (tr.y[i + 1] - tr.y[i]);
        const t = tr.customdata ? tr.customdata[i] + f * (tr.customdata[i + 1] - tr.customdata[i]) : null;
        const sw = h("i", { class: "xhair-sw" });
        sw.style.background = tr.line.color;
        box.append(h("div", { class: "xhair-row" }, sw, h("span", { class: "xhair-name" }, tr.meta || tr.name),
          h("b", {}, `${(tr.yaxis || "y") === "y2" ? sym.replace("χ", "χ″") : sym} ${y.toFixed(dec)}`), t == null ? "" : h("span", {}, `${t.toFixed(0)} min`)));
        break;
      }
    }
    const x = cx - wr.left;
    Object.assign(line.style, { left: x + "px", top: g.top - wr.top + "px", height: g.h + "px" });
    line.classList.remove("hidden"); box.classList.remove("hidden");
    const bw = box.offsetWidth;
    box.style.left = Math.max(g.left - wr.left, Math.min(x - bw / 2, g.left - wr.left + g.w - bw)) + "px";
    box.style.top = g.top - wr.top + 4 + "px";
  };
  wrap.addEventListener("mousemove", (e) => { lastX = e.clientX; if (e.altKey) show(e.clientX); else hide(); });
  wrap.addEventListener("mouseleave", () => { lastX = null; hide(); });
  addEventListener("keydown", (e) => {
    if (e.key !== "Alt") return;
    e.preventDefault();                       // no menu activation from a lone Alt
    if (lastX != null) show(lastX);
    if (peek) showPeek();
  });
  addEventListener("keyup", (e) => { if (e.key === "Alt") { e.preventDefault(); hide(); hidePeek(); } });
  addEventListener("blur", () => { hide(); hidePeek(); });
}

function wirePlotMouse() {
  const gd = $("#plot"), wrap = $(".plot-wrap");
  const box = h("div", { class: "zoombox hidden" });
  wrap.append(box);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const AXIS_ONLY = 12;                                  // px: thinner than this = one-axis zoom
  let drag = null;

  gd.addEventListener("contextmenu", (e) => e.preventDefault());
  // keep Plotly away from middle/right presses; also stops Chromium's middle-click autoscroll
  gd.addEventListener("mousedown", (e) => {
    if (e.button === 1 || e.button === 2) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  gd.addEventListener("pointerdown", (e) => {
    if (e.button !== 1 && e.button !== 2) return;
    const g = plotGeom();
    if (!g || e.clientX < g.left || e.clientX > g.left + g.w || e.clientY < g.top || e.clientY > g.top + g.h) return;
    e.preventDefault(); e.stopPropagation();
    drag = { mode: e.button === 2 ? "zoom" : "pan", g, x0: e.clientX, y0: e.clientY, raf: 0, sel: null };
    try { gd.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    gd.style.cursor = drag.mode === "pan" ? "grabbing" : "crosshair";
  }, true);

  gd.addEventListener("pointermove", (e) => {
    if (!drag) return;
    e.stopPropagation();
    const g = drag.g;
    if (drag.mode === "pan") {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      const sx = (g.x[1] - g.x[0]) / g.w;
      const u = { "xaxis.range": [g.x[0] - dx * sx, g.x[1] - dx * sx] };
      for (const [k, r] of g.ys) { const sy = (r[1] - r[0]) / g.h; u[k + ".range"] = [r[0] + dy * sy, r[1] + dy * sy]; }
      cancelAnimationFrame(drag.raf);
      drag.raf = requestAnimationFrame(() => guiRelayout(u));
      return;
    }
    const xa = clamp(drag.x0, g.left, g.left + g.w), ya = clamp(drag.y0, g.top, g.top + g.h);
    const xb = clamp(e.clientX, g.left, g.left + g.w), yb = clamp(e.clientY, g.top, g.top + g.h);
    let x1 = Math.min(xa, xb), x2 = Math.max(xa, xb), y1 = Math.min(ya, yb), y2 = Math.max(ya, yb);
    const xOnly = y2 - y1 < AXIS_ONLY && x2 - x1 >= AXIS_ONLY, yOnly = x2 - x1 < AXIS_ONLY && y2 - y1 >= AXIS_ONLY;
    if (xOnly) { y1 = g.top; y2 = g.top + g.h; }
    if (yOnly) { x1 = g.left; x2 = g.left + g.w; }
    drag.sel = { x1, x2, y1, y2, xOnly, yOnly, big: x2 - x1 >= 6 || y2 - y1 >= 6 };
    const wr = wrap.getBoundingClientRect();
    Object.assign(box.style, { left: x1 - wr.left + "px", top: y1 - wr.top + "px", width: x2 - x1 + "px", height: y2 - y1 + "px" });
    box.classList.toggle("hidden", !drag.sel.big);
  }, true);

  const end = (e) => {
    if (!drag) return;
    e.stopPropagation();
    const { g, sel, mode } = drag;
    cancelAnimationFrame(drag.raf);
    drag = null;
    gd.style.cursor = "";
    box.classList.add("hidden");
    if (mode !== "zoom" || !sel || !sel.big) return;
    const fx = (px) => g.x[0] + ((px - g.left) / g.w) * (g.x[1] - g.x[0]);
    const fy = (r, py) => r[1] - ((py - g.top) / g.h) * (r[1] - r[0]);
    const u = {};
    if (!sel.yOnly) u["xaxis.range"] = [fx(sel.x1), fx(sel.x2)];
    if (!sel.xOnly) for (const [k, r] of g.ys) u[k + ".range"] = [fy(r, sel.y2), fy(r, sel.y1)];
    guiRelayout(u);
  };
  gd.addEventListener("pointerup", end, true);
  gd.addEventListener("pointercancel", end, true);
}

// ====================================================================== inspector
function renderInspector(runs) {
  const ins = $("#inspector");
  ins.innerHTML = "";
  hideBand();
  if (runs.length > 1) { ins.append(selectionCard(runs)); return; }
  const r = runs[0];
  if (r.dry) ins.append(dryCard(r)); else ins.append(correctionCard(r));
  if (!r.out) ins.append(notesCard(r));
  if (state.s.para && !r.dry) ins.append(paraCard(r));
  ins.append(runCard(r));
  if (!r.dry && !r.out) ins.append(exportCard([r]));
}

/** How an empty holder is smoothed before subtraction: running mean (N points), the
 *  smoothing stored in the file, or none. `compact` = shown on a sample's card. */
function holderSmoothingField(d, compact) {
  const spec = smoothFor(d), stored = hasStored(d), sn = storedN(d);
  const box = h("div", { class: "field" }, h("label", {}, compact ? `Smoothing of ${d.stem} before subtraction` : "Smoothing before subtraction"));
  const seg = h("div", { class: "seg seg-sm" });
  for (const [mode, label, title] of [
    ["smooth", "Running mean", "Smooth here with a running mean over N points"],
    ["stored", "From file", stored ? "Use the smoothing already stored in the file" : "This file carries no stored smoothing"],
    ["none", "None", "Subtract the measured values as they are"]]) {
    seg.append(h("button", { class: spec.mode === mode ? "on" : null, disabled: mode === "stored" && !stored, title,
      onclick: () => setHolderSmooth(d, { mode, n: spec.n || 5 }) }, label));
  }
  box.append(seg);
  if (spec.mode === "smooth") {
    const inp = h("input", { type: "number", min: 1, max: 51, step: 2, value: spec.n });
    const set = (n) => {
      n = Math.max(1, Math.min(51, n | 0)); if (n % 2 === 0) n += 1;
      if (n === spec.n) { inp.value = n; return; }
      setHolderSmooth(d, { mode: "smooth", n });
    };
    inp.addEventListener("change", () => set(+inp.value));
    box.append(h("div", { class: "num", style: "margin-top:8px" },
      h("button", { onclick: () => set(spec.n - 2), title: "Fewer points" }, "−"), inp,
      h("button", { onclick: () => set(spec.n + 2), title: "More points" }, "+"),
      h("span", { class: "delta", style: "margin-left:6px" }, spec.n === 5 ? "points · default" : "points")));
  }
  if (spec.mode === "none") {
    box.append(note("warn", "Not smoothed: the empty holder's measurement noise goes straight into every corrected curve."));
  } else if (spec.mode === "stored") {
    box.append(note("ok", sn > 1 ? `Using the smoothing stored in the file – a running mean of ${sn} points.` : "Using the smoothing stored in the file."));
  } else if (stored) {
    box.append(sn === spec.n ? note("ok", "Same as the smoothing stored in the file.")
      : note("info", `The file stores ${sn > 1 ? `a running mean of ${sn} points` : "a different smoothing"} – choose <i>From file</i> to use it.`));
  } else {
    box.append(note("info", "The file itself is not smoothed; it is smoothed here before it is used."));
  }
  if (compact) box.append(h("div", { class: "delta", style: "margin-top:6px" }, "Applies to every run corrected with this empty holder."));
  return box;
}

function note(kind, html) {
  const n = h("div", { class: `note ${kind}` });
  n.innerHTML = ICON[kind === "ok" ? "ok" : kind === "warn" ? "warn" : "info"] + `<div>${html}</div>`;
  return n;
}

/** Card that collapses to its heading, a status mark (green check / amber warning) and a
 *  one-line summary; the body opens on click. */
function collapsibleCard(title, status, summary, body, isOpen, setOpen) {
  const card = h("div", { class: `card collapsible${isOpen() ? " open" : ""}` });
  const head = h("button", { class: "card-head", "aria-expanded": String(isOpen()) });
  head.innerHTML = ICON.chev;
  head.append(h("span", { class: "card-title" }, title));
  const mark = h("span", { class: `card-status ${status}`, title: status === "ok" ? "Everything looks right" : "Needs a look – open for details" });
  mark.innerHTML = status === "ok" ? ICON.ok : ICON.warn;
  head.append(mark);
  head.addEventListener("click", () => {
    setOpen(!isOpen());
    card.classList.toggle("open", isOpen());
    head.setAttribute("aria-expanded", String(isOpen()));
  });
  card.append(head, h("div", { class: "card-summary" }, summary), h("div", { class: "card-body" }, body));
  return card;
}

let corrOpen = false;        // the empty-holder card starts collapsed; stays as set while the app runs

function correctionCard(r) {
  const body = document.createDocumentFragment();
  const issues = [];
  const cands = candidatesFor(r);
  const pair = dryFor(r);
  const card = (summary) => collapsibleCard("Empty-holder correction", issues.length ? "warn" : "ok", summary, body,
    () => corrOpen, (v) => { corrOpen = v; });
  if (!cands.length) {
    issues.push("none");
    body.append(note("warn", `No ${r.kind === "HT" ? "high-T (.cur)" : "low-T (.clw)"} empty-holder run found in or near this folder. ` +
      `Put it in a <code>holder</code> folder next to the data, or right-click a run › <i>Use as empty holder</i>.`));
    return card("No empty-holder run found – uncorrected");
  }
  // empty-holder picker
  const sel = h("select", {});
  const autoPick = L.pairDryRun(r.time, cands.map((c) => ({ run: c, time: c.time })), state.s.rule);
  sel.append(h("option", { value: "" }, `Automatic — ${autoPick.run.stem}`));
  const sorted = [...cands].sort((a, b) => (r.time != null && a.time != null && b.time != null ? Math.abs(a.time - r.time) - Math.abs(b.time - r.time) : 0));
  for (const c of sorted) {
    const d = r.time != null && c.time != null ? ` (${fmtDays(c.time - r.time).replace(" after", " later").replace(" before", " earlier")})` : "";
    sel.append(h("option", { value: c.main }, `${c.stem} · ${fmtDate(c.time)}${d}`));
  }
  sel.value = state.s.overrides[r.main] && cands.some((c) => c.main === state.s.overrides[r.main]) ? state.s.overrides[r.main] : "";
  sel.addEventListener("change", () => {
    if (sel.value) state.s.overrides[r.main] = sel.value; else delete state.s.overrides[r.main];
    persist(); renderViewer(); renderDryPanel();
  });
  body.append(h("div", { class: "field" }, h("label", {}, "Empty holder"), sel));

  // how the automatic choice is made -- only relevant while it is automatic
  if (pair.auto) {
    const radio = h("div", { class: "radio" });
    for (const [v, label] of [["nearest", "Nearest in time"], ["preceding", "Latest before the run"]]) {
      const inp = h("input", { type: "radio", name: "rule", value: v, checked: state.s.rule === v });
      inp.addEventListener("change", () => { saveSettings({ rule: v }); renderViewer(); renderDryPanel(); renderStatusRight(); });
      radio.append(h("label", {}, inp, label));
    }
    body.append(h("div", { class: "field" }, h("label", {}, "Automatic pairing"), radio));
  }
  body.append(holderSmoothingField(pair.dry, true));
  const spec = smoothFor(pair.dry);
  if (spec.mode === "none") issues.push("smoothing");

  const res = correctionFor(r);
  let gapShort = "date unknown";
  if (res) {
    const st = res.cin.stats;
    const gap = r.time != null && pair.dry.time != null ? pair.dry.time - r.time : null;
    if (gap != null) {
      const days = Math.round(Math.abs(gap) / DAY);
      gapShort = days === 0 ? "same day" : `${days} d ${gap > 0 ? "later" : "earlier"}`;
    }
    body.append(h("dl", { class: "kv", style: "margin-top:12px" },
      h("dt", {}, "Empty holder measured"), h("dd", {}, fmtDate(pair.dry.time)),
      h("dt", {}, ""), h("dd", { class: "delta" }, gap == null ? "run date unknown" : Math.round(Math.abs(gap) / DAY) === 0 ? "same day as the run" : `${fmtDays(gap)} the run`),
      h("dt", {}, "Empty holder T range"), h("dd", {}, `${st.holderTmin.toFixed(1)} … ${st.holderTmax.toFixed(1)} °C`),
      h("dt", {}, "Out-of-phase"), h("dd", {}, res.cout ? "corrected" : r.curveIm ? "empty holder has no _Im" : "no _Im file")));
    if (r.curveIm && !res.cout) issues.push("im");
    if (gap != null && Math.abs(gap) > 30 * DAY) {
      issues.push("gap");
      body.append(note("warn", `The empty holder was measured ${fmtDays(gap)} this run — the holder signal drifts, a closer empty-holder run would be better.`));
    }
    if (st.cold || st.warm) {
      const pts = (n) => `${n} point${n === 1 ? "" : "s"}`;
      const parts = [];
      if (st.warm) parts.push(`${pts(st.warm)} warmer than ${st.holderTmax.toFixed(1)} °C`);
      if (st.cold) parts.push(`${pts(st.cold)} colder than ${st.holderTmin.toFixed(1)} °C`);
      // a stray start/end point is normal; a stretch of the curve beyond the holder is not
      const many = st.cold + st.warm > Math.max(3, st.n * 0.02);
      if (many) issues.push("range");
      body.append(note(many ? "warn" : "info", `${parts.join(" and ")} — outside the empty holder's range. Its end value is used there (shaded in the plot).`));
    }
    const cmp = st.compare;
    if (cmp) {
      const tag = r.curve.emptyTag;
      if (cmp.mean < 0.1) {
        body.append(note("ok", `Matches the correction stored in the file (mean |Δ| ${cmp.mean.toFixed(3)}, max ${cmp.max.toFixed(2)} ×10⁻⁶ SI).`));
      } else {
        body.append(note("info", `The file carries an older correction${tag ? ` (against <code>…${esc(tag)}</code>)` : ""}, ` +
          `${cmp.mean.toFixed(2)} ×10⁻⁶ SI off on average. It is replaced by the correction against <b>${esc(pair.dry.stem)}</b>.`));
      }
    }
  }
  const smoothShort = spec.mode === "none" ? "not smoothed" : spec.mode === "stored" ? "smoothing from file" : `mean of ${spec.n}`;
  return card(`${pair.dry.stem} · ${gapShort} · ${smoothShort}${pair.auto ? "" : " · chosen by hand"}`);
}

function dryCard(r) {
  const used = samples().filter((x) => { const p = dryFor(x); return p && p.dry.id === r.id; });
  const card = h("div", { class: "card" }, h("h3", {}, h("span", { class: "grow" }, "Empty holder"), h("span", { class: "pill dry" }, r.autoDry ? "auto-detected" : "marked by you")));
  card.append(h("p", { style: "margin:0 0 10px;color:var(--text-2)" },
    `Empty ${r.kind === "HT" ? "furnace" : "cryostat"} measurement. It is smoothed (thick line) and then subtracted from ${r.kind === "HT" ? "high-T" : "low-T"} runs.`));
  card.append(holderSmoothingField(r, false));
  const list = h("div", { class: "legend-list", style: "margin-top:10px" });
  list.append(h("div", { class: "delta" }, used.length ? `Corrects ${used.length} run${used.length === 1 ? "" : "s"}:` : "Not the closest empty holder for any run in this folder."));
  for (const u of used.slice(0, 12)) list.append(h("a", { class: "link", onclick: () => select([u.id], { scroll: true }) }, u.stem));
  if (used.length > 12) list.append(h("span", { class: "delta" }, `… and ${used.length - 12} more`));
  card.append(list);
  return card;
}

function runCard(r) {
  const rows = r.curve.rows;
  const temps = rows.map((x) => x.temp);
  const k = temps.indexOf(Math.max(...temps));
  const dur = rows.length ? (rows[rows.length - 1].time - rows[0].time) / 60 : 0;
  const rate = k > 0 && rows[k].time > rows[0].time ? (temps[k] - temps[0]) / ((rows[k].time - rows[0].time) / 60) : null;
  const rec = r.record || {};
  const card = h("div", { class: "card" }, h("h3", {}, "Run"));
  const kv = h("dl", { class: "kv" },
    h("dt", {}, "Measured"), h("dd", {}, fmtDateTime(r.time)),
    h("dt", {}, "Duration"), h("dd", {}, `${dur.toFixed(0)} min`),
    h("dt", {}, "Temperature"), h("dd", {}, `${Math.min(...temps).toFixed(1)} → ${Math.max(...temps).toFixed(1)} °C`),
    h("dt", {}, r.kind === "LT" ? "Warming rate" : "Heating rate"), h("dd", {}, rate ? `${rate.toFixed(1)} °C/min` : "—"),
    h("dt", {}, "Points"), h("dd", {}, rows.length));
  if (rec.field) kv.append(h("dt", {}, "Field / freq."), h("dd", {}, `${rec.field} A/m · ${rec.freq} Hz`));
  if (rec.instrument) kv.append(h("dt", {}, "Instrument"), h("dd", {}, rec.instrument));
  if (rec.note) kv.append(h("dt", {}, "Note"), h("dd", {}, rec.note));
  card.append(kv);
  const files = h("div", { style: "margin-top:10px;display:flex;flex-direction:column;gap:3px" });
  for (const p of [r.main, r.im, r.recordPath].filter(Boolean)) {
    files.append(h("a", { class: "link path", title: "Show in Explorer", onclick: () => api.reveal(p) }, L.basename(p)));
  }
  card.append(files);
  return card;
}

function exportCard(runs) {
  const dirs = [...new Set(runs.map((r) => L.outputDir(r.dir)))];
  const card = h("div", { class: "card" }, h("h3", {}, "Export"));
  card.append(h("p", { style: "margin:0 0 8px;color:var(--text-2);font-size:12.5px" },
    "Corrected .cur/.clw (+ _Im), a CSV per run, a combined CSV and a sources note go to:"));
  for (const d of dirs) card.append(h("a", { class: "link path", style: "display:block;margin-bottom:10px", title: "Open folder", onclick: () => openOrReveal(d) }, d));
  const b1 = h("button", { class: "btn primary", onclick: () => exportRuns(runs) });
  b1.innerHTML = ICON.export + (runs.length > 1 ? `Export ${runs.length} runs` : "Export this run");
  card.append(h("div", { class: "btn-row" }, b1));
  return card;
}

function selectionCard(runs) {
  const tags = overlayLabels(runs);
  const card = h("div", { class: "card" }, h("h3", {}, `${runs.length} runs`));
  const list = h("div", { class: "legend-list" });
  runs.forEach((r) => {
    const p = r.dry ? null : dryFor(r);
    const color = r.kind === "LT" ? "var(--warm)" : "var(--heat)";
    list.append(h("div", { class: "li" },
      h("span", { class: "run-tag", style: `color:${color};border-color:${color}` }, tags.get(r.id)),
      h("a", { class: "link", onclick: () => select([r.id], { scroll: true }) }, r.stem),
      h("span", { class: "meta" }, r.dry ? "empty holder" : p ? `− ${p.dry.stem}` : "uncorrected")));
  });
  card.append(list);
  card.append(h("p", { class: "delta", style: "margin:10px 0 0" },
    "Colours show the run type (heating dark red, warming dark blue, cooling dashed blue); the tags on the curves name the file. Click a name to open it alone."));
  const frag = document.createDocumentFragment();
  frag.append(card);
  if (state.s.para && runs.some((r) => !r.dry)) frag.append(paraOverlayCard(runs));
  const exp = runs.filter((r) => !r.dry && !r.out);
  if (exp.length) frag.append(exportCard(exp));
  return frag;
}

async function openOrReveal(dir) {
  if (await api.exists(dir)) api.openPath(dir); else toast("Nothing exported there yet");
}

// ====================================================================== export
/** <spec>-<piece><run>.csv, the lab's established name for the per-run CSV */
function csvName(r) {
  const l = r.label;
  return (l.spec && l.run ? `${l.spec}-${l.piece}${l.run}` : r.stem) + ".csv";
}

function exportTargets(r) {
  const out = L.outputDir(r.dir);
  const t = [L.joinPath(out, L.basename(r.main)), L.joinPath(out, csvName(r))];
  if (r.im) t.push(L.joinPath(out, L.basename(r.im)));
  return t;
}

async function exportRuns(runs, { confirmed = false } = {}) {
  runs = runs.filter((r) => r && !r.dry && !r.out);
  if (!runs.length) return;
  if (!confirmed) {
    const outs = [...new Set(runs.map((r) => L.outputDir(r.dir)))];
    const targets = runs.flatMap(exportTargets);
    for (const o of outs) {
      const base = L.basename(o).replace(/_corr$/i, "");
      targets.push(L.joinPath(o, `${base}_corrected.csv`), L.joinPath(o, `${base}_sources.txt`));
    }
    const existing = [];
    for (const t of targets) if (await api.exists(t)) existing.push(t);
    if (existing.length) {
      const ok = await confirmDialog(
        `Replace ${existing.length} existing file${existing.length === 1 ? "" : "s"}?`,
        `The output folder${outs.length === 1 ? "" : "s"} already contain${outs.length === 1 ? "s" : ""} files with these names ` +
        `(e.g. from an earlier export). Raw data is never touched.`,
        outs, "Replace");
      if (!ok) { setStatus("Export cancelled"); return; }
    }
  }
  setStatus(h("span", {}, h("span", { class: "spinner" }), `  Exporting ${runs.length} run${runs.length === 1 ? "" : "s"}…`));
  const groups = new Map(), skipped = [];
  let files = 0;
  try {
    for (const r of runs) {
      const res = correctionFor(r);
      if (!res) { skipped.push(r.stem); continue; }
      const out = L.outputDir(r.dir);
      const dryStem = res.pair.dry.stem;
      await api.writeText(L.joinPath(out, L.basename(r.main)), L.writeCurve(r.curve, res.cin, dryStem)); files++;
      if (res.cout) { await api.writeText(L.joinPath(out, L.basename(r.im)), L.writeCurve(r.curveIm, res.cout, dryStem)); files++; }
      const csv = L.runCsv({ ...r.label, kind: r.kind }, res.cin, res.cout);
      await api.writeText(L.joinPath(out, csvName(r)), csv); files++;
      if (!groups.has(out)) groups.set(out, []);
      groups.get(out).push({ r, res, csv });
    }
    for (const [out, items] of groups) {
      // merge with runs exported earlier into the same folder, so "export one run" never drops the others
      const base = L.basename(out).replace(/_corr$/i, "");
      const allHere = samples().filter((r) => L.outputDir(r.dir) === out);
      const merged = [];
      for (const r of allHere) {
        const mine = items.find((x) => x.r.id === r.id);
        if (mine) { merged.push(mine); continue; }
        if (await api.exists(L.joinPath(out, L.basename(r.main)))) {
          const res = correctionFor(r);
          if (res) merged.push({ r, res, csv: L.runCsv({ ...r.label, kind: r.kind }, res.cin, res.cout) });
        }
      }
      merged.sort((a, b) => pieceKey(a.r) - pieceKey(b.r) || a.r.stem.localeCompare(b.r.stem, undefined, { numeric: true }));
      const header = merged[0].csv.split("\r\n")[0];
      const body = merged.map((m) => m.csv.split("\r\n").slice(1).filter(Boolean).join("\r\n"));
      await api.writeText(L.joinPath(out, `${base}_corrected.csv`), [header, ...body].join("\r\n") + "\r\n"); files++;
      await api.writeText(L.joinPath(out, `${base}_sources.txt`), sourcesText(base, merged)); files++;
    }
    const outs = [...groups.keys()];
    setStatus(`Exported ${runs.length - skipped.length} run(s), ${files} files`);
    toast(`Exported ${runs.length - skipped.length} run${runs.length - skipped.length === 1 ? "" : "s"} → ${outs.length === 1 ? L.basename(outs[0]) : `${outs.length} folders`}` +
      (skipped.length ? ` · ${skipped.length} skipped (no empty holder)` : ""),
      outs.length ? { label: "Open folder", run: () => api.openPath(outs[0]) } : null);
  } catch (err) {
    console.error(err);
    setStatus("Export failed");
    toast(`Export failed: ${err.message || err}`);
  }
}

function pieceKey(r) { const m = /^(\d+)/.exec(r.label.piece || ""); return m ? +m[1] : 9999; }

function confirmDialog(title, body, paths, okLabel) {
  return new Promise((resolve) => {
    const done = (v) => { wrap.remove(); removeEventListener("keydown", key, true); resolve(v); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } if (e.key === "Enter") { e.stopPropagation(); done(true); } };
    const ok = h("button", { class: "btn primary", onclick: () => done(true) }, okLabel);
    const wrap = h("div", { class: "modal-wrap", onclick: (e) => e.target === wrap && done(false) },
      h("div", { class: "modal", role: "dialog" },
        h("h3", {}, title), h("p", {}, body),
        h("div", { class: "modal-paths" }, paths.map((p) => h("div", { class: "path" }, p))),
        h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), ok)));
    document.body.append(wrap);
    addEventListener("keydown", key, true);
    ok.focus();
  });
}

function sourcesText(base, items) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [
    `${base} - empty-holder correction (TX Studio, ${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
    `pairing: ${state.s.rule === "nearest" ? "nearest in time" : "latest before the run"}`,
    `CSUSC = TSUSC - smoothed empty holder at the same temperature (heating / cooling branches separate); NSUSC = CSUSC / max(CSUSC)`,
    "-".repeat(126),
    pad("run", 26) + pad("empty holder", 22) + pad("smoothing", 16) + pad("run date", 12) + pad("holder date", 12) + pad("gap", 8) + pad("Im", 5) + "notes",
  ];
  for (const { r, res } of items) {
    const st = res.cin.stats, d = res.pair.dry;
    const gap = r.time != null && d.time != null ? `${Math.round((d.time - r.time) / DAY)}d` : "?";
    const notes = [];
    if (!res.pair.auto) notes.push("empty holder chosen by hand");
    if (st.cold || st.warm) notes.push(`${st.cold + st.warm} pts outside empty-holder T range (${st.cold} cold, ${st.warm} warm), held`);
    if (st.compare) notes.push(st.compare.mean < 0.1 ? `matches stored correction (${st.compare.mean.toFixed(3)} mean)` : `replaces stored correction (off by ${st.compare.mean.toFixed(2)} mean)`);
    const sp = res.spec || smoothFor(d);
    const smooth = sp.mode === "none" ? "none" : sp.mode === "stored" ? (storedN(d) > 1 ? `file (mean ${storedN(d)})` : "file") : `mean ${sp.n}`;
    lines.push(pad(r.stem, 26) + pad(d.stem, 22) + pad(smooth, 16) + pad(isoDate(r.time), 12) + pad(isoDate(d.time), 12) + pad(gap, 8) + pad(res.cout ? "yes" : "-", 5) + notes.join("; "));
  }
  return lines.join("\r\n") + "\r\n";
}

async function exportPng() {
  const runs = state.selected.map((id) => state.runs.get(id)).filter(Boolean);
  if (!runs.length) return;
  const light = { text: "#1c2027", text2: "#5b6370", text3: "#8a919c", line: "#e3e6ea", line2: "#c9ced6", bg: "#ffffff", heat: "#9f1d22", warm: "#1e3a8a", cool: "#2b8cee", para: "#7c3aed", warnSoft: "#fff4e0", zero: "#1c2027", model: "#0f766e" };
  const fig = drawPlot(runs, light);
  const name = (runs.length === 1 ? runs[0].stem : `${runs[0].stem}+${runs.length - 1}`) + `_${state.s.view}.png`;
  const target = await api.saveDialog({ title: "Save plot", defaultPath: L.joinPath(L.outputDir(runs[0].dir), name), filters: [{ name: "PNG image", extensions: ["png"] }] });
  if (!target) return;
  const url = await Plotly.toImage(fig, { format: "png", width: 1500, height: 950, scale: 2 });
  await api.writeBase64(target, url.split(",")[1]);
  toast(`Saved ${L.basename(target)}`, { label: "Show", run: () => api.reveal(target) });
}

// ====================================================================== chrome
function setStatus(x) { const s = $("#status"); s.innerHTML = ""; s.append(x); }
function renderStatusRight() {
  const n = samples().length;
  $("#statusRight").textContent = state.root
    ? `${n} run${n === 1 ? "" : "s"} · ${state.dry.length} empty holder${state.dry.length === 1 ? "" : "s"} · ${state.s.rule === "nearest" ? "nearest empty holder" : "latest empty holder before the run"}`
    : "";
}
let toastTimer = null;
function toast(msg, action) {
  const t = $("#toast");
  t.innerHTML = "";
  t.append(h("span", {}, msg));
  if (action) t.append(h("a", { class: "link", onclick: () => { action.run(); t.classList.add("hidden"); } }, action.label));
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), action ? 7000 : 4000);
}

function applyTheme() {
  const t = state.s.theme;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#btnTheme").innerHTML = t === "system" ? ICON.auto : t === "dark" ? ICON.moon : ICON.sun;
  $("#btnTheme").title = `Theme: ${t} (click to change)`;
  api.setTheme(t);
  if (state.selected.length) renderViewer();
}

/** In-phase / out-of-phase / both, keeping the temperature zoom. */
function setComp(c) {
  const runs = state.selected.map((id) => state.runs.get(id)).filter(Boolean);
  if (c !== "in" && !runs.some((r) => r.curveIm)) { toast("No out-of-phase (_Im) data for this run"); return; }
  keepXZoom(() => { saveSettings({ comp: c }); renderViewer(); });
}

async function pickAndOpen() {
  const p = await api.pickFolder(state.root || undefined);
  if (p) openFolder(p);
}

function moveSelection(delta, extend) {
  if (!state.visible.length) return;
  const cur = state.visible.indexOf(state.anchor);
  const next = Math.max(0, Math.min(state.visible.length - 1, cur < 0 ? 0 : cur + delta));
  const id = state.visible[next];
  if (extend) {
    const s = new Set(state.selected); s.add(id); state.anchor = id;
    select([...s], { scroll: true, keepAnchor: true });
  } else select([id], { scroll: true });
}

// ====================================================================== wiring
function wire() {
  $("#btnOpen").onclick = pickAndOpen;
  $("#btnOpenBig").onclick = pickAndOpen;
  $("#btnRefresh").onclick = () => state.root && openFolder(state.root, { quiet: true });
  $("#btnExportAll").onclick = () => exportRuns(samples());
  $("#crumb").onclick = () => state.root && api.openPath(state.root);
  $("#btnTheme").onclick = () => { saveSettings({ theme: { system: "light", light: "dark", dark: "system" }[state.s.theme] || "system" }); applyTheme(); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.s.theme === "system" && applyTheme());
  $("#btnPng").onclick = exportPng;
  wirePlotMouse();
  wireCrosshair();
  $("#search").addEventListener("input", debounce(renderTree, 120));
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; renderTree(); }
    if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); $("#tree").focus(); if (state.visible.length) select([state.visible[0]], { scroll: true }); }
  });

  $("#btnFilter").onclick = (e) => { e.stopPropagation(); $("#filterPop").classList.toggle("hidden"); $("#btnFilter").classList.toggle("on"); };
  document.addEventListener("click", (e) => {
    if (!$("#filterPop").contains(e.target) && e.target !== $("#btnFilter")) { $("#filterPop").classList.add("hidden"); $("#btnFilter").classList.remove("on"); }
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });
  for (const [id, key] of [["#optOnlyCurves", "onlyCurves"], ["#optShowCorr", "showCorr"], ["#optShowIm", "showIm"]]) {
    $(id).checked = !!state.s[key];
    $(id).onchange = (e) => { saveSettings({ [key]: e.target.checked }); renderTree(); };
  }
  $("#dryHead").onclick = () => { saveSettings({ dryOpen: !state.s.dryOpen }); $("#dryPanel").classList.toggle("open", state.s.dryOpen); };

  $("#segView").onclick = (e) => { const b = e.target.closest("button"); if (b && !b.disabled) keepXZoom(() => { saveSettings({ view: b.dataset.v }); renderViewer(); }); };
  $("#segComp").onclick = (e) => { const b = e.target.closest("button"); if (b && !b.disabled) setComp(b.dataset.c); };
  $(".chips").onclick = (e) => { const b = e.target.closest(".chip"); if (b) { saveSettings({ [b.dataset.t]: !state.s[b.dataset.t] }); renderViewer(); } };

  // keyboard
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.id !== "tree";
    if (e.key === "Escape") {
      if (menuEl) { closeMenu(); return; }
      if (!typing && !$("#viewer").classList.contains("hidden")) { e.preventDefault(); resetZoom(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); pickAndOpen(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("#search").focus(); $("#search").select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
      e.preventDefault();
      exportRuns(e.shiftKey ? samples() : state.selected.map((id) => state.runs.get(id)));
      return;
    }
    if (e.key === "F5") { e.preventDefault(); if (state.root) openFolder(state.root, { quiet: true }); return; }
    if (typing) return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveSelection(1, e.shiftKey); }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); moveSelection(-1, e.shiftKey); }
    if (e.key === "a" && (e.ctrlKey || e.metaKey) && document.activeElement.id === "tree") { e.preventDefault(); select(state.visible.slice()); }
    if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.metaKey && !e.altKey && state.selected.length) {
      e.preventDefault();
      setComp(e.shiftKey ? "both" : state.s.comp === "in" ? "out" : "in");
    }
  });

  // sidebar splitter
  const sp = $("#splitter");
  sp.addEventListener("mousedown", (e) => {
    e.preventDefault(); sp.classList.add("drag");
    const move = (ev) => { const w = Math.max(220, Math.min(560, ev.clientX)); document.documentElement.style.setProperty("--side-w", w + "px"); state.s.sideW = w; };
    const up = () => { sp.classList.remove("drag"); removeEventListener("mousemove", move); removeEventListener("mouseup", up); persist(); };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  });
  new ResizeObserver(debounce(() => { if (!$("#viewer").classList.contains("hidden")) Promise.resolve(Plotly.Plots.resize("plot")).then(updateJumpers); }, 60)).observe($(".plot-wrap"));

  // drag & drop a folder (or a .cur/.clw file) onto the window
  let dragDepth = 0;
  addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#dropOverlay").classList.remove("hidden"); });
  addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").classList.add("hidden"); } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", async (e) => {
    e.preventDefault(); dragDepth = 0; $("#dropOverlay").classList.add("hidden");
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = await api.pathForFile(f);
    if (!p) return;
    if (L.isCurveFile(p)) {
      await openFolder(L.dirname(p));
      const id = runIdFor(p);
      if (state.runs.has(id)) select([id], { scroll: true });
    } else openFolder(p);
  });

  // unsaved notes go to disk when the window loses focus or closes
  addEventListener("blur", flushNotes);
  addEventListener("beforeunload", flushNotes);
  api.onFsChanged(debounce(() => { if (state.root && !state.loading) openFolder(state.root, { quiet: true }); }, 400));
}

(async function init() {
  const saved = await api.getSettings();
  state.s = { ...DEFAULTS, ...saved };
  for (const k of ["overrides", "dryOverrides", "holderSmooth", "paraPick", "modelProps", "modelY", "expanded", "lastSel"]) state.s[k] = { ...(saved[k] || {}) };
  document.documentElement.style.setProperty("--side-w", (state.s.sideW || 300) + "px");
  if (api.nativeFrame) document.documentElement.classList.add("native-frame");
  wire();
  applyTheme();
  renderViewer();
  const start = await api.startupPath();
  if (start && L.isCurveFile(start)) {
    await openFolder(L.dirname(start));
    if (state.runs.has(L.runId(start))) select([L.runId(start)], { scroll: true });
  } else if (start) openFolder(start);
  else if (state.s.lastRoot && (await api.exists(state.s.lastRoot))) openFolder(state.s.lastRoot);
})();
