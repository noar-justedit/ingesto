// The volumes the window lists (macOS, Windows, Linux), and whether a path
// the window holds is still the volume it was.
'use strict';

const { detectCamera } = require('./camera-detect');
const { execFileSync } = require('child_process');
const { isHdeSource } = require('../shared/sources');
const { isVirtualMountType } = require('./mounts');
const { tryExecFile } = require('./util');
const { VOLUME_PROBE_MS, statWithin } = require('./io-deadline');
const fs = require('fs');
const path = require('path');

async function getMountedVolumes() {
  if (process.platform === 'win32') return getMountedVolumesWin();
  if (process.platform === 'linux') return getMountedVolumesLinux();
  if (process.platform !== 'darwin') return [];

  // Network detection. The mountpoint sits between " on " and " (" and is always
  // absolute — anchoring to " on /" stops a share NAMED "…on" (Canon, Nikon)
  // from being mis-parsed, which would send network shares through diskutil.
  const networkPaths = new Set();
  // Volumes served by a program rather than a disk (macFUSE, X2XFUSE: Codex
  // Platform's "_hde" volume among them). Their files are produced while
  // they are read, so the volume is never browsed beyond its root here.
  const virtualPaths = new Set();
  try {
    for (const line of (await tryExecFile('mount', [], 2000)).split('\n')) {
      const m = line.match(/ on (\/.*) \(([^,)]*)/);
      if (!m) continue;
      if (/smbfs|afpfs|nfs|webdav|ftpfs/.test(line)) networkPaths.add(m[1].trim());
      if (isVirtualMountType(m[2])) virtualPaths.add(m[1].trim());
    }
  } catch (_) {}

  let entries = [];
  try { entries = fs.readdirSync('/Volumes'); } catch (_) { return []; }

  let rootDev = null;
  try { rootDev = fs.statSync('/').dev; } catch (_) {}

  // Probe every volume CONCURRENTLY — the async execFile calls do not block
  // the main thread, and total wall-time is that of the slowest single volume
  // instead of the sum of all of them.
  const results = await Promise.all(entries.map(async (name) => {
    const fullPath = '/Volumes/' + name;
    // With a deadline: without one, a volume whose reader or service hangs
    // freezes the application at the next mount event. It is listed as not
    // answering, never dropped: a card that vanished from the list in the
    // middle of an ingest would read as a card pulled out.
    const vs = await statWithin(fullPath, VOLUME_PROBE_MS);
    const isVirtual = virtualPaths.has(fullPath);
    if (vs.timeout) return { name, label: name, path: fullPath, isSystem: false, isNetwork: networkPaths.has(fullPath),
      fsType: 'external', totalSize: 0, freeSize: 0, usedSize: 0, camera: null, unresponsive: true, isVirtual, hde: isHdeSource(fullPath) };
    if (vs.err || !vs.v.isDirectory()) return null;

    let isSystem = false, isNetwork = networkPaths.has(fullPath);
    let fsType = 'external';
    if (rootDev && vs.v.dev === rootDev) isSystem = true;

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
    // detectCamera reads the volume synchronously: not on a virtual one.
    if (!isSystem && !isNetwork && !isVirtual) { try { camera = detectCamera(fullPath) || null; } catch (_) {} }
    // On macOS the /Volumes entry name IS the volume label, so display name and
    // card name are the same string — but the field must exist on every
    // platform, or the renderer would fall back per-platform.
    return { name, label: name, path: fullPath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize-freeSize, camera, isVirtual, hde: isHdeSource(fullPath) };
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
            name: 'System', label: 'System', path: '/', isSystem: true, isNetwork: false, fsType: 'system',
            totalSize: total, freeSize: free, usedSize: total - free, camera: null,
          });
        } else if (/^\/(media|run\/media)\//.test(mp)) {
          seen.add(mp);
          const name = (n.label || '').trim() || path.basename(mp);
          let camera = null;
          try { camera = detectCamera(mp) || null; } catch (_) {}
          volumes.push({
            name, label: name, path: mp, isSystem: false, isNetwork: false, fsType: 'usb',
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
        volumes.push({ name: 'System', label: 'System', path: '/', isSystem: true, isNetwork: false,
          fsType: 'system', totalSize, freeSize, usedSize: totalSize - freeSize, camera: null });
        continue;
      }
      let camera = null; try { camera = detectCamera(mp) || null; } catch (_) {}
      volumes.push({ name: path.basename(mp), label: path.basename(mp), path: mp, isSystem: false, isNetwork: false,
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
        name: path.basename(mp) || src, label: path.basename(mp) || src, path: mp, isSystem: false, isNetwork: true,
        fsType: 'network', totalSize, freeSize, usedSize: totalSize - freeSize, camera: null,
      });
    }
  } catch (_) {}
  return volumes;
}
// Windows tells you about a drive through two doors, and each one is deaf on a
// different side:
//
//   Get-PSDrive  lists EVERY drive letter, mapped network drives included, and
//                gives Used/Free plus the UNC path of a network drive — but its
//                "Description" carries the volume label only for FIXED disks.
//                On a REMOVABLE volume it comes back empty. Measured on a real
//                machine: C: "W11", G: "MEDIAS_GABARA", D: (a LUMIX card) "".
//                With this call alone, every card ingested on Windows would be
//                named after its drive letter ("D:"), which the folder-name
//                cleaner then turns into "D_". The card's own name would never
//                reach the template, the ingest report, or the phone
//                notification.
//
//   Get-Volume   knows the real label of a removable volume (FileSystemLabel),
//                but does NOT list mapped network drives at all — the same
//                machine returns C, D, G and an unlettered recovery partition,
//                with no sign of the Z: share that Get-PSDrive reports.
//
// Hence both calls, merged by drive letter. Kept as a pure function so it can
// be tested against the exact JSON a real Windows machine produces.
function mergeWinDrives(psdriveJson, volumeJson) {
  const rows = (txt) => {
    if (!txt) return [];
    try { const p = JSON.parse(txt); return Array.isArray(p) ? p : [p]; }
    catch (_) { return []; }
  };
  const str = v => String(v == null ? '' : v).trim();
  // Get-Volume's DriveLetter is a char; ConvertTo-Json may render it as "D" or
  // as its code point. Accept both rather than depend on a PowerShell version.
  const letterOf = (v) => {
    if (typeof v === 'number') {
      const inRange = (v >= 65 && v <= 90) || (v >= 97 && v <= 122);   // A-Z or a-z, not "[ \\ ] ^ _ `"
      return inRange ? String.fromCharCode(v).toUpperCase() : '';
    }
    const s = str(v).toUpperCase();
    return /^[A-Z]$/.test(s) ? s : '';
  };

  const byLetter = new Map();
  for (const d of rows(psdriveJson)) {
    if (!d) continue;
    const L = letterOf(d.Name);
    if (!L) continue;
    byLetter.set(L, {
      used: Number(d.Used) || 0,
      free: Number(d.Free) || 0,
      displayRoot: str(d.DisplayRoot),
      label: str(d.Description),      // right for a fixed disk, empty for a card
    });
  }
  for (const v of rows(volumeJson)) {
    if (!v) continue;
    const L = letterOf(v.DriveLetter);
    if (!L) continue;                 // an unlettered partition (recovery, EFI)
    const e = byLetter.get(L) || { used: 0, free: 0, displayRoot: '', label: '' };
    const label = str(v.FileSystemLabel);
    if (label) e.label = label;       // authoritative — this one sees removable media
    byLetter.set(L, e);
  }
  return byLetter;
}
// Asynchronous. Run with execSync, one after the other, the two PowerShell
// calls make the whole main process wait, up to 13 s with a dead mapped drive,
// and a card plugged in DURING an ingest freezes the copy and the verification
// for that long. So they run side by side, off the main thread, and so does
// the check of each drive letter.
async function getMountedVolumesWin() {
  const volumes = [];
  // Single PowerShell call for every drive. One process per existing drive
  // letter costs up to ~4 s each: 20-30 s per scan with several drives.
  // No string interpolation in the command → no injection surface.
  // Force UTF-8 output so accented volume names ("Sauvegarde Vidéo") don't come
  // back mojibake and then flow into folder names. windowsHide stops a console
  // window from flashing. No string interpolation in either command → no
  // injection surface.
  const sysLetter = String(process.env.SystemDrive || 'C:').replace(/[:\\/]/g,'').toUpperCase() || 'C';
  // Two calls rather than one merged command: this exact pair was verified by
  // hand on a real machine, and a single call would need a nested
  // ConvertTo-Json whose depth behaviour cannot be checked from here.
  // Get-Volume is local and lists no network drive, so it cannot hang on a dead
  // share the way Get-PSDrive can — hence the shorter budget.
  // tryExecFile answers '' on any failure: a missing or refused call must not
  // lose the whole scan.
  const ask = async (cmd, ms) => String(await tryExecFile('powershell',
    ['-NoProfile', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + cmd], ms) || '').trim();
  const [psdrives, getvolume] = await Promise.all([
    ask('Get-PSDrive -PSProvider FileSystem | Select-Object -Property Name,Used,Free,Description,DisplayRoot | ConvertTo-Json -Compress', 8000),
    ask('Get-Volume | Select-Object -Property DriveLetter,FileSystemLabel | ConvertTo-Json -Compress', 5000),
  ]);
  const byLetter = mergeWinDrives(psdrives, getvolume);

  // Which letters exist, all checked at once. A dead network drive can take a
  // long time to answer a stat: it is given 3 s, then treated as absent.
  const letters = [];
  for (let code = 65; code <= 90; code++) letters.push(String.fromCharCode(code));
  const present = await Promise.all(letters.map(L => Promise.race([
    fs.promises.stat(L + ':\\').then(st => st.isDirectory(), () => false),
    new Promise(r => setTimeout(() => r(false), 3000)),
  ])));

  // Enumerate drive letters A-Z
  for (let li = 0; li < letters.length; li++) {
    if (!present[li]) continue;
    const letter = letters[li];
    const drivePath = letter + ':\\';

    // `label` is the card's own name and nothing else — it is what {cardname}
    // resolves to, what the ingest report records and what the phone shows.
    // `name` is the label for the eye, with the drive letter appended so two
    // identical cards in two readers can be told apart in the volume list. One
    // string for both would make a card really called LUMIX produce the folder
    // "LUMIX (D_)": the display decoration would go into the filename.
    let label = '';
    let name = letter + ':';
    let totalSize = 0, freeSize = 0;
    let fsType = 'usb'; // default for removable
    let isSystem = false, isNetwork = false;

    const d = byLetter.get(letter);
    if (d) {
      freeSize  = d.free;
      totalSize = d.used + freeSize;
      label = d.label;
      if (label) name = label + ' (' + letter + ':)';
      // Detect network drive via DisplayRoot (UNC path like \\server\share)
      if (d.displayRoot.startsWith('\\\\') || d.displayRoot.startsWith('\\')) {
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
    // detectCamera reads the drive synchronously: only once it has answered
    // within the deadline (a hung reader would freeze the application here).
    let unresponsive = false;
    if (!isSystem && !isNetwork) {
      const probe = await statWithin(drivePath, VOLUME_PROBE_MS);
      if (probe.timeout) unresponsive = true;
      else { try { camera = detectCamera(drivePath) || null; } catch (_) {} }
    }
    const hde = isHdeSource(label || '');
    volumes.push({
      // A card formatted in-camera often has no label at all. The fallback is
      // the bare letter, never "D:" — the colon is exactly the character the
      // folder-name cleaner turns into "_", which would produce folder names
      // like "001_D__noar".
      name, label: label || letter, path: drivePath, isSystem, isNetwork, fsType,
      totalSize, freeSize, usedSize: totalSize - freeSize, camera,
      ...(unresponsive ? { unresponsive: true } : {}), hde
    });
  }
  return volumes;
}
// What the OS knows about the volume a card is mounted on. macOS only for the
// identifier: elsewhere there is no cheap equivalent, and a script that needs
// one on Windows can read it itself.
function volumeIdentity(p) {
  const out = { uuid: null, removable: null, mounted: false };
  if (!p) return out;
  try { out.mounted = fs.statSync(p).isDirectory(); } catch (_) { return out; }
  if (process.platform !== 'darwin') return out;
  try {
    const txt = execFileSync('diskutil', ['info', p],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = txt.match(/Volume UUID:\s*([0-9A-Fa-f-]+)/);
    if (m) out.uuid = m[1];
    const r = txt.match(/Removable Media:\s*(\w+)/);
    if (r) out.removable = /removable|yes/i.test(r[1]);
  } catch (_) {}
  return out;
}
// ─── Are these volumes still there? ────────────────────────────────────────
// A card or a destination drive can be unplugged, ejected or dropped off the
// network between the moment it is loaded and the moment Start is pressed.
// Without this check, the ingest would begin and fail file by file.
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
    // on macOS, so comparing device numbers across time would reject the very
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

module.exports = { getMountedVolumes, getMountedVolumesLinux, mergeWinDrives, getMountedVolumesWin, volumeIdentity, checkOnePath };
