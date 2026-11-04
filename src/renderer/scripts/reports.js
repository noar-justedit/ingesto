async function openReport(){
  if(!S.dests.length){ showToast('No destination set, no report yet.','warn',3500); return; }
  // The history merges the reports of every destination, so opening it must
  // not stop at the first one: with a new drive in DST1 and the history coming
  // from DST2, the button would answer "no report" over a list of cards it had
  // just drawn.
  for(const d of S.dests){
    let ok=false;
    try{ ok = await window.ingesto.reportOpen(d.path); }catch(_){ ok=false; }
    if(ok) return;
  }
  showToast('No report on these destinations yet.','warn',3500);
}
function reportModeLabel(r){
  const ALG={xxh64:'xxHash64',xxh128:'xxHash128',md5:'MD5'};
  // "Verified" is reserved for a read-back: SECURE and PRO. NORMAL checks
  // sizes, FAST checks nothing, and the report is the archival record.
  return r.mode===MODE.PRO ? 'PRO · '+(ALG[r.proAlgo]||r.proAlgo||'') : ({fast:'Fast (not verified)',normal:'Size check (not verified)',slow:'Secure'}[r.mode]||r.mode||'-');
}
// The class says what the mode IS, not how good it sounds. `normal` maps to
// m-sizecheck (blue, as in the app's own legend), never to a green class: the
// archival record would print "Size check (not verified)" in the colour the
// rest of the app reserves for a verified copy. Read months later by someone
// who did not run the ingest, that green would be a lie.
function reportModeClass(r){ return {fast:'m-fast',normal:'m-sizecheck',slow:'m-secure',pro:'m-pro'}[r.mode]||''; }
function fmtReportDate(iso){
  try{ const d=new Date(iso),p=x=>String(x).padStart(2,'0');
    return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }catch(_){ return iso||'-'; }
}
async function updateReports(R, base, run){
  // Which files this run writes was decided when START was pressed, not here.
  const RP = (run && run.report) || { html:true, csv:false, json:false, full:true };
  // The destinations and the card metadata of THE RUN, not whatever is on
  // screen by the time this async function gets there.
  const runDests   = (run && run.dests)   || S.dests;
  const runSources = (run && run.sources) || S.sources;
  // Group by source PATH, not name: two cards labelled the same ("Untitled",
  // "NO NAME") would collapse into one record, dropping the second card from
  // the client-facing report entirely.
  const uniq=[...new Set(R.map(r=>r.sourcePath||r.sourceName))];
  const now=new Date(), p=x=>String(x).padStart(2,'0');
  // One date format everywhere: DD.MM.YYYY HH:MM. The year stays in the
  // report lines: this is the one document meant to be archived.
  const dateStr=`${p(now.getDate())}.${p(now.getMonth()+1)}.${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
  const isoNow=now.toISOString();
  const newRecs=uniq.map((sp,i)=>{
    const rs=R.filter(r=>(r.sourcePath||r.sourceName)===sp), r0=rs[0], name=r0.sourceName;
    const src=runSources.find(s=>s.path===sp)||runSources.find(s=>s.name===name)||{};
    const errors=rs.reduce((a,r)=>a+(r.errors||0),0);
    const failed=rs.reduce((a,r)=>a+((r.failedFiles&&r.failedFiles.length)||0),0);
    const unstable=rs.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
    // A cancelled ingest must NEVER be recorded as "OK" — the report is the
    // client-facing proof of archival. Show it as cancelled and count only what
    // was actually copied, not the full scan total.
    // `some`, not `every`: one destination stopped is a card NOT fully backed up.
    const canceled=rs.length>0 && rs.some(r=>r.canceled);
    const notOk=rs.some(r=>r.success!==true);
    const copiedFiles=rs.reduce((a,r)=>a+(r.copiedFiles||0),0);
    const copiedBytes=rs.reduce((a,r)=>a+(r.copiedBytes||0),0);
    // The report is the archival record: the caveats the summary shows on
    // screen (read-back possibly answered from memory, the PRO card re-read
    // that did not really run) belong here too, or the archive says "OK"
    // where the screen said "heads-up".
    const cached = rs.some(r=>r.doubleReadCached) ? ' · card re-read came from memory'
                 : rs.some(r=>r.coldVerify===false) ? ' · read-back may have come from memory' : '';
    const skippedN = r0.skippedFiles||0;
    let result='OK'+cached+(skippedN>0?` · ${skippedN} already on drive, not copied`:''), rclass='r-ok';
    if(canceled){ result='canceled'; rclass='r-err'; }
    else if(unstable>0){ result='⚠ suspect card'; rclass='r-suspect'; }
    else if(errors>0||failed>0){ const n=errors||failed; result=`${n} error${n>1?'s':''}`; rclass='r-err'; }
    else if(notOk){ result='incomplete'; rclass='r-err'; }
    // What went wrong, file by file. "2 errors" alone is not enough: the
    // end-of-ingest window holds the reason, and it is gone once closed.
    // Capped, so a card that fails everywhere does not
    // turn the report into a log; errsMore says how many were left out.
    const allErrs=[];
    for(const r of rs) for(const e of (r.errorList||[])) allErrs.push(reportErrEntry(e, rs.length>1 ? driveNameOf(r) : ''));
    const errs=allErrs.slice(0, REPORT_ERR_MAX), errsMore=allErrs.length-errs.length;
    return { n:padCounter(base+i, run && run.counterWidth), date:dateStr, card:name,
      // Where the card actually landed under the destination. With subfolders
      // the card name alone does not say where the footage is, and a report
      // that cannot be matched to the drive is worth little.
      folder:r0.relFolder||'',
      operator:src.operator||'', cam:src.camera||'', pp:src.pp||'', note:src.note||'',
      mode:reportModeLabel(r0), modeClass:reportModeClass(r0),
      files:canceled?copiedFiles:(r0.totalFiles||0), bytes:canceled?copiedBytes:(r0.totalBytes||0), result, rclass,
      skipped:r0.skippedFiles||0,
      // Phase timings, in ms. v2 is 0 outside PRO double source read.
      copyMs:r0.copyMs, v1Ms:r0.verify1Ms, v2Ms:r0.verify2Ms,
      // Light report: this card is recorded without its file names. Cards
      // already in the report are carried over untouched.
      fileList:RP.full?(r0.fileList||[]).map(f=>({path:f.path,size:f.size,mtime:f.mtime})):[],
      errs, errsMore };
  });
  for(const d of runDests){
    let created=isoNow, records=[], unreadable=false;
    try{
      const existing=await window.ingesto.reportRead(d.path);
      if(existing && existing.unreadable){
        // The destination HAS a report we could not parse. Its history cannot be
        // carried over, so the old file is kept beside the new one instead of
        // being overwritten, and the operator is told — silently restarting a
        // client-facing report from scratch is not acceptable.
        unreadable=true;
        // "Could not be read" is not true of a report that was simply too big
        // to open, and the two call for different things: one is a damaged
        // file, the other a history that has outgrown one page.
        showToast(existing.tooBig
          ? `The ingest report in "${esc(d.name||d.path)}" is too large to read back. It has been kept as INGESTO_report.unreadable.html and a new one started.`
          : `The ingest report in "${esc(d.name||d.path)}" could not be read. It has been kept as INGESTO_report.unreadable.html and a new one started.`,
          'warn', 8000);
      } else if(existing){ created=existing.created||isoNow; records=Array.isArray(existing.records)?existing.records:[]; }
    }catch(_){}
    records=records.concat(newRecs);
    // A report that could not be written must not fail in silence (the handler
    // answers false): the drive would leave the truck with the footage and no
    // INGESTO_report at all. Say it, once per destination.
    const failedNames=[];
    const w = async (name, fn) => { let r=false; try{ r = await fn(); }catch(_){ r=false; } if(r===false) failedNames.push(name); };
    if(RP.html){ await w('INGESTO_report.html', async () => window.ingesto.reportWrite(d.path, await buildReportHtml(created, isoNow, d.path, records), unreadable)); }
    // No history could be read (HTML and JSON absent or unreadable): the CSV
    // may still hold one, so this run is APPENDED to it rather than replacing it.
    const csvAppend = !(records.length > newRecs.length);
    if(RP.csv){  await w('INGESTO_report.csv',  () => window.ingesto.reportWriteNamed(d.path, 'INGESTO_report.csv', buildReportCsv(csvAppend ? newRecs : records), csvAppend)); }
    if(RP.json){ await w('INGESTO_report.json', () => window.ingesto.reportWriteNamed(d.path, 'INGESTO_report.json', buildReportJson(created, isoNow, d.path, records))); }
    if(failedNames.length){
      showToast(`The ingest report could not be written to "${esc(d.name||d.path)}" (${failedNames.join(', ')}). The footage is there, the report is not. Check that the drive is still mounted and writable.`, 'warn', 10000);
    }
  }
}
// A record's file list, whatever its origin (reportFilePairs(), further down
// in this file): fresh records carry `fileList` ({path,size,…}); records
// RE-READ from a destination's existing report come back slim, as `f`
// ([path,size] pairs). Reading only `fileList` would drop every older card's
// file detail on the next ingest, the client-facing report silently
// amputating itself. Both are normalised to [path,size] pairs.
// Duration for the reports: "-" when the record has no timing (reports from
// earlier versions simply have none), otherwise the same compact style as
// the UI.
function fmtReportDur(ms){
  // 0 means "this phase did not run" (no 2nd verify outside PRO double read),
  // which must read as "-", not "<1s".
  if(typeof ms!=='number' || !isFinite(ms) || ms<=0) return '-';
  const s = ms/1000;
  if(s < 1)    return '<1s';
  const t = Math.round(s);              // round ONCE, then split — rounding the
  if(t < 60)   return `${t}s`;          // seconds separately could print "1m60s"
  if(t < 3600) return `${Math.floor(t/60)}m${String(t%60).padStart(2,'0')}s`;
  return `${Math.floor(t/3600)}h${String(Math.floor((t%3600)/60)).padStart(2,'0')}m`;
}
// One line of the "what went wrong" list of a report. The message comes from
// the engine, in English, like the error itself; it is flattened to one line
// and shortened so that one runaway message cannot swell the report.
const REPORT_ERR_MAX = 50;
function reportErrEntry(e, drive){
  const o = { file:String((e&&e.file)||''), phase:String((e&&e.phase)||''),
              error:String((e&&e.error)||'').replace(/\s+/g,' ').trim().slice(0,400) };
  if (drive) o.drive = String(drive);
  return o;
}
// The list of a record, whatever its origin: a record written by an earlier
// version has none, a record read back from a tampered report may hold
// anything.
function reportErrs(r){
  return (Array.isArray(r && r.errs) ? r.errs : [])
    .filter(x => x && typeof x === 'object').slice(0, REPORT_ERR_MAX)
    .map(x => reportErrEntry(x, x.drive));
}
// The phase, for a person. The engine's codes stay in the data.
function reportPhaseLabel(ph){
  const L = { copy:'Copy', verify:'Verify', source:'Card re-read', scan:'Card scan', setup:'Before the start',
              sidecar:'Manifest', warning:'Warning', retry:'Re-copy' };
  return tr(L[ph] || ph || 'Error');
}
function reportFilePairs(r){
  if (Array.isArray(r.fileList) && r.fileList.length) return r.fileList.map(x=>[x.path, x.size]);
  if (Array.isArray(r.f) && r.f.length) return r.f.map(x=>Array.isArray(x)?[x[0],x[1]]:[x.path,x.size]);
  return [];
}
function buildReportCsv(records){
  const q=(x)=>{
    let s=String(x==null?'':x);
    // CSV formula-injection guard: a cell starting with = + - @ (or a control
    // char) is executed as a formula by Excel/Sheets. Card names and notes are
    // user/label-controlled, so neutralise the leading character.
    if(/^[=+\-@\t\r]/.test(s)) s="'"+s;
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
  // Timings are exported BOTH readable and raw (ms) — the readable one for a
  // human opening the sheet, the raw one so it can be summed or charted.
  // Column titles and the mode and result follow the language; everything
  // else is data. A spreadsheet that reads the CSV by column NUMBER is
  // unaffected; one that reads it by title must use the English export.
  const head=['#','Date','Card','Folder','Operator','Cam','Profile','Mode','Files','Bytes','Size','Result',
              'Copy','Verify','Card re-read','Copy ms','Verify ms','Card re-read ms','Note','Files list','Errors'].map(tr);
  const num=v=>(typeof v==='number'&&isFinite(v))?v:'';
  const rows=records.map(r=>{
    const fl=reportFilePairs(r).map(([p,sz])=>`${p} (${fmtSize(sz)})`).join(' | ');
    return [r.n,r.date,r.card,r.folder||'',r.operator,r.cam,r.pp||'',tr(r.mode),r.files,r.bytes,fmtSize(r.bytes),tr(r.result),
            fmtReportDur(r.copyMs),fmtReportDur(r.v1Ms),fmtReportDur(r.v2Ms),
            num(r.copyMs),num(r.v1Ms),num(r.v2Ms),
            r.note,fl,reportErrsText(r)].map(q).join(',');
  });
  return head.join(',')+'\n'+rows.join('\n')+'\n';
}
// The error list on one line, for the CSV: "file (phase): message | ...".
function reportErrsText(r){
  const list = reportErrs(r).map(x => `${x.drive?x.drive+' / ':''}${x.file} (${reportPhaseLabel(x.phase)}): ${x.error}`);
  const more = Number.isFinite(+r.errsMore) ? (+r.errsMore|0) : 0;
  if (more > 0) list.push(trf('{n} more not listed', {n:more}));
  return list.join(' | ');
}
function buildReportJson(created, updated, destPath, records){
  // Field names, codes and VALUES stay in English, whatever the language:
  // tools read them, and this file is read back by the next ingest when the
  // HTML report is off. A translated `result` ("2 erreurs") would be kept for
  // ever, and a script testing result === "canceled" would break on a French
  // station. The texts for a person are added next to them.
  const out = records.map(r => Object.assign({}, r, { modeLabel:tr(r.mode), resultLabel:tr(r.result) }));
  return JSON.stringify({ created, updated, destPath, cards:records.length, records:out }, null, 2);
}
// gzip + base64 in the renderer (CompressionStream is a browser API; the main
// process reads it back with zlib). base64 is used rather than raw bytes because
// the payload has to survive inside an HTML document as text.
async function gzipB64(str){
  const cs=new CompressionStream('gzip');
  const stream=new Blob([new TextEncoder().encode(str)]).stream().pipeThrough(cs);
  const buf=new Uint8Array(await new Response(stream).arrayBuffer());
  let bin=''; const CH=0x8000;
  for(let i=0;i<buf.length;i+=CH) bin+=String.fromCharCode.apply(null,buf.subarray(i,i+CH));
  return btoa(bin);
}
async function buildReportHtml(created, updated, destPath, records){
  const escH=(x)=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const totalBytes=records.reduce((a,r)=>a+(r.bytes||0),0);
  // The tiles at the top of the report. Counted from the records themselves,
  // including the ones re-read from the report already on this destination, so
  // the figures describe the drive and not just the run that just ended.
  const totalFiles=records.reduce((a,r)=>a+(Number.isFinite(+r.files)?(+r.files|0):0),0);
  const badCount=records.filter(r=>r.rclass==='r-err').length;
  const suspectCount=records.filter(r=>r.rclass==='r-suspect').length;
  // A report legitimately MIXES full and light cards, so the chevron column
  // exists as soon as one card has a file list, and each row says for itself
  // whether it has one.
  const anyFl=records.some(r=>reportFilePairs(r).length>0);
  // File lists are NOT rendered into the rows: they would store every path twice
  // (once in the hidden HTML, once in the embedded JSON below). The chevron builds
  // the list on demand from that JSON, so each path is stored once.
  const rows=records.map((r,ri)=>{
    const hasFl = reportFilePairs(r).length>0;
    const chev = !anyFl ? ''
      : hasFl
      ? `<td class="c-chev" onclick="tgl(${ri})" id="ch-${ri}" title="${escH(tr('Show files'))}">\u25b8</td>`
      : `<td class="c-chev c-mut" title="${escH(tr('Recorded as a light entry, no file list'))}">\u00b7</td>`;
    // modeClass / rclass go into a class attribute unescaped, and files into
    // markup as a number — but records are re-read from the report JSON that
    // lives on the (possibly shared) destination, so a tampered INGESTO_report
    // could smuggle `"><img onerror=...>` through them. Whitelist the classes
    // and coerce the count to an integer.
    const MODE_CLASSES = new Set(['m-fast','m-sizecheck','m-verified','m-secure','m-pro','mode-fast','mode-normal','mode-slow','mode-pro','']);
    const R_CLASSES    = new Set(['r-ok','r-err','r-suspect','']);
    const modeCls = MODE_CLASSES.has(r.modeClass) ? r.modeClass : '';
    const rCls    = R_CLASSES.has(r.rclass) ? r.rclass : '';
    const nFiles  = Number.isFinite(+r.files) ? (+r.files|0) : 0;
    const errs = reportErrs(r), more = Number.isFinite(+r.errsMore) ? (+r.errsMore|0) : 0;
    const main = `<tr class="rec">`+chev+
      `<td class="c-num">${escH(r.n)}</td><td class="c-mut">${escH(r.date)}</td>`+
      `<td>${escH(r.card)}${(r.folder&&r.folder.includes('/'))?`<div class="c-path">${escH(r.folder)}</div>`:''}</td>`+
      // The picture profile rides under the camera rather than in a column of
      // its own: the table already carries eleven columns, and the two belong
      // together anyway.
      `<td class="c-txt">${escH(r.operator)}</td>`+
      `<td>${escH(r.cam)}${r.pp?`<div class="c-path">${escH(r.pp)}</div>`:''}</td>`+
      `<td class="${modeCls}">${escH(tr(r.mode))}</td>`+
      `<td class="c-r">${nFiles}</td><td class="c-r">${fmtSize(r.bytes)}</td>`+
      // A card with an error list: the result badge opens it.
      (errs.length
        ? `<td><span class="${rCls} r-click" onclick="tge(${ri})" title="${escH(tr('Show what went wrong'))}">${escH(tr(r.result))} <span id="eb-${ri}">\u25b8</span></span></td>`
        : `<td><span class="${rCls}">${escH(tr(r.result))}</span></td>`)+
      // One compact column rather than three: the table already carries 11
      // columns and three more would crush it. All three values are shown.
      // Phase timings: fixed-width sub-columns so the "/" separators line up
      // from row to row, coloured with the app's phase palette (copy=green,
      // dest verify=blue, source re-read=violet). A phase that didn't run
      // stays grey — colours only ever mark a real measurement.
      `<td class="c-r" style="white-space:nowrap">`+
        `<span class="tv ${r.copyMs>0?'t-copy':'t-na'}">${escH(fmtReportDur(r.copyMs))}</span>`+
        `<span class="t-sep">/</span>`+
        `<span class="tv ${r.v1Ms>0?'t-v1':'t-na'}">${escH(fmtReportDur(r.v1Ms))}</span>`+
        `<span class="t-sep">/</span>`+
        `<span class="tv ${r.v2Ms>0?'t-v2':'t-na'}">${escH(fmtReportDur(r.v2Ms))}</span>`+
      `</td>`+
      // The note is markdown: shown formatted, built by
      // mdToHtml(), which escapes everything first.
      `<td class="c-txt c-mut">${r.note ? `<div class="md-note">${mdToHtml(r.note)}</div>` : ''}</td></tr>`;
    // What went wrong: opened from the result badge, and printed with the
    // PDF export, which opens every list.
    const errRow = !errs.length ? '' :
      `<tr class="er" id="er-${ri}" style="display:none;">${anyFl?'<td></td>':''}<td colspan="11"><div class="er-list">`+
      errs.map(x=>`<div class="er-row ${x.phase==='warning'?'er-warn':''}">`+
        `<span class="er-p">${escH(reportPhaseLabel(x.phase))}</span>`+
        `<span class="er-f">${escH((x.drive?x.drive+' / ':'')+x.file)}</span>`+
        `<span class="er-m">${escH(x.error)}</span></div>`).join('')+
      (more>0?`<div class="er-row er-more">${escH(trf('{n} more not listed', {n:more}))}</div>`:'')+
      `</div></td></tr>`;
    if(!hasFl) return main+errRow;
    return main+errRow+`<tr class="det" id="det-${ri}" style="display:none;"><td></td><td colspan="11"></td></tr>`;
  }).join('');
  // Compact encoding: [path, size] pairs instead of {path,size,mtime} objects
  // (~30 chars of JSON scaffolding saved per file). mtime is dropped — it is
  // never displayed and the card sentinel already keeps it.
  const slim = records.map(r=>{
    // folder and skipped must travel too: report-read reads this block
    // before INGESTO_report.json, so whatever is left out here is lost for
    // every earlier card at the next ingest.
    const o = { n:r.n, date:r.date, card:r.card, folder:r.folder||'', operator:r.operator, cam:r.cam, pp:r.pp||'',
      mode:r.mode, modeClass:r.modeClass, files:r.files, bytes:r.bytes,
      result:r.result, rclass:r.rclass, note:r.note, skipped:r.skipped||0,
      copyMs:r.copyMs, v1Ms:r.v1Ms, v2Ms:r.v2Ms };
    const errs = reportErrs(r);
    if (errs.length) { o.errs = errs; if (+r.errsMore > 0) o.errsMore = +r.errsMore|0; }
    const pairs = reportFilePairs(r);
    if (pairs.length) o.f = pairs;
    return o;
  });
  // Neutralise a closing script tag (and any other "<") inside the embedded
  // JSON: a note or filename containing one would otherwise end the data block
  // early and let the rest render as HTML. "<" parses back to "<", so the data
  // is unchanged for the reader.
  // The data block is gzipped and base64'd. On a 180-card session it is the
  // file lists that make the report heavy — thousands of paths sharing the same
  // folder and differing by a number, which is the ideal case for gzip: a
  // 1.55 MB report comes out at ~174 KB. The VISIBLE table stays plain HTML, so
  // the part a client actually reads opens in anything; only the file lists,
  // which appear on click, go through decompression.
  const raw=JSON.stringify({created, v:2, records:slim});
  const data=await gzipB64(raw);
  // The report follows the language of the app at the time it is written.
  // Its data block (slim, above) stays in English: it is read back by the
  // next ingest, whatever the language then.
  const lang = (typeof INGESTO_I18N!=='undefined' && INGESTO_I18N) ? INGESTO_I18N.getLanguage() : 'en';
  const fl = { none: tr('File list unavailable in this browser'),
    noneWhy: tr('The list is stored compressed. Open this report in a recent browser (Safari 16.4+, Chrome, Firefox, Edge) to read it.'),
    bad: tr('File list could not be read'), badWhy: tr('The stored data is damaged. The table above is unaffected.'),
    one: tr('{n} file ingested'), many: tr('{n} files ingested') };
  return `<!doctype html><html lang="${escH(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(tr('ingesto - Ingest Report'))}</title>
<style>${REPORT_CSS}</style></head><body><div class="wrap">

<div class="card">
<div class="hd"><div style="flex-grow:1;min-width:0;">
<div class="brand">ingesto<span>.</span></div>
<div class="ttl">${escH(tr('INGEST REPORT'))}</div>
<div class="path">${escH(destPath)}</div>
<div class="meta">${escH(trf('Created {date}', {date:fmtReportDate(created)}))} &middot; ${escH(trf('last update {date}', {date:fmtReportDate(updated)}))}</div>
</div><button class="pdf" onclick="_pdf()">&#11015; ${escH(tr('Export PDF'))}</button></div>
<div class="tiles">
<div class="tile"><b>${records.length}</b><span>${escH(tr(records.length>1?'CARDS':'CARD'))}</span></div>
<div class="tile"><b>${totalFiles}</b><span>${escH(tr('FILES'))}</span></div>
<div class="tile"><b>${fmtSize(totalBytes)}</b><span>${escH(tr('TOTAL SIZE'))}</span></div>
<div class="tile"><b style="color:${badCount?'#f2555a':(suspectCount?'#f2a03d':'#35c98b')};">${badCount?badCount:(suspectCount?suspectCount:records.length)}</b><span>${escH(tr(badCount?'WITH ERRORS':(suspectCount?'SUSPECT':'CLEAN')))}</span></div>
</div>
</div>

<div class="card" style="padding:16px 14px;">
<div style="overflow-x:auto;">
<table><thead><tr>${anyFl?'<th class="c-chev"></th>':''}<th>#</th>${['DATE','CARD','OPERATOR','CAM','MODE'].map(h=>`<th>${escH(tr(h))}</th>`).join('')}<th class="c-r">${escH(tr('FILES'))}</th><th class="c-r">${escH(tr('SIZE'))}</th><th>${escH(tr('RESULT'))}</th><th class="c-r" title="${escH(tr('Copy / Verify (destination) / Card re-read'))}" style="white-space:nowrap"><span class="tv t-copy">${escH(tr('COPY'))}</span><span class="t-sep">/</span><span class="tv t-v1">${escH(tr('VERIFY'))}</span><span class="t-sep">/</span><span class="tv t-v2">${escH(tr('RE-READ'))}</span></th><th>${escH(tr('NOTE'))}</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>
<div class="legend">
<span><b style="color:#35c98b;">${escH(tr('COPY'))}</b> ${escH(tr('copy pass'))}</span>
<span><b style="color:#4d90f0;">${escH(tr('VERIFY'))}</b> ${escH(tr('read back on the destination'))}</span>
<span><b style="color:#a880ff;">${escH(tr('RE-READ'))}</b> ${escH(tr('card re-read'))}</span>
${anyFl?`<span>${escH(tr('Click ▸ on a line to list the files.'))}</span>`:''}
${records.some(r=>reportErrs(r).length)?`<span>${escH(tr('Click a result marked ▸ to see what went wrong.'))}</span>`:''}
</div>
</div>

<div class="ft">${tr('Written by ingesto. This file lives in the destination and is updated after each ingest. Only <b>Secure</b> and <b>PRO</b> read the copies back: a line in <b>Fast</b> or <b>Size check</b> says what was copied, not that it was verified.')}</div>
</div>
<script id="ingesto-report-data" type="application/gzip+base64">${data}<\/script>
<script>var _L=${JSON.stringify(fl).replace(/</g,'\\u003c')};${REPORT_VIEWER_JS}<\/script>
</body></html>`;
}
