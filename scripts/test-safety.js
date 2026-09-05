#!/usr/bin/env node
// Two promises, tested from the outside:
//
//   1. INGESTO never overwrites, deletes or writes into footage that was
//      already ingested — on the destination or on the card.
//   2. INGESTO never records a file as ingested/skippable unless a verified
//      copy of it sits on the destination in question.
//
// Every case below is a way one of the two used to break, run against the
// REAL main.js and its REAL ipc handlers on real folders. Each is named after
// the defect, so a red line says what came back.
//
//   node scripts/test-safety.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-safety-'));
const fresh = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) {
  const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const list = (d) => { try { return fs.readdirSync(d).sort(); } catch (_) { return null; } };

// ── Electron stub, then the REAL main.js ────────────────────────────────────
const handlers = {};
const userData = fresh('userData');
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true, quit: () => {},
         getVersion: () => '2.6.1', getPath: () => userData, getName: () => 'ingesto', isPackaged: false, setAboutPanelOptions: () => {} },
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
const sentinel = require(path.join(__dirname, '..', 'src', 'main', 'sentinel.js'));
const call = (ch, ...args) => handlers[ch]({ sender: { send: () => {} } }, ...args);

const opts = (x) => ({ mode: 'slow', folderTemplate: '{counter}_{cardname}', writeSentinel: true,
                       writeChecksum: true, cksumList: true, cksumMhl: false, ascMhl: false, ...x });
const ingest = (card, name, dst, o = {}) => call('start-copy', {
  sources: [{ name, path: card, counter: o.counter || '001', cameraman: 'noar', camera: 'FX6', ...(o.src || {}) }],
  destinations: (Array.isArray(dst) ? dst : [dst]).map((p, i) => ({ name: 'D' + (i + 1), path: p })),
  options: opts(o) });
const refused = (r) => r && r.success === false && r.copiedFiles === 0 &&
                       (r.errorList || []).some(e => e.phase === 'setup');

(async () => {
  // ═══════════ 1. Nothing already ingested is ever written over ═══════════

  console.log('\na template without {counter}: two cards labelled "NO NAME" the same day');
  {
    // The counter guard only knows a NUMBER. "260903_NO NAME" has none, so the
    // second card landed on the first: CLIP0001.MOV of the morning replaced by
    // the afternoon's, both runs green, Verify "passed" afterwards.
    const dst = fresh('d1'), A = fresh('c1a'), B = fresh('c1b');
    mk(A, { 'CLIP0001.MOV': 'MORNING take 1', 'CLIP0002.MOV': 'MORNING take 2' });
    mk(B, { 'CLIP0001.MOV': 'AFTERNOON take 1' });
    const tpl = '{YY}{MM}{DD}_{cardname}';
    const r1 = (await ingest(A, 'NO NAME', dst, { folderTemplate: tpl }))[0];
    ok(r1.success === true, 'the first card is ingested');
    const r2 = (await ingest(B, 'NO NAME', dst, { folderTemplate: tpl }))[0];
    ok(refused(r2), 'the second card, resolving to the SAME folder, is refused before a byte moves');
    ok(/already exists/i.test((r2.errorList[0] || {}).error || ''), 'and the message says the folder already exists');
    ok(read(path.join(r1.destPath, 'CLIP0001.MOV')) === 'MORNING take 1', 'the morning clip is intact');
    ok(list(r1.destPath).join() === list(r1.destPath).join() && list(r1.destPath).includes('CLIP0002.MOV'), 'nothing was added to the first card\'s folder');
  }

  console.log('\nthe engine guards on its own — two cards of one call, same name, template {cardname}');
  {
    const dst = fresh('d2'), A = fresh('c2a'), B = fresh('c2b');
    mk(A, { 'X.MOV': 'card A' }); mk(B, { 'X.MOV': 'card B' });
    const R = await call('start-copy', {
      sources: [{ name: 'NO NAME', path: A, counter: '001' }, { name: 'NO NAME', path: B, counter: '002' }],
      destinations: [{ name: 'D', path: dst }], options: opts({ folderTemplate: '{cardname}' }) });
    ok(R[0].success === true && refused(R[1]), 'card 2 is refused by the ENGINE, no renderer needed');
    ok(read(path.join(dst, 'NO NAME', 'X.MOV')) === 'card A', 'card A\'s file was not replaced');
  }

  console.log('\nan existing card folder that holds only INGESTO residue may be reused');
  {
    // The one thing the guard tolerates: *.ingesto-part left by an interrupted
    // run. It is swept BEFORE the copy, never after.
    const dst = fresh('d3'), card = fresh('c3');
    mk(card, { 'A.MOV': 'aaaa' });
    mk(path.join(dst, '001_A001'), { 'A.MOV.ingesto-part': 'partial', 'sub/B.MOV.ingesto-part': 'partial',
                                     '.DS_Store': 'finder', '._A.MOV': 'appledouble' });
    // Residue of an interrupted run is OLD. A *.ingesto-part written seconds
    // ago is a copy in progress — on another machine sharing this drive.
    const fresh0 = (await ingest(card, 'A001', dst))[0];
    ok(refused(fresh0), 'a *.ingesto-part written seconds ago means a copy in progress: refused');
    const old = (Date.now() - 10 * 60 * 1000) / 1000;
    for (const f of ['A.MOV.ingesto-part', 'sub/B.MOV.ingesto-part']) { try { fs.utimesSync(path.join(dst, '001_A001', f), old, old); } catch (_) {} }
    const r = (await ingest(card, 'A001', dst))[0];
    ok(r.success === true, 'the run proceeds into the residue-only folder (residue 10 minutes old, Finder litter ignored)');
    ok(!fs.existsSync(path.join(dst, '001_A001', 'A.MOV.ingesto-part')), 'the residue is gone');
    ok(read(path.join(dst, '001_A001', 'A.MOV')) === 'aaaa', 'and the card is there');
  }
  {
    const dst = fresh('d3b'), card = fresh('c3b');
    mk(card, { 'A.MOV': 'aaaa' });
    mk(path.join(dst, '001_A001'), { 'A.MOV.ingesto-part': 'partial', 'PRECIOUS.MOV': 'yesterday' });
    const r = (await ingest(card, 'A001', dst))[0];
    ok(refused(r), 'one real file beside the residue is enough to refuse');
    ok(read(path.join(dst, '001_A001', 'PRECIOUS.MOV')) === 'yesterday' &&
       fs.existsSync(path.join(dst, '001_A001', 'A.MOV.ingesto-part')), 'and nothing in that folder was touched — not even the residue');
  }

  console.log('\na card folder that is a symbolic link');
  {
    // Invisible to the counter walk (not a directory entry), followed by
    // mkdir and rename: the link\'s target was written over.
    const dst = fresh('d4'), archive = fresh('archive4'), card = fresh('c4');
    mk(archive, { '001_A001/CLIP.MOV': 'the archive' });
    fs.symlinkSync(path.join(archive, '001_A001'), path.join(dst, '001_A001'));
    mk(card, { 'CLIP.MOV': 'new card' });
    const hit = await call('check-counter-collision', [dst], [1], '{counter}_{cardname}');
    ok(hit && hit.counter === 1, 'the counter walk now SEES the linked folder (' + JSON.stringify(hit) + ')');
    const r = (await ingest(card, 'A001', dst))[0];
    ok(refused(r), 'and the engine refuses it anyway');
    ok(read(path.join(archive, '001_A001', 'CLIP.MOV')) === 'the archive', 'the archive behind the link is intact');
  }

  console.log('\nthe destination drive is gone');
  {
    // mkdir -p recreated /Volumes/BACKUP/001_A001 on the system disk, copied,
    // verified against itself: "success", footage on the laptop, drive empty.
    const parent = fresh('p5'), card = fresh('c5');
    mk(card, { 'A.MOV': 'aaaa' });
    const gone = path.join(parent, 'BACKUP');
    const r = (await ingest(card, 'A001', gone))[0];
    ok(refused(r) && /not there/i.test((r.errorList[0] || {}).error || ''), 'a missing destination root is refused: ' + ((r.errorList[0] || {}).error || '').slice(0, 60));
    ok(!fs.existsSync(gone), 'and nothing was recreated in its place');
  }
  {
    // Same for a retry: the folder a previous run created must still be there.
    const dst = fresh('d5b'), card = fresh('c5b');
    mk(card, { 'A.MOV': 'aaaa', 'B.MOV': 'bbbb' });
    const first = (await ingest(card, 'A001', dst))[0];
    fs.rmSync(dst, { recursive: true, force: true });                     // drive unplugged
    const rr = await call('recopy-failed', { sourcePath: card, sourceName: 'A001', destPath: first.destPath,
      mode: 'slow', files: ['A.MOV'], destRelMap: {}, destIndex: 0, destName: 'D' });
    const x = Array.isArray(rr) ? rr[0] : rr;
    ok(x.success === false && x.copiedFiles === 0, 'a retry towards a vanished folder is refused');
    ok(!fs.existsSync(first.destPath), 'and the folder is not recreated on whatever now backs that path');
  }

  console.log('\na destination that is a link to the card itself');
  {
    const card = fresh('c6'); mk(card, { 'C.MOV': 'cccc' });
    const link = path.join(TMP, 'BACKUP_LINK6'); fs.symlinkSync(card, link);
    const r = (await ingest(card, 'A006', link))[0];
    ok(refused(r) && /same as|inside/i.test((r.errorList[0] || {}).error || ''), 'the card is not copied into itself through a link');
    ok(list(card).join() === 'C.MOV', 'the card holds exactly what it held');
  }

  console.log('\na retry is a checklist');
  {
    // A requested file the card no longer holds used to vanish from the run:
    // "2 of 2 copied", retry button gone, third clip unrecoverable.
    const dst = fresh('d7'), card = fresh('c7');
    mk(card, { 'F1.MOV': '1', 'F2.MOV': '2', 'F3.MOV': '3' });
    const first = (await ingest(card, 'A007', dst))[0];
    fs.unlinkSync(path.join(card, 'F3.MOV'));
    const rr0 = await call('recopy-failed', { sourcePath: card, sourceName: 'A007', destPath: first.destPath,
      mode: 'slow', files: ['F1.MOV', 'F2.MOV', 'F3.MOV'], destRelMap: {}, destIndex: 0, destName: 'D' });
    const rr = Array.isArray(rr0) ? rr0[0] : rr0;
    ok(rr.success === false, 'the retry is NOT a success');
    ok(rr.failedFiles.includes('F3.MOV'), 'the file that is no longer on the card is named as failed');
    ok(rr.copiedFiles === 2, 'the two that were there were still re-copied');
  }

  console.log('\nthe sweep never eats a file this run delivered');
  {
    // A source file whose name ends in ".ingesto-part" (a folder from an
    // interrupted ingest, re-ingested as a card) was copied then deleted by the
    // post-copy sweep. In FAST nothing noticed.
    const dst = fresh('d8'), card = fresh('c8');
    mk(card, { 'RESIDUE.MOV.ingesto-part': 'from the card', 'A.MOV': 'a' });
    const r = (await ingest(card, 'A008', dst, { mode: 'fast' }))[0];
    ok(r.success === true && r.copiedFiles === 2, 'both files are copied');
    ok(read(path.join(r.destPath, 'RESIDUE.MOV.ingesto-part')) === 'from the card', 'and the one named like residue is still there');
  }

  console.log('\nINGESTO\'s own probe file is not footage');
  {
    const dst = fresh('d9'), card = fresh('c9');
    mk(card, { '.ingesto_wtest_1234': '', 'A.MOV': 'a' });
    const r = (await ingest(card, 'A009', dst))[0];
    ok(r.totalFiles === 1 && !fs.existsSync(path.join(r.destPath, '.ingesto_wtest_1234')), 'a leftover write probe is neither copied nor counted');
  }

  console.log('\nquarantine never replaces an earlier quarantined copy');
  {
    // renameSync replaces its target silently: a second bad copy of A.MOV set
    // aside as "A.MOV.ingesto-failed" erased the first one.
    const dst = fresh('d10'), card = fresh('c10');
    mk(card, { 'A.MOV': 'x'.repeat(4096) });
    const realRename = fs.renameSync;
    fs.renameSync = function (from, to, ...rest) {
      const promote = String(from).endsWith('.ingesto-part') && path.basename(String(to)) === 'A.MOV';
      if (promote) fs.writeFileSync(to + '.ingesto-failed', 'FIRST BAD COPY');   // an earlier quarantined copy
      const out = realRename.call(fs, from, to, ...rest);
      if (promote) { const b = Buffer.from(fs.readFileSync(to)); b[0] ^= 0xff; fs.writeFileSync(to, b); }  // this copy comes back changed
      return out;
    };
    let r; try { r = (await ingest(card, 'A010', dst))[0]; } finally { fs.renameSync = realRename; }
    ok(r.success === false, 'the altered copy fails verification');
    ok(read(path.join(r.destPath, 'A.MOV.ingesto-failed')) === 'FIRST BAD COPY', 'the earlier quarantined copy is untouched');
    ok(fs.existsSync(path.join(r.destPath, 'A.MOV.ingesto-failed-2')), 'the new one is set aside under a free name');
  }

  // ═══════════ 2. "Already ingested" means: verified, on THIS destination ═══

  console.log('\nthe card\'s log records what was checked');
  {
    const dst = fresh('d11'), card = fresh('c11');
    mk(card, { 'A.MOV': 'a', 'B.MOV': 'b' });
    await ingest(card, 'A011', dst, { mode: 'fast' });
    const s1 = sentinel.readSentinel(card);
    ok(s1 && s1.ingests[0].mode === 'fast' && s1.ingests[0].verified === false, 'a FAST ingest is recorded as NOT verified');
    await ingest(card, 'A011', dst, { counter: '002' });
    const s2 = sentinel.readSentinel(card);
    ok(s2.ingests[1].mode === 'slow' && s2.ingests[1].verified === true, 'a SECURE ingest is recorded as verified');
  }

  console.log('\n"copy new files only" trusts nothing but a verified copy on the selected drive');
  {
    const A = fresh('d12a'), B = fresh('d12b'), card = fresh('c12');
    const files = {}; for (let i = 1; i <= 12; i++) files[`C${String(i).padStart(4, '0')}.MOV`] = 'x'.repeat(100 + i);
    mk(card, files);
    const day1 = (await ingest(card, 'A012', A))[0];
    ok(day1.success === true && day1.copiedFiles === 12, 'day 1: the card goes to drive A, verified');
    mk(card, { 'C0013.MOV': 'new', 'C0014.MOV': 'new2' });

    const onA = await call('inspect-card', card, false, [A]);
    ok(onA.counts.alreadyIngested === 12 && onA.counts.skippable === 12, 'for drive A, the 12 verified files are skippable (' + onA.counts.skippable + ')');
    const onB = await call('inspect-card', card, false, [B]);
    ok(onB.counts.alreadyIngested === 12 && onB.counts.skippable === 0, 'for a drive that never saw the card, NONE is skippable (' + onB.counts.skippable + ')');
    const none = await call('inspect-card', card, false);
    ok(none.counts.skippable === 0, 'with no destination given, nothing is skippable');

    // The wrong skip list (the whole history) is what the old dialog sent.
    // The engine still obeys it — the guard is in what the renderer may ask
    // for — so what matters is that the RIGHT list makes drive B complete.
    const day2B = (await call('start-copy', { sources: [{ name: 'A012', path: card, counter: '002' }],
      destinations: [{ name: 'B', path: B }], options: opts({ skipKeys: onB._skippableKeys }) }))[0];
    ok(day2B.success === true && day2B.copiedFiles === 14 && day2B.skippedFiles === 0, 'drive B receives all 14 files (' + day2B.copiedFiles + ')');
    const day2A = (await call('start-copy', { sources: [{ name: 'A012', path: card, counter: '003' }],
      destinations: [{ name: 'A', path: A }], options: opts({ skipKeys: onA._skippableKeys }) }))[0];
    ok(day2A.success === true && day2A.copiedFiles === 2 && day2A.skippedFiles === 12, 'drive A receives the 2 new files and reports 12 skipped (' + day2A.copiedFiles + '/' + day2A.skippedFiles + ')');

    // Wipe the card folder on A: its record no longer vouches for anything.
    fs.rmSync(day1.destPath, { recursive: true, force: true });
    const wiped = await call('inspect-card', card, false, [A]);
    ok(wiped.counts.skippable === 2, 'once the day-1 folder is gone from A, only the day-2 files remain skippable (' + wiped.counts.skippable + ')');
  }
  {
    // A FAST ingest vouches for nothing, even on the right drive.
    const A = fresh('d13'), card = fresh('c13');
    mk(card, { 'A.MOV': 'a' });
    await ingest(card, 'A013', A, { mode: 'fast' });
    const info = await call('inspect-card', card, false, [A]);
    ok(info.counts.alreadyIngested === 1 && info.counts.skippable === 0, 'a file ingested in FAST is never skippable');
  }
  {
    // A record written by an earlier version says nothing about the mode: the
    // manifest a verified ingest leaves behind decides.
    const A = fresh('d14'), card = fresh('c14');
    mk(card, { 'A.MOV': 'a' });
    const r = (await ingest(card, 'A014', A))[0];
    const sp = path.join(card, '.ingesto.json'); const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
    delete j.ingests[0].mode; delete j.ingests[0].verified; fs.writeFileSync(sp, JSON.stringify(j));
    ok((await call('inspect-card', card, false, [A])).counts.skippable === 1, 'a legacy record with a checksum manifest in its folder is trusted');
    for (const n of fs.readdirSync(r.destPath)) if (/\.xxh/.test(n)) fs.unlinkSync(path.join(r.destPath, n));
    ok((await call('inspect-card', card, false, [A])).counts.skippable === 0, 'the same record without a manifest is not');
  }

  console.log('\na skip needs a verified copy on EVERY selected destination');
  {
    // One proven drive plus a brand-new one: the new one used to receive only
    // today's clips, with a green tick and an eject button.
    const A = fresh('d16a'), C = fresh('d16c'), card = fresh('c16');
    mk(card, { 'A001.MOV': 'a1', 'A002.MOV': 'a2' });
    await ingest(card, 'A016', A);
    mk(card, { 'A003.MOV': 'a3' });
    const both = await call('inspect-card', card, false, [A, C]);
    ok(both.counts.skippable === 0, 'with a new drive among the destinations, nothing is skippable (' + both.counts.skippable + ')');
    const onlyA = await call('inspect-card', card, false, [A]);
    ok(onlyA.counts.skippable === 2, 'with the proven drive alone, the two verified files are (' + onlyA.counts.skippable + ')');
  }

  console.log('\na record vouches for a FILE, not for a folder');
  {
    const A = fresh('d17'), card = fresh('c17');
    mk(card, { 'A.MOV': 'aaaa', 'B.MOV': 'bbbb' });
    const r = (await ingest(card, 'A017', A))[0];
    fs.unlinkSync(path.join(r.destPath, 'B.MOV'));                       // someone dragged it out
    const info = await call('inspect-card', card, false, [A]);
    ok(info.counts.skippable === 1, 'a file no longer in the recorded folder is not skippable (' + info.counts.skippable + ')');
    fs.writeFileSync(path.join(r.destPath, 'A.MOV'), 'aa');               // same name, other size
    ok((await call('inspect-card', card, false, [A])).counts.skippable === 0, 'nor is one whose size no longer matches');
  }
  {
    // A legacy record is trusted only on INGESTO's own manifest, not on any
    // *.md5 that happens to sit in the folder.
    const A = fresh('d18'), card = fresh('c18');
    mk(card, { 'A.MOV': 'a' });
    const r = (await ingest(card, 'A018', A, { mode: 'fast' }))[0];
    const sp = path.join(card, '.ingesto.json'); const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
    delete j.ingests[0].mode; delete j.ingests[0].verified; fs.writeFileSync(sp, JSON.stringify(j));
    fs.writeFileSync(path.join(r.destPath, 'from_the_sound_recordist.md5'), 'x');
    ok((await call('inspect-card', card, false, [A])).counts.skippable === 0, 'someone else\'s .md5 does not make a legacy FAST record trusted');
  }

  console.log('\na retry cleans up only what it opened');
  {
    // The post-copy sweep walked the folder and deleted a delivered file named
    // like residue — on a retry, one an earlier run had already verified.
    const dst = fresh('d19'), card = fresh('c19');
    mk(card, { 'OLD.MOV.ingesto-part': 'real footage', 'B.MOV': 'b', 'C.MOV': 'c' });
    const first = (await ingest(card, 'A019', dst))[0];
    ok(first.success === true && fs.existsSync(path.join(first.destPath, 'OLD.MOV.ingesto-part')), 'first run delivers the oddly named file');
    const rr0 = await call('recopy-failed', { sourcePath: card, sourceName: 'A019', destPath: first.destPath,
      mode: 'slow', files: ['C.MOV'], destRelMap: {}, destIndex: 0, destName: 'D' });
    const rr = Array.isArray(rr0) ? rr0[0] : rr0;
    ok(rr.success === true && rr.errors === 0, 'the retry of C.MOV succeeds');
    ok(read(path.join(first.destPath, 'OLD.MOV.ingesto-part')) === 'real footage', 'and the delivered file named like residue is still there');
  }

  console.log('\nthe CSV report keeps its history');
  {
    const dst = fresh('d15');
    const csv = (rows) => '#,Card\n' + rows.map(r => r + '\n').join('');
    ok(await call('report-write-named', dst, 'INGESTO_report.csv', csv(['001,A']), true) === true, 'first write creates the file');
    ok(await call('report-write-named', dst, 'INGESTO_report.csv', csv(['002,B']), true) === true, 'second write appends');
    ok(read(path.join(dst, 'INGESTO_report.csv')) === '#,Card\n001,A\n002,B\n', 'both rows are there, one header');
    // A file from an earlier version with other columns is not appended to.
    ok(await call('report-write-named', dst, 'INGESTO_report.csv', '#,Card,Folder\n003,C,DAY1\n', true) === true, 'a write with a different header is accepted');
    ok(read(path.join(dst, 'INGESTO_report.csv')) === '#,Card\n001,A\n002,B\n', 'but the old file is left as it was');
    ok(read(path.join(dst, 'INGESTO_report-2.csv')) === '#,Card,Folder\n003,C,DAY1\n', 'and the rows go to a sibling file with their own header');
    ok(await call('report-write-named', dst, 'INGESTO_report.csv', '#,Card,Folder\n004,D,DAY1\n', true) === true &&
       read(path.join(dst, 'INGESTO_report-2.csv')) === '#,Card,Folder\n003,C,DAY1\n004,D,DAY1\n', 'the next run appends to that sibling');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
