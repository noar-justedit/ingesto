// Captures du manuel utilisateur, ecrites dans docs/manual/images/.
// Ouvre la vraie interface (src/renderer/index.html) dans Chromium avec un faux
// window.ingesto et des donnees de demo, sur le modele de docs/notes/harness/stub.js.
// Mode d'emploi : docs/manual/tools/README.md
//   node docs/manual/tools/capture.js            toutes les captures
//   node docs/manual/tools/capture.js 15 22      seulement celles qui commencent par 15 ou 22
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file://' + path.join(ROOT, 'src', 'renderer', 'index.html');
const OUT = path.join(__dirname, '..', 'images');
const VERSION = require(path.join(ROOT, 'package.json')).version;
fs.mkdirSync(OUT, { recursive: true });

const VOLS = [
  { path:'/Volumes/A001', name:'A001', total:128e9, freeSize:33.2e9, size:128e9, removable:true, type:'removable', fsType:'sdcard', camera:'FX6' },
  { path:'/Volumes/A002', name:'A002', total:128e9, freeSize:12e9, size:128e9, removable:true, type:'removable', fsType:'sdcard', camera:'FX6' },
  { path:'/Volumes/RAID_SHOOT', name:'RAID_SHOOT', total:8e12, freeSize:4.9e12, size:8e12, removable:true, type:'removable' },
  { path:'/Volumes/NAS_BACKUP', name:'NAS_BACKUP', total:40e12, freeSize:15.6e12, size:40e12, removable:false, type:'network', isNetwork:true },
  { path:'/', name:'Macintosh HD', total:1e12, freeSize:320e9, size:1e12, removable:false, type:'system', system:true, isSystem:true },
];
const fl = (pfx, n, sz) => Array.from({ length: n }, (_, i) => ({ path: `XDROOT/Clip/${pfx}${String(i + 1).padStart(3, '0')}.MXF`, size: sz }));
const REC = [
  { n:'001', date:'24.09.2026 09:12', card:'A001', folder:'001_A001_ALEX_FX6_260924_0912', operator:'ALEX', cam:'FX6', pp:'SLOG3',
    mode:'Secure', modeClass:'m-secure', files:168, bytes:26.4e9, result:'OK', rclass:'r-ok', copyMs:412000, v1Ms:251000, v2Ms:0, note:'Interviews', fileList: fl('A001C', 6, 4.4e9) },
  { n:'002', date:'24.09.2026 11:31', card:'B001', folder:'002_B001_MARC_FX3_260924_1131', operator:'MARC', cam:'FX3', pp:'SLOG3',
    mode:'PRO · xxHash64', modeClass:'m-pro', files:92, bytes:14.1e9, result:'OK', rclass:'r-ok', copyMs:221000, v1Ms:139000, v2Ms:120000, note:'B-roll' },
  { n:'003', date:'24.09.2026 15:02', card:'A002', folder:'003_A002_ALEX_FX6_260924_1502', operator:'ALEX', cam:'FX6', pp:'SLOG3',
    mode:'Secure', modeClass:'m-secure', files:121, bytes:19.8e9, result:'OK', rclass:'r-ok', copyMs:318000, v1Ms:190000, v2Ms:0, note:'' },
];

async function open(browser, { width = 1500, height = 940, startNever = false, prefs = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message.split('\n')[0]));
  p.on('dialog', d => d.accept());
  await p.addInitScript(({ VOLS, REC, startNever, prefs, VERSION }) => {
    const noop = () => {};
    window.__cb = {};
    window.__vols = VOLS;
    const api = {
      platform: 'darwin',
      getVolumes: async () => window.__vols,
      getVersion: async () => VERSION,
      loadPrefs: async () => Object.assign({ mode: 'slow', proWarnDismissed: true, cameraman: 'ALEX', camera: 'FX6', pp: 'SLOG3' }, prefs),
      savePrefs: async () => true,
      isRemovable: async () => true,
      diskFree: async () => ({ free: 4.9e12, total: 8e12 }),
      folderSize: async () => 26.4e9,
      checkPaths: async (e) => (e || []).map(x => ({ ...x, ok: true, exists: true })),
      detectCamera: async () => ({ camera: 'FX6', brand: 'SONY', model: 'FX6' }),
      inspectCard: async () => ({ ok: true, files: 168, bytes: 26.4e9, clips: 168, writable: true, unformatted: false, tag: null }),
      scanDestCounter: async () => ({ next: 4, max: 3 }),
      scanDestCounterFull: async () => ({ next: 4, max: 3, folders: [] }),
      checkCounterCollision: async () => null,
      reportRead: async () => ({ created: '2026-09-24T07:12:00Z', records: REC }),
      resolvePath: async (x) => x,
      setPowerBlock: async () => true,
      startCopy: async () => startNever ? new Promise(() => {}) : null,
    };
    window.ingesto = new Proxy(api, { get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k.startsWith('on')) return (cb) => { window.__cb[k] = cb; return noop; };
      return async () => null;
    }});
  }, { VOLS, REC, startNever, prefs, VERSION });
  await p.goto(PAGE);
  await p.waitForTimeout(1200);
  return p;
}

const wait = (p, ms = 600) => p.waitForTimeout(ms);
async function shot(p, name, sel) {
  await wait(p, 500);
  const f = path.join(OUT, name + '.png');
  if (sel) await p.locator(sel).first().screenshot({ path: f });
  else await p.screenshot({ path: f });
  console.log('ok', name);
}

async function region(p, name, topSel, botSel, pad = 6) {
  await wait(p, 500);
  const r = await p.evaluate(({ topSel, botSel }) => {
    const a = document.querySelector(topSel).getBoundingClientRect(), b = document.querySelector(botSel).getBoundingClientRect();
    return { x: Math.min(a.left, b.left), y: a.top, w: Math.max(a.right, b.right) - Math.min(a.left, b.left), h: b.bottom - a.top };
  }, { topSel, botSel });
  await p.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: r.x - pad, y: r.y - pad, width: r.w + 2 * pad, height: r.h + 2 * pad } });
  console.log('ok', name);
}
async function loadCardDest(p, cards = ['A001'], dsts = ['RAID_SHOOT', 'NAS_BACKUP']) {
  await p.evaluate(({ cards, dsts }) => {
    for (const c of cards) addToZone('src', { path: '/Volumes/' + c, name: c });
    for (const d of dsts) addToZone('dst', { path: '/Volumes/' + d, name: d });
  }, { cards, dsts });
  await wait(p, 1500);
}
const DEST_PREFS = { destPaths: [{ path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' }, { path: '/Volumes/NAS_BACKUP', name: 'NAS_BACKUP' }] };

const S = {};

S['01-first-launch'] = async b => { const p = await open(b); await shot(p, '01-first-launch'); };

S['02-ready'] = async b => {
  const p = await open(b); await loadCardDest(p);
  await p.evaluate(() => { const n = document.querySelector('#src-info-list textarea'); if (n) { n.value = 'Interviews, day 1'; n.dispatchEvent(new Event('input', { bubbles: true })); } });
  await shot(p, '02-ready');
};

S['04-vol-menu'] = async b => {
  const p = await open(b);
  const box = await p.locator('.vc').first().boundingBox();
  await p.evaluate(({ x, y }) => winVolMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, '/Volumes/A001'), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await wait(p, 800);
  await p.screenshot({ path: path.join(OUT, '04-vol-menu.png'), clip: { x: box.x - 20, y: box.y - 20, width: 520, height: 360 } }); console.log('ok 04-vol-menu');
};

S['05-new-drive'] = async b => {
  const p = await open(b);
  await p.evaluate(() => proposeNewVolumes([window.__vols[1]]));
  await shot(p, '05-new-drive', '#vol-proposal > *');
};

S['10-pro'] = async b => {
  const p = await open(b, { prefs: { mode: 'pro', proAlgo: 'xxh64' } }); await loadCardDest(p);
  await shot(p, '10-pro', '#center-controls');
};

S['11-pro-warn'] = async b => {
  const p = await open(b, { prefs: { proWarnDismissed: false } });
  await p.evaluate(() => onSelectPro()); await shot(p, '11-pro-warn', '#pro-warn-ov > *');
};

S['12-counter-info'] = async b => { const p = await open(b); await p.evaluate(() => showCounterInfo()); await shot(p, '12-counter-info', '#counter-info-ov > *'); };

async function ingestRunning(b, phase) {
  const p = await open(b, { startNever: true }); await loadCardDest(p, ['A001', 'A002']);
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
  return p;
}
S['13-ingest-copy'] = async b => { const p = await ingestRunning(b, 'copy'); await shot(p, '13-ingest-copy'); };
S['14-ingest-verify'] = async b => { const p = await ingestRunning(b, 'verify'); await shot(p, '14-ingest-verify'); };

const R_OK = (dst) => ({ success: true, canceled: false, sourceName: 'A001', sourcePath: '/Volumes/A001', destPath: `/Volumes/${dst}/004_A001_ALEX_FX6_261001_1214`, relFolder: '004_A001_ALEX_FX6_261001_1214',
  totalFiles: 168, copiedFiles: 168, totalBytes: 26.4e9, copiedBytes: 26.4e9, errors: 0, errorList: [], failedFiles: [], unstableFiles: [], notes: [], mode: 'slow', coldVerify: true,
  copyMs: 412000, verify1Ms: 251000, verify2Ms: 0, duration: 663000 });
S['15-summary-ok'] = async b => {
  const p = await open(b); await loadCardDest(p);
  await p.evaluate((R) => showSummary(R), [R_OK('RAID_SHOOT'), R_OK('NAS_BACKUP')]);
  await shot(p, '15-summary-ok', '.sum-card');
};
S['16-summary-fail'] = async b => {
  const p = await open(b); await loadCardDest(p);
  const bad = { ...R_OK('NAS_BACKUP'), success: false, errors: 2, copiedFiles: 166, failedFiles: ['XDROOT/Clip/A001C087.MXF', 'XDROOT/Clip/A001C088.MXF'],
    errorList: [{ file: 'XDROOT/Clip/A001C087.MXF', phase: 'verify', error: 'Checksum mismatch', origin: 'dest' }, { file: 'XDROOT/Clip/A001C088.MXF', phase: 'verify', error: 'Checksum mismatch', origin: 'dest' }] };
  await p.evaluate((R) => showSummary(R), [R_OK('RAID_SHOOT'), bad]);
  await shot(p, '16-summary-fail', '.sum-card');
};

S['17-refusal'] = async b => {
  const p = await open(b, { prefs: { lastTemplate: [{ type: 'var', key: 'cardname' }] } });
  await loadCardDest(p, ['A001', 'A002']);
  await p.evaluate(() => { const v = window.__vols; v[1].name = 'A001'; });
  await p.evaluate(() => { S.sources[1].name = 'A001'; renderAll && renderAll(); }).catch(() => {});
  await p.evaluate(() => onStartBtn()); await wait(p, 1500);
  await shot(p, '17-refusal', '#pf-ov > *');
};

S['18-history'] = async b => {
  const p = await open(b, { prefs: DEST_PREFS }); await wait(p, 1500);
  await p.locator('.sess-row').first().click(); await wait(p, 700);
  await shot(p, '18-history', '#sess-card');
};

S['19-report'] = async b => {
  const p = await open(b);
  const html = await p.evaluate(async (R) => buildReportHtml('2026-09-24T07:12:00Z', '2026-09-24T15:14:00Z', '/Volumes/RAID_SHOOT', R), REC);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
  const q = await ctx.newPage(); await q.setContent(html); await wait(q, 800);
  await q.evaluate(() => { try { tgl(0); } catch (e) {} }); await wait(q, 500);
  await q.screenshot({ path: path.join(OUT, '19-report.png') }); console.log('ok 19-report');
};

S['20-verify-result'] = async b => {
  const p = await open(b);
  await p.evaluate(() => showVerifyResult({ ok: true, total: 168, matched: 168, corrupted: [], missing: [], extra: [], quarantined: [], canceled: false }, '/Volumes/RAID_SHOOT/001_A001_ALEX_FX6_260924_0912'));
  await shot(p, '20-verify-result', '#verify-result-ov > *');
};

S['21-settings'] = async b => {
  const p = await open(b, { height: 1000, prefs: { ntfyEnabled: true, ntfyTopic: 'ingesto-studio-7x2k' } });
  await p.evaluate(() => openSettings()); await wait(p, 600);
  await shot(p, '21-settings-overview', '#settings-ov .mi-card');
  await p.evaluate(() => {
    const t = document.getElementById('filefilter-toggle'); t.checked = true; onFileFilterToggle(t);
    for (const id of ['set-hook-en', 'set-handoff-en']) { const e = document.getElementById(id); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); }
    const c = document.querySelector('#settings-ov .mi-card'); c.style.maxHeight = 'none'; c.style.overflow = 'visible';
    document.getElementById('settings-ov').style.alignItems = 'flex-start';
  });
  await p.setViewportSize({ width: 1500, height: 3400 }); await wait(p, 800);
  // Sections 5 et 6 (Post-Ingest Command, Card Handoff) : decrites sans capture.
  const names = ['tracking', 'checksum', 'report', 'filter', 'ntfy', null, null, 'file'];
  for (let i = 0; i < names.length; i++) if (names[i]) await shot(p, `22-set-${i}-${names[i]}`, `#settings-ov .set-section >> nth=${i}`);
};

S['25-kiosk-pin'] = async b => { const p = await open(b); await p.evaluate(() => enterKiosk()); await shot(p, '25-kiosk-pin', '#kiosk-pin-ov > *'); };
S['26-kiosk'] = async b => {
  const p = await open(b);
  await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); });
  await wait(p, 500);
  await p.evaluate(() => addToZone('dst', { path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' }));
  await p.evaluate(() => addToZone('src', { path: '/Volumes/A001', name: 'A001' }));
  await wait(p, 1200);
  await p.evaluate(() => { const o = document.getElementById('k-op'); o.value = 'ALEX'; o.dispatchEvent(new Event('input', { bubbles: true })); });
  await shot(p, '26b-kiosk-card', '#kiosk-ov > *');
};
S['27-kiosk-result'] = async b => {
  const p = await open(b);
  await p.evaluate(() => { S.kioskPin = '1234'; S.kioskMode = true; applyKioskMode(); kioskShowResult('ok', 'Verified', 'A001 · 168 files · 26.4 GB', 'You can remove your card.'); });
  await shot(p, '27-kiosk-result', '#kiosk-result-ov > *');
};

S['28-unformatted'] = async b => {
  const p = await open(b, { prefs: { writeSentinel: true } }); await loadCardDest(p);
  await p.evaluate(() => showUnformattedCardDialog(S.sources[0], { counts: { total: 168, alreadyIngested: 120 }, lastIngest: { date: '2026-09-24T07:12:00Z', destination: '/Volumes/RAID_SHOOT/001_A001_ALEX_FX6_260924_0912' }, alreadyIngestedPreview: [{ p: 'XDROOT/Clip/A001C001.MXF', s: 4.4e9 }] }));
  await shot(p, '28-unformatted', '#unformatted-ov > *');
};

S['30-crops'] = async b => {
  let p = await open(b); await loadCardDest(p, ['A001', 'A002']);
  await p.evaluate(() => { const n = document.querySelector('#src-info-list textarea'); if (n) { n.value = 'Interviews, day 1'; n.dispatchEvent(new Event('input', { bubbles: true })); } });
  await region(p, '30-card-details', '#src-info-title', '#src-info-list');
  await region(p, '31-dest-list', '#dst-zone', '#dst-list');
  await p.click('#ins-btn'); await wait(p, 600);
  await region(p, '32-insert-menu', '#ins-btn', '#ins-menu', 3);
  p = await open(b); await loadCardDest(p);
  await p.evaluate(() => { S.tokens = []; [['sep','DAY1'],['sep','/'],['var','camera'],['sep','/'],['var','counter'],['sep','_'],['var','cardname'],['sep','_'],['var','operator'],['sep','_'],['var','YY'],['var','MM'],['var','DD']].forEach(([t,k]) => addTok(t,k)); });
  await wait(p, 1200);
  await region(p, '33-subfolder', '#dst-list', '#tpl-box');
  const tok = s => s.split(' ').map(k => k.startsWith('{') ? { type: 'var', key: k.slice(1, -1) } : { type: 'sep', key: k });
  p = await open(b, { prefs: { tplVersion: 2, activePreset: 0, presets: [
    { name: 'Standard', tokens: tok('{counter} _ {cardname} _ {operator} _ {camera} _ {YY} {MM} {DD}') },
    { name: 'Short', tokens: tok('{counter} _ {cardname}') }, null, null] } });
  await loadCardDest(p);
  await region(p, '34-templates', '#presets-row', '#presets-row');
};

// Le logo de la couverture : celui de la barre de titre de l'appli.
S['00-logo'] = async () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const m = html.match(/class="t-logo"><img src="data:image\/png;base64,([^"]+)"/);
  fs.writeFileSync(path.join(OUT, 'logo-mark.png'), Buffer.from(m[1], 'base64'));
  console.log('ok 00-logo');
};

(async () => {
  const b = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
  const want = process.argv.slice(2);
  for (const [k, fn] of Object.entries(S)) {
    if (want.length && !want.some(w => k.startsWith(w))) continue;
    try { await fn(b); } catch (e) { console.log('FAIL', k, e.message.split('\n')[0]); }
  }
  await b.close();
})();
