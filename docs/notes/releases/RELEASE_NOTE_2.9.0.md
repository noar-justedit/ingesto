# ingesto 2.9.0

ingesto in French, and open to other languages. The copy engine and the verification are unchanged.

## Requirements
Unchanged: **macOS 13 Ventura or later** (Apple Silicon), Windows 10 or 11 (64-bit), Linux x64.

## Languages
- **Settings > Language**: English or French. At first launch, ingesto starts in the language of your system if it has it, in English otherwise.
- Everything you read follows the language: the interface, the end-of-ingest window, the HTML and CSV reports, the phone notifications, the system dialogs and the labels of the shooting note.
- What never changes: card, drive, folder and file names, your notes and operator names, the template variables (`{counter}`, `{cardname}`...) and the mode names (FAST, SIZE CHECK, SECURE, PRO).
- The JSON report and the Card Handoff document keep their field names and codes in English, so your scripts keep working. Only the mode and result texts follow the language.
- Want ingesto in your language? Translations are welcome: see "Translating ingesto" in the README. Thanks to wibi8bo, whose Chinese translation in his fork showed the way.

## Folder names
In English and French, a folder name is now plain ASCII:
- accents become the plain letter: `Hélène` gives `Helene` (it gave `Hlne` before);
- spaces and special characters are removed, in card names, fixed text and fields alike: a card labelled `NO NAME` gives `NONAME`;
- `_` and `-` stay; a name with no Latin letter at all becomes `CARD`.

The counter still finds the cards already on your drives. The shooting note keeps everything you typed.

## Interface
- With no card loaded, the start button reads **INSERT YOUR CARD** and breathes in orange.
- Empty drop zones are tinted: red for the cards, green for the destinations.

## Also in this release
2.8.1 was prepared but not released on its own, so this release also brings its fix:
- **The report kept the folder of the last card only.** Each new ingest to the same destination rewrote the earlier cards without their `folder` and without the count of files already on the drive, in `INGESTO_report.html` and `INGESTO_report.json`. From now on every card keeps its folder. Cards already in a report written by 2.8.0 or earlier stay as they are.
- The HTML report title no longer uses a long dash.
- The project's internal tracking files are no longer published on GitHub.

## Tests
2003 checks, all passing. The French interface was captured screen by screen and reviewed in full.
