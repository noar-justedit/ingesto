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


const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Subscribes `listener` to a channel and returns the function that removes
// that listener, and only that one: another part of the window listening on
// the same channel keeps its subscription.
function subscribe(channel, listener) {
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const ingestoAPI = {
  getVolumes:           ()              => ipcRenderer.invoke('get-volumes'),
  browseFolder:         ()              => ipcRenderer.invoke('browse-folder'),
  exportPresets:        (data)          => ipcRenderer.invoke('export-presets', data),
  importPresets:        ()              => ipcRenderer.invoke('import-presets'),
  pauseCopy:            ()              => ipcRenderer.invoke('pause-copy'),
  resumeCopy:           ()              => ipcRenderer.invoke('resume-copy'),
  onPauseHeld: (cb) => {
    return subscribe('pause-held', () => cb());
  },
  exportSettings:       (data)          => ipcRenderer.invoke('export-settings', data),
  importSettings:       ()              => ipcRenderer.invoke('import-settings'),
  resolvePath:          (p)             => ipcRenderer.invoke('resolve-path', p),
  startCopy:            (args)          => ipcRenderer.invoke('start-copy', args),
  cancelCopy:           ()              => ipcRenderer.invoke('cancel-copy'),
  recopyFailed:         (args)          => ipcRenderer.invoke('recopy-failed', args),
  openExternal:         (url)           => ipcRenderer.invoke('open-external', url),
  revealPath:           (p)             => ipcRenderer.invoke('reveal-path', p),
  ejectVolume:          (p)             => ipcRenderer.invoke('eject-volume', p),
  redoDoubleRead:       (args)          => ipcRenderer.invoke('redo-double-read', args),
  isRemovable:          (p)             => ipcRenderer.invoke('is-removable', p),
  setPowerBlock:        (on)            => ipcRenderer.invoke('set-power-block', on),
  ntfySend:             (opts)          => ipcRenderer.invoke('ntfy-send', opts),
  diskFree:             (p)             => ipcRenderer.invoke('disk-free', p),
  folderSize:           (p)             => ipcRenderer.invoke('folder-size', p),
  checkPaths:           (entries)       => ipcRenderer.invoke('check-paths', entries),
  reportRead:           (p)             => ipcRenderer.invoke('report-read', p),
  handoff:              (doc, argv, keep) => ipcRenderer.invoke('handoff', doc, argv, keep),
  reportWrite:          (p,html,keep)   => ipcRenderer.invoke('report-write', p, html, keep===true),
  reportOpen:           (p)             => ipcRenderer.invoke('report-open', p),
  reportWriteNamed:     (p,name,c,app)  => ipcRenderer.invoke('report-write-named', p, name, c, app),
  runHook:              (argv, tpl)     => ipcRenderer.invoke('run-hook', argv, tpl),
  getVersion:           ()              => ipcRenderer.invoke('get-version'),
  loadPrefs:            ()              => ipcRenderer.invoke('load-prefs'),
  savePrefs:            (p)             => ipcRenderer.invoke('save-prefs', p),
  scanDestCounterFull:  (paths, tpl)    => ipcRenderer.invoke('scan-dest-counter-full', paths, tpl),
  checkCounterCollision:(paths, counter, tpl)=> ipcRenderer.invoke('check-counter-collision', paths, counter, tpl),
  detectCamera:         (p)             => ipcRenderer.invoke('detect-camera', p),
  inspectCard:          (p, probeWrite, destRoots) => ipcRenderer.invoke('inspect-card', p, probeWrite, destRoots),
  verifyFolder:         (p)             => ipcRenderer.invoke('verify-folder', p),
  cancelVerify:         ()              => ipcRenderer.invoke('cancel-verify'),
  onVerifyProgress: (cb) => {
    return subscribe('verify-progress', (_, d) => cb(d));
  },
  onCopyProgress: (cb) => {
    return subscribe('copy-progress', (_, d) => cb(d));
  },
  onCopyComplete: (cb) => {
    return subscribe('copy-complete', (_, d) => cb(d));
  },
  onFinderDrop: (cb) => {
    return subscribe('finder-drop', (_, p, clientX) => cb(p, clientX));
  },
  onVolumesChanged: (cb) => {
    return subscribe('volumes-changed', () => cb());
  },
  onUpdateAvailable: (cb) => {
    return subscribe('update-available', (_, d) => cb(d));
  },
  // A second launch is refused so two windows cannot give two cards the same
  // counter. The window says so, rather than letting it vanish without a word.
  onSecondInstance: (cb) => {
    return subscribe('second-instance-blocked', () => cb());
  },
  platform: process.platform,
  getPathForFile: (file) => {
    try { return webUtils ? webUtils.getPathForFile(file) : (file.path || ''); }
    catch(_) { return file.path || ''; }
  },
  winMinimize:  () => ipcRenderer.send('win-minimize'),
  winMaximize:  () => ipcRenderer.send('win-maximize'),
  winClose:     () => ipcRenderer.send('win-close'),
  onMaximizeChange: (cb) => {
    const offMax   = subscribe('win-maximized',   () => cb(true));
    const offUnmax = subscribe('win-unmaximized', () => cb(false));
    return () => { offMax(); offUnmax(); };
  }
};

// main.js always creates the window with contextIsolation: true, so the API
// goes through contextBridge. The other branch is a fallback for a window
// created without isolation, where contextBridge is not available.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ingesto', ingestoAPI);
} else {
  // Without isolation: exposed directly on window.
  window.ingesto = ingestoAPI;
}

