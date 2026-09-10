#!/usr/bin/env node
// Four ways a file NAME could destroy footage, found in the 2.6.3 review and
// all four reproduced against the real engine before being fixed.
//
// The common shape: two parts of the engine looked at the same folder and
// disagreed about what was in it, because one of them decided by a name
// pattern instead of by what the thing actually is.
//
//   node scripts/test-name-guards.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-names-'));
const fresh = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) {
  const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };
const listAll = (root) => {
  const out = [];
  (function walk(d, pre) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel); else out.push(rel);
    }
  })(root, '');
  return out.sort();
};

// ── Electron stub, then the REAL main.js and its REAL ipc handlers ──────────
const handlers = {};
const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false };
const userData = fresh('userData');
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true,
         quit: () => {}, getVersion: () => '2.6.4', getPath: () => userData, getName: () => 'ingesto',
         isPackaged: false, setAboutPanelOptions: () => {} },
  BrowserWindow: class { static getAllWindows() { return []; } },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } },
  dialog: {}, screen: {},
  shell: { openPath: async () => {}, showItemInFolder: () => {}, openExternal: async () => {} },
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return electron; return realLoad.call(this, req, ...rest); };
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
const call = (ch, ...args) => handlers[ch]({ sender: fakeWin.webContents }, ...args);

const opts = (extra) => ({ mode: 'fast', folderTemplate: '{counter}_{cardname}',
                           writeSentinel: true, writeChecksum: true,
                           cksumList: true, cksumMhl: false, ascMhl: false, ...extra });
const run = (card, dst, o, src) => call('start-copy', {
  sources: [Object.assign({ name: 'A001', path: card, counter: '001',
                            cameraman: 'noar', camera: 'FX6' }, src || {})],
  destinations: [{ name: 'D', path: dst }],
  options: opts(o) });

(async () => {

console.log('\na folder named "._x" is content, not litter');
{
  // The guard that refuses to write into an occupied card folder skipped every
  // entry whose name began with "._" BEFORE asking whether it was a directory.
  // The card scanner has no such blind spot (isAppleDouble tests isFile), so it
  // copies "._private/" as ordinary footage. A card folder holding only that
  // therefore read as empty, and the next card was written straight over it.
  const day = fresh('d-apple');
  const c1 = fresh('c-apple-1'), c2 = fresh('c-apple-2');
  mk(c1, { '._private/CLIP.MOV': 'MORNING footage' });
  mk(c2, { '._private/CLIP.MOV': 'AFTERNOON footage' });

  const r1 = (await run(c1, day, {}, { name: 'NO NAME' }))[0];
  ok(r1.success === true, 'the first card lands');
  const leaf = r1.destPath;
  ok(fs.existsSync(path.join(leaf, '._private/CLIP.MOV')), 'and its footage is under ._private/');

  const r2 = (await run(c2, day, {}, { name: 'NO NAME' }))[0];
  ok(r2.success === false && r2.refused === true,
     'the second card into the same folder is REFUSED, not let in');
  ok(r2.refusalCode === 'PF-E9', 'as "that folder already exists and holds files" (' + r2.refusalCode + ')');
  ok(fs.readFileSync(path.join(leaf, '._private/CLIP.MOV'), 'utf8') === 'MORNING footage',
     'and the first card\'s footage is untouched');
}

console.log('\nOS litter really is litter: a folder holding only that is still empty');
{
  const day = fresh('d-litter');
  const c1 = fresh('c-litter-1'), c2 = fresh('c-litter-2');
  mk(c1, { 'CLIP.MOV': 'x' });
  mk(c2, { 'CLIP2.MOV': 'y' });
  const r1 = (await run(c1, day, {}, { name: 'CARD' }))[0];
  const leaf = r1.destPath;
  // Delete the delivered file and leave only what an OS drops on a volume.
  for (const f of fs.readdirSync(leaf)) fs.rmSync(path.join(leaf, f), { recursive: true, force: true });
  mk(leaf, { '.DS_Store': 'x', '._CLIP.MOV': 'x', '.Spotlight-V100/store.db': 'x',
             'System Volume Information/WPSettings.dat': 'x' });
  const r2 = (await run(c2, day, {}, { name: 'CARD' }))[0];
  ok(r2.refused !== true, 'a folder holding only OS litter does not refuse the next card');
  ok(r2.success === true, 'and the card is copied');
}

console.log('\na card carrying both "X.MOV" and "X.MOV.ingesto-part"');
{
  // The temp name of one file is the final name of the other. Either order
  // destroys one of them: the temp open truncates the delivered file, or the
  // post-copy sweep deletes it because the run registered that exact path as
  // its own temp. In FAST the run still said "2 copied".
  // Happens for real when a folder left by an interrupted ingest is re-ingested.
  for (const mode of ['fast', 'normal', 'slow']) {
    const card = fresh('c-twin-' + mode), dst = fresh('d-twin-' + mode);
    mk(card, { 'X.MOV': 'the real clip', 'X.MOV.ingesto-part': 'the interrupted one' });
    const r = (await run(card, dst, { mode }))[0];
    ok(r.refused === true && r.refusalCode === 'PF-E10',
       `${mode}: refused before anything is written (${r.refusalCode})`);
    ok(!fs.existsSync(r.destPath) || listAll(r.destPath).length === 0,
       `${mode}: and the destination folder is untouched`);
  }
  // The same for the quarantine suffix.
  const card = fresh('c-twin-f'), dst = fresh('d-twin-f');
  mk(card, { 'Y.MOV': 'a', 'Y.MOV.ingesto-failed': 'b' });
  const r = (await run(card, dst, {}))[0];
  ok(r.refused === true && r.refusalCode === 'PF-E10', '.ingesto-failed twins are refused too');
  ok(/collides with the temporary name/.test((r.errorList[0] || {}).error || ''),
     'and the reason names the collision');
}

console.log('\na card carrying only ".ingesto-part" files is copied normally');
{
  // The refusal is about the PAIR. A lone file whose name ends that way is
  // just a file, and refusing it would make the folder of an interrupted
  // ingest un-reingestable.
  const card = fresh('c-lone'), dst = fresh('d-lone');
  mk(card, { 'Z.MOV.ingesto-part': 'orphan', 'W.MOV': 'clip' });
  const r = (await run(card, dst, {}))[0];
  ok(r.refused !== true, 'not refused');
  ok(r.success === true && r.copiedFiles === 2, 'both files copied');
  ok(fs.readFileSync(path.join(r.destPath, 'Z.MOV.ingesto-part'), 'utf8') === 'orphan',
     'and it is still on the drive when the run ends');
}

console.log('\na file being SKIPPED is not residue, even when it is named like residue');
{
  // The whole of a card, lost, with a green window. The folder an interrupted
  // ingest left behind was itself ingested as a card, so the delivered copies
  // carry the name "*.ingesto-part". On the next ingest of that card with
  // "copy new files only", the folder reads as residue-only (so the run is
  // allowed in), the skip list is computed while the files are still there,
  // and the pre-copy sweep then deletes exactly the copies the skips were
  // relying on. Nothing is copied, nothing is reported, and the folder is empty.
  const card = fresh('c-skip'), dst = fresh('d-skip');
  mk(card, { 'X.MOV.ingesto-part': 'THE ONLY COPY OF THIS SHOT' });

  // Verified, and with every sidecar switched off, so the folder really does
  // hold nothing but that one file: with a checksum list beside it the folder
  // would read as occupied and the second ingest would simply be refused.
  const r1 = (await run(card, dst, { mode: 'slow', writeChecksum: false,
                                     cksumList: false, cksumMhl: false, ascMhl: false }))[0];
  ok(r1.success === true, 'the first ingest lands');
  const leaf = r1.destPath;
  ok(fs.readdirSync(leaf).length === 1, 'and the folder holds that file and nothing else');
  ok(fs.readFileSync(path.join(leaf, 'X.MOV.ingesto-part'), 'utf8') === 'THE ONLY COPY OF THIS SHOT',
     'and the oddly named file is on the drive');

  // Ten minutes old, so the folder reads as residue an interrupted run left
  // behind rather than as a copy in progress: that is what lets the second
  // ingest in at all.
  { const old = (Date.now() - 10 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(leaf, 'X.MOV.ingesto-part'), old, old); }

  const info = await call('inspect-card', card, false, [dst]);
  ok(info.counts.skippable === 1, 'the second ingest can skip it');

  const r2 = (await call('start-copy', {
    sources: [{ name: 'A001', path: card, counter: '001' }],
    destinations: [{ name: 'D', path: dst }],
    options: Object.assign(opts({ mode: 'slow', writeChecksum: false, cksumList: false,
                                 cksumMhl: false, ascMhl: false }),
                           { skipKeys: info._skippableKeys }) }))[0];

  ok(r2.refused !== true, 'the second ingest is let in (' + (r2.refusalCode || 'not refused') + ')');
  ok(r2.skippedFiles === 1, 'and really skips the file rather than copying it again');
  ok(fs.existsSync(path.join(r2.destPath || leaf, 'X.MOV.ingesto-part')),
     'and after it, the file is STILL THERE');
  ok(fs.readFileSync(path.join(r2.destPath || leaf, 'X.MOV.ingesto-part'), 'utf8')
       === 'THE ONLY COPY OF THIS SHOT', 'with its content untouched');
}

console.log('\nthe shooting note never replaces a file the card carried');
{
  // writeFileAtomic renames onto its target. A card holding "001_note.txt" had
  // that file replaced by the note: silently in FAST, and in SECURE it was the
  // NOTE that got quarantined while the card's file was still missing.
  const card = fresh('c-note'), dst = fresh('d-note');
  mk(card, { '001_note.txt': 'THE CARD OWN FILE', 'A.MOV': 'clip' });
  const r = (await run(card, dst, { mode: 'slow' }, { note: 'Jour 3, plateau B.' }))[0];
  ok(r.success === true && r.errors === 0, 'the run succeeds');
  ok(fs.readFileSync(path.join(r.destPath, '001_note.txt'), 'utf8') === 'THE CARD OWN FILE',
     'the card\'s own file is still its own');
  const alt = fs.readdirSync(r.destPath).find(n => /^001-\d+_note\.txt$/.test(n));
  ok(!!alt, 'the shooting note went to a free name (' + alt + ')');
  ok(fs.readFileSync(path.join(r.destPath, alt || 'nope'), 'utf8').startsWith('ingesto - Shooting Note'),
     'and it is the note');
  // The suffix must sit before "_note.txt": Verify recognises our note by that
  // ending, so "001_note.txt-2" would be reported as a stranger for ever.
  ok(/_note\.txt$/.test(alt || ''), 'and Verify will still recognise it as ours');
  ok((r.notes || []).some(n => n.code === 'CV-10'), 'a remark says what happened');
  // And with no clash the note keeps its plain name.
  const card2 = fresh('c-note2'), dst2 = fresh('d-note2');
  mk(card2, { 'A.MOV': 'clip' });
  const r2 = (await run(card2, dst2, { mode: 'slow' }, { note: 'ok' }))[0];
  ok(fs.existsSync(path.join(r2.destPath, '001_note.txt')), 'normally it is 001_note.txt');
  ok(!(r2.notes || []).some(n => n.code === 'CV-10'), 'with no remark');
}

console.log('\nthe retry deletes the copies IT set aside, and nothing else');
{
  // The retry used to delete "<rel>.ingesto-failed" and every "-2…-N" by name.
  // A card carrying a file called exactly that had it copied, verified, and
  // then deleted as if it were one of our own quarantined copies. PF-E10 above
  // now refuses that card outright, so the pattern deletion is unreachable
  // rather than wrong: these checks lock the contract (delete what you created,
  // and only once its good twin is back), not a live bug.
  const card = fresh('c-qua'), dst = fresh('d-qua');
  mk(card, { 'X.MOV': 'x'.repeat(4096), 'X.MOV.ingesto-failed': 'REAL FOOTAGE FROM THE CARD' });
  // The pair guard refuses X.MOV + X.MOV.ingesto-failed, so use a card where
  // the ".ingesto-failed" file has no twin: it is then ordinary content.
  fs.unlinkSync(path.join(card, 'X.MOV'));
  mk(card, { 'OTHER.MOV': 'o'.repeat(4096) });

  const r1 = (await run(card, dst, { mode: 'slow' }))[0];
  ok(r1.success === true, 'first run copies both files');
  const leaf = r1.destPath;
  ok(fs.existsSync(path.join(leaf, 'X.MOV.ingesto-failed')), 'including the oddly named one');

  // Now a retry that recopies OTHER.MOV. Nothing was quarantined by that run,
  // so nothing may be deleted.
  const r2 = await call('recopy-failed', {
    sourcePath: card, sourceName: 'A001', destPath: leaf, destName: 'D',
    mode: 'slow', files: ['OTHER.MOV'], destRelMap: {}, quarantined: [] });
  ok(!!r2, 'the retry runs');
  ok(fs.readFileSync(path.join(leaf, 'X.MOV.ingesto-failed'), 'utf8') === 'REAL FOOTAGE FROM THE CARD',
     'and the card\'s file called X.MOV.ingesto-failed is STILL THERE');

  // A window can outlive the run that opened it: retried twice, reopened on a
  // second batch, a group rebuilt after a cancel. Its list of set-aside copies
  // is then stale. Deleting one whose good copy did NOT come back in THIS retry
  // would leave the folder holding neither of the two.
  fs.writeFileSync(path.join(leaf, 'STALE.MOV.ingesto-failed'), 'the only copy left');
  const r3 = await call('recopy-failed', {
    sourcePath: card, sourceName: 'A001', destPath: leaf, destName: 'D',
    mode: 'slow', files: ['OTHER.MOV'], destRelMap: {},
    quarantined: [path.join(leaf, 'STALE.MOV.ingesto-failed')] });
  ok(!!r3, 'a retry carrying a stale set-aside path runs');
  ok(fs.existsSync(path.join(leaf, 'STALE.MOV.ingesto-failed')),
     'and does not drop it, because no good copy of STALE.MOV came back');
}

console.log('\na copy that dies half-written leaves no ".ingesto-part" behind');
{
  // The other side of the sweep: what THIS run opened and could not finish is
  // its own to remove. A truncated file left under a temporary name is residue
  // that makes the folder un-reingestable for ever.
  const card = fresh('c-part'), dst = fresh('d-part');
  mk(card, { 'GOOD.MOV': 'g'.repeat(4096), 'LATE.MOV': 'l'.repeat(4096) });
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to, ...rest) {
    if (path.basename(String(to)) === 'LATE.MOV') { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
    return realRename.call(fs, from, to, ...rest);
  };
  let r;
  try { r = (await run(card, dst, { mode: 'fast' }))[0]; } finally { fs.renameSync = realRename; }
  ok(!!r && r.success === false, 'the run reports the failure');
  ok(fs.existsSync(path.join(r.destPath, 'GOOD.MOV')), 'the file that made it is delivered');
  ok(listAll(r.destPath).every(n => !n.endsWith('.ingesto-part')),
     'and nothing is left under a temporary name');
}

console.log('\na real quarantined copy is still cleaned up by the retry');
{
  // The other half of the same rule: what the run really did set aside must go
  // once a good copy is back, or the delivered folder keeps a corrupt twin.
  const card = fresh('c-qua2'), dst = fresh('d-qua2');
  mk(card, { 'BAD.MOV': 'b'.repeat(4096), 'GOOD.MOV': 'g'.repeat(4096) });

  // Sabotage BAD.MOV at the instant it is promoted, exactly as a failing drive
  // would: the copy succeeds, the read-back disagrees, the copy is set aside.
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to, ...rest) {
    const out = realRename.call(fs, from, to, ...rest);
    try {
      if (String(from).endsWith('.ingesto-part') && path.basename(String(to)) === 'BAD.MOV') {
        const buf = fs.readFileSync(to); const b = Buffer.from(buf); b[0] ^= 0xFF; fs.writeFileSync(to, b);
      }
    } catch (_) {}
    return out;
  };
  const r1 = (await run(card, dst, { mode: 'slow' }))[0];
  fs.renameSync = realRename;

  const leaf = r1.destPath;
  ok(r1.success === false && r1.failedFiles.includes('BAD.MOV'), 'the bad copy is caught');
  ok(Array.isArray(r1.quarantinedPaths) && r1.quarantinedPaths.length === 1,
     'and the run reports the exact path it set it aside under');
  ok(fs.existsSync(r1.quarantinedPaths[0]), 'which really is on disk');

  const r2 = await call('recopy-failed', {
    sourcePath: card, sourceName: 'A001', destPath: leaf, destName: 'D',
    mode: 'slow', files: ['BAD.MOV'], destRelMap: {}, quarantined: r1.quarantinedPaths });
  ok(r2 && r2.success === true, 'the retry copies it again');
  ok(!fs.existsSync(r1.quarantinedPaths[0]), 'and the set-aside copy is gone');
  ok(fs.existsSync(path.join(leaf, 'BAD.MOV')), 'the good copy is in its place');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
