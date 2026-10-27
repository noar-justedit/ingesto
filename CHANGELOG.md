# Changelog

All notable changes to ingesto. Versions before 2.5.5 are not listed here.

## 2.9.2 (2026-10-26)
Field report from an ALEXA Mini shoot (ARRIRAW, with and without HDE).
- Reports: each card now carries what went wrong, file by file, with the
  step and the message. HTML: click the result to open the list (the PDF
  export prints every list). CSV: new `Errors` column, last, so the column
  numbers do not move. JSON: `errs` and `errsMore`. Up to 50 lines per card.
- A card that stops answering no longer freezes ingesto. Every read of the
  card has a 60 s deadline (scan, copy, SIZE CHECK, card re-read); once it is
  missed, the card is reported as silent and the files left are listed as not
  copied. The volume list (macOS, Windows) no longer waits on a volume that
  does not answer; it lists it as such.
- Virtual volumes, HDE among them (CODEX Platform, formerly Device Manager):
  recognised by name (`A003_hde`, the extra volume of a CFast card) or because
  the system reports them as served by a program (FUSE), which covers ALEXA
  LF / SXT / XT media whose volume keeps the card's name. A notice says so
  when the card is loaded. The copies are compared with what the volume
  delivers (the announced sizes are not trusted), the card re-read (PRO) is
  off, the card log is never written there, and the window and report say
  what such a copy proves. An ordinary card is unaffected (same results and
  same files as 2.9.1, checked in every mode).
- French interface: the button of the information and refusal windows read
  "GOT IT" in English; it now reads "COMPRIS".
- The project's private tracking files leave GitHub with this version (they
  stay in the ZIP).

## 2.9.1 (2026-10-24)
Fixes and harmonisation after a full review of the code.
- History: a FAST or SIZE CHECK line that went fine now reads COPIED, not
  VERIFIED (its own details said "not verified"). VERIFIED stays for SECURE
  and PRO.
- Leaving kiosk mode redraws the main window: it no longer shows a card that
  is gone, and START with no card or no destination does nothing.
- The PRO "check the card for real" (unmount and re-read, macOS) works when the
  source is a folder inside the card; it used to report every file unreadable.
- The interface in French no longer grows in memory during long ingests.
- A language code in an unexpected form in the preferences can no longer stop
  an ingest after the copy.
- JSON report: `mode` and `result` stay in English for scripts and for the
  next read-back; `modeLabel` and `resultLabel` carry the translated texts.
- Windows: `System Volume Information`, `$RECYCLE.BIN` and
  `.DocumentRevisions-V100` on a source drive are skipped instead of failing
  the ingest; plugging a drive in during an ingest no longer freezes the
  copy (the volume scan no longer blocks).
- The engine refuses a second ingest while one runs.
- PRO card re-read: about 10 s of needless work removed on a 30,000-file card.
- Security: the post-ingest command and the card handoff run only after the
  operator has approved that exact command once, in a system dialog.
- One name for each step: Verify (the read-back on the destination) and Card
  re-read (the second read of the card, PRO). Report columns COPY / VERIFY /
  RE-READ; CSV columns renamed accordingly.
- One format: dates DD.MM.YYYY HH:MM everywhere (report lines now carry the
  year), durations "11m03s", sizes in decimal units like the Finder
  (a 128 GB card reads 128.0 GB).
- "ingesto" in lowercase everywhere; the logo dot is violet everywhere; kiosk
  shows a good copy in green like the main window.
- Labels and tooltips on the counter buttons and the template chips. The two
  remaining confirmations are translated.
- Tests: 2044 checks, all passing.

## 2.9.0 (2026-10-23)
- ingesto is open to translation. **French** is the first language besides
  English: Settings > Language, the system language at first launch. The
  interface, the HTML and CSV reports, the phone notifications, the system
  dialogs and the shooting note follow it. In the JSON report and the Card
  Handoff document, field names and codes stay in English for scripts.
- The translation engine follows the design of wibi8bo's Chinese translation
  (github.com/wibi8bo/ingesto), so other languages plug in the same way.
  Card, drive, folder and file names, notes and operator names are never
  translated.
- Folder names: in English and French, accents become the plain letter
  ("Hélène" gives "Helene", it gave "Hlne" before) and spaces and special
  characters are removed from card names, fixed text and fields alike. Only
  "_" and "-" stay. The shooting note keeps everything.
- With no card loaded, the start button says INSERT YOUR CARD and breathes in
  orange; empty drop zones are tinted, red for cards, green for destinations.
- Tests: 2003 checks, all passing.

## 2.8.1 (2026-10-23)
- Fix: the ingest report lost the `folder` of earlier cards (and the count of
  files already on the drive) at each new ingest to the same destination, in
  `INGESTO_report.html` and `INGESTO_report.json`. Reports written by 2.8.0
  and earlier keep the gap for the cards already in them; cards ingested from
  2.8.1 on keep their folder.
- The HTML report title no longer uses a long dash.
- The project's private tracking files (`AGENTS.md`, `ETAT_PROJET.md`,
  `CLAUDE.md`, `docs/notes/`) are no longer published on GitHub.
- Tests: 1917 checks, all passing.

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
