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

// Two kinds of persisted state:
//   PREFERENCES  window size, last used settings, recent jobs. Lives in the
//                user data folder, never travels.
//   JOBS         a folder pair plus every setting needed to reproduce a run,
//                saved as "<name>.syncto" wherever the user wants. This is
//                the file you commit next to a project or drop on a colleague.
//                The job has no name of its own: its name IS the file name.

const fs   = require('fs');
const path = require('path');
const secrets = require('./secrets');
const { redactLocation } = require('./fs/afs');

const JOB_EXT    = '.syncto';
const JOB_FORMAT = 'syncto-job';

// "MILOUSE" from /backups/MILOUSE.syncto (legacy .syncto.json accepted too).
function jobNameFromPath(p) {
  let base = path.basename(String(p || ''));
  base = base.replace(/\.syncto\.json$/i, '').replace(/\.syncto$/i, '').replace(/\.json$/i, '');
  return base || 'Untitled';
}

// ── The recent-jobs list (Zone 1) ─────────────────────────────────────────
// Most recent first, unique by path, capped. Kept here rather than inline in
// the window process so both callers — opening a job and closing one — share
// one definition of what the list is, and so it can be tested without Electron.
const RECENT_MAX = 10;

function pushRecent(list, name, p) {
  const out = (list || []).filter(r => r && r.path && r.path !== p);
  out.unshift({ name: name || jobNameFromPath(p), path: p });
  return out.slice(0, RECENT_MAX);
}

// Takes an entry OUT of the list. The file itself is never touched: the list
// is a convenience, the .syncto file is the thing the user owns.
function removeRecent(list, p) {
  return (list || []).filter(r => r && r.path && r.path !== p);
}

function defaultJob() {
  return {
    format : JOB_FORMAT,
    version: 1,
    name   : 'Untitled',
    pairId : null,                      // legacy — pair ids are path-derived now
    // Every pair shares the job's settings, exactly like FreeFileSync.
    pairs  : [{ left: '', right: '' }],
    compare: {
      compareVariant: 'timeSize',       // timeSize | content | size
      timeTolerance : 2,                // seconds
      timeShifts    : [],               // whole-hour shifts, e.g. [60] for DST
      symlinks      : 'exclude',        // exclude | asLink
      detectMoves   : true,             // rename instead of copy+delete (needs 1 prior run)
      includeFilter : '*',
      excludeFilter : '',
      softFilter    : {
        sizeMinUnit: 'none', sizeMin: 0,
        sizeMaxUnit: 'none', sizeMax: 0,
        timeUnit   : 'none', timeValue: 0,
      },
    },
    sync: {
      variant: 'mirror',                // twoWay | mirror | update | custom
      custom : { leftOnly: 'right', rightOnly: 'left', leftNewer: 'right', rightNewer: 'left' },
      customChange: {
        left : { create: 'right', update: 'right', delete: 'right' },
        right: { create: 'left',  update: 'left',  delete: 'left'  },
      },
      // Kept in the file so older jobs still load, but there is only one
      // mode now: copy, then read back and compare. migrateJob pins it.
      copyLevel        : 'secure',
      writeChecksumList: false,
      deletion         : 'recycler',    // permanent | recycler | versioning
      permanentFallback: false,
      versioning: {
        leftFolder : '', rightFolder: '',
        style      : 'timestampFolder', // replace | timestampFolder | timestampFile
        maxAgeDays : 0, countMin: 0, countMax: 0,
      },
      lockFolders    : true,            // .syncto.lock — one machine at a time
      failSafe       : true,
      preserveTimes  : true,
      copyPermissions: false,
      retryCount     : 2,
      retryDelayMs   : 5000,
      // On by default: a run works through what it can and lists the failures
      // at the end. 0.2.5 made this setting real for the first time (it had
      // been read nowhere) and left it off, which turned one unreadable file
      // into a job that copied nothing — the wrong trade for a backup tool.
      // Untick it for a run you are watching and want stopped at the first
      // problem.
      ignoreErrors   : true,
      // What to do once the run is over: none | quit | sleep | shutdown.
      // Only ever fires on a clean run — see the renderer's countdown.
      afterSync      : 'none',
      report: {
        enabled: false, html: true, csv: false, json: false,
        folder : '',                    // empty -> Documents/syncto reports
      },
    },
    autoSync: {
      enabled: false,
      minutes: 30,                      // compare + sync with current settings
    },
  };
}

const PREFS_REVISION = 2;

function defaultPrefs() {
  return {
    revision: PREFS_REVISION,
    window: { width: 1280, height: 820 },
    lastJobPath: '',
    recent: [],
    ui: { showEqual: false },
    job: defaultJob(),
    // Named servers, in the order they appear in the connection window.
    // NOTE the shape: passwordEnc / passphraseEnc, never `password`. Secrets
    // are ciphertext from the OS credential store (see secrets.js) and no
    // readable password is ever written to this file.
    // { id, name, host, port, username, keyPath, savePassword, passwordEnc, passphraseEnc }
    servers: [],
    // Phone notifications, same mechanism as ingesto. The access token is
    // ciphertext from the OS credential store, like every other secret here.
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', tokenEnc: '', onlyOnProblem: false },
  };
}

// The engine looks credentials up by "user@host" (see fs/afs.js parseLocation),
// which is all it needs and all it should know. The window works with named
// entries instead, because "NAS Montage" is what a person recognises.
//
// Decryption happens here, on the way to a run, and the result is held in
// memory for that run only.
function credentialMap(servers) {
  const out = {};
  for (const s of (servers || [])) {
    if (!s || !s.host || !s.username) continue;
    let privateKey = null;
    if (s.keyPath) {
      try { privateKey = fs.readFileSync(s.keyPath); } catch (_) { privateKey = null; }
    }
    // Keyed by user@host only, exactly like parseLocation looks it up. Two
    // entries differing only by port therefore collapse — the last one wins —
    // so the port is folded in when it is not the default, and the plain key
    // is kept as the fallback parseLocation actually asks for.
    const cred = {
      username  : s.username,
      password  : secrets.decrypt(s.passwordEnc),
      privateKey,
      passphrase: secrets.decrypt(s.passphraseEnc),
    };
    const port = Number(s.port) || 22;
    if (port !== 22) out[`${s.username}@${s.host}:${port}`] = cred;
    if (!out[`${s.username}@${s.host}`] || port === 22) out[`${s.username}@${s.host}`] = cred;
  }
  return out;
}

// Up to 0.2.5, clicking the "identical" chip in the stats bar switched
// "show identical" on behind the user's back, and the next write to the
// preferences made it permanent — the switch came back ticked at every launch
// with no way to tell it had never been asked for. The cause is fixed; this
// clears the value it left behind, once.
function migratePrefs(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const from = Number(raw.revision) || 0;

  if (from < 1) {
    if (raw.ui && typeof raw.ui === 'object') raw.ui.showEqual = false;
  }

  // Up to 0.2.6 the only way to reach a server was to type an sftp:// URL, and
  // whatever credentials that produced sat under "user@host" — with the
  // password in plain text. Turn each one into a named entry so it appears in
  // the connection window, move its password into the OS credential store, and
  // delete every readable secret from this file on the way through.
  if (from < 2) {
    if (!Array.isArray(raw.servers)) raw.servers = [];
    const known = new Set(raw.servers.map(s => `${s.username}@${s.host}`));
    let n = raw.servers.length;
    let had = 0;
    for (const key of Object.keys(raw.sftp || {})) {
      const m = /^([^@]*)@(.+)$/.exec(key);
      if (!m || known.has(key)) continue;
      const c = raw.sftp[key] || {};
      const username = c.username || m[1];
      const host = m[2];
      if (!username || !host) continue;
      const enc = secrets.encrypt(c.password);
      if (c.password) had++;
      raw.servers.push({
        id  : `srv-${++n}-${host}`,
        name: host,
        host, port: 22, username,
        keyPath      : c.keyPath || c.privateKeyPath || '',
        savePassword : !!enc,
        passwordEnc  : enc || '',
        passphraseEnc: secrets.encrypt(c.passphrase) || '',
      });
      known.add(key);
    }
    // The old block goes, always: keeping it would mean syncto rewriting
    // plain-text passwords into its own file at every save, which is the exact
    // thing this release removed.
    //
    // But when there is no usable credential store they cannot be carried over
    // either, and losing them without a word is what made this a bug. The user
    // knows their own passwords — they just have to be told to type them again.
    if (had && !secrets.available()) {
      raw.migrationNotes = (raw.migrationNotes || []).concat(
        `This machine has no usable credential store, so the ${had} saved SFTP ` +
        `password${had > 1 ? 's' : ''} could not be carried over and ${had > 1 ? 'were' : 'was'} ` +
        `removed rather than left readable on disk. Open the server window and enter ` +
        `${had > 1 ? 'them' : 'it'} again.`);
    }
    delete raw.sftp;
  }

  // Belt and braces on every load, whatever the revision: a `password` or
  // `passphrase` key must never survive in this file, even if an older build,
  // a hand edit or a restored backup put one there.
  for (const s of (raw.servers || [])) {
    if (!s || typeof s !== 'object') continue;
    if (s.password) {
      const enc = secrets.encrypt(s.password);
      if (enc) { s.passwordEnc = enc; s.savePassword = true; }
      delete s.password;
    }
    if (s.passphrase) {
      const enc = secrets.encrypt(s.passphrase);
      if (enc) s.passphraseEnc = enc;
      delete s.passphrase;
    }
  }

  raw.revision = PREFS_REVISION;
  return raw;
}

// Writes a file the way the sync engine writes data: beside it, then rename.
// writeFileSync truncates the target the moment it opens, so an interrupted
// write left an empty or half-written file. For preferences.json that meant a
// blank application on the next launch — recent jobs, window size and the SFTP
// credentials all gone, with no message; for a .syncto it meant the user's own
// job file destroyed.
function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

// Deep merge that keeps unknown keys from the file and fills in new defaults.
// A non-object `over` where the default is an object (a hand-edited job with
// "compare": null) would have replaced a whole section with null and left the
// interface throwing halfway through a redraw; keep the default instead.
function merge(base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) {
    if (over === undefined) return base;
    if (base && typeof base === 'object' && !Array.isArray(base)) return base;
    if (Array.isArray(base) && !Array.isArray(over)) return base;
    return over;
  }
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

class Prefs {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'preferences.json');
    this.data = defaultPrefs();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = merge(defaultPrefs(), migratePrefs(raw));
    } catch (_) { this.data = defaultPrefs(); }
    return this.data;
  }
  // Returns true when the file really reached the disk. Every caller used to
  // announce success regardless: "server saved, password remembered" while
  // nothing was written, and the migration that deletes the old plain-text
  // block ran in memory only — so those passwords stayed readable on disk for
  // ever while the window showed migrated entries.
  save(patch) {
    if (patch) this.data = merge(this.data, patch);
    // The renderer can send arbitrary patches through save-prefs. This is the
    // one gate every write passes through, so it is where the promise "no
    // readable password is ever written to disk" is actually kept — not in the
    // callers, which would only have to forget once.
    scrubSecrets(this.data);
    this.lastSaveError = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      this.lastSaveError = err.message || String(err);
    }
    return this.data;
  }

  saved() { return !this.lastSaveError; }

  // ── Servers ──────────────────────────────────────────────────────────────
  // What the connection window shows. Never the secrets themselves: the window
  // gets a flag saying a password is remembered, and that is all it needs.
  listServers() {
    return (this.data.servers || []).map(s => ({
      id: s.id, name: s.name, host: s.host, port: s.port || 22,
      username: s.username, keyPath: s.keyPath || '',
      // Readable, not merely present. Preferences copied from another machine
      // carry blobs this account cannot decrypt; showing them as "remembered"
      // made the window promise a password that produced an authentication
      // failure blamed on the user's typing.
      hasPassword: !!s.passwordEnc && !!secrets.decrypt(s.passwordEnc),
      savePassword: !!s.savePassword,
    }));
  }

  // Credentials for one entry, decrypted, for an immediate connection attempt.
  serverSecrets(id) {
    const s = (this.data.servers || []).find(x => x.id === id);
    if (!s) return null;
    return {
      host: s.host, port: s.port || 22, username: s.username,
      keyPath: s.keyPath || '',
      password: secrets.decrypt(s.passwordEnc),
      passphrase: secrets.decrypt(s.passphraseEnc),
    };
  }

  // conn: { id?, name, host, port, username, password, keyPath, passphrase,
  //         savePassword }
  // Returns the stored entry (without secrets) plus whether the password could
  // actually be remembered — on a machine with no usable credential store it
  // cannot, and the window says so rather than pretending.
  saveServer(conn) {
    if (!Array.isArray(this.data.servers)) this.data.servers = [];
    const list = this.data.servers;
    const key = `${conn.username}@${conn.host}`;
    let entry = list.find(s => s.id === conn.id) ||
                list.find(s => `${s.username}@${s.host}` === key && (s.port || 22) === (Number(conn.port) || 22));
    if (!entry) {
      entry = { id: `srv-${Date.now().toString(36)}-${list.length + 1}` };
      list.push(entry);
    }
    // Repointing an entry at another machine or another account must not carry
    // the old password with it: the next Connect would decrypt it and send it
    // to a host that never had it.
    const moved = (entry.host && entry.host !== conn.host) ||
                  (entry.username && entry.username !== conn.username);
    if (moved) { entry.passwordEnc = ''; entry.passphraseEnc = ''; }

    entry.name     = String(conn.name || conn.host || '').trim() || conn.host;
    entry.host     = conn.host;
    entry.port     = Number(conn.port) || 22;
    entry.username = conn.username;
    entry.keyPath  = conn.keyPath || '';

    const wants = conn.savePassword !== false;
    entry.savePassword = wants;
    if (!wants) {
      entry.passwordEnc = '';
    } else if (conn.password) {
      entry.passwordEnc = secrets.encrypt(conn.password) || '';
    }
    if (conn.passphrase) entry.passphraseEnc = secrets.encrypt(conn.passphrase) || '';

    this.save();
    return {
      server: this.listServers().find(s => s.id === entry.id),
      // False means: asked to remember, could not. The caller tells the user.
      remembered: (!wants || !conn.password ? true : !!entry.passwordEnc) && this.saved(),
      vaultAvailable: secrets.available(),
      written: this.saved(),
      writeError: this.lastSaveError || null,
    };
  }

  removeServer(id) {
    this.data.servers = (this.data.servers || []).filter(s => s.id !== id);
    this.save();
    return this.listServers();
  }

  // ── ntfy ─────────────────────────────────────────────────────────────────
  // What the settings panel is allowed to see: everything except the token,
  // which it only ever learns the existence of.
  ntfyForUi() {
    const n = this.data.ntfy || {};
    return {
      enabled: !!n.enabled,
      server : n.server || 'https://ntfy.sh',
      topic  : n.topic || '',
      hasToken: !!n.tokenEnc,
      onlyOnProblem: !!n.onlyOnProblem,
    };
  }

  // Decrypted, for an immediate send. Stays in the main process.
  ntfyConfig() {
    const n = this.data.ntfy || {};
    return {
      enabled: !!n.enabled,
      server : n.server || 'https://ntfy.sh',
      topic  : n.topic || '',
      token  : secrets.decrypt(n.tokenEnc),
      onlyOnProblem: !!n.onlyOnProblem,
    };
  }

  // patch may carry `token`; it is encrypted here and never stored readable.
  // An empty string clears it, `undefined` leaves it alone — so re-saving the
  // panel without retyping the token does not wipe it.
  saveNtfy(patch) {
    const n = Object.assign({}, this.data.ntfy);
    if (patch.enabled !== undefined) n.enabled = !!patch.enabled;
    if (patch.server  !== undefined) n.server  = String(patch.server || '').trim() || 'https://ntfy.sh';
    if (patch.topic   !== undefined) n.topic   = String(patch.topic || '').trim();
    if (patch.onlyOnProblem !== undefined) n.onlyOnProblem = !!patch.onlyOnProblem;
    if (patch.token !== undefined) {
      n.tokenEnc = patch.token ? (secrets.encrypt(patch.token) || '') : '';
    }
    this.data.ntfy = n;
    this.save();
    return this.ntfyForUi();
  }
}

// No `password`, `passphrase` or ntfy `token` key survives a write, whatever
// put it there.
// "sftp://user:secret@host/path" is a legal folder path — parseLocation
// accepts it, so people type it. It is also persisted as a plain string, which
// means the password lands in preferences.json, in the .syncto file handed to
// a colleague, in reports, and in the phone notification's pair label.
//
// Take it out of the path, and put it where every other secret lives: the OS
// credential store, keyed by user@host, so the job keeps working.
function captureUrlPassword(data, phrase) {
  const m = /^sftp:\/\/([^@/:]+):([^@/]*)@([^/:]+)(?::(\d+))?/i.exec(String(phrase || ''));
  if (!m || !m[2]) return phrase;
  const [, username, password, host, port] = m;
  if (!Array.isArray(data.servers)) data.servers = [];
  const p = Number(port) || 22;
  let entry = data.servers.find(s => s.username === username && s.host === host && (s.port || 22) === p);
  if (!entry) {
    entry = { id: `srv-${Date.now().toString(36)}-${data.servers.length + 1}`,
              name: host, host, port: p, username, keyPath: '' };
    data.servers.push(entry);
  }
  const enc = secrets.encrypt(password);
  if (enc) { entry.passwordEnc = enc; entry.savePassword = true; }
  return redactLocation(phrase);
}

function scrubSecrets(data) {
  if (!data) return;
  if (data.job && Array.isArray(data.job.pairs)) {
    for (const pair of data.job.pairs) {
      if (!pair || typeof pair !== 'object') continue;
      if (typeof pair.left === 'string')  pair.left  = captureUrlPassword(data, pair.left);
      if (typeof pair.right === 'string') pair.right = captureUrlPassword(data, pair.right);
    }
  }
  if (data.ntfy && typeof data.ntfy === 'object' && data.ntfy.token) {
    const enc = secrets.encrypt(data.ntfy.token);
    if (enc) data.ntfy.tokenEnc = enc;
    delete data.ntfy.token;
  }
  if (!Array.isArray(data.servers)) return;
  for (const s of data.servers) {
    if (!s || typeof s !== 'object') continue;
    if (s.password) {
      const enc = secrets.encrypt(s.password);
      if (enc) { s.passwordEnc = enc; s.savePassword = true; }
      delete s.password;
    }
    if (s.passphrase) {
      const enc = secrets.encrypt(s.passphrase);
      if (enc) s.passphraseEnc = enc;
      delete s.passphrase;
    }
  }
  delete data.sftp;
}

// A job saved before multi-pair support carried a single left/right at the
// top level; it becomes the only entry of `pairs`.
function migrateJob(raw) {
  if (raw && !Array.isArray(raw.pairs) && (raw.left || raw.right)) {
    raw.pairs = [{ left: raw.left || '', right: raw.right || '' }];
  }
  if (raw && Array.isArray(raw.pairs)) {
    raw.pairs = raw.pairs
      .filter(p => p && (typeof p.left === 'string' || typeof p.right === 'string'))
      .map(p => ({ left: p.left || '', right: p.right || '' }));
    if (!raw.pairs.length) raw.pairs = [{ left: '', right: '' }];
  }
  // Before 0.3.1 this flag was stored but never read, so a `false` in an old
  // job is the old default, not a decision anybody made. Leaving it as-is
  // would silently arm "stop at the first error" on every job written before
  // the setting did anything. `rev` marks a job that has been through here.
  if (raw && raw.sync && !raw.rev) raw.sync.ignoreErrors = true;
  if (raw) raw.rev = 1;

  if (raw && raw.sync) {
    // The Pro level was removed: without this coercion algoFor('pro') returns
    // null and an old "pro" job silently degrades to a FAST copy — the exact
    // opposite of what its author chose.
    // A job written when syncto still offered three levels could ask for
    // 'fast' or 'verified'. Neither exists any more, and silently running a
    // job at a weaker level than it now claims would be the worst outcome.
    raw.sync.copyLevel = 'secure';
    // Versioning has no interface. A job asking for it with no revision folder
    // configured could only ever fail; the trash is the honest equivalent.
    if (raw.sync.deletion === 'versioning') {
      const v = raw.sync.versioning || {};
      if (!v.leftFolder && !v.rightFolder) raw.sync.deletion = 'recycler';
    }
  }
  return raw;
}

function loadJob(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a syncto job file.');
  if (raw.format !== JOB_FORMAT) throw new Error('Not a syncto job file.');
  const job = merge(defaultJob(), migrateJob(raw));
  // A job may be hand-edited or produced by another tool. Every section the
  // interface reads unconditionally must be an object by the time it gets
  // there, or the redraw throws with the path fields already replaced and the
  // rest of the window left showing the previous job.
  for (const k of ['compare', 'sync', 'autoSync']) {
    const def = defaultJob()[k];
    if (def && (!job[k] || typeof job[k] !== 'object' || Array.isArray(job[k]))) job[k] = def;
  }
  if (job.sync && (!job.sync.versioning || typeof job.sync.versioning !== 'object')) {
    job.sync.versioning = defaultJob().sync.versioning;
  }
  if (job.sync && (!job.sync.report || typeof job.sync.report !== 'object')) {
    job.sync.report = defaultJob().sync.report;
  }
  if (!Array.isArray(job.pairs) || !job.pairs.length) job.pairs = [{ left: '', right: '' }];
  delete job.left; delete job.right;
  return job;
}

function saveJob(file, job) {
  const out = merge(defaultJob(), job);
  out.format = JOB_FORMAT;
  // A .syncto is the file you commit next to a project or hand to a colleague.
  // A password typed into a folder field must not travel with it, ever.
  if (Array.isArray(out.pairs)) {
    for (const p of out.pairs) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.left === 'string')  p.left  = redactLocation(p.left);
      if (typeof p.right === 'string') p.right = redactLocation(p.right);
    }
  }
  writeFileAtomic(file, JSON.stringify(out, null, 2));
  return out;
}

module.exports = { Prefs, defaultJob, defaultPrefs, loadJob, saveJob, merge, migrateJob,
  migratePrefs, credentialMap, jobNameFromPath, pushRecent, removeRecent, RECENT_MAX,
  JOB_EXT, JOB_FORMAT };
