/*
 * syncto — engine test suite
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
 *
 * Runs the whole engine against real folders in a temporary directory.
 * No Electron, no UI — plain `node test/run-tests.js`.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { PathFilter, SoftFilter } = require('../src/main/core/filter');
const { Session, MultiSession } = require('../src/main/core/session');
const { defaultJob } = require('../src/main/config');
const { versionedRelPath, runTimestamp } = require('../src/main/core/versioning');
const { CAT, OP, LOCK_NAME } = require('../src/main/core/compare');
const { NativeFs } = require('../src/main/fs/native');
const { acquireOne, acquireAll, abandonedLockName, localLockInfo, processStatus,
        DETECT_ABANDONED_MS } = require('../src/main/core/lock');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(label); process.stdout.write('x'); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) failures.push(`${label}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);
  if (same) { passed++; process.stdout.write('.'); } else { failed++; process.stdout.write('x'); }
}

// ── Scratch space ──────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'syncto-test-'));
let caseNo = 0;
function scratch() {
  const d = path.join(ROOT, 'case' + (++caseNo));
  fs.mkdirSync(path.join(d, 'L'), { recursive: true });
  fs.mkdirSync(path.join(d, 'R'), { recursive: true });
  return { dir: d, L: path.join(d, 'L'), R: path.join(d, 'R') };
}
function write(base, rel, content, mtime) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}
function read(base, rel) {
  try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch (_) { return null; }
}
function exists(base, rel) { return fs.existsSync(path.join(base, rel)); }
function listAll(base) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.push(r + '/'); walk(path.join(d, e.name), r); }
      else out.push(r);
    }
  })(base, '');
  return out.sort();
}

function makeJob(L, R, over) {
  const j = defaultJob();
  j.left = L; j.right = R;
  j.name = 'test';
  j.sync.deletion = 'permanent';
  j.sync.report.enabled = false;
  j.sync.retryCount = 0;
  return deepAssign(j, over || {});
}
function deepAssign(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepAssign(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}

async function runPair(job) {
  const s = new Session();
  const token = { cancelled: false, paused: false };
  const cmp = await s.compare(job, { token });
  const run = await s.sync(job, { token, appVersion: 'test' });
  await s.close();
  return { s, cmp, run };
}

// ══ 1. Path filter ═════════════════════════════════════════════════════════
function testFilter() {
  console.log('\n\n1. Path filter');
  const f1 = new PathFilter('*', '/*.tmp');
  ok(f1.passFile('clip.mov'), 'plain file passes');
  ok(!f1.passFile('clip.tmp'), '/*.tmp excludes a root .tmp');
  ok(f1.passFile('sub/clip.tmp'), '/*.tmp does not reach into subfolders');

  const f2 = new PathFilter('*', '/*/thumbs.db');
  ok(!f2.passFile('sub/thumbs.db'), '/*/thumbs.db excludes one level down');
  // Same rule as FreeFileSync: a leading */ also registers the bare tail, so
  // the pattern catches the file at the root too. Convenient, and it means
  // "/*/thumbs.db" behaves the way people actually expect.
  ok(!f2.passFile('thumbs.db'), '/*/thumbs.db also catches the root-level file');

  const f3 = new PathFilter('*', '/Proxies/');
  ok(!f3.passFolder('Proxies'), 'trailing slash excludes the folder');
  ok(!f3.passFile('Proxies/a.mov'), 'excluding a folder excludes its content');
  ok(f3.passFile('Masters/a.mov'), 'sibling folders are untouched');

  const f4 = new PathFilter('/A/B/*.mov', '');
  ok(f4.passFolder('A'), 'a nested include keeps the parent folders walkable');
  ok(f4.passFolder('A/B'), 'and the intermediate folder');
  ok(f4.passFile('A/B/x.mov'), 'the included file passes');
  ok(!f4.passFile('A/B/x.wav'), 'a non-matching extension is dropped');
  ok(!f4.passFile('C/x.mov'), 'an unrelated branch is dropped');

  const f5 = new PathFilter('*', '/*:');
  ok(!f5.passFile('a.txt'), 'a trailing colon means files only');
  ok(f5.passFolder('sub'), 'and leaves folders alone');

  const f6 = new PathFilter('*', 'CACHE | *.bak');
  ok(!f6.passFile('x.bak'), 'the pipe separates patterns');
  ok(!f6.passFolder('CACHE'), 'and both halves apply');

  const f7 = new PathFilter('*', '/Sub\\Deep\\');
  ok(!f7.passFolder('Sub/Deep'), 'backslashes are accepted as separators');

  const f8 = new PathFilter('*', '/MyFolder/');
  ok(!f8.passFolder('myfolder'), 'matching is case-insensitive');

  const soft = new SoftFilter({ sizeMinUnit: 'kb', sizeMin: 10 });
  ok(!soft.passes(5000, Date.now()), 'the soft filter rejects a file under the minimum');
  ok(soft.passes(50000, Date.now()), 'and accepts one above it');

  // Anchoring rule: no "/" in the pattern -> matches the NAME at any depth;
  // a leading "/" pins the pattern to the root.
  const f9 = new PathFilter('*', '*.tmp');
  ok(!f9.passFile('x.tmp'), 'a bare *.tmp excludes at the root');
  ok(!f9.passFile('a/b/c/x.tmp'), 'and at any depth');
  ok(f9.passFile('a/b/c/x.mov'), 'without touching other extensions');

  const f10 = new PathFilter('*', 'thumbs.db');
  ok(!f10.passFile('deep/er/thumbs.db'), 'a bare name excludes anywhere');

  const f11 = new PathFilter('*', 'Proxies/');
  ok(!f11.passFolder('a/b/Proxies'), 'a bare folder name excludes anywhere');
  ok(!f11.passFile('a/b/Proxies/p.mov'), 'along with its content');

  const f12 = new PathFilter('*', '/notes.txt');
  ok(!f12.passFile('notes.txt'), 'a leading slash pins to the root');
  ok(f12.passFile('sub/notes.txt'), 'and leaves deeper namesakes alone');
}

// ══ 2. Comparison categories ═══════════════════════════════════════════════
async function testCompare() {
  console.log('\n2. Comparison');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'same.txt', 'hello', t0);
  write(R, 'same.txt', 'hello', t0);
  write(L, 'leftonly.txt', 'x', t0);
  write(R, 'rightonly.txt', 'y', t0);
  write(L, 'newer.txt', 'aaaa', t0 + 60000);
  write(R, 'newer.txt', 'bbbb', t0);
  write(L, 'sub/deep.txt', 'z', t0);

  const job = makeJob(L, R);
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;

  eq(byRel['same.txt'].cat, CAT.EQUAL, 'identical file -> equal');
  eq(byRel['leftonly.txt'].cat, CAT.LEFT_ONLY, 'left only');
  eq(byRel['rightonly.txt'].cat, CAT.RIGHT_ONLY, 'right only');
  eq(byRel['newer.txt'].cat, CAT.LEFT_NEWER, 'left newer');
  ok(!!byRel['sub'], 'the subfolder is in the tree');
  eq(byRel['sub'].cat, CAT.LEFT_ONLY, 'the subfolder is left only');
  await s.close();

  // 1-second drift must not register as a change (FAT / SFTP resolution).
  const b = scratch();
  write(b.L, 'a.txt', 'hello', t0);
  write(b.R, 'a.txt', 'hello', t0 + 1000);
  const s2 = new Session();
  await s2.compare(makeJob(b.L, b.R), { token: {} });
  eq(s2.nodes[0].cat, CAT.EQUAL, '1 s of drift stays inside the 2 s tolerance');
  await s2.close();

  // Same date, different size -> conflict, never a silent overwrite.
  const c = scratch();
  write(c.L, 'a.txt', 'hello world', t0);
  write(c.R, 'a.txt', 'hello', t0);
  const s3 = new Session();
  await s3.compare(makeJob(c.L, c.R), { token: {} });
  eq(s3.nodes[0].cat, CAT.CONFLICT, 'same date but a different size is a conflict');
  await s3.close();

  // Content comparison notices a change the timestamps hide.
  const d = scratch();
  write(d.L, 'a.txt', 'AAAAA', t0);
  write(d.R, 'a.txt', 'BBBBB', t0);
  const s4 = new Session();
  await s4.compare(makeJob(d.L, d.R, { compare: { compareVariant: 'content' } }), { token: {} });
  eq(s4.nodes[0].cat, CAT.DIFFERENT, 'content comparison catches identical dates and sizes');
  await s4.close();
}

// ══ 3. Mirror ══════════════════════════════════════════════════════════════
async function testMirror() {
  console.log('\n3. Mirror');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'keep.txt', 'keep', t0);
  write(L, 'sub/new.txt', 'new', t0);
  write(R, 'stale.txt', 'stale', t0);
  write(R, 'keep.txt', 'old', t0 - 60000);

  const { run } = await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));

  eq(read(R, 'keep.txt'), 'keep', 'mirror overwrites the older right-hand copy');
  eq(read(R, 'sub/new.txt'), 'new', 'mirror creates missing folders and files');
  ok(!exists(R, 'stale.txt'), 'mirror removes what the left side does not have');
  eq(run.errors.length, 0, 'mirror runs without errors');
  eq(listAll(L).filter(x => !x.startsWith('.syncto')), listAll(R).filter(x => !x.startsWith('.syncto')),
     'both sides end up with the same tree');

  // Dates survive the copy — this is what makes the next comparison cheap.
  const sl = fs.statSync(path.join(L, 'sub/new.txt'));
  const sr = fs.statSync(path.join(R, 'sub/new.txt'));
  ok(Math.abs(sl.mtimeMs - sr.mtimeMs) < 2000, 'the modification date is preserved');

  // A second run must have nothing left to do.
  const s = new Session();
  const cmp2 = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'a second mirror run is a no-op');
  await s.close();
}

// ══ 4. Update never deletes ════════════════════════════════════════════════
async function testUpdate() {
  console.log('\n4. Update');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'new.txt', 'new', t0);
  write(R, 'extra.txt', 'extra', t0);

  await runPair(makeJob(L, R, { sync: { variant: 'update' } }));
  eq(read(R, 'new.txt'), 'new', 'update copies new files rightward');
  ok(exists(R, 'extra.txt'), 'update never removes anything on the right');
  ok(!exists(L, 'extra.txt'), 'update never copies leftward');
}

// ══ 5. Two way, with the database ══════════════════════════════════════════
async function testTwoWay() {
  console.log('\n5. Two way');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'a.txt', 'a', t0);
  write(R, 'b.txt', 'b', t0);

  // First run: no database yet, so it can only copy — that is the safe default.
  await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
  ok(exists(R, 'a.txt') && exists(L, 'b.txt'), 'the first two-way run copies both ways');
  ok(fs.existsSync(path.join(L, '.syncto.db')), 'a database is written on the left');
  ok(fs.existsSync(path.join(R, '.syncto.db')), 'and on the right');

  // Second run: delete on the left, add on the right. With the database, the
  // deletion must propagate instead of being undone by a copy back.
  fs.unlinkSync(path.join(L, 'b.txt'));
  write(R, 'c.txt', 'c', t0);

  const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;
  eq(byRel['b.txt'].op, OP.DELETE_RIGHT, 'a deletion on the left propagates to the right');
  eq(byRel['c.txt'].op, OP.CREATE_LEFT, 'a creation on the right propagates to the left');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(!exists(R, 'b.txt'), 'the deleted file is gone from both sides');
  eq(read(L, 'c.txt'), 'c', 'the new file reached the other side');

  // Both sides changed since the last run -> conflict, not a coin flip.
  write(L, 'a.txt', 'left version', Date.now());
  write(R, 'a.txt', 'right version', Date.now() - 30000);
  const s2 = new Session();
  await s2.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
  const conflict = s2.nodes.find(n => n.rel === 'a.txt');
  eq(conflict.op, OP.CONFLICT, 'a change on both sides is reported as a conflict');
  await s2.close();
}

// ══ 6. Secure copy, checksum list, verification ════════════════════════════
async function testSecure() {
  console.log('\n6. Secure copy and verification');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'big.bin', Buffer.alloc(1024 * 512, 7), t0);
  write(L, 'sub/small.txt', 'tiny', t0);

  const job = makeJob(L, R, {
    sync: { variant: 'mirror', copyLevel: 'secure', writeChecksumList: true,
            report: { enabled: true, html: true, csv: true, json: true, folder: path.join(ROOT, 'reports') } },
  });
  const { run } = await runPair(job);

  eq(run.errors.length, 0, 'the secure copy completes without errors');
  ok(fs.existsSync(path.join(R, 'syncto-checksums.txt')), 'a checksum list is written next to the data');
  ok(run.reportFiles.length === 3, 'HTML, CSV and JSON reports are written');
  ok(fs.readFileSync(run.reportFiles.find(f => f.endsWith('.html')), 'utf8').includes('syncto'),
     'the HTML report is not empty');

  const list = fs.readFileSync(path.join(R, 'syncto-checksums.txt'), 'utf8');
  ok(/xxh64/.test(list), 'the list records which algorithm was used');
  ok(list.split('\n').filter(l => l && !l.startsWith('#')).length === 2, 'every copied file is listed');

  // ORDER OF PHASES — the whole point of the ingesto model: every file is
  // copied first, and only then is everything read back. No copy may start
  // after the first verification has begun.
  const o = scratch();
  for (let i = 1; i <= 4; i++) write(o.L, `clip_${i}.bin`, Buffer.alloc(300 * 1024, i), t0);
  const seq = [];
  const so = new Session();
  const jo = makeJob(o.L, o.R, { sync: { variant: 'mirror', copyLevel: 'secure' } });
  await so.compare(jo, { token: {} });
  const ro = await so.sync(jo, {
    token: {}, appVersion: 'test',
    onProgress: p => { if (p.pass && seq[seq.length - 1] !== p.pass) seq.push(p.pass); },
  });
  await so.close();
  eq(seq, ['copy', 'verify', 'cleanup'], 'copy runs to completion, then verification, then cleanup — never back to copying');
  ok(seq.indexOf('copy') < seq.indexOf('verify'), 'not a single file is copied after verification starts');
  eq(ro.verified, 4, 'every copied file was read back and checked');
  eq(ro.errors.length, 0, 'and all of them matched');

  // The checksum list lives at the root of the target. A second mirror run must
  // treat it as syncto's own file, not as a stray to be deleted.
  const s2 = new Session();
  const cmp2 = await s2.compare(job, { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'the checksum list does not make the next run dirty');
  await s2.close();
  ok(fs.existsSync(path.join(R, 'syncto-checksums.txt')), 'and it is still there afterwards');

  // Verification of an intact folder.
  const { FsPool } = require('../src/main/fs/afs');
  const { verifyFolder } = require('../src/main/core/session');
  const pool = new FsPool();
  const v1 = await verifyFolder(pool, R, { token: {} });
  eq([v1.verified, v1.mismatched, v1.missing], [2, 0, 0], 'an intact folder verifies clean');

  // Now corrupt one byte, the way a failing drive would.
  const target = path.join(R, 'sub/small.txt');
  fs.writeFileSync(target, 'tin!');
  const v2 = await verifyFolder(pool, R, { token: {} });
  eq(v2.mismatched, 1, 'a single altered byte is caught');
  await pool.closeAll();
}

// ══ 7. Versioning ══════════════════════════════════════════════════════════
async function testVersioning() {
  console.log('\n7. Versioning');
  eq(versionedRelPath('sub/clip.mov', 'timestampFolder', '2026-08-08 143012'),
     '2026-08-08 143012/sub/clip.mov', 'timestampFolder puts a dated folder on top');
  eq(versionedRelPath('sub/clip.mov', 'timestampFile', '2026-08-08 143012'),
     'sub/clip 2026-08-08 143012.mov', 'timestampFile inserts the stamp before the extension');
  eq(versionedRelPath('README', 'timestampFile', '2026-08-08 143012'),
     'README 2026-08-08 143012', 'a file with no extension still gets a stamp');
  eq(versionedRelPath('sub/clip.mov', 'replace', '2026-08-08 143012'),
     'sub/clip.mov', 'replace keeps the path as it is');
  ok(/^\d{4}-\d{2}-\d{2} \d{6}$/.test(runTimestamp()), 'the run timestamp has the documented shape');

  const { L, R, dir } = scratch();
  const rev = path.join(dir, 'revisions');
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'new content', t0);
  write(R, 'a.txt', 'old content', t0 - 90000);
  write(R, 'gone.txt', 'about to be archived', t0);

  const { run } = await runPair(makeJob(L, R, {
    sync: { variant: 'mirror', deletion: 'versioning',
            versioning: { rightFolder: rev, leftFolder: rev, style: 'timestampFolder' } },
  }));

  eq(read(R, 'a.txt'), 'new content', 'the target is replaced');
  ok(!exists(R, 'gone.txt'), 'the extra file leaves the target');
  const stamps = fs.readdirSync(rev);
  eq(stamps.length, 1, 'one revision folder per run');
  const inRev = listAll(path.join(rev, stamps[0]));
  ok(inRev.includes('a.txt'), 'the replaced version is archived');
  ok(inRev.includes('gone.txt'), 'the removed file is archived too');
  eq(fs.readFileSync(path.join(rev, stamps[0], 'a.txt'), 'utf8'), 'old content',
     'the archived copy is the previous version, not the new one');
  eq(run.errors.length, 0, 'versioning runs without errors');
}

// ══ 8. Fail-safe copy ══════════════════════════════════════════════════════
async function testFailSafe() {
  console.log('\n8. Fail-safe copy and leftovers');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'good', t0);
  // A leftover from an interrupted run must be ignored, never synchronized.
  write(R, 'orphan.txt.syncto_tmp', 'half written', t0);

  const s = new Session();
  const cmp = await s.compare(makeJob(L, R), { token: {} });
  ok(!s.nodes.some(n => n.rel.includes('syncto_tmp')), 'a stray temp file is not compared');
  await s.close();

  await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
  eq(read(R, 'a.txt'), 'good', 'the copy lands under its real name');
  ok(!exists(R, 'a.txt.syncto_tmp'), 'no temporary file survives a successful copy');
}

// ══ 9. Manual overrides ════════════════════════════════════════════════════
async function testOverrides() {
  console.log('\n9. Manual overrides');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'a', t0);
  write(L, 'b.txt', 'b', t0);

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const bNode = s.nodes.find(n => n.rel === 'b.txt');
  s.setActive([bNode.idx], false);
  const stats = s.setDirection([], 'right');
  eq(stats.createRight, 1, 'deselecting a row removes it from the plan');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(exists(R, 'a.txt'), 'the selected file is copied');
  ok(!exists(R, 'b.txt'), 'the deselected file is left alone');

  // Excluding a FOLDER must exclude its whole subtree in one go.
  const c = scratch();
  write(c.L, 'keep.txt', 'k', t0);
  write(c.L, 'skip/deep/one.txt', '1', t0);
  write(c.L, 'skip/two.txt', '2', t0);
  const job2 = makeJob(c.L, c.R, { sync: { variant: 'mirror' } });
  const s2 = new Session();
  await s2.compare(job2, { token: {} });
  const folder = s2.nodes.find(n => n.rel === 'skip');
  const st = s2.toggleActive([folder.idx]);
  eq(st.createRight, 1, 'toggling a folder deactivates every descendant');
  await s2.sync(job2, { token: {}, appVersion: 'test' });
  await s2.close();
  ok(exists(c.R, 'keep.txt'), 'the rest still syncs');
  ok(!exists(c.R, 'skip'), 'the excluded folder never lands on the destination');
}

// ══ 10. Folder rules ═══════════════════════════════════════════════════════
async function testFolderRules() {
  console.log('\n10. Folder rules');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(R, 'doomed/keep.txt', 'keep', t0);
  write(R, 'doomed/also.txt', 'also', t0);

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const keep = s.nodes.find(n => n.rel === 'doomed/keep.txt');
  s.setActive([keep.idx], false);          // one child survives...
  const folder = s.nodes.find(n => n.rel === 'doomed');
  eq(folder.op, OP.DO_NOTHING, '...so the folder deletion is cancelled');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(exists(R, 'doomed/keep.txt'), 'the protected file survives');
  ok(!exists(R, 'doomed/also.txt'), 'its sibling is still removed');
  ok(exists(R, 'doomed'), 'and the folder itself stays');
}

// ══ 11. Moved-file detection ═══════════════════════════════════════════════
async function testMoves() {
  console.log('\n11. Moved-file detection');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'sub/clip.mov', Buffer.alloc(256 * 1024, 3), t0);
  write(L, 'other.txt', 'x', t0);

  // Run 1 (mirror): plain copy, and the database records the file ids.
  await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
  ok(fs.existsSync(path.join(L, '.syncto.db')), 'a mirror run writes the database when move detection is on');

  // The user reorganizes: same file, new folder, new name. Same inode.
  fs.mkdirSync(path.join(L, 'renamed'), { recursive: true });
  fs.renameSync(path.join(L, 'sub/clip.mov'), path.join(L, 'renamed/clip_v2.mov'));

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;

  eq(cmp.movesFound, 1, 'the rename is detected as one move');
  eq(byRel['renamed/clip_v2.mov'].op, OP.MOVE_RIGHT_TO, 'the new path is a move target');
  eq(byRel['sub/clip.mov'].op, OP.MOVE_RIGHT_FROM, 'the old path is the move source');

  const run = await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  eq(run.counters.moved, 1, 'one rename executed');
  eq(run.counters.files, 0, 'and NOT a single file re-copied');
  eq(run.counters.bytes, 0, 'zero bytes transferred');
  ok(exists(R, 'renamed/clip_v2.mov'), 'the right side followed the move');
  ok(!exists(R, 'sub/clip.mov'), 'the old right-hand path is gone');
  eq(fs.statSync(path.join(R, 'renamed/clip_v2.mov')).size, 256 * 1024, 'the moved file is intact');
  eq(run.errors.length, 0, 'no errors');

  // A second compare must be clean — including the database bookkeeping.
  const s2 = new Session();
  const cmp2 = await s2.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'the pair is fully in sync after the move');
  await s2.close();
}

// ══ 12. Moves in two-way, and the off switch ═══════════════════════════════
async function testMovesTwoWayAndOff() {
  console.log('\n12. Moves: two way and opting out');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'a.bin', Buffer.alloc(64 * 1024, 9), t0);

  await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
  // Move on the RIGHT this time: the LEFT side must rename.
  fs.renameSync(path.join(R, 'a.bin'), path.join(R, 'a_renamed.bin'));

  const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;
  eq(cmp.movesFound, 1, 'a move on the right is detected too');
  eq(byRel['a_renamed.bin'].op, OP.MOVE_LEFT_TO, 'and the LEFT side is the one renaming');
  const run = await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();
  ok(exists(L, 'a_renamed.bin') && !exists(L, 'a.bin'), 'the left side followed');
  eq(run.counters.bytes, 0, 'still zero bytes transferred');

  // With the option off, the same situation is a plain copy + delete again.
  const b = scratch();
  write(b.L, 'x.bin', Buffer.alloc(1024, 1), t0);
  await runPair(makeJob(b.L, b.R, { sync: { variant: 'mirror' } }));
  fs.renameSync(path.join(b.L, 'x.bin'), path.join(b.L, 'y.bin'));
  const s3 = new Session();
  const cmp3 = await s3.compare(makeJob(b.L, b.R, {
    compare: { detectMoves: false }, sync: { variant: 'mirror' },
  }), { token: {} });
  eq(cmp3.movesFound, 0, 'detection can be switched off');
  eq(cmp3.stats.createRight, 1, 'the new name is then a plain copy');
  eq(cmp3.stats.deleteRight, 1, 'and the old one a plain deletion');
  await s3.close();
}

// ══ 13. Multi-pair jobs ════════════════════════════════════════════════════
async function testMultiPair() {
  console.log('\n13. Multi-pair jobs');
  const a = scratch(), b = scratch();
  const t0 = Date.now() - 100000;
  write(a.L, 'one.txt', 'first pair', t0);
  write(a.L, 'sub/two.txt', 'deep', t0);
  write(b.L, 'three.txt', 'second pair', t0);
  write(b.R, 'stale.txt', 'to be removed', t0);

  const job = makeJob('', '', { sync: { variant: 'mirror' } });
  delete job.left; delete job.right;
  job.pairs = [{ left: a.L, right: a.R }, { left: b.L, right: b.R }];

  const m = new MultiSession();
  const cmp = await m.compare(job, { token: {} });
  eq(cmp.pairs.length, 2, 'both pairs are compared');
  eq(cmp.stats.createRight, 4, 'stats merge across pairs (2+1 files, 1 folder)');
  eq(cmp.stats.deleteRight, 1, 'including the deletion in pair 2');

  // The merged grid: header rows appear, indices are globalized.
  const rows = m.rows(0, 50, {});
  eq(rows.rows.filter(r => r.hdr).length, 2, 'one header row per pair');
  const three = rows.rows.find(r => !r.hdr && r.name === 'three.txt');
  ok(three && three.idx >= 1000000, 'pair-2 rows carry globalized indices');

  // Editing through a global index reaches the right pair.
  const st = m.toggleActive([three.idx]);
  eq(st.createRight, 3, 'toggling via a global index lands on the right pair');
  m.toggleActive([three.idx]);

  const run = await m.sync(job, { token: {}, appVersion: 'test' });
  eq(run.pairsDone, 2, 'both pairs synchronized');
  eq(run.errors.length, 0, 'no errors');
  eq(read(a.R, 'one.txt'), 'first pair', 'pair 1 copied');
  eq(read(a.R, 'sub/two.txt'), 'deep', 'pair 1 subfolder copied');
  eq(read(b.R, 'three.txt'), 'second pair', 'pair 2 copied');
  ok(!exists(b.R, 'stale.txt'), 'pair 2 deletion executed');
  ok(!exists(a.R, 'three.txt'), 'pairs never leak into each other');
  ok(fs.existsSync(path.join(b.L, '.syncto.db')), 'each pair keeps its own database');

  // Second compare: everything in sync, headers still there.
  const cmp2 = await m.compare(job, { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'a second run is a no-op across all pairs');
  await m.close();

  // Legacy single-pair job shape still works through MultiSession.
  const c = scratch();
  write(c.L, 'x.txt', 'x', t0);
  const legacy = makeJob(c.L, c.R, { sync: { variant: 'mirror' } });
  delete legacy.pairs;
  const m2 = new MultiSession();
  const cl = await m2.compare(legacy, { token: {} });
  eq(cl.stats.createRight, 1, 'a legacy left/right job still compares');
  await m2.sync(legacy, { token: {}, appVersion: 'test' });
  eq(read(c.R, 'x.txt'), 'x', 'and synchronizes');
  await m2.close();
}

// ══ 14. Directory locking ══════════════════════════════════════════════════
async function testLocking() {
  console.log('\n14. Directory locking');

  // Abandoned-lock renaming ladder, verbatim from FreeFileSync.
  eq(abandonedLockName('.syncto.lock'), 'Delete.0..syncto.lock', 'first take-over level');
  eq(abandonedLockName('Delete.0..syncto.lock'), 'Delete.1..syncto.lock', 'levels increment');
  eq(abandonedLockName('Delete.8..syncto.lock'), 'Delete.9..syncto.lock', 'up to the ceiling');
  let threw = false;
  try { abandonedLockName('Delete.9..syncto.lock'); } catch (_) { threw = true; }
  ok(threw, 'and refuses to recurse past 10');

  // Process identification.
  const local = localLockInfo();
  eq(processStatus(local, local), 'itsUs', 'our own lock is recognized');
  eq(processStatus({ ...local, processId: 999999 }, local), 'notRunning', 'a dead pid is detected');
  eq(processStatus({ ...local, computerName: 'OtherMachine' }, local), 'unknown',
     'another machine cannot be probed locally');

  const { L } = scratch();
  const fsx = new NativeFs();

  // Acquire / release round trip.
  const lock = await acquireOne(fsx, L, {});
  ok(fs.existsSync(path.join(L, LOCK_NAME)), 'the lock file is created');
  await lock.release();
  ok(!fs.existsSync(path.join(L, LOCK_NAME)), 'and removed on release');

  // A lock left behind by a CRASHED process of this machine is taken over at
  // once — no need to wait out the 12 s heartbeat window.
  const stale = { ...localLockInfo(), processId: 999999 };
  fs.writeFileSync(path.join(L, LOCK_NAME), JSON.stringify(stale) + '\n');
  const t0 = Date.now();
  const lock2 = await acquireOne(fsx, L, {});
  const took = Date.now() - t0;
  ok(took < 2000, `a dead owner's lock is taken over immediately (${took} ms)`);
  await lock2.release();

  // The real thing: a SEPARATE process holds the lock and heartbeats.
  const holder = spawn(process.execPath, [path.join(__dirname, 'lock-holder.js'), L]);
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));
  ok(fs.existsSync(path.join(L, LOCK_NAME)), 'the other process holds the lock');

  // We must NOT be able to take it while it lives.
  let grabbed = false;
  const token = { cancelled: false };
  const waiting = acquireOne(fsx, L, { token, onStatus: () => {} })
    .then(l => { grabbed = true; return l; })
    .catch(() => null);
  await new Promise(r => setTimeout(r, 3000));
  ok(!grabbed, 'a live lock is respected — we wait instead of syncing over it');

  // Owner leaves cleanly -> we get in.
  holder.kill('SIGTERM');
  const got = await Promise.race([waiting, new Promise(r => setTimeout(() => r(null), 12000))]);
  ok(!!got, 'the lock is acquired once the other process releases it');
  if (got) await got.release();

  // Cancelling while waiting must not hang.
  const holder2 = spawn(process.execPath, [path.join(__dirname, 'lock-holder.js'), L]);
  await new Promise(res => holder2.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));
  const tok2 = { cancelled: false };
  const pending = acquireOne(fsx, L, { token: tok2, onStatus: () => {} }).then(() => 'got').catch(e => e.message);
  setTimeout(() => { tok2.cancelled = true; }, 500);
  const outcome = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 8000))]);
  eq(outcome, 'Cancelled', 'cancelling while waiting returns promptly');
  holder2.kill('SIGKILL');

  // A SIGKILLed owner leaves a stale lock with a dead pid -> immediate take-over.
  await new Promise(r => setTimeout(r, 300));
  const lock3 = await acquireOne(fsx, L, {});
  ok(true, 'a killed owner leaves a lock that is reclaimed');
  await lock3.release();

  // acquireAll deduplicates folders shared by several pairs.
  const set = await acquireAll([{ fs: fsx, path: L }, { fs: fsx, path: L }], {});
  eq(set.count, 1, 'a folder used by two pairs is locked once');
  await set.release();
}

// ══ 15. Review regressions ═════════════════════════════════════════════════
// One test per bug found by the full-code review — each of these used to fail.
async function testReviewRegressions() {
  console.log('\n15. Review regressions');
  const { Comparer, isSyncToInternal } = require('../src/main/core/compare');
  const { migrateJob } = require('../src/main/config');
  const { readDb, pairIdFor } = require('../src/main/core/db');

  // (a) A name-only include mask must not prune folders — include "*.jpg" has
  // to reach files in subfolders, at any depth.
  {
    const f = new PathFilter('*.jpg', '');
    ok(f.passFolder('photos'), 'include *.jpg keeps folders walkable');
    ok(f.passFolder('photos/2026/deep'), 'at any depth');
    ok(f.passFile('photos/2026/deep/a.jpg'), 'so nested matches are reached');
    ok(!f.passFile('photos/2026/deep/a.txt'), 'while other files stay excluded');

    const { L, R } = scratch();
    write(L, 'shoot/day1/a.jpg', 'jpg', Date.now() - 100000);
    write(L, 'shoot/day1/notes.txt', 'txt', Date.now() - 100000);
    await runPair(makeJob(L, R, { compare: { includeFilter: '*.jpg' } }));
    ok(exists(R, 'shoot/day1/a.jpg'), 'e2e: the nested .jpg is synchronized');
    ok(!exists(R, 'shoot/day1/notes.txt'), 'e2e: the .txt is not');
  }

  // (b) An unreadable directory is a FATAL comparison error, and the healthy
  // side's items must not be fabricated into one-sided rows (=> deletions).
  {
    const { L, R } = scratch();
    write(L, 'boom/precious.mov', 'data');
    write(R, 'boom/precious.mov', 'data');
    const fsx = new NativeFs();
    const bad = Object.create(fsx);
    bad.readdir = p => p.endsWith('boom')
      ? Promise.reject(new Error('EACCES: permission denied'))
      : NativeFs.prototype.readdir.call(fsx, p);
    const c = new Comparer({ left: { fs: bad, path: L }, right: { fs: fsx, path: R }, config: {} });
    const res = await c.run();
    ok(res.errors.some(e => e.fatal), 'an unreadable folder is a fatal error');
    ok(!res.nodes.some(n => n.rel === 'boom/precious.mov'),
       'and nothing under it is reported one-sided');
  }

  // (c) Synchronizing on top of a fatal comparison error is refused.
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'a');
    const s = new Session();
    const job = makeJob(L, R, {});
    await s.compare(job, { token: {} });
    s.errors.push({ path: L, message: 'permission denied', fatal: true });
    let threw = null;
    try { await s.sync(job, { token: {}, appVersion: 'test' }); } catch (e) { threw = e; }
    ok(threw && /could not read/i.test(threw.message), 'sync refuses a broken comparison');
    await s.close();
  }

  // (d) stat() reports "absent" only for a genuinely absent item.
  {
    const fsx = new NativeFs();
    eq(await fsx.stat(path.join(ROOT, 'definitely-not-there')), null, 'missing item -> null');
  }

  // (e) Two way: a file identical on both sides but unknown to (or stale in)
  // the database is IN SYNC — never an unresolvable "both sides changed".
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'a.txt', 'a', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    // Same file appears identically on both sides, outside syncto's back.
    write(L, 'both.txt', 'same', t0);
    write(R, 'both.txt', 'same', t0);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
    const n = s.nodes.find(x => x.rel === 'both.txt');
    eq(n.op, OP.NONE, 'identical both sides + no db entry = in sync');
    eq(s.stats.conflicts, 0, 'no conflict is raised');
    await s.close();
  }

  // (f) Folder mtimes drift (creating files touches them) — a two-way rerun
  // must not flag folders as out of sync.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'sub/a.txt', 'a', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    fs.utimesSync(path.join(L, 'sub'), new Date(t0 - 5000000), new Date(t0 - 5000000));
    fs.utimesSync(path.join(R, 'sub'), new Date(t0 + 5000000), new Date(t0 + 5000000));
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
    eq(s.stats.conflicts, 0, 'folder mtime drift is not a conflict');
    await s.close();
  }

  // (g) Cancellation resolves cleanly: what was done is returned and the
  // database is still written — the next run must not re-discover it all.
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'a', Date.now() - 100000);
    const s = new Session();
    const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
    const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    token.cancelled = true;
    const res = await s.sync(job, { token, appVersion: 'test' });
    ok(res.cancelled === true, 'a cancelled run resolves instead of rejecting');
    ok(!!res.dbStamp, 'and the database is still written');
    await s.close();
  }

  // (h) Legacy jobs: the removed Pro level maps to Secure (its closest kin),
  // never silently down to Fast; UI-less versioning falls back to the trash.
  {
    const j1 = migrateJob({ sync: { copyLevel: 'pro' } });
    eq(j1.sync.copyLevel, 'secure', "legacy copyLevel 'pro' becomes 'secure'");
    const j2 = migrateJob({ sync: { deletion: 'versioning' } });
    eq(j2.sync.deletion, 'recycler', 'versioning with no revision folder falls back to the trash');
    const j3 = migrateJob({ sync: { deletion: 'versioning', versioning: { leftFolder: '/rev' } } });
    eq(j3.sync.deletion, 'versioning', 'but a configured revision folder is honoured');
  }

  // (i) OS litter must not keep a "visually empty" folder alive.
  {
    const { L, R } = scratch();
    write(R, 'old/x.txt', 'x');
    write(R, 'old/.DS_Store', 'junk');
    fs.unlinkSync(path.join(R, 'old/x.txt'));       // only litter remains
    await runPair(makeJob(L, R, {}));               // mirror: 'old' must go
    ok(!exists(R, 'old'), 'a folder holding only .DS_Store is deleted');
  }

  // (j) Overwriting a symlink works even with permanent deletion (nothing is
  // archived, so the old link must be explicitly replaced). Skipped where the
  // OS forbids creating symlinks (Windows without developer mode).
  {
    const { L, R } = scratch();
    const t0 = Date.now();
    let canLink = true;
    try {
      fs.symlinkSync('/tmp/new-target', path.join(L, 'link'));
      fs.symlinkSync('/tmp/old-target', path.join(R, 'link'));
    } catch (_) { canLink = false; }
    if (canLink) {
      fs.lutimesSync(path.join(L, 'link'), new Date(t0), new Date(t0));
      fs.lutimesSync(path.join(R, 'link'), new Date(t0 - 600000), new Date(t0 - 600000));
      const { run } = await runPair(makeJob(L, R, { compare: { symlinks: 'asLink' } }));
      eq(run.errors.length, 0, 'symlink overwrite reports no error');
      eq(fs.readlinkSync(path.join(R, 'link')), '/tmp/new-target', 'and the link now points to the new target');
    } else {
      ok(true, 'symlink overwrite skipped (symlinks not permitted here)');
      ok(true, 'symlink overwrite skipped (symlinks not permitted here)');
    }
  }

  // (k) Two names differing only by case: flagged, first one wins, no crash.
  // Only meaningful on a case-SENSITIVE filesystem — on APFS or NTFS the two
  // writes land in the same file and there is nothing to collide.
  {
    const { L, R } = scratch();
    write(L, 'File.txt', 'A');
    const caseInsensitive = fs.existsSync(path.join(L, 'FILE.TXT'));
    if (caseInsensitive) {
      ok(true, 'case collision skipped (case-insensitive filesystem)');
      ok(true, 'case collision skipped (case-insensitive filesystem)');
    } else {
      write(L, 'file.txt', 'B');
      const s = new Session();
      const cmp = await s.compare(makeJob(L, R, {}), { token: {} });
      ok(cmp.errors.some(e => /upper\/lower case/i.test(e.message)), 'case collision is reported');
      eq(s.nodes.filter(n => n.rel.toLowerCase() === 'file.txt').length, 1, 'and only one row is kept');
      await s.close();
    }
  }

  // (l) The checksum sidecar accumulates across runs instead of being reduced
  // to whatever the latest run copied.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 100000;
    write(L, 'a.txt', 'aaa', t0);
    const jobOpts = { sync: { copyLevel: 'secure', writeChecksumList: true } };
    await runPair(makeJob(L, R, jobOpts));
    write(L, 'b.txt', 'bbb', t0);
    await runPair(makeJob(L, R, jobOpts));
    const list = read(R, 'syncto-checksums.txt') || '';
    ok(list.includes('a.txt') && list.includes('b.txt'),
       'the sidecar keeps earlier entries when later runs add more');
  }

  // (m) Errors are not counted twice by the multi-pair aggregation. The
  //     failure has to be a per-FILE one: a configuration problem such as a
  //     missing recycle bin is now settled for the whole job before the run
  //     starts, so it never reaches the per-pair accounting.
  {
    const { dir } = scratch();
    const made = [];
    const mk = name => {
      const l = path.join(dir, name + 'L'), r = path.join(dir, name + 'R');
      fs.mkdirSync(l, { recursive: true }); fs.mkdirSync(r, { recursive: true });
      write(l, 'gone.txt', 'x');
      made.push(path.join(l, 'gone.txt'));
      return { left: l, right: r };
    };
    const job = makeJob('', '', { sync: { deletion: 'permanent', retryCount: 0 } });
    job.pairs = [mk('p1'), mk('p2')];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    for (const f of made) fs.rmSync(f);        // vanishes between compare and sync
    const res = await ms.sync(job, { token: {}, appVersion: 'test' });
    eq(res.counters.errors, res.errors.length, 'counters.errors equals the error list length');
    eq(res.errors.length, 2, 'one error per pair, not two');
    await ms.close();
  }

  // (n) MultiSession exposes visibleIndices with globalized indices.
  {
    const { dir } = scratch();
    const l1 = path.join(dir, 'aL'), r1 = path.join(dir, 'aR');
    const l2 = path.join(dir, 'bL'), r2 = path.join(dir, 'bR');
    for (const d of [l1, r1, l2, r2]) fs.mkdirSync(d, { recursive: true });
    write(l1, 'one.txt', '1'); write(l2, 'two.txt', '2');
    const job = makeJob('', '', {});
    job.pairs = [{ left: l1, right: r1 }, { left: l2, right: r2 }];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    const vis = ms.visibleIndices({ showEqual: true, showExcluded: true });
    eq(vis.length, 2, 'one visible row per pair');
    ok(vis.some(i => i >= 1000000), 'indices of the second pair are globalized');
    await ms.close();
  }

  // (o) A database entry hidden by the current filter keeps its history.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'keep.txt', 'k', t0);
    write(L, 'hide.txt', 'h', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' }, compare: { excludeFilter: 'hide.txt' } }));
    const fsx = new NativeFs();
    const doc = await readDb(fsx, L);
    const sess = doc.sessions[pairIdFor(null, L, R)];
    ok(sess && sess.items['hide.txt'], 'the filtered-out entry survives in the database');
  }

  // (p) A folder that does not exist yet is CREATED and locked, not skipped:
  // two machines starting their first backup into the same new share both used
  // to run unprotected. syncto's transient "Delete.N." takeover names stay
  // invisible to the comparison.
  {
    const fsx = new NativeFs();
    const fresh = path.join(ROOT, 'not-yet-created');
    const set = await acquireAll([{ fs: fsx, path: fresh }], {});
    eq(set.count, 1, 'a folder that does not exist yet is created and locked');
    ok(await fsx.exists(path.join(fresh, '.syncto.lock')), 'the lock file is really there');
    await set.release();
    ok(!(await fsx.exists(path.join(fresh, '.syncto.lock'))), 'and it is gone after release');
    ok(isSyncToInternal('Delete.0..syncto.lock'), 'a lock being taken over is internal litter');
    ok(!isSyncToInternal('Delete.0.notes'), 'but a user file named Delete.0.notes is not');
  }
}

// ══ 16. Audit fixes — 0.2.5 ════════════════════════════════════════════════
// One case per data-loss or silent-failure bug found in the 0.2.4 audit.
// Each of these failed on 0.2.4.

// Compare and synchronize as two separate steps, so a test can change the
// folders in between — which is exactly what several of these bugs need.
async function stepped(job, between, opts) {
  const s = new Session();
  const token = { cancelled: false, paused: false };
  const cmp = await s.compare(job, { token });
  if (between) await between(s);
  let run = null, error = null;
  try { run = await s.sync(job, Object.assign({ token, appVersion: 'test' }, opts || {})); }
  catch (err) { error = err; }
  await s.close();
  return { s, cmp, run, error };
}

// Moves an item into <dir>/.trash — the shape SyncRunner expects of trashItem.
function makeTrash(dir) {
  const bin = path.join(dir, '.trash');
  return {
    bin,
    fn: async (fsx, abs) => {
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(abs, path.join(bin, path.basename(abs)));
      return true;
    },
  };
}

async function testAuditFixes() {
  console.log('\n\n16. Audit fixes (0.2.5)');

  // (a) THE one. An unmounted source reads as an empty folder, and an empty
  //     folder plus a mirror is "delete everything on the other side". The
  //     comparison said so out loud — without marking it fatal.
  {
    const { L, R } = scratch();
    write(R, 'a.mov', 'keep'); write(R, 'sub/b.mov', 'keep');
    fs.rmSync(L, { recursive: true, force: true });
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!run, 'a missing source folder does not run a mirror');
    ok(error && /not there/i.test(error.message), 'and says which side is missing');
    ok(exists(R, 'a.mov') && exists(R, 'sub/b.mov'), 'the healthy side is untouched');
  }

  // (b) The same guard must not block the legitimate case: a target that does
  //     not exist yet is created, not treated as a catastrophe.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.rmSync(R, { recursive: true, force: true });
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!error, 'a missing target folder still synchronizes');
    ok(run && read(R, 'a.mov') === 'data', 'and the file lands in it');
  }

  // (c) Overwriting is deleting, with a copy on top. Versioning configured on
  //     one side only used to throw when DELETING and shrug when OVERWRITING,
  //     so the replaced version was destroyed with "keep every version" on.
  {
    const { dir, L, R } = scratch();
    write(L, 'a.mov', 'NEW', Date.now());
    write(R, 'a.mov', 'OLD', Date.now() - 86400000);
    const { run, error } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'versioning',
              versioning: { leftFolder: path.join(dir, 'rev-left'), rightFolder: '' } },
    }));
    ok(!error, 'the run itself completes');
    eq(read(R, 'a.mov'), 'OLD', 'the version that could not be archived is NOT replaced');
    ok(run && run.errors.some(e => /revision folder/i.test(e.message)),
       'and the refusal is reported as an error');
  }

  // (d) Same rule for the recycle bin: no bin here (and no permanent
  //     fallback) means the previous version cannot be kept, so do not replace
  //     it. Since 0.3.1 this is settled BEFORE the run rather than file by
  //     file during it — see section 19.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'NEW', Date.now());
    write(R, 'a.mov', 'OLD', Date.now() - 86400000);
    const { run, error } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false },
    }));
    eq(read(R, 'a.mov'), 'OLD', 'no recycle bin: the old version stays put');
    ok(!run, 'the run does not start at all');
    ok(error && /recycle bin/i.test(error.message), 'and the reason is reported');
  }

  // (e) preserveTimes off recorded the SOURCE date as the target's, so every
  //     later run saw a change on both sides and bounced the file forever.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data', Date.now() - 7 * 86400000);
    const job = makeJob(L, R, { sync: { variant: 'twoWay', preserveTimes: false } });
    const first = await runPair(job);
    eq(first.run.counters.files, 1, 'first run copies the file');
    const second = await runPair(job);
    eq(second.run.counters.files, 0, 'the second run has nothing to copy');
    eq(second.cmp.stats.updateLeft + second.cmp.stats.updateRight, 0,
       'and nothing to update in either direction');
  }

  // (f) A comparison that was interrupted is not a comparison. It used to be
  //     stamped as complete, which re-armed SYNCHRONIZE on a partial plan.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    const s = new Session();
    const token = { cancelled: true, paused: false };
    const cmp = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token });
    ok(cmp.cancelled, 'a cancelled comparison says so');
    eq(s.comparedAt, 0, 'and is not stamped as compared');
    let threw = false;
    try { await s.sync(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false }, appVersion: 'test' }); }
    catch (_) { threw = true; }
    ok(threw, 'synchronizing on top of it is refused');
    await s.close();
  }

  // (g) "Ignore errors" was declared, persisted, passed to the engine and read
  //     nowhere: the run always carried on. Off, it must stop at the first one.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'one'); write(L, 'b.mov', 'two'); write(L, 'c.mov', 'three');
    const vanish = () => fs.rmSync(path.join(L, 'a.mov'));
    const stop = await stepped(makeJob(L, R, { sync: { variant: 'mirror', ignoreErrors: false } }), vanish);
    ok(stop.run && stop.run.stopped, 'with "ignore errors" off the run stops');
    eq(stop.run.counters.files, 0, 'and copies nothing after the failure');

    const { L: L2, R: R2 } = scratch();
    write(L2, 'a.mov', 'one'); write(L2, 'b.mov', 'two'); write(L2, 'c.mov', 'three');
    const go = await stepped(makeJob(L2, R2, { sync: { variant: 'mirror', ignoreErrors: true } }),
      () => fs.rmSync(path.join(L2, 'a.mov')));
    ok(!go.run.stopped, 'with it on the run carries on');
    eq(go.run.counters.files, 2, 'the two healthy files are copied');
    // (h) A failed copy is not a copy. It used to be counted as one, so the
    //     report read "Files copied: 3 · Errors: 1".
    eq(go.run.counters.failed, 1, 'and the failure is counted separately');
  }

  // (i) A database that could not be written is an ERROR, not a note: the next
  //     two-way run reads yesterday's state and resurrects deleted files.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.mkdirSync(path.join(R, '.syncto.db'));            // a directory: unwritable as a file
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    ok(run.errors.some(e => /database could not be written/i.test(e.message)),
       'a failed database write is reported as an error');
    ok(run.counters.errors > 0, 'and counted, so the summary cannot say "successful"');
  }

  // (j) The database is rewritten in place; a crash mid-write used to destroy
  //     the history of EVERY pair sharing that base folder. Write then rename.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.mkdirSync(path.join(R, '.syncto.db'));
    await stepped(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    ok(!exists(R, '.syncto.db.syncto_tmp'), 'a failed database write leaves no temporary file');
    ok(exists(L, '.syncto.db'), 'and the side that succeeded keeps a real database');
    const { readDb } = require('../src/main/core/db');
    const doc = await readDb(new NativeFs(), L);
    ok(doc && doc.sessions, 'which is still readable');
  }

  // (k) Deleting a folder through the recycle bin took its whole contents —
  //     including the files the hard filter was hiding on purpose.
  {
    const { dir, L, R } = scratch();
    write(R, 'old/a.txt', 'go');
    write(R, 'old/keep.bak', 'excluded on purpose');
    const trash = makeTrash(dir);
    const { run } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler' }, compare: { excludeFilter: '*.bak' } }),
      null, { trashItem: trash.fn });
    ok(exists(R, 'old/keep.bak'), 'the excluded file survives');
    ok(run.errors.length > 0, 'and the folder removal fails loudly instead');
  }

  // (l) A .syncto_tmp left by a killed run was invisible to the comparison and
  //     removed by nothing — 180 GB could sit on a NAS for ever.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    write(R, 'ghost.mov.syncto_tmp', 'x'.repeat(1000));
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!exists(R, 'ghost.mov.syncto_tmp'), 'the leftover from an interrupted run is swept');
    ok(run.notes.some(n => /leftover temporary file/i.test(n)), 'and the sweep is reported');
  }

  // (m) The soft filter judged a two-sided file on the LEFT copy alone, so a
  //     file edited yesterday on the right was dropped because the left copy
  //     was old.
  {
    const { L, R } = scratch();
    const old = Date.now() - 400 * 86400000;
    write(L, 'contract.pdf', 'old', old);
    write(R, 'contract.pdf', 'edited yesterday', Date.now() - 86400000);
    const s = new Session();
    const cmp = await s.compare(
      makeJob(L, R, { sync: { variant: 'twoWay' }, compare: { softFilter: { timeUnit: 'lastDays', timeValue: 7 } } }),
      { token: { cancelled: false } });
    const node = s.nodes.find(n => n.rel === 'contract.pdf');
    ok(node && node.active, 'a recent change on either side keeps the row active');
    eq(cmp.stats.excluded, 0, 'so it is not silently counted as excluded');
    await s.close();
  }

  // (n) The plan belongs to the folders that were COMPARED. Swapping the sides
  //     and pressing SYNCHRONIZE replayed the old plan against the new labels.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'left'); write(R, 'b.mov', 'right');
    const m = new MultiSession();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    await m.compare(job, { token: { cancelled: false } });
    const swapped = makeJob(R, L, { sync: { variant: 'mirror' } });
    swapped.pairs = [{ left: R, right: L }];
    let threw = false;
    try { await m.sync(swapped, { token: { cancelled: false }, appVersion: 'test' }); }
    catch (err) { threw = /changed since the last comparison/i.test(err.message); }
    ok(threw, 'synchronizing after a swap without re-comparing is refused');
    ok(exists(R, 'b.mov'), 'and nothing was deleted on the swapped side');
    await m.close();
  }

  // (o) A hostname is not an identity. Two machines cloned from one image
  //     shared "host + user", so each read the other's LIVE lock, found no
  //     such process locally, and took the folder.
  {
    const mine = localLockInfo();
    const twin = Object.assign({}, mine, { installId: 'ffffffffffffffffffffffffffffffff', processId: 999999 });
    eq(processStatus(twin, mine), 'unknown', 'a same-name machine with another install id is not us');
    const legacy = Object.assign({}, mine, { processId: 999999 });
    delete legacy.installId;
    eq(processStatus(legacy, mine), 'unknown', 'a lock from an older version is not assumed to be ours either');
    const ours = Object.assign({}, mine, { processId: 999999, sessionId: 1 });
    eq(processStatus(ours, mine), 'notRunning', 'but our own dead process still shortcuts the wait');
  }

  // (p) renameStrict must LOSE when the target exists — the lock takeover is
  //     built on it. POSIX rename overwrites silently, so both machines won.
  {
    const { dir } = scratch();
    const fsx = new NativeFs();
    const a = write(dir, 'a', 'A'), b = write(dir, 'b', 'B');
    let threw = false;
    try { await fsx.renameStrict(a, b); } catch (err) { threw = err.code === 'EEXIST'; }
    ok(threw, 'renameStrict refuses an existing target');
    eq(fs.readFileSync(b, 'utf8'), 'B', 'and leaves it untouched');
    const c = path.join(dir, 'c');
    await fsx.renameStrict(a, c);
    ok(fs.existsSync(c) && !fs.existsSync(a), 'a free target still works');
  }

  // (q) A job file may be hand-edited or produced by another tool. A null
  //     section used to blow up halfway through redrawing the window.
  {
    const { dir } = scratch();
    const p = path.join(dir, 'broken.syncto');
    fs.writeFileSync(p, JSON.stringify({ format: 'syncto-job', compare: null, sync: 'nope', pairs: [] }));
    const { loadJob } = require('../src/main/config');
    const job = loadJob(p);
    ok(job.compare && typeof job.compare === 'object', 'a null section falls back to the default');
    ok(job.sync && typeof job.sync.variant === 'string', 'so does a section of the wrong type');
    ok(Array.isArray(job.pairs) && job.pairs.length === 1, 'and an empty pair list gets one blank pair');
  }

  // (r) Each side keeps the spelling it really has on disk. Building the
  //     destination path from the source spelling is how an accented file ends
  //     up duplicated on a server that stores names byte for byte.
  {
    const { L, R } = scratch();
    const nfd = 'Café.txt', nfc = 'Café.txt';
    write(L, nfd, 'new', Date.now());
    write(R, nfc, 'old', Date.now() - 86400000);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const node = s.nodes[0];
    ok(s.nodes.length === 1, 'the two spellings are one item, not two');
    eq(node.relL, nfd, 'the left path keeps the decomposed spelling');
    eq(node.relR, nfc, 'the right path keeps the composed one');
    eq(node.rel, nfc, 'and the key is the composed form, whichever side exists');
    await s.close();
  }
}

// ══ 17. Interface — 0.2.6 ══════════════════════════════════════════════════
async function testOverviewAndShowEqual() {
  console.log('\n\n17. Overview and "show identical" (0.2.6)');

  // (a) Two folders already in sync: zone 2 has nothing to say. It used to
  //     list every top-level folder with a percentage bar, describing work
  //     that did not exist.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'Rushes/A001.mov', 'same', t); write(R, 'Rushes/A001.mov', 'same', t);
    write(L, 'Audio/mix.wav', 'same', t);   write(R, 'Audio/mix.wav', 'same', t);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 0, 'identical folders produce an empty overview');
    ok(ov.identical, 'and say so explicitly');
    eq(ov.totalBytes, 0, 'with no bytes to account for');

    // The switch opts back into the full tree, for navigation.
    const full = s.overview({ showEqual: true });
    eq(full.rows.length, 2, '"show identical" lists the folders again');
    await s.close();
  }

  // (b) One changed file: only its folder shows, and the size is the data
  //     that will really cross — not the size of everything already there.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'Rushes/A001.mov', 'x'.repeat(500), t);
    write(R, 'Rushes/A001.mov', 'x'.repeat(500), t);
    write(L, 'Rushes/A002.mov', 'y'.repeat(120), Date.now());
    write(L, 'Audio/mix.wav', 'same', t); write(R, 'Audio/mix.wav', 'same', t);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 1, 'only the folder with work appears');
    eq(ov.rows[0].name, 'Rushes', 'and it is the right one');
    eq(ov.rows[0].items, 1, 'counting only the item that moves');
    eq(ov.rows[0].bytes, 120, 'and only the bytes that will cross');
    await s.close();
  }

  // (c) Deletions are work too, even though they transfer nothing.
  {
    const { L, R } = scratch();
    write(R, 'Old/stale.mov', 'gone');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 1, 'a folder that will be emptied still appears');
    eq(ov.rows[0].bytes, 0, 'with no bytes, because a deletion moves nothing');
    await s.close();
  }

  // (d) Filtering on the "identical" chip must show those rows WITHOUT the
  //     window switching "show identical" on — that flag was then written to
  //     the preferences and came back ticked at every launch.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'same.txt', 'x', t); write(R, 'same.txt', 'x', t);
    write(L, 'new.txt', 'y', Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    eq(s.rows(0, 50, { showEqual: false }).total, 1, 'by default only the row with work is listed');
    const onlyEqual = s.rows(0, 50, { showEqual: false, onlyOperation: 'none' });
    eq(onlyEqual.total, 1, 'filtering on "identical" reveals the identical row');
    eq(onlyEqual.rows[0].rel, 'same.txt', 'and it is the identical one');
    await s.close();
  }

  // (f) Clicking a folder in the overview scopes the grid to it. Every row
  //     the overview lists is a TOP-LEVEL entry of its own pair — with two
  //     pairs merged into one list, that was impossible to tell.
  {
    const { L, R } = scratch();
    write(L, 'Rushes/A001/clip.mov', 'a');
    write(L, 'Rushes/A002/clip.mov', 'b');
    write(L, 'Docs/notes.txt', 'c');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const wide = s.rows(0, 200, {}).total;
    const scoped = s.rows(0, 200, { scope: { rel: 'Rushes' } });
    ok(scoped.total < wide, 'a scope shows fewer rows than the whole tree');
    ok(scoped.rows.every(r => r.rel === 'Rushes' || r.rel.startsWith('Rushes/')),
       'and only rows inside the folder that was clicked');
    ok(scoped.rows.some(r => r.rel === 'Rushes/A001/clip.mov'),
       'including the ones nested deeper inside it');
    ok(!scoped.rows.some(r => r.rel.startsWith('Docs')), 'a sibling folder is left out');
    // A name that is a prefix of another must not drag it in.
    write(L, 'Rush/other.txt', 'd');
    const s2 = new Session();
    await s2.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const tight = s2.rows(0, 200, { scope: { rel: 'Rush' } });
    ok(tight.rows.every(r => !r.rel.startsWith('Rushes')), '"Rush" does not also match "Rushes"');
    await s.close(); await s2.close();
  }

  // (e) The preferences carry a revision, so the value the old bug stored is
  //     cleared once instead of following the user around for ever.
  {
    const { dir } = scratch();
    const { Prefs } = require('../src/main/config');
    const p = new Prefs(dir);
    fs.writeFileSync(path.join(dir, 'preferences.json'),
      JSON.stringify({ ui: { showEqual: true }, recent: [{ name: 'keep', path: '/tmp/x' }] }));
    p.load();
    eq(p.data.ui.showEqual, false, 'a pre-0.2.6 "show identical" is cleared on upgrade');
    eq(p.data.recent.length, 1, 'and the rest of the preferences survive');
    p.data.ui.showEqual = true;
    p.save();
    const again = new Prefs(dir);
    again.load();
    eq(again.data.ui.showEqual, true, 'a value set deliberately afterwards is kept');
  }
}

// ══ 18. Servers and credentials — 0.2.7 ═══════════════════════════════════
function testServers() {
  console.log('\n\n18. Servers and credentials (0.2.7)');
  const { migratePrefs, credentialMap, Prefs } = require('../src/main/config');
  const { RemoteBrowser } = require('../src/main/fs/browse');
  const { parseLocation } = require('../src/main/fs/afs');
  const secrets = require('../src/main/secrets');

  // Outside Electron there is no OS credential store, and the code must know
  // it. That is the whole point of the fallback: refuse to remember, never
  // downgrade to writing the password in the clear.
  ok(!secrets.available(), 'no credential store outside Electron, and the code knows it');
  eq(secrets.encrypt('hunter2'), null, 'so encrypt() refuses rather than returning plain text');

  // (a) A 0.2.6 preferences file carried the password in plain text under
  //     sftp["user@host"]. Upgrading turns it into a named server AND leaves
  //     nothing readable behind.
  {
    const raw = {
      ui: { showEqual: true },
      sftp: { 'arnaud@192.168.1.50': { username: 'arnaud', password: 'hunter2', passphrase: 'secret-phrase' } },
    };
    const out = migratePrefs(JSON.parse(JSON.stringify(raw)));
    const text = JSON.stringify(out);
    ok(!text.includes('hunter2'), 'the old plain-text password does not survive the migration');
    ok(!text.includes('secret-phrase'), 'nor does the passphrase');
    eq(out.sftp, undefined, 'the flat credential map is gone');
    eq(out.servers.length, 1, 'and it became one named server');
    eq(out.servers[0].username, 'arnaud', 'with the login kept');
    eq(out.servers[0].host, '192.168.1.50', 'and the host kept');
    eq(out.revision, 2, 'stamped with the preferences revision');
  }

  // (b) A `password` key must not survive a write, whoever put it there — an
  //     older build, a hand edit, a restored backup, or the renderer.
  {
    const { dir } = scratch();
    const p = new Prefs(dir);
    p.load();
    p.data.servers = [{ id: 'x', name: 'NAS', host: '10.0.0.8', port: 22,
                        username: 'dit', password: 'plain-text-leak' }];
    p.save();
    const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
    ok(!onDisk.includes('plain-text-leak'), 'a password set on the object never reaches the file');
    ok(onDisk.includes('10.0.0.8'), 'while the rest of the entry is stored normally');
  }

  // (c) The engine still receives what it expects: a map keyed by user@host.
  {
    const map = credentialMap([
      { host: 'nas.local', username: 'arnaud', port: 22 },
      { host: '10.0.0.8', username: 'dit', port: 2222 },
      { host: '', username: 'nobody' },                      // incomplete: skipped
    ]);
    // A non-default port gets its own key as well: two servers on the same host
    // and login but different ports have different passwords, and the port-less
    // key can only hold one of them.
    eq(Object.keys(map).sort(),
       ['arnaud@nas.local', 'dit@10.0.0.8', 'dit@10.0.0.8:2222'],
       'keys are user@host, plus user@host:port when the port is not 22');
    eq(map['arnaud@nas.local'].password, '', 'with no password to hand over on this machine');
  }

  // (d) The URL that lands in the folder field must never carry a password —
  //     it is displayed, saved into .syncto job files, and printed in reports.
  {
    const url = RemoteBrowser.urlFor({ host: '192.168.1.50', port: 22, username: 'arnaud' }, '/srv/backup/projets');
    eq(url, 'sftp://arnaud@192.168.1.50/srv/backup/projets', 'the default port is left out');
    eq(RemoteBrowser.urlFor({ host: 'nas.local', port: 2222, username: 'dit' }, '/data'),
       'sftp://dit@nas.local:2222/data', 'a custom port is kept');

    // And the engine parses back exactly what the window produced.
    const loc = parseLocation(url, credentialMap([{ host: '192.168.1.50', username: 'arnaud' }]));
    eq(loc.kind, 'sftp', 'the engine recognises it');
    eq(loc.username, 'arnaud', 'with the right login');
    eq(loc.host, '192.168.1.50', 'the right host');
    eq(loc.port, 22, 'the right port');
    eq(loc.path, '/srv/backup/projets', 'and the right folder');
  }

  // (e) Saving a server twice is an update, not a duplicate: reconnecting to
  //     the same NAS must not grow the list every time.
  {
    const { dir } = scratch();
    const p = new Prefs(dir);
    p.load();
    p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud', savePassword: false });
    p.saveServer({ name: 'NAS Montage', host: 'nas.local', port: 22, username: 'arnaud', savePassword: false });
    eq(p.listServers().length, 1, 'the same user@host:port updates its entry');
    eq(p.listServers()[0].name, 'NAS Montage', 'and takes the new name');
    p.saveServer({ name: 'Archives', host: '10.0.0.8', port: 22, username: 'dit', savePassword: false });
    eq(p.listServers().length, 2, 'a different server is a new entry');
    ok(p.listServers().every(s => !('password' in s) && !('passwordEnc' in s)),
       'and the list handed to the window carries no secret at all');
  }
}

// ══ 19. NAS regression — 0.3.1 ════════════════════════════════════════════
// Reported from a real run: mirror to a NAS, 0 files copied, "Stopped at the
// first error". Two 0.2.5 changes combined into a job that could do nothing.
async function testNasRegression() {
  console.log('\n\n19. Recycle bin on a NAS (0.3.1)');

  // A trash that refuses everything: what macOS does on most network shares,
  // while NativeFs.supportsTrash() cheerfully answers "yes" for any local path.
  const deadTrash = async () => false;
  const liveTrash = (dir) => {
    const bin = path.join(dir, '.trash');
    return async (fsx, abs) => {
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(abs, path.join(bin, path.basename(abs) + '-' + Math.random().toString(36).slice(2)));
      return true;
    };
  };

  // (a) The whole reported failure: deletions planned on a volume with no
  //     working bin. It must be settled before the run, not discovered on the
  //     first file — and NOTHING must have been touched.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'keep.mov', 'data');
    write(R, 'stale/CACHE.DAT', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: deadTrash });
    ok(!run, 'the run refuses to start');
    ok(error && /recycle bin does not work/i.test(error.message), 'saying the bin does not work there');
    ok(error && error.message.includes(R), 'and naming the folder');
    ok(error && /Delete permanently/i.test(error.message) && /delete anyway/i.test(error.message),
       'and naming both settings that fix it, exactly as they read on screen');
    ok(exists(R, 'stale/CACHE.DAT'), 'nothing was deleted');
    ok(!exists(R, '.syncto.trash-probe'), 'and the probe left nothing behind');
  }

  // (b) The same job with a working bin runs normally — the check must not
  //     block a NAS that does have one.
  {
    const { dir, L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: liveTrash(dir) });
    ok(!error, 'a working recycle bin is not blocked');
    ok(run && run.counters.files === 1, 'and the copy happens');
    ok(!exists(R, 'stale.mov'), 'with the deletion carried out');
  }

  // (c) Permanent deletion never needed a bin, so it must not be checked.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }),
      null, { trashItem: deadTrash });
    ok(!error && run, 'permanent deletion runs without a recycle bin');
    ok(!exists(R, 'stale.mov'), 'and removes the stray file');
  }

  // (d) A job with nothing to delete or replace is not blocked either: a bin
  //     that does not work only matters when something is going to be lost.
  {
    const { L, R } = scratch();
    write(L, 'new.mov', 'data');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: deadTrash });
    ok(!error, 'a pure copy is never blocked by the recycle bin');
    ok(run && run.counters.files === 1, 'and it copies');
  }

  // (e) "Ignore errors" is on by default again. 0.2.5 made the setting real
  //     and left it off, so one unreadable file meant a run that copied
  //     nothing — the wrong trade for a backup tool.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'one'); write(L, 'b.mov', 'two'); write(L, 'c.mov', 'three');
    const job = defaultJob();
    job.left = L; job.right = R; job.name = 'test';
    job.sync.variant = 'mirror'; job.sync.deletion = 'permanent';
    job.sync.report.enabled = false; job.sync.retryCount = 0;
    eq(job.sync.ignoreErrors, true, 'a new job carries on past a failure by default');
    const res = await stepped(job, () => fs.rmSync(path.join(L, 'a.mov')));
    ok(!res.run.stopped, 'so the run is not stopped by one missing file');
    eq(res.run.counters.files, 2, 'and the healthy files are copied');
  }

  // (f) A job saved before the setting did anything carries a meaningless
  //     `false`. Loading it must not arm "stop at the first error".
  {
    const { dir } = scratch();
    const { loadJob } = require('../src/main/config');
    const p = path.join(dir, 'old.syncto');
    fs.writeFileSync(p, JSON.stringify({
      format: 'syncto-job', pairs: [{ left: '/a', right: '/b' }],
      sync: { variant: 'mirror', ignoreErrors: false },
    }));
    eq(loadJob(p).sync.ignoreErrors, true, 'an old job is not left with the dead default');

    const q = path.join(dir, 'new.syncto');
    fs.writeFileSync(q, JSON.stringify({
      format: 'syncto-job', rev: 1, pairs: [{ left: '/a', right: '/b' }],
      sync: { variant: 'mirror', ignoreErrors: false },
    }));
    eq(loadJob(q).sync.ignoreErrors, false, 'but a deliberate choice made since is kept');
  }
}


// ══ 20. After the run, and phone notifications — 0.4.0 ════════════════════
function testAfterAndNtfy() {
  console.log('\n\n20. After the run and ntfy (0.4.0)');
  const power  = require('../src/main/power');
  const notify = require('../src/main/notify');
  const { Prefs } = require('../src/main/config');

  // (a) The right command on the right system. Asserted rather than run —
  //     a test suite that puts the machine to sleep is not a test suite.
  {
    eq(power.commandFor('sleep', 'darwin').cmd, 'pmset', 'macOS sleeps with pmset');
    eq(power.commandFor('sleep', 'darwin').args, ['sleepnow'], 'and asks for it now');
    eq(power.commandFor('sleep', 'win32').cmd, 'rundll32.exe', 'Windows sleeps through powrprof');
    eq(power.commandFor('shutdown', 'win32').args, ['/s', '/t', '0'], 'and shuts down with no delay');
    // Not `shutdown -h`, which needs root: this is the Apple-menu request, so
    // an app with unsaved work can still refuse.
    ok(/System Events/.test(power.commandFor('shutdown', 'darwin').args[1]),
       'macOS shuts down through System Events, not as root');
    eq(power.commandFor('none', 'darwin'), null, 'doing nothing has no command');
    eq(power.commandFor('quit', 'darwin'), null, 'and quitting is the app is own business');
    ok(!power.ACTIONS.includes('hibernate'),
       'there is no hibernate action — macOS has no such command');
  }

  // (b) The action must NOT fire on a run whose result the user has to read.
  //     The machine would take the summary down with it.
  {
    const clean = { errors: [], counters: { errors: 0 } };
    const cases = [
      [{ errors: [{ message: 'x' }], counters: { errors: 1 } }, 'an error'],
      [{ errors: [], counters: { errors: 0 }, cancelled: true }, 'a cancellation'],
      [{ errors: [], counters: { errors: 0 }, stopped: true }, 'a stop at the first error'],
      [{ errors: [], counters: { errors: 0 }, lockLost: 'x' }, 'a lost folder lock'],
    ];
    // runWasClean lives in the renderer; the rule is asserted here on the same
    // shape the renderer receives, so a change to the result shape breaks it.
    const runWasClean = r => !r.cancelled && !r.stopped && !r.lockLost &&
      !(r.errors && r.errors.length) && !(r.counters && r.counters.errors);
    ok(runWasClean(clean), 'a clean run may trigger the action');
    for (const [res, why] of cases) ok(!runWasClean(res), why + ' blocks the action');
  }

  // (c) Title, Tags and Priority are HTTP HEADER values. One accent or emoji
  //     throws ERR_INVALID_CHAR and loses the WHOLE notification, body
  //     included — the trap ingesto was bitten by.
  {
    eq(notify.headerSafe('Sauvegarde terminée ✓'), 'Sauvegarde termine', 'the title is stripped to ASCII');
    eq(notify.tagsSafe('white_check_mark'), 'white_check_mark', 'a plain tag passes through');
    eq(notify.tagsSafe('✅,warning'), 'warning', 'an emoji tag is dropped, the rest survives');
    eq(notify.tagsSafe(',,x,,'), 'x', 'stray commas are trimmed');
  }

  // (d) The message built for a finished run.
  {
    const okRun = { counters: { files: 12, bytes: 3.4e9, deleted: 2 }, errors: [],
                    durationMs: 95000, verified: 12 };
    const m = notify.forRun(okRun, 'TNAS');
    ok(/TNAS/.test(m.title) && /done/.test(m.title), 'a clean run is titled with the job name');
    ok(/12 files/.test(m.message) && /3.40 GB/.test(m.message), 'with what was copied');
    ok(/1m 35s/.test(m.message), 'and how long it took');
    eq(m.tags, 'white_check_mark', 'tagged as a success');

    const badRun = { counters: { files: 3, bytes: 100 },
                     errors: [{ rel: 'a.mov', message: 'no recycle bin' }], durationMs: 1000 };
    const b = notify.forRun(badRun, 'TNAS');
    ok(/1 error/.test(b.title), 'a failed run says so in the title, where a phone shows it');
    ok(/a.mov/.test(b.message), 'and names the first thing that failed');
    eq(b.tags, 'warning', 'tagged as a problem');
    eq(b.priority, 4, 'and raised in priority so the phone actually rings');

    const cancelled = { counters: {}, errors: [], cancelled: true, durationMs: 0 };
    ok(/cancelled/i.test(notify.forRun(cancelled, 'X').title), 'a cancelled run is not reported as done');
  }

  // (e) An empty topic must not produce a POST to the server root.
  {
    return notify.send({ server: 'https://ntfy.sh', topic: '' }).then(r => {
      ok(!r.ok && /topic/i.test(r.error), 'no topic, no request');
      return notify.send({ server: 'ftp://nope', topic: 't' });
    }).then(r => {
      ok(!r.ok && /http/i.test(r.error), 'and the server address must be http(s)');
    });
  }
}

function testNtfySecrets() {
  console.log('\n\n21. ntfy token storage (0.4.0)');
  const { Prefs } = require('../src/main/config');
  const { dir } = scratch();
  const p = new Prefs(dir);
  p.load();

  // The access token is a credential like any other: it goes through the OS
  // credential store, never into the file in the clear.
  p.saveNtfy({ enabled: true, server: 'https://ntfy.example', topic: 'syncto-abc', token: 'tk_secret_value' });
  const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
  ok(!onDisk.includes('tk_secret_value'), 'the ntfy token never reaches the file in the clear');
  ok(onDisk.includes('syncto-abc'), 'while the topic is stored normally');

  const ui = p.ntfyForUi();
  ok(!('token' in ui) && !('tokenEnc' in ui), 'and the settings panel is never handed the token');
  eq(ui.topic, 'syncto-abc', 'it gets the topic');
  eq(ui.enabled, true, 'and the switch state');

  // Saving the panel again without retyping the token must not wipe it.
  p.data.ntfy.tokenEnc = 'PRETEND-CIPHERTEXT';
  p.saveNtfy({ topic: 'syncto-def' });
  eq(p.data.ntfy.tokenEnc, 'PRETEND-CIPHERTEXT', 'an untouched token box leaves the stored token alone');
  p.saveNtfy({ token: '' });
  eq(p.data.ntfy.tokenEnc, '', 'and clearing it explicitly does clear it');
}


// ══ 22. One copy mode — 0.5.0 ═════════════════════════════════════════════
// syncto used to offer Fast / Verified / Secure. Fast and Verified ended up
// doing exactly the same thing, so two thirds of the choice was between
// identical behaviours with different names — and a user on "Verified" never
// saw a verification phase, because there wasn't one.
async function testSingleCopyMode() {
  console.log('\n\n22. One copy mode (0.5.0)');
  const { algoFor } = require('../src/main/core/hash');
  const { migrateJob, defaultJob } = require('../src/main/config');

  eq(algoFor(), 'xxh64', 'there is one algorithm and it is always used');
  eq(algoFor('fast'), 'xxh64', 'even when an old caller still passes a level');
  eq(defaultJob().sync.copyLevel, 'secure', 'a new job is secure');

  // A job saved when the levels existed must NOT quietly run weaker than the
  // interface now claims.
  eq(migrateJob({ sync: { copyLevel: 'fast' } }).sync.copyLevel, 'secure',
     "an old 'fast' job is pinned to secure on load");
  eq(migrateJob({ sync: { copyLevel: 'verified' } }).sync.copyLevel, 'secure',
     "so is an old 'verified' job");
  eq(migrateJob({ sync: { copyLevel: 'pro' } }).sync.copyLevel, 'secure',
     "and the even older 'pro'");

  // Whatever the file asks for, every run reads back what it wrote.
  for (const asked of ['fast', 'verified', 'secure', undefined]) {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x'.repeat(4096));
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    if (asked) job.sync.copyLevel = asked;
    const { run } = await runPair(job);
    eq(run.counters.files, 1, `copyLevel=${asked}: the file is copied`);
    eq(run.verified, 1, `copyLevel=${asked}: and read back and verified`);
    // Written once, read once: the work counter has to see both, or the ring
    // freezes at 50% while the verification runs.
    eq(run.counters.workBytes, 8192, `copyLevel=${asked}: work counts the read-back too`);
  }

  // The checksum list no longer depends on a level that no longer exists.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    delete job.sync.copyLevel;
    await runPair(job);
    ok(exists(R, 'syncto-checksums.txt'), 'the checksum list is written whenever it is asked for');
  }

  // And the report says what was checked, in words a client can read.
  {
    const { buildReport, toHtml } = require('../src/main/core/report');
    const rep = buildReport({
      appVersion: 't', pairName: 'j', leftPath: '/l', rightPath: '/r',
      variant: 'mirror', compareVariant: 'timeSize', copyLevel: 'secure',
      deletion: 'permanent', versioningStyle: '', filter: {},
      startedAt: 0, endedAt: 1000,
      run: { results: [], counters: { files: 3, bytes: 100, deleted: 0, folders: 0 },
             notes: [], verified: 3, errors: [] },
      stats: null, comparisonErrors: [],
    });
    eq(rep.totals.filesVerified, 3, 'the report carries the verified count');
    const html = toHtml(rep);
    ok(/read back and verified \(xxHash64\)/.test(html), 'and states it in the page');
    ok(/every file read back and compared/.test(html), 'and in the settings block');
    ok(!/size-checked/.test(html), 'with no trace of the old middle level');
  }
}


// ══ 23. Audit 0.5.1 — corrections ═════════════════════════════════════════
async function testAudit051() {
  console.log('\n\n23. Audit fixes (0.5.2)');
  const { redactLocation, parseLocation } = require('../src/main/fs/afs');
  const { Prefs, saveJob, defaultJob, migratePrefs, credentialMap } = require('../src/main/config');
  const notify = require('../src/main/notify');

  // (a) A password typed into a folder field reached preferences.json, the
  //     .syncto handed to a colleague, AND the body of the phone notification.
  {
    eq(redactLocation('sftp://arnaud:Hunter2!@nas.local/srv'), 'sftp://arnaud@nas.local/srv',
       'the password is taken out of the address');
    eq(redactLocation('/Volumes/RAID/Project'), '/Volumes/RAID/Project', 'a local path is untouched');
    eq(redactLocation('sftp://arnaud@nas.local/srv'), 'sftp://arnaud@nas.local/srv',
       'an address without one is untouched');

    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    p.data.job.pairs = [{ left: '/Volumes/CARD', right: 'sftp://arnaud:Hunter2!@nas.local/srv' }];
    p.save();
    const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
    ok(!onDisk.includes('Hunter2!'), 'no password reaches preferences.json');
    eq(JSON.parse(onDisk).job.pairs[0].right, 'sftp://arnaud@nas.local/srv',
       'and the stored path keeps working without it');

    const j = defaultJob();
    j.pairs = [{ left: '/a', right: 'sftp://arnaud:Hunter2!@nas.local/srv' }];
    const jf = path.join(dir, 'shared.syncto');
    saveJob(jf, j);
    ok(!fs.readFileSync(jf, 'utf8').includes('Hunter2!'), 'nor the job file meant to be shared');
  }

  // (b) The two sides of a pair with no path made split('/').pop() return
  //     "user:secret@host" — a label that travels into errors and ntfy.
  {
    const { pairLabel } = require('../src/main/core/session');
    const label = pairLabel({ left: 'sftp://arnaud:Hunter2!@nas.local', right: '/tmp/x' });
    ok(!label.includes('Hunter2!'), 'the pair label carries no password');
    ok(label.includes('nas.local'), 'but still names the machine');
    eq(pairLabel({ left: '/Volumes/CARD/', right: '/tmp/x' }), 'CARD → x',
       'a plain pair still reads as its two folder names');
  }

  // (c) Two servers on one host but different ports had one password between
  //     them: the port-less key could only hold the last one.
  {
    const map = credentialMap([
      { host: 'nas.local', username: 'a', port: 22 },
      { host: 'nas.local', username: 'a', port: 2222 },
    ]);
    ok(map['a@nas.local:2222'], 'the non-default port gets its own entry');
    const loc = parseLocation('sftp://a@nas.local:2222/data', map);
    eq(loc.port, 2222, 'and the address on that port finds it');
  }

  // (d) Repointing a saved server at another machine must not carry the old
  //     password to it.
  {
    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    const saved = p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud' });
    const id = saved.server.id;
    p.data.servers[0].passwordEnc = 'CIPHERTEXT-FOR-nas.local';
    p.saveServer({ id, name: 'Other', host: 'evil.example.com', port: 22, username: 'root' });
    eq(p.data.servers[0].passwordEnc, '', 'moving an entry to another host clears its password');
    eq(p.data.servers[0].host, 'evil.example.com', 'while the entry itself follows the edit');
  }

  // (e) A blob this account cannot read is not a remembered password.
  {
    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud' });
    p.data.servers[0].passwordEnc = 'not-decryptable-here';
    eq(p.listServers()[0].hasPassword, false,
       'an unreadable blob is not reported as a stored password');
  }

  // (f) A migration that has to drop credentials says so instead of losing
  //     them in silence.
  {
    const out = migratePrefs({ sftp: { 'arnaud@nas': { username: 'arnaud', password: 'p' } } });
    ok(!JSON.stringify(out).includes('"p"'), 'the plain-text password is gone');
    ok((out.migrationNotes || []).some(n => /credential store/i.test(n)),
       'and the user is told it could not be carried over');
  }

  // (g) A write that never reached the disk must not be reported as saved.
  {
    const { dir } = scratch();
    const p = new Prefs(path.join(dir, 'sub')); p.load();
    fs.writeFileSync(path.join(dir, 'sub'), 'not a directory');   // mkdir will fail
    const r = p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'a', password: 'x' });
    eq(r.written, false, 'the failed write is reported');
    eq(r.remembered, false, 'and nothing claims the password was remembered');
  }

  // (h) An access token must travel intact or not at all — stripping it to
  //     ASCII produced a 401 nobody could explain.
  {
    return notify.send({ server: 'https://ntfy.sh', topic: 't', token: 'tk_éàAB12' }).then(r => {
      ok(!r.ok && /header/i.test(r.error), 'a token that cannot be a header is refused, not mangled');
    });
  }
}

async function testAudit051Engine() {
  console.log('\n\n24. Audit fixes — engine (0.5.2)');

  // (a) THE one: the lock created the missing base folder before the guard ran,
  //     so the SECOND attempt saw an empty folder instead of a missing one and
  //     planned to delete the whole backup.
  {
    const { dir, L, R } = scratch();
    write(R, 'a.mov', 'keep'); write(R, 'b.mov', 'keep');
    fs.rmSync(L, { recursive: true, force: true });
    const job = makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } });

    const first = await stepped(job);
    ok(first.error && /not there/i.test(first.error.message), 'attempt 1 refuses');
    ok(!fs.existsSync(L), 'and the missing folder was NOT created by the lock');

    const second = await stepped(job);
    ok(second.error && /not there/i.test(second.error.message), 'attempt 2 refuses in the same way');
    ok(exists(R, 'a.mov') && exists(R, 'b.mov'), 'the backup is still there after both attempts');
  }

  // (b) A folder held back by a filtered file kept its checksum list: the
  //     sweep used to run before rmdir and destroyed the manifest anyway.
  {
    const { dir, L, R } = scratch();
    write(R, 'A001/clip.mov', 'x');
    write(R, 'A001/keep.bak', 'excluded');
    write(R, 'A001/syncto-checksums.txt', 'xxh64\nabc  clip.mov\n');
    const { run } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'permanent' },
      compare: { excludeFilter: '*.bak' },
    }));
    ok(exists(R, 'A001/keep.bak'), 'the excluded file survives');
    ok(exists(R, 'A001/syncto-checksums.txt'),
       'and so does the checksum list, in a folder that is not going away');
    ok(run.errors.length > 0, 'the folder removal still fails loudly');
  }

  // (c) An empty folder to remove needed no recycle bin, but the preflight
  //     demanded one and refused the whole run.
  {
    const { L, R } = scratch();
    write(L, 'new.mov', 'data');
    fs.mkdirSync(path.join(R, 'stale'), { recursive: true });
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: async () => false });
    ok(!error, 'a run whose only removal is a folder is not blocked');
    ok(run && run.counters.files === 1, 'and the copy happens');
  }

  // (d) Two-way went into a permanent conflict as soon as the target refused
  //     to take the source date.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data', Date.now() - 7 * 86400000);
    const job = makeJob(L, R, { sync: { variant: 'twoWay', preserveTimes: false } });
    await runPair(job);
    const second = await runPair(job);
    eq(second.cmp.stats.conflicts, 0, 'the second run is not a conflict');
    const third = await runPair(job);
    eq(third.cmp.stats.conflicts, 0, 'nor the third');
    eq(third.run.counters.files, 0, 'and nothing is copied back and forth');
  }

  // (e) A retry archived the target twice, and the second archive — the
  //     fragment left by the failed attempt — overwrote the good version.
  {
    const { dir, L, R } = scratch();
    const rev = path.join(dir, 'rev');
    write(L, 'a.mov', 'NEW-CONTENT', Date.now());
    write(R, 'a.mov', 'THE-ONLY-GOOD-OLD-VERSION', Date.now() - 86400000);
    const s = new Session();
    const job = makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'versioning', retryCount: 1,
              versioning: { leftFolder: '', rightFolder: rev, style: 'timestampFolder' } },
    });
    await s.compare(job, { token: { cancelled: false } });
    // Archive twice in a row, exactly as a retry would.
    const { SyncRunner } = require('../src/main/core/sync');
    const runner = new SyncRunner({ left: s.left, right: s.right, nodes: s.nodes,
                                    config: Object.assign({}, job.sync), token: { cancelled: false } });
    const node = s.nodes.find(n => n.rel === 'a.mov');
    await runner.archiveExisting('right', node);
    write(R, 'a.mov', 'TRUNCATED-FRAGMENT');          // what a failed attempt leaves
    await runner.archiveExisting('right', node);      // the retry archives again
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else found.push(fs.readFileSync(f, 'utf8'));
      }
    })(rev);
    ok(found.includes('THE-ONLY-GOOD-OLD-VERSION'), 'the good version is still in the revision store');
    ok(!found.includes('TRUNCATED-FRAGMENT'), 'and the retry did not bury it under its fragment');
    await s.close();
  }

  // (f) The checksum list has to name files the way the filesystem does.
  {
    const { L, R } = scratch();
    const nfd = 'Cafe\u0301.txt';
    write(L, nfd, 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    await runPair(job);
    const list = read(R, 'syncto-checksums.txt') || '';
    const onDisk = fs.readdirSync(R).find(n => n.normalize('NFC') === 'Café.txt');
    ok(onDisk && list.includes(onDisk),
       'the manifest names the file with the spelling the target really holds');
  }

  // (g) The heartbeat has to notice a share that stopped answering, not just
  //     one that returns errors.
  {
    const { acquireOne } = require('../src/main/core/lock');
    const { NativeFs } = require('../src/main/fs/native');
    const { dir } = scratch();
    const fsx = new NativeFs();
    let lost = null;
    const lock = await acquireOne(fsx, dir, { onLost: r => { lost = r; } });
    // A frozen mount does not fail — it never returns. Simulate exactly that.
    lock.fs = Object.assign(Object.create(Object.getPrototypeOf(fsx)), fsx, {
      appendByte: () => new Promise(() => {}),
      createReadStream: fsx.createReadStream.bind(fsx),
    });
    lock._lastBeat = Date.now() - 60000;          // 60 s of silence
    lock.timer._onTimeout();                       // one tick
    ok(lost && /not been refreshed/i.test(lost),
       'a lock that has gone quiet for a minute is reported lost');
    await lock.release();
  }

  // (h) A million rows in one pair collided with row 0 of the next pair: the
  //     grid's global index wrapped and a tick landed on another pair's file.
  {
    const { MultiSession } = require('../src/main/core/session');
    const m = new MultiSession();
    m.sessions = [{ nodes: new Array(3) }, { nodes: new Array(3) }];
    const a = m._split(1000001);
    eq(a.p, 0, 'row 1 000 001 still belongs to the first pair');
    eq(a.idx, -1, 'and is refused because that pair does not hold it');
    const b = m._split(1000000000 + 2);
    eq(b.p, 1, 'the second pair starts one billion higher');
    eq(b.idx, 2, 'and keeps its own row number');
    eq(m._split(-1).s, null, 'a negative index acts on nothing');
    eq(m._split(1.5).s, null, 'and so does a non-integer one');
    eq(m._split(1000000000 * 9).s, null, 'as does a pair that does not exist');
  }

  // (i) Windows long paths were only prefixed at the root, so a deep tree under
  //     a short root still failed at 260 characters.
  {
    const { NativeFs } = require('../src/main/fs/native');
    const nat = new NativeFs();
    const seen = [];
    nat.longPath = p => { seen.push(p); return p; };
    nat.join('base', 'a', 'b.mov');
    eq(seen.length, 1, 'every joined path goes through the long-path rule');
    ok(seen[0].endsWith('b.mov'), 'and it sees the full path, not just the root');

    const proto = Object.getPrototypeOf(nat);
    const deep = 'C:\\B\\' + 'x'.repeat(250);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      ok(proto.longPath.call(nat, deep).startsWith('\\\\?\\'),
         'a path past 240 characters gets the prefix');
      ok(proto.longPath.call(nat, '\\\\nas\\share\\' + 'y'.repeat(250)).startsWith('\\\\?\\UNC\\'),
         'and a UNC path gets the UNC form');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  }

  // (j) Two overlapping connections in the server window: the slower handshake
  //     landed last and overwrote — and leaked — the newer one.
  {
    const { RemoteBrowser } = require('../src/main/fs/browse');
    const b = new RemoteBrowser();
    let closed = 0;
    const fake = { close: async () => { closed++; } };
    b.fs = fake;
    const gen = b._gen;
    await b.close();
    eq(closed, 1, 'closing hangs up the live connection');
    ok(b._gen > gen, 'and invalidates any handshake still in flight');
    eq(b.fs, null, 'leaving nothing behind');
  }
}

// ══ 25. Folders the OS keeps something in (0.5.3) ═════════════════════════
async function testOsFolderLitter() {
  console.log('\n\n25. OS folders that blocked a removal (0.5.3)');

  // (a) THE one Noar hit: an HFS+ backup volume whose ingest folders each held
  //     a "System Volume Information" directory. The comparison skips that
  //     name, so the folder looked empty; the removal only ever unlinked
  //     FILES, so the folder could never go — every run reported
  //     "ENOTEMPTY: directory not empty" on a folder Finder showed as empty.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'keep.mov', 'data');
    write(R, 'ZZZZZZ/001_NOAR_Panasonic/System Volume Information/WPSettings.dat', 'windows');
    write(R, 'ZZZZZZ/001_NOAR_Panasonic/System Volume Information/IndexerVolumeGuid', 'guid');
    write(R, 'ZZZZZZ/002_NOAR_Panasonic/.DS_Store', 'finder');
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    ok(!error, 'the run is not refused');
    eq(run.errors.length, 0, 'and reports no error at all');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ', '001_NOAR_Panasonic')),
       'the folder holding System Volume Information is removed');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ', '002_NOAR_Panasonic')),
       'and so is the one holding only a .DS_Store');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ')), 'the empty parent goes with them');
  }

  // (b) The volume's recycle bin is NOT bookkeeping: it holds files somebody
  //     deleted and may want back. That folder is refused — but the message
  //     has to say why, which "ENOTEMPTY" never did.
  {
    const { L, R } = scratch();
    write(R, 'A001/.Trashes/501/deleted-by-mistake.mov', 'precious');
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    eq(run.errors.length, 1, 'the folder is refused');
    const msg = run.errors[0].message;
    ok(/still contains/.test(msg), 'and the message says the folder is not empty in plain words');
    ok(/\.Trashes/.test(msg), 'names what is in the way');
    ok(!/ENOTEMPTY/.test(msg), 'instead of a system error code');
    ok(fs.existsSync(path.join(R, 'A001/.Trashes/501/deleted-by-mistake.mov')),
       'and the file somebody may want back is untouched');
  }

  // (c) A file the filter hid still blocks the removal — correctly — and the
  //     message names it instead of leaving the user in front of a folder that
  //     looks empty.
  {
    const { R, L } = scratch();
    write(R, 'A001/clip.mov', 'x');
    write(R, 'A001/notes.bak', 'excluded');
    const { run } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'permanent' },
      compare: { excludeFilter: '*.bak' },
    }));
    eq(run.errors.length, 1, 'one error for the folder');
    ok(/"notes\.bak"/.test(run.errors[0].message), 'and it names the file that is in the way');
    ok(fs.existsSync(path.join(R, 'A001/notes.bak')), 'which is still there, as it should be');
  }

  // (d) A symbolic link is excluded from the comparison by default, so it too
  //     could only show up as ENOTEMPTY.
  {
    const { L, R } = scratch();
    fs.mkdirSync(path.join(R, 'A001'), { recursive: true });
    try { fs.symlinkSync('/tmp', path.join(R, 'A001', 'shortcut')); }
    catch (_) { return; }                       // no symlinks on this filesystem
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    eq(run.errors.length, 1, 'the folder holding a link is refused');
    ok(/"shortcut"/.test(run.errors[0].message), 'and the link is named');
  }
}

// ══ 26. The build scripts' Apple command lines (0.5.6) ════════════════════
// A static check, and the reason it exists. A draft of the signing library
// called
//     xcrun notarytool history --keychain-profile X --limit 1
// and `--limit` is not an option of `history`. notarytool rejected the command
// line before it ever reached Apple, the output was thrown away, and the build
// came out "signed but not notarized" whatever the credentials were.
//
// It got past a round of testing because those tests used a fake `xcrun` that
// answered on the subcommand alone and never looked at the flags — so they
// tested the stub, not the command. Reading the real command lines out of the
// scripts and checking them against notarytool's documented options is the
// check that catches it, and it needs no Mac to run.
//
// Options per subcommand, from notarytool(1).
function testAppleCommandLines() {
  console.log('\n\n26. Apple command lines in the build scripts (0.5.6)');

  const AUTH = ['--apple-id', '--password', '--team-id', '--key', '--key-id',
                '--issuer', '--keychain-profile', '--keychain', '-p', '-k', '-d'];
  const COMMON = ['--output-format', '--verbose', '-v'];
  const NOTARYTOOL = {
    'submit'           : [...AUTH, ...COMMON, '--wait', '--timeout', '--webhook',
                          '--no-progress', '--no-s3-acceleration'],
    // Authentication only. No --limit. No --page.
    'history'          : [...AUTH, ...COMMON],
    'info'             : [...AUTH, ...COMMON],
    'log'              : [...AUTH, ...COMMON],
    'store-credentials': ['--apple-id', '--password', '--team-id', '--key',
                          '--key-id', '--issuer', '--keychain', '--validate',
                          ...COMMON],
  };
  const STAPLER = ['staple', 'validate'];

  const files = ['scripts/notarize-lib.sh', 'scripts/build-mac.sh', 'build.sh'];
  let calls = 0;

  for (const rel of files) {
    const file = path.join(__dirname, '..', rel);
    if (!fs.existsSync(file)) continue;
    // Join backslash-continued lines so a wrapped command is read whole.
    const text = fs.readFileSync(file, 'utf8').replace(/\\\n\s*/g, ' ');

    for (const line of text.split('\n')) {
      // Skip comments — this file explains the bug in prose, and the prose
      // mentions the flag that must never appear in a command.
      if (/^\s*#/.test(line)) continue;

      let m = /xcrun\s+notarytool\s+([a-z-]+)([^\n;|&]*)/.exec(line);
      if (m) {
        calls++;
        const sub = m[1];
        const allowed = NOTARYTOOL[sub];
        ok(allowed, `notarytool "${sub}" is a real subcommand (${rel})`);
        for (const flag of (m[2].match(/(^|\s)(--?[a-z][a-z0-9-]*)/g) || [])) {
          const f = flag.trim();
          ok(allowed && allowed.includes(f),
             `notarytool ${sub} accepts ${f} (${rel})`);
        }
      }

      m = /xcrun\s+stapler\s+([a-z-]+)/.exec(line);
      if (m) {
        calls++;
        ok(STAPLER.includes(m[1]), `stapler "${m[1]}" is a real subcommand (${rel})`);
      }
    }
  }

  ok(calls >= 4, `the build scripts really do call Apple's tools (${calls} calls checked)`);

  // The specific line that was wrong, pinned so it cannot come back.
  const lib = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'notarize-lib.sh'), 'utf8');
  const commands = lib.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  ok(!/notarytool\s+history[^\n]*--limit/.test(commands),
     'notarytool history is never given --limit again');
  ok(/store_notary_credentials[^\n]*&&\s*notary_profile_ready/.test(commands) === false,
     'a successful store-credentials is not second-guessed by another check');
}

// ══ 27. Comparison progress, and Reveal (0.5.7) ═══════════════════════════
async function testProgressAndReveal() {
  console.log('\n\n27. Comparison progress and Reveal (0.5.7)');

  // (a) A multi-pair comparison used to report each pair's own counter, which
  //     falls back to zero at every pair — the ring emptied and refilled, and
  //     nothing on screen said how far along the whole thing was. The window
  //     now gets a running total that never goes down.
  {
    const { L, R } = scratch();
    const L2 = path.join(path.dirname(L), 'L2'), R2 = path.join(path.dirname(R), 'R2');
    for (const d of [L2, R2]) fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 6; i++) write(L,  `a${i}.mov`, 'x');
    for (let i = 0; i < 6; i++) write(L2, `b${i}.mov`, 'y');

    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }, { left: L2, right: R2 }];

    const m = new MultiSession();
    const seen = [];
    await m.compare(job, { token: { cancelled: false }, onProgress: p => seen.push(p) });
    await m.close();

    ok(seen.length > 0, 'the comparison reports progress');
    ok(seen.every(p => p.scannedTotal != null), 'every event carries a running total');
    let worst = 0, fell = false;
    for (const p of seen) { if (p.scannedTotal < worst) fell = true; worst = Math.max(worst, p.scannedTotal); }
    ok(!fell, 'the running total never goes backwards, not even between pairs');
    ok(seen.some(p => p.pair === 2), 'the second pair is reported as pair 2');
    ok(seen.every(p => p.pairs === 2), 'and the number of pairs is on every event');
    ok(seen.every(p => p.elapsedMs != null), 'elapsed time is reported, which needs no total to be true');
    const last = seen[seen.length - 1];
    ok(last.scannedTotal >= 12, `the total covers both pairs (${last.scannedTotal})`);
  }

  // (b) The estimate that makes an honest percentage possible: how many items
  //     the pair held at the end of the last run. It has to be read BEFORE the
  //     scan, or it arrives too late to be of any use.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 5; i++) write(L, `c${i}.mov`, 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });

    const first = [];
    const s1 = new Session();
    await s1.compare(job, { token: { cancelled: false }, onProgress: p => first.push(p) });
    ok(first.every(p => !p.expected), 'a first comparison has nothing to estimate against');
    await s1.sync(job, { token: { cancelled: false }, appVersion: 'test' });
    await s1.close();

    const second = [];
    const s2 = new Session();
    await s2.compare(job, { token: { cancelled: false }, onProgress: p => second.push(p) });
    await s2.close();
    ok(second.length && second.every(p => p.expected > 0),
       `the next comparison knows roughly how many items to expect (${second[0] && second[0].expected})`);
  }

  // (c) Reveal: the window sends a row index and a side, and the path comes
  //     back resolved — including the spelling that side really uses.
  {
    const { L, R } = scratch();
    write(L, 'A001/clip.mov', 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });

    const rows = m.rows(0, 50, { showEqual: true });
    const row = rows.rows.find(r => r.rel === 'A001/clip.mov');
    ok(row, 'the file is in the grid');

    const left = m.locate(row.idx, 'left');
    ok(left.ok, 'the source side resolves');
    eq(left.path, path.join(L, 'A001', 'clip.mov'), 'to the real path on disk');
    ok(fs.existsSync(left.path), 'which exists');

    // Not on the destination yet: opening the containing folder beats an error.
    const right = m.locate(row.idx, 'right');
    ok(!right.ok, 'the destination side has nothing to reveal');
    eq(right.fallback, R, 'so the containing folder is offered instead');

    eq(m.locate(999999, 'left').ok, false, 'a stale row index reveals nothing');
    await m.close();
  }

  // (d) A server has no Finder window. Say so, rather than silently doing
  //     nothing or handing a remote path to the operating system.
  {
    const { L, R } = scratch();
    write(L, 'x.mov', 'data');
    const m = new MultiSession();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    await m.compare(job, { token: { cancelled: false } });
    m.sessions[0].right.kind = 'sftp';           // as pool.open tags a server
    const r = m.locate(m.rows(0, 10, {}).rows[0].idx, 'right');
    eq(r.ok, false, 'a remote side is refused');
    ok(/server/i.test(r.error), 'and the message says why');
    await m.close();
  }
}

// ══ Run ════════════════════════════════════════════════════════════════════
// ══ 28. Application bundles, and the copy-the-log button (0.5.9) ═══════════
// A macOS .framework is built on symbolic links: `Resources` points at
// `Versions/Current/Resources`, `Current` points at `A`. syncto recreates
// links as links — but only as long as it BELIEVES the item is a link. On a
// type clash (a link here, a real file or folder there) the comparison files
// the row as a "file" so it can be shown and resolved in the grid, and the
// copy used to take that at face value: it read the link as a file, which is
// EISDIR on a link to a directory, and measured 26 bytes where it wrote a
// megabyte on a link to a file.
async function testBundlesAndCopyLog() {
  console.log('\n\n28. Application bundles and the copy button (0.5.9)');

  // A framework the way macOS really builds one.
  function framework(base, rel, size) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.join(f, 'Versions/A/Resources'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Versions/A/Bin'), Buffer.alloc(size, 7));
    fs.writeFileSync(path.join(f, 'Versions/A/Resources/Info.plist'), 'plist');
    fs.symlinkSync('A', path.join(f, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Bin', path.join(f, 'Bin'));
    fs.symlinkSync('Versions/Current/Resources', path.join(f, 'Resources'));
    return f;
  }
  // The same bundle after a tool that followed the links: the shortcuts have
  // become real files and real folders.
  function flattened(base, rel, size, fillResources) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.join(f, 'Versions/A/Resources'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Versions/A/Bin'), Buffer.alloc(size, 7));
    fs.writeFileSync(path.join(f, 'Versions/A/Resources/Info.plist'), 'plist');
    fs.mkdirSync(path.join(f, 'Versions/Current'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Bin'), Buffer.alloc(size, 7));
    fs.mkdirSync(path.join(f, 'Resources'), { recursive: true });
    if (fillResources) fs.writeFileSync(path.join(f, 'Resources/Info.plist'), 'plist');
    return f;
  }
  function linkTarget(p) {
    try { return fs.readlinkSync(p); } catch (_) { return null; }
  }

  // (a) A clean copy of a bundle, which already worked and must keep working.
  {
    const { L, R } = scratch();
    framework(L, 'App.app/Contents/Frameworks/F.framework', 4096);
    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const { run } = await runPair(job);
    const f = path.join(R, 'App.app/Contents/Frameworks/F.framework');
    eq(run.errors.length, 0, 'a bundle copies to an empty target without an error');
    eq(linkTarget(path.join(f, 'Bin')), 'Versions/Current/Bin', 'the binary stays a link');
    eq(linkTarget(path.join(f, 'Resources')), 'Versions/Current/Resources', 'Resources stays a link');
    eq(linkTarget(path.join(f, 'Versions/Current')), 'A', 'Versions/Current stays a link');
  }

  // (b) The Luminar Neo case: the target already holds a flattened copy, and
  //     the user resolves the clashes in the grid by forcing left → right.
  {
    const { L, R } = scratch();
    framework(L, 'F.framework', 997472);
    flattened(R, 'F.framework', 997472, false);

    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });

    const clashes = s.nodes.filter(n => n.cat === 'conflict').map(n => n.rel).sort();
    eq(clashes, ['F.framework/Bin', 'F.framework/Resources', 'F.framework/Versions/Current'],
       'a link facing a real file or folder is reported as a conflict');
    // What the comparison hands the grid, and what used to be taken literally.
    ok(s.nodes.filter(n => n.cat === 'conflict').every(n => n.type === 'file'),
       'the grid still shows a clash as a single file row');

    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();

    const msgs = run.errors.map(e => e.message).join(' | ');
    ok(!/EISDIR/.test(msgs), 'no EISDIR: a link to a directory is no longer read as a file');
    ok(!/Size mismatch/.test(msgs), 'no size mismatch: the link is not measured against its target');
    eq(run.errors.length, 0, 'the flattened bundle is repaired without an error');
    eq(linkTarget(path.join(R, 'F.framework/Bin')), 'Versions/Current/Bin',
       'the real file is replaced by the link it should have been');
    eq(linkTarget(path.join(R, 'F.framework/Resources')), 'Versions/Current/Resources',
       'the real folder is replaced by the link it should have been');
    eq(linkTarget(path.join(R, 'F.framework/Versions/Current')), 'A',
       'and the version link too');
  }

  // (c) The same, except the folder in the way still holds a real file. It is
  //     NOT wiped: deleting it goes through the ordinary deletion policy, and
  //     that policy refuses a folder with content in it — naming the content.
  {
    const { L, R } = scratch();
    framework(L, 'F.framework', 4096);
    flattened(R, 'F.framework', 4096, true);

    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });
    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();

    const msg = run.errors.map(e => e.message).join(' | ');
    ok(/symbolic link/.test(msg), 'the refusal says a link is facing a real folder');
    ok(/Info\.plist/.test(msg), 'and names what is inside it');
    ok(!/EISDIR/.test(msg), 'and it is not an errno');
    ok(fs.existsSync(path.join(R, 'F.framework/Resources/Info.plist')),
       'nothing inside the folder was destroyed');
    // The other two rows have no content in the way and are repaired anyway.
    eq(linkTarget(path.join(R, 'F.framework/Bin')), 'Versions/Current/Bin',
       'one bad row does not stop the others');
  }

  // (d) A folder facing a file, no symbolic link anywhere: the same clash from
  //     the other side. It must refuse in words, not stream a directory.
  {
    const { L, R } = scratch();
    fs.mkdirSync(path.join(L, 'thing'), { recursive: true });
    write(L, 'thing/inside.txt', 'x');
    write(R, 'thing', 'I am a file');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });
    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();
    const msg = run.errors.map(e => e.message).join(' | ');
    ok(/folder/.test(msg) && !/EISDIR/.test(msg),
       'a folder facing a file is explained, not reported as an errno');
  }

  // (e) The copy button. Nothing here launches Electron — what is checked is
  //     the wiring, which is exactly what silently breaks: a button pointing
  //     at an id that does not exist copies nothing and says nothing.
  {
    const html   = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre    = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main   = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    const buttons = [...html.matchAll(/class="err-copy" data-copy="([^"]+)"/g)].map(m => m[1]);
    eq(buttons.sort(), ['sum-errors-body', 'sum-notes-body', 'vf-bad-body'],
       'every error panel carries a copy button');
    for (const id of buttons) {
      ok(html.includes(`id="${id}"`), `the button for ${id} points at an element that exists`);
      ok(new RegExp(`setCopyBlock\\('${id}'`).test(appjs), `${id} is given something to copy`);
    }
    // The whole chain, end to end: renderer → preload → main → clipboard.
    ok(/API\.copyText\(/.test(appjs), 'the handler calls the exposed API');
    ok(/copyText\s*:.*invoke\('copy-text'/.test(pre), 'preload exposes it on the channel');
    ok(/ipcMain\.handle\('copy-text'/.test(main), 'and main answers on that channel');
    ok(/clipboard\.writeText/.test(main), 'through Electron clipboard');
    // navigator.clipboard is unusable from file:// under this CSP — it is not
    // a secure context — and reaching for it is the obvious wrong move.
    ok(!/navigator\.clipboard/.test(appjs), 'and never through navigator.clipboard');
    // The panels show 60 lines at most; the copy must carry the whole list.
    ok(/setCopyBlock\('sum-errors-body', res\.errors\.map/.test(appjs),
       'the copy takes every error, not the 60 that are displayed');
    // The heading holds the button, so it must not scroll away with the list.
    ok(/\.err-body\{max-height:150px;overflow-y:auto;\}/.test(html),
       'the list scrolls inside the block, not the block itself');
    ok(!/\.err-block\{[^}]*overflow-y:auto/.test(html),
       'so the title and its button stay put');
  }
}

// ══ 29. Pairs that are in sync leave the list ═════════════════════════════
// A multi-pair job emitted one heading per pair unconditionally. A backup that
// is up to date — every pair identical, the ordinary case — therefore produced
// a list of headings with nothing under them, which looks like work and, worse,
// kept the grid from ever being empty: the "nothing to do" message the window
// has for exactly this case could not be reached in a multi-pair job.
async function testInSyncPairs() {
  console.log('\n\n29. Pairs in sync leave the list');

  function pairDirs(n, extraOn) {
    const { dir } = scratch();
    const pairs = [];
    for (let p = 0; p < n; p++) {
      const L = path.join(dir, 'L' + p), R = path.join(dir, 'R' + p);
      for (let i = 0; i < 4; i++) {
        write(L, `clip${i}.mov`, 'x'.repeat(100 + i), 1700000000000);
        write(R, `clip${i}.mov`, 'x'.repeat(100 + i), 1700000000000);
      }
      if (extraOn === p) write(L, 'new/EXTRA.mov', 'yyy');
      pairs.push({ left: L, right: R });
    }
    return pairs;
  }

  // (a) Every pair identical: nothing at all in the list.
  {
    const pairs = pairDirs(3, -1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const view = { showEqual: false, showExcluded: false };
    const r = m.rows(0, 200, view);
    eq(r.total, 0, 'three synchronized pairs put nothing in the list');
    eq(r.pairsShown, 0, 'and no pair claims to be showing something');
    eq(r.pairs, 3, 'while the number of pairs is still reported');
    eq(r.rows.filter(x => x.hdr).length, 0, 'no heading is left behind');
    // The figures the window puts under "All pairs are in sync".
    ok(m.stats.rows > 0, 'the comparison did compare something');
    eq(m.stats.filesToProcess, 0, 'and found nothing to do');
    await m.close();
  }

  // (b) One pair out of three has work: only that one appears, heading included.
  {
    const pairs = pairDirs(3, 1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const r = m.rows(0, 200, { showEqual: false, showExcluded: false });
    eq(r.pairsShown, 1, 'one pair shows something');
    const hdrs = r.rows.filter(x => x.hdr);
    eq(hdrs.length, 1, 'and exactly one heading is drawn');
    eq(hdrs[0].pair, 2, 'the heading is the pair that has work, not the first one');
    ok(r.total > 1, 'its rows are there under it');
    ok(r.rows.filter(x => !x.hdr).every(x => x.rel.startsWith('new')),
       'and nothing from the two synchronized pairs');
    await m.close();
  }

  // (c) "Show identical" is the way back: every pair comes back, headings too.
  {
    const pairs = pairDirs(3, -1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const r = m.rows(0, 200, { showEqual: true, showExcluded: false });
    eq(r.pairsShown, 3, 'ticking "show identical" brings all three back');
    eq(r.rows.filter(x => x.hdr).length, 3, 'with their headings');
    await m.close();
  }

  // (d) A single pair reports the same shape, so the window has one code path.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x', 1700000000000);
    write(R, 'a.mov', 'x', 1700000000000);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    const r = s.rows(0, 200, { showEqual: false, showExcluded: false });
    eq(r.total, 0, 'a single synchronized pair shows nothing');
    eq(r.pairs, 1, 'and reports one pair');
    eq(r.pairsShown, 0, 'showing nothing');
    await s.close();
  }

  // (e) The window's four empty states. Checked statically — what breaks here
  //     is a message that no longer matches the branch that reaches it.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    for (const id of ['ge-ico', 'ge-title', 'ge-sub', 'ge-act']) {
      ok(html.includes(`id="${id}"`), `the empty grid has its ${id}`);
    }
    ok(/All pairs are in sync/.test(appjs), 'the multi-pair wording exists');
    ok(/Everything is in sync/.test(appjs), 'and the single-pair one');
    ok(/pairs already in sync/.test(appjs),
       'pairs that dropped out are counted in the status strip');
    // display:'' would fall back to the stylesheet, which hides the button —
    // the rule sits on #ge-act itself. That mistake makes the way back out of
    // the empty state invisible.
    ok(!/ge-act[\s\S]{0,400}?style\.display = act \? '' :/.test(appjs),
       "the action button is not shown with display:''");
    ok(/#ge-act\{display:none/.test(html), 'and it is hidden by default in CSS');
  }
}

// ══ 30. Closing a job (0.5.11) ════════════════════════════════════════════
// "Close" removes a job from the JOBS list. The thing that must never happen
// is the one a right-click menu invites: deleting the file. The list is a
// convenience; the .syncto file is what the user owns, and it is often the
// only record of which two folders belong together.
function testCloseJob() {
  console.log('\n\n30. Closing a job (0.5.11)');

  const { pushRecent, removeRecent, RECENT_MAX, saveJob, loadJob } =
    require('../src/main/config');

  // (a) The list itself.
  {
    let l = [];
    l = pushRecent(l, 'A', '/jobs/a.syncto');
    l = pushRecent(l, 'B', '/jobs/b.syncto');
    eq(l.map(r => r.name), ['B', 'A'], 'the newest entry comes first');
    l = pushRecent(l, 'A again', '/jobs/a.syncto');
    eq(l.length, 2, 'reopening a job does not duplicate its entry');
    eq(l[0].name, 'A again', 'it moves back to the top under its current name');

    eq(removeRecent(l, '/jobs/a.syncto').map(r => r.name), ['B'], 'closing removes that entry');
    eq(removeRecent(l, '/jobs/nope').length, 2, 'closing an unknown path changes nothing');
    eq(removeRecent(null, '/jobs/a.syncto'), [], 'and an empty list survives it');
    // A malformed entry used to slip through the filter and reach the window,
    // where `r.path` on undefined took the whole list down.
    eq(removeRecent([null, { name: 'x' }, { name: 'B', path: '/b' }], '/a').length, 1,
       'entries with no path are dropped rather than rendered');

    let big = [];
    for (let i = 0; i < RECENT_MAX + 5; i++) big = pushRecent(big, 'J' + i, '/jobs/' + i);
    eq(big.length, RECENT_MAX, 'the list is capped');
    eq(big[0].name, 'J' + (RECENT_MAX + 4), 'and keeps the most recent end');
  }

  // (b) Closing never touches the file. Checked for real, on a real file.
  {
    const { dir } = scratch();
    const file = path.join(dir, 'MONTAGE.syncto');
    const j = defaultJob();
    j.name = 'MONTAGE';
    j.pairs = [{ left: path.join(dir, 'L'), right: path.join(dir, 'R') }];
    saveJob(file, j);

    let list = pushRecent([], 'MONTAGE', file);
    list = removeRecent(list, file);
    eq(list.length, 0, 'the entry is gone from the list');
    ok(fs.existsSync(file), 'and the job file is still there');
    const back = loadJob(file);
    eq(back.pairs.length, 1, 'still readable, with its pairs intact');
  }

  // (c) The wiring, end to end: button → renderer → preload → main.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    ok(/id="job-close-btn"/.test(html), 'the CLOSE button is in the markup');
    ok(/repeat\(5,\s*1fr\)/.test(html), 'and the row is laid out for five buttons');
    ok(/job-close-btn'\)\.addEventListener\('click'/.test(appjs), 'it is wired');
    ok(/openJobCtx/.test(appjs) && /closest\('\.recent-item'\)/.test(appjs),
       'a right-click on a job in the list opens a menu');
    ok(/data-k="close"/.test(appjs), 'that menu offers Close');
    ok(/jobClose\s*:.*invoke\('job-close'/.test(pre), 'preload exposes the channel');
    ok(/ipcMain\.handle\('job-close'/.test(main), 'and main answers on it');
    ok(/lastJobPath = ''/.test(main),
       'closing the open job clears lastJobPath, so the next launch does not reopen it');

    // The handler must not delete anything. Read the handler's own body.
    const body = main.slice(main.indexOf("ipcMain.handle('job-close'"));
    const handler = body.slice(0, body.indexOf('});') + 3);
    ok(!/unlink|rmSync|rmdir|trash/i.test(handler), 'and it deletes nothing on disk');

    // ⌘W already belongs to role:'close' and to the Window menu. Two menu
    // items claiming one key is a coin toss.
    const menuLine = (main.match(/\{ label: 'Close job'.*\}/) || [''])[0];
    ok(!/accelerator/.test(menuLine), 'the Close job menu entry claims no accelerator');
    ok(/label: 'Close job'/.test(main), 'but it is in the File menu');
  }
}

// ══ 31. A base folder with a history that is gone (0.6.0) ═════════════════
// Reported on 0.5.11: a destination folder was renamed on the drive, and the
// next comparison proposed to copy all of it again — into the old name, beside
// the copy that already held it. Nothing refused, because the existing guard
// only fires when the OTHER side would lose files, and here nothing was going
// to be deleted. syncto does not go looking for the folder: it says the row is
// wrong, in words and in red, and the person fixes it.
async function testMissingRootWithHistory() {
  console.log('\n\n31. A base folder with a history that is gone (0.6.0)');

  const { readSideSession } = require('../src/main/core/db');
  const { NativeFs } = require('../src/main/fs/native');
  const nfs = new NativeFs();

  // A pair that has really run, so both .syncto.db files are real.
  async function synced(nFiles) {
    const { dir } = scratch();
    const L = path.join(dir, 'SOURCE'), R = path.join(dir, 'G', 'MagicCam_OLD');
    for (let i = 0; i < nFiles; i++) write(L, `A00${i % 2}/CLIP_${i}.mov`, 'x'.repeat(500 + i));
    fs.mkdirSync(path.join(dir, 'G'), { recursive: true });
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    await s.sync(job, { token: {}, appVersion: 'test' });
    const pairId = s.pairId;
    await s.close();
    return { dir, L, R, pairId, job: () => makeJob(L, R, { sync: { variant: 'mirror' } }) };
  }

  // (a) What the surviving side remembers is the whole basis for the refusal.
  {
    const c = await synced(6);
    ok(fs.existsSync(path.join(c.R, '.syncto.db')), 'the run left a database in the destination');
    const sess = await readSideSession(nfs, c.L, c.pairId);
    ok(!!sess, 'the source still holds this pair session');
    ok(sess.items && Object.keys(sess.items).length > 0, 'with the items it last agreed on');
    eq(await readSideSession(nfs, c.L, 'auto-somethingelse'), null,
       'and nothing for a pair id nobody stored');
    eq(await readSideSession(nfs, path.join(c.dir, 'nope'), c.pairId), null,
       'an unreadable folder answers null rather than throwing');
  }

  // (b) The reported case: renamed on the drive, job untouched.
  {
    const c = await synced(8);
    fs.renameSync(c.R, path.join(path.dirname(c.R), 'MagicCam_JUSTEDIT'));

    const s = new Session();
    const res = await s.compare(c.job(), { token: {} });
    ok(res.stats.createRight > 0, 'the comparison still plans the copy — the path really is gone');

    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'but the synchronization refuses');
    const msg = (warn[0] || {}).message || '';
    ok(/was synchronized on/.test(msg), 'saying the folder had a history');
    ok(/would duplicate it/.test(msg), 'and what copying again would cost');
    ok(/point that row at the right folder/.test(msg), 'and who has to fix it');
    // Deliberately NOT a search of the drive for a lookalike.
    ok(!/MagicCam_JUSTEDIT/.test(msg), 'syncto does not go hunting for a replacement');
    await s.close();

    // Pointing the job at the new name is all it takes.
    const s2 = new Session();
    const NEW = path.join(path.dirname(c.R), 'MagicCam_JUSTEDIT');
    const r2 = await s2.compare(makeJob(c.L, NEW, { sync: { variant: 'mirror' } }), { token: {} });
    eq(r2.stats.filesToProcess, 0, 'and then there is nothing left to copy');
    eq((await s2.preflight(makeJob(c.L, NEW, { sync: { variant: 'mirror' } }), {})).length, 0,
       'and nothing left to refuse');
    await s2.close();
  }

  // (c) Deleted outright rather than renamed: same refusal, same advice.
  {
    const c = await synced(4);
    fs.rmSync(c.R, { recursive: true, force: true });
    const s = new Session();
    await s.compare(c.job(), { token: {} });
    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'a folder that had a history and is gone still refuses');
    ok(/Reconnect the drive/.test((warn[0] || {}).message || ''), 'with the advice that fits');
    await s.close();
  }

  // (d) THE REGRESSION THAT WOULD HURT: a first run into a destination that has
  //     never existed must stay completely silent. Every job starts here.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x');
    const target = path.join(R, 'NEW_TARGET');
    const job = () => makeJob(L, target, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job(), { token: {} });
    eq((await s.preflight(job(), {})).length, 0, 'a brand-new destination does not refuse to run');
    await s.close();
  }

  // (e) The older guard still comes first: a missing SOURCE would empty the
  //     destination, and that message names the deletions.
  {
    const c = await synced(5);
    fs.rmSync(c.L, { recursive: true, force: true });
    const s = new Session();
    await s.compare(c.job(), { token: {} });
    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'a missing source still refuses');
    ok(/would delete/.test((warn[0] || {}).message || ''), 'and still leads with the deletions');
    await s.close();
  }
}

// ══ 32. Opening a job whose folders moved (0.6.1) ═════════════════════════
// 0.6.0 caught this after a comparison. Opening the job is earlier and cheaper:
// the stale path can be fixed before anything is planned against it. What the
// window gets is one entry per native folder the job names that is not there.
async function testCheckJobPaths() {
  console.log('\n\n32. Opening a job whose folders moved (0.6.1)');

  const { checkJobPaths } = require('../src/main/core/session');

  // (a) Which rows are reported, and which are deliberately not.
  {
    const { dir } = scratch();
    const A = path.join(dir, 'A'), B = path.join(dir, 'B');
    fs.mkdirSync(A, { recursive: true });
    fs.mkdirSync(B, { recursive: true });
    const GONE = path.join(dir, 'NOT_THERE');

    const job = {
      pairs: [
        { left: A, right: B },                 // both there
        { left: A, right: GONE },              // the one to report
        { left: 'sftp://nas/share', right: A },// a server side is not stat'ed
        { left: A, right: '' },                // an unfinished row is not a problem
      ],
    };
    const out = await checkJobPaths(job);
    eq(out.length, 1, 'only the folder that is really missing is reported');
    eq(out[0].pairIndex, 1, 'with the row the window has to write into');
    eq(out[0].pair, 2, 'numbered for the user');
    eq(out[0].side, 'right', 'and the side');
    eq(out[0].path, GONE, 'and the path that does not resolve');
    eq(out[0].hadHistory, false, 'these two folders were never synchronized');
  }

  // (b) A folder that was renamed after a real run: the suggestion is filled in
  //     from the .syncto.db the folder took with it.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'SOURCE'), R = path.join(dir, 'G', 'MagicCam_OLD');
    for (let i = 0; i < 5; i++) write(L, `CLIP_${i}.mov`, 'x'.repeat(300 + i));
    fs.mkdirSync(path.join(dir, 'G'), { recursive: true });
    for (const n of ['LUTS', '_TEMP']) fs.mkdirSync(path.join(dir, 'G', n), { recursive: true });
    const s = new Session();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await s.compare(job, { token: {} });
    await s.sync(job, { token: {}, appVersion: 'test' });
    await s.close();

    const NEW = path.join(dir, 'G', 'MagicCam_JUSTEDIT');
    fs.renameSync(R, NEW);

    const out = await checkJobPaths({ pairs: [{ left: L, right: R }] });
    eq(out.length, 1, 'the renamed destination is reported');
    eq(out[0].hadHistory, true, 'the surviving side remembers this pair');
    ok(out[0].items > 0, 'and how many items it held');
    eq(out[0].candidate, undefined, 'syncto does not go looking for a replacement');
    eq(out[0].label, '', 'a single-pair job needs no "Pair 1" label');
  }

  // (c) The same job once the path is fixed: silence.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'L'), R = path.join(dir, 'R');
    fs.mkdirSync(L, { recursive: true }); fs.mkdirSync(R, { recursive: true });
    eq((await checkJobPaths({ pairs: [{ left: L, right: R }] })).length, 0,
       'a job whose folders are all there reports nothing');
    eq((await checkJobPaths({ left: L, right: R })).length, 0,
       'including a job written before multi-pair');
  }

  // (d) A file where a folder should be is missing as far as a job is
  //     concerned — syncing into it would fail on the first write.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'L');
    fs.mkdirSync(L, { recursive: true });
    const F = path.join(dir, 'a-file.txt');
    fs.writeFileSync(F, 'not a folder');
    const out = await checkJobPaths({ pairs: [{ left: L, right: F }] });
    eq(out.length, 1, 'a file standing where a folder is expected is reported');
  }

  // (e) The wiring: the check runs when a job is OPENED, and only marks at
  //     launch. A dialog in the face at every start, because a NAS is not
  //     mounted yet, is how a warning stops being read.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    ok(/ipcMain\.handle\('check-job-paths'/.test(main), 'main answers on the channel');
    ok(/checkJobPaths\s*:.*invoke\('check-job-paths'/.test(pre), 'preload exposes it');
    eq((appjs.match(/await offerRelinkForJob\(\);/g) || []).length, 2,
       'both ways of opening a job check its folders');
    ok(/offerRelinkForJob\(true\);/.test(appjs), 'and the launch only marks');
    ok(html.includes('id="missing-badge"'), 'the mark is a button in the status strip');
    ok(/missing-badge'\)\.addEventListener\('click', \(\) => offerRelinkForJob\(false\)\)/.test(appjs),
       'clicking it opens the dialog');

    // (f) The red on the row. This is what is still on screen an hour after the
    //     dialog was closed, and the path is where the problem actually is.
    ok(/\.prow input\.gone\{border-color:rgba\(242,85,90/.test(html),
       'a row whose folder is missing is drawn in red');
    ok(/function markMissingPaths\(list\)/.test(appjs), 'and something marks it');
    ok(/markMissingPaths\(state\.missingPaths\);/.test(appjs),
       'rebuilding the pair rows puts the red back');
    ok(/recheckPathsSoon\(\);/.test(appjs), 'editing a path re-checks it');
    ok(/state\.missingPaths = list \|\| \[\];/.test(appjs),
       'the red covers every missing folder, dismissed or not');
    ok(!/relinkFromCompare|findRenamedBase|rl-btn use/.test(appjs),
       'and nothing is left of the folder-hunting the window used to do');

    // Browse opens where the folder used to be. Without it the picker lands on
    // wherever the user last browsed, which is rarely the right drive.
    ok(/browse-folder', async \(_, title, startIn\)/.test(main), 'browse takes a starting folder');
    ok(/opts\.defaultPath = start;/.test(main), 'and uses it');
    ok(/API\.browseFolder\(`\$\{side\} — \$\{item\.label \|\| 'pair'\}`, item\.path\)/.test(appjs),
       'the dialog passes the missing path as the starting point');
  }
}

// ══ 33. Locks: network tolerance, and leftovers (0.6.2) ═══════════════════
// Two reports, one subject.
//
// The first: a synchronization between two machines on a network died every
// time with "the lock file has not been refreshed for 15 s — the folder may
// have been taken over". Nobody had taken anything over. An SMB share
// reconnecting takes longer than the twelve seconds the protocol allowed.
//
// The second: lock files left behind by runs that never finished. The protocol
// clears an abandoned lock, but only when somebody asks for that folder again —
// and if nobody does, the file sits there.
async function testLockTolerance() {
  console.log('\n\n33. Locks: network tolerance and leftovers (0.6.2)');

  const {
    checkStillOurs, findLeftoverLocks, clearStaleLock, isCorpseName,
    acquireOne, localLockInfo, DETECT_ABANDONED_MS, EMIT_LIFE_SIGN_MS, LOCK_NAME,
  } = require('../src/main/core/lock');
  const { NativeFs } = require('../src/main/fs/native');
  const nfs = new NativeFs();

  // (a) The window. A number that is right for two processes on one machine is
  //     wrong for two machines on a network.
  {
    ok(DETECT_ABANDONED_MS >= 60000,
       'a folder is given up only after a full minute of silence');
    ok(DETECT_ABANDONED_MS > 15000,
       'and 15 s of network trouble — the case reported — is ridden out');
    ok(DETECT_ABANDONED_MS > EMIT_LIFE_SIGN_MS * 4,
       'which is several heartbeats, not one missed beat');
  }

  // (b) THE BUG. A read that fails proves nothing, and was being read as "the
  //     lock file disappeared" — one unreadable instant ended the run.
  {
    const { dir } = scratch();
    const p = path.join(dir, LOCK_NAME);
    const mine = localLockInfo();
    fs.writeFileSync(p, JSON.stringify(mine) + '\n');

    eq(await checkStillOurs(nfs, p, mine.lockId), 'ours', 'our own lock reads as ours');
    eq(await checkStillOurs(nfs, p, 'someone-elses-id'), 'taken',
       'a lock carrying another id reads as taken');
    eq(await checkStillOurs(nfs, path.join(dir, 'no-such-lock'), mine.lockId), 'gone',
       'a file that is really absent reads as gone');

    // A share that does not answer: stat throws rather than returning null.
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      stat: async () => { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; },
    });
    eq(await checkStillOurs(flaky, p, mine.lockId), 'unknown',
       'a share that does not answer is unknown, NOT gone');

    // There, but unreadable this instant: the old code called this "gone".
    const unreadable = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      createReadStream: () => { throw new Error('EIO'); },
    });
    eq(await checkStillOurs(unreadable, p, mine.lockId), 'unknown',
       'a lock that cannot be read this instant is unknown, NOT gone');
  }

  // (c) A held lock rides out a share that stops answering, and still gives up
  //     the instant somebody really takes it.
  {
    const { dir } = scratch();
    let failing = false;
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      stat: async (...a) => {
        if (failing) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
        return NativeFs.prototype.stat.apply(nfs, a);
      },
      appendByte: async (...a) => {
        if (failing) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
        return NativeFs.prototype.appendByte.apply(nfs, a);
      },
    });

    // Same logic, played at speed: 200 ms beats and a 2 s window instead of
    // 5 s and a minute. The real numbers are asserted in (a).
    const FAST = { beatMs: 200, detectMs: 2000 };
    let lostReason = null;
    const lock = await acquireOne(flaky, dir, { onLost: r => { lostReason = r; }, timing: FAST });
    ok(!!lock, 'the lock is taken');

    // Three heartbeats' worth of a share that answers nothing.
    failing = true;
    await new Promise(r => setTimeout(r, FAST.beatMs * 4));
    eq(lostReason, null, 'several beats of silence do not end the run');
    ok(lock.hiccups >= 1, 'but it is counted, for the run summary');
    failing = false;
    await new Promise(r => setTimeout(r, FAST.beatMs * 3));
    eq(lostReason, null, 'and the run carries on once the share comes back');
    ok(lock.worstGapMs >= FAST.beatMs, 'the longest gap is remembered');

    // The exact shape of the reported failure: the share answers a stat but
    // the read comes back empty. That used to read as "the lock file
    // disappeared" and ended the run on the spot.
    let readBroken = false;
    const halfDead = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      createReadStream: (...a) => {
        if (readBroken) throw new Error('EIO');
        return NativeFs.prototype.createReadStream.apply(nfs, a);
      },
    });
    let lost2 = null;
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const lock2 = await acquireOne(halfDead, sub, { onLost: r => { lost2 = r; }, timing: FAST });
    readBroken = true;
    await new Promise(r => setTimeout(r, FAST.beatMs * 4));
    eq(lost2, null, 'a share whose reads fail does not end the run either');
    readBroken = false;
    await lock2.release();

    // Now somebody really takes the folder: that IS proof, and it stops at once.
    fs.writeFileSync(path.join(dir, LOCK_NAME),
      JSON.stringify(Object.assign(localLockInfo(), { computerName: 'OTHER-MAC' })) + '\n');
    await new Promise(r => setTimeout(r, FAST.beatMs * 3));
    ok(!!lostReason, 'a genuine takeover still ends the run immediately');
    ok(/taken over/.test(lostReason || ''), 'and says who took it');
    await lock.release();
  }

  // (d) Finding what a dead run left behind. The comparison already lists the
  //     root of every base folder, so this reads no extra bytes.
  {
    const join = (d, n) => path.join(d, n);
    const now = 1_700_000_000_000;
    const entries = [
      { name: LOCK_NAME,                    mtime: now - 90_000 },
      { name: `Delete.0.${LOCK_NAME}`,      mtime: now - 90_000 },
      { name: `Delete.3.${LOCK_NAME}`,      mtime: now - 1_000  },
      { name: '.syncto.db',                 mtime: now },
      { name: 'CLIP_0001.mov',              mtime: now },
      { name: 'Delete.0.something-else.txt',mtime: now - 90_000 },
    ];
    const found = findLeftoverLocks(entries, '/vol/BACKUP', join, now);
    eq(found.map(f => f.name).sort(),
       [`Delete.0.${LOCK_NAME}`, `Delete.3.${LOCK_NAME}`, LOCK_NAME].sort(),
       'the lock and its corpses are found, and nothing else');
    eq(found.filter(f => f.stale).length, 2,
       'the one touched a second ago is not called stale');
    eq(found.find(f => f.name === LOCK_NAME).kind, 'lock', 'a lock is a lock');
    eq(found.find(f => f.name === `Delete.0.${LOCK_NAME}`).kind, 'corpse',
       'and a renamed one is a corpse');
    ok(isCorpseName(`Delete.7.${LOCK_NAME}`), 'corpse names are recognised');
    ok(!isCorpseName('Delete.0.holiday.mov'), 'and a user file called Delete.0 is not one');
    eq(findLeftoverLocks(null, '/x', join, now), [], 'an empty listing finds nothing');
  }

  // (e) Clearing one. A lock that is being fed is left exactly where it is —
  //     an mtime that merely looks old is not a licence to delete.
  {
    const { dir } = scratch();
    const lockPath = path.join(dir, LOCK_NAME);
    const old = Date.now() - DETECT_ABANDONED_MS - 60_000;

    // A corpse: already declared abandoned by whoever renamed it.
    const corpse = path.join(dir, `Delete.0.${LOCK_NAME}`);
    fs.writeFileSync(corpse, 'x');
    fs.utimesSync(corpse, new Date(old), new Date(old));
    eq(await clearStaleLock(nfs, { path: corpse, kind: 'corpse' }, {}), 'removed',
       'an old corpse is removed');
    ok(!fs.existsSync(corpse), 'and it really is gone');

    const fresh = path.join(dir, `Delete.1.${LOCK_NAME}`);
    fs.writeFileSync(fresh, 'x');
    eq(await clearStaleLock(nfs, { path: fresh, kind: 'corpse' }, {}), 'alive',
       'a corpse from this very second is left alone — a takeover is in flight');
    ok(fs.existsSync(fresh), 'so the file is still there');

    // A lock from a process on this machine that no longer exists.
    const dead = Object.assign(localLockInfo(), { processId: 999_999, sessionId: 999_998 });
    fs.writeFileSync(lockPath, JSON.stringify(dead) + '\n');
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'removed',
       'a lock left by a dead process on this machine is removed');
    ok(!fs.existsSync(lockPath), 'and the folder is free again');

    // A lock this very process holds is not a leftover.
    const live = await acquireOne(nfs, dir, {});
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'alive',
       'a lock that is genuinely held is never removed');
    ok(fs.existsSync(lockPath), 'it is still there');
    await live.release();
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'gone',
       'and once released there is nothing left to clear');
  }

  // (f) A comparison reports them, and reports nothing when there is nothing.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x');
    const clean = new Session();
    const r0 = await clean.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    eq(r0.staleLocks.length, 0, 'a healthy folder reports no leftover lock');
    await clean.close();

    const old = Date.now() - DETECT_ABANDONED_MS - 60_000;
    for (const base of [L, R]) {
      const p = path.join(base, LOCK_NAME);
      fs.writeFileSync(p, JSON.stringify(localLockInfo()) + '\n');
      fs.utimesSync(p, new Date(old), new Date(old));
    }
    const s = new Session();
    const res = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    eq(res.staleLocks.length, 2, 'a leftover lock on each side is reported');
    eq(res.staleLocks.filter(l => l.kind === 'lock').length, 2, 'as locks');
    ok(res.staleLocks.every(l => l.folder && l.path), 'each naming its folder and file');
    // And it stays invisible to the plan: reported, never synchronized.
    eq(res.stats.filesToProcess, 1, 'the lock files are not copied anywhere');
    await s.close();
  }

  // (f2) The wrapper the window actually calls. Tested separately from
  //      clearStaleLock because it is where the plumbing lives — it opens the
  //      folder through the pool, and a folder is a LOCATION there, not a
  //      string. Getting that wrong reported "could not be removed" on every
  //      file while they all sat there untouched.
  {
    const { clearStaleLocks } = require('../src/main/core/session');
    const { dir } = scratch();
    const lockPath = path.join(dir, LOCK_NAME);
    const corpse   = path.join(dir, `Delete.0.${LOCK_NAME}`);
    const old = Date.now() - DETECT_ABANDONED_MS - 90_000;
    for (const f of [lockPath, corpse]) {
      fs.writeFileSync(f, JSON.stringify(localLockInfo()) + '\n');
      fs.utimesSync(f, new Date(old), new Date(old));
    }
    const res = await clearStaleLocks({}, [
      { folder: dir, name: LOCK_NAME, path: lockPath, kind: 'lock' },
      { folder: dir, name: `Delete.0.${LOCK_NAME}`, path: corpse, kind: 'corpse' },
    ], {});
    eq(res.length, 2, 'every item comes back with a verdict');
    ok(res.every(r => r.status !== 'failed'), 'and none of them failed');
    ok(res.every(r => !r.error), 'with no error carried back');
    eq(fs.readdirSync(dir).filter(n => n.includes('.syncto.lock')), [],
       'the folder really is clean afterwards');
  }

  // (g) The window's side: reported, and cleared only on purpose.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    ok(html.includes('id="lock-badge"'), 'the status strip can say so');
    ok(/noteStaleLocks\(res\.staleLocks \|\| \[\]\)/.test(appjs), 'a comparison fills it');
    ok(/lock-badge'\)\.addEventListener\('click', clearStaleLocksNow\)/.test(appjs),
       'and clearing is a click, never automatic');
    ok(/clearLocks\s*:.*invoke\('clear-locks'/.test(pre), 'preload exposes the channel');
    ok(/ipcMain\.handle\('clear-locks'/.test(main), 'and main answers on it');
    // Nothing in the comparison path may delete a lock on the way past.
    const cmp = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/compare.js'), 'utf8');
    ok(!/unlink[\s\S]{0,80}LOCK_NAME/.test(cmp), 'the comparison never removes one itself');
  }
}

(async function main() {
  console.log('syncto engine tests');
  console.log('scratch: ' + ROOT);
  try {
    testFilter();
    await testCompare();
    await testMirror();
    await testUpdate();
    await testTwoWay();
    await testSecure();
    await testVersioning();
    await testFailSafe();
    await testOverrides();
    await testFolderRules();
    await testMoves();
    await testMovesTwoWayAndOff();
    await testMultiPair();
    await testLocking();
    await testReviewRegressions();
    await testAuditFixes();
    await testOverviewAndShowEqual();
    testServers();
    await testNasRegression();
    await testAfterAndNtfy();
    testNtfySecrets();
    await testSingleCopyMode();
    await testAudit051();
    await testAudit051Engine();
    await testOsFolderLitter();
    testAppleCommandLines();
    await testProgressAndReveal();
    await testBundlesAndCopyLog();
    await testInSyncPairs();
    testCloseJob();
    await testMissingRootWithHistory();
    await testCheckJobPaths();
    await testLockTolerance();
  } catch (err) {
    failed++;
    failures.push('UNCAUGHT: ' + (err.stack || err.message));
  }

  console.log('\n');
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (!process.env.KEEP_SCRATCH) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
