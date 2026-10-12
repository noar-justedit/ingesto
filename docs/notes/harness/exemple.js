// Exemple complet : une carte, deux destinations, une mesure, une capture.
//   node docs/notes/harness/exemple.js
const fs = require('fs');
const path = require('path');
const { launch, open } = require('./stub');

(async () => {
  const b = await launch();
  const p = await open(b);
  // On peuple l'etat en appelant les fonctions de l'appli elle-meme.
  await p.evaluate(() => {
    addToZone('src', { path: '/Volumes/A001', name: 'A001' });
    addToZone('dst', { path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' });
    addToZone('dst', { path: '/Volumes/NAS_BACKUP', name: 'NAS_BACKUP' });
  });
  await p.waitForTimeout(1500);

  // Mesurer, ne pas supposer. ATTENTION : beaucoup de boutons ont une
  // transition CSS ; lire getComputedStyle juste apres un changement de
  // classe renvoie l'ancienne valeur. Attendre ~400 ms.
  await p.waitForTimeout(400);
  console.log(await p.evaluate(() => {
    const m = document.getElementById('ins-menu');
    return { historyLines: document.querySelectorAll('.sess-row').length,
             insertMenuHeight: m ? m.scrollHeight : null };
  }));

  // Simuler un ingest en cours : open(b, { startNever:true }), puis
  //   await p.evaluate(() => { startCopy(); });
  //   await p.evaluate(() => window.__cb.onCopyProgress({ sourcePath:'/Volumes/A001', phase:'copy', progress:.4, ... }));

  const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
  await p.screenshot({ path: path.join(out, 'main.png') });
  await b.close();
})();
