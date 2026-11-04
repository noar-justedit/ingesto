#!/usr/bin/env node
// The bridge between the window and the main process (src/main/preload.js),
// loaded with a stand-in for Electron: what each subscription removes.
//
//   node scripts/test-preload.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const ipcRenderer = new EventEmitter();
ipcRenderer.invoke = async () => null;
ipcRenderer.send = () => {};
let api = null;
const electron = { ipcRenderer, webUtils: null, contextBridge: { exposeInMainWorld: (name, value) => { api = value; } } };
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
vm.runInNewContext(code, { require: (m) => (m === 'electron' ? electron : require(m)), process: { contextIsolated: true, platform: 'darwin' }, console });

console.log('\nan unsubscribe removes its own listener, not the others');
{
  ok(api && typeof api.onVerifyProgress === 'function', 'the bridge is exposed');
  const got = { a: 0, b: 0 };
  const offA = api.onVerifyProgress(() => got.a++);
  api.onVerifyProgress(() => got.b++);
  ipcRenderer.emit('verify-progress', {}, { index: 1 });
  offA();
  ipcRenderer.emit('verify-progress', {}, { index: 2 });
  ok(got.a === 1, 'the listener that unsubscribed hears nothing more');
  ok(got.b === 2, 'the other listener on the same channel still hears everything');

  const seen = [];
  const off = api.onMaximizeChange(v => seen.push(v));
  const other = []; api.onMaximizeChange(v => other.push(v));
  ipcRenderer.emit('win-maximized'); off(); ipcRenderer.emit('win-unmaximized');
  ok(seen.join() === 'true' && other.join() === 'true,false', 'the same for the two channels of the window size');

  // Every on...() subscription returns its own remover.
  const subs = Object.keys(api).filter(k => /^on[A-Z]/.test(k));
  const counts = subs.map(k => {
    const before = ipcRenderer.eventNames().reduce((n, e) => n + ipcRenderer.listenerCount(e), 0);
    const offK = api[k](() => {});
    const mid = ipcRenderer.eventNames().reduce((n, e) => n + ipcRenderer.listenerCount(e), 0);
    offK();
    const after = ipcRenderer.eventNames().reduce((n, e) => n + ipcRenderer.listenerCount(e), 0);
    return [k, mid > before && after === before];
  });
  const bad = counts.filter(c => !c[1]).map(c => c[0]);
  ok(subs.length >= 8 && bad.length === 0, `every subscription (${subs.length}) removes exactly what it added` + (bad.length ? ' : ' + bad.join(', ') : ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
