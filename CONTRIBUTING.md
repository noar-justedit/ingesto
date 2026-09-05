# Contributing to syncto

Thanks for taking the time. syncto moves data around on other people's drives,
so the bar for changes to the engine is deliberately high.

## Licensing of contributions

syncto is **GPL-3.0-or-later**. By opening a pull request you agree that your
contribution is licensed under those same terms. Do not paste code from other
projects unless it is GPL-compatible and you say so in the pull request.

Note in particular: syncto's *behaviour* is modelled on FreeFileSync, but it
contains **none of its code**, and it must stay that way. Describe the behaviour
you want to reproduce; don't translate their C++.

## Before you open a pull request

```bash
npm install
npm test          # 140+ engine tests against real folders in a temp directory
./build.sh --dev  # run the app
```

`npm test` must stay green. It creates real files, real folders, real locks and
even a second process — if it passes, the engine works; if you break it, you
broke something people rely on.

**Any change to the engine needs a test.** The suite lives in
`test/run-tests.js` and is deliberately dependency-free: no framework, just
`ok()` and `eq()` against a scratch directory. Add your case next to the
closest existing section.

## Where things live

| Path | Role |
|---|---|
| `src/main/core/compare.js` | traversal and categorization of every item |
| `src/main/core/direction.js` | category → direction → operation, folder rules, move detection |
| `src/main/core/sync.js` | execution: copy, delete, rename, retry, progress |
| `src/main/core/db.js` | the last-synchronized-state database |
| `src/main/core/lock.js` | directory locking across machines |
| `src/main/core/session.js` | one pair (`Session`) and the multi-pair layer (`MultiSession`) |
| `src/main/fs/` | filesystem abstraction: `native.js`, `sftp.js` |
| `src/renderer/` | the interface — one HTML file, one JS file, no framework |

The layering matters: the engine knows nothing about Electron, which is what
makes it testable from plain `node`.

## Things that will get a pull request rejected

- A change to the copy path without a test proving data still lands intact.
- Making a deletion path quieter. syncto announces everything it removes; that
  is not negotiable.
- Adding a runtime dependency that needs native compilation — it would break
  cross-building Windows from a Mac, which is a feature.
- Reformatting files you did not otherwise change.

## Style

Two-space indent, no semicolon crusades, comments that explain *why* rather than
restate the code. Interface strings are in English.

## Reporting a bug

Please include your platform, the syncto version (bottom-left of the window),
the synchronization variant and copy level, and — if you can — the `.syncto` job
file with paths redacted. A comparison that produced the wrong plan is far more
useful than a screenshot of the result.
