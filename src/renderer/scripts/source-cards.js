// ═══════════════════════════════════════════════════════
// Per-source info cards
// ═══════════════════════════════════════════════════════
function updateCopyInfoVisibility(){
  const globalSec = document.getElementById('global-meta-sec');
  const globalTitle = document.getElementById('copy-info-title');
  const srcTitle  = document.getElementById('src-info-title');
  if(!globalSec) return;
  if(S.sources.length === 0){
    // No cards: show global defaults, hide per-card section
    globalSec.style.display = '';
    if(globalTitle) globalTitle.style.display = '';
    if(srcTitle) srcTitle.style.display = 'none';
  } else {
    // Cards loaded: hide global (already pre-filled into cards), show per-card
    globalSec.style.display = 'none';
    if(globalTitle) globalTitle.style.display = 'none';
    if(srcTitle) srcTitle.style.display = '';
  }
}

function renderSourceInfoCards(){
  const list  = document.getElementById('src-info-list');
  const title = document.getElementById('src-info-title');
  if(!list) return;

  updateCopyInfoVisibility();

  if(S.sources.length === 0){
    list.innerHTML = '';
    updatePreview();
    return;
  }

  // Single source: expand by default; multiple: collapsed by default
  list.innerHTML = S.sources.map((src, i) => {
    const isOpen  = S.sources.length === 1 || src._open;
    const op      = src.operator || '';
    const cam     = src.camera   || '';
    const pp      = src.pp       || '';
    const note    = src.note     || '';
    return `<div class="src-info-card${isOpen ? ' open' : ''}" id="sic-${i}">
      <div class="src-info-header" role="button" tabindex="0"
        aria-expanded="${isOpen ? 'true' : 'false'}"
        aria-label="${esc(src.name)}, ${isOpen ? 'collapse' : 'expand'} this card">
        <span class="src-info-chevron">▶</span>
        <span class="sic-num">SRC${i+1}</span>
        <div class="src-info-icon">${getZoneIcon('src')}</div>
        <span class="src-info-name">${esc(src.name)}</span>
        <button class="sic-rm" aria-label="Remove card ${esc(src.name)}" title="Remove card">×</button>
      </div>
      <div class="sic-sub">
        <div class="sic-preview" id="sicprev-${i}">${esc(previewForSource(src,i))}</div>
      </div>
      <div class="src-info-body">
        <div class="sif-grid row3">
          <div>
            <div class="sif-label">OPERATOR</div>
            <input class="sif-input" type="text" value="${esc(op)}" data-opcb data-js="operator"
              aria-label="Operator of card ${esc(src.name)}"
              placeholder="Operator">
          </div>
          <div>
            <div class="sif-label">CAMERA${srcMark(src,'camera')}</div>
            <input class="sif-input" type="text" value="${esc(cam)}" data-js="camera"
              aria-label="Camera of card ${esc(src.name)}"
              placeholder="Camera">
          </div>
          <div>
            <div class="sif-label">PROFILE</div>
            <input class="sif-input" type="text" value="${esc(pp)}" data-pp data-js="pp"
              aria-label="Picture profile of card ${esc(src.name)}">
          </div>
        </div>
        <div>
          <textarea class="sif-textarea" data-mdn data-mdn-label="NOTES" data-mdn-lc="sif-label" data-i="${i}"
            aria-label="Notes for card ${esc(src.name)}"
            placeholder="Shooting notes, lens info, location…">${esc(note)}</textarea>
        </div>
      </div>
    </div>`;
  }).join('');
  // The handlers, before fieldsInit adds its own to the same fields.
  list.querySelectorAll('.src-info-card').forEach((card, i) => {
    const head = card.querySelector('.src-info-header');
    head.onkeydown = function(event){ if(event.key==='Enter'||event.key===' '){ event.preventDefault(); toggleSIC(i); } };
    head.onclick = function(){ toggleSIC(i); };
    card.querySelector('.sic-rm').onclick = function(event){ event.stopPropagation(); removeZoneAt('src', i); };
    card.querySelector('[data-js="operator"]').oninput = function(){ sanitizeMeta(this); updateSrcField(i, 'operator', this.value); };
    card.querySelector('[data-js="camera"]').oninput = function(){ sanitizeMeta(this); markForced(i, 'camera'); updateSrcField(i, 'camera', this.value); };
    card.querySelector('[data-js="pp"]').oninput = function(){ sanitizePP(this); updateSrcField(i, 'pp', this.value); };
    card.querySelector('textarea.sif-textarea').oninput = function(){ updateSrcField(i, 'note', this.value); };
  });
  fieldsInit(list);
  updatePreview();
  applyIngestLock();   // the cards are rebuilt at START — bring the lock back
}

function toggleSIC(i){
  S.sources[i]._open = !S.sources[i]._open;
  const card = document.getElementById(`sic-${i}`);
  if(card) card.classList.toggle('open', S.sources[i]._open);
}

// Which global field carries the default of each card field. What is typed on
// a card is "the last entered value", and the next card starts from it.
const SRC_DEFAULT_FIELD = { operator:'meta-cam', camera:'meta-model', pp:'meta-pp' };
function updateSrcField(i, field, value){
  if(S.sources[i]){
    S.sources[i][field] = value;
    S.sources[i]._customised = true; // user has manually edited this card
    const gid = SRC_DEFAULT_FIELD[field];
    if(gid){ const g = document.getElementById(gid); if(g){ g.value = value; persistPrefs(); } }
    if(field==='operator'||field==='camera'||field==='pp') updatePreview(); // also refreshes the top box + all per-card previews
  }
}

// The broom: Operator, Camera, Picture profile and Notes emptied in one click,
// on the defaults and on every loaded card. Refused during an ingest, like
// every other field (the run already holds its own copy of them).
function clearCopyInfo(){
  if(S.copying || S._starting) return;
  ['meta-cam','meta-model','meta-pp','meta-note'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  S.sources.forEach(src => {
    src.operator = ''; src.camera = ''; src.pp = ''; src.note = '';
    src._customised = false; src._camDetected = false;
    if(src._forced) src._forced.camera = false;
  });
  persistPrefs();
  renderSourceInfoCards();
  try{ updatePreview(); }catch(_){}
  showToast('Operator, camera, picture profile and notes cleared.');
}
function syncDefaultsToSources(){
  // When global defaults change, push to ALL sources (they can override individually)
  const op   = document.getElementById('meta-cam')?.value   || '';
  const cam  = document.getElementById('meta-model')?.value || '';
  const pp   = document.getElementById('meta-pp')?.value    || '';
  const note = document.getElementById('meta-note')?.value  || '';
  S.sources.forEach(src => {
    if(!src._customised){
      src.operator = op;
      src.camera   = cam;
      src.pp       = pp;
      src.note     = note;
    }
  });
  renderSourceInfoCards();
}
