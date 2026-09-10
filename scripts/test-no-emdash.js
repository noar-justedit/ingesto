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

const BAD = /[—–]/;

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

const REND = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

console.log('\nthe interface');
{
  const hits = badMarkup(REND);
  ok(hits.length === 0, 'no dash in anything drawn on screen' +
     (hits.length ? '\n       ' + hits.slice(0, 8).join('\n       ') : ''));
  const lit = badLiterals(REND.slice(REND.indexOf('<script')));
  ok(lit.length === 0, 'no dash in any string the interface can show' +
     (lit.length ? '\n       ' + lit.slice(0, 8).join('\n       ') : ''));
}

console.log('\nthe engine');
for (const f of ['main.js', 'preload.js', 'sentinel.js', 'camera-detect.js', 'nocache.js']) {
  const p = path.join(ROOT, 'src', 'main', f);
  if (!fs.existsSync(p)) continue;
  const hits = badLiterals(fs.readFileSync(p, 'utf8'));
  ok(hits.length === 0, `no dash in a message from ${f}` +
     (hits.length ? '\n       ' + hits.slice(0, 8).join('\n       ') : ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
