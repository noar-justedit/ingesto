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

const ingestoAPI = {
  getVolumes:           ()              => ipcRenderer.invoke('get-volumes'),
  browseFolder:         ()              => ipcRenderer.invoke('browse-folder'),
  exportPresets:        (data)          => ipcRenderer.invoke('export-presets', data),
  importPresets:        ()              => ipcRenderer.invoke('import-presets'),
  resolvePath:          (p)             => ipcRenderer.invoke('resolve-path', p),
  startCopy:            (args)          => ipcRenderer.invoke('start-copy', args),
  cancelCopy:           ()              => ipcRenderer.invoke('cancel-copy'),
  recopyFailed:         (args)          => ipcRenderer.invoke('recopy-failed', args),
  openExternal:         (url)           => ipcRenderer.invoke('open-external', url),
  revealPath:           (p)             => ipcRenderer.invoke('reveal-path', p),
  ejectVolume:          (p)             => ipcRenderer.invoke('eject-volume', p),
  isRemovable:          (p)             => ipcRenderer.invoke('is-removable', p),
  setPowerBlock:        (on)            => ipcRenderer.invoke('set-power-block', on),
  ntfySend:             (opts)          => ipcRenderer.invoke('ntfy-send', opts),
  diskFree:             (p)             => ipcRenderer.invoke('disk-free', p),
  folderSize:           (p)             => ipcRenderer.invoke('folder-size', p),
  reportRead:           (p)             => ipcRenderer.invoke('report-read', p),
  reportWrite:          (p,html)        => ipcRenderer.invoke('report-write', p, html),
  reportOpen:           (p)             => ipcRenderer.invoke('report-open', p),
  reportWriteNamed:     (p,name,c)      => ipcRenderer.invoke('report-write-named', p, name, c),
  runHook:              (cmd)           => ipcRenderer.invoke('run-hook', cmd),
  getVersion:           ()              => ipcRenderer.invoke('get-version'),
  loadPrefs:            ()              => ipcRenderer.invoke('load-prefs'),
  savePrefs:            (p)             => ipcRenderer.invoke('save-prefs', p),
  scanDestCounter:      (paths)         => ipcRenderer.invoke('scan-dest-counter', paths),
  scanDestCounterFull:  (paths)         => ipcRenderer.invoke('scan-dest-counter-full', paths),
  checkCounterCollision:(paths, counter)=> ipcRenderer.invoke('check-counter-collision', paths, counter),
  detectCamera:         (p)             => ipcRenderer.invoke('detect-camera', p),
  inspectCard:          (p, probeWrite) => ipcRenderer.invoke('inspect-card', p, probeWrite),
  verifyFolder:         (p)             => ipcRenderer.invoke('verify-folder', p),
  cancelVerify:         ()              => ipcRenderer.invoke('cancel-verify'),
  onVerifyProgress: (cb) => {
    ipcRenderer.on('verify-progress', (_, d) => cb(d));
    return () => ipcRenderer.removeAllListeners('verify-progress');
  },
  onCopyProgress: (cb) => {
    ipcRenderer.on('copy-progress', (_, d) => cb(d));
    return () => ipcRenderer.removeAllListeners('copy-progress');
  },
  onCopyComplete: (cb) => {
    ipcRenderer.on('copy-complete', (_, d) => cb(d));
    return () => ipcRenderer.removeAllListeners('copy-complete');
  },
  onFinderDrop: (cb) => {
    ipcRenderer.on('finder-drop', (_, p, clientX) => cb(p, clientX));
    return () => ipcRenderer.removeAllListeners('finder-drop');
  },
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', (_, d) => cb(d));
    return () => ipcRenderer.removeAllListeners('update-available');
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
    ipcRenderer.on('win-maximized',   () => cb(true));
    ipcRenderer.on('win-unmaximized', () => cb(false));
    return () => {
      ipcRenderer.removeAllListeners('win-maximized');
      ipcRenderer.removeAllListeners('win-unmaximized');
    };
  }
};

// With contextIsolation:false (Windows), contextBridge still works
// but we also expose directly on window as fallback
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ingesto', ingestoAPI);
} else {
  // contextIsolation:false — expose directly on window
  window.ingesto = ingestoAPI;
}

