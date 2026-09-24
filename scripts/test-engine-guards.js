#!/usr/bin/env node
// What the engine refuses, reports and never does, after the 2.7.0 review.
//
// Each case here is a defect that was found by reading the code and confirmed
// by running it. They are grouped by what they protect:
//   1. the machine (a path that reveals must never execute)
//   2. the destination (a name built from a value the interface sent)
//   3. the operator (a failure that used to happen in silence)
//   4. the footage (a counter that can always be read back)
//
//   node scripts/test-engine-guards.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const SENT = fs.readFileSync(path.join(ROOT, 'src', 'main', 'sentinel.js'), 'utf8');

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
const handlerSrc = (ch) => {
  const i = MAIN.indexOf(`ipcMain.handle('${ch}'`);
  if (i < 0) throw new Error(`handler ${ch} not found`);
  return MAIN.slice(i, MAIN.indexOf("\nipcMain.handle(", i + 10));
};

// ── 1. Revealing a folder must never open a file ────────────────────────────
console.log('\n"reveal" shows a folder, it does not open anything');
{
  // The path can come from a record read back out of a report that lives on a
  // shared destination. openPath() does not show a file, it LAUNCHES it with
  // whatever application owns the extension: a stranger with write access to
  // the drive could have chosen the program that runs.
  const h = handlerSrc('reveal-path');
  ok(/showItemInFolder\(/.test(h), 'it uses showItemInFolder');
  ok(!/openPath\(/.test(h), 'and never openPath');
  ok(/existsSync\(abs\)/.test(h) && /path\.resolve\(/.test(h), 'the path is resolved and has to exist');
}

// ── 2. A name built from a value the interface sent ─────────────────────────
console.log('\nthe shooting note cannot be written outside the destination');
{
  const seg = MAIN.slice(MAIN.indexOf('const counterSafe'), MAIN.indexOf('const counterSafe') + 400);
  ok(/replace\(\/\[\^A-Za-z0-9_-\]\/g, ''\)/.test(seg), 'the counter is reduced to what a file name may hold');
  ok(/counterSafe/.test(MAIN.slice(MAIN.indexOf('const noteFileName'), MAIN.indexOf('const noteFileName') + 120)),
     'and the note is named with the cleaned value');
  // The rule itself.
  const clean = (x) => String(x || '001').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || '001';
  ok(clean('../../../../etc/passwd') === 'etcpasswd', 'a path turns into a plain name');
  ok(clean('001') === '001' && clean('') === '001' && clean('////') === '001', 'an ordinary counter is untouched');
}

// ── 3. A failure that used to be silent ─────────────────────────────────────
console.log('\na card that refuses the journal says so');
{
  // appendIngest reports a refusal by RETURNING {ok:false}; only a thrown error
  // was handled, so the commonest case of all (a write-protected card) went by
  // with a green ingest and no note.
  const i = MAIN.indexOf('const sent = await appendIngest(');
  ok(i > 0, 'the result of the journal write is kept');
  const seg = MAIN.slice(i, i + 400);
  ok(/if \(!sent \|\| sent\.ok !== true\) throw/.test(seg), 'a refusal is turned into the same path as an error');
  ok(/CV-8/.test(MAIN.slice(i, i + 1200)), 'which is the note the operator reads');

  // And the journal itself never comes back unbounded.
  ok(/SENTINEL_MAX_BYTES/.test(SENT), 'the card journal is capped like every other file read from outside');
  const rs = extractFn(SENT, 'readSentinel');
  ok(/statSync/.test(rs) && /st\.size > SENTINEL_MAX_BYTES/.test(rs), 'and the size is checked before it is read');
  ok(/return null/.test(rs), 'over the cap it reads as unreadable, never as a fresh card');
}

// ── 4. A counter that can always be read back ───────────────────────────────
console.log('\nthe counter survives a template that ends in a dot or a space');
{
  // cleanSegment drops the dots and spaces at the end of a folder name. The
  // matcher did not, so the folder created from "{counter}_{cardname}." could
  // never be matched: the scan answered next=001 for ever and every later
  // ingest was refused by the "folder already exists" guard.
  const ctx = vm.createContext({ console, path, Set, RegExp, String, Number, Math, Date });
  vm.runInContext([extractConst(MAIN, 'CLOCK_TOKENS'), extractFn(MAIN, 'nfc'), extractFn(MAIN, 'cleanSegment'),
                   extractFn(MAIN, 'makeCounterMatcher'), extractFn(MAIN, 'resolveTemplateVars'),
                   extractFn(MAIN, 'templateSegments'), extractFn(MAIN, 'buildFolderSegments')].join('\n'), ctx);
  const roundTrip = (tpl, n) => {
    const segs = ctx.buildFolderSegments(tpl, { name: 'A001', counter: n }, new Date());
    return ctx.makeCounterMatcher(tpl).extract(segs[segs.length - 1]);
  };
  ok(roundTrip('{counter}_{cardname}', '003') === 3, 'an ordinary template still reads back');
  ok(roundTrip('{counter}_{cardname}.', '007') === 7, 'a trailing dot too');
  ok(roundTrip('{counter}_{cardname} ', '008') === 8, 'a trailing space too');
  ok(roundTrip('{counter}_{cardname}.. ..', '009') === 9, 'and any run of them');
  ok(roundTrip('{YY}{MM}{DD}/{counter}_{cardname}.', '011') === 11, 'including under a subfolder');
  ok(roundTrip('{cardname}_{counter}.', '012') === 12, 'and with the counter at the end');
}

// ── 5. What is written beside the footage is written to last ────────────────
console.log('\nthe lists, manifests and reports are flushed, not just renamed');
{
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

// ── 6. The preflight covers the whole batch ─────────────────────────────────
console.log('\na destination inside ANY card of the batch is refused before the first byte');
{
  // It used to be compared against the card being copied only. A destination
  // sitting inside another card of the same batch passed here and was stopped
  // later by the source-card lock, in the middle of the copy, naming a card the
  // operator was not copying.
  const i = MAIN.indexOf('const batchRoots');
  ok(i > 0, 'the preflight is told about the batch');
  const seg = MAIN.slice(i, i + 700);
  ok(/options\.batchSources/.test(seg), 'it reads the list of cards of this run');
  ok(/batchRoots\.find\(sp => pathContains\(sp, dp\) \|\| pathContains\(dp, sp\)\)/.test(seg),
     'and refuses a destination that contains, or sits inside, any of them');
  ok(/PF-E6/.test(MAIN.slice(i, i + 900)), 'with the refusal the interface already knows');

  // The list is set on the options object itself. A copy of it made the engine
  // and the card journal disagree: the journal recorded "not verified" for a
  // run the engine had normalised to SECURE and verified.
  const start = MAIN.slice(MAIN.indexOf("ipcMain.handle('start-copy'"), MAIN.indexOf("ipcMain.handle('recopy-failed'"));
  ok(/options\.batchSources = lockedHere/.test(start), 'set on the options object, not on a copy of it');
  ok(!/Object\.assign\(\{\}, options/.test(start), 'nothing clones the options behind the engine');
}

// ── 7. The copy path ────────────────────────────────────────────────────────
console.log('\nthe copy reads while it writes, and does not flood the interface');
{
  const fan = extractFn(MAIN, 'copyFanOut');
  ok(/const CHUNK = 8\*1024\*1024;/.test(fan), 'the read chunk is named once');
  ok(/highWaterMark: CHUNK \* 2/.test(fan),
     'and a write buffer takes two of them, so the reader is not stopped on every chunk');

  const i = MAIN.indexOf('const onB = (b, force)');
  ok(i > 0, 'the copy progress can be forced');
  const seg = MAIN.slice(i, i + 700);
  ok(/if \(!force && now-lastEmit < 100\) return;/.test(seg), 'and is throttled to 100 ms, like the verify phase');
  ok(/onB\(0, true\);/.test(MAIN), 'the end of each file is always sent, whatever the throttle');
}

// ── 8. The card journal is read once ────────────────────────────────────────
console.log('\nthe card journal is read once per inspection');
{
  const fn = extractFn(SENT, 'inspectCard');
  ok(!/=\s*sentinelIsDamaged\(/.test(fn), 'inspectCard no longer re-reads and re-parses the same file');
  ok(/result\.sentinel === null && fs\.existsSync\(/.test(fn), 'damaged is answered from what was already read');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
