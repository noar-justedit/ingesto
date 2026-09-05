Folder comparison and synchronization for video and audio professionals — the
FreeFileSync feature set, rebuilt from scratch with the ingesto interface.

This is the first public release. Before it, the whole codebase went through a
full review — 30+ bugs found and fixed, from the serious (an unreadable folder
could look empty and get its healthy twin mirrored away; a `*.jpg` include
filter synchronized nothing outside the root) to the cosmetic, each one covered
by a regression test. The engine test suite now runs 179 assertions.

## What it does

- **Compare** by modification time and size, byte for byte, or by size only.
- **Synchronize** in 2 Ways, Mirror, Update, or a Custom rule per category.
- **Multi-pair jobs** — one job holds any number of folder pairs, all sharing the
  same settings, compared and synchronized in one go.
- **Moved-file detection** — a renamed or moved file is recognized by its file id
  and replayed as a rename on the other side. Reorganizing 100 GB of rushes
  synchronizes in seconds instead of re-copying everything.
- **Three copy levels** — Fast, Verified (size check), Secure (xxHash64). Secure
  works in two passes like ingesto: copy everything, then read everything back
  and compare fingerprints, with an optional checksum sidecar you can re-verify
  months later.
- **Fail-safe copy** — data goes to a temporary file and is renamed into place
  only once complete and verified. A power cut leaves a stray temp file, never a
  half-written file wearing a good name.
- **Directory locking** — one machine at a time per folder. Another machine
  starting on the same folders waits and tells you who is running; a lock left
  behind by a crash is reclaimed automatically.
- **Auto-sync** — compare and synchronize every N minutes, armed only after an
  explicit confirmation, window framed in red while it runs.
- **Per-job filters**, include and exclude, editable by right-clicking any row.
- **Reports** in HTML, CSV and JSON, with every checksum.
- **SFTP** alongside local disks and mounted network shares.
- Trash or permanent deletion — always announced, never silent.

## Coming from FreeFileSync

`scripts/ffs-convert.js` converts your `.ffs_gui` and `.ffs_batch`
configurations into `.syncto` jobs, all folder pairs included:

```bash
node scripts/ffs-convert.js ~/FreeFileSync/*.ffs_gui -o ~/syncto-jobs/
```

Variants, filters and retry settings are translated. FreeFileSync's versioning
falls back to the trash — syncto has no revision folders.

## Install

Download the installer below, or build from source (Node.js required):

```bash
git clone https://github.com/noar-justedit/syncto.git
cd syncto && ./build.sh          # macOS · ./build.sh --win for Windows
```

**The builds are unsigned.**
macOS: right-click syncto → **Open** on first launch.
Windows: SmartScreen → **More info** → **Run anyway**.

## Known limitations

- No real-time folder watching yet (the RealTimeSync equivalent).
- No command-line batch jobs.
- FTP is not supported — SFTP only.
- Over SFTP: no move detection (no file ids) and no trash.
- SFTP passwords typed into a path are saved **in clear** inside the `.syncto`
  file, and the server's host key is not verified. See `SECURITY.md`.

## License

GPL-3.0-or-later. Behaviour modelled on
[FreeFileSync](https://freefilesync.org) by Zenju, also GPLv3 — no FreeFileSync
code is used; syncto is written from scratch in JavaScript on Electron.
App icon based on the `folder-sync` glyph from [Lucide](https://lucide.dev) (ISC).
