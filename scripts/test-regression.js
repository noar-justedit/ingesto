#!/usr/bin/env node
// The regression bench: what the engine does, recorded, and compared.
//
// Runs real ingests through the real main.js on real folders, in every mode
// and in the situations that matter (several destinations, a card already
// ingested, a refusal, the file filter, subfolders, a shooting note), and
// compares two things with the record kept in scripts/fixtures/regression.json:
//
//   - the result the engine returns to the window, field by field;
//   - every file each run left on disk (name, size, bytes) and, for the
//     manifests and notes, their text.
//
// A clean-up of the engine must leave both unchanged. A red line names the
// scenario and the field or file that moved.
//
//   node scripts/test-regression.js            compare with the record
//   node scripts/test-regression.js --update   rewrite the record (after a
//                                              change that is MEANT to alter
//                                              what the engine does)
//
// Anything that legitimately differs from one run or machine to the next is
// taken out before the comparison: timings, speeds, dates, the version,
// absolute paths, and whether the OS cache could be defeated.
const fs   = require('fs');
const path = require('path');
const H    = require('./lib/harness');

const UPDATE = process.argv.includes('--update');
const RECORD = path.join(__dirname, 'fixtures', 'regression.json');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const { call } = H.loadMain({ version: '0.0.0' });

// ── What is left out of the comparison ─────────────────────────────────────
const VOLATILE = new Set(['copyMs', 'verify1Ms', 'verify2Ms', 'duration', 'copySpeed', 'doubleReadSpeed',
                          'cacheProbe', 'coldVerify', 'doubleReadCached', 'recheckList']);
const relPath = (s) => String(s).split(H.TMP).join('<tmp>').split(path.sep).join('/');
function normaliseResult(r) {
  const out = {};
  for (const k of Object.keys(r).sort()) {
    if (VOLATILE.has(k)) continue;
    let v = r[k];
    if (typeof v === 'string') v = relPath(v);
    else if (k === 'errorList' || k === 'notes') v = v.map(e => JSON.parse(relPath(JSON.stringify(e))));
    else if (k === '_cksumEntries') v = v.map(e => ({ rel: e.rel, hash: e.hash, size: e.size }));
    else if (k === '_copiedForSentinel') v = v.map(e => ({ p: e.p, s: e.s, d: e.d }));
    else if (v && typeof v === 'object' && !Array.isArray(v)) v = JSON.parse(relPath(JSON.stringify(v)));
    out[k] = v;
  }
  return out;
}
// Manifests, checksum lists, notes and the card log carry dates, the version
// and the machine: those lines are blanked, the rest is compared as text.
function normaliseText(rel, text) {
  if (!/\.(mhl|xxh|md5|md|json|txt)$/i.test(rel)) return null;
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<date>')
    .replace(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/g, '<date>')
    .replace(/<(startdate|finishdate|creationdate|lastmodificationdate)>[^<]*<\/\1>/gi, '<$1><date></$1>')
    .replace(/"(date|hostname|host|username|user)":\s*"[^"]*"/g, '"$1": "<x>"')
    .replace(/"(\w*version)":\s*"[^"]*"/g, '"$1": "<v>"')
    .replace(/INGESTO [0-9.]+/g, 'INGESTO <v>')
    .replace(/ingesto [0-9.]+/g, 'ingesto <v>')
    .replace(/<hostname>[^<]*<\/hostname>/g, '<hostname><x></hostname>')
    .replace(/<username>[^<]*<\/username>/g, '<username><x></username>')
    .split(H.TMP).join('<tmp>');
}
const tree = (dir) => H.snapshotTree(dir, normaliseText);

// ── The scenarios ──────────────────────────────────────────────────────────
const src = (dir, name, extra) => Object.assign({ name, path: dir, counter: '001', cameraman: 'noar', camera: 'FX6', pp: 'SLOG3', note: '' }, extra);
const opts = (x) => Object.assign({ mode: 'slow', proAlgo: 'xxh64', proDoubleRead: false, folderTemplate: '{counter}_{cardname}',
  writeSentinel: false, writeChecksum: true, cksumList: true, cksumMhl: true, ascMhl: false, fileFilter: null }, x);
const ingest = (sources, dests, o) => call('start-copy', {
  sources, destinations: dests.map((p, i) => ({ name: 'D' + (i + 1), path: p })), options: opts(o) });

const SCENARIOS = {
  // Every mode, two destinations, one classic card.
  async 'fast, two destinations'() {
    const c = H.card(H.fresh('c-fast'), H.CARD_CLASSIC), d1 = H.fresh('d-fast-1'), d2 = H.fresh('d-fast-2');
    return { results: await ingest([src(c, 'A001')], [d1, d2], { mode: 'fast' }), trees: [tree(d1), tree(d2)], cardAfter: tree(c) };
  },
  async 'size check'() {
    const c = H.card(H.fresh('c-size'), H.CARD_CLASSIC), d = H.fresh('d-size');
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'normal' }), trees: [tree(d)] };
  },
  async 'secure, two destinations'() {
    const c = H.card(H.fresh('c-sec'), H.CARD_CLASSIC), d1 = H.fresh('d-sec-1'), d2 = H.fresh('d-sec-2');
    return { results: await ingest([src(c, 'A001')], [d1, d2], { mode: 'slow' }), trees: [tree(d1), tree(d2)] };
  },
  async 'pro xxh64'() {
    const c = H.card(H.fresh('c-pro'), H.CARD_CLASSIC), d = H.fresh('d-pro');
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'pro', proAlgo: 'xxh64' }), trees: [tree(d)] };
  },
  async 'pro xxh128 with card re-read'() {
    const c = H.card(H.fresh('c-pro2'), H.CARD_CLASSIC), d = H.fresh('d-pro2');
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'pro', proAlgo: 'xxh128', proDoubleRead: true }), trees: [tree(d)] };
  },
  async 'pro md5'() {
    const c = H.card(H.fresh('c-md5'), H.CARD_CLASSIC), d = H.fresh('d-md5');
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'pro', proAlgo: 'md5' }), trees: [tree(d)] };
  },
  // The card log, then "copy new files only": the second ingest to the same
  // drive copies only the clip added since.
  async 'card log, then only the new file'() {
    const c = H.card(H.fresh('c-log'), H.CARD_CLASSIC), d = H.fresh('d-log');
    const first = await ingest([src(c, 'A001')], [d], { mode: 'slow', writeSentinel: true });
    H.card(c, { 'PRIVATE/M4ROOT/CLIP/C0003.MP4': 2048 });
    const info = await call('inspect-card', c, false, [d]);
    const second = await ingest([src(c, 'A001', { counter: '002' })], [d],
      { mode: 'slow', writeSentinel: true, skipKeys: info._skippableKeys });
    return { results: first.concat(second), trees: [tree(d)], cardAfter: tree(c),
             inspect: { counts: info.counts, hasSentinel: info.hasSentinel } };
  },
  // The folder already holds footage: refused before a byte moves.
  async 'refused: the folder already exists'() {
    const c = H.card(H.fresh('c-ref'), H.CARD_CLASSIC), d = H.fresh('d-ref');
    H.card(d, { '001_A001/CLIP.MOV': 'earlier footage' });
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'fast' }), trees: [tree(d)] };
  },
  // Subfolders in the template, and the shooting note.
  async 'subfolders and a note'() {
    const c = H.card(H.fresh('c-sub'), H.CARD_CLASSIC), d = H.fresh('d-sub');
    return { results: await ingest([src(c, 'A001', { note: '**take 4** is the one\n\n- [x] checked' })], [d],
      { mode: 'slow', folderTemplate: 'DAY01/{counter}_{cardname}_{operator}' }), trees: [tree(d)] };
  },
  // The file filter: only video and pictures, reorganised into /VIDEO and /PICTURES.
  async 'file filter, reorganised'() {
    const c = H.card(H.fresh('c-ff'), H.CARD_CLASSIC), d = H.fresh('d-ff');
    const fileFilter = { extCat: { mp4: 'VIDEO', mov: 'VIDEO', jpg: 'PICTURES', wav: 'AUDIO' }, copyEmpty: false, reorganize: true };
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'slow', fileFilter }), trees: [tree(d)] };
  },
  async 'file filter, folders kept'() {
    const c = H.card(H.fresh('c-ff2'), H.CARD_CLASSIC), d = H.fresh('d-ff2');
    const fileFilter = { extCat: { mp4: 'VIDEO', xml: 'OTHERS' }, copyEmpty: true, reorganize: false };
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'fast', fileFilter }), trees: [tree(d)] };
  },
  // Two cards in one batch, and a card that is a folder inside a volume.
  async 'two cards in one batch'() {
    const a = H.card(H.fresh('c-b1'), H.CARD_CLASSIC), b = H.card(H.fresh('c-b2'), { 'CLIP/B.MOV': 5000, 'CLIP/B.XML': 200 });
    const d = H.fresh('d-batch');
    return { results: await ingest([src(a, 'A001'), src(b, 'B001', { counter: '002' })], [d], { mode: 'slow' }), trees: [tree(d)] };
  },
  // A card with nothing to copy.
  async 'empty card'() {
    const c = H.fresh('c-empty'), d = H.fresh('d-empty');
    return { results: await ingest([src(c, 'A001')], [d], { mode: 'slow' }), trees: [tree(d)] };
  },
  // Verify, run later on a delivered folder: untouched, then one byte changed.
  async 'verify a delivered folder'() {
    const c = H.card(H.fresh('c-ver'), H.CARD_CLASSIC), d = H.fresh('d-ver');
    const r = await ingest([src(c, 'A001')], [d], { mode: 'pro', proAlgo: 'xxh64' });
    const clean = await call('verify-folder', r[0].destPath);
    const clip = path.join(r[0].destPath, 'PRIVATE/M4ROOT/CLIP/C0002.MP4');
    const buf = fs.readFileSync(clip); buf[100] ^= 0xff; fs.writeFileSync(clip, buf);
    const bad = await call('verify-folder', r[0].destPath);
    const slim = (v) => JSON.parse(relPath(JSON.stringify(v)));
    return { verify: { clean: slim(clean), bad: slim(bad) } };
  },
};

(async () => {
  const actual = {};
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    // A scenario that blows up is a difference like any other, reported on
    // its own line, not the end of the whole bench.
    let out;
    try { out = await fn(); if (out.results) out.results = out.results.map(normaliseResult); }
    catch (e) { out = { crashed: relPath(e && e.message || String(e)) }; }
    actual[name] = out;
  }

  if (UPDATE) {
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify(actual, null, 1) + '\n');
    console.log(`record written: ${path.relative(H.ROOT, RECORD)} (${Object.keys(actual).length} scenarios)`);
    H.cleanup();
    return;
  }

  let expected;
  try { expected = JSON.parse(fs.readFileSync(RECORD, 'utf8')); }
  catch (e) { console.log('no record yet: run with --update first'); process.exit(2); }

  // One line per scenario; on a difference, the first paths that differ.
  const diffs = (a, b, at, acc) => {
    if (acc.length > 6) return acc;
    if (typeof a !== typeof b || (a && typeof a === 'object') !== (b && typeof b === 'object')) { acc.push(at); return acc; }
    if (a && typeof a === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], at + '/' + k, acc);
      return acc;
    }
    if (a !== b) acc.push(at + ` (${JSON.stringify(b)} became ${JSON.stringify(a)})`);
    return acc;
  };
  console.log('\nthe engine still does what the record says');
  for (const name of Object.keys(SCENARIOS)) {
    const d = diffs(actual[name], expected[name], '', []);
    ok(d.length === 0 && name in expected, name + (d.length ? ':\n         ' + d.join('\n         ') : ''));
  }
  const stale = Object.keys(expected).filter(k => !(k in SCENARIOS));
  ok(stale.length === 0, 'the record has no scenario this test no longer runs' + (stale.length ? ': ' + stale.join(', ') : ''));

  H.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); H.cleanup(); process.exit(2); });
