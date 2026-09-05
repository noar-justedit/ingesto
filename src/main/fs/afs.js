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

// Abstract filesystem layer.
//
// A "location phrase" is what the user types in a folder field. It is either
//   - a local/mounted path:  /Volumes/RAID/Project   or   D:\Project
//   - an SFTP URL:           sftp://user@host:22/srv/backup
// Macros (%date%, %timestamp%, ...) and ~ are expanded here so the rest of the
// engine only ever sees resolved absolute paths.
//
// Every backend exposes the same contract:
//   connect() close() stat(p) readdir(p) readlink(p) symlink(t,p)
//   createReadStream(p) createWriteStream(p) mkdir(p) unlink(p) rmdir(p)
//   rename(a,b) renameStrict(a,b) writeExclusive(p,buf) appendByte(p,b)
//   setMTime(p,ms) chmod(p,mode) flush(p) exists(p)
//   join() dirname() basename() resolve() deviceKey(p) displayName(p)
//   supportsTrash()

const { NativeFs } = require('./native');
const { SftpFs }   = require('./sftp');

// ── Macro expansion ────────────────────────────────────────────────────────
// Same spirit as FreeFileSync: %Date%, %Time%, %TimeStamp%, %Year%, %Month%,
// %MonthName%, %Day%, %Hour%, %Min%, %Sec%, %WeekDayName%, %Week%.
// Unknown %names% are left untouched, then looked up in the environment.
function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function expandMacros(phrase, now) {
  const d = now || new Date();
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const map = {
    date       : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time       : `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    timestamp  : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    year       : String(d.getFullYear()),
    month      : pad(d.getMonth() + 1),
    monthname  : MONTHS[d.getMonth()],
    day        : pad(d.getDate()),
    hour       : pad(d.getHours()),
    min        : pad(d.getMinutes()),
    sec        : pad(d.getSeconds()),
    weekdayname: DAYS[d.getDay()],
    week       : pad(isoWeek(d)),
    weekday    : String(d.getDay() === 0 ? 7 : d.getDay()),
  };
  return String(phrase || '').replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (full, name) => {
    const k = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
    if (process.env[name] != null) return process.env[name];
    return full;
  });
}

// ── Location parsing ───────────────────────────────────────────────────────
// Returns { kind:'native', path } or
//         { kind:'sftp', host, port, username, password, privateKey, path }
function parseLocation(phrase, credentials) {
  const raw = expandMacros(String(phrase || '').trim());
  const m = /^sftp:\/\/(?:([^@/:]+)(?::([^@/]*))?@)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(raw);
  if (m) {
    const host = m[3];
    const port = m[4] ? parseInt(m[4], 10) : 22;
    // Look for the entry that names this port first: two servers on the same
    // host and login but different ports have different passwords, and the
    // port-less key can only hold one of them.
    const cred = (credentials && (credentials[`${m[1] || ''}@${host}:${port}`] ||
                                  credentials[`${m[1] || ''}@${host}`])) || {};
    return {
      kind      : 'sftp',
      username  : m[1] || cred.username || '',
      password  : m[2] || cred.password || '',
      privateKey: cred.privateKey || null,
      passphrase: cred.passphrase || '',
      host,
      port,
      path      : m[5] || '/',
      phrase    : raw,
    };
  }
  return { kind: 'native', path: raw, phrase: raw };
}

// Builds the backend for a location. Native backends are shared (stateless);
// SFTP backends are pooled per host+user so a run opens one connection each.
class FsPool {
  constructor() {
    this.native = new NativeFs();
    this.sftp   = new Map();
  }

  // Returns { fs, path } ready to use.
  async open(loc) {
    if (loc.kind === 'native') {
      return { fs: this.native, path: this.native.resolve(loc.path), kind: 'native' };
    }
    const key = `${loc.username}@${loc.host}:${loc.port}`;
    let backend = this.sftp.get(key);
    // A backend whose connection died is not reusable — every call on it would
    // fail with the error that killed it. And a backend must not be cached
    // BEFORE it connects: a first failed attempt used to be handed to every
    // later location on the same host, long after the network came back.
    if (backend && backend.dead) {
      try { await backend.close(); } catch (_) {}
      this.sftp.delete(key);
      backend = null;
    }
    if (!backend) backend = new SftpFs(loc);
    try {
      await backend.connect();
    } catch (err) {
      try { await backend.close(); } catch (_) {}
      this.sftp.delete(key);
      throw err;
    }
    this.sftp.set(key, backend);
    return { fs: backend, path: backend.resolve(loc.path), kind: 'sftp' };
  }

  async closeAll() {
    for (const b of this.sftp.values()) { try { await b.close(); } catch (_) {} }
    this.sftp.clear();
  }
}

// The same address with any password taken out of it.
//
// "sftp://user:secret@host/path" is accepted by parseLocation, so people use
// it — and that string is a folder path: it is saved into preferences.json,
// written into the .syncto file people hand to a colleague, printed in
// reports, and put in the label that ends up in a phone notification. It must
// never carry a secret past this point.
function redactLocation(phrase) {
  const s = String(phrase == null ? '' : phrase);
  return s.replace(/^(sftp:\/\/)([^@/:]+):([^@/]*)@/i, '$1$2@');
}

module.exports = { FsPool, parseLocation, expandMacros, redactLocation };
