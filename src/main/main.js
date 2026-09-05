/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker, clipboard } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');

// ── Update check — reads a small shared JSON hosted on GitHub ──────────────
// Same mechanism as ingesto: version.json at the repo root is the single
// source of truth. Never blocks startup, fails silently on any network issue.
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/syncto/main/version.json';
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
const UPDATE_MAX_BYTES = 64 * 1024;   // version.json is ~100 bytes
const UPDATE_HOST = 'raw.githubusercontent.com';
const RELEASES_URL = 'https://github.com/noar-justedit/syncto/releases/latest';

// GET a URL following up to 3 redirects (https.get does NOT follow them itself).
//
// Three guards that were missing: the callback can only fire once (an 'error'
// arriving after 'end' used to call it a second time), the body is capped (a
// server answering 200 and then streaming for ever grew a string in the main
// process until the app died), and a redirect may not leave the host we asked.
function fetchFollow(url, hops, cb) {
  let called = false;
  const done = v => { if (!called) { called = true; cb(v); } };
  if (hops > 3) return done(null);
  try {
    if (new URL(url).host !== UPDATE_HOST) return done(null);
    const req = https.get(url, { timeout: 4000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch (e) { return done(null); }
        called = true;                     // hand the callback to the next hop
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let body = '';
      res.on('data', c => {
        body += c;
        if (body.length > UPDATE_MAX_BYTES) { req.destroy(); done(null); }
      });
      res.on('end', () => done(body));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  } catch (e) { done(null); }
}
function checkForUpdate() {
  fetchFollow(UPDATE_URL, 0, (body) => {
    if (!body) return;
    let data; try { data = JSON.parse(body); } catch (e) { return; }
    if (!data || !data.version) return;
    if (!/^\d+(\.\d+){0,3}$/.test(String(data.version))) return;
    if (semverGt(data.version, appVersion()) && win && !win.isDestroyed()) {
      win.webContents.send('update-available', {
        version: String(data.version),
        // NEVER the url from the JSON. It ends up at shell.openExternal, and a
        // file:// or UNC value there means "run this for me" on every machine
        // that checks for updates. The releases page is where the download is.
        url: RELEASES_URL,
      });
    }
  });
}

const { MultiSession, verifyFolder, checkJobPaths, clearStaleLocks } = require('./core/session');
const { FsPool } = require('./fs/afs');
const { Prefs, defaultJob, loadJob, saveJob, jobNameFromPath, JOB_EXT, credentialMap,
        pushRecent: addRecent, removeRecent } = require('./config');
const { RemoteBrowser } = require('./fs/browse');
const secrets = require('./secrets');
const power  = require('./power');
const notify = require('./notify');

const IS_MAC = process.platform === 'darwin';
const DEV    = process.argv.includes('--dev');

let win = null;
let prefs = null;
let session = null;
let currentJobPath = '';
let powerBlockId = null;

const tokens = {
  compare: { cancelled: false },
  sync   : { cancelled: false, paused: false },
  verify : { cancelled: false },
};

function appVersion() {
  try { return require('../../package.json').version; } catch (_) { return '0.0.0'; }
}

// shell.openExternal hands the string to the operating system's "open this"
// machinery. With no scheme check, a file:// path or a UNC share means "run
// this program", and the only thing standing between that and a click was
// whoever could edit the JSON the URL came from. Web links only.
function openExternalSafely(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  shell.openExternal(parsed.toString());
  return true;
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  const w = (prefs.data.window && prefs.data.window.width)  || 1280;
  const h = (prefs.data.window && prefs.data.window.height) || 820;

  win = new BrowserWindow({
    width: w, height: h, minWidth: 1040, minHeight: 640,
    backgroundColor: '#0e0f13',
    show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: IS_MAC ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The renderer holds the whole IPC surface: reading any folder, running a
  // file with its default application, and the stored SFTP credentials. So it
  // must never be able to become a page we did not write. Without these three
  // guards, Electron's default is "allow": dropping an .html file on the
  // window navigated the main webContents, and the page that loaded kept the
  // preload bridge.
  const OWN_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  const blockNavigation = (e, url) => {
    let isOwn = false;
    try { isOwn = url.startsWith('file://') && path.normalize(new URL(url).pathname) === path.normalize(OWN_PAGE); }
    catch (_) {}
    if (!isOwn) { e.preventDefault(); openExternalSafely(url); }
  };
  win.webContents.on('will-navigate', blockNavigation);
  win.webContents.on('will-redirect', blockNavigation);
  win.webContents.on('will-attach-webview', e => e.preventDefault());

  // Belt and braces alongside the meta tag in index.html: a CSP delivered as a
  // header cannot be stripped by anything injected into the document.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; font-src 'self'; connect-src 'none'; " +
          "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        ],
      }),
    });
  });

  win.loadFile(OWN_PAGE);
  win.once('ready-to-show', () => { win.show(); if (DEV) win.webContents.openDevTools({ mode: 'detach' }); });
  win.webContents.once('did-finish-load', () => { setTimeout(checkForUpdate, 1500); });

  // Resizing fired this on EVERY pixel, and Prefs.save serialises the whole
  // configuration and writes it synchronously — in the same process that runs
  // the synchronization. Dragging a window corner during a large transfer
  // stalled the event loop and the throughput with it.
  let resizeTimer = null;
  win.on('resize', () => {
    if (!win) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!win || win.isDestroyed()) return;
      const [ww, hh] = win.getSize();
      prefs.save({ window: { width: ww, height: hh } });
    }, 400);
  });
  win.on('maximize',   () => win.webContents.send('menu', { action: 'maximized',   value: true  }));
  win.on('unmaximize', () => win.webContents.send('menu', { action: 'maximized',   value: false }));
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const send = action => () => { if (win) win.webContents.send('menu', { action }); };
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New job',      accelerator: 'CmdOrCtrl+N', click: send('job-new') },
        { label: 'Open job…',    accelerator: 'CmdOrCtrl+O', click: send('job-open') },
        { label: 'Save job',     accelerator: 'CmdOrCtrl+S', click: send('job-save') },
        { label: 'Save job as…', accelerator: 'CmdOrCtrl+Shift+S', click: send('job-save-as') },
        { type: 'separator' },
        // No accelerator on purpose: ⌘W already belongs to `role: 'close'`
        // just below, and to the Window menu. Two menu items claiming the
        // same key is a coin toss, and the one people expect ⌘W to do is
        // close the window.
        { label: 'Close job',    click: send('job-close') },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Actions',
      submenu: [
        { label: 'Compare',     accelerator: 'F5', click: send('compare') },
        { label: 'Synchronize', accelerator: 'F9', click: send('sync') },
        { type: 'separator' },
        { label: 'Swap sides',  accelerator: 'CmdOrCtrl+T', click: send('swap') },
        { label: 'Invert all directions', click: send('invert') },
        { type: 'separator' },
        { label: 'Verify a folder…', click: send('verify') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'syncto on GitHub', click: () => shell.openExternal('https://github.com/noar-justedit/syncto') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  prefs = new Prefs(app.getPath('userData'));
  prefs.load();
  // lastJobPath was written on every open and save and read by nobody, so a
  // restart detached the settings from their file: the title said "not saved
  // yet" and Ctrl+S asked for a name again — which is exactly how an existing
  // job file gets overwritten by accident.
  const last = prefs.data.lastJobPath;
  if (last && fs.existsSync(last)) currentJobPath = last;
  else if (last) prefs.save({ lastJobPath: '' });
  session = new MultiSession();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (session) { try { await session.close(); } catch (_) {} }
  if (!IS_MAC) app.quit();
});

// ── Small helpers ──────────────────────────────────────────────────────────
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function holdSleep(on) {
  if (on && powerBlockId == null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && powerBlockId != null) { try { powerSaveBlocker.stop(powerBlockId); } catch (_) {} powerBlockId = null; }
}

async function trashItem(fsx, absPath) {
  if (fsx.kind !== 'native') return false;
  try { await shell.trashItem(absPath); return true; }
  catch (_) { return false; }
}

// ── IPC: basics ────────────────────────────────────────────────────────────
ipcMain.handle('get-version', () => appVersion());
// NOT prefs.data: it carries servers[].passwordEnc and ntfy.tokenEnc. Those
// blobs are decryptable by anything running as this user, so handing them to
// the window is handing over the passwords — exactly what listServers() and
// ntfyForUi() exist to prevent. The window gets everything else.
ipcMain.handle('load-prefs',  () => {
  const d = Object.assign({}, prefs.data);
  d.servers = prefs.listServers();
  d.ntfy = prefs.ntfyForUi();
  return d;
});

// Shown once, then cleared: a migration that had to drop something has to say
// so, and saying it every launch would train the user to ignore it.
ipcMain.handle('take-migration-notes', () => {
  const notes = prefs.data.migrationNotes || [];
  if (notes.length) { prefs.data.migrationNotes = []; prefs.save(); }
  return notes;
});
ipcMain.handle('save-prefs',  (_, p) => prefs.save(p));

// `startIn` opens the picker where the folder used to be. Relinking a renamed
// folder is the case that needs it: the parent is still there, and the folder
// under its new name is sitting in it.
ipcMain.handle('browse-folder', async (_, title, startIn) => {
  const opts = {
    title: title || 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (startIn) {
    let start = String(startIn);
    // A path that no longer resolves makes the dialog fall back to the last
    // place the user browsed, which is rarely the right one. Walk up until
    // something exists.
    for (let i = 0; i < 12 && start; i++) {
      try { if (fs.statSync(start).isDirectory()) { opts.defaultPath = start; break; } } catch (_) {}
      const up = path.dirname(start);
      if (up === start) break;
      start = up;
    }
  }
  const res = await dialog.showOpenDialog(win, opts);
  return (res.canceled || !res.filePaths.length) ? null : res.filePaths[0];
});

// ── IPC: the "Connect to a server" window ──────────────────────────────────
// Its own connection, deliberately separate from the one a run uses: browsing
// a server must never disturb a synchronization in progress, and closing this
// window must never pull a connection out from under one.
const browser = new RemoteBrowser();

function friendly(err) {
  const msg = (err && err.message) || String(err);
  return { ok: false, error: msg };
}

ipcMain.handle('server-list-saved', () => ({
  servers: prefs.listServers(),
  vaultAvailable: secrets.available(),
}));

// conn.savedId names an entry whose password stays here: it is decrypted in
// this process, used, and dropped. A remembered password is never sent to the
// window — the window only ever knows that one exists. A password the user is
// typing right now obviously does travel, once, from the field it was typed in.
ipcMain.handle('server-connect', async (_, conn) => {
  try {
    let full = Object.assign({}, conn);
    if (conn && conn.savedId) {
      const kept = prefs.serverSecrets(conn.savedId);
      if (!kept) return { ok: false, error: 'That saved server is gone.' };
      full = Object.assign(kept, {
        savedId: conn.savedId,
        // Anything retyped in the window wins over what was remembered.
        password  : conn.password  || kept.password,
        passphrase: conn.passphrase || kept.passphrase,
        keyPath   : conn.keyPath   || kept.keyPath,
      });
      if (!full.password && !full.keyPath) {
        return { ok: false, error: 'needs-password', needsPassword: true };
      }
    }
    const res = await browser.connect(full);
    return Object.assign({ ok: true }, res);
  } catch (err) { return friendly(err); }
});

ipcMain.handle('server-list', async (_, dir) => {
  try { return Object.assign({ ok: true }, await browser.list(dir)); }
  catch (err) { return friendly(err); }
});

ipcMain.handle('server-mkdir', async (_, dir, name) => {
  try { return Object.assign({ ok: true }, await browser.mkdir(dir, name)); }
  catch (err) { return friendly(err); }
});

ipcMain.handle('server-save', (_, conn) => {
  try { return Object.assign({ ok: true }, prefs.saveServer(conn)); }
  catch (err) { return friendly(err); }
});

ipcMain.handle('server-forget', (_, id) => ({ ok: true, servers: prefs.removeServer(id) }));

ipcMain.handle('server-disconnect', async () => { await browser.close(); return { ok: true }; });

// The folder field's value. Built here so the renderer never has to assemble
// an sftp:// URL — and so the password can never end up inside one.
ipcMain.handle('server-url', (_, conn, folder) => RemoteBrowser.urlFor(conn, folder));

// A private key is picked from disk; only its PATH is ever stored.
ipcMain.handle('browse-key', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a private key',
    properties: ['openFile', 'showHiddenFiles'],
    defaultPath: path.join(app.getPath('home'), '.ssh'),
  });
  return (res.canceled || !res.filePaths.length) ? null : res.filePaths[0];
});

// ── IPC: after the run ─────────────────────────────────────────────────────
// The renderer runs the countdown (it owns the Cancel button); this only
// carries out the action once the countdown has expired.
// `clean` is asserted by the window, but the guard lives here too: this
// handler switches a machine off, and it must not be one forgotten branch in
// the renderer away from doing it after a run full of errors.
ipcMain.handle('after-sync', async (_, action, clean) => {
  if (clean !== true) return { ok: false, action, error: 'The run did not finish cleanly.' };
  return power.run(action, { onQuit: () => setTimeout(() => app.quit(), 200) });
});

// ── IPC: phone notifications (ntfy) ────────────────────────────────────────
ipcMain.handle('ntfy-get',  () => prefs.ntfyForUi());
ipcMain.handle('ntfy-save', (_, patch) => prefs.saveNtfy(patch || {}));

// The token comes from the stored config, not from the window — the panel
// never holds it. A token being typed right now is passed in `patch.token`.
ipcMain.handle('ntfy-test', async (_, patch) => {
  const cfg = prefs.ntfyConfig();
  const p = patch || {};
  // `undefined` means "not on screen, use what is stored"; an EMPTY string
  // means the user cleared the box and wants it tested empty. Treating the two
  // the same made "Test" pass with the old token still attached, right after
  // the user had removed it.
  const pick = (a, b) => (a === undefined ? b : a);
  return notify.send({
    server: pick(p.server, cfg.server) || cfg.server,
    topic : pick(p.topic,  cfg.topic),
    token : pick(p.token,  cfg.token),
    title : 'syncto test',
    message: 'Test notification from syncto.',
    tags  : 'bell',
  });
});

// Sent after a run. Fire and forget, always resolves: a notification must
// never be able to fail a synchronization.
ipcMain.handle('ntfy-run', async (_, res, jobName) => {
  const cfg = prefs.ntfyConfig();
  if (!cfg.enabled || !cfg.topic) return { ok: false, skipped: true };
  const clean = !res.cancelled && !res.lockLost && !(res.errors || []).length;
  if (cfg.onlyOnProblem && clean) return { ok: false, skipped: true };
  const msg = notify.forRun(res, jobName);
  return notify.sendWithRetry(Object.assign({
    server: cfg.server, topic: cfg.topic, token: cfg.token,
  }, msg));
});

ipcMain.handle('reveal-path',  (_, p) => { try { shell.showItemInFolder(p); } catch (_) {} });
ipcMain.handle('open-path',    (_, p) => shell.openPath(p));
ipcMain.handle('open-external',(_, u) => openExternalSafely(u));

// Electron's own clipboard, deliberately, and not navigator.clipboard: the
// renderer is loaded from file:// under a strict CSP, which is not a secure
// context, so the web API is either missing or silently refuses. A cap so a
// runaway list cannot hand the system clipboard a hundred megabytes.
ipcMain.handle('copy-text', (_, text) => {
  const s = String(text == null ? '' : text).slice(0, 2 * 1024 * 1024);
  try { clipboard.writeText(s); return true; } catch (_) { return false; }
});

ipcMain.handle('folder-exists', async (_, p) => {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
});

ipcMain.handle('disk-free', async (_, p) => {
  try { const s = fs.statfsSync(p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; }
  catch (_) { return null; }
});

// ── IPC: jobs ──────────────────────────────────────────────────────────────
// The list itself lives in config.js — both callers, opening and closing, use
// the same definition of it.
function pushRecent(name, p) {
  prefs.data.recent = addRecent(prefs.data.recent, name, p);
  prefs.save();
  return prefs.data.recent;
}

function openJobFile(p) {
  const job = loadJob(p);
  // The job's name is the file's name — whatever was stored inside is ignored.
  job.name = jobNameFromPath(p);
  // Auto-sync NEVER arms itself: whatever the file says, it always starts
  // disarmed and only runs after the user confirms it in this session.
  if (job.autoSync) job.autoSync.enabled = false;
  currentJobPath = p;
  prefs.save({ lastJobPath: p });
  const recent = pushRecent(job.name, p);
  return { job, path: p, recent };
}

// Every native folder this job names, stat'ed. Called when a job is opened —
// the moment a stale path can still be fixed for the price of one dialog,
// rather than after a comparison has planned a full copy against it.
// Removing a lock a previous run left behind. Never done on the way past: this
// can mean watching the file for a full minute to be sure nobody is feeding it.
ipcMain.handle('clear-locks', async (_, job, items) => {
  try {
    const results = await clearStaleLocks(job, items, {
      credentials: credentialMap(prefs.data.servers),
      token: tokens.compare,
      onStatus: st => send('lock-progress', st),
    });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('check-job-paths', async (_, job) => {
  try { return await checkJobPaths(job); }
  catch (_) { return []; }
});

ipcMain.handle('job-new', () => { currentJobPath = ''; return defaultJob(); });

// Closing a job takes it OUT of the list. It never touches the file on disk:
// a right-click menu that deletes something is a trap, and a .syncto file is
// often the only record of which two folders belong together. Reopening it is
// one OPEN away, which is exactly why removing the entry is safe.
ipcMain.handle('job-close', (_, p) => {
  const target = p || currentJobPath;
  const wasCurrent = !target || target === currentJobPath;
  if (target) prefs.data.recent = removeRecent(prefs.data.recent, target);
  if (wasCurrent) {
    currentJobPath = '';
    // Otherwise the next launch reopens the job that was just closed.
    prefs.data.lastJobPath = '';
  }
  prefs.save();
  return { recent: prefs.data.recent || [], closedCurrent: wasCurrent, path: target || '' };
});

ipcMain.handle('job-open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a syncto job',
    filters: [{ name: 'syncto job', extensions: ['syncto', 'json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  try { return openJobFile(res.filePaths[0]); }
  catch (err) {
    dialog.showErrorBox('syncto', `Could not open that job:\n${err.message}`);
    return null;
  }
});

// A click in the recent list (Zone 1) opens without a dialog. A file that
// really vanished is dropped from the list; anything else is reported.
//
// The old catch-all treated "the network share is not mounted yet" and "the
// file is damaged" as "gone" and quietly deleted the entry — losing the only
// record of where that job lived, at the exact moment the user needed it.
ipcMain.handle('job-open-path', async (_, p) => {
  try { return openJobFile(p); }
  catch (err) {
    let missing = false;
    try { fs.statSync(p); } catch (e) { missing = e.code === 'ENOENT'; }
    if (missing) {
      prefs.data.recent = removeRecent(prefs.data.recent, p);
      prefs.save();
      return { error: 'gone', recent: prefs.data.recent };
    }
    return { error: 'failed', message: err.message || String(err), path: p };
  }
});

ipcMain.handle('job-save', async (_, job, saveAs) => {
  let target = currentJobPath;
  if (saveAs || !target) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save the syncto job',
      defaultPath: `${(job.name && job.name !== 'Untitled' ? job.name : 'job').replace(/[^\w.-]+/g, '_')}${JOB_EXT}`,
      filters: [{ name: 'syncto job', extensions: ['syncto'] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
    if (!/\.syncto$/i.test(target) && !/\.syncto\.json$/i.test(target)) {
      target += JOB_EXT;
      // The system dialog checked the name the user typed. We just added an
      // extension to it, so its overwrite warning never applied to the file we
      // are about to write: typing "NAS-backup" silently replaced an existing
      // NAS-backup.syncto. Ask ourselves, since nobody else will.
      if (fs.existsSync(target)) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Replace', 'Cancel'],
          defaultId: 1, cancelId: 1,
          message: `"${path.basename(target)}" already exists.`,
          detail: 'Saving will replace the job stored in that file.',
        });
        if (response !== 0) return null;
      }
    }
  }
  try {
    // The file name IS the job name, so saving under a new name renames the job.
    job.name = jobNameFromPath(target);
    saveJob(target, job);
    currentJobPath = target;
    prefs.save({ lastJobPath: target });
    const recent = pushRecent(job.name, target);
    return { path: target, recent, name: job.name };
  } catch (err) {
    dialog.showErrorBox('syncto', `Could not save:\n${err.message}`);
    return null;
  }
});

// ── IPC: comparison ────────────────────────────────────────────────────────
ipcMain.handle('compare', async (_, job) => {
  tokens.compare.cancelled = false;
  try {
    const res = await session.compare(job, {
      token: tokens.compare,
      credentials: credentialMap(prefs.data.servers),
      onProgress: p => send('compare-progress', p),
    });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('compare-cancel', () => { tokens.compare.cancelled = true; return true; });

ipcMain.handle('get-rows', (_, offset, limit, view) => session.rows(offset, limit, view));
ipcMain.handle('get-overview', (_, view) => session.overview(view));

// Right-click → Reveal. The window sends a row index and a side; the path is
// resolved here, where the pairs, the two roots and each side's own spelling of
// the name live. When the item is gone the containing folder is opened instead
// — more useful than an error, and it is what the user was heading for anyway.
ipcMain.handle('reveal-node', (_, idx, side) => {
  try {
    const r = session.locate(idx, side === 'left' ? 'left' : 'right');
    if (r.ok) { shell.showItemInFolder(r.path); return { ok: true }; }
    if (r.fallback) { shell.openPath(r.fallback); return { ok: true, note: r.error }; }
    return { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Asked by the confirmation dialog. Anything that would make the run refuse is
// better said here, with the folders on screen and the settings one click
// away, than as an error after a run that did nothing.
ipcMain.handle('preflight', async (_, job) => {
  try { return { ok: true, warnings: await session.preflight(job, { trashItem }) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});
ipcMain.handle('visible-indices', (_, view) => session.visibleIndices(view));
ipcMain.handle('set-direction', (_, indices, dir) => session.setDirection(indices, dir));
ipcMain.handle('set-active',    (_, indices, act) => session.setActive(indices, act));
ipcMain.handle('toggle-active', (_, indices) => session.toggleActive(indices));
ipcMain.handle('invert-all',    () => session.invertAll());

// ── IPC: synchronization ───────────────────────────────────────────────────
ipcMain.handle('sync', async (_, job) => {
  tokens.sync.cancelled = false;
  tokens.sync.paused = false;
  holdSleep(true);
  try {
    const res = await session.sync(job, {
      token: tokens.sync,
      trashItem,
      appVersion: appVersion(),
      defaultReportFolder: path.join(app.getPath('documents'), 'syncto reports'),
      onProgress: p => send('sync-progress', p),
    });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    holdSleep(false);
  }
});

ipcMain.handle('sync-cancel', () => { tokens.sync.cancelled = true; tokens.sync.paused = false; return true; });
ipcMain.handle('sync-pause',  () => { tokens.sync.paused = true;  return true; });
ipcMain.handle('sync-resume', () => { tokens.sync.paused = false; return true; });

// ── IPC: verification ──────────────────────────────────────────────────────
// One verification at a time. Two of them shared a single cancel token and a
// single progress channel: closing the second window cancelled the first, and
// the two progress streams fought over the same ring — one run appearing to go
// backwards. Refusing the second is honest and costs nothing; verifying two
// folders at once was never offered by the interface anyway.
let verifying = false;

ipcMain.handle('verify-folder', async (_, folder) => {
  if (verifying) return { ok: false, error: 'A verification is already running. Wait for it to finish.' };
  verifying = true;
  tokens.verify.cancelled = false;
  const pool = new FsPool();
  try {
    const res = await verifyFolder(pool, folder, {
      token: tokens.verify,
      credentials: credentialMap(prefs.data.servers),
      onProgress: p => send('verify-progress', p),
    });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    verifying = false;
    await pool.closeAll();
  }
});

ipcMain.handle('verify-cancel', () => { tokens.verify.cancelled = true; return true; });

// ── IPC: window chrome ─────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close',    () => win && win.close());
