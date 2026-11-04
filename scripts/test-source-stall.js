#!/usr/bin/env node
// A source that stops answering (2.9.2).
//
// A card reader that hangs, or the "_hde" volume of Codex Device Manager when
// its encoder stalls, does not fail: it never answers. ingesto used to wait
// for ever (asynchronous reads) or freeze entirely (synchronous calls). Every
// read of the source now has a deadline, and once it is missed the card is
// not asked anything else during the run.
//
// This test runs the real helpers against streams and calls that never come
// back, with a deadline shortened to a fraction of a second, and checks the
// engine's own code for the places that must go through them.
//
//   node scripts/test-source-stall.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const { Readable } = require('stream');

const SRC = require('./lib/source').ENGINE;

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in main.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in main.js`);
  return m[0];
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A call that hangs is the bug this test looks for: it must fail, not freeze.
const orHang = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('still waiting after ' + ms + ' ms'); })]);

// A source that gives `chunks` chunks, then never anything again.
function silentAfter(chunks) {
  let n = 0;
  return new Readable({ read() { if (n < chunks) { n++; this.push(Buffer.alloc(1024, 7)); } } });
}

// What the fake fs answers: the real one, except for the paths listed here.
const hung = new Set();
let statCalls = 0;
const fakeFs = Object.assign({}, fs, {
  promises: Object.assign({}, fs.promises, {
    stat: (p) => { statCalls++; return hung.has(p) ? new Promise(() => {}) : fs.promises.stat(p); },
  }),
  createReadStream: (p, o) => (p.startsWith('SILENT:') ? silentAfter(+p.slice(7)) : fs.createReadStream(p, o)),
});

const ctx = vm.createContext({
  fs: fakeFs, path, console, Buffer, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  process: { env: {} },          // the real deadline, not a shortened one
  ctl: { cancelCopy: false },
  safeWriteTarget: (p) => p,
  nocache: { createReadStream: (p, o) => fakeFs.createReadStream(p, o), createWriteStream: fs.createWriteStream },
});
vm.runInContext([
  extractConst('SOURCE_STALL_MS'),
  extractConst('_ioInFlight'),
  extractFn('settleWithin'),
  extractFn('statWithin'),
  extractFn('stallError'),
  extractFn('stallWatch'),
  extractFn('hashPro'),
  extractFn('copyFanOut'),
  'this.SOURCE_STALL_MS = SOURCE_STALL_MS; this._ioInFlight = _ioInFlight;',
].join('\n'), ctx);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-stall-'));
const fakeHasher = () => ({ init(){}, update(){}, digest(){ return 'h'; } });

// ── Real ingests on named pipes, in a child process ───────────────────────
// A pipe announces 0 bytes and delivers what its writer sends, or nothing at
// all: a card that stops answering, or a volume produced on read, without
// FUSE. The engine runs in a child with INGESTO_STALL_MS=400 and a time
// limit, so a regression that hangs is a failure, not a frozen test.
const { spawnSync, spawn } = require('child_process');
function runChild(scenario) {
  if (process.platform === 'win32') return { skipped: 'named pipes are not available on Windows: the engine scenarios run on macOS and Linux' };
  const r = spawnSync(process.execPath, [__filename, '--child', scenario], {
    env: Object.assign({}, process.env, { INGESTO_STALL_MS: '400' }), encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return { results: [], error: 'the child ended with status ' + r.status + (r.signal ? ' (' + r.signal + ')' : '') + '\n' + (r.stderr || '').slice(-800) };
  const line = (r.stdout || '').split('\n').filter(l => l.startsWith('{')).pop();
  try { return JSON.parse(line); } catch (_) { return { results: [], error: 'no JSON from the child: ' + (r.stdout || '').slice(-400) } };
}
async function childMain(scenario) {
  const H = require('./lib/harness');
  const { call } = H.loadMain({ version: 'test' });
  const writers = [];
  const fifo = (p, feed) => {
    spawnSync('mkfifo', [p]);
    // `sh -c` keeps the pipe's writer alive for the whole feed: cat for a
    // file, printf + sleep for a pipe that gives one byte and goes silent.
    // Its own process group, so that the whole feed (sh and its sleep) can
    // be killed at the end: a writer left alive keeps the pipe open, and a
    // read blocked on it keeps this process from exiting.
    writers.push(spawn('sh', ['-c', '(' + feed + ') > ' + JSON.stringify(p)], { stdio: 'ignore', detached: true }));
  };
  const src = (dir, name, extra) => Object.assign({ name, path: dir, counter: '001', cameraman: 'n', camera: '', pp: '', note: '' }, extra);
  const ingest = (c, name, d, o) => call('start-copy', { sources: [src(c, name)], destinations: [{ name: 'D1', path: d }],
    options: Object.assign({ mode: 'fast', proAlgo: 'xxh64', proDoubleRead: false, folderTemplate: '{cardname}',
      writeSentinel: false, writeChecksum: true, cksumList: true, cksumMhl: true, ascMhl: false, fileFilter: null }, o) });
  let out = {};
  try {
    if (scenario === 'copy-stall') {
      const c = H.fresh('stall-card'), d = H.fresh('stall-dest');
      fs.writeFileSync(path.join(c, 'A.txt'), 'one');
      fifo(path.join(c, 'B.mxf'), 'printf x; sleep 30');
      fs.writeFileSync(path.join(c, 'C.txt'), 'three');
      const t0 = Date.now();
      const results = await ingest(c, 'STALL', d, { mode: 'fast' });
      out = { ms: Date.now() - t0, results: results.map(r => ({ success: r.success, copiedFiles: r.copiedFiles, errorList: r.errorList, failedFiles: r.failedFiles })),
              destFiles: fs.existsSync(path.join(d, 'STALL')) ? fs.readdirSync(path.join(d, 'STALL')).sort() : [] };
    } else if (scenario === 'hde') {
      const feed = H.fresh('hde-feed');
      fs.writeFileSync(path.join(feed, 'C001.mxf'), H.bytes('C001', 300000));
      fs.writeFileSync(path.join(feed, 'C002.mxf'), H.bytes('C002', 120000));
      const slim = (r) => ({ success: r.success, errors: r.errors, copiedFiles: r.copiedFiles, proDoubleRead: r.proDoubleRead,
                             verify2Ms: r.verify2Ms, notes: r.notes, errorList: r.errorList });
      for (const m of ['fast', 'normal', 'slow', 'pro']) {
        // The volume's own name ends in "_hde", as CODEX Platform names it.
        const c = path.join(H.fresh('hde-' + m), 'A003_hde'), d = H.fresh('hde-dest-' + m);
        fs.mkdirSync(c);
        fifo(path.join(c, 'C001.mxf'), 'cat ' + JSON.stringify(path.join(feed, 'C001.mxf')));
        fifo(path.join(c, 'C002.mxf'), 'cat ' + JSON.stringify(path.join(feed, 'C002.mxf')));
        const r = (await ingest(c, 'A003_hde', d, { mode: m, proDoubleRead: m === 'pro', writeSentinel: true }))[0];
        out[m] = slim(r);
        const dd = path.join(d, 'A003_hde');
        out[m].delivered = fs.existsSync(path.join(dd, 'C001.mxf')) && fs.statSync(path.join(dd, 'C001.mxf')).size === 300000
          && fs.readFileSync(path.join(dd, 'C002.mxf')).equals(H.bytes('C002', 120000));
        if (m === 'pro') {
          const mhl = fs.readdirSync(dd).find(f => f.endsWith('.mhl'));
          out.manifestSizes = !!mhl && /<size>300000<\/size>/.test(fs.readFileSync(path.join(dd, mhl), 'utf8'));
          out.sentinelWritten = fs.existsSync(path.join(c, '.ingesto.json'));
          out.inspect = await call('inspect-card', c, true, [d]);
          out.camera = await call('detect-camera', c);
          // The unmount-and-re-read check exists on macOS only: run it as on
          // a Mac, so that what it says about this volume is what is checked.
          const realPlatform = process.platform;
          Object.defineProperty(process, 'platform', { value: 'darwin' });
          try { out.redo = await call('redo-double-read', { sourcePath: c, algo: 'xxh64', files: [{ rel: 'C001.mxf', hash: 'x' }] }); }
          finally { Object.defineProperty(process, 'platform', { value: realPlatform }); }
        }
      }
    }
  } finally {
    for (const w of writers) { try { process.kill(-w.pid, 'SIGKILL'); } catch (_) {} }
    H.cleanup();
  }
  console.log(JSON.stringify(out));
}
if (process.argv[2] === '--child') {
  childMain(process.argv[3]).then(() => process.exit(0), e => { console.error(e); process.exit(1); });
  return;
}

// The engine's timers do not keep the process alive (unref), and neither do
// the calls that never come back: this one does, for the test's duration.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('\nthe deadline');
  {
    ok(ctx.SOURCE_STALL_MS >= 30000 && ctx.SOURCE_STALL_MS <= 120000,
       `a card is given ${ctx.SOURCE_STALL_MS / 1000} s before it is called silent (between 30 s and 2 min)`);
    const t0 = Date.now();
    const r = await ctx.settleWithin('k1', () => new Promise(() => {}), 150);
    ok(r.timeout === true && Date.now() - t0 < 1000, 'a call that never comes back is abandoned at the deadline');
    let calls = 0;
    const r2 = await ctx.settleWithin('k1', () => { calls++; return 1; }, 150);
    ok(r2.timeout === true && calls === 0,
       'the same call is not started a second time while the first one is still stuck');
    const r3 = await ctx.settleWithin('k2', () => 42, 150);
    const r4 = await ctx.settleWithin('k3', () => { throw new Error('ENOENT'); }, 150);
    ok(r3.v === 42 && r4.err && r4.err.message === 'ENOENT', 'an answer, or an error, comes back as it is');
    ok(!ctx._ioInFlight.has('k2') && !ctx._ioInFlight.has('k3'), 'an answered call does not block the next one');
  }

  console.log('\nstatWithin');
  {
    const f = path.join(tmp, 'a.bin'); fs.writeFileSync(f, 'abc');
    const a = await ctx.statWithin(f, 500);
    ok(a.v && a.v.size === 3, 'a file that answers is measured');
    hung.add('/Volumes/A003_hde/C001.mxf');
    const b = await ctx.statWithin('/Volumes/A003_hde/C001.mxf', 150);
    ok(b.timeout === true, 'a file that does not answer times out');
    const before = statCalls;
    const c = await ctx.statWithin('/Volumes/A003_hde/C001.mxf', 150);
    ok(c.timeout === true && statCalls === before, 'and is not asked again while the first call is stuck');
  }

  console.log('\nstallWatch');
  {
    let fired = 0;
    const s1 = silentAfter(1); s1.on('data', () => {});
    ctx.stallWatch(s1, 150, () => fired++);
    await sleep(450);
    ok(fired === 1, 'a stream that stops giving data is reported, once');
    let fired2 = 0;
    const s2 = silentAfter(1); s2.on('data', () => {}); s2.pause();
    ctx.stallWatch(s2, 150, () => fired2++);
    await sleep(450);
    ok(fired2 === 0, 'a stream paused on purpose (a destination still writing) is not the card going silent');
    let fired3 = 0;
    const s3 = Readable.from([Buffer.alloc(10)]); s3.on('data', () => {});
    ctx.stallWatch(s3, 150, () => fired3++);
    await sleep(450);
    ok(fired3 === 0, 'a stream that ends normally is not reported');
  }

  console.log('\ncopyFanOut: the card goes silent in the middle of a file');
  {
    const dest = path.join(tmp, 'C007.mxf.ingesto-part');
    const t0 = Date.now();
    let err = null;
    try { await orHang(ctx.copyFanOut('SILENT:3', [dest], () => {}, null, 200), 3000); } catch (e) { err = e; }
    ok(err && err.stalled === true && /stopped answering/.test(err.message),
       `the copy gives up with "the card stopped answering" (${err ? err.message : 'no error'})`);
    ok(Date.now() - t0 < 2000, 'and does not wait for ever');
    let gone = false; try { fs.unlinkSync(dest); gone = true; } catch (_) { gone = !fs.existsSync(dest); }
    ok(gone, 'the partial file can be removed');
    const good = path.join(tmp, 'good.bin'); fs.writeFileSync(good, Buffer.alloc(3 * 1024 * 1024, 1));
    const out = path.join(tmp, 'good.copy');
    const res = await ctx.copyFanOut(good, [out], () => {}, null, 200);
    ok(res && fs.statSync(out).size === 3 * 1024 * 1024, 'a card that answers is copied as before');
  }

  console.log('\nhashPro: the card re-read is watched, the read-back on a drive is not');
  {
    let err = null;
    try { await orHang(ctx.hashPro('SILENT:2', fakeHasher(), { stallMs: 200 }), 3000); } catch (e) { err = e; }
    ok(err && err.stalled === true, 'a card re-read that goes silent ends with "the card stopped answering"');
    const watched = /if \(opts && opts\.stallMs\) stallWatch\(s,/.test(extractFn('hashPro'));
    ok(watched, 'only when asked to: the destination read-back passes no deadline');
  }

  console.log('\nthe engine, on a card that stops answering (real ingest, deadline shortened)');
  {
    // Run in a child process with the deadline set to 400 ms and a time
    // limit: a regression that waits for ever shows up as a failure here, not
    // as a hung test. Needs named pipes (mkfifo): skipped on Windows.
    const r = runChild('copy-stall');
    if (r.skipped) { console.log('  --   ' + r.skipped); }
    else if (r.error) { ok(false, 'the scenario did not finish (a hang is a regression): ' + r.error.split('\n')[0]); }
    else {
      const res = r.results && r.results[0];
      ok(!!res && res.success === false, `the ingest ends, and not green (${r.ms} ms)`);
      ok(r.ms < 5000, 'without waiting for the 60 s the application gives a card');
      const errs = (res && res.errorList) || [];
      const stalled = errs.find(e => e.file === 'B.mxf');
      ok(!!stalled && stalled.stalled === true && /stopped answering/.test(stalled.error),
         'the file the card went silent on says "the card stopped answering"');
      const after = errs.find(e => e.file === 'C.txt');
      ok(!!after && after.stalled === true && /not copied/.test(after.error),
         'the file after it is listed as not copied, without being asked for');
      ok(res && res.copiedFiles === 1 && (res.failedFiles || []).join() === 'B.mxf,C.txt',
         'the file before it was copied; the two others are in the retry list');
      ok(r.destFiles.join() === 'A.txt', 'and only that one is on the drive (no partial file)');
    }
  }

  console.log('\nthe engine, on a volume produced on read (real ingest through named pipes)');
  {
    // Files that announce 0 bytes and deliver their content when read, in a
    // folder named "_hde": what CODEX Platform does for HDE. Every mode must
    // end green with the delivered bytes on the drive.
    const r = runChild('hde');
    if (r.skipped) { console.log('  --   ' + r.skipped); }
    else if (r.error) { ok(false, 'the scenario did not finish (a hang is a regression): ' + r.error.split('\n')[0]); }
    else {
      for (const m of ['fast', 'normal', 'slow', 'pro']) {
        const x = r[m];
        ok(x && x.success === true && x.errors === 0 && x.copiedFiles === 2,
           `${m}: green, both files copied (${x && JSON.stringify((x.errorList || []).map(e => e.error.slice(0, 60)))})`);
        ok(x && x.delivered === true, `${m}: the drive holds the delivered bytes, not the 0 bytes announced`);
      }
      ok(r.pro.proDoubleRead === false && r.pro.verify2Ms === 0, 'PRO: the card re-read is off (it would only produce the files again)');
      ok((r.pro.notes || []).some(n => n.code === 'HDE') && (r.pro.errorList || []).some(e => e.phase === 'warning' && /Virtual volume/.test(e.error)),
         'the window and the report say what such a copy proves');
      ok(/checked against what it delivered/.test(r.pro.errorList.map(e => e.error).join(' ')) &&
         !/checked against/.test(r.fast.errorList.map(e => e.error).join(' ')),
         'and FAST is not credited with a check it did not make');
      ok(r.manifestSizes === true, 'PRO: the manifest records the delivered sizes');
      ok(r.sentinelWritten === false, 'no card log is written on such a volume, even with Card Tracking on');
      ok(r.inspect === null && r.camera === null, 'neither the card inspection (write probe) nor the camera detection touch it');
      ok(r.redo && r.redo.ok === false && /virtual/.test(r.redo.error || ''), 'the unmount-and-re-read check refuses it (there is no card behind it)');
    }
    const REND = require('./lib/source').RENDERER;
    ok(/if \(isHdeSource\(entry\.path\)\) warnHdeSource\(entry\);/.test(REND) &&
       /if\(z==='src' && r && r\[0\] && r\[0\]\.virtual === true\)\{ entry\._virtual = true; warnHdeSource\(entry\); \}/.test(REND),
       'the window warns when such a card is loaded, by name or when the system says so (read in the page; its own test comes with the renderer modules)');
  }

  console.log('\nthe volume list (macOS): a volume that does not answer no longer freezes it');
  {
    const asked = [];
    const vctx = vm.createContext({
      console, Promise, setTimeout, clearTimeout, String, Array, Set, Map, parseInt, Number,
      process: { platform: 'darwin', env: {} }, isHdeSource: require('../src/shared/sources').isHdeSource,
      tryExecFile: async (cmd, args) => {
        asked.push(cmd + ' ' + args.join(' '));
        if (cmd === 'mount') return [
          '/dev/disk4s1 on /Volumes/A003 (exfat, local, nodev, nosuid, noowners)',
          'codex@macfuse0 on /Volumes/A003_hde (macfuse, nodev, nosuid, synchronous, mounted by noar)',
          '/dev/disk5s1 on /Volumes/HUNG (exfat, local, nodev, nosuid)',
        ].join('\n');
        if (cmd === 'df') return 'Filesystem 1024-blocks Used Available\n/dev/x 1000 400 600 40% /';
        return '';
      },
      fs: {
        readdirSync: (p) => (p === '/Volumes' ? ['A003', 'A003_hde', 'HUNG'] : []),
        statSync: (p) => { if (p === '/') return { dev: 1 }; throw new Error('a synchronous call on ' + p); },
        promises: { stat: (p) => (p === '/Volumes/HUNG' ? new Promise(() => {})
                                                         : Promise.resolve({ isDirectory: () => true, dev: 2 })) },
      },
      detectCamera: (p) => { asked.push('detect ' + p); return null; },
      getMountedVolumesWin: async () => [], getMountedVolumesLinux: () => [],
    });
    vm.runInContext([
      extractConst('SOURCE_STALL_MS'), extractConst('_ioInFlight'),
      // The real deadline is 3 s; the test does not wait that long.
      'const VOLUME_PROBE_MS = 200;',
      extractFn('settleWithin'), extractFn('statWithin'), extractFn('isVirtualMountType'), extractFn('getMountedVolumes'),
    ].join('\n'), vctx);
    const t0 = Date.now();
    const vols = await orHang(vctx.getMountedVolumes(), 3000).catch(e => { console.log('    ' + e.message); return []; });
    const by = {}; vols.forEach(v => { by[v.name] = v; });
    ok(vols.length === 3 && Date.now() - t0 < 2000, 'the list comes back, all three volumes in it');
    ok(by.HUNG && by.HUNG.unresponsive === true,
       'the volume that does not answer is listed as such, not dropped (a card dropped mid-ingest reads as pulled out)');
    ok(by.A003_hde && by.A003_hde.isVirtual === true && by.A003_hde.hde === true && by.A003 && by.A003.hde === false,
       'the Codex volume is seen as virtual and as HDE, the card itself as neither');
    ok(!asked.includes('detect /Volumes/A003_hde') && !asked.includes('detect /Volumes/HUNG') && asked.includes('detect /Volumes/A003'),
       'the camera is not looked for on a virtual volume, nor on one that does not answer');
    ok(extractConst('VOLUME_PROBE_MS') === 'const VOLUME_PROBE_MS = 3000;', 'the real deadline for the volume list is 3 s');
    const watch = extractFn('startVolumeWatch');
    const win = watch.slice(watch.indexOf("process.platform === 'win32'"));
    ok(!/statSync/.test(win) && /statWithin\(l \+ ':\\\\', VOLUME_PROBE_MS\)/.test(win),
       'Windows: the drive letters are polled with a deadline, no synchronous call every 2 s');
  }

  console.log('\nthe HDE rule: one copy, used by the engine and the window');
  {
    const REND = require('./lib/source').RENDERER;
    const { isHdeSource } = require('../src/shared/sources');
    const mainFiles = require('./lib/source').files('main');
    ok(mainFiles.some(f => /require\('\.\.\/shared\/sources'\)/.test(f.text)) &&
       !mainFiles.some(f => /^\s*function isHdeSource\(/m.test(f.text)),
       'the engine requires the shared rule and has no copy of its own');
    ok(/<script src="\.\.\/shared\/sources\.js"><\/script>/.test(REND) && !/function isHdeSource\(/.test(REND),
       'the window loads the same file and has no copy either');
    ok(isHdeSource('/Volumes/A003_hde') && isHdeSource('/Volumes/A003_HDE/A003C001') && isHdeSource('E:\\A003_hde\\x') &&
       isHdeSource('A003_hde') && !isHdeSource('/Volumes/A003') && !isHdeSource('/Volumes/hde') &&
       !isHdeSource('/Volumes/my_hdee') && !isHdeSource('') && !isHdeSource(null),
       'a volume or a folder inside it is HDE; a name that only contains "hde" is not');
  }

  console.log('\nwhich volume is virtual: the mount table, not the name');
  {
    const mk = (platform, mountOut, procMounts) => {
      const c = vm.createContext({ console, Promise, String, Array, path, parseInt,
        process: { platform },
        tryExecFile: async (cmd) => (cmd === 'mount' ? mountOut : ''),
        fs: { promises: { readFile: async () => { if (procMounts == null) throw new Error('ENOENT'); return procMounts; } } },
      });
      vm.runInContext([extractFn('readMountTable'), extractFn('isVirtualMountType'), extractFn('mountOfPath'), extractFn('isVirtualSource')].join('\n'), c);
      return c;
    };
    const MAC = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk4s1 on /Volumes/A003R2GR (udf, local, nodev, nosuid, read-only, noowners)',
      'CODEX on /Volumes/A003R2GR_hde (macfuse, nodev, nosuid, synchronous, mounted by noar)',
      'codexfs@1 on /Volumes/A001R01D (macfuse, nodev, nosuid, synchronous, mounted by noar)',
      '/dev/disk5s1 on /Volumes/SD CARD (msdos, local, nodev, nosuid, noowners)',
      '//noar@nas/rushes on /Volumes/rushes (smbfs, nodev, nosuid, mounted by noar)',
    ].join('\n');
    const mac = mk('darwin', MAC, null);
    const v = async (p) => mac.isVirtualSource(p);
    ok(await v('/Volumes/A001R01D') && await v('/Volumes/A001R01D/A001C001_210101_R01D.mxf'),
       'an ALEXA LF card served by CODEX Platform is virtual, under its usual name, and so is a folder inside it');
    ok(await v('/Volumes/A003R2GR_hde'), 'the "_hde" volume of a CFast card is virtual');
    ok(!(await v('/Volumes/A003R2GR')) && !(await v('/Volumes/SD CARD/DCIM')) && !(await v('/Volumes/rushes')) && !(await v('/Users/noar/Desktop/CARD')),
       'an ordinary card (UDF, FAT, exFAT), a network share and a folder on the Mac are not');
    ok(!(await v('/Volumes/A001R01D2')), 'a mount point is matched by whole name: A001R01D2 is not inside A001R01D');
    const lin = mk('linux', '', [
      '/dev/sdb1 /media/noar/NTFS_SSD fuseblk rw,nosuid,nodev,relatime 0 0',
      '/dev/sdc1 /media/noar/EOS_DIGITAL fuseblk rw,nosuid,nodev 0 0',
      'sshfs#noar@nas: /mnt/nas fuse.sshfs rw 0 0',
      'Codex /media/noar/A001_hde\\040x fuse rw 0 0',
    ].join('\n'));
    ok(!(await lin.isVirtualSource('/media/noar/NTFS_SSD')) && !(await lin.isVirtualSource('/media/noar/EOS_DIGITAL/DCIM')),
       'Linux: an NTFS or exFAT drive read through FUSE (fuseblk) is an ordinary disk, not virtual');
    ok(await lin.isVirtualSource('/mnt/nas/x') && await lin.isVirtualSource('/media/noar/A001_hde x'),
       'Linux: a FUSE volume served by a program is virtual (mount points with spaces read correctly)');
    const win = mk('win32', 'C:\\ on / (macfuse)', null);
    ok(!(await win.isVirtualSource('E:\\A001')), 'Windows: never (CODEX Platform does not exist there)');
    const broken = mk('darwin', '', null);
    ok(!(await broken.isVirtualSource('/Volumes/A001R01D')), 'no mount table: treated as an ordinary card, as before');
    ok(/return Object\.assign\(\{\}, res, \{ virtual: virtualOf\(p\) \}\);/.test(SRC),
       'check-paths tells the window which paths are virtual');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  clearInterval(keepAlive);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
