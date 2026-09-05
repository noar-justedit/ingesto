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

// SFTP backend. Same contract as fs/native.js, over an ssh2 connection.
//
// Design notes:
//  - One SSH connection per remote location, reused for the whole run. SFTP is
//    request/response over a single channel, so operations are serialized by a
//    small promise queue to avoid flooding servers that cap concurrent requests.
//  - Paths are always POSIX, whatever the local platform.
//  - `id` (inode) is not available over SFTP, so move detection and hard-link
//    awareness are disabled for remote locations.
//  - Timestamps have 1-second resolution in the SFTP protocol, which is why the
//    default comparison tolerance of 2 s matters here.

const posix = require('path').posix;

let ssh2 = null;
function getSsh2() { if (!ssh2) ssh2 = require('ssh2'); return ssh2; }

const READ_BLOCK = 512 * 1024;   // SFTP throughput is bounded by the window, not the block

// How long a single metadata request may take before the channel is declared
// dead. ssh2 silently drops requests issued on a closed channel — the callback
// is never called — so without this a sleeping laptop or a dropped Wi-Fi left
// the whole run hanging for ever, with no error and an unresponsive Abort.
const OP_TIMEOUT_MS = 45000;

// NO backslash translation. These are POSIX paths: "a\b.txt" is a perfectly
// legal file name on a Linux server, and turning it into "a/b.txt" made syncto
// look for a directory that does not exist.
function normalize(p) {
  let s = String(p || '');
  if (!s.startsWith('/')) s = '/' + s;
  return posix.normalize(s).replace(/\/+$/, '') || '/';
}

class SftpFs {
  // opts: { host, port, username, password, privateKey, passphrase, root }
  constructor(opts) {
    this.kind = 'sftp';
    this.sep  = '/';
    this.opts = opts || {};
    this.conn = null;
    this.sftp = null;
    this._chain = Promise.resolve();
    this._streams = new Set();   // transfers in flight, so a drop can kill them
    this.dead = null;            // the error that killed this connection
  }

  deviceKey() { return `sftp:${this.opts.username}@${this.opts.host}:${this.opts.port || 22}`; }
  displayName(p) { return `sftp://${this.opts.username}@${this.opts.host}${p}`; }

  normalizeName(name) { return String(name).normalize('NFC'); }

  join(...parts)  { return normalize(posix.join(...parts.map(String))); }
  dirname(p)      { return posix.dirname(normalize(p)); }
  basename(p)     { return posix.basename(normalize(p)); }
  isAbsolute()    { return true; }
  resolve(p)      { return normalize(p); }

  // Declares the connection unusable and makes every user of it fail NOW.
  // Requests already handed to ssh2 on a closed channel never call back, so
  // waiting for them is waiting for ever; the transfers in flight are torn
  // down with the same error so the copy loop sees a failure it can report.
  _die(err) {
    if (this.dead) return;
    this.dead = err instanceof Error ? err : new Error(String(err || 'The SFTP connection was lost.'));
    for (const s of this._streams) { try { s.destroy(this.dead); } catch (_) {} }
    this._streams.clear();
    try { if (this.conn) this.conn.end(); } catch (_) {}
    this.sftp = null;
    this._connectPromise = null;
  }

  _track(stream) {
    this._streams.add(stream);
    const drop = () => this._streams.delete(stream);
    stream.once('close', drop);
    stream.once('error', drop);
    stream.once('end', drop);
    return stream;
  }

  // Serializes SFTP requests: ssh2 will happily pipeline, but many servers
  // (and most NAS boxes) drop requests past a low concurrency limit.
  //
  // Every request also carries a deadline. Without one, a single request
  // issued after the channel died blocked this queue — and therefore the whole
  // run — permanently, because its callback was never going to arrive.
  _q(fn) {
    const guarded = () => {
      if (this.dead) return Promise.reject(this.dead);
      if (!this.sftp) return Promise.reject(new Error('The SFTP connection is not open.'));
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          const err = new Error(`The server did not answer within ${Math.round(OP_TIMEOUT_MS / 1000)} s.`);
          this._die(err);
          reject(err);
        }, OP_TIMEOUT_MS);
        Promise.resolve().then(fn).then(
          v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
          e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      });
    };
    const run = this._chain.then(guarded, guarded);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const { Client } = getSsh2();
      const conn = new Client();
      let settled = false;
      const cfg = {
        host             : this.opts.host,
        port             : this.opts.port || 22,
        username         : this.opts.username,
        readyTimeout     : 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
      if (this.opts.password)   cfg.password   = this.opts.password;
      if (this.opts.privateKey) cfg.privateKey = this.opts.privateKey;
      if (this.opts.passphrase) cfg.passphrase = this.opts.passphrase;

      // A connection that never became usable still holds a live socket and a
      // keepalive timer. Ten attempts against a misconfigured server used to
      // leave ten of them running until the app quit — and the server hit its
      // session limit and started refusing everyone.
      const bail = err => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch (_) {}
        this.conn = null; this.sftp = null;
        // Do NOT keep the rejected promise: it would be replayed as a cached
        // failure for every later attempt, even once the network is back.
        this._connectPromise = null;
        reject(err);
      };

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return bail(err);
          if (settled) { try { conn.end(); } catch (_) {} return; }
          settled = true;
          this.conn = conn; this.sftp = sftp; this.dead = null;
          // From here on, losing the channel is a run-stopping error rather
          // than a silent freeze.
          const lost = e => this._die(e || new Error('The SFTP connection was closed by the server.'));
          conn.on('error', lost);
          conn.on('close', () => lost());
          conn.on('end',   () => lost());
          sftp.on('error', lost);
          sftp.on('close', () => lost());
          resolve();
        });
      });
      conn.on('error', bail);
      conn.on('close', () => bail(new Error('The SFTP connection was closed before it was ready.')));
      conn.connect(cfg);
    });
    return this._connectPromise;
  }

  async close() {
    for (const s of this._streams) { try { s.destroy(); } catch (_) {} }
    this._streams.clear();
    try { if (this.conn) this.conn.end(); } catch (_) {}
    this.conn = null; this.sftp = null; this._connectPromise = null; this.dead = null;
  }

  _mapStat(st) {
    const isLink = typeof st.isSymbolicLink === 'function' ? st.isSymbolicLink() : false;
    const isDir  = typeof st.isDirectory    === 'function' ? st.isDirectory()    : false;
    const isFile = typeof st.isFile         === 'function' ? st.isFile()         : false;
    return {
      type : isLink ? 'symlink' : isDir ? 'folder' : isFile ? 'file' : 'other',
      size : st.size,
      mtime: (st.mtime || 0) * 1000,     // SFTP reports seconds
      mode : st.mode,
      id   : null,
    };
  }

  // Null means "does not exist" — and only that. SSH_FX_NO_SUCH_FILE is 2;
  // a permission error must surface, not masquerade as an absent file (the
  // comparison would take "absent" at its word and schedule deletions).
  async stat(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.lstat(normalize(p), (err, st) => {
        if (!err) return resolve(this._mapStat(st));
        if (err.code === 2 || /no such file/i.test(err.message || '')) return resolve(null);
        reject(err);
      });
    }));
  }

  async exists(p) { return (await this.stat(p)) !== null; }

  async readdir(p) {
    const dir = normalize(p);
    const list = await this._q(() => new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, l) => err ? reject(err) : resolve(l));
    }));
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => {
        const st = this._mapStat(e.attrs);
        return { name: e.filename, type: st.type, size: st.size, mtime: st.mtime, id: null };
      });
  }

  // What the server thinks a path really is. Used with "." to find the login
  // directory, so the folder browser opens where the user lives instead of at
  // the root of an archive server with two hundred entries.
  async realpath(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.realpath(String(p == null ? '.' : p), (err, t) => err ? reject(err) : resolve(t));
    }));
  }

  async readlink(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.readlink(normalize(p), (err, t) => err ? reject(err) : resolve(t));
    }));
  }

  async symlink(target, p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.symlink(target, normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  // Streams bypass the queue on purpose: they hold a channel for their whole
  // lifetime, and the sync engine never runs two transfers on one connection.
  createReadStream(p) {
    if (this.dead) throw this.dead;
    return this._track(this.sftp.createReadStream(normalize(p), { highWaterMark: READ_BLOCK }));
  }

  createWriteStream(p) {
    if (this.dead) throw this.dead;
    return this._track(this.sftp.createWriteStream(normalize(p), { highWaterMark: READ_BLOCK }));
  }

  // SSH_FXF_EXCL: the SFTP protocol has the exclusive-create flag natively.
  async writeExclusive(p, buf) {
    return this._q(() => new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(normalize(p), { flags: 'wx' });
      ws.on('error', err => {
        // Servers report the clash in various ways; normalize it for the caller.
        if (/exist|failure/i.test(err.message || '')) err.code = 'EEXIST';
        reject(err);
      });
      ws.on('close', resolve);
      ws.end(buf);
    }));
  }

  async appendByte(p, byte) {
    return this._q(() => new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(normalize(p), { flags: 'a' });
      ws.on('error', reject);
      ws.on('close', resolve);
      ws.end(Buffer.from(byte, 'utf8'));
    }));
  }

  async mkdir(p) {
    const full = normalize(p);
    const parts = full.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const st = await this.stat(cur);
      if (st) continue;
      try {
        await this._q(() => new Promise((resolve, reject) => {
          this.sftp.mkdir(cur, err => err ? reject(err) : resolve());
        }));
      } catch (e) {
        if (!(await this.stat(cur))) throw e;   // lost a race, that is fine
      }
    }
  }

  async unlink(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.unlink(normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  async rmdir(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.rmdir(normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  _rawRename(src, dst) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.rename(src, dst, err => err ? reject(err) : resolve());
    }));
  }

  async rename(from, to) {
    const src = normalize(from), dst = normalize(to);
    try {
      await this._rawRename(src, dst);
      return;
    } catch (e) {
      if (!(await this.exists(src)) || !(await this.exists(dst))) throw e;
    }
    // Most servers refuse to rename onto an existing target, and the engine's
    // "tmp file → final name" rename legitimately needs to replace one.
    //
    // Deleting the target first was a hole: between the unlink and the rename
    // there is a full network round trip, and a connection that dropped in
    // that window left NOTHING at the destination — the previous version gone,
    // the new one still under its .syncto_tmp name. Move the old file aside
    // instead, and put it back if the rename does not go through.
    const parked = dst + '.syncto_old';
    try { await this.unlink(parked); } catch (_) {}
    await this._rawRename(dst, parked);
    try {
      await this._rawRename(src, dst);
    } catch (err) {
      try { await this._rawRename(parked, dst); } catch (_) {}
      throw err;
    }
    try { await this.unlink(parked); } catch (_) {}
  }

  // Rename with NO delete-and-retry fallback. This is what makes the lock
  // takeover atomic: of two machines renaming the same abandoned lock, exactly
  // one may succeed — a fallback that deletes the target would let both win.
  async renameStrict(from, to) {
    return this._rawRename(normalize(from), normalize(to));
  }

  async setMTime(p, mtimeMs) {
    const t = Math.floor(mtimeMs / 1000);
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.utimes(normalize(p), t, t, err => err ? reject(err) : resolve());
    }));
  }

  async chmod(p, mode) {
    try {
      await this._q(() => new Promise((resolve, reject) => {
        this.sftp.chmod(normalize(p), mode, err => err ? reject(err) : resolve());
      }));
    } catch (_) {}
  }

  async flush() { /* the server owns its cache */ }
  supportsTrash() { return false; }
}

module.exports = { SftpFs, READ_BLOCK };
