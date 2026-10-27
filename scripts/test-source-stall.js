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

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

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
  cancelCopy: false,
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

  console.log('\nthe engine goes through them');
  {
    const eng = extractFn('performCopyMulti');
    const scanStart = eng.indexOf('async function scan(dir)');
    const scanBody = eng.slice(scanStart, eng.indexOf('totalFiles = allFiles.length', scanStart));
    ok(scanStart > 0 && !/readdirSync|statSync/.test(scanBody),
       'the scan of the card makes no synchronous call');
    ok(/settleWithin\('readdir:'/.test(scanBody) && /statWithin\(full, SOURCE_STALL_MS\)/.test(scanBody),
       'it lists and measures with a deadline');
    const copyStart = eng.indexOf('PHASE 1');
    const copy = eng.slice(copyStart, eng.indexOf('tCopyEnd = Date.now()', copyStart));
    ok(/if \(sourceStalled\) \{ failRemaining\(i, act\); break; \}/.test(copy),
       'once the card is silent, the files left are reported and not asked for');
    const pre = copy.indexOf('statWithin(file.src, SOURCE_STALL_MS)'), purge = copy.indexOf('purgeFileCache(file.src)');
    ok(pre > 0 && purge > pre, 'the card is asked, with a deadline, before the purge opens the file synchronously');
    ok(/copyFanOut\(file\.src, destTmpAbs, onB, hasher, SOURCE_STALL_MS\)/.test(copy), 'the copy itself is watched');
    ok(!/statSync\(file\.src\)/.test(copy), 'no synchronous measure of the card after the copy');
    ok(/if \(e && e\.stalled\) sourceStalled = e;/.test(copy), 'a silence in the middle of a file stops the run asking');
    ok(!/statSync\(c\.src\)/.test(eng), 'SIZE CHECK measures the card with a deadline too');
    ok(/hashPro\(c\.src, hasher, \{ stallMs: SOURCE_STALL_MS \}\)/.test(eng) && /not re-read: \$\{silent\.message\}/.test(eng),
       'the card re-read is watched, and a silent card is not called "unstable"');
  }

  console.log('\nthe volume list (macOS): a volume that does not answer no longer freezes it');
  {
    const asked = [];
    const vctx = vm.createContext({
      console, Promise, setTimeout, clearTimeout, String, Array, Set, Map, parseInt,
      process: { platform: 'darwin' },
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
      extractFn('settleWithin'), extractFn('statWithin'), extractFn('isHdeSource'), extractFn('isVirtualMountType'), extractFn('getMountedVolumes'),
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

  console.log('\nthe HDE rule is the same on both sides');
  {
    const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    const m = REND.match(/function isHdeSource\(p\) \{[\s\S]*?\n\}/);
    const c2 = vm.createContext({ String });
    vm.runInContext(extractFn('isHdeSource') + '\nthis.main = isHdeSource;', ctx);
    if (m) vm.runInContext(m[0] + '\nthis.rend = isHdeSource;', c2);
    const cases = ['/Volumes/A003_hde', '/Volumes/A003_HDE/A003C001', 'E:\\A003_hde\\x', '/Volumes/A003',
                   '/Volumes/hde', '/Volumes/my_hdee', 'A003_hde', '', null];
    ok(!!m && cases.every(x => ctx.main(x) === c2.rend(x)),
       'main.js and index.html agree on every case');
    ok(ctx.main('/Volumes/A003_hde') && ctx.main('/Volumes/A003_hde/sub') && ctx.main('E:\\A003_hde') &&
       !ctx.main('/Volumes/A003') && !ctx.main('/Volumes/hde') && !ctx.main('/Volumes/my_hdee'),
       'a volume or a folder inside it is HDE; a name that only contains "hde" is not');
  }

  console.log('\nan HDE card in the engine');
  {
    const eng = extractFn('performCopyMulti');
    ok(/const hdeSource = isHdeSource\(source\.path\) \|\| await isVirtualSource\(source\.path\);/.test(eng) &&
       /const proDouble = isPro && options\.proDoubleRead === true && !hdeSource;/.test(eng),
       'the card re-read is off on an HDE volume');
    ok(/if \(\(isPro \|\| isSecure\) && !hdeSource\) \{\s*let purged = false;\s*try \{ purged = nocache\.purgeFileCache\(file\.src\)/.test(eng),
       'its files are not purged from the cache (they are produced on demand, and a failed purge would raise a false warning)');
    ok(/if \(hdeSource\) \{ if \(!st\) why = /.test(eng) && /file\.size = fileBytes;/.test(eng),
       'the announced size is not compared: what was read becomes the size of the file');
    ok(/if \(hdeSource\) srcSize = c\.size;/.test(eng), 'SIZE CHECK compares with what was delivered');
    ok(/if \(hdeSource\) for \(const r of R\) \{[\s\S]{0,400}code: 'HDE'/.test(eng) && /phase: 'warning'/.test(eng),
       'the window and the report say what an HDE copy proves');
    ok(/const verified = isPro \|\| isSecure;/.test(eng) && /verified \? 'Virtual volume: the copies were checked/.test(eng),
       'and FAST or SIZE CHECK is not credited with a check it did not make');
    ok(/options\.writeSentinel === true && common\.length && !isHdeSource\(source\.path\) && !\(await isVirtualSource\(source\.path\)\)/.test(SRC),
       'no card log is written on an HDE volume');
    ok(/ipcMain\.handle\('detect-camera'[\s\S]{0,250}if \(isHdeSource\(rootPath\) \|\| await isVirtualSource\(rootPath\)\) return null;/.test(SRC) &&
       /ipcMain\.handle\('inspect-card'[\s\S]{0,250}if \(isHdeSource\(rootPath\) \|\| await isVirtualSource\(rootPath\)\) return null;/.test(SRC),
       'neither the camera detection nor the card inspection (and its write probe) touch it');
    const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    ok(/if \(isHdeSource\(entry\.path\)\) warnHdeSource\(entry\);/.test(REND) && /async function onSourceAdded\(entry\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(isHdeSource\(entry\.path\)\) return;/.test(REND),
       'the window warns when an HDE card is loaded, and does not inspect it');
    ok(/if\(z==='src' && r && r\[0\] && r\[0\]\.virtual === true\)\{ entry\._virtual = true; warnHdeSource\(entry\); \}/.test(REND) &&
       /if \(entry\._virtualWarned\) return; entry\._virtualWarned = true;/.test(REND),
       'and when the system says the volume is virtual, whatever its name, once per card');
    ok(/ipcMain\.handle\('redo-double-read'[\s\S]{0,900}if \(isHdeSource\(sourcePath\) \|\| await isVirtualSource\(sourcePath\)\) return \{ ok:false/.test(SRC),
       'the unmount-and-re-read check refuses a virtual volume (there is no card behind it)');
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
