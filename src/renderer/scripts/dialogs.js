// ═══════════════════════════════════════════════════════
// Counter warning
// ═══════════════════════════════════════════════════════
// ─── Unformatted-card dialog (sentinel) ────────────────
// Builds and shows a modal explaining that a previously-ingested card
// has been re-inserted, and lets the user choose what to copy.
function showUnformattedCardDialog(entry, info) {
  // Avoid duplicate dialogs
  const existing = document.getElementById('unformatted-ov');
  if (existing) existing.remove();

  const ov = document.createElement('div');
  ov.id = 'unformatted-ov';
  ov.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);
    z-index:2300;display:flex;align-items:center;justify-content:center;
  `;
  // Format date in user-friendly form
  let dateStr = '-';
  try {
    const d = new Date(info.lastIngest.date);
    // The same DD.MM.YYYY HH:MM as the history and the report.
    if (!isNaN(d)) dateStr = fmtReportDate(d.toISOString());
  } catch(_) {}
  // Destination folder display (basename only, with full path on hover)
  const destFull = info.lastIngest.destination || '-';
  const destBase = destFull.split(/[/\\]/).pop() || destFull;

  // The full list, folded. Open, it would make the window 640 px tall for
  // information nobody reads before deciding.
  const already = (info.alreadyIngestedPreview || []);
  const fullItems = already.map(f => {
    const base = f.p.split('/').pop();
    const sizeMB = (f.s / 1e6).toFixed(1);   // decimal, like fmtSize and the Finder
    return `<div class="ufc-fitem">${esc(base)} <span class="ufc-fsize">${sizeMB} MB</span></div>`;
  }).join('') || '<div class="ufc-fitem">The list could not be read back from the card.</div>';
  S._ufcList = already.map(f => f.p).join('\n');

  const nTotal = info.counts.total;
  const nOld   = info.counts.alreadyIngested;
  // Green next to orange, the same code as the ingest queue: orange = passed
  // over, green = copied. This is the number the operator is actually after.
  const nNew   = Math.max(0, nTotal - nOld);

  ov.innerHTML = `
    <div class="sum-card" style="width:540px;">
      <div class="sum-hd">
        <div class="sum-ico cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        </div>
        <div style="min-width:0">
          <div class="sum-h1 t-warn">CARD HAS NOT BEEN&nbsp;FORMATTED</div>
          <div class="sum-h2" style="font-family:var(--font)">This card was previously ingested by ingesto
          and has not been formatted&nbsp;since.</div>
        </div>
      </div>
      <div class="sum-grid" style="grid-template-columns:repeat(2,1fr)">
        <div class="srow">
          <div class="sr-lbl">Card</div>
          <div class="sr-val">${esc(entry.name || '')}</div>
        </div>
        <div class="srow">
          <div class="sr-lbl">Last ingest</div>
          <div class="sr-val" style="font-size:14px">${esc(dateStr)}</div>
        </div>
      </div>
      <div class="sum-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="srow">
          <div class="sr-lbl">Total on card</div>
          <div class="sr-val">${nTotal}</div>
        </div>
        <div class="srow">
          <div class="sr-lbl">Already ingested</div>
          <div class="sr-val" style="color:var(--orange)">${nOld}</div>
        </div>
        <div class="srow">
          <div class="sr-lbl">New files</div>
          <div class="sr-val" style="color:var(--green)">${nNew}</div>
        </div>
      </div>
      <div class="sc" style="margin-bottom:12px">
        <div class="sc-row">
          <div class="sc-open clk" data-js="ufc-toggle">
            <span class="sc-caret" id="ufc-car">&#9656;</span>
            <span class="sc-name" style="font-family:var(--font);font-size:13px">DETAILS</span>
            <span class="sc-count">${nOld} already ingested</span>
          </div>
          <button class="mini-btn" id="ufc-copy">COPY LIST</button>
        </div>
        <div class="sc-dests" id="ufc-full" style="display:none">
          <div class="sc-dest" style="display:block;padding-bottom:2px">
            <div class="sr-lbl">Previous destination</div>
            <div class="sc-path" style="margin-top:2px" title="${esc(destFull)}">${esc(destFull)}</div>
          </div>
          <div class="ufc-flist">${fullItems}</div>
        </div>
      </div>
      <div class="ufc-actions">
        <button id="ufc-skip" class="ufc-abtn ufc-abtn-primary">
          <div class="ufc-abtn-title">COPY NEW FILES</div>
        </button>
        <button id="ufc-all" class="ufc-abtn ufc-abtn-secondary">
          <div class="ufc-abtn-title">COPY FULL CARD</div>
        </button>
        <button id="ufc-cancel" class="ufc-abtn ufc-abtn-cancel">
          <div class="ufc-abtn-title">CANCEL</div>
        </button>
      </div>
      <div class="ufc-caveat">A file is skipped only when every destination you selected
      already holds a verified copy of&nbsp;it.</div>
    </div>
  `;
  document.body.appendChild(ov);

  // Wire buttons
  ov.querySelector('[data-js="ufc-toggle"]').onclick = () => ufcToggleAll();
  document.getElementById('ufc-copy').onclick = () => ufcCopyList();
  // The choice is an INTENT, resolved at Start against the destinations
  // selected THEN. Fixing the list here would trust the card's whole history: a
  // file ingested yesterday to drive A would be skipped today for drive B,
  // which has never seen it — 2 clips out of 14 landed, "Transfer Complete".
  document.getElementById('ufc-skip').onclick = () => {
    entry._skipIntent = true; entry._skipKeys = [];
    ov.remove();
    showToast(`Files already verified on the selected destination(s) will be skipped for "${entry.name}", decided at Start, from the drives you choose.`, 'info', 6000);
  };
  document.getElementById('ufc-all').onclick = () => {
    entry._skipIntent = false; entry._skipKeys = [];
    ov.remove();
    showToast(`Will copy all ${info.counts.total} file${info.counts.total===1?'':'s'} on "${entry.name}".`, 'info');
  };
  document.getElementById('ufc-cancel').onclick = () => {
    removeFromZone('src', entry.path);
    ov.remove();
  };
}

// DETAILS is folded by default: the window is about 470 px tall instead of 640.
function ufcToggleAll() {
  const full = document.getElementById('ufc-full');
  const car  = document.getElementById('ufc-car');
  if (!full) return;
  const open = full.style.display === 'none';
  full.style.display = open ? '' : 'none';
  if (car) car.classList.toggle('open', open);
}
// The operator who wants to check a list wants it in a text editor, not in a
// 470 px window.
async function ufcCopyList() {
  const btn = document.getElementById('ufc-copy');
  try { await navigator.clipboard.writeText(S._ufcList || ''); }
  catch (_) { if (btn) { btn.textContent = 'COPY FAILED'; } return; }
  if (btn) { btn.textContent = 'COPIED'; btn.classList.add('done'); }
}

// ─── Toast notification ────────────────────────────────
function showToast(msg, type='info', duration=4000){
  let t = document.getElementById('ingesto-toast');
  if(!t){
    t = document.createElement('div');
    t.id = 'ingesto-toast';
    t.style.cssText = `
      position:fixed;bottom:70px;left:50%;transform:translateX(-50%);
      background:var(--bg3);border:1px solid var(--border2);
      border-radius:var(--rs);padding:10px 16px;font-size:15px;
      max-width:380px;text-align:center;line-height:1.5;
      box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:5000;
      transition:opacity .3s;pointer-events:none;white-space:pre-line;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  const color = type==='error' ? 'rgba(242,85,90,.4)'
              : type==='warn'  ? 'rgba(242,160,61,.4)'
              : 'var(--border2)';
  const textCol = type==='error' ? 'var(--red)'
                : type==='warn'  ? 'var(--orange)'
                : 'var(--text)';
  t.style.borderColor = color;
  t.style.color = textCol;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>{ t.style.opacity='0'; }, duration);
}
