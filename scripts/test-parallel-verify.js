#!/usr/bin/env node
// Regression tests for the parallel destination verification added in 2.5.1.
// Pulls the real functions out of src/main/main.js — no Electron needed — and
// runs them against real files in a temp directory.
//
//   node scripts/test-parallel-verify.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in main.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const nocache = require(path.join(ROOT, 'src', 'main', 'nocache.js'));
const hashWasm = require('hash-wasm');

// Pause bookkeeping lives at module scope in main.js; recreate that scope here
// so the real statements are the ones under test.
const PAUSE_SRC = SRC.match(/let pausedMs = 0, _pauseStart = 0, _pauseHeldSent = false;[\s\S]*?\n}\n/)[0];

const ctx = vm.createContext({
  fs, path, process, Buffer, console, setTimeout, setInterval, clearInterval,
  nocache, getHashWasm: () => hashWasm, module: {}, require,
});
vm.runInContext(
  extractFn('groupByDevice') + '\n' +
  extractFn('newProHasher') + '\n' +
  extractFn('hashPro') + '\n' +
  PAUSE_SRC + '\n' +
  extractFn('pauseGate') + '\n' +
  'let pauseCopy = false, cancelCopy = false;\n' +
  // `let` stays in the script's lexical scope and never lands on the context
  // object, so the test reaches it through these explicit accessors.
  'globalThis.setPause = v => { pauseCopy = v; };\n' +
  'globalThis.getPausedMs = () => pausedMs;\n',
  ctx);

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ok  ', n); }
  else { fail++; console.log('  FAIL', n, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-par-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

function mkfile(name, mb, seed) {
  const p = path.join(TMP, name);
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(p, 'w');
  for (let i = 0; i < mb; i++) { buf.fill((seed + i) & 0xff); fs.writeSync(fd, buf); }
  fs.closeSync(fd);
  return p;
}

async function main() {
  console.log('\ngroupByDevice');
  {
    const a = path.join(TMP, 'a'), b = path.join(TMP, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const groups = ctx.groupByDevice([{ p: a }, { p: b }], x => x.p);
    // Same temp filesystem → same device → ONE group, read one after the other.
    ok('two folders on the same disk end up in the same lane',
      groups.length === 1 && groups[0].length === 2, groups.map(g => g.length));

    const g2 = ctx.groupByDevice([{ p: a }, { p: path.join(TMP, 'gone-' + Date.now(), 'nope') }], x => x.p);
    ok('an unreachable path gets its own lane rather than joining another',
      g2.length === 2, g2.map(g => g.length));

    const g3 = ctx.groupByDevice([], x => x.p);
    ok('an empty list produces no lane', g3.length === 0);

    // Every input must come back exactly once — a destination silently dropped
    // here would never be verified at all.
    const many = [{ p: a }, { p: b }, { p: path.join(TMP, 'gone-a') }, { p: path.join(TMP, 'gone-b') }];
    const g4 = ctx.groupByDevice(many, x => x.p);
    const flat = g4.flat();
    ok('no destination is lost or duplicated by the grouping',
      flat.length === many.length && new Set(flat).size === many.length, flat.length);
  }

  console.log('\nhashPro — one hasher per lane');
  {
    const f1 = mkfile('one.bin', 6, 1);
    const f2 = mkfile('two.bin', 6, 200);
    const ref1 = await ctx.hashPro(f1, await ctx.newProHasher('xxh128'));
    const ref2 = await ctx.hashPro(f2, await ctx.newProHasher('xxh128'));
    ok('two different files have different fingerprints', ref1 !== ref2);

    // Sequential use of a single hasher is fine — that is the 2.5.0 behaviour.
    const shared = await ctx.newProHasher('xxh128');
    ok('one hasher reused SEQUENTIALLY still gives the right digest',
      (await ctx.hashPro(f1, shared)) === ref1 && (await ctx.hashPro(f2, shared)) === ref2);

    // THE hazard this whole test file exists for. hashPro() calls hasher.init()
    // then streams into it, so two concurrent calls on the same instance walk
    // over each other. hash-wasm does not return a wrong digest — it throws
    // ("digest() called before init()"), and in the verify loop that exception
    // is caught as a verification failure: a perfectly good copy reported as a
    // checksum mismatch AND quarantined under .ingesto-failed. Hence one hasher
    // per lane, and hence this test.
    const clash = await ctx.newProHasher('xxh128');
    let broke = false, c1 = null, c2 = null;
    try { [c1, c2] = await Promise.all([ctx.hashPro(f1, clash), ctx.hashPro(f2, clash)]); }
    catch (_) { broke = true; }
    ok('sharing ONE hasher across concurrent lanes fails loudly (proves the hazard)',
      broke || c1 !== ref1 || c2 !== ref2, { broke, c1: c1 === ref1, c2: c2 === ref2 });

    // …and the fix: one instance per lane.
    const h1 = await ctx.newProHasher('xxh128'), h2 = await ctx.newProHasher('xxh128');
    const [p1, p2] = await Promise.all([ctx.hashPro(f1, h1), ctx.hashPro(f2, h2)]);
    ok('one hasher PER LANE gives the same digests as sequential',
      p1 === ref1 && p2 === ref2, { p1, ref1, p2, ref2 });

    // Three lanes, the realistic case: same card copied to three destinations.
    const d = [];
    for (let i = 0; i < 3; i++) { const q = path.join(TMP, `d${i}.bin`); fs.copyFileSync(f1, q); d.push(q); }
    const hs = [await ctx.newProHasher('xxh128'), await ctx.newProHasher('xxh128'), await ctx.newProHasher('xxh128')];
    const got = await Promise.all(d.map((q, i) => ctx.hashPro(q, hs[i])));
    ok('three destinations verified at once all match the source fingerprint',
      got.every(x => x === ref1), got);

    ok('xxh64 and xxh128 are not the same algorithm',
      (await ctx.hashPro(f1, await ctx.newProHasher('xxh64'))) !== ref1);
  }

  console.log('\npause accounting with several lanes');
  // The clock is started by pauseGate itself, when a lane really stops — not by
  // the button. Between the two the engine is still finishing the file in
  // flight, and billing that as pause used to subtract it from the phase
  // durations (a 500 s verify reported as 240 s, or clamped to zero).
  {
    ctx.resetPausedMs();
    ok('paused time starts at zero', ctx.getPausedMs() === 0);

    const win = { webContents: { send: () => {} } };
    ctx.setPause(true);
    // Three lanes all sitting in the gate through the SAME pause.
    const waiters = [ctx.pauseGate(win), ctx.pauseGate(win), ctx.pauseGate(win)];
    await new Promise(r => setTimeout(r, 600));
    ctx.setPause(false); ctx.pauseEnd();
    await Promise.all(waiters);
    const held = ctx.getPausedMs();
    // Wall clock, not the sum of what each lane waited: ~600 ms, not ~1800 ms.
    ok('a pause is counted ONCE however many lanes waited through it',
      held >= 500 && held < 1000, held);

    ctx.resetPausedMs();
    ctx.setPause(true);
    const w2 = ctx.pauseGate(win);
    await new Promise(r => setTimeout(r, 300));
    ctx.setPause(false); ctx.pauseEnd();
    await w2;
    ctx.setPause(true);
    const w3 = ctx.pauseGate(win);
    await new Promise(r => setTimeout(r, 300));
    ctx.setPause(false); ctx.pauseEnd();
    await w3;
    ok('two successive pauses add up', ctx.getPausedMs() >= 500 && ctx.getPausedMs() < 1000, ctx.getPausedMs());

    ctx.resetPausedMs();
    ctx.pauseEnd();   // resume with no pause in progress
    ok('resuming when nothing was paused adds nothing', ctx.getPausedMs() === 0);

    // Pressing Pause while the engine is still copying a large file must not
    // bill the copy time: the clock only starts at the gate.
    ctx.resetPausedMs();
    ctx.setPause(true);
    await new Promise(r => setTimeout(r, 400));   // engine still working, no gate reached
    ok('time before any lane reaches the gate is not counted as pause',
      ctx.getPausedMs() === 0, ctx.getPausedMs());
    const w5 = ctx.pauseGate(win);
    await new Promise(r => setTimeout(r, 300));
    ctx.setPause(false); ctx.pauseEnd();
    await w5;
    ok('only the time actually held is counted',
      ctx.getPausedMs() >= 200 && ctx.getPausedMs() < 600, ctx.getPausedMs());

    // A pause left open when the next card starts must not leak into it.
    ctx.setPause(true);
    const w6 = ctx.pauseGate(win);
    await new Promise(r => setTimeout(r, 250));
    ctx.resetPausedMs();          // as a new performCopyMulti does
    ctx.setPause(false);
    await w6;
    ok('a pause open across two cards does not leak into the next one',
      ctx.getPausedMs() === 0, ctx.getPausedMs());

    let held2 = 0;
    const win2 = { webContents: { send: () => { held2++; } } };
    ctx.setPause(true);
    const w4 = [ctx.pauseGate(win2), ctx.pauseGate(win2), ctx.pauseGate(win2)];
    await new Promise(r => setTimeout(r, 300));
    ctx.setPause(false); ctx.pauseEnd();
    await Promise.all(w4);
    ok('the "paused" badge is announced once, not once per lane', held2 === 1, held2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); cleanup(); process.exit(1); });
