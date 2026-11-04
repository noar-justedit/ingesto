// The mount table: which volume a path lives on, and whether that volume is
// served by a program (FUSE) rather than read from a disk.
'use strict';

const { tryExecFile } = require('./util');
const fs = require('fs');
const path = require('path');

// A volume served by a PROGRAM rather than read from a disk. CODEX
// Platform does this for HDE: the "_hde" volume of a CFast card, but also,
// since version 8, the card's own volume on ALEXA LF / SXT / XT media, which
// keeps its usual name. Both go through FUSE (macFUSE on macOS). The mount
// table says so, whatever the name.
// Not virtual, on purpose: "fuseblk" (Linux) is FUSE over a real block device
// (ntfs-3g, exfat-fuse: ordinary NTFS or exFAT drives and cards).
// Windows: CODEX Platform does not exist there.
async function readMountTable() {
  if (process.platform === 'darwin') {
    const out = await tryExecFile('mount', [], 2000);
    return out.split('\n').map(line => {
      const m = line.match(/^(.*?) on (\/.*) \(([^,)]*)/);
      return m ? { source: m[1], point: m[2].trim(), type: m[3].trim() } : null;
    }).filter(Boolean);
  }
  if (process.platform === 'linux') {
    let txt = '';
    try { txt = await fs.promises.readFile('/proc/mounts', 'utf8'); } catch (_) { return []; }
    const unesc = (x) => x.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
    return txt.split('\n').map(line => {
      const f = line.split(' ');
      return f.length >= 3 ? { source: unesc(f[0]), point: unesc(f[1]), type: f[2] } : null;
    }).filter(Boolean);
  }
  return [];
}
function isVirtualMountType(type) {
  const t = String(type || '').toLowerCase();
  return /fuse/.test(t) && t !== 'fuseblk';
}
// The mount a path lives on: the longest mount point that contains it.
function mountOfPath(p, table) {
  const abs = String(p || '');
  let best = null;
  for (const m of table) {
    const pt = m.point === '/' ? '/' : m.point.replace(/\/+$/, '');
    const inside = pt === '/' ? abs.startsWith('/') : (abs === pt || abs.startsWith(pt + '/'));
    if (inside && (!best || pt.length > best.point.length)) best = { ...m, point: pt };
  }
  return best;
}
async function isVirtualSource(p) {
  if (process.platform === 'win32' || !p) return false;
  try { const m = mountOfPath(path.resolve(String(p)), await readMountTable()); return !!(m && isVirtualMountType(m.type)); }
  catch (_) { return false; }
}

module.exports = { readMountTable, isVirtualMountType, mountOfPath, isVirtualSource };
