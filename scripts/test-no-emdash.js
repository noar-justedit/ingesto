#!/usr/bin/env node
// A house rule, and it is not decorative: no em dash (U+2014) and no en dash
// (U+2013) in anything a user reads. Not in a dialog, not in a toast, not in a
// tooltip, not in a notification, not in a label on screen.
//
// Code comments are exempt: nobody reads them in the app.
//
//   node scripts/test-no-emdash.js
//
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// The character itself, and every way of writing it that still draws it on
// screen: an HTML entity in the markup (&mdash; slipped through this test in
// the ntfy help text), a numeric reference, or a \u escape in a string.
const BAD = /[—–]|&mdash;|&ndash;|&#821[12];|&#x201[34];|\\u201[34]/i;

// ── String literals in the JavaScript ──────────────────────────────────────
// Comment lines are skipped; everything else that is quoted can reach a screen.
function badLiterals(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
    let m;
    while ((m = re.exec(lines[i]))) if (BAD.test(m[0])) hits.push(`${i + 1}: ${m[0].slice(0, 90)}`);
  }
  return hits;
}

// ── Text nodes in the HTML ─────────────────────────────────────────────────
// Everything outside <script>, <style> and comments is on screen.
function badMarkup(html) {
  const head = html.slice(0, html.indexOf('<script'));
  const noComments = head.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];
  noComments.split('\n').forEach((line, i) => {
    // Only the text between tags, and attribute values that are shown
    // (title=, placeholder=, data-tip=).
    const texts = [...line.matchAll(/>([^<>]+)</g)].map(m => m[1]);
    const attrs = [...line.matchAll(/(?:title|placeholder|data-tip)="([^"]*)"/g)].map(m => m[1]);
    for (const t of texts.concat(attrs))
      if (BAD.test(t)) hits.push(`${i + 1}: ${t.trim().slice(0, 90)}`);
  });
  return hits;
}


// ── Template literals over several lines ───────────────────────────────────
// badLiterals() reads one line at a time, so a `...` spanning lines escaped
// it: the HTML report template carried "INGESTO — Ingest Report" in its
// <title> until 2.8.1. Here the whole file is read at once. Comment lines
// and trailing "// " comments are blanked first, so a backtick written in a
// comment cannot pair with a real one.
function badTemplates(src) {
  const code = src.split('\n').map(l => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    return l.replace(/(^|[\s;{}),])\/\/ .*$/, '$1');
  }).join('\n');
  const hits = [];
  const re = /`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(code))) {
    if (!m[0].includes('\n')) continue;
    const i = m[0].search(BAD);
    if (i < 0) continue;
    const line = code.slice(0, m.index + i).split('\n').length;
    hits.push(`${line}: ${m[0].slice(Math.max(0, i - 40), i + 30).replace(/\n/g, ' ')}`);
  }
  return hits;
}

const REND = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

console.log('\nthe interface');
{
  const hits = badMarkup(REND);
  ok(hits.length === 0, 'no dash in anything drawn on screen' +
     (hits.length ? '\n       ' + hits.slice(0, 8).join('\n       ') : ''));
  const lit = badLiterals(REND.slice(REND.indexOf('<script')));
  ok(lit.length === 0, 'no dash in any string the interface can show' +
     (lit.length ? '\n       ' + lit.slice(0, 8).join('\n       ') : ''));
  const off = REND.slice(0, REND.indexOf('<script')).split('\n').length - 1;
  const tpl = badTemplates(REND.slice(REND.indexOf('<script')))
    .map(h => h.replace(/^(\d+)/, n => String(+n + off)));
  ok(tpl.length === 0, 'no dash in a template over several lines (the HTML report)' +
     (tpl.length ? '\n       ' + tpl.slice(0, 8).join('\n       ') : ''));
  // The report template must really be in the scanned text, or the check
  // above passes on nothing.
  ok(/<title>\$\{escH\(tr\('ingesto - Ingest Report'\)\)\}<\/title>/.test(REND), 'the HTML report template is part of the scan');
}

console.log('\nthe engine');
for (const f of ['main.js', 'preload.js', 'sentinel.js', 'camera-detect.js', 'nocache.js']) {
  const p = path.join(ROOT, 'src', 'main', f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const hits = badLiterals(src).concat(badTemplates(src));
  ok(hits.length === 0, `no dash in a message from ${f}` +
     (hits.length ? '\n       ' + hits.slice(0, 8).join('\n       ') : ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
