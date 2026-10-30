// THE SOURCE-CARD LOCK
//
// Non-negotiable rule: ingesto never deletes, renames or overwrites a file on
// a source card. Every destructive filesystem call of the engine goes through
// the four functions below (safeUnlink, safeRename, safeRmTree,
// safeWriteTarget), and scripts/test-source-lock.js fails the build if a raw
// fs.unlinkSync / renameSync / rmSync / rmdirSync appears anywhere else.
'use strict';

const fs = require('fs');
const path = require('path');

// True when `child` is `parent` itself or lives underneath it. Comparison is
// case-insensitive on Windows/macOS, where the filesystem is too.
// realpath of the deepest existing ancestor + the rest of the path unchanged.
function realpathAsFarAsPossible(p) {
  let head = p, tail = [];
  for (let i = 0; i < 64; i++) {
    try { return tail.length ? path.join(fs.realpathSync.native(head), ...tail) : fs.realpathSync.native(head); }
    catch (_) {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head)); head = parent;
    }
  }
  return p;
}
function pathContains(parent, child) {
  try {
    const norm = p => {
      let r = path.resolve(String(p || ''));
      // Resolve symbolic links, or a destination that is a link to the card
      // slips past this guard: "/Volumes/BACKUP_LINK -> /Volumes/CARD" and the
      // card is copied into itself, flagged as ingested, offered for ejection.
      // A path that does not exist yet (the card folder about to be created)
      // is resolved as far as it does exist.
      r = realpathAsFarAsPossible(r);
      if (process.platform !== 'linux') r = r.toLowerCase();
      return r;
    };
    const p = norm(parent), c = norm(child);
    if (!p || !c) return false;
    if (p === c) return true;
    return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  } catch (_) { return false; }
}
// ═══════════════════════════════════════════════════════════════════════════
// THE SOURCE-CARD LOCK
// ═══════════════════════════════════════════════════════════════════════════
// Non-negotiable rule: ingesto never deletes, renames or overwrites a file on a
// source card. The rule does not rest on every call site being written with
// care: every destructive call in the engine goes through the four functions
// below, and scripts/test-source-lock.js fails the build if a raw
// fs.unlinkSync / renameSync / rmSync / rmdirSync appears anywhere else.
//
// A card is locked for as long as a run that reads it is in progress: an
// ingest, or a retry of failed files. Not for the whole life of the app: a
// shuttle drive offloaded as a source in the morning is a legitimate
// destination in the afternoon, and a session-long lock would refuse
// every write to it. During a run, PF-E6 already refuses a destination that
// overlaps the card, so the lock should never fire; it is the second key,
// the one that holds even if a future change forgets the first.
//
// It fails closed: a refused operation throws, and the caller's own error
// path takes over (a leftover temp file on a destination, never a lost file
// on a card).
const _lockedSources = new Map();   // resolved card root -> number of runs using it
function lockSource(root) {
  if (!root) return;
  const k = path.resolve(String(root));
  _lockedSources.set(k, (_lockedSources.get(k) || 0) + 1);
}
function unlockSource(root) {
  if (!root) return;
  const k = path.resolve(String(root));
  const n = (_lockedSources.get(k) || 0) - 1;
  if (n > 0) _lockedSources.set(k, n); else _lockedSources.delete(k);
}
function onLockedSource(p) {
  for (const root of _lockedSources.keys()) if (pathContains(root, p)) return root;
  return null;
}
function refuseOnSource(op, p) {
  const root = onLockedSource(p);
  if (!root) return;
  const e = new Error(`${op} refused: "${p}" is on the source card "${root}". ingesto never touches a file on a card.`);
  e.code = 'INGESTO_SOURCE_LOCK';
  console.error('[source-lock] ' + e.message);
  throw e;
}
function safeUnlink(p) { refuseOnSource('delete', p); fs.unlinkSync(p); }
function safeRename(from, to) { refuseOnSource('rename', from); refuseOnSource('rename', to); fs.renameSync(from, to); }
function safeRmTree(p) { refuseOnSource('delete', p); fs.rmSync(p, { recursive: true, force: true }); }
// Opening a file for writing truncates it: on a card, that is a deletion too.
function safeWriteTarget(p) { refuseOnSource('write', p); return p; }

module.exports = { realpathAsFarAsPossible, pathContains, lockSource, unlockSource, onLockedSource, refuseOnSource, safeUnlink, safeRename, safeRmTree, safeWriteTarget };
