#!/usr/bin/env node
// NON-NEGOTIABLE RULE: ingesto never deletes, renames or overwrites a file on a
// source card.
//
// This suite holds the rule two ways.
//
//  1. By reading the code. Every destructive filesystem call of the engine has
//     to go through the source-card lock (safeUnlink, safeRename, safeRmTree,
//     safeWriteTarget). A raw fs.unlinkSync / renameSync / rmSync / rmdirSync
//     written anywhere else fails this test, so the rule cannot erode one
//     careless line at a time. The card journal (sentinel.js) deletes nothing
//     at all, and may only write the journal's own names.
//
//  2. By running it, on real files in a temp folder: a locked card refuses
//     every deletion, rename and write, including through a symbolic link, and
//     comes out of the operations byte for byte identical.
//
//   node scripts/test-source-lock.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const SENT = fs.readFileSync(path.join(ROOT, 'src', 'main', 'sentinel.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
// Code without its comments, so that a comment quoting a forbidden call does
// not count, and a forbidden call hidden after a comment still does.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');

const DESTRUCTIVE = /\bfs\s*\.\s*(unlinkSync|renameSync|rmSync|rmdirSync|unlink|rename|rm|rmdir|truncateSync|truncate)\s*\(|\bfs\s*\.\s*promises\s*\.\s*(unlink|rename|rm|rmdir|truncate)\s*\(|\bfsp\s*\.\s*(unlink|rename|rm|rmdir|truncate)\s*\(/g;

// ── 1. The code ─────────────────────────────────────────────────────────────
console.log('\nevery destructive call of the engine goes through the lock');
{
  const GATES = ['safeUnlink', 'safeRename', 'safeRmTree'];
  let code = stripComments(MAIN);
  for (const g of GATES) code = code.replace(extractFn(code, g), '');   // the gates themselves may call fs
  const raw = [...code.matchAll(DESTRUCTIVE)].map(m => m[0]);
  ok(raw.length === 0, 'no raw delete, rename or truncate in main.js outside the lock' +
     (raw.length ? ' : ' + raw.join(', ') : ''));

  const lock = extractFn(MAIN, 'refuseOnSource');
  ok(/throw e;/.test(lock) && /INGESTO_SOURCE_LOCK/.test(lock), 'a refusal throws: the lock fails closed');
  for (const g of GATES)
    ok(/refuseOnSource\(/.test(extractFn(MAIN, g)), `${g} asks the lock before touching the filesystem`);
  ok(/refuseOnSource\('write'/.test(extractFn(MAIN, 'safeWriteTarget')),
     'opening a file for writing is checked too: on a card, truncating is deleting');
  ok(/mkWrite\(safeWriteTarget\(/.test(MAIN), 'the copy engine checks every file it opens for writing');
  ok(/safeWriteTarget\(target\); safeWriteTarget\(tmp\);/.test(extractFn(MAIN, 'writeFileAtomic')),
     'and so does every report, list and manifest written');
}

console.log('\nthe cards of a run are locked for the whole run, and only for it');
{
  const start = MAIN.slice(MAIN.indexOf("ipcMain.handle('start-copy'"), MAIN.indexOf("ipcMain.handle('recopy-failed'"));
  ok(/lockedHere\.forEach\(lockSource\)/.test(start), 'an ingest locks every card of its batch');
  ok(/finally \{[^}]*lockedHere\.forEach\(unlockSource\)/.test(start), 'and releases them in a finally, whatever happens');
  const re = MAIN.slice(MAIN.indexOf("ipcMain.handle('recopy-failed'"));
  ok(/lockSource\(sourcePath\)/.test(re.slice(0, 800)), 'a retry of failed files locks its card');
  ok(/finally \{[^}]*unlockSource\(sourcePath\)/.test(re.slice(0, 20000)), 'and releases it the same way');
}

console.log('\nthe card journal deletes nothing and writes only its own names');
{
  const code = stripComments(SENT);
  const del = [...code.matchAll(/\bfs\s*\.\s*(unlinkSync|rmSync|rmdirSync|unlink|rm|rmdir|truncateSync|truncate)\s*\(/g)].map(m => m[0]);
  ok(del.length === 0, 'no delete of any kind in sentinel.js' + (del.length ? ' : ' + del.join(', ') : ''));
  const writes = [...code.matchAll(/\bfs\s*\.\s*(renameSync|writeFileSync|appendFileSync|createWriteStream|copyFileSync)\s*\(([^)]*\)?[^,;]*)/g)];
  const unguarded = writes.filter(m => !/^\s*journalOnly\(/.test(m[2]));
  ok(writes.length > 0 && unguarded.length === 0,
     `every write and rename names its target through journalOnly (${writes.length} call(s))` +
     (unguarded.length ? ' : ' + unguarded.map(m => m[0].slice(0, 60)).join(' | ') : ''));
  ok(/fs\.renameSync\(journalOnly\(root, tmp\), journalOnly\(root, sentPath\)\)/.test(SENT),
     'the rename that installs the journal checks both of its names');
  const probe = extractFn(SENT, 'isWritable');
  ok(!/writeFileSync|openSync|unlink/.test(probe), 'the write-protect check writes nothing on the card');
  ok(/accessSync\(root, fs\.constants\.W_OK\)/.test(probe), 'it asks the system instead');
}

console.log('\nthe other modules of the engine touch no file');
for (const f of ['camera-detect.js', 'nocache.js', 'preload.js']) {
  const p = path.join(ROOT, 'src', 'main', f);
  if (!fs.existsSync(p)) continue;
  const code = stripComments(fs.readFileSync(p, 'utf8'));
  const hits = [...code.matchAll(DESTRUCTIVE)].map(m => m[0]);
  ok(hits.length === 0, `${f}: no delete, rename or truncate` + (hits.length ? ' : ' + hits.join(', ') : ''));
}

// ── 2. Running it ───────────────────────────────────────────────────────────
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-lock-'));
const CARD = path.join(TMP, 'A001_FX6');
const DEST = path.join(TMP, 'SHUTTLE_1');
fs.mkdirSync(path.join(CARD, 'PRIVATE', 'M4ROOT', 'CLIP'), { recursive: true });
fs.mkdirSync(DEST, { recursive: true });
const FOOTAGE = {
  'PRIVATE/M4ROOT/CLIP/C0001.MP4': crypto.randomBytes(4096),
  'PRIVATE/M4ROOT/CLIP/C0002.MP4': crypto.randomBytes(2048),
  // Names that look like ingesto's own scratch. They are FOOTAGE here: a folder
  // from an interrupted ingest, re-ingested as a card.
  'PRIVATE/M4ROOT/CLIP/C0003.MP4.ingesto-part': crypto.randomBytes(1024),
  'PRIVATE/M4ROOT/CLIP/C0004.MP4.ingesto-failed': crypto.randomBytes(1024),
  'notes.txt': Buffer.from('on set'),
};
for (const [rel, buf] of Object.entries(FOOTAGE)) fs.writeFileSync(path.join(CARD, rel), buf);
const snapshot = () => {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(CARD, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  })(CARD);
  return out;
};
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const BEFORE = snapshot();

const ctx = vm.createContext({ fs, path, process, console, os });
vm.runInContext([
  'const _lockedSources = new Map();',
  "const PART_SUFFIX = '.ingesto-part';",
  extractFn(MAIN, 'realpathAsFarAsPossible'),
  extractFn(MAIN, 'pathContains'),
  ...['lockSource', 'unlockSource', 'onLockedSource', 'refuseOnSource',
      'safeUnlink', 'safeRename', 'safeRmTree', 'safeWriteTarget', 'sweepPartFiles'].map(n => extractFn(MAIN, n)),
].join('\n'), ctx);
const refused = (fn) => { try { fn(); return false; } catch (e) { return e && e.code === 'INGESTO_SOURCE_LOCK'; } };

console.log('\na locked card refuses every destructive operation');
{
  ctx.console = { error() {} };      // the lock logs its refusals; keep the output readable
  ctx.lockSource(CARD);
  const clip = path.join(CARD, 'PRIVATE/M4ROOT/CLIP/C0001.MP4');
  ok(refused(() => ctx.safeUnlink(clip)), 'deleting a clip is refused');
  ok(refused(() => ctx.safeRename(clip, clip + '.bak')), 'renaming a clip is refused');
  ok(refused(() => ctx.safeRename(path.join(DEST, 'x'), clip)), 'renaming something OVER a clip is refused');
  ok(refused(() => ctx.safeRmTree(path.join(CARD, 'PRIVATE'))), 'deleting a folder of the card is refused');
  ok(refused(() => ctx.safeRmTree(CARD)), 'deleting the card itself is refused');
  ok(refused(() => ctx.safeWriteTarget(clip)), 'opening a clip for writing is refused');
  ok(refused(() => ctx.safeWriteTarget(path.join(CARD, 'new.txt'))), 'creating a file on the card is refused');

  // A destination folder that is a link to the card: the path looks like the
  // destination, the files are the card's.
  const link = path.join(DEST, 'LINK_TO_CARD');
  try { fs.symlinkSync(CARD, link, 'dir'); } catch (_) {}
  if (fs.existsSync(link)) {
    ok(refused(() => ctx.safeUnlink(path.join(link, 'notes.txt'))), 'deleting through a link that points into the card is refused');
    fs.unlinkSync(link);
  }

  // The sweep of leftover *.ingesto-part files, run by mistake on a card:
  // every deletion is refused and swallowed, the file stays.
  const n = ctx.sweepPartFiles(CARD, new Set());
  ok(n === 0, `the part-file sweep removes nothing from a locked card (${n})`);

  // The destination is not the card: it is untouched by the lock.
  const d = path.join(DEST, 'tmp.ingesto-part');
  fs.writeFileSync(d, 'x');
  let destOk = true; try { ctx.safeUnlink(d); } catch (_) { destOk = false; }
  ok(destOk && !fs.existsSync(d), 'a file on the destination is deleted normally');

  ok(same(snapshot(), BEFORE), 'after all of it, the card is byte for byte what it was');
  ctx.unlockSource(CARD);
}

console.log('\nthe lock lasts as long as the run, not the life of the app');
{
  // A shuttle drive offloaded as a source this morning is a destination this
  // afternoon. A session-long lock would refuse every write to it.
  const f = path.join(DEST, 'later.txt'); fs.writeFileSync(f, 'x');
  ctx.lockSource(DEST); ctx.lockSource(DEST);          // two runs on the same drive
  ctx.unlockSource(DEST);
  ok(refused(() => ctx.safeUnlink(f)), 'still locked while another run uses it');
  ctx.unlockSource(DEST);
  let ok2 = true; try { ctx.safeUnlink(f); } catch (_) { ok2 = false; }
  ok(ok2, 'released once no run uses it any more');
}

console.log('\nthe card journal, on a real card');
{
  const S = require(path.join(ROOT, 'src', 'main', 'sentinel.js'));
  const list = () => fs.readdirSync(CARD).sort();
  const before = list();
  S.isWritable(CARD);
  ok(JSON.stringify(list()) === JSON.stringify(before), 'checking write-protection leaves no file behind, and creates none');

  (async () => {
    const r = await S.appendIngest(CARD, [DEST], [{ p: 'notes.txt', s: 6, m: 0 }], '2.7.0', { mode: 'slow', verified: true });
    ok(r && r.ok, 'the journal is written when Card Tracking is on');
    const added = list().filter(x => !before.includes(x));
    ok(JSON.stringify(added) === JSON.stringify(['.ingesto.json']), `it is the only file added (${added.join(', ')})`);
    ok(same(snapshot(), Object.assign({}, BEFORE, { '.ingesto.json': snapshot()['.ingesto.json'] })),
       'every clip is untouched');

    // A journal it cannot read is kept, renamed, never deleted.
    fs.writeFileSync(path.join(CARD, '.ingesto.json'), '{ not json');
    const r2 = await S.appendIngest(CARD, [DEST], [{ p: 'notes.txt', s: 6, m: 0 }], '2.7.0', {});
    ok(r2 && r2.ok && fs.existsSync(path.join(CARD, '.ingesto.json.unreadable')),
       'an unreadable journal is kept beside the new one');

    // A journal write that fails leaves its working file and deletes nothing.
    const tmpAsDir = path.join(CARD, '.ingesto.json.tmp');
    fs.mkdirSync(tmpAsDir);
    const snap = snapshot();
    const r3 = await S.appendIngest(CARD, [DEST], [], '2.7.0', {});
    ok(r3 && r3.ok === false, 'a failed journal write is reported as failed');
    ok(same(snapshot(), snap) && fs.existsSync(tmpAsDir), 'and nothing on the card was deleted to clean up after it');
    fs.rmdirSync(tmpAsDir);

    // The journal cannot be pointed at another file.
    const jo = vm.runInNewContext(extractFn(SENT, 'journalOnly') + '; journalOnly',
      { path, JOURNAL_RE: /^\.ingesto\.json(\.tmp|\.unreadable(-\d+)?)?$/, Error });
    const bad = (p) => { try { jo(CARD, p); return false; } catch (e) { return e.code === 'INGESTO_SOURCE_LOCK'; } };
    ok(bad(path.join(CARD, 'PRIVATE/M4ROOT/CLIP/C0001.MP4')), 'the journal guard refuses a clip');
    ok(bad(path.join(CARD, 'PRIVATE', '.ingesto.json')), 'and its own name in a subfolder');
    ok(bad(path.join(CARD, '.ingesto.json.evil')), 'and a name that only starts like it');
    ok(!bad(path.join(CARD, '.ingesto.json')) && !bad(path.join(CARD, '.ingesto.json.unreadable-3')),
       'while its real names pass');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })().catch(e => { console.error(e); process.exit(2); });
}
