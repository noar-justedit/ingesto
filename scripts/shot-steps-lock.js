// Lock screenshot only — re-run when the host name needs to be set first.
module.exports = async function steps(c, { sleep }) {
  const clean = () => c.eval(`document.querySelectorAll('.tooltip-float').forEach(e=>e.remove()); return 1;`);
  const { spawn, execSync } = require('child_process');
  execSync(`bash ${__dirname}/shot-dataset.sh`, { stdio: 'ignore' });
  execSync('chmod -R 777 /Volumes', { stdio: 'ignore' });

  await c.eval(`const it=document.querySelector('.recent-item'); if(it) it.click(); return 1;`);
  await sleep(1200);

  const holder = spawn('su', ['arnaud', '-c',
    `${process.execPath} ${__dirname}/../test/lock-holder.js /Volumes/NAS_EDIT/PROJET_TOSCANE/01_RUSHES --forever`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));

  await c.eval(`document.getElementById('btn-compare').click(); return 1;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await c.eval(`return !document.getElementById('btn-sync').disabled;`)) break;
  }
  await sleep(800);
  await c.eval(`document.getElementById('btn-sync').click(); return 1;`);
  await sleep(700);
  await c.eval(`const ok=document.getElementById('cf-ok'); if(ok&&document.getElementById('ov-confirm').classList.contains('open')) ok.click(); return 1;`);
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const t = await c.eval(`return (document.getElementById('pb-title')||{}).textContent || '';`);
    if (/Waiting for another machine/i.test(t)) { await sleep(900); break; }
  }
  await clean();
  await c.shot('syncto-lock.png');
  try { execSync(`pkill -u arnaud -f lock-holder`); } catch (_) {}
  holder.kill('SIGKILL');
};
