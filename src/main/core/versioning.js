/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// What happens to a file that a synchronization is about to remove or replace.
//
//   permanent  deleted outright. No way back.
//   recycler   moved to the system trash. Local volumes only — a NAS or an SFTP
//              server has no trash, so syncto falls back to versioning if one is
//              configured, otherwise it refuses and reports the item.
//   versioning moved into a separate folder you choose, under one of three
//              naming schemes:
//                replace          Revisions/sub/Sample.txt
//                                 (one slot per file, previous copy overwritten)
//                timestampFolder  Revisions/2026-08-08 143012/sub/Sample.txt
//                                 (one folder per run — easiest to restore)
//                timestampFile    Revisions/sub/Sample 2026-08-08 143012.txt
//                                 (every version side by side in place)
//
// The timestamp is computed once per run, so a single synchronization produces
// exactly one revision folder however long it takes.

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// "2026-08-08 143012" — 17 characters, sorts chronologically as plain text.
function runTimestamp(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

// rel uses '/' separators and is relative to the folder-pair root.
function versionedRelPath(rel, style, stamp) {
  const parts = rel.split('/');
  const name  = parts.pop();
  const dir   = parts.join('/');

  if (style === 'timestampFolder') {
    return (dir ? `${stamp}/${dir}/${name}` : `${stamp}/${name}`);
  }
  if (style === 'timestampFile') {
    const { base, ext } = splitExt(name);
    const newName = `${base} ${stamp}${ext}`;
    return dir ? `${dir}/${newName}` : newName;
  }
  return rel;   // replace
}

// Reverse mapping, used to prune old revisions.
const STAMP_RE = /(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})/;

function stampToDate(s) {
  const m = STAMP_RE.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

class Versioner {
  // opts: { fs, root, style, maxAgeDays, countMin, countMax, stamp }
  constructor(opts) {
    this.fs    = opts.fs;
    this.root  = opts.root;
    this.style = opts.style || 'timestampFolder';
    this.stamp = opts.stamp || runTimestamp();
    this.maxAgeDays = Number(opts.maxAgeDays) || 0;
    this.countMin   = Number(opts.countMin)   || 0;
    this.countMax   = Number(opts.countMax)   || 0;
    this._mkdirCache = new Set();
  }

  async _ensureDir(dirPath) {
    if (this._mkdirCache.has(dirPath)) return;
    await this.fs.mkdir(dirPath);
    this._mkdirCache.add(dirPath);
  }

  // Moves `srcPath` (an item inside a base folder) into the revision store.
  // Falls back to copy + delete when the two are on different volumes.
  async archive(srcFs, srcPath, rel) {
    const relOut = versionedRelPath(rel, this.style, this.stamp);
    const parts  = relOut.split('/');
    const target = this.fs.join(this.root, ...parts);
    await this._ensureDir(this.fs.dirname(target));

    if (srcFs === this.fs) {
      try { await this.fs.rename(srcPath, target); return target; }
      catch (_) { /* cross-device, fall through to stream copy */ }
    }
    // Same fail-safe rule as the sync engine: write beside the revision name,
    // check the size, then rename. A revision the user cannot trust is worse
    // than no revision — and the source is only unlinked once it is safe.
    const st = await srcFs.stat(srcPath);
    const tmp = target + '.syncto_tmp';
    try {
      await streamCopy(srcFs, srcPath, this.fs, tmp);
      const out = await this.fs.stat(tmp);
      if (!out || (st && out.size !== st.size)) {
        throw new Error(`Revision of ${rel} is incomplete (${out ? out.size : 0} of ${st ? st.size : '?'} bytes).`);
      }
      await this.fs.rename(tmp, target);
    } catch (err) {
      try { await this.fs.unlink(tmp); } catch (_) {}
      throw err;
    }
    if (st) { try { await this.fs.setMTime(target, st.mtime); } catch (_) {} }
    await srcFs.unlink(srcPath);
    return target;
  }

  // Prunes old revisions. Only meaningful for the timestamped styles.
  async prune(onNote) {
    if (this.style === 'replace') return 0;
    if (!this.maxAgeDays && !this.countMax) return 0;
    if (this.style !== 'timestampFolder') return 0;   // per-file pruning would mean a full walk

    let entries;
    try { entries = await this.fs.readdir(this.root); } catch (_) { return 0; }
    const versions = entries
      .filter(e => e.type === 'folder' && stampToDate(e.name))
      .map(e => ({ name: e.name, date: stampToDate(e.name) }))
      .sort((a, b) => b.date - a.date);      // newest first

    const doomed = [];
    if (this.countMax > 0 && versions.length > this.countMax) {
      doomed.push(...versions.slice(this.countMax));
    }
    if (this.maxAgeDays > 0) {
      const cutoff = Date.now() - this.maxAgeDays * 86400000;
      const keepMin = Math.max(this.countMin, 0);
      versions.forEach((v, i) => {
        if (i < keepMin) return;
        if (v.date.getTime() < cutoff && !doomed.includes(v)) doomed.push(v);
      });
    }

    let removed = 0;
    for (const v of doomed) {
      try {
        await removeTree(this.fs, this.fs.join(this.root, v.name));
        removed++;
        if (onNote) onNote(`Pruned old revision ${v.name}`);
      } catch (_) {}
    }
    return removed;
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────
// pipe() does not forward errors: a read that broke halfway left the write
// stream open and a truncated file sitting at the destination — under a
// revision name, indistinguishable from a good one when restoring. Settle
// once, tear both streams down, and report how many bytes really went through
// so the caller can check the size.
function streamCopy(srcFs, srcPath, dstFs, dstPath) {
  return new Promise((resolve, reject) => {
    const rs = srcFs.createReadStream(srcPath);
    const ws = dstFs.createWriteStream(dstPath);
    let bytes = 0, settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (_) {}
      try { ws.destroy(); } catch (_) {}
      reject(err);
    };
    rs.on('error', fail);
    ws.on('error', fail);
    rs.on('data', chunk => {
      bytes += chunk.length;
      if (!ws.write(chunk)) { rs.pause(); ws.once('drain', () => rs.resume()); }
    });
    rs.on('end', () => ws.end());
    ws.on('finish', () => { if (!settled) { settled = true; resolve({ bytes }); } });
  });
}

async function removeTree(fsx, p) {
  const st = await fsx.stat(p);
  if (!st) return;
  if (st.type !== 'folder') { await fsx.unlink(p); return; }
  let entries = [];
  try { entries = await fsx.readdir(p); } catch (_) {}
  for (const e of entries) await removeTree(fsx, fsx.join(p, e.name));
  await fsx.rmdir(p);
}

module.exports = { Versioner, runTimestamp, versionedRelPath, stampToDate, streamCopy, removeTree };
