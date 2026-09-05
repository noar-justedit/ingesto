# syncto 0.2.3

A cosmetic release: new application icon, one interface fix, refreshed
documentation. Nothing in the synchronization engine changed, so 0.2.2 jobs,
databases and checksum lists carry over untouched.

## New icon

syncto now uses the Just Edit artwork — a violet folder carrying the sync
arrows — instead of the Lucide-derived glyph on a dark square. Every embedded
asset is regenerated from `build-resources/icon.svg`: the macOS `.icns` (ten
representations up to 1024 px), the Windows `.ico` (16 to 256 px), the 1024 px
master and the Linux icon set.

**If the old icon survives the upgrade**, macOS is showing you its cache, not the
app. Move the `.app` somewhere else and back, or run `killall Dock`.

## Fixed

Warning text in the confirmation dialogs was hyphenating in the middle of words
— the auto-sync warning read `with th / e current settings`. It was styled for
file paths rather than for sentences. Paths still wrap, prose now reads
normally.

## Documentation

The README screenshots were retaken at 1440×900 @2× against a realistic two-pair
job. Three are new: the copy phase, the verification pass introduced in 0.2.2,
and the end-of-run summary.

## Also in this release

Two scripts for anyone rebuilding from source: `scripts/gen-icons.py`
regenerates every icon asset from the SVG on any platform, and `scripts/shots.js`
produces the documentation screenshots by driving the real application through
the DevTools protocol.

## Downloads

| File | For |
|---|---|
| `syncto-0.2.3-mac-arm64.dmg` | macOS 11+, Apple Silicon |
| `syncto-Setup-0.2.3.exe` | Windows 10/11 x64, installer |
| `syncto-0.2.3-win-x64.zip` | Windows 10/11 x64, portable |

Both builds are unsigned. macOS: right-click the app, then **Open**, on first
launch. Windows: **More info → Run anyway** on the SmartScreen warning.

## Upgrading

Install over the previous version. Jobs (`.syncto`), sync databases
(`.syncto.db`) and checksum lists are unchanged and need no migration.

**Full changelog:** https://github.com/noar-justedit/syncto/compare/v0.2.2...v0.2.3
