// ═══════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════
// `opt.retryOf` — the results of the run this one is fixing up. A retry copies
// a handful of files back into folders an earlier run created, and its window
// must not be built as though those files were the whole ingest: two files
// recopied would read "ALL FILES COPIED & VERIFIED", and a card the first run
// had called suspect would come back green.
function showSummary(R, opt){
  const retryOf = (opt && Array.isArray(opt.retryOf)) ? opt.retryOf : null;
  // R holds ONE ENTRY PER (source × destination). Card contents and timings are
  // shared by all the destinations of the same card — the card is read once and
  // the phase timestamps are taken once — so summing R blindly would count a
  // 170-file card as 340 files and make COPY+V1+V2 exceed TOTAL. Collapse to
  // one entry per source first, then add up across cards.
  const bySrc=new Map();
  R.forEach(r=>{ const k=r.sourcePath||r.sourceName||''; if(!bySrc.has(k)) bySrc.set(k,[]); bySrc.get(k).push(r); });
  const G=[...bySrc.values()];
  const sum=(f)=>G.reduce((a,g)=>a+(f(g)||0),0);
  const tf=sum(g=>g[0].totalFiles);
  const tb=sum(g=>g[0].totalBytes);
  // A file only counts as copied once it made it to EVERY destination of that
  // card — the weakest destination is the honest number.
  const cf=sum(g=>Math.min(...g.map(r=>r.copiedFiles)));
  const er=R.reduce((a,r)=>a+r.errors,0);
  const dur=sum(g=>g[0].duration);
  // The verdict is the ENGINE's, never re-derived here. A cancel is not an
  // error (errors:0), so "ok = no errors" would say "Transfer Complete!" for a
  // batch whose second card was stopped at 1 file of 3: green tick, EJECT lit,
  // phone told "all verified". `every(canceled)` is also wrong: one stopped
  // card out of three makes the whole run incomplete.
  const canceled=R.some(r=>r.canceled);
  // Every card the run STARTED with has to be accounted for. "every card
  // succeeded" is a claim about the list in hand, and a batch that came back
  // short (the engine stopped between cards, a result was lost on the way)
  // would make it true of a list missing two of three: green tick, EJECT lit,
  // and the source list emptied for cards that were never copied.
  const startedCards = (S.run && Array.isArray(S.run.sources)) ? S.run.sources : [];
  const seenCards = new Set(R.map(r=>r.sourcePath||r.sourceName));
  const unaccounted = startedCards.filter(s=>!seenCards.has(s.path) && !seenCards.has(s.name));
  // A re-copy cannot clear what the CARD did in the first run. A file that
  // copies on the second attempt says the drive took it this time; it says
  // nothing about a card that gave different data twice, or a card part of
  // which could not be read. Left out of `ok`, the retry would come back with a
  // green tick, a lit EJECT button and the card cleared from the source list:
  // the three things a DIT actually acts on, all saying "format me".
  // The same three things failureVerdict blames the CARD for: a card giving
  // different data twice, a card part of which could not be read, and any
  // error the engine attributed to the source.
  const retrySuspect = !!retryOf &&
    retryOf.some(r=>((r.unstableFiles||[]).length>0) || r.scanIncomplete===true
                    || (r.errorList||[]).some(e=>e.origin==='source'));
  const ok=R.length>0 && !er && !canceled && R.every(r=>r.success===true)
           && !unaccounted.length && !retrySuspect;
  S._clearSrcOnClose = ok;      // sources are cleared only after a run that is complete on every card

  const ico=document.getElementById('s-ico');
  // Set again below, once failureVerdict() has decided; this keeps the element
  // in a known state if anything throws in between.
  ico.className='sum-ico '+(canceled?'cancel':ok?'ok':'err');
  const ICO_CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';
  const ICO_X='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
  const ICO_STOP='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>';
  const ICO_WARN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  ico.innerHTML=canceled?ICO_STOP:ok?ICO_CHECK:ICO_X;
  // The mode the run actually used, taken from the results, not the selector —
  // which can be changed by importing settings mid-ingest, and would then
  // headline a FAST run as "Secure Transfer Complete".
  const runMode = (R && R[0] && R[0].mode) || (S.run && S.run.mode) || S.mode;
  // NORMAL compares sizes, FAST compares nothing: neither may be headlined as
  // "verified". The word is reserved for a run whose every file was read back
  // from the destination and compared (SECURE, PRO).
  const r0=R[0]||{};
  const ALGN={xxh64:'xxHash64',xxh128:'xxHash128',md5:'MD5'};
  // The headline states the RESULT, and it is invariable: no count to make
  // agree, no batch total to add up. The exact figure lives in its own tile.
  // "ALL" is a promise, so it drops the moment it stops being true: after a
  // card where files were passed over, the title reads "62 OF 248".
  // Non-breaking after the ampersand: a line ending on a lone "&" is the one
  // wrap this title must never make.
  const CHECKED={fast:'',normal:' &\u00a0SIZE-CHECKED',slow:' &\u00a0VERIFIED',pro:' &\u00a0VERIFIED'};
  // A manifest that was not written is not a detail. In a scrolling error list
  // under a green "Complete!" tick, it would go unseen and the operator would
  // eject the card. The title has to lose its promise.
  const missingSidecars=[...new Set(R.flatMap(r=>r.sidecarFailed||[]))];
  // Two lines, broken by hand: left to wrap on its own this one would put
  // "COPIED &" alone on the first line.
  // The engine counts what was LEFT to copy: on a card whose files were passed
  // over, totalFiles already excludes them, so `cf<tf` can never become true
  // and cannot drop the promise. The number of files passed over is what
  // says it, and it has to be the sum over the cards, not the biggest of them.
  const skippedTotal = G.reduce((a,g)=>a+Math.max(0,...g.map(r=>r.skippedFiles||0)),0);
  // "ALL" is a promise about a card. A retry knows nothing about the rest of
  // the card, so it never says it.
  const headline = retryOf
    ? `${cf} FILE${cf===1?'':'S'} RE-COPIED`
    : skippedTotal>0
      ? `${cf} NEW FILE${cf===1?'':'S'} COPIED`
      : (cf<tf?`${cf} OF ${tf} FILES COPIED`:'ALL FILES COPIED');
  const okTitle = missingSidecars.length
    ? headline+(CHECKED[runMode]||'')+'\nNO MANIFEST WRITTEN'
    : headline+(CHECKED[runMode]||'');
  const tEl=document.getElementById('s-title');
  // What failed decides what the title says. "FINISHED WITH ERRORS" tells the
  // operator nothing: it does not say whether to throw away the drive or the
  // card, and those are opposite conclusions. The title names the drive or the
  // card, never the number of errors.
  const V = failureVerdict(R, { canceled, ok, okTitle, missingSidecars, retrySuspect });
  tEl.className='sum-h1 '+V.cls;
  tEl.innerHTML=V.title.map(esc).join('<br>');
  const lead=document.getElementById('s-lead');
  if(lead){
    lead.style.display = V.lead ? 'block' : 'none';
    lead.className = 'sum-lead '+(V.leadKind||'bad');
    lead.textContent = V.lead || '';
  }
  // Under it: the card, the algorithm, and in FAST and SIZE CHECK the word the
  // operator must not be allowed to assume. In red, because it is the one
  // thing on a green window that is not reassuring.
  ico.className='sum-ico '+V.ico;
  ico.innerHTML = V.ico==='ok'?ICO_CHECK : V.ico==='err'?ICO_X : V.icoShape==='stop'?ICO_STOP : ICO_WARN;
  const cardNames=[...new Set(R.map(r=>r.sourceName))];
  const algoTxt = runMode===MODE.PRO ? (ALGN[r0.proAlgo]||r0.proAlgo||'')
                : runMode===MODE.SECURE ? 'xxHash64' : '';
  const caveat  = runMode===MODE.FAST ? 'not verified'
                : runMode===MODE.SIZE_CHECK ? 'content not verified' : '';
  document.getElementById('s-sub').innerHTML =
    (cardNames.length>1 ? `${cardNames.length} cards` : esc(cardNames[0]||''))+
    (algoTxt?` · ${esc(algoTxt)}`:'')+
    (caveat?` · <span class="caveat">${caveat}</span>`:'');
  const copyMs=sum(g=>g[0].copyMs);
  const v1Ms=sum(g=>g[0].verify1Ms);
  const v2Ms=sum(g=>g[0].verify2Ms);
  const srow=(l,v,st)=>`<div class="srow"><div class="sr-lbl">${l}</div><div class="sr-val"${st?` style="${st}"`:''}>${v}</div></div>`;
  // MODE tile: mode name coloured with the copy-mode palette, algorithm on a
  // smaller sub-line (nothing left to truncate). Fixed 4×2 grid:
  //   MODE · FILES COPIED · TOTAL SIZE · AVG SPEED
  //   COPY · 1ST VERIFY  · 2ND VERIFY · TOTAL
  // Same four colours as the COPY MODE badges: the two must never disagree on
  // what a mode looks like.
  const MODE_UI={fast:['FAST','var(--grey)'],normal:['SIZE CHECK','var(--blue)'],
                 slow:['SECURE','var(--orange)'],pro:['PRO','var(--pro)']};
  const [mName,mCol]=MODE_UI[runMode]||['','var(--text)'];
  // The double read is an option OF the mode, so it rides in the mode tile, on
  // the same line, smaller. When it is off, nothing is written: never "double
  // read: no". The algorithm has left this tile and lives under the title.
  const dbl = R.some(r=>r.proDoubleRead===true);
  const modeTile=`<div class="srow"><div class="sr-lbl">Mode</div>`+
    `<div class="sr-mode" style="color:${mCol}">${mName}`+
    (dbl?`<span class="sr-opt"> + CARD RE-READ</span>`:'')+`</div></div>`;
  const dash='<span style="color:var(--text3)">-</span>';
  // Per card, then summed: three cards passing over 10 files each is 30, and
  // taking the max across the whole run would report 10.
  const skipped=skippedTotal;
  // Row 1: what was moved. Row 2: how long it took, and how fast.
  // `tf` already excludes what was passed over, so "62/62" would repeat one
  // number twice. When files were skipped, the second figure worth showing is what
  // the card holds in total.
  const onCard = skipped>0 ? cf+skipped : tf;
  const rows=[ modeTile, srow('Files', skipped>0?`${cf}/${onCard}`:String(cf)),
               srow('Total size', fmtSize(tb)) ];
  // Only the tempos the mode actually spent. FAST has no verify pass, SECURE
  // has no second read: an empty cell invites the question "why is it empty".
  const t2=[ srow('Copy', copyMs>0?fmtEta(copyMs/1000):dash) ];
  if(runMode===MODE.SECURE||runMode===MODE.PRO) t2.push(srow('Verify', v1Ms>0?fmtEta(v1Ms/1000):dash));
  // The tile is narrow: the short form, as in the report columns.
  if(dbl) t2.push(srow('Re-read', v2Ms>0?fmtEta(v2Ms/1000):dash));
  t2.push(srow('Total', fmtEta(dur/1000)));
  // Speed comes AFTER the tempos: they add up to the total, the speed is a
  // conclusion of another kind. On a batch it would average cards of different
  // throughputs and describe none of them, so the tile disappears entirely
  // rather than showing a dash.
  // A tile is 90 to 110 px wide: one decimal on a three-digit speed pushes
  // "107.1 MB/s" into an ellipsis. Above 10 the decimal says nothing.
  const spdTile=(v)=>{ const t=fmtSpd(v); const m=/^(\d+)\.(\d) (.*)$/.exec(t);
                       return (m && +m[1]>=10) ? `${m[1]} ${m[3]}` : t; };
  if(G.length===1) t2.push(srow('Avg speed', spdTile(tb/(dur/1000))));
  // No "Errors: 3" tile: the title already carries the number, and the block
  // below says what each of them was. Such a tile would only repeat the bad
  // news without adding a single thing to do about it.
  // Prose, not a value: the body font, not the monospace reserved for paths and
  // figures. Last two words glued so neither ends up alone on a line.
  if(skipped>0) t2.push(`<div class="srow" style="grid-column:1/-1"><div class="sr-lbl">Not copied</div>`+
    `<div class="sr-note">${skipped} file${skipped>1?'s':''} already verified on this destination, `+
    `left out on&nbsp;purpose</div></div>`);
  document.getElementById('s-grid').innerHTML = rows.join('');
  const g2=document.getElementById('s-grid2');
  g2.className='sum-grid2'+(t2.length>=5?' n5':'');
  g2.style.gridTemplateColumns='repeat('+Math.min(t2.length,5)+',1fr)';
  g2.innerHTML=t2.join('');

  // ── One block per card ──────────────────────────────────────────────────
  // A single card shows everything. From the SECOND card on, the list shows
  // names only and the NAME is what unfolds that card's destinations: you open
  // the card whose path you want, not the whole batch inventory.
  S._revealPaths = R.map(r => r.destPath || '');
  S._cardGroups  = G.map(g => ({ name: g[0].sourceName, path: g[0].sourcePath }));
  const many = G.length>1;
  const cardsHtml = G.map((g,gi)=>{
    const cfg=Math.min(...g.map(x=>x.copiedFiles));
    const dests=g.map(x=>({ path:x.destPath||'', idx:R.indexOf(x) }))
      .map(d=>`<div class="sc-dest"><div class="sc-path">${esc(d.path)}</div>`+
               `<button class="mini-btn" data-js="reveal" data-idx="${d.idx}">REVEAL</button></div>`).join('');
    return `<div class="sc">`+
      `<div class="sc-row">`+
        `<div class="sc-open${many?' clk':''}"${many?` data-js="toggle-card"`:''}>`+
          (many?`<span class="sc-caret" id="sc-car-${gi}">&#9656;</span>`:'')+
          `<span class="sc-name">${esc(g[0].sourceName)}</span>`+
          `<span class="sc-count">${cfg} file${cfg===1?'':'s'}</span>`+
        `</div>`+
        `<button class="mini-btn ej" id="sc-ej-${gi}" style="display:none">EJECT</button>`+
      `</div>`+
      `<div class="sc-dests" id="sc-d-${gi}"${many?' style="display:none"':''}>${dests}</div>`+
    `</div>`;
  }).join('');
  // Remarks come from the engine (a card log that could not be written, a note
  // file that did not land) and from whatever finishes after this window opens
  // (the post-ingest command, the phone notification).
  S._lateNotes = [];
  // The engine attaches a card-level remark to every destination result, so
  // without this a two-drive ingest would show the same sentence twice, word
  // for word.
  S._summaryNotes = [];
  { const seen=new Set();
    for(const n of R.flatMap(r => r.notes || [])){
      const k=(n.code||'')+'|'+(n.text||'');
      if(seen.has(k)) continue; seen.add(k); S._summaryNotes.push(n);
    } }
  if(retryOf){
    S._summaryNotes = S._summaryNotes.concat([{
      code:'CV-12',
      text:'This window describes the re-copy, not the whole card.',
      detail:'The files listed here were copied again into the folders the first run created. Everything the first run had already delivered is unchanged.' }]);
    // A successful re-copy says the drive took the file this time. It says
    // nothing about a card that gave different data twice.
    const suspect = retryOf.some(r=>(r.unstableFiles||[]).length) || retryOf.some(r=>r.scanIncomplete);
    if(suspect) S._summaryNotes = S._summaryNotes.concat([{
      code:'CV-13',
      text:'The first run could not read this card cleanly.',
      detail:'A file that copies on the second attempt does not clear that. Do not format this card, and copy it again on another reader.' }]);
  }
  if(unaccounted.length){
    S._summaryNotes = S._summaryNotes.concat([{
      code:'CV-11',
      text: unaccounted.length===1
        ? (unaccounted[0].name||'One card')+' did not report back.'
        : unaccounted.length+' cards did not report back.',
      detail:'Nothing is known about '+(unaccounted.length===1?'it':'them')+
             ', so nothing about '+(unaccounted.length===1?'it':'them')+
             ' is claimed here. '+(unaccounted.length===1?'It is':'They are')+
             ' still in the source list. Ingest '+(unaccounted.length===1?'it':'them')+' again.' }]);
  }
  if(missingSidecars.length){
    // Which drive. "the destination" would be anonymous, and on a two-drive
    // ingest the other folder is perfectly re-verifiable.
    const on=[...new Set(R.filter(r=>(r.sidecarFailed||[]).length).map(driveNameOf))];
    const list = missingSidecars.length===1 ? 'The '+missingSidecars[0]
               : 'The '+missingSidecars.slice(0,-1).join(', the ')+' and the '+missingSidecars.slice(-1);
    S._summaryNotes = S._summaryNotes.concat([{
      code:'SIDECAR',
      text: list+' could not be written to '+(on.length===1?on[0]:on.join(' and '))+'.',
      // "Every file was copied and verified" is only true when nothing else
      // failed. On a run that also lost files, this remark would sit under a
      // red title and tell the operator the opposite of what the title says.
      detail:(ok ? 'Every file was copied and verified. But '+(on.length>1?'those folders':'that folder')
                 : 'On top of what failed above, '+(on.length>1?'those folders':'that folder'))+
             ' cannot be re-verified later, and EJECT stays off: the card is the only original left.' }]);
  }
  renderSummaryNotes(S._summaryNotes);
  document.getElementById('s-cards').innerHTML =
    (many?`<div class="sc-hd"><span class="sc-hd-l">${G.length} cards</span>`+
          `<button class="mini-btn ej" id="sc-ej-all" style="display:none">EJECT ALL</button></div>`:'')+
    cardsHtml;
  { const box = document.getElementById('s-cards');
    box.querySelectorAll('[data-js="reveal"]').forEach(b => { b.onclick = function(){ revealAt(+this.dataset.idx); }; });
    box.querySelectorAll('.sc').forEach((card, gi) => {
      const open = card.querySelector('[data-js="toggle-card"]'); if(open) open.onclick = function(){ toggleCard(gi); };
      const ej = card.querySelector('#sc-ej-' + gi); if(ej) ej.onclick = function(){ ejectCard(gi); };
    });
    const all = document.getElementById('sc-ej-all'); if(all) all.onclick = function(){ ejectAllCards(); }; }
  // Cold-verify hint: a verified ingest (SECURE/PRO) whose read-back was NOT
  // cache-bypassed (i.e. not on macOS) can, on the tail of a big transfer, have
  // compared cached RAM against itself. Suggest an independent cold Verify.
  const cv=document.getElementById('s-coldverify');
  if(cv){
    const verified = R.some(r => r && r.coldVerify !== null && r.coldVerify !== undefined);
    const cold     = R.some(r => r && r.coldVerify === true);
    // Strongest signal first: the PRO source re-read was answered from RAM, so
    // it verified nothing about the card. Say it plainly.
    const dblCached = R.some(r => r && r.doubleReadCached);
    // Never over a window headlined with lost files: "Your footage is fine"
    // would sit six lines under "3 FILES DID NOT SURVIVE THE COPY TO NAS_BACKUP".
    if(dblCached && !canceled && ok){
      cv.style.display='block';
      const dr = R.find(r => r && r.doubleReadCached) || {};
      const sp = v => (typeof v === 'number' && v > 0) ? fmtSpd(v) : '-';
      // Offer a real re-check only when we can actually do it: macOS, a known
      // source, and the per-file hashes from the copy.
      const canRedo = window.ingesto.platform === 'darwin'
        && dr.sourcePath && Array.isArray(dr.recheckList) && dr.recheckList.length;
      S._redo = canRedo ? { sourcePath: dr.sourcePath, sourceName: dr.sourceName,
                            algo: dr.proAlgoUsed || 'xxh128', files: dr.recheckList } : null;
      cv.style.display='block';
      // Wording aimed at shooters/DITs/editors, not engineers: lead with
      // "your footage is safe", explain simply, keep the numbers as a small
      // technical footnote for those who want them.
      cv.innerHTML =
        `<div style="margin:8px 0;padding:11px 13px;border-radius:var(--rs);`+
        `border:1px solid rgba(242,160,61,.5);background:rgba(242,160,61,.12);color:var(--orange);font-size:12.5px;line-height:1.5">`+
        `<b>The extra card check did not really run</b><br>`+
        `Your footage is fine: every file was copied and verified on the destination.<br>`+
        `But the card re-read was answered by the computer's memory, not by the card itself, `+
        `so it couldn't test the card's health. Consider this ingest verified at <b>SECURE</b> level.`+
        `<div style="margin-top:5px;color:var(--text3);font-size:11px;">`+
        // The footnote must state what was actually measured, not an inference
        // from pass speeds: the verdict comes from a direct test, so the
        // numbers shown are that test's.
        (dr.cacheProbe
          ? `Test: an 8 MB read taken right after clearing the computer's memory took `+
            `${esc(dr.cacheProbe.coldMs.toFixed(1))} ms, against `+
            `${esc(dr.cacheProbe.warmMs.toFixed(1))} ms for the same data read from memory. `+
            `Too close to be a real read of the card.`
          : `The computer's memory could not be cleared before re-reading, so the card itself was never asked.`)+
        `</div>`+
        (canRedo
          ? `<div style="margin-top:9px;padding-top:9px;border-top:1px solid rgba(242,160,61,.3);color:var(--text2);">`+
            `You can run the card check for real: the card stays in the reader, and your copied files are untouched.`+
            `<button id="dr-redo" style="display:block;width:100%;margin-top:8px;padding:9px;border-radius:var(--rs);`+
            `border:1px solid rgba(242,160,61,.5);background:rgba(242,160,61,.16);color:var(--orange);`+
            `font-family:var(--font);font-size:12.5px;font-weight:700;cursor:pointer;">`+
            `⟳ Check the card for real</button></div>`
          : ``)+
        `<div id="dr-result" style="margin-top:8px;"></div>`+
        `</div>`;
      const rb = document.getElementById('dr-redo');
      if(rb) rb.onclick = () => redoDoubleRead();
    } else if(verified && !cold && !canceled && ok){
      cv.style.display='block';
      cv.innerHTML =
        `<div style="margin:8px 0;padding:11px 13px;border-radius:var(--rs);`+
        `border:1px solid rgba(94,155,255,.4);background:rgba(94,155,255,.10);color:var(--blue);font-size:12.5px;line-height:1.5">`+
        `<b>You can double-check this later</b><br>`+
        `Today's check ran right after the copy, so part of it may have been answered by the computer's memory. `+
        `For extra peace of mind: another day, re-plug the drive and press <b>Verify</b> on this folder, `+
        `that reads every file straight from the drive.</div>`;
    } else cv.style.display='none';
  }
  // ── What failed, grouped by CAUSE ───────────────────────────────────────
  // One scrolling list under a red "Transfer Errors" would mix real failures,
  // remarks and raw system codes, and thirty corrupt files would make thirty
  // identical lines. Here the twelve failures are grouped by
  // what the operator has to conclude from them, and the system codes are
  // translated with the raw code kept small and grey at the end, for the person
  // reading a bug report, not for the shooter.
  const eb=document.getElementById('s-errs');
  const groups = buildFailureGroups(R);
  if(groups.length){
    eb.style.display='block';
    document.getElementById('s-errlist').innerHTML = groups.map((g,gi)=>
      `<div class="fg">`+
        `<div class="fg-h" data-js="fail-group">`+
          `<span class="sc-caret" id="fg-car-${gi}">&#9656;</span>`+
          `<span class="fg-what">${esc(g.what)}</span>`+
          `<span class="fg-n">${g.files.length} ${g.unit||'file'}${g.files.length>1?'s':''}</span>`+
        `</div>`+
        `<div class="fg-why">${esc(g.why)}`+
          (g.code?` <span class="fg-code">${esc(g.code)}</span>`:'')+`</div>`+
        `<div class="fg-files" id="fg-f-${gi}" style="display:none">`+
          g.files.map(f=>`<div class="fg-file">${esc(f)}</div>`).join('')+
        `</div>`+
      `</div>`).join('');
    document.getElementById('s-errlist').querySelectorAll('[data-js="fail-group"]').forEach((h, gi) => { h.onclick = function(){ toggleFailGroup(gi); }; });
  } else eb.style.display='none';
  // Sound notification (only when the copy was not cancelled)
  if(!canceled) playIngestSound(ok);
  // No separate "This card may be failing" panel: the title, the constant line
  // and the cause block already say it, and the advice (check the files by
  // eye, prefer another copy) lives in the cause block itself.

  // Collect files that failed copy/verify, grouped by source+destination,
  // so the user can re-copy only those (into the same folder).
  // Kept for the retry window, which has to be able to say what it is fixing.
  if(!retryOf) S._lastRun = R;
  // Set aside copies ACCUMULATE across attempts. A first failure leaves
  // "X.MOV.ingesto-failed", a second leaves "X.MOV.ingesto-failed-2", and each
  // run only knows about its own: handing the retry just the latest list would
  // leave every earlier generation on the drive for ever. Verify would then
  // report that folder as holding a bad copy, and re-ingesting it would be
  // refused outright,
  // because a folder carrying both "X.MOV" and "X.MOV.ingesto-failed" is
  // exactly what PF-E10 turns away.
  if(!retryOf) S._quarantineSeen = {};
  const qKey = r => String(r.sourcePath||r.sourceName||'')+'\u0000'+String(r.destPath||'');
  { const seen = (S._quarantineSeen || (S._quarantineSeen = {}));
    for(const r of R){
      const k = qKey(r);
      seen[k] = [...new Set((seen[k]||[]).concat(r.quarantinedPaths||[]))];
    } }
  S._failedGroups = R.filter(r => Array.isArray(r.failedFiles) && r.failedFiles.length).map(r => ({
    sourcePath: r.sourcePath, sourceName: r.sourceName,
    destPath:   r.destPath,  destName: (r.destPath||'').split(/[\\/]/).pop(),
    mode:       r.mode,      files: r.failedFiles,
    destRelMap: r.failedMap || {},   // original destination paths (Reorganize runs)
    // The exact *.ingesto-failed paths THIS run created. The retry deletes
    // those and nothing else: deriving them from a name pattern could erase a
    // delivered file the card itself carried under that name.
    quarantined: (S._quarantineSeen && S._quarantineSeen[qKey(r)]) || r.quarantinedPaths || [],
    // Carried so the retry can be judged against what the first run found,
    // instead of replacing its verdict.
    _pro: { algo: r.proAlgo || null, dbl: r.proDoubleRead === true },
  }));
  const nFailed = S._failedGroups.reduce((a,g)=>a+g.files.length,0);
  const reBtn = document.getElementById('sum-recopy');
  if (reBtn){
    reBtn.style.display = nFailed>0 ? '' : 'none';
    reBtn.textContent   = `↻ Re-copy ${nFailed} failed file${nFailed>1?'s':''}`;
  }

  setupEjectButtons(R, G, { ok });
  document.getElementById('sum-ov').classList.add('open');
}
function closeSummary(){
  document.getElementById('sum-ov').classList.remove('open');
  // Clear sources after a completed ingest so the next card starts fresh
  if(S._clearSrcOnClose){ S._clearSrcOnClose=false; clearSources(); }
}

// Re-copy only the files that failed copy/verify, into the same folders.
async function recopyFailed(){
  const groups = S._failedGroups || [];
  if(!groups.length) return;
  // Leave the summary without triggering the "clear sources" behaviour
  S._clearSrcOnClose=false;
  document.getElementById('sum-ov').classList.remove('open');
  S.copying=true; S.recopyCanceled=false; updateBtn();
  // A retry writes just as much as the original ingest did, and over a slow
  // destination it runs just as long. Like the ingest, it blocks power save,
  // or the machine could sleep in the middle of the write that is supposed to
  // repair the copy. Released in the same place as the ingest's.
  try{ window.ingesto.setPowerBlock(true); }catch(_){}
  setIngestLock(true);
  // Same view as a normal ingest. A retry over a slow network destination can
  // run for a long time, and watching it through a one-line strip would tell
  // the operator nothing about which card or which drive is being redone.
  tfInitFromGroups(groups);
  document.getElementById('tf-ring').style.display = '';
  document.getElementById('tf-stats').classList.add('on');
  setCenterView('transfers');
  { const t=document.getElementById('h-title'); if(t){ t.textContent='Re-copying failed files'; t.style.color=''; } }
  resetSpark();
  const results=[];
  for(const g of groups){
    // A cancel during the retry must stop the remaining groups. Each
    // recopyFailed() call clears the cancel flag in the main process, so
    // without this the next destination would start copying right after the
    // user pressed Cancel.
    if(S.recopyCanceled) break;
    try{
      const r = await window.ingesto.recopyFailed({
        sourcePath:g.sourcePath, sourceName:g.sourceName,
        destPath:g.destPath, destName:g.destName, destIndex:g._di||0,
        // The RUN's algorithm, not whatever the selector shows at retry time: a
        // retry with a different algorithm would leave the recopied file out of
        // the manifest, and Verify would then pass over a folder holding a file
        // nothing had ever checksummed.
        mode:g.mode, proAlgo:(g._pro&&g._pro.algo)||S.proAlgo,
        proDoubleRead:(g._pro?g._pro.dbl:S.proDoubleRead), files:g.files,
        destRelMap:g.destRelMap||{}, quarantined:g.quarantined||[],
      });
      if(r) results.push(r);
    }catch(e){
      // A group that rejects must not vanish from the results, or a retry where
      // one destination failed outright would still show "Transfer Complete"
      // and the re-copy button would disappear for the destination never
      // retried.
      console.error('recopyFailed', e);
      results.push({ success:false, canceled:false, sourceName:g.sourceName, sourcePath:g.sourcePath,
        destPath:g.destPath, mode:g.mode, totalFiles:g.files.length, copiedFiles:0,
        totalBytes:0, copiedBytes:0, errors:g.files.length,
        errorList:[{ file:'(retry)', phase:'retry',
          error:'this destination could not be retried: '+((e&&e.message)||'unexpected error') }],
        failedFiles:g.files.slice(), failedMap:g.destRelMap||{}, unstableFiles:[],
        copyMs:0, verify1Ms:0, verify2Ms:0, duration:0 });
    }
  }
  S.copying=false;
  try{ window.ingesto.setPowerBlock(false); }catch(_){}
  setIngestLock(false);
  tfExit();
  updateBtn();
  // The window of the retry, told as a retry: the first run's results are
  // handed over so it cannot present a handful of recopied files as a card.
  showSummary(results, { retryOf: S._lastRun || [] });
}

// Reset the source list (keeps destinations, template, counter)
function clearSources(){
  S.sources=[];
  // addToZone pre-fills a new card's fields from the global Operator/Camera/
  // Profile/Notes inputs, so whatever stays in them is inherited by the NEXT
  // card.
  // Operator, camera and picture profile are KEPT for the next card: on a
  // shoot they change rarely, and typing them again for every card is where
  // inconsistent metadata comes from. The (A)/(M) mark on the next card says
  // where its camera came from, and the broom beside the title clears them all
  // in one click. Notes describe ONE card, so they go.
  const mn=document.getElementById('meta-note');  if(mn) mn.value='';
  persistPrefs();
  renderZoneList('src');
  renderVolumes();
  renderSourceInfoCards();
  updateCopyInfoVisibility();
  updateBtn();
  persistPrefs();
}

// Modes explanation modal
function showModesInfo(){ document.getElementById('modes-info-ov').classList.add('open'); }
function hideModesInfo(){ document.getElementById('modes-info-ov').classList.remove('open'); }

// Card tracking (sentinel) switch. OFF by default; enabling requires confirmation.
function onSentinelToggle(el){
  if(el.checked){
    // Each paragraph through the dictionary, or this message would stay in
    // English in a translated interface.
    const ok = confirm([
      tr('Enable card tracking?'),
      tr('ingesto will write a small log file (.ingesto.json) on the SOURCE card after each copy, so it can detect an already-ingested card next time.'),
      tr('This requires write access to the card. While this option is OFF, ingesto never writes anything on your cards.'),
      tr('Do you want ingesto to write on the source card?')
    ].join('\n\n'));
    if(!ok){ el.checked=false; S.writeSentinel=false; persistPrefs(); return; }
    S.writeSentinel=true;
  } else {
    S.writeSentinel=false;
  }
  persistPrefs();
}

// Info modals: counter and card re-read
function showCounterInfo(){ document.getElementById('counter-info-ov').classList.add('open'); }
function showDrInfo(){ document.getElementById('dr-info-ov').classList.add('open'); }
function hideDrInfo(){ document.getElementById('dr-info-ov').classList.remove('open'); }
function hideCounterInfo(){ document.getElementById('counter-info-ov').classList.remove('open'); }
