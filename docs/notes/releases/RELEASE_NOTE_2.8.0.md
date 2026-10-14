# ingesto 2.8.0

A faster Copy Info: notes in markdown, a picture profile menu, the operators of the day one click away, and Electron 44 underneath. The copy engine and the verification are unchanged.

## Requirements
- **macOS 13 Ventura or later** (Apple Silicon). Electron 44 no longer runs on macOS 12 Monterey: if you are on Monterey, stay on 2.7.2.
- Windows 10 or 11 (64-bit), Linux x64: unchanged.

## Notes in markdown
- The Notes field is a small text editor: bold, italic, underline, strikethrough, heading, bulleted and numbered lists, checklist.
- Prefer typing markdown? The **Aa / MD** switch shows the markdown itself. Both views edit the same note, and ingesto remembers your choice.
- The note is saved next to the footage as `001_note.md`, under a header with the date, counter, card, operator, camera and profile. Verify recognises both this file and the `001_note.txt` written by earlier versions.
- Underline has no markdown form: it is written `<u>text</u>`, which most markdown viewers display.
- The HTML report and the ingest history show the note formatted. The CSV report and the phone notification keep the markdown text.
- The field is larger than before.

## Operator, Camera and Profile
- The three fields now share one row, in Copy Info, on each loaded card and in kiosk mode.
- **Profile** opens a menu of the usual picture profiles, grouped by manufacturer: Sony, Canon, Panasonic, Fujifilm, ARRI, RED and Nikon, Blackmagic, DJI, smartphones and more. Each entry shows what `{pp}` writes in the folder name. Anything else can be typed at the bottom of the menu, and **None** clears it.
- **Operator** remembers the names used since ingesto was opened. The arrow lists them, and typing the first letters narrows the list. A name joins the list when an ingest starts. The list is never saved to disk: it is empty again at the next launch. Kiosk mode has it too.

## Documentation
- The user manual (English and French, in `docs/manual/`) is updated for 2.8.0, with new pages on the Profile menu, the operators of the day and the markdown notes.
- New screenshots in the README.

## Also in this release
2.7.3 was prepared but not released on its own, so this release also brings:
- Build launchers renamed `scripts/build_mac.command` and `scripts/build_win_from_mac.command`.
- A `.gitignore`, and the project's tracking files and notes published in the repository (`AGENTS.md`, `ETAT_PROJET.md`, `CHANGELOG.md`, `docs/notes/`, in French).

## Tests
1890 checks, all passing. The new controls were also tried in the running app under Electron 44, with a real ingest writing its markdown note.
