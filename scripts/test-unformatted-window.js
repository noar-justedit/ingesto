#!/usr/bin/env node
// The window that opens when a card INGESTO has already ingested is re-inserted
// without having been formatted. It is a decision window, not a report: the
// operator has to choose between copying only the new files and copying the
// whole card, and the numbers on it are what that choice is made on.
//
// Two things it must never do:
//   - let "62 new files" read as a guarantee. A file is passed over only when
//     EVERY selected destination already holds a verified copy of it. Without
//     that sentence, a card ingested yesterday to drive A and re-inserted today
//     with a fresh drive B put 2 clips out of 14 on that drive under a
//     "Transfer Complete". The caveat under the buttons is load-bearing.
//   - open on 640 px of file list nobody reads before deciding.
//
//   node scripts/test-unformatted-window.js
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
const made = [];
function makeEl(id) {
  const el = { id: id||'', innerHTML:'', textContent:'', style:{ cssText:'' }, onclick:null,
               _cl:new Set(),
               classList:{ add:c=>el._cl.add(c), remove:c=>el._cl.delete(c),
                           toggle:(c,v)=>{ v?el._cl.add(c):el._cl.delete(c); },
                           contains:c=>el._cl.has(c) },
               remove(){}, appendChild(){} };
  return el;
}
let ovEl = null;
const ctx = vm.createContext({
  console,
  document: {
    createElement: () => (ovEl = makeEl()),
    getElementById: (id) => { const e = makeEl(id); made.push(e); return e; },
    body: { appendChild: () => {} },
  },
  S: {},
  showToast: () => {},
  removeFromZone: () => {},
  navigator: { clipboard: { writeText: async () => {} } },
});
vm.runInContext([extractFn(REND, 'esc'), extractFn(REND, 'showUnformattedCardDialog')].join('\n'), ctx);

const files = (n) => Array.from({length:n}, (_,i) =>
  ({ p: '/DCIM/100MSDCF/A001C' + String(i+1).padStart(3,'0') + '.MP4', s: 340*1024*1024 }));

const open = (total, oldCount, over) => {
  ovEl = null; ctx.S = {};
  ctx.showUnformattedCardDialog(
    { name:'A001_LUMIX', path:'/Volumes/A001_LUMIX' },
    Object.assign({
      counts: { total, alreadyIngested: oldCount },
      lastIngest: { date: Date.now()-86400000,
                    destination: '/Volumes/SHUTTLE_1/2026-09-08/001_A001_LUMIX' },
      alreadyIngestedPreview: files(oldCount),
    }, over));
  return ovEl.innerHTML;
};
const tile = (html, label) => {
  const m = new RegExp('<div class="sr-lbl">' + label + '</div>\\s*<div class="sr-val"[^>]*>([^<]*)<')
              .exec(html);
  return m ? m[1].trim() : null;
};

console.log('\n248 files on the card, 186 of them already ingested');
{
  const h = open(248, 186);
  ok(/CARD HAS NOT BEEN&nbsp;FORMATTED/.test(h), 'the title names the situation, not the app');
  ok(tile(h,'Total on card') === '248', 'total on card: ' + tile(h,'Total on card'));
  ok(tile(h,'Already ingested') === '186', 'already ingested: ' + tile(h,'Already ingested'));
  // The number the operator is actually after, and it is computed, not read.
  ok(tile(h,'New files') === '62', 'new files is the subtraction: ' + tile(h,'New files'));
  ok(/New files<\/div>\s*<div class="sr-val" style="color:var\(--green\)"/.test(h),
     'green next to orange, the same code as the ingest queue');
  ok(/Already ingested<\/div>\s*<div class="sr-val" style="color:var\(--orange\)"/.test(h),
     'orange means passed over');
  ok(tile(h,'Card') === 'A001_LUMIX', 'the card is named');
  ok(/Last ingest/.test(h), 'and the date of the previous ingest is there');
}

console.log('\nthe caveat under the buttons');
{
  const h = open(248, 186);
  ok(/A file is skipped only when every destination you selected\s+already holds a verified copy of&nbsp;it\./.test(h),
     'it is there, word for word');
  // Present in the markup is not the same as on screen: the whole point is
  // that the operator reads it before pressing a button.
  ok(/<div class="ufc-caveat">A file is skipped only/.test(h),
     'and it is visible, not hidden behind an attribute or a display:none');
  const iBtn = h.indexOf('COPY NEW FILES'), iCav = h.indexOf('A file is skipped only');
  ok(iCav > iBtn, 'and it sits under the buttons, where the decision is made');
}

console.log('\nDETAILS is folded, and it holds what nobody reads before deciding');
{
  const h = open(248, 186);
  ok(/id="ufc-full" style="display:none"/.test(h), 'the list starts folded');
  ok(/onclick="ufcToggleAll\(\)"/.test(h), 'the DETAILS row unfolds it');
  ok(/186 already ingested<\/span>/.test(h), 'and says how many are in there while folded');
  ok(/Previous destination/.test(h), 'the previous destination moved inside it');
  ok(h.indexOf('Previous destination') > h.indexOf('id="ufc-full"'),
     'inside, not on the front of the window');
  ok((h.match(/class="ufc-fitem"/g)||[]).length === 186, 'the whole list is in there, not the first five');
  ok(/id="ufc-copy"/.test(h), 'with a COPY LIST button, for people who want it in a text editor');
}

console.log('\nthe three choices');
{
  const h = open(248, 186);
  for (const b of ['COPY NEW FILES','COPY FULL CARD','CANCEL'])
    ok(h.includes(b), `"${b}" is offered`);
  ok(/id="ufc-skip"/.test(h) && /id="ufc-all"/.test(h) && /id="ufc-cancel"/.test(h),
     'and each one is wired');
}

console.log('\na card whose list could not be read back');
{
  const h = open(248, 186, { alreadyIngestedPreview: [] });
  ok(/could not be read back from the card/.test(h),
     'says so, instead of showing an empty box');
  ok(tile(h,'New files') === '62', 'and the counts still come from the card, not from the list');
}

console.log('\nevery file on the card is new');
{
  const h = open(64, 0);
  ok(tile(h,'New files') === '64' && tile(h,'Already ingested') === '0',
     'nothing to pass over');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
