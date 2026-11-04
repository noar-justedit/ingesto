// What ingesto writes beside the footage and reads back from it: checksum
// lists, MHL and ASC MHL manifests, and the rules that tell ingesto's own
// files (manifests, temporary files, the shooting note) from footage.
'use strict';

const { app } = require('electron');
const { FAILED_SUFFIX, PART_SUFFIX } = require('./copy-io');
const { isoSec, nfc, xmlEsc } = require('./util');
const { PRO_EXT, getHashWasm } = require('./hashing');
const { safeRename, safeUnlink, safeWriteTarget } = require('./source-lock');
const fs = require('fs');
const nocache = require('./nocache');
const os = require('os');
const path = require('path');

// Write a file the way the copy engine writes media: to a temp name in the same
// folder, then rename over the target. `writeFileSync` truncates the target
// FIRST, so a drive unplugged (or an app killed) mid-write would leave a
// zero-length manifest, report or sentinel, destroying the very record it was
// updating.
// Rename within a folder is atomic on every filesystem we target.
const ATOMIC_TMP_SUFFIX = '.ingesto-tmp';
function writeFileAtomic(target, content) {
  // NOT PART_SUFFIX: that one means "an interrupted media copy", and a stranded
  // manifest temp would then be reported to the user as a lost clip.
  const tmp = target + ATOMIC_TMP_SUFFIX;
  try {
    safeWriteTarget(target); safeWriteTarget(tmp);
    // Atomic is not enough: the rename cannot be undone, but the CONTENT can
    // still be in the drive's cache when the power goes. The footage is flushed
    // file by file (F_FULLFSYNC); the checksum list, the MHL, the ASC MHL, the
    // report and the shooting note go through here, and left unflushed, a
    // power cut could leave a green run's drive with its rushes and no list.
    // Flush the file, then the directory entry that names it.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      try { if (!nocache.fullFsync(fd)) fs.fsyncSync(fd); } catch (_) {}
    } finally { try { fs.closeSync(fd); } catch (_) {} }
    safeRename(tmp, target);
    try { const dfd = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) {}
    return true;
  } catch (e) {
    try { safeUnlink(tmp); } catch (_) {}
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
// A manifest is a text file listing files. 256 MB is already absurd for one
// (a million files at 250 bytes a line). Past that it is either corrupt or not
// a manifest, and reading it whole into memory is how the app dies on a folder
// somebody else's tool wrote.
const MANIFEST_MAX_BYTES = 256 * 1024 * 1024;
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
      // Measured before it is read: the chain lives on the destination, where
      // other tools and other people write too. If it is not a size a chain
      // can be, it is treated as damaged and rebuilt from the manifests below.
      const cst = fs.statSync(chainPath);
      if (!cst.isFile() || cst.size > MANIFEST_MAX_BYTES) throw new Error('chain too large');
      const prev = fs.readFileSync(chainPath, 'utf8');
      rows = prev.match(/<hashlist[\s\S]*?<\/hashlist>/g) || [];
    } catch (_) {}

    // Replacing a chain that is missing, empty or damaged by a single row
    // carrying the NEW sequence number would leave every earlier manifest
    // unreferenced: a history with holes, written without a word. If what we
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
    let cst = null; try { cst = fs.statSync(fp); } catch (_) { continue; }
    if (!cst.isFile() || cst.size > MANIFEST_MAX_BYTES) continue;
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
// Every path an ASC MHL history vouches for, across all its generations.
// Only the paths: this is used to answer "is this file covered by a manifest",
// never to verify a hash.
function readAscMhlRels(destPath) {
  const out = new Set();
  const dir = path.join(destPath, 'ascmhl');
  let names; try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    if (!/\.mhl$/i.test(n)) continue;
    const fp = path.join(dir, n);
    try {
      // A manifest is data, and data has no business being 300 MB. Checked
      // before reading, not after: readFileSync on a huge file is the crash.
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) continue;
      const xml = fs.readFileSync(fp, 'utf8');
      const re = /<path\b[^>]*>([\s\S]*?)<\/path>/g;
      let m;
      while ((m = re.exec(xml))) {
        const rel = m[1].trim()
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        if (rel) out.add(nfc(rel.replace(/\\/g, '/')));
      }
    } catch (_) {}
  }
  return out;
}
// "Is this file covered by a manifest in this folder?"
//
// Handed to inspectCard, which decides which files may be SKIPPED on the next
// ingest of the same card. A sentinel record plus a file of the right size is
// not proof that a good copy is there: a truncated file repadded to its old
// size, a file replaced by another of the same length, a folder restored from
// an incomplete backup all pass that test. The proof a Verify run would use
// tomorrow is the manifest, so it is the proof used here.
//
// One read per folder per inspection, no hashing: the decision has to be
// instant on a card the operator has just plugged in.
function hasManifestFile(folder) {
  const base = path.basename(folder);
  for (const ext of ['.xxh', '.xxh3', '.md5', '.mhl'])
    if (fs.existsSync(path.join(folder, base + ext))) return true;
  try { return fs.readdirSync(path.join(folder, 'ascmhl')).some(n => /\.mhl$/i.test(n)); }
  catch (_) { return false; }
}
function makeManifestHas() {
  const cache = new Map();
  const setFor = (folder) => {
    let set = cache.get(folder);
    if (!set) {
      set = new Set();
      try { const ck = readChecksumListFile(folder); if (ck) for (const e of ck.entries) set.add(nfc(e.rel)); } catch (_) {}
      try { const mh = readMHLFile(folder);          if (mh) for (const e of mh.entries) set.add(nfc(e.rel)); } catch (_) {}
      try { for (const r of readAscMhlRels(folder)) set.add(r); } catch (_) {}
      cache.set(folder, set);
    }
    return set;
  };
  return {
    // Does this folder carry a manifest at all? Not every verified ingest
    // leaves one: the checksum list is a switch the operator can turn off, and
    // a manifest write can fail. Demanding an entry from a folder that has no
    // manifest would make "copy new files only" re-copy a 512 GB card in full
    // for those users, which is not a safety gain, only a cost.
    // The FILE, not the entries. A manifest that exists but reads as empty (a
    // truncated write, a tool that rewrote it, a hand-edited list) is not the
    // same as a folder that never had one: it claims to vouch for the folder,
    // so it is what decides, and a file it does not list is copied again.
    any:  (folder)      => setFor(folder).size > 0 || hasManifestFile(folder),
    has:  (folder, rel) => setFor(folder).has(nfc(String(rel).replace(/\\/g, '/'))),
  };
}
// Look for a classic MHL (<basename>.mhl) at the root of destPath. Only MD5 and
// xxHash64 exist in classic MHL, matching what ingesto itself ever writes.
function readMHLFile(destPath) {
  const base = path.basename(destPath);
  const file = base + '.mhl';
  const fp = path.join(destPath, file);
  let mst = null; try { mst = fs.statSync(fp); } catch (_) { return null; }
  if (!mst.isFile() || mst.size > MANIFEST_MAX_BYTES) return null;
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
// Sidecar files ingesto itself writes — excluded from the "extra files" list,
// since they're not footage the user needs to be alerted about.
// Residue this app leaves behind on purpose: a quarantined bad copy, or a temp
// file from a run that was killed. Neither is an "extra file the user added".
function isIngestoResidue(name) {
  return name.endsWith(FAILED_SUFFIX) || name.endsWith(PART_SUFFIX);
}
// A half-written sidecar/report temp: our own bookkeeping, not the user's media.
function isIngestoTemp(name) { return name.endsWith(ATOMIC_TMP_SUFFIX); }
// The shooting note written after the copy. It is deliberately NOT in the
// manifest: a text file people open and correct would then be read back as
// "corrupted". Recognised by its name AND by its first line, so a rush that
// happens to be called "001_note.txt" is never waved through on the name alone.
// The note is markdown, "001_note.md", and its first line is the same header
// as a level-1 title. Folders written by earlier versions hold the .txt form:
// both stay ours.
const NOTE_HEADER = 'ingesto - Shooting Note';
function isShootingNote(rel, abs) {
  if (!/^[^/]*_note\.(txt|md)$/.test(rel)) return false;   // root of the folder only
  if (!abs) return false;
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(64);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, 64, 0); } finally { fs.closeSync(fd); }
    const head = buf.subarray(0, n).toString('utf8');
    return /\.md$/.test(rel) ? head.startsWith('# ' + NOTE_HEADER) : head.startsWith(NOTE_HEADER);
  } catch (_) { return false; }
}
// A value from the interface written into the markdown header of the note:
// "A_001" or "*B*" must read as typed, not as italics.
function mdEscapeText(v) { return String(v == null ? '' : v).replace(/[\\`*_{}\[\]<>#|~]/g, '\\$&'); }
function isIngestoSidecar(rel, destBase, abs) {
  // `rel` is the path RELATIVE TO THE DESTINATION FOLDER, forward slashes, and
  // it keeps its folders: the ASC MHL test below needs them. Passing a
  // basename here would make that test unmatchable and push the whole ascmhl
  // directory into "extra files" on every Verify.
  // The ASC MHL history and the recovery copies of an unreadable report are
  // files ingesto writes itself; listing them back as "extra files (not in
  // manifest)" would make the operator doubt a folder the application had just
  // produced.
  if (/^ascmhl\//.test(rel)) return true;
  if (/^INGESTO_report(\.unreadable)?(-\d+)?\.(html|csv|json)$/.test(rel)) return true;
  if (rel === destBase + '.xxh' || rel === destBase + '.xxh3' || rel === destBase + '.md5' ||
      rel === destBase + '.mhl') return true;
  return isShootingNote(rel, abs);
}

module.exports = { ATOMIC_TMP_SUFFIX, writeFileAtomic, writeChecksumList, MANIFEST_MAX_BYTES, ASCMHL_ALGOS, C4_ALPHABET, c4Id, ascIso, ascNextSeq, writeAscMhl, writeMHL, VERIFY_SKIP, isAppleDouble, scanDirFiles, readChecksumListFile, readAscMhlRels, hasManifestFile, makeManifestHas, readMHLFile, isIngestoResidue, isIngestoTemp, NOTE_HEADER, isShootingNote, mdEscapeText, isIngestoSidecar };
