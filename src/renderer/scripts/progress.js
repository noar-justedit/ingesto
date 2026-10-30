// ═══════════════════════════════════════════════════════
// Progress + complete
// ═══════════════════════════════════════════════════════
// Real-time throughput sparkline (header strip) — line + filled area chart
const SPARK_N = 24, SPARK_W = 100, SPARK_H = 28;
function resetSpark(){
  S._spark = [];
  const svg = document.getElementById('h-spark');
  if(svg) svg.innerHTML = `<path class="spark-area" d=""></path><path class="spark-line" d=""></path><circle class="spark-dot" r="2" style="display:none"></circle>`;
}
function pushSpark(speedBps){
  const svg = document.getElementById('h-spark');
  if(!svg) return;
  if(!svg.querySelector('.spark-line')) resetSpark();
  S._spark.push(Math.max(0, speedBps||0));
  if(S._spark.length > SPARK_N) S._spark.shift();
  const n = S._spark.length;
  if(n < 2) return; // need at least 2 points to draw a line
  const max = Math.max(1, ...S._spark);
  const stepX = SPARK_W / (SPARK_N - 1);
  const offset = SPARK_N - n; // right-align: most recent sample is the rightmost point
  const pts = S._spark.map((v,i) => {
    const x = (offset+i) * stepX;
    const y = SPARK_H - 1 - (v/max) * (SPARK_H - 3);
    return [x, y];
  });
  const line = 'M' + pts.map(p => p.join(',')).join(' L');
  const area = line + ` L${pts[pts.length-1][0]},${SPARK_H} L${pts[0][0]},${SPARK_H} Z`;
  svg.querySelector('.spark-line').setAttribute('d', line);
  svg.querySelector('.spark-area').setAttribute('d', area);
  const dot = svg.querySelector('.spark-dot');
  const last = pts[pts.length-1];
  dot.setAttribute('cx', last[0]); dot.setAttribute('cy', last[1]);
  dot.style.display = '';
}
// ── Transfers view ──────────────────────────────────────────────────────────
// While an ingest runs, the centre column stops showing mounted volumes —
// nobody plugs a card in mid-copy — and shows what is actually happening
// instead: one block per card, one sub-line per destination.
//
// Why the shape is what it is: the engine reports a SINGLE copy event for all
// destinations (one read of the card fanning out to N writes), then verifies
// each destination in turn, then re-reads the source once. So copy and source
// re-read are card-level facts and live on the card's own bar, while the
// destination verify is per-destination and lives on its sub-line. Drawing a
// separate copy bar per destination would imply N independent operations that
// the engine never performs.
const TF_LBL = { queued:'QUEUED', copy:'COPYING', copied:'COPIED',
                 verify:'VERIFYING', source:'CARD RE-READ',
                 done:'VERIFIED ✓', err:'ERROR',
                 // a finished card in a mode that reads nothing back
                 doneFast:'COPIED ✓ (not verified)', doneNormal:'COPIED ✓ (sizes checked)' };
const TF_COL = { copy:'var(--green)', copied:'var(--green)', verify:'var(--blue)',
                 source:'var(--pro)', done:'var(--green)', err:'var(--red)',
                 queued:'transparent' };

function tfIsNetwork(p){
  const v = S.volumes.find(x => x.path === p);
  if (v) return !!v.isNetwork;
  // Browse can land on a sub-folder of a mounted share: fall back to the
  // volume that contains it, then to a plain UNC path.
  if (S.volumes.some(x => x.isNetwork && p && pathContains(x.path, p))) return true;
  return /^(\/\/|\\\\)/.test(p||'');
}

// Built once per ingest, from the list frozen at START.
function tfInit(){
  const nD    = Math.max(1, S.dests.length);
  const hasV1 = S.mode !== MODE.FAST;
  const sizeOnly = S.mode === MODE.SIZE_CHECK;
  const hasV2 = (S.mode === MODE.PRO && S.proDoubleRead);
  // Everything the queue maths needs is FROZEN here. Reading S.mode or
  // S.dests live would let a mid-ingest change (removing a destination,
  // switching mode) rewrite the denominator under a run already in flight
  // and send the ring to 100% while the copy is still going.
  const cards = S.sources.map(src => ({
    name: src.name, path: src.path,
    bytes: src._bytes || 0,      // shown; may be refined once copying starts
    w: src._bytes || 0,          // weight in the ring, never changed after this
    files: 0, errors: 0,
    phase: 'queued', frac: 0, file: '', speed: 0,
    dests: S.dests.map(d => ({ name: d.name, net: tfIsNetwork(d.path),
                               phase: 'queued', frac: 0, speed: 0 }))
  }));
  // A card whose size could not be measured (unreadable folder, network
  // source) must not weigh zero — it would vanish from the queue and let the
  // ring reach 100% with that card still copying. Give it the median of the
  // ones we do know, or an equal share if we know none.
  const known = cards.map(c => c.w).filter(x => x > 0).sort((a,b)=>a-b);
  const fallback = known.length ? known[Math.floor(known.length/2)] : 1;
  cards.forEach(c => { if(!(c.w > 0)) c.w = fallback; });

  S.tfSpd = 0;
  S.spd = { copy:0, dest:0, source:0 };
  S.tf = { multi: S.dests.length > 1, nD, hasV1, hasV2, sizeOnly,
           segs: 1 + (hasV1 ? nD : 0) + (hasV2 ? 1 : 0), cards };
  S._tfSig = '';
}

// A retry is a queue too. Built from the failed groups rather than from the
// loaded cards: only the destinations that actually failed appear, and the ring
// is weighted by NUMBER OF FILES — the retry list carries file names, not
// sizes. Less exact than the byte weighting of a normal ingest, which matters
// far less when a retry is a handful of files rather than terabytes.
function tfInitFromGroups(groups){
  const byCard = new Map();
  for(const g of groups){
    const k = g.sourcePath || g.sourceName || '';
    if(!byCard.has(k)) byCard.set(k, { name:g.sourceName, path:g.sourcePath, dests:[] });
    byCard.get(k).dests.push(g);
  }
  // Each group is told where it lives in the view, so the progress it reports
  // lands on the right destination line instead of all piling onto the first.
  [...byCard.values()].forEach((c, ci) => c.dests.forEach((g, di) => { g._ci = ci; g._di = di; }));
  const cards = [...byCard.values()].map(c => ({
    name: c.name, path: c.path,
    // Weight = units of WORK (a file redone on two destinations is two jobs);
    // the count shown = distinct files, which is what the operator counts.
    bytes: 0, w: Math.max(1, c.dests.reduce((a,g)=>a+g.files.length, 0)),
    files: new Set(c.dests.flatMap(g => g.files)).size, errors: 0,
    phase: 'queued', frac: 0, file: '', speed: 0,
    dests: c.dests.map(g => ({ name: g.destName || g.destPath, net: tfIsNetwork(g.destPath),
                               phase: 'queued', frac: 0, speed: 0, seg: 0 }))
  }));
  const nD = Math.max(1, ...cards.map(c => c.dests.length));
  const mode = groups[0] && groups[0].mode;
  const hasV1 = mode !== MODE.FAST;
  const sizeOnly = mode === MODE.SIZE_CHECK;
  // A PRO retry DOES re-read the source when the double read is on — the engine
  // is told so by recopyFailed. Claiming otherwise would make the card reach
  // 100% while the source re-read still had minutes to run.
  const hasV2 = (mode === MODE.PRO && !!S.proDoubleRead);
  S.tfSpd = 0;
  S.spd = { copy:0, dest:0, source:0 };
  S.tf = { multi: nD > 1, nD, hasV1, hasV2, sizeOnly,
           segs: 1 + (hasV1 ? nD : 0) + (hasV2 ? 1 : 0), cards, retry: true };
  S._tfSig = '';
}

function tfProgress(d){
  if(!S.tf) return;
  const ci = d.sourcePath ? S.tf.cards.findIndex(c => c.path === d.sourcePath)
                          : S.tf.cards.findIndex(c => c.name === d.sourceName);
  if(ci < 0) return;
  const c = S.tf.cards[ci];

  // Everything before the current card is finished — but "finished" is not
  // "verified". A card that reported errors keeps saying so; painting it green
  // would be the one lie this application cannot afford.
  c._seen = true;
  for(let k=0;k<ci;k++){
    const p = S.tf.cards[k];
    // "Finished" is not inferred from the index alone. A card the engine refused
    // outright — an impossible folder name, a destination inside the source —
    // emits NOT ONE event, so its error count is still zero and it would be
    // painted VERIFIED ✓ with a green tick over a card that was never read. A
    // card we never heard from cannot be called clean.
    const bad = p.errors > 0 || !p._seen;
    p.phase = bad ? 'err' : 'done';
    p.frac = 1; p.file = '';
    // The engine reports errors per card, not per destination, so on a card
    // that failed we state only what is certain — the files were written —
    // rather than putting a green tick under a red heading.
    p.dests.forEach(x => { x.phase = bad ? 'copied' : 'done'; x.frac = 1; });
  }

  // In a retry each destination is a separate engine run reporting only ITS
  // own file count and size, so adopting them would shrink the card's totals
  // to whatever is being redone right now. The figures fixed at the start are
  // the ones that describe the card.
  if(!S.tf.retry){
    // ONLY during the copy. In the verify phase the engine's `totalFiles` is
    // the number of verification STEPS — files × destinations, plus the source
    // pass — because that is what its own progress counts. Adopting it would
    // make the card heading say 168 files while copying and 336 the moment
    // verification starts (504 on three destinations): a figure that
    // describes the work, printed on the line that describes the card.
    if(d.phase === 'copy' && d.totalFiles) c.files = d.totalFiles;
    // The displayed size follows what is really being copied (a filter or
    // "new files only" makes it smaller than the card); the RING WEIGHT does
    // not move, or the total would shrink under a run in progress and the
    // percentage would go backwards.
    if(d.phase === 'copy' && d.totalBytes) c.bytes = d.totalBytes;
  }
  c.file   = d.currentFile || '';
  c.speed  = d.speed || 0;
  // In a retry each destination is a SEPARATE engine run whose error count
  // restarts at zero. Overwriting would let the next group's clean start erase
  // a group that failed, and the card would end with a green tick.
  c.errors = S.tf.retry ? Math.max(c.errors || 0, d.errors || 0) : (d.errors || 0);

  // Each bar shows ITS OWN phase from 0 to 100. `progress` is the whole
  // verify (destinations + source re-read) and would start the double source
  // read at two thirds full; `passProgress` is the current pass and is what
  // the label above the bar actually names.
  const pass = (d.phase === 'verify' && d.passProgress != null)
    ? Math.max(0, Math.min(1, d.passProgress))
    : Math.max(0, Math.min(1, d.progress || 0));
  c.frac = pass;

  if(d.phase === 'copy'){
    c.phase = 'copy';
    if(S.tf.retry){
      // A retry redoes one destination at a time — each is its own engine run.
      const x = c.dests[d.destIndex || 0];
      if(x){ x.phase='copy'; x.frac=c.frac; x.seg=0; x.speed=d.speed||0; }
    } else {
      // One operation writing to every destination at once: the sub-lines
      // mirror the card's progress rather than inventing per-destination
      // figures the copy phase does not measure separately.
      c.dests.forEach(x => { x.phase='copy'; x.frac=c.frac; });
    }
  } else if(d.pass === 'source'){
    c.phase = 'source';
    // Same rule as for a finished card: on a card that reported errors the
    // engine does not say WHICH destination failed, so we state only what is
    // certain — the files were written. A green tick here would cover a
    // destination holding quarantined copies.
    const bad = (d.errors || 0) > 0 || c.errors > 0;
    c.dests.forEach(x => { x.phase = bad ? 'copied' : 'done'; x.frac=1; });
  } else {
    c.phase = 'verify';
    const di = d.destIndex || 0;
    // The engine verifies destinations AT THE SAME TIME and reports each one's
    // own progress. An event speaks for ONE destination — the others keep
    // whatever they had, instead of being rewritten from an arithmetic guess
    // about whose turn it is.
    const x = c.dests[di];
    if(x){
      x.frac  = (d.destProgress != null) ? Math.max(0, Math.min(1, d.destProgress)) : pass;
      // A destination that reached the end of its files while the card is
      // carrying errors says COPIED, not VERIFIED. The engine reports errors per
      // card, not per destination, so "verified" is a claim we cannot make.
      x.phase = x.frac < 0.999 ? 'verify' : (c.errors > 0 ? 'copied' : 'done');
      x.speed = d.destSpeed || 0;
      x.seg   = x.frac >= 0.999 ? 2 : 1;
    }
    // A destination still showing the copy phase has been written and is
    // waiting for, or running, its own verification.
    c.dests.forEach((y,i) => { if(i !== di && y.phase === 'copy'){ y.phase='copied'; y.frac=1; } });
  }

  // In a retry the destinations are redone one after the other, so the card
  // figure is how far through its OWN destinations it is — otherwise the card
  // bar would drop back to zero every time the next destination starts.
  if(S.tf.retry){
    const per = (S.tf.hasV1 ? 2 : 1) + (S.tf.hasV2 ? 1 : 0);
    const dn  = c.dests.length || 1;
    let f = c.dests.reduce((a,x)=>a + Math.min(1, ((x.seg||0) + (x.seg>=2?0:x.frac))/per), 0) / dn;
    // Destinations are redone one at a time, and the card-level source pass
    // touches none of their segments, so the raw figure can dip when the next
    // destination starts. A progress figure that goes backwards is read as a
    // fault; hold the high-water mark instead.
    f = Math.max(0, Math.min(1, f));
    c._hi = Math.max(c._hi || 0, f);
    c.frac = c._hi;
  }

  // Speed, smoothed PER PHASE. Copying and verifying do not run at the same
  // rate — on a network destination the verify is often half the copy — so a
  // single average would make the estimate jump every time the phase changes.
  { const k = d.phase === 'copy' ? 'copy' : (d.pass === 'source' ? 'source' : 'dest');
    const v = d.speed || 0;
    if(v > 0) S.spd[k] = S.spd[k] ? S.spd[k]*0.7 + v*0.3 : v; }
  S.tfSpd = S.tfSpd ? S.tfSpd*0.7 + (d.speed||0)*0.3 : (d.speed||0);
  tfPaint();
}

// How far this card is through ITS OWN work, every segment counted: the copy,
// one verification per destination, and the source re-read when PRO has it on.
//
// This is the figure in the card's ring. The BAR underneath keeps showing the
// phase in progress — that is what its colour names — because the two answer
// different questions: the bar says "what is happening", the ring says "where
// is this card". A ring that repeated the bar would display 16% on a card
// with only its source re-read left to do.
//
// Same arithmetic as the queue ring below, deliberately: the card figures and
// the queue figure can never drift apart.
function tfCardDone(c){
  if(!S.tf) return 0;
  // A retry's c.frac already spans that card's whole job.
  if(S.tf.retry) return Math.max(0, Math.min(1, c.frac || 0));
  const { nD, hasV1, segs } = S.tf;
  if(c.phase === 'queued') return 0;
  if(c.phase === 'done' || c.phase === 'err') return 1;
  let d = 0;
  if(c.phase === 'copy')        d = c.frac;
  else if(c.phase === 'verify') d = 1 + nD * c.frac;
  else if(c.phase === 'source') d = 1 + (hasV1 ? nD : 0) + c.frac;
  return segs > 0 ? Math.max(0, Math.min(1, d / segs)) : 0;
}

// Queue progress, weighted by BYTES over every segment of work: one copy per
// card, one verify per destination, plus the source re-read when it is on.
// Weighting cards equally would make a 2 GB card finishing look like as much
// work as a 30 GB card still queued.
function tfGlobal(){
  if(!S.tf) return { frac:0, phase:'copy', left:0, bytes:0, eta:0 };
  const { nD, hasV1, hasV2, segs, cards } = S.tf;

  // Work left is counted SEPARATELY for each kind of segment, because they do
  // not run at the same speed. One average across copying and verifying would
  // make the estimate lurch at every phase change; splitting it means the
  // figure settles after the first card and stays put.
  if(S.tf.retry){
    // c.frac already covers this card's whole retry (copy + verify, every
    // destination), so the queue is simply the weighted average of the cards.
    let t = 0, dn = 0, cur = 'copy', left = 0;
    for(const c of cards){
      const w = c.w || 1; t += w;
      if(c.phase === 'queued'){ left++; continue; }
      if(c.phase !== 'done' && c.phase !== 'err') cur = c.phase;
      dn += w * tfCardDone(c);
    }
    // No ETA on a retry: the list carries file names, not sizes, so any time
    // estimate would be invented rather than measured.
    return { frac: t > 0 ? Math.max(0, Math.min(1, dn/t)) : 0,
             phase: cur, left, bytes: 0, eta: 0,
             files: cards.reduce((a,c)=>a+(c.files||0), 0) };
  }

  let total = 0, done = 0, cur = 'copy', left = 0, bytes = 0;
  let remCopy = 0, remDest = 0, remSrc = 0;
  for(const c of cards){
    const w = c.w || 1;
    const dw = hasV1 ? w * nD : 0;      // all the destination verifies
    const sw = hasV2 ? w : 0;           // the source re-read
    total += w * segs;
    bytes += c.bytes || 0;
    if(c.phase === 'queued'){ left++; remCopy += w; remDest += dw; remSrc += sw; continue; }
    // One definition of "done" for this card, shared with its own ring.
    done += w * segs * tfCardDone(c);
    if(c.phase === 'done' || c.phase === 'err') continue;
    cur = c.phase;
    if(c.phase === 'copy'){
      remCopy += w * (1 - c.frac); remDest += dw; remSrc += sw;
    } else if(c.phase === 'verify'){
      // c.frac is the destination pass as a whole, so it already spans the nD
      // verify segments — no per-destination bookkeeping to add on top.
      remDest += dw * (1 - c.frac); remSrc += sw;
    } else if(c.phase === 'source'){
      remSrc += sw * (1 - c.frac);
    }
  }
  const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;

  // A phase never seen yet borrows the closest speed we do have, so the very
  // first estimate is approximate rather than absent — and corrects itself as
  // soon as that phase actually starts.
  const sp = S.spd || {};
  const any = sp.copy || sp.dest || sp.source || S.tfSpd || 0;
  const vCopy = sp.copy || any, vDest = sp.dest || sp.copy || any, vSrc = sp.source || sp.dest || sp.copy || any;
  let eta = 0;
  if(any > 0){
    if(vCopy > 0) eta += remCopy / vCopy;
    if(vDest > 0) eta += remDest / vDest;
    if(vSrc  > 0) eta += remSrc  / vSrc;
  }
  return { frac, phase: cur, left, bytes, eta };
}

function tfBar(phase, frac, thin){
  return `<div class="tf-bar${thin?' thin':''}"><i style="width:${(frac*100).toFixed(1)}%;`
       + `background:${TF_COL[phase]||'transparent'}"></i></div>`;
}

// Per-card ring. The bar underneath says WHICH phase by its colour; the ring
// says HOW FAR, as a figure — the number the operator actually asks for.
const TF_CR = 14, TF_CC = 2*Math.PI*TF_CR;    // radius / circumference
// A full ring shows a tick rather than "100%" — the figure has served its
// purpose by then, and the mark reads from further away.
const TF_TICK = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none"`
  + ` stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`
  + ` style="display:block"><path d="M20 6 9 17l-5-5"/></svg>`;
// …but ONLY when the card is genuinely clean. A card that reported errors has
// also reached the end of its work, and a green tick over it would be the one
// lie this application cannot afford: its figure stays 100%, in red.
function tfDoneClean(c){ return !c.errors && c.phase !== 'err'; }
function tfRingInner(frac, clean, px){
  return (frac >= 0.999 && clean) ? TF_TICK(px) : Math.round(frac*100)+'%';
}
function tfCardRing(i, phase, frac, clean){
  const col = TF_COL[phase] && TF_COL[phase] !== 'transparent' ? TF_COL[phase] : 'var(--text3)';
  return `<div class="tf-cring">
    <svg width="34" height="34" viewBox="0 0 34 34">
      <circle cx="17" cy="17" r="${TF_CR}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3.5"/>
      <circle cx="17" cy="17" r="${TF_CR}" fill="none" stroke="${col}" stroke-width="3.5"
        stroke-linecap="round" stroke-dasharray="${TF_CC.toFixed(2)}"
        stroke-dashoffset="${(TF_CC*(1-frac)).toFixed(2)}" id="tfcring-${i}"/>
    </svg>
    <div class="cp" id="tfcpct-${i}" style="color:${col}">${tfRingInner(frac, clean, 15)}</div>
  </div>`;
}

// Full rebuild, only when the structure or a phase actually changed — the
// in-between updates just move the bars, so the list never flickers.
function tfRender(){
  const list = document.getElementById('tf-list');
  if(!list || !S.tf) return;
  const multi = S.tf.multi;
  // The frozen run, never the live selector: the mode can be changed between
  // the summary and a retry, which would relabel merely-copied files as VERIFIED.
  const verifies = S.tf.hasV1;
  // A finished card says what was checked: NORMAL compares sizes and must not
  // read "VERIFIED ✓" like a SECURE one.
  const doneLbl = !verifies ? TF_LBL.doneFast : S.tf.sizeOnly ? TF_LBL.doneNormal : TF_LBL.done;

  list.innerHTML = S.tf.cards.map((c,i) => {
    const chip = c.phase === 'done' ? doneLbl : TF_LBL[c.phase];
    const plur = (n,w) => `${n} ${w}${n>1?'s':''}`;
    const sub  = [ c.files ? plur(c.files,'file') : '', c.bytes ? fmtSize(c.bytes) : '' ]
                   .filter(Boolean).join(' · ');
    const meta = c.phase === 'queued' ? 'waiting'
               : c.phase === 'done'   ? 'complete'
               : `${fmtSpd(c.speed)}`;
    const dst0 = c.dests[0];

    const ring = tfCardRing(i, c.phase, tfCardDone(c), tfDoneClean(c));

    const head = multi
      ? `<div class="tf-hd">${ring}<span class="tf-nm">${esc(c.name)}</span>
           <span class="tf-sub">${sub}${sub?' · ':''}${plur(c.dests.length,'destination')}</span>
           <span class="tf-chip ${c.phase}" id="tfchip-${i}">${chip}</span></div>`
      : `<div class="tf-hd">${ring}<span class="tf-nm">${esc(c.name)}</span><span class="tf-arrow">→</span>
           <span class="tf-nm">${esc(dst0 ? dst0.name : '-')}</span>
           ${dst0 && dst0.net ? '<span class="tf-net">NETWORK</span>' : ''}
           <span class="tf-chip ${c.phase}" id="tfchip-${i}">${chip}</span></div>`;

    const kids = multi ? `<div class="tf-kids">` + c.dests.map((x,j) => `
        <div class="tf-kid">
          <div class="tf-hd" style="margin-bottom:5px;"><span class="tf-dot"></span>
            <span class="tf-nm" style="font-size:12.5px;">${esc(x.name)}</span>
            ${x.net ? '<span class="tf-net">NETWORK</span>' : ''}
            <span class="tf-kspd" id="tfdspd-${i}-${j}">${x.speed>0?fmtSpd(x.speed):''}</span>
            <span class="tf-chip ${x.phase}" id="tfdchip-${i}-${j}">${
              x.phase==='done' ? doneLbl : TF_LBL[x.phase]}</span>
            <span class="tf-kpct" id="tfdpct-${i}-${j}"
              style="color:${TF_COL[x.phase]&&TF_COL[x.phase]!=='transparent'?TF_COL[x.phase]:'var(--text3)'}"
              >${Math.round(x.frac*100)}%</span></div>
          <div id="tfdbar-${i}-${j}">${tfBar(x.phase, x.frac, true)}</div>
        </div>`).join('') + `</div>` : '';

    return `<div class="tf-card ${multi?'multi ':''}${c.phase==='queued'?'queued':c.phase==='done'?'done':''}" id="tfc-${i}">
      ${head}
      <div id="tfbar-${i}">${tfBar(c.phase, c.frac)}</div>
      <div class="tf-ft"><span class="tf-file" id="tffile-${i}">${esc(c.file)}</span>
        <span class="tf-meta" id="tfmeta-${i}">${meta}</span></div>
      ${kids}
    </div>`;
  }).join('');
}

// Cheap path: move the bars and refresh the labels, no DOM rebuild.
function tfPaint(){
  if(!S.tf) return;
  const sig = S.tf.cards.map(c => c.phase + '/' + c.dests.map(x=>x.phase).join(',') + '/' + c.files).join('|');
  if(sig !== S._tfSig){ S._tfSig = sig; tfRender(); }
  else {
    S.tf.cards.forEach((c,i) => {
      const b = document.querySelector(`#tfbar-${i} i`);
      if(b) b.style.width = (c.frac*100).toFixed(1)+'%';
      const f = document.getElementById(`tffile-${i}`);
      if(f) f.textContent = c.file;
      const m = document.getElementById(`tfmeta-${i}`);
      if(m && c.phase!=='queued' && c.phase!=='done') m.textContent = fmtSpd(c.speed);
      const cd = tfCardDone(c);
      const cr = document.getElementById(`tfcring-${i}`);
      if(cr) cr.setAttribute('stroke-dashoffset', (TF_CC*(1-cd)).toFixed(2));
      const cp = document.getElementById(`tfcpct-${i}`);
      // innerHTML only when the tick has to appear or disappear; the rest of
      // the time this runs several times a second on every card.
      if(cp){
        const want = tfRingInner(cd, tfDoneClean(c), 15);
        if(cp.innerHTML !== want) cp.innerHTML = want;
      }
      c.dests.forEach((x,j) => {
        const k = document.querySelector(`#tfdbar-${i}-${j} i`);
        if(k) k.style.width = (x.frac*100).toFixed(1)+'%';
        const kp = document.getElementById(`tfdpct-${i}-${j}`);
        if(kp) kp.textContent = Math.round(x.frac*100)+'%';
        const ks = document.getElementById(`tfdspd-${i}-${j}`);
        if(ks) ks.textContent = x.speed>0 ? fmtSpd(x.speed) : '';
      });
    });
  }

  // The heading carries the total number of cards in this ingest — a figure
  // fixed at START, not a countdown; "left" is on the line underneath.
  const ttl = document.getElementById('tf-ring-title');
  if(ttl) ttl.textContent = `${S.tf.retry ? 'RETRY QUEUE' : 'INGEST QUEUE'} (${S.tf.cards.length})`;

  const g = tfGlobal();
  const arc = document.getElementById('tf-ring-arc');
  const pct = document.getElementById('tf-ring-pct');
  const lbl = document.getElementById('tf-ring-lbl');
  if(arc){
    const C = 2*Math.PI*26;
    arc.setAttribute('stroke-dasharray', C.toFixed(2));
    arc.setAttribute('stroke-dashoffset', (C*(1-g.frac)).toFixed(2));
    arc.style.stroke = TF_COL[g.phase] || 'var(--green)';
  }
  if(pct){
    // The queue tick waits for every card to be clean — one card in error and
    // the figure stays a figure.
    const clean = S.tf.cards.every(c => tfDoneClean(c));
    const want = tfRingInner(g.frac, clean, 26);
    if(pct.innerHTML !== want) pct.innerHTML = want;
    pct.style.color = TF_COL[g.phase] || 'var(--green)';
  }
  if(lbl){
    // Each figure says what it is. The volume is the size of the WHOLE job;
    // sitting unlabelled between "2 cards left" and the time remaining, it would
    // read as "245 GB still to go".
    const bits = [];
    if(g.left > 0) bits.push(`${g.left} card${g.left>1?'s':''} left`);
    if(g.files > 0) bits.push(`${g.files} file${g.files>1?'s':''} total`);
    if(g.bytes > 0) bits.push(fmtSize(g.bytes)+' total');
    if(g.eta > 0) bits.push('~'+fmtEta(g.eta)+' left');
    lbl.textContent = bits.join(' · ') || '-';
  }
}

// TRANSFERS | VOLUMES. The volumes stay one click away during an ingest —
// handy when another drive has to be ejected mid-copy.
