#!/usr/bin/env node
// The Verify result window says three different things, and until 2.6.3 it only
// knew two. A folder holding a file the manifest does not list got the SAME red
// cross as a folder holding a corrupted copy, under a title that never said the
// verification itself had gone fine.
//
// It mattered because INGESTO's own files were among those "unknown" files: the
// shooting note (and, through a separate bug, the whole ascmhl folder) came back
// flagged, and users read a red cross as a checksum failure on their rushes.
//
// This suite runs the real showVerifyResult() from index.html against a fake DOM
// and pins the three states down: green when everything is covered and matches,
// amber when what is listed matches but the folder holds something else, red
// when a file is corrupted, missing, or has no good copy.
//
//   node scripts/test-verify-window.js
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
// Every node the function touches, and nothing else. classList is a real set,
// so "did the overlay open" is a fact and not a string match.
function makeEl() {
  return { className: '', innerHTML: '', textContent: '',
           _cl: new Set(),
           get classList() { const s = this._cl; return { add: c => s.add(c), remove: c => s.delete(c),
                                                         contains: c => s.has(c) }; } };
}
const els = {};
for (const id of ['vf-r-ico','vf-r-grid','vf-r-lists','vf-r-title','vf-r-sub','verify-result-ov'])
  els[id] = makeEl();
const ctx = vm.createContext({
  document: { getElementById: id => els[id] || makeEl() },
  console,
  esc: s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
});
vm.runInContext(extractFn(REND, 'showVerifyResult'), ctx);

const R = (over) => Object.assign({
  ok: true, canceled: false, algo: 'xxh64', manifestFile: '001_A001.xxh',
  total: 2, matched: 2, corrupted: [], missing: [], extra: [], quarantined: [],
}, over);
const show = (res) => { for (const id in els) { els[id].className=''; els[id].innerHTML='';
                                               els[id].textContent=''; els[id]._cl.clear(); }
                        ctx.showVerifyResult(res, '/Volumes/SHUTTLE_1/001_A001');
                        return { title: els['vf-r-title'].textContent,
                                 tclass: els['vf-r-title'].className,
                                 icls: els['vf-r-ico'].className,
                                 ico: els['vf-r-ico'].innerHTML,
                                 lists: els['vf-r-lists'].innerHTML,
                                 sub: els['vf-r-sub'].textContent,
                                 open: els['verify-result-ov'].classList.contains('open') }; };

console.log('\neverything listed, everything matches');
{
  const v = show(R());
  ok(v.title === 'ALL FILES VERIFIED', 'the title states the result, not the act ("' + v.title + '")');
  ok(/vf-g/.test(v.tclass), 'the title is green');
  ok(/sum-ico ok/.test(v.icls), 'the icon is the green one');
  ok(/m9 11 3 3L22 4/.test(v.ico), 'and it is the tick drawing');
  ok(!/not in the manifest/.test(v.lists), 'nothing is listed as unknown');
  ok(/INGESTO's own files/.test(v.lists),
     "the grey line explains what was deliberately not checked");
  ok(v.sub === '001_A001', 'the folder is named under the title');
  ok(v.open === true, 'and the window opens');
}

console.log('\nlisted files all match, but the folder holds something else');
{
  const v = show(R({ extra: ['A001C003.MOV'] }));
  ok(v.title === 'ALL LISTED FILES VERIFIED',
     'the title says the verification itself went fine ("' + v.title + '")');
  ok(/vf-o/.test(v.tclass), 'the title is orange, not red');
  ok(!/sum-ico err/.test(v.icls), 'the icon is NOT the red cross of a failure');
  // The class carries the colour, the drawing carries the shape: assert both,
  // or a red cross tinted orange passes as a warning.
  ok(!/m15 9-6 6/.test(v.ico), 'and it is not the cross drawing either');
  ok(/M12 9v4/.test(v.ico), 'it is the warning triangle');
  ok(/1 file in this folder is not in the manifest/.test(v.lists),
     'the block counts them in plain words, singular');
  ok(/Every file the manifest lists was checked and matches/.test(v.lists),
     'and it opens on what is NOT affected');
  ok(!/nothing vouches/.test(v.lists), 'the accusing wording is gone');
  ok(/A001C003\.MOV/.test(v.lists), 'the file is named');
}

console.log('\nplural, because a message that says "1 files" is a message nobody wrote');
{
  const v = show(R({ extra: ['A.MOV', 'LUT.cube'] }));
  ok(/2 files in this folder are not in the manifest/.test(v.lists), 'header agrees in number');
  ok(/These were added after the ingest/.test(v.lists), 'so does the sentence under it');
  ok(/If one of them is footage/.test(v.lists), 'and the instruction');
}

console.log('\na corrupted file is still a failure');
{
  const v = show(R({ matched: 1, corrupted: ['A001C002.MOV'] }));
  ok(v.title === 'VERIFICATION FAILED', 'the title is unambiguous');
  ok(/vf-r/.test(v.tclass) && /sum-ico err/.test(v.icls), 'red title, red icon');
  ok(/hash mismatch/.test(v.lists), 'and the file is named with its reason');
}
console.log('\nso is a missing one, and a file with no good copy');
{
  const a = show(R({ matched: 1, missing: ['A001C002.MOV'] }));
  ok(a.title === 'VERIFICATION FAILED' && /sum-ico err/.test(a.icls), 'missing file: red');
  const b = show(R({ quarantined: ['A001C002.MOV.ingesto-failed'] }));
  ok(b.title === 'VERIFICATION FAILED' && /sum-ico err/.test(b.icls), 'quarantined copy: red');
  ok(/missing a good copy of/.test(b.lists), 'and it is named as such');
}

console.log('\na cancelled verification claims nothing');
{
  const v = show(R({ canceled: true, matched: 1 }));
  ok(v.title === 'VERIFICATION STOPPED', 'it is its own state, not a failure ("' + v.title + '")');
  ok(!/sum-ico err/.test(v.icls), 'and it does not wear the failure icon');
}

console.log('\na manifest that lists nothing verified nothing');
{
  // Second review: the empty case only rewrote the TEXT; the state stayed
  // green, so the window wore the tick over a folder nothing had been checked
  // in.
  const v = show(R({ total:0, matched:0 }));
  ok(v.title === 'THIS MANIFEST LISTS NOTHING', 'the title says so');
  ok(!/sum-ico ok/.test(v.icls), 'and it does not wear the green tick');
  ok(!/m9 11 3 3L22 4/.test(v.ico), 'nor the tick drawing');
}
{
  const v = show(R({ total:0, matched:0, extra:['A.MOV'] }));
  ok(v.title !== 'ALL LISTED FILES VERIFIED',
     'nor does it claim files were verified when none were listed ("' + v.title + '")');
}

console.log('\na folder that was never ingested with a manifest');
{
  const v = show({ ok: false, reason: 'no-manifest' });
  ok(v.title === 'NOTHING TO VERIFY HERE', 'the title describes the folder, not a failure');
  ok(!/sum-ico err/.test(v.icls), 'no red cross: nothing failed here either');
  ok(/Nothing is wrong with the folder/.test(v.lists), 'and the text says so outright');
  ok(v.open === true, 'the window still opens');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
