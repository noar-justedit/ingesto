// Screenshot driver: launches the real app under Xvfb, drives the renderer
// through the Chrome DevTools Protocol and writes docs/screenshots/*.png.
// Nothing in the shipped code is modified.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const OUT = process.env.SHOT_OUT || path.join(__dirname, '..', 'docs', 'screenshots');
const PORT = 9333;
const W = 1440, H = 900, SCALE = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new CDP(ws);
    ws.on('message', m => {
      const msg = JSON.parse(m);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  ->', name);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const electron = require('electron');
  // On Linux, safeStorage only reports itself available when a libsecret
  // provider is reachable. Without this the connection window is photographed
  // wearing "this machine has no usable credential store", which is true of a
  // build container and false of every Mac and Windows machine the screenshot
  // is meant to describe. scripts/shots-linux.sh starts the keyring.
  const args = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'];
  if (process.platform === 'linux') args.push('--password-store=gnome-libsecret');
  const child = spawn(electron, args, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: '/home/claude/shome', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { targets = page; break; }
    } catch (_) {}
  }
  if (!targets) { child.kill(); throw new Error('devtools target not found'); }

  const c = await CDP.connect(targets.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
  });
  await sleep(2500);

  const steps = require(process.env.SHOT_STEPS || './shot-steps.js');
  await steps(c, { sleep, OUT });

  child.kill('SIGTERM');
  await sleep(800);
  try { child.kill('SIGKILL'); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
