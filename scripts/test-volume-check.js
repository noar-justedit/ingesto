#!/usr/bin/env node
// Regression tests for the "is this volume still there" check run at Start.
// Exercised against a real filesystem, no Electron needed.
//
//   node scripts/test-volume-check.js
//
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('{', start), d = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') d++;
    else if (SRC[i] === '}') { d--; if (!d) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces');
}
const ctx = vm.createContext({ fs, path, Math, console });
vm.runInContext(extractFn('checkOnePath') + '\n' + extractFn('emptyRunReason'), ctx);

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ok  ', n); }
  else { fail++; console.log('  FAIL', n, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-vol-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

const dest = path.join(TMP, 'MEDIAS_RAID0');
fs.mkdirSync(dest);
const loaded = ctx.checkOnePath({ path: dest });   // what we record when the volume is added

console.log('\nA volume that is still there');
ok('accepted', loaded.ok === true, loaded);
ok('its capacity was measured', loaded.total > 0, loaded.total);
ok('whether it is a mount point was measured', typeof loaded.isMount === 'boolean', loaded.isMount);
ok('still accepted when checked again with what we recorded',
  ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: loaded.total }).ok === true);

console.log('\nTHE BUG: a volume unplugged and plugged back in');
// macOS hands out a NEW device number on every mount. The check used to compare
// the device number recorded when the destination was loaded, so the same drive
// coming back was rejected as "a different volume" — and the only way out was to
// remove the destination and add it again, or quit ingesto altogether.
{
  const r = ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: loaded.total,
                               dev: (loaded.dev || 0) + 12345 });
  ok('a changed device number no longer blocks the ingest', r.ok === true, r);
}

console.log('\nA volume that is gone');
ok('a path that no longer exists is caught',
  ctx.checkOnePath({ path: path.join(TMP, 'never-existed') }).reason === 'missing');
{
  const f = path.join(TMP, 'a-file');
  fs.writeFileSync(f, 'x');
  ok('a path that became a file is caught', ctx.checkOnePath({ path: f }).reason === 'notdir');
}

console.log('\nA volume unmounted, its empty mount folder left behind');
// The Linux case: /media/user/DISK survives the unmount as an empty directory,
// so "does the path exist" proves nothing. Only "was it a mount point, and is it
// still one" catches it — and that comparison is made at ONE instant, which is
// why it survives a remount.
{
  const r = ctx.checkOnePath({ path: dest, isMount: true, total: loaded.total });
  ok('a folder that was a mount point and is not one any more is caught',
    r.reason === 'unmounted', r);
  ok('a folder that was NOT a mount point is left alone',
    ctx.checkOnePath({ path: dest, isMount: false, total: loaded.total }).ok === true);
}

console.log('\nA different volume at the same path');
{
  const half = ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: Math.round(loaded.total / 2) });
  ok('a capacity that halved is a different volume', half.reason === 'replaced', half);
  const tiny = ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: Math.round(loaded.total * 1.005) });
  ok('half a percent of drift is tolerated (an APFS container breathes)', tiny.ok === true, tiny);
  const past = ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: Math.round(loaded.total * 1.05) });
  ok('five percent is not', past.reason === 'replaced', past);
  ok('an unknown recorded capacity never blocks',
    ctx.checkOnePath({ path: dest, isMount: loaded.isMount, total: null }).ok === true);
}

console.log('\nA run that copied nothing');
// Green summary, "all verified" on the phone, and in kiosk mode the card
// ejected with "You can remove your card" — over an ingest that read not one
// file. The worst defect the audit found.
ok('an empty folder is not a success',
  /no file was found/.test(ctx.emptyRunReason(0, 0, 0) || ''), ctx.emptyRunReason(0, 0, 0));
ok('a filter that excluded everything is not a success',
  /file filter/.test(ctx.emptyRunReason(412, 0, 0) || ''), ctx.emptyRunReason(412, 0, 0));
ok('the message says how many files were passed over',
  /all 412 files/.test(ctx.emptyRunReason(412, 0, 0) || ''));
ok('one file reads "file", not "files"', /all 1 file /.test(ctx.emptyRunReason(1, 0, 0) || ''));
ok('a card already ingested in full IS a legitimate success',
  ctx.emptyRunReason(171, 171, 0) === null);
ok('a normal ingest is untouched', ctx.emptyRunReason(171, 0, 171) === null);
ok('files copied AND files skipped is untouched', ctx.emptyRunReason(171, 40, 131) === null);

console.log('\nNever blocks for the wrong reason');
ok('an empty entry is refused without throwing', ctx.checkOnePath({}).reason === 'missing');
ok('no entry at all is refused without throwing', ctx.checkOnePath(null).reason === 'missing');

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
