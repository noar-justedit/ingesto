// ═══════════════════════════════════════════════════════
// Counter
// ═══════════════════════════════════════════════════════

function renderCounter(){
  const inp   = document.getElementById('counter-input');
  const autoBtn = document.getElementById('counter-auto-btn');
  if(!inp) return;
  // Written the way it will appear in the folder name. Not while the field has
  // focus: re-padding on every keystroke fights whoever is typing in it.
  if(document.activeElement !== inp) inp.value = padCounter(S.counter);
  if(S.counterOverride){
    inp.className = 'counter-val overridden';
    if(autoBtn) autoBtn.setAttribute('data-tip','Manual override. Click to go back to auto');
  } else {
    inp.className = 'counter-val';
    if(autoBtn) autoBtn.setAttribute('data-tip','Rescans the destination and picks the next free number');
  }
  renderCounterWidth();   // the three samples show the counter in hand
  refreshCardPreviews();
}

// The three choices show the CURRENT counter written each way, so the setting
// is read by looking at it rather than by reading a label: 07 / 007 / 0007.
function renderCounterWidth(){
  const box = document.getElementById('counter-pad');
  if(!box) return;
  for(const b of box.querySelectorAll('.cpad')){
    const w = Number(b.dataset.w);
    b.textContent = padCounter(S.counter||1, w);
    b.classList.toggle('on', w === S.counterWidth);
  }
}
function setCounterWidth(w){
  if(!COUNTER_WIDTHS.includes(w)) return;
  S.counterWidth = w;
  renderCounter(); updatePreview(); refreshCardPreviews();
  persistPrefs();
}

function stepCounter(delta){
  const v = Math.min(COUNTER_MAX, Math.max(1, (S.counter||1) + delta));
  S.counter = v;
  S.counterOverride = true;
  renderCounter();
  updatePreview();
  persistPrefs();
}

function onCounterInput(){
  const inp = document.getElementById('counter-input');
  const v = parseInt(inp.value, 10);
  if(!isNaN(v) && v >= 1 && v <= COUNTER_MAX){
    S.counter = v;
    S.counterOverride = true;
    renderCounter();
    updatePreview();
    persistPrefs();
  }
}

function resetCounterOverride(){
  // Without a destination there is nothing to scan: say so, rather than doing
  // nothing at all while the tooltip promises a rescan.
  if(!S.dests.length){
    showToast('Add a destination first: the next free number is read from the drive.','info',4000);
    return;
  }
  // Pass true → scanCounter will force-apply the scanned value
  scanCounter(true);
}

// applyResult=true → always update counter value (used by Auto button)
// applyResult=false → only update if not overridden (background auto-scan)
async function scanCounter(applyResult=false){
  try {
    if(!S.dests.length){
      const info    = document.getElementById('counter-max-info');
      const autoBtn = document.getElementById('counter-auto-btn');
      if(info)  info.textContent = '';
      if(autoBtn && !S.counterOverride){
        autoBtn.setAttribute('data-tip','Add a destination so ingesto can scan for the next free number');
      }
      return;
    }

    const {next, max} = await window.ingesto.scanDestCounterFull(S.dests.map(d=>d.path), buildTplStr());
    S.counterMax = max;

    // Apply the value if: explicitly requested OR not overridden
    if(applyResult || !S.counterOverride){
      S.counter = next;
      S.counterOverride = false;  // back to auto
      renderCounter();
      updatePreview();
      persistPrefs();
    }

    // Update info displays
    const info    = document.getElementById('counter-max-info');
    const autoBtn = document.getElementById('counter-auto-btn');

    if(info) info.textContent = max > 0 ? `last: ${padCounter(max)}` : '';

    if(autoBtn){
      if(S.counterOverride){
        // Still in override — show what auto would give
        autoBtn.setAttribute('data-tip', `Manual override. Auto would give ${padCounter(next)}`);
      } else {
        autoBtn.setAttribute('data-tip', max > 0
          ? `Last: ${padCounter(max)} → next: ${padCounter(next)}`
          : 'No existing copies in destination, starting at ' + padCounter(next));
      }
    }
  } catch(e){
    console.error('scanCounter:', e);
  }
}
