// ── Eject source (summary, clean success only, removable-or-camera only) ──
// A card's destinations unfold from its NAME. The caret is decoration; the
// whole name row is the target.
function toggleCard(gi){
  const box=document.getElementById('sc-d-'+gi), car=document.getElementById('sc-car-'+gi);
  if(!box) return;
  const open = box.style.display==='none';
  box.style.display = open ? '' : 'none';
  if(car) car.classList.toggle('open', open);
}

// EJECT sits on the card it ejects, so eligibility is decided per card and
// not once for the whole run: otherwise a batch mixing a card reader and a
// folder on a drive would hide the button for both.
// `verdict.ok` is the window's own conclusion, and EJECT must never be more
// optimistic than the title above it. Re-deriving the gate from R alone would
// light the button under "THIS CARD IS STILL SUSPECT", because the results of a re-copy
// know nothing about the run being re-copied. Ejecting is the gesture that
// comes just before formatting.
async function setupEjectButtons(R, G, verdict){
  if(verdict && verdict.ok === false) return;
  const er=R.reduce((a,r)=>a+r.errors,0);
  // ONE stopped card is enough to keep the buttons dark: `every(canceled)` would
  // light them for a batch whose second card was cancelled at 1 file of 3.
  const canceled=R.some(r=>r.canceled);
  const cf=R.reduce((a,r)=>a+r.copiedFiles,0);
  const unstable=R.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
  // A destination missing its manifest is not a destination you eject a card
  // over. The checksum list IS the promise of PRO: without it, the copy can
  // never be re-verified, and the card is the only remaining original.
  const noSidecar=R.some(r=>(r.sidecarFailed||[]).length>0);
  if(er||canceled||cf<=0||unstable>0||noSidecar||!R.every(r=>r.success===true)) return;   // clean success only, as the ENGINE sees it
  const shown=[];
  for(let gi=0; gi<G.length; gi++){
    const src={ path:G[gi][0].sourcePath, name:G[gi][0].sourceName };
    if(!src.path) continue;
    let okEject=false;
    try{ okEject=await window.ingesto.isRemovable(src.path); }catch(_){}
    if(!okEject){
      const entry=S.sources.find(x=>x.path===src.path);
      if(entry && entry.camera) okEject=true;
      else { try{ if(await window.ingesto.detectCamera(src.path)) okEject=true; }catch(_){} }
    }
    if(!okEject) continue;
    const b=document.getElementById('sc-ej-'+gi);
    if(b){ b.style.display=''; shown.push(gi); }
  }
  const all=document.getElementById('sc-ej-all');
  if(all && shown.length>1) all.style.display='';
}
async function ejectCard(gi){
  const g=(S._cardGroups||[])[gi];
  const btn=document.getElementById('sc-ej-'+gi);
  if(!g || !g.path || !btn) return;
  btn.disabled=true;
  let okEject=false;
  try{ const r=await window.ingesto.ejectVolume(g.path); okEject=!!(r&&r.ok); }catch(_){}
  if(okEject){ btn.textContent='EJECTED'; btn.classList.add('done'); }
  else{
    btn.disabled=false;
    showToast(`${g.name} could not be ejected. Eject it from the Finder.`,'warn',4500);
  }
}
async function ejectAllCards(){
  const all=document.getElementById('sc-ej-all');
  if(all) all.disabled=true;
  const G=S._cardGroups||[];
  for(let gi=0; gi<G.length; gi++){
    const b=document.getElementById('sc-ej-'+gi);
    if(b && b.style.display!=='none' && !b.disabled) await ejectCard(gi);
  }
  if(all){ all.textContent='EJECTED'; all.classList.add('done'); }
}
// Forced physical re-read of the source: unmount the card, remount it (cache
// gone), and re-hash every file against what was read during the copy.
async function redoDoubleRead(){
  const job = S._redo;
  if(!job) return;
  const btn = document.getElementById('dr-redo');
  const out = document.getElementById('dr-result');
  if(btn){ btn.disabled = true; btn.textContent = '⟳ Unmounting and re-reading…'; btn.style.opacity = '.6'; }
  let res = null;
  try{ res = await window.ingesto.redoDoubleRead(job); }
  catch(e){ res = { ok:false, error: e && e.message }; }
  if(!out) return;
  if(!res || !res.ok){
    const why = (res && res.error) ? esc(res.error) : 'unknown error';
    out.innerHTML = `<div style="color:var(--orange);">The card couldn't be checked (${why}). `+
      `This is usually another app using the card. Close Finder windows or photo apps and try again. `+
      `Your copied files are not affected.</div>`;
    if(btn){ btn.disabled=false; btn.style.opacity=''; btn.textContent='⟳ Check the card for real'; }
    return;
  }
  if(btn) btn.style.display='none';
  const spd = res.speed ? fmtSpd(res.speed) : '-';
  if(res.unstable && res.unstable.length){
    out.innerHTML =
      `<div style="color:var(--red);font-weight:700;">⚠ ${res.unstable.length} file`+
      `${res.unstable.length>1?'s':''} came back different when the card was read again.</div>`+
      `<div style="color:var(--text2);margin-top:4px;">This card is not reliable. Keep it as it is, do not format it. `+
      `and check these files by eye in your edit software. If another copy of this footage exists, prefer it.</div>`+
      res.unstable.slice(0,20).map(f=>`<div class="err-item">⚠ ${esc(f)}</div>`).join('');
  } else if(res.errors && res.errors.length){
    out.innerHTML = `<div style="color:var(--orange);">The check finished, but ${res.errors.length} file`+
      `${res.errors.length>1?'s':''} couldn't be read from the card. Your copies on the destination are verified and safe.</div>`;
  } else {
    out.innerHTML = `<div style="color:var(--green);font-weight:700;">✓ Card checked. All ${res.checked} file`+
      `${res.checked>1?'s':''} read back identical (${esc(spd)}). Full PRO level confirmed.</div>`;
  }
}
