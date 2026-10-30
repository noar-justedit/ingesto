// ══════════════════════════ KIOSK MODE ══════════════════════════
function applyKioskMode(){
  const ov=document.getElementById('kiosk-ov');
  if(!ov) return;
  if(S.kioskMode){
    ov.classList.add('on');
    document.getElementById('k-op').value  = document.getElementById('meta-cam')?.value||'';
    document.getElementById('k-cam').value = document.getElementById('meta-model')?.value||'';
    document.getElementById('k-pp').value  = document.getElementById('meta-pp')?.value||'';
    document.getElementById('k-note').value= '';
    renderKioskSource();
    kioskUpdateStart();
    renderKioskCounter();
  } else {
    ov.classList.remove('on');
    // Kiosk mode changes S.sources on its own (next card, remove card) without
    // drawing the main window. Leaving it without a redraw would show a card
    // that is not loaded any more, and START enabled for an ingest of nothing.
    try{ renderZoneList('src'); renderZoneList('dst'); renderSourceInfoCards(); updateBtn(); }catch(e){ console.error('kiosk exit', e); }
  }
}
function renderKioskCounter(){
  const el=document.getElementById('k-cardno');
  if(el) el.textContent = 'CARD '+padCounter(S.counter||1);
}
// ── Disk-space check (both modes) ──
async function checkDiskSpace(){
  let need=0;
  for(const s of S.sources){
    // The size is measured here anyway: keep it, the queue ring weights each
    // card by its bytes rather than treating them all as equal.
    try{ const sz=await window.ingesto.folderSize(s.path); if(typeof sz==='number'){ need+=sz; s._bytes=sz; } }catch(_){}
  }
  if(need<=0) return {ok:true};
  // A drive that does not answer is NOT a drive with room. The absence of a
  // warning reads as "there is space", so the unknown has to be said.
  const unknown=[];
  for(const d of S.dests){
    let info=null;
    try{ info=await window.ingesto.diskFree(d.path); }catch(_){}
    if(!info || typeof info.free!=='number'){ unknown.push(d.name||d.path); continue; }
    if(need>info.free) return {ok:false, dest:d, need, free:info.free};
  }
  if(unknown.length) return {ok:true, unknown};
  return {ok:true};
}
// Not a refusal: the ingest CAN start, and the operator owns the decision. So
// it is orange, the constant line gains its "yet", and the button that goes
// ahead is orange too.
async function confirmDiskSpace(sp){
  const dn = sp.dest.name || sp.dest.path;
  const m = x => `<span class="m">${esc(x)}</span>`;
  const answer = await showRefusal({ code:'PF-R13', kind:'warn',
    lead:'Nothing has been written yet.', leadKind:'warn',
    title:[`${dn} has less free space`, 'than this ingest needs'],
    cause:`It needs ${m(fmtSize(sp.need))}, the drive has ${m(fmtSize(sp.free))} free. `+
          `The copy would stop before the end.`,
    action:'Free some space, choose another drive, or start anyway and re-copy what fails.',
    buttons:[{ label:'CONTINUE ANYWAY', value:'go', style:'go' },
             { label:'CANCEL', value:'cancel', style:'ghost' }] });
  return answer==='go';
}
// The space check itself could not run. It must be said, not just logged with
// a console.warn: the absence of a warning reads as "there is room".
async function warnSpaceUnknown(dests){
  const answer = await showRefusal({ code:'PF-R13b', kind:'warn',
    lead:'Nothing has been written yet.', leadKind:'warn',
    title:['Free space could not be checked', dests.length===1 ? `on ${dests[0]}` : 'on the destinations'],
    cause:'ingesto asked the drive how much room is left and got no answer, so it cannot tell you '+
          'whether this ingest fits. The copy may stop before the end.',
    action:'Check the drive yourself, or start anyway and re-copy what fails.',
    buttons:[{ label:'CONTINUE ANYWAY', value:'go', style:'go' },
             { label:'CANCEL', value:'cancel', style:'ghost' }] });
  return answer==='go';
}
// Kiosk is a state the STATION is in, chosen between ingests. Entered during
// one, its overlay covers the transfer that is still running behind it, and
// the kiosk screen, which knows nothing about that run, offers its own START.
function kioskBusy(){
  if(!(S.copying || S._starting)) return false;
  showToast('The ingest is still running. Wait for it to finish before switching to kiosk mode.', 'warn', 5000);
  return true;
}
function enterKiosk(){
  if(kioskBusy()) return;
  if(!S.kioskPin){ kioskOpenPin('set'); return; }   // force a PIN before locking down
  S.kioskMode=true; persistPrefs(); applyKioskMode();
}
function kioskRequestAdmin(){ kioskOpenPin('enter'); }

let _kp={mode:'enter', buf:'', first:''};
let _kpFails=0, _kpLock=0;   // wrong-PIN counter + lockout-until timestamp
function kioskOpenPin(mode){
  _kp={mode, buf:'', first:''};
  document.getElementById('kp-title').textContent = mode==='set' ? 'Set a 4-digit PIN' : 'Enter PIN';
  // Stating it plainly on the screen that sets it: nobody should discover this
  // by being locked out, and nobody should expect the PIN to still be there
  // tomorrow.
  const sub=document.getElementById('kp-sub');
  if(sub) sub.textContent = mode==='set'
    ? 'For this session only. Quitting ingesto leaves kiosk mode and clears the PIN.'
    : 'Forgotten it? Quit and reopen ingesto, that leaves kiosk mode.';
  document.getElementById('kp-err').textContent='';
  kioskPinRender();
  document.getElementById('kiosk-pin-ov').classList.add('on');
}
function kioskPinCancel(){ document.getElementById('kiosk-pin-ov').classList.remove('on'); }
function kioskPinDel(){ _kp.buf=_kp.buf.slice(0,-1); kioskPinRender(); }
function kioskPinRender(){
  document.querySelectorAll('#kp-dots span').forEach((d,i)=>d.classList.toggle('on', i<_kp.buf.length));
}
function kioskPinKey(d){
  if(_kp.buf.length>=4) return;
  _kp.buf+=d; kioskPinRender();
  if(_kp.buf.length===4) setTimeout(kioskPinComplete,120);
}
function kioskPinComplete(){
  const err=document.getElementById('kp-err');
  if(_kp.mode==='set'){
    if(!_kp.first){ _kp.first=_kp.buf; _kp.buf=''; document.getElementById('kp-title').textContent='Confirm PIN'; kioskPinRender(); return; }
    if(_kp.buf===_kp.first){
      S.kioskPin=_kp.first; kioskPinCancel();
      // An ingest can have been started while the PIN was being typed.
      if(kioskBusy()) return;
      S.kioskMode=true; persistPrefs(); applyKioskMode();
    } else {
      err.textContent='PIN mismatch. Start again'; _kp={mode:'set',buf:'',first:''};
      document.getElementById('kp-title').textContent='Set a 4-digit PIN'; kioskPinRender();
    }
  } else {
    // Rate-limit wrong PINs so the 4-digit space can't just be walked through.
    if(_kpLock && Date.now()<_kpLock){ err.textContent='Too many attempts. Wait a moment'; _kp.buf=''; kioskPinRender(); return; }
    if(_kp.buf===S.kioskPin){ _kpFails=0; kioskPinCancel(); S.kioskMode=false; persistPrefs(); applyKioskMode(); }
    else {
      _kpFails++;
      if(_kpFails>=5){ _kpLock=Date.now()+30000; _kpFails=0; err.textContent='Too many attempts. Locked for 30s'; }
      else err.textContent='Wrong PIN';
      _kp.buf=''; kioskPinRender();
    }
  }
}
async function kioskBrowse(){
  const fp=await window.ingesto.browseFolder();
  if(!fp) return;
  S.sources=[];                       // single card at a time in kiosk
  addToZone('src',{path:fp,name:cardNameForPath(fp)});
  try{
    const cam=isHdeSource(fp) ? null : await window.ingesto.detectCamera(fp);
    const camModel=(cam && cam.model) ? cam.model.replace(/[^A-Za-z0-9]/g,'') : '';
    if(camModel){ if(S.sources[0]) S.sources[0].camera=camModel; document.getElementById('k-cam').value=camModel; kioskCamMark('A'); }
    else   { kioskCamMark(''); }
  }catch(_){}
  renderKioskSource();
  kioskUpdateStart();
}
// The kiosk says where the camera model came from the way the standard window
// does: a green (A) when it was read off the card, a grey (M) once typed over.
function kioskCamMark(k){
  const el = document.getElementById('k-cam-auto'); if(!el) return;
  el.innerHTML = k === 'A' ? MARK_A : k === 'M' ? MARK_M : '';
  if(k !== 'M'){ const kc = document.getElementById('k-cam'); if(kc) kc._typed = false; }
}
function kioskCamTyped(){
  const kc = document.getElementById('k-cam'); if(kc) kc._typed = true;
  const el = document.getElementById('k-cam-auto');
  if(el && el.innerHTML) el.innerHTML = MARK_M;
}
function kioskRemoveSource(){ S.sources=[]; renderVolumes(); renderKioskSource(); kioskUpdateStart(); }
function renderKioskSource(){
  const el=document.getElementById('k-source'); if(!el) return;
  const s=S.sources[0];
  if(!s){
    el.innerHTML='<div class="k-browse"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6h10V4"/></svg>Browse a card…</div>';
    el.querySelector('.k-browse').onclick = function(){ kioskBrowse(); };
    return;
  }
  const camStr = (s.camera && typeof s.camera==='object') ? (s.camera.model||'') : (s.camera||'');
  const cam = camStr ? `<span class="kl-badge">${esc(camStr)}</span>` : '';
  el.innerHTML=`<div class="k-loaded"><svg class="kl-ico" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v6h10V4"/></svg><div class="kl-main"><div class="kl-name">${esc(s.name)}</div><div class="kl-meta">selected</div></div>${cam}<button class="kl-x">✕</button></div>`;
  el.querySelector('.kl-x').onclick = function(){ kioskRemoveSource(); };
}
function kioskUpdateStart(){
  const b=document.getElementById('k-start'); if(!b) return;
  b.disabled = !(S.sources.length>0 && document.getElementById('k-op').value.trim().length>0);
}
async function kioskStart(){
  // Nothing is threatened here, and the shooter in a kiosk cannot fix it. The
  // message says who can, instead of raising the alarm reserved for rushes.
  if(!S.dests.length){
    kioskShowResult('stop','Not set up yet','No destination has been chosen.',
                    'Ask the person who set up this station.');
    return; }
  // The same rule as the standard window, applied again here rather than
  // trusted from the field: a value restored, pasted or set by script must not
  // put a space (or a slash) into a folder name that the engine only flattens.
  const clean = x => String(x==null?'':x).replace(/[^A-Za-z0-9]/g,'');
  const op=clean(document.getElementById('k-op').value);
  const cam=clean(document.getElementById('k-cam').value);
  const pp=normPP(document.getElementById('k-pp').value);
  const note=document.getElementById('k-note').value.trim();
  document.getElementById('meta-cam').value=op;
  document.getElementById('meta-model').value=cam;
  { const mp=document.getElementById('meta-pp'); if(mp) mp.value=pp; }
  document.getElementById('meta-note').value=note;
  if(S.sources[0]){ S.sources[0].operator=op; S.sources[0].camera=cam||S.sources[0].camera; S.sources[0].pp=pp; S.sources[0].note=note; S.sources[0]._customised=true; }
  { const b=document.getElementById('krun-cancel'); if(b) b.disabled=false; }
  await startCopy();
}
function kioskProgress(d){
  document.getElementById('kiosk-run-ov').classList.add('on');
  // The ring follows the WHOLE queue, like the one in the header. Computed from
  // the current card only, with several cards it would fill up, go back to
  // zero, fill up again, and someone watching from across the room would read
  // that as the ingest restarting.
  let f;
  if(S.tf){ f = tfGlobal().frac; }
  else {
    const three=(S.mode===MODE.PRO&&S.proDoubleRead), hasV=S.mode!==MODE.FAST;
    if(three) f = d.phase==='verify' ? (1/3+d.progress*2/3) : d.progress/3;
    else      f = d.phase==='verify' ? (hasV?0.5+d.progress*0.5:1) : (hasV?d.progress*0.5:d.progress);
  }
  const phase = d.phase==='verify' ? (d.pass==='source'?'Card re-read…':'Verifying…') : 'Copying…';
  const phaseCol = d.phase==='verify' ? (d.pass==='source'?'var(--pro)':'var(--blue)') : 'var(--green)';
  { const kp=document.getElementById('krun-phase'); kp.textContent=phase; kp.style.color=phaseCol; }
  const RING_C = 502.65; // 2 * PI * r(80)
  const ring=document.getElementById('krun-ring');
  ring.style.strokeDashoffset = (RING_C * (1 - f)).toFixed(1);
  ring.style.stroke = phaseCol;
  document.getElementById('krun-pct').textContent=(f*100).toFixed(0)+'%';
  // Which card the figure covers, so the ring is never read as one card's own.
  { const el=document.getElementById('krun-card');
    if(el){
      const n = S.tf ? S.tf.cards.length : (S.sources.length||1);
      const i = S.tf ? S.tf.cards.findIndex(c => d.sourcePath ? c.path===d.sourcePath : c.name===d.sourceName) : -1;
      el.textContent = (n>1 && i>=0) ? `Card ${i+1} of ${n} · ${d.sourceName||''}` : (d.sourceName||'');
    } }
  document.getElementById('krun-spd').textContent = d.speed>0 ? fmtSpd(d.speed) : '-';
  document.getElementById('krun-eta').textContent = d.speed>0 ? fmtEta(d.eta) : '-';
  document.getElementById('krun-file').textContent=d.currentFile||'';
}
// Shared by showSummary() and kioskAfterIngest() — creates the Audio object on the fly
// rather than a <audio> tag in the DOM, to avoid the mic-permission prompt on macOS.
function playIngestSound(ok){
  try{
    const a=new Audio(ok?'./sounds/success.wav':'./sounds/error.wav');
    a.play().catch(()=>{});
  }catch(_){}
}
// ── The kiosk answers ONE question: can I erase the card? ──────────────────
// Answering "Call the boss!" to everything, from a checksum list that could
// not be written to a corrupt copy, would make the alarm mean nothing.
// Three answers, always the LAST line and always in bold:
//   You can remove your card.
//   Remove your card. Do not erase it.
//   Do not erase it. Call the person in charge.
// "Call the boss" is reserved for what actually threatens the rushes: a
// card giving different data twice, and files that failed to copy.
const K_SAFE = 'You can remove your card.';
const K_KEEP = 'Remove your card. Do not erase it.';
const K_BOSS = 'Do not erase it. Call the person in charge.';
function kioskAfterIngest(R){
  document.getElementById('kiosk-run-ov').classList.remove('on');
  const failed   = R.reduce((a,r)=>a+((r.failedFiles&&r.failedFiles.length)||0),0);
  const unstable = R.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
  const okAll = R.length>0 && R.every(r=>r.success) && !failed && !unstable;
  // One stopped card is a stopped ingest: the card must be kept.
  const canceled = R.length>0 && R.some(r=>r.canceled);
  const refused  = R.length>0 && R.every(r=>r.refused);
  if(!canceled) playIngestSound(okAll);

  if(refused){
    // Nothing was written, so nothing threatens the rushes. The operator in a
    // kiosk cannot fix a template: the message must say WHO can.
    const why = ((R[0].errorList||[])[0]||{}).error || '';
    kioskShowResult('stop','Not started',
      'ingesto would not start: '+kioskShort(why),
      'Nothing was written. Ask the person in charge.');
    return;
  }
  if(canceled){
    // A deliberate stop is not a failure. Saying "Call the boss!" to someone
    // who just pressed Cancel is both alarming and wrong, but the card must
    // still be kept, because the copy is incomplete.
    // One of the three answers, not a paraphrase: "keep it and start again"
    // is one reading away from "carry on".
    kioskShowResult('stop','Stopped',
      'Nothing was deleted, and this card is not complete on any drive.', K_KEEP);
    return;
  }
  if(unstable>0){
    kioskShowResult('fail','Keep this card',
      `${unstable} file${unstable>1?'s were':' was'} read differently the second time.`, K_BOSS);
    return;
  }
  if(!okAll){
    // Card fault and drive fault are opposite conclusions: a card fault must
    // not name a healthy drive. Same split as the desktop window.
    if(R.some(r=>r.scanIncomplete)){
      kioskShowResult('fail','Keep this card','Part of the card could not be read.', K_BOSS);
      return;
    }
    if(R.some(r=>(r.errorList||[]).some(e=>e.origin==='source'))){
      kioskShowResult('fail','Keep this card','The card could not be read in full.', K_BOSS);
      return;
    }
    // "Nothing to copy" is only sayable once the card itself has been cleared
    // above, and not from totalFiles alone: a card whose readable files were
    // already ingested and whose remaining subtree threw EIO comes back
    // totalFiles:0, and the kiosk would answer "You can remove your card"
    // while the desktop window says "PART OF THIS CARD COULD NOT BE READ".
    // The engine sets emptyReason only when the scan itself went fine.
    if(R.every(r=>r.emptyReason)){
      const filtered = R.find(r=>r.emptyReason==='filtered-out');
      kioskShowResult('warn','Nothing to copy',
        filtered
          ? 'The file filter excluded every file on this card.'
          : 'This card is empty, or you picked a folder inside it.',
        'Check what you loaded, then start again.');
      return;
    }
    const bad = R.filter(r=>(r.failedFiles&&r.failedFiles.length)||r.errors);
    const drives = [...new Set(bad.map(driveNameOf))];
    // One file failing on two drives is ONE file: a plain sum would count it
    // twice.
    const n = [...new Set(bad.flatMap(r=>r.failedFiles||[]))].length
              || bad.reduce((a,r)=>a+(r.errors||0),0);
    kioskShowResult('fail','Keep this card',
      `${n} file${n>1?'s':''} failed on ${drives.length===1?drives[0]:drives.length+' drives'}.`, K_BOSS);
    return;
  }
  // The one case where the desktop window deliberately withholds EJECT,
  // because the card is the only original left. The kiosk must not answer
  // "Verified. You can remove your card." and eject the card itself here.
  const alreadyThere = Math.max(0, ...R.map(r=>r.skippedFiles||0));
  if(R.every(r=>(r.totalFiles||0)===0) && alreadyThere>0){
    kioskShowResult('ok','Nothing new on this card',
      `Its ${alreadyThere} file${alreadyThere>1?'s are':' is'} already on the drives, verified.`,
      K_SAFE);
    return;
  }
  const noSidecar = R.some(r=>(r.sidecarFailed||[]).length>0);
  if(noSidecar){
    kioskShowResult('warn','Copied & verified',
      'The checksum list could not be written, so this folder cannot be checked again later.',
      K_KEEP);
    return;
  }
  S.sources.forEach(s=>{ try{ window.ingesto.ejectVolume(s.path); }catch(_){} });
  const modes = new Set(R.map(r=>r.mode));
  const skipped = Math.max(0, ...R.map(r=>r.skippedFiles||0));
  // The read-back may have been answered by the computer's memory. Saying
  // "Verified. You can remove your card." exactly as for a real cold check
  // would use the word where it is worth the most, and means the least.
  const cached = R.some(r=>r.doubleReadCached || r.coldVerify===false);
  // Same colour as the main window: a copy that went fine is green
  // whatever the mode; the words say what was and was not checked, and the
  // card is still to be kept.
  if(modes.has(MODE.FAST)){
    kioskShowResult('ok','Copied','Not verified. Sizes and contents were not checked.', K_KEEP);
  } else if(modes.has(MODE.SIZE_CHECK)){
    kioskShowResult('ok','Copied','Sizes match. Contents were not checked.', K_KEEP);
  } else if(cached){
    kioskShowResult('ok','Copied & checked',
      'The check may have read from memory, not from the drive.', K_KEEP);
  } else if(skipped>0){
    // One card at a time in the kiosk, but be explicit anyway: taking min for
    // one number and max for the other would describe neither card.
    const nNew = Math.max(0, ...R.map(r=>r.copiedFiles||0));
    kioskShowResult('ok','Verified',
      [`${nNew} new file${nNew===1?'':'s'} copied and verified.`,
       `${skipped} ${skipped===1?'was':'were'} already on the drives.`], K_SAFE);
  } else {
    kioskShowResult('ok','Verified','Every file was read back from the drive and compared.', K_SAFE);
  }
}
// An engine message is written for the person who chose the template. In the
// kiosk it has to fit on one line and stop at the first sentence.
function kioskShort(msg){
  const first = String(msg||'').split(/(?<=\.)\s/)[0] || String(msg||'');
  return first.length>120 ? first.slice(0,117)+'...' : (first || 'the settings are not usable.');
}
// `answer` is the line that decides what happens to the card. It is always
// last, always bold, and it is the only line some people read.
function kioskShowResult(kind,title,sub,answer){
  const card=document.getElementById('kr-card');
  card.className='kr-card '+(kind==='ok'?'ok':kind==='warn'?'warn':kind==='stop'?'stop':'fail');
  const ICO_CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';
  const ICO_X='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
  const ICO_W='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  document.getElementById('kr-icon').innerHTML =
    kind==='ok'?ICO_CHECK : kind==='warn'?ICO_W : kind==='stop'?STOP_SVG : ICO_X;
  document.getElementById('kr-title').textContent=title;
  // `sub` carries volume names and engine messages, which are attacker
  // controlled: a card or a drive can be named anything. Escaped here, with
  // only the line break we put in ourselves allowed back through. Unescaped,
  // a drive named with a <div class="kr-answer"> could FORGE the line that
  // tells the operator whether the card may be erased.
  // `sub` may be a single string or the lines we want on separate rows. Each
  // line is escaped on its own and joined with a real <br>: nothing an
  // attacker writes can become markup, not even a <br> of their own.
  const lines = Array.isArray(sub) ? sub : [sub];
  document.getElementById('kr-sub').innerHTML =
    lines.map(x=>esc(x)).join('<br>') +
    (answer?`<div class="kr-answer">${esc(answer)}</div>`:'');
  document.getElementById('kr-btn').textContent = kind==='ok'?'Next card':'Dismiss';
  document.getElementById('kiosk-result-ov').classList.add('on');
}
function kioskReset(){
  document.getElementById('kiosk-result-ov').classList.remove('on');
  S.sources=[];
  document.getElementById('k-note').value='';
  document.getElementById('k-cam').value='';
  { const kp=document.getElementById('k-pp'); if(kp) kp.value=''; }
  kioskCamMark('');
  document.getElementById('k-op').value='';
  // kioskStart() copies these kiosk fields into the global Operator/Camera/
  // Profile/Notes inputs before starting the copy — clear those too, or the
  // next card (kiosk or standard) would silently inherit this shooter's
  // leftover values.
  const mc=document.getElementById('meta-cam');   if(mc) mc.value='';
  const mm=document.getElementById('meta-model'); if(mm) mm.value='';
  const mp=document.getElementById('meta-pp');    if(mp) mp.value='';
  const mn=document.getElementById('meta-note');  if(mn) mn.value='';
  renderVolumes();
  renderKioskSource();
  kioskUpdateStart();
  renderKioskCounter();
  persistPrefs();
}
