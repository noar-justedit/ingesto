// The few texts the main process shows itself (system dialogs, the header of
// the shooting note) in the language chosen in the interface. Same dictionary
// files as the interface (src/renderer/lang/*.js): one file per language, for
// both sides. Only exact texts are looked up here; a text missing from the
// dictionary stays in English.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'renderer', 'lang');
let lang = 'en';
let dict = null;

// A language code as the files are named: letters and "-" only ("fr",
// "zh-CN"). Anything else ("fr ", "../fr") is not a language code.
function clean(code) { return String(code == null ? '' : code).replace(/[^A-Za-z-]/g, ''); }

function load(code) {
  const file = path.join(DIR, clean(code) + '.js');
  try {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 1000 });
    return Object.values(ctx.window)[0] || null;
  } catch (_) { return null; }
}

// The code that is kept is the CLEANED one: it is also handed to
// toLocaleString(), which throws on a code like "fr " (keeping the raw value
// would let a hand-edited preference stop an ingest after the copy, while the
// shooting note is being written).
function setLanguage(code) {
  const c = clean(code);
  if (!c || c === lang) return;
  const d = c === 'en' ? null : load(c);
  lang = d ? c : 'en';
  dict = d;
}

function t(s) {
  if (!dict) return s;
  const key = String(s).replace(/\s+/g, ' ').trim();
  const v = (dict.texts && Object.prototype.hasOwnProperty.call(dict.texts, key)) ? dict.texts[key] : null;
  if (v == null) return s;
  return dict.frenchSpacing ? v.replace(/ ([:;?!»])/g, ' $1').replace(/« /g, '« ') : v;
}

// A locale for dates written for a person ("23/10/2026 14:05" in French).
// English keeps the system's own format.
function locale() {
  if (lang === 'en') return undefined;
  try { return Intl.DateTimeFormat.supportedLocalesOf([lang]).length ? lang : undefined; }
  catch (_) { return undefined; }
}

module.exports = { setLanguage, t, locale, get language() { return lang; } };
