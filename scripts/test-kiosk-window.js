#!/usr/bin/env node
// The kiosk screen. A camera operator with no DIT reads this and nothing else,
// then decides whether to format the card. It has to answer exactly one
// question, and its last line is that answer.
//
// Before 2.6.3 it answered "Call the boss!" to everything from a checksum list
// that could not be written to a corrupt copy, and it said
// "Verified. You can remove your card." over a run whose manifest was never
// written, while the desktop window was withholding EJECT for that exact case.
//
//   node scripts/test-kiosk-window.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── DOM ─────────────────────────────────────────────────────────────────────
let els = {}, ejected = [];
function makeEl() {
  const el = { className:'', innerHTML:'', textContent:'', _cl:new Set(),
               classList:{ add:c=>el._cl.add(c), remove:c=>el._cl.delete(c),
                           toggle:(c,v)=>{ v?el._cl.add(c):el._cl.delete(c); },
                           contains:c=>el._cl.has(c) } };
  return el;
}
const ctx = vm.createContext({
  console,
  document: { getElementById: id => (els[id] || (els[id] = makeEl())) },
  S: { sources: [], dests: [] },
  window: { ingesto: { ejectVolume: (p) => { ejected.push(p); return Promise.resolve({ok:true}); } } },
  playIngestSound: () => {},
  STOP_SVG: '<svg id="stop"></svg>',
});
vm.runInContext([
  extractFn(REND, 'esc'),
  extractFn(REND, 'driveNameOf'),
  extractConst(REND, 'K_SAFE'), extractConst(REND, 'K_KEEP'), extractConst(REND, 'K_BOSS'),
  extractFn(REND, 'kioskShort'),
  extractFn(REND, 'kioskShowResult'),
  extractFn(REND, 'kioskAfterIngest'),
].join('\n'), ctx);

// The contract, written out here rather than read from the source: a test that
// imports the strings it is checking cannot notice them changing.
// (`const` inside a vm script never lands on the context object anyway.)
const K_SAFE = 'You can remove your card.';
const K_KEEP = 'Remove your card. Do not erase it.';
const K_BOSS = 'Do not erase it. Call the person in charge.';
const ANSWERS = [K_SAFE, K_KEEP, K_BOSS];
console.log('\nthe three answers, and only three');
for (const [n, want] of [['K_SAFE',K_SAFE],['K_KEEP',K_KEEP],['K_BOSS',K_BOSS]])
  ok(new RegExp("^const " + n + " = '" + want.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + "';$", 'm').test(REND),
     `${n} still reads "${want}"`);
ok(!/do not erase it yet/i.test(REND),
   'and "yet" is gone: it promised a verification that never comes in FAST');

const card = (over) => Object.assign({
  success:true, canceled:false, errors:0, errorList:[], failedFiles:[], unstableFiles:[],
  sourceName:'A001_LUMIX', sourcePath:'/Volumes/A001_LUMIX',
  destPath:'/Volumes/SHUTTLE_1/001_A001', relFolder:'001_A001',
  totalFiles:186, copiedFiles:186, skippedFiles:0, mode:'slow', sidecarFailed:[],
  coldVerify:true, doubleReadCached:false, scanIncomplete:false,
}, over);

const run = (R, sources) => {
  els = {}; ejected = [];
  ctx.S = { sources: sources || [{ path:'/Volumes/A001_LUMIX' }],
            dests: [{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' },
                    { path:'/Volumes/NAS_BACKUP', name:'NAS_BACKUP' }] };
  ctx.kioskAfterIngest(R);
  const sub = (els['kr-sub']||makeEl()).innerHTML;
  const m = /<div class="kr-answer">([\s\S]*?)<\/div>/.exec(sub);
  return { title:(els['kr-title']||makeEl()).textContent,
           sub, answer: m ? m[1] : null,
           cls:(els['kr-card']||makeEl()).className,
           btn:(els['kr-btn']||makeEl()).textContent,
           ejected: ejected.slice() };
};

console.log('\nverified, cold, nothing skipped');
{
  const v = run([card()]);
  ok(v.title === 'Verified', 'the title is the verdict');
  ok(v.answer === K_SAFE, 'the card may be removed');
  ok(v.ejected.length === 1, 'and it is ejected for the operator');
}

console.log('\nFAST and SIZE CHECK: removable, never erasable');
{
  ok(run([card({ mode:'fast' })]).answer === K_KEEP, 'FAST keeps the card');
  ok(run([card({ mode:'normal' })]).answer === K_KEEP, 'SIZE CHECK keeps the card');
  ok(!/yet/.test(run([card({ mode:'fast' })]).sub),
     'and the word "yet" is gone: no verification is coming later');
}

console.log('\nthe read-back that may have come from memory');
{
  const v = run([card({ doubleReadCached:true })]);
  ok(v.answer === K_KEEP, 'the card is kept');
  ok(/memory/.test(v.sub), 'and the reason is said, not hidden behind "Verified"');
}

console.log('\nthe manifest that was not written');
{
  // The desktop window withholds EJECT here, saying the card is the only
  // original left. The kiosk used to answer "You can remove your card" AND
  // eject the card itself.
  const v = run([card({ mode:'pro', sidecarFailed:['checksum list'] })]);
  ok(v.answer === K_KEEP, 'the kiosk agrees with the window and keeps the card');
  ok(v.ejected.length === 0, 'and it does not eject it');
  ok(/checksum list/.test(v.sub), 'the reason is named');
}

console.log('\na dying card is not a drive problem');
{
  const a = run([card({ success:false, unstableFiles:['A.MOV','B.MOV'] })]);
  ok(a.answer === K_BOSS, 'a card giving two different answers reaches the person in charge');
  ok(!/SHUTTLE_1|NAS_BACKUP/.test(a.sub), 'and no healthy drive is blamed');
  const b = run([card({ success:false, scanIncomplete:true, errors:1 })]);
  ok(b.answer === K_BOSS && !/SHUTTLE/.test(b.sub),
     'nor when part of the card could not be read');
  const c = run([card({ success:false, errors:1, failedFiles:['A.MOV'],
    errorList:[{ file:'A.MOV', error:'EIO', phase:'copy', origin:'source' }] })]);
  ok(c.answer === K_BOSS && !/SHUTTLE/.test(c.sub),
     'nor when the card itself refused to be read');
}

console.log('\na drive that lost files IS named, and counted once');
{
  // Same file failing on two destinations is one file.
  const v = run([
    card({ success:false, errors:1, failedFiles:['A.MOV'],
           errorList:[{ file:'A.MOV', error:'x', phase:'verify', origin:'destination' }] }),
    card({ success:false, errors:1, failedFiles:['A.MOV'], destPath:'/Volumes/NAS_BACKUP/001_A001',
           errorList:[{ file:'A.MOV', error:'x', phase:'verify', origin:'destination' }] }),
  ]);
  ok(/^1 file failed/.test(v.sub.replace(/<[^>]*>/g,'')),
     'one file, not two: ' + v.sub.replace(/<[^>]*>/g,'').slice(0,40));
  ok(v.answer === K_BOSS, 'and the card is kept');
}

console.log('\na full card that was already backed up is not an empty card');
{
  // The engine counts what is LEFT to copy, so a card entirely already ingested
  // comes back with totalFiles:0. The kiosk told the operator their full card
  // was empty and to load it again.
  const v = run([card({ totalFiles:0, copiedFiles:0, skippedFiles:186 })]);
  ok(!/empty/.test(v.sub), 'it does not call a full card empty');
  ok(v.answer === K_SAFE, 'and the card may be removed');
  ok(/186/.test(v.sub), 'the number already on the drives is stated');
}

console.log('\na genuinely empty card, and a filter that excluded everything');
{
  const a = run([card({ success:false, errors:1, totalFiles:0, copiedFiles:0,
                        emptyReason:'no-files', seenFiles:0 })]);
  ok(!/Call the boss/.test(a.title + a.sub), 'no alarm for an empty card');
  ok(/folder inside it/.test(a.sub), 'the most likely cause is named');
  const b = run([card({ success:false, errors:1, totalFiles:0, copiedFiles:0,
                        emptyReason:'filtered-out', seenFiles:186 })]);
  ok(/filter/.test(b.sub), 'and the filter case says the filter, not "the card is empty"');
}

console.log('\na card that could not be fully read never gets the safe answer');
{
  // Found in the second review. These two shapes used to reach the
  // "nothing to copy" branches, which sat above every failure check and keyed
  // off totalFiles alone. The desktop window said "PART OF THIS CARD COULD NOT
  // BE READ / Do not format this card." for the same result set.
  const a = run([card({ success:false, errors:2, totalFiles:0, copiedFiles:0,
                        skippedFiles:186, scanIncomplete:true })]);
  ok(a.answer === K_BOSS,
     'a card whose scan failed is kept, even when everything readable was already there');
  ok(!/remove your card/i.test(a.answer||''), 'never the safe answer');
  const b = run([card({ success:false, errors:1, totalFiles:0, copiedFiles:0,
                        scanIncomplete:true })]);
  ok(b.answer === K_BOSS, 'and not "this card is empty" either');
  ok(!/empty/.test(b.sub), 'the card is not called empty when it could not be read');
}

console.log('\nrefused, and cancelled');
{
  const a = run([card({ success:false, refused:true, errors:1, totalFiles:0,
    errorList:[{ file:'(pre-flight)', phase:'setup',
                 error:'The folder "012_A001" already exists and is not empty. Nothing was written.' }] })]);
  ok(a.title === 'Not started', 'a refusal is not a failure');
  ok(/Ask the person in charge/.test(a.answer||''), 'and it says who can fix it');
  ok(!/Call the boss/.test(a.sub), 'without the alarm reserved for the rushes');
  const b = run([card({ success:false, canceled:true, copiedFiles:12 })]);
  ok(b.answer === K_KEEP, 'a stopped ingest keeps the card, in the standard words');
}

console.log('\nno destination configured');
{
  els = {}; ejected = [];
  ctx.kioskShowResult('stop','Not set up yet','No destination has been chosen.',
                      'Ask the person who set up this station.');
  const sub=(els['kr-sub']||makeEl()).innerHTML;
  ok(/Ask the person who set up this station/.test(sub),
     'the shooter is told who can fix it, not alarmed');
}

console.log('\na drive named by an attacker cannot forge the verdict');
{
  // The verdict line is described in the code as "the only line some people
  // read". A volume can be named anything, and the kiosk switched from
  // textContent to innerHTML in this release.
  const evil = 'SHUTTLE<div class="kr-answer">' + K_SAFE + '</div><span>';
  const v = run([
    card({ success:false, errors:1, failedFiles:['A.MOV'],
           destPath:'/Volumes/'+evil+'/001_A001',
           errorList:[{ file:'A.MOV', error:'x', phase:'verify', origin:'destination' }] }),
  ], [{ path:'/Volumes/A001_LUMIX' }]);
  const answers = [...v.sub.matchAll(/<div class="kr-answer">([\s\S]*?)<\/div>/g)].map(m=>m[1]);
  ok(answers.length === 1, 'exactly one verdict line, whatever the drive is called');
  ok(answers[0] === K_BOSS, 'and it is the real one');
  ok(!/<span>/.test(v.sub), 'no tag from a volume name survives into the page');
}

console.log('\nevery answer is one of the three, or an explicit fourth');
{
  const cases = [
    ['verified', [card()]],
    ['fast', [card({ mode:'fast' })]],
    ['cached', [card({ doubleReadCached:true })]],
    ['no manifest', [card({ sidecarFailed:['checksum list'] })]],
    ['unstable', [card({ success:false, unstableFiles:['A'] })]],
    ['failed', [card({ success:false, errors:1, failedFiles:['A'],
      errorList:[{file:'A',error:'x',phase:'verify',origin:'destination'}] })]],
    ['cancelled', [card({ success:false, canceled:true })]],
    ['skipped', [card({ totalFiles:0, copiedFiles:0, skippedFiles:186 })]],
  ];
  for (const [label, R] of cases) {
    const v = run(R);
    ok(ANSWERS.includes(v.answer),
       `"${label}" ends on one of the three answers ("${v.answer}")`);
  }
}

console.log('\nkiosk mode cannot be entered over a running ingest');
{
  // The overlay covers the transfer view. Behind it the copy carries on, and
  // the kiosk screen, which knows nothing about that run, shows its own START.
  const toasts = [];
  const kctx = vm.createContext({
    console,
    S: { copying:false, _starting:false, kioskPin:'1234', kioskMode:false },
    showToast: (m, kind) => toasts.push([kind, m]),
    persistPrefs(){}, applyKioskMode(){}, kioskOpenPin(){},
  });
  vm.runInContext(extractFn(REND, 'kioskBusy'), kctx);
  vm.runInContext(extractFn(REND, 'enterKiosk'), kctx);

  kctx.S.copying = true;
  kctx.enterKiosk();
  ok(kctx.S.kioskMode === false, 'with a card copying, KIOSK does nothing');
  ok(toasts.length === 1 && /still running/.test(toasts[0][1]), 'and says why');

  kctx.S.copying = false; kctx.S._starting = true;
  kctx.enterKiosk();
  ok(kctx.S.kioskMode === false, 'the same in the moment between START and the first byte');

  kctx.S._starting = false;
  kctx.enterKiosk();
  ok(kctx.S.kioskMode === true, 'and once the station is idle it works');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
