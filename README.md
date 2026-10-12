# TX Studio

A desktop viewer for thermomagnetic (temperature–susceptibility, "TX") runs measured on
KLY5 / MFK Kappabridges with a furnace or cryostat: browse a folder of `.cur` / `.clw`
runs, look at the curves, and correct every run for the empty holder automatically.

## Install on a Windows PC

1. Download **[TX-Studio-win32-x64.zip](https://github.com/egorsann/TX-studio/releases/latest/download/TX-Studio-win32-x64.zip)**
   (or pick a version under [Releases](https://github.com/egorsann/TX-studio/releases)).
2. Unzip it (right-click → *Extract All…*).
3. Double-click **`Install TX Studio.cmd`** in the unzipped folder.

That's it: TX Studio is copied to `%LOCALAPPDATA%\Programs\TX Studio`, gets a
**TX Studio** shortcut in the Start Menu and on the Desktop, and starts. No admin rights.

* Needs **Windows 10 or 11, 64-bit** — nothing else (no Node.js or Python).
* If Windows shows *"Windows protected your PC"*: **More info → Run anyway** (the app
  isn't code-signed). Happens once.
* **Update:** download the newer zip and run `Install TX Studio.cmd` again.
* **Uninstall:** `Uninstall TX Studio.cmd` in `%LOCALAPPDATA%\Programs\TX Studio`.
* Don't want to install? Double-click `TX Studio.exe` in the unzipped folder instead.
* Settings (last folder, choices) are kept per user in `%APPDATA%\TX Studio`.

## Using it

* Open a folder (button, `Ctrl+O`, or drop a folder / a `.cur` file on the window).
  The last folder is reopened next time.
* Pick runs in the sidebar; ↑/↓ flips through them, Ctrl/Shift-click overlays several.
* **Plot:** right-drag = zoom box (a flat box zooms temperature only, a narrow one χ only),
  left- or middle-drag = pan, mouse wheel = zoom, double-click or Esc = full curve.
  Heating is dark red, low-T warming dark blue, cooling a dashed brighter blue.
* **Paramagnetic** toggle: the Curie–Weiss curve a purely paramagnetic sample would follow
  (see below).
* **Transitions** (Po, Mag, Hem / T<sub>V</sub>, T<sub>M</sub>) sit as small labels above the
  plot; click one to zoom onto the data at that temperature (its line flashes yellow).
* **Overlays** keep the run-type colours; every curve gets a small tag in its own colour
  naming the file by the part between specimen ID and run code (`AB24CD112-30SH1` → `30S`).
  Tags are made unique only where needed (`27 L1` / `27 L2`, `101 · 31` / `112 · 31`).
* **Export** (`Ctrl+E` this run, `Ctrl+Shift+E` / *Export all*) writes the corrected files.

File names are expected to start with the specimen ID and end with the run code
(`H1`, `L1`, `L2`, …), e.g. `AB24CD101-27H1.cur`, `AB24CD101-27L1.clw`.

### The three parts

**Sidebar.** The folder tree, reduced to thermomagnetic runs (`.cur` = high-T furnace,
`.clw` = low-T cryostat). An `_Im` (out-of-phase) file is merged into its run (`Im` badge),
the instrument record (`.KHT`/`.KLT`) supplies the date. Single-child folders are compacted
(`AB24CD101_TX / AB24CD101_TX_raw`), exported `_corr` folders are hidden (filter menu).
Files stay in alphabetical order; runs of the same piece (`27H1`, `27L1`, `27L2`) share a
faint background band, alternating per group like Finder's row stripes.
The **Empty holders** panel at the bottom lists every empty-holder run that was found.

**Curve viewer.** Corrected χ(T), *Raw vs empty holder* (what is being subtracted),
normalised, and 1/χ. In-phase, out-of-phase, or both (out-of-phase on the right axis).
Toggles for points and transition lines, and an overlay of a correction already stored in
the file. *PNG* saves a white-background figure. Temperatures outside the empty holder's
range are shaded.

**Automatic empty-holder correction.** No manual "smooth the empty curve, open it, subtract":

1. Empty-holder runs are recognised by the instrument record (`Note = EMPTY`), by name
   (`*HOTSTUFF*`, `*FREEZ*`, `*FROSTY*`, `empty`, `dry run`), or by sitting in a `*holder*`
   folder. The opened folder *and up to three levels above it* are searched, so opening a
   single specimen still finds `holder_corrections/`. Right-click any run to mark/unmark it.
2. Each run is paired with the empty-holder run of the same kind measured **nearest in time**
   (or the latest one before it). Override per run in the inspector.
3. The empty holder is smoothed and subtracted (below).

**Export** writes, next to the raw folder (`X_raw/` → `X_corr/`, otherwise
`<folder>/<folder>_corr/`): corrected `.cur`/`.clw` (+ `_Im`) in the original format,
a CSV per run (`piece, run, mode, temp_C, time_s, segment, chi_in_1e6SI, chi_in_norm,
chi_out_1e6SI, chi_raw_1e6SI, holder_1e6SI`), a combined CSV and a `_sources.txt` noting
which empty holder (and smoothing) corrected what. The app asks before replacing existing files, and refuses
to write anywhere but a `*_corr` folder, so raw data can't be overwritten.

## The correction

* **Smoothing** — before it is used, each empty holder is smoothed; select it to choose how:
  a centred *running mean* over N points (default 5; the first/last N/2 points copied from
  the nearest full window, rounded to 0.01), *From file* (the smoothing already stored in
  the file's CSUSC column — the default when the file has one), or *None* (warned against).
  The plot previews it, the choice is remembered per empty-holder file and applies to every
  run corrected with it; the same control sits on each run's correction card.
* **Subtraction** — sample and empty holder are split into heating / cooling at their
  temperature maximum. For each sample point the smoothed empty holder is looked up on the
  same branch: below the branch's first point or beyond its last point the end value is
  used, otherwise the *first pair in measurement order* that brackets the temperature
  (rising pairs when heating, falling when cooling) is interpolated linearly, in single
  precision. `CSUSC = TSUSC − that value`.
* **Normalisation** — `NSUSC = CSUSC / max(CSUSC)` (signed maximum).
* The written `.cur`/`.clw` keeps every other column as it was, zeroes BULKS (it derives
  from the old CSUSC) and puts the empty holder's name in the header's EMPTY field.

## Paramagnetic reference

The *Paramagnetic* toggle draws the Curie–Weiss curve χ = C / (T − θ) (T in kelvin) that a
purely paramagnetic sample would follow, scaled to the corrected χ nearest 25 °C on the
heating / warming branch (θ adjustable, default 0 K = Curie law). In the 1/χ view it is a
straight line. Samples without magnetite or other ferromagnetic phases follow it; the
inspector reports the largest departure (ignoring the first 8 °C of start-up transient).

## Development

Needs Node.js 22+.

```
npm install
npm start               # run from source (or double-click "TX Studio.cmd")
npm test                # parser / smoothing / pairing / correction tests
npm run pack            # dist\TX-Studio-win32-x64.zip with installer
```

Real-data tests run when `TX_TEST_DATA` (or a one-line `test/data-path.local`) points at a
folder with `holder_corrections/` and `<SPEC>_TX/<SPEC>_TX_raw/` runs.

`src/lib/curlib.js` holds all file handling and correction maths (no Electron
dependency); `src/app.js` is the UI; `main.js` the window and file access;
`scripts/` the packaging and installer.

To publish a new version: bump `version` in `package.json`, `npm run pack`, then
`gh release create vX.Y.Z dist/TX-Studio-win32-x64.zip`.

## License

MIT
