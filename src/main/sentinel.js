// ingesto — Professional Camera Media Ingest
// Copyright (C) 2026 Just Edit (Arnaud Augst)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.


// ────────────────────────────────────────────────────────────────────────────
// ingesto — sentinel.js
// Writes/reads .ingesto.json on memory cards to detect when a card was
// previously ingested but not formatted before reuse.
//
// File location: <card_root>/.ingesto.json (hidden on Windows via attrib +H)
//
// File format:
// {
//   "ingesto_version": "0.9.8-beta",
//   "ingests": [
//     {
//       "date": "ISO-8601",
//       "destination": "/path/to/folder",
//       "files_count": N,
//       "files": [ { "p": "rel/path", "s": <bytes>, "m": <epoch_secs> }, ... ]
//     },
//     ...
//   ]
// }
// ────────────────────────────────────────────────────────────────────────────

const fs            = require('fs');
const path          = require('path');
const { execFile }  = require('child_process');

const SENTINEL_NAME = '.ingesto.json';

// ──────────────────────────────────────────────────────────────────────────
// Write-protect detection — try to create a tiny test file, then remove it.
// Returns true if the card root is writable.
// ──────────────────────────────────────────────────────────────────────────
function isWritable(root) {
  const testPath = path.join(root, '.ingesto_wtest_' + Date.now());
  try {
    fs.writeFileSync(testPath, '');
    try { fs.unlinkSync(testPath); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Hide a file on Windows (attrib +H). No-op on macOS/Linux (the leading
// dot in the filename already hides it in Finder).
// ──────────────────────────────────────────────────────────────────────────
function hideOnWindows(filePath) {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise(resolve => {
    execFile('attrib', ['+H', filePath], { windowsHide: true }, () => resolve());
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Read sentinel file from card root. Returns parsed object or null.
// ──────────────────────────────────────────────────────────────────────────
function readSentinel(root) {
  const sentPath = path.join(root, SENTINEL_NAME);
  if (!fs.existsSync(sentPath)) return null;
  try {
    const txt = fs.readFileSync(sentPath, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && Array.isArray(obj.ingests)) return obj;
  } catch (_) {}
  return null;
}

// True when a sentinel file EXISTS but could not be understood (truncated by an
// unplug, hand-edited, or written by a future version that changed the format).
// This must not be treated as "no sentinel": doing so silently dropped the whole
// ingest history of the card AND made the "already ingested" warning disappear.
function sentinelIsDamaged(root) {
  const sentPath = path.join(root, SENTINEL_NAME);
  if (!fs.existsSync(sentPath)) return false;
  return readSentinel(root) === null;
}

// ──────────────────────────────────────────────────────────────────────────
// Walk a directory recursively, returning a list of { p, s, m } objects.
// Skips the sentinel file itself and any dot-files we created.
// ──────────────────────────────────────────────────────────────────────────
function listAllFiles(root, currentVersion) {
  const out = [];
  function walk(dir, relBase) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const ent of entries) {
      const name = ent.name;
      const full = path.join(dir, name);
      const rel  = relBase ? `${relBase}/${name}` : name;
      // Skip sentinel + internal test files + Windows / macOS system folders
      // The tracking log and anything derived from it (.unreadable backup, the
      // .tmp of an interrupted write) are OUR bookkeeping, never footage. They
      // must not show up as "new files" and must never be copied to a client
      // destination — which is what happened once .unreadable started existing.
      if (rel === SENTINEL_NAME || rel.startsWith(SENTINEL_NAME + '.')) continue;
      if (/^\.ingesto_wtest_/.test(name)) continue;
      if (name === 'System Volume Information') continue;
      if (name === '$RECYCLE.BIN') continue;
      if (name === '.Spotlight-V100') continue;
      if (name === '.Trashes') continue;
      if (name === '.fseventsd') continue;
      if (name === '.DS_Store') continue;
      // AppleDouble metadata sidecars (._<name>) — regenerated by macOS on
      // non-native filesystems; not media, and the copy engine skips them too,
      // so tracking them here would flag every re-inserted card as "changed".
      if (ent.isFile() && name.startsWith('._')) continue;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ p: rel, s: st.size, m: Math.floor(st.mtimeMs / 1000) });
        } catch (_) {}
      }
    }
  }
  walk(root, '');
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Inspect a card: returns
//   {
//     writable: bool,
//     sentinel: <parsed sentinel or null>,
//     lastIngest: <last entry of sentinel.ingests or null>,
//     alreadyIngested: [ { p, s, m } ... ]  // files present now AND in last sentinel
//     newFiles:        [ { p, s, m } ... ]  // files present now but NOT in any sentinel ingest
//     allCurrent:      [ { p, s, m } ... ]
//   }
// ──────────────────────────────────────────────────────────────────────────
// Where a recorded ingest put its files, on ONE selected destination root —
// or null when it did not go there. The record names the card folder it
// created; that folder must sit under the root and still be there.
function ingestFolderUnder(ing, root) {
  if (!ing || !root) return null;
  const norm = p => { let r = path.resolve(String(p || '')); if (process.platform !== 'linux') r = r.toLowerCase(); return r; };
  const under = (a, b) => { const x = norm(a), y = norm(b); return x === y || y.startsWith(x.endsWith(path.sep) ? x : x + path.sep); };
  const folders = Array.isArray(ing.destinations) && ing.destinations.length ? ing.destinations : [ing.destination];
  for (const folder of folders) {
    if (!folder || !under(root, folder)) continue;
    let st = null; try { st = fs.statSync(folder); } catch (_) { continue; }
    if (st.isDirectory()) return folder;
  }
  return null;
}

// Was this recorded ingest a VERIFIED one? Recorded as such from 2.6.1 on;
// for a record written by an earlier version that did not say, INGESTO's own
// checksum list or ASC MHL history in the folder is the proof (only SECURE
// and PRO wrote them). Any other file — someone else's .md5 — is not.
function ingestVerified(ing, folder) {
  if (ing.verified === true) return true;
  if (ing.verified === false) return false;
  try {
    const own = path.basename(folder);
    return fs.readdirSync(folder).some(n =>
      n === 'ascmhl' || new RegExp('^' + own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(xxh|xxh64|xxh128|xxh3|md5|mhl)$', 'i').test(n));
  } catch (_) { return false; }
}

// The keys ("p|s|m") a recorded ingest can vouch for on ONE root: the ingest
// went there, was verified, and EACH file is still in that folder at the
// recorded size. A folder that is there but has been emptied vouches for
// nothing; a record proves the folder, never the file, unless it is checked.
function usableKeysOnRoot(ing, root) {
  const keys = new Set();
  const folder = ingestFolderUnder(ing, root);
  if (!folder || !ingestVerified(ing, folder)) return keys;
  for (const f of (ing.files || [])) {
    const rel = String(f.d || f.p || '');
    if (!rel || rel.includes('..')) continue;
    let st = null; try { st = fs.statSync(path.join(folder, rel)); } catch (_) { continue; }
    if (st.isFile() && st.size === f.s) keys.add(`${f.p}|${f.s}|${f.m}`);
  }
  return keys;
}

// Kept for callers that ask the coarse question ("did this ingest go to one of
// these roots, verified?"); the skip decision itself is per file, per root.
function ingestUsable(ing, destRoots) {
  if (!ing || !Array.isArray(destRoots) || !destRoots.length) return false;
  return destRoots.some(root => { const f = ingestFolderUnder(ing, root); return f && ingestVerified(ing, f); });
}

// `destRoots` — the destination roots selected for the coming ingest. Without
// them, `skippable` stays empty: a file may only be skipped for a destination
// that is known to hold a verified copy of it.
function inspectCard(root, probeWrite = false, destRoots = null) {
  const result = {
    writable: null,
    sentinel: null,
    lastIngest: null,
    alreadyIngested: [],
    skippable: [],
    newFiles: [],
    allCurrent: [],
  };
  try {
    if (!fs.statSync(root).isDirectory()) return result;
  } catch (_) { return result; }

  // Only probe writability when explicitly asked (it creates a temp file on the card).
  result.writable = probeWrite ? isWritable(root) : null;
  result.sentinel = readSentinel(root);
  // A sentinel that exists but cannot be read means "this card HAS a history we
  // can no longer see" — very different from a fresh card. The caller must be
  // able to tell the operator instead of quietly declaring every file new.
  result.sentinelDamaged = sentinelIsDamaged(root);
  result.allCurrent = listAllFiles(root);

  if (result.sentinel && result.sentinel.ingests.length) {
    result.lastIngest = result.sentinel.ingests[result.sentinel.ingests.length - 1];
    // "p|s|m" keys from ALL previous ingests (the card's history, for the
    // dialog) and, separately, from the ingests that can vouch for a file on
    // the destinations selected now (the only ones a copy may be skipped for).
    // A file may be skipped only when EVERY selected destination holds a
    // verified copy of it: what one root can vouch for is intersected across
    // roots. With one drive proven and a new one added, the new one used to
    // receive only today's clips — green tick, eject button, whole day missing.
    const ingestedKeys = new Set();
    for (const ing of result.sentinel.ingests) for (const f of (ing.files || [])) ingestedKeys.add(`${f.p}|${f.s}|${f.m}`);
    let usableKeys = new Set();
    if (Array.isArray(destRoots) && destRoots.length) {
      const perRoot = destRoots.map(root => {
        const keys = new Set();
        for (const ing of result.sentinel.ingests) for (const k of usableKeysOnRoot(ing, root)) keys.add(k);
        return keys;
      });
      usableKeys = perRoot.reduce((acc, keys) => new Set([...acc].filter(k => keys.has(k))));
    }
    for (const cur of result.allCurrent) {
      const key = `${cur.p}|${cur.s}|${cur.m}`;
      if (ingestedKeys.has(key)) result.alreadyIngested.push(cur);
      else                       result.newFiles.push(cur);
      if (usableKeys.has(key))   result.skippable.push(cur);
    }
  } else {
    // No sentinel → all files are new
    result.newFiles = result.allCurrent.slice();
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Append a new ingest entry to the sentinel and write it back.
//   root         = card root
//   destination  = full path of the destination folder created by ingesto
//   filesIngested = list of { p, s, m } objects describing the files copied
//   ingestoVersion = version string
//
// Returns { ok: bool, reason?: string }
// ──────────────────────────────────────────────────────────────────────────
//   meta         = { mode, verified } — what this ingest checked. Recorded so
//                  that "copy new files only" can refuse to trust a FAST run.
async function appendIngest(root, destination, filesIngested, ingestoVersion, meta) {
  if (!isWritable(root)) {
    return { ok: false, reason: 'write-protected' };
  }
  // destination may be a single path (legacy) or an array of destination paths.
  // 'destination' (singular, first path) is kept so older readers still work;
  // 'destinations' lists every destination that succeeded.
  const destList = Array.isArray(destination) ? destination : [destination];
  const sentPath = path.join(root, SENTINEL_NAME);
  let sentinel = readSentinel(root);
  if (!sentinel) {
    // Never overwrite a file we could not read: keep it beside the new one so
    // the card's history is recoverable instead of destroyed.
    if (fs.existsSync(sentPath)) {
      // A fixed name was overwritten by the NEXT rescue, destroying the very
      // history the rescue exists to keep. One backup per rescue.
      try {
        let bak = sentPath + '.unreadable';
        if (fs.existsSync(bak)) bak = `${bak}-${Date.now()}`;
        fs.renameSync(sentPath, bak);
      } catch (_) {}
    }
    sentinel = { ingesto_version: ingestoVersion, ingests: [] };
  } else {
    sentinel.ingesto_version = ingestoVersion;
  }
  sentinel.ingests.push({
    date:         new Date().toISOString(),
    destination:  destList[0] || '',
    destinations: destList,
    mode:         meta && meta.mode ? String(meta.mode) : undefined,
    verified:     meta ? meta.verified === true : undefined,
    files_count:  filesIngested.length,
    files:        filesIngested,
  });
  try {
    // Same discipline as the media files: write a temp file, then rename over
    // the target. writeFileSync truncates first, so a card pulled mid-write
    // used to leave a zero-length sentinel — i.e. no history at all.
    const tmp = sentPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(sentinel, null, 2), 'utf8');
      fs.renameSync(tmp, sentPath);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
    await hideOnWindows(sentPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { inspectCard, appendIngest, listAllFiles, isWritable, readSentinel, sentinelIsDamaged, ingestUsable, SENTINEL_NAME };
