#!/usr/bin/env node
// Thirty things can stop an ingest before it starts. Until 2.6.3 they all
// arrived as the same red box with a "Got it" button: the operator was told
// what was wrong and left with nothing to press. Some arrived as a toast at the
// bottom of the screen, and two arrived as nothing at all.
//
// This suite pins the shape they now share:
//   - the title says what WOULD happen, in two hand-broken lines
//   - a constant line, never negotiated: on a refusal, nothing has been written
//   - the cause and the instruction are separate paragraphs
//   - every window offers at least one button that DOES something
//
//   node scripts/test-refusal-window.js
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
  const m = src.match(new RegExp(`^const ${name} = \\{[\\s\\S]*?\\n\\};`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── DOM ─────────────────────────────────────────────────────────────────────
let lastOv = null;
function makeEl() {
  const el = { className:'', innerHTML:'', id:'', style:{ cssText:'' }, onclick:null,
               _btns:[],
               querySelectorAll(sel){ return sel === '.pf-btn' ? el._btns : []; },
               remove(){} };
  return el;
}
const ctx = vm.createContext({
  console,
  document: { createElement: () => (lastOv = makeEl()), body: { appendChild: () => {} },
              getElementById: () => null },
  Promise, setTimeout,
});
vm.runInContext([
  extractFn(REND, 'esc'),
  extractConst(REND, 'PF_ICO'),
  extractFn(REND, 'showRefusal'),
].join('\n'), ctx);

// showRefusal renders, then waits for a click. The suite only reads what was
// rendered, so the promise is left hanging on purpose.
const render = (spec) => { lastOv = null; ctx.showRefusal(spec); return lastOv.innerHTML; };

console.log('\nthe shape every refusal shares');
{
  const h = render({ kind:'block', code:'PF-R1', lead:'Nothing has been written.',
    title:['This card would be written','into the destination root'],
    cause:'because of X.', action:'Do Y.',
    buttons:[{ label:'EDIT TEMPLATE', value:'edit', style:'fix' },
             { label:'CANCEL', value:'cancel', style:'ghost' }] });
  ok(/pf-card pf-block/.test(h), 'a refusal is red');
  ok(/This card would be written<br>into the destination root/.test(h),
     'the title is broken by hand into two lines');
  ok(/class="pf-lead ok">Nothing has been written\./.test(h),
     'the constant line is there, and it is green');
  ok(/class="pf-cause">because of X\./.test(h) && /class="pf-act">Do Y\./.test(h),
     'cause and instruction are separate blocks, so the eye can skip one');
  ok(h.indexOf('pf-cause') < h.indexOf('pf-act'), 'cause first, instruction second');
  ok((h.match(/<button class="pf-btn/g)||[]).length === 2, 'two buttons');
  ok((h.match(/pf-btn fix/g)||[]).length === 1, 'exactly one accented button: the one that fixes it');
}

console.log('\na warning is not a refusal, and it must not look like one');
{
  const h = render({ kind:'warn', lead:'Nothing has been written yet.', leadKind:'warn',
    title:['SHUTTLE_1 has less free space','than this ingest needs'],
    cause:'It needs more room.', action:'Free some space.',
    buttons:[{ label:'CONTINUE ANYWAY', value:'go', style:'go' },
             { label:'CANCEL', value:'cancel', style:'ghost' }] });
  ok(/pf-card pf-warn/.test(h), 'it is orange');
  ok(/class="pf-lead warn">Nothing has been written yet\./.test(h),
     'the constant line gains its "yet"');
  ok(/pf-btn go/.test(h), 'and the button that goes ahead owns the decision, in orange');
  ok(!/pf-btn fix/.test(h), 'there is nothing to fix here');
}

console.log('\na busy state is blue, and never claims nothing was written');
{
  const h = render({ kind:'busy', lead:'Your ingest is not affected.', leadKind:'info',
    title:['This card was not','added'],
    cause:'An ingest is running.', action:'Load it when the current ingest is done.',
    buttons:[{ label:'GOT IT', value:'ok' }] });
  ok(/pf-card pf-busy/.test(h), 'it is blue');
  ok(/class="pf-lead info"/.test(h), 'and its constant line is of another nature');
  ok(!/Nothing has been written/.test(h),
     'writing is exactly what is happening: saying otherwise would be worse than saying nothing');
}

console.log('\na window with no buttons declared still offers one');
{
  const h = render({ kind:'block', title:['Something'], cause:'x', action:'y' });
  ok((h.match(/<button class="pf-btn/g)||[]).length === 1, 'never a window you cannot close');
}

console.log('\nthe card name is escaped, not interpolated');
{
  const h = render({ kind:'block', title:['<img src=x onerror=alert(1)>'], cause:'x', action:'y' });
  ok(!/<img/.test(h), 'a card label is attacker-controlled text, and it is escaped');
  ok(/&lt;img/.test(h), 'shown as text');
}

// ── The nine engine refusals ───────────────────────────────────────────────
// The engine refuses in nine situations. The interface refuses in the same nine.
// The operator must not be told two different things depending on which side
// noticed first.
console.log('\nthe nine engine refusals all produce a window, and it acts');
{
  const shown = [];
  const ctx2 = vm.createContext({
    console, esc: ctx.esc,
    showRefusal: (spec) => { shown.push(spec); return Promise.resolve('cancel'); },
    pfEditTemplate(){}, pfChangeCounter(){}, pfOpenFilter(){},
    removeFromZone(){}, revealPath(){},
  });
  vm.runInContext([extractFn(REND, 'showEngineRefusal'),
                   extractFn(REND, 'showOneEngineRefusal')].join('\n'), ctx2);
  const CODES = ['PF-E1','PF-E2','PF-E3','PF-E4','PF-E5','PF-E6','PF-E7','PF-E8','PF-E9'];
  for (const code of CODES) {
    shown.length = 0;
    ctx2.showEngineRefusal([{ refused:true, refusalCode:code, sourceName:'A001_LUMIX',
      errorList:[{ file:'(pre-flight)', error:'refused', phase:'setup' }],
      refusalData:{ card:'A001_LUMIX', dest:'SHUTTLE_1', destPath:'/Volumes/SHUTTLE_1',
                    seg:'..', levels:5, limit:4, shared:'DAY1', folder:'012_A001',
                    absPath:'/Volumes/SHUTTLE_1/012_A001' } }]);
    const s = shown[0];
    ok(!!s, `${code} opens a window`);
    if (!s) continue;
    ok(s.lead === 'Nothing has been written.', `${code} says nothing was written`);
    ok(Array.isArray(s.title) && s.title.length === 2 && s.title.every(t=>t && t.length<=42),
       `${code} has a two-line title, neither line too long (${JSON.stringify(s.title)})`);
    ok(!!s.cause && !!s.action, `${code} separates cause from instruction`);
    ok((s.buttons||[]).some(b=>b.style==='fix' || b.act),
       `${code} offers a button that does something`);
    ok((s.buttons||[]).some(b=>b.value==='cancel'), `${code} can be dismissed`);
  }
  // An unknown code must still refuse, never fall through to a summary.
  shown.length = 0;
  ctx2.showEngineRefusal([{ refused:true, refusalCode:'PF-E99', sourceName:'A001',
    errorList:[{ file:'(pre-flight)', error:'something new', phase:'setup' }], refusalData:{} }]);
  ok(shown.length === 1 && shown[0].lead === 'Nothing has been written.',
     'an unrecognised refusal still says the one thing that matters');
  ok(/something new/.test(shown[0].cause || ''), 'and passes the engine wording through');

  // The same refusal on two destinations of one card is still ONE window.
  shown.length = 0;
  ctx2.showEngineRefusal([
    { refused:true, refusalCode:'PF-E9', sourceName:'A001', refusalData:{}, errorList:[{error:'x'}] },
    { refused:true, refusalCode:'PF-E9', sourceName:'A001', refusalData:{}, errorList:[{error:'x'}] },
  ]);
  ok(shown.length === 1, 'the same refusal on two destinations is one window');

  // A batch refused for two different reasons used to show one window and drop
  // the other without a word. They are opened in turn, so the second appears
  // only after the first resolves: the check has to wait for that.
  (async () => {
    shown.length = 0;
    ctx2.showEngineRefusal([
      { refused:true, refusalCode:'PF-E9', sourceName:'A001',
        refusalData:{ card:'A001', dest:'SHUTTLE_1', folder:'012_A001' },
        errorList:[{ error:'exists' }] },
      { refused:true, refusalCode:'PF-E1', sourceName:'B002',
        refusalData:{ card:'B002', dest:'SHUTTLE_1' }, errorList:[{ error:'empty name' }] },
    ]);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    ok(shown.length === 2, 'two different refusals produce two windows, in turn');
    ok(shown[0] && shown[1] && shown[0].code === 'PF-E9' && shown[1].code === 'PF-E1',
       'each with its own text');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
