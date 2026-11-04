// ═══════════════════════════════════════════════════════
// Template — tokens + raw text input
// ═══════════════════════════════════════════════════════
// What a token IS, decided from its content rather than from a stored flag:
// the template also lives as a plain string (the text field, the saved
// memories, the exported settings), and a round trip through that string must
// never change how a token looks.
//   var   — {counter} and friends            → bold, coloured by position
//   slash — "/"                              → blue, starts a subfolder
//   sep   — a run of "_" or "-"              → neutral
//   txt   — anything else the operator typed → italic, coloured by position
function tokClass(t){
  if(!t) return 'sep';
  if(t.type==='var') return 'var';
  if(t.key==='/') return 'slash';
  return /^[_\-]+$/.test(String(t.key||'')) ? 'sep' : 'txt';
}
// Index of the last "/" — everything before it is a subfolder level.
function lastSlashIdx(){ let k=-1; S.tokens.forEach((t,i)=>{ if(tokClass(t)==='slash') k=i; }); return k; }
function tokChipHtml(t,i,cut){
  const kind=tokClass(t);
  const inTree=i<cut;                       // before the last "/" → a folder level
  let cls;
  if(kind==='slash')     cls='tok tok-slash';
  else if(kind==='sep')  cls='tok tok-sep';
  else cls='tok '+(inTree?'tok-lvl':'tok-var')+(kind==='txt'?' tok-txt':'');
  // esc(): a token key can come from an imported settings/preset file or
  // from restored prefs, so it is untrusted text going into innerHTML.
  const lbl=esc(kind==='var'?`{${t.key}}`:t.key);
  return`<div class="${cls}" draggable="true" data-id="${t.id}">
    ${lbl}<button class="tok-rm" aria-label="Remove from the template" title="Remove from the template">×</button></div>`;
}
// The template chips, drawn into the template box, and what they do.
function drawTokChips(){
  const cut=lastSlashIdx();
  const box=document.getElementById('tpl-box');
  box.innerHTML=S.tokens.map((t,i)=>tokChipHtml(t,i,cut)).join('');
  box.querySelectorAll('.tok[data-id]').forEach(chip => {
    const id=+chip.dataset.id;
    chip.ondragstart = function(event){ tokStart(event,id); };
    chip.ondragover  = function(event){ tokOver2(event,id); };
    chip.ondragleave = function(event){ tokLeave(event); };
    chip.ondrop      = function(event){ tokDrop(event,id); };
    chip.querySelector('.tok-rm').onclick = function(){ removeTok(id); };
  });
}
// A literal run typed in the text field becomes several tokens, so that a "/"
// can be dragged and removed on its own and a fixed text keeps its own chip.
function litTokens(lit){
  const out=[];
  const re=/(\/)|([_\-]+)|([^\/_\-]+)/g;
  let m;
  while((m=re.exec(lit))!==null) out.push({type:'sep',key:m[0]});
  return out;
}
// Ask for one line of text, in the app's own style.
// NOT window.prompt(): Electron does not implement it — it returns undefined
// and the button would silently do nothing. (An alert() and a confirm() DO work,
// which is why the two other dialogs of this app are fine.)
// Rebuild the chip list from stored tokens (prefs, a preset, an imported
// settings file). A stored literal is split the same way a typed one is: a
// token saved as "DAY1/" is one chip in the file but TWO on screen — the fixed
// text and the "/" that makes it a subfolder level. Kept whole, it would show a
// single green chip while the engine creates two folders, so nothing on screen
// would say where the card actually lands.
// `legacy` is set for a template saved without tplVersion (earlier versions),
// where a "/" typed into the template field was just an illegal character the
// engine turned into "_": "{counter}_{cardname}/RAW" made the folder
// "001_A001_RAW". Read with the current syntax it would become two levels, and
// with the counter on a subfolder level, every ingest would be refused. So an
// old template keeps the meaning it had when it was saved; a "/" typed in the
// field is a subfolder.
function tokensFromStored(list, legacy){
  const out=[];
  for(const t of (Array.isArray(list)?list:[])){
    if(t && t.type==='var'){ out.push(mkTok('var', canonKey(String(t.key||'')))); continue; }
    let key=String((t&&t.key)||'');
    if(legacy) key=key.replace(/\//g,'_');
    key=tplText(key);   // the folder-name rule, so the chips show what is written
    for(const lit of litTokens(key)) out.push(mkTok('sep', lit.key));
  }
  return out;
}
let askTextClose=null;   // closes the dialog already on screen, if any
function askText(title, sub, placeholder){
  return new Promise(resolve => {
    // Removing the node is not enough: the previous promise would never settle
    // and its document-level key handler would stay behind, swallowing Escape
    // and Enter for the rest of the session.
    if(askTextClose) askTextClose(null);
    const ov=document.createElement('div');
    ov.id='asktext-ov';
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:6000;display:flex;align-items:center;justify-content:center;padding:16px;';
    ov.innerHTML=`<div class="mi-card" style="max-width:460px;">`+
      `<div class="mi-h">${esc(title)}</div>`+
      (sub?`<div class="mi-sub">${esc(sub)}</div>`:'')+
      `<input class="tpl-raw" id="asktext-in" type="text" maxlength="60" placeholder="${esc(placeholder||'')}" style="margin:0 0 16px;">`+
      `<div class="vp-actions">`+
      `<button class="vp-ign" id="asktext-no">Cancel</button>`+
      `<button class="vp-use" id="asktext-ok">Add</button></div></div>`;
    document.body.appendChild(ov);
    const input=ov.querySelector('#asktext-in');
    let done=false;
    const finish=(val)=>{ if(done) return; done=true; askTextClose=null;
                          document.removeEventListener('keydown',onKey,true); ov.remove(); resolve(val); };
    askTextClose=finish;
    const onKey=(e)=>{ if(e.key==='Escape'){ e.preventDefault(); finish(null); }
                       else if(e.key==='Enter'){ e.preventDefault(); finish(input.value); } };
    document.addEventListener('keydown',onKey,true);
    ov.querySelector('#asktext-ok').onclick=()=>finish(input.value);
    ov.querySelector('#asktext-no').onclick=()=>finish(null);
    ov.onclick=(e)=>{ if(e.target===ov) finish(null); };
    setTimeout(()=>input.focus(),0);
  });
}
async function addTxtTok(){
  if(document.getElementById('asktext-ov')) return;      // one dialog at a time
  const v=await askText('Fixed text','The same for every card: a day, a shoot, a client.','DAY1');
  if(v==null) return;
  const t=String(v).trim(); if(!t) return;
  // Typed by hand, and it must stay TEXT: "{" would turn it into a variable on
  // the next round trip through the text field, "/" into a subfolder — neither
  // is what the prompt offered.
  for(const tok of litTokens(tplText(t.replace(/[<>:"|?*\\\/{}]/g,'_')))) S.tokens.push(mkTok('sep',tok.key));
  renderTemplate();syncRaw();persistPrefs();
}
function addTok(type,key){S.tokens.push(mkTok(type,key));renderTemplate();syncRaw();persistPrefs();}

// ── The Insert menu ─────────────────────────────────────────────────────────
// Fifteen chips laid out in a block would tell the operator what exists, and
// nothing about what belongs together. So the entries are grouped and named,
// with the token they write shown beside each one: the menu is the place to
// discover them, the token strip is the place to work.
function toggleInsertMenu(ev){
  if(ev) ev.stopPropagation();
  const m=document.getElementById('ins-menu'); if(!m) return;
  const btn=document.getElementById('ins-btn');
  const open=!m.classList.contains('on');
  m.classList.toggle('on',open);
  if(btn) btn.setAttribute('aria-expanded',open?'true':'false');
  if(open){
    // One click anywhere else closes it, Escape too. Registered once per
    // opening and removed with it, so nothing accumulates.
    const close=()=>{ m.classList.remove('on'); if(btn) btn.setAttribute('aria-expanded','false');
      document.removeEventListener('click',close); document.removeEventListener('keydown',onKey); };
    const onKey=(e)=>{ if(e.key==='Escape'){ close(); if(btn) btn.focus(); } };
    setTimeout(()=>{ document.addEventListener('click',close); document.addEventListener('keydown',onKey); },0);
  }
}
function insPick(kind,key){
  const m=document.getElementById('ins-menu');
  if(m) m.classList.remove('on');
  const btn=document.getElementById('ins-btn'); if(btn) btn.setAttribute('aria-expanded','false');
  if(kind==='txt') addTxtTok(); else addTok(kind,key);
}
// The raw line is there for whoever wants to type a whole template: it is
// reached by double-clicking the token strip instead of sitting under it
// permanently, where it would clutter the template area.
function showRawTemplate(){
  const raw=document.getElementById('tpl-raw'); const box=document.getElementById('tpl-box');
  if(!raw||!box) return;
  if(document.body.classList.contains('ingesting')) return;   // locked during a run
  syncRaw();
  raw.style.display='block'; box.style.display='none';
  raw.focus(); raw.select();
}
function hideRawTemplate(){
  const raw=document.getElementById('tpl-raw'); const box=document.getElementById('tpl-box');
  if(!raw||!box) return;
  raw.style.display='none'; box.style.display='';
}
function removeTok(id){S.tokens=S.tokens.filter(t=>t.id!==id);renderTemplate();syncRaw();persistPrefs();}

function renderTemplate(){
  setTimeout(applyIngestLock,0);
  drawTokChips();
  updatePreview();
}

// Drag with insertion indicator
function tokStart(e,id){S.dragTokId=id;e.dataTransfer.effectAllowed='move';}
function tokOver2(e,tid){
  e.preventDefault();e.stopPropagation();
  // Clear all indicators
  document.querySelectorAll('.tok').forEach(t=>{
    t.classList.remove('drag-over-left','drag-over-right');
  });
  const rect=e.currentTarget.getBoundingClientRect();
  const half=rect.left+rect.width/2;
  if(e.clientX<half) e.currentTarget.classList.add('drag-over-left');
  else e.currentTarget.classList.add('drag-over-right');
}
function tokLeave(e){
  e.currentTarget.classList.remove('drag-over-left','drag-over-right');
}
function tokContainerOver(e){e.preventDefault();}
function tokContainerDrop(e){e.preventDefault();}
function tokDrop(e,tid){
  e.preventDefault();e.stopPropagation();
  document.querySelectorAll('.tok').forEach(t=>t.classList.remove('drag-over-left','drag-over-right'));
  if(S.dragTokId===null||S.dragTokId===tid)return;
  const si=S.tokens.findIndex(t=>t.id===S.dragTokId);
  const ti=S.tokens.findIndex(t=>t.id===tid);
  // Determine insert before or after
  const el=document.querySelector(`.tok[data-id="${tid}"]`);
  const rect=el.getBoundingClientRect();
  const insertBefore=e.clientX<rect.left+rect.width/2;
  const[tok]=S.tokens.splice(si,1);
  const newTi=S.tokens.findIndex(t=>t.id===tid);
  S.tokens.splice(insertBefore?newTi:newTi+1,0,tok);
  S.dragTokId=null;
  renderTemplate();syncRaw();persistPrefs();
}

// The fixed text goes through the folder-name rule here too: a template saved
// by an earlier version, or imported, may still hold "Journée". The engine and the
// counter scan both receive this string, so both see the same folder names.
function buildTplStr(){
  return S.tokens.map(t=>t.type==='var'?`{${t.key}}`:tplText(t.key)).join('');
}

// Sync raw input from tokens
function syncRaw(){
  if(!rawFocused) document.getElementById('tpl-raw').value=buildTplStr();
}

// Parse raw input back to tokens
function onRawInput(){
  const raw=document.getElementById('tpl-raw').value;
  // Parse: split on {variable} boundaries, keep separators as literals
  const parts=[];
  const re=/\{([^}]+)\}/g;
  let last=0,m;
  while((m=re.exec(raw))!==null){
    if(m.index>last){
      // literal text before this var — split so "/" and fixed texts each get
      // their own chip (DAY1/ → the text DAY1, then the subfolder mark).
      parts.push(...litTokens(tplText(raw.slice(last,m.index))));
    }
    parts.push({type:'var',key:canonKey(m[1])});
    last=m.index+m[0].length;
  }
  if(last<raw.length) parts.push(...litTokens(tplText(raw.slice(last))));
  tokId=400;
  S.tokens=parts.map(t=>({...t,id:tokId++}));
  // Update token bar without touching raw input
  drawTokChips();
  updatePreview();
  persistPrefs();
}

function updatePreview(){
  // The preview is what the ENGINE will create, resolved by the same code the
  // preflight uses — placeholders for an empty operator or camera would show a
  // folder that is never created.
  const demo = S.sources.length ? S.sources[0] : { name:'A001' };
  paintPreviewPath(folderPathFromTemplate(demo, 0));
  refreshCardPreviews();
  // The folder names live under each destination, so anything that changes
  // the template, the counter or a card has to redraw that list.
  if (document.getElementById('dst-list')) renderZoneList('dst');
  refreshNoteFooters();
}
// Destination + subfolders + the card's own folder, coloured like the chips.
function paintPreviewPath(segs){
  const el=document.getElementById('tpl-preview'); if(!el) return;
  const leaf=segs.length?segs[segs.length-1]:'';
  const tree=segs.slice(0,-1);
  const dest=(S.dests[0]&&(S.dests[0].name||S.dests[0].path))||'destination';
  let h='<span class="pv-dest">'+esc(dest)+'</span>';
  for(const t of tree) h+='<span class="pv-sep">/</span><span class="pv-tree">'+esc(t)+'</span>';
  h+='<span class="pv-sep">/</span><span class="pv-leaf">'+esc(leaf||'-')+'</span>';
  el.innerHTML=h;
}
// Per-card preview: the path this card will take, relative to each destination.
function previewForSource(src, i){
  const segs=folderPathFromTemplate(src, i);
  return segs.length?segs.join('/'):'-';
}
function refreshCardPreviews(){
  S.sources.forEach((src,i)=>{
    const el=document.getElementById(`sicprev-${i}`);
    if(el) el.textContent=previewForSource(src,i);
  });
}

document.addEventListener('input',e=>{
  if(['meta-cam','meta-model','meta-pp'].includes(e.target.id)){updatePreview();persistPrefs();}
});
