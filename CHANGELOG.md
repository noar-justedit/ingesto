# Changelog

All notable changes to syncto are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/lang/fr/).

## [0.6.2] — 2026-09-05

Locks: a run that survives the network, and the files a dead run leaves behind.

### Fixed

- **A synchronization between two machines died on every network hiccup**, with
  *"the lock file has not been refreshed for 15 s — the folder may have been
  taken over"*. Nobody had taken anything over. Two causes:
  - **The silence window was 12 seconds.** That is the right number for two
    processes on one machine and much too tight for two machines on a share.
    An SMB reconnection, a switch renegotiating, a NAS spinning a disk back up:
    fifteen seconds of nothing is an ordinary Tuesday. It is now **60 seconds**,
    the same number at both ends — the owner gives up exactly when a waiter
    becomes entitled to take over, never later.
  - **A read that failed was read as "the lock file disappeared."** The helper
    that reads a lock returns nothing both when the file is missing and when the
    read failed, and the heartbeat treated the two the same — so one unreadable
    instant ended the run. The check now distinguishes *gone* (the filesystem
    said absent) from *unknown* (the share did not answer), and only the first
    is proof. A genuine takeover — the file replaced by another machine's lock —
    still stops the run immediately, as it must.
- **The run summary says what the network did.** A run that rode out three
  dropouts finished correctly; that is a note, not an error, and it is worth
  knowing before the share stops answering for good.

### Added

- **Leftover lock files are found and reported.** syncto locks each folder it
  writes to and clears the lock when it finishes. A run that never finished — a
  crash, a cable pulled, a machine put to sleep — leaves the file behind, and
  until now nothing cleared it unless another run happened to want that folder.
  A comparison already lists the root of every base folder, so noticing one
  costs nothing. `3 leftover locks — clear` appears in the status strip.
- **Clearing them is a click, never automatic.** A lock file is the one thing
  standing between two machines writing the same files, so an old-looking
  timestamp is not a licence to delete: each one is re-verified — a lock held by
  a live process is left exactly where it is, an unidentified one is watched for
  real life signs first — and removal goes through the same atomic rename the
  protocol uses. The summary says how many were removed, how many were still in
  use, and how many refused.

### Notes

- ⚠️ **Update both machines.** Two machines running different versions no longer
  agree on the silence window: an older one would take a folder after 12 s while
  a newer one still believes it holds it.

## [0.6.1] — 2026-09-05

The check moves to the moment a job is opened, and syncto stops guessing.

### Added

- **Opening a saved job checks every folder it names.** The ones that are not
  there arrive in one list — one line per folder, with the pair number and the
  side — each with a **Browse…** button. *Apply* writes only the rows that were
  resolved. This happens before anything is planned against a stale path, which
  is the cheapest moment to fix one.
- **A missing folder is drawn in red in its own row**, with the reason on hover.
  That is what is still on screen an hour after the dialog was closed, and the
  row is where the problem actually is. The red follows what is typed: it clears
  the moment a path resolves and appears the moment one stops.
- **Browse opens where the folder used to be.** When the path no longer
  resolves, the picker walks up until it finds something that does, instead of
  landing on wherever the user last browsed.
- **A red mark in the status strip** — `2 folders missing — fix` — reopens the
  list. At launch the window only marks: a drive that is not mounted yet is the
  normal state of a morning, and a dialog in the face at every start is how a
  warning stops being read.

### Removed

- **The search for the folder under its new name, added in 0.6.0.** syncto no
  longer reads the neighbouring folders' databases looking for a lookalike to
  propose. It says the row is wrong, in words and in red, and the person points
  it at the right place. One less thing deciding on the user's behalf, and one
  less directory scan.

### Kept

- **The run still refuses** when a folder that has a history is not there:
  copying all of it again would duplicate it. The message now says to fix the
  row rather than naming a folder syncto went looking for.

### Notes

- **SFTP sides are not checked.** Answering "does this folder exist" on a server
  means opening a connection and possibly asking for a password, which is not
  something opening a job should do on its own.

## [0.6.0] — 2026-09-05

A folder that was renamed is no longer copied again from scratch.

### Fixed

- **A base folder renamed on the drive was treated as a new one.** The job
  still named the old path, the path no longer resolved, that side read as
  empty — and the next comparison proposed to copy everything into the old
  name, beside the folder that already held it. Nothing refused, because the
  guard that catches a missing root only fires when the OTHER side would lose
  files, and here nothing was going to be deleted. A destination that has a
  history and is no longer there is now a refusal, whichever way the files were
  about to move.

### Added

- **syncto looks for the folder under its new name, and offers it.** A renamed
  folder takes its `.syncto.db` with it, and that file names the pair — so the
  folder identifies itself. No inode numbers (Windows and exFAT have no stable
  ones), no name similarity, no scoring of contents. When the candidate's stamp
  matches the surviving side's, it is not a resemblance: `savePairDb` writes the
  same stamp to both sides, so that folder is literally the other half of the
  last run.
- **A dialog, not an action.** It names the missing path, the folder that looks
  like it, and why. *Use this folder* writes the new path into that one pair,
  on that one side, and compares again. Nothing is ever retargeted on its own —
  repointing a mirror at a folder nobody confirmed is how the wrong folder gets
  emptied. Several folders carrying the same pair are listed, and none is
  chosen.

### Notes

- **The scan is the immediate parent only**, never the volume, and it gives up
  on a parent holding more than 200 entries. It runs only when a base folder is
  missing, so a normal comparison pays nothing for it.
- **A brand-new destination raises nothing** — no dialog, no refusal. That is
  where every job starts.
- **A folder that was really deleted** is still reported, with no folder offered
  in its place and the advice that fits.
- Still true, and the subject of a later version: a pair's identity is derived
  from its two paths, so changing a path starts a fresh database. It costs
  nothing in MIRROR; in UPDATE and 2 WAYS it means the next run has no memory of
  the previous one.

## [0.5.11] — 2026-09-03

Interface only. The engine is untouched.

### Added

- **A CLOSE button, next to NEW, OPEN, SAVE and SAVE AS.** It closes the open
  job and takes it out of the JOBS list. It is greyed out while no job file is
  open — NEW is what clears an untitled one — so CLOSE can never lose work that
  is not already on disk.
- **Right-click on a job in the list**: *Open*, *Reveal in Finder* (*Show in
  Explorer* on Windows), and *Close*.
- **Close job** in the File menu. Deliberately without a keyboard shortcut:
  ⌘W already belongs to the window's own Close and to the Window menu, and two
  menu items claiming one key is a coin toss.

### Notes

- **Closing never deletes anything.** It removes the entry from the list; the
  `.syncto` file stays where it is, and the status strip says so with the full
  path. A job file is often the only record of which two folders belong
  together, and a right-click menu that deletes one is a trap.
- **Closing the open job also clears the last-opened path**, so the next launch
  starts on an untitled job instead of reopening the one just closed.

### Changed

- The recent-jobs list moved out of the window process into `config.js`
  (`pushRecent` / `removeRecent`). Opening a job and closing one now share one
  definition of what that list is, and it is covered by the test suite without
  needing Electron.

## [0.5.10] — 2026-09-01

Interface only. The engine is untouched; the same checks pass, plus 25 new ones.

### Fixed

- **A job whose pairs are all in sync no longer lists them.** A multi-pair job
  drew one heading per pair unconditionally, so a backup that is up to date —
  the ordinary state of a backup — produced a column of headings with nothing
  underneath: five rows that look like work. Worse, it kept the grid from ever
  being empty, so the "nothing to do" message the window already had could not
  be reached in a multi-pair job at all. A pair now appears only when it has
  something to show.
- **A pair that has work still appears in full**, heading included. With three
  pairs and one of them behind, the list holds that one pair and the status
  strip says `2 of 3 pairs already in sync` — in words, not as empty rows.

### Changed

- **The empty grid answers the question that was actually asked.** One hedging
  sentence — "everything is in sync, or the view filters are hiding it" — is
  replaced by four states that know which one they are:
  - every pair identical → a green check, **All pairs are in sync**, the figures
    underneath, and a button to list the identical files anyway;
  - work exists but the current view hides all of it → how many items need
    attention, and a button that clears the filters;
  - nothing was compared at all → the folders are empty, or the filter removes
    everything in them;
  - nothing compared yet → pick two folders and press Compare.

## [0.5.9] — 2026-09-01

Application bundles, and a log you can send to somebody.

### Fixed

- **A macOS `.app` could be destroyed a little more at every run.** A
  `.framework` is built on symbolic links — `Resources` points at
  `Versions/Current/Resources`, `Current` points at `A`. syncto recreates
  links as links, but only while it believes the item is a link. When the two
  sides disagreed about an item's type — a link here, a real file or folder
  there, which is what a bundle copied by another tool leaves behind — the
  comparison filed the row as a plain file so it could be shown and resolved in
  the grid, and the copy took that at face value. Resolving the conflict then
  read the link as if it were a file: `EISDIR: illegal operation on a
  directory, read` on a link pointing at a folder, and a size mismatch on a
  link pointing at a file, whose own length is 26 bytes where its target holds
  a megabyte. The copy now decides from what `lstat` says at that instant, not
  from what the comparison recorded — the stat was already being made, so it
  costs nothing. Present since symbolic links arrived.
- **A real folder standing where the source has a link is now replaced**, so a
  flattened bundle is repaired instead of reported for ever. The removal goes
  through the configured deletion policy — recycle bin, revision folder or
  permanent — and a folder that still holds files refuses and names them,
  rather than being wiped behind the user's back.
- **A folder facing a file is explained in words** instead of failing with an
  errno.

### Added

- **A Copy button on the Errors, Notes and Problems panels.** It puts the whole
  list on the clipboard — all of it, not the sixty lines the panel shows —
  behind a header naming the version, the job and the date. The heading no
  longer scrolls with the list, so the button stays reachable at the sixtieth
  line.

## [0.5.8] — 2026-09-01

Interface only. The engine is untouched and the same 447 checks pass.

### Changed — the top of the window

- **The synchronization mode is now the first thing on screen**, above the
  folders. It is the decision that governs everything below it, and it was
  sitting underneath — the comment in the source even claimed it was at the top.
- **The copy-mode box is gone.** It described the one and only copy mode, at
  length, permanently. That is not a choice, so it does not need a panel: it is
  in the settings, and in the run summary where it is actually being used. The
  grid gains about 140 px — eight rows visible where five fitted before, which
  the progress panel also benefits from.

### Changed — the folder pairs

**Pair 1 is no longer a special case.** It had its own markup up in the header,
with the only swap button and the only free-space readouts, so nothing below it
lined up with anything.

- **Every pair is numbered**, from 1.
- **The header row and every pair row share one CSS grid** — remove · number ·
  source · swap · destination. That is what makes the columns line up, and it
  cannot drift: changing a track moves both together.
- **Every pair has its own swap button**, and it swaps that pair. ⌘T still
  swaps them all at once.
- **The free-space readouts are gone.** "27.8 GB free of 252 GB" is a fact about
  the machine, not about the job — and it was the main reason pair 1 was taller
  than the rest. A pair is a source and a destination.
- **Remove moved to the left, is red, and uses Lucide's `trash-2`.** It is the
  one destructive control in that strip and it was last in the row, in the same
  grey as Browse. On the last remaining pair it is disabled rather than hidden,
  so the columns do not shift when a job is down to one.

### Fixed

- **The server button stopped lighting up** when an `sftp://` address was typed
  by hand. The old code only did that for pair 1, in the function that
  free-space removal emptied. It now updates in place as you type — in place
  rather than by redrawing the rows, because redrawing takes the focus away
  from someone tabbing between fields.

---

## [0.5.7] — 2026-09-01

Reported as "on a multi-pair comparison over a large volume, the circle fills,
empties, fills again — I have no idea of the progress or the time". Three
separate things were wrong, and the third is the one that mattered most.

### Fixed — you could not see the progress panel at all

**During a comparison the whole progress panel was cut off below the bottom of
the window.** The ring, the counters, the elapsed time, the Cancel button — all
of it, on a default-sized window. `#gridscroll` is a scrolling flex child and
had no `min-height: 0`, so it refused to shrink below its content, the column
kept growing, and everything under it was pushed off screen.

It only showed up during a **comparison**, because that is the one phase where
the grid is still filling while the panel is up. A synchronization, running
against an already-drawn grid, fitted. That is why it had gone unnoticed —
including by the screenshots, which had never photographed a comparison in
progress.

### Fixed — a ring that filled, emptied and filled again

The ring was driven by `(scanned % 500) / 500`: it filled once per 500 items
scanned and started over. On a large job that cycles for minutes. It was meant
to read as "working", and it reads as a progress bar that has lost its mind.

**And every pair restarted its own counter from zero**, so at each pair boundary
the numbers fell back and the ring emptied for real.

Two honest answers now, depending on what is actually known:

- **The pair has been synchronized before.** The database remembers how many
  items these two folders held last time, which for a backup that runs
  regularly is a good estimate. It is read *before* the scan now rather than
  after, and the ring shows a real percentage — written `≈62%`, because the
  tree has changed since, which is the entire reason you are comparing. Capped
  at 99 %: the run is over when it says it is.
- **First comparison of this pair.** No percentage at all — inventing one is
  what caused this. The arc spins, and the count of items scanned sits in the
  middle where the percentage would be. A number that only ever grows.

Across pairs everything is a running total, and the ring's own progress is
(finished pairs + fraction of the current one) / pairs. **Nothing goes
backwards**, at a pair boundary or anywhere else.

### Fixed — no idea of the time

The four tiles kept their copy-phase labels during a comparison, so "ETA" was
sitting over a number that was not an ETA. They now say what they are showing:
**Items scanned · Data read · Scan rate · Elapsed**, and "Removed" — which a
comparison never does — is hidden.

Elapsed time and scan rate need no total to be true, which is the point: they
answer "is this thing moving?" even on a first run with nothing to estimate
against. The rate is computed from milliseconds, so it is there in the first
second rather than blank for the exact moment you are wondering.

The window also gets its first progress event **before** the walk starts
instead of at the 200th item — on a deep tree or a slow share, that was a long
stare at an empty panel — and one at the end of each pair, so the running total
handed to the next pair is the same number you were last shown.

### Added — Reveal, on right-click

Right-clicking a row in the grid or in the overview now offers **Reveal in
Finder** (Show in Explorer on Windows) for **both sides** — a row is two places
on disk, not one. The side the item is not on is greyed rather than hidden: a
menu that changes shape from row to row is harder to use than one where the
missing half is visible and inert.

Right-clicking a folder field — SOURCE, DESTINATION, or any extra pair — offers
the same thing for the folder itself.

The path is resolved in the main process, not in the window, because that is
where the pairs, the two roots and each side's own spelling of the name live: a
Mac stores accents decomposed and a Linux share composed, and handing the wrong
spelling to the Finder reveals nothing. A side that is on a server says so
instead of doing nothing. And when the item is gone, the containing folder
opens — more useful than an error, and where you were heading anyway.

### Tests

18 new assertions, to **447**: the running total never falls (including across
a pair boundary), the estimate appears on the second comparison and not the
first, elapsed time is always reported, and Reveal resolves both sides,
falls back to the containing folder, refuses a stale row index and refuses a
server.

---

## [0.5.6] — 2026-09-01

**The macOS build now handles signing and notarization by itself.** Reported as
"the build script should do the whole notarization thing for me — I want
something simple for my future builds", and that is the right instinct: 0.5.5
shipped a separate setup step to run first, which is one thing too many to
remember.

### Changed

- **There is nothing to run before the build.** Double-clicking
  `scripts/build-mac.command` — or `./build.sh` — is the whole procedure, now
  and for every build after. The first signed build asks two questions (an Apple
  ID and an app-specific password), stores them in the keychain, and never asks
  again. `scripts/notarize-setup.sh` and its `.command` are gone; everything
  they did happens during the build.
- **A failed notarization no longer costs you the build.** Notarization is the
  one step that depends on a company on the other side of the internet
  answering. When the build fails with it switched on — Apple down, Wi-Fi
  dropped, a submission rejected — it runs again without it and hands you a
  signed application, instead of an empty `dist/` and a wasted evening.
- **The build now checks Apple's command line tools too**, and reports the one
  command that installs them. Without `notarytool` the failure looked like a
  credentials problem, which sends you hunting in the wrong place.
- `./build.sh --sign-setup` is replaced by `./build.sh --sign-check`: a pure
  report of what you would get, asking and changing nothing. Use it to look
  without building; you never need it to build.
- **Credentials Apple has accepted are never second-guessed.**
  `notarytool store-credentials` validates against Apple before it writes
  anything, so its exit code is the verdict; re-checking afterwards can only
  throw away something known to be good. And when the build does look up an
  already-stored profile, a `notarytool` that will not answer no longer means
  "not notarized" — the keychain is asked instead, the reason is printed, and
  the submission itself remains the real test.
- **Every option the build passes to `notarytool` and `stapler` is now checked
  by the test suite**, against the list in `notarytool(1)`. `history` takes
  authentication options and nothing else — no `--limit`, no `--page` — and one
  invented flag there is enough to make notarytool reject the command line
  before it reaches Apple, which reads exactly like a wrong password when the
  output is discarded. A fake `xcrun` that answers on the subcommand alone
  cannot catch that; reading the real command lines out of the scripts can, and
  needs no Mac. 15 new assertions, taking the suite to **429**.

### Unchanged

Everything that 0.5.5 established stays exactly as it was: the credentials live
in the keychain under `syncto-notarization` and never touch the project, the
disk image gets its own trip to Apple so the first launch works offline, and
`spctl` reports at the end what a stranger's Mac will do with the file.

**The Windows build script is untouched**, deliberately. It never had anything
to do with signing, and the fix that made the Windows cross-build work again
lives in `electron-builder.yml`, not in the script.

---

## [0.5.5] — 2026-08-31

Two build problems, both reported from a real Mac. Nothing in the engine
changed; the 414 checks pass identically.

### Fixed

- **The Windows build from a Mac was impossible.** It stopped at
  `⨯ node-gyp does not support cross-compiling native modules from source`,
  before packaging anything.

  syncto's own code compiles nothing — but **ssh2 declares two optional native
  modules, `cpu-features` and `nan`**, and npm installs them on any machine that
  happens to have a compiler, which every Mac with the Xcode command line tools
  does. electron-builder then ran `@electron/rebuild` before packaging, found
  `cpu-features`, and tried to rebuild it for `win32-x64`. node-gyp cannot
  cross-compile, so the build died there.

  `electron-builder.yml` now sets `npmRebuild: false` — nothing in syncto needs
  rebuilding — and excludes both modules from the package, so a macOS `.node`
  binary can no longer be shipped inside a Windows application. ssh2 works
  without them: it wraps the require in a try/catch and falls back to its
  JavaScript implementation, losing only a CPU-feature probe used to pick an
  accelerated cipher.

  Reproduced and fixed against a real cross-build, not reasoned about: the same
  error first, then a Windows package that contains neither module.

### Added — signed and notarized macOS builds

With a **Developer ID Application** certificate in the keychain, `./build.sh`
and `scripts/build-mac.command` now sign the application, send it to Apple for
notarization, and attach the returned ticket to **both** the app and the disk
image. It opens with a plain double-click on any Mac, with no internet
connection needed on first launch.

**Set it up once**, before the first signed build:

```
./build.sh --sign-setup      # or double-click scripts/notarize-setup.command
```

It checks the four things that have to be true and stops at the first that is
not — macOS, Apple's command line tools, a *Developer ID Application*
certificate, and credentials Apple actually accepts. Thirty seconds, instead of
finding out five minutes into a build. It is also the diagnostic: run it any
time, it changes nothing that already works.

It is deliberately picky about the certificate. An *Apple Development* or *Mac
App Distribution* certificate signs the application perfectly and is then
refused by every other Mac, so when one of those is all that is installed the
script lists what it found and says so. And when Apple rejects the credentials
it names the three usual causes: an Apple ID password given instead of an
app-specific one, an Apple ID that does not belong to the certificate's team,
and a lapsed Developer Program membership — a certificate outlives it, and
notarization stops working while signing still appears to.

- The credentials go to the macOS keychain through
  `xcrun notarytool store-credentials`, under the name `syncto-notarization`.
  **Nothing is written into the project** — no file to add to `.gitignore`, no
  secret to leak into a release zip.
- The disk image gets its own trip to Apple. electron-builder notarizes the
  `.app`; the `.dmg` around it is a separate file that Gatekeeper checks when it
  is downloaded, and stapling it is what makes the first launch work with no
  network — which is exactly the situation syncto is used in.
- **Three outcomes, and the script says which one you got**: *notarized*,
  *signed but not notarized*, or *unsigned*. It then runs `spctl` and reports
  what a stranger's Mac will do with the file, because a build that is signed
  but not notarized looks perfect on the machine that made it and is refused
  everywhere else.
- None of it is mandatory. No certificate → an unsigned build, exactly as
  before. `SYNCTO_SKIP_SIGN=1 ./build.sh` forces one on purpose, and
  `SYNCTO_NOTARY_PROFILE` picks a different keychain profile.

The work lives in `scripts/notarize-lib.sh`, shared by both build entry points.

### Added — what macOS asks the user

The app now carries a usage description for removable volumes, network volumes,
Desktop, Documents and Downloads. macOS shows that sentence in the permission
prompt; without one it shows a blank, alarming dialog, and on some releases
refuses outright. A folder synchronizer lives on cards and NAS shares, so every
location it can legitimately be pointed at now explains itself.

---

## [0.5.4] — 2026-08-31

The screenshots in this README were taken on 0.2.x. Regenerating them against
the current build turned up three things that had gone stale in the interface
itself — which is the argument for regenerating them at every release, and for
doing it from the running application rather than by hand.

### Fixed

- **The connection window's boxes were white.** Login, Password, Private key and
  Name fell back to the browser's default styling and looked nothing like the
  rest of the application. The rule that styles a settings field was written
  `input[type=text]`, and none of those inputs spell out a type — `type`
  defaults to `text` when the attribute is absent, so the selector matched
  nothing. Present since the window was introduced in 0.3.0, on every platform.
- **"syncto-checksums.txt at the root of each target (SECURE only)"** — there
  has been one copy mode since 0.5.0. The label now says what the file is for:
  checkable months later.
- **The auto-sync confirmation said "verified copy"**, another leftover of the
  three-level era. It now says every file is read back and compared, which is
  the only thing syncto does.

### Screenshots

Ten of them, regenerated from the running application: main window, copy pass,
verification pass, run summary, the connection window, the filter, settings,
the after-the-run and phone-notification panel, the auto-sync confirmation, and
one machine waiting on another's lock. Two are new — the SFTP connection window
(0.3.0) and the ntfy panel (0.4.0) had never been shown.

`scripts/shots-linux.sh` produces them: it builds a demo dataset under
`/Volumes`, seeds a profile, launches the real application under Xvfb and drives
it through the DevTools protocol. Nothing is mocked up and nothing is drawn by
hand — the verification frame is a real verification pass, and the "another
machine is running" frame is a second process genuinely holding the lock, under
its own user, its own install id and its own machine name.

Two details that only matter to whoever runs the script next: the keyring has to
be unlocked inside the session bus, or the connection window is photographed
saying "this machine has no usable credential store" — true of a build
container, false of every Mac; and the copy pass is over in seconds on a fast
disk, so the capture loop polls the step strip rather than waiting politely.

The files are also about 60 % smaller than the ones they replace.

---

## [0.5.3] — 2026-08-31

One defect, reported from a real backup: every folder on an HFS+ backup volume
refused to be removed, run after run, with `ENOTEMPTY: directory not empty` on a
folder Finder showed as empty. Fixed, along with the two other situations that
produced that same unreadable error.

### Fixed

- **A folder holding `System Volume Information` could never be removed.** That
  name is on the list syncto always ignores, so the comparison did not see it
  and the folder looked empty — but the routine that empties a folder before
  removing it only ever unlinked **files**. A directory with that name was
  therefore invisible to one half of the code and immovable by the other, for
  ever. Same trap for `.Spotlight-V100`, `.fseventsd` and `.TemporaryItems`.
  These folders are now taken with their parent: their contents belong to
  Windows or to macOS, never to the user, and the volume recreates them on the
  spot if it still wants them. Removal is recursive with a depth limit.
- **`.Trashes` and `$RECYCLE.BIN` are deliberately not swept.** They hold files
  somebody deleted and may want back, so a folder containing one is still
  refused — with an explanation rather than an error code.
- **`ENOTEMPTY: directory not empty` is gone from the interface.** What blocks a
  removal is now named: *"The folder could not be removed: it still contains
  "notes.bak". Those items are outside this synchronization — excluded by a
  filter, a symbolic link, or the volume's own recycle bin — so syncto will not
  delete them."* This covers the two other cases that produced the same opaque
  message: a file hidden by an exclusion filter, and a symbolic link (excluded
  from the comparison by default).

### Changed

- `.DocumentRevisions-V100` joins the always-ignored names. macOS version
  history is not something a backup should carry.

### Tests

15 new assertions, 8 of which fail on 0.5.2. The engine suite goes from 399 to
**414 checks**.

---

## [0.5.2] — 2026-08-31

A full audit of the code, and the fixes it produced. No new feature: 32 defects
found by reading every file, each one covered by a regression test that fails on
0.5.1. The engine suite goes from 356 to **399 checks**.

### Fixed — data safety

- **A missing drive could still lead to a mass deletion.** The guard that
  refuses a run when one side's root folder is gone ran *after* the folder
  locks were taken — and taking a lock creates the folder if it is not there.
  So the first attempt was refused, the mount point was created anyway, and the
  *next* comparison saw a legitimately empty folder and planned to delete the
  whole healthy side for real. The check now runs before anything is created.
- **A retry could bury the only good version.** With versioning on, a failed
  attempt archived the target, left a truncated fragment behind, and the retry
  archived *that* fragment over the version it had just put aside — every
  revision path in a run shares one timestamp. A file is now archived at most
  once per run.
- **A folder held back by a filtered file lost its checksum list.** Removing a
  folder swept its leftovers first and called `rmdir` afterwards. When the
  folder was not going away, `syncto-checksums.txt` had already been deleted
  for nothing, outside any deletion policy. `rmdir` is tried first now, and the
  sweep only runs when leftovers are all that stands in the way.
- **A move deleted the source without checking the copy.** Every other copy
  path verifies the size before committing; the one that then *unlinks* the
  original did not.
- **Two-way sync fell into a conflict it could never leave.** When the target
  refused to take the source's date — an SFTP server without `SETSTAT`, a FAT
  volume, or simply "preserve dates" off — the two recorded dates differed and
  the next run called it "both sides have changed". Conflicts are skipped, a
  skip leaves the database untouched, so the same conflict came back for ever.
  Entries written by a run of syncto's own are now marked as such.
- **A lost lock no longer writes its database over the new owner's.** Losing
  the lock mid-run means another machine owns those folders and may already
  have recorded its own state there.
- **A frozen network share went unnoticed.** The heartbeat counted failed
  writes, and a frozen mount does not fail — it blocks, for ever, so the
  counter stayed at zero while the lock file stopped growing and another
  machine legitimately took the folder. It now measures elapsed time since the
  last beat that actually landed.
- **A NAS with one stale empty folder to drop refused to run at all.** The
  recycle-bin preflight demanded a working bin for folder removals, which never
  use the bin.
- **Beyond a million items in one pair, ticking a row changed another pair's
  file.** The grid's global index wrapped. It now has a billion per pair, and
  an index it cannot decode acts on nothing.
- **Windows long paths were only protected at the root.** The root is usually
  short (`D:\Backup`); it is the tree *under* it that runs past 260
  characters. Every path built below the root now carries the prefix.

### Fixed — secrets

- **`sftp://user:password@host/folder` typed into a folder field is no longer
  stored as typed.** It was a legal path, so people used it — and it landed in
  `preferences.json`, in the `.syncto` file handed to a colleague, in reports,
  and in the phone notification. The password is now moved into the OS
  credential store on the way to disk and the path is redacted; the job keeps
  working.
- **The window no longer receives the encrypted blobs.** `load-prefs` handed
  over `servers[].passwordEnc` and `ntfy.tokenEnc` — decryptable by anything
  running as this user, which defeats the point of never sending the passwords
  themselves.
- **Migrating a machine with no credential store said nothing.** The old
  plain-text block was deleted, correctly, but the passwords went with it in
  silence. syncto now tells you, once, that they have to be typed again.
- **Repointing a saved server at another machine carried the old password to
  it.** The next Connect would have sent it to a host that never had it.
- **A password that cannot be read is no longer shown as remembered.**
  Preferences copied from another machine carry blobs this account cannot
  decrypt; the window promised a password, and the resulting authentication
  failure was blamed on the user's typing.
- **Two servers on the same host and login but different ports shared one
  password.** The credential key ignored the port, so only the last one
  survived.
- **"Saved" was announced even when nothing reached the disk.** A failed write
  is now reported.
- **An ntfy token with a non-ASCII character was silently mangled** into
  something the server answered 401 to. It is refused with an explanation
  instead.

### Fixed — interface

- **The countdown before shutting the machine down was invisible.** It sat
  behind the summary card, unclickable, while it ran.
- **A run that failed sent no phone notification** — the very run the person
  away from the screen most needs to hear about.
- **A failed notification was never mentioned**, so someone relying on it for
  overnight backups read silence as success.
- **The green "verified" shield from the previous run stayed under a red error
  card**, certifying something unrelated.
- **Shutting the machine down left the auto-sync switch on**, red frame and
  all, over a scheduler that would never fire again.
- **Editing a pair's folders did not invalidate the plan in memory.**
- **Removing a pair left the ✕ on pair 1 in the wrong state**, and clicking it
  emptied SOURCE and DESTINATION — and saved that.
- **Enter pressed twice on a slow connection opened two SSH sessions**, only
  the second of which was remembered; the first stayed open on the server until
  syncto quit. Guarded in the window *and* in the main process, which now also
  refuses to let a slow handshake overwrite a newer one.
- **Editing the address of a saved server browsed the old machine** while
  writing the new address into the job.
- **The Synchronize button was live during the preflight**, so a quick click
  started a run the check was about to refuse.
- **Clearing the ntfy token and pressing Test passed** — with the old token
  still attached.
- **Two verifications at once** shared one cancel token and one progress
  channel: closing the second cancelled the first, and the ring appeared to run
  backwards. The second is refused.
- **"Sleep" reported a failure on a machine that had slept exactly as asked.**
  On Windows the command does not return until the machine wakes up.
- **The checksum list used the canonical spelling of a name, not the one the
  file really has on that side**, which made Verify Folder report an intact
  accented file as missing on a byte-exact filesystem, and the manifest
  unusable with `xxhsum -c`.

### Changed

- `README.md` no longer refers to a "Secure level" — there is one copy mode
  since 0.5.0.

---

## [0.5.1] — 2026-08-31

A build fix. Nothing in the application changed — the 350 engine checks pass
identically.

### Fixed

- **`./build.sh` and `build-mac.command` failed on macOS** with
  `Exit code: 1. Command failed: which python`, after the application itself
  had already been built. electron-builder 24's `dmg-builder` shells out to
  `python` to assemble the disk image, and macOS has not shipped a binary by
  that name since 12.3 — only `python3`. Every recent Mac hit this.
  The build toolchain is now the one ingesto already runs on the same
  machines: **Electron 43.4.1 and electron-builder 26.15.3**. Version 26 of
  `dmg-builder` contains no reference to `python` at all.
- **A failed disk image no longer means an empty `dist/`.** The `.app` is built
  first and the `.dmg` is wrapped around it afterwards, so a failure at the
  second step used to throw away a finished application. Both build scripts now
  notice, pack the `.app` as a zip, and say so.

### Changed

- Electron 34 → 43, nine major versions. syncto uses nothing that moved:
  `safeStorage`, `shell.trashItem`, `powerSaveBlocker`, `webUtils`, the CSP and
  navigation guards all behave the same. The packaged application was built and
  launched under Electron 43 before this went out.
- macOS 11 and Windows 10 remain the floor, as before.

---

## [0.5.0] — 2026-08-29

One copy mode, and a verification you can see happening.

Reported as "the verification phase is not clearly shown to the user". Looking
into it turned up the reason: for two of the three copy levels there was no
verification to show.

### Changed — syncto has one copy mode

**Fast, Verified and Secure are gone. Every run copies, then reads everything
back and compares.**

The three levels had stopped being three things. Since 0.2.5 the size check ran
at every level — a fix for an SFTP hole where a truncated file could replace a
good one — and that check was the only thing Verified had over Fast. Measured
on 0.4.0, on the same file:

```
fast      copied: 1 · files read back and compared: 0 · work bytes: 5000
verified  copied: 1 · files read back and compared: 0 · work bytes: 5000
secure    copied: 1 · files read back and compared: 1 · work bytes: 10000
```

Two thirds of the choice was a choice between identical behaviours with
different names, and anyone on **Verified** — the reassuring middle option —
was getting a copy nothing had verified. A folder synchroniser for rushes has
no business offering "copy and hope".

**What this costs:** a run now moves twice the data, so it takes roughly twice
as long as a copy alone, and over SFTP the read-back crosses the network too.
Jobs already saved as `fast` or `verified` are pinned to the single mode when
they load — running weaker than the window now claims would be the worse
outcome. The copy-mode selector is replaced by a statement of what syncto does.

### Added — the verification is visible

- **The passes are shown as steps** — Copy → Verify · xxHash64 → Finish —
  from the moment SYNCHRONIZE is pressed, *before* either starts. A pass that
  only appears once it begins reads as a stall, which is exactly what was
  reported.
- The step that is running is lit in its own colour, the ones behind it are
  ticked. Same colour code as ingesto: copying green, reading back blue.
- **The summary states what was checked**, in a line at the top: *"128 files
  read back and verified — every file was copied, then read from its final
  location and compared with the xxHash64 fingerprint taken while writing. Not
  one differed."* A verification failure turns that line red and says how many.
- **The HTML report carries the same sentence**, since the report is the
  artefact a DIT keeps and shows a client. It also carries the verified count
  as a field.
- **The phone notification says it too** — `✓ 128 read back and verified
  (xxHash64)` rather than a bare "done". The whole point of the notification is
  that nobody is at the screen.

### Tests

350 checks, up from 327. The new ones pin the single mode from every angle: an
old `fast` or `verified` job is loaded as secure, every run reads back what it
wrote whatever the file asks for, the work counter accounts for both passes so
the ring cannot freeze at 50%, and the report states the verification without a
trace of the old middle level.

---

## [0.4.0] — 2026-08-28

Two ways of walking away from a long run: let the machine finish and switch
itself off, and be told on your phone when it is done.

Nothing in the synchronization engine changed. Jobs, databases and checksum
lists carry over untouched.

### Added — after the synchronization

- **Do nothing · Quit syncto · Sleep · Shut down**, in Settings. The action is
  saved with the job, so an overnight backup can be set once.
- **It only fires on a clean run.** An error, a cancellation, a stop, or a lost
  folder lock leaves the machine alone — otherwise the summary you need to read
  disappears with it. When it is skipped, the status line says so.
- **A 30-second countdown with a Cancel button** comes first, every time, with
  a *Do it now* if you are watching and impatient. Escape cancels. This is the
  part FreeFileSync does not have, and the reason its shutdown option is the
  one people ask to turn off.
- Auto-sync is disarmed when the action fires: a machine that shuts down is not
  going to run the next cycle.
- **There is no hibernate entry, on purpose.** macOS has no such command —
  `hibernatemode` describes what the Mac does *during* sleep, it is not
  something you can ask for — and on Windows `shutdown /h` only works when
  hibernation is enabled, which it is not by default on machines with fast
  startup. An entry that silently does something else on half the machines is
  worse than no entry. FreeFileSync draws the same line.
- Nothing here needs an administrator password, and nothing forces applications
  to quit: on macOS the shutdown is the same request the Apple menu makes, so
  another app with unsaved work can still stop it.

### Added — phone notifications (ntfy)

The same mechanism as ingesto, deliberately: a plain POST to
`<server>/<topic>`. No account, no SDK, no dependency, and whatever is
subscribed to that topic — the free ntfy app on a phone, a browser tab —
receives it.

- Settings carry the **server** (`https://ntfy.sh` by default, or your own),
  the **topic**, an optional **access token** for a server that needs one, a
  **Send a test** button, and a QR code to install the app.
- A notification goes out **after every run**, with the job name in the title,
  what was copied, how long it took, and the first error if there was one.
  Failures are raised in priority so the phone actually rings, and tagged so
  the app shows the right icon.
- **Only when there is a problem** is a switch, for people who only want to
  hear from a backup when it goes wrong.
- Sending never blocks and never fails a run: one retry two seconds later, then
  silence.
- **The access token is stored like every other secret in syncto** — encrypted
  through the OS credential store, never readable on disk, and never handed to
  the window, which only learns that one exists.
- Title, Tags and Priority are stripped to printable ASCII before they are
  sent. They are HTTP *header* values, where a single accent or emoji throws
  `ERR_INVALID_CHAR` and loses the entire notification, body included. The
  message body keeps everything — it travels as UTF-8 in the request body.

**Worth knowing about the public server:** on `ntfy.sh` the topic *is* the
password. Anyone who guesses it can read your notifications, so make it long
and unguessable. The settings panel says so.

### Tests

327 checks, up from 292. The platform commands are asserted rather than run —
a test suite that puts the machine to sleep is not a test suite.

---

## [0.3.1] — 2026-08-28

A job that could not run at all against a NAS, and an overview panel nobody
could read. Nothing in the synchronization engine's decisions changed, so 0.3.0
jobs, databases and checksum lists carry over untouched.

### Fixed

- **A mirror to a NAS did nothing at all.** Reported from a real run: *Completed
  with 2 errors*, 0 files copied, 0 items removed, 0 s.
  Two things combined. `supportsTrash()` answers "yes" for every local path,
  which is a guess — macOS and Windows both refuse to move a file to the trash
  on most network shares. And 0.2.5 had just made "ignore errors" real, so the
  first refusal stopped the whole run before a single file was copied.
  syncto now **probes the recycle bin once, before the run**, by trashing a
  file of its own, and refuses up front — naming the folder and the two
  settings that fix it, worded exactly as they read on screen. The confirmation
  dialog runs the same check, so it is said while the settings are one click
  away instead of after a run that did nothing. A destination that *does* have
  a working bin is not slowed down or blocked, and a job with nothing to delete
  or replace is never checked at all.
- **"Ignore errors" is on by default again.** 0.2.5 made the setting real for
  the first time — it had been stored, loaded and read nowhere — and left it
  off, which turned one unreadable file into a job that copied nothing. That is
  the wrong trade for a backup tool. A run works through what it can and lists
  the failures at the end; untick it for a run you are watching and want
  stopped at the first problem.
  A job saved before 0.3.1 carries a `false` nobody chose, since the setting
  did nothing when it was written; it is corrected on load. Jobs now carry a
  revision marker so a deliberate choice made from here on is kept.

### Changed — the overview panel

- **One block per folder pair, with its label.** Every row in the overview is a
  *top-level* entry of its own pair — but with several pairs, the lists were
  merged and sorted by size together, so a root folder of pair 2 landed between
  two root folders of pair 1 with nothing on screen saying so. It read as an
  arbitrary mix of roots and sub-folders: `Resolve`, a root of
  `_GOODIES → public`, sat among the roots of `MEDIAS_RAID0 → TNAS`, and the
  only clue was a tooltip you had to hover. Pairs keep their own block now, and
  rows are sorted by size *within* a pair.
- **Clicking a folder shows its contents in the grid.** The panel is a
  navigator, not a legend: click a row and the grid is limited to that folder
  and everything under it. A bar above the grid says what is being shown, with
  one button back to everything; clicking the same row again clears it too.
  Prefix names are handled properly — `Rush` does not also pull in `Rushes`.

### Tests

292 checks, up from 268. The new ones reproduce the NAS run that copied
nothing, cover a working bin and permanent deletion so the check cannot become
a nuisance, and pin the overview scope including the prefix case.

---

## [0.3.0] — 2026-08-22

Reaching a server no longer means typing an `sftp://` URL from memory into a
field that otherwise expects a local path. And passwords are no longer stored
in a readable file.

Jobs (`.syncto`), sync databases (`.syncto.db`) and checksum lists are
unchanged. The preferences file changes shape once, on first launch.

### Added

- **A server button in every folder field.** The Lucide *server* glyph, beside
  **Browse**, in Source, in Destination, and in every additional pair. It opens
  a window that asks for the address, the port, the login, the password or a
  private key — and then lets you walk the server's folders and pick one. The
  field still ends up holding an `sftp://` URL, so existing jobs and the engine
  are untouched; nobody has to write one any more.
- **A remote folder browser.** One level at a time, with a clickable path and a
  **New folder…** button, because "the destination does not exist yet" is the
  normal state of a new backup target. Only folders are listed — a destination
  is a folder, and listing the files of a rushes directory would mean tens of
  thousands of unpickable rows.
- **Saved servers.** Named, listed at the top of the window, one click to fill
  everything in. This is what actually removes the friction: without it, typing
  a URL would just have become filling five boxes.
- **A private key field**, next to the password. The engine already accepted
  one; there was no way to enter it. Only the path is stored, never the key.
- **Connection errors in plain language.** ssh2 says "All configured
  authentication methods failed"; syncto now says which login was refused and
  what to check. Same for a wrong port, an unreachable host, and a timeout.

### Changed — worth knowing

- **Passwords move to the operating system's credential store.** Up to 0.2.6
  they sat in `preferences.json` in plain text. They are now encrypted through
  Electron's `safeStorage`, which is backed by the **macOS Keychain** and by
  **DPAPI on Windows**. On first launch, any password already in that file is
  moved and the readable copy deleted; a `password` key cannot survive a write
  from then on, whatever puts it there.
  **The deliberate limit:** if a machine has no usable credential store, syncto
  does *not* fall back to writing the password down. It says so in the window
  and asks each time.
  **Why not keytar,** the usual answer to this: it is a compiled native module.
  syncto has none, and that is precisely why a Windows build can be produced
  from a Mac. One native dependency would have ended cross-building — for a
  password field.
- **A remembered password never reaches the interface.** It is decrypted in the
  main process, used for the connection, and dropped. The window only ever
  learns that a password exists.
- The URL written into the field carries the login and the host, never the
  password — it is displayed, saved into `.syncto` files, and printed in
  reports.
- The placeholder in both fields no longer advertises URL syntax.

### Fixed

- `SftpFs` gained `realpath`, so the browser opens in the login directory
  instead of at `/` on an archive server with two hundred entries at the root.

### Tests

268 checks, up from 244.

---

## [0.2.6] — 2026-08-22

Two interface fixes. Nothing in the synchronization engine changed, so 0.2.5
jobs, databases and checksum lists carry over untouched.

### Fixed

- **"Show identical" came back ticked at every launch.** Clicking the
  *identical* chip in the statistics bar switched it on behind the user's back
  — the window's way of making those rows visible — and the next write to
  `preferences.json` made that permanent. Nothing ever switched it off again,
  and nothing said it had happened, so the setting looked like it defaulted to
  on. Filtering on that chip now tells the engine to include those rows
  directly, and the switch stays exactly where you left it. On first launch of
  0.2.6, a value stored by the old behaviour is cleared once (the preferences
  file carries a revision number for this); anything you set deliberately
  afterwards is kept.
- **The overview listed every folder even when there was nothing to do.** Zone
  2 walked the whole compared tree, so two folders already in sync still filled
  it with rows and percentage bars describing work that did not exist. A folder
  now has to carry actual work to appear, and its size is the data that will
  really cross — not the size of what is already sitting there, which made the
  bars meaningless. Two folders in sync leave the panel empty, with one line
  saying so. Ticking **Show identical** puts the whole tree back, for when you
  want to click a folder that is *not* changing and find it in the grid.
  A deletion still shows its folder, at zero bytes: it is work, but nothing
  travels.

### Tests

244 checks, up from 228. Six cover the overview and the switch.

---

## [0.2.5] — 2026-08-20

A full audit of 0.2.4 and the repair of everything it found: 36 issues, six of
which could lose data. The engine test suite grows from 179 to 228 checks;
every fix below has a regression test that fails on 0.2.4.

Jobs (`.syncto`), sync databases (`.syncto.db`) and checksum lists carry over
untouched.

### Fixed — data loss

- **An unmounted source folder made a mirror delete the whole target.** The
  comparison recorded "Left folder not found — it will be created" without
  marking it fatal, so an absent base folder (ENOENT — an ejected drive, a
  dropped share) read as an empty side, every file on the healthy side became
  one-sided, and mirror removed the lot. A missing base folder now stops the
  run whenever the plan would delete anything on the other side, and says which
  side is gone. Creating a missing *target* still works exactly as before.
- **Overwriting destroyed the replaced version in silence.** `archiveExisting`
  returned quietly where the delete path throws: with "keep every version"
  selected and a revision folder set on one side only — which `migrateJob`
  allows, since it only falls back to the trash when *both* are empty — the
  file being replaced was simply gone. Same hole when the location has no
  recycle bin (SFTP, most NAS) or the bin refused the item: the return value
  was never checked. An overwrite is a deletion with a copy on top, and it now
  gets the same guarantees — if the previous version cannot be kept, the copy
  is refused and the target keeps its content.
- **Swapping the two sides did not invalidate the comparison.** The engine
  looped over the folder pairs memorised at the last comparison and never
  looked at the ones on screen, while the confirmation dialog read the new
  ones. Swapping the sides to restore B onto A therefore mirrored A onto B.
  Same for editing a path or loading another job — which also brought that
  job's `deletion` setting, turning planned trash removals into permanent ones.
  The engine refuses a plan whose folders have changed, and the window clears
  the plan as soon as they do.
- **A machine was identified by hostname and user name.** Two Windows PCs
  deployed from one image, or two Macs on their factory name, matched — so each
  read the other's *live* lock, checked that process id against its own process
  table, found nothing and took the folder. Both then wrote the same files.
  Every installation now carries an id of its own (`~/.syncto/install-id`); a
  lock that cannot be proved ours takes the slow, always-correct path of
  watching for twelve seconds of silence.
- **A dropped SFTP connection froze the run for ever.** ssh2 discards requests
  issued on a closed channel without ever calling back, so the first operation
  after a sleeping laptop or a lost Wi-Fi blocked the request queue — and with
  it the whole run — with no error, no progress, and an Abort button that could
  not fire. The channel is now watched, every request carries a deadline,
  transfers in flight are torn down with a real error, and a connection that
  never became usable is closed instead of being left running.
- **The heartbeat never re-checked ownership, and release deleted whatever was
  there.** If the share went away for longer than the abandonment window,
  another machine legitimately took over — and the old owner carried on
  writing, its blind append feeding the *new* owner's lock file, then deleted
  that lock at the end of its run and let a third machine in. The heartbeat now
  verifies the lock is still ours and stops the run when it is not; release
  only removes a lock it still owns.

### Fixed — silent failures

- **`preserveTimes: false` made two-way jobs copy the same file for ever.** The
  database recorded the source's date as the target's, so both sides looked
  changed at every run and the file bounced back and forth — and became a
  permanent conflict if it was edited in between.
- **A cancelled comparison was presented as a complete one.** The byte-for-byte
  comparison returned "different" for files it had not finished reading, the
  walker left the tree truncated, and the timestamp was set anyway, so
  SYNCHRONIZE came back enabled on a partial plan and the summary said
  "Completed successfully". An interrupted comparison is now marked as such,
  the grid says the list is partial, and synchronizing is refused.
- **"Ignore errors" was never read.** The checkbox was saved, loaded and passed
  to the engine, which referenced it nowhere: the run always carried on.
  **Behaviour change worth knowing:** the setting is off by default, so a run
  now stops at the first error instead of pushing through. Stopping is
  graceful — the database and the report are still written from what really
  happened. Tick "ignore errors" for the old behaviour.
- **A database that could not be written was a footnote.** It was recorded as a
  note, not an error, so the report showed "Completed successfully" — and the
  next two-way run, reading yesterday's state, put back the file you had just
  deleted. It is now an error, counted and reported.
- **`.syncto.db` was rewritten in place.** The stream truncated it on open, and
  a single file holds the history of every pair based in that folder, so an
  interrupted write silently reset all of them to "no database yet". It is
  written beside and renamed, like everything else the engine writes. A
  database that exists but cannot be read is now reported as damaged rather
  than as missing.
- **Deleting a folder through the recycle bin took the filtered files with
  it.** The trash path bypassed the sweep that removes only OS litter and lets
  `rmdir` fail loudly on anything else, so files hidden by an exclude filter —
  excluded precisely so syncto would not touch them — went to the bin inside
  their parent folder.
- **A truncated file could replace a good one at the fast copy level.** ssh2
  reports a write as finished before the server has acknowledged the close, and
  a quota or disk-full error arrives in that acknowledgement. The size check
  before the rename now runs at every level; one stat against a whole file copy
  costs nothing.
- **Verification could not report that it had not verified anything.** The
  cache flush swallowed its own failure, including the EACCES it hit whenever
  `copyPermissions` had just made the file read-only. It reports now, and the
  run says so once. Worth knowing, and deliberately not overstated in the
  interface: fsync guarantees the data left the write cache; it does not
  invalidate the read cache, and Node offers no portable way to do that. The
  secure level catches a truncated or mis-written file. It is not a media test.
- **Replacing a file over SFTP deleted the target before renaming.** Between
  the two there is a full network round trip; a connection that dropped in that
  window left nothing at the destination — old version deleted, new one still
  under its temporary name. The old file is moved aside instead, and put back
  if the rename does not go through.
- **A stray takeover file blocked every lock, for ever.** The takeover always
  renamed to the same name and deleted it best-effort; one interruption left
  the file behind, and since SFTPv3's rename refuses an existing target, every
  later takeover failed silently and the window sat on "Waiting for…" until
  someone deleted the file by hand on the server. Several slots are tried now,
  a stale one is cleared, and a takeover that genuinely cannot proceed says so
  with the path to fix.
- **`renameStrict` was a plain rename**, which overwrites the target silently on
  both POSIX and Windows — so the "exactly one machine wins" guarantee the lock
  is built on was not true. It uses a hard link and fails with EEXIST, falling
  back to check-then-rename only where links do not exist.
- **A folder that could not be listed was synchronized without a lock.** A
  catch-all treated a permission error or a network hiccup as "does not exist
  yet" and skipped the lock in silence. Real errors surface, and a folder that
  genuinely is not there yet is created and locked — two machines starting
  their first backup into the same new share were both unprotected until the
  second run.
- **Accented file names were duplicated on Linux servers and Windows shares.**
  macOS hands back decomposed names (NFD); the destination path was built from
  the source spelling, so a file already there in composed form (NFC) got a
  twin — and the run after that reported the pair as differing only by case and
  stopped synchronizing one of them. Each side now keeps the spelling it really
  has on disk, and the key shared by the two sides is the composed form.
- **A failed SFTP connection stayed alive.** Ten attempts against a
  misconfigured server left ten sockets and their keepalive timers running
  until the app quit, and the server started refusing everyone. The failure is
  no longer cached either, so a retry after the network comes back is a real
  retry.
- **Symlinks were re-copied at every run.** The recreated link carried today's
  date and there was no `lutimes` to fix it, so it looked newer for ever — and
  under versioning, a revision was archived every night. The date is set on the
  link itself now, and where that is impossible (SFTP) the comparison asks what
  the two links point at before calling one newer.

### Fixed — the application itself

- **No content security policy, no navigation guard.** The window holds the
  whole IPC bridge — reading any folder, running a file with its default
  application, the stored SFTP credentials — and Electron's default for a
  window-open handler is "allow", so a child window would have inherited the
  preload. Dropping an `.html` file on the window during the moment before the
  drop zones are installed navigated the main view, and the page that loaded
  kept the bridge. A policy is now applied as both a meta tag and a response
  header, navigation is confined to syncto's own page, external links go to the
  browser, and `<webview>` is refused outright.
- **`shell.openExternal` accepted any scheme, from a remote JSON.** The update
  notice passed the URL out of `version.json` straight to the operating
  system's "open this" machinery; a `file://` or UNC value there means "run
  this program". Only http and https are opened, the notice always points at
  the releases page, the response body is capped, redirects may not leave the
  host, and the callback can no longer fire twice.
- **`preferences.json` and `.syncto` files were written in place.** An
  interruption left a truncated file: a blank application on the next launch —
  recent jobs, window size and SFTP credentials gone with no message — or the
  user's own job file destroyed. Both are written beside and renamed.
- **Resizing the window wrote the whole configuration to disk on every pixel.**
  No debounce, a deep merge and a *synchronous* write, in the process that runs
  the synchronization: dragging a corner during a large transfer stalled the
  event loop, the progress updates and the throughput. Debounced to 400 ms.
- **Saving could replace an existing job without asking.** The dialog checked
  the name typed, then the code appended `.syncto` to it — so the system's
  overwrite warning never applied to the file actually written. syncto asks.
- **The re-comparison after a run left the buttons live.** It never claimed the
  busy flag, so a second comparison could start and close the filesystem pool
  underneath the first one.
- **Any failure to open a recent job deleted it from the list.** An unmounted
  share or a damaged file was read as "the file is gone" and the entry vanished
  without a word. Only a genuine ENOENT drops an entry; anything else is
  reported and the entry kept.
- **A hand-edited job file could freeze the window.** A `null` section replaced
  a whole default and the redraw threw halfway through, with the path fields
  already updated and the rest still showing the previous job. Sections are
  validated on load.
- **`lastJobPath` was written and never read**, so a restart detached the
  settings from their file: the title said "not saved yet" and Ctrl+S asked for
  a name again — the short road to overwriting a different job.
- **Failed copies were counted as copies.** Reports read "Files copied: 10 ·
  Errors: 3" with the number that actually landed appearing nowhere. The
  summary shows "Files not copied" separately.
- **Leftover `.syncto_tmp` files were never removed.** Invisible to the
  comparison by design, swept by nothing: an interrupted 180 GB copy sat on a
  NAS for ever and the space disappeared with no explanation in the app. They
  are removed at the end of the next run, and the run says how much it
  reclaimed.
- **The size filter judged a two-sided file on the left copy alone**, so a file
  edited yesterday on the right was dropped because the left copy was a year
  old. Either side passing is enough.
- **An interrupted revision kept a good version's name.** `pipe` does not
  forward errors, so a broken read left a truncated file in the revision store,
  indistinguishable from a valid one when restoring. Revisions are written
  beside, size-checked, then renamed.
- **Windows long paths.** `.syncto_tmp` adds twelve characters, enough to push
  a legal name past 260 and fail the copy with ENOENT on a path plainly visible
  in Explorer. Long paths get the `\\?\` prefix.
- **A file named `a\b.txt` on a Linux server was treated as a path.** The SFTP
  backend translated every backslash into a separator. It no longer does —
  these are POSIX paths.

### Files

Two new names to know: `~/.syncto/install-id`, the per-installation identifier
the lock uses, and `*.syncto_old`, a target parked for a moment while its
replacement is renamed over it on SFTP. A stray one is swept like any leftover.

### Documentation

`docs/AUDIT-0.2.4.md` records the audit itself: every issue with its file, its
line and the situation that triggers it.

---

## [0.2.4] — 2026-08-10

### Fixed
- **The first folder pair could not be removed.** Pairs 2 and beyond had a ✕
  button; pair 1 — the big SOURCE/DESTINATION fields — did not, so a
  multi-pair job could never drop back below its original first pair. Pair 1
  now shows the same ✕ as every other pair, hidden only when it is the job's
  last remaining pair (exactly like the others). Removing it promotes pair 2
  into the main fields, same as removing any other pair shifts the ones below
  it up.

---

## [0.2.3] — 2026-08-09

### Changed
- **New application icon.** The Lucide-derived glyph on a dark rounded square is
  replaced by the Just Edit artwork: a violet folder with the sync arrows, drawn
  as a shape on a transparent background. Every embedded asset is regenerated
  from `build-resources/icon.svg` — `icon.icns` (10 representations up to
  1024 px), `icon.ico` (16 → 256 px), the 1024 px master and the Linux set.
  Nothing else in the build configuration changes.
  **Worth knowing:** macOS caches application icons aggressively. If the old one
  survives an upgrade, move the `.app` or run `killall Dock`.

### Fixed
- **Warning text was broken mid-word.** The warning block in the confirmation
  dialogs (auto-sync, copy errors) used `word-break: break-all`, which is right
  for file paths and wrong for sentences: the auto-sync warning read
  `with th / e current settings` and `as a r / eminder`. It now uses
  `overflow-wrap: anywhere`, which only breaks a word that genuinely does not
  fit, so paths still wrap and prose reads normally.

### Tooling
- `scripts/gen-icons.py` regenerates every icon asset from the SVG on any
  platform (needs `cairosvg` and `pillow`); `scripts/make-icon.sh` stays the
  macOS path and now prefers `rsvg-convert` over `qlmanage`, which could flatten
  the transparent background into white.
- `scripts/shots.js`, `scripts/shot-steps.js` and `scripts/shot-dataset.sh`
  produce the README screenshots by driving the real application through the
  DevTools protocol. No screenshot is retouched and nothing in the shipped code
  is modified to accommodate them.

### Documentation
- Screenshots retaken at 1440×900 @2×, on a two-pair job with realistic paths
  and file names. Three new ones: the copy phase, the verification pass and the
  end-of-run summary.

---

## [0.2.2] — 2026-08-08

### Changed
- **Verification is now a second pass, like ingesto.** Every file is copied
  first; only once the whole copy phase is finished does syncto read everything
  back and compare fingerprints. It used to verify each file inline, before
  giving it its final name.
  **Consequence worth knowing:** a file that fails verification already carries
  its final name, so it has already replaced the previous version. It is
  reported as an error, excluded from the checksum list, and deliberately *not*
  recorded in the synchronization database — the next run looks at it again. The
  cheap size check still runs before the rename, so a truncated copy never lands
  under a good name.

### Fixed
- **The verification pass was invisible.** Only the written bytes counted
  towards the progress, so the ring froze during the read-back and nothing said
  why. Verification is now half of the planned work and has its own phase,
  styled like ingesto: the title reads `VERIFYING · SECURE` and the ring, the
  top bar and the label turn blue. Speed and ETA include the verification I/O,
  which is what actually determines how long a secure run takes.
- The summary now reports how many files were verified.

### Fixed by the full-code review (32 regression tests added)

*Data safety*
- **An unreadable folder was treated as an empty one.** A permission error or a
  dropped network share during the comparison made every file on the healthy
  side look one-sided — and a mirror would have deleted them. Unreadable
  directories are now a fatal comparison error: the affected subtree is left
  out entirely, and synchronizing on top of a broken comparison is refused (the
  auto-sync skips it too). The same rule now applies to `stat` on both backends:
  "permission denied" is an error, never "absent".
- **A name-only include filter synchronized almost nothing.** Include `*.jpg`
  pruned every folder (no folder is named `*.jpg`), so files in subfolders were
  never reached. Name-only include masks no longer prune folders.
- **Two-way: a file identical on both sides but unknown to the database was an
  unresolvable conflict** ("both sides have changed", forever, since conflicts
  are skipped and skipping preserves the stale entry). Identical-right-now is
  now in sync, whatever the database believed.
- **Two-way: folder mtime drift produced perpetual folder conflicts.** Folder
  dates carry no sync meaning and are now ignored by the database check.
- **Cancelling a run threw everything away.** The database and the report were
  skipped, so the next two-way run re-discovered (and could mis-judge) work
  that had actually completed. A cancelled run now ends cleanly: partial
  results, report and database are all written.
- The failure of a "preserve the date" step is now noted, and the database
  records the target's real date — it used to record the wish, guaranteeing a
  spurious re-copy.
- The move fallback (when a rename is refused) now goes through the fail-safe
  temp file like every other copy.

*Locking*
- The takeover of an abandoned lock over SFTP could fall back to a
  delete-and-retry rename, breaking the one guarantee the rename provides (a
  single winner). Takeovers now use a strict rename on every backend.
- Locking a destination folder that does not exist yet made the first sync into
  it fail; such folders are now skipped (the run creates them).
- A generic SFTP failure during lock creation (reported as "exists" by SFTPv3)
  caused a sleepless retry loop; the acquire now paces itself and gives up with
  the real error after a few attempts.
- The heartbeat could recreate the lock file just after release; release now
  waits for the in-flight beat.

*Correctness & robustness*
- Legacy jobs: `copyLevel: "pro"` now maps to `secure` (it silently degraded to
  a FAST copy); `deletion: "versioning"` with no revision folder falls back to
  the trash.
- The checksum sidecar is merged run after run instead of being overwritten
  with only the latest run's files.
- Database entries hidden by the current include/exclude filter keep their
  history instead of being erased.
- Overwriting a symlink no longer fails with EEXIST (and a dangling symlink at
  the destination is no longer mistaken for an absent file).
- A folder containing only OS litter (`.DS_Store`, `Thumbs.db`…) can now be
  deleted permanently.
- Two names differing only by upper/lower case are reported instead of silently
  colliding.
- Multi-pair: errors were counted twice; one failing pair discarded the results
  of the pairs already done; the progress ring mixed two byte units during a
  secure run and could jump backwards; a job-level pair id made pairs sharing a
  base folder overwrite each other's database session. All fixed.
- A failed or cancelled comparison no longer leaves the previous "compared"
  state standing.
- Interface: quotes in file names could break out of HTML attributes; Escape
  now goes through each dialog's own close logic (settings persist, filter
  re-compares, verify cancels); the cleanup phase no longer claims to be
  copying; the row selection is dropped when the tree is re-compared.

### Removed
- **The PRO copy level**, and everything that existed only for it: the
  xxHash128 / MD5 / SHA-256 selector and the always-on checksum sidecar. SECURE
  covers the same ground with xxHash64, and the checksum list stays available as
  a switch in the settings. Jobs saved with `copyLevel: "pro"` are migrated to
  SECURE automatically.
- Dead code swept out: unused backend methods (`statFollow`, `freeSpace`),
  unused exports (`ALGOS`, `VARIANTS`), orphan CSS rules, a stale preference
  key, and the `--pro` colour variable (renamed `--violet`, which is what it
  is).

## [0.2.1] — 2026-08-08

### Added
- **Directory locking.** A `.syncto.lock` file at the root of each synchronized
  folder means one machine at a time. Ported from FreeFileSync's design, which
  needs no OS locking primitive and therefore works over SMB, AFP, NFS and SFTP:
  a heartbeat appends one byte every 5 s, a waiting machine polls every 2 s and
  presumes the owner dead after 12 s of silence. A lock left behind by a crash on
  the same machine is reclaimed immediately (the process id is checked directly);
  taking over an abandoned lock goes through an atomic rename to
  `Delete.0.<name>` so two waiting machines can never both proceed. The interface
  shows which machine and user is holding the run. Switchable off in the settings.

## [0.2.0] — 2026-08-08

### Added
- **Multi-pair jobs.** One job synchronizes any number of folder pairs, all
  sharing the same settings, in a single compare/synchronize. Each pair has its
  own row of SOURCE/DESTINATION fields; the merged grid separates them with a
  header line, and statistics, overview and report are aggregated.
- **Moved-file detection.** A renamed or moved file is recognized by its file id
  and replayed as a rename on the other side — a folder reorganization costs
  seconds instead of a full re-copy. Requires one previous run of the pair and a
  filesystem exposing inodes (not SFTP).
- **Auto-sync.** Compare + synchronize every N minutes, armed only after an
  explicit confirmation, with the window framed in red while it runs. Never arms
  itself: a restart always starts disarmed.
- **Per-job filters** behind a funnel button, with a clarified anchoring rule —
  a pattern without `/` matches the item's name at any depth, a pattern starting
  with `/` matches one exact path.
- **Context menu** on grid and overview rows: exclude temporarily (Space),
  include via filter, exclude via filter — with ready-made patterns.
- **FreeFileSync converter** (`scripts/ffs-convert.js`): `.ffs_gui` / `.ffs_batch`
  to `.syncto`, all folder pairs included.
- Update check against `version.json` on this repository, with a dismissible
  notice.
- Resizable panels, drag and drop of a volume or folder anywhere in the window,
  version shown in the footer.

### Changed
- Job files use the `.syncto` extension; the file name IS the job name.
- Interface reorganized into four zones (jobs, overview, source, destination)
  with the synchronization modes on top and the copy modes at the bottom, in the
  ingesto button style.
- Colour code across the grid: green added, orange updated, red struck-through
  deleted, violet renamed — applied to the full path.
- Excluding a folder now excludes its whole subtree.
- Checksum list and report are off by default.

### Removed
- Versioning (revision folders), time tolerance, time shifts, symlink policy and
  the size filter are no longer exposed in the settings. The engine keeps safe
  defaults for the comparison ones.

## [0.1.0] — 2026-08-08

Initial release. Comparison (time & size, content, size), four synchronization
variants (2 Ways, Mirror, Update, Custom), synchronization database for two-way,
four copy levels up to xxHash128 with checksum sidecar, fail-safe copy,
include/exclude filters, HTML/CSV/JSON reports, SFTP support, folder verification
against a checksum list.
