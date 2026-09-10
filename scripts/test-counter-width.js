#!/usr/bin/env node
// How many digits the counter is written with (issue #9).
//
// The dangerous half of this feature is not the padding, it is everything that
// READS a folder name back: the counter scan that decides the next free number,
// and the collision guard that refuses to write over an existing reel. If a
// change of width made either of them blind, INGESTO would restart at 1 and
// write over the morning.
//
//   node scripts/test-counter-width.js
//
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const Module = require('module');

const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── The interface side ──────────────────────────────────────────────────────
const ctx = vm.createContext({
  console,
  // Written out here rather than read from the source: this is the contract.
  COUNTER_WIDTHS: [2, 3, 4],
  // The ceiling is the folder scanner's, not a preference: it reads at most
  // four digits back out of a folder name.
  COUNTER_MAX: 9999,
  S: { counter: 7, counterWidth: 3 },
});
vm.runInContext(extractFn(REND, 'padCounter'), ctx);
vm.runInContext(extractFn(REND, 'prefsCounterWidth'), ctx);
vm.runInContext(extractFn(REND, 'prefsCounter'), ctx);

console.log('\nthe width is a minimum, never a maximum');
{
  ctx.S.counterWidth = 2;
  ok(ctx.padCounter(1) === '01', 'a small number is padded');
  ok(ctx.padCounter(99) === '99', '99 fits');
  ok(ctx.padCounter(100) === '100', 'and 100 is written in full, not truncated');
  ok(ctx.padCounter(1000) === '1000', 'so is 1000');
  ctx.S.counterWidth = 4;
  ok(ctx.padCounter(7) === '0007', 'four digits pads to four');
  ok(ctx.padCounter(12345) === '12345', 'and still does not truncate past them');
  ctx.S.counterWidth = 3;
  ok(ctx.padCounter(7) === '007', 'three digits is three digits');
}

console.log('\nthe default is three, and nothing else is accepted');
{
  // Everything that has ever been ingested was written with three. A setting
  // that could arrive as anything else, from a preferences file or a settings
  // file, must fall back to it rather than invent a folder name.
  for (const bad of [null, undefined, 0, 1, 5, 9, '3', 2.5, -2, {}, [3], NaN, Infinity]) {
    ctx.S.counterWidth = bad;
    ok(ctx.padCounter(7) === '007', `${JSON.stringify(bad)} falls back to three digits`);
  }
  ctx.S.counterWidth = 3;
  for (const bad of [null, undefined, 0, 1, 5, 2.5, {}, [3], [2], true])
    ok(ctx.prefsCounterWidth({ counterWidth: bad }) === null,
       `${JSON.stringify(bad)} is refused when read off a disk`);
  for (const good of [2, 3, 4])
    ok(ctx.prefsCounterWidth({ counterWidth: good }) === good, `${good} is accepted`);
  // A hand-edited file writing it as text is still a width.
  ok(ctx.prefsCounterWidth({ counterWidth: '2' }) === 2, 'and one saved as text is read as the number it is');
  ok(ctx.prefsCounterWidth({}) === null, 'and a file that says nothing changes nothing');
}

console.log('\nthe counter itself stops where the folder scanner stops reading');
{
  // Not a preference: the scanner captures at most four digits out of a folder
  // name, and the guard that refuses to write over an existing reel reads the
  // same number. A counter of 10000 would be invisible to both, the scan would
  // restart at 1, and the next card would land on an earlier one. Four digits
  // being on offer is what made that easy to reach.
  ok(ctx.prefsCounter({ counter: 9999 }) === 9999, '9999 is allowed');
  ok(ctx.prefsCounter({ counter: 10000 }) === null, '10000 is refused');
  ok(ctx.prefsCounter({ counter: 999999 }) === null, 'and so is anything above it');
  ok(ctx.prefsCounter({ counter: 1 }) === 1, 'while 1 is still fine');
}

console.log('\nan explicit width beats the setting');
{
  // What the report and the phone notification use: they describe folders that
  // already exist, and the setting may have changed since.
  ctx.S.counterWidth = 4;
  ok(ctx.padCounter(7, 2) === '07', 'the run said two digits, so it is two');
  ok(ctx.padCounter(7, 3) === '007', 'and three when the run said three');
  ok(ctx.padCounter(7, 9) === '0007', 'a width that is not one of the three falls back to the setting');
  ctx.S.counterWidth = 3;
}

console.log('\nthe width is frozen into the run');
{
  // Checked on the source, not through the engine: S.run is assembled inside
  // startCopy, which cannot be driven without the whole interface. A source
  // check is worth little in general, so this one is deliberately narrow. What
  // it pins down is that the two things which run AFTER the panels unlock read
  // the width from the snapshot: a width changed between START and the end
  // would otherwise renumber, in the report and on the phone, folders that are
  // already on the drive under another name.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  // Anchored on the snapshot itself: the same assignment also appears in the
  // preferences writer, and a looser pattern was satisfied by that one.
  ok(/base:\s*S\.counter,[\s\S]{0,400}?counterWidth:\s*S\.counterWidth,/.test(src),
     'the run snapshot carries the width');
  ok(/padCounter\(base\+i,\s*run && run\.counterWidth\)/.test(src),
     'the ingest report reads it from the snapshot');
  ok(/padCounter\(start\+i,\s*run && run\.counterWidth\)/.test(src),
     'and so does the phone notification');
  ok(/padCounter\(S\.run\.base\+i,\s*S\.run\.counterWidth\)/.test(src),
     'and the folder name itself comes from the same place');
}

// ── The engine side ─────────────────────────────────────────────────────────
// The real counter scan, against real folders on disk.
const handlers = {};
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true,
         quit: () => {}, getVersion: () => '2.6.5', getPath: () => os.tmpdir(), getName: () => 'ingesto',
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
const call = (ch, ...args) => handlers[ch]({ sender: { send: () => {} } }, ...args);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-cw-'));
const withFolders = (names) => {
  const d = fs.mkdtempSync(path.join(TMP, 'd-'));
  for (const n of names) fs.mkdirSync(path.join(d, n), { recursive: true });
  return d;
};

(async () => {

console.log('\nthe counter scan does not care how many digits it is looking at');
{
  // This is what makes changing the setting safe. If the scan only understood
  // three digits, switching to two would make it answer "next: 1" over a
  // destination already holding a hundred reels.
  const tpl = '{counter}_{cardname}';
  const cases = [
    [['001_A001', '002_A002', '003_A003'], 3, 4, 'three digits throughout'],
    [['01_A001', '02_A002', '03_A003'],    3, 4, 'two digits throughout'],
    [['0001_A001', '0002_A002'],           2, 3, 'four digits throughout'],
    [['01_A001', '002_A002', '7_A003'],    7, 8, 'a folder where the widths are mixed'],
    [['099_A001', '100_A002'],           100, 101, 'across the hundred boundary'],
  ];
  for (const [names, max, next, label] of cases) {
    const d = withFolders(names);
    const r = await call('scan-dest-counter-full', [d], tpl);
    ok(r.max === max && r.next === next,
       `${label}: last ${r.max}, next ${r.next}`);
  }
}

console.log('\nand the folder guard still refuses to write over a reel');
{
  // The guard compares real folder names, so a card ingested at two digits into
  // a destination that already holds it at three must still be refused. The
  // counter scan is what puts them on the same number in the first place.
  const dst = withFolders([]);
  const card = fs.mkdtempSync(path.join(TMP, 'c-'));
  fs.writeFileSync(path.join(card, 'A.MOV'), 'morning');
  const opts = (extra) => ({ mode: 'fast', folderTemplate: '{counter}_{cardname}',
                             writeSentinel: false, writeChecksum: false, cksumList: false,
                             cksumMhl: false, ascMhl: false, ...extra });
  const ingest = (counter) => call('start-copy', {
    sources: [{ name: 'A001', path: card, counter }],
    destinations: [{ name: 'D', path: dst }], options: opts() });

  const r1 = (await ingest('01'))[0];
  ok(r1.success === true && path.basename(r1.destPath) === '01_A001',
     `a two-digit ingest creates ${path.basename(r1.destPath)}`);

  // The scan sees it as counter 1 and offers 2, which is the whole point.
  const scan = await call('scan-dest-counter-full', [dst], '{counter}_{cardname}');
  ok(scan.max === 1 && scan.next === 2, `the scan reads it as 1 and offers 2 (max ${scan.max})`);

  // And if the operator forces the same number back, whatever the width, the
  // folder guard is the last line and it holds.
  const r2 = (await ingest('01'))[0];
  ok(r2.refused === true, `the same number again is refused (${r2.refusalCode})`);
  ok(fs.readFileSync(path.join(r1.destPath, 'A.MOV'), 'utf8') === 'morning',
     'and the first card is untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
