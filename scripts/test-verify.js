#!/usr/bin/env node
// Verification, the negative path: what happens when the destination does NOT
// hold what the source holds.
//
// This is the promise the whole product rests on, and until now every test
// only ever gave the engine files that matched. Forcing the comparison to
// "always equal" — or deleting the quarantine rename — left all the suites
// green. This suite makes that impossible.
//
// Nothing is stubbed on the read path: a real file on disk is really altered
// between the copy and the read-back, exactly as a failing drive would leave
// it, and the engine is then asked what it says about it.
//
//   node scripts/test-verify.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-verify-'));
const fresh = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) {
  const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };

const PART_SUFFIX   = '.ingesto-part';
const FAILED_SUFFIX = '.ingesto-failed';

// ── Electron stub, then the REAL main.js and its REAL ipc handlers ──────────
const handlers = {};
const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false };
const userData = fresh('userData');
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true, quit: () => {}, getVersion: () => '2.6.0',
         getPath: () => userData, getName: () => 'ingesto', isPackaged: false, setAboutPanelOptions: () => {} },
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

// ── The failing drive ───────────────────────────────────────────────────────
// The copy protocol is: write "<name>.ingesto-part", fsync, rename to "<name>".
// We hook that rename — the exact instant the file becomes the delivered copy —
// and alter it there. From the engine's point of view the write succeeded and
// the medium gave something else back, which is precisely the failure this
// verification exists to catch.
const realRename = fs.renameSync;
let sabotage = null;   // { name, how: 'flip' | 'truncate' }
fs.renameSync = function (from, to, ...rest) {
  const out = realRename.call(fs, from, to, ...rest);
  try {
    if (sabotage && String(from).endsWith(PART_SUFFIX) && path.basename(String(to)) === sabotage.name) {
      const buf = fs.readFileSync(to);
      if (sabotage.how === 'truncate') fs.writeFileSync(to, buf.subarray(0, Math.max(0, buf.length - 3)));
      else { const b = Buffer.from(buf); b[0] = b[0] ^ 0xFF; fs.writeFileSync(to, b); }  // SAME size
      sabotage.done = true;
    }
  } catch (_) {}
  return out;
};

const opts = (extra) => ({ mode: 'slow', folderTemplate: '{counter}_{cardname}',
                           writeSentinel: true, writeChecksum: true,
                           cksumList: true, cksumMhl: false, ascMhl: false, ...extra });
const run = (card, dst, o) => call('start-copy', {
  sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6' }],
  destinations: [{ name: 'D', path: dst }],
  options: opts(o) });

(async () => {
  console.log('\na destination file that comes back CHANGED (SECURE, xxHash)');
  {
    const card = fresh('c1'), dst = fresh('d1');
    mk(card, { 'GOOD.MOV': 'x'.repeat(5000), 'BAD.MOV': 'y'.repeat(5000) });
    sabotage = { name: 'BAD.MOV', how: 'flip' };
    const r = (await run(card, dst))[0];
    sabotage = null;
    const leaf = r.destPath;

    ok(r.success === false, 'the ingest is NOT reported as a success');
    ok(r.errors >= 1, 'the failure is counted as an error, not just listed');
    ok(r.failedFiles.includes('BAD.MOV'), 'the file is named in failedFiles');
    ok(r.errorList.some(e => e.phase === 'verify' && /mismatch/i.test(e.error || '')),
       'the error says the checksum did not match');
    ok(!fs.existsSync(path.join(leaf, 'BAD.MOV')), 'the bad copy no longer carries its real name');
    ok(fs.existsSync(path.join(leaf, 'BAD.MOV' + FAILED_SUFFIX)), 'it is set aside as .ingesto-failed');
    ok(fs.existsSync(path.join(leaf, 'GOOD.MOV')), 'the file that was fine is untouched');

    const ck = fs.readdirSync(leaf).find(n => /\.xxh$/.test(n));
    const list = ck ? fs.readFileSync(path.join(leaf, ck), 'utf8') : '';
    ok(ck && /GOOD\.MOV/.test(list), 'the checksum list records the good file');
    ok(ck && !/BAD\.MOV/.test(list), 'and does NOT record the bad one');

    // The reason the quarantine exists: a bad copy left under its real name
    // was listed by a later Verify as a mere "extra file", and Verify still
    // answered "passed". Set aside, it is neither counted nor mistaken for a
    // deliverable — the folder now holds exactly one verified file.
    const v = await call('verify-folder', leaf);
    ok(v && v.matched === 1 && (v.corrupted || []).length === 0 && (v.extra || []).length === 0,
       'a later Verify on that folder counts one good file and no stray extra (' +
       JSON.stringify({ ok: v && v.ok, matched: v && v.matched,
                        corrupted: (v && v.corrupted || []).length, extra: (v && v.extra || []).length }) + ')');
  }

  console.log('\nthe same, in PRO');
  {
    const card = fresh('c2'), dst = fresh('d2');
    mk(card, { 'A.MOV': 'a'.repeat(4096), 'B.MOV': 'b'.repeat(4096) });
    sabotage = { name: 'B.MOV', how: 'flip' };
    const r = (await run(card, dst, { mode: 'pro', proAlgo: 'xxh64' }))[0];
    sabotage = null;
    ok(r.success === false && r.failedFiles.includes('B.MOV'),
       'a changed byte is caught in PRO too');
    ok(fs.existsSync(path.join(r.destPath, 'B.MOV' + FAILED_SUFFIX)), 'and the bad copy is set aside');
  }

  console.log('\na destination file that comes back SHORT (NORMAL, size only)');
  {
    const card = fresh('c3'), dst = fresh('d3');
    mk(card, { 'A.MOV': 'a'.repeat(4096), 'SHORT.MOV': 'b'.repeat(4096) });
    sabotage = { name: 'SHORT.MOV', how: 'truncate' };
    const r = (await run(card, dst, { mode: 'normal' }))[0];
    sabotage = null;
    ok(r.success === false && r.failedFiles.includes('SHORT.MOV'),
       'a truncated copy is caught by the size check');
    ok(r.errorList.some(e => e.phase === 'verify' && /size/i.test(e.error || '')),
       'and the error names the size');
    ok(fs.existsSync(path.join(r.destPath, 'SHORT.MOV' + FAILED_SUFFIX)), 'it is set aside as well');
  }

  console.log('\nNORMAL compares sizes, so a same-size change is NOT caught — and must not claim it was');
  {
    // Not a defect: NORMAL is the "no read-back" mode. The test exists so that
    // nobody later reads a green NORMAL suite as proof that content is checked.
    const card = fresh('c4'), dst = fresh('d4');
    mk(card, { 'A.MOV': 'a'.repeat(4096) });
    sabotage = { name: 'A.MOV', how: 'flip' };
    const r = (await run(card, dst, { mode: 'normal' }))[0];
    sabotage = null;
    ok(r.success === true, 'NORMAL reports success on a same-size change (by design)');
    ok(r.mode === 'normal', 'and the mode is recorded, so the report can say what was checked');
  }

  console.log('\nthe failed file is not remembered as ingested');
  {
    const card = fresh('c5'), dst = fresh('d5');
    mk(card, { 'OK.MOV': 'o'.repeat(4096), 'KO.MOV': 'k'.repeat(4096) });
    sabotage = { name: 'KO.MOV', how: 'flip' };
    const r = (await run(card, dst))[0];
    sabotage = null;
    // The sentinel is written on the CARD: it is what "copy new files only"
    // reads on the next ingest of the same card.
    const sent = fs.existsSync(path.join(card, '.ingesto.json'))
      ? fs.readFileSync(path.join(card, '.ingesto.json'), 'utf8') : '';
    ok(/OK\.MOV/.test(sent), 'the good file is recorded for the card sentinel');
    ok(!/KO\.MOV/.test(sent),
       'the failed one is NOT — otherwise "copy new files only" would skip it for ever');
  }

  console.log('\nan untouched ingest still passes (the sabotage is what fails, not the harness)');
  {
    const card = fresh('c6'), dst = fresh('d6');
    mk(card, { 'A.MOV': 'a'.repeat(4096), 'B.MOV': 'b'.repeat(4096) });
    const r = (await run(card, dst))[0];
    ok(r.success === true && r.errors === 0 && r.failedFiles.length === 0,
       'two good files verify clean');
    ok(fs.readdirSync(r.destPath).every(n => !n.endsWith(FAILED_SUFFIX)),
       'and nothing is set aside');
  }

  fs.renameSync = realRename;
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  fs.renameSync = realRename;
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
