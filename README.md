# TX Studio

A desktop viewer for thermomagnetic (temperature–susceptibility, "TX") runs measured on
KLY5 / MFK Kappabridges with a furnace or cryostat: browse a folder of `.cur` / `.clw`
runs, look at the curves, and correct every run for the empty holder (dry run)
automatically.

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
* **Transitions** (Po, Mag, Hem / T<sub>V</sub>, T<sub>M</sub>) sit as small labels above the
  plot; click one to zoom onto the data at that temperature (its line flashes yellow).
* **Overlays** keep the run-type colours; every curve gets a small tag in its own colour
  naming the file by the part between specimen ID and run code (`ER26PB012-30SH1` → `30S`).
  Tags are made unique only where needed (`27 L1` / `27 L2`, `002 · 31` / `012 · 31`).
* **Export** (`Ctrl+E` this run, `Ctrl+Shift+E` / *Export all*) writes the corrected files.

File names are expected to start with the specimen ID and end with the run code
(`H1`, `L1`, `L2`, …), e.g. `ER26PB002-27H1.cur`, `ER26PB002-27L1.clw`.

### The three parts

**Sidebar.** The folder tree, reduced to thermomagnetic runs (`.cur` = high-T furnace,
`.clw` = low-T cryostat). An `_Im` (out-of-phase) file is merged into its run (`Im` badge),
the instrument record (`.KHT`/`.KLT`) supplies the date. Single-child folders are compacted
(`ER26PB002_TX / ER26PB002_TX_raw`), exported `_corr` folders are hidden (filter menu).
Files stay in alphabetical order; runs of the same piece (`27H1`, `27L1`, `27L2`) share a
faint background band, alternating per group like Finder's row stripes.
The **Dry runs** panel at the bottom lists every empty-holder run that was found.

**Curve viewer.** Corrected χ(T), *Raw vs dry run* (what is being subtracted),
normalised, and 1/χ. In-phase, out-of-phase, or both (out-of-phase on the right axis).
Toggles for points and transition lines, and an overlay of a correction already stored in
the file. *PNG* saves a white-background figure. Temperatures outside the dry run's range
are shaded.

**Automatic dry-run correction.** No manual "smooth the empty curve, open it, subtract":

1. Dry runs are recognised by the instrument record (`Note = EMPTY`), by name
   (`*HOTSTUFF*`, `*FREEZ*`, `*FROSTY*`, `empty`, `dry run`), or by sitting in a `*holder*`
   folder. The opened folder *and up to three levels above it* are searched, so opening a
   single specimen still finds `holder_corrections/`. Right-click any run to mark/unmark it.
2. Each run is paired with the dry run of the same kind measured **nearest in time**
   (or the latest one before it). Override per run in the inspector.
3. The dry run is smoothed and subtracted (below).

**Export** writes, next to the raw folder (`X_raw/` → `X_corr/`, otherwise
`<folder>/<folder>_corr/`): corrected `.cur`/`.clw` (+ `_Im`) in the original format,
a CSV per run (`piece, run, mode, temp_C, time_s, segment, chi_in_1e6SI, chi_in_norm,
chi_out_1e6SI, chi_raw_1e6SI, holder_1e6SI`), a combined CSV and a `_sources.txt` noting
which dry run corrected what. The app asks before replacing existing files, and refuses
to write anywhere but a `*_corr` folder, so raw data can't be overwritten.

## The correction

* **Smoothing** — the dry run's TSUSC is smoothed with a centred *running mean* over N
  points (default 5, adjustable), the first/last N/2 points copied from the nearest full
  window, rounded to 0.01.
* **Subtraction** — sample and dry run are split into heating / cooling at their
  temperature maximum. For each sample point the smoothed dry run is looked up on the
  same branch: below the branch's first point or beyond its last point the end value is
  used, otherwise the *first pair in measurement order* that brackets the temperature
  (rising pairs when heating, falling when cooling) is interpolated linearly, in single
  precision. `CSUSC = TSUSC − that value`.
* **Normalisation** — `NSUSC = CSUSC / max(CSUSC)` (signed maximum).
* The written `.cur`/`.clw` keeps every other column as it was, zeroes BULKS (it derives
  from the old CSUSC) and puts the dry run's name in the header's EMPTY field.

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
