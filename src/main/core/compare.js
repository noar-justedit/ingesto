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

// Traversal of both sides and categorization of every item.
//
// Comparison variants
//   'timeSize'  modification time + size   (fast, the sane default)
//   'content'   byte for byte              (slow, catches silent corruption)
//   'size'      size only                  (for filesystems with useless dates)
//
// Time comparison uses a tolerance (2 s by default) because FAT/exFAT store
// timestamps with 2-second resolution and SFTP with 1-second resolution — a
// file copied from an SD card to a NAS is legitimately "off by one second".
// Optional whole-hour shifts cover DST and timezone-naive filesystems.

const { PathFilter, SoftFilter } = require('./filter');
// Required lazily: lock.js takes LOCK_NAME from this file, so importing it at
// the top would be a cycle and LOCK_NAME would be undefined on one of the two
// load orders. One call per comparison, so the lookup costs nothing.
let _lockMod = null;
function lockMod() { return (_lockMod || (_lockMod = require('./lock'))); }

const CAT = {
  EQUAL      : 'equal',
  LEFT_ONLY  : 'leftOnly',
  RIGHT_ONLY : 'rightOnly',
  LEFT_NEWER : 'leftNewer',
  RIGHT_NEWER: 'rightNewer',
  DIFFERENT  : 'different',
  TIME_INVALID: 'timeInvalid',
  CONFLICT   : 'conflict',
};

const OP = {
  NONE          : 'none',            // both sides already identical
  CREATE_LEFT   : 'createLeft',
  CREATE_RIGHT  : 'createRight',
  DELETE_LEFT   : 'deleteLeft',
  DELETE_RIGHT  : 'deleteRight',
  OVERWRITE_LEFT: 'overwriteLeft',
  OVERWRITE_RIGHT: 'overwriteRight',
  // A detected move: the same file left one path and appeared at another, so
  // the other side renames instead of copying gigabytes and deleting the old
  // copy. FROM marks the old path, TO the new one; the two nodes are paired.
  MOVE_LEFT_FROM : 'moveLeftFrom',   // rename happens on the LEFT side
  MOVE_LEFT_TO   : 'moveLeftTo',
  MOVE_RIGHT_FROM: 'moveRightFrom',  // rename happens on the RIGHT side
  MOVE_RIGHT_TO  : 'moveRightTo',
  DO_NOTHING    : 'doNothing',       // deliberately skipped
  CONFLICT      : 'conflict',        // needs a human decision
};

const TEMP_EXT   = '.syncto_tmp';
// A target parked out of the way while its replacement is renamed into place
// (SFTP has no atomic replace). Normally gone within milliseconds; a dropped
// connection can strand one, and the next run sweeps it like any leftover.
const OLD_EXT    = '.syncto_old';
const DB_NAME    = '.syncto.db';      // gzipped JSON, one per base folder
const LOCK_NAME  = '.syncto.lock';
const DEFAULT_TOLERANCE_SEC = 2;

const CHECKSUM_FILE = 'syncto-checksums.txt';

// Items syncto always ignores: its own scaffolding plus the usual OS litter.
// The checksum list is deliberately visible — a DIT should be able to find it —
// so it has to be excluded by name, otherwise the next mirror run would treat
// it as a stray file on the target and delete it.
const ALWAYS_SKIP = new Set([
  CHECKSUM_FILE,
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
  '.DocumentRevisions-V100',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]);

// The skipped names that are FOLDERS, and whose contents belong to the
// operating system rather than to anyone: Windows indexing and restore data,
// Spotlight's index, the FSEvents journal. When syncto is removing the folder
// that holds one of them, it may take it whole — the volume recreates it on
// the spot if it still wants it.
//
// This is the list that was missing. The comparison skipped these names, so a
// folder holding one of them looked empty; the removal only ever unlinked
// FILES, so it never could be. Every run reported "ENOTEMPTY: directory not
// empty" on a folder Finder showed as empty, and no run could ever clear it.
//
// ".Trashes" and "$RECYCLE.BIN" are deliberately NOT here: they hold files
// somebody deleted and may want back. A folder containing one of those is
// refused, with an explanation.
const OS_LITTER_FOLDERS = new Set([
  'System Volume Information', '.Spotlight-V100', '.fseventsd',
  '.TemporaryItems', '.DocumentRevisions-V100',
]);

function isSyncToInternal(name) {
  if (name === DB_NAME || name === LOCK_NAME || name.startsWith('.syncto.')) return true;
  // A lock being taken over is renamed "Delete.N.<name>" for an instant; if a
  // comparison runs at that exact moment it must not see it as a user file.
  return /^Delete\.\d+\./.test(name) && name.includes('.syncto.');
}

// ── Time helpers ───────────────────────────────────────────────────────────
function sameTime(a, b, toleranceSec, shiftMinutes) {
  const tol = (toleranceSec == null ? DEFAULT_TOLERANCE_SEC : toleranceSec) * 1000;
  const diff = Math.abs(a - b);
  if (diff <= tol) return true;
  for (const m of (shiftMinutes || [])) {
    const shift = Math.abs(m) * 60000;
    if (Math.abs(diff - shift) <= tol) return true;
  }
  return false;
}

// 'equal' | 'leftNewer' | 'rightNewer' | 'leftInvalid' | 'rightInvalid'
function compareTime(lhs, rhs, toleranceSec, shiftMinutes, now) {
  if (sameTime(lhs, rhs, toleranceSec, shiftMinutes)) return 'equal';
  const oneYearAhead = (now || Date.now()) + 365 * 86400000;
  if (lhs < 0 || lhs > oneYearAhead) return 'leftInvalid';
  if (rhs < 0 || rhs > oneYearAhead) return 'rightInvalid';
  return lhs < rhs ? 'rightNewer' : 'leftNewer';
}

// ── Byte-for-byte comparison ───────────────────────────────────────────────
// Returns true, false, or NULL when the token was cancelled mid-file. Null is
// not "different": returning false there marked byte-identical files for
// overwrite, and the run that followed re-copied them for nothing.
async function equalContent(fsL, pl, fsR, pr, onBytes, token) {
  const a = fsL.createReadStream(pl);
  const b = fsR.createReadStream(pr);
  let bufA = Buffer.alloc(0), bufB = Buffer.alloc(0);
  let endA = false, endB = false, equal = true, done = false, cancelled = false;

  const pull = (stream, which) => new Promise((resolve, reject) => {
    const onData = chunk => { stream.pause(); cleanup(); resolve(chunk); };
    const onEnd  = () => { cleanup(); resolve(null); };
    const onErr  = e => { cleanup(); reject(e); };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onErr);
    };
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onErr);
    stream.resume();
  });

  try {
    while (!done) {
      if (token && token.cancelled) { cancelled = true; break; }
      if (!endA && bufA.length === 0) {
        const c = await pull(a, 'a');
        if (c == null) endA = true; else bufA = c;
      }
      if (!endB && bufB.length === 0) {
        const c = await pull(b, 'b');
        if (c == null) endB = true; else bufB = c;
      }
      if (endA && endB) break;
      if (endA !== endB) { equal = false; break; }
      const n = Math.min(bufA.length, bufB.length);
      if (Buffer.compare(bufA.subarray(0, n), bufB.subarray(0, n)) !== 0) { equal = false; break; }
      if (onBytes) onBytes(n);
      bufA = bufA.subarray(n);
      bufB = bufB.subarray(n);
    }
  } finally {
    try { a.destroy(); } catch (_) {}
    try { b.destroy(); } catch (_) {}
  }
  return cancelled ? null : equal;
}

// ── Tree building ──────────────────────────────────────────────────────────
// One node per item, flat, parents before children (depth-first pre-order) so
// the grid can render it directly and folder rules can look at direct children.
class Comparer {
  // ctx: { left:{fs,path}, right:{fs,path}, config, token, onProgress }
  constructor(ctx) {
    this.left   = ctx.left;
    this.right  = ctx.right;
    this.cfg    = ctx.config || {};
    this.token  = ctx.token || { cancelled: false };
    this.onProgress = ctx.onProgress || (() => {});
    this.filter = new PathFilter(this.cfg.includeFilter, this.cfg.excludeFilter);
    this.soft   = new SoftFilter(this.cfg.softFilter);
    this.nodes  = [];
    this.errors = [];
    this.leftovers = [];      // stray .syncto_tmp files from an interrupted run
    this.locks = [];          // lock files a run that never finished left behind
    this.stats  = { scanned: 0, comparedBytes: 0 };
    this.symlinks = this.cfg.symlinks || 'exclude';   // exclude | asLink
    // How many items these two folders held at the end of the last run, read
    // from the database before the scan started. Zero on a first comparison.
    //
    // Walking a tree has no total you can know in advance — you find out how
    // big it is by finishing — so this is the only honest source of a
    // percentage, and it is an ESTIMATE: the tree has changed since, which is
    // the whole reason for comparing. The interface says "about".
    this.expected = Math.max(0, ctx.expected || 0);
    this.startedAt = Date.now();
  }

  _emit(current) {
    this.onProgress({
      phase  : 'compare',
      scanned: this.stats.scanned,
      bytes  : this.stats.comparedBytes,
      expected: this.expected,
      elapsedMs: Date.now() - this.startedAt,
      current,
    });
  }

  // Per-side spelling of a name that only exists on the other side. A Mac
  // stores "é" decomposed (NFD), a Linux server or a Windows share composed
  // (NFC); reusing the source spelling to build the destination path makes the
  // target create a SECOND file next to the one already there.
  _spell(side, name) {
    const fsx = (side === 'left' ? this.left : this.right).fs;
    return fsx.normalizeName ? fsx.normalizeName(name) : name;
  }

  async run() {
    const lRoot = await this.left.fs.stat(this.left.path);
    const rRoot = await this.right.fs.stat(this.right.path);
    if (!lRoot && !rRoot) throw new Error('Neither folder exists.');
    // `missingRoot` is what tells sync() this side is empty because it is gone,
    // not because it is genuinely empty. A missing base folder plus a mirror is
    // a mass deletion of the healthy side — see Session.sync().
    if (!lRoot) this.errors.push({ path: this.left.path,  message: 'Left folder not found — it will be created.',  missingRoot: 'left'  });
    if (!rRoot) this.errors.push({ path: this.right.path, message: 'Right folder not found — it will be created.', missingRoot: 'right' });

    // One event before anything is walked, and one after. Without the first,
    // nothing reaches the window until the 200th item — on a slow share or a
    // deep tree that is a long stare at an empty progress panel. Without the
    // last, the final count the window was shown is whatever the 200-item
    // boundary happened to land on, and the running total across pairs starts
    // the next pair from a stale number.
    this._emit('');
    await this._walk({ c: '', l: '', r: '' }, -1, 0, !!lRoot, !!rRoot);
    this._emit('');
    return {
      nodes: this.nodes, errors: this.errors, stats: this.stats,
      leftovers: this.leftovers,
      locks: this.locks,
      cancelled: !!this.token.cancelled,
    };
  }

  // Returns a Map, or null when the directory could not be read. Null is NOT
  // an empty folder: treating an unreadable side as empty would make every
  // file on the healthy side look one-sided — and a mirror would delete them.
  async _list(side, relDir, exists) {
    if (!exists) return new Map();
    const base = side === 'left' ? this.left : this.right;
    const dir  = relDir ? base.fs.join(base.path, ...relDir.split('/')) : base.path;
    try {
      const list = await base.fs.readdir(dir);
      // Lock files live at the ROOT of a base folder and nowhere else. The
      // listing is already in hand, so noticing a leftover costs nothing — and
      // the walk hides these names from the user, which is exactly why nobody
      // ever found out one had been left behind by a run that never finished.
      if (!relDir) {
        this.locks.push(...lockMod()
          .findLeftoverLocks(list, base.path, (d, n) => base.fs.join(d, n))
          .map(x => Object.assign(x, { side })));
      }
      const map = new Map();
      for (const e of list) {
        if (ALWAYS_SKIP.has(e.name) || isSyncToInternal(e.name)) continue;
        if (e.name.endsWith(TEMP_EXT) || e.name.endsWith(OLD_EXT)) {
          // Leftover from a run that was killed or lost power. It is invisible
          // to the comparison — which is right — but nothing ever removed it
          // either, so an interrupted 180 GB copy sat on the NAS for ever and
          // the space vanished with no explanation anywhere in the app.
          this.leftovers.push({ side, path: base.fs.join(dir, e.name), size: e.size || 0 });
          continue;
        }
        if (e.type === 'symlink' && this.symlinks === 'exclude') continue;
        if (e.type === 'other') continue;
        // Case-insensitive key so a Mac and a Windows share agree on identity,
        // while the original spelling is preserved for display and for I/O.
        const key = e.name.normalize('NFC').toLowerCase();
        if (map.has(key)) {
          // Two items differing only by case cannot both exist on the other
          // side of a case-insensitive filesystem; keep the first, flag it.
          this.errors.push({
            path: base.fs.join(dir, e.name),
            message: `"${e.name}" and "${map.get(key).name}" differ only by upper/lower case — only the first is synchronized.`,
          });
          continue;
        }
        map.set(key, e);
      }
      return map;
    } catch (err) {
      this.errors.push({ path: dir, message: err.message || String(err), fatal: true });
      return null;
    }
  }

  // `rels` carries three views of the current directory: `c` the canonical one
  // (NFC, side-independent — it keys the database and the grid), `l` and `r`
  // the spelling each side really has on disk.
  async _walk(rels, parentIdx, depth, lExists, rExists) {
    if (this.token.cancelled) return;
    const [L, R] = await Promise.all([
      this._list('left',  rels.l, lExists),
      this._list('right', rels.r, rExists),
    ]);
    // One side unreadable: comparing would fabricate one-sided items and turn
    // an I/O error into deletions. The whole directory is left out instead;
    // the fatal error recorded by _list blocks the synchronization.
    if (!L || !R) return;

    const keys = new Set([...L.keys(), ...R.keys()]);
    const sorted = [...keys].sort();

    for (const key of sorted) {
      if (this.token.cancelled) return;
      const l = L.get(key) || null;
      const r = R.get(key) || null;
      const name  = (l || r).name.normalize('NFC');
      const rel   = rels.c ? rels.c + '/' + name : name;
      const lName = l ? l.name : this._spell('left',  name);
      const rName = r ? r.name : this._spell('right', name);
      const child = {
        c: rel,
        l: rels.l ? rels.l + '/' + lName : lName,
        r: rels.r ? rels.r + '/' + rName : rName,
      };

      const kind = (l || r).type;
      // A folder on one side and a file on the other: not comparable.
      const typeClash = l && r && l.type !== r.type;

      if (kind === 'folder' && !typeClash) {
        if (!this.filter.passFolder(rel)) continue;
        const idx = this.nodes.length;
        this.nodes.push(this._makeNode(idx, child, name, 'folder', parentIdx, depth, l, r, null));
        this.stats.scanned++;
        if (this.nodes.length % 200 === 0) this._emit(rel);
        await this._walk(child, idx, depth + 1, !!l, !!r);
        continue;
      }

      if (!this.filter.passFile(rel)) continue;
      const node = this._makeNode(this.nodes.length, child, name,
        typeClash ? 'file' : kind, parentIdx, depth, l, r, typeClash);
      if (!typeClash && l && r && kind !== 'symlink') await this._categorizeFile(node, child, l, r);
      else if (!typeClash && l && r && kind === 'symlink') await this._categorizeSymlink(node, child, l, r);
      this.nodes.push(node);
      this.stats.scanned++;
      if (this.nodes.length % 200 === 0) this._emit(rel);
    }
  }

  _makeNode(idx, rels, name, type, parentIdx, depth, l, r, typeClash) {
    const rel = rels.c;
    const node = {
      idx, rel, relL: rels.l, relR: rels.r, name, type, parent: parentIdx, depth,
      left : l ? { exists: true, size: l.size, mtime: l.mtime, id: l.id } : { exists: false },
      right: r ? { exists: true, size: r.size, mtime: r.mtime, id: r.id } : { exists: false },
      cat  : CAT.EQUAL,
      catMsg: '',
      dir  : 'none',
      op   : OP.NONE,
      active: true,
      dbChangeL: 'noChange',
      dbChangeR: 'noChange',
      movePair: null,       // idx of the paired node when part of a detected move
      preMoveOp: null,      // what the op was before pairing, to undo cleanly
    };
    if (typeClash) {
      node.cat = CAT.CONFLICT;
      node.catMsg = 'One side is a file, the other a folder.';
    } else if (l && !r) {
      node.cat = CAT.LEFT_ONLY;
    } else if (!l && r) {
      node.cat = CAT.RIGHT_ONLY;
    } else if (type === 'folder') {
      node.cat = CAT.EQUAL;
    }
    // Soft filter marks rows inactive without removing them from the view.
    // Either side passing is enough: judging a two-sided item on the left copy
    // alone silently dropped a file edited yesterday on the right because the
    // left copy was a year old.
    if (type !== 'folder') {
      const ok = (l && this.soft.passes(l.size, l.mtime)) ||
                 (r && this.soft.passes(r.size, r.mtime));
      if (!ok) node.active = false;
    }
    return node;
  }

  async _categorizeFile(node, rels, l, r) {
    const rel = rels.c;
    const variant = this.cfg.compareVariant || 'timeSize';
    const tol     = this.cfg.timeTolerance;
    const shifts  = this.cfg.timeShifts || [];

    if (variant === 'size') {
      node.cat = (l.size === r.size) ? CAT.EQUAL : CAT.DIFFERENT;
      return;
    }

    if (variant === 'content') {
      if (l.size !== r.size) { node.cat = CAT.DIFFERENT; return; }
      if (!node.active) {                       // excluded by the soft filter
        node.cat = CAT.CONFLICT;
        node.catMsg = 'Content comparison was skipped for an excluded file.';
        return;
      }
      const pl = this.left.fs.join(this.left.path, ...rels.l.split('/'));
      const pr = this.right.fs.join(this.right.path, ...rels.r.split('/'));
      try {
        this._emit(rel);
        const same = await equalContent(
          this.left.fs, pl, this.right.fs, pr,
          n => { this.stats.comparedBytes += n; }, this.token);
        // Cancelled mid-file: leave the node on its harmless default (equal,
        // no operation). The run is flagged cancelled, so nothing will be
        // synchronized from this half-built tree anyway.
        if (same === null) return;
        node.cat = same ? CAT.EQUAL : CAT.DIFFERENT;
      } catch (err) {
        node.cat = CAT.CONFLICT;
        node.catMsg = err.message || String(err);
        this.errors.push({ path: pl, message: node.catMsg });
      }
      return;
    }

    // timeSize
    const res = compareTime(l.mtime, r.mtime, tol, shifts);
    if (res === 'equal') {
      if (l.size === r.size) node.cat = CAT.EQUAL;
      else { node.cat = CAT.CONFLICT; node.catMsg = 'Same date but a different size.'; }
    } else if (res === 'leftInvalid' || res === 'rightInvalid') {
      node.cat = CAT.TIME_INVALID;
      node.catMsg = 'Invalid modification date.';
    } else {
      node.cat = res === 'leftNewer' ? CAT.LEFT_NEWER : CAT.RIGHT_NEWER;
    }
  }

  async _categorizeSymlink(node, rels, l, r) {
    const variant = this.cfg.compareVariant || 'timeSize';
    if (variant === 'timeSize') {
      const res = compareTime(l.mtime, r.mtime, this.cfg.timeTolerance, this.cfg.timeShifts);
      if (res === 'equal') { node.cat = CAT.EQUAL; return; }
      // A symlink has no content of its own but its target, and a recreated
      // link always carries today's date — on a filesystem without lutimes
      // (SFTP) the dates can never match. Ask what the links point at before
      // declaring one newer, or the pair is re-copied every single run.
      try {
        const a = await this.left.fs.readlink(this.left.fs.join(this.left.path, ...rels.l.split('/')));
        const b = await this.right.fs.readlink(this.right.fs.join(this.right.path, ...rels.r.split('/')));
        if (a === b) { node.cat = CAT.EQUAL; return; }
      } catch (_) { /* fall through to the date verdict */ }
      node.cat = res === 'leftNewer' ? CAT.LEFT_NEWER
               : res === 'rightNewer' ? CAT.RIGHT_NEWER
               : CAT.TIME_INVALID;
      return;
    }
    try {
      const a = await this.left.fs.readlink(this.left.fs.join(this.left.path, ...rels.l.split('/')));
      const b = await this.right.fs.readlink(this.right.fs.join(this.right.path, ...rels.r.split('/')));
      node.cat = (a === b) ? CAT.EQUAL : CAT.DIFFERENT;
    } catch (err) {
      node.cat = CAT.CONFLICT;
      node.catMsg = err.message || String(err);
    }
  }
}

module.exports = {
  Comparer, CAT, OP, compareTime, sameTime, equalContent,
  TEMP_EXT, OLD_EXT, DB_NAME, LOCK_NAME, CHECKSUM_FILE, ALWAYS_SKIP, OS_LITTER_FOLDERS,
  isSyncToInternal,
  DEFAULT_TOLERANCE_SEC,
};
