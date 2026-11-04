// The counter: which card numbers a destination already holds, read from
// the folder names a template creates.
'use strict';

const { makeCounterMatcher, structuralLevelPatterns, templateDepth } = require('../shared/folder-names');
const fs = require('fs');
const path = require('path');

// Walk a destination looking for CARD folders. Since a template can place
// cards under subfolders (DAY1/A_CAM/001_...), reading only the root would
// miss every card of every earlier day: the counter would restart at 001 and
// the gap in the numbering — the operator's only signal that a card is missing
// — would disappear. The counter stays GLOBAL to the destination, so the scan
// is global too.
//
// EVERY folder is tested, and the walk NEVER stops descending because a name
// happened to match. The matcher is deliberately permissive (an empty variable
// collapses its separator, so literal separators are optional in the pattern),
// which means a subfolder level can look like a card — "01_JOUR1" reads as
// card 1. Treating that as a card and not descending would hide every real
// card underneath it: the scan would return next=002 with 002 already on the
// disk, and the ingest would write into an existing card's folder. Counting a
// subfolder as a card only pushes the counter FORWARD, which is safe and
// visible; missing a card is not.
//
// Depth: a card can never be deeper than the number of levels the template
// describes, so that is where the walk stops: one readdir for a template with
// no "/", and never deeper than the template asks for.
// `structural` is the list of patterns from structuralLevelPatterns(): a folder
// whose name matches one of them is a level the template always creates, not a
// card. Without it "{YYYY}/{counter}_{cardname}" would read the year folder
// "2026" as card 2026 and number the first ingest of the day 2027.
function walkCardFolders(root, matcher, onCard, maxDepth, structural) {
  const levels = Array.isArray(structural) ? structural : [];
  let stopped = false;
  (function walk(dir, depth, rel) {
    if (stopped) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (stopped) return;
      if (e.name.startsWith('.')) continue;
      // A symbolic link to a folder IS a folder here: mkdir and rename follow
      // it, so a linked card folder that this walk could not see would be
      // written through, onto the link's target.
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (_) {} }
      if (!isDir) continue;
      if (e.name === 'ascmhl') continue;          // our own manifest history
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (!levels.some(rx => rx.test(e.name))) {
        const n = matcher.extract(e.name);
        if (n != null && onCard(n, childRel) === false) { stopped = true; return; }
      }
      if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1, childRel);
    }
  })(root, 1, '');
  return stopped;
}
// Walk one destination, EXACTLY as deep as the template describes — no deeper.
//
// No retry at full depth when the template's own depth yields nothing (which
// would let a tree built by another template still be seen). It costs far
// more than it gives: on an ordinary post drive holding
// PROJECT_X/{01_DOC,02_RUSHES,03_EDIT}, a flat template scanning two levels
// down reads "01_DOC" as card 1 and answers next=004, refusing counters 1,
// 2 and 3 with "already exists in the destination". Same on a destination
// whose cards were ingested without a counter: DCIM/100MSDCF, 101MSDCF read as
// cards, next=102. Reading the root only answers 001 in both cases.
//
// What such a retry would cover (cards sitting DEEPER than the current
// template) is rare (it needs the template's depth to have changed) and is
// not dangerous: the ingest then lands somewhere else in the tree and nothing
// is overwritten. Inventing a counter out of a project folder, on the other
// hand, happens on the first real drive.
function walkDestination(destPath, matcher, tpl, onCard) {
  walkCardFolders(destPath, matcher, onCard, templateDepth(tpl), structuralLevelPatterns(tpl));
}
// ─── IPC: Scan destinations — returns { max, next } ─────────────────────────
function scanCounterInDests(destPaths, template) {
  const matcher = makeCounterMatcher(template);
  let maxNum = 0;
  for (const destPath of (Array.isArray(destPaths) ? destPaths : [])) {
    walkDestination(destPath, matcher, template, (n) => { if (n > maxNum) maxNum = n; });
  }
  return { max: maxNum, next: Math.max(maxNum + 1, 1) };
}

module.exports = { walkCardFolders, walkDestination, scanCounterInDests };
