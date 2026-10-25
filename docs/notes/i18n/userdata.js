// Checks that the translation never touches what the user typed or what
// comes from the drives: card, drive, folder and template names, operator,
// camera, notes. The demo data here uses names that ARE in the French
// dictionary ("Missing", "Matched", "Copied"...): if one of them comes out
// translated anywhere, the place is listed and the check fails.
//   NODE_PATH=<playwright> node docs/notes/i18n/userdata.js
const { chromium } = require('playwright');
const { open, wait } = require('./page');

const U = { card: 'Missing', dest: 'Matched', op: 'Copied', cam: 'Stopped', folder: 'Show it again', note: 'Ignore', tpl: 'Later', preset: 'Dismiss' };

(async () => {
  const b = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
  const recs = [{ n: '001', date: '24.09.2026 09:12', card: U.card, folder: U.folder, operator: U.op, cam: U.cam, pp: 'SLOG3',
    mode: 'Secure', modeClass: 'm-secure', files: 2, bytes: 2e9, result: 'OK', rclass: 'r-ok', copyMs: 1000, v1Ms: 1000, v2Ms: 0, note: U.note,
    fileList: [{ path: U.folder + '/' + U.card + '.MXF', size: 1e9 }] }];
  const tok = [{ type: 'var', key: 'counter' }, { type: 'sep', key: '_' }, { type: 'sep', key: U.tpl }];
  const p = await open(b, { lang: 'fr', scale: 1, prefs: {
    cameraman: U.op, camera: U.cam, destPaths: [{ path: '/Volumes/' + U.dest, name: U.dest }],
    tplVersion: 2, activePreset: 0, lastTemplate: tok, presets: [{ name: U.preset, tokens: tok }, null, null, null] } });
  await p.evaluate(({ U, recs }) => {
    window.__vols[0].name = U.card; window.__vols[0].path = '/Volumes/' + U.card;
    window.__vols[2].name = U.dest; window.__vols[2].path = '/Volumes/' + U.dest;
    window.ingesto.reportRead = async () => ({ created: '2026-09-24T07:12:00Z', records: recs });
  }, { U, recs });
  await p.evaluate(() => loadVolumes && loadVolumes()).catch(() => {});
  await wait(p, 800);
  await p.evaluate(({ U }) => { addToZone('src', { path: '/Volumes/' + U.card, name: U.card }); addToZone('dst', { path: '/Volumes/' + U.dest, name: U.dest }); }, { U });
  await wait(p, 1500);
  await p.evaluate(({ U }) => { const n = document.querySelector('#src-info-list textarea'); if (n) { n.value = U.note; n.dispatchEvent(new Event('input', { bubbles: true })); } rememberOperators([U.op]); }, { U });
  await p.locator('.sess-row').first().click().catch(() => {});
  await wait(p, 600);
  const R = { success: true, canceled: false, sourceName: U.card, sourcePath: '/Volumes/' + U.card, destPath: '/Volumes/' + U.dest + '/' + U.folder, relFolder: U.folder,
    totalFiles: 2, copiedFiles: 2, totalBytes: 2e9, copiedBytes: 2e9, errors: 0, errorList: [], failedFiles: [], unstableFiles: [], notes: [], mode: 'slow', coldVerify: true,
    copyMs: 1000, verify1Ms: 1000, verify2Ms: 0, duration: 2000 };
  await p.evaluate((R) => showSummary([R]), R).catch(e => console.log('summary', e.message));
  await wait(p, 800);
  const bad = await p.evaluate((vals) => {
    const set = new Set(vals);
    return window.INGESTO_I18N.touched().filter(t => set.has(String(t.orig).trim())).map(t => {
      const el = t.node.nodeType === 1 ? t.node : t.node.parentElement;
      const chain = []; for (let e = el; e && e !== document.body && chain.length < 4; e = e.parentElement) chain.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''));
      return `${t.kind} "${t.orig}" -> "${t.applied}"   in ${chain.join(' < ')}`;
    });
  }, Object.values(U));
  console.log(bad.length ? 'TRANSLATED USER DATA:\n  ' + bad.join('\n  ') : 'ok: no user data translated');
  await b.close();
  process.exit(bad.length ? 1 : 0);
})();
