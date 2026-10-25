# ingesto 2.9.1

ingesto in French, and open to other languages, with a full review of the code behind it. The copy engine and the verification work as before; this release fixes what the review found and makes the same things look and read the same everywhere.

## Requirements
Unchanged: **macOS 13 Ventura or later** (Apple Silicon), Windows 10 or 11 (64-bit), Linux x64.

## Languages (new in 2.9)
- **Settings > Language**: English or French. At first launch, ingesto starts in the language of your system if it has it, in English otherwise.
- The interface, the end-of-ingest window, the HTML and CSV reports, the phone notifications, the system dialogs and the labels of the shooting note follow the language.
- Never translated: card, drive, folder and file names, your notes and operator names, the template variables (`{counter}`, `{cardname}`...) and the mode names (FAST, SIZE CHECK, SECURE, PRO).
- The JSON report keeps its field names and values in English for your scripts; `modeLabel` and `resultLabel` carry the translated texts.
- Want ingesto in your language? See "Translating ingesto" in the README. Thanks to wibi8bo, whose Chinese translation in his fork showed the way.

## Folder names (new in 2.9)
In English and French, a folder name is plain ASCII: accents become the plain letter (`Hélène` gives `Helene`), spaces and special characters are removed (`NO NAME` gives `NONAME`), `_` and `-` stay. This also applies to the fixed text of templates saved before: `Journée 1` becomes `Journee1`. The shooting note keeps everything you typed.

## Fixed
- **History said VERIFIED for copies that were never verified.** A FAST or SIZE CHECK line now reads COPIED. VERIFIED is reserved for SECURE and PRO.
- **After kiosk mode, the main window showed a card that was gone**, and START could launch an ingest of nothing.
- **"Check the card for real" (PRO, macOS)** reported every file unreadable when the source was a folder inside the card.
- **Windows:** a drive plugged in during an ingest froze the copy for several seconds; an NTFS drive used as a source could not finish green because of its protected system folders.
- The French interface no longer grows in memory during a day of ingests.
- The engine refuses a second ingest while one runs.
- PRO card re-read: much less CPU on cards with tens of thousands of files.

## Security
The post-ingest command and the card handoff now run only after you have approved that exact command once, in a system dialog. A command changed behind your back would ask again.

## One name, one format
- **Verify** is the read-back on the destination, **Card re-read** the second read of the card (PRO). The report columns read COPY / VERIFY / RE-READ, and the CSV columns are renamed the same way (`Verify`, `Card re-read`, `Verify ms`, `Card re-read ms`): update a spreadsheet that reads them by name.
- Dates are DD.MM.YYYY HH:MM everywhere; report lines now carry the year.
- Durations read `11m03s` everywhere.
- **Sizes are in decimal units, like the Finder**: a 128 GB card reads 128.0 GB (it read 119.2 GB before).
- "ingesto" is written in lowercase everywhere, and the logo dot is violet everywhere.
- Kiosk mode shows a good copy in green, like the main window.

## Interface (new in 2.9)
- With no card loaded, the start button reads **INSERT YOUR CARD** and breathes in orange.
- Empty drop zones are tinted: red for the cards, green for the destinations.

## Also in this release
2.8.1 and 2.9.0 were prepared but not released on their own. This release also brings the 2.8.1 report fix: each new ingest to a destination no longer drops the `folder` of the earlier cards from `INGESTO_report.html` and `INGESTO_report.json`. Cards already in a report written by 2.8.0 or earlier stay as they are.

## Tests
2044 checks, all passing.
