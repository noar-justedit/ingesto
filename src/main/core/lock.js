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

// Directory locking — one machine at a time per synchronized folder.
//
// Ported from FreeFileSync's dir_lock, whose design has one great virtue: it
// needs no operating-system locking primitive. It works over SMB, AFP, NFS and
// SFTP alike, because it relies on only two things every filesystem provides —
// appending a byte, and renaming atomically.
//
//   1. A lock file (.syncto.lock) is created at the root of each synchronized
//      folder, holding who owns it: machine, user, process id, session id.
//
//   2. While the run lasts, a heartbeat appends ONE space byte to that file
//      every 5 seconds. The file grows; any other machine can see that through
//      a plain stat, over any network mount.
//
//   3. A machine that finds a lock polls it every 2 seconds. If the file has
//      not grown for 12 seconds (5 + 7 of margin) the owner is presumed dead
//      and the lock is abandoned.
//
//   4. Taking over an abandoned lock is NOT a delete — two waiting machines
//      would both delete it and both proceed. The lock is RENAMED to
//      "Delete.0.<name>" first: renaming is atomic, so exactly one machine
//      wins, and that machine is the one allowed to continue.
//
// Shortcut: when the lock belongs to this very machine and user, there is no
// need to wait 12 seconds — we can ask the operating system directly whether
// that process is still alive.

const os = require('os');
const fsNode = require('fs');
const nodePath = require('path');
const { LOCK_NAME } = require('./compare');

const EMIT_LIFE_SIGN_MS   = 5000;                        // heartbeat period
const POLL_LIFE_SIGN_MS   = 2000;                        // how often a waiter looks
// How long a folder has to stay silent before its owner is presumed dead.
//
// This was 12 s, which is the right number for two processes on one machine
// and much too tight for two machines on a network. An SMB share reconnecting,
// a switch renegotiating, a NAS spinning a disk back up: fifteen seconds of
// nothing is an ordinary Tuesday, and it aborted whole runs with "the lock file
// has not been refreshed for 15 s". A minute of complete silence still means
// something is genuinely wrong, and a backup tool can afford to wait a minute
// before stepping on another machine's work.
//
// The SAME number is used at both ends, and that is the safety property: the
// owner gives up exactly when a waiter becomes entitled to take over, never
// later. ⚠️ Two machines running DIFFERENT versions of syncto no longer agree
// on it — a 0.6.1 machine would take the folder after 12 s while a newer one
// still believes it holds it. Update both.
const DETECT_ABANDONED_MS = 60000;
const ABANDONED_LEVEL_MAX = 10;                          // guard against pathological recursion
const FORMAT  = 'syncto-lock';
const VERSION = 1;

function guid() {
  return require('crypto').randomBytes(16).toString('hex');
}

// "sync.lock" -> "Delete.0.sync.lock" -> "Delete.1.sync.lock" -> …
// Recursive abandoned locks are (almost) impossible, but filesystem bugs have
// produced them in the wild, hence the level counter and its ceiling.
function abandonedLockName(name) {
  let base = name, level = 0;
  const m = /^Delete\.(\d+)\.(.+)$/.exec(name);
  if (m) {
    level = parseInt(m[1], 10) + 1;
    base  = m[2];
    if (level >= ABANDONED_LEVEL_MAX) throw new Error('Endless recursion on the lock file.');
  }
  return `Delete.${level}.${base}`;
}

// A hostname is not an identity. Two Windows machines deployed from the same
// image are both "WIN-DIT01\admin"; so are two Macs left on their factory
// name. That was enough for one to read the other's live lock, find no such
// process id locally, call it dead and take the folder — two machines writing
// the same files at the same time.
//
// This id is generated once per installation and kept next to the preferences.
// If it cannot be stored, a per-process id is used instead: the fast path for
// our own stale locks is lost, but the slow path — watch for 12 s of silence —
// is always correct, which is the direction to fail in.
let INSTALL_ID = null;
function installId() {
  if (INSTALL_ID) return INSTALL_ID;
  try {
    const dir = nodePath.join(os.homedir(), '.syncto');
    const file = nodePath.join(dir, 'install-id');
    try {
      const v = fsNode.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(v)) return (INSTALL_ID = v);
    } catch (_) { /* not created yet */ }
    fsNode.mkdirSync(dir, { recursive: true });
    const v = guid();
    fsNode.writeFileSync(file, v + '\n', { mode: 0o600 });
    return (INSTALL_ID = v);
  } catch (_) {
    return (INSTALL_ID = guid());
  }
}

function localLockInfo() {
  return {
    format : FORMAT,
    version: VERSION,
    lockId : guid(),
    installId: installId(),
    computerName: os.hostname(),
    userId : (() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })(),
    sessionId: process.ppid || 0,
    processId: process.pid,
    since  : Date.now(),
  };
}

// 'running' | 'notRunning' | 'itsUs' | 'unknown'
function processStatus(info, local) {
  // No install id (a lock written by 0.2.4 or earlier) means we cannot prove
  // the lock is ours, so we must not shortcut: 'unknown' waits for silence.
  if (!info.installId || !local.installId || info.installId !== local.installId) return 'unknown';
  if (info.computerName !== local.computerName || info.userId !== local.userId) {
    return 'unknown';                       // another machine, or another user on this one
  }
  if (info.processId === local.processId && info.sessionId === local.sessionId) {
    return 'itsUs';                         // obscure but possible: a lock we failed to clean up
  }
  try {
    process.kill(info.processId, 0);        // signal 0: existence check only
    return 'running';
  } catch (err) {
    return err.code === 'EPERM' ? 'running' : 'notRunning';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// The lock ids this process is holding RIGHT NOW. A lock we hold and a lock we
// once failed to release are both "itsUs" to processStatus — same machine,
// same process id — and only the lock id tells them apart. Without this, the
// "clear the leftovers" button would free a folder in the middle of the run
// that is writing to it.
const HELD = new Set();
function isHeldHere(lockId) { return !!lockId && HELD.has(lockId); }

async function readLockInfo(fsx, lockPath) {
  return new Promise(resolve => {
    const chunks = [];
    let rs;
    try { rs = fsx.createReadStream(lockPath); } catch (_) { return resolve(null); }
    rs.on('data', c => chunks.push(c));
    rs.on('error', () => resolve(null));
    rs.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      // The heartbeat appends spaces after the JSON, so parse the first line.
      try {
        const json = JSON.parse(text.split('\n')[0]);
        resolve(json && json.format === FORMAT ? json : null);
      } catch (_) { resolve(null); }
    });
  });
}

// Is this lock still ours? Answers with what can be PROVEN, and says so when
// nothing can be:
//
//   'ours'    — the file is there and carries our lock id
//   'taken'   — the file is there and carries someone else's
//   'gone'    — the file is not there (stat says absent, not "I could not ask")
//   'unknown' — the share did not answer
//
// The distinction is the whole point. readLockInfo() resolves null both when
// the file is missing and when the read failed, and the heartbeat treated that
// null as "the lock file disappeared" — so one unreadable moment on a network
// share ended the run. A read that fails is not evidence of anything.
async function checkStillOurs(fsx, lockPath, lockId) {
  let st;
  try { st = await fsx.stat(lockPath); }
  catch (_) { return 'unknown'; }        // the share did not answer
  if (!st) return 'gone';                // stat is explicit: absent
  const cur = await readLockInfo(fsx, lockPath);
  if (!cur) return 'unknown';            // there, but unreadable this instant
  return cur.lockId === lockId ? 'ours' : 'taken';
}

// One held lock, with its heartbeat.
//
// The heartbeat is not just a keep-alive, it is a re-check. If the share goes
// away for longer than the abandonment window, another machine legitimately
// takes the folder — and the old owner has to find out. It used to swallow
// every append failure and keep going: the ousted owner carried on writing
// (its blind `appendByte` in "a" mode even fed the NEW owner's lock file), and
// its release() then deleted a lock it no longer held, freeing the folder for
// a third machine while the second was still running.
class DirLock {
  // onLost(reason) fires when this lock is no longer ours. The run must stop.
  //
  // `timing` exists so the test suite can play out a network dropout in a
  // second instead of a minute. Nothing in the application passes it: a run
  // always uses the real periods, and one assertion checks that those are
  // still the numbers two machines have to agree on.
  constructor(fsx, lockPath, info, onLost, timing) {
    this.fs = fsx;
    this.path = lockPath;
    this.info = info;
    this.onLost = onLost || null;
    this.beatMs   = (timing && timing.beatMs)   || EMIT_LIFE_SIGN_MS;
    this.detectMs = (timing && timing.detectMs) || DETECT_ABANDONED_MS;
    this.timer = null;
    this.released = false;
    this.lost = null;
    // WALL CLOCK, not a count of failed beats. A share that freezes does not
    // make appendFile fail — it makes it block, for ever — so the previous
    // counter stayed at zero while the file stopped growing and another
    // machine legitimately took the folder. What matters is how long it has
    // been since a beat actually landed.
    this._lastBeat = Date.now();
    // How rough the ride was, for the run summary. A run that survived four
    // dropouts finished correctly, and saying so is more use than silence.
    this.hiccups = 0;
    this.worstGapMs = 0;
    this._hiccupSince = 0;
    HELD.add(info.lockId);
  }

  _fail(reason) {
    if (this.lost || this.released) return;
    this.lost = reason;
    HELD.delete(this.info.lockId);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.onLost) { try { this.onLost(reason); } catch (_) {} }
  }

  _startHeartbeat() {
    const beat = () => {
      if (this.released || this.lost) return;
      // Checked on EVERY tick, including while a previous beat is still stuck
      // in a blocked write. This is the only thing that notices a mount that
      // has stopped answering.
      const silent = Date.now() - this._lastBeat;
      if (silent >= this.detectMs) {
        return this._fail(`the lock file has not been refreshed for ${
          Math.round(silent / 1000)} s — the folder may have been taken over`);
      }
      if (this._beating) return;
      this._beating = (async () => {
        // Still ours? A stat is not enough — the file may have been taken over
        // and recreated by someone else, at a similar size. And a read that
        // FAILS proves nothing at all, which is what this distinguishes.
        const state = await checkStillOurs(this.fs, this.path, this.info.lockId);
        if (state === 'gone')  throw new Error('the lock file disappeared');
        if (state === 'taken') {
          const cur = await readLockInfo(this.fs, this.path);
          throw new Error(`the folder was taken over by ${describe(cur)}`);
        }
        if (state === 'unknown') throw new Error('hiccup: the share did not answer');
        // A single space. Growing the file IS the life sign — nothing else
        // needs to be readable or parsed by the other side.
        await this.fs.appendByte(this.path, ' ');
        this._lastBeat = Date.now();
        if (this._hiccupSince) {
          this.worstGapMs = Math.max(this.worstGapMs, Date.now() - this._hiccupSince);
          this._hiccupSince = 0;
        }
      })()
        .catch(err => {
          // Positive evidence ends the run at once. Anything else is the
          // network being the network: the tick above is what decides when the
          // silence has lasted long enough for another machine to be entitled
          // to the folder, and until then we ride it out.
          if (/taken over|disappeared/.test(err.message || '')) return this._fail(err.message);
          if (!this._hiccupSince) { this._hiccupSince = Date.now(); this.hiccups++; }
        })
        .finally(() => { this._beating = null; });
    };
    this.timer = setInterval(beat, this.beatMs);
    if (this.timer.unref) this.timer.unref();
  }

  async release() {
    if (this.released) return;
    this.released = true;
    HELD.delete(this.info.lockId);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // The in-flight append has to finish first: one landing AFTER the unlink
    // would recreate the file and block other machines for a full minute.
    if (this._beating) { try { await this._beating; } catch (_) {} }
    if (this.lost) return;              // not ours any more — deleting it would evict its owner
    try {
      const cur = await readLockInfo(this.fs, this.path);
      if (cur && cur.lockId !== this.info.lockId) return;
      await this.fs.unlink(this.path);
    } catch (_) {}
  }
}

// Describes who is blocking us, for the interface.
function describe(info) {
  if (!info) return 'another syncto run';
  return `${info.computerName} (${info.userId})`;
}

// ── Leftover lock files ───────────────────────────────────────────────────
// The protocol above clears an abandoned lock, but only when somebody asks for
// that folder again. A run killed by a crash, a cable pulled, a NAS that went
// to sleep — the lock file stays, and nothing ever mentions it. The same goes
// for the "Delete.N." corpse an interrupted takeover leaves behind: the next
// takeover clears it, and if there is no next takeover it sits there for good.
//
// Age is measured against the file's own mtime, which is exactly what the
// heartbeat refreshes every 5 s. One stat, no polling, no waiting.
//
// A network share can have a clock of its own, so this can be wrong in both
// directions: a live lock looking old, or a dead one looking fresh. Neither is
// allowed to matter — this function only REPORTS. Removing goes through
// clearStaleLock(), which does the real life-sign watch first.
function isCorpseName(name) {
  return /^Delete\.\d+\./.test(name) && name.includes(LOCK_NAME);
}

// entries: what a readdir of the folder returned ({name, size, mtime}).
// Returns [] when nothing is left over.
function findLeftoverLocks(entries, folderPath, joinPath, now) {
  const t = now || Date.now();
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.name) continue;
    const corpse = isCorpseName(e.name);
    if (e.name !== LOCK_NAME && !corpse) continue;
    const ageMs = Math.max(0, t - (e.mtime || 0));
    out.push({
      folder: folderPath,
      path  : joinPath(folderPath, e.name),
      name  : e.name,
      kind  : corpse ? 'corpse' : 'lock',
      ageMs,
      // A corpse is a lock that was ALREADY declared abandoned by whoever
      // renamed it — there is nothing left to protect. It is still given the
      // silence window, because a machine can be between its rename and its
      // unlink, and that window is milliseconds.
      stale : ageMs >= DETECT_ABANDONED_MS,
    });
  }
  return out;
}

// Removes one leftover, and re-establishes the proof first: a lock file is the
// one thing standing between two machines writing the same files, so an
// mtime that merely LOOKS old is not enough to delete it.
//
//   - a corpse is removed once it has been silent long enough;
//   - a lock this machine wrote for a process that is gone is removed at once;
//   - anything else is watched for real life signs, and left alone if it moves.
//
// Returns 'removed' | 'alive' | 'gone' | 'failed'.
async function clearStaleLock(fsx, item, opts) {
  const { onStatus, token } = opts || {};
  let st = null;
  try { st = await fsx.stat(item.path); } catch (_) { return 'failed'; }
  if (!st) return 'gone';

  if (item.kind === 'corpse') {
    const ageMs = Date.now() - (st.mtime || 0);
    if (ageMs < DETECT_ABANDONED_MS) return 'alive';
    try { await fsx.unlink(item.path); return 'removed'; }
    catch (_) { return 'failed'; }
  }

  const info = await readLockInfo(fsx, item.path);
  // A run of ours is holding this folder this very second.
  if (info && isHeldHere(info.lockId)) return 'alive';
  const status = info ? processStatus(info, localLockInfo()) : 'unknown';
  if (status === 'running') return 'alive';

  if (status === 'unknown') {
    // Another machine, or one we cannot identify: earn the right to delete it
    // the same way acquireOne does — watch the file, and back off if it moves.
    const alive = await watchLifeSigns(fsx, item.path, info, onStatus, token);
    if (alive) return 'alive';
  }

  try { await takeOver(fsx, item.path, onStatus, info, 3); }
  catch (_) { return 'failed'; }
  let after = null;
  try { after = await fsx.stat(item.path); } catch (_) { return 'removed'; }
  return after ? 'failed' : 'removed';
}

// Acquires the lock on one base folder, waiting for a live owner to finish.
// onStatus({ waiting, holder, secondsLeft }) drives the UI; token.cancelled aborts.
async function acquireOne(fsx, folderPath, opts) {
  const { onStatus, token, onLost } = opts || {};
  const lockPath = fsx.join(folderPath, LOCK_NAME);
  const local = localLockInfo();
  const payload = Buffer.from(JSON.stringify(local) + '\n', 'utf8');
  let ghostTries = 0;   // create fails "exists" but no lock file is there
  let takeoverTries = 0;

  for (;;) {
    if (token && token.cancelled) throw new Error('Cancelled');

    // Fast path: create it exclusively. Whoever wins this call owns the folder.
    let createErr;
    try {
      await fsx.writeExclusive(lockPath, payload);
      const lock = new DirLock(fsx, lockPath, local, onLost, (opts || {}).timing);
      lock._startHeartbeat();
      return lock;
    } catch (err) {
      if (!/exist/i.test(err.code || err.message || '')) throw err;
      createErr = err;
    }

    // Someone holds it. Find out who, and whether they are still breathing.
    const info = await readLockInfo(fsx, lockPath);

    // SFTPv3 has no specific "already exists" status: an exclusive create that
    // clashes AND a genuine failure both come back as "Failure". If the file
    // is not actually there, this was a real error, not a taken lock — retry a
    // few times with a pause (never a hot loop), then give up honestly.
    if (!info) {
      let st = null;
      try { st = await fsx.stat(lockPath); } catch (_) {}
      if (!st) {
        if (++ghostTries >= 5) throw createErr;
        await sleep(POLL_LIFE_SIGN_MS);
        continue;
      }
    }
    ghostTries = 0;
    const status = info ? processStatus(info, local) : 'unknown';

    if (status === 'notRunning' || status === 'itsUs') {
      await takeOver(fsx, lockPath, onStatus, info, ++takeoverTries);
      continue;                                   // and try to create it again
    }

    // Unknown owner (another machine): watch the file for life signs.
    const alive = await watchLifeSigns(fsx, lockPath, info, onStatus, token);
    if (alive) { takeoverTries = 0; continue; }
    await takeOver(fsx, lockPath, onStatus, info, ++takeoverTries);
    // Loop back and attempt the exclusive create.
  }
}

// Polls the lock file. Returns true if it is still being fed, false once it has
// been silent for DETECT_ABANDONED_MS.
async function watchLifeSigns(fsx, lockPath, info, onStatus, token) {
  let last = await fsx.stat(lockPath);
  if (!last) return false;                        // vanished: free to take
  let lastChange = Date.now();
  let lastSize = last.size, lastMtime = last.mtime;

  for (;;) {
    if (token && token.cancelled) throw new Error('Cancelled');

    const silentMs = Date.now() - lastChange;
    if (onStatus) {
      onStatus({
        waiting: true,
        holder : describe(info),
        secondsLeft: Math.max(0, Math.ceil((DETECT_ABANDONED_MS - silentMs) / 1000)),
      });
    }
    if (silentMs >= DETECT_ABANDONED_MS) return false;

    await sleep(POLL_LIFE_SIGN_MS);

    const st = await fsx.stat(lockPath);
    if (!st) return false;                        // owner finished and removed it
    if (st.size !== lastSize || st.mtime !== lastMtime) {
      lastSize = st.size; lastMtime = st.mtime; lastChange = Date.now();
    }
  }
}

// Removes an abandoned lock the safe way: rename first (atomic — only one
// waiting machine can succeed), then delete the renamed file.
async function takeOver(fsx, lockPath, onStatus, info, attempt) {
  const dir  = fsx.dirname(lockPath);
  const name = fsx.basename(lockPath);

  if (onStatus) onStatus({ waiting: true, holder: describe(info), takingOver: true });

  // The old code always renamed to "Delete.0.<name>" and deleted it on a
  // best-effort basis. A crash between the two left that file behind — and
  // SFTPv3's rename refuses an existing target, so every later takeover failed
  // for ever, silently, and the window sat on "Waiting for…" until someone
  // deleted the file by hand on the server. Try several slots, and clear a
  // stale corpse before reusing its name.
  let lastErr = null;
  for (let level = 0; level < ABANDONED_LEVEL_MAX; level++) {
    const doomed = fsx.join(dir, `Delete.${level}.${name}`);
    try {
      // renameStrict: no delete-and-retry fallback. Renaming is the whole point —
      // of two machines waiting on the same abandoned lock, exactly one may win.
      await (fsx.renameStrict ? fsx.renameStrict(lockPath, doomed) : fsx.rename(lockPath, doomed));
      try { await fsx.unlink(doomed); } catch (_) {}
      return;
    } catch (err) {
      lastErr = err;
      // Is the lock still there at all? If not, another waiter won the rename
      // or the owner released it — nothing to do but retry the create.
      let st = null;
      try { st = await fsx.stat(lockPath); } catch (_) { return; }
      if (!st) return;
      // The target is occupied by a corpse from an interrupted takeover.
      try { await fsx.unlink(doomed); } catch (_) { continue; }
    }
  }

  // Never loop for ever in silence: after enough rounds, say what is wrong and
  // where, so the user can act instead of watching a spinner.
  if (attempt >= 3) {
    throw new Error(`The lock file at ${lockPath} is abandoned but cannot be cleared` +
      (lastErr ? ` (${lastErr.message})` : '') +
      '. Delete it manually, then run the comparison again.');
  }
}

// Acquires every folder of a run. Folders are deduplicated (two pairs sharing a
// source lock it once) and sorted, so two machines requesting the same set can
// never deadlock by taking them in opposite orders.
async function acquireAll(entries, opts) {
  const seen = new Map();
  for (const e of entries) {
    if (!e || !e.fs || !e.path) continue;
    const key = `${e.fs.kind}:${e.fs.deviceKey ? e.fs.deviceKey(e.path) : ''}:${e.path}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  const list = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(x => x[1]);

  const held = [];
  try {
    for (const e of list) {
      // stat() returns null for "absent" and throws for everything else. The
      // old catch-all treated a permission error or a network hiccup as
      // "absent" and ran the whole synchronization on that folder WITHOUT a
      // lock, silently. Let the real error through.
      const st = await e.fs.stat(e.path);
      if (!st) {
        // Genuinely not there yet. Create it now rather than skipping the lock:
        // two machines starting their first backup into the same new NAS folder
        // both used to proceed unprotected, and only the second run was safe.
        try { await e.fs.mkdir(e.path); }
        catch (err) {
          throw new Error(`Cannot create ${e.path} to lock it: ${err.message}`);
        }
      }
      const lock = await acquireOne(e.fs, e.path, opts);
      held.push(lock);
    }
  } catch (err) {
    for (const l of held) { try { await l.release(); } catch (_) {} }
    throw err;
  }
  return {
    count: held.length,
    // What the network did during the run: how many times a folder stopped
    // answering, and the longest stretch that was ridden out.
    hiccups() {
      let n = 0, worst = 0;
      for (const l of held) { n += l.hiccups || 0; worst = Math.max(worst, l.worstGapMs || 0); }
      return { count: n, worstMs: worst };
    },
    // Non-null as soon as ANY of the folders stopped being ours mid-run.
    lost() {
      const l = held.find(x => x.lost);
      return l ? `${l.path}: ${l.lost}` : null;
    },
    async release() { for (const l of held) { try { await l.release(); } catch (_) {} } },
  };
}

module.exports = {
  acquireOne, acquireAll, abandonedLockName, processStatus, localLockInfo, readLockInfo,
  findLeftoverLocks, clearStaleLock, isCorpseName, checkStillOurs, isHeldHere,
  EMIT_LIFE_SIGN_MS, POLL_LIFE_SIGN_MS, DETECT_ABANDONED_MS, LOCK_NAME,
};
