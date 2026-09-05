# syncto 0.2.5

A repair release. 0.2.4 was audited end to end — engine, filesystem backends,
directory lock, Electron layer — and everything the audit found is fixed here:
36 issues, six of which could lose data. The engine test suite grows from 179
to 228 checks, and every fix has a regression test that fails on 0.2.4.

Nothing in the file formats changed. Jobs (`.syncto`), sync databases
(`.syncto.db`) and checksum lists carry over untouched.

## The six that could lose data

**An unmounted source folder made a mirror delete the whole target.** A base
folder that is *gone* — an ejected drive, a share that dropped — reads as an
empty folder, and an empty side plus a mirror is "remove everything on the
other side". The comparison even said so ("Left folder not found — it will be
created") without marking it serious enough to stop anything. It now stops the
run whenever the plan would delete something on the other side because of it.
Creating a missing *target* still works exactly as before.

**Overwriting destroyed the replaced version in silence.** With "keep every
version" selected and a revision folder set on one side only, the delete path
refused to run and the overwrite path shrugged — so the file being replaced
disappeared, with versioning explicitly on. Same when the location has no
recycle bin, or the bin refused the item. An overwrite is a deletion with a
copy on top, and it now gets the same guarantees: if the previous version
cannot be kept, the copy is refused and the target keeps its content.

**Swapping the two sides did not invalidate the comparison.** The engine
replayed the plan from the last comparison while the confirmation dialog showed
the folders currently on screen. Swapping the sides to restore B onto A
therefore mirrored A onto B. Editing a path or loading another job had the same
effect — and brought that job's deletion setting with it, turning planned trash
removals into permanent ones.

**A machine was identified by its hostname and user name.** Two PCs deployed
from the same image are both `WIN-DIT01\admin`, so each read the other's *live*
lock, looked for that process id in its own process table, found nothing, and
took the folder. Both then wrote the same files. Every installation now carries
an id of its own; a lock that cannot be proved ours takes the slow,
always-correct path.

**A dropped SFTP connection froze the run for ever.** Requests issued on a
closed channel never call back, so a sleeping laptop or a lost Wi-Fi left the
progress bar frozen with no error — and Abort could not fire either. Requests
now carry a deadline, the channel is watched, and transfers in flight fail with
a real error.

**The lock heartbeat never re-checked ownership.** A share that went away for
longer than the abandonment window let another machine legitimately take over,
while the old owner kept writing — and then deleted the new owner's lock at the
end of its run, letting a third machine in.

## One behaviour change

**"Ignore errors" now does something.** The checkbox was saved, loaded, handed
to the engine, and read nowhere: a run always pushed through every failure. It
is off by default, so **a run now stops at the first error**. Stopping is
graceful — the database and the report are still written from what really
happened, and the summary says why it stopped. Tick "ignore errors" in the
settings for the old behaviour.

## Everything else

Twenty-nine more, from a database rewritten in place to accented file names
duplicated on Linux servers, from a missing content security policy to a window
resize that stalled the transfer it was running. The full list, with the
situation that triggers each one, is in [`CHANGELOG.md`](../CHANGELOG.md); the
audit itself, with file and line numbers, is in
[`AUDIT-0.2.4.md`](./AUDIT-0.2.4.md).

## Two new file names

| File | Where | Why |
|---|---|---|
| `install-id` | `~/.syncto/` | identifies this installation to the directory lock |
| `*.syncto_old` | next to a file being replaced on SFTP | a target parked for a moment while its replacement is renamed over it. A stray one is swept like any leftover. |

## Downloads

| File | For |
|---|---|
| `syncto-0.2.5-mac-arm64.dmg` | macOS 11+, Apple Silicon |
| `syncto-Setup-0.2.5.exe` | Windows 10/11 x64, installer |
| `syncto-0.2.5-win-x64.zip` | Windows 10/11 x64, portable |

Both builds are unsigned. macOS: right-click the app, then **Open**, on first
launch. Windows: **More info → Run anyway** on the SmartScreen warning.

## Upgrading

Install over the previous version. Nothing needs migrating.

**Full changelog:** https://github.com/noar-justedit/syncto/compare/v0.2.4...v0.2.5
