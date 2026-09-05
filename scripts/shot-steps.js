// The scenario played in front of the camera. One function per shot.
// SYNCHRONIZE opens a confirmation whose OK button stays disabled until the
// preflight has answered — it probes the destination for real, which is slow on
// a NAS. Clicking before that does nothing, so the camera has to wait for it.
async function confirmRun(c, sleep) {
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    const ready = await c.eval(`
      const ok = document.getElementById('cf-ok');
      return !!(ok && !ok.disabled && document.getElementById('ov-confirm').classList.contains('open'));`);
    if (ready) break;
  }
  await c.eval(`
    const ok = document.getElementById('cf-ok');
    if (ok && !ok.disabled) ok.click();
    return 1;`);
}

module.exports = async function steps(c, { sleep }) {

  // Kill any hover tooltip left over by a synthetic click before capturing.
  const clean = () => c.eval(`document.querySelectorAll('.tooltip-float').forEach(e=>e.remove()); return 1;`);

  // ── 1. Main window — comparison done, Mirror + Verified ──────────────────
  console.log('shot 1: main');
  // The profile was seeded before launch (scripts/shot-seed.js), so this is
  // just a person opening their saved job from the recent list.
  await c.eval(`
    const it = document.querySelector('.recent-item');
    if (it) it.click();
    return 1;`);
  await sleep(800);
  await c.eval(`document.getElementById('btn-compare').click(); return 1;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const done = await c.eval(`return !document.getElementById('btn-sync').disabled;`);
    if (done) break;
  }
  await sleep(1200);
  await c.eval(`window.scrollTo(0,0); document.getElementById('gridscroll').scrollTop = 0; return 1;`);
  await sleep(400);
  await clean();
  await c.shot('syncto-main.png');

  // ── 2. Filter panel ──────────────────────────────────────────────────────
  console.log('shot 2: filter');
  await c.eval(`document.getElementById('btn-filter').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-filter.png');
  await c.eval(`document.getElementById('filter-close').click(); return 1;`);
  await sleep(600);

  // ── 3. Settings panel ────────────────────────────────────────────────────
  console.log('shot 3: settings');
  await c.eval(`document.getElementById('btn-settings').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-settings.png');
  // Same panel, scrolled to the two things 0.4.0 added: what happens when the
  // run ends, and the phone notification. They are below the fold on a 900 px
  // window, which is exactly why they need their own frame.
  await c.eval(`
    const h = document.querySelector('#ov-settings .mcard');
    const t = document.getElementById('st-ntfy-en');
    if (h && t) h.scrollTop = t.closest('.set-row').offsetTop - 90;
    return 1;`);
  await sleep(600);
  await clean();
  await c.shot('syncto-ntfy.png');
  await c.eval(`document.getElementById('set-close').click(); return 1;`);
  await sleep(600);

  // ── 3b. Connect to a server (0.3.0) ──────────────────────────────────────
  // Filled in, not connected: there is no SFTP server in the build container,
  // and a fake "connected" state would be a lie in the repository's own
  // screenshots. This is the window as it looks the moment before Connect.
  console.log('shot 3b: server');
  await c.eval(`document.getElementById('right-server').click(); return 1;`);
  await sleep(700);
  await c.eval(`
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input')); } };
    set('srv-name', 'NAS EDIT');
    set('srv-host', '192.168.1.24');
    set('srv-port', '22');
    set('srv-user', 'dit');
    set('srv-pass', '**********');
    return 1;`);
  await sleep(500);
  await clean();
  await c.shot('syncto-server.png');
  await c.eval(`document.getElementById('srv-cancel').click(); return 1;`);
  await sleep(600);

  // ── 4. Auto-sync armed (confirmation dialog) ─────────────────────────────
  console.log('shot 4: autosync');
  await c.eval(`document.getElementById('auto-switch').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-autosync.png');
  await c.eval(`
    const cancel = document.getElementById('auto-cf-cancel');
    if (cancel) cancel.click();
    return 1;`);
  await sleep(700);

  // ── 5–7. A real SECURE run: copy phase, verify phase, summary ────────────
  console.log('shot 5-7: sync run');
  await c.eval(`document.getElementById('btn-sync').click(); return 1;`);
  await confirmRun(c, sleep);

  // One eval per poll, not three: the round trip is what made the camera miss
  // the copy pass entirely on a fast disk. `pass` comes from the step strip,
  // which is the same thing the user sees lit.
  const runState = () => c.eval(`
    const t = (document.getElementById('pb-title')||{}).textContent || '';
    const pct = parseInt((document.getElementById('pb-pct')||{}).textContent, 10) || 0;
    const on = document.querySelector('#pb-steps .pb-step.on');
    return {
      title: t, pct,
      pass: on ? (on.classList.contains('verify') ? 'verify' : on.classList.contains('copy') ? 'copy' : 'tail') : '',
      done: document.getElementById('ov-summary').classList.contains('open'),
    };`);

  let gotCopy = false, gotVerify = false;
  for (let i = 0; i < 900; i++) {
    const st = await runState();
    if (!gotCopy && st.pass === 'copy' && st.pct > 8) {
      gotCopy = true; await clean(); await c.shot('syncto-sync.png');
    }
    if (!gotVerify && st.pass === 'verify') {
      gotVerify = true; await clean(); await c.shot('syncto-verify.png');
    }
    if (st.done) break;
    await sleep(60);
  }
  await sleep(1000);
  await clean();
  await c.shot('syncto-summary.png');
  await c.eval(`document.getElementById('sum-close').click(); return 1;`);
  await sleep(600);
  console.log('  copy shot:', gotCopy, '| verify shot:', gotVerify);

  // ── 8. Another machine holds the lock ────────────────────────────────────
  console.log('shot 8: lock');
  const { spawn, execSync } = require('child_process');
  execSync(`bash ${__dirname}/shot-dataset.sh`, { stdio: 'ignore' });
  // Held by a different user on a different machine name, so the screenshot
  // reads like a real second edit station rather than the build container.
  execSync('chmod -R 777 /Volumes', { stdio: 'ignore' });
  // A lock is only "somebody else's" if the install id, the machine name AND
  // the user name all differ — see processStatus in core/lock.js. So the
  // holder runs under another user, with its own HOME (hence its own install
  // id) and its own hostname in a UTS namespace.
  const holder = spawn('unshare', ['-u', 'bash', '-c',
    `hostname EDIT-2; exec su arnaud -c "HOME=/home/arnaud ${process.execPath} ${__dirname}/../test/lock-holder.js /Volumes/NAS_EDIT/PROJET_TOSCANE/01_RUSHES --forever"`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));

  await c.eval(`document.getElementById('btn-compare').click(); return 1;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await c.eval(`return !document.getElementById('btn-sync').disabled;`)) break;
  }
  await sleep(800);
  await c.eval(`document.getElementById('btn-sync').click(); return 1;`);
  await confirmRun(c, sleep);
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const t = await c.eval(`return (document.getElementById('pb-title')||{}).textContent || '';`);
    if (/Waiting for another machine/i.test(t)) { await sleep(900); break; }
  }
  await clean();
  await c.shot('syncto-lock.png');
  holder.kill('SIGTERM');
  await sleep(500);
  await c.eval(`
    const b = document.getElementById('btn-abort');
    if (b) b.click();
    return 1;`);
  await sleep(1000);
};
