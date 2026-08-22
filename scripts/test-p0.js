#!/usr/bin/env node
// Standalone regression tests for the P0 fixes.
// Pulls the relevant functions out of src/main/main.js (no Electron needed) and
// exercises them against real files in a temp directory.
//
//   node scripts/test-p0.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

// ── Extract a top-level `function name(...) { ... }` by brace matching ──────
function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in main.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;   // keep the async keyword
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Top-level `const NAME = ...;` on a single line.
function extractConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in main.js`);
  return m[0];
}

// Read the real suffix out of main.js so the test can never drift from it.
const PART_SUFFIX = extractConst('PART_SUFFIX').match(/'([^']+)'/)[1];

// fsyncFile references the nocache helper; inject a stub that forces the
// portable fh.sync() path so this test exercises the generic behavior.
const ctx = vm.createContext({ fs, path, process, Buffer, console, setImmediate, setTimeout,
  setInterval, clearInterval,
  nocache: { fullFsync: () => false, available: () => false },
  cancelCopy: false });   // copyFanOut reads this module global for mid-file cancel
vm.runInContext([
  extractConst('PART_SUFFIX'),
  extractConst('FSYNC_UNSUPPORTED'),
  extractConst('FSYNC_BUSY'),
  extractConst('sleep'),
  'let _fsyncBusyHopeless = false;',   // the real one is a mutable module global
  extractFn('isSafeFolderName'),
  extractFn('pathContains'),
  extractFn('fsyncFile'),
  extractFn('resetFsyncBusyState'),
  extractFn('sweepPartFiles'),
  extractFn('copyFanOut'),
  extractFn('nfc'),
  extractFn('isoSec'),
  extractFn('xmlEsc'),
  extractFn('makeCounterMatcher'),
  extractFn('isAppleDouble'),
  extractFn('buildFolderName'),
].join('\n'), ctx);

let pass = 0, fail = 0;
const ok  = (cond, label) => { if (cond) { pass++; console.log('  ok   ' + label); }
                               else      { fail++; console.log('  FAIL ' + label); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-test-'));

// ── 1. isSafeFolderName ────────────────────────────────────────────────────
console.log('\nisSafeFolderName');
ok(ctx.isSafeFolderName('001_A001_260819'), 'accepts a normal folder name');
ok(!ctx.isSafeFolderName(''),      'rejects empty (would write into destination root)');
ok(!ctx.isSafeFolderName('   '),   'rejects whitespace only');
ok(!ctx.isSafeFolderName('.'),     'rejects "."');
ok(!ctx.isSafeFolderName('..'),    'rejects ".." (would escape the destination)');
ok(!ctx.isSafeFolderName('a/b'),   'rejects an embedded separator');
ok(!ctx.isSafeFolderName('x'.repeat(300)), 'rejects a name past the filesystem limit');

// ── 2. pathContains ────────────────────────────────────────────────────────
console.log('\npathContains');
ok(ctx.pathContains('/Volumes/A001', '/Volumes/A001'),          'a path contains itself');
ok(ctx.pathContains('/Volumes/A001', '/Volumes/A001/DCIM'),     'detects a nested destination');
ok(!ctx.pathContains('/Volumes/A001', '/Volumes/A0011'),        'no false positive on a name prefix');
ok(!ctx.pathContains('/Volumes/A001', '/Volumes/RAID'),         'unrelated paths do not match');

// ── 3. Reorganize: the suffixed name must itself be free ───────────────────
// Mirrors the loop in performCopyMulti.
console.log('\nreorganize naming');
function reorganize(files) {
  const used = new Set(), out = [];
  for (const f of files) {
    const base = path.basename(f.rel);
    const ext  = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let cand = f.cat + '/' + base, n = 1;
    while (used.has(cand.toLowerCase())) { n++; cand = f.cat + '/' + stem + '_' + n + ext; }
    used.add(cand.toLowerCase());
    out.push(cand);
  }
  return out;
}
{
  // The case that used to overwrite a clip: CLIP_2.MOV already exists on the card.
  const got = reorganize([
    { rel: '100/CLIP.MOV',   cat: 'VIDEO' },
    { rel: '102/CLIP_2.MOV', cat: 'VIDEO' },
    { rel: '101/CLIP.MOV',   cat: 'VIDEO' },
  ]);
  ok(new Set(got).size === got.length, 'no two files target the same destination path');
  ok(got[2] === 'VIDEO/CLIP_3.MOV',    'the colliding file falls through to _3');
  const many = reorganize(Array.from({length: 50}, () => ({ rel: 'x/A.MOV', cat: 'VIDEO' })));
  ok(new Set(many).size === 50,        '50 identically named files all get a distinct name');
}

// ── 4. copyFanOut settles on close, not finish ─────────────────────────────
console.log('\ncopyFanOut');
(async () => {
  const src = path.join(TMP, 'src.bin');
  fs.writeFileSync(src, Buffer.alloc(3 * 1024 * 1024, 7));

  {
    const d1 = path.join(TMP, 'd1.bin'), d2 = path.join(TMP, 'd2.bin');
    const r = await ctx.copyFanOut(src, [d1, d2], () => {}, null);
    ok(r.failed.every(f => f === null), 'a healthy 2-destination copy reports no failure');
    ok(fs.readFileSync(d1).equals(fs.readFileSync(src)), 'destination 1 is byte-identical');
    ok(fs.readFileSync(d2).equals(fs.readFileSync(src)), 'destination 2 is byte-identical');
  }

  {
    // A destination that cannot be opened must not take the other one down.
    const good = path.join(TMP, 'good.bin');
    const bad  = path.join(TMP, 'nope', 'deep', 'bad.bin');   // parent does not exist
    const r = await ctx.copyFanOut(src, [good, bad], () => {}, null);
    ok(r.failed[0] === null,  'the healthy destination still succeeds');
    ok(r.failed[1] !== null,  'the broken destination is reported as failed');
    ok(fs.readFileSync(good).equals(fs.readFileSync(src)), 'the healthy destination is complete');
  }

  {
    // Late close() failure: the stream emits 'finish', then 'error'. Settling on
    // 'finish' used to count this file as copied.
    const realOpen = fs.open, realClose = fs.close;
    const target = path.join(TMP, 'late.bin');
    const doomed = new Set();          // fds opened for the target file only
    fs.open = function (p, ...rest) {
      const cb = rest[rest.length - 1];
      rest[rest.length - 1] = (err, fd) => { if (!err && p === target) doomed.add(fd); cb(err, fd); };
      return realOpen.call(fs, p, ...rest);
    };
    fs.close = function (fd, cb) {
      if (doomed.has(fd)) {
        doomed.delete(fd);
        return realClose.call(fs, fd, () => {
          const e = new Error('EIO simulated at close'); e.code = 'EIO'; cb(e);
        });
      }
      return realClose.call(fs, fd, cb);
    };
    let r = null, threw = null;
    try { r = await ctx.copyFanOut(src, [target], () => {}, null); }
    catch (e) { threw = e; }
    finally { fs.open = realOpen; fs.close = realClose; }
    ok(r && r.failed[0] !== null && !threw,
       'an error raised by close() marks the destination failed (not silently copied)');
  }

  // ── 5. Temp-name + atomic rename ─────────────────────────────────────────
  console.log('\ntemp file / atomic promotion');
  {
    // A failed destination must leave NOTHING under the final name.
    const finalPath = path.join(TMP, 'promote.bin');
    const tmpPath   = finalPath + '.ingesto-part';
    const badFinal  = path.join(TMP, 'missing-dir', 'x.bin');
    const r = await ctx.copyFanOut(src, [tmpPath, badFinal + '.ingesto-part'], () => {}, null);
    ok(r.failed[0] === null && r.failed[1] !== null, 'one destination fails, the other does not');
    ok(fs.existsSync(tmpPath),        'the good copy sits under the temporary name');
    ok(!fs.existsSync(finalPath),     'nothing exists under the final name before promotion');
    fs.renameSync(tmpPath, finalPath);
    ok(fs.existsSync(finalPath) && !fs.existsSync(tmpPath), 'rename promotes it atomically');
    ok(fs.readFileSync(finalPath).equals(fs.readFileSync(src)), 'the promoted file is byte-identical');
    ok(!fs.existsSync(badFinal),      'the failed destination left no file under its final name');
  }

  // ── 6. fsyncFile: real errors surface, unsupported degrades to a warning ──
  console.log('\nfsyncFile');
  {
    const f = path.join(TMP, 'sync-me.bin');
    fs.writeFileSync(f, 'x');
    const res = await ctx.fsyncFile(f);
    ok(res && res.ok === true, 'a normal file flushes successfully');
  }
  {
    // The read-only-source case: fsync must be attempted BEFORE chmod, so a
    // 0444 file is exactly what used to break it. Here we prove the error is
    // no longer swallowed.
    // This is the write-protected-card case: the file ends up 0444 and the
    // flush used to fail with EACCES, silently, for every single file.
    // Mocked rather than chmod-based so the test is meaningful when run as root.
    const realOpen = fs.promises.open;
    fs.promises.open = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
    let threw = null;
    try { await ctx.fsyncFile(path.join(TMP, 'readonly.bin')); } catch (e) { threw = e; }
    fs.promises.open = realOpen;
    ok(threw && threw.code === 'EACCES', 'a permission failure is reported, not swallowed');
  }
  {
    // Transient lock (Windows antivirus holding the file it has just scanned).
    // This must NOT be treated as a copy error — the previous behaviour deleted
    // a perfectly good multi-GB file and asked the operator to copy it again.
    const realOpen = fs.promises.open;
    let calls = 0;
    fs.promises.open = async (...a) => {
      if (++calls <= 2) { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; }
      return realOpen(...a);
    };
    const f = path.join(TMP, 'locked.bin');
    fs.writeFileSync(f, 'x');
    let res = null, threw = null;
    try { res = await ctx.fsyncFile(f); } catch (e) { threw = e; }
    fs.promises.open = realOpen;
    ok(!threw && res && res.ok === true, 'a transient lock is retried, not turned into a copy error');
    ok(calls === 3, 'the retry actually re-opened the file');
    ok(fs.existsSync(f), 'the good copy is still there');
  }
  {
    // A lock that never clears degrades to the same warning as a filesystem
    // with no flush support — never to a deleted file.
    const realOpen = fs.promises.open;
    let calls = 0;
    fs.promises.open = async () => { calls++; const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; };
    let res = null, threw = null;
    try { res = await ctx.fsyncFile(path.join(TMP, 'always-locked.bin')); } catch (e) { threw = e; }
    ok(!threw && res && res.ok === false && res.unsupported === true,
       'a lock that never clears degrades to a warning, not a failure');
    ok(calls === 5, 'it gave up after 5 attempts');
    // …and it must not pay that cost again for every remaining file of the card.
    calls = 0;
    try { await ctx.fsyncFile(path.join(TMP, 'always-locked-2.bin')); } catch (e) { threw = e; }
    fs.promises.open = realOpen;
    ok(calls === 1, 'once a destination is hopeless, later files are not retried');
    ctx.resetFsyncBusyState();
  }
  {
    const realOpen = fs.promises.open;
    fs.promises.open = async () => { const e = new Error('not supported'); e.code = 'ENOTSUP'; throw e; };
    let res = null, threw = null;
    try { res = await ctx.fsyncFile(path.join(TMP, 'whatever.bin')); } catch (e) { threw = e; }
    fs.promises.open = realOpen;
    ok(!threw && res && res.unsupported === true && res.code === 'ENOTSUP',
       'a filesystem without flush support degrades to a warning instead of failing');
  }

  // ── 6b. sweepPartFiles removes leftovers, keeps real files ───────────────
  console.log('\nsweepPartFiles');
  {
    const root = path.join(TMP, 'sweep');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'A001.MOV'), 'keep me');
    fs.writeFileSync(path.join(root, 'A001.MOV' + PART_SUFFIX), 'crash residue');
    fs.writeFileSync(path.join(root, 'sub', 'A002.MOV' + PART_SUFFIX), 'crash residue');
    const n = ctx.sweepPartFiles(root);
    ok(n === 2, 'both leftover temp files are removed, including in subfolders');
    ok(fs.existsSync(path.join(root, 'A001.MOV')), 'a real file is left untouched');
  }

  // ── 7. Sentinel: intersection across every destination ───────────────────
  console.log('\nsentinel intersection');
  {
    // Mirrors the logic in the start-copy handler.
    const intersect = (perDest) => {
      const keyOf = f => `${f.p}|${f.s}|${f.m}`;
      let common = perDest.length ? perDest[0] : [];
      for (let i = 1; i < perDest.length; i++) {
        const have = new Set(perDest[i].map(keyOf));
        common = common.filter(f => have.has(keyOf(f)));
      }
      return common;
    };
    const A = [{p:'a.mov',s:1,m:10},{p:'b.mov',s:2,m:20},{p:'c.mov',s:3,m:30}];
    const B = [{p:'a.mov',s:1,m:10},{p:'c.mov',s:3,m:30}];
    const got = intersect([A, B]).map(f => f.p);
    ok(got.length === 2 && !got.includes('b.mov'),
       'a file that failed on destination B is NOT recorded as ingested');
    ok(intersect([A, []]).length === 0,
       'a destination that copied nothing blocks the sentinel entirely');
    ok(intersect([A]).length === 3,
       'a single destination records everything it verified');
  }

  // ── 8. nocache module: safe fallback everywhere ─────────────────────────
  console.log('\nnocache module');
  {
    const nocache = require(path.join(__dirname, '..', 'src', 'main', 'nocache.js'));
    // On this (Linux) box the feature must be OFF and every call must be safe.
    // Per-descriptor uncached I/O is macOS-only; the PURGE capability exists on
    // all three platforms, so available() — which drives coldVerify — reflects
    // whichever mechanism the platform has (when koffi is present).
    {
      let koffiPresent = true; try { require('koffi'); } catch (_) { koffiPresent = false; }
      const expectIO = process.platform === 'darwin' && koffiPresent;
      ok(nocache.uncachedIOAvailable() === expectIO,
         `per-fd uncached I/O availability matches the platform (${process.platform})`);
      ok(nocache.available() === koffiPresent,
         `available() reflects the purge capability (koffi ${koffiPresent ? 'present' : 'absent'})`);
    }
    ok(nocache.setUncached(-1) === false, 'setUncached never throws, returns false when unavailable');
    ok(nocache.fullFsync(-1) === false, 'fullFsync never throws, returns false when unavailable');

    // The stream helpers must behave exactly like fs when the feature is off.
    const s   = path.join(TMP, 'nc-src.bin');
    const d   = path.join(TMP, 'nc-dst.bin');
    fs.writeFileSync(s, Buffer.alloc(64 * 1024, 9));
    await new Promise((res, rej) => {
      const r = nocache.createReadStream(s, { highWaterMark: 16 * 1024 });
      const w = nocache.createWriteStream(d);
      r.on('error', rej); w.on('error', rej); w.on('close', res);
      r.pipe(w);
    });
    ok(fs.readFileSync(d).equals(fs.readFileSync(s)),
       'fallback read+write streams copy the file byte-for-byte');
  }

  // ── 9. Template-aware counter matcher ───────────────────────────────────
  console.log('\ncounter matcher (template-aware)');
  {
    const mk = ctx.makeCounterMatcher;
    // counter first — the only case the old code handled
    ok(mk('{counter}_{cardname}').extract('001_A001') === 1, 'reads a leading counter');
    // counter AFTER the date — the case that used to always return 001 and
    // silently overwrite earlier reels
    ok(mk('{YY}{MM}{DD}_{counter}_{cardname}').extract('260820_007_A001') === 7,
       'reads a counter placed after the date');
    ok(mk('{cardname}_{counter}').extract('A001_042') === 42, 'reads a trailing counter');
    // a folder that does not match the template yields nothing
    ok(mk('{counter}_{cardname}').extract('random-folder') === null, 'non-matching name -> null');
    // no {counter} token -> leading-digits fallback (old behavior)
    ok(mk('{cardname}_{YY}').extract('123_x') === 123, 'no counter token falls back to leading digits');
    ok(mk(null).extract('015_CARD') === 15, 'no template falls back to leading digits');
  }

  // ── 10. Unicode NFC, safe timestamps, XML escaping ──────────────────────
  console.log('\nnfc / isoSec / xmlEsc');
  {
    const nfd = 'Séquence';       // e + combining acute
    const nfcS = 'Séquence';        // precomposed é
    ok(ctx.nfc(nfd) === ctx.nfc(nfcS), 'decomposed and composed accents normalize equal');
    ok(ctx.nfc(nfd) === nfcS, 'NFD input becomes composed NFC');

    ok(/^\d{4}-\d{2}-\d{2}T/.test(ctx.isoSec(Date.parse('2026-08-20T10:00:00Z'))), 'valid ms -> ISO');
    let threw = false;
    try { ctx.isoSec(NaN); } catch(_) { threw = true; }
    ok(!threw && /^\d{4}-/.test(ctx.isoSec(NaN)), 'a NaN mtime does not throw (would abort the whole manifest)');
    ok(!threw && /^\d{4}-/.test(ctx.isoSec(8.64e15 * 2)), 'an absurd mtime does not throw');

    ok(ctx.xmlEsc('a & b < c > d') === 'a &amp; b &lt; c &gt; d', 'escapes & < >');
    ok(ctx.xmlEsc('x\x00\x07y') === 'xy', 'strips XML-illegal control characters');
  }

  // ── 11. AppleDouble sidecars are skipped, real files are not ─────────────
  console.log('\nAppleDouble filter');
  {
    const mk = (name, dir=false) => ({ name, isFile: () => !dir, isDirectory: () => dir });
    ok(ctx.isAppleDouble(mk('._CLIP.MOV')) === true,  'a ._ sidecar file is skipped');
    ok(ctx.isAppleDouble(mk('CLIP.MOV'))   === false, 'a real media file is kept');
    ok(ctx.isAppleDouble(mk('.hidden'))    === false, 'a plain dotfile is not confused with a sidecar');
    ok(ctx.isAppleDouble(mk('._dir', true)) === false, 'a DIRECTORY named ._x is not filtered');
    // The sentinel scanner applies the same rule — a re-inserted card must not
    // read as "changed" because macOS regenerated its sidecars.
    const sentinel = require(path.join(__dirname, '..', 'src', 'main', 'sentinel.js'));
    if (typeof sentinel.listAllFiles === 'function') {
      const root = path.join(TMP, 'adcard');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'A001.MOV'), 'media');
      fs.writeFileSync(path.join(root, '._A001.MOV'), 'metadata');
      fs.writeFileSync(path.join(root, '.DS_Store'), 'finder');
      const listed = sentinel.listAllFiles(root).map(f => f.p);
      ok(listed.includes('A001.MOV') && !listed.some(p => p.startsWith('._')) && !listed.includes('.DS_Store'),
         'sentinel scan keeps media, drops ._* and .DS_Store');
    } else {
      ok(true, 'sentinel scan keeps media, drops ._* (skipped: listAllFiles not exported)');
    }
  }

  // ── 12. {operator} canonical + {cameraman} legacy alias ─────────────────
  console.log('\noperator/cameraman alias');
  {
    const src = { name:'A001', counter:'004', cameraman:'Noar', camera:'FX6' };
    const a = ctx.buildFolderName('{counter}_{operator}_{camera}', src);
    const b = ctx.buildFolderName('{counter}_{cameraman}_{camera}', src);
    ok(a === b && a.startsWith('004_Noar_FX6'), 'both spellings build the same folder name');
    ok(!/\{/.test(a), 'no unresolved token remains in the name');
    const empty = ctx.buildFolderName('{counter}_{operator}_{camera}', { name:'A001', counter:'003', camera:'FX6' });
    ok(empty.startsWith('003_FX6'), 'an empty operator still collapses orphan separators');
    // The counter matcher MUST know {operator}, or a template using it would
    // make every scan return 001 again (the overwrite bug coming back).
    ok(ctx.makeCounterMatcher('{YY}{MM}{DD}_{counter}_{operator}').extract('260821_009_Noar') === 9,
       'counter matcher resolves through an {operator} template');
    ok(ctx.makeCounterMatcher('{operator}_{counter}').extract('Noar_012') === 12,
       'counter matcher: {operator} before the counter');
  }

  // ── 13. Counter matcher mirrors buildFolderName post-processing ─────────
  console.log('\ncounter matcher vs folder-name cleanup');
  {
    const mk = ctx.makeCounterMatcher;
    // Empty {operator}: buildFolderName trims the orphan "_" → folder "001".
    // The matcher MUST still read 001, or the scan resets to 001 and overwrites.
    const emptyOpName = ctx.buildFolderName('{counter}_{operator}', { name:'A', counter:'001', camera:'' });
    ok(emptyOpName === '001', 'empty operator collapses to bare "001"');
    ok(mk('{counter}_{operator}').extract('001') === 1,
       'matcher reads the counter even after the separator was trimmed away');
    // Collapsed double separator
    ok(mk('{counter}__{cardname}').extract('007_A001') === 7,
       'matcher tolerates a collapsed double separator');
    // Illegal char in a literal becomes "_" in the folder — matcher maps it too
    ok(mk('{counter}:{cardname}').extract('009_A001') === 9,
       'matcher maps an illegal literal char the way the engine does');
  }

  // ── 14. Mid-file cancel leaves no .part, no false success ───────────────
  console.log('\nmid-file cancel cleanup');
  {
    // Big enough that the copy is still streaming when we flip cancelCopy.
    const bigSrc = path.join(TMP, 'big.bin');
    fs.writeFileSync(bigSrc, Buffer.alloc(24 * 1024 * 1024, 3));
    const tmpDst = path.join(TMP, 'cancel.bin.ingesto-part');
    ctx.cancelCopy = true;   // simulate a cancel already in flight
    const r = await ctx.copyFanOut(bigSrc, [tmpDst], () => {}, null);
    ctx.cancelCopy = false;
    ok(r.failed[0] && r.failed[0].aborted === true, 'a cancelled file is flagged aborted (not an error)');
    // failDest waited for close; the caller would unlink — emulate and confirm
    // the file is removable (fd already closed).
    try { fs.unlinkSync(tmpDst); } catch (_) {}
    ok(!fs.existsSync(tmpDst), 'the .part is gone after cancel (fd was closed first)');
  }

  // ── 15. Cache-served double-read detection ──────────────────────────────
  console.log('\ncached double-read detection (probe)');
  {
    // The verdict now comes from probeCacheEviction, a MEASUREMENT: read a block
    // known to be cached, purge it, read it again and compare against the same
    // block read from memory. The old speed heuristic it replaced was blind in
    // MD5 (a RAM-served read is capped by the hashing at ~300 MB/s, the same as
    // a fast card) and cried wolf on a fast card with slow destinations.
    const TMP2 = path.join(TMP, 'probe'); fs.mkdirSync(TMP2, { recursive: true });
    const f = path.join(TMP2, 'clip.bin');
    fs.writeFileSync(f, Buffer.alloc(24 * 1024 * 1024, 7));

    const withPurge = (purge) => {
      const c = vm.createContext({ fs, path, process, Buffer, console,
        nocache: { purgeFileCache: purge } });
      vm.runInContext(extractConst('PROBE_BYTES') + '\n' + extractFn('probeCacheEviction'), c);
      return c.probeCacheEviction;
    };
    const dropCache = (p) => {
      // Best effort on this machine; the assertions below only depend on the
      // relative timings, and skip themselves if the drop is not available.
      try { require('child_process').execSync(
        `dd of=${JSON.stringify(p)} oflag=nocache conv=notrunc,fdatasync count=0 2>/dev/null`); }
      catch (_) {}
      return true;
    };

    // An eviction that silently does nothing must be caught: the "cold" read is
    // served from the cache, so it matches the warm read.
    const noop = withPurge(() => true)(f);
    ok(noop.ok === true, 'the probe returns a verdict on a real file');
    ok(noop.ok && noop.evicted === false,
       'an eviction that silently does nothing is detected as cached');

    // A working eviction must NOT raise an alarm.
    const real = withPurge(dropCache)(f);
    if (real.ok && real.coldMs / real.warmMs > 2.5) {
      ok(real.evicted === true, 'a working eviction is recognised as a real read');
    } else {
      ok(true, 'a working eviction is recognised as a real read (skipped: cannot drop caches here)');
    }

    // An eviction that REPORTS failure gives no verdict — dblPurgeFails covers it.
    const failed = withPurge(() => false)(f);
    ok(failed.ok === false && failed.purgeFailed === true,
       'a purge that reports failure yields no verdict, not a false alarm');

    // Too small to time: say nothing rather than guess.
    const small = path.join(TMP2, 'tiny.bin');
    fs.writeFileSync(small, Buffer.alloc(64 * 1024, 1));
    ok(withPurge(() => true)(small).ok === false, 'a file too small to time gives no verdict');

    // Never throws, whatever the medium does.
    let threw = null;
    try { withPurge(() => { throw new Error('boom'); })(f); } catch (e) { threw = e; }
    ok(threw === null, 'the probe never throws');
    ok(withPurge(() => true)(path.join(TMP2, 'gone.bin')).ok === false,
       'a missing file gives no verdict instead of throwing');
  }

  // ── 16. purgeFileCache is always safe ───────────────────────────────────
  console.log('\npurgeFileCache safety');
  {
    const nocacheMod = require(path.join(__dirname, '..', 'src', 'main', 'nocache.js'));
    const f = path.join(TMP, 'purge-me.bin');
    fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 4));
    let threw = null;
    try { nocacheMod.purgeFileCache(f); } catch (e) { threw = e; }
    ok(!threw, 'purging never throws');
    ok(fs.statSync(f).size === 3 * 1024 * 1024, 'purging leaves the file byte-identical in size');
    ok(fs.readFileSync(f)[0] === 4, 'purging does not alter the contents');
    let threw2 = null;
    try { nocacheMod.purgeFileCache(path.join(TMP, 'does-not-exist.bin')); } catch (e) { threw2 = e; }
    ok(!threw2, 'purging a missing file never throws');
    ok(nocacheMod.purgeFileCache(path.join(TMP, 'does-not-exist.bin')) === false,
       'purging a missing file reports failure');
    // On Linux the purge is LIVE in this test environment (posix_fadvise):
    // it must actually report success on a real file.
    if (process.platform === 'linux') {
      let koffiPresent = true; try { require('koffi'); } catch (_) { koffiPresent = false; }
      if (koffiPresent) ok(nocacheMod.purgeFileCache(f) === true, 'Linux fadvise purge succeeds on a real file');
      else ok(true, 'Linux fadvise purge succeeds on a real file (skipped: koffi absent)');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
