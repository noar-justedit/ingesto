#!/usr/bin/env node
// The template resolver exists TWICE: once in the engine (main.js
// buildFolderSegments) and once in the interface (index.html resolveTplSegs),
// because the preview and the pre-flight must show what the engine will build
// without asking it. Both files carry a comment saying "mirror of the other" —
// a comment enforces nothing.
//
// This suite enforces it. It extracts BOTH functions, runs them side by side on
// the same templates and the same cards, and fails on any disagreement.
//
// Why it exists: adding {YYYY} in 2.6.2 meant editing the same five lines in two
// files. Had one been missed, the interface would have previewed
// "2026/001_A001" while the engine created "{YYYY}/001_A001" — a literal
// "{YYYY}" folder on every destination — or the reverse: a pre-flight approving
// a path other than the one written. Neither is caught by any other test.
//
//   node scripts/test-template-parity.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractConst(src, name, where) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in ${where}`);
  return m[0];
}
function extractFn(src, name, where) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in ${where}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name} (${where})`);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── The engine side ─────────────────────────────────────────────────────────
const eng = vm.createContext({ console });
vm.runInContext([
  extractConst(MAIN, 'CLOCK_TOKENS',      'main.js'),
  extractFn(MAIN, 'resolveTemplateVars', 'main.js'),
  extractFn(MAIN, 'cleanSegment',        'main.js'),
  extractFn(MAIN, 'buildFolderSegments', 'main.js'),
  extractFn(MAIN, 'buildFolderName',     'main.js'),
  extractFn(MAIN, 'templateSegments',    'main.js'),
  extractFn(MAIN, 'makeCounterMatcher',  'main.js'),
].join('\n'), eng);

// ── The interface side ──────────────────────────────────────────────────────
// resolveTplSegs() reads two things from its page: the counter (S.counter) and,
// as a fallback when the card carries none, the operator/camera fields. The
// fallback is stubbed to "not present" so the card's own values are the only
// input — the same input the engine gets.
const ren = vm.createContext({
  console,
  S: { counter: 7, counterWidth: 3 },
  // A const inside a vm script never lands on the context object, so the list
  // is written out here. It is the contract, and a test that read it from the
  // source could never disagree with the source.
  COUNTER_WIDTHS: [2,3,4],
  document: { getElementById: () => null },
});
vm.runInContext(extractFn(REND, 'padCounter', 'index.html'), ren);
vm.runInContext(extractFn(REND, 'resolveTplSegs', 'index.html'), ren);

// A fixed clock: the two functions each call new Date() otherwise, and a run
// straddling a second boundary would fail on {SS} for the wrong reason.
const CLOCK = new Date(2026, 0, 5, 3, 4, 5);

const CARDS = {
  'full':            { name: 'A001', operator: 'noar', camera: 'FX6' },
  'no operator':     { name: 'A001', operator: '',     camera: 'FX6' },
  'no camera':       { name: 'A001', operator: 'noar', camera: ''    },
  'neither':         { name: 'A001', operator: '',     camera: ''    },
  'slash in values': { name: 'A/001', operator: 'Jean/Marc', camera: 'FX6' },
  'card named ".."': { name: '..',   operator: '',     camera: ''    },
  'no label':        { name: '',     operator: 'noar', camera: 'FX6' },
  'trailing dot':    { name: 'A001.', operator: 'noar', camera: 'FX6' },
};

const TEMPLATES = [
  '{counter}_{cardname}',
  '{YYYY}{MM}{DD}/{counter}_{cardname}',
  '{YY}{MM}{DD}/{counter}_{cardname}',
  '{YYYY}-{MM}-{DD}/{camera}/{counter}_{operator}',
  '{YYYY}/{YY}/{counter}',
  '{counter}_{cardname}_{operator}_{camera}_{YY}{MM}{DD}_{HH}{MIN}',
  '{counter}_{cardname}_{YYYY}{MM}{DD}_{HH}{MIN}{SS}',
  '{cameraman}/{counter}_{cardname}',
  'DAY1/{camera}/{counter}_{operator}',
  'DAY1//{counter}',
  '/DAY1/{counter}/',
  'DAY1/../{counter}',
  'DAY1 /{counter}',
  '{counter}_{cardname}\\x/y',
  '{camera}/{counter}',
  '{cardname}{counter}',
  '{YYYY}{counter}',
  '{YYYY}_{counter}_{cardname}',
];

console.log('\nengine and interface resolve the same template to the same path');
for (const tpl of TEMPLATES) {
  for (const [label, c] of Object.entries(CARDS)) {
    const a = eng.buildFolderSegments(tpl, {
      counter: '007', name: c.name, cameraman: c.operator, camera: c.camera,
    }, CLOCK).join('/');
    const b = ren.resolveTplSegs(tpl, {
      name: c.name, operator: c.operator, camera: c.camera,
    }, 0, CLOCK).join('/');
    ok(a === b, `${JSON.stringify(tpl)} · ${label} → ${a === b ? a || '(nothing)' : `engine "${a}" vs interface "${b}"`}`);
  }
}

// ── The counter width (issue #9) ────────────────────────────────────────────
// The interface pads the counter for the PREVIEW, and then sends the engine an
// already padded string for the FOLDER. If the two ever disagree, the operator
// is shown a folder name that is not the one created.
console.log('\nthe preview and the folder agree on the width of the counter');
for (const w of [2, 3, 4]) {
  ren.S.counterWidth = w;
  const padded = String(7).padStart(w, '0');
  const tpl = '{counter}_{cardname}';
  const c = CARDS.plain || Object.values(CARDS)[0];
  // The engine receives the string the interface built.
  const a = eng.buildFolderSegments(tpl, {
    counter: ren.padCounter(7), name: c.name, cameraman: c.operator, camera: c.camera,
  }, CLOCK).join('/');
  const b = ren.resolveTplSegs(tpl, {
    name: c.name, operator: c.operator, camera: c.camera,
  }, 0, CLOCK).join('/');
  ok(a === b, `${w} digits · engine "${a}" vs interface "${b}"`);
  ok(b.startsWith(padded + '_'), `${w} digits · the preview really shows ${padded} ("${b}")`);
}
// A minimum, not a maximum: two digits must not truncate 100 to 00, which would
// put two reels in one folder.
{
  ren.S.counterWidth = 2;
  ren.S.counter = 100;
  const b = ren.resolveTplSegs('{counter}_{cardname}', { name: 'A001' }, 0, CLOCK).join('/');
  ok(b.startsWith('100_'), `past 99 a two-digit counter goes to 100, not 00 ("${b}")`);
  ren.S.counter = 7; ren.S.counterWidth = 3;
}

// ── The token sets themselves ───────────────────────────────────────────────
// The loop above only compares the templates it was given. A token added to one
// resolver and forgotten in the other would slip through unless a template here
// happens to use it — so the two lists are compared directly, from the source.
console.log('\nboth resolvers know exactly the same variables');
{
  const tokensOf = (src) => new Set(
    (src.match(/replaceAll\(\s*'(\{[a-zA-Z]+\})'/g) || [])
      .map(m => m.replace(/^replaceAll\(\s*'/, '').replace(/'$/, ''))
  );
  const a = tokensOf(extractFn(MAIN, 'resolveTemplateVars', 'main.js'));
  const b = tokensOf(extractFn(REND, 'resolveTplSegs', 'index.html'));
  const only = (x, y) => [...x].filter(t => !y.has(t));
  ok(a.size >= 11, `the engine list was read (${a.size} variables)`);
  ok(only(a, b).length === 0, 'no variable the engine resolves is missing from the interface' +
     (only(a, b).length ? ' — missing: ' + only(a, b).join(' ') : ''));
  ok(only(b, a).length === 0, 'no variable the interface resolves is missing from the engine' +
     (only(b, a).length ? ' — missing: ' + only(b, a).join(' ') : ''));
  ok(a.has('{YYYY}') && b.has('{YYYY}'), 'both sides know {YYYY}');
}

// ── The chips offered in the interface ──────────────────────────────────────
// A chip inserts a token into the template with one click. A chip for a variable
// NO resolver knows would create a folder literally called "{XXXX}" on every
// destination, and the user would have no way to tell why. So every chip is
// checked against the resolvers. (The reverse is not required: {SS} is resolved
// but deliberately has no chip — it is reachable by typing.)
console.log('\nevery variable chip inserts a token the resolvers actually know');
{
  const chips = [...REND.matchAll(/addTok\(\s*'var'\s*,\s*'([A-Za-z]+)'\s*\)/g)].map(m => m[1]);
  const engSrc = extractFn(MAIN, 'resolveTemplateVars', 'main.js');
  const renSrc = extractFn(REND, 'resolveTplSegs', 'index.html');
  ok(chips.length >= 10, `the chip row was read (${chips.length} variable chips)`);
  for (const k of chips) {
    ok(engSrc.includes(`'{${k}}'`) && renSrc.includes(`'{${k}}'`),
       `the "${k}" chip inserts a token both resolvers substitute`);
  }
  ok(chips.includes('YYYY'), 'the four-digit year is offered as a chip, not only by typing');
  ok(chips.includes('YY'), 'and the two-digit year is still offered');
}

// ── Every variable must survive the ROUND TRIP ──────────────────────────────
// Creating a folder is only half of it: the counter is read back OUT of the
// name, by a pattern built from the same template. A variable the resolver
// knows but the matcher does not falls through to the matcher's literal branch,
// the pattern then matches nothing at all, the scan finds no card, and the
// counter restarts at 001 — with the "folder already exists" guard as the only
// thing left between an ingest and an existing reel.
//
// This is checked by DOING it, for every variable the engine resolves, derived
// from the source rather than listed here: build a real folder name, then ask
// the real matcher for its counter back. A hardcoded list would not have
// covered the next variable somebody adds.
console.log('\nevery variable the engine resolves survives the round trip');
{
  const tokens = [...new Set(
    (extractFn(MAIN, 'resolveTemplateVars', 'main.js').match(/replaceAll\(\s*'(\{[a-zA-Z]+\})'/g) || [])
      .map(m => m.replace(/^replaceAll\(\s*'/, '').replace(/'$/, ''))
  )].filter(t => t !== '{counter}');
  const CARD = { counter: '007', name: 'A001', cameraman: 'noar', camera: 'FX6' };
  // `const` inside a vm context is not a property of the sandbox — read it out.
  const CLOCK_WIDTHS = vm.runInContext('CLOCK_TOKENS', eng);
  ok(tokens.length >= 9, `the variable list was derived from the source (${tokens.length} besides {counter})`);
  for (const t of tokens) {
    // The glued forms are the ones where the token's WIDTH decides the answer:
    // with no separator, the pattern has to know exactly how many characters to
    // consume before the counter starts. They are asked only of the CLOCK
    // variables, which have a width — a card name or a camera glued to the
    // counter is genuinely ambiguous ("A0011"), and main.js keeps the looser
    // pattern there on purpose: over-reading is annoying, missing a card is not.
    const glued = CLOCK_WIDTHS[t] ? [`${t}{counter}`, `{counter}${t}`] : [];
    for (const tpl of [`${t}_{counter}`, `{counter}_${t}`, `${t}_{counter}_{cardname}`, ...glued]) {
      const name = eng.buildFolderName(tpl, CARD, CLOCK);
      const got  = eng.makeCounterMatcher(tpl).extract(name);
      ok(got === 7, `${tpl} → "${name}" → counter ${got === 7 ? '7' : String(got) + ' (expected 7)'}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
