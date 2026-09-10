#!/usr/bin/env node
// A file that changes on the card WHILE it is being copied.
//
// The dangerous part is that nothing downstream notices. The checksum is taken
// over the bytes that were read, so the source and the destination agree
// perfectly, the file is delivered, the manifest vouches for it, and the
// operator formats the card. What is on the drive is a prefix, a mixture, or a
// torn file, and every check INGESTO runs says it is fine.
//
// Real causes: a camera still finalising a clip, a card unplugged and pushed
// back, a network source someone else is writing to.
//
//   node scripts/test-live-source.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-live-'));
const fresh = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };
const mk = (dir, files) => { for (const [rel, data] of Object.entries(files)) {
  const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } };

const handlers = {};
const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false };
const userData = fresh('userData');
const electron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true,
         quit: () => {}, getVersion: () => '2.6.4', getPath: () => userData, getName: () => 'ingesto',
         isPackaged: false, setAboutPanelOptions: () => {} },
  BrowserWindow: class { static getAllWindows() { return []; } },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } },
  dialog: {}, screen: {},
  shell: { openPath: async () => {}, showItemInFolder: () => {}, openExternal: async () => {} },
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return electron; return realLoad.call(this, req, ...rest); };
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
const call = (ch, ...args) => handlers[ch]({ sender: fakeWin.webContents }, ...args);


const run = (card, dst, o) => call('start-copy', {
  sources: [{ name: 'A001', path: card, counter: '001', cameraman: 'noar', camera: 'FX6' }],
  destinations: [{ name: 'D', path: dst }],
  options: { mode: 'fast', folderTemplate: '{counter}_{cardname}', writeSentinel: true,
             writeChecksum: true, cksumList: true, cksumMhl: false, ascMhl: false, ...o } });

// Sabotage at the only honest moment: the instant the engine opens the source
// for reading, which is exactly when a camera would still be writing to it.
const realCRS = fs.createReadStream;
function withSabotage(targetBase, act, fn, when) {
  fs.createReadStream = function (p, ...rest) {
    const hit = path.basename(String(p)) === targetBase;
    if (hit && when !== 'after') { try { act(String(p)); } catch (_) {} }
    const rs = realCRS.call(fs, p, ...rest);
    // 'after' fires once the last byte has been read: the file is changed
    // between the read and the check, which is the only window the byte count
    // cannot see.
    if (hit && when === 'after') rs.once('end', () => { try { act(String(p)); } catch (_) {} });
    return rs;
  };
  return Promise.resolve().then(fn).finally(() => { fs.createReadStream = realCRS; });
}

(async () => {

for (const mode of ['fast', 'normal', 'slow']) {
  console.log(`\n[${mode}] a clip that is still growing is never delivered`);
  const card = fresh(`c-grow-${mode}`), dst = fresh(`d-grow-${mode}`);
  mk(card, { 'GROWING.MOV': 'g'.repeat(4096), 'STILL.MOV': 's'.repeat(4096) });

  const r = (await withSabotage('GROWING.MOV',
    p => fs.appendFileSync(p, 'MORE'.repeat(256)),
    () => run(card, dst, { mode })))[0];

  ok(r.success === false, 'the run does not report success');
  ok(r.failedFiles.includes('GROWING.MOV'), 'the growing clip is reported as failed');
  ok(!fs.existsSync(path.join(r.destPath, 'GROWING.MOV')),
     'and it is NOT on the drive under its final name');
  ok(!fs.existsSync(path.join(r.destPath, 'GROWING.MOV.ingesto-part')),
     'nor under a temporary one');
  ok(fs.existsSync(path.join(r.destPath, 'STILL.MOV')), 'the other file is delivered normally');
  const msg = (r.errorList.find(e => e.file === 'GROWING.MOV') || {}).error || '';
  ok(/changed on the card while it was being copied/.test(msg), 'the message says what happened');
  ok(/could be read, not the/.test(msg), 'and names both readings');
  ok((r.errorList.find(e => e.file === 'GROWING.MOV') || {}).origin === 'source',
     'blamed on the card, not on the drive');
  // The manifest must not vouch for a file that was never delivered.
  const sidecars = fs.readdirSync(r.destPath).filter(n => /\.(xxh|xxh3|md5|mhl)$/.test(n))
    .map(n => fs.readFileSync(path.join(r.destPath, n), 'utf8'));
  ok(sidecars.every(t => !/GROWING\.MOV/.test(t)),
     `no manifest vouches for it (${sidecars.length} written in ${mode})`);
  if (sidecars.length) ok(sidecars.some(t => /STILL\.MOV/.test(t)),
                          'while the file that was delivered is listed');
}

console.log('\na clip rewritten in place, same size, is caught too');
{
  // The size check cannot see this one: a camera that rewrites a header, or a
  // card pulled and put back with the file re-created. Only the timestamp moved.
  const card = fresh('c-touch'), dst = fresh('d-touch');
  mk(card, { 'REWRITTEN.MOV': 'r'.repeat(4096) });
  const then = new Date(Date.now() + 60000);
  const r = (await withSabotage('REWRITTEN.MOV',
    p => fs.utimesSync(p, then, then),
    () => run(card, dst, { mode: 'slow' })))[0];

  ok(r.success === false && r.failedFiles.includes('REWRITTEN.MOV'), 'reported as failed');
  ok(!fs.existsSync(path.join(r.destPath, 'REWRITTEN.MOV')), 'and not delivered');
  ok(/written again while INGESTO was reading it/.test(
       (r.errorList.find(e => e.file === 'REWRITTEN.MOV') || {}).error || ''),
     'and the message says the file was rewritten');
}

console.log('\na clip cut short the instant the read finished is caught too');
{
  // The byte counter cannot see this one: every byte the card announced WAS
  // read. The file was replaced by a shorter one immediately afterwards, so
  // what is on the drive no longer matches what is on the card, and a Verify
  // run tomorrow would call the drive corrupt.
  const card = fresh('c-cut'), dst = fresh('d-cut');
  mk(card, { 'CUT.MOV': 'c'.repeat(4096), 'STILL.MOV': 's'.repeat(4096) });
  const r = (await withSabotage('CUT.MOV',
    p => fs.truncateSync(p, 100),
    () => run(card, dst, { mode: 'slow' }), 'after'))[0];

  ok(r.success === false && r.failedFiles.includes('CUT.MOV'), 'reported as failed');
  ok(!fs.existsSync(path.join(r.destPath, 'CUT.MOV')), 'and not delivered');
  ok(/was 4\.0 KB when the card was scanned and is 100 bytes now/.test(
       (r.errorList.find(e => e.file === 'CUT.MOV') || {}).error || ''),
     'and the message gives both sizes in plain units');
  ok(fs.existsSync(path.join(r.destPath, 'STILL.MOV')), 'the rest of the card is delivered');
}

console.log('\na drive that dies mid-file is a DRIVE failure, not a card failure');
{
  // The check above compares what was read against what the card announced.
  // But when every destination fails, the engine stops reading the card on
  // purpose, so the read is short for a reason that has nothing to do with the
  // card. Blamed on the card, a drive that filled up produced "THIS CARD COULD
  // NOT BE READ IN FULL / do not erase it, copy it again on another reader",
  // the real error (ENOSPC) was thrown away, and the fix, freeing space, was
  // nowhere on the screen.
  const card = fresh('c-enospc'), dst = fresh('d-enospc');
  mk(card, { 'BIG.MOV': 'b'.repeat(24 * 1024 * 1024) });
  const realCWS = fs.createWriteStream;
  fs.createWriteStream = function (p, ...rest) {
    const ws = realCWS.call(fs, p, ...rest);
    if (path.basename(String(p)).startsWith('BIG.MOV')) {
      let seen = 0;
      const realWrite = ws.write.bind(ws);
      ws.write = function (chunk, ...a) {
        seen += chunk.length;
        if (seen > 1024 * 1024) {
          const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC';
          process.nextTick(() => ws.emit('error', e));
          return false;
        }
        return realWrite(chunk, ...a);
      };
    }
    return ws;
  };
  let r;
  try { r = (await run(card, dst, { mode: 'fast' }))[0]; } finally { fs.createWriteStream = realCWS; }

  const e = (r.errorList || []).find(x => x.file === 'BIG.MOV') || {};
  ok(r.success === false, 'the run fails');
  ok(e.origin === 'destination', `blamed on the drive, not the card (origin=${e.origin})`);
  ok(/ENOSPC/.test(e.error || ''), `and the real error survives ("${String(e.error).slice(0, 60)}")`);
  ok(!/changed on the card/.test(e.error || ''), 'nothing accuses the card of moving');
}

console.log('\na card that stops answering right after the read is not trusted either');
{
  // The three readings need the card to still be there afterwards. When the
  // stat itself fails (the card pulled between the last chunk and the check, a
  // network source that went away), a SHORT read used to fall through the whole
  // check: the truncated file was promoted to its real name, the checksum was
  // taken over what had been read, the manifest vouched for it, and Verify
  // passed over it for ever after.
  const card = fresh('c-gone'), dst = fresh('d-gone');
  mk(card, { 'GONE.MOV': 'g'.repeat(8 * 1024 * 1024) });
  const target = path.join(card, 'GONE.MOV');
  const realCRS2 = fs.createReadStream, realStat = fs.statSync;
  fs.createReadStream = function (p, ...rest) {
    if (String(p) === target) {
      // The file shrinks the instant before it is read, so the read is short
      // and ends CLEANLY: every destination writes what it was given and is
      // perfectly happy. Then the card stops answering.
      try { realStat.call(fs, target); fs.truncateSync(target, 1024 * 1024); } catch (_) {}
      const rs = realCRS2.call(fs, p, ...rest);
      fs.statSync = function (q, ...a) {
        if (String(q) === target) { const e = new Error('ESTALE'); e.code = 'ESTALE'; throw e; }
        return realStat.call(fs, q, ...a);
      };
      return rs;
    }
    return realCRS2.call(fs, p, ...rest);
  };
  let r;
  try { r = (await run(card, dst, { mode: 'slow' }))[0]; }
  finally { fs.createReadStream = realCRS2; fs.statSync = realStat; }

  ok(r.success === false, 'the run does not report success');
  ok((r.errorList||[]).some(e => e.origin === 'source'), 'the card is what is blamed');
  ok(!fs.existsSync(path.join(r.destPath, 'GONE.MOV')), 'the short copy is NOT delivered');
  const sidecars = fs.readdirSync(r.destPath).filter(n => /\.(xxh|xxh3|md5|mhl)$/.test(n))
    .map(n => fs.readFileSync(path.join(r.destPath, n), 'utf8'));
  ok(sidecars.every(t => !/GONE\.MOV/.test(t)), 'and no manifest vouches for it');
}

console.log('\nan ordinary card is not accused of anything');
{
  // The guard compares three readings of the same file. If any of them drifts
  // on its own, every ingest on that medium fails. This is the check that has
  // to hold on a NAS, on exFAT, and on a card with second-resolution mtimes.
  const card = fresh('c-calm'), dst = fresh('d-calm');
  const files = {};
  for (let i = 1; i <= 12; i++) files[`C${String(i).padStart(3,'0')}.MOV`] = String(i).repeat(3000 + i * 37);
  files['SUB/DEEP.MOV'] = 'd'.repeat(9000);
  mk(card, files);
  for (const mode of ['fast', 'normal', 'slow']) {
    const r = (await run(card, fresh('d-calm-' + mode), { mode }))[0];
    ok(r.success === true && r.errors === 0 && r.copiedFiles === 13,
       `${mode}: all 13 files delivered, no false accusation`);
  }
}

console.log('\nthe progress bar never goes past 100%');
{
  // A file that grew since the scan pushed the byte counter past the total: the
  // bar reported 103% and the ETA counted backwards in front of the operator.
  //
  // Checked on the source, not through the engine: progress is pushed straight
  // to the window, and there is no window in a test. A source check is worth
  // little in general, so this one is deliberately narrow: the two expressions
  // that feed the bar must be clamped.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/progress:\s*totalBytes>0\?Math\.min\(1,\s*copiedBytes\/totalBytes\)/.test(src),
     'the copy progress is clamped to 1');
  ok(/eta:\s*sp>0\?Math\.max\(0,\s*\(totalBytes-copiedBytes\)\/sp\)/.test(src),
     'and the remaining time never goes below zero');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
