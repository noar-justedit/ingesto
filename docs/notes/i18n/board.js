// Builds the data of the translation review board: every screen of the app
// in the language asked for, captured, with each translated text located on
// the capture, plus what stayed in English. Nothing here changes the app.
//
//   NODE_PATH=<playwright> node docs/notes/i18n/board.js fr <out folder>
//
// Writes <out>/screens/*.png and <out>/board.json:
//   screens   [{ id, title, img, w, h, items:[{key, kind, en, tr, x, y, w, h}],
//                english:[{text, x, y, w, h}] }]
//   entries   every dictionary entry: { key, section, kind, tr, seen:[screen ids] }
// A text still in English on a screen is a translation to add (or a name
// that should be on the list of things never translated).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { open, wait, ROOT, VOLS } = require('./page');

const LANG = process.argv[2] || 'fr';
const OUT = path.resolve(process.argv[3] || path.join(require('os').tmpdir(), 'ingesto-board'));
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });

// ── Demo data ────────────────────────────────────────────────────────────
const NOTE_DEMO = '### Day 1\n**Interviews**, room B\n- [x] Sound checked\n- [ ] Copy card B';
const DEST_PREFS = { destPaths: [{ path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' }, { path: '/Volumes/NAS_BACKUP', name: 'NAS_BACKUP' }] };
async function loadCardDest(p, cards = ['A001'], dsts = ['RAID_SHOOT', 'NAS_BACKUP']) {
  await p.evaluate(({ cards, dsts }) => {
    for (const c of cards) addToZone('src', { path: '/Volumes/' + c, name: c });
    for (const d of dsts) addToZone('dst', { path: '/Volumes/' + d, name: d });
  }, { cards, dsts });
  await wait(p, 1500);
}
async function typeNote(p) {
  await p.evaluate((NOTE) => { const n = document.querySelector('#src-info-list textarea'); if (n) { n.value = NOTE; n.dispatchEvent(new Event('input', { bubbles: true })); } }, NOTE_DEMO);
}
const R_OK = (dst, over = {}) => Object.assign({ success: true, canceled: false, sourceName: 'A001', sourcePath: '/Volumes/A001',
  destPath: `/Volumes/${dst}/004_A001_ALEX_FX6_261001_1214`, relFolder: '004_A001_ALEX_FX6_261001_1214',
  totalFiles: 168, copiedFiles: 168, totalBytes: 26.4e9, copiedBytes: 26.4e9, errors: 0, errorList: [], failedFiles: [],
  unstableFiles: [], notes: [], mode: 'slow', coldVerify: true, copyMs: 412000, verify1Ms: 251000, verify2Ms: 0, duration: 663000 }, over);
const refusal = (code, data) => [{ success: false, refused: true, refusalCode: code, refusalData: data, sourceName: 'A001', errorList: [] }];

async function running(p, phase) {
  await loadCardDest(p, ['A001', 'A002']);
  await p.evaluate(() => { startCopy(); });
  await wait(p, 1200);
  await p.evaluate((phase) => {
    const base = { sourceName: 'A001', sourcePath: '/Volumes/A001', totalFiles: 168, totalBytes: 26.4e9, errors: 0 };
    if (phase === 'copy') {
      window.__cb.onCopyProgress({ ...base, phase: 'copy', currentFile: 'XDROOT/Clip/A001C014.MXF', copiedFiles: 71, remainingFiles: 97, copiedBytes: 11.2e9, progress: 0.42, speed: 412e6, eta: 38 });
    } else {
      window.__cb.onCopyProgress({ ...base, phase: 'copy', copiedFiles: 168, remainingFiles: 0, copiedBytes: 26.4e9, progress: 1, speed: 420e6, eta: 0 });
      for (const [i, n, dp, sp] of [[0, 'RAID_SHOOT', 0.71, 610e6], [1, 'NAS_BACKUP', 0.38, 112e6]])
        window.__cb.onCopyProgress({ ...base, phase: 'verify', pass: 'dest', destIndex: i, destName: n, currentFile: 'XDROOT/Clip/A001C102.MXF', copiedFiles: 168, remainingFiles: 70, copiedBytes: 26.4e9, progress: 0.55, passProgress: 0.55, destProgress: dp, destSpeed: sp, speed: 720e6, eta: 52 });
    }
  }, phase);
  await wait(p, 600);
}

// ── Screens. crop: the element captured (default: the whole window). ─────
// Titles are in French: the board is for the person who reviews.
const SCREENS = [
  { id: 'main-empty', title: 'Fenêtre principale, au premier lancement', run: async p => {} },
  { id: 'main-ready', title: 'Fenêtre principale, une carte et deux destinations chargées', run: async p => { await loadCardDest(p); await typeNote(p); } },
  { id: 'vol-menu', title: 'Clic droit sur un volume', run: async p => {
      const box = await p.locator('.vc').first().boundingBox();
      await p.evaluate(({ x, y }) => winVolMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, '/Volumes/A001'), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }, crop: '#vol-ctx, .vol-ctx, #ctx-vol' },
  { id: 'new-drive', title: 'Nouveau disque détecté', run: async p => { await p.evaluate(() => proposeNewVolumes([window.__vols[1]])); }, crop: '#vol-proposal' },
  { id: 'insert-menu', title: 'Menu Insérer (modèle de dossier)', run: async p => { await loadCardDest(p); await p.click('#ins-btn'); }, crop: '#ins-menu' },
  { id: 'pp-menu', title: 'Menu Profil (profil d\'image)', run: async p => { await loadCardDest(p, ['A001'], ['RAID_SHOOT']); await p.click('#sic-0 .pp-btn'); }, crop: '#pp-menu' },
  { id: 'op-list', title: 'Liste des opérateurs de la session', run: async p => {
      await loadCardDest(p, ['A001'], ['RAID_SHOOT']);
      await p.evaluate(() => rememberOperators(['LEA', 'MARC', 'MARIE', 'ALEX']));
      const op = p.locator('#sic-0 .op-cb input'); await op.fill(''); await op.type('MA');
    }, crop: '#op-list' },
  { id: 'notes-md', title: 'Notes en mode markdown', run: async p => { await loadCardDest(p, ['A001'], ['RAID_SHOOT']); await typeNote(p); await p.click('#sic-0 .mdn-sw button[data-m="md"]'); }, crop: '#sic-0' },
  { id: 'templates-ctx', title: 'Clic droit sur un modèle enregistré', run: async p => {
      await p.evaluate(() => { const el = document.querySelector('.mem-item'); el && el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 600 })); });
    }, crop: '#ctx-menu, .ctx-menu' },
  { id: 'template-save', title: 'Enregistrer un modèle', run: async p => { await p.evaluate(() => { const el = document.querySelector('.mem-item'); el && el.click(); }); await wait(p, 300); await p.evaluate(() => { const o = document.getElementById('sno-ov') || document.querySelector('[id^="sno"]'); }); }, crop: null },
  { id: 'modes-info', title: 'Aide : modes de vérification', run: async p => { await p.evaluate(() => showModesInfo()); }, crop: '#modes-info-ov .mi-card' },
  { id: 'dr-info', title: 'Aide : double lecture de la source', run: async p => { await p.evaluate(() => showDrInfo()); }, crop: '#dr-info-ov .mi-card' },
  { id: 'counter-info', title: 'Aide : compteur', run: async p => { await p.evaluate(() => showCounterInfo()); }, crop: '#counter-info-ov .mi-card' },
  { id: 'pro-warn', title: 'Avertissement avant le mode PRO', prefs: { proWarnDismissed: false }, run: async p => { await p.evaluate(() => { onSelectPro(); }); }, crop: '#pro-warn-ov .mi-card' },
  { id: 'ingest-copy', title: 'Ingest en cours : copie', startNever: true, run: async p => running(p, 'copy') },
  { id: 'ingest-verify', title: 'Ingest en cours : vérification', startNever: true, run: async p => running(p, 'verify') },
  { id: 'summary-ok', title: 'Fin d\'ingest : tout est vérifié', run: async p => { await loadCardDest(p); await p.evaluate(R => showSummary(R), [R_OK('RAID_SHOOT'), R_OK('NAS_BACKUP')]); }, crop: '.sum-card' },
  { id: 'summary-fail', title: 'Fin d\'ingest : fichiers corrompus sur une destination', run: async p => {
      await loadCardDest(p);
      const bad = R_OK('NAS_BACKUP', { success: false, errors: 2, copiedFiles: 166, failedFiles: ['XDROOT/Clip/A001C087.MXF', 'XDROOT/Clip/A001C088.MXF'],
        errorList: [{ file: 'XDROOT/Clip/A001C087.MXF', phase: 'verify', error: 'Checksum mismatch', origin: 'dest' }, { file: 'XDROOT/Clip/A001C088.MXF', phase: 'verify', error: 'Checksum mismatch', origin: 'dest' }] });
      await p.evaluate(R => showSummary(R), [R_OK('RAID_SHOOT'), bad]);
    }, crop: '.sum-card' },
  { id: 'summary-suspect', title: 'Fin d\'ingest : carte suspecte (double lecture)', prefs: { mode: 'pro', proDoubleRead: true }, run: async p => {
      await loadCardDest(p);
      const sus = o => R_OK(o, { mode: 'pro', verify2Ms: 120000, unstableFiles: ['XDROOT/Clip/A001C033.MXF'] });
      await p.evaluate(R => showSummary(R), [sus('RAID_SHOOT'), sus('NAS_BACKUP')]);
    }, crop: '.sum-card' },
  { id: 'summary-write', title: 'Fin d\'ingest : le disque a refusé l\'écriture', run: async p => {
      await loadCardDest(p);
      const bad = R_OK('NAS_BACKUP', { success: false, errors: 1, copiedFiles: 167, failedFiles: ['XDROOT/Clip/A001C090.MXF'],
        errorList: [{ file: 'XDROOT/Clip/A001C090.MXF', phase: 'copy', error: 'ENOSPC: no space left on device', code: 'ENOSPC', origin: 'dest' }] });
      await p.evaluate(R => showSummary(R), [R_OK('RAID_SHOOT'), bad]);
    }, crop: '.sum-card' },
  ...[
    ['PF-E1', 'Refus : la carte serait écrite à la racine', { card: 'A001', dest: 'RAID_SHOOT' }],
    ['PF-E2', 'Refus : la carte partagerait un dossier', { card: 'A001', shared: 'DAY1' }],
    ['PF-E3', 'Refus : un niveau n\'est pas un nom utilisable', { card: 'A001', seg: '..' }],
    ['PF-E4', 'Refus : trop de niveaux de dossiers', { levels: 7, limit: 5 }],
    ['PF-E5', 'Refus : le compteur n\'est pas dans le dossier de la carte', {}],
    ['PF-E6', 'Refus : la destination est la carte elle-même', { card: 'A001', destPath: '/Volumes/A001/BACKUP' }],
    ['PF-E7', 'Refus : le filtre ne copierait rien', {}],
    ['PF-E8', 'Refus : le disque a disparu', { dest: 'NAS_BACKUP' }],
    ['PF-E9', 'Refus : le dossier existe déjà', { folder: '004_A001_ALEX', dest: 'RAID_SHOOT', absPath: '/Volumes/RAID_SHOOT/004_A001_ALEX' }],
  ].map(([code, title, data]) => ({ id: 'refusal-' + code.toLowerCase(), title, run: async p => { await p.evaluate(({ code, data }) => { showOneEngineRefusal([{ refused: true, refusalCode: code, refusalData: data, sourceName: 'A001', errorList: [] }]); }, { code, data }); }, crop: '#pf-ov .pf-card' })),
  { id: 'space', title: 'Avertissement : pas assez de place', run: async p => { await loadCardDest(p); p.evaluate(() => { confirmDiskSpace({ dest: { name: 'NAS_BACKUP', path: '/Volumes/NAS_BACKUP' }, need: 26.4e9, free: 12e9 }); }).catch(() => {}); }, crop: '#pf-ov .pf-card' },
  { id: 'space-unknown', title: 'Avertissement : place libre inconnue', run: async p => { await loadCardDest(p); p.evaluate(() => { warnSpaceUnknown(['NAS_BACKUP']); }).catch(() => {}); }, crop: '#pf-ov .pf-card' },
  { id: 'history', title: 'Historique des ingests, une ligne ouverte', prefs: DEST_PREFS, run: async p => { await wait(p, 900); await p.locator('.sess-row').first().click(); }, crop: '#sess-card' },
  { id: 'verify-ok', title: 'Vérifier un dossier : tout est bon', run: async p => {
      await p.evaluate(() => showVerifyResult({ ok: true, total: 168, matched: 168, corrupted: [], missing: [], extra: [], quarantined: [], canceled: false }, '/Volumes/RAID_SHOOT/001_A001_ALEX_FX6_260924_0912'));
    }, crop: '#verify-result-ov .sum-card, #verify-result-ov > *' },
  { id: 'verify-fail', title: 'Vérifier un dossier : fichiers corrompus', run: async p => {
      await p.evaluate(() => showVerifyResult({ ok: false, total: 168, matched: 165, corrupted: [{ file: 'XDROOT/Clip/A001C087.MXF' }, { file: 'XDROOT/Clip/A001C088.MXF' }], missing: [{ file: 'XDROOT/Clip/A001C099.MXF' }], extra: ['notes.txt'], quarantined: [], canceled: false }, '/Volumes/RAID_SHOOT/001_A001_ALEX_FX6_260924_0912'));
    }, crop: '#verify-result-ov .sum-card, #verify-result-ov > *' },
  { id: 'settings', title: 'Réglages (toutes les sections ouvertes)', height: 3400, prefs: { ntfyEnabled: true, ntfyTopic: 'ingesto-studio-7x2k' }, run: async p => {
      await p.evaluate(() => openSettings());
      await p.evaluate(() => {
        const t = document.getElementById('filefilter-toggle'); if (t) { t.checked = true; onFileFilterToggle(t); }
        for (const id of ['set-hook-en', 'set-handoff-en']) { const e = document.getElementById(id); if (e) { e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); } }
        const c = document.querySelector('#settings-ov .mi-card'); c.style.maxHeight = 'none'; c.style.overflow = 'visible';
        document.getElementById('settings-ov').style.alignItems = 'flex-start';
      });
    }, crop: '#settings-ov .mi-card' },
  { id: 'unformatted', title: 'Carte déjà copiée et non formatée', prefs: { writeSentinel: true }, run: async p => {
      await loadCardDest(p);
      await p.evaluate(() => void showUnformattedCardDialog(S.sources[0], { counts: { total: 168, alreadyIngested: 120 }, lastIngest: { date: '2026-09-24T07:12:00Z', destination: '/Volumes/RAID_SHOOT/001_A001_ALEX_FX6_260924_0912' }, alreadyIngestedPreview: [{ p: 'XDROOT/Clip/A001C001.MXF', s: 4.4e9 }] }));
    }, crop: '#unformatted-ov > *' },
  { id: 'update', title: 'Nouvelle version disponible', run: async p => { await p.evaluate(() => { S.appVersion = '2.9.0'; showUpdateNotice({ version: '2.9.1', url: 'https://github.com/noar-justedit/ingesto/releases' }); }); }, crop: '#update-ov .mi-card' },
  { id: 'kiosk-pin', title: 'Kiosk : choix du code PIN', run: async p => { await p.evaluate(() => enterKiosk()); }, crop: '#kiosk-pin-ov > *' },
  { id: 'kiosk-card', title: 'Kiosk : une carte chargée', run: async p => {
      await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); });
      await wait(p, 500);
      await p.evaluate(() => addToZone('dst', { path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' }));
      await p.evaluate(() => addToZone('src', { path: '/Volumes/A001', name: 'A001' }));
      await wait(p, 1200);
      await p.evaluate(() => { const o = document.getElementById('k-op'); o.value = 'ALEX'; o.dispatchEvent(new Event('input', { bubbles: true })); renderKioskCounter(); });
    }, crop: '#kiosk-ov > *' },
  { id: 'kiosk-ok', title: 'Kiosk : carte vérifiée', run: async p => { await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); kioskShowResult('ok', 'Verified', 'A001 · 168 files · 26.4 GB', 'You can remove your card.'); }); }, crop: '#kiosk-result-ov > *' },
  { id: 'kiosk-warn', title: 'Kiosk : copiée, contenu non contrôlé', run: async p => { await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); kioskShowResult('warn', 'Copied', 'Sizes match. Contents were not checked.', 'Remove your card. Do not erase it.'); }); }, crop: '#kiosk-result-ov > *' },
  { id: 'kiosk-fail', title: 'Kiosk : gardez cette carte', run: async p => { await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); kioskShowResult('fail', 'Keep this card', 'Part of the card could not be read.', 'Do not erase it. Call the person in charge.'); }); }, crop: '#kiosk-result-ov > *' },
];

// ── In the page: what is translated, what stayed in English ──────────────
function collect(cropSel) {
  const I = window.INGESTO_I18N;
  let root = document.body;
  if (cropSel) for (const s of cropSel.split(',')) { const e = document.querySelector(s.trim()); if (e && e.getBoundingClientRect().width) { root = e; break; } }
  const rr = root.getBoundingClientRect();
  const clip = { x: Math.max(0, rr.left - 8), y: Math.max(0, rr.top - 8), w: rr.width + 16, h: rr.height + 16 };
  if (root === document.body) { clip.x = 0; clip.y = 0; clip.w = innerWidth; clip.h = innerHeight; }
  const shown = el => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    }
    return true;
  };
  const rectOf = n => {
    let r;
    if (n.nodeType === 3) { const g = document.createRange(); g.selectNodeContents(n); r = g.getBoundingClientRect(); }
    else r = n.getBoundingClientRect();
    return r;
  };
  const inside = r => r.width > 0 && r.height > 0 && r.right > clip.x && r.left < clip.x + clip.w && r.bottom > clip.y && r.top < clip.y + clip.h;
  const box = r => ({ x: Math.round(r.left - clip.x), y: Math.round(r.top - clip.y), w: Math.round(r.width), h: Math.round(r.height) });
  const items = [];
  const seen = new Set();
  for (const t of I.touched()) {
    const el = t.node.nodeType === 1 ? t.node : t.node.parentElement;
    if (!root.contains(el) || !shown(el)) continue;
    const r = rectOf(t.node);
    if (!inside(r)) continue;
    seen.add(t.node);
    items.push(Object.assign({ key: t.key, kind: t.kind, en: String(t.orig).replace(/\s+/g, ' ').trim(), tr: String(t.applied).replace(/\s+/g, ' ').trim() }, box(r)));
  }
  // Still in English: visible text with letters, not translated, not user data.
  const KEEP = /^(FAST|SIZE CHECK|SECURE|PRO|KIOSK|STANDARD|SOURCE|xxHash64|xxHash128|MD5|ASC MHL|MHL|HTML|CSV|JSON|ntfy|ntfy\.sh|OK|INGESTO|ingesto|Just Edit|just-edit\.fr|Aa|MD|N|CAM|TeraCopy|Silverstack|YoYotta|OffShoot|Finder|Sony|Canon|Panasonic|Fujifilm|ARRI|RED|Nikon|Blackmagic|DJI|Apple|iPhone|Android|Smartphones|Standard|Total|Notes|Mode|Destinations|Sources|AUDIO|PRO · .*|.*\{[A-Za-z]+\}.*|v\d[\d.]*|[\d.,]+\s?[KMGTP]?B( \/s| free)?|[\d.,]+\s?[KMGTP]?B\/s|[A-Z0-9_\-]+\.(MXF|MP4|MOV|md|txt|json|html|csv)|[A-Za-z0-9_.\-\/]+\/[A-Za-z0-9_.\-\/]*|[A-Z0-9]{2,5}|\([\d.,]+\s?[KMGTP]?B\)|https?:\/\/\S+|[a-z0-9]+(-[a-z0-9]+)+)$/;
  const english = [];
  // A paragraph translated as a whole (blocks): its new text nodes are the
  // translation, not English left over.
  const blocksDone = I.touched().filter(t => t.kind === 'html').map(t => t.node);
  const inBlock = n => blocksDone.some(b => b.contains(n));
  // Found in the dictionary, even if the word is the same in both languages
  // ("Minute", "Pause", "DATE"): reviewed with the others, not missing.
  const known = v => I.lookup(v) != null;
  const walk = el => {
    if (/^(SCRIPT|STYLE|TEXTAREA|SVG)$/i.test(el.tagName)) return;
    if (I.isUserData && I.isUserData(el)) return;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) { walk(c); continue; }
      if (c.nodeType !== 3 || seen.has(c)) continue;
      const v = c.data.replace(/\s+/g, ' ').trim();
      if (!/[A-Za-z]{2,}/.test(v) || KEEP.test(v) || known(v) || inBlock(c)) continue;
      if (!shown(el)) continue;
      const r = rectOf(c);
      if (!inside(r)) continue;
      english.push(Object.assign({ text: v }, box(r)));
    }
  };
  walk(root);
  for (const el of root.querySelectorAll('[title],[placeholder]')) {
    if (I.isUserData && I.isUserData(el)) continue;
    for (const a of ['title', 'placeholder']) {
      const v = (el.getAttribute(a) || '').trim();
      if (!v || !/[A-Za-z]{2,}/.test(v) || KEEP.test(v) || I.lookup(v)) continue;
      if (I.touched().some(t => t.node === el && t.kind === a)) continue;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect(); if (!inside(r)) continue;
      english.push(Object.assign({ text: v, attr: a }, box(r)));
    }
  }
  return { clip, items, english };
}

(async () => {
  const b = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
  const want = process.argv.slice(4);
  const screens = [];
  for (const sc of SCREENS) {
    if (want.length && !want.some(w => sc.id.startsWith(w))) continue;
    try {
      const p = await open(b, { lang: LANG, scale: 1, height: sc.height || 940, startNever: !!sc.startNever, prefs: sc.prefs || {} });
      const errs = []; p.on('pageerror', e => errs.push(e.message.split('\n')[0]));
      // A window that waits for a click returns a promise that never settles:
      // never wait more than 20 s for a screen to be ready.
      await Promise.race([sc.run(p), new Promise(r => setTimeout(r, 20000))]);
      await wait(p, 900);
      const d = await p.evaluate(collect, sc.crop || null);
      const img = `screens/${sc.id}.png`;
      await p.screenshot({ path: path.join(OUT, img), clip: { x: d.clip.x, y: d.clip.y, width: Math.min(d.clip.w, 1500), height: Math.min(d.clip.h, sc.height || 940) } });
      screens.push({ id: sc.id, title: sc.title, img, w: Math.round(Math.min(d.clip.w, 1500)), h: Math.round(Math.min(d.clip.h, sc.height || 940)), items: d.items, english: d.english });
      console.log(`${sc.id.padEnd(18)} ${String(d.items.length).padStart(3)} traduits  ${String(d.english.length).padStart(3)} en anglais` + (errs.length ? '  ERR ' + errs[0] : ''));
      await p.context().close();
    } catch (e) { console.log('FAIL', sc.id, e.message.split('\n')[0]); }
  }
  // Every dictionary entry, with its section (the comment above it in the
  // language file), so that what no screen shows can still be reviewed.
  const file = path.join(ROOT, 'src', 'renderer', 'lang', LANG + '.js');
  if (!fs.existsSync(file)) { console.log(`\n${screens.length} écrans (pas de dictionnaire ${LANG})`); await b.close(); return; }
  const src = fs.readFileSync(file, 'utf8');
  global.window = {};
  require(file);
  const dict = Object.values(global.window)[0];
  const entries = [];
  let section = '', part = '';
  const lines = src.split('\n');
  const sectionAt = [];
  for (const l of lines) {
    const m = l.match(/^\s*\/\*\s*(?:──\s*)?(.+?)\s*(?:──\s*)?(\*\/)?$/);
    if (/^\s{2}(texts|attrs|patterns|blocks|blockPatterns)\s*:/.test(l)) part = l.trim().split(':')[0];
    if (m && !/^=+$/.test(m[1])) section = m[1].replace(/──/g, '').trim();
    sectionAt.push([part, section]);
  }
  const sectionOf = (needle) => { const i = lines.findIndex(l => l.includes(needle)); return i >= 0 ? sectionAt[i][1] : ''; };
  const seenBy = {};
  for (const s of screens) for (const it of s.items) for (const k of String(it.key).split(' + ')) (seenBy[k] = seenBy[k] || new Set()).add(s.id);
  const add = (kind, key, tr) => entries.push({ key, kind, tr, section: sectionOf(JSON.stringify(key).slice(1, 40)), seen: [...(seenBy[key] || [])] });
  for (const k in dict.texts || {}) add('text', k, dict.texts[k]);
  for (const k in dict.attrs || {}) add('attr', k, dict.attrs[k]);
  for (const [k, v] of dict.patterns || []) add('pattern', k, v);
  for (const k in dict.blocks || {}) add('block', k, dict.blocks[k]);
  for (const [k, v] of dict.blockPatterns || []) add('blockPattern', k, v);
  fs.writeFileSync(path.join(OUT, 'board.json'), JSON.stringify({ lang: LANG, made: new Date().toISOString(), screens, entries }, null, 1));
  const unseen = entries.filter(e => !e.seen.length).length;
  console.log(`\n${screens.length} écrans, ${entries.length} entrées, ${unseen} jamais vues sur un écran, ${screens.reduce((a, s) => a + s.english.length, 0)} textes restés en anglais`);
  await b.close();
})();
