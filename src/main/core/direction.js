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

// Turns "these two items differ" into "do this to that side".
//
// Two decision models, exactly like FreeFileSync:
//
//   BY DIFFERENCE — looks only at the current state of both sides. No memory,
//   no database. Mirror and Custom work this way.
//
//   BY CHANGE — compares each side against the last synchronized state stored
//   in .syncto.db.json, so it can tell "this file was deleted on the left" from
//   "this file was created on the right". Two way and Update need it. Without a
//   database (first run) it falls back to the by-difference projection, which
//   is why the very first two-way run only ever copies, never deletes.

const { CAT, OP, sameTime } = require('./compare');

function diffDefaults(variant) {
  switch (variant) {
    case 'mirror': return { leftOnly: 'right', rightOnly: 'right', leftNewer: 'right', rightNewer: 'right' };
    case 'update': return { leftOnly: 'right', rightOnly: 'none',  leftNewer: 'right', rightNewer: 'none'  };
    case 'twoWay': return { leftOnly: 'right', rightOnly: 'left',  leftNewer: 'right', rightNewer: 'left'  };
    default:       return { leftOnly: 'right', rightOnly: 'left',  leftNewer: 'right', rightNewer: 'left'  };
  }
}

function changeDefaults(variant) {
  switch (variant) {
    case 'twoWay': return {
      left : { create: 'right', update: 'right', delete: 'right' },
      right: { create: 'left',  update: 'left',  delete: 'left'  },
    };
    case 'update': return {
      left : { create: 'right', update: 'right', delete: 'none' },
      right: { create: 'none',  update: 'none',  delete: 'none' },
    };
    default: return {
      left : { create: 'right', update: 'right', delete: 'right' },
      right: { create: 'left',  update: 'left',  delete: 'left'  },
    };
  }
}

function usesDatabase(variant) { return variant === 'twoWay' || variant === 'update'; }

// ── By difference ──────────────────────────────────────────────────────────
function directionByDiff(node, d) {
  switch (node.cat) {
    case CAT.EQUAL:       return { dir: 'none' };
    case CAT.LEFT_ONLY:   return { dir: d.leftOnly };
    case CAT.RIGHT_ONLY:  return { dir: d.rightOnly };
    case CAT.LEFT_NEWER:  return { dir: d.leftNewer };
    case CAT.RIGHT_NEWER: return { dir: d.rightNewer };
    case CAT.DIFFERENT:
      if (d.leftNewer === d.rightNewer) return { dir: d.leftNewer };
      return { dir: 'conflict', msg: 'The items have different content, but it is unknown which side changed.' };
    case CAT.TIME_INVALID:
      if (d.leftNewer === d.rightNewer) return { dir: d.leftNewer };
      return { dir: 'conflict', msg: node.catMsg || 'Invalid modification date.' };
    case CAT.CONFLICT:
    default:
      return { dir: 'conflict', msg: node.catMsg || 'Conflict.' };
  }
}

// ── By change ──────────────────────────────────────────────────────────────
// 'noChange' | 'create' | 'update' | 'delete'
function sideChange(sideState, dbSide, type, tol, shifts) {
  if (!sideState || !sideState.exists) return dbSide ? 'delete' : 'noChange';
  if (!dbSide) return 'create';
  if (type === 'folder') return 'noChange';
  if (type === 'symlink') return sameTime(sideState.mtime, dbSide.mtime, tol, shifts) ? 'noChange' : 'update';
  if (sameTime(sideState.mtime, dbSide.mtime, tol, shifts) && sideState.size === dbSide.size) return 'noChange';
  return 'update';
}

// Is the recorded state still a valid "in sync" reference under the current
// comparison variant? A database written with time+size cannot vouch for a
// content comparison, and vice versa. Folders always pass: their recorded
// mtimes are incidental (creating a file inside touches them) and carry no
// synchronization meaning.
function stillInSync(dbEntry, variant, tol, shifts) {
  if (!dbEntry) return true;
  if (dbEntry.type === 'folder') return true;
  if (variant === 'size') return true;
  if (variant === 'content') return dbEntry.cmpVar === 'content';
  if (dbEntry.cmpVar === 'content') return true;
  // Written by a run of ours: the two sides were made identical then, whatever
  // dates they ended up carrying. Comparing the two stored dates here is only
  // meaningful for entries recorded from an observation, not from an action.
  if (dbEntry.synced) return true;
  return sameTime(dbEntry.left.mtime, dbEntry.right.mtime, tol, shifts);
}

function directionByChange(node, dirs, dbEntry, cfg) {
  const tol = cfg.timeTolerance, shifts = cfg.timeShifts || [];

  if (node.cat === CAT.CONFLICT) return { dir: 'conflict', msg: node.catMsg || 'Conflict.' };

  // Both sides are identical RIGHT NOW: they are in sync, whatever the
  // database believes. Without this, a file created identically on both sides
  // (or one synchronized by another tool) would be flagged "both sides have
  // changed" forever — a conflict no run could ever clear, since conflicts are
  // skipped and skipping preserves the stale database entry.
  if (node.cat === CAT.EQUAL) return { dir: 'none' };

  if (!stillInSync(dbEntry, cfg.compareVariant || 'timeSize', tol, shifts)) {
    return { dir: 'conflict', msg: 'The database entry is not in sync with the current comparison settings.' };
  }

  const cl = sideChange(node.left,  dbEntry ? dbEntry.left  : null, node.type, tol, shifts);
  const cr = sideChange(node.right, dbEntry ? dbEntry.right : null, node.type, tol, shifts);
  node.dbChangeL = cl;
  node.dbChangeR = cr;

  if (cl === 'noChange' && cr === 'noChange') {
    if (node.cat === CAT.EQUAL) return { dir: 'none' };
    // Neither side has moved since a state WE wrote. The two dates differ
    // because the copy could not carry the source's date (SFTP without
    // SETSTAT, a FAT volume, "preserve dates" off) — not because anything
    // changed. Calling that a conflict is a trap: conflicts are skipped, a
    // skip leaves the database untouched, and the same conflict comes back on
    // every run for ever.
    if (dbEntry && dbEntry.synced) return { dir: 'none' };
    return { dir: 'conflict', msg: 'Cannot determine a direction: no change since the last synchronization.' };
  }
  if (cr === 'noChange') return { dir: dirs.left[cl]  || 'none' };
  if (cl === 'noChange') return { dir: dirs.right[cr] || 'none' };

  const dl = dirs.left[cl]  || 'none';
  const dr = dirs.right[cr] || 'none';
  if (dl === dr) return { dir: dl };
  return { dir: 'conflict', msg: 'Both sides have changed since the last synchronization.' };
}

// ── Direction -> operation ─────────────────────────────────────────────────
function operationFor(node) {
  if (!node.active) return OP.DO_NOTHING;
  if (node.dir === 'conflict') return OP.CONFLICT;

  const l = node.left.exists, r = node.right.exists;

  if (node.dir === 'none') {
    return (node.cat === CAT.EQUAL) ? OP.NONE : OP.DO_NOTHING;
  }
  if (l && !r) return node.dir === 'right' ? OP.CREATE_RIGHT : OP.DELETE_LEFT;
  if (!l && r) return node.dir === 'left'  ? OP.CREATE_LEFT  : OP.DELETE_RIGHT;
  if (l && r)  return node.dir === 'left'  ? OP.OVERWRITE_LEFT : OP.OVERWRITE_RIGHT;
  return OP.DO_NOTHING;
}

// ── Public entry point ─────────────────────────────────────────────────────
// syncCfg: { variant, custom:{leftOnly,rightOnly,leftNewer,rightNewer},
//            customChange:{left:{...},right:{...}} }
// db:      { get(rel) -> entry | null }  or null
function applyDirections(nodes, syncCfg, cmpCfg, db) {
  const variant = syncCfg.variant || 'mirror';
  const haveDb  = !!db && db.available;
  const byChange = usesDatabase(variant) && haveDb;

  const diffDirs   = variant === 'custom' && syncCfg.custom ? syncCfg.custom : diffDefaults(variant);
  const changeDirs = variant === 'custom' && syncCfg.customChange ? syncCfg.customChange : changeDefaults(variant);

  for (const node of nodes) {
    let res;
    if (byChange) res = directionByChange(node, changeDirs, db.get(node.rel), cmpCfg);
    else          res = directionByDiff(node, diffDirs);

    node.dir = res.dir === 'conflict' ? 'conflict' : res.dir;
    if (res.msg) node.catMsg = res.msg;
    node.op = operationFor(node);
  }

  applyFolderRules(nodes);
  return { byChange, variant };
}

// ── Moved-file detection ───────────────────────────────────────────────────
// A rename or a move leaves a signature: the file vanished from one path and an
// identical file appeared at another, with the SAME file id (inode), because a
// rename does not touch the data. When the database from the previous run maps
// that id to its old path, the pair is certain — so instead of copying the
// whole file to the other side and deleting the old copy there, the other side
// simply renames too.
//
// Requirements, all checked here:
//   - the database (so ids need at least one previous run — the first sync
//     after enabling this still copies);
//   - stable file ids, which local disks have and SFTP does not;
//   - unambiguous ids: hard links share an inode, so any id seen twice on one
//     side is discarded rather than guessed at;
//   - the pending plan must actually be "create here + delete there" — a move
//     is only ever an optimization of what was already going to happen, never
//     a new decision. Update mode, which forbids deletions, therefore never
//     produces one.
function detectMoves(nodes, db) {
  if (!db || !db.available) return 0;

  const byRel = new Map();
  for (const n of nodes) byRel.set(n.rel, n);

  // One-side-only file nodes with a usable id, ambiguous ids purged.
  const collect = side => {
    const map = new Map(), dupes = new Set();
    for (const n of nodes) {
      if (n.type !== 'file' || !n.active) continue;
      const s = n[side];
      const o = n[side === 'left' ? 'right' : 'left'];
      if (!s.exists || o.exists || !s.id) continue;
      if (map.has(s.id) || dupes.has(s.id)) { map.delete(s.id); dupes.add(s.id); continue; }
      map.set(s.id, n);
    }
    return map;
  };
  const newLeft  = collect('left');    // candidates that appeared on the left
  const newRight = collect('right');

  // Database ids, ambiguous ones purged the same way.
  const dbByIdL = new Map(), dbByIdR = new Map();
  {
    const dupL = new Set(), dupR = new Set();
    for (const rel of Object.keys(db.items)) {
      const e = db.items[rel];
      if (e.t !== 'f') continue;
      if (e.li) {
        if (dbByIdL.has(e.li) || dupL.has(e.li)) { dbByIdL.delete(e.li); dupL.add(e.li); }
        else dbByIdL.set(e.li, rel);
      }
      if (e.ri) {
        if (dbByIdR.has(e.ri) || dupR.has(e.ri)) { dbByIdR.delete(e.ri); dupR.add(e.ri); }
        else dbByIdR.set(e.ri, rel);
      }
    }
  }

  let pairs = 0;

  // side = the side the user moved the file on; the OTHER side renames.
  const tryPair = (candidates, dbById, side) => {
    const other = side === 'left' ? 'right' : 'left';
    const createOp = other === 'right' ? OP.CREATE_RIGHT : OP.CREATE_LEFT;
    const deleteOp = other === 'right' ? OP.DELETE_RIGHT : OP.DELETE_LEFT;
    const moveTo   = other === 'right' ? OP.MOVE_RIGHT_TO   : OP.MOVE_LEFT_TO;
    const moveFrom = other === 'right' ? OP.MOVE_RIGHT_FROM : OP.MOVE_LEFT_FROM;

    for (const [id, toNode] of candidates) {
      const oldRel = dbById.get(id);
      if (oldRel == null || oldRel === toNode.rel) continue;
      const fromNode = byRel.get(oldRel);
      if (!fromNode || fromNode.type !== 'file' || fromNode.movePair != null) continue;
      // The old path must still hold the file on the other side, scheduled for
      // deletion there — and the new path must be scheduled for creation there.
      if (toNode.op !== createOp || fromNode.op !== deleteOp) continue;
      // The surviving copy must match what the database remembers, otherwise
      // the file changed as well as moved and a real copy is safer.
      const e = db.items[oldRel];
      const sideKey = side === 'left' ? 'ls' : 'rs';
      if (e && e[sideKey] != null && e[sideKey] !== toNode[side].size) continue;

      toNode.preMoveOp   = toNode.op;
      fromNode.preMoveOp = fromNode.op;
      toNode.op   = moveTo;
      fromNode.op = moveFrom;
      toNode.movePair   = fromNode.idx;
      fromNode.movePair = toNode.idx;
      pairs++;
    }
  };

  tryPair(newLeft,  dbByIdL, 'left');    // moved on the left → right renames
  tryPair(newRight, dbByIdR, 'right');   // moved on the right → left renames

  if (pairs) applyFolderRules(nodes);
  return pairs;
}

// Dissolves a move pair back into its original copy + delete, e.g. when the
// user manually overrides one of the two rows.
function dissolveMove(nodes, node) {
  if (node.movePair == null) return;
  const mate = nodes[node.movePair];
  node.op = node.preMoveOp || node.op;
  node.movePair = null; node.preMoveOp = null;
  if (mate) {
    mate.op = mate.preMoveOp || mate.op;
    mate.movePair = null; mate.preMoveOp = null;
  }
}

// Folders follow their children:
//  - a folder that does not exist on the target side must be created as soon as
//    one of its children is being created there, whatever its own category;
//  - a folder deletion is cancelled when any direct child is being kept, since
//    deleting the folder would take that child with it.
function applyFolderRules(nodes) {
  const childrenOf = new Map();
  for (const n of nodes) {
    if (n.parent < 0) continue;
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  }

  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type !== 'folder') continue;
    const kids = childrenOf.get(n.idx) || [];

    const needsRight = kids.some(k => k.op === OP.CREATE_RIGHT || k.op === OP.OVERWRITE_RIGHT || k.op === OP.MOVE_RIGHT_TO);
    const needsLeft  = kids.some(k => k.op === OP.CREATE_LEFT  || k.op === OP.OVERWRITE_LEFT  || k.op === OP.MOVE_LEFT_TO);

    if (!n.right.exists && needsRight && n.op !== OP.CREATE_RIGHT) n.op = OP.CREATE_RIGHT;
    if (!n.left.exists  && needsLeft  && n.op !== OP.CREATE_LEFT)  n.op = OP.CREATE_LEFT;

    if (n.op === OP.DELETE_LEFT || n.op === OP.DELETE_RIGHT) {
      const side = n.op === OP.DELETE_LEFT ? 'left' : 'right';
      // A child leaving through a move still leaves — it is not a survivor.
      const departing = side === 'left' ? OP.MOVE_LEFT_FROM : OP.MOVE_RIGHT_FROM;
      const survivor = kids.some(k => k.op !== n.op && k.op !== departing && k[side].exists);
      if (survivor) n.op = OP.DO_NOTHING;
    }
  }
}

// ── Statistics ─────────────────────────────────────────────────────────────
function computeStats(nodes) {
  const s = {
    rows: nodes.length,
    createLeft: 0, createRight: 0,
    updateLeft: 0, updateRight: 0,
    deleteLeft: 0, deleteRight: 0,
    moveLeft: 0, moveRight: 0,
    conflicts: 0, equal: 0, excluded: 0, doNothing: 0,
    bytesLeft: 0, bytesRight: 0, bytesTotal: 0,
    filesToProcess: 0,
    conflictList: [],
    catCounts: {},
  };
  for (const n of nodes) {
    s.catCounts[n.cat] = (s.catCounts[n.cat] || 0) + 1;
    if (!n.active) { s.excluded++; }
    switch (n.op) {
      case OP.CREATE_LEFT:    s.createLeft++;  s.bytesLeft  += sizeOf(n, 'right'); break;
      case OP.CREATE_RIGHT:   s.createRight++; s.bytesRight += sizeOf(n, 'left');  break;
      case OP.OVERWRITE_LEFT: s.updateLeft++;  s.bytesLeft  += sizeOf(n, 'right'); break;
      case OP.OVERWRITE_RIGHT:s.updateRight++; s.bytesRight += sizeOf(n, 'left');  break;
      case OP.DELETE_LEFT:    s.deleteLeft++;  break;
      case OP.DELETE_RIGHT:   s.deleteRight++; break;
      // A pair is one move; count it on the TO node only, and note that its
      // bytes are NOT added — a rename copies nothing, that is the point.
      case OP.MOVE_LEFT_TO:   s.moveLeft++;  break;
      case OP.MOVE_RIGHT_TO:  s.moveRight++; break;
      case OP.MOVE_LEFT_FROM: case OP.MOVE_RIGHT_FROM: break;
      case OP.CONFLICT:       s.conflicts++;
        if (s.conflictList.length < 25) s.conflictList.push({ rel: n.rel, msg: n.catMsg });
        break;
      case OP.NONE:           s.equal++; break;
      default:                s.doNothing++; break;
    }
  }
  s.bytesTotal = s.bytesLeft + s.bytesRight;
  s.filesToProcess = s.createLeft + s.createRight + s.updateLeft + s.updateRight +
                     s.deleteLeft + s.deleteRight + s.moveLeft + s.moveRight;
  return s;
}

function sizeOf(n, side) {
  if (n.type === 'folder') return 0;
  return (n[side] && n[side].exists) ? (n[side].size || 0) : 0;
}

module.exports = {
  applyDirections, computeStats, operationFor, applyFolderRules,
  detectMoves, dissolveMove,
  diffDefaults, changeDefaults, usesDatabase, stillInSync, sideChange,
};
