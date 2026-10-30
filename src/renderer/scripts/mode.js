// ═══════════════════════════════════════════════════════
// Mode
// ═══════════════════════════════════════════════════════
function setMode(m,persist=true){
  if(!MODES.includes(m)) return;   // never leave S.mode holding something no mode handler knows
  S.mode=m;
  MODES.forEach(id=>document.getElementById(`mode-${id}`)?.classList.toggle('on',id===m));
  const pa=document.getElementById('pro-algo'); if(pa) pa.style.display = (m===MODE.PRO)?'block':'none';
  if(persist)persistPrefs();
}
function setProAlgo(a,persist=true){
  S.proAlgo=a;
  // Switch rows behave as radios: reflect the active algo on every row.
  document.querySelectorAll('#pro-algo .pa-line .pa-item').forEach(row=>{
    const inp=row.querySelector('input[data-algo]');
    if(!inp) return;
    const on = inp.dataset.algo===a;
    inp.checked=on;
    row.classList.toggle('on',on);
  });
  if(persist)persistPrefs();
}
// Checksum switches are exclusive: turning one ON turns the others off, and the
// active one cannot be turned OFF (there must always be exactly one algorithm).
function algoSwitch(el){
  if(!el.checked){ el.checked=true; return; }
  setProAlgo(el.dataset.algo);
}
function setProDouble(v){
  S.proDoubleRead=!!v;
  const row=document.getElementById('pro-dr-toggle')?.closest('.pa-item');
  if(row) row.classList.toggle('on',!!v);
  persistPrefs();
}
// PRO button click — warn novices first (unless dismissed), then select.
// The mode in force when the dialog opens is remembered, and cancelling leaves
// the mode exactly where it was. Falling back to setMode('slow') would mean that
// someone in FAST who clicked PRO out of curiosity and then clicked outside the
// dialog silently ends up in SECURE, and that choice is persisted.
function onSelectPro(){
  if(S.proWarnDismissed){ setMode(MODE.PRO); return; }
  S._modeBeforeProWarn = S.mode;
  document.getElementById('pro-warn-chk').checked=false;
  document.getElementById('pro-warn-ov').classList.add('open');
}
function proWarnUse(){
  if(document.getElementById('pro-warn-chk').checked){ S.proWarnDismissed=true; }
  document.getElementById('pro-warn-ov').classList.remove('open');
  setMode(MODE.PRO);
}
function proWarnCancel(){
  document.getElementById('pro-warn-ov').classList.remove('open');
  // Back to whatever was selected before the dialog, and to SECURE only when
  // that is unknown (nothing selected yet).
  const back = S._modeBeforeProWarn;
  S._modeBeforeProWarn = null;
  setMode(back || MODE.SECURE);
}

// ── Update notice — small dismissible overlay, doesn't repeat for the same version ──
function showUpdateNotice({ version, url }){
  if (version === S.updateDismissedVersion) return;
  if (document.getElementById('update-ov')) return;
  const ov=document.createElement('div');
  ov.id='update-ov'; ov.className='open';
  ov.innerHTML =
    `<div class="mi-card">`+
    `<div class="mi-h">New version available</div>`+
    `<div class="mi-sub">ingesto v${esc(version)} is available. You're on v${esc(S.appVersion||'')}.</div>`+
    `<div class="pw-actions">`+
    `<button class="pw-back" id="upd-later">Later</button>`+
    `<button class="pw-use" id="upd-go">Get it</button></div>`+
    `</div>`;
  document.body.appendChild(ov);
  const dismiss=()=>{ S.updateDismissedVersion=version; persistPrefs(); ov.remove(); };
  ov.querySelector('#upd-later').onclick=dismiss;
  ov.querySelector('#upd-go').onclick=()=>{ window.ingesto.openExternal(url); dismiss(); };
  ov.onclick=(e)=>{ if(e.target===ov) dismiss(); };
}
