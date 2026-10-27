# ingesto 2.9.2

Built from a field report on an ALEXA Mini shoot, in ARRIRAW with and without HDE. Thanks to Manuel López (DigitalFrozen) for the report.

## Requirements
Unchanged: **macOS 13 Ventura or later** (Apple Silicon), Windows 10 or 11 (64-bit), Linux x64.

## The report says what went wrong
A card that ended with "2 errors" now says which files, at which step, and why.
- **HTML**: click the result of a card (`2 errors ▸`) to open the list. The PDF export prints every list.
- **CSV**: a new `Errors` column, added last so the other column numbers do not move.
- **JSON**: `errs` (file, step, message, drive when there are several) and `errsMore`.
- Up to 50 lines per card. The messages come from the system and stay in English.

## A card that stops answering no longer freezes ingesto
A reader that hangs, or a virtual volume whose service stalls, used to leave ingesto waiting for ever, or frozen.
- Every read of a card now has a 60-second deadline: the scan, the copy, SIZE CHECK and the card re-read.
- Past it, the card is reported as silent, nothing more is asked of it, and the files left are listed as not copied, ready for a retry.
- The volume list (macOS, Windows) no longer waits on a volume that does not answer. It is listed as not answering, not dropped.

## Virtual volumes and HDE (ARRIRAW, CODEX Platform)
CODEX Platform (formerly Device Manager) can present ARRIRAW as HDE, encoded while it is read: on a CFast card as an extra volume whose name ends in `_hde`, on ALEXA LF / SXT / XT media as the card's own volume, under its usual name. ingesto recognises such a volume by its name, or because the system reports it as served by a program, and says so when the card is loaded.
- The files of such a volume only get their size once read. ingesto no longer compares them with the size the volume announces (every file used to fail): the copies are compared with what the volume delivers.
- That is all such a copy can prove: the files exist only on your drives, not on the card. The end-of-ingest window and the report say so.
- The PRO card re-read is off there: it would only produce the files again.
- The progress bar counts files, and no time left is shown.
- ingesto never writes its card log on such a volume.
- With HDE on a CFast card, clips in other formats (ProRes) stay on the card's other volume: load it too.
- Tested on a simulated volume (files announced at 0 bytes, and one that never answers), not yet on real CODEX hardware. An ordinary card behaves exactly as in 2.9.1.

## Also fixed
- French interface: the button of the information and refusal windows stayed in English ("GOT IT"). It now reads "COMPRIS".

## Tests
2117 checks, all passing.
