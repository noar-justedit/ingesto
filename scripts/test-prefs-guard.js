#!/usr/bin/env node
// What INGESTO is willing to believe from its own preferences file.
//
// The file is written by INGESTO and it is also editable by anyone, syncable
// by anything, and truncatable by a power cut. Two values out of it decide
// what an ingest DOES: the copy mode, and the counter every folder name is
// built from. Both used to be taken as they came.
//
//   node scripts/test-prefs-guard.js
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

const els = {};
const el = () => ({ classList: { toggle(){}, add(){}, remove(){} }, style: {}, checked: false,
                    closest: () => null, querySelectorAll: () => [] });
const ctx = vm.createContext({
  console,
  // The list is written out here rather than read from the file: this is the
  // contract, and a test that took it from the source could never disagree.
  MODES: ['fast','normal','slow','pro'],
  // The folder scanner reads at most four digits back out of a folder name,
  // so the counter stops there. Written out because a const inside a vm script
  // never lands on the context.
  COUNTER_MAX: 9999,
  S: { mode: 'slow', counter: 7, counterOverride: false },
  document: { getElementById: (id) => (els[id] || (els[id] = el())),
              querySelectorAll: () => [] },
  persistPrefs(){},
});
vm.runInContext(extractFn(REND, 'prefsCounter'), ctx);
vm.runInContext(extractFn(REND, 'prefsMode'), ctx);
vm.runInContext(extractFn(REND, 'setMode'), ctx);

(async () => {
console.log('\nthe counter has to be a whole number a folder can be named after');
{
  ok(ctx.prefsCounter({ counter: 12 }) === 12, 'a normal counter goes through');
  ok(ctx.prefsCounter({ counter: '12' }) === 12, 'and one saved as text is read as the number it is');
  const rejected = [
    ['nothing at all',        {}],
    ['null',                  { counter: null }],
    ['zero',                  { counter: 0 }],
    ['negative',              { counter: -3 }],
    ['fractional',            { counter: 2.5 }],
    ['not a number',          { counter: 'A001' }],
    ['an object',             { counter: { n: 4 } }],
    ['an array',              { counter: [4] }],
    ['past four digits',      { counter: 10000 }],
    ['absurdly large',        { counter: 10000000 }],
    ['infinite',              { counter: Infinity }],
  ];
  for (const [what, prefs] of rejected)
    ok(ctx.prefsCounter(prefs) === null, `${what} is refused, and the counter in hand is kept`);
}

console.log('\nthe mode has to be one of the four');
{
  for (const m of ['fast','normal','slow','pro'])
    ok(ctx.prefsMode({ mode: m }, 'slow') === m, `"${m}" is a mode`);
  const rejected = ['secure', 'verified', 'SLOW', '', null, undefined, 3, {}, ['pro']];
  for (const m of rejected)
    ok(ctx.prefsMode({ mode: m }, 'slow') === 'slow',
       `${JSON.stringify(m)} is not, and the running mode is kept`);
  ok(ctx.prefsMode({}, 'fast') === 'fast', 'with nothing saved, the running mode is kept');
}

console.log('\nand setMode itself refuses what is not a mode');
{
  // Both ends: the file is checked on the way in, and the one function that
  // writes S.mode refuses anything else whatever the caller does.
  ctx.S.mode = 'pro';
  ctx.setMode('banana', false);
  ok(ctx.S.mode === 'pro', 'an unknown mode leaves the running mode alone');
  ctx.setMode('fast', false);
  ok(ctx.S.mode === 'fast', 'a real one still applies');
}

console.log('\nsettings cannot be imported into a run that is already going');
{
  // The guard existed, and it was asked before the file dialog opened. Picking
  // a file is a system dialog: it can stay open for minutes, and an ingest
  // started in the meantime got the imported mode, template and algorithm
  // applied to it halfway through.
  const toasts = [];
  const applied = [];
  const ictx = vm.createContext({
    console, Promise, Array,
    S: { copying:false, _starting:false, tokens:[], presets:[] },
    showToast: (m) => toasts.push(m),
    window: { ingesto: { importSettings: async () => {
      ictx.S.copying = true;                       // START pressed while the dialog was open
      return { ok:true, data:{ ingestoSettingsVersion:1, include:{ namingTemplate:true },
                               tokens:[{ t:'counter' }] } };
    } } },
    tokensFromStored: (t) => { applied.push(t); return t; },
    renderTemplate(){}, syncRaw(){}, normPresets:(x)=>x, renderPresets(){},
    persistPrefs(){}, updatePreview(){}, renderCounter(){}, showToastOnce(){},
    document: { getElementById: () => ({ checked:false, value:'', style:{},
                                         classList:{ add(){}, remove(){}, toggle(){} } }),
                querySelectorAll: () => [] },
  });
  vm.runInContext(extractFn(REND, 'importBusy'), ictx);
  vm.runInContext(extractFn(REND, 'importSettingsFile'), ictx);

  // Anything past the guard reaches parts of the interface this harness does
  // not stub, and throws. That is the point: nothing past the guard should run.
  try { await ictx.importSettingsFile(); } catch (_) {}
  ok(applied.length === 0, 'nothing from the file is applied');
  ok(ictx.S.tokens.length === 0, 'the naming template of the running ingest is untouched');
  ok(toasts.some(t => /ingest is running/.test(t)), 'and the operator is told why');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
