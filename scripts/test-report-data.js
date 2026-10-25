#!/usr/bin/env node
// The HTML report carries its own data in a gzip+base64 block, and that block
// is what the next ingest reads back first (report-read in main.js) to carry
// the earlier cards over. A field left out of the block is therefore lost for
// every earlier card as soon as one more card is ingested to that drive.
// 2.8.0 lost `folder` and `skipped` this way (fixed in 2.8.1).
//
// This test builds a report with the real buildReportHtml(), decodes the
// block the way main.js does, and checks that every field of a record comes
// back. fileList is the one exception: it is stored as `f` pairs.
//
//   node scripts/test-report-data.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const zlib = require('zlib');

const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractFn(name) {
  let s = REND.indexOf(`async function ${name}(`);
  if (s < 0) s = REND.indexOf(`function ${name}(`);
  if (s < 0) throw new Error('function not found: ' + name);
  let i = REND.indexOf('{', s), d = 0;
  for (; i < REND.length; i++) {
    if (REND[i] === '{') d++;
    else if (REND[i] === '}') { d--; if (!d) return REND.slice(s, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const NAMES = ['tr', 'trf', 'buildReportHtml', 'gzipB64', 'reportFilePairs', 'fmtReportDur', 'fmtSize',
               'mdEscape', 'mdInline', 'mdToHtml', 'fmtReportDate'];
const ctx = vm.createContext({ console, String, Number, Array, Object, Math, JSON, Date, isFinite,
  Blob, Response, CompressionStream, TextEncoder, btoa, Uint8Array, S: { appVersion: 'test' } });
vm.runInContext(NAMES.map(extractFn).join('\n'), ctx);

// Same expression as report-read in main.js.
const decode = (html) => {
  const m = html.match(/<script id="ingesto-report-data" type="application\/gzip\+base64">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(zlib.gunzipSync(Buffer.from(m[1].trim(), 'base64')).toString('utf8')) : null;
};

// A record with every field updateReports() writes, each with a value that
// cannot be confused with a default.
const REC = {
  n: '007', date: '23.10 14:05', card: 'A001', folder: 'DAY01/007_A001_NOAR',
  operator: 'NOAR', cam: 'FX6', pp: 'SLOG3', note: '**take 4** is the one',
  mode: 'Secure', modeClass: 'm-secure', files: 12, bytes: 123456789,
  result: 'OK · 3 already on drive, not copied', rclass: 'r-ok', skipped: 3,
  copyMs: 1500, v1Ms: 900, v2Ms: 0,
  fileList: [{ path: 'CLIP/A001.MXF', size: 100, mtime: 1 }],
};

// The fields the record really has, read from updateReports() itself, so a
// field added there later is checked here without touching this test.
const ur = extractFn('updateReports');
const body = ur.slice(ur.indexOf('return { n:padCounter'));
let block = body.slice(0, body.indexOf('};') + 1)
  .replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*'|`[^`]*`/g, "''");
// Inner objects (the fileList entries) are not record fields: drop them,
// keeping the outer braces.
const inner = block.slice(1, -1);
let flat = inner, prev;
do { prev = flat; flat = flat.replace(/\{[^{}]*\}/g, '0').replace(/\([^()]*\)/g, '0'); } while (flat !== prev);
block = '{' + flat + '}';
// key: value, and shorthand fields such as "result, rclass".
const WRITTEN = [...new Set([
  ...[...block.matchAll(/[{,]\s*([A-Za-z0-9]+)\s*:/g)].map(m => m[1]),
  ...[...block.matchAll(/[{,]\s*([A-Za-z0-9]+)\s*(?=[,}])/g)].map(m => m[1]),
])];

(async () => {
  console.log('\nthe record fields');
  ok(WRITTEN.length >= 15 && WRITTEN.includes('folder') && WRITTEN.includes('skipped'),
     `the fields of a record are read from updateReports() (${WRITTEN.length}: ${WRITTEN.join(' ')})`);
  const missingFromTest = WRITTEN.filter(k => !(k in REC));
  ok(missingFromTest.length === 0, 'this test gives every one of them a value' +
     (missingFromTest.length ? ': missing ' + missingFromTest.join(', ') : ''));

  const html = await ctx.buildReportHtml('2026-10-23T12:00:00Z', '2026-10-23T12:00:00Z', '/D', [REC]);
  const back = decode(html);
  ok(back && Array.isArray(back.records) && back.records.length === 1, 'the data block decodes to one record');
  const r = (back && back.records && back.records[0]) || {};

  console.log('\nevery field comes back from the data block');
  for (const k of WRITTEN) {
    if (k === 'fileList') continue;
    ok(JSON.stringify(r[k]) === JSON.stringify(REC[k]), `${k} survives (${JSON.stringify(r[k])})`);
  }
  ok(Array.isArray(r.f) && r.f.length === 1, 'the file list comes back as pairs');

  console.log('\nand a second ingest keeps them for the earlier card');
  // What updateReports() does: earlier records as read back, plus the new one.
  const next = back.records.concat([Object.assign({}, REC, { n: '008', folder: 'DAY01/008_B001_NOAR', skipped: 0 })]);
  const back2 = decode(await ctx.buildReportHtml(back.created || '', 'u2', '/D', next));
  const r1 = (back2 && back2.records && back2.records[0]) || {};
  ok(r1.folder === REC.folder, 'folder of the first card is still there after the second ingest');
  ok(r1.skipped === REC.skipped, 'skipped of the first card is still there after the second ingest');

  console.log('\nan old report without the fields stays readable');
  const old = Object.assign({}, REC); delete old.folder; delete old.skipped;
  const back3 = decode(await ctx.buildReportHtml('c', 'u', '/D', [old]));
  const r3 = (back3 && back3.records && back3.records[0]) || {};
  ok(r3.folder === '' && r3.skipped === 0, 'missing folder and skipped come back empty, not undefined');

  console.log('\nthe JSON report keeps English values, and adds the texts for a person (2.9.1)');
  {
    const j = vm.createContext({ JSON, Object, INGESTO_I18N: { t: s => 'FR:' + s } });
    vm.runInContext(extractFn('tr') + '\n' + extractFn('buildReportJson'), j);
    const out = JSON.parse(j.buildReportJson('c', 'u', '/D', [Object.assign({}, REC, { result: '2 errors', mode: 'Secure' })])).records[0];
    ok(out.result === '2 errors' && out.mode === 'Secure', 'result and mode stay in English, for scripts and for the next read-back');
    ok(out.resultLabel === 'FR:2 errors' && out.modeLabel === 'FR:Secure', 'resultLabel and modeLabel follow the language');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
