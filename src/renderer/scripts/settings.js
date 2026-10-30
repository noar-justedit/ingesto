// ══════════════════════════ INGEST REPORT ══════════════════════════
function onReportToggle(el){
  S.writeReport=el.checked;
  // Re-enabling the master with no format selected → turn on the default (HTML)
  if(el.checked && !(S.reportHtml||S.reportCsv||S.reportJson)){
    S.reportHtml=true;
    const h=document.getElementById('rf-html'); if(h) h.checked=true;
  }
  persistPrefs();
  updateSettingsDetails();
}
// Full report vs light report. This applies to the ingest ABOUT TO RUN and to
// nothing else: every card carries its own file list, so cards already in the
// report keep exactly what they recorded. The switch can be flipped between two
// ingests without ever losing anything — one shoot archived in full, the next
// logged as a single line, in the same report.
function onReportDetail(el){
  S.reportFull=el.checked;
  updateReportDetailNote();
  persistPrefs();
}
function updateReportDetailNote(){
  const n=document.getElementById('rf-full-note');
  if(!n) return;
  n.textContent = S.reportFull
    ? 'The next ingest will list every file it copies. Cards already in the report keep what they recorded.'
    : 'The next ingest will be recorded as a single line, without file names. Cards already in the report keep their file lists.';
}
function onReportFmt(){
  const wasAny=S.reportHtml||S.reportCsv||S.reportJson;
  S.reportHtml=!!document.getElementById('rf-html')?.checked;
  S.reportCsv =!!document.getElementById('rf-csv')?.checked;
  S.reportJson=!!document.getElementById('rf-json')?.checked;
  syncMaster('report-toggle', (S.reportHtml||S.reportCsv||S.reportJson), wasAny, v=>S.writeReport=v);
  persistPrefs();
}
function onChecksumToggle(el){
  S.writeChecksum=el.checked;
  // Re-enabling the master with no format selected → turn on the default (Checksum list)
  if(el.checked && !(S.cksumList||S.cksumMhl||S.ascMhl)){
    S.cksumList=true;
    const l=document.getElementById('cf-list'); if(l) l.checked=true;
  }
  persistPrefs();
  updateSettingsDetails();
}
function onChecksumFmt(){
  const wasAny=S.cksumList||S.cksumMhl||S.ascMhl;
  S.cksumList=!!document.getElementById('cf-list')?.checked;
  S.cksumMhl =!!document.getElementById('cf-mhl')?.checked;
  S.ascMhl   =!!document.getElementById('cf-ascmhl')?.checked;
  syncMaster('cksum-toggle', (S.cksumList||S.cksumMhl||S.ascMhl), wasAny, v=>S.writeChecksum=v);
  persistPrefs();
}
// Keep a master (Ingest Report / Write Checksum) consistent with its formats,
// WITHOUT ever greying/disabling it. No format left → master unchecks (still clickable).
// A format switched back on (from the no-format state) re-checks the master. When
// formats persist, the master is left as the user set it (manual pause preserved).
function syncMaster(masterId, nowAny, wasAny, setFlag){
  const t=document.getElementById(masterId); if(!t) return;
  t.disabled=false;
  if(!nowAny){ t.checked=false; setFlag(false); }
  else if(!wasAny){ t.checked=true; setFlag(true); }
}
function initMaster(masterId, anyFormat, setFlag, getFlag){
  const t=document.getElementById(masterId); if(!t) return;
  t.disabled=false;
  if(!anyFormat){ t.checked=false; setFlag(false); }
  else { t.checked=getFlag(); }
}
// ── Settings panel + ntfy notification ──
function openSettings(){
  updateSettingsDetails();
  if (S.fileFilter && S.fileFilterFormats) renderFilterList();
  document.getElementById('settings-ov').classList.add('open');
}
function closeSettings(){ document.getElementById('settings-ov').classList.remove('open'); }

// Show a section's details only while its master switch is on
function updateSettingsDetails(){
  const map = {
    'cksum-details':  S.writeChecksum,
    'report-details': S.writeReport,
    'ff-details':     S.fileFilter,
    'ntfy-details':   S.ntfyEnabled,
    'hook-details':   S.hookEnabled,
    'handoff-details': S.handoffEnabled,
  };
  for (const [id,on] of Object.entries(map)){
    const el=document.getElementById(id);
    if (el) el.classList.toggle('on', !!on);
  }
  const ffEmpty=document.getElementById('ff-empty'); if(ffEmpty) ffEmpty.checked=S.copyEmptyFolders;
  const ffReorg=document.getElementById('ff-reorg'); if(ffReorg) ffReorg.checked=S.reorganizeFiles;
}
async function openNtfySite(){ await window.ingesto.openExternal('https://ntfy.sh/'); }
function onNtfyToggle(el){ S.ntfyEnabled=el.checked; persistPrefs(); updateSettingsDetails(); }
function onHookToggle(el){ S.hookEnabled=el.checked; persistPrefs(); updateSettingsDetails(); }
function onHookField(){ S.hookCommand=(document.getElementById('set-hook').value||'').trim(); persistPrefs(); }
function onHandoffToggle(el){ S.handoffEnabled=el.checked; persistPrefs(); updateSettingsDetails(); }
function onHandoffField(){ S.handoffCommand=(document.getElementById('set-handoff').value||'').trim(); persistPrefs(); }

// ── Settings file export / import ─────────────────────────────────────────
// Shares the ingest setup between machines. Deliberately excluded: source and
// destination paths, the post-ingest hook, notifications, kiosk PIN, and
// operator/camera/notes — machine- or person-specific, and the hook is a shell
// command (importing one from a shared file would be a code-execution vector).
const EXPORT_INC = { 'sx-tpl':'namingTemplate','sx-presets':'namingPresets','sx-mode':'copyMode',
  'sx-track':'cardTracking','sx-cksum':'writeChecksum','sx-report':'ingestReport','sx-filter':'fileFilter' };
function onExportInc(){
  S.exportInclude = {};
  for (const [id,key] of Object.entries(EXPORT_INC))
    S.exportInclude[key] = !!document.getElementById(id)?.checked;
  persistPrefs();
}
function getExportInclude(){
  const inc={};
  for (const [id,key] of Object.entries(EXPORT_INC))
    inc[key] = !!document.getElementById(id)?.checked;
  return inc;
}
async function exportSettingsFile(){
  const inc = getExportInclude();
  const d = Object.assign({ ingestoSettingsVersion:1, exported:new Date().toISOString(), include:inc },
                          settingsForFile({ to:'export', cats:inc }));
  try{
    const r = await window.ingesto.exportSettings(d);
    if (r && r.ok) showToast('Settings exported.', 'ok');
    else if (r && r.error) showToast('Export failed: '+r.error, 'warn');
  }catch(_){ showToast('Export failed.', 'warn'); }
}
// Settings can be opened mid-ingest to read the ntfy topic. Importing a FILE
// there would change the copy mode, the template and the algorithm under a
// run already in flight, headlining a FAST ingest "Secure Transfer Complete".
function importBusy(){
  if(!(S.copying || S._starting)) return false;
  showToast('An ingest is running. Settings cannot be imported until it completes.','warn',5000);
  return true;
}
async function importSettingsFile(){
  if(importBusy()) return;
  let r=null;
  try{ r = await window.ingesto.importSettings(); }catch(_){}
  // Asked again on the way back. Choosing a file is a system dialog that can
  // stay open for minutes, and the check above was made before it opened: an
  // ingest started in the meantime would get the new mode, template and
  // algorithm applied to it halfway through.
  if(importBusy()) return;
  if (!r || !r.ok) { if (r && r.error) showToast('Import failed: '+r.error, 'warn'); return; }
  const d = r.data;
  if (!d || d.ingestoSettingsVersion !== 1 || !d.include){ showToast('Not a valid ingesto settings file.', 'warn'); return; }
  // The file's own include map is authoritative: it says what it contains.
  // Within an included category, a missing or unusable value takes the
  // default, as at launch (applySettings, preferences.js).
  const inc = d.include;
  applySettings(d, { from:'export', cats: inc });
  showSettings();
  if (inc.namingTemplate){ renderTemplate(); syncRaw(); }
  if (inc.namingPresets) renderPresets();
  persistPrefs();
  updateSettingsDetails();
  showToast('Settings imported. All included categories applied.', 'ok');
}
