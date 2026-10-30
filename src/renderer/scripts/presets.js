// ═══════════════════════════════════════════════════════
// 4-slot presets — compact, right-click context menu
// ═══════════════════════════════════════════════════════
// Coerce anything that claims to be a preset list into exactly 4 slots holding
// either null or {name:string, tokens:array}. The prefs file, an imported
// settings file and an imported presets file all land here: a hand-edited or
// truncated file would otherwise throw inside renderPresets during boot, which
// kills the whole DOMContentLoaded handler — no volume list, no progress events,
// a dead app with nothing on screen to explain it.
// `legacy` migrates the slots of a prefs file written by an earlier version
// (no tplVersion) ONCE, on load, so a slot saved when "/" meant "_" keeps its
// meaning — and a slot saved by this version is read as written. Migrating at load rather than at each use is what
// makes the two cases distinguishable within one session.
function normPresets(arr, legacy){
  const src = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i=0; i<4; i++){
    const p = src[i];
    out.push((p && typeof p==='object' && typeof p.name==='string')
      ? { name: p.name,
          tokens: (Array.isArray(p.tokens)?p.tokens:[]).map(t=>({
            type: (t&&t.type==='var')?'var':'sep',
            key: (legacy && !(t&&t.type==='var'))
                   ? String((t&&t.key)||'').replace(/\//g,'_')
                   : String((t&&t.key)||'') })) }
      : null);
  }
  return out;
}
function renderPresets(){
  setTimeout(applyIngestLock,0);
  const list = document.getElementById('presets-row');
  list.innerHTML = S.presets.map((p, i) => {
    const isActive = i === S.activePreset;
    // Use mem-* prefixed classes to avoid collision with generic .empty CSS
    const state    = isActive ? 'mem-active' : p ? 'mem-filled' : 'mem-empty';
    const MAX_NAME = 22;
    const displayName = p
      ? (p.name.length > MAX_NAME ? p.name.slice(0, MAX_NAME) + '…' : p.name)
      : 'Template ' + (i + 1);
    const tip = p
      ? (p.name + ' · click to load, right-click for options')
      : ('Empty · click to save the current template here');
    // The motif under the name: a preset is chosen by what it writes, not by
    // the number of the slot it sits in. An empty slot says so in words rather
    // than in a red badge, which read as a fault.
    const motif = p ? (p.tokens||[]).map(t=>t.type==='var'?('{'+t.key+'}'):t.key).join('') : 'empty';
    return '<div class="mem-item ' + state + '" role="button" tabindex="0" title="' + esc(tip) + '"'
      + ' aria-label="' + esc(p ? ('Load the template ' + displayName) : ('Empty template ' + (i + 1) + ', save the current template here')) + '"'
      + '>'
      + '<div class="mem-body">'
      // A saved template's name and motif are the user's: never translated.
      // An empty slot's "Template 2" and "empty" are interface text.
      +   '<div class="mem-name"' + (p ? ' data-i18n-skip' : '') + '>' + esc(displayName) + '</div>'
      +   '<div class="mem-motif"' + (p ? ' data-i18n-skip' : '') + '>' + esc(motif) + '</div>'
      + '</div>'
      + (isActive ? '<svg class="mem-tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-label="in use"><title>in use</title><path d="M20 6 9 17l-5-5"/></svg>' : '')
      + '</div>';
  }).join('');
  list.querySelectorAll('.mem-item').forEach((slot, i) => {
    slot.onclick = function(){ slotClick(i); };
    slot.onkeydown = function(event){ if(event.key==='Enter'||event.key===' '){ event.preventDefault(); slotClick(i); } };
    slot.oncontextmenu = function(event){ slotRightClick(event, i); };
  });
}

// Where a value came from, said in one glyph beside its label: a green (A)
// when ingesto read it off the card, a grey (M) when a human typed it. The
// camera model is the only field that is ever detected today, so it is the
// only one that carries a mark; the day another field is detected, it gets one
// the same way.
function srcMark(src, field){
  if(field !== 'camera') return '';
  const forced = src && src._forced && src._forced.camera;
  const has = !!(src && src.camera);
  if(forced) return MARK_M;
  // A camera carried over from the previous card was typed by someone, not
  // read off THIS card: it says (M) until the detection confirms or replaces it.
  if(has && !src._camDetected) return MARK_M;
  return has ? MARK_A : '';
}
const MARK_A = '<svg class="sif-mk" width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="detected on the card">'
  + '<title>detected on the card</title><circle cx="12" cy="12" r="10" fill="none" stroke="#35c98b" stroke-width="2"/>'
  + '<text x="12" y="12" text-anchor="middle" dominant-baseline="central" fill="#35c98b" font-size="13" font-weight="700">A</text></svg>';
const MARK_M = '<svg class="sif-mk" width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="typed by hand">'
  + '<title>typed by hand</title><circle cx="12" cy="12" r="10" fill="none" stroke="#8b909b" stroke-width="2"/>'
  + '<text x="12" y="12" text-anchor="middle" dominant-baseline="central" fill="#8b909b" font-size="12" font-weight="700">M</text></svg>';
// Typing in a detected field makes it a typed field. Recorded on the source so
// it survives a redraw, and NOT re-rendered here: rebuilding the list on every
// keystroke would take the caret out of the field being typed in.
function markForced(i, field){
  const src = S.sources[i]; if(!src) return;
  src._forced = src._forced || {};
  src._forced[field] = true;
  const lbl = document.querySelector(`#sic-${i} .sif-grid > div:nth-child(2) .sif-label`);
  if(lbl && !/>M</.test(lbl.innerHTML)) lbl.innerHTML = 'CAMERA' + MARK_M;
}

// Escape closes the window that is open. Only the windows that merely inform,
// plus Settings and the PRO warning: a refusal and the end-of-ingest summary
// carry a decision, and are left to their own buttons. The list is walked from
// the most recently opened, so a dialog above another one closes first.
const ESC_CLOSERS = [
  ['pro-warn-ov',     () => proWarnCancel()],
  ['counter-info-ov', () => hideCounterInfo()],
  ['dr-info-ov',      () => hideDrInfo()],
  ['modes-info-ov',   () => hideModesInfo()],
  ['verify-result-ov',() => closeVerifyResult()],
  ['settings-ov',     () => closeSettings()],
];
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  for(const [id, close] of ESC_CLOSERS){
    const el = document.getElementById(id);
    if(el && el.classList.contains('open')){ e.preventDefault(); try{ close(); }catch(_){} return; }
  }
});

function slotClick(i){
  // A filled slot loads. An empty one offers to save the current template into
  // it: doing nothing at all would read as a broken button, and a right-click
  // is not something the screen announces.
  if(S.presets[i]) loadFromSlot(i);
  else if(!document.body.classList.contains('ingesting')) promptSaveSlot(i);
}

function slotRightClick(e,i){
  e.preventDefault();
  e.stopPropagation();
  S.ctxSlot=i;
  // Configure menu items
  const p=S.presets[i];
  document.getElementById('ctx-load').className='ctx-item'+(p?'':' disabled');
  document.getElementById('ctx-del').className='ctx-item danger'+(p?'':' disabled');
  // Position & show menu
  const menu=document.getElementById('ctx-menu');
  menu.classList.add('open');
  // Measure after making visible
  const mw=200, mh=menu.offsetHeight||120;
  let x=e.clientX, y=e.clientY;
  if(x+mw>window.innerWidth)  x=window.innerWidth-mw-6;
  if(y+mh>window.innerHeight) y=window.innerHeight-mh-6;
  menu.style.left=x+'px'; menu.style.top=y+'px';
}

function closeCtx(){document.getElementById('ctx-menu').classList.remove('open');}

function ctxLoad(e){
  if(e)e.stopPropagation();
  const slot=S.ctxSlot;
  closeCtx();
  if(slot<0||!S.presets[slot])return;
  loadFromSlot(slot);
}
// The save icon in the Templates header, so that saving is not reachable only
// by right-clicking a slot, which nothing on screen announces. The icon fills the
// first free slot; with all four taken it says which one to right-click rather
// than overwriting a template the operator did not name.
function saveTemplateQuick(){
  const free = S.presets.findIndex(p => !p);
  if(free >= 0){ promptSaveSlot(free); return; }
  showToast('All four templates are taken. Right-click the one to replace.', 'info', 5000);
}
function ctxSave(e){
  if(e)e.stopPropagation();
  const slot=S.ctxSlot;
  closeCtx();
  if(slot<0)return;
  promptSaveSlot(slot);
}
function ctxDelete(e){
  if(e)e.stopPropagation();
  const slot=S.ctxSlot;
  closeCtx();
  if(slot<0||!S.presets[slot])return;
  if(!confirm(trf('Delete template {n}?', {n:slot+1})))return;
  S.presets[slot]=null;
  if(S.activePreset===slot)S.activePreset=-1;
  renderPresets();persistPrefs();
}

function loadFromSlot(i){
  const p=S.presets[i];if(!p)return;
  tokId=300+i*50;
  S.tokens=tokensFromStored(p.tokens);
  S.activePreset=i;
  renderTemplate();syncRaw();renderPresets();persistPrefs();
}

let _saveSlotIdx = -1;
function promptSaveSlot(i){
  _saveSlotIdx = i;
  document.getElementById('sno-title').textContent = `Save template ${i+1}`;
  const inp = document.getElementById('sno-input');
  inp.value = S.presets[i]?.name || '';
  inp.placeholder = `Template ${i+1}`;
  const ov = document.getElementById('save-name-overlay');
  ov.style.display = 'flex';
  setTimeout(()=>inp.focus(), 50);
}
function snoCancel(){
  document.getElementById('save-name-overlay').style.display='none';
  _saveSlotIdx=-1;
}
function snoConfirm(){
  if(_saveSlotIdx<0)return;
  let name = document.getElementById('sno-input').value.trim() || `Template ${_saveSlotIdx+1}`;
  if(name.length > 24) name = name.slice(0, 24); // enforce max length
  S.presets[_saveSlotIdx]={name,tokens:S.tokens.map(t=>({type:t.type,key:t.key}))};
  S.activePreset=_saveSlotIdx;
  document.getElementById('save-name-overlay').style.display='none';
  _saveSlotIdx=-1;
  renderPresets();persistPrefs();
}
// Enter key confirms
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&document.getElementById('save-name-overlay').style.display==='flex') snoConfirm();
  if(e.key==='Escape'&&document.getElementById('save-name-overlay').style.display==='flex') snoCancel();
});
