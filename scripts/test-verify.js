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

  // ── The files INGESTO writes itself are not "extra files" ────────────────
  // Reported from the field: a user ingests with a card note, runs Verify a
  // day later, and gets the red cross of a failed verification because
  // "001_note.txt" is not in the manifest. Same for the whole ascmhl folder:
  // the sidecar test received a basename, so its "^ascmhl/" pattern could
  // never match anything.
  console.log('\nINGESTO\'s own files are not reported as unknown');
  {
    const card = fresh('c7'), dst = fresh('d7');
    mk(card, { 'A001C001.MOV': 'a'.repeat(4096), 'A001C002.MOV': 'b'.repeat(4096) });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6',
                  note: 'Jour 3, plateau B.' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ mode: 'pro', proAlgo: 'xxh64', ascMhl: true }) });
    const leaf = R[0].destPath;

    // The fixture must really contain what the test claims to be about.
    ok(fs.existsSync(path.join(leaf, '001_note.txt')), 'the shooting note was written');
    ok(fs.existsSync(path.join(leaf, 'ascmhl')), 'the ASC MHL history was written');

    const v = await call('verify-folder', leaf);
    ok(v.matched === 2 && v.corrupted.length === 0 && v.missing.length === 0,
       'the two clips verify clean');
    ok(!v.extra.includes('001_note.txt'),
       'the shooting note is not listed as an unknown file');
    ok(!v.extra.some(f => f.startsWith('ascmhl/')),
       'no ASC MHL file is listed as an unknown file (' + JSON.stringify(v.extra) + ')');
    ok(v.extra.length === 0, 'and the folder comes back with nothing unknown at all');

    // A text file that merely LOOKS like a note is still an unknown file: the
    // name alone must never be enough to wave a file through.
    fs.writeFileSync(path.join(leaf, '002_note.txt'), 'not an ingesto note at all');
    const v2 = await call('verify-folder', leaf);
    ok(v2.extra.includes('002_note.txt'),
       'a *_note.txt without the INGESTO header is still reported');
    fs.unlinkSync(path.join(leaf, '002_note.txt'));

    // Only at the root. A note-looking file inside a card subfolder is media
    // territory and stays visible.
    fs.mkdirSync(path.join(leaf, 'CLIP'), { recursive: true });
    fs.writeFileSync(path.join(leaf, 'CLIP', '003_note.txt'),
                     'ingesto - Shooting Note\n----\nfake');
    const v3 = await call('verify-folder', leaf);
    ok(v3.extra.includes('CLIP/003_note.txt'),
       'a note-looking file in a subfolder is still reported');
    fs.rmSync(path.join(leaf, 'CLIP'), { recursive: true, force: true });

    // And the reason the "extra" list exists in the first place still holds.
    fs.writeFileSync(path.join(leaf, 'A001C003.MOV'), 'c'.repeat(4096));
    const v4 = await call('verify-folder', leaf);
    ok(v4.extra.length === 1 && v4.extra[0] === 'A001C003.MOV',
       'a real unlisted clip is still reported, alone');
  }

  console.log('\naccented names: the two ways a name can be stored');
  {
    // "É" can be one character or two (E plus a combining accent). macOS writes
    // the two-character form, everything else the one-character form, and they
    // look identical on screen. Manifest entries are normalised one way; the
    // name on a Linux, Windows or NAS volume keeps the bytes it was given.
    //
    // Verify used to build each path by joining the normalised name onto the
    // folder, find nothing, and report the file as MISSING: the loudest thing
    // it can say about a delivered rush, on a folder that is perfectly fine.
    const NFC = 'CLIP_ÉTÉ.MOV';        // É as one character
    const NFD = NFC.normalize('NFD');                        // E + combining accent
    ok(NFC !== NFD && NFC.length !== NFD.length, 'the fixture really holds two different forms');
    const card = fresh('c-nfd'), dst = fresh('d-nfd');
    mk(card, { [NFC]: 'e'.repeat(4096), 'PLAIN.MOV': 'p'.repeat(4096) });
    const leaf = (await run(card, dst, { mode: 'slow' }))[0].destPath;

    const ckName = fs.readdirSync(leaf).find(n => /\.xxh$/.test(n));
    ok(/CLIP_ÉTÉ\.MOV/.test(fs.readFileSync(path.join(leaf, ckName), 'utf8')),
       'the manifest holds the one-character form');

    // Now the delivered file carries the OTHER form, as it would on a volume
    // written by a Mac and read anywhere else.
    fs.renameSync(path.join(leaf, NFC), path.join(leaf, NFD));
    ok(fs.readdirSync(leaf).includes(NFD), 'and the file on disk holds the two-character form');

    const v = await call('verify-folder', leaf);
    ok(v.missing.length === 0, 'nothing is reported missing (' + JSON.stringify(v.missing) + ')');
    ok(v.corrupted.length === 0, 'nothing is reported corrupt');
    ok(v.matched === 2, 'both files verify, the accented one included');
    ok(v.extra.length === 0, 'and it is not listed as an unknown file either');
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
