#!/usr/bin/env node
// Interface translation (2.9.0): the engine (src/renderer/i18n.js) and every
// language file in src/renderer/lang/. What can be checked without a
// browser. The checks in a browser (every screen captured, user data never
// translated) are in docs/notes/i18n/ (board.js, userdata.js).
//
//   node scripts/test-i18n.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const REND = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const ENGINE = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
const LANG_DIR = path.join(ROOT, 'src', 'renderer', 'lang');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const DASH = /[—–]|&mdash;|&ndash;/;
const groups = re => { try { return new RegExp(re + '|').exec('').length - 1; } catch (e) { return -1; } };
const vars = s => (String(s).match(/\{[A-Za-z]+\}/g) || []).sort().join(' ');

// ── The engine and its place in the page ──────────────────────────────────
console.log('\nthe engine');
{
  let parsed = true; try { new vm.Script(ENGINE); } catch (e) { parsed = false; }
  ok(parsed, 'i18n.js parses');
  const files = fs.readdirSync(LANG_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const at = REND.indexOf(`<script src="lang/${f}"></script>`);
    ok(at > 0 && at < REND.indexOf('<script src="i18n.js"></script>'), `lang/${f} is loaded, before i18n.js`);
  }
  ok(REND.indexOf('<script src="i18n.js"></script>') < REND.indexOf('</head>'), 'i18n.js is loaded in <head>, before the page is drawn');
  ok(/id="set-language"[^>]*data-i18n-skip/.test(REND), 'Settings has the language menu, and its language names are never translated');
  ok(/language:\(window\.INGESTO_I18N && window\.INGESTO_I18N\.getLanguage\(\)\) \|\| 'en'/.test(REND), 'the language is saved with the preferences');
  ok(/prefs\.language && window\.INGESTO_I18N && prefs\.language!==window\.INGESTO_I18N\.getLanguage\(\)/.test(REND), 'and restored from them at launch');
  // English must stay untouched: with no dictionary the engine does nothing.
  ok(/dict = \(lang === 'en'\) \? null/.test(ENGINE) && /if \(!s \|\| !dict\) return null;/.test(ENGINE), 'in English the engine changes nothing');
  ok(/el\.tagName === 'TEXTAREA'/.test(ENGINE) && /getAttribute\('contenteditable'\) === 'true'/.test(ENGINE), 'what the user types (textarea, rich notes) is never walked into');
  for (const cls of ['.vc-name', '.zi-name', '.src-info-name', '.tok-txt', '.md-note', '.mdn', '#pf-ov .m', '.tf-file'])
    ok(ENGINE.includes(cls), `user data ${cls} is never translated`);
  ok(/'<div class="mem-name"' \+ \(p \? ' data-i18n-skip' : ''\)/.test(REND), 'a saved template keeps its name, an empty slot is translated');
  // 2.9.1: records of nodes the code has replaced are dropped, or a day of
  // ingests in French keeps every progress label ever shown in memory.
  ok(/function sweep\(\)[\s\S]{0,400}isConnected/.test(ENGINE) && /if \(sinceSweep > \d+\) sweep\(\);/.test(ENGINE),
     'translation records of nodes no longer in the page are dropped');
  // A system dialog is not in the page: its text must go through tr()/trf().
  const rawConfirm = [...REND.matchAll(/confirm\(\s*(['"`])/g)].length;
  ok(rawConfirm === 0, 'no confirm() with a text the dictionary never sees (' + rawConfirm + ')');
}

// ── Each language file ────────────────────────────────────────────────────
for (const f of fs.readdirSync(LANG_DIR).filter(f => f.endsWith('.js'))) {
  console.log(`\nlang/${f}`);
  const ctx = { window: {} };
  let loaded = true;
  try { vm.runInNewContext(fs.readFileSync(path.join(LANG_DIR, f), 'utf8'), ctx); } catch (e) { loaded = false; }
  ok(loaded, 'loads');
  const name = Object.keys(ctx.window)[0];
  const d = ctx.window[name] || {};
  ok(new RegExp(`dictName: '${name}'`).test(ENGINE), `${name} is declared in LANGS (i18n.js)`);
  const plain = Object.entries(d.texts || {}).concat(Object.entries(d.attrs || {})).concat(Object.entries(d.blocks || {}));
  const pats = (d.patterns || []).concat(d.blockPatterns || []);
  ok(plain.length > 400, `${plain.length} texts, ${pats.length} patterns`);

  const dashes = plain.filter(([, v]) => DASH.test(v)).map(([k]) => k).concat(pats.filter(p => DASH.test(p[1])).map(p => p[0]));
  ok(dashes.length === 0, 'no long dash in a translation' + (dashes.length ? ': ' + dashes.slice(0, 3).join(' | ') : ''));

  // Keys are looked up with their spaces tidied (none at the ends, one
  // between words): a key written otherwise can never be found.
  const untidy = plain.map(([k]) => k).filter(k => k !== k.replace(/\s+/g, ' ').trim());
  ok(untidy.length === 0, 'no key with spaces at its ends or doubled' + (untidy.length ? ': ' + JSON.stringify(untidy[0]) : ''));

  const empty = plain.filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
  ok(empty.length === 0, 'no empty translation' + (empty.length ? ': ' + empty.slice(0, 3).join(' | ') : ''));

  const badRe = pats.filter(p => groups(p[0]) < 0).map(p => p[0]);
  ok(badRe.length === 0, 'every pattern is a valid regular expression' + (badRe.length ? ': ' + badRe[0] : ''));
  const anchored = pats.filter(p => !(p[0].startsWith('^') && p[0].endsWith('$'))).map(p => p[0]);
  ok(anchored.length === 0, 'every pattern matches a whole text (^...$), never a piece of one' + (anchored.length ? ': ' + anchored[0] : ''));
  // $3 in a template with two groups would print "$3" on screen.
  const badRef = pats.filter(p => { const n = groups(p[0]); return (String(p[1]).match(/\$(\d)/g) || []).some(r => +r.slice(1) > n); }).map(p => p[0]);
  ok(badRef.length === 0, 'no template uses a value its pattern does not capture' + (badRef.length ? ': ' + badRef[0] : ''));
  const lost = pats.filter(p => { const n = groups(p[0]); for (let i = 1; i <= n; i++) if (!String(p[1]).includes('$' + i)) return true; return false; }).map(p => p[0]);
  ok(lost.length === 0, 'every captured value (a name, a number) is shown in the translation' + (lost.length ? ': ' + lost.slice(0, 2).join(' | ') : ''));

  // {counter}, {cardname}... are the folder template's own words.
  const varLost = plain.filter(([k, v]) => vars(k) !== vars(v)).map(([k]) => k);
  ok(varLost.length === 0, 'every {variable} of the original is kept, untranslated' + (varLost.length ? ': ' + varLost.slice(0, 2).join(' | ') : ''));

  // A tag in a paragraph translation must be one the original has.
  const tagsOf = s => (String(s).match(/<\/?([a-z]+)/g) || []).map(t => t.replace(/[<\/]/g, '')).sort().join(' ');
  const tagBad = Object.entries(d.blocks || {}).filter(([k, v]) => tagsOf(k) !== tagsOf(v)).map(([k]) => k.slice(0, 60));
  ok(tagBad.length === 0, 'paragraph translations keep the same tags as the original' + (tagBad.length ? ': ' + tagBad[0] : ''));

  // A name of a mode stays a name.
  const MODES = ['FAST', 'SIZE CHECK', 'SECURE', 'PRO', 'KIOSK'];
  const modeLost = plain.filter(([k, v]) => MODES.some(m => new RegExp(`\\b${m}\\b`).test(k) && !new RegExp(`\\b${m}\\b`).test(v) && !/^[A-Z ]+$/.test(k))).map(([k]) => k);
  ok(modeLost.length === 0, 'mode names (FAST, SIZE CHECK, SECURE, PRO, KIOSK) are kept' + (modeLost.length ? ': ' + modeLost.slice(0, 2).join(' | ') : ''));

  // The same key twice in one section: JavaScript keeps the last one,
  // without a word, and the first translation is silently lost.
  const src = fs.readFileSync(path.join(LANG_DIR, f), 'utf8');
  const dup = [];
  for (const part of ['texts', 'attrs', 'blocks']) {
    const a = src.indexOf(`  ${part}: {`); if (a < 0) continue;
    const b = src.indexOf('\n  },', a);
    const keys = [...src.slice(a, b).matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)].map(m => m[1]);
    const seen = new Set();
    for (const k of keys) { if (seen.has(k)) dup.push(part + ' ' + k); seen.add(k); }
  }
  ok(dup.length === 0, 'no key written twice in a section' + (dup.length ? ': ' + dup.slice(0, 3).join(' | ') : ''));

  // Two entries for the same text with two different translations: the
  // second one would never be seen.
  const both = Object.keys(d.texts || {}).filter(k => (d.attrs || {})[k] !== undefined && d.attrs[k] !== d.texts[k]);
  ok(both.length === 0, 'no text translated two different ways' + (both.length ? ': ' + both[0] : ''));
}

// ── Texts the code translates itself ─────────────────────────────────────
// Notifications, reports and the main process's dialogs are not on screen:
// the code passes them to tr(), trf() or i18n.t(). Every such text must be
// in every dictionary, or it silently stays in English.
console.log('\ntexts translated by the code');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
function calledWith(src, fnRe) {
  const out = new Set();
  const re = new RegExp(fnRe + '\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1, q = null;
    const start = i;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const arg = src.slice(start, i - 1);
    const lits = [...arg.matchAll(/'((?:\\.|[^'\\])*)'/g)].map(x => x[1].replace(/\\(.)/g, '$1'));
    if (/^\s*'(?:\\.|[^'\\])*'(\s*\+\s*'(?:\\.|[^'\\])*')*\s*$/.test(arg)) out.add(lits.join(''));
    else lits.forEach(l => out.add(l));
  }
  return [...out].filter(k => /[A-Za-z]{2,}/.test(k));
}
const used = calledWith(REND, '\\b(?:tr|trf)').concat(calledWith(MAIN, '\\bi18n\\.t'));
// The CSV column titles go through .map(tr).
const csv = REND.match(/const head=\[([^\]]+)\]\.map\(tr\)/);
ok(!!csv, 'the CSV column titles are translated');
if (csv) for (const m of csv[1].matchAll(/'([^']+)'/g)) used.push(m[1]);
ok(used.length > 60, `${used.length} texts found in tr(), trf(), i18n.t()`);
for (const f of fs.readdirSync(LANG_DIR).filter(f => f.endsWith('.js'))) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(LANG_DIR, f), 'utf8'), ctx);
  const d = Object.values(ctx.window)[0] || {};
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const has = k => { k = norm(k); return (d.texts && k in d.texts) || (d.attrs && k in d.attrs) || (d.patterns || []).some(p => new RegExp(p[0]).test(k)); };
  const missing = used.filter(k => !has(k));
  ok(missing.length === 0, `lang/${f} translates all of them` + (missing.length ? ': ' + missing.slice(0, 4).map(x => JSON.stringify(x)).join(' | ') : ''));
}

// ── The name of the app ────────────────────────────────────────────────────
// "ingesto", in lowercase, like the logo (decided 2.9.1). Only file names
// (INGESTO_report.html) and the tool name inside the MHL manifests keep the
// capitals.
console.log('\nthe name of the app');
{
  const caps = [];
  for (const [name, src] of [['index.html', REND], ['main.js', MAIN],
       ...fs.readdirSync(LANG_DIR).filter(f => f.endsWith('.js')).map(f => ['lang/' + f, fs.readFileSync(path.join(LANG_DIR, f), 'utf8')])])
    src.split('\n').forEach((l, i) => { if (/\bINGESTO\b(?!_)/.test(l) && !/<tool>INGESTO/.test(l)) caps.push(`${name}:${i + 1}`); });
  ok(caps.length === 0, 'written "ingesto" everywhere' + (caps.length ? ': ' + caps.slice(0, 5).join(', ') : ''));
}

// ── The main process's loader ─────────────────────────────────────────────
console.log('\nthe main process');
{
  const L = require(path.join(ROOT, 'src', 'main', 'lang.js'));
  ok(L.t('Quit Anyway') === 'Quit Anyway' && L.language === 'en', 'in English, texts come back unchanged');
  L.setLanguage('fr');
  ok(L.language === 'fr' && L.t('Quit Anyway') === 'Quitter quand même', 'in French, a dialog button is translated');
  ok(L.t('Date:') === 'Date\u00a0:', 'with the no-break space before the colon');
  ok(L.t('A text nobody translated') === 'A text nobody translated', 'a text missing from the dictionary stays in English');
  ok(L.locale() === 'fr', 'dates for a person follow the language');
  // 2.9.1: a code that is not exactly a file name ("fr " in a hand-edited
  // preference) used to be kept raw and crash toLocaleString() while the
  // shooting note was written, after the copy and before the verification.
  for (const odd of ['fr ', 'fr_', '../fr']) {
    L.setLanguage('en'); L.setLanguage(odd);
    let threw = false; try { new Date().toLocaleString(L.locale()); } catch (e) { threw = true; }
    ok(L.language === 'fr' && !threw, `"${odd}" is read as fr, and dates still format`);
  }
  L.setLanguage('xx/../../etc');
  ok(L.language === 'en', 'an unknown or odd language name falls back to English');
  ok(/^# ' \+ NOTE_HEADER|'# ' \+ NOTE_HEADER/.test(MAIN) && /const NOTE_HEADER = 'ingesto - Shooting Note'/.test(MAIN),
     'the note keeps its English first line: Verify recognises the note by it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
