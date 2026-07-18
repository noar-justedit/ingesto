# ingesto
### Professional Camera Media Ingest — by Just Edit

Free, open-source ingest tool for video/audio professionals (DITs, editors) —
copy footage off cards and drives with verified integrity, camera auto-detection,
checksum lists, MHL manifests, and a kiosk mode for on-set use.

Licensed under the **GNU General Public License v3.0** (see [`LICENSE`](./LICENSE)).
You're free to use, study, modify, and redistribute this software, as long as any
distributed modified version stays under the same license and its source is made
available. See the license file for the full terms.

---

## Quick install (no coding knowledge required)

### Step 1 — Install Node.js
1. Open your browser and go to **https://nodejs.org**
2. Click the green **"LTS"** button (recommended version)
3. Download and install the `.pkg` file
4. Follow the installer (click "Continue" through to the end)

### Step 2 — Download ingesto
Clone or download this repository (`Code` → `Download ZIP`, or
`git clone https://github.com/noar-justedit/ingesto.git`), and unzip it
wherever you like (e.g. your Desktop or `~/Documents`).

### Step 3 — Build the app
1. Open the `ingesto/scripts/` folder
2. **Double-click `build-mac.sh`**
   - If macOS asks for confirmation, click **"Open"**
   - A Terminal window opens and builds everything automatically
   - The first run takes 2-3 minutes (downloading dependencies)
3. When it's done, the script offers to open the `dist/` folder

For Windows, use `scripts/build-win-from-mac.sh` (cross-build from a Mac) —
the resulting installer is unsigned, so Windows will show a SmartScreen warning
on first launch (expected; click "More info" → "Run anyway").

### Step 4 — Install the app
1. In the `dist/` folder, open the `.dmg` file
2. Drag **ingesto** into your **Applications** folder
3. **First launch**: right-click the app → **"Open"**
   (macOS will otherwise block it, since it isn't signed through the App Store)

---

## Test without building (dev mode)

If you just want to try it before building:
1. Install Node.js (see Step 1)
2. Double-click `scripts/dev.sh`

---

## Using the app

### Interface
- **Center column**: mounted volumes (SD cards, drives, etc.), each with a type
  icon (removable card, system disk, network, external) and an SRC/DST badge
  once assigned
- **Filters** (column header): hide System and/or Network volumes, or manually
  hide a given volume (right-click → Hide Volume)
- **↻ Refresh**: refresh the volume list

### Typical workflow
1. **Connect** your source cards / drives
2. **Drag** a source volume into the **Sources** zone (left)
   — or right-click a volume → **Set as SOURCE**
3. **Drag** one or more destination drives into the **Destinations** zone (right)
4. Enter the **operator**, **camera model**, and notes if needed
5. Choose a **copy mode**:
   - **FAST**: copy only, no checks
   - **VERIFIED**: detects incomplete copies (size)
   - **SECURE**: detects any data corruption (xxHash64)
   - **PRO**: Secure + checksum lists, MHL export, optional double source read
6. Configure the **folder name** using the variables (drag to reorder them)
7. Click **START INGEST**

### During the copy
- Progress ring + real-time throughput bar
- Remaining files, ETA, speed, errors — all live
- **Cancel** to stop cleanly

### When it's done
A complete summary is shown (files copied, verified, any errors), with a sound
notification and an exportable HTML/CSV/JSON report depending on your settings.

### Verifying a folder later
The **Verify** button (book icon) lets you re-check a folder that was already
ingested, by reading back its checksum list or MHL manifest, without copying
anything again.

---

## Folder name variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{counter}` | Auto-incrementing counter | `001`, `002`… |
| `{cardname}` | Source volume name | `A001` |
| `{cameraman}` | Operator name entered | `JohnDoe` |
| `{camera}` | Camera model entered/detected | `SonyFX3` |
| `{YY}` | Short year | `26` |
| `{MM}` | Month | `04` |
| `{DD}` | Day | `29` |
| `{HH}` | Hour | `14` |
| `{MIN}` | Minutes | `35` |

**Example**: `001_A001_JohnDoe_SonyFX3_260429_1435`

---

## Project structure

```
ingesto/
├── src/
│   ├── main/
│   │   ├── main.js            — Electron main process (copy engine, volumes, IPC…)
│   │   ├── camera-detect.js   — Camera brand/model detection from card structure
│   │   ├── sentinel.js        — Card tracking (.ingesto.json), off by default
│   │   └── preload.js         — Secure bridge between main and renderer
│   └── renderer/
│       └── index.html         — Full user interface (HTML+CSS+JS)
├── build-resources/
│   ├── icon.icns / icon.ico   — Compiled app icons
│   └── entitlements.mac.plist
├── scripts/
│   ├── build-mac.sh           — Build the app for Mac
│   ├── build-win-from-mac.sh  — Build the app for Windows from a Mac
│   └── dev.sh                 — Run in dev mode, without building
├── package.json                — Project configuration
├── LICENSE                     — Full text of the GPL v3 license
└── README.md                   — This file
```

---

## Troubleshooting

**"ingesto can't be opened because Apple cannot check it for malicious software"
/ "...because the developer cannot be verified" (macOS, first launch)**

ingesto isn't signed with an Apple Developer certificate, so macOS blocks it
on first launch. Two ways to fix it, either works — you only need to do this once:

- **Right-click method (easiest)**: right-click (or Control+click) ingesto in
  Applications → **Open** → **Open** again in the dialog that appears.
- **Terminal method**: open Terminal (Applications → Utilities → Terminal),
  paste the following, press Enter, then launch ingesto normally:
  ```
  xattr -cr /Applications/ingesto.app
  ```

**"build-mac.sh" won't open**
→ Terminal → `chmod +x /path/to/build-mac.sh && /path/to/build-mac.sh`

**Volumes aren't showing up**
→ Click **↻ Refresh**; check that your cards are actually mounted in Finder/Explorer

**Copying is slow in SECURE or PRO mode**
→ Expected — computing the checksum (xxHash/MD5) during verification slows the
copy down, that's the trade-off between speed and integrity guarantees

---

## Contributing

Issues and pull requests are welcome on this repository. The maintainer remains
the sole decision-maker on what gets merged, but any genuine contribution will
be considered.

## License

This project is licensed under **GNU GPL v3.0**. See the [`LICENSE`](./LICENSE)
file for the full text. In short: you're free to use, study, modify, and
redistribute this software; any modified version you distribute must stay
under the same license, with its source code made available.

## Support

**ingesto** — [github.com/noar-justedit/ingesto](https://github.com/noar-justedit/ingesto)

For a bug report or feature request, open an *issue* on this repository:
[github.com/noar-justedit/ingesto/issues](https://github.com/noar-justedit/ingesto/issues)

Copyright © Just Edit — 2026
