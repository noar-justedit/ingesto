// ═══════════════════════════════════════════════════════
// Ingest history (read back from the reports on the destinations)
// ═══════════════════════════════════════════════════════
// The centre column holds more than the volumes, or it would sit empty as
// soon as they are listed. It carries what was ingested on the
// destinations currently loaded, READ BACK from the reports written on those
// drives: it survives a restart of the app, and a drive that arrives from
// another machine brings its history with it. Nothing here is kept in memory.
let _sessBusy = false, _sessAgain = false;
let _sessRows = [];   // what is on screen right now, so Clear hides exactly that
// One line of the history, identified by what the report records about it.
// The date carries the minute, so a counter and a card name reused on another
// shoot make another key.
function historyKey(r){ return [r && r.n, r && r.card, r && r.date].map(x => String(x == null ? '' : x)).join('|'); }
// Clearing the history hides the lines currently listed. It deletes nothing:
// the history is read from the INGESTO_report files on the destinations, which
// are the record handed to the client, and the app has no business erasing
// them. The hidden keys are kept in the preferences so a cleared history stays
// cleared after a restart, and the empty state offers to show it again.
function clearIngestHistory(){
  if(!_sessRows.length) return;
  // Translated paragraph by paragraph, so the blank line between them stays.
  if(!confirm(tr('Clear the ingest history?')+'\n\n'+tr('The lines are only hidden in ingesto. The reports on the drives are kept, untouched.'))) return;
  const keep = Array.isArray(S.historyHidden) ? S.historyHidden : [];
  const add = _sessRows.map(row => historyKey(row.rec));
  // Capped so the preferences file cannot grow without end: the oldest keys go
  // first, and they belong to drives long gone from the list anyway.
  S.historyHidden = [...new Set(keep.concat(add))].slice(-5000);
  S.historyClearedAt = new Date().toISOString();
  persistPrefs();
  refreshSessionLog();
}
function restoreIngestHistory(){
  S.historyHidden = [];
  S.historyClearedAt = '';
  persistPrefs();
  refreshSessionLog();
}
async function refreshSessionLog(){
  const card = document.getElementById('sess-card');
  if(!card) return;
  const dests = S.dests.slice();
  if(!dests.length){ card.style.display='none'; return; }
  // One read at a time: it touches the drives. A call that arrives during a
  // read is REMEMBERED rather than dropped. Dropping it would mean that dropping
  // two destinations in quick succession leaves the log describing only the
  // first.
  if(_sessBusy){ _sessAgain = true; return; }
  _sessBusy = true;
  try{
    // Each destination answers with the records of ITS report. The same card
    // written to two drives appears once, with both drive names beside it.
    const byKey = new Map();
    for(const d of dests){
      let res=null;
      try{ res = await window.ingesto.reportRead(d.path); }catch(_){ res=null; }
      if(!res || res.unreadable || !Array.isArray(res.records)) continue;
      for(const r of res.records){
        const key = String(r.n||'') + '\u0000' + String(r.card||'');
        const prev = byKey.get(key);
        if(prev){
          prev.drives.push(d.name||d.path);
          // A card that failed on ANY destination is a card that failed.
          if(r.rclass==='r-err' || prev.rec.rclass==='r-err'){
            prev.rec = (r.rclass==='r-err') ? r : prev.rec;
          }
        }else{
          byKey.set(key, { rec:r, drives:[d.name||d.path], destPath:d.path });
        }
      }
    }
    // Lines cleared by the operator are hidden here, and only here: the reports
    // on the drives are the archival record and are never touched.
    const hidden = new Set(Array.isArray(S.historyHidden) ? S.historyHidden : []);
    const rows=[...byKey.values()]
      .filter(row => !hidden.has(historyKey(row.rec)))
      .sort((a,b)=>String(b.rec.n||'').localeCompare(String(a.rec.n||'')));
    _sessRows = rows;
    renderSessionLog(rows);
    card.style.display='flex';
  } finally {
    _sessBusy = false;
    if(_sessAgain){ _sessAgain = false; refreshSessionLog(); }
  }
}
// Which lines are open. Kept across redraws (a new ingest redraws the list),
// not across restarts: it is a way of looking, not a setting.
const _sessOpen = new Set();
// The second line of an entry. Everything comes from the record written in the
// report on the drive: nothing is measured again, nothing is kept elsewhere.
// A report written by an older version may lack the timings: they read "-".
function sessDetails(row){
  const r=row.rec||{};
  const num=x=>(typeof x==='number'&&isFinite(x)&&x>0)?x:0;
  const copy=num(r.copyMs), v1=num(r.v1Ms), v2=num(r.v2Ms), total=copy+v1+v2;
  const bytes=num(Number(r.bytes));
  const speed=(copy&&bytes)?bytes/(copy/1000):0;
  const phases=[copy?`copy ${fmtReportDur(copy)}`:'', v1?`verify ${fmtReportDur(v1)}`:'', v2?`card re-read ${fmtReportDur(v2)}`:'']
    .filter(Boolean).join(' · ');
  const who=[r.operator, r.cam, r.pp].filter(x=>x).join(' · ');
  // user=true: the value is the user's (names, note), never translated.
  const cell=(k,v,wide,user)=>`<div class="sd-cell${wide?' sd-wide':''}"><div class="sd-k">${k}</div><div class="sd-v"${user?' data-i18n-skip':''}>${v}</div></div>`;
  return `<div class="sess-det">`
    + cell('DATE', esc(r.date||'-'))
    + cell('FILES', esc(String(r.files!=null?r.files:'-')))
    + cell('SIZE', bytes?esc(fmtSize(bytes)):'-')
    + cell('DURATION', total?esc(fmtReportDur(total)):'-')
    + cell('COPY SPEED', speed?esc(fmtSpd(speed)):'-')
    + cell('MODE', esc(r.mode||'-'))
    + (phases?cell('PHASES', esc(phases), true):'')
    + cell('DESTINATIONS', esc(row.drives.join(', ')), true, true)
    + (who?cell('OPERATOR · CAMERA · PROFILE', esc(who), true, true):'')
    + (r.note?cell('NOTE', `<div class="md-note">${mdToHtml(r.note)}</div>`, true, true):'')
    + (r.rclass==='r-err'||r.rclass==='r-suspect'?cell('RESULT', esc(r.result||''), true):'')
    + `</div>`;
}
const SESS_ICON = {
  'r-ok':      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#35c98b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 6 9 17l-5-5"/></svg>',
  'r-err':     '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f2555a" stroke-width="2.2" stroke-linecap="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 16.5h.01"/></svg>',
  'r-suspect': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f2a03d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
};
function renderSessionLog(rows){
  const list=document.getElementById('sess-list');
  const sum=document.getElementById('sess-sum');
  if(!list) return;
  const clr=document.getElementById('sess-clear');
  if(clr) clr.disabled = !rows.length;
  if(!rows.length){
    if(S.historyClearedAt){
      const d=new Date(S.historyClearedAt), p=x=>String(x).padStart(2,'0');
      const when=isNaN(d)?'':` on ${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} at ${p(d.getHours())}:${p(d.getMinutes())}`;
      list.innerHTML=`<div class="sess-empty">History cleared${when}. The reports on the drives are untouched.`+
        `<button class="sess-restore">Show it again</button></div>`;
      list.querySelector('.sess-restore').onclick = function(){ restoreIngestHistory(); };
    } else {
      list.innerHTML='<div class="sess-empty">Nothing has been ingested on these destinations yet.</div>';
    }
    if(sum) sum.textContent='';
    return;
  }
  const bytes=rows.reduce((a,r)=>a+(Number(r.rec.bytes)||0),0);
  // "Show it again" lives here too, not in the empty state only. Plug a second
  // drive that has its own history and the list is not empty any more: the way
  // back would disappear while the first drive's lines stayed hidden for ever.
  const hiddenN = (Array.isArray(S.historyHidden) ? S.historyHidden : []).length;
  if(sum) sum.innerHTML = esc(`${rows.length} card${rows.length>1?'s':''} · ${fmtSize(bytes)}`)
    + (hiddenN ? ` · <button class="sess-restore">${hiddenN} hidden, show again</button>` : '');
  { const rb = sum && sum.querySelector('.sess-restore'); if(rb) rb.onclick = function(){ restoreIngestHistory(); }; }
  list.innerHTML=rows.map((row,idx)=>{
    const r=row.rec;
    const cls=['r-ok','r-err','r-suspect'].includes(r.rclass)?r.rclass:'r-ok';
    const col=cls==='r-err'?'#f2555a':(cls==='r-suspect'?'#f2a03d':'#35c98b');
    // "VERIFIED" only for a mode that read the copy back (SECURE, PRO). A
    // FAST or SIZE CHECK line that went fine is COPIED: VERIFIED here would
    // contradict its own details, which say "not verified".
    const readBack = !['m-fast','m-sizecheck','m-verified'].includes(r.modeClass);
    const state=cls==='r-err'?'FAILED':(cls==='r-suspect'?'SUSPECT':(readBack?'VERIFIED':'COPIED'));
    // Two drives is the common case and reads better as a count; one drive is
    // named, because knowing WHICH one is the useful part.
    const drives=row.drives.length>1?`${row.drives.length} drives`:esc(row.drives[0]||'');
    const open = _sessOpen.has(historyKey(r));
    return `<div class="sess-item${open?' open':''}"><div class="sess-row" role="button" tabindex="0" data-i="${idx}"
      aria-expanded="${open?'true':'false'}" aria-label="Details of ${esc(r.card||'')}">
      <svg class="sess-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      ${SESS_ICON[cls]}
      <span class="sess-n">${esc(r.n||'')}</span>
      <span class="sess-name">${esc(r.card||'')}</span>
      <span class="sess-folder">${esc(r.folder||r.card||'')}</span>
      <span class="sess-drives"${row.drives.length>1?'':' data-i18n-skip'}>${drives}</span>
      <span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:${col};background:${col}26;padding:2px 6px;border-radius:4px;flex-shrink:0;">${state}</span>
      <button class="sess-rev" data-i="${idx}" aria-label="Reveal ${esc(r.card||'')} on the destination" title="Reveal on the destination"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></button>
    </div>${sessDetails(row)}</div>`;
  }).join('');
  // A click on the line, or Enter / Space, opens its details. The reveal
  // button keeps its own job.
  list.querySelectorAll('.sess-row').forEach(el=>{
    const row=rows[+el.dataset.i]; if(!row) return;
    const toggle=()=>{
      const k=historyKey(row.rec);
      if(_sessOpen.has(k)) _sessOpen.delete(k); else _sessOpen.add(k);
      const item=el.parentElement, on=_sessOpen.has(k);
      item.classList.toggle('open', on); el.setAttribute('aria-expanded', on?'true':'false');
    };
    el.addEventListener('click', e=>{ if(e.target.closest('.sess-rev')) return; toggle(); });
    el.addEventListener('keydown', e=>{ if(e.target!==el) return; if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } });
  });
  // The path is bound in a closure rather than interpolated into an onclick:
  // a folder name comes from a card, and a card is named by whoever formatted
  // it. Same rule as the volume rows.
  list.querySelectorAll('.sess-rev').forEach(btn=>{
    const row=rows[+btn.dataset.i]; if(!row) return;
    btn.addEventListener('click',()=>{
      // The folder comes from a report that lives on the destination, and that
      // drive can be a share anyone writes to. Keep the plain segments only:
      // no "..", no leading slash, nothing that could climb out of the drive.
      const folder=String(row.rec.folder||'').replace(/\\/g,'/').split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..').join('/');
      const full=folder ? (row.destPath.replace(/\/+$/,'') + '/' + folder) : row.destPath;
      try{ window.ingesto.revealPath(full); }catch(_){}
    });
  });
}

function setCenterView(v){
  S.centerView = v;
  const onTf = (v === 'transfers') && S.copying;
  document.getElementById('tf-list').classList.toggle('on', onTf);
  // The queue takes the whole column. Left under it, the ingest history would
  // squeeze three cards and their destinations into a 200-pixel window.
  document.body.classList.toggle('tf-on', onTf);
  document.getElementById('vols-grid').style.display = onTf ? 'none' : '';
  // During an ingest the heading is the one beside the ring — INGEST QUEUE (N).
  // Keeping "Transfers" here as well would repeat the same word twice in 20
  // pixels.
  { const ct = document.getElementById('center-title');
    ct.textContent = 'Mounted Volumes';
    ct.style.display = onTf ? 'none' : ''; }
  { const vc = document.getElementById('vcnt');
    if(vc) vc.style.display = onTf ? 'none' : ''; }
  ['fb-system','fb-network','fb-showhidden','refresh-btn','vcnt-hidden'].forEach(id => {
    const el = document.getElementById(id); if(el) el.style.display = onTf ? 'none' : '';
  });
  if(onTf) tfPaint(); else renderVolumes();
}

// Sources and Destinations are locked for the whole ingest. The engine works
// from the list, the template, the counter and the mode as they were at START;
// a control that still answers a click during a run is a control that promises
// a change the copy will never make. Cancel, Pause and the view switch stay
// live — they are the two things the operator legitimately needs mid-run.
function setIngestLock(on){
  document.body.classList.toggle('ingesting', !!on);
  applyIngestLock();
}
// The CSS (body.ingesting .lockable) is what actually stops the clicks, and it
// keeps working on rows redrawn mid-ingest. Setting `disabled` on top of it is
// belt and braces — keyboard focus and Enter cannot reach a locked field
// either — so it is re-applied after every redraw of a locked area.
function applyIngestLock(){
  const on = document.body.classList.contains('ingesting');
  document.querySelectorAll('.lockable').forEach(root => {
    const els = root.matches('input,textarea,button,select')
      ? [root] : root.querySelectorAll('input,textarea,button,select');
    els.forEach(el => { el.disabled = on; });
    root.querySelectorAll('[draggable]').forEach(el => el.setAttribute('draggable', on ? 'false' : 'true'));
    // The formatted notes view is not a form field: disabled does not exist
    // for it, contenteditable does.
    root.querySelectorAll('[data-mdn-ed]').forEach(el => el.setAttribute('contenteditable', on ? 'false' : 'true'));
  });
}

function tfEnter(){
  tfInit();
  document.getElementById('tf-ring').style.display = '';
  document.getElementById('tf-stats').classList.add('on');
  setCenterView('transfers');
}

function tfExit(){
  S.tf = null; S._tfSig = ''; S.centerView = 'volumes';
  const rg = document.getElementById('tf-ring');   if(rg) rg.style.display = 'none';
  const st = document.getElementById('tf-stats');  if(st) st.classList.remove('on');
  const tl = document.getElementById('tf-list');   if(tl) tl.classList.remove('on');
  document.body.classList.remove('tf-on');
  const vg = document.getElementById('vols-grid'); if(vg) vg.style.display = '';
  const ct = document.getElementById('center-title');
  if(ct){ ct.textContent = 'Mounted Volumes'; ct.style.display = ''; }
  const vc = document.getElementById('vcnt'); if(vc) vc.style.display = '';
  ['fb-system','fb-network','fb-showhidden','refresh-btn'].forEach(id => {
    const el = document.getElementById(id); if(el) el.style.display = '';
  });
  renderVolumes();
}

function onProgress(d){
  // The model FIRST: the kiosk ring and the header ring both read the queue
  // figure straight out of it. Updating it afterwards would leave them one
  // event behind, and the ring would never reach 100% on the last card.
  tfProgress(d);
  if(S.kioskMode) kioskProgress(d);
  pushSpark(d.speed);

  const phase = d.phase==='verify' ? (d.pass==='source'?'Card re-read':'Verifying') : 'Copying';
  const col   = d.phase==='verify' ? (d.pass==='source'?'var(--pro)':'var(--blue)') : 'var(--green)';
  const strip = document.getElementById('tf-stats');
  if(strip) strip.style.setProperty('--pb-color', col);

  const set = (id, html) => { const el=document.getElementById(id); if(el) el.innerHTML = html; };
  const txt = (id, t)    => { const el=document.getElementById(id); if(el) el.textContent = t; };

  { const t=document.getElementById('h-title');
    if(t){ t.textContent = phase; t.style.color = col; } }
  txt('h-file', d.currentFile || '-');
  // During verification the engine counts CHECKS — one per file per
  // destination, plus the source pass — because that is what its progress
  // measures. Labelling that figure "Files" would make a 168-file card read as
  // 504 files; the card heading keeps the card's own count, and this tile says
  // what it is actually counting.
  txt('h-files-label', d.phase === 'verify' ? 'Checks Remaining' : 'Files Remaining');
  set('h-files', `${d.remainingFiles} <span class="stot">(${d.totalFiles})</span>`);
  set('h-size',  fmtSizePair(d.totalBytes-d.copiedBytes, d.totalBytes));
  txt('h-spd', fmtSpd(d.speed));
  txt('h-eta', fmtEta(d.eta));
  txt('h-err', String(d.errors||0));
  const eb = document.getElementById('h-errbox');
  if(eb) eb.style.display = d.errors>0 ? '' : 'none';
}

function onComplete(R){
  S.copying=false;
  setIngestLock(false);
  // Back to the volumes: the ingest is over, and the summary takes the stage.
  tfExit();
  // Increment counter by number of sources (not multiplied by destinations).
  // Count by PATH so two identically-named cards still advance it by two.
  const srcCount=[...new Set(R.map(r=>r.sourcePath||r.sourceName))].length;
  // The numbers actually written on disk, not whatever the field holds by now.
  const reportBase=(S.run && S.run.base!=null) ? S.run.base : S.counter;
  S.counter=reportBase+srcCount;
  // If user had not overridden, keep auto mode
  renderCounter();
  updateBtn();persistPrefs();
  window.ingesto.setPowerBlock(false);
  if(S.run && S.run.report && S.run.report.any){
    // The log reads the reports, so it is refreshed AFTER they are written.
    updateReports(R, reportBase, S.run).then(()=>refreshSessionLog()).catch(()=>{});
  } else { refreshSessionLog(); }
  // Both read S.run.dests / S.run.sources and are asynchronous, so the snapshot
  // is handed to them explicitly and released only once they hold it.
  const run = S.run;
  // The window is already open by the time this settles, so a failure to
  // deliver comes back as a late remark rather than as nothing at all.
  sendIngestNotification(R, reportBase, run).then(()=>{
    if(S._ntfyFailed) addSummaryNote({ code:'NTFY',
      text:'The phone notification could not be sent.',
      detail: (S.ntfyServer||'ntfy.sh')+' did not answer ('+S._ntfyFailed+'). '+
              'Check the network or the topic name.' });
  }).catch(()=>{});
  runPostHook(R, run);
  runHandoff(R, run);
  // S.run is released at the END of this function, not here. The window is
  // built below, and driveNameOf, the mode line and the "every card is
  // accounted for" check all read the snapshot: released early, they would
  // silently fall back to whatever is on screen at that moment.

  // A refusal is not a result. When the engine turned the whole run away before
  // touching anything, an end-of-ingest window saying "Finished with Errors",
  // with a red cross, an errors count and a reason buried in a scrolling list,
  // would read as "the copy went wrong", and the operator would look at the
  // drive for half-written files that were never there.
  // It gets its own window, and only when EVERY card was refused: one refused
  // card out of three still leaves two real ingests to report.
  if(R.length && R.every(r=>r.refused)){
    // showSummary is what normally resets these; without it a late remark from
    // the hook or from ntfy would render the PREVIOUS run's notes.
    S._summaryNotes=[]; S._lateNotes=[]; renderSummaryNotes([]);
    // The kiosk plays its own sound; playing one here too would make it stutter.
    if(!S.kioskMode) playIngestSound(false);
    if(S.kioskMode) kioskAfterIngest(R); else showEngineRefusal(R);
    S.run = null;
    return;
  }
  if(S.kioskMode) kioskAfterIngest(R); else showSummary(R);
  S.run = null;
}

// The DRIVE, not the last folder before the card. Taking the second-to-last
// path segment works only for templates one level deep: with
// "{YYYY}-{MM}-{DD}/{counter}_{cardname}" it would name the date folder, and
// the window would read "the copy to 2026-09-09" instead of "the copy to
// NAS_BACKUP".
function driveNameOf(r){
  const dp = String((r && r.destPath) || '');
  const rel = String((r && r.relFolder) || '');
  // First answer: the drive the operator actually dropped in the destination
  // zone, by its own name. Everything else is a guess from a path.
  try{
    const known = ((S.run && S.run.dests) || S.dests || []);
    const norm = dp.replace(/\\/g,'/');
    for(const d of known){
      const dpath = String(d && d.path || '').replace(/\\/g,'/').replace(/\/+$/,'');
      if(dpath && (norm === dpath || norm.startsWith(dpath + '/')))
        return d.name || dpath.split('/').filter(Boolean).pop() || tr('the destination');
    }
  }catch(_){}
  let root = dp;
  if(rel){
    const tail = '/' + rel.replace(/\\/g,'/');
    const norm = dp.replace(/\\/g,'/');
    if(norm.endsWith(tail)) root = norm.slice(0, norm.length - tail.length);
  } else {
    root = dp.replace(/\\/g,'/').split('/').slice(0,-1).join('/');
  }
  const base = root.split('/').filter(Boolean).pop();
  return base || tr('the destination');
}

// What the end-of-ingest window is allowed to say when something went wrong.
// The rule the twelve failures share: the title names the DRIVE or the CARD,
// never the number of errors, and the constant line is
// "Do not format this card." Which is true in all twelve.
function failureVerdict(R, ctx){
  const nameOf = driveNameOf;
  const KEEP = 'Do not format this card.';
  // The engine call itself failed and returned nothing. Without this case the
  // fall-through would produce "0 FILES DID NOT SURVIVE THE COPY TO 0 DRIVES".
  if(!R.length) return { title:['THE INGEST DID NOT','RUN'], cls:'t-bad', ico:'err',
    lead:'Nothing was written.', leadKind:'bad' };
  if(ctx.canceled){
    // In a batch, some cards may have finished. Naming the one that stopped
    // beats telling a complete card that it is incomplete.
    const stopped=[...new Set(R.filter(r=>r.canceled).map(r=>r.sourceName||'the card'))];
    return { title:['TRANSFER STOPPED'], cls:'t-warn', ico:'cancel', icoShape:'stop',
      lead:'Nothing was deleted. '+(stopped.length===1?stopped[0]:stopped.join(', '))+
           ' '+(stopped.length===1?'is':'are')+' not complete anywhere.', leadKind:'warn' };
  }

  // A card with nothing on it is not a failure. It must not come back as
  // "Finished with Errors", with the kiosk shouting "Call the boss!" and the
  // phone announcing an error, for an empty card.
  // EVERY entry, not "every entry with at most one error". An empty card sets
  // errors:1, and so does a refusal and a card that lost exactly one clip, so
  // the looser test would print "nothing was lost" over a batch that lost a
  // file.
  const empty = R.find(r=>r.emptyReason);
  if(empty && R.every(r=>r.emptyReason)){
    const n = empty.seenFiles||0;
    return empty.emptyReason==='filtered-out'
      ? { title:['THE FILE FILTER EXCLUDED', n===1?'THE ONLY FILE ON THIS\u00a0CARD'
                                                 :`ALL ${n}\u00a0FILES`], cls:'t-warn',
          ico:'cancel', lead:'Nothing was copied, and nothing was lost.', leadKind:'ok' }
      : { title:['THERE WAS NOTHING','ON THIS\u00a0CARD'], cls:'t-warn', ico:'cancel',
          lead:'Nothing was copied, and nothing was lost.', leadKind:'ok' };
  }
  // A card the engine refused is not a card that lost files: nothing was ever
  // written for it. It must not be counted among the failures below.
  // A refused card and an empty card are both "nothing happened here", and
  // both carry errors:1. Neither may be counted as a lost file below.
  const inert = r => !!(r.refused || r.emptyReason);
  const refusedCards = R.filter(r=>r.refused);
  if(refusedCards.length && R.every(r=>inert(r) || r.success===true) && !ctx.canceled){
    const names=[...new Set(refusedCards.map(r=>r.sourceName||'a card'))];
    const copied = R.some(r=>!inert(r) && r.success===true && (r.copiedFiles||0)>0);
    return { title:[ names.length===1 ? `${names[0]} WAS NOT\u00a0STARTED`
                                      : `${names.length} CARDS WERE NOT\u00a0STARTED`,
                     copied ? 'THE OTHERS WERE\u00a0COPIED' : 'NOTHING WAS\u00a0COPIED' ],
             cls:'t-warn', ico:'cancel',
             lead:'Nothing was written for '+(names.length===1?'it':'them')+'.', leadKind:'warn' };
  }
  if(ctx.ok){
    if(ctx.missingSidecars.length) return { title:ctx.okTitle.split('\n'), cls:'t-warn', ico:'cancel',
      lead:'Every file was copied and verified. This folder cannot be re-verified later.',
      leadKind:'warn' };
    return { title:[ctx.okTitle], cls:'t-ok', ico:'ok', lead:'', leadKind:'ok' };
  }
  // The worst outcome this application can produce: it gets the title, not
  // one line in a scrolling list.
  // Only when the copy really failed its comparison. A drive pulled out of the
  // socket also fails to rename the bad copy aside, and that headline would
  // then accuse a folder of holding a corrupt file that does not exist.
  if(R.some(r=>(r.errorList||[]).some(e=>e.notQuarantined && /mismatch/i.test(String(e.error||'')))))
    return { title:['A CORRUPT FILE IS SITTING','IN THE DELIVERED\u00a0FOLDER'], cls:'t-bad',
             ico:'err', lead:KEEP, leadKind:'bad' };
  // The re-copy worked, and the card is still the one the first run could not
  // read. Said here rather than in a remark, because the title is what decides
  // whether the card gets formatted.
  // Only when the re-copy itself went through. A retry that copied nothing
  // because the drive is full is a DRIVE failure, and this title would point
  // the operator at the card and the reader instead.
  if(ctx.retrySuspect && R.every(r=>r.success===true))
    return { title:['THE FILES WERE\u00a0RE-COPIED','THIS CARD IS STILL\u00a0SUSPECT'],
    cls:'t-bad', ico:'err', lead:KEEP+' Copy it again on another\u00a0reader.', leadKind:'bad' };
  // The card is the problem. Opposite conclusion from a drive failure, so it is
  // a different window: it does not talk about drives, and EJECT is withheld.
  const unstable=R.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
  if(unstable) return { title:['THIS CARD IS NOT GIVING','THE SAME DATA\u00a0TWICE'], cls:'t-bad',
    ico:'err', lead:KEEP+' Copy it again on another\u00a0reader.', leadKind:'bad' };
  if(R.some(r=>r.scanIncomplete)) return { title:['PART OF THIS CARD','COULD NOT BE\u00a0READ'],
    cls:'t-bad', ico:'err', lead:KEEP+' Copy it again on another\u00a0reader.', leadKind:'bad' };
  const srcFail=R.some(r=>(r.errorList||[]).some(e=>e.origin==='source'));
  if(srcFail) return { title:['THIS CARD COULD NOT','BE READ IN\u00a0FULL'], cls:'t-bad', ico:'err',
    lead:KEEP+' Copy it again on another\u00a0reader.', leadKind:'bad' };
  // The common case: the card is intact, a drive did not keep up. Name the
  // drive, and say how many files it lost.
  const bad=R.filter(r=>!inert(r) && (r.errors>0 || (r.failedFiles&&r.failedFiles.length)));
  if(!bad.length) return { title:['THIS INGEST DID NOT','FINISH CLEANLY'], cls:'t-bad', ico:'err',
    lead:KEEP, leadKind:'bad' };
  const drives=[...new Set(bad.map(nameOf))];
  const n=[...new Set(bad.flatMap(r=>r.failedFiles||[]))].length || bad.reduce((a,r)=>a+(r.errors||0),0);
  return { title:[`${n} FILE${n>1?'S':''} DID NOT\u00a0SURVIVE`,
                  `THE COPY TO ${drives.length===1?drives[0]:drives.length+' DRIVES'}`],
           cls:'t-bad', ico:'err', lead:KEEP, leadKind:'bad' };
}

// ── Failures, grouped by cause ─────────────────────────────────────────────
// Raw system codes are for bug reports, not for the person holding the card.
// The code is kept, small and grey, at the end of the sentence.
function humanErrno(msg){
  const t=String(msg||'');
  const M=[
    [/ENOSPC/i,      'The drive ran out of space.',                  'ENOSPC'],
    [/EDQUOT/i,      'The drive quota was reached.',                 'EDQUOT'],
    [/EIO\b/i,       'The drive or the card stopped answering.',     'EIO'],
    [/ENXIO|ENODEV/i,'The drive was disconnected during the copy.',  'ENODEV'],
    [/EACCES|EPERM/i,'ingesto was not allowed to write there.',      'EACCES'],
    [/EROFS/i,       'The drive is read-only.',                      'EROFS'],
    [/ENOENT/i,      'The file was gone when ingesto reached it.',   'ENOENT'],
    [/ENAMETOOLONG/i,'The path is too long for this filesystem.',    'ENAMETOOLONG'],
    [/EBUSY/i,       'The file was in use by another program.',      'EBUSY'],
    [/ETIMEDOUT|ESTALE|ECONNRESET/i,'The network drive stopped responding.','network'],
  ];
  for(const [re,text,code] of M) if(re.test(t)) return { text, code };
  return null;
}
// One entry per CAUSE, each carrying its files. Order matters: the most serious
// first, because the operator reads the top of the block and acts.
function buildFailureGroups(R){
  const add=(map,key,what,why,code,unit)=>{
    if(!map.has(key)) map.set(key,{ what, why, code:code||'', unit:unit||'file', files:[] });
    return map.get(key);
  };
  const g=new Map();
  // The worst thing this application can produce: a corrupt file wearing its
  // real name in the delivered folder. It must not get lost as one line in a
  // scrolling list: it comes first, and it names the file.
  for(const r of R) for(const e of (r.errorList||[])){
    if(!e.notQuarantined) continue;
    add(g,'quarantine-failed','A corrupt file is still in the delivered folder',
      'It failed verification and could not be set aside, so it wears its real name and nothing '+
      'downstream will know it is bad. Delete it by hand, or copy the card again.')
      // Named per DRIVE: the same file failing on two destinations leaves two
      // corrupt files in two folders, and the operator has to visit both.
      .files.push(driveNameOf(r)+'/'+(r.relFolder?r.relFolder+'/':'')+(e.destRel||e.file));
  }
  const unstable=[...new Set(R.flatMap(r=>r.unstableFiles||[]))];
  if(unstable.length){
    add(g,'unstable','Read twice from the card, two different answers',
      'A card near the end of its life returns changing data. The copies on the drives may both be '+
      'wrong, so check these files by eye in your edit software and prefer another copy if one '+
      'exists. Copying the card again will not help. They were left out of the verification list.')
      .files.push(...unstable);
  }
  if(R.some(r=>r.scanIncomplete)){
    add(g,'scan','Part of the card could not be read at all',
      'The file counts above describe what ingesto could see. There may be more on the card.',
      '', 'folder').files.push('(the card could not be listed completely)');
  }
  for(const r of R) for(const e of (r.errorList||[])){
    if(e.phase==='warning' || e.notQuarantined) continue;   // remarks live elsewhere
    // A refusal that reached the summary (one refused card in a batch) has its
    // whole explanation in this line. Filtering every "(...)" file name would
    // delete it, leaving a window that announces a lost file and explains
    // nothing.
    if(e.refused || e.phase==='setup'){
      add(g,'refused-'+(r.sourceName||''), `${r.sourceName||'This card'} was not started`,
        String(e.error||'').replace(/\s+/g,' '), '', 'card').files.push(r.sourceName||'(card)');
      continue;
    }
    if(e.file && String(e.file).startsWith('(')) continue;   // sidecars have their own remark
    // Order matters. A read-back that fails with EIO is a verify failure, not a
    // file that was never copied: the copy IS on the drive, quarantined. Saying
    // "not copied" would send the operator looking for a file that is there.
    // A verify failure is "corrupt on arrival" only when the comparison itself
    // disagreed. A drive unplugged mid-verify also fails in this phase, and
    // testing the phase alone would report ENODEV as content corruption, with a
    // headline about a corrupt file in the delivered folder.
    if(e.phase==='verify' && /mismatch/i.test(String(e.error||''))){
      add(g,'verify','Corrupt on arrival. Read back and compared, they differ',
        'The bad copies were set aside as .ingesto-failed so no wrong file wears a good name.')
        .files.push(e.file);
      continue;
    }
    const h=humanErrno(e.error);
    if(h){
      // A scan error carries no origin and is by definition a read of the CARD.
      const onCard = e.origin==='source' || e.phase==='scan';
      add(g,'errno:'+h.code+(onCard?':src':':dst'), h.text,
        (onCard ? 'On the card.' : 'On the destination.')+
        (e.phase==='verify'
          ? ' The files below were copied but could not be read back and checked.'
          : ' The files below were not copied.'), h.code).files.push(e.file);
      continue;
    }
    if(e.origin==='source'){
      add(g,'src-read','These files could not be read from the card',
        'The card answered with an error. Try another reader before copying again.').files.push(e.file);
      continue;
    }
    add(g,'dest-write','These files could not be written to the destination',
      'The drive refused or interrupted the write. Nothing was left under a real name.')
      .files.push(e.file);
  }
  // Same file failing on two destinations is one file, not two.
  return [...g.values()].map(x=>({ ...x, files:[...new Set(x.files)] })).filter(x=>x.files.length);
}
function toggleFailGroup(gi){
  const box=document.getElementById('fg-f-'+gi), car=document.getElementById('fg-car-'+gi);
  if(!box) return;
  const open=box.style.display==='none';
  box.style.display=open?'':'none';
  if(car) car.classList.toggle('open', open);
}

// The engine's own refusals, in the same window as the interface's. Same nine
// situations, so the same nine texts: the operator must not be told two
// different things depending on which side noticed.
function showEngineRefusal(R){
  // One window per distinct refusal, opened in turn: a batch refused for two
  // different reasons would otherwise show the first and drop the second
  // silently.
  const byCode=new Map();
  for(const r of R){ const k=(r.refusalCode||'')+'|'+(r.sourceName||'');
                     if(!byCode.has(k)) byCode.set(k, r); }
  const distinct=[...byCode.values()];
  if(distinct.length>1){
    (async()=>{ for(const one of distinct) await showOneEngineRefusal([one]); })();
    return;
  }
  showOneEngineRefusal(R);
}
function showOneEngineRefusal(R){
  const r0=R[0]||{};
  const d=r0.refusalData||{};
  const m = x => `<span class="m">${esc(x)}</span>`;
  const NUM=['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
  const CANCEL={ label:'CANCEL', value:'cancel', style:'ghost' };
  const EDIT=tok=>({ label:'EDIT TEMPLATE', value:'edit', style:'fix', act:()=>pfEditTemplate(tok) });
  const card=d.card||r0.sourceName||'this card';
  const dest=d.dest||'the destination';
  const S9={
    'PF-E1':{ title:['This card would be written','into the destination root'],
      cause:`The template gives card ${m(card)} no folder of its own. Every card would land side by `+
            `side in ${m(dest)}, each one overwriting the last.`,
      action:`Add ${m('{counter}')} or ${m('{cardname}')} to the last level of the template.`,
      buttons:[EDIT('{counter}'), CANCEL] },
    'PF-E2':{ title:['This card would share a folder','with every other card'],
      cause:`The last level of the template, the <span class="g">green</span> part, produces nothing `+
            `for card ${m(card)}. It would be written into ${m((d.shared||'')+'/')}, the folder it `+
            `shares with the whole day.`,
      action:'Put something in the last level, or fill the field it uses.',
      buttons:[EDIT('{cardname}'), CANCEL] },
    'PF-E3':{ title:['One folder level is not','a usable name'],
      cause:`The template produces ${m(d.seg||'(empty)')} as a level for card ${m(card)}. No drive `+
            `accepts that as a folder name.`,
      action:'Fix that level of the template.', buttons:[EDIT(null), CANCEL] },
    'PF-E4':{ title:['The template asks for',`${NUM[d.levels]||d.levels} levels of folders`],
      cause:`The limit is ${NUM[d.limit]||d.limit}. Deeper trees make long paths that Windows refuses `+
            `and that nobody can read on a drive.`,
      action:`Remove a ${m('/')} from the template.`, buttons:[EDIT('/'), CANCEL] },
    'PF-E5':{ title:['The counter is not',"in the card's folder"],
      cause:`${m('{counter}')} sits on a subfolder level. It numbers cards, not days or cameras: on a `+
            `shared level it would give every card of the day the same number.`,
      action:`Move it after the last ${m('/')}, into the <span class="g">green</span> part.`,
      buttons:[EDIT('{counter}'), CANCEL] },
    'PF-E6':{ title:['The destination is','the card itself'],
      cause:`${m(d.destPath||dest)} is the source card ${m(card)}, or a folder inside it. The card `+
            `would be copied into itself, then flagged as ingested and offered for ejection.`,
      action:'Remove one of the two.',
      buttons:[{ label:'REMOVE DESTINATION', value:'removed', style:'fix',
                 act:()=>{ if(d.destPath) removeFromZone('dst', d.destPath); } }, CANCEL] },
    'PF-E7':{ title:['The file filter would','copy nothing'],
      cause:'The filter is on and no format is checked. Not a single file would be copied, and the '+
            'ingest would still report a success.',
      action:'Check at least one format, or turn the filter off.',
      buttons:[{ label:'OPEN FILE FILTER', value:'filter', style:'fix', act:()=>pfOpenFilter() }, CANCEL] },
    'PF-E8':{ title:[`${dest} disappeared`,'between the check and the copy'],
      cause:'The drive was there when ingesto checked, and gone when it started to write. Nothing was '+
            'copied.',
      action:'Reconnect it and start again.',
      // The button has to DO the recheck: without an act it would be decoration.
      buttons:[{ label:'RECHECK DRIVES', value:'recheck', style:'fix',
                 act:()=>{ setIngestLock(false); setTimeout(()=>startCopy(), 0); } }, CANCEL] },
    'PF-E9':{ title:['That folder already exists','and holds files'],
      cause:`${m(d.folder||'')} on ${m(dest)} is not empty. ingesto never writes into an existing card `+
            `folder, that is how footage gets overwritten.`,
      action:'Use another counter, or check what is already in there.',
      buttons:[{ label:'CHANGE COUNTER', value:'counter', style:'fix', act:()=>pfChangeCounter() }]
        .concat(d.absPath?[{ label:'REVEAL FOLDER', value:'reveal', act:()=>revealPath(d.absPath) }]:[])
        .concat([CANCEL]) },
  };
  const spec = S9[r0.refusalCode];
  // An unknown code must still produce a refusal window, not a summary window:
  // the one thing that must never change is "nothing has been written".
  const fallback = {
    title:['This ingest was not started','by ingesto'],
    cause: esc(((r0.errorList||[])[0]||{}).error || 'The ingest was refused before it began.'),
    action:'Nothing is on the drive. Fix what the message names and start again.',
    buttons:[CANCEL] };
  return showRefusal(Object.assign({ kind:'block', lead:'Nothing has been written.',
                                     code:r0.refusalCode }, spec || fallback));
}
