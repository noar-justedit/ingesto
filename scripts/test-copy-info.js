// Copy Info 2.8.0: notes in markdown, the Profile menu, the operators of the
// session. Runs without Electron and without a browser: the functions are
// taken from index.html and run in a vm, the formatted view is read through a
// small DOM stand-in built below.
//
//   node scripts/test-copy-info.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const REND = require('./lib/source').RENDERER;

function extractFn(name) {
  let start = REND.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = REND.indexOf('{', start), depth = 0;
  for (; i < REND.length; i++) {
    if (REND[i] === '{') depth++;
    else if (REND[i] === '}') { depth--; if (depth === 0) return REND.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── A DOM stand-in, just enough for htmlToMd(): elements, text nodes, classes.
// It parses the HTML that mdToHtml() produces and the HTML Chromium leaves in
// a contenteditable (text and <b> side by side, <div>, <br>).
function parse(html) {
  const mk = (tag, cls) => ({ nodeType: 1, tagName: tag, nodeName: tag, childNodes: [], cls: cls || [],
    classList: { contains(c) { return this.el.cls.includes(c); } },
    querySelectorAll(sel) { if (sel !== ':scope > li') throw new Error('selector ' + sel);
                            return this.childNodes.filter(n => n.tagName === 'LI'); },
    querySelector(sel) { const want = sel.split(',').map(s => s.trim().toUpperCase());
      const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 1 && want.includes(c.tagName)) return c; const r = c.nodeType === 1 && walk(c); if (r) return r; } return null; };
      return walk(this); } });
  const root = mk('DIV'); root.classList.el = root;
  const stack = [root];
  const ent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g; let m;
  const add = n => { const p = stack[stack.length - 1]; n.previousSibling = p.childNodes[p.childNodes.length - 1] || null; p.childNodes.push(n); };
  while ((m = re.exec(html))) {
    if (m[4] != null) { add({ nodeType: 3, nodeName: '#text', nodeValue: ent(m[4]) }); continue; }
    const tag = m[2].toUpperCase();
    if (m[1]) { while (stack.length > 1 && stack.pop().tagName !== tag); continue; }
    const cm = m[3].match(/class="([^"]*)"/);
    const el = mk(tag, cm ? cm[1].split(/\s+/) : []); el.classList.el = el;
    add(el);
    if (tag !== 'BR') stack.push(el);
  }
  return root;
}

const ctx = vm.createContext({ String, Object, Number, Array, RegExp, console });
vm.runInContext(['mdEscape', 'mdInline', 'mdToHtml', 'mdInlineOf', 'htmlToMd'].map(extractFn).join('\n'), ctx);
const md2html = s => ctx.mdToHtml(s);
const html2md = h => ctx.htmlToMd(parse(h));

console.log('\nmarkdown -> formatted -> markdown gives the note back');
{
  const cases = [
    'plain text',
    '**bold** and *italic* and <u>underlined</u> and ~~struck~~',
    '### Salle B\n**Interviews** du matin, *35 mm*',
    '- one\n- two',
    '1. first\n2. second',
    '- [x] Son HF vérifié\n- [ ] Doubler la carte B',
    '### Day 2\n\nfirst line\nsecond line\n- [ ] to do\n- bullet',
  ];
  for (const md of cases) {
    const back = html2md(md2html(md));
    ok(back === md, `${JSON.stringify(md)} ${back === md ? '' : '-> ' + JSON.stringify(back)}`);
  }
}

console.log('\nwhat the formatted view sends back is markdown');
{
  // What Chromium really leaves in the editor, typed by hand.
  ok(html2md('Salle B <b>Interviews</b>') === 'Salle B **Interviews**',
     'text then Cmd+B in an empty field: ONE line, the bold kept');
  ok(html2md('<p>a <i>b</i> <u>c</u> <s>d</s></p>') === 'a *b* <u>c</u> ~~d~~', 'each mark has its markdown');
  ok(html2md('<p><b>bold </b>next</p>') === '**bold** next', 'a mark never swallows the space after it');
  ok(html2md('<div>one</div><div>two</div>') === 'one\ntwo', 'a <div> per line, as Chromium writes them');
  ok(html2md('one<br>two') === 'one\ntwo', 'a line break is a new line');
  ok(html2md('<ul class="task"><li class="done">x</li><li>y</li></ul>') === '- [x] x\n- [ ] y', 'a ticked box is [x]');
  ok(html2md('<ol><li>a</li><li>b</li></ol>') === '1. a\n2. b', 'numbered items are renumbered from 1');
  ok(html2md('<h3>T</h3>') === '### T', 'a heading is ###');
  ok(html2md('') === '', 'an empty field is an empty note');
}

console.log('\nnothing typed in a note can become a tag');
{
  // The note reaches the history of the app and the HTML report on the drive.
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '**<b onclick=x>a</b>**',
    '<u onmouseover=alert(1)>x</u>',
    '- [ ] <iframe src=javascript:alert(1)>',
    '"><svg onload=alert(1)>',
  ];
  for (const e of evil) {
    const h = md2html(e);
    const tags = [...h.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)];
    const allowed = tags.every(t => /^(p|br|b|i|u|s|h3|ul|ol|li)$/i.test(t[1]) && (t[2] === '' || /^ class="(task|done)"$/.test(t[2])));
    ok(allowed, `${JSON.stringify(e)} -> only the editor's own tags, no attribute but its class`);
  }
  ok(md2html('a & b < c').includes('a &amp; b &lt; c'), 'and & and < stay text');
}

console.log('\nthe operators of the session');
{
  const S = { sessionOps: [] };
  const c = vm.createContext({ S, String, Array, Math });
  vm.runInContext(REND.match(/^const SESSION_OPS_MAX = .*;$/m)[0].replace('const', 'var') + '\n' + extractFn('rememberOperators'), c);
  c.rememberOperators(['NOAR']); c.rememberOperators(['MARC', 'LEA']);
  ok(S.sessionOps.join() === 'LEA,MARC,NOAR', 'most recent first');
  c.rememberOperators(['noar']);
  ok(S.sessionOps.join() === 'noar,LEA,MARC', 'a name used again moves to the top, once, whatever its case');
  c.rememberOperators(['', '  ', null, undefined]);
  ok(S.sessionOps.length === 3, 'an empty operator is not a name');
  c.rememberOperators(Array.from({ length: 50 }, (_, k) => 'OP' + k));
  ok(S.sessionOps.length === 30 && S.sessionOps[0] === 'OP49', 'the list is capped, the newest kept');

  // Kept in memory only: the list is empty again at every launch.
  const save = extractFn('persistPrefsNow');
  ok(!/sessionOps/.test(save), 'the list is never written to the preferences');
  ok(/sessionOps:\[\],/.test(REND), 'and the app starts with an empty one');
  // Filled at START, from what the run really uses.
  const start = REND.indexOf('async function startCopy(');
  const body = REND.slice(start, REND.indexOf('\nasync function ', start + 10));
  ok(/rememberOperators\(S\.run\.sources\.map\(x => x\.operator\)\)/.test(body),
     'START adds the operators of the run, kiosk included (it goes through startCopy)');
  ok(body.indexOf('rememberOperators(') > body.indexOf('S.run = {'),
     'after the run is frozen, not before a refusal');
}

console.log('\nthe three places a card is described all have the new fields');
{
  const grab = (id, n) => REND.slice(REND.indexOf(`id="${id}"`), REND.indexOf(`id="${id}"`) + (n || 260));
  ok(/data-opcb/.test(grab('meta-cam')) && /data-opcb/.test(grab('k-op')), 'Operator offers the session list in Copy Info and in kiosk');
  ok(/OPERATOR<\/div>\s*<input class="sif-input"[^>]*data-opcb/.test(REND), 'and on each loaded card');
  ok(/data-mdn\b/.test(grab('meta-note')) && /data-mdn\b/.test(grab('k-note')), 'Notes is the markdown editor in Copy Info and in kiosk');
  ok(/<textarea class="sif-textarea" data-mdn\b/.test(REND), 'and on each loaded card');
  ok(/<div class="row3">\s*<div class="mf"><div class="mf-label">Operator<\/div>/.test(REND), 'Operator, Camera and Profile share one row in Copy Info');
  ok(/class="sif-grid row3"/.test(REND), 'on each card');
  ok(/<div class="row3">\s*<div class="k-field">\s*<div class="k-lbl">Operator/.test(REND), 'and in kiosk');
  ok(/fieldsInit\(list\);\s*updatePreview\(\);/.test(REND), 'the card fields are built again each time the cards are drawn');
  const boot = REND.indexOf("fieldsInit(document)"), prefs = REND.indexOf('const prefs=(await window.ingesto.loadPrefs())');
  ok(boot > 0 && boot < prefs, 'and the page fields before the saved values are written into them');
}

console.log('\nduring an ingest the new controls are locked too');
{
  const els = { ed: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } };
  const root = { matches: () => false, querySelectorAll(sel) {
    if (sel === '[data-mdn-ed]') return [els.ed];
    return []; } };
  const c = vm.createContext({ document: { body: { classList: { contains: () => true } }, querySelectorAll: () => [root] } });
  vm.runInContext(extractFn('applyIngestLock'), c);
  c.applyIngestLock();
  ok(els.ed.attrs.contenteditable === 'false', 'the formatted notes view stops being editable');
  c.document.body.classList.contains = () => false; c.applyIngestLock();
  ok(els.ed.attrs.contenteditable === 'true', 'and becomes editable again after');
  ok(/new MutationObserver\(\(\) => \{ b\.disabled = input\.disabled; \}\)/.test(REND),
     'the Profile button follows its field when the lock disables it');
  ok(/new MutationObserver\(\(\) => \{ a\.disabled = input\.disabled; \}\)/.test(REND),
     'so does the arrow of the operator list');
}

console.log('\nthe note mode is remembered without an early save');
{
  // Saved and read back by the SETTINGS table (checked in test-settings.js).
  ok(/\{ key:'noteMode', cat:null, valid: v => v === 'md' \|\| v === 'rich' \}/.test(REND), 'the mode is saved with the preferences');
  const at = REND.indexOf("if(S.noteMode==='md') document.querySelectorAll('.mdn').forEach(mdnApplyMode);");
  const load = at < 0 ? '' : REND.slice(at, at + 120);
  ok(load.length > 0 && !/setNoteMode\(/.test(load), 'and restored without setNoteMode(), which would save before the rest is restored');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
