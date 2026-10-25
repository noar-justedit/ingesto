// Opens the real interface (src/renderer/index.html) in Chromium with a fake
// window.ingesto and demo data, in the language asked for. Shared by the
// translation tools of this folder. Same stub as docs/manual/tools/capture.js.
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file://' + path.join(ROOT, 'src', 'renderer', 'index.html');
const VERSION = require(path.join(ROOT, 'package.json')).version;

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
    mode:'Secure', modeClass:'m-secure', files:168, bytes:26.4e9, result:'OK', rclass:'r-ok', copyMs:412000, v1Ms:251000, v2Ms:0, note:'**Interviews**, room B', fileList: fl('A001C', 6, 4.4e9) },
  { n:'002', date:'24.09.2026 11:31', card:'B001', folder:'002_B001_MARC_FX3_260924_1131', operator:'MARC', cam:'FX3', pp:'SLOG3',
    mode:'PRO · xxHash64', modeClass:'m-pro', files:92, bytes:14.1e9, result:'OK', rclass:'r-ok', copyMs:221000, v1Ms:139000, v2Ms:120000, note:'B-roll' },
  { n:'003', date:'24.09.2026 15:02', card:'A002', folder:'003_A002_ALEX_FX6_260924_1502', operator:'ALEX', cam:'FX6', pp:'SLOG3',
    mode:'Secure', modeClass:'m-secure', files:121, bytes:19.8e9, result:'OK', rclass:'r-ok', copyMs:318000, v1Ms:190000, v2Ms:0, note:'**Exteriors**, car park\n- [x] Sound checked' },
];

async function open(browser, { width = 1500, height = 940, startNever = false, prefs = {}, lang = "en", scale = 2 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message.split('\n')[0]));
  p.on('dialog', d => d.accept());
  await p.addInitScript((lang) => { try { localStorage.setItem('ingesto-language', lang); } catch (e) {} }, lang);
  prefs = Object.assign({ language: lang }, prefs);
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
module.exports = { open, wait, ROOT, VOLS, REC };
