// Memory check of the translation engine (2.9.1): 3000 progress events in
// French, then the number of translation records. Must stay bounded (a few
// hundred); 2.9.0 kept one per event (15 000+).
//   NODE_PATH=<playwright> node docs/notes/i18n/leak.js
const { chromium } = require('playwright');
const { open, wait } = require('./page');
(async () => {
  const b = await chromium.launch({ ...(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {}) });
  const p = await open(b, { lang: 'fr', scale: 1, startNever: true });
  await p.evaluate(() => { addToZone('src', { path: '/Volumes/A001', name: 'A001' }); addToZone('dst', { path: '/Volumes/RAID_SHOOT', name: 'RAID_SHOOT' }); });
  await wait(p, 1500);
  await p.evaluate(() => { startCopy(); }); await wait(p, 1200);
  const before = await p.evaluate(() => INGESTO_I18N.records());
  for (let k = 0; k < 6; k++) {
    await p.evaluate(async (k) => {
      for (let i = 0; i < 500; i++) {
        const base = { sourceName: 'A001', sourcePath: '/Volumes/A001', totalFiles: 168, totalBytes: 26.4e9, errors: 0 };
        window.__cb.onCopyProgress({ ...base, phase: i % 2 ? 'copy' : 'verify', pass: 'dest', destIndex: 0, destName: 'RAID_SHOOT', currentFile: 'X/C' + i + '.MXF', copiedFiles: i % 168, remainingFiles: 168 - i % 168, copiedBytes: i * 1e8, progress: (i % 100) / 100, passProgress: .5, destProgress: .5, destSpeed: 4e8, speed: 4e8, eta: 500 - i });
        if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
      }
    }, k);
    await wait(p, 100);
  }
  const after = await p.evaluate(() => INGESTO_I18N.records());
  console.log('records before', before, 'after 3000 progress events', after);
  await b.close();
})();
