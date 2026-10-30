#!/usr/bin/env node
// What the engine refuses, reports and never does, after the 2.7.0 review,
// checked from the outside: real ingests through the real main.js on real
// folders, and what they leave behind. They are grouped by what they protect:
//   1. the machine (a path that reveals must never execute)
//   2. the destination (a name built from a value the interface sent)
//   3. the operator (a failure that used to happen in silence)
//   4. the footage (a counter that can always be read back)
//   5. what is written beside the footage (flushed before it is named)
//   6. the batch (a destination inside any card of it is refused first)
//
//   node scripts/test-engine-guards.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const H    = require('./lib/harness');

const MAIN = require('./lib/source').ENGINE;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

const { call, electron } = H.loadMain({ version: '2.7.0' });
const src = (dir, name, extra) => Object.assign({ name, path: dir, counter: '001', cameraman: 'noar', camera: 'FX6', pp: '', note: '' }, extra);
const ingest = (sources, dests, o) => call('start-copy', {
  sources, destinations: dests.map((p, i) => ({ name: 'D' + (i + 1), path: p })),
  options: Object.assign({ mode: 'slow', folderTemplate: '{counter}_{cardname}', writeSentinel: false,
    writeChecksum: true, cksumList: true, cksumMhl: false, ascMhl: false, fileFilter: null }, o) });
const SMALL = { 'CLIP/A.MOV': 3000, 'CLIP/B.MOV': 2000 };

(async () => {
  // ── 1. Revealing a folder must never open a file ──────────────────────────
  console.log('\n"reveal" shows a folder, it does not open anything');
  {
    // The path can come from a record read back out of a report that lives on
    // a shared destination. openPath() does not show a file, it LAUNCHES it
    // with whatever application owns the extension: a stranger with write
    // access to the drive could have chosen the program that runs.
    const calls = [];
    electron.shell.showItemInFolder = (p) => calls.push(['show', p]);
    electron.shell.openPath = async (p) => { calls.push(['open', p]); return ''; };
    electron.shell.openExternal = async (p) => { calls.push(['external', p]); };
    const d = H.fresh('reveal'); fs.writeFileSync(path.join(d, 'report.html'), 'x');
    const r1 = await call('reveal-path', path.join(d, 'report.html'));
    ok(r1 === true && calls.length === 1 && calls[0][0] === 'show', 'an existing file is shown in its folder');
    ok(calls[0][1] === path.resolve(path.join(d, 'report.html')), 'with its resolved path');
    const r2 = await call('reveal-path', path.join(d, 'missing.html'));
    ok(r2 === false && calls.length === 1, 'a path that does not exist is refused, and nothing is called');
    const r3 = await call('reveal-path', path.join(d, '..', 'reveal', 'report.html'));
    ok(r3 === true && calls.length === 2 && calls[1][0] === 'show', 'a path with ".." is resolved before it is shown');
    ok(calls.every(c => c[0] === 'show'), 'nothing was ever opened or launched');
  }

  // ── 2. A name built from a value the interface sent ───────────────────────
  console.log('\nthe shooting note cannot be written outside the destination');
  {
    const c = H.card(H.fresh('c-note'), SMALL), d = H.fresh('d-note');
    const r = (await ingest([src(c, 'A001', { counter: '../../../../etc/passwd', note: 'take 4' })], [d],
      { folderTemplate: '{cardname}' }))[0];
    ok(r.success === true, 'the ingest runs');
    const notes = H.snapshotTree(d);
    const noteFiles = Object.keys(notes).filter(k => k.endsWith('_note.md'));
    ok(noteFiles.length === 1 && noteFiles[0] === 'A001/etcpasswd_note.md',
       `the note is named with the cleaned counter, inside the card's folder (${noteFiles.join(', ')})`);
    ok(!fs.existsSync(path.join(d, '..', 'etc')) && !fs.existsSync(path.join(d, 'etc')), 'nothing was written anywhere else');
    const r2 = (await ingest([src(c, 'A001', { counter: '////', note: 'take 5' })], [H.fresh('d-note2')], { folderTemplate: '{cardname}' }))[0];
    ok(fs.existsSync(path.join(r2.destPath, '001_note.md')), 'a counter with nothing usable in it falls back to 001');
  }

  // ── 3. A failure that used to be silent ───────────────────────────────────
  console.log('\na card that refuses the journal says so');
  {
    // The journal is written through a temporary file: a folder in its place
    // makes the write fail the way a write-protected card does.
    const c = H.card(H.fresh('c-journal'), SMALL), d = H.fresh('d-journal');
    fs.mkdirSync(path.join(c, '.ingesto.json.tmp'));
    const r = (await ingest([src(c, 'A001')], [d], { writeSentinel: true }))[0];
    ok(r.success === true, 'the ingest itself succeeds (the footage is on the drive)');
    ok((r.notes || []).some(n => n.code === 'CV-8'), 'and the window gets the remark: this ingest was not recorded on the card');
    ok(!fs.existsSync(path.join(c, '.ingesto.json')), 'no journal was written');
    const good = H.card(H.fresh('c-journal2'), SMALL);
    const r2 = (await ingest([src(good, 'A001')], [H.fresh('d-journal2')], { writeSentinel: true }))[0];
    ok(!(r2.notes || []).some(n => n.code === 'CV-8') && fs.existsSync(path.join(good, '.ingesto.json')),
       'a card that takes the journal gets no such remark');
  }
  console.log('\nthe card journal never comes back unbounded');
  {
    // A journal over the cap reads as damaged, never as a fresh card: the
    // card is not re-ingested from scratch, and the operator is told.
    const c = H.card(H.fresh('c-cap'), SMALL);
    const jp = path.join(c, '.ingesto.json');
    // Valid JSON, 65 MB of it: without the cap it would be read and parsed.
    const fd = fs.openSync(jp, 'w');
    fs.writeSync(fd, '{"ingesto_version":"x","ingests":[]');
    const pad = Buffer.alloc(1024 * 1024, ' ');
    for (let i = 0; i < 65; i++) fs.writeSync(fd, pad);
    fs.writeSync(fd, '}'); fs.closeSync(fd);
    const info = await call('inspect-card', c, false, []);
    ok(info && info.hasSentinel === false && info.sentinelDamaged === true, 'a 65 MB journal is reported as damaged, not read');
    fs.writeFileSync(jp, '{"ingesto_version":"x","ingests":[]}');
    const info2 = await call('inspect-card', c, false, []);
    ok(info2 && info2.hasSentinel === true && info2.sentinelDamaged === false, 'a normal one is read');
  }

  // ── 4. A counter that can always be read back ─────────────────────────────
  console.log('\nthe counter survives a template that ends in a dot or a space');
  {
    // The folder created from "{counter}_{cardname}." must be matched by the
    // counter scan, or the scan answers next=001 for ever and every later
    // ingest is refused by the "folder already exists" guard.
    const d = H.fresh('d-counter');
    for (const [tpl, n] of [['{counter}_{cardname}.', '007'], ['{counter}_{cardname} ', '008'],
                            ['{counter}_{cardname}.. ..', '009'], ['{cardname}_{counter}.', '012']]) {
      const dd = H.fresh('d-counter-' + n);
      const c = H.card(H.fresh('c-counter-' + n), SMALL);
      const r = (await ingest([src(c, 'A001', { counter: n })], [dd], { mode: 'fast', folderTemplate: tpl }))[0];
      const next = await call('scan-dest-counter-full', [dd], tpl);
      ok(r.success === true && next && Number(next.next) === Number(n) + 1,
         `"${tpl}" written as ${n}: the scan reads it back and proposes ${Number(n) + 1} (${JSON.stringify(next)})`);
    }
    void d;
  }

  // ── 5. What is written beside the footage is written to last ──────────────
  console.log('\nthe lists, manifests and reports are flushed, not just renamed');
  {
    // Durability cannot be observed by a test (no power cut here): this is
    // the one place where the code itself is read. The flush of the file and
    // of the folder entry that names it, before the rename, is what keeps a
    // manifest from vanishing with the power.
    const fn = extractFn(MAIN, 'writeFileAtomic');
    ok(/fullFsync\(fd\)|fsyncSync\(fd\)/.test(fn), 'the file itself is flushed');
    ok(/openSync\(path\.dirname\(target\)/.test(fn) && /fsyncSync\(dfd\)/.test(fn),
       'and so is the folder entry that names it, or the name can be lost on a power cut');
    ok(fn.indexOf('fsyncSync(fd)') < fn.indexOf('safeRename'), 'the flush happens before the rename');

    // It still writes what it is given.
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-atomic-'));
    const ctx = vm.createContext({ fs, path, console,
      ATOMIC_TMP_SUFFIX: '.ingesto-tmp',
      nocache: { fullFsync: () => false },
      safeWriteTarget: (p) => p,
      safeRename: (a, b) => fs.renameSync(a, b) });
    vm.runInContext(extractFn(MAIN, 'writeFileAtomic'), ctx);
    const target = path.join(TMP, 'INGESTO_report.html');
    ctx.writeFileAtomic(target, 'hello');
    ok(fs.readFileSync(target, 'utf8') === 'hello', 'and the content is there afterwards');
    ok(fs.readdirSync(TMP).length === 1, 'with no temporary file left behind');
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // ── 6. The preflight covers the whole batch ───────────────────────────────
  console.log('\na destination inside ANY card of the batch is refused before the first byte');
  {
    // It used to be compared against the card being copied only. A
    // destination sitting inside another card of the same batch passed here
    // and was stopped later by the source-card lock, in the middle of the
    // copy, naming a card the operator was not copying.
    const a = H.card(H.fresh('c-batch-a'), SMALL), b = H.card(H.fresh('c-batch-b'), SMALL);
    const inB = path.join(b, 'BACKUP'); fs.mkdirSync(inB);
    const rs = await ingest([src(a, 'A001'), src(b, 'B001', { counter: '002' })], [inB], {});
    ok(rs.every(r => r.success === false && r.copiedFiles === 0), 'both cards are refused');
    ok(rs.every(r => r.refusalCode === 'PF-E6'), 'with the refusal the interface knows (PF-E6)');
    ok(fs.readdirSync(inB).length === 0, 'and not a byte landed inside the card');
    ok(fs.readdirSync(a).sort().join() === 'CLIP' && fs.readdirSync(b).sort().join() === 'BACKUP,CLIP',
       'both cards are untouched');
  }
  console.log('\nthe card journal records what the engine really did, not what the window asked');
  {
    // A mode the engine does not know is run as SECURE. The journal must say
    // so: a copy of the options made it record "not verified" for a run that
    // was verified, and the next "copy new files only" refused to trust it.
    const c = H.card(H.fresh('c-mode'), SMALL), d = H.fresh('d-mode');
    const r = (await ingest([src(c, 'A001')], [d], { mode: 'bogus', writeSentinel: true }))[0];
    const j = JSON.parse(fs.readFileSync(path.join(c, '.ingesto.json'), 'utf8'));
    ok(r.success === true && r.mode === 'slow', 'an unknown mode is run as SECURE');
    ok(j.ingests[0].mode === 'slow' && j.ingests[0].verified === true, 'and the journal says SECURE, verified');
  }

  // ── 7. A card with nothing to copy leaves nothing behind ─────────────────
  console.log('\na card with nothing to copy writes nothing on the destination');
  {
    // The card's folder would take a counter value and read, on the drive and
    // in the next counter scan, as a card that was ingested.
    const c = H.fresh('c-none'), d = H.fresh('d-none');
    const r = (await ingest([src(c, 'A001')], [d], {}))[0];
    ok(r.success === false && r.emptyReason === 'no-files', 'an empty card is reported as such');
    ok(!fs.existsSync(r.destPath), 'and its folder is not created');
    const c2 = H.card(H.fresh('c-filt'), SMALL), d2 = H.fresh('d-filt');
    const r2 = (await ingest([src(c2, 'A001')], [d2], { fileFilter: { extCat: { mp4: 'VIDEO' }, copyEmpty: true, reorganize: false } }))[0];
    ok(r2.emptyReason === 'filtered-out' && !fs.existsSync(r2.destPath),
       'a card whose files are all excluded by the filter: nothing created either, even with "copy empty folders"');
    const c3 = H.card(H.fresh('c-some'), SMALL), d3 = H.fresh('d-some');
    const r3 = (await ingest([src(c3, 'A001')], [d3], {}))[0];
    ok(r3.success === true && fs.existsSync(path.join(r3.destPath, 'CLIP', 'A.MOV')), 'a card with files is still copied');
  }

  // ── 8. The card re-read and the eject never freeze the app ───────────────
  console.log('\nthe card re-read counts as a running ingest, and diskutil never freezes the app');
  {
    // A stand-in diskutil that takes its time, first in the PATH. Both calls
    // exist on macOS: they run here as on a Mac.
    const bin = H.fresh('fake-bin');
    fs.writeFileSync(path.join(bin, 'diskutil'), '#!/bin/sh\nsleep 1\nexit 1\n', { mode: 0o755 });
    const realPath = process.env.PATH, realPlatform = process.platform;
    process.env.PATH = bin + path.delimiter + realPath;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const card = H.card(H.fresh('c-redo'), SMALL), d = H.fresh('d-redo');
      const redo = call('redo-double-read', { sourcePath: card, algo: 'xxh64', files: [{ rel: 'CLIP/A.MOV', hash: 'x' }] });
      let startErr = null;
      try { await ingest([src(card, 'A001')], [d], {}); } catch (e) { startErr = e; }
      ok(startErr && /already running/.test(startErr.message), 'START is refused while the card is being re-read');
      const r = await redo;
      ok(r && r.ok === false, 'the re-read ends (here: no card device found)');
      const after = (await ingest([src(card, 'A001')], [d], {}))[0];
      ok(after.success === true, 'and once it has ended, START works again');

      let ticks = 0;
      const timer = setInterval(() => ticks++, 50);
      const t0 = Date.now();
      const ej = await call('eject-volume', '/Volumes/NOPE');
      clearInterval(timer);
      ok(ej && ej.ok === false && Date.now() - t0 >= 900, 'an eject that takes a second reports its failure');
      ok(ticks >= 10, `and the app kept running meanwhile (${ticks} timer ticks in ${Date.now() - t0} ms)`);
    } finally {
      process.env.PATH = realPath;
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  }

  // ── 9. Cancel stops the Verify it was pressed for, and that one only ─────
  console.log('\nCancel during a Verify does not carry over to the next one');
  {
    const files = {}; for (let i = 0; i < 40; i++) files['CLIP/F' + String(i).padStart(2, '0') + '.MOV'] = 400000;
    const ca = H.card(H.fresh('c-va'), files), da = H.fresh('d-va');
    const cb = H.card(H.fresh('c-vb'), SMALL), db = H.fresh('d-vb');
    const ra = (await ingest([src(ca, 'A001')], [da], {}))[0];
    const rb = (await ingest([src(cb, 'B001')], [db], {}))[0];
    const pa = call('verify-folder', ra.destPath);
    await new Promise(r => setTimeout(r, 30));
    // Cancel, and a second Verify started in the same instant.
    const pc = call('cancel-verify');
    const pb = call('verify-folder', rb.destPath);
    await pc;
    const [va, vb] = await Promise.all([pa, pb]);
    ok(va.ok && va.canceled === true && va.matched < 40, `the Verify that was running stops (${va.matched} of 40 checked)`);
    ok(vb.ok && vb.canceled === false && vb.matched === 2, 'the Verify started after Cancel runs to the end');
    const vc = await call('verify-folder', ra.destPath);
    ok(vc.ok && vc.canceled === false && vc.matched === 40, 'and a later Verify of the first folder is not cancelled either');
  }

  // ── 10. One shape for every result ───────────────────────────────────────
  console.log('\na refusal and a run give results of the same shape');
  {
    const c = H.card(H.fresh('c-shape'), SMALL), d = H.fresh('d-shape');
    const run = (await ingest([src(c, 'A001')], [d], {}))[0];
    const refused = (await ingest([src(c, 'A001')], [d], {}))[0];   // the folder exists now: PF refusal
    const keys = o => Object.keys(o).sort().join(',');
    ok(refused.refused === true && run.refused === false, 'one is refused, the other ran');
    ok(keys(run) === keys(refused), 'and both carry exactly the same fields');
  }

  H.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); H.cleanup(); process.exit(2); });
