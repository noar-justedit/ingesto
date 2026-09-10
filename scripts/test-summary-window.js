#!/usr/bin/env node
// The window an operator sees at the end of an ingest, and the only one many of
// them ever read carefully. It is also the one that has told the most lies:
// "Transfer Complete!" over a card whose files were silently skipped, a green
// tick over a batch whose second card was stopped at 1 file of 3.
//
// This suite runs the real showSummary() from index.html against a fake DOM and
// pins down what it is allowed to claim.
//
//   node scripts/test-summary-window.js
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

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── A DOM just big enough ───────────────────────────────────────────────────
const IDS = ['s-ico','s-title','s-sub','s-grid','s-grid2','s-cards','s-coldverify',
             's-unstable','s-errs','s-errlist','sum-recopy','sum-ov'];
// Setting innerHTML really does change textContent in a browser, and the title
// is written both ways depending on whether it needs a line break. Without this
// link the suite would read an empty title and pass on nothing.
function makeEl() {
  const el = { className:'', disabled:false, style:{}, _cl:new Set(), onclick:null,
               _html:'', _text:'',
               classList:{ add:c=>el._cl.add(c), remove:c=>el._cl.delete(c),
                           toggle:(c,v)=>{ v?el._cl.add(c):el._cl.delete(c); },
                           contains:c=>el._cl.has(c) } };
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = String(v);
            el._text = String(v).replace(/<br\s*\/?>/gi,' ').replace(/<[^>]*>/g,'')
                        .replace(/&nbsp;/g,'\u00a0').replace(/&amp;/g,'&')
                        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'); } });
  Object.defineProperty(el, 'textContent', {
    get(){ return el._text; },
    set(v){ el._text = String(v); el._html = String(v); } });
  return el;
}
let els = {};
const ctx = vm.createContext({
  console,
  document: { getElementById: id => (els[id] || (els[id] = makeEl())) },
  // Everything showSummary reaches for outside itself, stubbed to be inert.
  S: {},
  window: { ingesto: { platform:'darwin', isRemovable: async()=>false, detectCamera: async()=>null,
                       ejectVolume: async()=>({ok:true}) } },
  playIngestSound: () => {},
  showToast: () => {},
  redoDoubleRead: () => {},
  // The REAL one, so the EJECT gate is a fact this suite can check. Its async
  // tail (isRemovable, the DOM walk) is harmless here: what matters is whether
  // it returns before touching anything.
  ejectReached: false,
  revealAt: () => {},
});
vm.runInContext([
  extractFn(REND, 'fmtSize'), extractFn(REND, 'fmtSpd'),
  extractFn(REND, 'fmtEta'),  extractFn(REND, 'esc'),
  // The real remarks renderer, so a note the engine reports is really rendered
  // and not swallowed by a stub.
  extractFn(REND, 'renderSummaryNotes'),
  // The real failure grouping, so "thirty corrupt files are ONE line" is a fact
  // this suite can check rather than a claim in a comment.
  extractFn(REND, 'humanErrno'), extractFn(REND, 'buildFailureGroups'),
  extractFn(REND, 'driveNameOf'), extractFn(REND, 'failureVerdict'),
  // Wrapped, not stubbed: the gate inside it is what decides whether a DIT is
  // offered the button that comes just before formatting the card.
  // The flag is set where the function stops being a gate and starts offering
  // the button, so a check on it is a check on the gate.
  'async ' + extractFn(REND, 'setupEjectButtons').replace(
    'const shown=[];', 'ejectReached = true; const shown=[];'),
  extractFn(REND, 'showSummary'),
].join('\n'), ctx);

// One card, one destination, everything fine. Overrides shape each scenario.
const card = (over) => Object.assign({
  success:true, canceled:false, errors:0, errorList:[], failedFiles:[], unstableFiles:[],
  sourceName:'A001_LUMIX', sourcePath:'/Volumes/A001_LUMIX', destPath:'/Volumes/SHUTTLE_1/001_A001',
  totalFiles:186, copiedFiles:186, skippedFiles:0, totalBytes:64*1024*1024*1024,
  duration:600000, copyMs:400000, verify1Ms:180000, verify2Ms:0,
  mode:'slow', proAlgo:null, proDoubleRead:false, coldVerify:true, doubleReadCached:false,
}, over);

const show = (R) => {
  els = {}; ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' },
                     { path:'/Volumes/NAS_BACKUP', name:'NAS_BACKUP' }], sources:[] };
  ctx.showSummary(R);
  const g = (id) => (els[id] || makeEl());
  // The title glues "&" to the word after it with a non-breaking space, so
  // comparisons here read the visible text and one dedicated check below
  // guards the glue itself.
  return { title:String(g('s-title').textContent).replace(/\u00a0/g,' '),
           rawTitle:g('s-title').textContent, titleHtml:g('s-title').innerHTML,
           tclass:g('s-title').className,
           sub:g('s-sub').innerHTML, icls:g('s-ico').className,
           grid:g('s-grid').innerHTML, grid2:g('s-grid2').innerHTML,
           g2class:g('s-grid2').className, g2cols:(g('s-grid2').style||{}).gridTemplateColumns,
           cards:g('s-cards').innerHTML, notes:g('s-notes').innerHTML,
           errs:g('s-errlist').innerHTML, errsShown:(g('s-errs').style||{}).display==='block',
           cold:g('s-coldverify').innerHTML,
           lead:g('s-lead').textContent, leadCls:g('s-lead').className,
           notesShown:(g('s-notes').style||{}).display!=='none', S:ctx.S };
};
const tiles = (html) => [...html.matchAll(/class="sr-lbl">([^<]*)</g)].map(m => m[1]);

console.log('\nSECURE, one card, nothing skipped');
{
  const v = show([card()]);
  ok(v.title === 'ALL FILES COPIED & VERIFIED',
     'the title states the result and carries no count ("' + v.title + '")');
  ok(/t-ok/.test(v.tclass) && /sum-ico ok/.test(v.icls), 'green title, green tick');
  ok(/&\u00a0VERIFIED/.test(v.rawTitle),
     'the ampersand is glued to the word after it, so it can never end a line');
  ok(/A001_LUMIX/.test(v.sub) && /xxHash64/.test(v.sub), 'the card and the algorithm sit under it');
  ok(!/caveat/.test(v.sub), 'and nothing is flagged in red');
  ok(JSON.stringify(tiles(v.grid)) === '["Mode","Files","Total size"]',
     'row 1 is what was moved: ' + JSON.stringify(tiles(v.grid)));
  ok(JSON.stringify(tiles(v.grid2)) === '["Copy","Verify","Total","Avg speed"]',
     'row 2 is the tempos then the speed: ' + JSON.stringify(tiles(v.grid2)));
  ok(!/2nd read/.test(v.grid2), 'no second-read tile: SECURE never reads the card twice');
  ok(!/color:var\(--green\)/.test(v.grid2) && !/color:var\(--blue\)/.test(v.grid2),
     'the tempos carry no colour: they are measurements, not verdicts');
  ok(/color:var\(--orange\)/.test(v.grid), 'only the MODE tile is coloured');
}

console.log('\nFAST says what it did not do, in red');
{
  const v = show([card({ mode:'fast', verify1Ms:0 })]);
  ok(v.title === 'ALL FILES COPIED', 'the title promises nothing more ("' + v.title + '")');
  ok(/class="caveat">not verified</.test(v.sub), 'the sub-line carries "not verified" in red');
  ok(JSON.stringify(tiles(v.grid2)) === '["Copy","Total","Avg speed"]',
     'and no verify tile at all: ' + JSON.stringify(tiles(v.grid2)));
}

console.log('\nSIZE CHECK is not a verification');
{
  const v = show([card({ mode:'normal', verify1Ms:2000 })]);
  ok(v.title === 'ALL FILES COPIED & SIZE-CHECKED', 'the title says exactly what ran');
  ok(/class="caveat">content not verified</.test(v.sub), 'and the sub-line spells out the limit');
}

console.log('\nPRO with the double read on');
{
  const v = show([card({ mode:'pro', proAlgo:'xxh128', proDoubleRead:true, verify2Ms:150000 })]);
  ok(v.title === 'ALL FILES COPIED & VERIFIED', 'same promise as SECURE');
  ok(/xxHash128/.test(v.sub), 'the algorithm the operator picked is named');
  ok(/PRO<span class="sr-opt"> \+ DOUBLE READ<\/span>/.test(v.grid),
     'the option rides on the SAME line as the mode, smaller');
  ok(JSON.stringify(tiles(v.grid2)) === '["Copy","Verify","2nd read","Total","Avg speed"]',
     'five tempo tiles: ' + JSON.stringify(tiles(v.grid2)));
  ok(/n5/.test(v.g2class), 'and the row switches to its tighter type size');
}
console.log('\nPRO without it says nothing at all about it');
{
  const v = show([card({ mode:'pro', proAlgo:'xxh64', proDoubleRead:false })]);
  ok(!/DOUBLE READ/.test(v.grid), 'never "double read: no"');
  ok(!/2nd read/.test(v.grid2), 'and no empty tile reserved for it');
}

console.log('\nfiles passed over: "ALL" has to go');
{
  // The engine counts what was LEFT to copy, so totalFiles already excludes the
  // files passed over: a card of 248 with 186 already on the drive comes back
  // as 62 of 62. The promise has to drop on skippedFiles, not on cf<tf, or it
  // never drops at all.
  const v = show([card({ totalFiles:62, copiedFiles:62, skippedFiles:186 })]);
  ok(v.title === '62 NEW FILES COPIED & VERIFIED',
     'the count comes back the moment the promise stops being true ("' + v.title + '")');
  ok(!/^ALL/.test(v.title), 'and "ALL" is gone');
  // 62 copied out of the 248 the card holds. "62/62" repeated one number
  // twice, because totalFiles already excludes what was passed over.
  ok(/62\/248/.test(v.grid), 'the Files tile shows what was copied and what the card holds');
  ok(/left out on&nbsp;purpose/.test(v.grid2), 'and a full-width line says what was left out');
  ok(/class="sr-note"/.test(v.grid2), 'as prose, not in the monospace kept for figures and paths');
}

console.log('\none card: everything is open, EJECT sits on the card, REVEAL on its destination');
{
  const v = show([card(), card({ destPath:'/Volumes/NAS_BACKUP/001_A001' })]);
  ok((v.cards.match(/class="sc"/g)||[]).length === 1, 'two destinations are ONE card, not two');
  ok(!/sc-caret/.test(v.cards), 'nothing to unfold, so no caret');
  ok(!/display:none/.test(v.cards.split('sc-dests')[1]||''), 'the destinations are already visible');
  ok((v.cards.match(/>REVEAL</g)||[]).length === 2, 'one REVEAL per destination');
  ok(/sc-ej-0[^>]*onclick="ejectCard\(0\)"/.test(v.cards), 'one EJECT, on the card');
  // The bug this ordering exists to prevent: EJECT nested inside the clickable
  // area meant a click on EJECT also unfolded the card.
  const row = v.cards.match(/<div class="sc-row">([\s\S]*?)<\/div><div class="sc-dests"/);
  ok(!!row && /<\/div><button class="mini-btn ej"/.test(row[1]),
     'EJECT is a sibling of the clickable area, not a child of it');
}

console.log('\ntwo cards: names only, and the NAME is what unfolds');
{
  const v = show([card({ sourceName:'A001', sourcePath:'/Volumes/A001' }),
                  card({ sourceName:'B002', sourcePath:'/Volumes/B002',
                         destPath:'/Volumes/SHUTTLE_1/002_B002' })]);
  ok(v.title === 'ALL FILES COPIED & VERIFIED', 'the title does not change for a batch');
  ok(/^2 cards/.test(v.sub), 'the sub-line counts them instead of listing them');
  ok((v.cards.match(/class="sc"/g)||[]).length === 2, 'two card blocks');
  ok((v.cards.match(/onclick="toggleCard\(/g)||[]).length === 2, 'each name unfolds its own card');
  ok((v.cards.match(/class="sc-dests" id="sc-d-\d+" style="display:none"/g)||[]).length === 2,
     'both start folded');
  ok(/EJECT ALL/.test(v.cards), 'and the header offers EJECT ALL');
  ok(!/DETAILS/.test(v.cards), 'there is no global DETAILS button');
}

console.log('\na batch has no average speed');
{
  const v = show([card({ sourceName:'A001', sourcePath:'/Volumes/A001' }),
                  card({ sourceName:'B002', sourcePath:'/Volumes/B002' })]);
  ok(!/Avg speed/.test(v.grid2),
     'it would average cards of different throughputs and describe none of them');
  ok(!/—/.test(v.grid2), 'and the tile is gone, not shown as a dash');
}

console.log('\nremarks: nothing failed, something was not done');
{
  // A run where every file was copied and verified, but the card's own log
  // could not be written. The title stays green: nothing failed. The remark is
  // there because without it the NEXT ingest's "copy new files" goes quiet with
  // no explanation.
  const v = show([card({ notes:[{ code:'CV-8',
    text:'This ingest was not recorded on the card.',
    detail:'The card is write-protected.' }] })]);
  ok(v.title === 'ALL FILES COPIED & VERIFIED', 'the title is untouched: nothing failed');
  ok(/t-ok/.test(v.tclass), 'and it stays green');
  ok(v.notesShown === true, 'the remarks block is shown');
  ok(/This ingest was not recorded on the card/.test(v.notes), 'the remark is there');
  ok(/write-protected/.test(v.notes), 'with the detail under it');
}
{
  const v = show([card()]);
  ok(v.notesShown === false, 'and on a run with nothing to remark, the block is not there at all');
}
{
  // One block per remark, and remarks from every card of a batch.
  const v = show([card({ sourceName:'A001', sourcePath:'/Volumes/A',
                         notes:[{ code:'CV-8', text:'A' }] }),
                  card({ sourceName:'B002', sourcePath:'/Volumes/B',
                         notes:[{ code:'CV-9', text:'B' }] })]);
  ok((v.notes.match(/class="s-note"/g)||[]).length === 2, 'both cards contribute their remark');
}

console.log('\na manifest that was not written takes the promise off the title');
{
  // Reported from the field: the checksum-list write failed, the failure went
  // into errorList but never into r.errors, so `ok` stayed true. Green tick,
  // "Complete!", EJECT lit, and no manifest on the drive. In PRO the manifest
  // IS the product.
  const v = show([card({ mode:'pro', proAlgo:'xxh64', sidecarFailed:['checksum list'] })]);
  ok(v.title === 'ALL FILES COPIED & VERIFIED NO MANIFEST WRITTEN',
     'the title says what is missing ("' + v.title + '")');
  ok(/<br>/.test(v.titleHtml || ''), 'broken by hand into two lines, not left to wrap');
  ok(/t-warn/.test(v.tclass), 'and it is not green');
  ok(!/sum-ico ok/.test(v.icls), 'nor is the tick');
  ok(/could not be written/.test(v.notes), 'a remark spells it out');
  ok(/EJECT stays off/.test(v.notes), 'and says the button is off on purpose');
  ok(/Every file was copied and verified/.test(v.notes),
     'while still saying what is NOT affected');
}

console.log('\nand it does not claim everything was verified when it was not');
{
  // Same remark, on a run that ALSO lost files. It sat under a red title and
  // told the operator the opposite of what the title said.
  const v = show([card({ mode:'pro', proAlgo:'xxh64', sidecarFailed:['checksum list'],
                         success:false, errors:2, failedFiles:['A.MOV','B.MOV'],
                         errorList:[{ file:'A.MOV', error:'ENOSPC', phase:'copy', origin:'destination' },
                                    { file:'B.MOV', error:'ENOSPC', phase:'copy', origin:'destination' }] })]);
  ok(/DID NOT SURVIVE|DID NOT SURVIVE/.test(v.title), 'the title is the failure ("' + v.title + '")');
  ok(/could not be written/.test(v.notes), 'the missing manifest is still reported');
  ok(!/Every file was copied and verified/.test(v.notes),
     'but nothing claims every file was verified');
  ok(/On top of what failed above/.test(v.notes), 'the remark reads as an addition to the failure');
  ok(/EJECT stays off/.test(v.notes), 'and EJECT is still off');
}

console.log('\nset-aside copies pile up across attempts, and the retry gets all of them');
{
  // Attempt 1 sets aside "A.MOV.ingesto-failed". Attempt 2 fails too and sets
  // aside "A.MOV.ingesto-failed-2". Each run only knows its own, so handing the
  // next retry the latest list left the first generation on the drive for ever:
  // Verify reports that folder as holding a bad copy, and re-ingesting it is
  // refused, because a folder carrying "A.MOV" and "A.MOV.ingesto-failed" is
  // exactly what the name guard turns away.
  const fail1 = card({ success:false, errors:1, failedFiles:['A.MOV'], failedMap:{},
                       quarantinedPaths:['/Volumes/SHUTTLE_1/001_A001/A.MOV.ingesto-failed'] });
  const fail2 = card({ success:false, errors:1, failedFiles:['A.MOV'], failedMap:{},
                       quarantinedPaths:['/Volumes/SHUTTLE_1/001_A001/A.MOV.ingesto-failed-2'] });
  els = {}; ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.showSummary([fail1]);
  ok((ctx.S._failedGroups[0].quarantined||[]).length === 1, 'after the first failure, one path');
  ctx.showSummary([fail2], { retryOf:[fail1] });
  const q = ctx.S._failedGroups[0].quarantined || [];
  ok(q.length === 2, 'after the second, both (' + q.length + ')');
  ok(q.some(p => /A\.MOV\.ingesto-failed$/.test(p)) && q.some(p => /-2$/.test(p)),
     'the first generation is still in the list handed to the next retry');

  // And a NEW run starts the tally over: those paths belong to a folder this
  // run has nothing to do with.
  els = {}; ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.showSummary([fail2]);
  ok((ctx.S._failedGroups[0].quarantined||[]).length === 1, 'a fresh run does not inherit them');
}

console.log('\nthe window of a re-copy says it is a re-copy');
{
  // RE-COPY FAILED FILES puts two files back into a folder the first run
  // created. The window was built as though those two files were the ingest:
  // "ALL FILES COPIED & VERIFIED", green, over a card whose first run had
  // called it suspect.
  const first = [card({ success:false, errors:2, failedFiles:['A.MOV','B.MOV'],
                        unstableFiles:['A.MOV'] })];
  els = {};
  ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.ejectReached = false;
  ctx.showSummary([card({ totalFiles:2, copiedFiles:2 })], { retryOf: first });
  const g = (id) => (els[id] || { textContent:'', innerHTML:'', className:'', _cl:new Set() });
  const title = String(g('s-title').textContent).replace(/\u00a0/g,' ');
  const notes = g('s-notes').innerHTML || '';
  ok(!/^ALL/.test(title), 'the title does not open on "ALL" ("' + title + '")');
  ok(/describes the re-copy/.test(notes), 'a remark says the window is about the re-copy alone');
  ok(/could not read this card cleanly/.test(notes),
     'and the first run calling the card suspect is carried over');
  ok(/Do not format this card/.test(notes), 'with the instruction that goes with it');
  // The three things a DIT acts on: the title, the button, the source list.
  ok(/STILL SUSPECT/.test(title), 'the TITLE says the card is still suspect');
  ok(/t-bad/.test(g('s-title').className||''), 'and it is the red one');
  ok(ctx.S._clearSrcOnClose === false, 'the card is not cleared out of the source list');
  ok(/sum-ico err/.test(g('s-ico').className||''), 'no green tick over a suspect card');
  ok(ctx.ejectReached === false,
     'and EJECT never even gets as far as offering itself');

  // A first run with nothing wrong with the CARD does not get that second remark.
  els = {};
  ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.ejectReached = false;
  ctx.showSummary([card({ totalFiles:1, copiedFiles:1 })],
                  { retryOf: [card({ success:false, errors:1, failedFiles:['A.MOV'] })] });
  const n2 = (els['s-notes'] || { innerHTML:'' }).innerHTML || '';
  const t2 = String((els['s-title'] || { textContent:'' }).textContent).replace(/\u00a0/g,' ');
  ok(/1 FILE RE-COPIED/.test(t2), 'the title counts what was re-copied ("' + t2 + '")');
  ok(!/^ALL/.test(t2), 'and never opens on "ALL": it knows nothing about the rest of the card');
  ok(/describes the re-copy/.test(n2), 'the re-copy remark is still there');
  ok(!/could not read this card cleanly/.test(n2), 'but the card is not accused for nothing');
  ok(ctx.S._clearSrcOnClose === true, 'and a clean re-copy of a sound card still finishes the job');
  ok(ctx.ejectReached === true, 'with EJECT offered again');

  // A first run that could not READ the card is the same verdict, by another
  // name: it is the branch the changed-source check feeds, and a plain EIO on
  // a dying card.
  els = {}; ctx.ejectReached = false;
  ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.showSummary([card({ totalFiles:1, copiedFiles:1 })], { retryOf: [card({
    success:false, errors:1, failedFiles:['A.MOV'],
    errorList:[{ file:'A.MOV', phase:'copy', origin:'source',
                 error:'this file changed on the card while it was being copied' }] })] });
  const t3 = String((els['s-title']||{ textContent:'' }).textContent).replace(/\u00a0/g,' ');
  ok(/STILL SUSPECT/.test(t3), 'a card the first run could not read stays suspect ("'+t3+'")');
  ok(ctx.ejectReached === false, 'and EJECT stays out of reach');
  ok(ctx.S._clearSrcOnClose === false, 'and the card stays in the list');

  // A retry that FAILED is a drive story, not a card story.
  els = {}; ctx.ejectReached = false;
  ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], sources:[] };
  ctx.showSummary([card({ success:false, errors:1, copiedFiles:0, failedFiles:['A.MOV'],
                          errorList:[{ file:'A.MOV', phase:'copy', origin:'destination',
                                       error:'ENOSPC: no space left on device' }] })],
                  { retryOf:[card({ success:false, errors:1, failedFiles:['A.MOV'],
                                    unstableFiles:['A.MOV'] })] });
  const t4 = String((els['s-title']||{ textContent:'' }).textContent).replace(/\u00a0/g,' ');
  ok(!/WERE RE-COPIED/.test(t4), 'it is not headlined as a re-copy that worked ("'+t4+'")');
  ok(/SHUTTLE_1|DID NOT SURVIVE|NOT FINISH/.test(t4), 'the title is about what actually failed');
  ok(/ran out of space/.test((els['s-errlist']||{ innerHTML:'' }).innerHTML||''),
     'and the real reason is still spelled out');
}

console.log('\na card that never reported back is not a card that succeeded');
{
  // The run started with three cards and came back with one result. "every
  // card succeeded" was true of the list in hand, so the window went green,
  // EJECT lit up, and the source list was emptied for two cards nobody had
  // copied.
  ctx.S = { dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }],
            sources:[],
            run:{ dests:[{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }],
                  sources:[{ path:'/Volumes/A001_LUMIX', name:'A001_LUMIX' },
                           { path:'/Volumes/B002', name:'B002' },
                           { path:'/Volumes/C003', name:'C003' }] } };
  els = {};
  ctx.showSummary([card()]);
  const g = (id) => (els[id] || { textContent:'', innerHTML:'', _cl:new Set() });
  const notes = g('s-notes').innerHTML || '';
  const title = (g('s-title').textContent || '').replace(/\s+/g,' ').trim();
  ok(ctx.S._clearSrcOnClose === false, 'the source list is NOT emptied');
  ok(!/t-ok/.test(g('s-title').className||''), 'the title is not the green one ("'+title+'")');
  ok(/did not report back/.test(notes), 'a remark names what is missing');
  ok(/2 cards did not report back/.test(notes), 'and how many ('+notes.replace(/<[^>]*>/g,' ').trim().slice(0,90)+')');
}

console.log('\nthe title names the DRIVE, whatever the template does');
{
  // The second-to-last path segment is the drive only while templates are one
  // level deep. With "{YYYY}-{MM}-{DD}/{counter}_{cardname}" it is the date,
  // and the window read "the copy to 2026-09-09".
  const deep = card({ success:false, errors:1, failedFiles:['A.MOV'],
    destPath:'/Volumes/NAS_BACKUP/2026-09-09/001_A001', relFolder:'2026-09-09/001_A001',
    errorList:[{ file:'A.MOV', error:'xxHash mismatch', phase:'verify', origin:'destination' }] });
  const v = show([deep]);
  ok(/NAS_BACKUP/.test(v.title), 'the drive is named ("' + v.title + '")');
  ok(!/2026-09-09/.test(v.title), 'and the date folder is not mistaken for it');
  // Same answer without relFolder, from the destination list the operator built.
  const noRel = Object.assign({}, deep); delete noRel.relFolder;
  ok(ctx.driveNameOf(noRel) === 'NAS_BACKUP',
     'and with no relFolder, the drive is recognised from the destination list');
}

console.log('\nthe card is the problem: a different window, and no talk of drives');
{
  const v = show([card({ success:false, errors:0, unstableFiles:['A.MOV','B.MOV'] })]);
  ok(v.title === 'THIS CARD IS NOT GIVING THE SAME DATA TWICE',
     'the title is about the card ("' + v.title + '")');
  ok(/Copy it again on another\u00a0reader/.test(v.lead), 'and the instruction changes with it');
  ok(!/NAS_BACKUP|SHUTTLE/.test(v.title), 'no drive is named: it is not the drive');
}
console.log('\na corrupt file left under its real name comes first');
{
  const v = show([card({ success:false, errors:1, unstableFiles:['X.MOV'],
    errorList:[{ file:'P1000418.MOV', destRel:'P1000418.MOV', phase:'verify',
                 origin:'destination', notQuarantined:true,
                 error:'xxHash mismatch: this file failed verification and could NOT be set aside.' }] })]);
  ok(v.title === 'A CORRUPT FILE IS SITTING IN THE DELIVERED FOLDER',
     'it outranks even a failing card ("' + v.title + '")');
  ok(/wears its real name/.test(v.errs), 'and the block says why that is the worst case');
  ok(v.errs.indexOf('corrupt file is still in the delivered folder') <
     (v.errs.indexOf('two different answers')<0 ? 1e9 : v.errs.indexOf('two different answers')),
     'it is listed first');
}
console.log('\na drive unplugged mid-verify is not a corrupt file');
{
  // Found in the second review. Testing phase==='verify' alone collapsed every
  // verify-phase failure into "corrupt on arrival", and a drive pulled out of
  // the socket also fails to rename the bad copy aside, so the headline
  // accused the folder of holding a corrupt file that does not exist.
  const v = show([card({ success:false, errors:3, failedFiles:['A.MOV','B.MOV','C.MOV'],
    errorList:[{ file:'A.MOV', phase:'verify', origin:'destination', notQuarantined:true,
                 error:'ENODEV: no such device, read' },
               { file:'B.MOV', phase:'verify', origin:'destination',
                 error:'ENODEV: no such device, read' }] })]);
  ok(!/CORRUPT/.test(v.title), 'the headline does not invent a corrupt file ("' + v.title + '")');
  ok(/disconnected during the copy/.test(v.errs), 'the real cause is named');
  ok(!/Corrupt on arrival/.test(v.errs), 'and it is not grouped as corruption');
  ok(/could not be read back and checked/.test(v.errs),
     'a verify-phase drive error says the files WERE copied');
}

console.log('\nthirty corrupt files are one line, not thirty');
{
  const files = Array.from({length:30},(_,i)=>'A'+i+'.MOV');
  const v = show([card({ success:false, errors:30, failedFiles:files,
    errorList: files.map(f=>({ file:f, error:'xxHash mismatch', phase:'verify', origin:'destination' })) })]);
  ok((v.errs.match(/class="fg"/g)||[]).length === 1, 'one cause block');
  ok(/30 files</.test(v.errs), 'carrying the count');
  ok((v.errs.match(/class="fg-file"/g)||[]).length === 30, 'and all thirty names inside it');
}
console.log('\nsystem codes are translated, and kept');
{
  const v = show([card({ success:false, errors:1, failedFiles:['A.MOV'],
    errorList:[{ file:'A.MOV', error:"ENOSPC: no space left on device, write", phase:'copy',
                 origin:'destination' }] })]);
  ok(/The drive ran out of space/.test(v.errs), 'ENOSPC is said in words');
  ok(/class="fg-code">ENOSPC</.test(v.errs), 'and the raw code is kept, small, for a bug report');
}
console.log('\nan empty card is a misunderstanding, not a failure');
{
  const v = show([card({ success:false, errors:1, totalFiles:0, copiedFiles:0,
                         emptyReason:'no-files', seenFiles:0 })]);
  ok(v.title === 'THERE WAS NOTHING ON THIS CARD', 'the title says what happened');
  ok(!/t-bad/.test(v.tclass), 'and it is not red');
  ok(v.lead === 'Nothing was copied, and nothing was lost.', 'the constant line reassures');
}
console.log('\nthe filter excluding everything is its own message');
{
  const v = show([card({ success:false, errors:1, totalFiles:0, copiedFiles:0,
                         emptyReason:'filtered-out', seenFiles:186 })]);
  ok(v.title === 'THE FILE FILTER EXCLUDED ALL 186 FILES',
     'a different cause gets a different instruction ("' + v.title + '")');
}

console.log('\nan empty card in a batch must not speak for the other cards');
{
  // Found by adversarial review, twice, independently. An empty card sets
  // errors:1 in the engine, and the guard accepted "every other card with at
  // most one error", so a batch that LOST A FILE was headlined
  // "THERE WAS NOTHING ON THIS CARD / Nothing was copied, and nothing was lost."
  const v = show([
    card({ sourceName:'A001', sourcePath:'/Volumes/A', success:false, errors:1,
           failedFiles:['A001C012.MOV'],
           errorList:[{ file:'A001C012.MOV', error:'EIO: i/o error, read', phase:'copy',
                        origin:'destination' }] }),
    card({ sourceName:'B002', sourcePath:'/Volumes/B', success:false, errors:1,
           totalFiles:0, copiedFiles:0, emptyReason:'no-files', seenFiles:0 }),
  ]);
  ok(!/NOTHING/.test(v.title), 'the empty card does not headline the batch ("' + v.title + '")');
  ok(v.lead !== 'Nothing was copied, and nothing was lost.',
     'and the window never says nothing was lost over a run that lost a file');
  ok(/Do not format this card/.test(v.lead), 'the instruction that matters is there');
}
{
  // The same guard also swallowed a REFUSED card, which also carries errors:1.
  const v = show([
    card({ sourceName:'A001', sourcePath:'/Volumes/A' }),
    card({ sourceName:'B002', sourcePath:'/Volumes/B', success:false, errors:1, refused:true,
           refusalCode:'PF-E9', totalFiles:0, copiedFiles:0,
           errorList:[{ file:'(pre-flight)', phase:'setup', refused:true,
                        error:'The folder "012_B002" already exists on "SHUTTLE_1" and is not empty.' }] }),
  ]);
  ok(/NOT\u00a0STARTED|NOT STARTED/.test(v.title),
     'a refused card is reported as refused, not as lost files ("' + v.title + '")');
  ok(!/DID NOT.*SURVIVE/.test(v.title), 'no invented data loss');
}
{
  // And when a refusal does reach the failure block, its explanation must be
  // in it: filtering every "(...)" file name deleted the only reason there was.
  const v = show([
    card({ sourceName:'A001', sourcePath:'/Volumes/A', success:false, errors:2,
           failedFiles:['X.MOV'],
           errorList:[{ file:'X.MOV', error:'xxHash mismatch', phase:'verify', origin:'destination' }] }),
    card({ sourceName:'B002', sourcePath:'/Volumes/B', success:false, errors:1, refused:true,
           refusalCode:'PF-E9', totalFiles:0, copiedFiles:0,
           errorList:[{ file:'(pre-flight)', phase:'setup', refused:true,
                        error:'The folder already exists and is not empty.' }] }),
  ]);
  ok(/B002 was not started/.test(v.errs), 'the refused card is named in the block');
  ok(/already exists/.test(v.errs), 'with the reason the engine gave');
}

console.log('\na run that produced no result at all');
{
  const v = show([]);
  ok(v.title === 'THE INGEST DID NOT RUN', 'not "0 FILES DID NOT SURVIVE THE COPY TO 0 DRIVES"');
}

console.log('\nthe reassuring panel never sits under a failure');
{
  const v = show([card({ success:false, errors:3, failedFiles:['A','B','C'],
    doubleReadCached:true, mode:'pro', proDoubleRead:true,
    errorList:[{file:'A',error:'xxHash mismatch',phase:'verify',origin:'destination'}] })]);
  ok(!/Your footage is fine/.test(v.cold||''),
     '"Your footage is fine" must not appear six lines under "3 FILES DID NOT SURVIVE"');
}

console.log('\na refused card next to an empty card invents nothing');
{
  // Second review: the empty branch needed every entry to be empty, the
  // refused branch needed every entry to be refused-or-clean, and `bad`
  // excluded refused but not empty. {refused, empty} fell through to
  // "1 FILE DID NOT SURVIVE THE COPY TO SHUTTLE_1".
  const v = show([
    card({ sourceName:'A001', sourcePath:'/Volumes/A', success:false, errors:1, refused:true,
           refusalCode:'PF-E9', totalFiles:0, copiedFiles:0,
           errorList:[{ file:'(pre-flight)', phase:'setup', refused:true, error:'exists' }] }),
    card({ sourceName:'B002', sourcePath:'/Volumes/B', success:false, errors:1,
           totalFiles:0, copiedFiles:0, emptyReason:'no-files', seenFiles:0 }),
  ]);
  ok(!/DID NOT.*SURVIVE/.test(v.title), 'no lost file is invented ("' + v.title + '")');
  ok(/NOTHING WAS COPIED/.test(v.title), 'and it says plainly that nothing was copied');
}

console.log('\nthe window still refuses to call a bad run good');
{
  // "FINISHED WITH ERRORS" is gone: it never said whether to throw away the
  // drive or the card, and those are opposite conclusions.
  const a = show([card({ success:false, errors:3, failedFiles:['A.MOV','B.MOV','C.MOV'],
                         destPath:'/Volumes/NAS_BACKUP/001_A001',
                         errorList:[{file:'A.MOV',error:'xxHash mismatch',phase:'verify',origin:'destination'}] })]);
  ok(a.title === '3 FILES DID NOT\u00a0SURVIVE THE COPY TO NAS_BACKUP'.replace(/\u00a0/g,' '),
     'the title names the drive, not the error count ("' + a.title + '")');
  ok(/t-bad/.test(a.tclass), 'and it is red');
  ok(a.lead === 'Do not format this card.',
     'the constant line is the only instruction that matters');
  ok(a.errsShown && /Corrupt on arrival/.test(a.errs), 'the cause is named, once');
  const b = show([card(), card({ sourceName:'B002', canceled:true, copiedFiles:1 })]);
  ok(b.title === 'TRANSFER STOPPED' && /t-warn/.test(b.tclass),
     'one stopped card out of two stops the whole run');
  ok(b.S._clearSrcOnClose === false, 'and the sources are NOT cleared behind it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
