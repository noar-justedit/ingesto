# Changelog

All notable changes to ingesto. Versions before 2.5.5 are not listed here.

## 2.8.0 (2026-10-13)
- Electron 44. **macOS 13 Ventura or later is now required** (the 2.7
  versions still run on macOS 12).
- Notes are written in markdown: formatting buttons (bold, italic, underline,
  strikethrough, heading, lists, checklist) or direct markdown input, one
  switch for both. The note is saved as `001_note.md`; Verify recognises both
  this and the `001_note.txt` of earlier versions. The HTML report and the
  ingest history show the note formatted.
- Operator, Camera and Profile on one row, in Copy Info, on each card and in
  kiosk mode. The notes field is larger.
- Profile is a menu of the usual picture profiles, grouped by manufacturer,
  with a free field for anything else.
- Operator offers the names used since ingesto was opened (list and
  autocompletion), kiosk included. The list is kept in memory only.
- User manual (English and French, HTML and PDF) and README screenshots
  updated for 2.8.0.
- Tests: 1890 checks, all passing.

## 2.7.3 (2026-10-03)
No change to the application: the copy engine, the verification and the
interface are the same as in 2.7.2.
- Build launchers renamed: `scripts/build_mac.command` and
  `scripts/build_win_from_mac.command`.
- New `scripts/push_github.command`: publishes the source folder to GitHub,
  including removed files and executable flags, and sends `version.json` only
  once the release and its binaries are out.
- Project tracking files added: `AGENTS.md`, `ETAT_PROJET.md`, `CHANGELOG.md`,
  `.gitignore`, and the project notes in `docs/notes/`.
- Tests: 1832 checks, all passing (6 new ones cover the two publishing scripts).

## 2.7.2
- Insert menu laid out on two columns: the end of the list was hidden below
  the edge, as macOS hides the scroll bar with a trackpad.
- "Custom text..." entry; menus on the floating surface colour; dark scroll
  bars everywhere.
- Tests: 1826 checks.

## 2.7.1
- Issue #11: expandable ingest history (date, files, size, durations, speed,
  destinations, operator).
- Operator, Camera and Picture profile are kept from one ingest to the next,
  Notes are cleared; a broom clears everything; (M) marks a camera entered by
  hand.
- Fixes: history covering the queue during a copy, SELECTED cut off, digit
  boxes cut off, camera not detected in kiosk mode.
- README and screenshots redone.

## 2.7.0
- Complete interface redesign.
- Ingest history read back from the reports on the drives.
- Source-card lock: ingesto never deletes, renames or overwrites a file on a
  source card.
- Full review: reveal could open a file (fixed), note names cleaned, journal
  capped at 64 MB, strict content security policy, destination-inside-card
  check for every card of a batch, manifests fsynced.
- Performance: 16 MB write buffer, progress 10 times per second, deferred
  preference writes.

## 2.6.6
- `{pp}` token (normalised picture profile).
- Build scripts executable.

## 2.6.5
- Counter width from 2 to 4 digits (issue #9).
- Card Handoff: `handoff.json` with `safeToErase` (issue #10).

## 2.6.3 / 2.6.4
- Every message rewritten (70 cases); safety release with 11 fixes.

## 2.6.0 to 2.6.2
- Subfolders in the folder template, `{YYYY}` token, Windows card names,
  `package-lock.json` and `npm ci`.

## 2.5.5
- First signed and notarized macOS release.
