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
function inspectCard(root, probeWrite = false) {
  const result = {
    writable: null,
    sentinel: null,
    lastIngest: null,
    alreadyIngested: [],
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
    // Build a Set of "p|s|m" keys from ALL previous ingests (every ingest in history)
    const ingestedKeys = new Set();
    for (const ing of result.sentinel.ingests) {
      for (const f of (ing.files || [])) {
        ingestedKeys.add(`${f.p}|${f.s}|${f.m}`);
      }
    }
    for (const cur of result.allCurrent) {
      const key = `${cur.p}|${cur.s}|${cur.m}`;
      if (ingestedKeys.has(key)) result.alreadyIngested.push(cur);
      else                       result.newFiles.push(cur);
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
async function appendIngest(root, destination, filesIngested, ingestoVersion) {
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
      try { fs.renameSync(sentPath, sentPath + '.unreadable'); } catch (_) {}
    }
    sentinel = { ingesto_version: ingestoVersion, ingests: [] };
  } else {
    sentinel.ingesto_version = ingestoVersion;
  }
  sentinel.ingests.push({
    date:         new Date().toISOString(),
    destination:  destList[0] || '',
    destinations: destList,
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

module.exports = { inspectCard, appendIngest, listAllFiles, isWritable, readSentinel, sentinelIsDamaged, SENTINEL_NAME };
