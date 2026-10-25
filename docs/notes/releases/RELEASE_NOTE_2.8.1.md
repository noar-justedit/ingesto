# ingesto 2.8.1

A fix for the ingest report. Nothing else changes in the application: the copy engine, the verification and the interface are the same as in 2.8.0.

## Requirements
Unchanged from 2.8.0: **macOS 13 Ventura or later** (Apple Silicon), Windows 10 or 11 (64-bit), Linux x64.

## Fixed
- **The report kept the folder of the last card only.** Each new ingest to the same destination rewrote the earlier cards without their `folder` (where the card sits on the drive) and without the count of files already on the drive. This affected `INGESTO_report.html`, `INGESTO_report.json`, and the "open folder" button of older cards in the ingest history. From 2.8.1 on, every card keeps its folder.
  Cards already in a report written by 2.8.0 or earlier stay as they are: their folder cannot be recovered from the report. Tools that read the report should still expect `folder` to be empty for those cards.
- The HTML report title no longer uses a long dash.

## Repository
The project's internal tracking files (development notes, in French) are no longer published on GitHub. `CHANGELOG.md` stays.

## Tests
1917 checks, all passing. A new test checks that every field of a report record survives being read back, so a field added later cannot be lost the same way.
