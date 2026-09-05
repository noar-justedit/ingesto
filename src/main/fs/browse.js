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

// The connection behind the "Connect to a server" window.
//
// It is deliberately NOT the connection a run uses: a comparison opens its own
// through the session's pool and closes it at the end. This one only exists
// while the window is open, so browsing a server can never interfere with a
// synchronization in progress, and closing the window cannot pull the rug from
// under a running job.
//
// One connection at a time. The window is modal, nobody can browse two servers
// at once, and holding a second idle SSH session open would be rude to servers
// that cap sessions per user.

const fs = require('fs');
const { SftpFs } = require('./sftp');

// ssh2's errors are precise and unreadable: "All configured authentication
// methods failed" tells a developer everything and a user nothing. Say what to
// check instead — the window shows this text verbatim.
function readable(err, conn) {
  const msg = String((err && err.message) || err || '');
  const code = err && err.code;
  const where = `${conn.host}:${conn.port || 22}`;

  if (/authentication methods failed|auth/i.test(msg)) {
    return conn.keyPath
      ? `The server refused the login for "${conn.username}". Check the user name, and that this key is authorized on the server.`
      : `The server refused the login for "${conn.username}". Check the user name and the password.`;
  }
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) {
    return `No machine answers to "${conn.host}". Check the address.`;
  }
  if (code === 'ECONNREFUSED') {
    return `${where} refused the connection. Check the port, and that SSH/SFTP is running on that machine.`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `${where} cannot be reached from this network.`;
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) {
    return `${where} did not answer in time. It may be off, asleep, or behind a firewall.`;
  }
  if (/handshake/i.test(msg)) {
    return `${where} answered, but the secure handshake failed (${msg}).`;
  }
  return `${where}: ${msg}`;
}

// A private key lives on disk; ssh2 wants its contents. Reading it here keeps
// the key material out of the preferences file — only the path is stored.
function loadKey(keyPath) {
  if (!keyPath) return null;
  try {
    return fs.readFileSync(keyPath);
  } catch (err) {
    const e = new Error(`The private key at ${keyPath} could not be read: ${err.message}`);
    e.friendly = true;
    throw e;
  }
}

class RemoteBrowser {
  constructor() {
    this.fs = null;
    this.conn = null;
    // Bumped by every connect and every close. A handshake can take twenty
    // seconds against a sleeping NAS, and in that time the user can hit
    // Connect again or close the window. Whoever holds the current number owns
    // this.fs; a slower attempt that finishes afterwards closes its own
    // connection instead of overwriting the newer one and leaking an SSH
    // session on the server.
    this._gen = 0;
  }

  // conn: { host, port, username, password, keyPath, passphrase }
  async connect(conn) {
    await this.close();
    const gen = this._gen;
    const opts = {
      host      : String(conn.host || '').trim(),
      port      : Number(conn.port) || 22,
      username  : String(conn.username || '').trim(),
      password  : conn.password || '',
      privateKey: loadKey(conn.keyPath),
      passphrase: conn.passphrase || '',
    };
    if (!opts.host)     throw Object.assign(new Error('Enter the address of the server.'), { friendly: true });
    if (!opts.username) throw Object.assign(new Error('Enter the login to use on that server.'), { friendly: true });

    const backend = new SftpFs(opts);
    try {
      await backend.connect();
    } catch (err) {
      try { await backend.close(); } catch (_) {}
      const e = new Error(err.friendly ? err.message : readable(err, conn));
      e.friendly = true;
      throw e;
    }
    if (gen !== this._gen) {
      try { await backend.close(); } catch (_) {}
      throw Object.assign(new Error('That connection was replaced by a newer one.'),
                          { friendly: true, superseded: true });
    }
    this.fs = backend;
    this.conn = conn;

    // Where to open the browser: the user's home if the server tells us, root
    // otherwise. Landing on "/" of a big archive server is a poor welcome.
    let start = '/';
    try {
      const home = await backend.realpath('.');
      if (home && home.startsWith('/')) start = home;
    } catch (_) { /* not every server answers this */ }

    return { ok: true, start, banner: `${opts.username}@${opts.host}` };
  }

  // Folders only, sorted, one level. A destination is a folder, and listing
  // the files of a rushes directory would mean tens of thousands of rows
  // nobody can pick from.
  async list(dir) {
    if (!this.fs) throw Object.assign(new Error('Not connected.'), { friendly: true });
    const path = dir && dir.startsWith('/') ? dir : '/';
    let entries;
    try {
      entries = await this.fs.readdir(path);
    } catch (err) {
      const e = new Error(/permission|denied/i.test(err.message || '')
        ? `You are not allowed to list ${path}.`
        : `${path} could not be listed: ${err.message}`);
      e.friendly = true;
      throw e;
    }
    const folders = entries
      .filter(e => e.type === 'folder' && e.name !== '.' && e.name !== '..')
      .map(e => ({ name: e.name, path: path === '/' ? '/' + e.name : path + '/' + e.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const parent = path === '/' ? null : (path.slice(0, path.lastIndexOf('/')) || '/');
    return { path, parent, folders };
  }

  // Creating the destination folder from inside the browser, because "the
  // folder does not exist yet" is the normal state of a new backup target.
  async mkdir(dir, name) {
    if (!this.fs) throw Object.assign(new Error('Not connected.'), { friendly: true });
    const clean = String(name || '').trim();
    if (!clean || /[/\\]/.test(clean)) {
      throw Object.assign(new Error('A folder name cannot be empty or contain a slash.'), { friendly: true });
    }
    const full = dir === '/' ? '/' + clean : dir + '/' + clean;
    if (await this.fs.exists(full)) {
      throw Object.assign(new Error(`"${clean}" already exists here.`), { friendly: true });
    }
    try {
      await this.fs.mkdir(full);
    } catch (err) {
      throw Object.assign(new Error(`Could not create ${full}: ${err.message}`), { friendly: true });
    }
    return { path: full };
  }

  // The URL the folder field will hold. The password never goes in it — it
  // stays in the saved server entry, keyed by user@host.
  static urlFor(conn, folder) {
    const port = Number(conn.port) || 22;
    const host = port === 22 ? conn.host : `${conn.host}:${port}`;
    return `sftp://${conn.username}@${host}${folder || '/'}`;
  }

  async close() {
    this._gen++;                 // invalidates any handshake still in flight
    if (this.fs) { try { await this.fs.close(); } catch (_) {} }
    this.fs = null;
    this.conn = null;
  }
}

module.exports = { RemoteBrowser, readable };
