// Harnais de test SANS BUILD de l'interface d'ingesto.
//
// Ouvre src/renderer/index.html dans Chromium (Playwright) avec un faux
// window.ingesto : le processus principal Electron n'existe pas ici. Un Proxy
// repond a tout ce qui n'est pas prevu : toute methode renvoie null, tout
// abonnement onX() est garde dans window.__cb pour pouvoir simuler un evenement
// (progression de copie, fin d'ingest...).
//
// Prerequis (a faire valider par Noar avant d'installer quoi que ce soit) :
//   npm install --no-save playwright && npx playwright install chromium
//
// Usage : const { launch, open } = require('./stub');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file://' + path.join(ROOT, 'src', 'renderer', 'index.html');

// Donnees de demo. fsType:'sdcard' donne l'icone carte, isNetwork le NAS,
// isSystem le disque systeme : sans ces champs tout s'affiche en disque.
const VOLS = [
  { path:'/Volumes/A001', name:'A001', total:128e9, freeSize:33.2e9, size:128e9, removable:true, type:'removable', fsType:'sdcard', camera:'FX6' },
  { path:'/Volumes/A002', name:'A002', total:128e9, freeSize:12e9,   size:128e9, removable:true, type:'removable', fsType:'sdcard', camera:'FX6' },
  { path:'/Volumes/RAID_SHOOT', name:'RAID_SHOOT', total:8e12, freeSize:4.9e12, size:8e12, removable:true, type:'removable' },
  { path:'/Volumes/NAS_BACKUP', name:'NAS_BACKUP', total:40e12, freeSize:15.6e12, size:40e12, removable:false, type:'network', isNetwork:true },
  { path:'/', name:'Macintosh HD', total:1e12, freeSize:320e9, size:1e12, removable:false, type:'system', system:true, isSystem:true },
];
// Lignes de rapport telles que updateReports() les ecrit. Les durees sont
// copyMs / v1Ms / v2Ms (PAS verify1Ms, qui est le nom cote moteur).
const REC = [
  { n:'001', date:'24.09.2026 09:12', card:'A001', folder:'001_A001_NOAR_FX6_SLOG3_260924', operator:'NOAR', cam:'FX6', pp:'SLOG3',
    mode:'Secure', modeClass:'m-secure', files:168, bytes:26.4e9, result:'OK', rclass:'r-ok', copyMs:412000, v1Ms:251000, v2Ms:0, note:'Interviews' },
  { n:'002', date:'24.09.2026 09:31', card:'B001', folder:'002_B001_MARC_FX3_SLOG3_260924', operator:'MARC', cam:'FX3', pp:'SLOG3',
    mode:'PRO · xxHash64', modeClass:'m-pro', files:92, bytes:14.1e9, result:'3 errors', rclass:'r-err', copyMs:221000, v1Ms:139000, v2Ms:120000 },
];

// PW_EXE : chemin d'un Chromium deja installe, si on ne veut pas celui de Playwright.
async function launch() { return chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {}); }

// opts.startNever : startCopy ne se termine jamais, pour figer l'etat "ingest en cours".
async function open(browser, { width = 1500, height = 940, dsf = 2, startNever = false, prefs = {} } = {}) {
  // bypassCSP : la page porte une CSP stricte ; sans ce drapeau une feuille de
  // style injectee par le harnais serait refusee.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message.split('\n')[0]));
  await p.addInitScript(({ VOLS, REC, startNever, prefs }) => {
    const noop = () => {};
    window.__cb = {};
    const api = {
      platform: 'darwin',
      getVolumes: async () => VOLS,
      getVersion: async () => 'dev',
      loadPrefs: async () => Object.assign({ mode: 'slow', proWarnDismissed: true }, prefs),
      savePrefs: async () => true,
      isRemovable: async () => true,
      diskFree: async () => ({ free: 4.9e12, total: 8e12 }),
      folderSize: async () => 26.4e9,
      checkPaths: async (e) => (e || []).map(x => ({ ...x, ok: true, exists: true })),
      detectCamera: async () => ({ camera: 'FX6', brand: 'SONY', model: 'FX6' }),
      inspectCard: async () => ({ ok: true, files: 168, bytes: 26.4e9, clips: 168, writable: true, unformatted: false, tag: null }),
      scanDestCounter: async () => ({ next: 3, max: 2 }),
      scanDestCounterFull: async () => ({ next: 3, max: 2, folders: [] }),
      // PIEGE : le moteur renvoie null quand il n'y a pas de collision. Un objet
      // (meme {collision:false}) declenche le refus "[object Object] already there".
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
  }, { VOLS, REC, startNever, prefs });
  await p.goto(PAGE);
  await p.waitForTimeout(1200);
  return p;
}

module.exports = { launch, open, VOLS, REC, ROOT };
