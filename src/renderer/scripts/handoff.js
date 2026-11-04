// Split a command line into tokens, honouring single/double quotes. Variable
// substitution happens PER TOKEN afterwards, so a value with spaces stays one
// argument and can never split into extra ones.
function tokenizeCommand(str){
  const out=[]; let cur='', q=null, has=false;
  for(let i=0;i<str.length;i++){
    const c=str[i];
    if(q){ if(c===q) q=null; else cur+=c; continue; }
    if(c==='"'||c==="'"){ q=c; has=true; continue; }
    if(c===' '||c==='\t'){ if(has||cur){ out.push(cur); cur=''; has=false; } continue; }
    cur+=c; has=true;
  }
  if(has||cur) out.push(cur);
  return out;
}
// ═══════════════════════════════════════════════════════
// The handoff
// ═══════════════════════════════════════════════════════
// A document written once per card, describing what was really done with it,
// so a script the operator owns can decide whether to hand that card to
// something that erases it. ingesto signs the form. It does not press the
// button.
//
// Built here rather than in the engine because it has to agree with the window:
// the same run must never produce a green EJECT and a "no" here, or the reverse.
// A test ties the two together.

// Which of the four modes actually reads the copy back and compares contents.

function buildHandoff(rs, run, index){
  const r0 = rs[0] || {};
  const mode = r0.mode || (run && run.mode) || MODE.FAST;
  const contentsVerified = modeVerifiesContents(mode);
  const dests = (run && Array.isArray(run.dests)) ? run.dests : [];
  // The card's own metadata, from the frozen list.
  //
  // Matched by PATH, not by position. `index` is the position in the list of
  // RESULTS grouped by card, which is not the position in the source list the
  // run was started with: a card refused at pre-flight, or one whose results
  // arrive in another order, shifts every card after it. Handing card two the
  // profile of card one is a mistake nobody catches until the grade, because
  // the document looks perfectly well formed. The grouping above already keys
  // on the path, so that is what is matched here.
  //
  // There is deliberately NO fallback on the position. A card whose path and
  // label are both absent from the list is a card nobody can identify, and an
  // empty field is the honest answer: handing it the neighbouring card's
  // operator, camera and profile would be a document that reads perfectly and
  // is about somebody else. An absent entry leaves the fields empty rather
  // than throwing, because the document must still be produced whatever else
  // is missing.
  //
  // `index` below is still the position, and stays so on purpose: cardId is
  // "which card of this batch", a number, not an identity.
  const srcList = (run && Array.isArray(run.sources)) ? run.sources : [];
  const srcMeta = srcList.find(s => s && s.path && s.path === r0.sourcePath)
               || srcList.find(s => s && s.name && s.name === r0.sourceName)
               || {};
  // The LONGEST match, not the first: with a drive and a folder on that same
  // drive both selected as destinations, the first match would name the wrong
  // one, and a script that routes on the drive would route to it.
  const destOf = (r) => {
    const p = String(r.destPath||'').replace(/\\/g,'/');
    let best = null;
    for(const d of dests){
      const dp = String(d.path||'').replace(/\\/g,'/').replace(/\/+$/,'');
      if(!dp) continue;
      if(p === dp || p.startsWith(dp + '/')){ if(!best || dp.length > best._len) best = { d, _len: dp.length }; }
    }
    return best ? best.d : {};
  };

  // The count is the WEAKEST destination: a file is only copied once it is on
  // every drive the operator asked for.
  const copied = rs.length ? Math.min(...rs.map(r => r.copiedFiles || 0)) : 0;
  // The card-wide figures come from every result, not from the first one. The
  // engine writes them identically to each destination today, and a document
  // that decides whether a card gets erased should not depend on that staying
  // true.
  const onCard = Math.max(0, ...rs.map(r => r.seenFiles || 0));
  const skipped = Math.max(0, ...rs.map(r => r.skippedFiles || 0));
  // What the file filter left out: everything seen on the card that was never
  // a candidate, minus what was skipped because a verified copy already exists.
  const filteredOut = Math.max(0, onCard - Math.min(...rs.map(r => r.totalFiles || 0), onCard) - skipped);
  const failed = [...new Set(rs.flatMap(r => r.failedFiles || []))].length;

  // A card is stable when it gave the same data twice. Outside PRO with the
  // double read on, nobody asked it twice: that is `null`, not `true`.
  const doubleRead = r0.proDoubleRead === true;
  const cardStable = rs.some(r => (r.unstableFiles || []).length) ? false
                   : (doubleRead ? true : null);

  // `=== true` throughout: a run object that says nothing about checksums did
  // not ask for a manifest, and an absent switch must not read as a yes on the
  // field that separates "can be checked again later" from "the card was the
  // last original".
  const manifestWanted = !!(run && run.cksum === true &&
                            (run.cksumList === true || run.cksumMhl === true || run.ascMhl === true));
  const algoOf = (r) => (mode === MODE.PRO ? (r.proAlgo || 'xxh128') : 'xxh64');

  const destinations = rs.map(r => {
    const d = destOf(r);
    const sidecarFailed = (r.sidecarFailed || []).length > 0;
    return {
      name: d.name || '',
      path: d.path || '',
      folder: r.destPath || '',
      copied: r.copiedFiles || 0,
      failed: (r.failedFiles || []).length,
      // Not "the mode was SECURE": this destination really read every file back
      // and every comparison matched.
      verified: contentsVerified && r.success === true && (r.errors || 0) === 0
                && (r.failedFiles || []).length === 0,
      manifest: (contentsVerified && manifestWanted && !sidecarFailed) ? algoOf(r) : null,
      quarantined: r.quarantinedPaths || [],
    };
  });

  const coversWholeCard = skipped === 0 && filteredOut === 0 && failed === 0
                          && !r0.emptyReason && onCard > 0 && copied === onCard;

  // Every condition, spelled out. A script that wants to be more permissive
  // than this has the individual fields above and has to say so deliberately.
  const safeToErase =
    contentsVerified &&
    rs.length > 0 &&
    // Every destination the run was started with produced a result. A card
    // said to be on two drives, with one result missing, would be answering
    // for a drive nobody heard from.
    rs.length === dests.length &&
    !rs.some(r => r.canceled) && !rs.some(r => r.refused === true) &&
    !rs.some(r => r.emptyReason) &&
    !rs.some(r => r.doubleReadCached === true) &&
    rs.every(r => r.success === true) &&
    rs.every(r => (r.errors || 0) === 0) &&
    rs.every(r => (r.failedFiles || []).length === 0) &&
    rs.every(r => (r.quarantinedPaths || []).length === 0) &&
    rs.every(r => r.scanIncomplete !== true) &&
    cardStable !== false &&
    destinations.length > 0 &&
    destinations.every(d => d.verified === true) &&
    destinations.every(d => d.manifest !== null) &&
    coversWholeCard;

  return {
    ingesto: (S.appVersion || ''),
    runId: (run && run.runId) || '',
    cardId: ((run && run.runId) || '') + '-' + (index + 1),
    finishedAt: new Date().toISOString(),
    // What the operator typed for this card, frozen at START like the rest of
    // the run. A script that picks a LUT, a transcode preset or a delivery
    // folder needs the picture profile, and asking it to parse the folder name
    // back apart would be asking it to guess.
    source: { name: r0.sourceName || '', path: r0.sourcePath || '',
              operator: srcMeta.operator || '', camera: srcMeta.camera || '',
              pictureProfile: srcMeta.pp || '',
              volumeUUID: null, removable: null, stillMounted: null },
    mode,
    contentsVerified,
    doubleRead,
    cardStable,
    scanComplete: rs.every(r => r.scanIncomplete !== true),
    // False on a machine that cannot defeat the read cache (everything except
    // macOS). Not a reason to refuse on its own, or the feature would be dead
    // outside macOS, but a script may be stricter than ingesto is.
    readBackCacheBypassed: (r0.coldVerify === null || r0.coldVerify === undefined) ? null : !!r0.coldVerify,
    files: { onCard, copied, skipped, filteredOut, failed },
    coversWholeCard,
    destinations,
    safeToErase,
  };
}

// One command per card, with the path to that card's document as the last
// argument. The document itself is written by the main process into the
// system's scratch directory and removed when the command returns: it is a
// document that gets passed from hand to hand, not one that gets filed.
function runHandoff(R, run){
  // Frozen at START like everything else that runs after the panels unlock: a
  // command typed, or a switch flipped, while a card copied must not apply to
  // the run that is already finishing.
  const ho = (run && run.handoff) || null;
  if(!ho || !ho.on) return;
  const cmd=(ho.cmd||'').trim(); if(!cmd) return;
  if(!R.length) return;
  // A run nobody started, or one the operator stopped, has nothing to hand
  // over. The document would say no, but the command should not run at all:
  // it is a command whose job is to act on cards.
  if(R.every(r=>r.canceled)) return;
  if(R.every(r=>r.refused)) return;
  const argv = tokenizeCommand(cmd);
  if(!argv.length || !argv[0]) return;

  // Grouped by card PATH: two cards labelled the same are two cards.
  const byCard = new Map();
  for(const r of R){ const k=r.sourcePath||r.sourceName||'';
    if(!byCard.has(k)) byCard.set(k,[]); byCard.get(k).push(r); }
  const cards=[...byCard.values()];

  (async()=>{
    const failures=[];
    for(let i=0;i<cards.length;i++){
      const payload = buildHandoff(cards[i], run, i);
      let res=null;
      try{ res = await window.ingesto.handoff(payload, argv); }
      catch(e){ res = { ok:false, error:String(e&&e.message||e) }; }
      if(!res || !res.ok) failures.push((payload.source.name||'a card')+': '+
        ((res && (res.error || (res.code!=null ? 'exit code '+res.code : ''))) || 'it did not run'));
    }
    if(failures.length) addSummaryNote({ code:'CV-14',
      text:'The handoff command did not run'+(failures.length>1?' for '+failures.length+' cards':'')+'.',
      detail: argv[0]+': '+failures.join(' · ')+'. The copy is unaffected.' });
  })();
}

// An example document, and the command run on it, with nothing ingested and no
// card involved. The file is kept and revealed, which is the point: it is how
// somebody writes the script in the first place.
async function handoffDryRun(){
  const out=document.getElementById('set-handoff-res');
  const cmd=(S.handoffCommand||'').trim();
  if(!cmd){ if(out){ out.textContent='Enter a command first.'; out.style.color='var(--orange)'; } return; }
  const argv=tokenizeCommand(cmd);
  if(!argv.length || !argv[0]){ if(out){ out.textContent='That command cannot be read.'; out.style.color='var(--orange)'; } return; }
  if(out){ out.textContent='Running...'; out.style.color='var(--text3)'; }
  // NEVER the real card, and never the real drive. The dry run is how somebody
  // writes the script that erases cards in the first place: pointing it at a
  // card that is actually in the reader, with an answer of yes, is the one
  // mistake this whole feature exists to avoid making.
  const example = buildHandoff([{
    sourceName: 'A001_EXAMPLE', sourcePath: '/Volumes/A001_EXAMPLE',
    destPath: '/Volumes/EXAMPLE_DRIVE/'+padCounter(S.counter||1)+'_A001_EXAMPLE',
    mode: S.mode, proAlgo: S.proAlgo, proDoubleRead: S.proDoubleRead,
    success: true, canceled: false, errors: 0, errorList: [], failedFiles: [], unstableFiles: [],
    quarantinedPaths: [], sidecarFailed: [], scanIncomplete: false, coldVerify: true,
    doubleReadCached: false, totalFiles: 186, copiedFiles: 186, seenFiles: 186,
    skippedFiles: 0, notes: [],
  }], { dests: [{ path:'/Volumes/EXAMPLE_DRIVE', name:'EXAMPLE_DRIVE' }],
        // Fictional like the rest of it, but present: a script is written
        // against the dry run, and a field that is empty here looks like a
        // field that does not exist.
        sources: [{ path:'/Volumes/A001_EXAMPLE', name:'A001_EXAMPLE',
                    operator:'EXAMPLE', camera:'EXAMPLE', pp:'EXAMPLE' }],
        runId: 'dry-run', mode: S.mode, cksum: true, cksumList: true,
        cksumMhl: false, ascMhl: false, counterWidth: S.counterWidth }, 0);
  // Marked, and answered NO. A script tuned against a dry run must never be
  // tuned against a yes: the main process refuses it a second time.
  example.dryRun = true;
  example.safeToErase = false;
  let res=null;
  try{ res = await window.ingesto.handoff(example, argv, true); }
  catch(e){ res = { ok:false, error:String(e&&e.message||e) }; }
  if(!out) return;
  if(res && res.ok){ out.textContent='Ran, and the document was kept for you.'; out.style.color='var(--green)'; }
  else { out.textContent = 'Did not run: '+((res && (res.error || (res.code!=null?'exit code '+res.code:'')))||'unknown reason');
         out.style.color='var(--red)'; }
}

// `run` is the snapshot taken at START. Reading the destination from the live
// interface state would let a drive added or removed while a card copied
// change what the hook is told about a run that is already finished. The
// report and the phone notification follow the same rule.
function runPostHook(R, run){
  // The switch and the command come from the snapshot, never from the live
  // state: Settings stays reachable while an ingest runs.
  const hk = (run && run.hook) || null;
  if(!hk || !hk.on) return;
  const cmd=(hk.cmd||'').trim(); if(!cmd) return;
  if(R.length>0 && R.every(r=>r.canceled)) return;   // skip on cancel
  // No result at all (the engine call itself failed) is an error, not "ok":
  // otherwise the hook would fire "ok" for an ingest that copied nothing.
  const er=R.reduce((a,r)=>a+(r.errors||0),0);
  const failed=R.reduce((a,r)=>a+((r.failedFiles&&r.failedFiles.length)||0),0);
  const unstable=R.reduce((a,r)=>a+((r.unstableFiles&&r.unstableFiles.length)||0),0);
  const stopped=!R.length || R.some(r=>r.canceled) || R.some(r=>r.success!==true);
  const result = unstable ? 'suspect' : ((er||failed||stopped) ? 'errors' : 'ok');
  const uniq=[...new Set(R.map(r=>r.sourcePath||r.sourceName))];
  const names=[...new Set(R.map(r=>r.sourceName))];
  const bytes=[...new Map(R.map(r=>[r.sourcePath||r.sourceName,r.totalBytes])).values()].reduce((a,b)=>a+(b||0),0);
  // No shell, no escaping games: the command is tokenized, then each token has
  // its variables replaced as a WHOLE argument value. A hostile card name is
  // just an argv string — it cannot inject, and a path with spaces just works.
  const runDests = (run && Array.isArray(run.dests) && run.dests.length) ? run.dests : S.dests;
  const vars={ '{destPath}':(runDests[0]?runDests[0].path:''), '{card}':names.join(', '),
    '{count}':String(uniq.length), '{bytes}':String(bytes), '{result}':result };
  const argv=tokenizeCommand(cmd).map((tok,idx)=>{
    // Never substitute into argv[0]: otherwise a hook written as "{destPath}\x"
    // would let an attacker-controlled card label choose the PROGRAM that runs.
    if(idx===0) return tok;
    let t=tok; for(const k in vars){ t=t.split(k).join(vars[k]); } return t;
  });
  if(!argv.length || !argv[0]) return;
  // The result of the command is reported, never thrown away: otherwise someone
  // sets up an automatic proxy encode, it never runs, and nothing says so.
  (async()=>{
    let res=null;
    // The command as typed goes along: the main process checks that argv is
    // exactly that command with its variables filled in, and asks the
    // operator once before running a command it has never run.
    try{ res = await window.ingesto.runHook(argv, tokenizeCommand(cmd)); }
    catch(e){ res = { ok:false, error:String(e&&e.message||e) }; }
    if(res && res.ok) return;
    const why = (res && (res.error || (res.code!=null ? `exit code ${res.code}` : ''))) || 'it did not run';
    addSummaryNote({ code:'CV-7', text:'The command after ingest did not run.',
                     detail: `${argv[0]}: ${why}.` });
  })();
}
// A remark added after the summary window is already on screen: the hook and
// the phone notification both finish later than the window opens.
function addSummaryNote(note){
  const box=document.getElementById('s-notes');
  if(!box) return;
  S._lateNotes = (S._lateNotes||[]).concat([note]);
  renderSummaryNotes(S._summaryNotes||[]);
}
function renderSummaryNotes(notes){
  const box=document.getElementById('s-notes');
  if(!box) return;
  const all=(notes||[]).concat(S._lateNotes||[]);
  if(!all.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='block';
  box.innerHTML = all.map(n =>
    `<div class="s-note"><div class="s-note-h">${esc(n.text)}</div>`+
    (n.detail?`<div class="s-note-d">${esc(n.detail)}</div>`:'')+`</div>`).join('');
}
function onNtfyField(){
  S.ntfyServer=(document.getElementById('set-ntfy-server').value||'').trim()||'https://ntfy.sh';
  S.ntfyTopic=(document.getElementById('set-ntfy-topic').value||'').trim();
  persistPrefs();
}
async function testNtfy(){
  const res=document.getElementById('set-ntfy-res');
  const topic=(document.getElementById('set-ntfy-topic').value||'').trim();
  const server=(document.getElementById('set-ntfy-server').value||'').trim()||'https://ntfy.sh';
  if(!topic){ res.textContent='Enter a topic first.'; res.style.color='var(--orange)'; return; }
  res.textContent='Sending…'; res.style.color='var(--text3)';
  try{
    const r=await window.ingesto.ntfySend({server,topic,title:tr('ingesto test'),message:tr('Test notification from ingesto'),tags:'bell'});
    if(r&&r.ok){ res.textContent='✓ Sent. Check your phone.'; res.style.color='var(--green)'; }
    else { res.textContent='✗ Failed'+(r&&r.error?': '+r.error:''); res.style.color='var(--red)'; }
  }catch(_){ res.textContent='✗ Failed'; res.style.color='var(--red)'; }
}
