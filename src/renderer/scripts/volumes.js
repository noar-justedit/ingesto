// ═══════════════════════════════════════════════════════
// Finder drop
// ═══════════════════════════════════════════════════════
// Track last mouse X for Finder drop zone detection
let _lastMouseX = 0;
document.addEventListener('mousemove', e => { _lastMouseX = e.clientX; });

async function onFinderDrop(filePath, clientX, forceZone){
  if(!filePath)return;
  const info=await window.ingesto.resolvePath(filePath);
  if(!info)return;
  const full = info.path || filePath;
  const entry={name:cardNameForPath(full)||info.name, path:full};
  // Use explicit zone if provided (from dropDZ), otherwise detect from mouse position
  let zone = forceZone;
  if(!zone){
    const x = (clientX !== undefined) ? clientX : _lastMouseX;
    zone = x < 264 ? 'src' : 'dst';
  }
  addToZone(zone, entry);
}

// ═══════════════════════════════════════════════════════
// Volumes
// ═══════════════════════════════════════════════════════
// Fired by the main process the instant a volume mounts/unmounts (macOS: fs.watch
// on /Volumes; Windows: cheap drive-letter polling). No manual refresh needed —
// mirrors what apps like Photo Mechanic / OffShoot do. Skipped mid-copy: an ingest
// is already hammering the disk, no need to add a volume scan on top of it: the
// next mount/unmount event (or the periodic Windows poll) will catch up once it ends.
function onVolumesChanged(){
  if (S.copying) return;
  loadVolumes(true);
}

async function loadVolumes(propose=false){
  const btn=document.getElementById('refresh-btn');
  const lbl=btn?btn.querySelector('.rfr-lbl'):null;
  if(btn){ btn.classList.add('scanning'); btn.disabled=true; if(lbl) lbl.textContent='Scanning…'; }
  const vols = await window.ingesto.getVolumes();
  S.volumes = vols;
  renderVolumes();
  if(btn){ btn.classList.remove('scanning'); btn.disabled=false; if(lbl) lbl.textContent='Refresh'; }

  const currentPaths = new Set(vols.map(v=>v.path));
  // First load = baseline, never propose
  if(!S._knownVolPaths){ S._knownVolPaths = currentPaths; return; }
  // Propose newly-appeared removable drives after a manual refresh
  if(propose && !S.copying){
    const fresh = vols.filter(v =>
      !S._knownVolPaths.has(v.path) &&
      !v.isSystem && !v.isNetwork &&                    // large filter: removable = not system/network
      !S.sources.find(x=>x.path===v.path) &&
      !S.dests.find(x=>x.path===v.path)
    );
    if(fresh.length) proposeNewVolumes(fresh);
  }
  S._knownVolPaths = currentPaths;   // update baseline (removed drives drop out; ignored ones won't re-prompt)
}

// Grouped, centered proposal (same overlay style as the info modals)
function proposeNewVolumes(vols){
  const old=document.getElementById('vol-proposal'); if(old) old.remove();
  const n=vols.length;
  const names=vols.map(v=>v.name).join(', ');
  const ov=document.createElement('div');
  ov.id='vol-proposal'; ov.className='open';
  ov.innerHTML =
    `<div class="mi-card">`+
    `<div class="mi-h">${n} new drive${n>1?'s':''} detected</div>`+
    `<div class="mi-sub">Add ${n>1?'them':'it'} as ingest source${n>1?'s':''}?</div>`+
    `<div class="mi-row" style="border-top:none;"><div class="mi-body vp-names">${esc(names)}</div></div>`+
    `<div class="vp-actions">`+
    `<button class="vp-use">Use as source${n>1?'s':''}</button>`+
    `<button class="vp-ign">Ignore</button></div>`+
    `</div>`;
  document.body.appendChild(ov);
  ov.querySelector('.vp-use').onclick=()=>{ vols.forEach(v=>addToZone('src',{name:volCardName(v),path:v.path})); ov.remove(); };
  ov.querySelector('.vp-ign').onclick=()=>ov.remove();
  ov.onclick=(e)=>{ if(e.target===ov) ov.remove(); };
}

function renderVolumes(){
  // While the Transfers view is on screen the volumes grid is hidden; a mount
  // event must not repaint it underneath.
  if(S.copying && S.centerView === 'transfers') return;
  const grid=document.getElementById('vols-grid');
  const shown=S.volumes.filter(v=>{
    if(S.filters.system&&v.isSystem)return false;
    if(S.filters.network&&v.isNetwork)return false;
    if(S.hiddenVolumes.has(v.path)&&!S.showHidden)return false;
    return true;
  });
  // "Mounted Volumes" always reflects the real, physical count — it must not
  // change when a filter (system/network/hidden) hides some of them from view.
  document.getElementById('vcnt').textContent=S.volumes.length;
  // Counts every volume currently absent from the grid, whatever the reason:
  // manually hidden, or filtered out by HIDE SYSTEM / HIDE NETWORK.
  const hiddenCount = S.volumes.length - shown.length;
  const hiddenBadge = document.getElementById('vcnt-hidden');
  if(hiddenBadge){
    hiddenBadge.style.display = hiddenCount>0 ? '' : 'none';
    hiddenBadge.textContent = hiddenCount>0 ? (hiddenCount+' hidden') : '';
  }
  if(!shown.length){
    grid.innerHTML=`<div class="empty"><div class="empty-ico" style="opacity:1;color:var(--red);"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20"/><path d="M8.35 2.69A10 10 0 0 1 21.3 15.65"/><path d="M19.08 19.08A10 10 0 1 1 4.92 4.92"/></svg></div><div class="empty-txt">No volumes found</div></div>`;
    return;
  }
  grid.innerHTML=shown.map((v,i)=>{
    const pct=v.totalSize>0?Math.min(100,v.usedSize/v.totalSize*100).toFixed(0):0;
    const srcIdx=S.sources.findIndex(x=>x.path===v.path);
    const dstIdx=S.dests.findIndex(x=>x.path===v.path);
    const isSrc=srcIdx>=0, isDst=dstIdx>=0;
    const isHidden=S.hiddenVolumes.has(v.path);
    const tagH=isSrc?`<div class="vc-tag tag-src">SRC${srcIdx+1}</div>`:isDst?`<div class="vc-tag tag-dst">DST${dstIdx+1}</div>`:isHidden?'<div class="vc-tag tag-hidden">HIDDEN</div>':'';
    const camBrand = (v.camera?.brand||'').toUpperCase();
    const camSameAsBrand = v.camera?.model && v.camera.model.toLowerCase() === (v.camera.brand||'').toLowerCase();
    const camH = v.camera && v.camera.model
      ? `<div class="vc-cam">${camSameAsBrand ? esc(camBrand) : `${esc(camBrand)} ${esc(v.camera.model)}`}</div>` : '';
    // SECURITY: the volume path is NEVER interpolated into an inline handler
    // (it comes from an attacker-controllable volume label). The card only
    // carries an index; the real path is bound below via addEventListener, so a
    // hostile name like `a');runHook(...)//` is just text, never code.
    return`<div class="vc${isHidden?' vc-hidden':''}" draggable="true" data-vi="${i}">
      ${tagH}
      <div class="vc-icon">${getVolIcon(v, isSrc, isDst)}</div>
      <div class="vc-name">${esc(v.name)}</div>
      ${camH}
      <div class="vc-meta">${fmtSize(v.freeSize)} free</div>
      <div class="vc-bar"><div class="vc-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  // Bind handlers with the path captured in a closure — no inline JS, no
  // interpolation of untrusted strings into markup.
  const isWin = window.ingesto.platform==='win32';
  grid.querySelectorAll('.vc').forEach(el => {
    const v = shown[parseInt(el.getAttribute('data-vi'),10)];
    if (!v) return;
    const p = v.path;
    el.addEventListener('dragstart', e => startVolDrag(e, p));
    el.addEventListener('dragend',   e => endVolDrag(e));
    el.addEventListener('contextmenu', e => winVolMenu(e, p));
    if (isWin) el.addEventListener('click', e => winVolClick(e, p));
  });
}

function toggleFilter(t){
  S.filters[t]=!S.filters[t];
  document.getElementById(`fb-${t}`).classList.toggle('on',S.filters[t]);
  renderVolumes();
}

const ICO_EYE='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const ICO_EYE_OFF='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
function toggleShowHidden(){
  S.showHidden=!S.showHidden;
  const btn=document.getElementById('fb-showhidden');
  btn.classList.toggle('on',S.showHidden);
  btn.innerHTML = S.showHidden ? ICO_EYE : ICO_EYE_OFF;
  renderVolumes();
}
function hideVolume(p){
  S.hiddenVolumes.add(p);
  renderVolumes();
}
function unhideVolume(p){
  S.hiddenVolumes.delete(p);
  renderVolumes();
}

// ═══════════════════════════════════════════════════════
// Drag volumes
// ═══════════════════════════════════════════════════════
function startVolDrag(e,p){
  S.dragVol=p;e.dataTransfer.effectAllowed='copy';
  e.dataTransfer.setData('text/plain',p);e.dataTransfer.setData('application/x-ingesto-vol','1');e.currentTarget.classList.add('dragging');
}
function endVolDrag(e){e.currentTarget.classList.remove('dragging');setTimeout(()=>{S.dragVol=null;},100);}

// ═══════════════════════════════════════════════════════
// Drop zones
// ═══════════════════════════════════════════════════════
// ── Windows volume click handlers ─────────────────────────────────
function winVolClick(e,p){
  e.preventDefault();
  e.stopPropagation();
  winVolMenu(e,p);
}

function winVolMenu(e,p){
  e.preventDefault();
  e.stopPropagation();
  const vol=S.volumes.find(v=>v.path===p);
  if(!vol) return;
  document.getElementById('win-vol-dialog')?.remove();
  document.getElementById('win-vol-ctx')?.remove();
  const m=document.createElement('div');
  m.id='win-vol-ctx';
  m.className='win-vol-ctx';
  const isSrc=S.sources.some(x=>x.path===p);
  const isDst=S.dests.some(x=>x.path===p);
  const item=(cls,label,onclick)=>{ const el=document.createElement('div'); el.className='wvc-item '+cls; el.textContent=label; el.onclick=()=>{ onclick(); m.remove(); }; return el; };
  if(isSrc){
    m.appendChild(item('wvc-src wvc-unload','Unload as SOURCE', ()=>removeFromZone('src',p)));
  } else {
    m.appendChild(item('wvc-src','Set as SOURCE', ()=>winVolAdd(p,'src')));
  }
  if(isDst){
    m.appendChild(item('wvc-dst wvc-unload','Unload as DESTINATION', ()=>removeFromZone('dst',p)));
  } else {
    m.appendChild(item('wvc-dst','Set as DESTINATION', ()=>winVolAdd(p,'dst')));
  }
  // Hiding a volume that's currently in use as source/destination would be confusing — offer it only otherwise.
  if(!isSrc && !isDst){
    const isHidden=S.hiddenVolumes.has(p);
    const i3=document.createElement('div'); i3.className='wvc-item wvc-hide';
    const eyeSvg=isHidden
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
    i3.innerHTML=`<span style="display:inline-flex;align-items:center;gap:8px;">${eyeSvg}${isHidden?'Show Volume':'Hide Volume'}</span>`;
    i3.onclick=()=>{ isHidden?unhideVolume(p):hideVolume(p); m.remove(); };
    m.appendChild(i3);
  }
  // ── Eject ────────────────────────────────────────────────────────────────
  // Offered for anything that isn't the system disk or a network share. The
  // item is created immediately (the menu is built synchronously) and only
  // enabled once the main process confirms the volume is really ejectable —
  // an unmount attempt on a fixed internal disk would just fail confusingly.
  if(!vol.isSystem && !vol.isNetwork){
    const ej=document.createElement('div');
    ej.className='wvc-item wvc-eject wvc-disabled';
    ej.innerHTML=`<span style="display:inline-flex;align-items:center;gap:8px;">${ICO_EJECT}Checking…</span>`;
    m.appendChild(ej);
    window.ingesto.isRemovable(p).then(removable=>{
      if(!m.isConnected) return;               // menu already dismissed
      // An external drive that reports "not removable" is still ejectable on
      // macOS, and a card that carries a camera structure obviously is.
      const ejectable = removable || vol.fsType==='sdcard' || vol.fsType==='usb'
                     || vol.fsType==='ssd' || vol.fsType==='external' || !!vol.camera;
      if(!ejectable){ ej.remove(); return; }
      ej.classList.remove('wvc-disabled');
      ej.innerHTML=`<span style="display:inline-flex;align-items:center;gap:8px;">${ICO_EJECT}Eject</span>`;
      ej.onclick=()=>{ m.remove(); ejectVolumeFromMenu(p, vol.name); };
    }).catch(()=>{ if(m.isConnected) ej.remove(); });
  }
  const mw=190, x=Math.min(e.clientX, window.innerWidth-mw-6), y=Math.min(e.clientY, window.innerHeight-130);
  m.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;z-index:3000;';
  document.body.appendChild(m);
  setTimeout(()=>document.addEventListener('click',function h(ev){
    if(!m.contains(ev.target)){ m.remove(); document.removeEventListener('click',h); }
  }),50);
}

const ICO_EJECT='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a1 1 0 0 1-.72-1.695l7.257-7.668a2 2 0 0 1 2.926 0l7.256 7.668A1 1 0 0 1 20 13z"/><rect x="3" y="17" width="18" height="4" rx="1"/></svg>';

// Eject a volume straight from the volume list. Two hard rules:
//  1. never during an ingest — pulling a source or destination mid-write is
//     exactly how footage gets lost;
//  2. if the volume is loaded as SOURCE or DESTINATION, drop it from that zone
//     first, otherwise the app would keep pointing at a path that no longer
//     exists (and a later Start would fail in confusing ways).
async function ejectVolumeFromMenu(p, label){
  // S._starting covers the seconds between START and the first byte: the
  // counter scan and the free-space check both await, and on a network share
  // they take long enough to eject a drive in between. Removing a destination
  // is refused for that window, and so is ejecting one: otherwise the ingest
  // would start against a path that had just gone away.
  if(S.copying || S._starting){
    showToast('An ingest is running. Nothing can be ejected while copying.','warn',4000);
    return;
  }
  const name = label || p;
  showToast(`Ejecting ${name}…`,'info',2000);
  let res=null;
  try{ res=await window.ingesto.ejectVolume(p); }catch(e){ res={ok:false,error:e&&e.message}; }
  if(res && res.ok){
    // Unload AFTER a confirmed eject: a failed attempt must not cost the user
    // their source/destination assignment for nothing.
    const wasSrc=S.sources.some(x=>x.path===p);
    const wasDst=S.dests.some(x=>x.path===p);
    if(wasSrc) removeFromZone('src',p);
    if(wasDst) removeFromZone('dst',p);
    S.hiddenVolumes.delete(p);
    const unloaded = wasSrc && wasDst ? ' (unloaded from SOURCE and DESTINATION)'
                   : wasSrc ? ' (unloaded from SOURCE)'
                   : wasDst ? ' (unloaded from DESTINATION)' : '';
    showToast(`${name} ejected. Safe to remove.${unloaded}`,'ok',3500);
  } else {
    const why = (res && res.error) ? ` (${res.error})` : '';
    showToast(`Could not eject ${name}${why}. A file may still be open. Eject it from the Finder.`,'warn',5000);
  }
  loadVolumes();   // refresh the list either way
}

// The name a volume carries once it is LOADED as a card or a destination.
// The volume list shows "LUMIX (D:)" so two identical cards in two readers can
// be told apart; what goes into {cardname}, the ingest report and the phone is
// the bare label — "LUMIX". Windows is where the two differ; elsewhere they are
// the same string.
function volCardName(v){ return (v && (v.label || v.name)) || ''; }

// The card name for a PATH, whatever route it arrived by — the volume list, a
// drag from Explorer, the Browse button, kiosk mode. EVERY route must ask this,
// or the ones that don't fall back to the path itself: on Windows "D:\"
// becomes the card name "D:", which the folder-name cleaner turns into "D_".
// Kiosk mode is one of those routes, and there Browse is the only way to load
// a card.
function cardNameForPath(p){
  const v = S.volumes.find(x => x.path === p);
  return v ? volCardName(v) : pathToName(p);
}

function winVolAdd(p,z){
  const vol=S.volumes.find(v=>v.path===p);
  if(!vol) return;
  addToZone(z,{name:volCardName(vol), path:p});
}


function onDZ(e,z){e.preventDefault();document.getElementById(`${z}-zone`).classList.add('over');}
function offDZ(e,z){document.getElementById(`${z}-zone`).classList.remove('over');}
function dropDZ(e,z){
  e.preventDefault();
  document.getElementById(`${z}-zone`).classList.remove('over');
  const p=e.dataTransfer.getData('text/plain')||S.dragVol;
  if(!p)return;
  addToZone(z,{name:cardNameForPath(p), path:p});
  S.dragVol=null;
}

async function browseFolder(z){
  const fp=await window.ingesto.browseFolder();
  if(!fp)return;
  addToZone(z,{name:cardNameForPath(fp),path:fp});
}

// Extract last meaningful segment from any path (Windows \ or Unix /)
function pathToName(p){
  const clean = (p||'').replace(/[\/\\]+$/, ''); // strip trailing slashes
  const seg   = clean.split(/[\/\\]/).pop();     // last segment
  return seg || clean || p;
}

// Said once, when the card is loaded: what a copy from a volume produced on
// read (HDE, by name or by the mount table, see check-paths) can and cannot
// prove.
function warnHdeSource(entry){
  if (entry) { if (entry._virtualWarned) return; entry._virtualWarned = true; }
  showRefusal({ code:'HDE', kind:'info',
    title:['This card is a','virtual volume'],
    lead:'A program produces its files while they are read, as CODEX Platform does for HDE.', leadKind:'info',
    cause:'ingesto can only compare the copies with what this volume delivers, not with the card itself. '+
          'Sizes are only known once each file is copied, and the card re-read (PRO) is off for this card.',
    action:'With HDE, clips in other formats (ProRes) can stay on another volume of the same card: load it too if it holds any.',
    buttons:[{ label:'GOT IT', value:'ok' }] });
}
function addToZone(z,entry){
  // An ingest works from the list frozen when it started: anything added now
  // would sit in the column looking loaded, never be copied, and throw the
  // "cards left" count off. Refusing is the only honest answer until the job
  // queue exists.
  if(S.copying || S._starting){
    // Blue, not red: nothing is wrong, something is simply in progress. And it
    // must never say "nothing has been written", because writing is exactly
    // what is happening.
    showRefusal({ code:'PF-R17', kind:'busy',
      lead:'Your ingest is not affected.', leadKind:'info',
      title: z==='src' ? ['This card was not','added'] : ['This destination was not','added'],
      cause:'An ingest is running. The '+(z==='src'?'card':'destination')+' list is frozen until it '+
            'finishes, so that nothing added halfway can reach a copy already in flight.',
      action:'Load it when the current ingest is done.',
      buttons:[{ label:'GOT IT', value:'ok' }] });
    return;
  }
  const arr=z==='src'?S.sources:S.dests;
  if(arr.find(x=>x.path===entry.path))return;
  // Refuse the assignment straight away when it would make a volume both the
  // source and the destination (or nest one inside the other).
  { const other = z==='src' ? S.dests : S.sources;
    const clash = other.find(o => pathContains(o.path, entry.path) || pathContains(entry.path, o.path));
    if(clash){
      showToast(`⚠ "${entry.name||entry.path}" is already used as ${z==='src'?'a DESTINATION':'a SOURCE'}.
A card cannot be copied into itself.`, 'error');
      return;
    } }
  if(z==='src'){
    // Pre-fill per-card fields from global defaults
    entry.operator = document.getElementById('meta-cam')?.value   || '';
    entry.camera   = document.getElementById('meta-model')?.value || '';
    entry.pp       = document.getElementById('meta-pp')?.value    || '';
    entry.note     = document.getElementById('meta-note')?.value  || '';
    entry._open    = true;  // auto-expand so user sees the fields immediately
    entry._customised = false;
    // Kiosk is single-card: a source accepted from the new-volume proposal
    // (whose overlay sits above the kiosk screen) replaces the previous one and
    // the kiosk panel is refreshed — otherwise the card loads invisibly while
    // the screen still shows "Browse a card…".
    if(S.kioskMode){
      S.sources.length=0;
    }
  }
  arr.push(entry);
  // Remember what this volume WAS, so that a card swapped for another at the
  // same mount point is caught before the ingest starts. Deliberately not the
  // device number: macOS hands out a new one every time a volume is mounted, so
  // an unplug-and-replug of the SAME drive would look like a different one.
  try{
    window.ingesto.checkPaths([{ path: entry.path }])
      .then(r => {
        if(r && r[0] && r[0].ok){ entry._isMount = r[0].isMount; entry._total = r[0].total; }
        // A volume produced on read whatever its name (CODEX Platform on
        // ALEXA LF media keeps the card's name). Only a card, only once.
        if(z==='src' && r && r[0] && r[0].virtual === true){ entry._virtual = true; warnHdeSource(entry); }
      })
      .catch(()=>{});
  }catch(_){}
  renderZoneList(z);
  renderVolumes();
  updateBtn();
  if(z==='src'){ renderSourceInfoCards(); updateCopyInfoVisibility(); }
  if(z==='dst'){ scanCounter(false); refreshSessionLog(); }
  // Keep the kiosk panel in sync when a card is added while locked.
  if(S.kioskMode && z==='src' && typeof renderKioskSource==='function'){
    try{ renderKioskSource(); kioskUpdateStart(); }catch(_){}
  }
  // ── Camera auto-detection + sentinel inspection ────────────────────────
  if (z === 'src') {
    onSourceAdded(entry).catch(err => console.error('onSourceAdded error:', err));
    if (isHdeSource(entry.path)) warnHdeSource(entry);
  }
}

// Runs camera detection + sentinel check on a newly added source.
// Updates the source entry in place when the user is still editing it.
async function onSourceAdded(entry) {
  // An HDE volume is a view produced by CODEX Platform (ex Device Manager): it is not
  // browsed for a camera, and the card log is never read or written there.
  if (isHdeSource(entry.path)) return;
  // 1. Camera auto-detection (fast — local fs scan, no I/O on file contents
  //    for most cameras except a small header read).
  try {
    const cam = await window.ingesto.detectCamera(entry.path);
    if (cam && cam.model) {
      // Write the detected model unless the user has manually typed in this card's
      // camera field. The field is pre-filled from the (stale) global default, so
      // testing "is it empty" would skip detection whenever a previous card's value
      // was pre-filled, and drop the detection silently (a GoPro after a Panasonic).
      if (!entry._customised) {
        entry.camera = (cam.model||'').replace(/[^A-Za-z0-9]/g,'');
        entry._camDetected = true;
        // The next card starts from what this one really is.
        { const g = document.getElementById('meta-model'); if (g && entry.camera) { g.value = entry.camera; persistPrefs(); } }
        // Update the corresponding input if the source card is rendered
        renderSourceInfoCards();
        // The kiosk is told of every detection, not only those from its own Browse
        // button: otherwise a card inserted or dropped while locked shows no camera
        // and no mark.
        if (S.kioskMode && S.sources[0] === entry) {
          const kc = document.getElementById('k-cam');
          if (kc && !kc._typed) { kc.value = entry.camera; kioskCamMark('A'); }
          try { renderKioskSource(); } catch(_) {}
        }
      }
    }
  } catch (_) {}
  // 2. Sentinel inspection — ONLY when the user has opted in (otherwise ingesto
  //    touches the card in no way: no read of the log, no write probe).
  if (!S.writeSentinel) return;
  try {
    const info = await window.ingesto.inspectCard(entry.path, true); // probeWrite = true
    // A later successful inspection clears the mark, so it does not stay for
    // the life of the entry.
    if (entry._inspectFailed) { entry._inspectFailed = null; try{ renderZoneList('src'); }catch(_){} }
    if (!info) return;
    // Physical write-protect (e.g. SD lock switch): can't write the log → warn, keep going.
    if (info.writable === false) {
      // Orange, and the reassuring line comes first: the copy is unaffected,
      // only the tracking log is. CANCEL takes the card back out, because a
      // warning whose only button says "ok" is a toast with extra steps.
      showRefusal({ code:'PF-R18', kind:'warn',
        lead:'Your footage is not affected.',
        title:[`${entry.name} is`, 'write-protected'],
        cause:'ingesto cannot write its tracking log on the card, so it will not be able to tell you '+
              'later which files were already copied.',
        action:'The copy itself works normally. Unlock the card if you want the tracking.',
        buttons:[{ label:'CONTINUE', value:'go', style:'go' },
                 { label:'REMOVE THE CARD', value:'cancel', style:'ghost',
                   act:()=>removeFromZone('src', entry.path) }] });
    }
    // A tracking log that exists but can no longer be read: say so, rather than
    // silently treating the card as never ingested.
    if (info.sentinelDamaged) {
      showToast(`Card "${entry.name}" has a tracking log ingesto cannot read, so it cannot tell you which files were already copied. The copy itself is unaffected.`, 'warn', 7000);
    }
    // Already-ingested detection
    if (info.hasSentinel && info.counts.alreadyIngested > 0) {
      showUnformattedCardDialog(entry, info);
    }
  } catch (e) {
    // Staying silent would read as "this card is new": the "card has not
    // been formatted" window simply never opens. A dot on the
    // card in the source list, and a tooltip that says what ingesto could not
    // check, so the operator is not deciding on an assumption.
    console.error('inspectCard error:', e);
    entry._inspectFailed = "ingesto could not read this card's tracking log, so it cannot tell you "
                         + 'whether it was already ingested.';
    try{ renderZoneList('src'); }catch(_){}
  }
}
// Index-based removal — used by rendered buttons so a volume PATH (which can
// contain attacker-controlled characters) is never interpolated into markup.
function removeZoneAt(z,i){
  const arr = z==='src' ? S.sources : S.dests;
  const e = arr[i];
  if(e) removeFromZone(z, e.path);
}
function removeFromZone(z,p){
  // Symmetrical with addToZone: the engine works from the list frozen at
  // START, so removing an entry now would only desync what is on screen from
  // what is actually being written.
  if(S.copying || S._starting){
    showToast(z==='src'
      ? 'An ingest is running. This card cannot be removed until it completes.'
      : 'An ingest is running. This destination cannot be removed until it completes.',
      'warn', 5000);
    return;
  }
  if(z==='src') S.sources=S.sources.filter(x=>x.path!==p);
  else          S.dests  =S.dests.filter(x=>x.path!==p);
  renderZoneList(z);renderVolumes();updateBtn();
  if(z==='src'){ renderSourceInfoCards(); updateCopyInfoVisibility(); }
  if(z==='dst'){ scanCounter(false); refreshSessionLog(); }
}

function renderZoneList(z){
  // Rows redrawn during an ingest must come back locked.
  setTimeout(applyIngestLock,0);
  const arr=z==='src'?S.sources:S.dests;
  const list=document.getElementById(`${z}-list`);
  const zone=document.getElementById(`${z}-zone`); if(zone) zone.classList.toggle('dz-empty', !arr.length);   // not 'empty': a generic .empty rule exists
  if(!arr.length){list.innerHTML='';return;}
  const tag=z==='src'?'SRC':'DST';
  list.innerHTML=arr.map((e,i)=>{
    const icon=z==='src'?`<div class="zi-icon">${getZoneIcon(z)}</div>`:'';
    return`<div class="zi zi-${z}">
      ${icon}
      <div class="zi-badge">${tag}${i+1}</div>
      <div class="zi-info">
        <div class="zi-name">${esc(e.name)}${e._inspectFailed?`<span class="zi-dot" title="${esc(e._inspectFailed)}">?</span>`:''}</div>
        <div class="zi-path">${esc(e.path)}</div>
        ${z==='dst'?destFolderLines():''}
      </div>
      <button class="zi-rm" aria-label="Remove ${z==='src'?'card':'destination'} ${esc(e.name)}" title="Remove">×</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.zi-rm').forEach((b, i) => { b.onclick = function(){ removeZoneAt(z, i); }; });
}
// The folders this batch will write, listed under the drive that will hold
// them, under every destination and not in a box of its own: the question it
// answers ("what am I about to create, and where") belongs beside the drive.
// Past three cards the list shows the first two and a count, otherwise a batch
// of twelve pushes the template out of the window.
function destFolderLines(){
  // With no card loaded there is nothing to announce. Falling back to a pretend
  // card would print "001_A001_..." in green under the real path, which reads
  // as a folder that is about to exist.
  if (!S.sources.length) return '';
  const srcs = S.sources;
  const all = srcs.map((src, i) => (folderPathFromTemplate(src, i) || []).join('/'));
  const shown = all.length > 3 ? all.slice(0, 2) : all;
  let h = shown.map(f => `<div class="zi-folder">${esc(f || '-')}</div>`).join('');
  if (all.length > shown.length){
    const n = all.length - shown.length;
    h += `<div class="zi-more">and ${n} more card${n>1?'s':''}</div>`;
  }
  return h;
}
