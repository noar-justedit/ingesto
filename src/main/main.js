// ingesto — Professional Camera Media Ingest
// Copyright (C) 2026 Just Edit (Arnaud Augst)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.


const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerSaveBlocker } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execSync, execFileSync } = require('child_process');
const https = require('https');

// ── Update check — reads a small shared JSON hosted on GitHub ──────────────
// Never blocks startup, fails silently on any network issue.
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/ingesto/main/version.json';
function semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
// GET a URL following up to 3 redirects (https.get does NOT follow them itself).
// Fails silently on any network/TLS issue — never blocks or disrupts startup.
function fetchFollow(url, hops, cb) {
  if (hops > 3) return cb(null);
  try {
    const req = https.get(url, { timeout: 4000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch (e) { return cb(null); }
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200) { res.resume(); return cb(null); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => cb(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => cb(null));
  } catch (e) { cb(null); }
}
function checkForUpdate() {
  fetchFollow(UPDATE_URL, 0, (body) => {
    if (!body) return;
    let data; try { data = JSON.parse(body); } catch (e) { return; }
    // This version.json is now dedicated to INGESTO alone (one file per app,
    // each in its own repo) — no more "ingesto" wrapper key like on the old
    // shared multi-app NAS file.
    if (!data || !data.version) return;
    if (semverGt(data.version, app.getVersion()) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', { version: data.version, url: data.url || 'https://github.com/noar-justedit/ingesto/releases/latest' });
    }
  });
}

const { detectCamera }                 = require('./camera-detect');
const { inspectCard, appendIngest, listAllFiles } = require('./sentinel');

// All fingerprints (SECURE xxHash64, PRO xxHash64/128/MD5, Verify) go through
// hash-wasm — a single library, pure WASM, no native binary. INGESTO ≤ 2.0.2
// used a second library (xxhash-wasm) for SECURE, whose hex output omitted
// leading zeros and caused false "hash mismatch" results in Verify.
let _hashwasm = null;
function getHashWasm() { if (!_hashwasm) _hashwasm = require('hash-wasm'); return _hashwasm; }
const PRO_EXT = { xxh64:'.xxh', xxh128:'.xxh3', md5:'.md5' };
async function newProHasher(algo) {
  const hw = getHashWasm();
  if (algo === 'md5')   return hw.createMD5();
  if (algo === 'xxh64') return hw.createXXHash64();
  return hw.createXXHash128();               // default: xxHash128
}
// Fingerprint a file with the chosen algo (used by SECURE, PRO and Verify).
//  - Small files (<= 8 MB): single buffered read + one update(). Removes the per-file
//    stream setup/teardown that dominates on card structures with thousands of tiny
//    files (Sony XDROOT XML/BIM/SMI, thumbnails…).
//  - Large files: stream with a bounded buffer so RAM stays flat.
const HASH_SMALL_LIMIT = 8 * 1024 * 1024;
async function hashPro(fp, hasher) {
  hasher.init();
  let size = Infinity;
  try { size = fs.statSync(fp).size; } catch (_) {}
  if (size <= HASH_SMALL_LIMIT) {
    const buf = await fs.promises.readFile(fp);
    try { hasher.update(buf); } catch (_) {}
    return hasher.digest();
  }
  return new Promise((res, rej) => {
    const s = fs.createReadStream(fp, { highWaterMark: 4*1024*1024 });
    s.on('data', d => { try { hasher.update(d); } catch(_){} });
    s.on('end', () => res(hasher.digest()));
    s.on('error', rej);
  });
}
// Write a TeraCopy-style checksum list at the root of a destination folder.
function writeChecksumList(destPath, algo, entries) {
  try {
    const ext  = PRO_EXT[algo] || '.xxh3';
    const name = path.basename(destPath) + ext;
    const lines = entries.slice()
      .sort((a,b)=> a.rel<b.rel?-1 : a.rel>b.rel?1 : 0)
      .map(e => `${e.hash} *${e.rel.replace(/\\/g,'/')}`);
    fs.writeFileSync(path.join(destPath, name), lines.join('\n') + '\n', 'utf8');
    return name;
  } catch(_) { return null; }
}
// Write a classic MHL (Media Hash List) manifest, mirroring what DaVinci Resolve's
// Clone Tool produces: hashlist version 1.0, one <hash> block per file. Read by
// Silverstack, YoYotta, OffShoot. Only MD5 and xxHash64 are valid in classic MHL.
function xmlEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function isoSec(ms){ return new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z'); }
function writeMHL(destPath, algo, entries, meta){
  try {
    if (algo!=='md5' && algo!=='xxh64') return null;      // classic MHL: MD5 or xxHash64 only
    const tag = algo==='md5' ? 'md5' : 'xxhash64be';
    const name = path.basename(destPath) + '.mhl';
    const startIso  = isoSec(meta && meta.startMs ? meta.startMs : Date.now());
    const finishIso = isoSec(Date.now());
    let user=''; try { user = os.userInfo().username || ''; } catch(_){}
    const host = os.hostname() || '';
    const hashes = entries.slice()
      .sort((a,b)=> a.rel<b.rel?-1 : a.rel>b.rel?1 : 0)
      .map(e => {
        const rel = e.rel.replace(/\\/g,'/');
        const mtime = isoSec(e.mtimeMs || Date.now());
        return '  <hash>\n'+
               '    <file>'+xmlEsc(rel)+'</file>\n'+
               '    <size>'+(e.size||0)+'</size>\n'+
               '    <lastmodificationdate>'+mtime+'</lastmodificationdate>\n'+
               '    <'+tag+'>'+e.hash+'</'+tag+'>\n'+
               '    <hashdate>'+finishIso+'</hashdate>\n'+
               '  </hash>';
      }).join('\n');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'+
      '<hashlist version="1.0">\n'+
      '  <creatorinfo>\n'+
      '    <username>'+xmlEsc(user)+'</username>\n'+
      '    <hostname>'+xmlEsc(host)+'</hostname>\n'+
      '    <tool>INGESTO '+app.getVersion()+'</tool>\n'+
      '    <startdate>'+startIso+'</startdate>\n'+
      '    <finishdate>'+finishIso+'</finishdate>\n'+
      '  </creatorinfo>\n'+
      hashes+'\n'+
      '</hashlist>\n';
    fs.writeFileSync(path.join(destPath, name), xml, 'utf8');
    return name;
  } catch(_) { return null; }
}

// ── Verify Folder: read back an existing checksum list or MHL and re-check ──
const VERIFY_SKIP = new Set(['.DS_Store','.Spotlight-V100','.Trashes','.fseventsd','.TemporaryItems']);

// Recursively list every file under root as {abs, rel} (rel uses forward slashes).
function scanDirFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return; }
    for (const e of entries) {
      if (VERIFY_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ abs: full, rel: path.relative(root, full).replace(/\\/g, '/') });
    }
  })(root);
  return out;
}

// Look for a TeraCopy-style checksum list (<basename>.xxh/.xxh3/.md5) at the root
// of destPath. Prefer this over MHL when both exist — it also covers xxHash128,
// which classic MHL cannot express.
function readChecksumListFile(destPath) {
  const base = path.basename(destPath);
  const EXT_ALGO = { '.xxh':'xxh64', '.xxh3':'xxh128', '.md5':'md5' };
  for (const ext of Object.keys(EXT_ALGO)) {
    const file = base + ext;
    const fp = path.join(destPath, file);
    if (!fs.existsSync(fp)) continue;
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      const entries = [];
      for (const line of lines) {
        const m = line.match(/^([0-9a-fA-F]+)\s+\*(.+)$/);
        if (m) entries.push({ rel: m[2].replace(/\\/g,'/'), hash: m[1] });
      }
      if (entries.length) return { algo: EXT_ALGO[ext], file, entries };
    } catch(_) {}
  }
  return null;
}

// Look for a classic MHL (<basename>.mhl) at the root of destPath. Only MD5 and
// xxHash64 exist in classic MHL, matching what INGESTO itself ever writes.
function readMHLFile(destPath) {
  const base = path.basename(destPath);
  const file = base + '.mhl';
  const fp = path.join(destPath, file);
  if (!fs.existsSync(fp)) return null;
  try {
    const xml = fs.readFileSync(fp, 'utf8');
    const blocks = xml.match(/<hash>[\s\S]*?<\/hash>/g) || [];
    if (!blocks.length) return null;
    let algo = null;
    const entries = [];
    for (const b of blocks) {
      const relM = b.match(/<file>([\s\S]*?)<\/file>/);
      const md5M = b.match(/<md5>([0-9a-fA-F]+)<\/md5>/);
      const xxhM = b.match(/<xxhash64be>([0-9a-fA-F]+)<\/xxhash64be>/);
      if (!relM) continue;
      const rel = relM[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      if (md5M) { algo = 'md5'; entries.push({ rel, hash: md5M[1] }); }
      else if (xxhM) { algo = 'xxh64'; entries.push({ rel, hash: xxhM[1] }); }
    }
    if (entries.length) return { algo, file, entries };
  } catch(_) {}
  return null;
}

// Sidecar files INGESTO itself writes — excluded from the "extra files" list,
// since they're not footage the user needs to be alerted about.
function isIngestoSidecar(name, destBase) {
  return name === destBase + '.xxh' || name === destBase + '.xxh3' || name === destBase + '.md5' ||
         name === destBase + '.mhl' || name === 'INGESTO_report.html' ||
         name === 'INGESTO_report.csv' || name === 'INGESTO_report.json';
}

ipcMain.handle('verify-folder', async (event, destPath) => {
  cancelVerify = false;
  const manifest = readChecksumListFile(destPath) || readMHLFile(destPath);
  if (!manifest) return { ok:false, reason:'no-manifest' };

  const hasher = await newProHasher(manifest.algo);
  const total = manifest.entries.length;
  const matched=[], corrupted=[], missing=[];
  const manifestRels = new Set(manifest.entries.map(e => e.rel));

  for (let i=0; i<total; i++) {
    if (cancelVerify) break;
    const entry = manifest.entries[i];
    const abs = path.join(destPath, entry.rel);
    if (!fs.existsSync(abs)) {
      missing.push(entry.rel);
    } else {
      try {
        const digest = await hashPro(abs, hasher);
        // Normalize before comparing: checksum lists written by INGESTO ≤ 2.0.2
        // in SECURE mode omit leading zeros (15-char hashes), while hash-wasm
        // always emits the full padded form. Same value, different text.
        const norm = h => String(h).toLowerCase().replace(/^0+(?=.)/, '');
        if (norm(digest) === norm(entry.hash)) matched.push(entry.rel);
        else corrupted.push(entry.rel);
      } catch(_) { corrupted.push(entry.rel); }
    }
    event.sender.send('verify-progress', { index:i+1, total, currentFile:entry.rel });
  }

  // Extra files: present on disk, not referenced by the manifest, and not an
  // INGESTO sidecar file (report/checksum list/MHL itself).
  const destBase = path.basename(destPath);
  const extra = scanDirFiles(destPath)
    .filter(f => !manifestRels.has(f.rel) && !isIngestoSidecar(path.basename(f.rel), destBase))
    .map(f => f.rel);

  return {
    ok: true, canceled: cancelVerify,
    algo: manifest.algo, manifestFile: manifest.file,
    total, matched: matched.length, corrupted, missing, extra,
  };
});
ipcMain.handle('cancel-verify', async () => { cancelVerify = true; return true; });

let mainWindow;
let cancelCopy = false;
let cancelVerify = false;

// ─── Preferences ────────────────────────────────────────────────────────────
const PREFS_PATH = path.join(app.getPath('userData'), 'ingesto-prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (_) { return {}; }
}
function savePrefs(p) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2)); } catch (_) {}
}

// ─── Window — show IMMEDIATELY, volumes load async ──────────────────────────
function createWindow() {

  const isMac = process.platform === 'darwin';
  const winOpts = isMac ? {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }
  } : {
    titleBarStyle: 'hidden'
  };

  // Default size: as tall as the screen allows (so all template slots are visible),
  // capped at the height the content needs. Width capped to a comfortable max.
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1440, wa.width);
  const winH = Math.min(1040, wa.height);

  mainWindow = new BrowserWindow({
    width: winW, height: winH, minWidth: 1200, minHeight: 720,
    center: true,
    backgroundColor: '#0c0c0e',
    ...winOpts,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: true
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.webContents.once('did-finish-load', () => { setTimeout(checkForUpdate, 1500); });

  // Notify renderer of maximize state changes (for Windows title bar button)
  mainWindow.on('maximize',   () => mainWindow.webContents.send('win-maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win-unmaximized'));

  // ── Handle Finder drag & drop ───────────────────────────────────────────
  // When user drags a folder/volume from Finder onto the app window,
  // Electron fires 'will-navigate' with a file:// URL — intercept it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) {
      event.preventDefault();
      try {
        let filePath = decodeURIComponent(new URL(url).pathname);
        // On Windows, pathname is /C:/foo — strip leading slash
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        mainWindow.webContents.send('finder-drop', filePath);
      } catch (_) {}
    }
  });

  // Auto-open DevTools on Windows for debugging
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Windows: fix GPU context crash on hybrid Intel Arc + NVIDIA (Optimus) systems
if (process.platform === 'win32') {
  // Force ANGLE to use D3D11 — works reliably on Intel Arc and NVIDIA hybrid configs
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  // Disable GPU sandbox which causes access violations on hybrid GPU systems
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Force the renderer to use the integrated GPU (avoids Optimus switching issues)
  app.commandLine.appendSwitch('force_low_power_gpu');
  // Disable features that require GLES3 (not available on all hybrid configs)
  app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform,VaapiVideoDecoder,VaapiVideoEncoder');
  // Do NOT call disableHardwareAcceleration() — D3D11 is hardware but stable
}

app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC: Preload drop (Windows drag & drop fix) ────────────────────────────
ipcMain.on('preload-drop', (_, { path: filePath, clientX }) => {
  mainWindow.webContents.send('finder-drop', filePath, clientX);
});

// ─── IPC: Window controls (Windows only) ────────────────────────────────────
ipcMain.on('win-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => { if (mainWindow) mainWindow.close(); });

// ─── IPC: Prefs ─────────────────────────────────────────────────────────────
ipcMain.handle('load-prefs', async () => loadPrefs());
ipcMain.handle('save-prefs', async (_, p) => { savePrefs(p); return true; });

// ─── IPC: Volumes — fast, non-blocking ──────────────────────────────────────
ipcMain.handle('get-volumes', async () => {
  // Run synchronously but only called once, in background after window shows
  return getMountedVolumes();
});

function getMountedVolumes() {
  const volumes = [];
  if (process.platform === 'win32') return getMountedVolumesWin();
  if (process.platform !== 'darwin') return volumes;

  // Network detection
  const networkPaths = new Set();
  try {
    for (const line of execSync('mount', { encoding:'utf8', timeout:2000 }).split('\n')) {
      if (/smbfs|afpfs|nfs|webdav|ftpfs/.test(line)) {
        const m = line.match(/on\s+(.+?)\s+\(/);
        if (m) networkPaths.add(m[1].trim());
      }
    }
  } catch (_) {}

  let entries = [];
  try { entries = fs.readdirSync('/Volumes'); } catch (_) { return volumes; }

  // Root device for system detection
  let rootDev = null;
  try { rootDev = fs.statSync('/').dev; } catch (_) {}

  for (const name of entries) {
    const fullPath = '/Volumes/' + name;
    try { if (!fs.statSync(fullPath).isDirectory()) continue; } catch (_) { continue; }

    let isSystem = false, isNetwork = networkPaths.has(fullPath);
    let fsType = 'external';

    // Quick system check: compare device IDs first (instantaneous)
    try { if (rootDev && fs.statSync(fullPath).dev === rootDev) isSystem = true; } catch (_) {}

    if (!isNetwork && !isSystem) {
      // diskutil info — limited timeout to avoid blocking
      try {
        // execFileSync: args passed without a shell — a hostile volume name cannot inject commands
        const info = execFileSync('diskutil', ['info', fullPath],
          { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'] });
        if (/Device Location:\s+Internal/i.test(info)) isSystem = true;

        // Detect media type from Protocol field
        const proto = (info.match(/Protocol:\s+(.+)/i)||[])[1]?.trim().toLowerCase() || '';
        if      (proto.includes('secure digital') || proto.includes('sdxc') || proto.includes('sd'))  fsType = 'sdcard';
        else if (proto.includes('usb'))            fsType = 'usb';
        else if (/Solid State:\s+Yes/i.test(info)) fsType = 'ssd';
        // CFR / SxS cards often appear as USB
        const mediaName = (info.match(/Media Name:\s+(.+)/i)||[])[1]?.trim().toLowerCase() || '';
        if (mediaName.includes('sd') || mediaName.includes('card')) fsType = 'sdcard';
        if (mediaName.includes('cfr') || mediaName.includes('cfast') || mediaName.includes('sxs')) fsType = 'sdcard';
      } catch (_) {}
    }

    // Disk usage
    let totalSize=0, freeSize=0;
    try {
      const parts = execFileSync('df', ['-k', fullPath],
          { encoding:'utf8', timeout:1500, stdio:['ignore','pipe','ignore'] })
        .trim().split('\n')[1]?.trim().split(/\s+/);
      if (parts?.length >= 4) { totalSize=parseInt(parts[1])*1024; freeSize=parseInt(parts[3])*1024; }
    } catch (_) {}

    let camera = null;
    if (!isSystem && !isNetwork) { try { camera = detectCamera(fullPath) || null; } catch (_) {} }
    volumes.push({ name, path: fullPath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize-freeSize, camera });
    // Note: NO iconBase64 — icons are now rendered as SVG in renderer (zero disk I/O)
  }
  return volumes;
}

function getMountedVolumesWin() {
  const volumes = [];
  // Single PowerShell call for every drive. Previously: one process per existing
  // drive letter (up to ~4 s each) — scans could take 20-30 s with several drives.
  // No string interpolation in the command → no injection surface.
  let byLetter = new Map();
  try {
    const ps = execSync(
      'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -Property Name,Used,Free,Description,DisplayRoot | ConvertTo-Json -Compress"',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
    if (ps) {
      const parsed = JSON.parse(ps);
      for (const d of (Array.isArray(parsed) ? parsed : [parsed])) {
        if (d && typeof d.Name === 'string' && /^[A-Za-z]$/.test(d.Name)) {
          byLetter.set(d.Name.toUpperCase(), d);
        }
      }
    }
  } catch (_) {}

  // Enumerate drive letters A-Z
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drivePath = letter + ':\\';
    try {
      // Check if drive exists and is accessible
      const stat = fs.statSync(drivePath);
      if (!stat.isDirectory()) continue;
    } catch (_) { continue; }

    let name = letter + ':';
    let totalSize = 0, freeSize = 0;
    let fsType = 'usb'; // default for removable
    let isSystem = false, isNetwork = false;

    const d = byLetter.get(letter);
    if (d) {
      freeSize  = d.Free  || 0;
      totalSize = (d.Used || 0) + freeSize;
      const volName = (d.Description || '').trim();
      const displayRoot = (d.DisplayRoot || '').trim();
      if (volName) name = volName + ' (' + letter + ':)';
      // Detect network drive via DisplayRoot (UNC path like \\server\share)
      if (displayRoot.startsWith('\\\\') || displayRoot.startsWith('\\')) {
        isNetwork = true; fsType = 'network';
      } else if (letter === 'C') {
        isSystem = true; fsType = 'system';
      }
    } else if (letter === 'C') {
      // PowerShell info unavailable: detect system by letter heuristic
      isSystem = true; fsType = 'system';
    }

    let camera = null;
    if (!isSystem && !isNetwork) { try { camera = detectCamera(drivePath) || null; } catch (_) {} }
    volumes.push({
      name, path: drivePath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize - freeSize, camera
    });
  }
  return volumes;
}

// ─── IPC: Browse folder ──────────────────────────────────────────────────────
ipcMain.handle('browse-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ─── IPC: Export / import template presets (item 9) ──────────────────────────
ipcMain.handle('export-presets', async (_, data) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export template presets',
    defaultPath: 'ingesto-presets.json',
    filters: [{ name: 'INGESTO presets', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('import-presets', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Import template presets',
    properties: ['openFile'],
    filters: [{ name: 'INGESTO presets', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
  try {
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC: Resolve path info (for Finder drops) ───────────────────────────────
ipcMain.handle('resolve-path', async (_, p) => {
  try {
    // Strip trailing separators before stat (Windows paths may end with \ or /)
    const normalized = p.replace(/[\/\\]+$/, '');
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) return null;
    const name = path.basename(normalized) || normalized;
    return { name, path: normalized, isDirectory: true };
  } catch (_) { return null; }
});

// ─── IPC: Start copy — multi destinations, parallel ──────────────────────────
ipcMain.handle('start-copy', async (event, { sources, destinations, options }) => {
  cancelCopy = false;
  const allResults = [];
  for (const source of sources) {
    if (cancelCopy) break;
    const sourceResults = await performCopyMulti(source, destinations, options,
      prog => mainWindow.webContents.send('copy-progress', prog)
    );
    allResults.push(...sourceResults);

    // ── Write sentinel on the source card after successful ingest ────────
    // Conditions: at least one destination succeeded (or partial success with copied files),
    // and the source card is writable.
    if (!cancelCopy) {
      const firstOK = sourceResults.find(r => r && (r.success || r.copiedFiles > 0));
      if (options.writeSentinel === true && firstOK && firstOK._copiedForSentinel && firstOK._copiedForSentinel.length) {
        // Record every destination that succeeded, not just the first one
        const okDests = sourceResults
          .filter(r => r && (r.success || r.copiedFiles > 0))
          .map(r => r.destPath);
        try {
          await appendIngest(
            source.path,
            okDests,
            firstOK._copiedForSentinel,
            app.getVersion()
          );
        } catch (e) {
          // Sentinel write failure must never break the ingest result
          console.error('Sentinel write failed:', e.message);
        }
      }
    }
  }
  // Strip internal _copiedForSentinel from results before sending to renderer,
  // but expose the verified file list publicly as fileList for the ingest report.
  const cleaned = allResults.map(r => {
    const { _copiedForSentinel, ...rest } = r || {};
    rest.fileList = (_copiedForSentinel || []).map(f => ({ path: f.p, size: f.s, mtime: f.m }));
    return rest;
  });
  mainWindow.webContents.send('copy-complete', cleaned);
  return cleaned;
});

ipcMain.handle('cancel-copy', async () => { cancelCopy = true; return true; });

// ─── Re-copy only the files that failed verification, into the SAME folder ───
ipcMain.handle('recopy-failed', async (event, { sourcePath, sourceName, destPath, mode, proAlgo, proDoubleRead, files, destIndex, destName }) => {
  cancelCopy = false;
  const source = { name: sourceName, path: sourcePath };
  const results = await performCopyMulti(
    source, [{ path: '', name: destName || '' }],
    { mode, proAlgo, proDoubleRead, fixedDestPath: destPath, onlyRel: files },
    prog => mainWindow.webContents.send('copy-progress', { ...prog, destIndex: destIndex||0, destName: destName||'' })
  );
  const { _copiedForSentinel, ...rest } = results[0] || {};   // not re-writing the sentinel on a retry
  rest.fileList = (_copiedForSentinel || []).map(f => ({ path: f.p, size: f.s, mtime: f.m }));
  return rest;
});

// ─── Copy engine — read the source ONCE, write to every destination ─────────
// Multi-destination used to launch one full copy per destination in parallel,
// making N simultaneous read passes over the same card that competed for the
// (usually slow) source medium. The fan-out engine reads each file once and
// streams the chunks to all destinations at the same time.

// Force a file's data out of the OS write cache onto the physical medium.
// Without this, SECURE/PRO's read-back verification can be served from RAM and
// compare the data with itself — a bad physical write would go unnoticed until
// a later Verify. Opened 'r+' (not 'r'): Windows' FlushFileBuffers requires a
// write-capable handle. Failure is non-fatal (some network mounts refuse fsync).
async function fsyncFile(fp) {
  let fh = null;
  try { fh = await fs.promises.open(fp, 'r+'); await fh.sync(); }
  catch (_) {}
  finally { if (fh) { try { await fh.close(); } catch (_) {} } }
}

// Read src once; write simultaneously to every path in destFiles.
// Per-destination failures don't stop the others. Resolves with
// { digest, failed } where failed[i] is the Error for destination i (or null),
// and digest is the source fingerprint when a hasher is provided.
// Rejects only when the SOURCE read itself fails (which affects every dest).
function copyFanOut(src, destFiles, onBytes, hasher) {
  return new Promise((resolve, reject) => {
    if (hasher) hasher.init();
    const rs = fs.createReadStream(src, { highWaterMark: 8*1024*1024 });
    const N = destFiles.length;
    const wss = new Array(N);
    const state = new Array(N).fill('open');   // open | done | failed
    const failed = new Array(N).fill(null);
    let pendingFinish = N, readEnded = false, settled = false;

    const maybeSettle = () => {
      if (settled || !readEnded || pendingFinish > 0) return;
      settled = true;
      resolve({ digest: hasher ? hasher.digest() : null, failed });
    };
    const failDest = (i, err) => {
      if (state[i] !== 'open') return;
      state[i] = 'failed';
      failed[i] = err || new Error('write failed');
      pendingFinish--;
      try { wss[i].destroy(); } catch (_) {}
      if (state.every(s => s === 'failed')) {
        // No destination left — stop reading the source.
        try { rs.destroy(); } catch (_) {}
        readEnded = true;
      }
      maybeSettle();
    };

    for (let i = 0; i < N; i++) {
      const ws = fs.createWriteStream(destFiles[i]);
      wss[i] = ws;
      ws.on('error', e => failDest(i, e));
      ws.on('finish', () => {
        if (state[i] !== 'open') return;
        state[i] = 'done'; pendingFinish--; maybeSettle();
      });
    }

    rs.on('data', chunk => {
      if (hasher) { try { hasher.update(chunk); } catch (_) {} }
      onBytes(chunk.length);
      const slow = [];
      for (let i = 0; i < N; i++) {
        if (state[i] !== 'open') continue;
        if (!wss[i].write(chunk)) slow.push(i);
      }
      if (slow.length) {
        // Backpressure: pause the read until every lagging destination drained.
        // 'close' also unblocks so a failing destination can't stall the read.
        rs.pause();
        let remaining = slow.length;
        const oneDone = () => { if (--remaining === 0 && !settled) rs.resume(); };
        for (const i of slow) {
          const ws = wss[i];
          const onDrain = () => { cleanup(); oneDone(); };
          const onGone  = () => { cleanup(); oneDone(); };
          const cleanup = () => {
            ws.removeListener('drain', onDrain);
            ws.removeListener('close', onGone);
          };
          ws.once('drain', onDrain);
          ws.once('close', onGone);
        }
      }
    });
    rs.on('end', () => {
      readEnded = true;
      for (let i = 0; i < N; i++) { if (state[i] === 'open') wss[i].end(); }
      maybeSettle();
    });
    rs.on('error', err => {
      for (let i = 0; i < N; i++) {
        if (state[i] === 'open') { state[i]='failed'; failed[i]=err; pendingFinish--; try { wss[i].destroy(); } catch (_) {} }
      }
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Copy one source to every destination. Returns one result object PER
// destination (same shape as the former per-destination engine, so the
// renderer and the sentinel logic are unchanged).
async function performCopyMulti(source, destinations, options, onProgress) {
  const t0 = Date.now();
  let tCopyEnd=0, tV1End=0, tV2End=0;
  let copiedBytes=0, totalBytes=0, totalFiles=0;
  const isPro    = options.mode === 'pro';
  const isSecure = options.mode === 'slow';
  const proAlgo  = options.proAlgo || 'xxh128';
  const cksumAlgo = isPro ? proAlgo : 'xxh64';        // SECURE fingerprints are xxHash64
  const hasher   = (isPro || isSecure) ? await newProHasher(isPro ? proAlgo : 'xxh64') : null;
  const proDouble = isPro && options.proDoubleRead === true;
  const folderName = options.fixedDestPath ? '' : buildFolderName(options.folderTemplate, source);
  const destNames  = destinations.map(d => d.name).filter(Boolean).join(' + ');

  // Per-destination state
  const R = destinations.map((d, i) => ({
    di: i,
    name: d.name || '',
    destPath: options.fixedDestPath || path.join(d.path, folderName),
    active: true,
    copiedFiles: 0, errors: 0, errorList: [], failedFiles: [], unstableFiles: [],
    copied: [],               // { rel, src, dest, size, mtimeMs, srcHash, _writeOk }
    copiedForSentinel: [], cksumEntries: [],
  }));

  // ── Scan the source ONCE ────────────────────────────────────────────────
  const onlyRel = options.onlyRel ? new Set(options.onlyRel.map(p => p.replace(/\\/g,'/'))) : null;
  const allFiles=[], allDirs=[];
  const SKIP = new Set(['.DS_Store','.Spotlight-V100','.Trashes','.fseventsd','.TemporaryItems']);
  const skipKeys = new Set(options.skipKeys || []);
  const SENTINEL_FILENAME = '.ingesto.json';
  (function scan(dir) {
    let entries; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch(_){return;}
    if (!entries.length) { allDirs.push(dir); return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.name === SENTINEL_FILENAME && dir === source.path) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { allDirs.push(full); scan(full); }
        else {
          const s=fs.statSync(full);
          const rel = path.relative(source.path, full).replace(/\\/g, '/');
          if (onlyRel && !onlyRel.has(rel)) continue;
          if (skipKeys.size) {
            const key = `${rel}|${s.size}|${Math.floor(s.mtimeMs/1000)}`;
            if (skipKeys.has(key)) continue;
          }
          allFiles.push({src:full,size:s.size,mtimeMs:s.mtimeMs,rel});
          totalBytes+=s.size;
        }
      } catch(_) {}
    }
  })(source.path);
  totalFiles = allFiles.length;

  // ── Destination roots, folder tree, note file ───────────────────────────
  for (const r of R) {
    try { fs.mkdirSync(r.destPath, {recursive:true}); }
    catch (e) {
      r.active = false; r.errors++;
      r.errorList.push({ file:'(destination)', error:e.message, phase:'copy' });
    }
  }
  const srcNote = source.note || options.note || '';
  if (!options.fixedDestPath && srcNote && srcNote.trim()) {
    const noteFileName = `${source.counter || '001'}_note.txt`;
    const sep = '-'.repeat(40);
    const noteContent = [
      'ingesto - Shooting Note', sep,
      'Date    : ' + new Date().toLocaleString(),
      'Counter : ' + (source.counter || '001'),
      'Card    : ' + source.name,
      'Operator: ' + (source.cameraman || 'Unknown'),
      'Camera  : ' + (source.camera || 'Unknown'),
      sep, '', srcNote.trim(), ''
    ].join('\n');
    for (const r of R) {
      if (!r.active) continue;
      try { fs.writeFileSync(path.join(r.destPath, noteFileName), noteContent, 'utf8'); }
      catch (e) { console.error('Note file write failed:', e.message); }
    }
  }
  if (!onlyRel) {
    for (const d of allDirs) {
      const rel = path.relative(source.path, d);
      let st=null; try { st=fs.statSync(d); } catch(_){}
      for (const r of R) {
        if (!r.active) continue;
        try {
          const dd = path.join(r.destPath, rel);
          fs.mkdirSync(dd,{recursive:true});
          if (st) fs.utimesSync(dd,st.atime,st.mtime);
        } catch(_){}
      }
    }
  }

  const spd=[], speedPush=(b,ms)=>{ if(ms>0){ spd.push(b/ms*1000); if(spd.length>12)spd.shift(); } };
  const avgSpd=()=>spd.length?spd.reduce((a,b)=>a+b)/spd.length:0;

  // ── PHASE 1 — read once, write to every destination (green bar) ─────────
  { let lastB=0, lastT=Date.now();
    for (let i=0; i<allFiles.length; i++) {
      if (cancelCopy) break;
      const act = R.filter(r=>r.active);
      if (!act.length) break;
      const file=allFiles[i], rel=file.rel;
      const destFilesAbs = act.map(r => path.join(r.destPath, rel));
      const onB = b => {
        copiedBytes+=b;
        const now=Date.now();
        if (now-lastT>=150){ speedPush(copiedBytes-lastB,now-lastT); lastB=copiedBytes; lastT=now; }
        const sp=avgSpd();
        onProgress({ sourceName:source.name, currentFile:rel, phase:'copy',
          destIndex:0, destName:destNames,
          copiedFiles:R[0].copiedFiles, totalFiles, remainingFiles:totalFiles-i-1,
          copiedBytes, totalBytes, progress:totalBytes>0?copiedBytes/totalBytes:0,
          speed:sp, eta:sp>0?(totalBytes-copiedBytes)/sp:0,
          errors:R.reduce((a,r)=>a+r.errors,0) });
      };
      try {
        if (onlyRel) for (const df of destFilesAbs) { try { fs.mkdirSync(path.dirname(df),{recursive:true}); } catch(_){} }
        const { digest, failed } = await copyFanOut(file.src, destFilesAbs, onB, hasher);
        const srcHash = digest == null ? null : String(digest);
        let st=null; try { st=fs.statSync(file.src); } catch(_){}
        for (let k=0; k<act.length; k++) {
          const r = act[k], df = destFilesAbs[k], err = failed[k];
          if (err) {
            r.errors++; r.errorList.push({file:rel,error:err.message,phase:'copy'}); r.failedFiles.push(rel);
          } else {
            if (st) { try { fs.chmodSync(df,st.mode); fs.utimesSync(df,st.atime,st.mtime); } catch(_){} }
            // SECURE/PRO: commit to the physical medium before verify reads it back
            if (isPro || isSecure) await fsyncFile(df);
            r.copiedFiles++;
            r.copied.push({rel,src:file.src,dest:df,size:file.size,mtimeMs:file.mtimeMs,srcHash});
          }
        }
      } catch(e){
        // Source read failure — the file failed for every active destination
        for (const r of act) { r.errors++; r.errorList.push({file:rel,error:e.message,phase:'copy'}); r.failedFiles.push(rel); }
      }
    }
  }
  tCopyEnd = Date.now(); tV1End = tCopyEnd; tV2End = tCopyEnd;

  // ── PHASE 2 — VERIFY each destination (blue), then optional source pass ─
  if (!cancelCopy && (options.mode==='normal' || options.mode==='slow' || isPro)) {
    spd.length=0;
    // Unique source files copied OK to at least one destination (for the PRO
    // double-read pass, which now reads the source ONCE — not once per dest).
    const srcByRel = new Map();
    for (const r of R) for (const c of r.copied) if (!srcByRel.has(c.rel)) srcByRel.set(c.rel, c);
    const destPassTotal = R.reduce((a,r)=>a + r.copied.reduce((x,c)=>x+c.size,0), 0);
    const srcPassTotal  = proDouble ? [...srcByRel.values()].reduce((a,c)=>a+c.size,0) : 0;
    const verifyTotalBytes = destPassTotal + srcPassTotal;
    const totalSteps = R.reduce((a,r)=>a+r.copied.length,0) + (proDouble ? srcByRel.size : 0);
    let verifiedBytes=0, verifiedFiles=0, lastB=0, lastT=Date.now();
    let passBytes=0, passTotal=destPassTotal;
    const emit=(cur,pass,di,dn)=>{
      const now=Date.now();
      if (now-lastT>=120){ speedPush(verifiedBytes-lastB,now-lastT); lastB=verifiedBytes; lastT=now; }
      const sp=avgSpd();
      onProgress({ sourceName:source.name, currentFile:cur, phase:'verify',
        destIndex:di, destName:dn,
        copiedFiles:verifiedFiles, totalFiles:totalSteps, remainingFiles:totalSteps-verifiedFiles,
        copiedBytes:verifiedBytes, totalBytes:verifyTotalBytes||1,
        progress:verifyTotalBytes>0?verifiedBytes/verifyTotalBytes:1,
        passProgress: passTotal>0 ? passBytes/passTotal : 1,
        speed:sp, eta:sp>0?(verifyTotalBytes-verifiedBytes)/sp:0,
        errors:R.reduce((a,r)=>a+r.errors,0), pass });
    };

    // 2a — verify every destination against the fingerprint taken during copy
    for (const r of R) {
      for (const c of r.copied) {
        if (cancelCopy) break;
        let okv=false;
        try {
          if (isPro || isSecure) {
            if (await hashPro(c.dest,hasher) !== c.srcHash) throw new Error(isPro?'checksum mismatch':'xxHash mismatch');
          } else {
            if (fs.statSync(c.src).size !== fs.statSync(c.dest).size) throw new Error('Size mismatch');
          }
          okv=true;
        } catch(e){ r.errors++; r.errorList.push({file:c.rel,error:e.message,phase:'verify'}); r.failedFiles.push(c.rel); }
        c._writeOk = okv;
        if (okv && !proDouble) {
          r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000) });
          if (isPro || isSecure) r.cksumEntries.push({ rel:c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
        }
        verifiedBytes+=c.size; passBytes+=c.size; verifiedFiles++;
        emit(c.rel,'dest',r.di,r.name);
      }
      if (cancelCopy) break;
    }
    tV1End = Date.now(); tV2End = tV1End;

    // 2b — PRO double-read: re-read the SOURCE (once, whatever the number of
    // destinations) to catch a failing/unstable card.
    if (proDouble && !cancelCopy) {
      passBytes=0; passTotal=srcPassTotal;
      for (const c of srcByRel.values()) {
        if (cancelCopy) break;
        // Only meaningful if at least one destination wrote this file OK
        const holders = R.filter(r => r.copied.some(x => x.rel===c.rel && x._writeOk));
        if (holders.length) {
          let stable=false;
          try { stable = (await hashPro(c.src, hasher) === c.srcHash); }
          catch(e){ stable=false; }
          for (const r of holders) {
            if (stable) {
              r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000) });
              r.cksumEntries.push({ rel:c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
            } else {
              r.errors++;
              r.errorList.push({ file:c.rel, error:'source read unstable', phase:'source' });
              r.unstableFiles.push(c.rel);
            }
          }
        }
        verifiedBytes+=c.size; passBytes+=c.size; verifiedFiles++;
        emit(c.rel,'source',0,destNames);
      }
      tV2End = Date.now();
    }

    // Fingerprint sidecars at each destination folder root (SECURE & PRO)
    for (const r of R) {
      const wantCk = !cancelCopy && !options.fixedDestPath && options.writeChecksum !== false
                     && (isPro || isSecure) && r.cksumEntries.length;
      if (wantCk && options.cksumList !== false) {
        const ckName = writeChecksumList(r.destPath, cksumAlgo, r.cksumEntries);
        if (!ckName) r.errorList.push({ file:'(checksum list)', error:'could not be written to destination', phase:'sidecar' });
      }
      if (wantCk && isPro && options.cksumMhl === true && (proAlgo==='xxh64'||proAlgo==='md5')) {
        const mhlName = writeMHL(r.destPath, proAlgo, r.cksumEntries, { startMs:t0 });
        if (!mhlName) r.errorList.push({ file:'(MHL manifest)', error:'could not be written to destination', phase:'sidecar' });
      }
    }
  } else {
    // FAST mode — no verification; every copied file is recorded for the sentinel
    for (const r of R) for (const c of r.copied)
      r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000) });
  }

  return R.map(r => ({
    success: !cancelCopy && !r.errors, canceled: cancelCopy,
    sourceName: source.name, sourcePath: source.path, destPath: r.destPath,
    totalFiles, copiedFiles: r.copiedFiles, totalBytes, copiedBytes,
    errors: r.errors, errorList: r.errorList,
    failedFiles: r.failedFiles, unstableFiles: r.unstableFiles,
    mode: options.mode, proAlgo: isPro ? proAlgo : null,
    copyMs: tCopyEnd-t0, verify1Ms: tV1End-tCopyEnd, verify2Ms: tV2End-tV1End,
    duration: Date.now()-t0,
    _copiedForSentinel: r.copiedForSentinel,
  }));
}


function buildFolderName(tpl, src) {
  const n=new Date(), p=x=>String(x).padStart(2,'0');

  // For optional fields (cameraman, camera): replace with empty string if not set
  // so we can clean up orphan separators after
  const cameraman = (src.cameraman||'').trim();
  const camera    = (src.camera   ||'').trim();

  let result = tpl
    .replaceAll('{counter}',   src.counter          || '001')
    .replaceAll('{cardname}',  src.name             || 'CARD')
    .replaceAll('{cameraman}', cameraman)
    .replaceAll('{camera}',    camera)
    .replaceAll('{YY}',  String(n.getFullYear()).slice(-2))
    .replaceAll('{MM}',  p(n.getMonth()+1))
    .replaceAll('{DD}',  p(n.getDate()))
    .replaceAll('{HH}',  p(n.getHours()))
    .replaceAll('{MIN}', p(n.getMinutes()))
    .replaceAll('{SS}',  p(n.getSeconds()));

  // Clean up orphan separators left by empty variables:
  // e.g. "001__card___260503" → "001_card_260503"
  result = result
    .replace(/[_\-]+/g, m => m[0]) // collapse repeated separators to one
    .replace(/^[_\-]+|[_\-]+$/g, ''); // trim leading/trailing separators

  // Remove illegal filesystem chars
  return result.replace(/[<>:"|?*/\\]/g,'_');
}

// ─── IPC: Check if counter already exists in any destination ─────────────────
// Returns the first conflicting folder name found, or null if clear.
ipcMain.handle('check-counter-collision', async (_, destPaths, counter) => {
  const cnum = parseInt(counter, 10);
  if (!Number.isFinite(cnum)) return null;

  for (const destPath of destPaths) {
    try {
      const entries = fs.readdirSync(destPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const m = entry.name.match(/^(\d{1,4})(?:[_\-]|$)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n === cnum) return entry.name; // collision found
        }
      }
    } catch (_) {}
  }
  return null; // no collision
});

// ─── IPC: Scan destinations — returns { max, next } ─────────────────────────
function scanCounterInDests(destPaths) {
  let maxNum = 0;
  for (const destPath of destPaths) {
    try {
      for (const entry of fs.readdirSync(destPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const m = entry.name.match(/^(\d{1,4})(?:[_\-]|$)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
    } catch (_) {}
  }
  return { max: maxNum, next: Math.max(maxNum + 1, 1) };
}

// Legacy — kept for compatibility
ipcMain.handle('scan-dest-counter', async (_, destPaths) => {
  return scanCounterInDests(destPaths).next;
});

// New — returns both max found and next to use
ipcMain.handle('scan-dest-counter-full', async (_, destPaths) => {
  return scanCounterInDests(destPaths);
});

ipcMain.handle('open-external', async (_,url) => shell.openExternal(url));
let _psbId = null;
ipcMain.handle('set-power-block', (_, on) => {
  try {
    if (on) { if (_psbId === null || !powerSaveBlocker.isStarted(_psbId)) _psbId = powerSaveBlocker.start('prevent-app-suspension'); }
    else if (_psbId !== null && powerSaveBlocker.isStarted(_psbId)) { powerSaveBlocker.stop(_psbId); _psbId = null; }
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('ntfy-send', async (_, opts) => {
  return new Promise((resolve) => {
    try {
      const server = (opts.server || 'https://ntfy.sh').replace(/\/+$/, '');
      const url = new URL(server + '/' + encodeURIComponent(opts.topic || ''));
      const body = Buffer.from(String(opts.message || ''), 'utf8');
      const mod = url.protocol === 'http:' ? require('http') : https;
      const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length };
      if (opts.title)    headers['Title']    = String(opts.title).replace(/[^\x20-\x7E]/g, '');   // ASCII-safe
      if (opts.tags)     headers['Tags']     = String(opts.tags);
      if (opts.priority) headers['Priority'] = String(opts.priority);
      const req = mod.request(url, { method: 'POST', headers, timeout: 8000 }, res => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(body); req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
});
ipcMain.handle('is-removable', async (_, p) => {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('diskutil', ['info', p],
        { encoding: 'utf8', timeout: 5000, stdio:['ignore','pipe','ignore'] });
      return /Removable Media:\s*Removable/i.test(out);
    }
    if (process.platform === 'win32') {
      const m = String(p).match(/^([A-Za-z]):/);
      if (!m) return false;
      const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${m[1]}:'\\").DriveType"`, { encoding: 'utf8', timeout: 5000 });
      return out.trim() === '2';  // 2 = Removable Disk
    }
    return false;
  } catch (_) { return false; }
});
ipcMain.handle('report-write-named', async (_, destPath, name, content) => {
  try { fs.writeFileSync(path.join(destPath, name), content, 'utf8'); return true; }
  catch (_) { return false; }
});
ipcMain.handle('run-hook', async (_, command) => {
  try {
    const { exec } = require('child_process');
    const child = exec(command, { windowsHide: true });   // fire-and-forget
    child.on('error', () => {});
    if (child.unref) child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('report-read', async (_, destPath) => {
  // Prefer the HTML's embedded data; fall back to the JSON sidecar when HTML isn't written.
  try {
    const fp = path.join(destPath, 'INGESTO_report.html');
    const html = fs.readFileSync(fp, 'utf8');
    const m = html.match(/<script id="ingesto-report-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch (_) {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(destPath, 'INGESTO_report.json'), 'utf8'));
    if (j && Array.isArray(j.records)) return { created: j.created, records: j.records };
  } catch (_) {}
  return null;
});
ipcMain.handle('report-write', async (_, destPath, html) => {
  try { fs.writeFileSync(path.join(destPath, 'INGESTO_report.html'), html, 'utf8'); return true; }
  catch (_) { return false; }
});
ipcMain.handle('report-open', async (_, destPath) => {
  try { await shell.openPath(path.join(destPath, 'INGESTO_report.html')); return true; }
  catch (_) { return false; }
});
ipcMain.handle('disk-free', async (_, p) => {
  try { const s = fs.statfsSync(p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; }
  catch (_) { return null; }
});
ipcMain.handle('folder-size', async (_, p) => {
  try { return listAllFiles(p).reduce((a, f) => a + (f.s || 0), 0); }
  catch (_) { return null; }
});
ipcMain.handle('eject-volume', async (_, volPath) => {
  try {
    if (process.platform === 'darwin') {
      execFileSync('diskutil', ['eject', volPath], { timeout: 15000, stdio:['ignore','pipe','ignore'] });
      return { ok: true };
    }
    if (process.platform === 'win32') {
      const m = String(volPath).match(/^([A-Za-z]):/);
      if (!m) return { ok: false, error: 'no drive letter' };
      // Best-effort on Windows — may fail silently depending on config
      execSync(`powershell -NoProfile -Command "(New-Object -comObject Shell.Application).Namespace(17).ParseName('${m[1]}:').InvokeVerb('Eject')"`, { timeout: 15000 });
      return { ok: true };
    }
    return { ok: false, error: 'unsupported platform' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('reveal-path', async (_,p) => { try { await shell.openPath(p); return true; } catch(_) { return false; } });
ipcMain.handle('get-version',   async ()    => app.getVersion());

// ─── Camera auto-detection ───────────────────────────────────────────────
ipcMain.handle('detect-camera', async (_, rootPath) => {
  try { return detectCamera(rootPath) || null; }
  catch (_) { return null; }
});

// ─── Sentinel inspection (unformatted-card detection) ────────────────────
ipcMain.handle('inspect-card', async (_, rootPath, probeWrite = false) => {
  try {
    const info = inspectCard(rootPath, probeWrite);
    // Don't ship the full file list back to the renderer if huge;
    // just keep counts + a short preview (first 50 of each list).
    return {
      writable:        info.writable,
      hasSentinel:     !!info.sentinel,
      lastIngest:      info.lastIngest ? {
        date:         info.lastIngest.date,
        destination:  info.lastIngest.destination,
        files_count:  info.lastIngest.files_count,
      } : null,
      counts: {
        total:           info.allCurrent.length,
        alreadyIngested: info.alreadyIngested.length,
        newFiles:        info.newFiles.length,
      },
      // First 50 already-ingested file names (relative paths, just basename for UI)
      alreadyIngestedPreview: info.alreadyIngested.slice(0, 50).map(f => ({
        p: f.p, s: f.s,
      })),
      // Full lists used by the copy engine when user chooses "skip already"
      _alreadyIngestedKeys: info.alreadyIngested.map(f => `${f.p}|${f.s}|${f.m}`),
    };
  } catch (e) {
    return { writable: false, hasSentinel: false, lastIngest: null,
             counts: { total: 0, alreadyIngested: 0, newFiles: 0 },
             alreadyIngestedPreview: [], _alreadyIngestedKeys: [],
             error: e.message };
  }
});
