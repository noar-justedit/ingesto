// Small helpers used across the engine: a child process with a deadline,
// sizes for messages, dates and text for the manifests.
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileP = promisify(execFile);
// Run a command, resolve its stdout, and NEVER reject — an unreadable volume
// must not blow up the whole scan. Async so the main thread stays responsive
// (synchronous diskutil/df calls freeze the UI for seconds per volume).
function tryExecFile(cmd, args, timeout) {
  return execFileP(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    .then(r => r.stdout || '')
    .catch(() => '');
}
// Escape text for the XML manifests (writeMHL and writeAscMhl, manifests.js).
// The classic MHL (Media Hash List) mirrors what DaVinci Resolve's Clone Tool
// produces: hashlist version 1.0, one <hash> block per file. Read by
// Silverstack, YoYotta, OffShoot. Only MD5 and xxHash64 are valid in classic MHL.
function xmlEsc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // Escaped for ATTRIBUTE position too — ASC MHL puts the tool version and the
    // author name in attributes, and one quote in a user name would produce a
    // manifest no parser would open.
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;')
    // A carriage return left as a literal is turned into a newline by every
    // conforming XML parser: the name that comes back out would not be the
    // name on disk. Encode it instead.
    .replace(/\r/g,'&#13;')
    // Strip characters that are simply illegal in XML 1.0, so one exotic byte in
    // a filename can't produce a manifest that no parser will open.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
// Seconds-resolution ISO timestamp. A corrupt/absurd mtime (exFAT after a bad
// unmount) makes `new Date(ms)` invalid and .toISOString() throw, which would
// abort the ENTIRE manifest. Fall back to "now" for that one file instead.
function isoSec(ms){
  let d = new Date(ms);
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/,'Z');
}
// Normalize a path to Unicode NFC. macOS stores filenames decomposed (NFD);
// Windows and most tools use composed (NFC). Without this, an accented clip
// verified across platforms shows up as BOTH missing and extra.
function nfc(s){ try { return String(s).normalize('NFC'); } catch(_) { return String(s); } }
// A name that does not exist yet: "X", then "X-2", "X-3"… renameSync replaces
// its target silently, and one set-aside copy must never erase another.
function freeName(p) {
  if (!fs.existsSync(p)) return p;
  for (let i = 2; i < 1000; i++) { const q = `${p}-${i}`; if (!fs.existsSync(q)) return q; }
  return `${p}-${Date.now()}`;
}
// Byte counts as a DIT reads them. Only used in messages, never in a decision.
function fmtBytes(n) {
  n = Number(n) || 0;
  // Decimal units, like the interface and the Finder.
  if (n < 1000) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { execFileP, tryExecFile, xmlEsc, isoSec, nfc, freeName, fmtBytes, sleep };
