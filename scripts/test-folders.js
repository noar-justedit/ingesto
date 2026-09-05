#!/usr/bin/env node
// Folder structure (2.6.0): a "/" in the template creates a subfolder.
//
// Two halves:
//   1. the resolver, extracted from main.js and exercised directly;
//   2. real ingests, run through the real IPC handlers against real folders,
//      with a stub in place of Electron.
//
//   node scripts/test-folders.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const Module = require('module');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

// ── Extract a top-level function by brace matching (same trick as test-p0) ──
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

let pass = 0, fail = 0, skip = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const skipped = (l, why) => { skip++; console.log('  --   ' + l + ' (skipped: ' + why + ')'); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-folders-'));
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };
const fresh = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

// ═══════════════════ 1. The resolver ═══════════════════
const ctx = vm.createContext({ console });
vm.runInContext([
  extractConst('MAX_FOLDER_DEPTH'),
  extractFn('resolveTemplateVars'),
  extractFn('cleanSegment'),
  extractFn('buildFolderSegments'),
  extractFn('buildFolderName'),
  extractFn('templateSegments'),
  extractFn('makeCounterMatcher'),
  extractFn('isSafeFolderName'),
].join('\n'), ctx);

const CARD = { counter: '007', name: 'A001', cameraman: 'noar', camera: 'FX6' };
const segs = (tpl, card) => ctx.buildFolderSegments(tpl, card || CARD);

console.log('\ntemplate → folder levels');
ok(segs('{counter}_{cardname}').join('|') === '007_A001',
   'no "/" — one folder, exactly as before');
ok(segs('DAY1/{camera}/{counter}_{operator}').join('|') === 'DAY1|FX6|007_noar',
   'two subfolder levels then the card folder');
ok(ctx.buildFolderName('DAY1/{camera}/{counter}_{operator}', CARD) === '007_noar',
   'the card\'s own folder is the LAST level');
ok(segs('DAY1//{counter}').join('|') === 'DAY1|007',
   'a doubled "/" makes no empty folder');
ok(segs('/DAY1/{counter}/').join('|') === 'DAY1|007',
   'a leading and a trailing "/" are ignored');
ok(segs('DAY1/{camera}/{counter}', { counter: '007', name: 'A001', cameraman: '', camera: '' }).join('|') === 'DAY1|007',
   'a card with no camera creates NO empty level — the level disappears');
ok(segs('{camera}/{counter}', { counter: '007', name: 'A001', cameraman: '', camera: '' }).join('|') === '007',
   'and the card still lands one level up, never in the root');
ok(segs('DAY1/../{counter}').join('|') === 'DAY1|007',
   '".." can never become a level: trailing dots are stripped and the empty level disappears');
ok(segs('{cardname}/{counter}', { counter: '007', name: '..', cameraman: '', camera: '' }).join('|') === '007',
   'and neither can a CARD named ".." — the value goes through the same cleaning');
ok(!ctx.isSafeFolderName('..') && !ctx.isSafeFolderName(''),
   'isSafeFolderName rejects ".." and the empty name — the guard the engine applies per level');
ok(segs('{operator}/{counter}_{cardname}', { counter: '007', name: 'A001', cameraman: 'a/b', camera: '' }).join('|') === 'a_b|007_A001',
   'a slash inside a VALUE creates no level — only the template decides the structure');
ok(segs('{counter}_{operator}', { counter: '007', name: 'A001', cameraman: 'Jean/Marc', camera: '' }).join('|') === '007_Jean_Marc',
   'so an operator called "Jean/Marc" cannot push the counter out of the card folder');
ok(segs('{cardname}_{counter}', { counter: '007', name: '../..', cameraman: '', camera: '' }).join('|') === '.._.._007',
   'and a card labelled "../.." stays ONE flat name — no level, no escape');
ok(segs('DAY1 /{counter}').join('|') === 'DAY1|007',
   'a trailing space on a level is trimmed (Windows drops it silently)');
ok(segs('{counter}_{cardname}\\x/y').join('|') === '007_A001_x|y',
   'a backslash inside a level becomes "_" — only "/" makes a folder');

console.log('\ncounter matcher');
{
  const m = ctx.makeCounterMatcher('DAY1/{camera}/{counter}_{operator}');
  ok(m.extract('007_noar') === 7, 'the matcher reads the counter from the CARD folder');
  ok(m.extract('DAY1') === null && m.extract('FX6') === null, 'and never from a subfolder level');
  const flat = ctx.makeCounterMatcher('{counter}_{cardname}');
  ok(flat.extract('007_A001') === 7, 'a template without "/" is unchanged');
}

// ═══════════════════ 2. Real ingests ═══════════════════
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
const opts = (extra) => ({ mode: 'slow', writeSentinel: false, writeChecksum: true,
                           cksumList: true, cksumMhl: false, ascMhl: false, ...extra });

(async () => {
  console.log('\nan ingest into subfolders');
  {
    const card = fresh('card1'), dst = fresh('dst1');
    mk(card, { '100CANON/A001.MOV': 'aaa', 'B002.MOV': 'bbb' });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '007', cameraman: 'noar', camera: 'FX6' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ folderTemplate: 'DAY1/{camera}/{counter}_{operator}' }) });
    const r = R[0];
    const leaf = path.join(dst, 'DAY1', 'FX6', '007_noar');
    ok(r.success === true, 'the ingest succeeds');
    ok(r.destPath === leaf, 'the destination is the full tree (' + path.relative(dst, r.destPath) + ')');
    ok(r.relFolder === 'DAY1/FX6/007_noar', 'the result carries the destination-relative path for the report');
    ok(fs.existsSync(path.join(leaf, '100CANON', 'A001.MOV')), 'the card\'s own tree is preserved inside');
    ok(fs.existsSync(path.join(leaf, '007_noar.xxh')), 'the checksum list sits in the CARD folder, not at the root');
    ok(!fs.existsSync(path.join(dst, '007_noar')), 'nothing is written at the destination root');
    const v = await call('verify-folder', leaf);
    ok(v.ok && v.matched === 2 && v.corrupted.length === 0 && v.extra.length === 0,
       'Verify works on the card folder unchanged');
  }

  console.log('\nthe same structure on every destination');
  {
    const card = fresh('card2'), d1 = fresh('dst2a'), d2 = fresh('dst2b');
    mk(card, { 'A.MOV': 'a' });
    const R = await call('start-copy', {
      sources: [{ name: 'A002', path: card, counter: '008', cameraman: 'noar', camera: 'FX6' }],
      destinations: [{ name: 'D1', path: d1 }, { name: 'D2', path: d2 }],
      options: opts({ folderTemplate: 'DAY1/{camera}/{counter}_{operator}' }) });
    ok(R.every(x => x.success === true), 'both destinations succeed');
    ok(R[0].relFolder === R[1].relFolder, 'both get the IDENTICAL relative path');
    ok(fs.existsSync(path.join(d1, 'DAY1', 'FX6', '008_noar', 'A.MOV')) &&
       fs.existsSync(path.join(d2, 'DAY1', 'FX6', '008_noar', 'A.MOV')),
       'the tree is created on both drives during the copy');
  }

  console.log('\nthe counter stays global across the tree');
  {
    const dst = fresh('dst3');
    // Day 1 held two cards under two cameras; day 2 starts.
    fs.mkdirSync(path.join(dst, 'DAY1', 'FX6', '001_noar'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'DAY1', 'C50', '002_noar'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'DAY2', 'FX6', '003_noar'), { recursive: true });
    const tpl = 'DAY2/{camera}/{counter}_{operator}';
    const scan = await call('scan-dest-counter-full', [dst], tpl);
    ok(scan.max === 3 && scan.next === 4,
       'the scan finds the cards of EVERY day and camera (max ' + scan.max + ', next ' + scan.next + ')');
    const hit = await call('check-counter-collision', [dst], 2, tpl);
    ok(hit && hit.counter === 2 && hit.folder === 'DAY1/C50/002_noar',
       'a collision names the counter AND the folder, with its path (' + JSON.stringify(hit) + ')');
    ok(await call('check-counter-collision', [dst], 4, tpl) === null, 'a free counter reports no collision');
  }

  console.log('\nthe scan reads no deeper than the template describes');
  {
    const dst = fresh('dst4');
    const cardFolder = path.join(dst, 'DAY1', 'FX6', '001_noar');
    fs.mkdirSync(path.join(cardFolder, '100CANON'), { recursive: true });
    // A folder INSIDE a card folder cannot be a card: cards live at the depth
    // the template describes, and the walk stops there.
    fs.mkdirSync(path.join(cardFolder, '999_trap'), { recursive: true });
    const scan = await call('scan-dest-counter-full', [dst], 'DAY1/{camera}/{counter}_{operator}');
    ok(scan.max === 1, 'a folder inside a card folder is not read as a card (max ' + scan.max + ')');
  }

  console.log('\na SUBFOLDER that looks like a card hides nothing');
  {
    // The matcher is permissive by design (an empty variable collapses its
    // separator), so a level named "01_JOUR1" reads as card 1. Stopping there
    // used to hide every real card underneath: the scan said "next = 002" with
    // 002 already on the disk, and the ingest walked into an existing card.
    const dst = fresh('dst4b');
    fs.mkdirSync(path.join(dst, '01_JOUR1', '002_noar'), { recursive: true });
    fs.writeFileSync(path.join(dst, '01_JOUR1', '002_noar', 'PRECIOUS.MOV'), 'do not touch');
    const tpl = '01_JOUR1/{counter}_{operator}';
    const scan = await call('scan-dest-counter-full', [dst], tpl);
    ok(scan.max === 2 && scan.next === 3,
       'the card under the look-alike level is found (max ' + scan.max + ', next ' + scan.next + ')');
    const hit = await call('check-counter-collision', [dst], 2, tpl);
    ok(hit && hit.counter === 2 && /002_noar/.test(hit.folder),
       'and reusing its counter is refused (' + JSON.stringify(hit) + ')');
    // (The engine has never refused a non-empty destination folder — that is a
    // separate, known gap. What this feature must guarantee is that the
    // collision check SEES the card, which is what the two checks above prove.)
    const free = await call('check-counter-collision', [dst], 3, tpl);
    ok(free === null, 'a counter that is genuinely free is still accepted');
  }

  console.log('\none walk for a whole batch of cards');
  {
    const dst = fresh('dst4c');
    fs.mkdirSync(path.join(dst, 'DAY1', 'FX6', '005_noar'), { recursive: true });
    const tpl = 'DAY1/{camera}/{counter}_{operator}';
    const none = await call('check-counter-collision', [dst], [1, 2, 3], tpl);
    ok(none === null, 'a batch with no clash returns nothing');
    const hit = await call('check-counter-collision', [dst], [3, 4, 5, 6], tpl);
    ok(hit && hit.counter === 5, 'a batch reports WHICH card of the batch clashes (' + (hit&&hit.counter) + ')');
    const one = await call('check-counter-collision', [dst], 5, tpl);
    ok(one && one.counter === 5, 'a single counter still works');
  }

  console.log('\nguards');
  {
    const card = fresh('card5'), dst = fresh('dst5');
    mk(card, { 'A.MOV': 'a' });
    const run = (tpl, src) => call('start-copy', {
      sources: [Object.assign({ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6' }, src)],
      destinations: [{ name: 'D', path: dst }], options: opts({ folderTemplate: tpl }) });

    const r1 = await run('{counter}/{cardname}');
    ok(r1[0].success === false && /counter is in a subfolder/i.test(r1[0].errorList[0].error),
       'the counter in a subfolder level is refused');
    const r2 = await run('a/b/c/d/e/{counter}');
    ok(r2[0].success === false && /levels of subfolders/i.test(r2[0].errorList[0].error),
       'more than 4 levels is refused');
    const r3 = await run('DAY1/' + 'x'.repeat(250) + '/{counter}');
    ok(r3[0].success === false && /not a usable folder name/i.test(r3[0].errorList[0].error),
       'a level over the 200-character limit is refused up front, not file by file');
    const r4 = await run('{camera}/{operator}', { camera: '', cameraman: '' });
    ok(r4[0].success === false && /empty name/i.test(r4[0].errorList[0].error),
       'a template that resolves to nothing is refused');
    ok(fs.readdirSync(dst).length === 0, 'not one of the refused runs wrote anything');
  }

  console.log('\n".." never escapes the destination');
  {
    const card = fresh('card5b'), dst = fresh('dst5b');
    mk(card, { 'A.MOV': 'a' });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6' }],
      destinations: [{ name: 'D', path: dst }], options: opts({ folderTemplate: 'DAY1/../{counter}' }) });
    ok(R[0].success === true && R[0].relFolder === 'DAY1/001',
       'the ".." level simply disappears (' + R[0].relFolder + ')');
    ok(fs.existsSync(path.join(dst, 'DAY1', '001', 'A.MOV')), 'the card lands inside the destination');
    ok(fs.readdirSync(path.dirname(dst)).filter(n => n === '001').length === 0,
       'and nothing was created beside the destination');
  }

  console.log('\nan existing flat destination is untouched by the new code');
  {
    const card = fresh('card6'), dst = fresh('dst6');
    mk(card, { 'A.MOV': 'a' });
    fs.mkdirSync(path.join(dst, '001_OLD'), { recursive: true });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '002', cameraman: 'noar', camera: 'FX6' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ folderTemplate: '{counter}_{cardname}' }) });
    ok(R[0].success === true && R[0].destPath === path.join(dst, '002_A001'),
       'a template without "/" behaves exactly as in 2.5.5');
    ok(R[0].relFolder === '002_A001', 'and its relative path is just the folder name');
    const scan = await call('scan-dest-counter-full', [dst], '{counter}_{cardname}');
    ok(scan.next === 3, 'the flat counter scan still works (next ' + scan.next + ')');
  }

  // ── Regressions found by the pre-freeze review, each named after the defect ──

  console.log('\nthe scan never reads deeper than the template (a project folder is not a card)');
  {
    // A first version retried the walk at FULL depth when the template's own
    // depth found nothing. On an ordinary post drive it read the project's
    // numbered folders as cards: next=004, and counters 1-3 refused.
    const dst = fresh('dst7');
    for (const n of ['01_DOC', '02_RUSHES', '03_EDIT']) fs.mkdirSync(path.join(dst, 'PROJECT_X', n), { recursive: true });
    const tpl = '{counter}_{cardname}';
    const scan = await call('scan-dest-counter-full', [dst], tpl);
    ok(scan.max === 0 && scan.next === 1,
       'PROJECT_X/01_DOC is not read as card 1 (next ' + scan.next + ')');
    ok(await call('check-counter-collision', [dst], [1, 2, 3, 4], tpl) === null,
       'and counters 1-3 are not refused');
  }
  {
    // Same walk, second shape: cards ingested WITHOUT a counter, whose own
    // camera folders were read as cards (DCIM/101MSDCF → next 102).
    const dst = fresh('dst7b');
    fs.mkdirSync(path.join(dst, 'A001_noar', 'DCIM', '100MSDCF'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'A001_noar', 'DCIM', '101MSDCF'), { recursive: true });
    const scan = await call('scan-dest-counter-full', [dst], '{counter}_{cardname}');
    ok(scan.next === 1, 'a camera folder inside an old card is not read as a card (next ' + scan.next + ')');
  }

  console.log('\nthe card\'s OWN folder can never vanish');
  {
    // A level that resolves to nothing disappears — intended for a subfolder,
    // never for the last one: every card of the day would be written INTO the
    // folder it shares with the others, tomorrow's over today's.
    const card = fresh('card8'), dst = fresh('dst8');
    mk(card, { 'A.MOV': 'a' });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '001', cameraman: '', camera: '' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ folderTemplate: '{YY}{MM}{DD}/{operator}_{camera}' }) });
    ok(R[0].success === false, 'an empty last level is refused, not flattened into the shared folder');
    ok(/last level/i.test((R[0].errorList[0] || {}).error || ''), 'and the message says which level is empty');
    ok(fs.readdirSync(dst).length === 0, 'the refused run wrote nothing at all');
  }
  {
    // The level ABOVE may still vanish — that is the documented behaviour.
    const card = fresh('card8b'), dst = fresh('dst8b');
    mk(card, { 'A.MOV': 'a' });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: '' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ folderTemplate: 'DAY1/{camera}/{counter}_{operator}' }) });
    ok(R[0].success === true && R[0].relFolder === 'DAY1/001_noar',
       'a card with no camera still moves up one level (' + R[0].relFolder + ')');
  }

  console.log('\na "/" at the end of the template names no level');
  {
    const card = fresh('card9'), dst = fresh('dst9');
    mk(card, { 'A.MOV': 'a' });
    const R = await call('start-copy', {
      sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6' }],
      destinations: [{ name: 'D', path: dst }],
      options: opts({ folderTemplate: '{counter}_{cardname}/' }) });
    ok(R[0].success === true && R[0].relFolder === '001_A001',
       'a trailing "/" is not a subfolder level, so {counter} is not "in a subfolder" (' +
       (R[0].success ? R[0].relFolder : ((R[0].errorList[0] || {}).error || '?')) + ')');
    ok(ctx.templateSegments('/DAY1/{counter}/').join('|') === 'DAY1|{counter}',
       'templateSegments trims the empty ends');
    ok(ctx.makeCounterMatcher('DAY1/{counter}_{cardname}/').extract('001_A001') === 1,
       'and the matcher still reads the card folder, not the empty level');
  }

  console.log('\nthe counter is read on a separator boundary, never inside a name');
  {
    // The pattern used to let the digits float: "1080p_proxies" read as 1080,
    // "260902" (a {YY}{MM}{DD} level, which 2.6.0 now walks) as 2609, and
    // "FX3_001_A001" as 3 — the counter froze and the collision check went
    // blind. The anchor is added only where the template has that boundary.
    const m = (t) => ctx.makeCounterMatcher(t);
    ok(m('{counter}_{cardname}').extract('001_A001') === 1, 'a real card folder still reads');
    ok(m('{counter}_{cardname}').extract('001') === 1, 'and so does one whose other fields were empty');
    ok(m('{counter}_{cardname}').extract('1080p_proxies') === null, '"1080p_proxies" is not counter 1080');
    ok(m('{counter}_{cardname}').extract('260902') === null, 'a {YY}{MM}{DD} level is not counter 2609');
    ok(m('{counter}_{cardname}').extract('12K') === null, 'a camera folder "12K" is not counter 12');
    ok(m('{camera}_{counter}_{cardname}').extract('FX3_001_A001') === 1,
       'the counter is read after the camera, not inside it');
    ok(m('{camera}_{counter}_{cardname}').extract('001_A001') === 1,
       'and still reads when the camera was empty');
    ok(m('{cardname}{counter}').extract('A0011') === 11,
       'a template with NO separator keeps its old looser pattern (missing a card is worse)');
  }
  {
    // End to end: day two of the most natural 2.6.0 template.
    const dst = fresh('dst10');
    fs.mkdirSync(path.join(dst, '260902', '001_A001'), { recursive: true });
    fs.mkdirSync(path.join(dst, '260902', '002_A002'), { recursive: true });
    const tpl = '{YY}{MM}{DD}/{counter}_{cardname}';
    const scan = await call('scan-dest-counter-full', [dst], tpl);
    ok(scan.max === 2 && scan.next === 3,
       'the date level is not counted as a card (next ' + scan.next + ')');
    ok(await call('check-counter-collision', [dst], [3, 4], tpl) === null,
       'and the next counters are not refused');
    const hit = await call('check-counter-collision', [dst], [2], tpl);
    ok(hit && hit.folder === '260902/002_A002', 'a real collision is still caught');
  }

  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
