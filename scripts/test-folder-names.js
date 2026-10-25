#!/usr/bin/env node
// What a folder name may hold, by language (2.9.0, decided with Noar on
// 23.10.2026):
//   English, French: no accent, no space, no special character in anything
//   that becomes a folder name ("é" becomes "e"). Only the note accepts all.
//   Chinese: wibi8bo's rule, only what a filesystem forbids is removed.
// The interface decides the rule (nameRule) and hands it to the engine with
// each card. The preview (index.html resolveTplSegs) and the engine (main.js
// resolveTemplateVars) must agree, and the counter scan must still find the
// folders created this way.
//
//   node scripts/test-folder-names.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const extractConst = (src, name) => src.match(new RegExp(`^const ${name} = .*;$`, 'm'))[0];

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── Engine ────────────────────────────────────────────────────────────────
const eng = vm.createContext({ console });
vm.runInContext([extractConst(MAIN, 'CLOCK_TOKENS'), 'resolveTemplateVars', 'cleanSegment', 'buildFolderSegments',
  'templateSegments', 'makeCounterMatcher'].map(n => n.startsWith('const') ? n : extractFn(MAIN, n)).join('\n'), eng);

// ── Interface ─────────────────────────────────────────────────────────────
function rendCtx(lang) {
  const c = vm.createContext({
    console, INGESTO_I18N: { getLanguage: () => lang },
    S: { counter: 1, tokens: [] }, padCounter: n => String(n).padStart(3, '0'),
    document: { getElementById: () => null },
  });
  vm.runInContext(['nameRule', 'asciiFold', 'tplText', 'sanitizeMeta', 'resolveTplSegs', 'buildTplStr', 'litTokens']
    .map(n => extractFn(REND, n)).join('\n'), c);
  return c;
}
const fr = rendCtx('fr'), en = rendCtx('en'), zh = rendCtx('zh-CN');
const CLOCK = new Date(2026, 9, 23, 14, 5, 0);
const card = (over) => Object.assign({ name: 'A001', counter: '001', cameraman: '', camera: '', pp: '' }, over);
const engSegs = (tpl, c) => eng.buildFolderSegments(tpl, c, CLOCK).join('/');
const renSegs = (ctx, tpl, c) => ctx.resolveTplSegs(tpl, { name: c.name, operator: c.cameraman, camera: c.camera, pp: c.pp, nameRule: c.nameRule }, 0, CLOCK).join('/');

console.log('\nthe rule follows the language');
ok(fr.nameRule() === 'ascii' && en.nameRule() === 'ascii', 'English and French: ascii');
ok(zh.nameRule() === 'unicode', 'Chinese: unicode');

console.log('\naccents become plain letters (English, French)');
for (const [inp, out] of [['Hélène', 'Helene'], ['Été', 'Ete'], ['Œuvre', 'OEuvre'], ['Straße', 'Strasse'], ['Dvořák', 'Dvorak'], ['Ægir', 'AEgir'], ['ça', 'ca']])
  ok(fr.asciiFold(inp) === out, `${inp} gives ${out}`);

console.log('\nthe engine, ascii');
{
  const c = card({ name: 'Carte Été', cameraman: 'Hélène', camera: 'Caméra 1', nameRule: 'ascii' });
  ok(engSegs('{counter}_{cardname}_{operator}_{camera}', c) === '001_CarteEte_Helene_Camera1', 'no accent and no space in the folder: ' + engSegs('{counter}_{cardname}_{operator}_{camera}', c));
  ok(engSegs('{counter}_{cardname}', card({ name: 'NO NAME', nameRule: 'ascii' })) === '001_NONAME', 'a card called "NO NAME" gives NONAME');
  ok(engSegs('{counter}_{cardname}', card({ name: 'カード', nameRule: 'ascii' })) === '001_CARD', 'a name with no Latin letter at all falls back to CARD');
  ok(engSegs('{counter}_{cardname}', card({ name: 'A001.bak (2)', nameRule: 'ascii' })) === '001_A001bak2', 'dots, brackets and spaces are removed');
  ok(engSegs('{counter}_{cardname}', card({ name: 'A001-B_c', nameRule: 'ascii' })) === '001_A001-B_c', 'letters, digits, "_" and "-" stay');
  ok(engSegs('{counter}_{cardname}', card({ name: 'A/B', nameRule: 'ascii' })) === '001_A_B', 'a "/" in a value still never makes a subfolder');
  ok(engSegs('{counter}_{cardname}', card({ name: 'œŒæÆßøØđĐłŁþÞð', nameRule: 'ascii' })) === '001_oeOEaeAEssoOdDlLthTHd', 'joined and special letters are spelled out');
}

console.log('\nthe engine, unicode (Chinese, and callers that say nothing)');
{
  const c = card({ name: 'Carte Été', cameraman: '王伟' });
  ok(engSegs('{counter}_{cardname}_{operator}', c) === '001_Carte Été_王伟', 'no rule given: the value is kept as before 2.9.0');
  ok(engSegs('{counter}_{cardname}_{operator}', Object.assign({}, c, { nameRule: 'unicode' })) === '001_Carte Été_王伟', 'unicode: Chinese characters and accents are kept');
  ok(engSegs('{counter}_{cardname}', card({ name: 'A:B', nameRule: 'unicode' })) === '001_A_B', 'unicode: what Windows forbids is still replaced');
}

console.log('\nthe preview shows what the engine creates');
for (const nr of ['ascii', 'unicode']) {
  const ctx = nr === 'ascii' ? fr : zh;
  for (const [tpl, c] of [
    ['{counter}_{cardname}_{operator}', card({ name: 'Carte Été', cameraman: 'Hélène' })],
    ['DAY1/{camera}/{counter}_{cardname}', card({ name: 'Œuvre 2', camera: 'Sony FX6' })],
    ['{counter}_{cardname}', card({ name: 'カード' })],
    // Every letter of the fold table, so a table edited on one side only shows.
    ['{counter}_{cardname}_{operator}', card({ name: 'œŒæÆßøØđĐłŁþÞð', cameraman: 'Straße' })],
    ['{YY}{MM}{DD}/{counter}_{cardname}_{operator}', card({ name: 'NO NAME', cameraman: 'Dvořák' })],
  ]) {
    const cc = Object.assign({}, c, { nameRule: nr });
    const a = engSegs(tpl, cc), b = renSegs(ctx, tpl, cc);
    ok(a === b, `${nr}: ${tpl} with ${c.name}: engine ${a}, preview ${b}`);
  }
}

console.log('\nthe counter scan finds the folders made this way');
{
  const tpl = '{counter}_{cardname}_{operator}';
  const name = engSegs(tpl, card({ name: 'Carte Été', cameraman: 'Hélène', counter: '042', nameRule: 'ascii' }));
  ok(eng.makeCounterMatcher(tpl).extract(name) === 42, `${name} is read as card 42`);
  const name2 = engSegs('JOUR/{counter}_{cardname}', card({ name: 'NO NAME', counter: '007', nameRule: 'ascii' })).split('/').pop();
  ok(eng.makeCounterMatcher('JOUR/{counter}_{cardname}').extract(name2) === 7, `${name2} is read as card 7`);
}

console.log('\nwhat the operator types');
{
  const el = (v) => ({ value: v, selectionStart: v.length, setSelectionRange() {} });
  let e = el('Hélène Dupont'); fr.sanitizeMeta(e);
  ok(e.value === 'HeleneDupont', 'French: "Hélène Dupont" becomes HeleneDupont (it was "HlneDupont" before 2.9.0)');
  e = el('Jean-Marc'); en.sanitizeMeta(e);
  ok(e.value === 'JeanMarc', 'English: letters and digits only, as before');
  e = el('王伟'); zh.sanitizeMeta(e);
  ok(e.value === '王伟', 'Chinese: Chinese characters are kept');
  e = el('A/B:C'); zh.sanitizeMeta(e);
  ok(e.value === 'ABC', 'Chinese: what a filesystem forbids is removed');
}

console.log('\nthe fixed text of the template');
{
  ok(fr.tplText('Journée 1') === 'Journee1', 'French: "Journée 1" becomes Journee1');
  ok(fr.tplText('DAY1/') === 'DAY1/', 'the subfolder mark stays');
  ok(zh.tplText('第一天') === '第一天', 'Chinese: kept');
  fr.S.tokens = [{ type: 'sep', key: 'Journée' }, { type: 'sep', key: '/' }, { type: 'var', key: 'counter' }];
  ok(fr.buildTplStr() === 'Journee/{counter}', 'a template saved with an accent is sent without it: ' + fr.buildTplStr());
  ok(/function tokensFromStored[\s\S]{0,600}key=tplText\(key\)/.test(REND), 'templates loaded from the preferences or a file go through the rule');
  ok(/parts\.push\(\.\.\.litTokens\(tplText\(raw\.slice\(last,m\.index\)\)\)\)/.test(REND), 'and so does a template typed by hand');
  ok(/litTokens\(tplText\(t\.replace/.test(REND), 'and the Custom text entry');
}

console.log('\nthe rule travels with each card');
ok(/S\.run = \{\s*tpl:\s*buildTplStr\(\),\s*nameRule:\s*nameRule\(\),/.test(REND), 'decided at START, with the template');
ok(/nameRule:\s*S\.run\.nameRule,\s*\}\)\);/.test(REND), 'and given to the engine with each card');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
