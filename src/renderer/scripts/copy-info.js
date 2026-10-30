// ═══════════════════════════════════════════════════════
// Copy Info fields: notes in markdown, picture profile menu,
// operators of the session
// ═══════════════════════════════════════════════════════
// The three are built AROUND the original fields rather than in place of them.
// #meta-note, #k-note and each card's note stay real <textarea>s holding the
// markdown; #meta-pp, #k-pp and each card's profile stay real <input>s holding
// the value. Every line of code that reads or writes .value (prefs, kiosk,
// the broom, startCopy, the report) keeps working unchanged, and a value set
// by script is mirrored on screen by hookValue() below.

// Lets a field tell its on-screen companion that .value was set by script.
// Typing does not go through the setter, so the 'input' event covers that.
function hookValue(el, after){
  if(!el || el._hooked) return;
  const proto = Object.getPrototypeOf(el);
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if(!d || !d.set) return;
  Object.defineProperty(el, 'value', {
    configurable: true,
    get(){ return d.get.call(this); },
    set(v){ d.set.call(this, v); try{ after(this); }catch(_){} },
  });
  el._setRaw = v => d.set.call(el, v);   // write without notifying (the editor itself)
  el._hooked = true;
}

// ── Markdown <-> formatted text ─────────────────────────────────────────────
// Only what the toolbar can produce: bold, italic, underline (<u>, markdown has
// no underline), strikethrough, a heading level, bulleted, numbered and
// checklist items. Everything is ESCAPED first: the note is typed by whoever
// stands at the station and ends up in the report, so no tag can survive
// except the ones built here.
function mdEscape(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function mdInline(s){
  s = mdEscape(s);
  s = s.replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/~~([^~]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<i>$2</i>');
  return s;
}
function mdToHtml(md){
  const out = []; let list = null;
  const close = () => { if(list){ out.push(`</${list.tag}>`); list = null; } };
  const open = (tag, cls) => {
    if(!list || list.tag !== tag || list.cls !== cls){ close(); out.push(`<${tag}${cls ? ` class="${cls}"` : ''}>`); list = { tag, cls }; }
  };
  for(const line of String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')){
    let m;
    if((m = line.match(/^\s*[-*] \[( |x|X)\] ?(.*)$/))){ open('ul', 'task'); out.push(`<li${m[1] !== ' ' ? ' class="done"' : ''}>${mdInline(m[2])}</li>`); }
    else if((m = line.match(/^\s*[-*] (.*)$/))){ open('ul', ''); out.push(`<li>${mdInline(m[1])}</li>`); }
    else if((m = line.match(/^\s*\d+[.)] (.*)$/))){ open('ol', ''); out.push(`<li>${mdInline(m[1])}</li>`); }
    else if((m = line.match(/^#{1,6} (.*)$/))){ close(); out.push(`<h3>${mdInline(m[1])}</h3>`); }
    else { close(); out.push(line.trim() ? `<p>${mdInline(line)}</p>` : '<p><br></p>'); }
  }
  close();
  // A trailing empty paragraph is only the last line break.
  while(out.length > 1 && out[out.length - 1] === '<p><br></p>') out.pop();
  return out.join('');
}
function mdInlineOf(node){
  let s = '';
  node.childNodes.forEach(n => {
    if(n.nodeType === 3){ s += n.nodeValue.replace(/ /g, ' '); return; }
    if(n.nodeType !== 1) return;
    const t = n.tagName;
    if(t === 'BR'){ s += '\n'; return; }
    const inner = mdInlineOf(n);
    if(!inner.trim()){ s += inner; return; }
    // Markers hug the words: "** bold**" is not bold in markdown.
    const wrap = (o, c) => { const lead = inner.match(/^\s*/)[0], tail = inner.match(/\s*$/)[0];
      return lead + o + inner.trim() + c + tail; };
    if(t === 'B' || t === 'STRONG') s += wrap('**', '**');
    else if(t === 'I' || t === 'EM') s += wrap('*', '*');
    else if(t === 'U') s += wrap('<u>', '</u>');
    else if(t === 'S' || t === 'STRIKE' || t === 'DEL') s += wrap('~~', '~~');
    else s += inner;
  });
  return s;
}
function htmlToMd(root){
  const lines = [];
  // Text and inline formatting sitting side by side make ONE line: typing in
  // the empty field and pressing Cmd+B leaves "Salle B " and <b>Interviews</b>
  // as two siblings of the same line, not two lines.
  let run = [];
  const flush = () => { if(run.length){ lines.push(...mdInlineOf({ childNodes: run }).split('\n')); run = []; } };
  const INLINE = /^(B|STRONG|I|EM|U|S|STRIKE|DEL|SPAN|FONT|A|CODE|SMALL|MARK|SUB|SUP)$/;
  const block = n => {
    if(n.nodeType === 3){ run.push(n); return; }
    if(n.nodeType !== 1) return;
    const t = n.tagName;
    if(INLINE.test(t)){ run.push(n); return; }
    flush();
    if(t === 'UL' || t === 'OL'){
      let k = 1; const task = n.classList.contains('task');
      n.querySelectorAll(':scope > li').forEach(li => {
        const txt = mdInlineOf(li).replace(/\n+/g, ' ').trim();
        if(task) lines.push(`- [${li.classList.contains('done') ? 'x' : ' '}] ${txt}`);
        else lines.push(t === 'OL' ? `${k++}. ${txt}` : `- ${txt}`);
      });
    } else if(/^H[1-6]$/.test(t)) lines.push('### ' + mdInlineOf(n).replace(/\n+/g, ' ').trim());
    else if(t === 'BR'){ /* flush() above ended the line; a second one is an empty line */ if(n.previousSibling && n.previousSibling.nodeName === 'BR') lines.push(''); }
    else if(t === 'DIV' && n.querySelector('ul,ol,h1,h2,h3,h4,h5,h6,p,div')){ n.childNodes.forEach(block); flush(); }
    else lines.push(...mdInlineOf(n).split('\n'));
  };
  root.childNodes.forEach(block);
  flush();
  return lines.map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
}

// ── The notes editor ────────────────────────────────────────────────────────
const MDN_ICONS = {
  bold:'<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic:'<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  underline:'<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  strike:'<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  h:'<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  ul:'<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  ol:'<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task:'<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
};
const MDN_TIPS = { bold:'Bold', italic:'Italic', underline:'Underline', strike:'Strikethrough',
                   h:'Heading', ul:'Bulleted list', ol:'Numbered list', task:'Checklist' };
const MDN_WRAP = { bold:['**','**'], italic:['*','*'], underline:['<u>','</u>'], strike:['~~','~~'] };
const MDN_PREFIX = { h:'### ', ul:'- ', ol:'1. ', task:'- [ ] ' };
const MDN_EXEC = { bold:'bold', italic:'italic', underline:'underline', strike:'strikeThrough' };

// One mode for every notes field, remembered in the preferences: someone who
// writes markdown wants it on every card, not only on the one they switched.
function setNoteMode(mode){
  mode = mode === 'md' ? 'md' : 'rich';
  if(S.noteMode === mode) return;
  S.noteMode = mode;
  document.querySelectorAll('.mdn').forEach(box => mdnApplyMode(box));
  persistPrefs();
}
function mdnApplyMode(box){
  const mode = S.noteMode === 'md' ? 'md' : 'rich';
  box.dataset.mode = mode;
  box.querySelectorAll('.mdn-sw button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.m === mode)));
  if(mode === 'rich') mdnRender(box);
}
// The formatted view, rebuilt from the markdown. Never while it is the one
// being typed in: rebuilding would throw the caret to the start.
function mdnRender(box){
  const ta = box.querySelector('textarea'), ed = box.querySelector('.mdn-ed');
  if(!ta || !ed || box._typing) return;
  ed.innerHTML = ta.value ? mdToHtml(ta.value) : '';
}
function mdnFromRich(box){
  const ta = box.querySelector('textarea'), ed = box.querySelector('.mdn-ed');
  ta._setRaw(htmlToMd(ed));
  box._typing = true;
  try{ ta.dispatchEvent(new Event('input', { bubbles:true })); } finally { box._typing = false; }
}
function mdnCommand(box, cmd){
  if(box.querySelector('textarea').disabled) return;
  if(box.dataset.mode === 'md'){
    const ta = box.querySelector('textarea'); const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    if(MDN_WRAP[cmd]){
      const [o, c] = MDN_WRAP[cmd]; const sel = v.slice(a, b);
      ta.value = v.slice(0, a) + o + sel + c + v.slice(b);
      ta.setSelectionRange(a + o.length, a + o.length + sel.length);
    } else {
      const ls = v.lastIndexOf('\n', a - 1) + 1; const p = MDN_PREFIX[cmd];
      ta.value = v.slice(0, ls) + p + v.slice(ls);
      ta.setSelectionRange(a + p.length, b + p.length);
    }
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles:true }));
    return;
  }
  const ed = box.querySelector('.mdn-ed'); ed.focus();
  if(MDN_EXEC[cmd]) document.execCommand(MDN_EXEC[cmd]);
  else if(cmd === 'h') document.execCommand('formatBlock', false, 'h3');
  else if(cmd === 'ul') document.execCommand('insertUnorderedList');
  else if(cmd === 'ol') document.execCommand('insertOrderedList');
  else if(cmd === 'task'){
    document.execCommand('insertUnorderedList');
    let n = getSelection().anchorNode; while(n && n !== ed && n.tagName !== 'UL') n = n.parentNode;
    if(n && n !== ed) n.classList.add('task');
  }
  mdnFromRich(box); mdnRefreshButtons(box);
}
function mdnRefreshButtons(box){
  const ed = box.querySelector('.mdn-ed');
  const inside = box.dataset.mode === 'rich' && ed && ed.contains(getSelection().anchorNode);
  box.querySelectorAll('.mdn-tb button').forEach(b => {
    const c = MDN_EXEC[b.dataset.cmd];
    let on = false; try{ on = !!(inside && c && document.queryCommandState(c)); }catch(_){}
    b.classList.toggle('on', on);
  });
}
// Wraps every <textarea data-mdn> found under root. Idempotent: a card list
// redrawn twice does not get two toolbars.
function mdnInit(root){
  (root || document).querySelectorAll('textarea[data-mdn]').forEach(ta => {
    if(ta.closest('.mdn')) return;
    const box = document.createElement('div'); box.className = 'mdn';
    const lc = ta.getAttribute('data-mdn-lc') || 'mf-label';
    const btn = k => `<button type="button" data-cmd="${k}" aria-label="${MDN_TIPS[k]}" title="${MDN_TIPS[k]}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${MDN_ICONS[k]}</svg></button>`;
    box.innerHTML =
      `<div class="mdn-hd"><div class="${lc}">${esc(ta.getAttribute('data-mdn-label') || 'Notes')}</div>`+
        `<div class="mdn-sw" role="radiogroup" aria-label="Note format">`+
          `<button type="button" data-m="rich" role="radio" title="Formatted text">Aa</button>`+
          `<button type="button" data-m="md" role="radio" title="Markdown source">MD</button></div></div>`+
      `<div class="mdn-box"><div class="mdn-tb">${btn('bold')}${btn('italic')}${btn('underline')}${btn('strike')}<span class="sep"></span>${btn('h')}${btn('ul')}${btn('ol')}${btn('task')}</div>`+
        `<div class="mdn-ed" contenteditable="true" role="textbox" aria-multiline="true" data-mdn-ed spellcheck="true"></div>`+
        `<div class="mdn-ft"></div></div>`;
    ta.before(box);
    box.querySelector('.mdn-ed').before(ta);
    ta.classList.add('mdn-src');
    const ed = box.querySelector('.mdn-ed');
    ed.setAttribute('data-ph', ta.getAttribute('placeholder') || '');
    ed.setAttribute('aria-label', ta.getAttribute('aria-label') || 'Notes');
    hookValue(ta, () => mdnRender(box));
    box.querySelectorAll('.mdn-tb button').forEach(b => {
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection
      b.addEventListener('click', () => mdnCommand(box, b.dataset.cmd));
    });
    box.querySelectorAll('.mdn-sw button').forEach(b => b.addEventListener('click', () => setNoteMode(b.dataset.m)));
    ed.addEventListener('input', () => mdnFromRich(box));
    // Plain text only: a paste from a web page or a mail would bring fonts,
    // links and images that markdown cannot keep.
    ed.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      document.execCommand('insertText', false, t);
    });
    ed.addEventListener('drop', e => e.preventDefault());
    ed.addEventListener('click', e => {
      const li = e.target.closest && e.target.closest('ul.task > li');
      if(!li || ed.getAttribute('contenteditable') !== 'true') return;
      if(e.clientX - li.getBoundingClientRect().left < 18){ li.classList.toggle('done'); mdnFromRich(box); }
    });
    ['keyup','mouseup','focus'].forEach(ev => ed.addEventListener(ev, () => mdnRefreshButtons(box)));
    mdnApplyMode(box);
    mdnRender(box);
  });
  refreshNoteFooters();
}
// What the note will be called on the drive, under each notes field.
function refreshNoteFooters(){
  const width = S.counterWidth;
  const set = (ta, n) => { const f = ta && ta.closest('.mdn') && ta.closest('.mdn').querySelector('.mdn-ft');
                           if(f) f.textContent = padCounter(n, width) + '_note.md'; };
  set(document.getElementById('meta-note'), S.counter);
  set(document.getElementById('k-note'), S.counter);
  document.querySelectorAll('#src-info-list textarea[data-mdn]').forEach(ta => set(ta, S.counter + Number(ta.dataset.i || 0)));
}

// ── Picture profile menu ────────────────────────────────────────────────────
// [label shown, value written]. The value is the short name the trade uses
// (CLOG3, not CANONLOG3), already in the form normPP() gives: picking SLOG3
// here and typing "S-Log3" by hand make the same folder name. Completed from
// user feedback.
const PP_GROUPS = [
  ['Sony',        [['S-Log3','SLOG3'],['S-Log2','SLOG2'],['S-Cinetone','SCINETONE'],['HLG3','HLG3']]],
  ['Canon',       [['Canon Log 3','CLOG3'],['Canon Log 2','CLOG2'],['Canon Log','CLOG']]],
  ['Panasonic',   [['V-Log','VLOG'],['Cinelike D2','CINELIKED2']]],
  ['Fujifilm',    [['F-Log2 C','FLOG2C'],['F-Log2','FLOG2'],['F-Log','FLOG'],['Eterna','ETERNA']]],
  ['ARRI',        [['LogC4','LOGC4'],['LogC3','LOGC3']]],
  ['RED / Nikon', [['Log3G10','LOG3G10'],['N-Log','NLOG']]],
  ['Blackmagic',  [['Film Gen 5','BMDFILM5'],['Blackmagic RAW','BRAW']]],
  ['DJI',         [['D-Log','DLOG'],['D-Log M','DLOGM']]],
  ['Smartphones', [['Apple Log 2','APPLELOG2'],['Apple Log','APPLELOG'],['Samsung Log','SAMSUNGLOG']]],
  ['Other',       [['L-Log (Leica, Sigma)','LLOG'],['I-Log (Insta360)','ILOG'],['Z-Log2 (Z CAM)','ZLOG2'],['KineLog3','KINELOG3']]],
  ['Standard',    [['Rec.709','REC709'],['HLG','HLG'],['PQ','PQ']]],
];
const PP_COLUMNS = [['Sony','Canon','Panasonic','Fujifilm'],['ARRI','RED / Nikon','Blackmagic','DJI'],['Smartphones','Other','Standard']];
let _ppMenu = null, _ppFor = null;
function ppMenuEl(){
  if(_ppMenu) return _ppMenu;
  const G = Object.fromEntries(PP_GROUPS);
  const m = document.createElement('div'); m.className = 'pp-menu'; m.id = 'pp-menu'; m.setAttribute('role', 'menu');
  m.innerHTML = `<div class="pp-cols">${PP_COLUMNS.map(col => `<div>${col.map(g => `<div class="pp-g"><div class="pp-gh">${esc(g)}</div>${
      G[g].map(([l, w]) => `<button type="button" class="pp-it" role="menuitemradio" data-w="${w}"><span>${esc(l)}</span><span class="w">${w}</span></button>`).join('')
    }</div>`).join('')}</div>`).join('')}</div>`+
    `<div class="pp-foot"><input type="text" maxlength="16" spellcheck="false" aria-label="Other picture profile" placeholder="Other profile, type it and press Enter"><button type="button" class="none">None</button></div>`+
    `<div class="pp-hint">The value on the right is what {pp} writes in the folder name.</div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => {
    const it = e.target.closest('.pp-it'); if(it){ ppApply(it.dataset.w); return; }
    if(e.target.closest('.none')) ppApply('');
  });
  const inp = m.querySelector('input');
  inp.addEventListener('input', () => sanitizePP(inp));
  inp.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); const w = normPP(inp.value); if(w) ppApply(w); }
  });
  document.addEventListener('mousedown', e => {
    if(_ppFor && !m.contains(e.target) && !(_ppFor._ppBtn && _ppFor._ppBtn.contains(e.target))) ppClose();
  }, true);
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && _ppFor) ppClose(); }, true);
  window.addEventListener('resize', ppClose);
  document.addEventListener('scroll', e => { if(_ppFor && !m.contains(e.target)) ppClose(); }, true);
  _ppMenu = m; return m;
}
function ppLabel(input){
  const b = input && input._ppBtn; if(!b) return;
  const v = b.querySelector('.v'); const val = input.value;
  v.textContent = val || 'None'; v.classList.toggle('ph', !val);
}
function ppApply(w){
  const input = _ppFor; if(!input) return;
  input.value = normPP(w);
  input.dispatchEvent(new Event('input', { bubbles:true }));   // the field's own handlers run, as if typed
  ppClose();
  if(input._ppBtn) input._ppBtn.focus();
}
function ppClose(){
  if(_ppMenu) _ppMenu.classList.remove('open');
  if(_ppFor && _ppFor._ppBtn) _ppFor._ppBtn.setAttribute('aria-expanded', 'false');
  _ppFor = null;
}
function ppOpen(input){
  if(!input || input.disabled) return;
  if(_ppFor === input) return ppClose();
  ppClose();
  const m = ppMenuEl(); _ppFor = input;
  input._ppBtn.setAttribute('aria-expanded', 'true');
  m.querySelectorAll('.pp-it').forEach(it => it.classList.toggle('cur', it.dataset.w === input.value));
  m.querySelector('input').value = '';
  m.classList.add('open');
  // Below the button if it fits, else above, else beside it: the menu must
  // never need scrolling, down to the smallest window (1280 x 760).
  const r = input._ppBtn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight, W = innerWidth, H = innerHeight, g = 6;
  let left, top;
  if(r.bottom + g + mh <= H - 8){ top = r.bottom + g; left = r.left; }
  else if(r.top - g - mh >= 8){ top = r.top - g - mh; left = r.left; }
  else { top = Math.max(8, Math.min(r.top, H - 8 - mh)); left = (r.right + g + mw <= W - 8) ? r.right + g : r.left - g - mw; }
  left = Math.max(8, Math.min(left, W - 8 - mw));
  m.style.left = left + 'px'; m.style.top = top + 'px';
  const cur = m.querySelector('.pp-it.cur') || m.querySelector('.pp-it'); if(cur) cur.focus();
}
// Turns every <input data-pp> under root into a button that opens the menu.
function ppInit(root){
  (root || document).querySelectorAll('input[data-pp]').forEach(input => {
    if(input._ppBtn) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pp-btn';
    b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', input.getAttribute('aria-label') || 'Picture profile');
    b.title = 'Picture profile';
    b.innerHTML = '<span class="v"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    input.hidden = true;
    input.after(b);
    input._ppBtn = b;
    b.addEventListener('click', () => ppOpen(input));
    hookValue(input, ppLabel);
    // The lock disables the field; the button follows it.
    new MutationObserver(() => { b.disabled = input.disabled; }).observe(input, { attributes:true, attributeFilter:['disabled'] });
    b.disabled = input.disabled;
    ppLabel(input);
  });
}

// ── Operators of this session ───────────────────────────────────────────────
// Kept in memory ONLY: never written to the preferences, so the list is empty
// again every time ingesto starts. Filled at START, not while typing, or
// "N", "NO" and "NOA" would join it on the way to "NOAR". Most recent first.
const SESSION_OPS_MAX = 30;
function rememberOperators(names){
  if(!Array.isArray(S.sessionOps)) S.sessionOps = [];
  for(const raw of names){
    const n = String(raw == null ? '' : raw).trim(); if(!n) continue;
    S.sessionOps = [n, ...S.sessionOps.filter(x => x.toLowerCase() !== n.toLowerCase())];
  }
  S.sessionOps = S.sessionOps.slice(0, SESSION_OPS_MAX);
}
let _opList = null, _opFor = null, _opHl = 0, _opItems = [];
function opListEl(){
  if(_opList) return _opList;
  const l = document.createElement('div'); l.className = 'op-list'; l.id = 'op-list'; l.setAttribute('role', 'listbox');
  document.body.appendChild(l);
  l.addEventListener('mousedown', e => { const it = e.target.closest('.op-it'); if(it){ e.preventDefault(); opPick(it.dataset.n); } });
  document.addEventListener('scroll', e => { if(_opFor && !l.contains(e.target)) opClose(); }, true);
  window.addEventListener('resize', opClose);
  _opList = l; return l;
}
function opClose(){ if(_opList) _opList.classList.remove('open'); if(_opFor) _opFor.setAttribute('aria-expanded', 'false'); _opFor = null; }
function opPick(n){
  const i = _opFor; if(!i) return;
  opClose();
  i.value = n;
  i.dispatchEvent(new Event('input', { bubbles:true }));
  i.focus();
}
function opRender(input, showAll){
  const l = opListEl();
  const all = Array.isArray(S.sessionOps) ? S.sessionOps : [];
  const q = showAll ? '' : input.value.trim().toLowerCase();
  _opItems = all.filter(n => !q || (n.toLowerCase().startsWith(q) && n.toLowerCase() !== q));
  if(!showAll && (!q || !_opItems.length)) return opClose();
  _opFor = input; input.setAttribute('aria-expanded', 'true');
  _opHl = Math.max(0, Math.min(_opHl, _opItems.length - 1));
  l.innerHTML = `<div class="op-lh">This session</div>` + (_opItems.length
    ? _opItems.map((n, k) => `<div class="op-it${k === _opHl ? ' hl' : ''}" role="option" data-n="${esc(n)}">${
        q ? `<b>${esc(n.slice(0, q.length))}</b>${esc(n.slice(q.length))}` : esc(n)}</div>`).join('')
    : `<div class="op-empty">Names are added here when an ingest starts.</div>`);
  l.classList.add('open');
  const r = input.getBoundingClientRect(); const w = Math.max(180, r.width);
  let top = r.bottom + 6; if(top + l.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - 6 - l.offsetHeight);
  l.style.minWidth = w + 'px';
  l.style.left = Math.max(8, Math.min(r.left, innerWidth - 8 - Math.max(w, l.offsetWidth))) + 'px';
  l.style.top = top + 'px';
}
// Wraps every <input data-opcb> under root.
function opInit(root){
  (root || document).querySelectorAll('input[data-opcb]').forEach(input => {
    if(input.closest('.op-cb')) return;
    const w = document.createElement('div'); w.className = 'op-cb';
    input.before(w); w.append(input);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list');
    const a = document.createElement('button'); a.type = 'button'; a.className = 'op-arrow'; a.tabIndex = -1;
    a.setAttribute('aria-label', 'Operators of this session'); a.title = 'Operators of this session';
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    w.append(a);
    new MutationObserver(() => { a.disabled = input.disabled; }).observe(input, { attributes:true, attributeFilter:['disabled'] });
    a.disabled = input.disabled;
    input.addEventListener('input', () => { if(input._opPicking) return; _opHl = 0; opRender(input, false); });
    input.addEventListener('keydown', e => {
      const open = _opFor === input;
      if(e.key === 'ArrowDown'){ e.preventDefault(); if(!open){ _opHl = 0; opRender(input, true); } else { _opHl = Math.min(_opHl + 1, _opItems.length - 1); opRender(input, !input.value.trim()); } }
      else if(e.key === 'ArrowUp' && open){ e.preventDefault(); _opHl = Math.max(_opHl - 1, 0); opRender(input, !input.value.trim()); }
      else if(e.key === 'Enter' && open && _opItems[_opHl]){ e.preventDefault(); opPick(_opItems[_opHl]); }
      else if(e.key === 'Escape' && open){ e.preventDefault(); e.stopPropagation(); opClose(); }
      else if(e.key === 'Tab' && open) opClose();
    });
    input.addEventListener('blur', () => setTimeout(() => { if(_opFor === input && document.activeElement !== input) opClose(); }, 150));
    a.addEventListener('mousedown', e => {
      e.preventDefault(); if(input.disabled) return;
      if(_opFor === input) return opClose();
      _opHl = 0; input.focus(); opRender(input, true);
    });
  });
}
function fieldsInit(root){ ppInit(root); opInit(root); mdnInit(root); }
