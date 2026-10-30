// ═══════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════
// ── Floating tooltips for [data-tip] elements ────────────────────────────
// Rendered as a fixed-position element appended to <body>, so it's never
// clipped by an ancestor's overflow:hidden (e.g. #center) or hidden behind a
// sibling panel (e.g. Destinations) — unlike a CSS ::after tooltip would be.
let _tipEl = null;
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  if (_tipEl) _tipEl.remove();
  _tipEl = document.createElement('div');
  _tipEl.className = 'tooltip-float';
  _tipEl.textContent = t.getAttribute('data-tip');
  document.body.appendChild(_tipEl);
  const r = t.getBoundingClientRect();
  const tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
  let left = r.left + r.width/2 - tw/2;
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - 6) top = r.top - th - 8; // flip above if no room below
  _tipEl.style.left = left + 'px';
  _tipEl.style.top = top + 'px';
});
document.addEventListener('mouseout', e => {
  if (!e.target.closest('[data-tip]')) return;
  if (_tipEl) { _tipEl.remove(); _tipEl = null; }
});

window.addEventListener('DOMContentLoaded', async ()=>{
  if(window.ingesto.platform==='win32' || window.ingesto.platform==='linux'){
    // Linux: same custom window controls as Windows — titleBarStyle:'hidden'
    // removes the system buttons there too, and nothing replaces them natively.
    document.body.classList.add(window.ingesto.platform==='win32' ? 'win32' : 'linux');
    // Update maximize button when state changes
    window.ingesto.onMaximizeChange(isMax=>{
      const btn=document.getElementById('btn-max');
      if(!btn)return;
      btn.innerHTML=isMax
        ? '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
        : '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    });
  }
  // Before the preferences: the fields must be built and hooked when the
  // saved values are written into them.
  try{ fieldsInit(document); }catch(e){ console.error('fieldsInit', e); }
  const prefs=(await window.ingesto.loadPrefs())||{};   // a failed read must not stop the boot
  // The note mode is applied directly, not through setNoteMode(): that one
  // saves the preferences, and a save at this point would write them before
  // they are restored.
  // Every setting of the SETTINGS table (preferences.js): a missing or
  // unusable value takes the default. tplVersion is absent from preferences
  // saved by earlier versions, when "/" was not a subfolder: see
  // tokensFromStored() in template.js.
  applySettings(prefs, { from:'prefs', legacy: prefs.tplVersion !== 2 });
  if(S.noteMode==='md') document.querySelectorAll('.mdn').forEach(mdnApplyMode);
  // Language: i18n.js has already applied its quick copy (localStorage), so
  // the window never flashes in English. The prefs file is the reference: if
  // the two disagree (new machine, web storage cleared), the file wins.
  try{
    if(prefs.language && window.INGESTO_I18N && prefs.language!==window.INGESTO_I18N.getLanguage())
      window.INGESTO_I18N.setLanguage(prefs.language);
  }catch(e){ console.error('language', e); }
  { const c = prefsCounter(prefs);
    if(c !== null){ S.counter = c; S.counterOverride = !!prefs.counterOverride; } }
  if(prefs.cameraman) document.getElementById('meta-cam').value=prefs.cameraman;
  if(prefs.note)      { const n=document.getElementById('meta-note'); if(n) n.value=prefs.note; }
  if(prefs.camera)    document.getElementById('meta-model').value=prefs.camera;
  if(prefs.pp)        { const pe=document.getElementById('meta-pp'); if(pe) pe.value=prefs.pp; }
  ['meta-cam','meta-model'].forEach(id=>{const el=document.getElementById(id); if(el) sanitizeMeta(el);});
  { const pe=document.getElementById('meta-pp'); if(pe) sanitizePP(pe); }
  // The kiosk PIN and the kiosk state are deliberately NOT restored. Restored,
  // they would relaunch the app straight back into kiosk mode, so an operator
  // who forgot the PIN would be locked out for good, with no way back short of
  // deleting the preferences file by hand. A kiosk session lasts exactly as
  // long as the app is open: quitting always gets you out, and entering kiosk
  // again asks for a fresh PIN.
  showSettings();

  // Restore persisted destinations (needed for KIOSK: admin sets them once)
  if(Array.isArray(prefs.destPaths)){
    prefs.destPaths.forEach(dp=>{ if(dp&&dp.path) addToZone('dst',{path:dp.path,name:dp.name||dp.path}); });
  }

  renderTemplate();
  renderPresets();
  renderCounter();
  renderSourceInfoCards();
  updateCopyInfoVisibility();
  // Auto-scan on startup if destinations are already set
  if(S.dests.length > 0) scanCounter();
  applyKioskMode();   // kiosk is always off at launch (see above): draws the standard screen
  // The destinations persist between launches, so the log can be filled from
  // the reports on those drives before anything is ingested.
  refreshSessionLog();

  window.ingesto.onCopyProgress(onProgress);
  // Wrapper, not onComplete directly: during a sequential batch the per-card
  // IPC 'copy-complete' events (including one that may arrive AFTER the loop
  // ends) are swallowed here, and startCopy() calls onComplete once itself.
  window.ingesto.onCopyComplete(R => { if(S._batchSuppress) return; onComplete(R); });
  window.ingesto.getVersion().then(v=>{
    S.appVersion=v;
    const fv=document.getElementById('footer-ver'); if(fv) fv.textContent='v'+v;
  });
  window.ingesto.onFinderDrop(onFinderDrop);
  window.ingesto.onVolumesChanged(onVolumesChanged);
  // A permanent, harmless refusal is a toast, not a window: the person who
  // double-clicked the icon twice is already looking at the window they wanted.
  if(window.ingesto.onSecondInstance) window.ingesto.onSecondInstance(()=>{
    showToast('ingesto is already open. A second window would share the same drives and could give '+
              'two cards the same counter.', 'info', 6000);
  });
  window.ingesto.onPauseHeld(onPauseHeld);
  window.ingesto.onUpdateAvailable(showUpdateNotice);

  // Native HTML5 drop from Finder
  // which fires when a file:// URL is dragged onto the window.
  // We only need dragover/drop on the document for internal volume card drags.
  // preventDefault on dragover is REQUIRED for the in-page 'drop' handler below
  // to fire (this is the channel that actually handles Finder drops, via
  // webUtils.getPathForFile). The main process's will-navigate file:// branch is
  // only a dead-man fallback and must stay preventDefault'ed there regardless.
  document.addEventListener('dragover',e=>e.preventDefault());
  document.addEventListener('drop',e=>{
    e.preventDefault();
    // Kiosk lockdown: a Finder drop could add an arbitrary DESTINATION (then
    // persisted for every later ingest) without the admin PIN.
    if(S.kioskMode) return;
    if(S.dragVol) return;
    _lastMouseX = e.clientX;
    // file.path was removed in Electron 32+ — webUtils.getPathForFile (exposed
    // by the preload as getPathForFile) is the supported way to resolve the
    // filesystem path of a dropped File on every platform.
    const files = e.dataTransfer ? e.dataTransfer.files : [];
    for(let i=0;i<files.length;i++){
      const fp = window.ingesto.getPathForFile(files[i]) || files[i].path || '';
      if(fp){ onFinderDrop(fp, e.clientX); return; }
    }
    // Fallback: .items API
    for(const item of e.dataTransfer.items||[]){
      if(item.kind==='file'){
        const f=item.getAsFile();
        const fp=f ? (window.ingesto.getPathForFile(f) || f.path || '') : '';
        if(fp){ onFinderDrop(fp, e.clientX); return; }
      }
    }
  });

  // Close context menu on any outside click
  document.addEventListener('click', function(e){
    const menu = document.getElementById('ctx-menu');
    if (menu && !menu.contains(e.target)) closeCtx();
  });

  loadVolumes();
  // The button says what is missing from the very first frame, not only
  // after a card has come and gone.
  try{ updateBtn(); }catch(_){}
});

// ── What a folder name may hold ─────────────────────────────────────────────
// The rule follows the language of the interface:
//   'ascii'   English, French (and any language not listed below): no accent,
//             no space, no special character in anything that becomes a folder
//             name. "é" becomes "e", "œ" becomes "oe"; spaces and other signs
//             are removed. Only the shooting note accepts everything.
//   'unicode' Chinese: wibi8bo's rule. Only what a filesystem forbids is
//             removed (/ \ : * ? " < > | and control characters).
// The template variables ({counter}, {cardname}...) are English in every
// language. The engine is told the rule with each card (nameRule), the same
// rule as the preview.
function nameRule(){
  const l = (typeof INGESTO_I18N!=='undefined' && INGESTO_I18N) ? INGESTO_I18N.getLanguage() : 'en';
  return /^zh/.test(l) ? 'unicode' : 'ascii';
}
// Folder names and source kinds come from src/shared, the same code as the
// engine: what this window previews is what the engine creates.
const { asciiFold, isHdeSource, MAX_FOLDER_DEPTH } = window.IngestoShared;
function isSafeFolderName(n){ return window.IngestoShared.isSafeFolderName(n, window.ingesto.platform); }
// A piece of fixed text of the template (DAY1, CLIENT...), under the rule.
function tplText(x){
  return nameRule()==='ascii' ? asciiFold(x).replace(/[^A-Za-z0-9_\-\/]/g,'') : String(x==null?'':x);
}

// OPERATOR / CAMERA MODEL, under the folder-name rule, applied live.
// ascii: letters and digits only, accents turned into the plain letter
// ("Hélène" gives "Helene", not "Hlne").
// unicode: only what a filesystem forbids is removed.
function sanitizeMeta(el){
  const start = el.selectionStart;
  const before = el.value;
  const after  = nameRule()==='ascii'
    ? asciiFold(before).replace(/[^A-Za-z0-9]/g,'')
    : before.replace(/[\/\\:*?"<>|\x00-\x1f]/g,'');
  if (after !== before){
    el.value = after;
    // keep caret from jumping to the end when a char is stripped
    const removed = before.length - after.length;
    const pos = Math.max(0, (start||before.length) - removed);
    try { el.setSelectionRange(pos, pos); } catch(_){}
  }
}

// PICTURE PROFILE: the same rule as OPERATOR / CAMERA MODEL, plus capitals.
//
// A profile is an acronym, and everyone writes it differently: SLog3, S-Log3,
// s log 3. Left as typed, one shoot ends up with SLOG3 on card one and SLog3
// on card two, two different folders for the same thing, and a script that
// routes on the name has to guess. One form, decided here.
//
// normPP() is the rule itself, so the field, the engine payload and anything
// arriving from a settings file all go through the same line rather than three
// copies of it that drift apart.
function normPP(v){ return String(v==null?'':v).replace(/[^A-Za-z0-9]/g,'').toUpperCase(); }
function sanitizePP(el){
  const start = el.selectionStart;
  const before = el.value;
  const after  = normPP(before);
  if (after !== before){
    el.value = after;
    // The caret only moves by what was REMOVED. Upper-casing changes no
    // length, so typing in the middle of a value does not throw it to the end.
    //
    // `start == null`, not `!start`: this branch also fires when nothing was
    // removed and only the case changed, which sanitizeMeta() could never do.
    // A caret genuinely at position 0 would then be thrown to the end of the
    // value by a test that treats 0 as "no caret".
    const removed = before.length - after.length;
    const pos = Math.max(0, (start == null ? before.length : start) - removed);
    try { el.setSelectionRange(pos, pos); } catch(_){}
  }
}

// The preferences are written by the main process with a synchronous write of
// the whole file. Called on every keystroke of Operator, Camera, Picture
// profile and Notes, that is dozens of synchronous disk writes per sentence,
// in the very process that is copying. Coalesced here into one write, 400 ms
// after the last change.
//
// A pending write is never lost: it is flushed when the field loses focus,
// before an ingest starts, and when the window is about to close.
let _prefsTimer = null;
function persistPrefs(){
  if(_prefsTimer) clearTimeout(_prefsTimer);
  _prefsTimer = setTimeout(() => { _prefsTimer = null; persistPrefsNow(); }, 400);
}
function flushPrefs(){
  if(!_prefsTimer) return;
  clearTimeout(_prefsTimer); _prefsTimer = null;
  persistPrefsNow();
}
window.addEventListener('beforeunload', flushPrefs);
document.addEventListener('focusout', (e) => { if(e.target && e.target.tagName && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) flushPrefs(); });
function persistPrefsNow(){
  window.ingesto.savePrefs(Object.assign(settingsForFile({ to:'prefs' }), {
    counter:S.counter, counterOverride:S.counterOverride,
    language:(window.INGESTO_I18N && window.INGESTO_I18N.getLanguage()) || 'en',
    tplVersion:2,          // "/" in a literal means a subfolder (see tokensFromStored)
    cameraman:document.getElementById('meta-cam')?.value||'',
    camera:document.getElementById('meta-model')?.value||'',
    pp:document.getElementById('meta-pp')?.value||'',
    note:document.getElementById('meta-note')?.value||'',
    // kioskMode and kioskPin are intentionally absent: see the loader. A
    // forgotten PIN must never outlive the session that set it.
    kioskMode:false, kioskPin:'',
    destPaths:S.dests.map(d=>({path:d.path,name:d.name})),
  }));
}
