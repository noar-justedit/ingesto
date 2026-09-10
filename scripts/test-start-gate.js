#!/usr/bin/env node
// Two ingests must never run at once. They would share S.run (the second
// overwrites it, so the first reports the wrong snapshot), share the counter
// and therefore the destination folder, and in the engine share cancelCopy:
// a second start-copy sets cancelCopy=false and silently un-cancels the first.
// Two engines then write and rename the same file names in the same folder.
//
// startCopy() guards this with S._starting, set for the whole of its own body,
// because S.copying is not set until several awaits later (the volume check,
// the counter scan, the disk-space check, the collision scan): on a network
// share that is seconds.
//
// The trap this suite exists for: the "recheck the drives" recovery button. It
// has to start the ingest again, and the obvious way to do that (clear the
// flag, call startCopy) is wrong twice over. The inner call runs to its first
// await and returns; the outer call's finally then clears the flag the inner
// call had just set; and between the two, both guards read false.
//
//   node scripts/test-start-gate.js
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

// One run of startCopy against a world where the drives are missing, the
// operator presses RECHECK, and they are back. Everything after the volume
// check parks for ever, so a run that got that far counts as "in flight".
function harness() {
  const state = { entered: 0, checks: 0 };
  const PARK = new Promise(() => {});
  const ctx = vm.createContext({
    console, Promise, setTimeout, clearTimeout,
    S: { copying:false, _starting:false, counterOverride:true, run:null,
         sources:[{ path:'/card', name:'A001' }], dests:[{ path:'/drive', name:'D' }] },
    document: { getElementById: () => ({ value:'', style:{}, classList:{ add(){}, remove(){} } }) },
    window: { ingesto: { setPowerBlock(){} } },
    preflightIngest: () => null,
    checkVolumesStillThere: async () => {
      state.checks++; state.entered++;
      if (state.checks === 1) return { code:'PF-R10' };   // the drives are gone
      if (state.checks === 2) return null;                // RECHECK: they are back
      await PARK;                                         // the restart parks here
      return null;
    },
    showRefusal: async () => 'recheck',
    setIngestLock(){}, updateBtn(){}, tfExit(){}, showToast(){}, resetSpark(){},
  });
  vm.runInContext(extractFn(REND, 'startCopy'), ctx);
  return { ctx, state };
}
const tick = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\nthe recheck button restarts the ingest');
  const { ctx, state } = harness();
  await ctx.startCopy();
  ok(state.checks >= 2, 'the volume check ran again when RECHECK was pressed');

  console.log('\nand the gate stays shut until the restart has really begun');
  {
    // The restart is queued, not re-entered. Until it starts, the flag must
    // still be set: clearing it here and re-entering on a timer would leave
    // the same window open, only narrower.
    ok(ctx.S._starting === true,
       'S._starting is still set while the restart is queued');
    const before = state.entered;
    ctx.startCopy();                       // the operator presses Start again
    await Promise.resolve(); await Promise.resolve();
    ok(state.entered === before, 'a press of Start while the restart is queued is refused');
  }

  console.log('\nthe queued restart runs, exactly once');
  {
    await tick(30);
    ok(state.entered === 3, 'three runs got past the gate: the first, the recheck, the restart ('
                            + state.entered + ')');
    const before = state.entered;
    ctx.startCopy();                       // press again, restart now in flight
    await tick(20);
    ok(state.entered === before, 'and a press while the restart is in flight is refused too');
  }

  console.log('\nnothing is left armed behind it');
  ok(!ctx.S._restartWanted, 'the restart flag is cleared, so it cannot fire twice');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
