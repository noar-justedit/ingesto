#!/usr/bin/env node
// The command run after an ingest.
//
// It fires once the panels have unlocked, so everything it is told has to come
// from the snapshot taken when START was pressed, not from whatever is on
// screen by then. A drive added or removed while a card copied used to change
// what the hook was told about a run that was already over.
//
// The other half of this suite is the shape of the command itself: it is run
// without a shell, and a card name is data. A card called
// `; rm -rf ~` is a string, not an instruction.
//
//   node scripts/test-post-hook.js
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

let launched = [];
const ctx = vm.createContext({
  console, Promise, Set, Map, Array, String, JSON,
  S: { hookEnabled: true, hookCommand: '', dests: [], _lateNotes: [] },
  window: { ingesto: { runHook: async (argv) => { launched.push(argv); return { ok: true }; } } },
  addSummaryNote(){}, document: { getElementById: () => null },
});
vm.runInContext(extractFn(REND, 'tokenizeCommand'), ctx);
vm.runInContext(extractFn(REND, 'runPostHook'), ctx);

const result = (over) => Object.assign({
  sourceName: 'A001', sourcePath: '/card/A001', destPath: '/Volumes/SHUTTLE_1/001_A001',
  success: true, canceled: false, errors: 0, failedFiles: [], unstableFiles: [],
  totalBytes: 1000,
}, over);
const RUN = { dests: [{ path: '/Volumes/SHUTTLE_1', name: 'SHUTTLE_1' }],
              hook: { on: true, cmd: '' } };
// The command is part of the snapshot: writing it here is what the interface
// does when START is pressed.
const cmd = (c) => { RUN.hook.cmd = c; };
const flush = () => new Promise(r => setTimeout(r, 5));

(async () => {

console.log('\nthe destination comes from the run, not from the screen');
{
  // The operator unplugs the shuttle and plugs an archive drive in while the
  // last card copies. The hook used to be handed the archive drive, for a run
  // that never wrote a byte to it.
  cmd('/usr/local/bin/proxy.sh "{destPath}"');
  ctx.S.dests = [{ path: '/Volumes/ARCHIVE_LTO', name: 'ARCHIVE_LTO' }];   // the live state, now
  launched = [];
  ctx.runPostHook([result()], RUN);
  await flush();
  ok(launched.length === 1, 'the command runs');
  ok(launched.length === 1 && launched[0][1] === '/Volumes/SHUTTLE_1',
     `it is told the drive the run used ("${launched.length ? launched[0][1] : '(nothing ran)'}")`);
}

console.log('\nthe command itself is frozen, like the handoff');
{
  // The gear button is not locked during an ingest. Settings can be opened
  // while a card copies, and the command typed there used to be the one that
  // ran at the end, on a run started under another one.
  cmd('/usr/local/bin/proxy.sh {card}');
  ctx.S.hookEnabled = true;
  ctx.S.hookCommand = '/usr/local/bin/SOMETHING_ELSE.sh {card}';   // typed mid-copy
  launched = [];
  ctx.runPostHook([result()], RUN);
  await flush();
  ok(launched.length === 1 && launched[0][0] === '/usr/local/bin/proxy.sh',
     `the command that runs is the one frozen at START ("${launched.length ? launched[0][0] : '(nothing ran)'}")`);
}

console.log('\nand so is the switch');
{
  // Switched ON mid-copy: the run it belongs to started with it off.
  ctx.S.hookEnabled = true;
  ctx.S.hookCommand = '/usr/local/bin/proxy.sh {card}';
  launched = [];
  ctx.runPostHook([result()], { dests: RUN.dests, hook: { on: false, cmd: '/usr/local/bin/proxy.sh {card}' } });
  await flush();
  ok(launched.length === 0, 'a hook switched on during the ingest does not run');

  // And switched OFF mid-copy: the run started with it on, so it runs.
  ctx.S.hookEnabled = false;
  launched = [];
  ctx.runPostHook([result()], RUN);
  await flush();
  ok(launched.length === 1, 'a hook switched off during the ingest still runs');
}

console.log('\nwithout a snapshot, nothing runs');
{
  // There is one call site and it always passes the run. A call without one is
  // a programming error, not a reason to fall back to the live screen.
  ctx.S.hookEnabled = true;
  ctx.S.hookCommand = '/usr/local/bin/proxy.sh {card}';
  launched = [];
  ctx.runPostHook([result()], null);
  await flush();
  ok(launched.length === 0, 'no run, no command');
}

console.log('\nthe card name is data, never part of the command');
{
  // A card can be named by whoever formatted it, and the name reaches this
  // function as text. The command is tokenized first, then each argument has
  // its variables replaced whole, so a hostile name stays one argument.
  cmd('/usr/local/bin/proxy.sh {card}');
  ctx.S.dests = [];
  launched = [];
  ctx.runPostHook([result({ sourceName: '; rm -rf ~' })], RUN);
  await flush();
  ok(launched.length === 1 && launched[0].length === 2, 'the command still has exactly two arguments');
  ok(launched.length === 1 && launched[0][1] === '; rm -rf ~', 'and the name arrives whole, as one string');
  ok(launched.length === 1 && launched[0][0] === '/usr/local/bin/proxy.sh', 'the program is the one that was configured');
}

console.log('\nand it can never choose the program');
{
  // A hook written as "{destPath}/x" would otherwise let a drive name pick the
  // executable. argv[0] is never substituted.
  cmd('{destPath} something');
  launched = [];
  ctx.runPostHook([result()], RUN);
  await flush();
  ok(launched.length === 1 && launched[0][0] === '{destPath}', 'the first argument is left exactly as typed');
}

console.log('\nwhat the hook is told about the result');
{
  cmd('/bin/echo {result}');
  const cases = [
    ['a clean run',                   [result()],                                              'ok'],
    ['a run with an error',           [result({ success: false, errors: 1 })],                 'errors'],
    ['a file that failed',            [result({ success: false, failedFiles: ['A.MOV'] })],    'errors'],
    ['a card giving different data',  [result({ success: false, unstableFiles: ['A.MOV'] })],  'suspect'],
    ['no result at all',              [],                                                      'errors'],
  ];
  for (const [label, R, expected] of cases) {
    launched = [];
    ctx.runPostHook(R, RUN);
    await flush();
    ok(launched.length === 1 && launched[0][1] === expected,
       `${label} reads as "${launched.length ? launched[0][1] : '(nothing ran)'}"`);
  }
  // A cancelled run does not fire the hook at all.
  launched = [];
  ctx.runPostHook([result({ canceled: true, success: false })], RUN);
  await flush();
  ok(launched.length === 0, 'a cancelled run does not run the command');
}

console.log('\nand the limit that issue #10 is about');
{
  // Stated here so nobody reads "ok" as "verified". It means the run finished
  // without errors, which a FAST copy also does, having checked nothing. This
  // is why the per card handoff exists rather than more variables here.
  cmd('/bin/echo {result}');
  launched = [];
  ctx.runPostHook([result({ mode: 'fast' })], RUN);
  await flush();
  ok(launched.length === 1 && launched[0][1] === 'ok', 'a FAST copy, where nothing was verified, still reads "ok"');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
