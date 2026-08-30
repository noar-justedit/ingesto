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


const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, powerSaveBlocker } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const zlib   = require('zlib');   // ingest reports embed their data gzipped
const { execSync, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
// Run a command, resolve its stdout, and NEVER reject — an unreadable volume
// must not blow up the whole scan. Async so the main thread stays responsive
// (the old synchronous diskutil/df calls froze the UI for seconds per volume).
function tryExecFile(cmd, args, timeout) {
  return execFileP(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    .then(r => r.stdout || '')
    .catch(() => '');
}
const https = require('https');

// ── Update check — reads a small shared JSON hosted on GitHub ──────────────
// Never blocks startup, fails silently on any network issue.
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/ingesto/main/version.json';
function semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
// GET a URL following up to 3 redirects (https.get does NOT follow them itself).
// Fails silently on any network/TLS issue — never blocks or disrupts startup.
function fetchFollow(url, hops, cb) {
  if (hops > 3) return cb(null);
  try {
    const req = https.get(url, { timeout: 4000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch (e) { return cb(null); }
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200) { res.resume(); return cb(null); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => cb(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => cb(null));
  } catch (e) { cb(null); }
}
function checkForUpdate() {
  fetchFollow(UPDATE_URL, 0, (body) => {
    if (!body) return;
    let data; try { data = JSON.parse(body); } catch (e) { return; }
    // This version.json is now dedicated to INGESTO alone (one file per app,
    // each in its own repo) — no more "ingesto" wrapper key like on the old
    // shared multi-app NAS file.
    if (!data || !data.version) return;
    if (semverGt(data.version, app.getVersion()) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', { version: data.version, url: data.url || 'https://github.com/noar-justedit/ingesto/releases/latest' });
    }
  });
}

const { detectCamera }                 = require('./camera-detect');
const { inspectCard, appendIngest, listAllFiles } = require('./sentinel');
const nocache = require('./nocache');   // uncached read-back verification (macOS)

// All fingerprints (SECURE xxHash64, PRO xxHash64/128/MD5, Verify) go through
// hash-wasm — a single library, pure WASM, no native binary. INGESTO ≤ 2.0.2
// used a second library (xxhash-wasm) for SECURE, whose hex output omitted
// leading zeros and caused false "hash mismatch" results in Verify.
let _hashwasm = null;
function getHashWasm() { if (!_hashwasm) _hashwasm = require('hash-wasm'); return _hashwasm; }
const PRO_EXT = { xxh64:'.xxh', xxh128:'.xxh3', md5:'.md5' };
async function newProHasher(algo) {
  const hw = getHashWasm();
  if (algo === 'md5')   return hw.createMD5();
  if (algo === 'xxh64') return hw.createXXHash64();
  return hw.createXXHash128();               // default: xxHash128
}
// Fingerprint a file with the chosen algo (used by SECURE, PRO and Verify).
//  Every file is streamed with a bounded buffer, so RAM stays flat and the read
//  can go through the uncached path.
async function hashPro(fp, hasher) {
  hasher.init();
  // NOTE: no readFile() shortcut for small files any more. It bypassed the
  // uncached path entirely, so every file under the threshold was verified
  // against the OS cache instead of the medium — on a mixed photo/video card
  // that is most of the files. Everything goes through the (uncached on macOS)
  // stream now; the cost is negligible next to reading the media.
  return new Promise((res, rej) => {
    // Read-back for verification: uncached on macOS so it hits the medium, not
    // the RAM copy of what we just wrote.
    const s = nocache.createReadStream(fp, { highWaterMark: 4*1024*1024 });
    s.on('data', d => {
      // A hasher failure here used to be swallowed, producing a partial digest
      // reported as "checksum mismatch" — sending the operator chasing a
      // perfectly healthy card. Surface the real error instead.
      try { hasher.update(d); }
      catch (e) { try { s.destroy(); } catch(_) {} rej(e instanceof Error ? e : new Error('hash update failed')); }
    });
    // digest() can throw (a hasher used by two readers at once, an internal
    // WASM failure). Thrown from a stream listener it escaped the promise
    // entirely and took the whole main process down, killing an ingest in
    // progress. Turn it into a rejection the verify loop can report.
    s.on('end', () => { try { res(hasher.digest()); } catch (e) { rej(e instanceof Error ? e : new Error('hash digest failed')); } });
    s.on('error', rej);
  });
}
// Write a file the way the copy engine writes media: to a temp name in the same
// folder, then rename over the target. `writeFileSync` truncates the target
// FIRST, so a drive unplugged (or an app killed) mid-write left a zero-length
// manifest, report or sentinel — destroying the very record it was updating.
// Rename within a folder is atomic on every filesystem we target.
const ATOMIC_TMP_SUFFIX = '.ingesto-tmp';
function writeFileAtomic(target, content) {
  // NOT PART_SUFFIX: that one means "an interrupted media copy", and a stranded
  // manifest temp would then be reported to the user as a lost clip.
  const tmp = target + ATOMIC_TMP_SUFFIX;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}
// Write a TeraCopy-style checksum list at the root of a destination folder.
function writeChecksumList(destPath, algo, entries) {
  try {
    const ext  = PRO_EXT[algo] || '.xxh3';
    const name = path.basename(destPath) + ext;
    const lines = entries.slice()
      .sort((a,b)=> a.rel<b.rel?-1 : a.rel>b.rel?1 : 0)
      .map(e => `${e.hash} *${nfc(e.rel.replace(/\\/g,'/'))}`);
    writeFileAtomic(path.join(destPath, name), lines.join('\n') + '\n');
    return name;
  } catch(_) { return null; }
}
// Write a classic MHL (Media Hash List) manifest, mirroring what DaVinci Resolve's
// Clone Tool produces: hashlist version 1.0, one <hash> block per file. Read by
// Silverstack, YoYotta, OffShoot. Only MD5 and xxHash64 are valid in classic MHL.
function xmlEsc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // Escaped for ATTRIBUTE position too — ASC MHL puts the tool version and the
    // author name in attributes, and one quote in a user name produced a
    // manifest no parser would open.
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;')
    // A carriage return survives as a literal today, and every conforming XML
    // parser then turns it into a newline: the name that comes back out is not
    // the name on disk. Encode it instead.
    .replace(/\r/g,'&#13;')
    // Strip characters that are simply illegal in XML 1.0, so one exotic byte in
    // a filename can't produce a manifest that no parser will open.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
// Seconds-resolution ISO timestamp. A corrupt/absurd mtime (exFAT after a bad
// unmount) makes `new Date(ms)` invalid and .toISOString() throw — which used
// to abort the ENTIRE manifest. Fall back to "now" for that one file instead.
function isoSec(ms){
  let d = new Date(ms);
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/,'Z');
}
// Normalize a path to Unicode NFC. macOS stores filenames decomposed (NFD);
// Windows and most tools use composed (NFC). Without this, an accented clip
// verified across platforms shows up as BOTH missing and extra.
function nfc(s){ try { return String(s).normalize('NFC'); } catch(_) { return String(s); } }
// ─── ASC MHL v2.0 ──────────────────────────────────────────────────────────
// Written IN ADDITION to the classic .mhl, never instead of it: the classic
// manifest is what most tools on set read today, ASC MHL is where the industry
// is going. Everything here reuses fingerprints already computed during the
// ingest — nothing is hashed twice.
//
// Validated against the ASC's own reference implementation (the `ascmhl`
// Python package): our four algorithms produce byte-identical values, and the
// C4 identifier below matches theirs on a real manifest.
//
// Deliberately NOT written: directory and root hashes. They are optional in the
// schema, and the verifiers that consume ASC MHL (Pomfort MediaVerify among
// them) check the folder against the manifest's FILE LIST and then re-hash each
// file — a missing file is caught either way. A directory hash that was subtly
// wrong would make a verifier reject a perfectly good folder, which is the one
// failure this application must never produce.

const ASCMHL_ALGOS = { xxh64:'xxh64', xxh128:'xxh128', xxh3:'xxh3', md5:'md5', sha1:'sha1' };
const C4_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// C4 identifier of a buffer: SHA-512, base58, left-padded to 88 characters
// after the "c4" prefix — 90 characters in all. The chain file demands one and
// the schema makes it mandatory, so a folder without it is not an ASC MHL
// history, only something that looks like one.
async function c4Id(buf){
  const hw = getHashWasm();
  const hex = await hw.sha512(buf);
  let n = BigInt('0x' + hex), out = '';
  const B = 58n;
  while (n > 0n) { const r = n % B; out = C4_ALPHABET[Number(r)] + out; n = n / B; }
  return 'c4' + out.padStart(88, '1');
}

// ISO timestamp with a UTC offset, the shape the reference implementation emits.
function ascIso(ms){
  let d = new Date(ms);
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// Next free generation number in an existing ascmhl folder.
function ascNextSeq(dir){
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{4,})_.*\.mhl$/.exec(f);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
  } catch (_) {}
  return max + 1;
}

// destPath/ascmhl/NNNN_<folder>_<YYYY-MM-DD>_<HHMMSSZ>.mhl  +  ascmhl_chain.xml
async function writeAscMhl(destPath, algo, entries, meta){
  try {
    const tag = ASCMHL_ALGOS[algo];
    if (!tag || !entries || !entries.length) return null;
    const dir = path.join(destPath, 'ascmhl');
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const seq = ascNextSeq(dir);
    const iso = now.toISOString();                       // 2026-08-29T14:49:15.000Z
    const day = iso.slice(0, 10);
    const hms = iso.slice(11, 19).replace(/:/g, '') + 'Z';
    const folder = path.basename(destPath);
    const name = `${String(seq).padStart(4, '0')}_${folder}_${day}_${hms}.mhl`;

    let user = ''; try { user = os.userInfo().username || ''; } catch(_) {}
    const host = os.hostname() || '';
    const created = ascIso(now.getTime());

    const hashes = entries.slice()
      .sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
      .map(e => {
        const rel = nfc(String(e.rel).replace(/\\/g, '/'));
        const mt  = ascIso(e.mtimeMs || now.getTime());
        // action="verified": every entry in this list was read back from the
        // destination and compared during V1. Saying "original" would understate
        // what ingesto actually did.
        return '    <hash>\n'
             + `      <path size="${e.size || 0}" lastmodificationdate="${mt}">${xmlEsc(rel)}</path>\n`
             + `      <${tag} action="verified" hashdate="${created}">${xmlEsc(e.hash)}</${tag}>\n`
             + '    </hash>';
      }).join('\n');

    // "transfer": these files were copied here from somewhere else, which is
    // exactly what an ingest is. "in-place" would claim we merely fingerprinted
    // a folder that was already there.
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">\n'
      + '  <creatorinfo>\n'
      + `    <creationdate>${created}</creationdate>\n`
      + `    <hostname>${xmlEsc(host)}</hostname>\n`
      + `    <tool version="${xmlEsc(app.getVersion())}">ingesto</tool>\n`
      + (user ? `    <author name="${xmlEsc(user)}"></author>\n` : '')
      + '  </creatorinfo>\n'
      + '  <processinfo>\n'
      + '    <process>transfer</process>\n'
      + '    <ignore>\n'
      + '      <pattern>.DS_Store</pattern>\n'
      + '      <pattern>ascmhl</pattern>\n'
      + '    </ignore>\n'
      + '  </processinfo>\n'
      + '  <hashes>\n' + hashes + '\n  </hashes>\n'
      + '</hashlist>\n';

    writeFileAtomic(path.join(dir, name), xml);

    // The chain references every generation by its C4 identifier. It is READ
    // BACK from disk rather than hashed from the string above, so the recorded
    // identifier is the one covering the bytes that actually landed.
    const onDisk = fs.readFileSync(path.join(dir, name));
    const c4 = await c4Id(onDisk);

    const chainPath = path.join(dir, 'ascmhl_chain.xml');
    let rows = [];
    try {
      const prev = fs.readFileSync(chainPath, 'utf8');
      rows = prev.match(/<hashlist[\s\S]*?<\/hashlist>/g) || [];
    } catch (_) {}

    // A chain that is missing, empty or damaged used to be replaced by a single
    // row carrying the NEW sequence number, leaving every earlier manifest
    // unreferenced — a history with holes, written without a word. If what we
    // read does not account for every manifest in the folder, rebuild the chain
    // from the folder itself: the manifests are the truth, the chain is an index.
    const onDiskMhl = (() => {
      try {
        return fs.readdirSync(dir)
          .filter(f => /^(\d{4,})_.*\.mhl$/.test(f))
          .sort();
      } catch (_) { return []; }
    })();
    if (rows.length !== onDiskMhl.length - 1) {
      rows = [];
      for (const f of onDiskMhl) {
        if (f === name) continue;
        const n = parseInt(/^(\d{4,})_/.exec(f)[1], 10);
        let h;
        try { h = await c4Id(fs.readFileSync(path.join(dir, f))); }
        catch (_) { continue; }
        rows.push(`  <hashlist sequencenr="${n}">\n`
                + `    <path>${xmlEsc(f)}</path>\n`
                + `    <c4>${h}</c4>\n`
                + '  </hashlist>');
      }
    }

    rows.push(`  <hashlist sequencenr="${seq}">\n`
            + `    <path>${xmlEsc(name)}</path>\n`
            + `    <c4>${c4}</c4>\n`
            + '  </hashlist>');
    writeFileAtomic(chainPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<ascmhldirectory xmlns="urn:ASC:MHL:DIRECTORY:v2.0">\n'
      + rows.join('\n') + '\n'
      + '</ascmhldirectory>\n');

    return name;
  } catch (_) { return null; }
}

function writeMHL(destPath, algo, entries, meta){
  try {
    if (algo!=='md5' && algo!=='xxh64') return null;      // classic MHL: MD5 or xxHash64 only
    const tag = algo==='md5' ? 'md5' : 'xxhash64be';
    const name = path.basename(destPath) + '.mhl';
    const startIso  = isoSec(meta && meta.startMs ? meta.startMs : Date.now());
    const finishIso = isoSec(Date.now());
    let user=''; try { user = os.userInfo().username || ''; } catch(_){}
    const host = os.hostname() || '';
    const hashes = entries.slice()
      .sort((a,b)=> a.rel<b.rel?-1 : a.rel>b.rel?1 : 0)
      .map(e => {
        const rel = nfc(e.rel.replace(/\\/g,'/'));
        const mtime = isoSec(e.mtimeMs || Date.now());
        return '  <hash>\n'+
               '    <file>'+xmlEsc(rel)+'</file>\n'+
               '    <size>'+(e.size||0)+'</size>\n'+
               '    <lastmodificationdate>'+mtime+'</lastmodificationdate>\n'+
               '    <'+tag+'>'+e.hash+'</'+tag+'>\n'+
               '    <hashdate>'+finishIso+'</hashdate>\n'+
               '  </hash>';
      }).join('\n');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'+
      '<hashlist version="1.0">\n'+
      '  <creatorinfo>\n'+
      '    <username>'+xmlEsc(user)+'</username>\n'+
      '    <hostname>'+xmlEsc(host)+'</hostname>\n'+
      '    <tool>INGESTO '+app.getVersion()+'</tool>\n'+
      '    <startdate>'+startIso+'</startdate>\n'+
      '    <finishdate>'+finishIso+'</finishdate>\n'+
      '  </creatorinfo>\n'+
      hashes+'\n'+
      '</hashlist>\n';
    writeFileAtomic(path.join(destPath, name), xml);
    return name;
  } catch(_) { return null; }
}

// ── Verify Folder: read back an existing checksum list or MHL and re-check ──
const VERIFY_SKIP = new Set(['.DS_Store','.Spotlight-V100','.Trashes','.fseventsd','.TemporaryItems']);
// AppleDouble sidecars: on filesystems without native macOS metadata support
// (exFAT cards, SMB/NAS), macOS shadows every file with a "._<name>" companion
// holding Finder metadata. They are not media, and the OS rewrites them behind
// our back on the destination — so in SECURE/PRO they show up as checksum
// mismatches on files that are actually fine (reported in the field: 5/10
// "corrupted" files, all of them ._*.m4v). Skip them everywhere: transfer scan,
// sentinel tracking, and Verify's extra-file listing. Directories are never
// filtered by this (a folder legitimately named "._x" is copied normally).
function isAppleDouble(entry) {
  return entry.isFile() && entry.name.startsWith('._');
}

// Recursively list every file under root as {abs, rel} (rel uses forward slashes).
function scanDirFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return; }
    for (const e of entries) {
      if (VERIFY_SKIP.has(e.name) || isAppleDouble(e)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ abs: full, rel: nfc(path.relative(root, full).replace(/\\/g, '/')) });
    }
  })(root);
  return out;
}

// Look for a TeraCopy-style checksum list (<basename>.xxh/.xxh3/.md5) at the root
// of destPath. Prefer this over MHL when both exist — it also covers xxHash128,
// which classic MHL cannot express.
function readChecksumListFile(destPath) {
  const base = path.basename(destPath);
  const EXT_ALGO = { '.xxh':'xxh64', '.xxh3':'xxh128', '.md5':'md5' };
  for (const ext of Object.keys(EXT_ALGO)) {
    const file = base + ext;
    const fp = path.join(destPath, file);
    if (!fs.existsSync(fp)) continue;
    try {
      const lines = fs.readFileSync(fp, 'utf8').replace(/^﻿/, '').split('\n').map(l => l.replace(/\r?\n?$/, '').replace(/^\s+/, '')).filter(Boolean);
      const entries = [];
      for (const line of lines) {
        const m = line.match(/^([0-9a-fA-F]+)\s+\*(.+)$/);
        if (m) entries.push({ rel: nfc(m[2].replace(/\\/g,'/')), hash: m[1] });
      }
      if (entries.length) return { algo: EXT_ALGO[ext], file, entries };
    } catch(_) {}
  }
  return null;
}

// Look for a classic MHL (<basename>.mhl) at the root of destPath. Only MD5 and
// xxHash64 exist in classic MHL, matching what INGESTO itself ever writes.
function readMHLFile(destPath) {
  const base = path.basename(destPath);
  const file = base + '.mhl';
  const fp = path.join(destPath, file);
  if (!fs.existsSync(fp)) return null;
  try {
    const xml = fs.readFileSync(fp, 'utf8');
    const blocks = xml.match(/<hash>[\s\S]*?<\/hash>/g) || [];
    if (!blocks.length) return null;
    let algo = null;
    const entries = [];
    for (const b of blocks) {
      const relM = b.match(/<file>([\s\S]*?)<\/file>/);
      const md5M = b.match(/<md5>([0-9a-fA-F]+)<\/md5>/);
      const xxhM = b.match(/<xxhash64be>([0-9a-fA-F]+)<\/xxhash64be>/);
      if (!relM) continue;
      // Unescape in REVERSE order of xmlEsc (which does & first): &lt;/&gt; must
      // come before &amp;, or "a&amp;lt;b" wrongly becomes "a<b".
      const rel = nfc(relM[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
      // Size and modification date are parsed too, so a manifest that has to be
      // rewritten (after a retry) keeps them instead of resetting every entry
      // to size 0 and today's date.
      const szM = b.match(/<size>(\d+)<\/size>/);
      const mtM = b.match(/<lastmodificationdate>([\s\S]*?)<\/lastmodificationdate>/);
      const size = szM ? Number(szM[1]) : 0;
      let mtimeMs = 0;
      if (mtM) { const t = Date.parse(mtM[1].trim()); if (isFinite(t)) mtimeMs = t; }
      if (md5M) { algo = 'md5'; entries.push({ rel, hash: md5M[1], size, mtimeMs }); }
      else if (xxhM) { algo = 'xxh64'; entries.push({ rel, hash: xxhM[1], size, mtimeMs }); }
    }
    if (entries.length) return { algo, file, entries, complete: entries.length === blocks.length };
  } catch(_) {}
  return null;
}

// Sidecar files INGESTO itself writes — excluded from the "extra files" list,
// since they're not footage the user needs to be alerted about.
// Residue this app leaves behind on purpose: a quarantined bad copy, or a temp
// file from a run that was killed. Neither is an "extra file the user added".
function isIngestoResidue(name) {
  return name.endsWith(FAILED_SUFFIX) || name.endsWith(PART_SUFFIX);
}
// A half-written sidecar/report temp: our own bookkeeping, not the user's media.
function isIngestoTemp(name) { return name.endsWith(ATOMIC_TMP_SUFFIX); }
function isIngestoSidecar(name, destBase) {
  // `name` can be a relative path with folders, because the scan is recursive.
  // The ASC MHL history and the recovery copies of an unreadable report are
  // files INGESTO writes itself; listing them back as "extra files (not in
  // manifest)" made the operator doubt a folder the application had just
  // produced.
  if (/^ascmhl\//.test(name)) return true;
  if (/^INGESTO_report(\.unreadable)?(-\d+)?\.(html|csv|json)$/.test(name)) return true;
  return name === destBase + '.xxh' || name === destBase + '.xxh3' || name === destBase + '.md5' ||
         name === destBase + '.mhl';
}

ipcMain.handle('verify-folder', async (event, destPath) => {
  cancelVerify = false;
  const manifest = readChecksumListFile(destPath) || readMHLFile(destPath);
  if (!manifest) return { ok:false, reason:'no-manifest' };

  // Drop AppleDouble entries from OLD manifests (written before we filtered
  // them): macOS keeps rewriting those sidecars on the destination, so hashing
  // them yields the same false "corrupted ._*.m4v" the field reported. They're
  // metadata, never footage — ignore them on read too.
  manifest.entries = manifest.entries.filter(e => !path.basename(e.rel).startsWith('._'));
  const hasher = await newProHasher(manifest.algo);
  const total = manifest.entries.length;
  const matched=[], corrupted=[], missing=[];
  const manifestRels = new Set(manifest.entries.map(e => e.rel));

  for (let i=0; i<total; i++) {
    if (cancelVerify) break;
    const entry = manifest.entries[i];
    const abs = path.join(destPath, entry.rel);
    // A manifest is data, not trust: never hash a path that escapes the folder.
    if (!pathContains(destPath, abs)) { corrupted.push(entry.rel); event.sender.send('verify-progress', { index:i+1, total, currentFile:entry.rel }); continue; }
    if (!fs.existsSync(abs)) {
      missing.push(entry.rel);
    } else {
      try {
        const digest = await hashPro(abs, hasher);
        // Normalize before comparing: checksum lists written by INGESTO ≤ 2.0.2
        // in SECURE mode omit leading zeros (15-char hashes), while hash-wasm
        // always emits the full padded form. Same value, different text.
        const norm = h => String(h).toLowerCase().replace(/^0+(?=.)/, '');
        if (norm(digest) === norm(entry.hash)) matched.push(entry.rel);
        else corrupted.push(entry.rel);
      } catch(_) { corrupted.push(entry.rel); }
    }
    event.sender.send('verify-progress', { index:i+1, total, currentFile:entry.rel });
  }

  // Extra files: present on disk, not referenced by the manifest, and not an
  // INGESTO sidecar file (report/checksum list/MHL itself).
  const destBase = path.basename(destPath);
  const onDisk = scanDirFiles(destPath)
    .filter(f => !manifestRels.has(f.rel) && !isIngestoSidecar(path.basename(f.rel), destBase))
    .map(f => f.rel);
  // Quarantined copies and temp files are NOT ordinary extra files — a folder
  // holding them has a known problem and must not be reported as clean.
  const quarantined = onDisk.filter(rel => isIngestoResidue(path.basename(rel)));
  const extra = onDisk.filter(rel => !isIngestoResidue(path.basename(rel))
                                   && !isIngestoTemp(path.basename(rel)));

  return {
    ok: true, canceled: cancelVerify,
    algo: manifest.algo, manifestFile: manifest.file,
    total, matched: matched.length, corrupted, missing, extra, quarantined,
  };
});
ipcMain.handle('cancel-verify', async () => { cancelVerify = true; return true; });

let mainWindow;
let cancelCopy = false;
let pauseCopy = false;     // pause between files — never mid-file (see pauseGate)
let activeCopyCount = 0;   // guards against quitting mid-ingest — see 'before-quit' below
let forceQuit = false;     // set once the user confirms quitting despite an active ingest
let cancelVerify = false;

// ─── Preferences ────────────────────────────────────────────────────────────
const PREFS_PATH = path.join(app.getPath('userData'), 'ingesto-prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (_) { return {}; }
}
function savePrefs(p) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2)); } catch (_) {}
}

// Application menu WITHOUT "Reload" or "Toggle DevTools" — those are the two
// one-keystroke ways out of kiosk mode. Clipboard/undo shortcuts are kept via
// the built-in edit roles so text fields still behave normally.
function installAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) template.push({ role: 'appMenu' });   // About / Hide / Quit — no reload
  template.push({ role: 'editMenu' });             // undo/redo/cut/copy/paste/selectAll
  if (isMac) template.push({ role: 'windowMenu' });
  // On Windows/Linux a null menu removes the bar entirely; Chromium still
  // handles Ctrl+C/V/X/A inside inputs.
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate(template) : null);
}

// ─── Window — show IMMEDIATELY, volumes load async ──────────────────────────
function createWindow() {

  const isMac = process.platform === 'darwin';
  const winOpts = isMac ? {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }
  } : {
    titleBarStyle: 'hidden'
  };

  // Default size: as tall as the screen allows (so all template slots are visible),
  // capped at the height the content needs. Width capped to a comfortable max.
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1440, wa.width);
  const winH = Math.min(1040, wa.height);

  mainWindow = new BrowserWindow({
    width: winW, height: winH, minWidth: 1200, minHeight: 720,
    center: true,
    backgroundColor: '#0c0c0e',
    ...winOpts,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: true
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.webContents.once('did-finish-load', () => { setTimeout(checkForUpdate, 1500); });

  // SECURITY: never let the app frame navigate to remote content (which would
  // keep the privileged preload) and never let it spawn arbitrary child
  // windows. External http(s) links go to the OS browser; everything else is
  // denied. (The file:// case below is the Finder drag-and-drop channel.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href); } catch (_) {}
    return { action: 'deny' };
  });

  // Notify renderer of maximize state changes (for Windows title bar button)
  mainWindow.on('maximize',   () => mainWindow.webContents.send('win-maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win-unmaximized'));

  // Guards the window's own close (✕ button, Alt+F4, window-manager close) —
  // the main path on Windows/Linux, where it fires *before* 'before-quit' and
  // destroys the window first. Without this, an ingest could die silently:
  // mainWindow.webContents.send() would throw on a destroyed window mid-copy.
  // Setting forceQuit here also means 'before-quit' below won't double-prompt.
  mainWindow.on('close', (e) => {
    if (forceQuit || activeCopyCount === 0) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Quit Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Ingest in progress',
      message: 'An ingest is currently running.',
      detail: 'Closing now will stop the copy immediately. Files being written at that moment may be left incomplete on the destination.',
    }).then(({ response }) => {
      if (response === 0) { forceQuit = true; app.quit(); }
    });
  });

  // ── Handle Finder drag & drop ───────────────────────────────────────────
  // When user drags a folder/volume from Finder onto the app window,
  // Electron fires 'will-navigate' with a file:// URL — intercept it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // The app itself never navigates; block every attempt. A file:// URL is a
    // Finder drag-and-drop — turn it into a finder-drop event. Anything else
    // (http/https that slipped in) is simply cancelled so the remote page can
    // never load in this privileged frame.
    event.preventDefault();
    if (url.startsWith('file://')) {
      try {
        let filePath = decodeURIComponent(new URL(url).pathname);
        // On Windows, pathname is /C:/foo — strip leading slash
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        mainWindow.webContents.send('finder-drop', filePath);
      } catch (_) {}
    }
  });

  // Auto-open DevTools on Windows for debugging
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Windows: fix GPU context crash on hybrid Intel Arc + NVIDIA (Optimus) systems
if (process.platform === 'win32') {
  // Force ANGLE to use D3D11 — works reliably on Intel Arc and NVIDIA hybrid configs
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  // Disable GPU sandbox which causes access violations on hybrid GPU systems
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Force the renderer to use the integrated GPU (avoids Optimus switching issues)
  app.commandLine.appendSwitch('force_low_power_gpu');
  // Disable features that require GLES3 (not available on all hybrid configs)
  app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform,VaapiVideoDecoder,VaapiVideoEncoder');
  // Do NOT call disableHardwareAcceleration() — D3D11 is hardware but stable
}

app.whenReady().then(() => {
  installAppMenu();
  createWindow();
  startVolumeWatch();
});
// Guard against quitting mid-ingest (Cmd+Q, Dock > Quit, app menu, Alt+F4…).
// activeCopyCount is set by the main process itself around the actual file
// I/O, so this can't be fooled by a renderer that's out of sync.
app.on('before-quit', (e) => {
  if (forceQuit || activeCopyCount === 0) return;
  e.preventDefault();
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Quit Anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Ingest in progress',
    message: 'An ingest is currently running.',
    detail: 'Quitting now will stop the copy immediately. Files being written at that moment may be left incomplete on the destination.',
  }).then(({ response }) => {
    if (response === 0) { forceQuit = true; app.quit(); }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC: Preload drop (Windows drag & drop fix) ────────────────────────────

// ─── IPC: Window controls (Windows only) ────────────────────────────────────
ipcMain.on('win-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => { if (mainWindow) mainWindow.close(); });

// ─── IPC: Prefs ─────────────────────────────────────────────────────────────
ipcMain.handle('load-prefs', async () => loadPrefs());
ipcMain.handle('save-prefs', async (_, p) => { savePrefs(p); return true; });

// ─── Live volume detection — no manual refresh needed ───────────────────────
// macOS: fs.watch('/Volumes') fires on mount/unmount, event-driven, near-instant.
// Windows: no filesystem-level mount event exists for drive letters, so we poll
// cheaply (existsSync per letter, no process spawned) and only run the full
// (heavier) PowerShell-based scan when the actual set of letters changed.
let _volWatchTimer = null;
function startVolumeWatch() {
  const notify = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('volumes-changed'); };
  const debounced = (() => { let t=null; return () => { clearTimeout(t); t=setTimeout(notify, 350); }; })();

  if (process.platform === 'darwin') {
    try {
      const w = fs.watch('/Volumes', { persistent: false }, () => debounced());
      // An FSWatcher that emits 'error' with no listener THROWS and takes the
      // whole process down mid-ingest. Swallow it instead.
      w.on('error', () => {});
    } catch (e) { console.error('Volume watch failed:', e.message); }
  } else if (process.platform === 'linux') {
    // Automount roots: /media/$USER (Debian/Ubuntu/Pop) or /run/media/$USER
    // (Fedora/Arch). The user subdirectory may not exist until the first card
    // is mounted, so we watch the parents and (re-)attach child watchers on
    // every event. fs.watch is not recursive on Linux.
    const user = require('os').userInfo().username;
    const roots = ['/media', '/run/media', '/media/' + user, '/run/media/' + user];
    const watched = new Set();
    const tryWatch = (d) => {
      if (watched.has(d)) return;
      try {
        if (!fs.existsSync(d)) return;
        const w = fs.watch(d, { persistent: false }, () => { debounced(); setTimeout(attachAll, 400); });
        // Without this, inotify pressure or the mount root being removed on
        // unmount emits 'error' and crashes the process.
        w.on('error', () => { watched.delete(d); });
        watched.add(d);
      } catch (_) {}
    };
    const attachAll = () => roots.forEach(tryWatch);
    attachAll();
  } else if (process.platform === 'win32') {
    let lastLetters = null;
    _volWatchTimer = setInterval(() => {
      let cur = '';
      for (let c = 65; c <= 90; c++) {
        const l = String.fromCharCode(c);
        try { if (fs.statSync(l + ':\\').isDirectory()) cur += l; } catch (_) {}
      }
      if (lastLetters !== null && cur !== lastLetters) notify();
      lastLetters = cur;
    }, 2000);
  }
}

ipcMain.handle('get-volumes', async () => {
  return getMountedVolumes();
});

async function getMountedVolumes() {
  if (process.platform === 'win32') return getMountedVolumesWin();
  if (process.platform === 'linux') return getMountedVolumesLinux();
  if (process.platform !== 'darwin') return [];

  // Network detection. The mountpoint sits between " on " and " (" and is always
  // absolute — anchoring to " on /" stops a share NAMED "…on" (Canon, Nikon)
  // from being mis-parsed, which used to send network shares through diskutil.
  const networkPaths = new Set();
  try {
    for (const line of (await tryExecFile('mount', [], 2000)).split('\n')) {
      if (/smbfs|afpfs|nfs|webdav|ftpfs/.test(line)) {
        const m = line.match(/ on (\/.*) \(/);
        if (m) networkPaths.add(m[1].trim());
      }
    }
  } catch (_) {}

  let entries = [];
  try { entries = fs.readdirSync('/Volumes'); } catch (_) { return []; }

  let rootDev = null;
  try { rootDev = fs.statSync('/').dev; } catch (_) {}

  // Probe every volume CONCURRENTLY — the async execFile calls no longer block
  // the main thread, and total wall-time is that of the slowest single volume
  // instead of the sum of all of them.
  const results = await Promise.all(entries.map(async (name) => {
    const fullPath = '/Volumes/' + name;
    try { if (!fs.statSync(fullPath).isDirectory()) return null; } catch (_) { return null; }

    let isSystem = false, isNetwork = networkPaths.has(fullPath);
    let fsType = 'external';
    try { if (rootDev && fs.statSync(fullPath).dev === rootDev) isSystem = true; } catch (_) {}

    if (!isNetwork && !isSystem) {
      const info = await tryExecFile('diskutil', ['info', fullPath], 3000);
      if (info) {
        if (/Device Location:\s+Internal/i.test(info)) isSystem = true;
        const proto = (info.match(/Protocol:\s+(.+)/i)||[])[1]?.trim().toLowerCase() || '';
        if      (/\bsdxc?\b/.test(proto) || proto.includes('secure digital')) fsType = 'sdcard';
        else if (proto.includes('usb'))            fsType = 'usb';
        else if (/Solid State:\s+Yes/i.test(info)) fsType = 'ssd';
        const mediaName = (info.match(/Media Name:\s+(.+)/i)||[])[1]?.trim().toLowerCase() || '';
        // "sd" must be a whole word, or "Samsung Portable SSD" gets mislabelled a card.
        if ((/\bsd(hc|xc)?\b/.test(mediaName) || mediaName.includes('card')) && !mediaName.includes('ssd')) fsType = 'sdcard';
        if (mediaName.includes('cfr') || mediaName.includes('cfast') || mediaName.includes('sxs')) fsType = 'sdcard';
      }
    }

    let totalSize=0, freeSize=0;
    const dfOut = await tryExecFile('df', ['-k', fullPath], 1500);
    const parts = dfOut.trim().split('\n')[1]?.trim().split(/\s+/);
    if (parts?.length >= 4) { totalSize=parseInt(parts[1])*1024; freeSize=parseInt(parts[3])*1024; }

    // Skip phantom snapshot/sealed-system mounts named by a raw UUID.
    if ((totalSize === 0 || freeSize === 0) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
      return null;
    }

    let camera = null;
    if (!isSystem && !isNetwork) { try { camera = detectCamera(fullPath) || null; } catch (_) {} }
    return { name, path: fullPath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize-freeSize, camera };
  }));

  return results.filter(Boolean);
}

// ─── Linux volume scan (Pop!_OS, Ubuntu, and udisks2-based distros) ────────
// Block devices come from lsblk (util-linux, present everywhere); desktop
// automount puts removable media under /media/$USER (Debian/Ubuntu family)
// or /run/media/$USER (Fedora/Arch family) — both are covered. Network
// mounts (SMB/NFS/SSHFS) come from /proc/mounts. Returned objects carry the
// exact same fields as the macOS and Windows scanners.
function getMountedVolumesLinux() {
  const volumes = [];
  const seen = new Set();
  let tree = null;
  try {
    const out = execFileSync('lsblk',
      ['-J', '-b', '-o', 'NAME,MOUNTPOINT,SIZE,FSAVAIL,RM,LABEL,TYPE'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    tree = JSON.parse(out);
  } catch (_) {}

  const walk = (nodes) => {
    for (const n of (nodes || [])) {
      const mp = n.mountpoint;
      if (mp && !seen.has(mp)) {
        const total = Number(n.size) || 0;
        const free  = Number(n.fsavail) || 0;
        if (mp === '/') {
          seen.add(mp);
          volumes.push({
            name: 'System', path: '/', isSystem: true, isNetwork: false, fsType: 'system',
            totalSize: total, freeSize: free, usedSize: total - free, camera: null,
          });
        } else if (/^\/(media|run\/media)\//.test(mp)) {
          seen.add(mp);
          const name = (n.label || '').trim() || path.basename(mp);
          let camera = null;
          try { camera = detectCamera(mp) || null; } catch (_) {}
          volumes.push({
            name, path: mp, isSystem: false, isNetwork: false, fsType: 'usb',
            totalSize: total, freeSize: free, usedSize: total - free, camera,
          });
        }
      }
      walk(n.children);
    }
  };
  if (tree) walk(tree.blockdevices);

  // Fallback: if lsblk is missing or too old to report FSAVAIL (util-linux
  // < 2.33), the walk above yields nothing and the user sees NO local volumes
  // at all. Recover the removable mounts straight from /proc/mounts.
  try {
    // If lsblk failed entirely, even "/" is missing — recover it here too.
    const haveSystem = volumes.some(v => v.isSystem);
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const parts = line.split(' ');
      const mp = (parts[1] || '').replace(/\\040/g, ' ');
      if (!mp || seen.has(mp)) continue;
      const isRoot = mp === '/';
      if (!isRoot && !/^\/(media|run\/media)\//.test(mp)) continue;
      if (isRoot && haveSystem) continue;
      seen.add(mp);
      let totalSize = 0, freeSize = 0;
      try { const st = fs.statfsSync(mp); totalSize = st.blocks * st.bsize; freeSize = st.bavail * st.bsize; } catch (_) {}
      if (isRoot) {
        volumes.push({ name: 'System', path: '/', isSystem: true, isNetwork: false,
          fsType: 'system', totalSize, freeSize, usedSize: totalSize - freeSize, camera: null });
        continue;
      }
      let camera = null; try { camera = detectCamera(mp) || null; } catch (_) {}
      volumes.push({ name: path.basename(mp), path: mp, isSystem: false, isNetwork: false,
        fsType: 'usb', totalSize, freeSize, usedSize: totalSize - freeSize, camera });
    }
  } catch (_) {}

  // Network mounts — /proc/mounts, octal-escaped spaces decoded
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const parts = line.split(' ');
      const src = parts[0], mpRaw = parts[1], fstype = parts[2] || '';
      if (!mpRaw || !/^(cifs|smb3|nfs4?|fuse\.sshfs)$/.test(fstype)) continue;
      const mp = mpRaw.replace(/\\040/g, ' ');
      if (seen.has(mp)) continue;
      seen.add(mp);
      let totalSize = 0, freeSize = 0;
      try {
        const st = fs.statfsSync(mp);
        totalSize = st.blocks * st.bsize; freeSize = st.bavail * st.bsize;
      } catch (_) {}
      volumes.push({
        name: path.basename(mp) || src, path: mp, isSystem: false, isNetwork: true,
        fsType: 'network', totalSize, freeSize, usedSize: totalSize - freeSize, camera: null,
      });
    }
  } catch (_) {}
  return volumes;
}

function getMountedVolumesWin() {
  const volumes = [];
  // Single PowerShell call for every drive. Previously: one process per existing
  // drive letter (up to ~4 s each) — scans could take 20-30 s with several drives.
  // No string interpolation in the command → no injection surface.
  let byLetter = new Map();
  // Force UTF-8 output so accented volume names ("Sauvegarde Vidéo") don't come
  // back mojibake and then flow into folder names. windowsHide stops a console
  // window from flashing.
  const sysLetter = String(process.env.SystemDrive || 'C:').replace(/[:\\/]/g,'').toUpperCase() || 'C';
  try {
    const ps = execSync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-PSDrive -PSProvider FileSystem | Select-Object -Property Name,Used,Free,Description,DisplayRoot | ConvertTo-Json -Compress"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    ).trim();
    if (ps) {
      const parsed = JSON.parse(ps);
      for (const d of (Array.isArray(parsed) ? parsed : [parsed])) {
        if (d && typeof d.Name === 'string' && /^[A-Za-z]$/.test(d.Name)) {
          byLetter.set(d.Name.toUpperCase(), d);
        }
      }
    }
  } catch (_) {}

  // Enumerate drive letters A-Z
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drivePath = letter + ':\\';
    try {
      // Check if drive exists and is accessible
      const stat = fs.statSync(drivePath);
      if (!stat.isDirectory()) continue;
    } catch (_) { continue; }

    let name = letter + ':';
    let totalSize = 0, freeSize = 0;
    let fsType = 'usb'; // default for removable
    let isSystem = false, isNetwork = false;

    const d = byLetter.get(letter);
    if (d) {
      freeSize  = d.Free  || 0;
      totalSize = (d.Used || 0) + freeSize;
      const volName = (d.Description || '').trim();
      const displayRoot = (d.DisplayRoot || '').trim();
      if (volName) name = volName + ' (' + letter + ':)';
      // Detect network drive via DisplayRoot (UNC path like \\server\share)
      if (displayRoot.startsWith('\\\\') || displayRoot.startsWith('\\')) {
        isNetwork = true; fsType = 'network';
      } else if (letter === sysLetter) {
        isSystem = true; fsType = 'system';
      }
    } else if (letter === sysLetter) {
      // PowerShell info unavailable: system drive is whatever %SystemDrive% says,
      // not always C: (some machines boot from D:).
      isSystem = true; fsType = 'system';
    }

    let camera = null;
    if (!isSystem && !isNetwork) { try { camera = detectCamera(drivePath) || null; } catch (_) {} }
    volumes.push({
      name, path: drivePath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize - freeSize, camera
    });
  }
  return volumes;
}

// ─── IPC: Browse folder ──────────────────────────────────────────────────────
ipcMain.handle('browse-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ─── IPC: Export / import template presets (item 9) ──────────────────────────
ipcMain.handle('export-settings', async (_, data) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export INGESTO settings',
    defaultPath: 'ingesto_settings.json',
    filters: [{ name: 'INGESTO settings', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('import-settings', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Import INGESTO settings',
    properties: ['openFile'],
    filters: [{ name: 'INGESTO settings', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
  try {
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('export-presets', async (_, data) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export template presets',
    defaultPath: 'ingesto-presets.json',
    filters: [{ name: 'INGESTO presets', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('import-presets', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Import template presets',
    properties: ['openFile'],
    filters: [{ name: 'INGESTO presets', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
  try {
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC: Resolve path info (for Finder drops) ───────────────────────────────
ipcMain.handle('resolve-path', async (_, p) => {
  try {
    // Strip trailing separators before stat, but keep a root intact: "E:\" must
    // not become "E:" (the drive's *current directory*, a different place) and
    // "/" must not become "".
    let normalized = p.replace(/[\/\\]+$/, '');
    if (/^[A-Za-z]:$/.test(normalized)) normalized += '\\';   // E: → E:\
    else if (normalized === '') normalized = '/';             // / stayed /
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) return null;
    const name = path.basename(normalized) || normalized;
    return { name, path: normalized, isDirectory: true };
  } catch (_) { return null; }
});

// ─── IPC: Start copy — multi destinations, parallel ──────────────────────────
ipcMain.handle('start-copy', async (event, { sources, destinations, options }) => {
  cancelCopy = false;
  pauseCopy = false;
  resetFsyncBusyState();   // a new ingest gets a fresh chance at flushing
  activeCopyCount++;
  try {
  const allResults = [];
  for (const source of sources) {
    if (cancelCopy) break;
    const sourceResults = await performCopyMulti(source, destinations, options,
      prog => mainWindow.webContents.send('copy-progress', prog)
    );
    allResults.push(...sourceResults);

    // ── Write sentinel on the source card after successful ingest ────────
    // Conditions: at least one destination succeeded (or partial success with copied files),
    // and the source card is writable.
    // Never mark a card as ingested when part of it could not even be read:
    // the operator would format a card whose missing files were never seen.
    const scanIncomplete = sourceResults.some(r => r && r.scanIncomplete);
    if (!cancelCopy && !scanIncomplete) {
      // A file may only be recorded as ingested if it landed OK on EVERY
      // destination the user asked for. It used to take the first destination's
      // list and credit it to all of them, so a file that failed verification on
      // destination B was still marked ingested — and the "copy new files only"
      // dialog then skipped it forever, leaving B permanently incomplete.
      const perDest = sourceResults.map(r => (r && r._copiedForSentinel) || []);
      const keyOf = f => `${f.p}|${f.s}|${f.m}`;
      let common = perDest.length ? perDest[0] : [];
      for (let i = 1; i < perDest.length; i++) {
        const have = new Set(perDest[i].map(keyOf));
        common = common.filter(f => have.has(keyOf(f)));
      }
      if (options.writeSentinel === true && common.length) {
        const allDests = sourceResults.map(r => r.destPath);
        try {
          await appendIngest(source.path, allDests, common, app.getVersion());
        } catch (e) {
          // Sentinel write failure must never break the ingest result
          console.error('Sentinel write failed:', e.message);
        }
      }
    }
  }
  // Strip internal _copiedForSentinel from results before sending to renderer,
  // but expose the verified file list publicly as fileList for the ingest report.
  const cleaned = allResults.map(r => {
    const { _copiedForSentinel, _cksumEntries, ...rest } = r || {};
    rest.fileList = (_copiedForSentinel || []).map(f => ({ path: f.d || f.p, size: f.s, mtime: f.m }));
    return rest;
  });
  mainWindow.webContents.send('copy-complete', cleaned);
  return cleaned;
  } finally { activeCopyCount--; }
});

ipcMain.handle('cancel-copy', async () => { cancelCopy = true; pauseCopy = false; pauseEnd(); return true; });
ipcMain.handle('pause-copy',  async () => { pauseCopy = true;  return true; });
ipcMain.handle('resume-copy', async () => { pauseCopy = false; pauseEnd(); return true; });

// ─── Re-copy only the files that failed verification, into the SAME folder ───
ipcMain.handle('recopy-failed', async (event, { sourcePath, sourceName, destPath, mode, proAlgo, proDoubleRead, files, destRelMap, destIndex, destName }) => {
  cancelCopy = false;
  pauseCopy = false;
  activeCopyCount++;
  try {
  const source = { name: sourceName, path: sourcePath };
  const results = await performCopyMulti(
    source, [{ path: '', name: destName || '' }],
    // destRelMap carries each failed file's ORIGINAL destination-relative path.
    // Without it, a retry after a "Reorganize" run rewrote the file under its
    // source tree (destPath/100CANON/CLIP.MOV), reported success, and left the
    // corrupted VIDEO/CLIP.MOV untouched in the delivered folder.
    { mode, proAlgo, proDoubleRead, fixedDestPath: destPath, onlyRel: files,
      destRelOverride: (destRelMap && typeof destRelMap === 'object') ? destRelMap : null },
    prog => mainWindow.webContents.send('copy-progress', { ...prog, destIndex: destIndex||0, destName: destName||'' })
  );
  const { _copiedForSentinel, _cksumEntries, ...rest } = results[0] || {};   // not re-writing the sentinel on a retry
  rest.fileList = (_copiedForSentinel || []).map(f => ({ path: f.p, size: f.s, mtime: f.m }));

  // Refresh the checksum sidecar with the entries that just verified, so a
  // later "Verify folder" covers the recopied files instead of listing them as
  // never-checksummed extras. Only when a matching-algo list already exists —
  // we never create a partial sidecar out of a retry.
  try {
    if ((mode === 'pro' || mode === 'slow') && Array.isArray(_cksumEntries) && _cksumEntries.length) {
      const existing = readChecksumListFile(destPath);
      const algo = mode === 'pro' ? (proAlgo || 'xxh128') : 'xxh64';
      if (existing && existing.algo === algo) {
        const byRel = new Map(existing.entries.map(e => [e.rel, e.hash]));
        for (const e of _cksumEntries) byRel.set(nfc(String(e.rel).replace(/\\/g,'/')), e.hash);
        writeChecksumList(destPath, algo, [...byRel].map(([rel, hash]) => ({ rel, hash })));
      }
      // The MHL manifest needs the same treatment. Without it a retried file was
      // added to the checksum list but never to the .mhl — so Silverstack,
      // YoYotta and OffShoot, which read the MHL, saw a manifest missing exactly
      // the files that had been at risk. INGESTO's own Verify prefers the
      // checksum list, which is why this stayed invisible here.
      const mhl = readMHLFile(destPath);
      // `complete` guards against silent data loss: readMHLFile only keeps <hash>
      // blocks carrying md5 or xxhash64be, so rewriting a manifest that also
      // holds other hash types (or blocks we don't parse) would DELETE them.
      // Refuse to touch a manifest we cannot reproduce faithfully.
      if (mhl && mhl.complete && mhl.algo === algo && (algo === 'xxh64' || algo === 'md5')) {
        const byRel = new Map(mhl.entries.map(e => [e.rel, e]));
        for (const e of _cksumEntries) {
          byRel.set(nfc(String(e.rel).replace(/\\/g,'/')),
                    { rel: e.rel, hash: e.hash, size: e.size, mtimeMs: e.mtimeMs });
        }
        writeMHL(destPath, algo, [...byRel.values()], { startMs: Date.now() });
      }
      // ASC MHL: a retry is a new GENERATION, which is exactly what the format's
      // chain is for. Without this the history kept describing the state before
      // the retry, and omitted precisely the files that had been at risk.
      if (fs.existsSync(path.join(destPath, 'ascmhl'))) {
        await writeAscMhl(destPath, algo, _cksumEntries, { startMs: Date.now() });
      }
    }
  } catch (_) { /* sidecar refresh is best-effort; the copy result stands */ }
  // Drop the quarantined bad copies that have now been replaced by a good one.
  // Driven by _copiedForSentinel, not _cksumEntries: the latter is only filled
  // in SECURE/PRO, so a VERIFIED retry used to leave the .ingesto-failed file
  // sitting in the delivered folder forever.
  try {
    for (const f of (_copiedForSentinel || [])) {
      const rel = String(f.d || f.p || '');
      if (!rel) continue;
      const q = path.join(destPath, rel) + FAILED_SUFFIX;
      if (!pathContains(destPath, q)) continue;   // a file list is data, not trust
      if (fs.existsSync(q)) { try { fs.unlinkSync(q); } catch (_) {} }
    }
  } catch (_) {}
  return rest;
  } finally { activeCopyCount--; }
});

// ─── Copy engine — read the source ONCE, write to every destination ─────────
// Multi-destination used to launch one full copy per destination in parallel,
// making N simultaneous read passes over the same card that competed for the
// (usually slow) source medium. The fan-out engine reads each file once and
// streams the chunks to all destinations at the same time.

// Suffix used while a file is still being written. A file only takes its final
// name once it is fully written, flushed and (in SECURE/PRO) fsynced, so a name
// on the destination always means a complete file — never a truncated one left
// behind by a crash, an unplug or a write error.
const PART_SUFFIX = '.ingesto-part';
// A copy that FAILED read-back verification is renamed with this suffix, so a
// plain filename in a destination always means a file that passed. Kept on disk
// rather than deleted: the operator may want to look at it, and "Re-copy failed
// files" recopies from the source anyway.
const FAILED_SUFFIX = '.ingesto-failed';

// Push a file's data out of the OS write cache down to the medium.
//
// What this DOES guarantee: the bytes have been handed to the device, so a
// later read cannot come back from the OS write-behind buffer alone.
//
// What it does NOT guarantee — read this before trusting a verify pass:
//  • fsync does not evict the page cache, so the read-back can still be served
//    from RAM. On a machine with more RAM than the tail of the ingest, the last
//    files verified may be compared against cached copies of themselves.
//    There is no portable way to PURGE a file's cached pages; the data has to
//    be kept out of the cache in the first place, on BOTH the write and the
//    read side — F_NOCACHE (macOS) and FILE_FLAG_NO_BUFFERING (Windows) need
//    fcntl/CreateFile, which Node does not expose (O_DIRECT exists in
//    fs.constants but on Linux only). Until that lands, a later "Verify folder"
//    run on a cold cache is the only fully independent check.
//  • On macOS, fsync(2) does not flush the drive's own write cache; that needs
//    fcntl(F_FULLFSYNC), also unavailable from Node.
//
// Opened 'r+' (not 'r'): Windows' FlushFileBuffers needs a write-capable handle.
// This is called BEFORE the source's permissions are copied onto the file —
// doing it the other way round made every fsync fail with EACCES whenever the
// source card was mounted read-only (write-protect switch), silently disabling
// the whole guarantee. Errors are now reported to the caller instead of being
// swallowed.
// Returns { ok:true } on success, { ok:false, unsupported:true, code } when the
// filesystem simply has no flush operation (some network shares, some FUSE
// mounts) — that is a weaker guarantee, not a failed copy, so it is surfaced as
// a warning. Any other error is a real problem and is thrown.
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
// The file is fully written and closed by the time we get here; these codes mean
// "something else is holding it right now", not "the copy is bad". On Windows a
// virus scanner opens every freshly written file for a moment, which used to
// make us DELETE a perfectly good multi-GB copy and report a copy error. Retry
// briefly, then downgrade to the same warning as an unsupported filesystem.
// EACCES is deliberately NOT here: that one means the file's own permissions
// deny us, which is the write-protected-source bug this code was written to
// surface, not a transient lock.
const FSYNC_BUSY = new Set(['EBUSY', 'EPERM']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Once a destination has proved that the lock never clears, stop paying the
// retry cost on every remaining file: 5 attempts x ~1.5s of sleeping would add
// hours to a 5,000-file card. Reset at the start of each ingest.
let _fsyncBusyHopeless = false;
function resetFsyncBusyState() { _fsyncBusyHopeless = false; }
async function fsyncFile(fp) {
  const maxAttempt = _fsyncBusyHopeless ? 0 : 4;
  for (let attempt = 0; ; attempt++) {
    let fh = null, retryIn = 0, result = null, thrown = null;
    try {
      fh = await fs.promises.open(fp, 'r+');
      // On macOS, prefer F_FULLFSYNC — plain fsync leaves the data in the
      // drive's own write cache, so it would not survive a power loss. Fall
      // back to the portable fsync when the native call is unavailable or fails.
      if (!nocache.fullFsync(fh.fd)) await fh.sync();
      result = { ok: true };
    } catch (e) {
      if (e && FSYNC_UNSUPPORTED.has(e.code)) result = { ok: false, unsupported: true, code: e.code };
      else if (e && FSYNC_BUSY.has(e.code)) {
        if (attempt < maxAttempt) retryIn = 150 * (attempt + 1);
        else { _fsyncBusyHopeless = true; result = { ok: false, unsupported: true, code: e.code }; }
      }
      else thrown = e;
    }
    // The handle is closed by the finally below BEFORE we wait — sleeping with
    // an 'r+' handle open would contend with the very lock we are waiting out.
    finally { if (fh) { try { await fh.close(); } catch (_) {} } }
    if (thrown) throw thrown;
    if (result) return result;
    await sleep(retryIn);
  }
}

// Remove every leftover *.ingesto-part under a folder (crash or power-loss
// residue from an earlier run). Returns the number of files removed.
function sweepPartFiles(root) {
  let n = 0;
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(PART_SUFFIX)) { try { fs.unlinkSync(full); n++; } catch (_) {} }
    }
  })(root);
  return n;
}

// Is the cache eviction actually working on THIS medium, right now?
//
// Why a probe rather than a speed heuristic: the previous check declared the
// second read "served from memory" when it ran 3x faster than the copy AND
// above 300 MB/s. That guess failed both ways.
//  • It was BLIND in MD5. A RAM-served read is capped by the hashing itself at
//    ~300 MB/s in MD5 (measured: 293 MB/s, against 683 in xxHash on the same
//    drive), which is indistinguishable from a fast card. MD5 is also one of
//    the two algorithms that produce an MHL manifest — the archival workflow
//    was the one with the weakest guard.
//  • It FALSE-ALARMED on a common professional setup. Fast card, slow shuttle
//    drives: the copy is bounded by writing, so a perfectly physical re-read is
//    legitimately three times faster, and the operator was told the check had
//    not really run.
//
// This measures instead, and calibrates itself against the machine it is on:
// purge one file, read a block and time it (COLD), then read the very same
// block again, which is certainly cached now (WARM). If the purge worked, cold
// is far slower than warm. If it did not, the "cold" read WAS the cached read
// and the two times match. The ratio needs no threshold tied to any particular
// hardware, and nothing is hashed, so the algorithm cannot skew it.
const PROBE_BYTES = 8 * 1024 * 1024;
function probeCacheEviction(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(PROBE_BYTES, size);
    // Too small to time reliably — say nothing rather than guess.
    if (len < 1024 * 1024) return { ok: false };
    const buf = Buffer.allocUnsafe(len);
    // Read the block we are about to measure, UNTIMED, so that two things are
    // true before the purge: the buffer's pages are resident and the file's
    // read-ahead state is warm (without this the cold read carried ~1 ms of
    // setup the warm read did not, worth a 2.7x ratio out of nothing), AND —
    // the part that actually matters — this exact block is known to be in the
    // cache. The whole test rests on that: if the purge does nothing, the
    // "cold" read must be served from the cache so the two times match. Warming
    // a DIFFERENT region left the measured block's residency to chance, and on
    // a large card the first file's opening bytes had long been evicted by LRU,
    // so a purge that silently did nothing still looked like it worked.
    buf.fill(0);
    fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } catch (_) {}
    fs.closeSync(fd); fd = null;

    if (!nocache.purgeFileCache(file)) return { ok: false, purgeFailed: true };

    fd = fs.openSync(file, 'r');
    const t0 = process.hrtime.bigint();
    fs.readSync(fd, buf, 0, len, 0);          // COLD: must come from the medium
    const t1 = process.hrtime.bigint();
    const coldMs = Number(t1 - t0) / 1e6;
    // Memory-speed reference: the same bytes, certainly cached now. Take the
    // FASTEST of three, so one scheduling hiccup cannot inflate it and make a
    // cached read look like a physical one.
    let warmMs = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = process.hrtime.bigint();
      fs.readSync(fd, buf, 0, len, 0);
      const b = process.hrtime.bigint();
      warmMs = Math.min(warmMs, Number(b - a) / 1e6);
    }
    // Timer noise guard: if even the warm read is under a tenth of a
    // millisecond the numbers are too small to compare.
    if (!(warmMs > 0.1) || !isFinite(coldMs)) return { ok: false };
    // Measured on the tightest case available (a fast virtio disk, where the
    // two times are closest), 5 runs of each of four scenarios — eviction
    // working or a silent no-op, crossed with the block being cached or already
    // evicted by LRU: 3.3-8.7x when the eviction works, 1.3-2.2x when it does
    // nothing. A camera card widens that to 30-50x. 2.5x sits in the gap, and
    // erring low errs towards NOT crying wolf on a good ingest.
    return { ok: true, evicted: coldMs >= warmMs * 2.5, coldMs, warmMs };
  } catch (_) {
    return { ok: false };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Read src once; write simultaneously to every path in destFiles.
// Per-destination failures don't stop the others. Resolves with
// { digest, failed } where failed[i] is the Error for destination i (or null),
// and digest is the source fingerprint when a hasher is provided.
// Rejects only when the SOURCE read itself fails (which affects every dest).
function copyFanOut(src, destFiles, onBytes, hasher) {
  return new Promise((resolve, reject) => {
    if (hasher) hasher.init();
    // In SECURE/PRO (hasher present) the destination is read back for
    // verification, so write it uncached on macOS — its pages then never sit in
    // RAM and the read-back is forced to come from the medium. In FAST there is
    // no read-back, so a plain cached write (faster) is fine.
    //
    // The SOURCE, however, is read through the normal cached path on every
    // platform. It used to be opened uncached on macOS too, but that is now
    // redundant: the caller purges the source file from the cache immediately
    // before this call in exactly the same modes (isPro || isSecure), so the
    // read already hits the card. Keeping F_NOCACHE on for the whole read also
    // disabled the kernel's read-ahead, costing ~35% on macOS (measured
    // 22/08/2026 on the same card: 60 MB/s here vs 76-79 on Windows/Linux,
    // which only evict and then read normally, vs 91 MB/s in FAST).
    const mkWrite = hasher ? nocache.createWriteStream : fs.createWriteStream;
    const rs = fs.createReadStream(src, { highWaterMark: 8*1024*1024 });
    const N = destFiles.length;
    const wss = new Array(N);
    const state = new Array(N).fill('open');   // open | done | failed
    const failed = new Array(N).fill(null);
    let pendingFinish = N, readEnded = false, settled = false;

    const maybeSettle = () => {
      if (settled || !readEnded || pendingFinish > 0) return;
      settled = true;
      // Same hazard as in hashPro: thrown from a stream listener, this escapes
      // the promise entirely and takes the whole main process down mid-copy.
      let dg = null;
      try { dg = hasher ? hasher.digest() : null; }
      catch (e) { reject(e instanceof Error ? e : new Error('hash digest failed')); return; }
      resolve({ digest: dg, failed });
    };
    const failDest = (i, err) => {
      if (state[i] !== 'open') return;
      state[i] = 'failed';
      failed[i] = err || new Error('write failed');
      // Settle only once this stream's fd is actually CLOSED. Decrementing
      // immediately let the caller unlink the .part while the handle was still
      // open — a no-op error on POSIX, but EPERM on Windows, leaving orphan
      // .ingesto-part files in a delivered folder.
      let doneOnce = false;
      const done = () => {
        if (doneOnce) return; doneOnce = true;
        pendingFinish--;
        if (state.every(s => s === 'failed')) {
          // No destination left — stop reading the source.
          try { rs.destroy(); } catch (_) {}
          readEnded = true;
        }
        maybeSettle();
      };
      wss[i].once('close', done);
      try { wss[i].destroy(); } catch (_) { done(); }
    };

    for (let i = 0; i < N; i++) {
      const ws = mkWrite(destFiles[i]);
      wss[i] = ws;
      ws.on('error', e => failDest(i, e));
      // Settle on 'close', NOT on 'finish'. A WriteStream emits 'finish' when
      // the last chunk is handed over, but close() can still fail afterwards —
      // ENOSPC/EIO on a write-behind SMB or NFS share are raised right there.
      // Node emits that late 'error' before 'close', so by the time 'close'
      // fires the destination has already been marked failed if it did fail.
      ws.on('close', () => {
        if (state[i] !== 'open') return;
        state[i] = 'done'; pendingFinish--; maybeSettle();
      });
    }

    rs.on('data', chunk => {
      // Mid-file cancellation: a 200 GB clip used to ignore "Cancel" until it
      // finished. Abort the read now; the partial .part files are cleaned up by
      // the caller. `aborted` is flagged so the caller does not log it as an error.
      if (cancelCopy) {
        // Fail every open destination via failDest, which waits for each fd to
        // CLOSE before settling — so the caller's .part cleanup and the final
        // sweep run against closed files (unlink would EPERM on Windows
        // otherwise). failDest's all-failed branch stops the source read.
        try { rs.destroy(); } catch (_) {}
        readEnded = true;
        for (let i = 0; i < N; i++) failDest(i, Object.assign(new Error('canceled'), { aborted: true }));
        maybeSettle();   // covers the no-open-destination edge
        return;
      }
      if (hasher) {
        // A hash failure must NOT be swallowed: a silent partial digest turns a
        // good file into a false "mismatch" (or, worse, two empty digests that
        // match). Tear down (waiting for the fds to close) and reject so the
        // file is reported as failed with the real error.
        try { hasher.update(chunk); }
        catch (e) {
          try { rs.destroy(); } catch (_) {}
          readEnded = true;
          const open = []; for (let i = 0; i < N; i++) if (state[i] === 'open') { state[i]='failed'; open.push(wss[i]); }
          const finish = () => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error('hash update failed')); } };
          if (!open.length) return finish();
          let remaining = open.length;
          for (const ws of open) {
            ws.once('close', () => { if (--remaining === 0) finish(); });
            try { ws.destroy(); } catch (_) { if (--remaining === 0) finish(); }
          }
          return;
        }
      }
      onBytes(chunk.length);
      const slow = [];
      for (let i = 0; i < N; i++) {
        if (state[i] !== 'open') continue;
        if (!wss[i].write(chunk)) slow.push(i);
      }
      if (slow.length) {
        // Backpressure: pause the read until every lagging destination drained.
        // 'close' also unblocks so a failing destination can't stall the read.
        rs.pause();
        let remaining = slow.length;
        let cancelPoll = null;
        const oneDone = () => {
          if (--remaining === 0) {
            if (cancelPoll) { clearInterval(cancelPoll); cancelPoll = null; }
            if (!settled) rs.resume();
          }
        };
        for (const i of slow) {
          const ws = wss[i];
          const onDrain = () => { cleanup(); oneDone(); };
          const onGone  = () => { cleanup(); oneDone(); };
          const cleanup = () => {
            ws.removeListener('drain', onDrain);
            ws.removeListener('close', onGone);
          };
          ws.once('drain', onDrain);
          ws.once('close', onGone);
        }
        // A destination that never drains (wedged SMB/NAS share) used to make
        // Cancel completely inert: no 'data' event ever fires again, so the
        // cancel check above is never reached. Poll while paused and tear the
        // stuck streams down on cancel — their 'close' unblocks via onGone.
        cancelPoll = setInterval(() => {
          if (!cancelCopy) return;
          clearInterval(cancelPoll); cancelPoll = null;
          // failDest (NOT a bare destroy): a destroyed-while-open stream emits
          // 'close' without 'error', which the completion handler would count
          // as a successful copy of a truncated file.
          for (const i of slow) failDest(i, Object.assign(new Error('canceled'), { aborted: true }));
        }, 500);
        if (cancelPoll.unref) cancelPoll.unref();
      }
    });
    rs.on('end', () => {
      readEnded = true;
      for (let i = 0; i < N; i++) { if (state[i] === 'open') wss[i].end(); }
      maybeSettle();
    });
    rs.on('error', err => {
      for (let i = 0; i < N; i++) {
        if (state[i] === 'open') { state[i]='failed'; failed[i]=err; pendingFinish--; try { wss[i].destroy(); } catch (_) {} }
      }
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Holds the engine between two files while paused. Announces to the renderer
// when the hold actually takes effect (the in-flight file finishes first), so
// the UI can switch from "Pausing…" to "Paused". Cancel breaks the hold.
// Milliseconds spent PAUSED during the current ingest. The phase durations are
// wall-clock, so without this an operator who pauses for two minutes during a
// one-minute copy sees "COPY 3m" in the report — and, worse, the copy speed
// derived from it collapses.
// Paused time, measured on the WALL CLOCK. It used to be accumulated inside
// pauseGate by every caller that waited — fine while one loop ran at a time,
// wrong the moment several destinations are verified at once: three lanes
// waiting through the same 10-second pause billed 30 seconds, and the phase
// durations in the report went to zero.
let pausedMs = 0, _pauseStart = 0, _pauseHeldSent = false;
// Close any pause still open before zeroing, or a pause that started between
// two cards of a batch would be credited to nobody and its minutes would land
// inside the next card's phase durations.
function resetPausedMs() { pauseEnd(); pausedMs = 0; _pauseStart = 0; _pauseHeldSent = false; }
function pauseBegin() { if (!_pauseStart) _pauseStart = Date.now(); }
function pauseEnd() {
  if (_pauseStart) { pausedMs += Date.now() - _pauseStart; _pauseStart = 0; }
  _pauseHeldSent = false;
}
// Split a list into groups that can safely be read AT THE SAME TIME: one group
// per physical device, so two folders on the same disk stay in the same group
// and are read one after the other. Falls back to "each on its own" when the
// device cannot be determined — parallel reads of two paths that turn out to
// share a disk cost speed, never correctness.
function groupByDevice(items, pathOf) {
  const byDev = new Map();
  for (const it of items) {
    let k;
    try { k = 'd' + fs.statSync(pathOf(it)).dev; }
    catch (_) { k = 'p' + pathOf(it); }
    if (!byDev.has(k)) byDev.set(k, []);
    byDev.get(k).push(it);
  }
  return [...byDev.values()];
}

// Why a card ended up with nothing to copy — or null when there is nothing to
// complain about. "Nothing to do" is a legitimate outcome when every file was
// already ingested; it is NOT one when the folder was empty or the format
// filter excluded everything. Those two used to come back success:true: green
// summary, "all verified" notification, and in kiosk mode the card ejected with
// "You can remove your card" on screen, having read not one of its files.
function emptyRunReason(seenFiles, skippedAlready, totalFiles) {
  if (totalFiles > 0 || skippedAlready > 0) return null;
  return seenFiles === 0
    ? 'no file was found on this card — check that you selected the card itself and not an empty folder inside it'
    : `all ${seenFiles} file${seenFiles > 1 ? 's' : ''} on this card were excluded by the file filter — nothing was copied`;
}

async function pauseGate(win) {
  if (!pauseCopy || cancelCopy) return;
  // The clock starts HERE, when a lane actually stops — not when the button was
  // pressed. Between the two the engine is still finishing the file in flight,
  // and billing that time as pause subtracted it from the phase durations: a
  // 500-second verify could be reported as 240 seconds, or clamped to zero.
  pauseBegin();
  // "Held" is announced once per pause, not once per waiting lane.
  if (!_pauseHeldSent) { _pauseHeldSent = true; try { win.webContents.send('pause-held'); } catch (_) {} }
  while (pauseCopy && !cancelCopy) await new Promise(r => setTimeout(r, 200));
}

// Copy one source to every destination. Returns one result object PER
// destination (same shape as the former per-destination engine, so the
// renderer and the sentinel logic are unchanged).
async function performCopyMulti(source, destinations, options, onProgress) {
  const t0 = Date.now();
  // tCopyStart is stamped just before the first file is read. t0 is kept for the
  // ingest's overall duration, but "COPY" must not include the recursive source
  // scan nor the destination tree pre-creation — on a card with tens of
  // thousands of files across three destinations that is seconds to tens of
  // seconds billed as copying, which also understated the copy speed.
  let tCopyStart=t0, tCopyEnd=0, tV1End=0, tV2End=0;
  // Paused time is measured per phase and subtracted from each.
  resetPausedMs();
  let pausedAtCopyStart=0, pausedAtCopyEnd=0, pausedAtV1End=0, pausedAtV2End=0;
  // Times the SOURCE cache eviction refused to run (SECURE/PRO). Since 2.4.6
  // the copy reads the card through the normal cached path, so this purge is
  // the only thing keeping the copy — and the PRO second read — off the OS
  // cache. A failure must be reported, never swallowed. The two phases are
  // counted SEPARATELY: a purge that failed while copying says nothing about
  // whether the second read hit the card, and mixing them raised a "the card
  // check didn't really run" alarm on ingests whose second read was genuine.
  let copyPurgeFails = 0, dblPurgeFails = 0;
  let copiedBytes=0, totalBytes=0, totalFiles=0;
  // How the scan ended, so that "nothing to copy" can be told apart from
  // "nothing worth copying" — see emptyRunReason.
  let seenFiles=0, skippedAlready=0;
  const isPro    = options.mode === 'pro';
  const isSecure = options.mode === 'slow';
  const proAlgo  = options.proAlgo || 'xxh128';
  const cksumAlgo = isPro ? proAlgo : 'xxh64';        // SECURE fingerprints are xxHash64
  const hasher   = (isPro || isSecure) ? await newProHasher(isPro ? proAlgo : 'xxh64') : null;
  const proDouble = isPro && options.proDoubleRead === true;
  const folderName = options.fixedDestPath ? '' : buildFolderName(options.folderTemplate, source);
  const destNames  = destinations.map(d => d.name).filter(Boolean).join(' + ');

  // ── Pre-flight guards — refuse to start rather than write in the wrong place ──
  // Each of these used to fail silently: the ingest ran, reported success, and
  // either overwrote existing footage or copied nothing at all.
  const abort = (msg) => destinations.map(d => ({
    success: false, canceled: false, scanIncomplete: false,
    sourceName: source.name, sourcePath: source.path,
    destPath: options.fixedDestPath || path.join(d.path, folderName || ''),
    totalFiles: 0, copiedFiles: 0, totalBytes: 0, copiedBytes: 0,
    errors: 1, errorList: [{ file: '(pre-flight)', error: msg, phase: 'setup' }],
    failedFiles: [], unstableFiles: [],
    mode: options.mode, proAlgo: isPro ? proAlgo : null,
    copyMs: 0, verify1Ms: 0, verify2Ms: 0, duration: 0,
    _copiedForSentinel: [],
  }));

  // 1. An empty / "." / ".." folder name would drop the whole card into the
  //    destination ROOT (path.join(dest,'') === dest), where the next card
  //    silently overwrites it.
  if (!options.fixedDestPath && !isSafeFolderName(folderName)) {
    return abort(
      'The folder-name template produced ' +
      (folderName ? `"${folderName}"` : 'an empty name') +
      ', which would write straight into the destination root. Ingest aborted — fix the template.'
    );
  }

  // 2. A destination equal to, or inside, the source card copies the card into
  //    itself; the card is then flagged as ingested and offered for ejection.
  for (const d of destinations) {
    const dp = options.fixedDestPath || d.path;
    if (pathContains(source.path, dp) || pathContains(dp, source.path)) {
      return abort(
        `Destination "${d.name || dp}" is the same as — or inside — the source card. Ingest aborted.`
      );
    }
  }

  // 3. File filter enabled with every format unchecked: the engine would skip
  //    every single file and still report a successful, verified ingest.
  if (options.fileFilter && options.fileFilter.extCat &&
      Object.keys(options.fileFilter.extCat).length === 0) {
    return abort('The file filter is enabled but no format is selected — nothing would be copied. Ingest aborted.');
  }

  // Per-destination state
  const R = destinations.map((d, i) => ({
    di: i,
    name: d.name || '',
    destPath: options.fixedDestPath || path.join(d.path, folderName),
    active: true,
    copiedFiles: 0, errors: 0, errorList: [], failedFiles: [], failedMap: {}, unstableFiles: [],
    copied: [],               // { rel, src, dest, size, mtimeMs, srcHash, _writeOk }
    copiedForSentinel: [], cksumEntries: [],
  }));

  // ── Scan the source ONCE ────────────────────────────────────────────────
  const onlyRel = options.onlyRel ? new Set(options.onlyRel.map(p => p.replace(/\\/g,'/'))) : null;
  // File filter (optional): { extCat: {ext:'VIDEO'|'AUDIO'|'PICTURES'|'OTHERS'},
  //                           copyEmpty: bool, reorganize: bool }
  const FF = options.fileFilter && options.fileFilter.extCat ? options.fileFilter : null;
  const ffReorg = !!(FF && FF.reorganize);
  const allFiles=[], allDirs=[];
  const SKIP = new Set(['.DS_Store','.Spotlight-V100','.Trashes','.fseventsd','.TemporaryItems']);
  const skipKeys = new Set(options.skipKeys || []);
  const SENTINEL_FILENAME = '.ingesto.json';
  // Anything we cannot even READ on the card is an error, never a silent skip:
  // a dying CFexpress that throws EIO on one folder used to produce a green
  // "100 %, 0 error" ingest with a whole subtree missing.
  const scanErrors = [];
  const scanFail = (p, e, what) => scanErrors.push({
    file: (path.relative(source.path, p) || '.').replace(/\\/g,'/'),
    error: `${what} could not be read on the source: ${e && e.message ? e.message : e}`,
    phase: 'scan',
  });
  (function scan(dir) {
    let entries;
    try { entries=fs.readdirSync(dir,{withFileTypes:true}); }
    catch(e){ scanFail(dir, e, 'folder'); return; }
    if (!entries.length) { allDirs.push(dir); return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || isAppleDouble(e)) continue;
      // Same rule as sentinel.listAllFiles: skip the tracking log AND its
      // siblings (.unreadable / .tmp), so card bookkeeping is never ingested.
      if ((e.name === SENTINEL_FILENAME || e.name.startsWith(SENTINEL_FILENAME + '.')) && dir === source.path) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { allDirs.push(full); scan(full); }
        else {
          const s=fs.statSync(full);
          const rel = path.relative(source.path, full).replace(/\\/g, '/');
          seenFiles++;
          if (onlyRel && !onlyRel.has(rel)) continue;
          if (skipKeys.size) {
            const key = `${rel}|${s.size}|${Math.floor(s.mtimeMs/1000)}`;
            if (skipKeys.has(key)) { skippedAlready++; continue; }
          }
          let cat = null;
          if (FF) {
            const ext = path.extname(e.name).slice(1).toLowerCase();
            // Own-property lookup only. A file literally named "CLIP.constructor"
            // or "CLIP.__proto__" otherwise resolved through Object.prototype,
            // came back truthy, and was copied even though no format matching it
            // was enabled — and with Reorganize on, landed in a folder named
            // "[object Object]". The card's contents decide this key, so it is
            // untrusted input.
            cat = Object.prototype.hasOwnProperty.call(FF.extCat, ext) ? FF.extCat[ext] : null;
            if (!cat) continue;                       // format not enabled → skipped
            if (ffReorg && cat === 'OTHERS') continue; // Others never reorganized
          }
          allFiles.push({src:full,size:s.size,mtimeMs:s.mtimeMs,rel,cat});
          totalBytes+=s.size;
        }
      } catch(e) { scanFail(full, e, 'entry'); }
    }
  })(source.path);
  totalFiles = allFiles.length;

  { const why = emptyRunReason(seenFiles, skippedAlready, totalFiles);
    if (why) for (const r of R) { r.errors++; r.errorList.push({ file:'(card)', error: why, phase:'scan' }); } }

  // Surface the scan failures on every destination result: they must count as
  // errors so the run can never come back success:true, and so the sentinel is
  // not written on a card whose content was only partially seen.
  if (scanErrors.length) {
    for (const r of R) { r.errors += scanErrors.length; r.errorList.push(...scanErrors.map(e => ({...e}))); }
  }

  // Destination-relative path per file. Normally identical to the source rel;
  // with "Reorganize files on destination" every kept file is flattened into
  // /VIDEO, /AUDIO or /PICTURES, with an _2/_3… suffix on basename collisions.
  // The suffixed name must itself be checked and reserved: a card holding
  // 100/CLIP.MOV, 101/CLIP.MOV and 102/CLIP_2.MOV used to send two files to the
  // same VIDEO/CLIP_2.MOV, and the second one overwrote the first.
  const usedNames = new Set();
  for (const f of allFiles) {
    if (!ffReorg) { f.destRel = f.rel; continue; }
    const base = path.basename(f.rel);
    const ext  = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = f.cat + '/' + base;
    let n = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      n++;
      candidate = f.cat + '/' + stem + '_' + n + ext;
    }
    usedNames.add(candidate.toLowerCase());
    f.destRel = candidate;
  }
  // Retry runs pin each file to the destination path it FAILED at (recorded by
  // the original run), so a reorganize retry overwrites the bad copy in place.
  if (options.destRelOverride) {
    for (const f of allFiles) {
      const o = options.destRelOverride[f.rel];
      if (typeof o === 'string' && o && !o.includes('..')) f.destRel = o;
    }
  }

  // ── Destination roots, folder tree, note file ───────────────────────────
  for (const r of R) {
    try { fs.mkdirSync(r.destPath, {recursive:true}); }
    catch (e) {
      r.active = false; r.errors++;
      r.errorList.push({ file:'(destination)', error:e.message, phase:'copy' });
    }
  }
  const srcNote = source.note || options.note || '';
  if (!options.fixedDestPath && srcNote && srcNote.trim()) {
    const noteFileName = `${source.counter || '001'}_note.txt`;
    const sep = '-'.repeat(40);
    const noteContent = [
      'ingesto - Shooting Note', sep,
      'Date    : ' + new Date().toLocaleString(),
      'Counter : ' + (source.counter || '001'),
      'Card    : ' + source.name,
      'Operator: ' + (source.cameraman || 'Unknown'),
      'Camera  : ' + (source.camera || 'Unknown'),
      sep, '', srcNote.trim(), ''
    ].join('\n');
    for (const r of R) {
      if (!r.active) continue;
      try { writeFileAtomic(path.join(r.destPath, noteFileName), noteContent); }
      catch (e) { console.error('Note file write failed:', e.message); }
    }
  }
  // Full source tree is pre-created only when copying everything, or when the
  // filter is on WITH "Copy empty folders". Filter without that option: folders
  // are created on demand per file, so dirs left empty by filtering never appear.
  // Reorganize ignores the source tree entirely (/VIDEO etc. created per file).
  if (!onlyRel && !ffReorg && (!FF || FF.copyEmpty)) {
    for (const d of allDirs) {
      const rel = path.relative(source.path, d);
      let st=null; try { st=fs.statSync(d); } catch(_){}
      for (const r of R) {
        if (!r.active) continue;
        try {
          const dd = path.join(r.destPath, rel);
          fs.mkdirSync(dd,{recursive:true});
          if (st) fs.utimesSync(dd,st.atime,st.mtime);
        } catch(_){}
      }
    }
  }

  const spd=[], speedPush=(b,ms)=>{ if(ms>0){ spd.push(b/ms*1000); if(spd.length>12)spd.shift(); } };
  const avgSpd=()=>spd.length?spd.reduce((a,b)=>a+b)/spd.length:0;

  // ── PHASE 1 — read once, write to every destination (green bar) ─────────
  tCopyStart = Date.now(); pausedAtCopyStart = pausedMs;
  { let lastB=0, lastT=Date.now();
    for (let i=0; i<allFiles.length; i++) {
      if (cancelCopy) break;
      await pauseGate(mainWindow);
      if (cancelCopy) break;
      const act = R.filter(r=>r.active);
      if (!act.length) break;
      const file=allFiles[i], rel=file.rel;
      const destFilesAbs = act.map(r => path.join(r.destPath, file.destRel));
      // Write under a temporary name; promote to the final name only once the
      // file is complete (and fsynced, in SECURE/PRO).
      const destTmpAbs   = destFilesAbs.map(p => p + PART_SUFFIX);
      const onB = b => {
        copiedBytes+=b;
        const now=Date.now();
        if (now-lastT>=150){ speedPush(copiedBytes-lastB,now-lastT); lastB=copiedBytes; lastT=now; }
        const sp=avgSpd();
        onProgress({ sourceName:source.name, sourcePath:source.path, currentFile:rel, phase:'copy',
          destIndex:0, destName:destNames,
          copiedFiles:R[0].copiedFiles, totalFiles, remainingFiles:totalFiles-i-1,
          copiedBytes, totalBytes, progress:totalBytes>0?copiedBytes/totalBytes:0,
          speed:sp, eta:sp>0?(totalBytes-copiedBytes)/sp:0,
          errors:R.reduce((a,r)=>a+r.errors,0) });
      };
      try {
        // On-demand parent dir: retry runs (onlyRel), filtered copies without
        // "Copy empty folders", and reorganize (/VIDEO etc.) all skip the
        // upfront tree creation, so make sure each file's parent exists.
        if (onlyRel || ffReorg || options.destRelOverride || (FF && !FF.copyEmpty)) for (const df of destFilesAbs) { try { fs.mkdirSync(path.dirname(df),{recursive:true}); } catch(_){} }
        // SECURE/PRO: evict this source file from the OS cache before reading
        // it, so the copy reads what the card delivers NOW — not what a
        // previous ingest of the same card left sitting in RAM (observed on
        // Windows: re-ingesting a 75 MB/s card ran the copy at 300-600 MB/s
        // from cache). The bytes were originally read from the card either
        // way, but SECURE's promise is about the card as it is at THIS ingest.
        // FAST/VERIFIED make no such claim and keep the free speed-up.
        if (isPro || isSecure) {
          let purged = false;
          try { purged = nocache.purgeFileCache(file.src); } catch(_) {}
          if (!purged) copyPurgeFails++;
        }
        const { digest, failed } = await copyFanOut(file.src, destTmpAbs, onB, hasher);
        const srcHash = digest == null ? null : String(digest);
        let st=null; try { st=fs.statSync(file.src); } catch(_){}
        for (let k=0; k<act.length; k++) {
          const r = act[k], df = destFilesAbs[k], tmp = destTmpAbs[k], err = failed[k];
          if (err) {
            // Drop the partial write. It never carried the final name, so there
            // is nothing on the destination that could pass for a good file.
            try { fs.unlinkSync(tmp); } catch(_) {}
            // A user cancellation is not a copy error — don't inflate the count.
            if (!err.aborted) { r.errors++; r.errorList.push({file:rel,error:err.message,phase:'copy'}); r.failedFiles.push(rel); r.failedMap[rel]=file.destRel; }
            continue;
          }
          try {
            // Order matters: flush BEFORE copying the source's permissions onto
            // the file, or a read-only source makes every fsync fail (EACCES).
            if (isPro || isSecure) {
              const fres = await fsyncFile(tmp);
              if (!fres.ok && fres.unsupported && !r._fsyncWarned) {
                r._fsyncWarned = true;   // warn once per destination, not per file
                r.errorList.push({ file: '(destination)', phase: 'warning',
                  error: `this drive didn't confirm when files were fully written (common on network drives, or while antivirus is scanning). The copy completed — for extra certainty, run Verify on this folder later.` });
              }
            }
            fs.renameSync(tmp, df);            // atomic promotion to the final name
            if (st) { try { fs.chmodSync(df,st.mode); fs.utimesSync(df,st.atime,st.mtime); } catch(_){} }
            r.copiedFiles++;
            r.copied.push({rel,destRel:file.destRel,src:file.src,dest:df,size:file.size,mtimeMs:file.mtimeMs,srcHash});
          } catch(e) {
            // Flush or rename failed — the file is NOT on the destination under
            // its final name, and that is now reported instead of swallowed.
            try { fs.unlinkSync(tmp); } catch(_) {}
            r.errors++;
            r.errorList.push({file:rel,error:`could not be committed to the destination: ${e.message}`,phase:'copy'});
            r.failedFiles.push(rel); r.failedMap[rel]=file.destRel;
          }
        }
      } catch(e){
        // Source read failure — the file failed for every active destination.
        for (const tmp of destTmpAbs) { try { fs.unlinkSync(tmp); } catch(_) {} }
        for (const r of act) { r.errors++; r.errorList.push({file:rel,error:e.message,phase:'copy'}); r.failedFiles.push(rel); r.failedMap[rel]=file.destRel; }
      }
    }
  }
  tCopyEnd = Date.now(); tV1End = tCopyEnd; tV2End = tCopyEnd;
  pausedAtCopyEnd = pausedAtV1End = pausedAtV2End = pausedMs;

  // The SECURE/PRO promise is about the card as it is at THIS ingest. If the
  // cache eviction refused to run, the copy may have been answered from RAM by
  // a previous ingest of the same card — the bytes are still the bytes we
  // fingerprinted, so nothing is corrupt, but "we read your card just now" is
  // no longer something we can claim. Say so instead of staying silent.
  // nocache.available() first: on a machine with no cache-control capability at
  // all (koffi missing), every purge "fails" by definition and this warning
  // would fire on every single SECURE/PRO ingest. That case is already covered
  // by coldVerify, which turns the "verify later" hint back on.
  if (!cancelCopy && (isPro || isSecure) && copyPurgeFails > 0 && R.length && nocache.available()) {
    R[0].errorList.push({ file: '(card read)', phase: 'warning',
      error: `the computer kept part of this card in its memory, so the copy may not have re-read the card itself. Your files are copied and verified — if this card was already ingested on this machine, run Verify on the destination later to be sure.` });
  }

  // Clear any *.ingesto-part still sitting in the destinations (cancelled run,
  // or residue from an earlier crash) so a folder never keeps stray temp files.
  for (const r of R) { if (r.active) sweepPartFiles(r.destPath); }

  // ── PHASE 2 — VERIFY each destination (blue), then optional source pass ─
  if (!cancelCopy && (options.mode==='normal' || options.mode==='slow' || isPro)) {
    spd.length=0;
    // Unique source files copied OK to at least one destination (for the PRO
    // double-read pass, which now reads the source ONCE — not once per dest).
    const srcByRel = new Map();
    for (const r of R) for (const c of r.copied) if (!srcByRel.has(c.rel)) srcByRel.set(c.rel, c);
    const destPassTotal = R.reduce((a,r)=>a + r.copied.reduce((x,c)=>x+c.size,0), 0);
    const srcPassTotal  = proDouble ? [...srcByRel.values()].reduce((a,c)=>a+c.size,0) : 0;
    const verifyTotalBytes = destPassTotal + srcPassTotal;
    const totalSteps = R.reduce((a,r)=>a+r.copied.length,0) + (proDouble ? srcByRel.size : 0);
    let verifiedBytes=0, verifiedFiles=0, lastB=0, lastT=Date.now();
    let passBytes=0, passTotal=destPassTotal;
    const emit=(cur,pass,di,dn,extra)=>{
      const now=Date.now();
      if (now-lastT>=120){ speedPush(verifiedBytes-lastB,now-lastT); lastB=verifiedBytes; lastT=now; }
      const sp=avgSpd();
      onProgress({ sourceName:source.name, sourcePath:source.path, currentFile:cur, phase:'verify',
        destIndex:di, destName:dn,
        copiedFiles:verifiedFiles, totalFiles:totalSteps, remainingFiles:totalSteps-verifiedFiles,
        copiedBytes:verifiedBytes, totalBytes:verifyTotalBytes||1,
        progress:verifyTotalBytes>0?verifiedBytes/verifyTotalBytes:1,
        passProgress: passTotal>0 ? passBytes/passTotal : 1,
        speed:sp, eta:sp>0?(verifyTotalBytes-verifiedBytes)/sp:0,
        errors:R.reduce((a,r)=>a+r.errors,0), pass, ...(extra||{}) });
    };

    // Per-destination progress and throughput. Until now the renderer received
    // ONE cumulative figure for the whole pass and had to work out each
    // destination's share by arithmetic — which was wrong twice already, and
    // becomes meaningless once destinations are verified at the same time.
    // Each destination now reports its own progress and its own speed.
    for (const r of R) {
      r._vTotal = r.copied.reduce((a,c)=>a+c.size, 0);
      r._vBytes = 0; r._vSpd = []; r._sB = 0; r._sT = Date.now(); r._lastEmit = 0;
    }
    const destSpeed = (r) => {
      const now = Date.now(), ms = now - r._sT;
      if (ms >= 150) {
        r._vSpd.push((r._vBytes - r._sB) / ms * 1000);
        if (r._vSpd.length > 12) r._vSpd.shift();
        r._sB = r._vBytes; r._sT = now;
      }
      return r._vSpd.length ? r._vSpd.reduce((a,b)=>a+b) / r._vSpd.length : 0;
    };
    const emitDest = (r, cur, force) => {
      const now = Date.now();
      // Several lanes reporting per file would flood the renderer; one update
      // per destination per 100 ms is more than the eye can follow, and the
      // last file of a destination always gets through.
      if (!force && now - r._lastEmit < 100) return;
      r._lastEmit = now;
      emit(cur, 'dest', r.di, r.name, {
        destProgress: r._vTotal > 0 ? Math.min(1, r._vBytes / r._vTotal) : 1,
        destSpeed: destSpeed(r),
      });
    };

    // 2a — verify every destination against the fingerprint taken during copy.
    //
    // Destinations are verified CONCURRENTLY, but only when they sit on
    // different physical devices. Two folders on the same disk are read one
    // after the other: making that disk seek between two streams is slower
    // than reading them in turn. The grouping reads the machine's actual
    // topology (the filesystem's device id) instead of guessing from paths.
    //
    // Worst case is "no gain", never a regression: the reads are asynchronous
    // and the total amount of hashing is unchanged, so if the fingerprint
    // calculation is what saturates, the lanes simply take turns on it.
    const lanes = groupByDevice(R, r => r.destPath);
    // ONE HASHER PER LANE. hashPro() calls hasher.init() then streams into it;
    // two concurrent calls on the same instance would interleave their updates
    // and produce a digest belonging to neither file — a silent false
    // "checksum mismatch", the worst possible failure for this application.
    const laneHashers = [];
    for (let i = 0; i < lanes.length; i++) {
      laneHashers.push(!hasher ? null
        : (i === 0 ? hasher : await newProHasher(isPro ? proAlgo : 'xxh64')));
    }

    const runLane = async (group, laneHasher) => {
      for (const r of group) {
        if (!r.copied.length) continue;   // nothing was written here
        for (const c of r.copied) {
          if (cancelCopy) return;
          await pauseGate(mainWindow);
          if (cancelCopy) return;
          let okv=false;
          try {
            if (isPro || isSecure) {
              // Evict this destination file's cached pages first, so the
              // read-back is forced to hit the disk. On macOS the uncached write
              // already kept most pages out (APFS); this covers Windows/Linux —
              // where the copy is fully cached and the read-back used to compare
              // RAM with itself — and exFAT/NTFS destinations on macOS, whose
              // drivers ignore F_NOCACHE. The RESULT is kept: a failed purge
              // (antivirus holding the file, exotic filesystem) means this
              // read-back may come from RAM, and coldVerify must say so.
              try { if (!nocache.purgeFileCache(c.dest)) r._purgeFails = (r._purgeFails||0) + 1; }
              catch(_) { r._purgeFails = (r._purgeFails||0) + 1; }
              if (await hashPro(c.dest,laneHasher) !== c.srcHash) throw new Error(isPro?'checksum mismatch':'xxHash mismatch');
            } else {
              if (fs.statSync(c.src).size !== fs.statSync(c.dest).size) throw new Error('Size mismatch');
            }
            okv=true;
          } catch(e){
            r.errors++; r.errorList.push({file:c.rel,error:e.message,phase:'verify'});
            r.failedFiles.push(c.rel); r.failedMap[c.rel]=c.destRel;
            // Quarantine the bad copy. Until now it kept its FINAL name while
            // being left out of the checksum list, so if the operator never ran
            // "Re-copy failed files" the folder held a corrupt clip under its
            // real name — and a later Verify on that folder listed it merely as
            // an "extra file" and still reported "Verification passed".
            // The whole point of the .ingesto-part protocol is that a real name
            // means a good file; this restores it for the verify phase too.
            try { fs.renameSync(c.dest, c.dest + FAILED_SUFFIX); c._quarantined = true; }
            catch(_) {
              // The bad copy is still sitting there under its REAL name. Left
              // silent, a later Verify listed it merely as an "extra file" and
              // still reported "Verification passed". Say it explicitly.
              r.errorList.push({ file:c.rel, phase:'verify',
                error:'this file failed verification and could NOT be set aside — a bad copy is still in the destination under its real name. Delete it by hand or re-copy the card.' });
            }
          }
          c._writeOk = okv;
          if (okv && !proDouble) {
            r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
            if (isPro || isSecure) r.cksumEntries.push({ rel:c.destRel||c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
          }
          verifiedBytes+=c.size; passBytes+=c.size; verifiedFiles++;
          r._vBytes += c.size;
          emitDest(r, c.rel, r._vBytes >= r._vTotal);
        }
        // This destination is finished: say so even if the throttle just ate
        // the last update, or its bar would sit at 97% for the rest of the run.
        emitDest(r, '', true);
      }
    };
    await Promise.all(lanes.map((g, i) => runLane(g, laneHashers[i])));
    tV1End = Date.now(); tV2End = tV1End;
    pausedAtV1End = pausedAtV2End = pausedMs;

    // 2b — PRO double-read: re-read the SOURCE (once, whatever the number of
    // destinations) to catch a failing/unstable card.
    if (proDouble && !cancelCopy) {
      passBytes=0; passTotal=srcPassTotal;
      // Measure ONCE, before re-reading anything, whether cache eviction really
      // works on this card in this machine. This is the guarantee the whole
      // double read rests on, so it is tested rather than inferred.
      var probe = { ok:false };
      for (const c of srcByRel.values()) {
        if (c.size >= 1024*1024) { probe = probeCacheEviction(c.src); break; }
      }
      for (const c of srcByRel.values()) {
        if (cancelCopy) break;
        await pauseGate(mainWindow);
        if (cancelCopy) break;
        // Only meaningful if at least one destination wrote this file OK
        const holders = R.filter(r => r.copied.some(x => x.rel===c.rel && x._writeOk));
        if (holders.length) {
          let stable=false;
          // Evict this file's cached pages first, so the re-read is forced to
          // hit the card. Without it the OS answers from RAM and this whole
          // pass compares memory with itself (see purgeFileCache).
          let purged = false;
          try { purged = nocache.purgeFileCache(c.src); } catch(_) {}
          if (!purged) dblPurgeFails++;
          try { stable = (await hashPro(c.src, hasher) === c.srcHash); }
          catch(e){ stable=false; }
          for (const r of holders) {
            if (stable) {
              r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
              r.cksumEntries.push({ rel:c.destRel||c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
            } else {
              r.errors++;
              r.errorList.push({ file:c.rel, error:'source read unstable', phase:'source' });
              r.unstableFiles.push(c.rel);
            }
          }
        }
        verifiedBytes+=c.size; passBytes+=c.size; verifiedFiles++;
        emit(c.rel,'source',0,destNames);
      }
      tV2End = Date.now(); pausedAtV2End = pausedMs;

      // ── Was the source actually re-read, or served from RAM? ─────────────
      // The whole point of the PRO double read is to ask the CARD a second
      // time. If the OS page cache answers instead, the pass compares memory
      // with itself and always passes — worse than useless, because it looks
      // like a guarantee.
      //
      // The verdict comes from the probe above (a measurement, see
      // probeCacheEviction), not from comparing pass speeds. Two triggers, one
      // remedy — the forced unmount/remount re-check:
      //   • the probe showed the eviction does not work on this medium, or
      //   • an eviction call outright failed during the pass.
      // A probe that could not run (every file under 1 MB, timings too small to
      // compare) says nothing and does NOT raise an alarm; dblPurgeFails still
      // covers the case where the mechanism is plainly unavailable.
      const copyMs = Math.max(1, tCopyEnd - tCopyStart);
      const dblMs  = Math.max(1, tV2End - tV1End);
      const copySpeed = copiedBytes / (copyMs / 1000);
      const dblSpeed  = srcPassTotal / (dblMs / 1000);
      const probeSaysCached = probe.ok && !probe.evicted;
      if (srcPassTotal > 0 && (probeSaysCached || dblPurgeFails > 0)) {
        for (const r of R) {
          r.doubleReadCached = true;
          r.doubleReadSpeed  = dblSpeed;
          r.copySpeedMeasured = copySpeed;
          // Only when the PROBE is what raised the alarm. When the trigger was
          // a purge that failed mid-pass, showing a 50x separation under the
          // words "too close to be a real read" contradicts the alarm itself.
          r.probe = probeSaysCached ? { coldMs: probe.coldMs, warmMs: probe.warmMs } : null;
          // Source-relative path + the hash read during the copy, so the user
          // can ask for a real (unmount/remount) re-check afterwards.
          r.recheckList = [...srcByRel.values()]
            .filter(c => c.srcHash)
            .map(c => ({ rel: c.rel, hash: String(c.srcHash) }));
        }
        // One entry, on one result only — the source pass happens once per
        // card, and a 3-destination ingest used to list the same line thrice.
        // Wording is aimed at non-technical operators: what happened, and that
        // their footage is fine.
        R[0].errorList.push({ file: '(card double-check)', phase: 'warning',
          error: `skipped — the card could not be read a second time, the computer answered from its memory. All files are still fully verified (SECURE level).` });
      }
    }

    // Fingerprint sidecars at each destination folder root (SECURE & PRO)
    for (const r of R) {
      const wantCk = !cancelCopy && !options.fixedDestPath && options.writeChecksum !== false
                     && (isPro || isSecure) && r.cksumEntries.length;
      if (wantCk && options.cksumList !== false) {
        const ckName = writeChecksumList(r.destPath, cksumAlgo, r.cksumEntries);
        if (!ckName) r.errorList.push({ file:'(checksum list)', error:'could not be written to destination', phase:'sidecar' });
      }
      if (wantCk && isPro && options.cksumMhl === true && (proAlgo==='xxh64'||proAlgo==='md5')) {
        const mhlName = writeMHL(r.destPath, proAlgo, r.cksumEntries, { startMs:t0 });
        if (!mhlName) r.errorList.push({ file:'(MHL manifest)', error:'could not be written to destination', phase:'sidecar' });
      }
      // ASC MHL comes IN ADDITION to the classic manifest, and covers every
      // algorithm ingesto can produce — not only the two the 2005 format knew.
      if (wantCk && options.ascMhl === true) {
        const ascName = await writeAscMhl(r.destPath, cksumAlgo, r.cksumEntries, { startMs:t0 });
        if (!ascName) r.errorList.push({ file:'(ASC MHL manifest)', error:'could not be written to destination', phase:'sidecar' });
      }
    }
  } else if (!cancelCopy) {
    // FAST mode — no verification; every copied file is recorded for the sentinel.
    // A CANCELLED run must never land here: it used to fall through to this
    // branch and declare every copied file good, which then fed the ingest
    // report's "verified" file list.
    for (const r of R) for (const c of r.copied)
      r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
  }

  return R.map(r => ({
    // Copying zero files out of a non-empty card is a failure, not a success.
    success: !cancelCopy && !r.errors && !scanErrors.length
             && !(totalFiles > 0 && r.copiedFiles === 0),
    canceled: cancelCopy,
    scanIncomplete: scanErrors.length > 0,
    // True when read-back verification actually bypassed the OS cache (macOS).
    // When false in SECURE/PRO, the UI suggests a later cold Verify.
    // True only when the machine CAN defeat the cache AND no destination
    // read-back purge failed. Capability alone is not enough: on a Windows
    // box where an antivirus holds each fresh file open, every purge fails
    // and the read-back comes from RAM — the "check again later" hint must
    // then reappear instead of being silenced by a mechanism that exists but
    // didn't work. (The PRO source pass has its own guard: the speed detector.)
    coldVerify: (isPro || isSecure) ? (nocache.available() && !(r._purgeFails > 0)) : null,
    // True when the PRO source re-read was demonstrably answered by the OS
    // cache rather than the card — the pass proves nothing in that case.
    doubleReadCached: !!r.doubleReadCached,
    doubleReadSpeed: r.doubleReadSpeed || 0,   // bytes/s of the source re-read
    // Probe timings (ms for an 8 MB block, cold vs warm) when the double read
    // was judged cached — useful in a bug report, never shown as-is.
    cacheProbe: r.probe || null,
    copySpeed: r.copySpeedMeasured || 0,       // bytes/s sustained while copying
    recheckList: r.recheckList || null,        // {rel,hash}[] for a forced re-check
    proAlgoUsed: isPro ? proAlgo : null,
    sourceName: source.name, sourcePath: source.path, destPath: r.destPath,
    totalFiles, copiedFiles: r.copiedFiles, totalBytes, copiedBytes,
    errors: r.errors, errorList: r.errorList,
    failedFiles: r.failedFiles, failedMap: r.failedMap, unstableFiles: r.unstableFiles,
    _cksumEntries: r.cksumEntries,
    mode: options.mode, proAlgo: isPro ? proAlgo : null,
    // Each phase minus the time the operator held it paused.
    copyMs:    Math.max(0, (tCopyEnd-tCopyStart) - (pausedAtCopyEnd-pausedAtCopyStart)),
    verify1Ms: Math.max(0, (tV1End-tCopyEnd)     - (pausedAtV1End-pausedAtCopyEnd)),
    verify2Ms: Math.max(0, (tV2End-tV1End)       - (pausedAtV2End-pausedAtV1End)),
    // Pause excluded here as well: the four summary tiles are COPY + V1 + V2
    // against TOTAL, and leaving pause in only the total made them contradict
    // each other on screen.
    duration: Math.max(0, (Date.now()-t0) - pausedMs),
    _copiedForSentinel: r.copiedForSentinel,
  }));
}


// A destination folder name must be exactly one usable path segment. Anything
// else (empty, ".", "..", a name containing a separator) means the template is
// broken and the ingest would land somewhere the user did not choose.
function isSafeFolderName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[\/\\]/.test(n)) return false;
  if (n.length > 200) return false;   // stay clear of ENAMETOOLONG
  return true;
}

// True when `child` is `parent` itself or lives underneath it. Comparison is
// case-insensitive on Windows/macOS, where the filesystem is too.
function pathContains(parent, child) {
  try {
    const norm = p => {
      let r = path.resolve(String(p || ''));
      if (process.platform !== 'linux') r = r.toLowerCase();
      return r;
    };
    const p = norm(parent), c = norm(child);
    if (!p || !c) return false;
    if (p === c) return true;
    return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  } catch (_) { return false; }
}

function buildFolderName(tpl, src) {
  const n=new Date(), p=x=>String(x).padStart(2,'0');

  // For optional fields (cameraman, camera): replace with empty string if not set
  // so we can clean up orphan separators after
  const cameraman = (src.cameraman||'').trim();
  const camera    = (src.camera   ||'').trim();

  let result = tpl
    .replaceAll('{counter}',   src.counter          || '001')
    .replaceAll('{cardname}',  src.name             || 'CARD')
    .replaceAll('{operator}',  cameraman)   // canonical name
    .replaceAll('{cameraman}', cameraman)   // legacy alias — keeps old saved templates working
    .replaceAll('{camera}',    camera)
    .replaceAll('{YY}',  String(n.getFullYear()).slice(-2))
    .replaceAll('{MM}',  p(n.getMonth()+1))
    .replaceAll('{DD}',  p(n.getDate()))
    .replaceAll('{HH}',  p(n.getHours()))
    .replaceAll('{MIN}', p(n.getMinutes()))
    .replaceAll('{SS}',  p(n.getSeconds()));

  // Clean up orphan separators left by empty variables:
  // e.g. "001__card___260503" → "001_card_260503"
  result = result
    .replace(/[_\-]+/g, m => m[0]) // collapse repeated separators to one
    .replace(/^[_\-]+|[_\-]+$/g, ''); // trim leading/trailing separators

  // Remove illegal filesystem chars
  return result.replace(/[<>:"|?*/\\]/g,'_');
}

// Build a matcher that extracts the counter from a folder name, given the SAME
// template used to create the folders. Without this, the old code only saw a
// counter when it was the FIRST thing in the name — so moving {counter} behind
// the date (which the UI actively invites) made every scan return 001 and the
// collision check blind, silently overwriting earlier reels.
//
// Returns { extract(name) -> number|null }. Falls back to "leading digits" when
// no template (or no {counter} token) is available, matching the old behavior.
function makeCounterMatcher(tpl) {
  const leading = name => { const m = String(name).match(/^(\d{1,4})(?:[_\-]|$)/); return m ? parseInt(m[1],10) : null; };
  if (!tpl || typeof tpl !== 'string' || !tpl.includes('{counter}')) return { extract: leading };

  const FIXED = { '{YY}':'\\d{2}', '{MM}':'\\d{2}', '{DD}':'\\d{2}',
                  '{HH}':'\\d{2}', '{MIN}':'\\d{2}', '{SS}':'\\d{2}' };
  // {operator} is the canonical name; {cameraman} the legacy alias. BOTH must be
  // here: a token missing from this set falls through to the literal branch and
  // the counter scan then never matches any folder — reintroducing the
  // counter-reset/overwrite bug this matcher exists to fix.
  const VAR   = new Set(['{cardname}','{cameraman}','{operator}','{camera}']);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Tokenize the template into {token} pieces and literal runs, then rebuild it
  // as a regex: {counter} → capture, date tokens → fixed digits, free-text
  // tokens → non-greedy any, literals → escaped.
  //
  // CRITICAL: buildFolderName post-processes the substituted name — illegal
  // filesystem chars become "_", separator runs collapse to one, and leading/
  // trailing separators get trimmed (an empty {operator} does exactly that).
  // The regex must mirror ALL of it: template "{counter}_{operator}" with an
  // empty operator creates folder "001", and a pattern demanding the literal
  // "_" would never match it — the scan would return next=001 forever and the
  // overwrite bug this matcher exists to fix would come straight back. Literal
  // separator runs therefore become "[_-]*" (flexible, absorbable), after the
  // same illegal-char mapping the engine applies.
  let re = '^';
  const parts = tpl.split(/(\{[a-zA-Z]+\})/).filter(s => s !== '');
  for (const p of parts) {
    if (p === '{counter}') re += '(\\d{1,4})';
    else if (FIXED[p]) re += FIXED[p];
    else if (VAR.has(p)) re += '.*?';
    else re += esc(p.replace(/[<>:"|?*\/\\]/g, '_')).replace(/[_\-]+/g, '[_\\-]*');
  }
  re += '$';
  let rx = null; try { rx = new RegExp(re); } catch(_) { rx = null; }
  return { extract: name => {
    if (rx) { const m = String(name).match(rx); if (m && m[1] != null) return parseInt(m[1],10); return null; }
    return leading(name);
  }};
}

// ─── IPC: Check if counter already exists in any destination ─────────────────
// Returns the first conflicting folder name found, or null if clear.
ipcMain.handle('check-counter-collision', async (_, destPaths, counter, template) => {
  const cnum = parseInt(counter, 10);
  if (!Number.isFinite(cnum)) return null;
  const matcher = makeCounterMatcher(template);

  for (const destPath of destPaths) {
    try {
      const entries = fs.readdirSync(destPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const n = matcher.extract(entry.name);
        if (n === cnum) return entry.name; // collision found
      }
    } catch (_) {}
  }
  return null; // no collision
});

// ─── IPC: Scan destinations — returns { max, next } ─────────────────────────
function scanCounterInDests(destPaths, template) {
  const matcher = makeCounterMatcher(template);
  let maxNum = 0;
  for (const destPath of destPaths) {
    try {
      for (const entry of fs.readdirSync(destPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const n = matcher.extract(entry.name);
        if (n != null && n > maxNum) maxNum = n;
      }
    } catch (_) {}
  }
  return { max: maxNum, next: Math.max(maxNum + 1, 1) };
}

// Legacy — kept for compatibility
ipcMain.handle('scan-dest-counter', async (_, destPaths, template) => {
  return scanCounterInDests(destPaths, template).next;
});

// New — returns both max found and next to use
ipcMain.handle('scan-dest-counter-full', async (_, destPaths, template) => {
  return scanCounterInDests(destPaths, template);
});

ipcMain.handle('open-external', async (_, url) => {
  // SECURITY: only ever hand http(s) URLs to the OS. Without this, a value
  // arriving from the update check (a remote version.json) could be a file://
  // or UNC path that leaks credentials or launches a local handler.
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.href);
    return true;
  } catch (_) { return false; }
});
let _psbId = null;
ipcMain.handle('set-power-block', (_, on) => {
  try {
    if (on) { if (_psbId === null || !powerSaveBlocker.isStarted(_psbId)) _psbId = powerSaveBlocker.start('prevent-app-suspension'); }
    else if (_psbId !== null && powerSaveBlocker.isStarted(_psbId)) { powerSaveBlocker.stop(_psbId); _psbId = null; }
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('ntfy-send', async (_, opts) => {
  return new Promise((resolve) => {
    try {
      const server = (opts.server || 'https://ntfy.sh').replace(/\/+$/, '');
      const url = new URL(server + '/' + encodeURIComponent(opts.topic || ''));
      const body = Buffer.from(String(opts.message || ''), 'utf8');
      const mod = url.protocol === 'http:' ? require('http') : https;
      const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length };
      if (opts.title)    headers['Title']    = String(opts.title).replace(/[^\x20-\x7E]/g, '');   // ASCII-safe
      // Tags and Priority are HTTP header values too: a non-ASCII tag (an emoji,
      // an accent) throws ERR_INVALID_CHAR and loses the WHOLE notification.
      if (opts.tags) {
        const t = String(opts.tags).replace(/[^\x20-\x7E]/g, '').replace(/[^a-zA-Z0-9_,\-]/g, '').replace(/^,+|,+$/g,'');
        if (t) headers['Tags'] = t;
      }
      if (opts.priority) {
        const p = parseInt(opts.priority, 10);
        if (Number.isFinite(p) && p >= 1 && p <= 5) headers['Priority'] = String(p);
      }
      const req = mod.request(url, { method: 'POST', headers, timeout: 8000 }, res => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(body); req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
});
ipcMain.handle('is-removable', async (_, p) => {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('diskutil', ['info', p],
        { encoding: 'utf8', timeout: 5000, stdio:['ignore','pipe','ignore'] });
      return /Removable Media:\s*Removable/i.test(out);
    }
    if (process.platform === 'win32') {
      const m = String(p).match(/^([A-Za-z]):/);
      if (!m) return false;
      const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${m[1]}:'\\").DriveType"`, { encoding: 'utf8', timeout: 5000 });
      return out.trim() === '2';  // 2 = Removable Disk
    }
    if (process.platform === 'linux') {
      // A mount under the desktop automount roots is removable media by
      // definition; the sysfs 'removable' flag confirms it when readable
      // (SD readers over USB report 1; some internal readers report 0,
      // which is why the mountpoint heuristic comes first).
      if (/^\/(media|run\/media)\//.test(String(p))) return true;
      try {
        const dev = execFileSync('findmnt', ['-n', '-o', 'SOURCE', p],
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const base = path.basename(dev);
        for (const rel of [base + '/removable', base + '/../removable']) {
          try {
            return fs.readFileSync(path.join('/sys/class/block', rel), 'utf8').trim() === '1';
          } catch (_) {}
        }
      } catch (_) {}
      return false;
    }
    return false;
  } catch (_) { return false; }
});
ipcMain.handle('report-write-named', async (_, destPath, name, content) => {
  // SECURITY: `name` must be a plain file name inside destPath. A crafted name
  // like "../../../../etc/cron.d/x" used to let the renderer write anywhere the
  // user could — silent persistence. Reject any name with a path separator or
  // "..", and confirm the resolved path really sits inside destPath.
  try {
    const base = String(name || '');
    if (!base || base === '.' || base === '..' || /[\/\\]/.test(base)) return false;
    // Windows leftovers: ':' would write an NTFS alternate data stream (invisible
    // content); the reserved device names silently go nowhere. Other chars are
    // illegal in filenames anyway.
    if (/[:<>"|?*\x00-\x1f]/.test(base)) return false;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) return false;
    const target = path.resolve(destPath, base);
    if (!pathContains(destPath, target)) return false;
    writeFileAtomic(target, content);
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('run-hook', async (_, argv) => {
  // SECURITY: the post-ingest hook now runs WITHOUT a shell. The renderer sends
  // an argument array [program, ...args]; each argument is passed verbatim to
  // the OS, never concatenated into a command line. A hostile card name — or a
  // path with spaces — can therefore no longer inject anything or split into
  // extra arguments. (The former exec(command) ran the whole string through a
  // shell, which was a command-injection surface.)
  try {
    if (!Array.isArray(argv) || !argv.length || typeof argv[0] !== 'string' || !argv[0].trim()) {
      return { ok: false, error: 'empty or malformed hook command' };
    }
    const program = argv[0];
    const args = argv.slice(1).map(a => String(a == null ? '' : a));
    // spawn (not execFile): no output pipes, so no maxBuffer cap that would kill
    // a long, chatty rsync, and NO timeout — a legitimate multi-hundred-GB hook
    // must be free to run for as long as it needs. It is fire-and-forget and
    // unref'd, so a stuck hook never blocks the app. stdio:'ignore' avoids the
    // EPIPE-on-quit failure that piped output would cause.
    // Note: on Windows this cannot launch a .bat/.cmd directly (no shell) — wrap
    // such hooks in an .exe or call the interpreter explicitly.
    const { spawn } = require('child_process');
    const child = spawn(program, args, { windowsHide: true, stdio: 'ignore' });
    return await new Promise(resolve => {
      let settled = false;
      child.on('error', e => { if (!settled) { settled = true; resolve({ ok: false, error: e.message }); } });
      child.on('spawn', () => { if (!settled) { settled = true; resolve({ ok: true }); } });
      setTimeout(() => { if (!settled) { settled = true; resolve({ ok: true }); } }, 800);
      if (child.unref) child.unref();
    });
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('report-read', async (_, destPath) => {
  // Prefer the HTML's embedded data; fall back to the JSON sidecar when HTML isn't written.
  let htmlExists = false, blockFound = false;
  try {
    const fp = path.join(destPath, 'INGESTO_report.html');
    const html = fs.readFileSync(fp, 'utf8');
    htmlExists = true;
    // Reports written from 2.4.7 carry a gzip+base64 data block; older ones
    // carry plain JSON. Both must be readable, or updating an existing report
    // would silently start it over from scratch and lose its history.
    const mz = html.match(/<script id="ingesto-report-data" type="application\/gzip\+base64">([\s\S]*?)<\/script>/);
    if (mz) { blockFound = true; return JSON.parse(zlib.gunzipSync(Buffer.from(mz[1].trim(), 'base64')).toString('utf8')); }
    const m = html.match(/<script id="ingesto-report-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) { blockFound = true; return JSON.parse(m[1]); }
  } catch (_) {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(destPath, 'INGESTO_report.json'), 'utf8'));
    if (j && Array.isArray(j.records)) return { created: j.created, records: j.records };
  } catch (_) {}
  // A report file that EXISTS but cannot be read is not the same as no report.
  // Returning null there made the next ingest rewrite the destination's report
  // with only today's cards — the client-facing history gone, silently. Say so
  // instead, so the caller can preserve the old file and warn.
  if (htmlExists) return { unreadable: true, blockFound, records: [] };
  return null;
});
ipcMain.handle('report-write', async (_, destPath, html, preserveExisting) => {
  try {
    const target = path.join(destPath, 'INGESTO_report.html');
    // The existing report could not be read, so its history cannot be carried
    // into the new one. Keep the old file rather than destroying a record we
    // simply failed to parse — it is still openable in a browser.
    if (preserveExisting && fs.existsSync(target)) {
      let bak = path.join(destPath, 'INGESTO_report.unreadable.html');
      for (let i = 2; fs.existsSync(bak) && i < 100; i++)
        bak = path.join(destPath, `INGESTO_report.unreadable-${i}.html`);
      try { fs.renameSync(target, bak); } catch (_) {}
    }
    writeFileAtomic(target, html);
    return true;
  }
  catch (_) { return false; }
});
ipcMain.handle('report-open', async (_, destPath) => {
  try { await shell.openPath(path.join(destPath, 'INGESTO_report.html')); return true; }
  catch (_) { return false; }
});
ipcMain.handle('disk-free', async (_, p) => {
  try { const s = fs.statfsSync(p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; }
  catch (_) { return null; }
});
// ─── Are these volumes still there? ────────────────────────────────────────
// A card or a destination drive can be unplugged, ejected or dropped off the
// network between the moment it is loaded and the moment Start is pressed.
// Nothing noticed: the ingest began and failed file by file.
//
// Existence alone is not enough. On Linux an unmounted volume often leaves its
// empty mount point behind, and on any system a second card can be mounted at
// the path the first one had. So the device id recorded when the volume was
// loaded is compared with the one it has now: a different device is a different
// volume, whatever the path says.
// Is this volume still there, and still the SAME volume? Split out of the IPC
// handler so the rules can be exercised against a real filesystem in the tests.
function checkOnePath(e) {
    const p = e && e.path;
    const out = { path: p, ok: false, reason: 'missing', dev: null, isMount: null, total: null };
    if (!p) return out;
    let st;
    try { st = fs.statSync(p); }
    catch (err) {
      out.reason = (err && err.code === 'ENOENT') ? 'missing' : 'unreachable';
      return out;
    }
    if (!st.isDirectory()) { out.reason = 'notdir'; return out; }
    out.dev = st.dev;

    // Is this path a mount point AT THIS INSTANT? Compared with its own parent,
    // never with a value remembered from earlier — which is the whole point:
    // a volume that is unplugged and plugged back in gets a NEW device number
    // on macOS, so comparing device numbers across time rejected the very
    // recovery the error message asks the operator to perform.
    try {
      const up = path.dirname(p);
      out.isMount = (up === p) ? true : (fs.statSync(up).dev !== st.dev);
    } catch (_) { out.isMount = null; }

    // Capacity of the filesystem behind this path. Stable for a given volume
    // across mounts, and different for a different card — which makes it a
    // usable identity check where the device number is not.
    try { const sf = fs.statfsSync(p); out.total = sf.blocks * sf.bsize; }
    catch (_) { out.total = null; }

    try { fs.accessSync(p, fs.constants.R_OK); }
    catch (_) { out.reason = 'unreachable'; return out; }
    // A network share can vanish while its mount point survives: the stat
    // succeeds but reading the directory does not.
    try { fs.readdirSync(p); }
    catch (_) { out.reason = 'unreachable'; return out; }

    // It was a mount point when it was loaded and it is not one any more: the
    // volume is gone and only its empty mount folder is left. Linux leaves one
    // behind routinely, and there the path alone proves nothing.
    if (e.isMount === true && out.isMount === false) { out.reason = 'unmounted'; return out; }

    // A different volume at the same path. One percent of tolerance because an
    // APFS volume shares its container and its reported size can drift a little
    // between mounts — a real swap changes the capacity by far more than that.
    if (e.total > 0 && out.total > 0) {
      const diff = Math.abs(out.total - e.total) / e.total;
      if (diff > 0.01) { out.reason = 'replaced'; return out; }
    }

    out.ok = true; out.reason = null;
    return out;
}
ipcMain.handle('check-paths', async (_, entries) => {
  const list = Array.isArray(entries) ? entries : [];
  // A throw here rejects the promise, the renderer swallows it, and the volume
  // check is skipped WITHOUT SAYING SO — a safety guard that fails open. Coerce
  // the incoming values and never let one bad entry take the others down.
  return list.map(e => {
    try {
      return checkOnePath({
        path:    (e && typeof e.path === 'string') ? e.path : null,
        isMount: (e && typeof e.isMount === 'boolean') ? e.isMount : null,
        total:   (e && Number.isFinite(Number(e.total))) ? Number(e.total) : null,
      });
    } catch (err) {
      return { path: e && e.path, ok: false, reason: 'unreachable', dev: null, isMount: null, total: null };
    }
  });
});
ipcMain.handle('folder-size', async (_, p) => {
  try { return listAllFiles(p).reduce((a, f) => a + (f.s || 0), 0); }
  catch (_) { return null; }
});
// ─── PRO: force a genuinely physical source re-read ─────────────────────────
// Last resort when the cache purge could not evict the card (some exFAT card
// readers). Unmounting a volume invalidates its cache unconditionally, so
// unmount → remount → re-hash is guaranteed to read the medium again.
// macOS only: Windows/Linux have no equivalent we can drive safely.
//
// The card stays physically inserted throughout. This runs AFTER the copy and
// the destination verification, so nothing is at risk if it fails — worst case
// the extra check simply doesn't happen and we say so.
ipcMain.handle('redo-double-read', async (event, { sourcePath, algo, files }) => {
  if (process.platform !== 'darwin') return { ok:false, error:'unmount/remount is only supported on macOS' };
  if (!Array.isArray(files) || !files.length) return { ok:false, error:'nothing to re-check' };

  // Resolve the device behind the mount point BEFORE unmounting it.
  let device = '';
  try {
    const info = await tryExecFile('diskutil', ['info', sourcePath], 5000);
    device = (info.match(/Device Identifier:\s+(\S+)/i) || [])[1] || '';
  } catch (_) {}
  if (!device) return { ok:false, error:'could not identify the card device' };

  try { execFileSync('diskutil', ['unmount', sourcePath], { timeout: 20000, stdio:['ignore','pipe','ignore'] }); }
  catch (e) { return { ok:false, error:'the card could not be unmounted — another application is using it' }; }

  // Remount and find where it landed (usually the same path, but macOS can
  // append a suffix if a stale mount point lingers).
  let mounted = '';
  try {
    execFileSync('diskutil', ['mount', device], { timeout: 20000, stdio:['ignore','pipe','ignore'] });
    const info2 = await tryExecFile('diskutil', ['info', device], 5000);
    mounted = (info2.match(/Mount Point:\s+(.+)/i) || [])[1]?.trim() || '';
  } catch (_) {}
  if (!mounted || !fs.existsSync(mounted)) {
    return { ok:false, remountFailed:true,
      error:'the card was unmounted but did not come back — re-insert it before continuing' };
  }

  // Re-hash every file from the (now cold) card and compare with the hashes
  // recorded during the copy.
  const hasher = await newProHasher(algo);
  const unstable = [], errors = [];
  const t0 = Date.now();
  let bytes = 0, checked = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const abs = path.join(mounted, f.rel);
    // Same rule as Verify Folder: a file list is data, not trust. Never hash a
    // path that escapes the card that was just remounted.
    if (!pathContains(mounted, abs)) { errors.push({ rel: f.rel, error: 'outside the card' }); continue; }
    try {
      const st = fs.statSync(abs);
      const digest = await hashPro(abs, hasher);
      bytes += st.size; checked++;
      if (String(digest) !== String(f.hash)) unstable.push(f.rel);
    } catch (e) { errors.push({ file: f.rel, error: e.message }); }
    try { event.sender.send('verify-progress', { index:i+1, total:files.length, currentFile:f.rel }); } catch (_) {}
  }
  const secs = Math.max(0.001, (Date.now() - t0) / 1000);
  return { ok:true, mountPoint:mounted, checked, unstable, errors,
           speed: bytes / secs, durationMs: Date.now() - t0 };
});

ipcMain.handle('eject-volume', async (_, volPath) => {
  try {
    if (process.platform === 'darwin') {
      execFileSync('diskutil', ['eject', volPath], { timeout: 15000, stdio:['ignore','pipe','ignore'] });
      return { ok: true };
    }
    if (process.platform === 'win32') {
      const m = String(volPath).match(/^([A-Za-z]):/);
      if (!m) return { ok: false, error: 'no drive letter' };
      // Best-effort on Windows — may fail silently depending on config
      execSync(`powershell -NoProfile -Command "(New-Object -comObject Shell.Application).Namespace(17).ParseName('${m[1]}:').InvokeVerb('Eject')"`, { timeout: 15000 });
      return { ok: true };
    }
    if (process.platform === 'linux') {
      // Resolve the block device behind the mountpoint, then let udisks2
      // unmount it — polkit grants this to the desktop session without sudo,
      // exactly like the file manager's own eject button.
      const dev = execFileSync('findmnt', ['-n', '-o', 'SOURCE', volPath],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!dev) return { ok: false, error: 'device not found' };
      execFileSync('udisksctl', ['unmount', '--block-device', dev],
        { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      return { ok: true };
    }
    return { ok: false, error: 'unsupported platform' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('reveal-path', async (_,p) => { try { await shell.openPath(p); return true; } catch(_) { return false; } });
ipcMain.handle('get-version',   async ()    => app.getVersion());

// ─── Camera auto-detection ───────────────────────────────────────────────
ipcMain.handle('detect-camera', async (_, rootPath) => {
  try { return detectCamera(rootPath) || null; }
  catch (_) { return null; }
});

// ─── Sentinel inspection (unformatted-card detection) ────────────────────
ipcMain.handle('inspect-card', async (_, rootPath, probeWrite = false) => {
  try {
    const info = inspectCard(rootPath, probeWrite);
    // Don't ship the full file list back to the renderer if huge;
    // just keep counts + a short preview (first 50 of each list).
    return {
      writable:        info.writable,
      hasSentinel:     !!info.sentinel,
      sentinelDamaged: !!info.sentinelDamaged,
      lastIngest:      info.lastIngest ? {
        date:         info.lastIngest.date,
        destination:  info.lastIngest.destination,
        files_count:  info.lastIngest.files_count,
      } : null,
      counts: {
        total:           info.allCurrent.length,
        alreadyIngested: info.alreadyIngested.length,
        newFiles:        info.newFiles.length,
      },
      // First 50 already-ingested file names (relative paths, just basename for UI)
      alreadyIngestedPreview: info.alreadyIngested.slice(0, 50).map(f => ({
        p: f.p, s: f.s,
      })),
      // Full lists used by the copy engine when user chooses "skip already"
      _alreadyIngestedKeys: info.alreadyIngested.map(f => `${f.p}|${f.s}|${f.m}`),
    };
  } catch (e) {
    return { writable: false, hasSentinel: false, sentinelDamaged: false, lastIngest: null,
             counts: { total: 0, alreadyIngested: 0, newFiles: 0 },
             alreadyIngestedPreview: [], _alreadyIngestedKeys: [],
             error: e.message };
  }
});
