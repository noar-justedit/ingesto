#!/usr/bin/env node
// The ingest report is written AFTER the panels unlock, and it is not awaited.
// Everything it depends on has to be the state as it was when START was
// pressed, not whatever is on screen by the time it runs.
//
// The destinations and the card list were frozen in 2.6.3. The switches that
// say WHICH files to write were not: turning the CSV on while a card was
// copying produced a CSV for that run, and turning the report off produced
// nothing at all for a run the operator had already been told was complete.
// Importing a settings file did the same thing without anyone touching a
// switch.
//
//   node scripts/test-report-freeze.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// Every write the function attempts, in order.
let written = [];
const ctx = vm.createContext({
  console, Promise, Date, Array, Math, JSON, String, Number, isFinite,
  // Live state: deliberately the OPPOSITE of what the run below froze, so a
  // read of the live switches is visible in the result rather than harmless.
  S: { dests: [{ path: '/D', name: 'D' }], sources: [{ path: '/card', name: 'A001' }],
       writeReport: false, reportHtml: false, reportCsv: true, reportJson: true, reportFull: false,
       counterWidth: 4 },
  window: { ingesto: {
    reportRead:      async () => null,
    reportWrite:     async (p, html) => { written.push(['html', p, html]); return true; },
    reportWriteNamed: async (p, name, body) => { written.push([name, p, body]); return true; },
  } },
  showToast(){}, esc: (s) => String(s),
  // The real one: the record number in the report has to be written with the
  // width the RUN used, not with the setting as it stands now.
  COUNTER_WIDTHS: [2,3,4],
  reportModeLabel: () => 'SECURE', reportModeClass: () => 'm-secure',
  fmtReportDate: (x) => String(x), fmtReportDur: (x) => String(x),
  buildReportHtml:  async (c, n, p, recs) => 'HTML:' + JSON.stringify(recs),
  buildReportCsv:   (recs) => 'CSV:' + JSON.stringify(recs),
  buildReportJson:  (c, n, p, recs) => 'JSON:' + JSON.stringify(recs),
});
vm.runInContext(extractFn(REND, 'padCounter'), ctx);
vm.runInContext(extractFn(REND, 'updateReports'), ctx);

const result = (over) => Object.assign({
  sourceName: 'A001', sourcePath: '/card', destPath: '/D/001_A001', relFolder: '001_A001',
  mode: 'slow', success: true, errors: 0, failedFiles: [], unstableFiles: [],
  copiedFiles: 3, copiedBytes: 3000, skippedFiles: 0, duration: 1000,
  fileList: [{ path: 'A.MOV', size: 1000, mtime: 1 }],
}, over);

const RUN = (report) => ({ dests: [{ path: '/D', name: 'D' }],
                           sources: [{ path: '/card', name: 'A001' }], report });

(async () => {

console.log('\nthe run writes what was switched on when it started');
{
  written = [];
  await ctx.updateReports([result()], 1,
    RUN({ any: true, html: true, csv: false, json: false, full: true }));
  ok(written.length === 1, 'exactly one file is written');
  ok(written[0][0] === 'html', 'and it is the HTML report');
  ok(/A\.MOV/.test(written[0][2]), 'with the file list, because the run asked for a full report');
}

console.log('\nand not what the switches say now');
{
  // The live state above has HTML off, CSV and JSON on, and the light report.
  // If any of that leaks in, this run produces the wrong files.
  written = [];
  await ctx.updateReports([result()], 1,
    RUN({ any: true, html: true, csv: false, json: false, full: true }));
  ok(!written.some(w => w[0] === 'INGESTO_report.csv'), 'no CSV, though the switch is on now');
  ok(!written.some(w => w[0] === 'INGESTO_report.json'), 'no JSON either');
  ok(written.length === 1 && written[0][0] === 'html', 'still just the HTML report');
}

console.log('\nthe other way round too');
{
  written = [];
  await ctx.updateReports([result()], 1,
    RUN({ any: true, html: false, csv: true, json: true, full: false }));
  const names = written.map(w => w[0]).sort();
  ok(names.length === 2 && names[0] === 'INGESTO_report.csv' && names[1] === 'INGESTO_report.json',
     'the CSV and the JSON are written, the HTML is not (' + names.join(', ') + ')');
  const csv = written.find(w => w[0] === 'INGESTO_report.csv');
  ok(!/A\.MOV/.test(csv[2]), 'and the record carries no file list, because the run asked for a light report');
}

console.log('\nthe record number is written with the width the run used');
{
  // The live setting above is 4 digits. A report describing folders that were
  // created with 2 must not renumber them.
  written = [];
  await ctx.updateReports([result()], 7,
    Object.assign(RUN({ any: true, html: true, csv: false, json: false, full: true }),
                  { counterWidth: 2 }));
  ok(/"n":"07"/.test(written[0][2]), 'the record is 07, as on the drive');
  ok(!/"n":"0007"/.test(written[0][2]), 'not 0007, which is what the setting says now');
}

console.log('\na run with no frozen switches still writes a report');
{
  // Belt and braces: an older call site, or a run object rebuilt somewhere
  // else, must not silently produce nothing at all.
  written = [];
  await ctx.updateReports([result()], 1, { dests: [{ path: '/D', name: 'D' }], sources: [] });
  ok(written.length === 1 && written[0][0] === 'html', 'the HTML report, as the default');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
