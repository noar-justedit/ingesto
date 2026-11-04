// ── ntfy ─────────────────────────────────────────────────────────────────
// ONE COMPLETE NOTIFICATION PER CARD, then a closing line for the batch.
// A single message would describe a multi-destination run as one anonymous
// blob: no card name, no destinations, no timings. On a shoot the phone is
// often the only screen the DIT looks at, so each card gets its own card sheet.
function ntfyDur(ms){ return ms>0 ? fmtEta(ms/1000) : '-'; }

// Everything known about one card, phrased for a phone lock screen.
// Texts built in JavaScript (notifications, reports) go through the
// dictionary too: tr() translates a whole text, trf() a text with {name}-style
// values filled in after translation. In English both return the text as is.
function tr(s){ return (typeof INGESTO_I18N!=='undefined' && INGESTO_I18N) ? INGESTO_I18N.t(s) : s; }
function trf(s, v){ return tr(s).replace(/\{(\w+)\}/g, (m,k)=>Object.prototype.hasOwnProperty.call(v,k)?String(v[k]):m); }
function ntfyCard(rs, num, runSources, runDests){
  const r0   = rs[0];
  const name = r0.sourceName || '-';
  const src  = runSources.find(x => x.path === r0.sourcePath)
            || runSources.find(x => x.name === name) || {};
  const errors   = rs.reduce((a,r)=>a+(r.errors||0),0);
  const failed   = rs.reduce((a,r)=>a+((r.failedFiles&&r.failedFiles.length)||0),0);
  const unstable = rs.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
  const canceled = rs.every(r=>r.canceled);

  const refused  = rs.every(r=>r.refused);
  const empty    = rs.every(r=>(r.totalFiles||0)===0) && !refused && !canceled;
  // Three marks instead of words, readable without reading:
  //   ✓ it is done   ⚠ there is a problem   ■ it did not happen
  // And the card is named in the line itself: "⚠ 1 error" on a lock screen,
  // with eight cards in the day, allows no decision at all.
  const dests = rs.map(driveNameOf);
  const badDests = rs.filter(r => (r.errors||0) || (r.failedFiles&&r.failedFiles.length))
                     .map(driveNameOf);
  const okDests  = rs.filter(r => !(r.errors||0) && !(r.failedFiles&&r.failedFiles.length))
                     .map(driveNameOf);
  const nFiles   = r0.copiedFiles || 0;
  let result, tags, priority='default';
  const files = n => trf(n===1?'{n} file':'{n} files', {n});
  if(refused){
    result=trf('■ {name}, not started · nothing was written', {name}); tags='no_entry'; priority='high';
  } else if(canceled){
    result=trf('■ {name}. Stopped · card is not complete anywhere', {name}); tags='x'; priority='high';
  } else if(empty){
    result=trf('■ {name}. Nothing on this card', {name}); tags='no_entry'; priority='default';
  } else if(unstable>0){
    result=trf(unstable>1?'⚠ {name}. Suspect card, do not erase · {n} files unstable':'⚠ {name}. Suspect card, do not erase · {n} file unstable', {name, n:unstable});
    tags='warning'; priority='high';
  } else if(rs.some(r=>r.scanIncomplete)){
    result=trf('⚠ {name}. Part of the card could not be read, do not erase', {name});
    tags='warning'; priority='high';
  } else if(rs.some(r=>(r.errorList||[]).some(e=>e.origin==='source'))){
    result=trf('⚠ {name}. The card could not be read in full, do not erase', {name});
    tags='warning'; priority='high';
  } else if(errors||failed){
    // One file that failed on two drives is ONE file, and both drives are worth
    // naming: badDests[0] alone would silently drop the second.
    const n=[...new Set(rs.flatMap(r=>r.failedFiles||[]))].length || errors;
    const bd=[...new Set(badDests)].filter(Boolean);
    const okd=[...new Set(okDests)].filter(Boolean);
    result=trf(n>1?'⚠ {name}. {n} files failed on {drives}':'⚠ {name}. {n} file failed on {drives}', {name, n, drives:bd.length?bd.join(', '):tr('a drive')})+
           (okd.length?' · '+trf('{drives} ok', {drives:okd.join(', ')}):'');
    tags='warning'; priority='high';
  } else if(rs.some(r=>(r.sidecarFailed||[]).length)){
    result=trf('⚠ {name} copied & verified · no manifest written, keep the card', {name});
    tags='warning'; priority='high';
  } else if(r0.mode===MODE.FAST){
    result=trf('✓ {name} copied · not verified · {files}', {name, files:files(nFiles)}); tags='white_check_mark';
  } else if(r0.mode===MODE.SIZE_CHECK){
    result=trf('✓ {name} copied · sizes checked, contents not verified', {name}); tags='white_check_mark';
  } else if(rs.some(r=>r.coldVerify===false || r.doubleReadCached)){
    result=trf('✓ {name} verified · read-back may have come from memory', {name}); tags='white_check_mark';
  } else {
    result=trf('✓ {name} verified · {files}', {name, files:files(nFiles)})+
           (dests.filter(Boolean).length?` · ${dests.filter(Boolean).join(', ')}`:'');
    tags='white_check_mark';
  }

  const L = [];
  // The verdict FIRST. As the last line of nine, under the operator, the
  // timings and the destination list, nobody would ever see it on a lock screen.
  L.push(result);
  // Who shot it.
  { const l=[src.operator, src.camera, src.pp].filter(Boolean).join(' · '); if(l) L.push(l); }
  // What was moved, and how.
  L.push(`${files(r0.totalFiles||0)} · ${fmtSize(r0.totalBytes||0)} · ${tr(reportModeLabel(r0))}`+
         ((r0.skippedFiles||0)>0 ? ' · '+trf('{n} already on drive, not copied', {n:r0.skippedFiles}) : ''));
  // Where it came from — the mount point, which is not always the card label.
  if(r0.sourcePath) L.push(trf('From: {path}', {path:r0.sourcePath}));
  // Where it went. One line per destination, each with its own outcome, so a
  // run that succeeded on the local disk and failed on the NAS says exactly that.
  rs.forEach((r,j) => {
    const dn = (runDests[j] && runDests[j].name) || driveNameOf(r);
    // The engine records a failed file in BOTH errors and failedFiles, so
    // adding them would report "⚠ 2" for one lost clip.
    const bad = Math.max((r.errors||0), ((r.failedFiles&&r.failedFiles.length)||0));
    const mark = r.canceled ? '■' : bad ? `⚠ ${bad}`
               : (r.refused || (r.totalFiles||0)===0) ? '■'
               : (r.unstableFiles&&r.unstableFiles.length) ? '⚠' : '✓';
    // The FULL path under the drive, subfolders included. The drive name alone
    // does not say where the footage is once a template builds a tree:
    // "→ SHUTTLE_1 ✓" is not something you can go and check from set.
    const where = r.relFolder ? `${dn}/${r.relFolder}` : dn;
    L.push(`→ ${where}  ${mark}`);
  });
  // How long it took, phase by phase — the figure that tells you whether the
  // next card will fit before the next setup.
  const t = [trf('Copy {t}', {t:ntfyDur(r0.copyMs)})];
  if(r0.verify1Ms>0) t.push(trf('Verify {t}', {t:ntfyDur(r0.verify1Ms)}));
  if(r0.verify2Ms>0) t.push(trf('Card re-read {t}', {t:ntfyDur(r0.verify2Ms)}));
  L.push(t.join(' · '));
  L.push(trf('Total {t}', {t:ntfyDur(r0.duration)}));
  if(src.note) L.push(tr('Note:')+' '+src.note);

  return { title:`#${num} - ${name}`, message:L.join('\n'), tags, priority };
}

// A notification that never left is the worst silence of the seven: a DIT
// watching a phone is waiting for something that will not arrive, and reads the
// absence as "nothing to report". Two attempts, then the result is REMEMBERED
// so the end-of-ingest window can say so.
async function ntfyPush(payload){
  const full = { server:S.ntfyServer, topic:S.ntfyTopic, ...payload };
  let last=null;
  try{
    last = await window.ingesto.ntfySend(full);
    if(!(last&&last.ok)){ await new Promise(z=>setTimeout(z,2000)); last = await window.ingesto.ntfySend(full); }
  }catch(e){ last = { ok:false, error:String(e&&e.message||e) }; }
  const ok = !!(last && last.ok);
  if(!ok) S._ntfyFailed = (last && (last.error || ('HTTP '+last.status))) || 'no answer';
  return ok;
}

async function sendIngestNotification(R, base, run){
  S._ntfyFailed = null;
  if(!S.ntfyEnabled || !S.ntfyTopic || !R || !R.length) return;
  // Pushed one card at a time with a gap between them, long after the operator
  // may have cleared the sources: without the snapshot, cards 2 and beyond would
  // lose their operator, camera and note, and the per-destination lines could
  // name drives that had since been removed.
  const runDests   = (run && run.dests)   || S.dests;
  const runSources = (run && run.sources) || S.sources;

  // Group by source PATH, not name: two cards both labelled "NO NAME" are two
  // cards, and each deserves its own message.
  const byCard = new Map();
  R.forEach(r => { const k=r.sourcePath||r.sourceName||''; if(!byCard.has(k)) byCard.set(k,[]); byCard.get(k).push(r); });
  const cards = [...byCard.values()];

  if(R.every(r=>r.canceled) && cards.length>1){
    await ntfyPush({ title:'ingesto - Ingest stopped',
      message:'■ Stopped · no card is complete anywhere', tags:'x', priority:'high' });
    return;
  }

  const start = (base!=null) ? base : S.counter;
  for(let i=0;i<cards.length;i++){
    await ntfyPush(ntfyCard(cards[i], padCounter(start+i, run && run.counterWidth), runSources, runDests));
    // ntfy servers throttle a burst from one client; a short gap keeps the
    // last card's message from being the one that gets dropped.
    if(i < cards.length-1) await new Promise(z=>setTimeout(z,400));
  }

  // One closing line for the batch — only worth sending when there were several.
  if(cards.length>1){
    const er   = R.reduce((a,r)=>a+(r.errors||0),0);
    const fl   = R.reduce((a,r)=>a+((r.failedFiles&&r.failedFiles.length)||0),0);
    const uns  = R.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
    // Count each card's volume once, not once per destination.
    const bytes = cards.reduce((a,rs)=>a+(rs[0].totalBytes||0),0);
    const dur   = cards.reduce((a,rs)=>a+(rs[0].duration||0),0);
    const nd    = runDests.length;
    const head  = `${cards.length} cards · ${fmtSize(bytes)} · ${nd} destination${nd>1?'s':''}\n${ntfyDur(dur)} total`;
    const canc = R.some(r=>r.canceled);
    const notOk = R.some(r=>r.success!==true);
    if(er||fl||uns||canc||notOk){
      const bits=[]; const ne=er||fl; if(ne) bits.push(`${ne} error${ne>1?'s':''}`); if(uns) bits.push('suspect card');
      if(canc) bits.push('stopped before the end'); else if(notOk && !ne) bits.push('incomplete');
      await ntfyPush({ title:'ingesto - Finished with issues', message:`${head}\n⚠ ${bits.join(', ')}`, tags:'warning', priority:'high' });
    } else {
      // The closing line is the one left on the lock screen: it must say what
      // was checked, exactly like each card's own line.
      const modes = new Set(R.map(r=>r.mode));
      const line = modes.has(MODE.FAST) ? '✓ copied · not verified'
                 : modes.has(MODE.SIZE_CHECK) ? '✓ copied · sizes checked, contents not verified'
                 : '✓ all verified';
      await ntfyPush({ title:'ingesto - Ingest complete', message:`${head}\n${line}`, tags:'white_check_mark' });
    }
  }
}
