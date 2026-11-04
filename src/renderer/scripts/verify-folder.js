// ══════════════════════════ Verify Folder ══════════════════════════
// Re-checks a previously ingested folder against its own checksum list / MHL
// manifest, without doing any copy. Read-only: nothing on disk is touched
// besides re-reading the footage to re-hash it.
const VF_RING_C = 427.3; // 2 * PI * r(68)
let _verifyProgressUnsub = null;

async function startVerifyFolder(){
  // A verify pass is a full read and hash of a folder. Started during an
  // ingest it competes for the same drives, covers the transfer view with a
  // full-screen overlay, and gives the operator a Cancel button that cancels
  // the verify, not the copy, with nothing saying which.
  if(S.copying || S._starting){
    showToast('An ingest is running. A folder can be verified once it completes.','warn',5000);
    return;
  }
  const folder = await window.ingesto.browseFolder();
  if(!folder) return;
  document.getElementById('vf-pct').textContent='0%';
  document.getElementById('vf-file').textContent='-';
  const ring=document.getElementById('vf-ring');
  ring.style.strokeDashoffset=String(VF_RING_C);
  document.getElementById('verify-progress-ov').classList.add('open');
  if(_verifyProgressUnsub) _verifyProgressUnsub();
  _verifyProgressUnsub = window.ingesto.onVerifyProgress(d=>{
    const frac = d.total ? d.index/d.total : 0;
    ring.style.strokeDashoffset=(VF_RING_C*(1-frac)).toFixed(1);
    document.getElementById('vf-pct').textContent=Math.round(frac*100)+'%';
    document.getElementById('vf-file').textContent=d.currentFile||'';
  });
  let res;
  try { res = await window.ingesto.verifyFolder(folder); }
  catch(e){ res = { ok:false, reason:'error' }; }
  document.getElementById('verify-progress-ov').classList.remove('open');
  if(_verifyProgressUnsub){ _verifyProgressUnsub(); _verifyProgressUnsub=null; }
  showVerifyResult(res, folder);
}

function cancelVerifyFolder(){
  window.ingesto.cancelVerify().catch(()=>{});
}

function closeVerifyResult(){
  document.getElementById('verify-result-ov').classList.remove('open');
}

function showVerifyResult(res, folder){
  const ICO_CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';
  const ICO_X='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
  const ICO_WARN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const ico=document.getElementById('vf-r-ico');
  const grid=document.getElementById('vf-r-grid');
  const lists=document.getElementById('vf-r-lists');
  const title=document.getElementById('vf-r-title');
  const sub=document.getElementById('vf-r-sub');
  const folderName = folder.replace(/[\\/]+$/,'').split(/[\\/]/).pop();

  if(!res || !res.ok){
    ico.className='sum-ico cancel'; ico.innerHTML=ICO_WARN;
    title.className='sum-h1 vf-o';
    title.textContent='NOTHING TO VERIFY HERE';
    sub.textContent=folderName;
    grid.innerHTML='';
    lists.innerHTML='<div class="vf-flist">'+
      '<div class="vf-note">This folder holds no checksum list and no MHL manifest, so there is '+
      'nothing to compare its files against. It was ingested in Fast or Size check mode, or with '+
      'Write Checksum turned off.<br><br><b>Nothing is wrong with the folder.</b> Only a folder '+
      'ingested in Secure or Pro mode can be verified later.</div></div>';
    document.getElementById('verify-result-ov').classList.add('open');
    return;
  }
  // A folder holding a quarantined bad copy (or a temp file from an interrupted
  // run) is NOT a clean folder, even though those files are also listed under
  // "extra files".
  const quar = res.quarantined || [];
  const clean = res.corrupted.length===0 && res.missing.length===0 && quar.length===0 && !res.canceled;
  // A file the manifest does not know is a file nothing has vouched for, so it
  // must not sit under "extra files" beneath a green "Verification passed": a
  // clip a PRO double read found unstable on the card is exactly such a file.
  // "Passed" means every file in this folder is listed AND matches.
  const extras = (res.extra||[]).length;
  const ok = clean && extras===0;
  // Three states, not two. A folder holding something the manifest does not
  // cover is a WARNING, not the red cross of a corrupted copy: everything the
  // manifest lists was read back and matched. It does not go green either,
  // because a clip a PRO double read found unstable on the card is left out of
  // the manifest on purpose and would then disappear from view.
  // A cancel is its own state: nothing failed, the answer is simply unknown.
  // Red outranks stopped: a corruption already found stays found. Cancelling
  // the rest of the pass must not downgrade it to an amber "VERIFICATION STOPPED".
  const foundBad = res.corrupted.length>0 || res.missing.length>0 || quar.length>0;
  // A manifest that lists nothing verified nothing. Green, with a tick, would
  // tell the operator their folder had been checked.
  const emptyManifest = res.total === 0;
  const state = foundBad ? 'red' : res.canceled ? 'stopped'
              : emptyManifest ? 'stopped' : ok ? 'green' : 'amber';
  ico.className='sum-ico '+({green:'ok',amber:'cancel',stopped:'cancel',red:'err'})[state];
  ico.innerHTML = state==='green'?ICO_CHECK:state==='red'?ICO_X:ICO_WARN;
  title.className='sum-h1 '+({green:'vf-g',amber:'vf-o',stopped:'vf-o',red:'vf-r'})[state];
  title.textContent = (emptyManifest && !foundBad && !res.canceled)
    ? 'THIS MANIFEST LISTS NOTHING'
    : ({ stopped:'VERIFICATION STOPPED', green:'ALL FILES VERIFIED',
         amber:'ALL LISTED FILES VERIFIED', red:'VERIFICATION FAILED' })[state];
  sub.textContent = folderName;
  let listsHtmlPre='';
  grid.innerHTML =
    '<div class="srow"><div class="sr-lbl">Checked</div><div class="sr-val">'+res.total+'</div></div>'+
    '<div class="srow"><div class="sr-lbl">Matched</div><div class="sr-val">'+res.matched+'</div></div>'+
    '<div class="srow"><div class="sr-lbl">Corrupted</div><div class="sr-val'+(res.corrupted.length?' bad':'')+'">'+res.corrupted.length+'</div></div>'+
    '<div class="srow"><div class="sr-lbl">Missing</div><div class="sr-val'+(res.missing.length?' bad':'')+'">'+res.missing.length+'</div></div>'+
    (quar.length?'<div class="srow"><div class="sr-lbl">No good copy</div><div class="sr-val bad">'+quar.length+'</div></div>':'');
  if(quar.length){
    listsHtmlPre = '<div class="vf-flist"><div class="vf-flist-h bad">Files this folder is missing a good copy of</div>'+
      quar.map(f=>'<div class="vf-fitem bad">'+esc(String(f).replace(/\.ingesto-(failed|part)$/,''))+
        ' <span class="vf-tag">'+(String(f).endsWith('.ingesto-part')?'copy interrupted':'failed verification')+'</span></div>').join('')+
      '<div class="vf-fitem">Copy these from the card again.</div></div>';
  }
  let listsHtml=listsHtmlPre;
  if(res.corrupted.length || res.missing.length){
    listsHtml += '<div class="vf-flist"><div class="vf-flist-h bad">Corrupted / missing files</div>'+
      res.corrupted.map(f=>'<div class="vf-fitem bad">'+esc(f)+' <span class="vf-tag">hash mismatch</span></div>').join('')+
      res.missing.map(f=>'<div class="vf-fitem bad">'+esc(f)+' <span class="vf-tag">missing</span></div>').join('')+
      '</div>';
  }
  if(res.extra.length){
    // Says first what is NOT affected, then what to do. A wording like
    // "nothing vouches for these" reads as an accusation against a folder
    // that, most of the time, is perfectly fine.
    listsHtml += '<div class="vf-flist"><div class="vf-flist-h warn">'+res.extra.length+
      ' file'+(res.extra.length>1?'s':'')+' in this folder '+(res.extra.length>1?'are':'is')+
      ' not in the manifest</div>'+
      res.extra.map(f=>'<div class="vf-fitem">'+esc(f)+'</div>').join('')+
      '<div class="vf-note"><b>Every file the manifest lists was checked and matches.</b> '+
      (res.extra.length>1?'These were':'This one was')+' added after the ingest, or the ingest '+
      'could not vouch for '+(res.extra.length>1?'them':'it')+'. If '+
      (res.extra.length>1?'one of them is':'it is')+' footage, copy it from the card again.</div>'+
      '</div>';
  }
  // Always there, green window included: it answers the question the counters
  // raise on their own ("four files in the folder, why were only two checked?").
  listsHtml += '<p class="vf-skip">Not checked, and not expected to be: ingesto\'s own files. '+
    'Checksum list, shooting note, ASC MHL history.</p>';
  lists.innerHTML = listsHtml;
  document.getElementById('verify-result-ov').classList.add('open');
}

// Export / import template memory presets
async function exportPresets(){
  try{
    const data = { type:'ingesto-presets', version:1, presets:S.presets };
    const res = await window.ingesto.exportPresets(data);
    if(res && res.ok) showToast('Templates exported.', 'info');
  }catch(e){ console.error('exportPresets', e); showToast('Export failed.', 'warn'); }
}
async function importPresets(){
  try{
    const res = await window.ingesto.importPresets();
    if(!res || !res.ok) return; // user cancelled
    const d = res.data;
    if(!d || !Array.isArray(d.presets)){ showToast('Not a valid presets file.', 'warn'); return; }
    S.presets = normPresets(d.presets);
    renderPresets();
    persistPrefs();
    showToast('Templates imported.', 'info');
  }catch(e){ console.error('importPresets', e); showToast('Import failed.', 'warn'); }
}
