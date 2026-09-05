# syncto 0.2.4

A one-bug release. Nothing in the synchronization engine changed, so 0.2.3
jobs, databases and checksum lists carry over untouched.

## Fixed

**The first folder pair could not be removed.** Every pair from the second one
down had a ✕ button to remove it; the first pair — the big SOURCE/DESTINATION
fields at the top of the window — did not. In a multi-pair job, that meant you
could delete pair 3, pair 2, anything except the one that started it all.

Pair 1 now carries the same ✕ as every other pair, and follows the same rule:
hidden only when it's the last pair left in the job, since a job always needs
at least one. Removing it promotes pair 2 into the main fields — the same
shift that already happened when you removed any other pair.

## Downloads

| File | For |
|---|---|
| `syncto-0.2.4-mac-arm64.dmg` | macOS 11+, Apple Silicon |
| `syncto-Setup-0.2.4.exe` | Windows 10/11 x64, installer |
| `syncto-0.2.4-win-x64.zip` | Windows 10/11 x64, portable |

Both builds are unsigned. macOS: right-click the app, then **Open**, on first
launch. Windows: **More info → Run anyway** on the SmartScreen warning.

## Upgrading

Install over the previous version. Jobs (`.syncto`), sync databases
(`.syncto.db`) and checksum lists are unchanged and need no migration.

**Full changelog:** https://github.com/noar-justedit/syncto/compare/v0.2.3...v0.2.4
