#!/usr/bin/env node
// The card handoff (issue #10).
//
// A document written once per card, read by a script that may then erase that
// card. `safeToErase` is the only line in it that matters, and it is the one
// claim INGESTO makes that cannot be taken back: everything else it says can be
// checked again afterwards, this one is acted upon and the card is gone.
//
// So the suite takes every condition of `safeToErase` one at a time, breaks it,
// and requires the answer to become no. And it ties the document to the window:
// a run that offers EJECT and a document that says no, or the reverse, would be
// INGESTO contradicting itself about the same card.
//
//   node scripts/test-handoff.js
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

// ── The document ────────────────────────────────────────────────────────────
const ctx = vm.createContext({ console, Set, Map, Math, Date, Array, String, Number, JSON,
                               S: { appVersion: '2.6.5' } });
vm.runInContext(extractFn(REND, 'modeVerifiesContents'), ctx);
vm.runInContext(extractFn(REND, 'buildHandoff'), ctx);

const RUN = { dests: [{ path: '/Volumes/SHUTTLE_1', name: 'SHUTTLE_1' }],
              runId: 'r1', cksum: true, cksumList: true, cksumMhl: false, ascMhl: false };

// One destination, PRO with the double read, everything perfect.
const good = (over) => Object.assign({
  sourceName: 'A001_LUMIX', sourcePath: '/Volumes/A001_LUMIX',
  destPath: '/Volumes/SHUTTLE_1/001_A001', relFolder: '001_A001',
  mode: 'pro', proAlgo: 'xxh128', proDoubleRead: true,
  success: true, canceled: false, errors: 0, errorList: [],
  failedFiles: [], unstableFiles: [], quarantinedPaths: [], sidecarFailed: [],
  scanIncomplete: false, coldVerify: true, doubleReadCached: false,
  seenFiles: 186, totalFiles: 186, copiedFiles: 186, skippedFiles: 0,
}, over);
const doc = (rs, run) => ctx.buildHandoff(Array.isArray(rs) ? rs : [rs], run || RUN, 0);

console.log('\na clean verified ingest says yes, and says what it is');
{
  const d = doc(good());
  ok(d.safeToErase === true, 'safeToErase is true');
  ok(d.mode === 'pro' && d.contentsVerified === true, 'the mode is named and it verified contents');
  ok(d.doubleRead === true && d.cardStable === true, 'the card was read twice and gave the same data');
  ok(d.coversWholeCard === true, 'and the copy covers the whole card');
  ok(d.files.onCard === 186 && d.files.copied === 186, 'the counts are there');
  ok(d.destinations.length === 1 && d.destinations[0].verified === true,
     'the destination is listed and marked verified');
  ok(d.destinations[0].manifest === 'xxh128', 'with the manifest that vouches for it');
  ok(d.destinations[0].folder === '/Volumes/SHUTTLE_1/001_A001', 'and the folder the card landed in');
  ok(d.source.path === '/Volumes/A001_LUMIX', 'the card is named by its path, never rebuilt from its name');
  ok(d.cardId === 'r1-1' && d.runId === 'r1', 'the card can be tied back to its run');
}

console.log('\nand every single thing that makes it say no');
{
  const cases = [
    ['FAST, nothing was verified',        good({ mode: 'fast' })],
    ['SIZE CHECK, contents not verified', good({ mode: 'normal' })],
    ['the run did not succeed',           good({ success: false })],
    ['an error was counted',              good({ errors: 1 })],
    ['a file failed',                     good({ failedFiles: ['A.MOV'] })],
    ['a bad copy was set aside',          good({ quarantinedPaths: ['/x/A.MOV.ingesto-failed'] })],
    ['part of the card could not be read',good({ scanIncomplete: true })],
    ['the card gave different data twice',good({ unstableFiles: ['A.MOV'] })],
    ['the card re-read came from memory', good({ doubleReadCached: true })],
    ['no manifest was written',           good({ sidecarFailed: ['checksum list'] })],
    ['the run was cancelled',             good({ canceled: true })],
    ['the card was refused',              good({ refused: true })],
    ['the card was empty',                good({ emptyReason: 'no-files', seenFiles: 0, totalFiles: 0, copiedFiles: 0 })],
    ['files were skipped',                good({ skippedFiles: 4, totalFiles: 182, copiedFiles: 182 })],
    ['files were filtered out',           good({ totalFiles: 100, copiedFiles: 100 })],
  ];
  for (const [label, r] of cases) ok(doc(r).safeToErase === false, `${label}: no`);

  // And the two that are about the RUN rather than the card.
  ok(doc(good(), Object.assign({}, RUN, { cksum: false })).safeToErase === false,
     'every checksum switched off, so nothing can be checked again later: no');
  ok(ctx.buildHandoff([], RUN, 0).safeToErase === false, 'no result at all: no');
}

console.log('\nwith two destinations, the weakest one decides');
{
  const RUN2 = Object.assign({}, RUN, { dests: [
    { path: '/Volumes/SHUTTLE_1', name: 'SHUTTLE_1' },
    { path: '/Volumes/NAS_BACKUP', name: 'NAS_BACKUP' }] });
  const a = good();
  const b = good({ destPath: '/Volumes/NAS_BACKUP/001_A001' });
  ok(doc([a, b], RUN2).safeToErase === true, 'two clean destinations: yes');
  const bad = good({ destPath: '/Volumes/NAS_BACKUP/001_A001', success: false, errors: 1,
                     failedFiles: ['A.MOV'], copiedFiles: 185 });
  const d = doc([a, bad], RUN2);
  ok(d.safeToErase === false, 'one drive that lost a file: no');
  ok(d.destinations.length === 2, 'both drives are listed');
  ok(d.destinations[0].verified === true && d.destinations[1].verified === false,
     'each one carries its own verdict');
  ok(d.destinations[1].name === 'NAS_BACKUP', 'named as the operator named it');
  ok(d.files.copied === 185,
     `the file count is the weakest drive (${d.files.copied}), not the best one (186)`);
}

console.log('\nwhat is said when nobody asked the card twice');
{
  // SECURE reads the copy back, but it never re-reads the card. "Stable" is
  // then unknown, and unknown is not true.
  const d = doc(good({ mode: 'slow', proAlgo: null, proDoubleRead: false }));
  ok(d.cardStable === null, 'cardStable is null, not true');
  ok(d.doubleRead === false, 'and it says the card was not read twice');
  ok(d.safeToErase === true, 'which does not stop a SECURE ingest from being enough');
  ok(d.destinations[0].manifest === 'xxh64', 'the manifest is the one SECURE writes');
}

console.log('\nand what is said about the read-back on a machine that cannot beat the cache');
{
  // Every machine except macOS. It is a caveat, not a refusal: refusing here
  // would make the whole feature useless outside macOS. A script that wants to
  // be stricter than INGESTO has the field.
  const d = doc(good({ coldVerify: false }));
  ok(d.readBackCacheBypassed === false, 'the document says the cache was not bypassed');
  ok(d.safeToErase === true, 'and still answers yes, because that is not a failed check');
  const d2 = doc(good({ mode: 'fast', coldVerify: null }));
  ok(d2.readBackCacheBypassed === null, 'in a mode with no read-back at all, it is null');
}

// ── The document against the window ─────────────────────────────────────────
// The same run must not produce a lit EJECT and a document that says no, or a
// document that says yes under a red title. Both verdicts are computed here
// from the same results.
console.log('\nthe document and the window never contradict each other');
{
  const wctx = vm.createContext({
    console,
    document: { getElementById: () => ({ className:'', style:{}, innerHTML:'', textContent:'',
      classList:{ add(){}, remove(){}, toggle(){}, contains:()=>false } }) },
    S: {}, window: { ingesto: { platform:'darwin', isRemovable: async()=>false,
                                detectCamera: async()=>null, ejectVolume: async()=>({ok:true}) } },
    playIngestSound(){}, showToast(){}, redoDoubleRead(){}, revealAt(){},
    ejectOffered: false,
  });
  vm.runInContext([
    extractFn(REND, 'fmtSize'), extractFn(REND, 'fmtSpd'), extractFn(REND, 'fmtEta'),
    extractFn(REND, 'esc'), extractFn(REND, 'renderSummaryNotes'),
    extractFn(REND, 'humanErrno'), extractFn(REND, 'buildFailureGroups'),
    extractFn(REND, 'driveNameOf'), extractFn(REND, 'failureVerdict'),
    extractFn(REND, 'setupEjectButtons').replace('const shown=[];', 'ejectOffered = true; const shown=[];'),
    extractFn(REND, 'showSummary'),
  ].join('\n'), wctx);

  const scenarios = [
    ['a clean PRO ingest',            good()],
    ['FAST',                          good({ mode: 'fast' })],
    ['SIZE CHECK',                    good({ mode: 'normal' })],
    ['a file that failed',            good({ success: false, errors: 1, failedFiles: ['A.MOV'],
                                             errorList: [{ file:'A.MOV', error:'x', phase:'verify',
                                                           origin:'destination' }] })],
    ['a suspect card',                good({ success: false, unstableFiles: ['A.MOV'] })],
    ['a missing manifest',            good({ sidecarFailed: ['checksum list'] })],
    ['a cancelled run',               good({ success: false, canceled: true })],
    ['files skipped',                 good({ skippedFiles: 4, totalFiles: 182, copiedFiles: 182 })],
  ];
  for (const [label, r] of scenarios) {
    wctx.S = { dests: RUN.dests, sources: [], run: RUN };
    wctx.ejectOffered = false;
    wctx.showSummary([r]);
    const d = doc(r);
    // The one direction that matters: the document may never be more
    // optimistic than the window. If EJECT is withheld, "yes" is a lie.
    ok(!(d.safeToErase === true && wctx.ejectOffered === false),
       `${label}: document says ${d.safeToErase ? 'yes' : 'no'}, window ${wctx.ejectOffered ? 'offers' : 'withholds'} EJECT`);
  }
}

// ── The file, and the command ───────────────────────────────────────────────
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-ho-'));

(async () => {

console.log('\nthe document reaches the command, and does not outlive it');
{
  // A script that records the path it was given and the content it read.
  const log = path.join(TMP, 'seen.txt');
  const script = path.join(TMP, 'reader.js');
  fs.writeFileSync(script, `
    const fs=require('fs');
    const p=process.argv[process.argv.length-1];
    fs.writeFileSync(${JSON.stringify(log)}, p+'\\n'+fs.readFileSync(p,'utf8'));
  `);
  const card = fs.mkdtempSync(path.join(TMP, 'card-'));
  const payload = doc(good({ sourcePath: card }));
  const res = await call('handoff', payload, [process.execPath, script]);
  ok(res && res.ok === true, `the command ran (${JSON.stringify(res)})`);
  const seen = fs.readFileSync(log, 'utf8').split('\n');
  const givenPath = seen[0];
  ok(/\.json$/.test(givenPath), `the last argument is a .json path (${path.basename(givenPath)})`);
  const back = JSON.parse(seen.slice(1).join('\n'));
  ok(back.source.path === card, 'the document holds the real card path');
  ok(back.safeToErase === true, 'and its answer survived the trip');
  ok(back.source.stillMounted === true, 'the card was checked to be still there');
  ok(!fs.existsSync(givenPath), 'and the file is gone now that the command has returned');
}

console.log('\na card that is no longer mounted can never be handed over');
{
  const gone = path.join(TMP, 'not-there-at-all');
  const copyTo = path.join(TMP, 'handed.json');
  const script = path.join(TMP, 'noop.js');
  // The copy goes OUTSIDE the scratch directory: that directory and everything
  // a command left in it is removed when the command returns.
  fs.writeFileSync(script, `const fs=require('fs');
    fs.writeFileSync(${JSON.stringify(copyTo)}, fs.readFileSync(process.argv[process.argv.length-1]));`);
  const payload = doc(good({ sourcePath: gone }));
  ok(payload.safeToErase === true, 'the run itself was clean');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => /^ingesto-handoff-/.test(n)));
  const res = await call('handoff', payload, [process.execPath, script]);
  ok(res && res.ok === true, 'the command still runs, because it has to be told');
  const handed = fs.existsSync(copyTo) ? JSON.parse(fs.readFileSync(copyTo, 'utf8')) : null;
  ok(handed !== null, 'the script received a document');
  ok(handed.source.stillMounted === false, 'which says the card is not mounted');
  ok(handed.safeToErase === false, 'and answers no, whatever the run said');
  const left = fs.readdirSync(os.tmpdir()).filter(n => /^ingesto-handoff-/.test(n) && !before.has(n));
  ok(left.length === 0,
     `and nothing is left behind, not even what the command wrote next to the document (${left.join(', ')})`);
}

console.log('\nand a command that cannot be run is reported, not swallowed');
{
  const payload = doc(good());
  const res = await call('handoff', payload, ['/nonexistent/please/no']);
  ok(res && res.ok === false && !!res.error, `reported as a failure (${res.error})`);
  const res2 = await call('handoff', payload, []);
  ok(res2 && res2.ok === false, 'so is an empty command');
  const res3 = await call('handoff', null, [process.execPath, '-e', '0']);
  ok(res3 && res3.ok === false, 'and so is a call with no document');
}

console.log('\na command that fails says so');
{
  const script = path.join(TMP, 'refuse.js');
  fs.writeFileSync(script, 'process.exit(3);');
  const res = await call('handoff', doc(good()), [process.execPath, script]);
  ok(res && res.ok === false && res.code === 3, `exit code carried back (${res.code})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
