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

// Native (local / mounted network) filesystem backend.
// Implements the abstract filesystem contract described in fs/afs.js.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const READ_BLOCK = 4 * 1024 * 1024;   // 4 MiB — good balance for spinning disks and SSDs

function typeOf(dirent) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory())    return 'folder';
  if (dirent.isFile())         return 'file';
  return 'other';
}

class NativeFs {
  constructor() {
    this.kind = 'native';
    this.sep  = path.sep;
  }

  // Identifies the physical device, used to cap parallel operations per drive.
  deviceKey(p) {
    if (process.platform === 'win32') {
      const m = /^([a-zA-Z]:)/.exec(p) || /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
      return 'native:' + (m ? m[1].toLowerCase() : p.slice(0, 3).toLowerCase());
    }
    // /Volumes/Foo/... on macOS, /media|/mnt/... on Linux — otherwise the root.
    const m = /^(\/(?:Volumes|media|mnt|run\/media)\/[^/]+)/.exec(p);
    return 'native:' + (m ? m[1] : '/');
  }

  displayName(p) { return p; }

  async connect() { /* nothing to do */ }
  async close()   { /* nothing to do */ }

  // Every path the engine builds below the root goes through here, which is
  // where the Windows long-path prefix has to be applied: the root itself is
  // usually short (D:\Backup) and it is the tree UNDER it that runs past 260
  // characters. Prefixing only in resolve() left every deep child unprotected.
  join(...parts)  { return this.longPath(path.join(...parts)); }
  dirname(p)      { return path.dirname(p); }
  basename(p)     { return path.basename(p); }
  isAbsolute(p)   { return path.isAbsolute(p); }

  // Turns "~/foo", "%VAR%/foo" and relative paths into an absolute path.
  resolve(p) {
    let s = String(p || '').trim();
    if (!s) return s;
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
    return this.longPath(path.resolve(s));
  }

  // Windows caps a path at 260 characters unless it carries the \\?\ prefix.
  // syncto appends ".syncto_tmp" to every target it writes, so twelve extra
  // characters could push a perfectly legal name over the edge and the copy
  // failed with ENOENT on a path the user could see in Explorer.
  longPath(p) {
    if (process.platform !== 'win32') return p;
    if (!p || p.length < 240 || p.startsWith('\\\\?\\')) return p;
    if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
    return /^[a-zA-Z]:\\/.test(p) ? '\\\\?\\' + p : p;
  }

  // The spelling this filesystem should be asked for when creating a name that
  // only exists on the other side. macOS hands back decomposed names (NFD) and
  // accepts either form; everything else is byte-exact, so a decomposed name
  // sent to a Linux server creates a second file beside the composed one.
  normalizeName(name) {
    return process.platform === 'darwin' ? name : String(name).normalize('NFC');
  }

  // lstat, not access: access() follows symlinks, so a dangling link would
  // read as "absent" — and then replacing it fails with EEXIST.
  async exists(p) {
    try { await fs.promises.lstat(p); return true; } catch (_) { return false; }
  }

  // Returns null when the item does not exist — and ONLY then. A permission
  // error must throw: "unreadable" reported as "absent" is how a sync engine
  // ends up deleting the healthy side. Never follows symlinks.
  async stat(p) {
    let st;
    try { st = await fs.promises.lstat(p); }
    catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
    return {
      type   : st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other',
      size   : st.size,
      mtime  : st.mtimeMs,
      mode   : st.mode,
      id     : (st.dev != null && st.ino != null) ? `${st.dev}:${st.ino}` : null,
    };
  }

  // [{ name, type, size, mtime, id }] — throws on unreadable directories so the
  // caller can record a proper error instead of silently syncing an empty tree.
  async readdir(p) {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const full = path.join(p, e.name);
      let st = null;
      try { st = await fs.promises.lstat(full); } catch (_) { /* vanished mid-scan */ }
      if (!st) continue;
      out.push({
        name : e.name,
        type : typeOf(e),
        size : st.size,
        mtime: st.mtimeMs,
        id   : (st.dev != null && st.ino != null) ? `${st.dev}:${st.ino}` : null,
      });
    }
    return out;
  }

  async readlink(p) { return fs.promises.readlink(p); }
  async symlink(target, p) { return fs.promises.symlink(target, p); }

  createReadStream(p, opts) {
    return fs.createReadStream(p, Object.assign({ highWaterMark: READ_BLOCK }, opts || {}));
  }

  createWriteStream(p) {
    return fs.createWriteStream(p, { highWaterMark: READ_BLOCK });
  }

  // Creates a file only if it does not exist yet — the atomic primitive the
  // directory lock is built on. Throws with code EEXIST when taken.
  async writeExclusive(p, buf) {
    await fs.promises.writeFile(p, buf, { flag: 'wx' });
  }

  async appendByte(p, byte) { await fs.promises.appendFile(p, byte); }

  async mkdir(p)  { await fs.promises.mkdir(p, { recursive: true }); }
  async unlink(p) { await fs.promises.unlink(p); }
  async rmdir(p)  { await fs.promises.rmdir(p); }

  async rename(from, to) { await fs.promises.rename(from, to); }

  // "Rename, and lose if the target already exists."
  //
  // This is the primitive the directory lock uses to decide which of two
  // machines wins a takeover, and a plain rename() is the wrong tool: POSIX
  // and Windows both let it OVERWRITE the target silently, so two machines
  // could each believe they had won. link() is atomic and fails with EEXIST,
  // which is exactly the contract. On filesystems with no hard links (FAT,
  // some SMB shares) fall back to check-then-rename — narrower, but the only
  // option there.
  async renameStrict(from, to) {
    try {
      await fs.promises.link(from, to);
      await fs.promises.unlink(from);
      return;
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
      if (!['EPERM', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'EMLINK', 'EACCES'].includes(err.code)) throw err;
    }
    try { await fs.promises.lstat(to); }
    catch (_) { await fs.promises.rename(from, to); return; }
    const e = new Error(`Target already exists: ${to}`);
    e.code = 'EEXIST';
    throw e;
  }

  async setMTime(p, mtimeMs) {
    const t = new Date(mtimeMs);
    await fs.promises.utimes(p, t, t);
  }

  // utimes follows symlinks — it would stamp the TARGET, not the link. Without
  // this a recreated link kept today's date, looked newer at every run, and
  // was copied (and archived, under versioning) for ever.
  async setLinkMTime(p, mtimeMs) {
    const t = new Date(mtimeMs);
    await fs.promises.lutimes(p, t, t);
  }

  async chmod(p, mode) { try { await fs.promises.chmod(p, mode); } catch (_) {} }

  // Push this file's dirty pages to the physical medium before it is read
  // back. Returns false when it could not be done, so the caller can say so
  // instead of presenting an unverifiable read as verified — a file copied
  // with copyPermissions and a read-only source mode used to fail the 'r+'
  // open with EACCES, and the error was swallowed on the spot.
  //
  // Worth knowing, and deliberately not overstated anywhere in the interface:
  // fsync guarantees the data left the cache on its way OUT. It does not
  // invalidate the read cache, and Node exposes no portable way to do that,
  // so the verification read may still be served from RAM on some systems.
  // It catches a truncated or mis-written file; it is not a media test.
  async flush(p) {
    for (const mode of ['r+', 'r']) {
      let fh = null;
      try { fh = await fs.promises.open(p, mode); await fh.sync(); return true; }
      catch (_) { /* try the next mode */ }
      finally { if (fh) { try { await fh.close(); } catch (_) {} } }
    }
    return false;
  }

  supportsTrash() { return true; }
}

module.exports = { NativeFs, READ_BLOCK };
