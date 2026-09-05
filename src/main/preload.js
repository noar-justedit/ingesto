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

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  platform  : process.platform,
  getVersion: ()        => ipcRenderer.invoke('get-version'),

  loadPrefs : ()        => ipcRenderer.invoke('load-prefs'),
  savePrefs : (p)       => ipcRenderer.invoke('save-prefs', p),

  browseFolder : (title, startIn) => ipcRenderer.invoke('browse-folder', title, startIn),
  checkJobPaths: (job)   => ipcRenderer.invoke('check-job-paths', job),
  clearLocks   : (job, items) => ipcRenderer.invoke('clear-locks', job, items),
  revealPath   : (p)    => ipcRenderer.invoke('reveal-path', p),
  openExternal : (u)    => ipcRenderer.invoke('open-external', u),
  openPath     : (p)    => ipcRenderer.invoke('open-path', p),
  copyText     : (t)    => ipcRenderer.invoke('copy-text', t),
  diskFree     : (p)    => ipcRenderer.invoke('disk-free', p),
  folderExists : (p)    => ipcRenderer.invoke('folder-exists', p),

  jobNew     : ()        => ipcRenderer.invoke('job-new'),
  jobOpen    : ()        => ipcRenderer.invoke('job-open'),
  jobOpenPath: (p)       => ipcRenderer.invoke('job-open-path', p),
  jobSave    : (job, as) => ipcRenderer.invoke('job-save', job, as),
  jobClose   : (p)       => ipcRenderer.invoke('job-close', p),
  getOverview: (view)    => ipcRenderer.invoke('get-overview', view),
  revealNode : (idx, side)=> ipcRenderer.invoke('reveal-node', idx, side),
  preflight  : (job)     => ipcRenderer.invoke('preflight', job),
  takeMigrationNotes: () => ipcRenderer.invoke('take-migration-notes'),

  // After the run, and phone notifications. `ntfyGet` never returns the
  // access token — only whether one is stored.
  afterSync : (action)      => ipcRenderer.invoke('after-sync', action),
  ntfyGet   : ()            => ipcRenderer.invoke('ntfy-get'),
  ntfySave  : (patch)       => ipcRenderer.invoke('ntfy-save', patch),
  ntfyTest  : (patch)       => ipcRenderer.invoke('ntfy-test', patch),
  ntfyRun   : (res, name)   => ipcRenderer.invoke('ntfy-run', res, name),

  // Connect-to-a-server window. No method here ever returns a password: the
  // renderer learns that one is remembered, never what it is.
  serverListSaved : ()            => ipcRenderer.invoke('server-list-saved'),
  serverConnect   : (conn)        => ipcRenderer.invoke('server-connect', conn),
  serverList      : (dir)         => ipcRenderer.invoke('server-list', dir),
  serverMkdir     : (dir, name)   => ipcRenderer.invoke('server-mkdir', dir, name),
  serverSave      : (conn)        => ipcRenderer.invoke('server-save', conn),
  serverForget    : (id)          => ipcRenderer.invoke('server-forget', id),
  serverDisconnect: ()            => ipcRenderer.invoke('server-disconnect'),
  serverUrl       : (conn, folder)=> ipcRenderer.invoke('server-url', conn, folder),
  browseKey       : ()            => ipcRenderer.invoke('browse-key'),

  compare      : (job)  => ipcRenderer.invoke('compare', job),
  compareCancel: ()     => ipcRenderer.invoke('compare-cancel'),
  getRows      : (o,l,v)=> ipcRenderer.invoke('get-rows', o, l, v),
  setDirection : (i,d)  => ipcRenderer.invoke('set-direction', i, d),
  setActive    : (i,a)  => ipcRenderer.invoke('set-active', i, a),
  toggleActive : (i)    => ipcRenderer.invoke('toggle-active', i),
  invertAll    : ()     => ipcRenderer.invoke('invert-all'),
  visibleIndices:(v)    => ipcRenderer.invoke('visible-indices', v),

  sync        : (job)   => ipcRenderer.invoke('sync', job),
  syncCancel  : ()      => ipcRenderer.invoke('sync-cancel'),
  syncPause   : ()      => ipcRenderer.invoke('sync-pause'),
  syncResume  : ()      => ipcRenderer.invoke('sync-resume'),

  verifyFolder: (p)     => ipcRenderer.invoke('verify-folder', p),
  verifyCancel: ()      => ipcRenderer.invoke('verify-cancel'),

  onCompareProgress: cb => sub('compare-progress', cb),
  onLockProgress   : cb => sub('lock-progress', cb),
  onSyncProgress   : cb => sub('sync-progress', cb),
  onVerifyProgress : cb => sub('verify-progress', cb),
  onMenu           : cb => sub('menu', cb),
  onUpdateAvailable: cb => sub('update-available', cb),

  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose   : () => ipcRenderer.send('win-close'),

  getPathForFile: (file) => {
    try { return webUtils ? webUtils.getPathForFile(file) : (file.path || ''); }
    catch (_) { return file.path || ''; }
  },
};

function sub(channel, cb) {
  const handler = (_, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

if (process.contextIsolated) contextBridge.exposeInMainWorld('syncto', api);
else window.syncto = api;
