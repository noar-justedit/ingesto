#!/usr/bin/env node
// The PRO double read (a second read of the card after the copies are
// verified), run against the REAL main.js on real folders.
//
// 2.9.1 replaced the lookup of "which destinations wrote this file" (a scan of
// every destination's whole list, for every file: the square of the file
// count) by an index built once. This checks that the index gives the same
// answer: every file read back identical is credited to every destination that
// wrote it, and only to those.
//
//   node scripts/test-double-read.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-dblread-'));
const fresh = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) {
  const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const list = (d) => { try { return fs.readdirSync(d).sort(); } catch (_) { return null; } };

// ── Electron stub, then the REAL main.js ────────────────────────────────────
const handlers = {};
const userData = fresh('userData');
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true, quit: () => {},
         getVersion: () => '2.6.2', getPath: () => userData, getName: () => 'ingesto', isPackaged: false, setAboutPanelOptions: () => {} },
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
const sentinel = require(path.join(__dirname, '..', 'src', 'main', 'sentinel.js'));
const call = (ch, ...args) => handlers[ch]({ sender: { send: () => {} } }, ...args);

const opts = (x) => ({ mode: 'slow', folderTemplate: '{counter}_{cardname}', writeSentinel: true,
                       writeChecksum: true, cksumList: true, cksumMhl: false, ascMhl: false, ...x });
const ingest = (card, name, dst, o = {}) => call('start-copy', {
  sources: [{ name, path: card, counter: o.counter || '001', cameraman: 'noar', camera: 'FX6', ...(o.src || {}) }],
  destinations: (Array.isArray(dst) ? dst : [dst]).map((p, i) => ({ name: 'D' + (i + 1), path: p })),
  options: opts(o) });
const refused = (r) => r && r.success === false && r.copiedFiles === 0 &&
                       (r.errorList || []).some(e => e.phase === 'setup');

(async () => {
  console.log('\nPRO with double read, three destinations');
  {
    const card = fresh('card'), d1 = fresh('d1'), d2 = fresh('d2'), d3 = fresh('d3');
    const files = {};
    for (let i = 1; i <= 40; i++) files[`CLIP/C${String(i).padStart(4, '0')}.MXF`] = 'frame data ' + i + ' '.repeat(i);
    mk(card, files);
    const R = await ingest(card, 'A001', [d1, d2, d3], { mode: 'pro', proAlgo: 'xxh64', proDoubleRead: true });
    ok(Array.isArray(R) && R.length === 3, 'three results');
    ok(R.every(r => r.success === true && (r.unstableFiles || []).length === 0), 'every destination succeeds, nothing unstable');
    for (const [i, r] of R.entries()) {
      const lists = (list(r.destPath) || []).filter(n => /\.xxh$/.test(n));
      const body = lists.length ? read(path.join(r.destPath, lists[0])) || '' : '';
      const lines = body.split('\n').filter(l => /C\d{4}\.MXF/.test(l));
      ok(lines.length === 40, `destination ${i + 1}: its checksum list holds all 40 files (${lines.length})`);
    }
  }

  console.log('\ntwo destinations, two files: no file credited twice');
  {
    const card = fresh('card2'), d1 = fresh('e1'), d2 = fresh('e2');
    mk(card, { 'A.MXF': 'aaa', 'B.MXF': 'bbbb' });
    const R = await ingest(card, 'A002', [d1, d2], { mode: 'pro', proAlgo: 'xxh64', proDoubleRead: true, counter: '002' });
    ok(R.every(r => r.success === true), 'both destinations succeed');
    const counts = R.map(r => { const l = (list(r.destPath) || []).find(n => /\.xxh$/.test(n));
      return l ? (read(path.join(r.destPath, l)) || '').split('\n').filter(x => /\.MXF/.test(x)).length : -1; });
    ok(counts.every(c => c === 2), 'each checksum list holds exactly its two files (' + counts.join(', ') + ')');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
