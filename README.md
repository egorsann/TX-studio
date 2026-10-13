# TX Studio

A desktop viewer for thermomagnetic (temperature–susceptibility, "TX") runs measured on
KLY5 / MFK Kappabridges with a furnace or cryostat: browse a folder of `.cur` / `.clw`
runs, look at the curves, and correct every run for the empty holder automatically.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img src="docs/screenshots/overview-light.png" alt="TX Studio: folder sidebar, a corrected heating / cooling run with transition labels, and the empty-holder correction card">
</picture>

## Install on a Windows PC

1. Download **[TX-Studio-win32-x64.zip](https://github.com/egorsann/TX-studio/releases/latest/download/TX-Studio-win32-x64.zip)**
   (under 1 MB; or pick a version under [Releases](https://github.com/egorsann/TX-studio/releases)).
2. Unzip it (right-click → *Extract All…*).
3. Double-click **`Install TX Studio.cmd`** in the unzipped folder.

That's it: TX Studio is copied to `%LOCALAPPDATA%\Programs\TX Studio`, gets a
**TX Studio** shortcut in the Start Menu and on the Desktop, and starts. No admin rights.

* Needs **Windows 10 or 11, 64-bit** — nothing else. The app shows its window through the
  Microsoft Edge WebView2 runtime that is part of Windows 11 and current Windows 10 (if a PC
  lacks it, the app offers the download).
* If Windows shows *"Windows protected your PC"*: **More info → Run anyway** (the app
  isn't code-signed). Happens once.
* **Update:** download the newer zip and run `Install TX Studio.cmd` again.
* **Uninstall:** `Uninstall TX Studio.cmd` in `%LOCALAPPDATA%\Programs\TX Studio`.
* Don't want to install? Double-click `TX Studio.exe` in the unzipped folder instead.
* Settings (last folder, choices) are kept per user in `%APPDATA%\TX Studio`.

## Features

### Folder view

<img src="docs/screenshots/sidebar.png" align="right" width="270" alt="Sidebar: runs grouped per specimen piece, empty holders panel">

Open a folder (button, `Ctrl+O`, or drop a folder / a `.cur` file on the window) and the
sidebar shows its thermomagnetic runs — `HT` = high-T furnace (`.cur`), `LT` = low-T
cryostat (`.clw`) — with the measurement date from the instrument record (`.KHT`/`.KLT`).

* An `_Im` (out-of-phase) file is merged into its run (`Im` badge).
* Files stay in alphabetical order; the runs of one piece (`27H1`, `27L1`, `27L2`) share a
  faint background band, like Finder's row stripes.
* The folder that holds the runs is bold; single-child folders are compacted
  (`AB24CD101_TX / AB24CD101_TX_raw`); exported `_corr` folders are hidden (filter menu).
* ↑/↓ flips through runs, Ctrl/Shift-click overlays several, type to filter.
* The **Empty holders** panel lists every empty-holder run found, how many runs each
  corrects, and the last folder is reopened next time.

File names are expected to start with the specimen ID and end with the run code
(`H1`, `L1`, `L2`, …), e.g. `AB24CD101-27H1.cur`.

<br clear="right">

### Automatic empty-holder correction

![Raw run, the empty holder that is subtracted from it, and the expanded correction card](docs/screenshots/empty-holder-correction.png)

No manual "smooth the empty curve, open it, subtract":

1. Empty-holder runs are recognised by the instrument record (`Note = EMPTY`), by name
   (`*HOTSTUFF*`, `*FREEZ*`, `*FROSTY*`, `empty`, `dry run`), or by sitting in a `*holder*`
   folder. The opened folder *and up to three levels above it* are searched, so opening a
   single specimen still finds `holder_corrections/`. Right-click any run to mark/unmark it.
2. Each run is paired with the empty-holder run of the same kind measured **nearest in time**
   (or the latest one before it), or one you pick.
3. The empty holder is smoothed and subtracted (see *The correction* below). *Raw vs empty
   holder* shows what is subtracted.

The correction card stays collapsed to one line — holder · time gap · smoothing — with a
green check, or an amber mark when something needs a look (no holder, holder more than
30 days away, many points outside its temperature range, no smoothing).

![Empty-holder run with the smoothing choice: running mean, from file, or none](docs/screenshots/empty-holder-smoothing.png)

Select an empty-holder run to choose how it is smoothed before it is used: a **running
mean** over N points, the smoothing already stored in the file (**From file**), or
**None**. The plot previews it; the choice applies to every run corrected with that holder.

### Transition labels: click to zoom

![Clicking "Mag" zooms onto the 580 °C magnetite Curie point and flashes its line yellow](docs/screenshots/transition-zoom.png)

Po, Mag, Hem (pyrrhotite, magnetite, hematite) for high-T runs and T<sub>V</sub>, T<sub>M</sub>
(Verwey, Morin) for low-T runs sit as small labels above the plot. Click one to zoom onto the
data at that temperature — its line flashes yellow; double-click or Esc returns to the full curve.

**Mouse:** right-drag = zoom box (a flat box zooms temperature only, a narrow one χ only),
left- or middle-drag = pan, wheel = zoom. Views: corrected, raw vs empty holder,
normalised, 1/χ — in-phase, out-of-phase or both. Heating is dark red, low-T warming dark
blue, cooling a dashed brighter blue. *PNG* saves a white-background figure.

### Overlays

![Four high-T runs overlaid, each curve tagged with its piece](docs/screenshots/overlay-tags.png)

Overlaid runs keep the run-type colours; every curve gets a small tag in its own colour
naming the file by the part between specimen ID and run code (`AB24CD112-30SH1` → `30S`),
made unique only where needed (`27 L1` / `27 L2`, `101 · 31` / `112 · 31`).

### Paramagnetic reference

![Low-T run with the Curie–Weiss reference curve and the inspector's verdict](docs/screenshots/paramagnetic.png)

The *Paramagnetic* toggle draws the Curie–Weiss curve χ = C / (T − θ) (T in kelvin) that a
purely paramagnetic sample would follow, scaled to the corrected χ nearest 25 °C
(θ adjustable, default 0 K = Curie law; a straight line in the 1/χ view). Samples without
magnetite or other ferromagnetic phases follow it; the inspector reports the largest
departure. In overlays each run has its own curve, labelled with its tag.

### Export

`Ctrl+E` (this run), `Ctrl+Shift+E` / *Export all* write, next to the raw folder
(`X_raw/` → `X_corr/`, otherwise `<folder>/<folder>_corr/`): corrected `.cur`/`.clw`
(+ `_Im`) in the original format, a CSV per run (`piece, run, mode, temp_C, time_s, segment,
chi_in_1e6SI, chi_in_norm, chi_out_1e6SI, chi_raw_1e6SI, holder_1e6SI`), a combined CSV and
a `_sources.txt` noting which empty holder (and smoothing) corrected what. The app asks
before replacing existing files and refuses to write anywhere but a `*_corr` folder, so
raw data can't be overwritten.

## The correction

* **Smoothing** — a centred *running mean* over N points (default 5; the first/last N/2
  points copied from the nearest full window, rounded to 0.01), the smoothing stored in the
  file's CSUSC column (the default when the file has one), or none (warned against).
* **Subtraction** — sample and empty holder are split into heating / cooling at their
  temperature maximum. For each sample point the smoothed empty holder is looked up on the
  same branch: below the branch's first point or beyond its last point the end value is
  used, otherwise the *first pair in measurement order* that brackets the temperature
  (rising pairs when heating, falling when cooling) is interpolated linearly, in single
  precision. `CSUSC = TSUSC − that value`.
* **Normalisation** — `NSUSC = CSUSC / max(CSUSC)` (signed maximum).
* The written `.cur`/`.clw` keeps every other column as it was, zeroes BULKS (it derives
  from the old CSUSC) and puts the empty holder's name in the header's EMPTY field.

## Development

Needs Node.js 22+ on Windows.

```
npm install
npm run host            # build the Windows app and run it on the source tree
npm test                # parser / smoothing / pairing / correction tests
npm run pack            # dist\TX-Studio-win32-x64.zip with installer
npm start               # alternative: run the UI in Electron (development only)
node test/check_run.js <folder> <specimen prefix>   # corrections of one specimen vs stored / earlier CSVs
```

The app is a ~40 KB Windows host (`host/TXStudio.cs`) that shows the web UI (`src/`) in the
system's WebView2 runtime. It is compiled with the C# compiler that ships with .NET
Framework 4.8 — no SDK to install; the three WebView2 SDK DLLs are fetched from NuGet
(hash-checked) on the first build. `src/host-bridge.js` gives the UI file access, dialogs
and settings through the host; Electron's `main.js` / `preload.js` do the same for `npm start`.

Real-data tests run when `TX_TEST_DATA` (or a one-line `test/data-path.local`) points at a
folder with `holder_corrections/` and `<SPEC>_TX/<SPEC>_TX_raw/` runs.

`src/lib/curlib.js` holds all file handling and correction maths; `src/app.js` is the UI;
`scripts/` the build, packaging and installer. Screenshots in `docs/screenshots` use made-up
specimen IDs.

To publish a new version: bump `version` in `package.json`, `npm run pack`, then
`gh release create vX.Y.Z dist/TX-Studio-win32-x64.zip`.

## License

MIT
