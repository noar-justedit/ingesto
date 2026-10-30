// ═══════════════════════════════════════════════════════
// Launch
// ═══════════════════════════════════════════════════════
function onStartBtn(){
  if(S.copying){ doCancelCopy(); return; }
  // Nothing to copy, or nowhere to copy it: the button is out of date, never
  // a reason to start.
  if(!S.sources.length || !S.dests.length){ updateBtn(); return; }
  startCopy();
}
// Transport icons — official lucide.dev shapes (play / pause / square / eject)
const PAUSE_SVG='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/></svg>';
const PLAY_SVG='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';
const STOP_SVG='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
function onPauseBtn(){
  if(!S.copying) return;
  if(!S.paused){
    S.paused=true;
    window.ingesto.pauseCopy();
    // This one stays: a pause does not stop the copy on the spot, the file in
    // flight is finished first. Without it the operator clicks Pause, watches
    // the bar keep moving, and concludes the button did nothing. The badge
    // disappears as soon as the engine really holds.
    setPauseBadge('Pausing, finishing the current file…');
  } else {
    S.paused=false;
    window.ingesto.resumeCopy();
    setPauseBadge(null);
  }
  updateBtn();
}
// At this point the engine is actually holding. The badge has done its job and goes
// away: the button already reads "Resume" and every figure has stopped moving,
// so a banner repeating "Paused" is one thing too many on screen.
function onPauseHeld(){ if(S.paused) setPauseBadge(null); }
function setPauseBadge(txt){
  const b=document.getElementById('pause-badge');
  const t=document.getElementById('pause-badge-txt');
  if(txt){ t.textContent=txt; b.style.display='flex'; }
  else b.style.display='none';
}
function updateBtn(){
  const b=document.getElementById('start-btn');
  const p=document.getElementById('pause-btn');
  if(S.copying){
    b.disabled=false; b.classList.add('danger');
    b.innerHTML=STOP_SVG+' Cancel';
    p.style.display='flex';
    if(S.paused){ p.classList.add('resume'); p.innerHTML=PLAY_SVG+' Resume'; }
    else { p.classList.remove('resume'); p.innerHTML=PAUSE_SVG+' Pause'; }
  } else {
    b.classList.remove('danger');
    // A permanent refusal is not said in a modal: it is read on the button you
    // are trying to press. With no card or no destination, a START that is
    // simply grey, with no tooltip, no title and no message, would be the one
    // case where the software says nothing at all.
    const noSrc = S.sources.length===0, noDst = S.dests.length===0;
    b.disabled = noSrc || noDst;
    // No card yet: the button says what to do, without
    // the play icon, and breathes in orange until a card is there.
    b.classList.toggle('insert', noSrc);
    b.innerHTML = noSrc ? 'Insert your card'
                : PLAY_SVG + (noDst ? ' Choose a destination' : ' Start Ingest');
    p.style.display='none';
    S.paused=false;
    setPauseBadge(null);
  }
}

// ── Pre-flight guards ────────────────────────────────────────────────────
// Mirrors the checks the copy engine enforces, so the user gets a clear
// reason BEFORE the ingest starts instead of a green run that copied nothing
// or overwrote a previous card.

// Same cleanup the engine applies in buildFolderName().
// Two folder names that a filesystem would treat as ONE. macOS and Windows are
// case-insensitive, and macOS stores names decomposed while Windows composes
// them — so "NO NAME" and "No Name", or the same accented name typed on two
// systems, all land in the same directory.
function folderKey(name){
  let n = String(name || '');
  try { n = n.normalize('NFC'); } catch(_) {}
  // Windows silently drops trailing dots and spaces from a directory name, so
  // "REEL1." and "REEL1" are ONE folder there. Fold them here too — erring on
  // the side of refusing is the right direction for a guard against overwrite.
  return n.trim().replace(/[. ]+$/,'').toLowerCase();
}

// `refDate` lets one preflight pass resolve EVERY card's name from the same
// clock reading. Without it, a loop crossing a minute (or, with {SS}, a second)
// boundary would give two homonymous cards different keys, and the collision
// guard would wave through a run that the engine could still write into a
// single folder.
const tplSegments = (t) => window.IngestoShared.templateSegments(t);
const tplLeaf     = (t) => window.IngestoShared.templateLeaf(t);

function folderPathFromTemplate(src, i, refDate){
  return resolveTplSegs(buildTplStr(), src, i, refDate);
}
// The card's OWN folder, resolved from the LAST template level alone. Asking
// the full path for it would not do: an empty last level disappears from the
// path and the level above would answer in its place.
function leafNameFromTemplate(src, i, refDate){
  const s=resolveTplSegs(tplLeaf(buildTplStr()), src, i, refDate);
  return s.length?s[s.length-1]:'';
}
// The card's path under a destination, as a list of folders: the shared
// buildFolderSegments(), fed with what this window knows of the card. The
// counter is the one the run will use; an operator, camera or profile not set
// on the card comes from the Copy Info fields; the folder-name rule follows
// the language (nameRule()).
function resolveTplSegs(tplStr, src, i, refDate){
  const field = id => document.getElementById(id)?.value || '';
  return window.IngestoShared.buildFolderSegments(tplStr, {
    name:      src.name,
    counter:   padCounter((S.counter||1)+i),
    cameraman: src.operator || field('meta-cam'),
    camera:    src.camera   || field('meta-model'),
    pp:        src.pp       || field('meta-pp'),
    nameRule:  src.nameRule || (typeof nameRule==='function' ? nameRule() : 'unicode'),
  }, refDate||new Date());
}
// Path-containment test, case-insensitive except on Linux.
function pathContains(parent, child){
  const norm=p=>{
    // Resolve "." and ".." segments so "/Volumes/CARD/../CARD" is caught here,
    // like the main-process path.resolve version — not only later at run time.
    let r=String(p||'').replace(/\\/g,'/');
    const abs=r.startsWith('/');
    const out=[];
    for(const seg of r.split('/')){
      if(seg===''||seg==='.') continue;
      if(seg==='..'){ if(out.length&&out[out.length-1]!=='..') out.pop(); else if(!abs) out.push('..'); }
      else out.push(seg);
    }
    r=(abs?'/':'')+out.join('/');
    r=r.replace(/\/+$/,'')||(abs?'/':'');
    if(window.ingesto.platform!=='linux') r=r.toLowerCase();
    return r;
  };
  const a=norm(parent), b=norm(child);
  if(!a||!b) return false;
  return a===b || b.startsWith(a==='/'?'/':a+'/');
}
// Returns an error message, or null when everything is fine.
function preflightIngest(){
  // One clock reading for the whole preflight, see folderNameFromTemplate.
  const pfNow=new Date();
  const m = x => `<span class="m">${esc(x)}</span>`;
  const NUM = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
  const EDIT = tok => ({ label:'EDIT TEMPLATE', value:'edit', style:'fix',
                         act:()=>pfEditTemplate(tok) });
  const CANCEL = { label:'CANCEL', value:'cancel', style:'ghost' };
  const NOTHING = 'Nothing has been written.';

  // 1. Folder template. Every level must be a usable folder name.
  for(let i=0;i<S.sources.length;i++){
    const segs=folderPathFromTemplate(S.sources[i], i, pfNow);
    const card=S.sources[i].name||S.sources[i].path;
    const dest=(S.dests[0]&&(S.dests[0].name||S.dests[0].path))||'the destination';
    if(!segs.length){
      return { code:'PF-R1', kind:'block', lead:NOTHING,
        title:['This card would be written','into the destination root'],
        cause:`The template gives card ${m(card)} no folder of its own. Every card would land side `+
              `by side in ${m(dest)}, each one overwriting the last.`,
        action:`Add ${m('{counter}')} or ${m('{cardname}')} to the last level of the template.`,
        buttons:[EDIT('{counter}'), CANCEL] };
    }
    const bad=segs.find(x=>!isSafeFolderName(x));
    if(bad!==undefined){
      return { code:'PF-R2', kind:'block', lead:NOTHING,
        title:['One folder level is not','a usable name'],
        cause:`The template produces ${m(bad||'(empty)')} as a level for card ${m(card)}. `+
              `No drive accepts that as a folder name.`,
        action:'Fix that level of the template.',
        buttons:[EDIT(null), CANCEL] };
    }
    // The card's OWN folder must exist. A level that resolves to nothing simply
    // disappears, which is fine for a subfolder and never for the last one:
    // "{YY}{MM}{DD}/{operator}_{camera}" with both fields empty leaves "260903"
    // alone, and every card of the day is written INTO that folder, tomorrow's
    // over today's.
    if(!leafNameFromTemplate(S.sources[i], i, pfNow)){
      const shared=segs.join('/')+'/';
      return { code:'PF-R3', kind:'block', lead:NOTHING,
        title:['This card would share a folder','with every other card'],
        cause:`The last level of the template, the <span class="g">green</span> part, produces nothing `+
              `for card ${m(card)}. It would be written into ${m(shared)}, the folder it shares with `+
              `the whole day.`,
        action:'Put something in the last level, or fill the field it uses.',
        buttons:[EDIT('{cardname}'), CANCEL] };
    }
    if(segs.length>MAX_FOLDER_DEPTH){
      return { code:'PF-R4', kind:'block', lead:NOTHING,
        title:['The template asks for',`${NUM[segs.length]||segs.length} levels of folders`],
        cause:`The limit is ${NUM[MAX_FOLDER_DEPTH]||MAX_FOLDER_DEPTH}. Deeper trees make long paths `+
              `that Windows refuses and that nobody can read on a drive.`,
        action:`Remove a ${m('/')} from the template.`,
        buttons:[EDIT('/'), CANCEL] };
    }
  }
  // 1b. The counter identifies a CARD, so it must be in the card's own folder,
  //     the level after the last "/". On a shared level it would number a day
  //     or a camera instead, and the counter scan, the collision check and the
  //     report would all describe something other than the cards.
  { const segs=tplSegments(buildTplStr());
    if(segs.slice(0,-1).some(x=>x.includes('{counter}'))){
      return { code:'PF-R5', kind:'block', lead:NOTHING,
        title:['The counter is not',"in the card's folder"],
        cause:`${m('{counter}')} sits on a subfolder level. It numbers cards, not days or cameras: `+
              `on a shared level it would give every card of the day the same number.`,
        action:`Move it after the last ${m('/')}, into the <span class="g">green</span> part.`,
        buttons:[EDIT('{counter}'), CANCEL] };
    }
  }
  // 2. A destination that IS the source card, or lives inside it.
  for(const s of S.sources) for(const d of S.dests){
    if(pathContains(s.path,d.path) || pathContains(d.path,s.path)){
      return { code:'PF-R6', kind:'block', lead:NOTHING,
        title:['The destination is','the card itself'],
        cause:`${m(d.path)} is the source card ${m(s.name||s.path)}, or a folder inside it. The card `+
              `would be copied into itself, then flagged as ingested and offered for ejection.`,
        action:'Remove one of the two.',
        buttons:[{ label:'REMOVE DESTINATION', value:'removed', style:'fix',
                   act:()=>{ removeFromZone('dst', d.path); } }, CANCEL] };
    }
  }
  // 3. Two cards of the same run resolving to the SAME destination folder.
  //    No other check catches this: check 1 only asks whether each name is
  //    valid, and the counter-collision check compares against what is already
  //    on the disk, never card against card. With a template carrying no
  //    {counter} and two cards labelled the same ("NO NAME" is the factory
  //    label on half the cards in circulation), both ingests would write into
  //    one folder, the second overwriting the first, and BOTH runs would report
  //    success. The operator would then erase two cards holding one card's
  //    footage.
  //    Compared on the RESOLVED name, not the card label: a template like
  //    {operator}_{YY}{MM}{DD} collides for every card of the day whatever
  //    they are called.
  { const byKey = new Map();
    for(let i=0;i<S.sources.length;i++){
      // The FULL path under the destination: two cards that share a card-folder
      // name but land in different subfolders (two cameras, same counter) do
      // not collide, and two that share the whole path do.
      const nm = folderPathFromTemplate(S.sources[i], i, pfNow).join('/');
      const k  = nm.split('/').map(folderKey).join('/');
      if(byKey.has(k)){
        const first = S.sources[byKey.get(k)], second = S.sources[i];
        const same  = folderKey(first.name) === folderKey(second.name);
        return { code:'PF-R7', kind:'block', lead:NOTHING,
          title:['Two cards would land','in the same folder'],
          cause:`Card ${m(first.name||first.path)} and card ${m(second.name||second.path)} both produce `+
                `${m(nm)}. The second would be written over the first, and both would be reported as a `+
                `success.`,
          action: same
            ? `The two cards carry the same name. Add ${m('{counter}')} to the template, or rename one `+
              `of them in the source list.`
            : `Add ${m('{counter}')} or ${m('{cardname}')} to the template so each card gets its own folder.`,
          buttons:[EDIT('{counter}'),
                   { label:'RENAME A CARD', value:'rename', act:()=>pfShowSources() },
                   CANCEL] };
      }
      byKey.set(k, i);
    }
    // Equal paths are not the only overlap: one card's folder can BE a level of
    // another's. With "{cardname}/{camera}", card A001 shot on A_CAM lands in
    // "A001/A_CAM" and a second A001 with no camera lands in "A001": the first
    // ends up INSIDE the second, and both are reported as clean backups.
    // EVERY pair, not just neighbours after a sort: any third card whose key
    // sorts between the two breaks adjacency (every character below "/" does
    // it, "-" first of all), and the real pair would then never be compared.
    const keys=[...byKey.keys()];
    let outerK=null, innerK=null;
    for(let a=0;a<keys.length && !outerK;a++) for(let b=0;b<keys.length;b++){
      if(a!==b && keys[b].startsWith(keys[a]+'/')){ outerK=keys[a]; innerK=keys[b]; break; }
    }
    if(outerK){
      const outer=S.sources[byKey.get(outerK)], inner=S.sources[byKey.get(innerK)];
      return { code:'PF-R8', kind:'block', lead:NOTHING,
        title:['One card would sit','inside another'],
        cause:`Card ${m(inner.name||inner.path)} would be written inside the folder of card `+
              `${m(outer.name||outer.path)}. The two ingests would be tangled together on the drive.`,
        action:'This happens when a template level is empty for one card and not for the other. '+
               'Fill the missing field, or fix the template.',
        buttons:[EDIT(null), CANCEL] };
    }
  }
  // 4. File filter on, every format unchecked.
  const ff=buildFileFilterOptions();
  if(ff && Object.keys(ff.extCat).length===0){
    return { code:'PF-R9', kind:'block', lead:NOTHING,
      title:['The file filter would','copy nothing'],
      cause:'The filter is on and no format is checked. Not a single file would be copied, and the '+
            'ingest would still report a success.',
      action:'Check at least one format, or turn the filter off.',
      buttons:[{ label:'OPEN FILE FILTER', value:'filter', style:'fix', act:()=>pfOpenFilter() }, CANCEL] };
  }
  return null;
}
// Every card and every destination must still be there — and be the SAME
// volume — at the moment Start is pressed. Otherwise ejecting a destination
// and then starting would run the whole ingest into errors, file by file.
async function checkVolumesStillThere(){
  const items = [
    ...S.sources.map(x => ({ zone:'src', entry:x })),
    ...S.dests.map(x   => ({ zone:'dst', entry:x })),
  ];
  if(!items.length) return null;
  let res;
  try{
    res = await window.ingesto.checkPaths(items.map(i => ({
      path: i.entry.path, isMount: i.entry._isMount, total: i.entry._total })));
  }catch(_){ return null; }          // the check must never block a valid ingest
  if(!Array.isArray(res)) return null;

  const lost = [];
  res.forEach((r,i) => {
    if(r && r.ok){
      // Refresh what we know: the volume is fine, and it may not have been
      // measured yet (the first probe can lose a race with a fast operator).
      if(r.isMount != null) items[i].entry._isMount = r.isMount;
      if(r.total   != null) items[i].entry._total   = r.total;
    } else {
      lost.push({ ...items[i], reason: (r && r.reason) || 'missing' });
    }
  });
  if(!lost.length) return null;

  const nameOf = l => l.entry.name || l.entry.path;
  const why = { missing:'is not mounted any more', unreachable:'cannot be reached any more',
                notdir:'is not a folder any more', unmounted:'is not mounted any more',
                replaced:'has been swapped for a different volume at the same place' };
  const cards = lost.filter(l => l.zone==='src');
  const one   = lost.length === 1;
  // The title names the thing on the table, and says which of the two problems
  // it is. A volume that was REPLACED is still connected: it is a different
  // drive under the same name, which is the more dangerous of the two, so the
  // title must say it.
  const swapped = lost.filter(l => l.reason==='replaced');
  const title = swapped.length === lost.length
    ? (one ? [ `${nameOf(lost[0])} is not the same`, 'drive any more' ]
           : [ `${lost.length} drives are not the same`, 'drives any more' ])
    : one
      ? [ `${nameOf(lost[0])} is no longer`, 'connected' ]
      : [ `${lost.length} ${cards.length===lost.length?'cards':'drives'} are no longer`, 'connected' ];
  const lines = lost.map(l =>
    `<div style="margin:5px 0">It was loaded as a ${l.zone==='src'?'card':'destination'} but `+
    `${why[l.reason]||'is unavailable'}: <span class="m">${esc(l.entry.path)}</span></div>`
  ).join('');
  return { code:'PF-R10', kind:'block', lead:'Nothing has been written.',
    title, cause: lines,
    // "the list", not "the destinations": a card may be among the volumes
    // that went away.
    action: swapped.length === lost.length
      ? `Put the original back and press Recheck, or take ${one?'it':'them'} out of the list.`
      : `Reconnect ${one?'it':'them'} and press Recheck, or take ${one?'it':'them'} out of the list.`,
    buttons:[{ label:'RECHECK DRIVES', value:'recheck', style:'fix' },
             { label:'REMOVE IT', value:'removed',
               act:()=>{ lost.forEach(l=>removeFromZone(l.zone, l.entry.path)); } },
             { label:'CANCEL', value:'cancel', style:'ghost' }] };
}

// ── The one window every refusal, warning and busy state goes through ──────
// Whatever has happened (a template that cannot produce a folder name, a drive
// that was unplugged, a second window opening), the window offers buttons that
// lead to the fix: a single red box with a "Got it" button would tell the
// operator what is wrong and leave them with nothing to press.
//
// spec = { kind:'block'|'warn'|'busy', code, title:[line1,line2], lead,
//          leadKind:'ok'|'warn'|'info', cause, action, buttons:[...] }
// Each button is { label, value, style:'fix'|'go'|'ghost', act? }. `act` runs
// before the promise resolves with the button's value, so the window can both
// close itself and put the cursor where the fix is made.
const PF_ICO = {
  block:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  busy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  // Something to know, nothing wrong and nothing running (the HDE card).
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};
let _pfPending = null;   // resolver of the window currently on screen
function showRefusal(spec){
  const old=document.getElementById('pf-ov');
  if(old){
    old.remove();
    // Replacing a window on screen must SETTLE its promise, not orphan it: the
    // queue that opens one refusal per refused card awaits each in turn, and a
    // window opened from elsewhere (a card dropped in, a restart) would
    // strand it, so the remaining refusals would never appear.
    if(_pfPending){ const done=_pfPending; _pfPending=null; done('dismiss'); }
  }
  const kind = spec.kind || 'block';
  const btns = (spec.buttons && spec.buttons.length) ? spec.buttons
             : [{ label:'GOT IT', value:'cancel' }];
  const ov=document.createElement('div');
  ov.id='pf-ov';
  ov.innerHTML =
    `<div class="pf-card pf-${kind}">`+
      `<div class="pf-hd"><div class="pf-ico">${PF_ICO[kind]||PF_ICO.block}</div>`+
      `<div style="min-width:0">`+
        `<div class="pf-title">${(spec.title||[]).map(esc).join('<br>')}</div>`+
        (spec.lead?`<div class="pf-lead ${spec.leadKind||'ok'}">${esc(spec.lead)}</div>`:'')+
      `</div></div>`+
      (spec.cause?`<div class="pf-cause">${spec.cause}</div>`:'')+
      (spec.action?`<div class="pf-act">${spec.action}</div>`:'')+
      `<div class="pf-btns">`+
        btns.map((b,i)=>`<button class="pf-btn ${b.style||''}" data-i="${i}">${esc(b.label)}</button>`).join('')+
      `</div>`+
    `</div>`;
  document.body.appendChild(ov);
  return new Promise(resolve=>{
    _pfPending = resolve;
    const finish=(b)=>{ ov.remove(); _pfPending=null; try{ if(b && b.act) b.act(); }catch(_){}
                        resolve(b ? b.value : 'cancel'); };
    ov.querySelectorAll('.pf-btn').forEach(el=>{
      el.onclick=()=>finish(btns[+el.dataset.i]);
    });
    // Clicking the backdrop closes the window and does NOTHING else. Running
    // the last button's action instead would be dangerous: on the
    // write-protected-card warning the last button is "REMOVE THE CARD", and a
    // click outside the modal would silently unload the card.
    ov.onclick=(e)=>{ if(e.target===ov){ ov.remove(); _pfPending=null; resolve('dismiss'); } };
  });
}

// ── What the buttons actually do ───────────────────────────────────────────
// A refusal that only says "fix the template" leaves the operator hunting for
// the template. These put the cursor on it.
function pfEditTemplate(token){
  const box=document.getElementById('tpl-box'); if(box) box.scrollIntoView({block:'center'});
  const raw=document.getElementById('tpl-raw');
  if(raw){
    raw.focus();
    if(token){ const i=raw.value.indexOf(token);
               if(i>=0) raw.setSelectionRange(i, i+token.length); }
  }
}
function pfChangeCounter(){
  const inp=document.getElementById('counter-input');
  if(inp){ inp.scrollIntoView({block:'center'}); inp.focus(); inp.select(); }
}
function pfShowSources(){
  const z=document.getElementById('src-zone');
  if(z){ z.scrollIntoView({block:'center'}); z.classList.add('over');
         setTimeout(()=>z.classList.remove('over'), 1200); }
}
function pfOpenFilter(){
  const d=document.getElementById('ff-details');
  if(d){ d.scrollIntoView({block:'center'});
         if(d.style.display==='none') d.style.display=''; }
}
async function startCopy(){
  flushPrefs();   // nothing typed a moment ago may be still waiting in the timer
  // `_starting` covers the window this function opens BEFORE `S.copying` is
  // set: the volume check, the counter scans and the disk-space dialog are all
  // awaited, and during those seconds the interface is otherwise fully live. A
  // second press of Start would slip past the `S.copying` test and launch a
  // parallel ingest into the same folders; a card dropped in during the scan
  // would join the run without ever being seen by the preflight. Everything
  // that refuses input during an ingest refuses it from the first click.
  if(S.copying || S._starting)return;
  S._starting=true;
  // try/finally spans the whole run: whatever path leaves this function —
  // preflight refusal, a rejected engine call, or normal completion — the
  // flag cannot stay stuck and lock the Start button for ever.
  try{
  S._batchSuppress=false;   // re-arm: a batch may have left it set
  S.recopyCanceled=false;   // and so may a cancel from the previous run

  // ── Pre-flight — refuse to start rather than lose footage ──────────────
  { const problem=preflightIngest();
    if(problem){ showRefusal(problem); return; } }

  // ── Is every volume still on the machine? ──────────────────────────────
  { const gone=await checkVolumesStillThere();
    if(gone){
      // RECHECK re-runs the volume scan and closes the window if everything is
      // back: the operator plugs the drive in and presses one button, instead
      // of closing a dialog and pressing Start again to find out.
      const answer = await showRefusal(gone);
      // startCopy() refuses to re-enter while S._starting is set, and it is set
      // for the whole of this function: calling it from here would do nothing at
      // all, and the one accented button on the window would be inert. The
      // restart is queued in S._restartWanted and run by the `finally` at the
      // end of this function, once the gate is released.
      if(answer==='recheck'){
        const still = await checkVolumesStillThere();
        if(!still){ S._restartWanted = true; return; }
        showRefusal(still);
      }
      return; } }

  // ── Verify counter is fresh (non-blocking, does not override manual value) ──
  // Counter was already auto-scanned when destination was added.
  // If still in auto mode, do one final scan to catch any copies
  // made by another tool since the destination was added.
  if(!S.counterOverride && S.dests.length>0){
    try {
      await scanCounter(false); // false = respect override state
    } catch(e){
      // This is not a remark after the fact: it is the counter safety check
      // that did not run. Starting blind can write this card onto an existing
      // one, so it is a refusal, offered with a way out.
      console.warn('Counter scan failed:', e);
      const dn = S.dests.length===1 ? (S.dests[0].name||S.dests[0].path) : 'The destinations';
      const answer = await showRefusal({ code:'PF-R11b', kind:'block',
        lead:'Nothing has been written.',
        title:[ S.dests.length===1 ? `${dn} could not be read` : 'The destinations could not be read',
                'to check the counter' ],
        cause:`ingesto could not list the destination to see which counters are already there. `+
              `Starting blind could write this card onto an existing one.`,
        action:'Check that the drive is still mounted and readable. On a network share, check the '+
               `connection.<div style="margin-top:8px;opacity:.65;font-size:12px">${esc(String(e&&e.message||e))}</div>`,
        buttons:[{ label:'RECHECK DRIVES', value:'recheck', style:'fix' },
                 { label:'CANCEL', value:'cancel', style:'ghost' }] });
      if(answer==='recheck') S._restartWanted = true;
      return;
    }
  }

  // ── Disk-space check (warning + override) ─────────────────────────────
  try {
    const sp = await checkDiskSpace();
    if(sp && !sp.ok){
      const go = await confirmDiskSpace(sp);
      if(!go) return;   // the operator chose not to force
    } else if(sp && sp.unknown && sp.unknown.length){
      const go = await warnSpaceUnknown(sp.unknown);
      if(!go) return;
    }
  } catch(e){
    // Even the check failing must reach the operator: a console.warn alone
    // is silent, and a silent check reads exactly like a check that passed.
    console.warn('Disk space check failed:', e);
    const go = await warnSpaceUnknown(S.dests.map(d=>d.name||d.path));
    if(!go) return;
  }

  // The checks above are awaited, and the template panel stays editable while
  // they run: a template emptied of {counter} during the counter scan would
  // be captured into the frozen run below, validated against a version of
  // itself that does not exist any more. One last synchronous preflight on the
  // final state closes that window — it costs nothing and reads what will
  // actually be frozen.
  { const problem=preflightIngest();
    if(problem){ showRefusal(problem); return; } }

  // ── Does any card's counter already exist in the destinations? ────────────
  // LAST, and never earlier. This check reads the counter and the template, and
  // it awaits a walk of the destinations that lasts seconds on a network share
  // while the panels are still editable: run before the disk-space dialog and
  // the final pre-flight, it would validate a template that might not exist
  // any more when the run is frozen, and the ingest would start towards a path
  // nothing had checked. Nothing may be awaited between this and the freeze
  // below.
  //
  // Checked for every card (S.counter + i), not just the first, and template-
  // aware so it still works when {counter} isn't at the front of the name.
  // Every card of the batch in ONE walk: one walk per card would freeze the
  // interface for seconds on a network destination.
  if(S.dests.length>0){
    let collision=null;
    // Locked BEFORE the walk, unlocked again if we refuse: the walk itself is
    // an await, and the template must not be editable while it is checked.
    setIngestLock(true);
    try {
      collision = await window.ingesto.checkCounterCollision(
        S.dests.map(d=>d.path),
        S.sources.map((_,i)=>S.counter+i),
        buildTplStr()
      );
    } catch(e){
      // Failing OPEN here would mean the copy goes ahead with no overwrite check
      // at all and not a word on screen: the one guard against writing into an
      // existing card's folder, silently switched off by a dropped drive.
      console.warn('Collision check failed:', e);
      setIngestLock(false);
      { const dn = S.dests.length===1 ? (S.dests[0].name||S.dests[0].path) : 'The destinations';
        const one = S.dests.length===1;
        const answer = await showRefusal({ code:'PF-R11', kind:'block',
          lead:'Nothing has been written.',
          title:[ one ? `${dn} could not` : 'The destinations could not', 'be read' ],
          cause:`ingesto could not list the destination to check whether counter `+
                `<span class="m">${esc(padCounter(S.counter))}</span> is already there. `+
                `It will not start blind: the ingest could land on an existing card.`,
          action:'Check that the drive is still mounted and readable. On a network share, check the '+
                 'connection.'+
                 `<div style="margin-top:8px;opacity:.65;font-size:12px">${esc(String(e&&e.message||e))}</div>`,
          buttons:[{ label:'RECHECK DRIVES', value:'recheck', style:'fix' },
                   { label:'CANCEL', value:'cancel', style:'ghost' }] });
        if(answer==='recheck') S._restartWanted = true;
      }
      return;
    }
    if(collision){
      setIngestLock(false);
      // This is the one case where two cards can overwrite each other, too
      // serious for a toast at the bottom of the window. It is a refusal, and
      // it gets a refusal window, with the folder named and openable.
      const folder = collision.folder || String(collision||'');
      const cnum   = padCounter(collision.counter!=null?collision.counter:S.counter);
      const dn     = collision.dest || (S.dests[0] && (S.dests[0].name||S.dests[0].path)) || 'the destination';
      const abs    = collision.absPath || '';
      const answer = await showRefusal({ code:'PF-R12', kind:'block',
        lead:'Nothing has been written.',
        title:[`Counter ${cnum} is already`, `on ${dn}`],
        cause:`The folder <span class="m">${esc(folder)}</span> is already there. Starting would write `+
              `this card into it.`,
        action:'Use another counter, or look at what is already in that folder.',
        buttons:[{ label:'CHANGE COUNTER', value:'counter', style:'fix', act:()=>pfChangeCounter() }]
          .concat(abs?[{ label:'REVEAL FOLDER', value:'reveal', act:()=>revealPath(abs) }]:[])
          .concat([{ label:'CANCEL', value:'cancel', style:'ghost' }]) });
      void answer;
      return; // Refused: the operator must change the counter.
    }
  }

  S.copying=true;updateBtn();
  window.ingesto.setPowerBlock(true);
  // The global Operator / Camera / Picture profile fields, read ONCE and read
  // HERE, above the freeze.
  //
  // Read after S.run is built, the frozen list would hold the per-card values
  // ALONE while the engine gets the per-card value or the global one. A card
  // is "customised" the moment anything on it is edited, a note included, and
  // a customised card does not receive the global fields. So: type a note on
  // the card, then fill Operator and Camera globally, and the folder on the
  // drive would carry them while the report, the phone notification and the
  // handoff document said the fields were empty.
  const globalOp  = document.getElementById('meta-cam')?.value  || '';
  const globalCam = document.getElementById('meta-model')?.value || '';
  const globalPP  = document.getElementById('meta-pp')?.value    || '';
  // ── Freeze the run ──────────────────────────────────────────────────────
  // Everything the engine and the report need is captured HERE, once. The
  // sequential (per-card) path calls the engine inside a loop; reading the
  // template, the mode or the filter live would let a change made while card 1
  // is copying silently apply to cards 2 and 3 (different folder name,
  // different copy mode, same run). The panels are locked as well, but a run must not
  // depend on a lock holding.
  S.run = {
    tpl:        buildTplStr(),
    nameRule:   nameRule(),
    mode:       S.mode,
    proAlgo:    S.proAlgo,
    proDouble:  S.proDoubleRead,
    filter:     buildFileFilterOptions(),
    base:       S.counter,
    // Frozen like the destinations: the report and the phone notification run
    // after the panels unlock, and they name folders that already exist on the
    // drive. A width changed in between would describe them wrongly.
    counterWidth: S.counterWidth,
    // The report and the notification are written AFTER the panels unlock and
    // are not awaited. Reading the live lists there would mean a drive dropped
    // in right after an ingest could receive a report listing footage it does
    // not hold, and a notification could name the wrong drive beside each result.
    dests:      S.dests.map(d => ({ path: d.path, name: d.name })),
    // The SAME fallback the engine payload uses, or the document describes a
    // folder other than the one created.
    sources:    S.sources.map(x => ({ path: x.path, name: x.name,
                                      operator: x.operator || globalOp  || '',
                                      camera:   x.camera   || globalCam || '',
                                      pp:       normPP(x.pp || globalPP),
                                      note: x.note || '' })),
    sentinel:   S.writeSentinel,
    cksum:      S.writeChecksum, cksumList: S.cksumList, cksumMhl: S.cksumMhl, ascMhl: S.ascMhl,
    // Frozen for the same reason as the destinations above: the report is
    // written after the panels unlock, and a switch flipped in the meantime
    // (by hand, or by importing a settings file) would decide what a report
    // already half-written is allowed to contain. What was set when START was pressed
    // is what the run produces.
    report: { any: S.writeReport, html: S.reportHtml, csv: S.reportCsv,
              json: S.reportJson, full: S.reportFull },
    handoff: { on: S.handoffEnabled === true, cmd: S.handoffCommand || '' },
    // Frozen for exactly the reason the handoff above is. The gear button is
    // not locked during an ingest, so Settings can be opened mid-copy: read at
    // the end, the command would be the one typed THEN, on a run started under
    // another one. The report, the notification, the handoff and the hook all
    // follow the same rule.
    hook: { on: S.hookEnabled === true, cmd: S.hookCommand || '' },
    startedAt:  Date.now(),
    // Stable name for this batch, so a handoff can be tied back to one run.
    runId:      new Date().toISOString().replace(/\.\d{3}Z$/,'Z') + '-' +
                Math.random().toString(36).slice(2, 6),
  };
  // The names this run really uses join the session list, at START and not
  // while they were typed. Kiosk goes through here too.
  rememberOperators(S.run.sources.map(x => x.operator));
  setIngestLock(true);
  // The centre column stops listing volumes and shows the transfers instead.
  tfEnter();
  renderSourceInfoCards();
  resetSpark();
  // Per-source operator/camera/profile/note, falling back to the global fields
  // read above START. The same three values the frozen list was built from.
  // Process sources one by one — skipKeys is per-source so we issue a startCopy per source
  // (the main process already loops over sources internally, but we pass per-source skipKeys
  // by issuing separate startCopy calls when needed). For simplicity, we batch all sources
  // that have no skipKeys, and isolate those that do.
  // "Copy new files only", resolved at START: re-read each card's log against the
  // destinations of this run. Only a file that a verified ingest put on one of
  // them — in a folder still there — may be skipped; the rest is copied again.
  // Re-reading here also drops a list computed for a card that has since been
  // swapped at the same mount point.
  for (const s of S.sources) {
    if (!s._skipIntent) { s._skipKeys = []; continue; }
    let keys = [], history = 0;
    try {
      const info = await window.ingesto.inspectCard(s.path, false, S.run.dests.map(d => d.path));
      keys = (info && info._skippableKeys) || [];
      history = (info && info.counts && info.counts.alreadyIngested) || 0;
    } catch (_) { keys = []; }
    s._skipKeys = keys;
    if (keys.length < history) {
      // The operator pressed "copy new files" expecting a short ingest. Telling
      // them in a toast, at the bottom of the screen, while the copy starts, is
      // not telling them. The number they were counting on has changed.
      const again = history - keys.length;
      const go = await showRefusal({ code:'PF-R19', kind:'warn',
        lead:'Nothing has been written yet.', leadKind:'warn',
        title:['Copy new files: '+again+' of '+history, 'files will be copied again'],
        cause: keys.length
          ? `Only ${keys.length} of the files already ingested from ${esc(s.name)} have a verified copy `+
            `on the destinations you selected. The others were sent somewhere else, or were not verified.`
          : `None of the previous ingests of ${esc(s.name)} went to the destinations you selected with `+
            `verification. The full card will be copied.`,
        action:'Nothing is skipped unless every selected destination already holds a verified copy.',
        buttons:[{ label:'CONTINUE', value:'go', style:'go' },
                 { label:'CANCEL', value:'cancel', style:'ghost' }] });
      if(go!=='go'){ S.copying=false; updateBtn(); setIngestLock(false);
                     window.ingesto.setPowerBlock(false); S.run=null; tfExit(); return; }
    }
  }
  const sources=S.sources.map((s,i)=>({
    ...s,
    counter:   padCounter(S.run.base+i, S.run.counterWidth),
    cameraman: s.operator || globalOp  || '',
    camera:    s.camera   || globalCam || '',
    pp:        normPP(s.pp || globalPP),
    note:      s.note     || '',
    nameRule:  S.run.nameRule,
  }));
  // Group sources by their skipKeys signature (sources without skip → one batch; sources
  // with skip → individual calls). To keep things simple here, if ANY source has skipKeys,
  // process them sequentially. Otherwise, batch all in one call.
  const anyHasSkip = sources.some(s => s._skipKeys && s._skipKeys.length);
  if (!anyHasSkip) {
    try {
    await window.ingesto.startCopy({
      sources,
      destinations: S.dests,
      options: { mode: S.run.mode, proAlgo: S.run.proAlgo, proDoubleRead: S.run.proDouble, folderTemplate: S.run.tpl, writeSentinel: S.run.sentinel, writeChecksum: S.run.cksum, cksumList: S.run.cksumList, cksumMhl: S.run.cksumMhl, ascMhl: S.run.ascMhl, fileFilter: S.run.filter }
    });
    } catch(e){
      // An engine rejection produces no 'copy-complete', so without this
      // onComplete would never run: panels locked, ring frozen mid-arc, Start
      // stuck on Cancel, for ever, with no message.
      console.error('start-copy failed', e);
      showToast('The ingest could not be completed: ' + (e && e.message ? e.message : 'unexpected error'), 'error', 8000);
      onComplete([]);
    }
  } else {
    // Sequential per-source so each can pass its own skipKeys.
    // Each start-copy invocation fires its own 'copy-complete' event; without
    // suppression, the FIRST card's completion would run the full onComplete
    // (Start re-enabled mid-batch, power-save unblocked, panels unlocked,
    // summary shown while card 2 is still writing, hook+ntfy fired per card).
    // Collect each invocation's returned results instead, and run the real
    // completion exactly once with the concatenated batch.
    // Stays true after the loop so a trailing per-card event is ignored; the
    // next startCopy() re-arms it to false at the top.
    S._batchSuppress = true;
    const batchResults = [];
    {
      for (const s of sources) {
        // Cancel pressed between two cards must not be lost: the part that has
        // just returned carries canceled:false, and the next start-copy would
        // clear the engine's cancel flag and copy the following card in full.
        if (S.recopyCanceled) break;
        let part;
        try {
        part = await window.ingesto.startCopy({
          sources: [s],
          destinations: S.dests,
          options: {
            mode: S.run.mode,
            proAlgo: S.run.proAlgo,
            proDoubleRead: S.run.proDouble,
            folderTemplate: S.run.tpl,
            skipKeys: s._skipKeys || [],
            writeSentinel: S.run.sentinel,
            writeChecksum: S.run.cksum, cksumList: S.run.cksumList, cksumMhl: S.run.cksumMhl, ascMhl: S.run.ascMhl,
            fileFilter: S.run.filter,
          }
        });
        } catch(e){
          // The engine rejected instead of completing. Report it and stop the
          // batch: swallowing this would leave the app locked in "copying"
          // for ever, refusing every card the operator drops afterwards.
          console.error('start-copy failed', e);
          showToast('The ingest could not be completed: ' + (e && e.message ? e.message : 'unexpected error'), 'error', 8000);
          break;
        }
        if (Array.isArray(part)) batchResults.push(...part);
        // Cancel must stop the whole batch: the next start-copy would reset
        // cancelCopy=false in the main process and copy the remaining cards.
        if (Array.isArray(part) && part.length && part.every(r => r && r.canceled)) break;
      }
    }
    onComplete(batchResults);   // the single, real completion for the whole batch
  }
  } finally {
    // A recovery button ("recheck the drives") must NOT call startCopy() from
    // inside this one: the inner call runs to its first await, this finally
    // then clears the flag the inner call had just set, and for the seconds
    // before S.copying is set BOTH guards are false. A second press of Start
    // would be admitted, and two engines would write into the same destination
    // folder.
    //
    // The restart is queued instead, and the gate stays SHUT until it has
    // actually begun: releasing the flag here and re-entering on a timer would
    // leave the same window open, just narrower.
    if(S._restartWanted){
      S._restartWanted=false; setIngestLock(false);
      setTimeout(()=>{ S._starting=false; startCopy(); }, 0);
    } else {
      S._starting=false;
    }
  }
}

async function doCancelCopy(){
  { const t=document.getElementById('h-title'); if(t){ t.textContent='Canceling'; t.style.color=''; } }
  const b=document.getElementById('start-btn'); b.disabled=true;
  S.recopyCanceled=true;   // also stops a retry batch between its groups
  await window.ingesto.cancelCopy();
}
async function kioskCancelCopy(){
  const b=document.getElementById('krun-cancel'); if(b) b.disabled=true;
  const p=document.getElementById('krun-phase'); if(p){ p.textContent='Canceling…'; p.style.color=''; }
  S.recopyCanceled=true;
  await window.ingesto.cancelCopy();
}
