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


// ────────────────────────────────────────────────────────────────────────────
// ingesto — camera-detect.js
// Detects camera brand & model from the structure/contents of a memory card.
// Returns { brand, model } or null if nothing matched.
//
// Strategy:
//   1. Structural signature (folder layout) → identifies the brand/family
//   2. Metadata sniff (XML, MIF, SQLite, MP4 header) → extracts exact model
//   3. Fallback to generic brand name if no exact model could be read
// ────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// Utility: safe existsSync
function has(root, sub) {
  try { return fs.existsSync(path.join(root, sub)); } catch (_) { return false; }
}
// Utility: list files (non-recursive), filter by predicate
function listFiles(dir, pred) {
  try {
    return fs.readdirSync(dir).filter(n => pred ? pred(n) : true);
  } catch (_) { return []; }
}
// Utility: read first N bytes of a file as buffer
function readHead(filePath, nBytes) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(nBytes);
    const read = fs.readSync(fd, buf, 0, nBytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, read);
  } catch (_) { return null; }
}
// Utility: read entire file as text (safe)
function readText(filePath, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return readHead(filePath, maxBytes)?.toString('utf8') || '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) { return ''; }
}

// Utility: scan a text/binary string for any of the given model patterns.
// Patterns are tried in longest-first order so that more specific variants
// (e.g. "Pocket Cinema Camera 6K Pro") match before generic ones ("6K").
// Returns the short name (map value) or null.
function findModelInText(txt, modelMap) {
  if (!txt) return null;
  const entries = Object.entries(modelMap).sort((a, b) => b[0].length - a[0].length);
  for (const [raw, short] of entries) {
    if (txt.includes(raw)) return short;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Model mappings — convert manufacturer's internal model name to short name
// ──────────────────────────────────────────────────────────────────────────

// Sony XAVC/XDCAM raw model strings → ingesto short names
const SONY_MODEL_MAP = {
  'ILME-FX2':  'FX2',
  'ILME-FX6V': 'FX6', 'ILME-FX6':  'FX6',
  'ILME-FX3':  'FX3',
  'ILME-FX30': 'FX30',
  'ILME-FX9':  'FX9',  'ILME-FX9V': 'FX9',
  'PXW-FS7':   'FS7',  'PXW-FS7M2': 'FS7',
  'PXW-FS5':   'FS5',  'PXW-FS5M2': 'FS5',
  'PXW-FX9':   'FX9',
  'PXW-FR7':   'FR7',
  'MPC-3610':  'Venice',
  'MPC-3628':  'Venice2',
  'ILX-LR1':   'Burano',
  'ILCE-7S':   'A7S',
  'ILCE-7SM2': 'A7S2',
  'ILCE-7SM3': 'A7S3',
  'ILCE-7M4':  'A7M4',
  'ILCE-7RM5': 'A7R5',
  'ILCE-1':    'A1',
  'ILCE-1M2':  'A1II',
  'ILCE-9M3':  'A9III',
  'ILCE-9M2':  'A9II',
  'ILCE-9':    'A9',
  'ZV-E1':     'ZVE1',
  'ZV-E10':    'ZVE10',
};

// Canon Cinema EOS model strings → ingesto short names
const CANON_MODEL_MAP = {
  'EOS C70':              'C70',
  'EOS C200':             'C200',
  'EOS C300 Mark II':     'C300mk2',
  'EOS C300 Mark III':    'C300mk3',
  'EOS C400':             'C400',
  'EOS C80':              'C80',
  'EOS C500 Mark II':     'C500mk2',
  'EOS R5 C':             'R5C',
  // Canon photo/hybrid (read from EXIF in DCIM)
  'Canon EOS R3':         'R3',
  'Canon EOS R5':         'R5',
  'Canon EOS R5 Mark II': 'R5II',
  'Canon EOS R6':         'R6',
  'Canon EOS R6 Mark II': 'R6II',
  'Canon EOS R1':         'R1',
  'Canon EOS R7':         'R7',
  'Canon EOS R8':         'R8',
};

// DJI — the MISC/*.db filename is the CAMERA code (FCxxxx / PP-xxx / OW / AC / MC / RZ),
// NOT the aircraft WM code. Mapping built from the Wikimedia Commons "DJI camera model
// names" reference + real cards (Neo, Osmo Nano, Osmo Pocket 3, Inspire 3).
const DJI_CODE_MAP = {
  // Mavic
  'FC220':'MavicPro','FC2220':'Mavic2Zoom','FC2204':'Mavic2Ent','FC2403':'Mavic2EntDual',
  'L1D-20c':'Mavic2Pro','L2D-20c':'Mavic3','FC4170':'Mavic3','FC4382':'Mavic3Pro','FC4370':'Mavic3Pro',
  'M3E':'Mavic3E','M3M':'Mavic3M','M3T':'Mavic3T',
  'L3D-100c':'Mavic4Pro','FC9284':'Mavic4Pro','FC9287':'Mavic4Pro',
  // Air
  'FC230':'MavicAir','FC2103':'MavicAir','FC3170':'MavicAir2','FC3411':'Air2S',
  'FC8282':'Air3','FC8284':'Air3','FC9113':'Air3S','FC9184':'Air3S',
  // Avata / Flip / FPV
  'FC8183':'Avata','FC8485':'Avata2','OQ001E':'Avata360','FC8582':'Flip','FC3305':'FPV',
  // Inspire (FC4280 = Inspire 3 in DCIM/H.264; ProRes handled by structure signature)
  'FC350':'Inspire1','FC550':'Inspire1','FC550RAW':'Inspire1',
  'FC6510':'Inspire2','FC6520':'Inspire2','FC6540':'Inspire2','FC4280':'Inspire3',
  // Lito
  'FC9670':'Lito1','FC9589':'LitoX1',
  // Mini
  'FC7203':'MavicMini','FC7303':'Mini2','FC7503':'Mini2SE','FC7703':'Mini4K',
  'FC3682':'Mini3','FC3582':'Mini3Pro','FC8482':'Mini4Pro','FC9313':'Mini5Pro',
  // Neo
  'FC8671':'Neo','FC9470':'Neo2',
  // Phantom
  'FC40':'Phantom','FC200':'Phantom2Vision','FC300S':'Phantom3Adv','FC300X':'Phantom3Pro',
  'FC300C':'Phantom3Std','FC300XW':'Phantom34K','FC300SE':'Phantom3SE',
  'FC330':'Phantom4','FC6310':'Phantom4Pro','FC6310S':'Phantom4ProV2','FC6310R':'Phantom4RTK','FC6360':'P4Multispectral',
  // Other
  'FC1102':'Spark','RZ001':'Tello',
  // Handheld / stabilized
  'MC211':'Action2','AC002':'OsmoAction3','AC003':'OsmoAction4','AC004':'OsmoAction5Pro',
  'PP-101':'OsmoPocket3',
};
// Prefix-matched codes where a counter varies (e.g. OW001, OW002 on Osmo Nano)
const DJI_PREFIX_MAP = { 'OW':'OsmoNano' };

// Panasonic Lumix model strings → short names
const PANA_MODEL_MAP = {
  'DC-GH4':   'GH4',  'DMC-GH4': 'GH4',
  'DC-GH5':   'GH5',  'DMC-GH5': 'GH5',
  'DC-GH5M2': 'GH5II',
  'DC-GH6':   'GH6',
  'DC-GH7':   'GH7',
  'DC-S1':    'S1',
  'DC-S1H':   'S1H',
  'DC-S1R':   'S1R',
  'DC-S5M2':  'S5II',
  'DC-S5M2X': 'S5IIX',
  'DC-BS1H':  'BS1H',
  'AU-EVA1':  'EVA1',
  'AU-V35LT1':'VariCamLT',
  'AU-V35C1': 'VariCam',
};

// Nikon
const NIKON_MODEL_MAP = {
  'NIKON Z 8':    'Z8',
  'NIKON Z 9':    'Z9',
  'NIKON Z 6_3':  'Z6III',
  'NIKON Z 6II':  'Z6II',
  'NIKON Z 7II':  'Z7II',
};

// Fujifilm
const FUJI_MODEL_MAP = {
  'X-H2S':     'XH2S',
  'X-H2':      'XH2',
  'GFX100 II': 'GFX100II',
};

// Phantom (Vision Research)
const PHANTOM_MODEL_MAP = {
  'Phantom Flex4K':  'PhantomFlex4K',
  'Phantom VEO 4K':  'PhantomVEO4K',
  'Phantom TMX':     'PhantomTMX',
  'Phantom Miro':    'PhantomMiro',
};

// Blackmagic
const BMD_MODEL_MAP = {
  'Pocket Cinema Camera 4K':           'Pocket4K',
  'Pocket Cinema Camera 6K':           'Pocket6K',
  'Pocket Cinema Camera 6K Pro':       'Pocket6KPro',
  'Pocket Cinema Camera 6K G2':        'Pocket6KG2',
  'Cinema Camera 6K':                  'Cinema6K',
  'Pyxis 6K':                          'Pyxis6K',
  'URSA Mini Pro G2':                  'URSAMiniProG2',
  'URSA Mini Pro 4.6K G2':             'URSAMiniProG2',
  'URSA Mini Pro 12K':                 'URSAMiniPro12K',
  'URSA Cine 12K LF':                  'URSACine12K',
};

// ──────────────────────────────────────────────────────────────────────────
// Detectors — each returns { brand, model } or null
// They are tried in order in detectCamera() until one returns non-null.
// ──────────────────────────────────────────────────────────────────────────

// ----- Sony — MEDIAPRO.XML (most reliable: one file, <System systemKind>) --------
// Present for XAVC-S (M4ROOT, .MP4) and XAVC/XDCAM (XDROOT, .MXF), at the card root
// or under PRIVATE/. Covers the whole Sony range (ILME cinema, ILCE Alpha, PXW…).
function detectSonyMediaPro(root) {
  const locations = [
    'M4ROOT/MEDIAPRO.XML',
    'PRIVATE/M4ROOT/MEDIAPRO.XML',
    'XDROOT/MEDIAPRO.XML',
    'PRIVATE/XDROOT/MEDIAPRO.XML',
  ];
  for (const rel of locations) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const txt = readText(p, 64 * 1024);
    const m = txt.match(/systemKind\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    // Normalise: drop any version suffix ("ILME-FX6V ver.6.000" → "ILME-FX6V")
    const raw = m[1].trim().split(/\s+/)[0];
    const mapped = SONY_MODEL_MAP[raw];
    return { brand: 'Sony', model: mapped || sonyFallbackName(raw) };
  }
  return null;
}

// Friendly-ish short name for an unmapped Sony systemKind
function sonyFallbackName(raw) {
  let s = raw;
  if (/^ILCE-/i.test(s)) s = 'A' + s.replace(/^ILCE-/i, '');            // Alpha bodies
  else s = s.replace(/^(ILME|PXW|PMW|HXR|HDR|FDR|DSC|NEX)-/i, '');       // cinema/handheld
  return s.replace(/[^A-Za-z0-9]/g, '') || 'Sony';
}

// ----- Sony XDCAM (FX6, FX9, FS7, FS5, Venice, etc.) ----------------------
function detectSonyXDCAM(root) {
  if (!has(root, 'XDROOT')) return null;
  const clipDir = path.join(root, 'XDROOT', 'Clip');
  // Look at first *M01.XML metadata file
  const xmls = listFiles(clipDir, n => /M01\.XML$/i.test(n));
  if (xmls.length) {
    const txt = readText(path.join(clipDir, xmls[0]), 64 * 1024);
    // Look for <Device manufacturer="Sony" modelName="ILME-FX6V" .../>
    const m = txt.match(/modelName=["']([^"']+)["']/i);
    if (m) {
      const raw = m[1].trim();
      const mapped = SONY_MODEL_MAP[raw];
      if (mapped) return { brand: 'Sony', model: mapped };
      // Unknown but it's Sony XDCAM → return raw cleaned
      return { brand: 'Sony', model: raw.replace(/[^A-Za-z0-9]/g, '') };
    }
  }
  return { brand: 'Sony', model: 'Sony' }; // fallback brand
}

// ----- Sony XAVC S (FX3, FX30, A7S series, A1, etc.) ---------------------
function detectSonyXAVCS(root) {
  if (!has(root, 'M4ROOT')) return null;
  // Try to find a M01.XML sidecar in M4ROOT/CLIP
  const clipDir = path.join(root, 'M4ROOT', 'CLIP');
  const xmls = listFiles(clipDir, n => /M01\.XML$/i.test(n));
  if (xmls.length) {
    const txt = readText(path.join(clipDir, xmls[0]), 64 * 1024);
    const m = txt.match(/modelName=["']([^"']+)["']/i);
    if (m) {
      const raw = m[1].trim();
      const mapped = SONY_MODEL_MAP[raw];
      if (mapped) return { brand: 'Sony', model: mapped };
      return { brand: 'Sony', model: raw.replace(/[^A-Za-z0-9]/g, '') };
    }
  }
  return { brand: 'Sony', model: 'Sony' };
}

// ----- Sony AVCHD (older A7, FS100, etc.) --------------------------------
function detectSonyAVCHD(root) {
  if (!has(root, 'PRIVATE/AVCHD')) return null;
  // AVCHD metadata is in BDMV/INDEX.BDM (binary, harder to parse)
  // For now just return brand
  return { brand: 'Sony', model: 'Sony' };
}

// ----- Canon XF / Cinema EOS (C300, C500, C70, C400, R5C) ----------------
function detectCanonXF(root) {
  // Canon Cinema EOS (C300/C400/C80/R5C…) across several recording layouts:
  //   Legacy : CONTENTS/INDEX.MIF
  //   Format1: CLIPxxx/ at root (*.MP4 + INDEX.MIF)
  //   Format2: VIDEO|XF-AVC|PROXY / CLIPxxx/ (*.MXF/*.MP4 + INDEX.MIF)
  //   Format3: DCIM/CLIPSxxx/*.MXF
  //   Flat   : *.MXF directly at root (often "..._CANON.MXF")
  const mifs = [];
  const vids = [];
  const pushMif = p => { if (fs.existsSync(p)) mifs.push(p); };
  const pushVids = (dir, re) => { for (const f of listFiles(dir, n => re.test(n))) vids.push(path.join(dir, f)); };

  pushMif(path.join(root, 'CONTENTS', 'INDEX.MIF'));
  const clipBases = [root, path.join(root, 'VIDEO'), path.join(root, 'XF-AVC'), path.join(root, 'PROXY'), path.join(root, 'DCIM')];
  for (const base of clipBases) {
    for (const sub of listFiles(base, n => /^CLIPS?\d+$/i.test(n))) {
      const dir = path.join(base, sub);
      pushMif(path.join(dir, 'INDEX.MIF'));
      pushVids(dir, /\.(mxf|mp4)$/i);
    }
  }
  pushVids(root, /\.mxf$/i); // flat variant

  if (!mifs.length && !vids.length) return null;

  // Read the model out of INDEX.MIF first, then the video headers.
  const readModel = buf => {
    if (!buf) return null;
    const m = buf.toString('binary').match(/EOS\s+(?:C\d+(?:\s+Mark\s+[IVX]+)?|R\d+(?:\s+C)?)/);
    if (!m) return null;
    const raw = m[0].trim().replace(/\s+/g, ' ');
    return CANON_MODEL_MAP[raw] || raw.replace(/EOS\s+/, '').replace(/\s+/g, '');
  };
  for (const p of mifs) { const model = readModel(readHead(p, 256 * 1024)); if (model) return { brand: 'Canon', model }; }
  for (const p of vids) { const model = readModel(readHead(p, 256 * 1024)); if (model) return { brand: 'Canon', model }; }

  // Structure recognised but model unreadable → generic Canon, but only on a
  // strong Canon signal (INDEX.MIF present, or a "_CANON.MXF" filename) so we
  // never steal a Sony/Panasonic MXF card that happens to sit at root.
  const hasCanonNamedMxf = listFiles(root, n => /_CANON\.mxf$/i.test(n)).length > 0;
  const hasClipsInDcim = has(root, 'DCIM') && listFiles(path.join(root, 'DCIM'), n => /^CLIPS?\d+$/i.test(n)).length > 0;
  if (mifs.length || hasCanonNamedMxf || hasClipsInDcim) return { brand: 'Canon', model: 'Canon' };
  return null;
}

// ----- ARRI (Alexa series) -----------------------------------------------
function detectARRI(root) {
  // ARRI structure: MXF files named like A001C001_xxxxxx_xxxx.mxf at root or in folders
  // Best signature: presence of .ari files OR MXF naming pattern A###C###
  const files = listFiles(root);
  const hasARRI = files.some(f =>
    /^[A-Z]\d{3}C\d{3}_/.test(f) && /\.(mxf|ari)$/i.test(f)
  );
  if (!hasARRI) {
    // Also check inside an Arri-specific folder if present
    const arriDirs = files.filter(f => /\.ARRI$/i.test(f));
    if (!arriDirs.length) return null;
  }
  // Could read MXF header for exact model, but skip for V1
  // Default to AlexaMini (most common) as a best-effort fallback
  return { brand: 'Arri', model: 'Arri' };
}

// ----- RED (V-Raptor, Komodo, etc.) --------------------------------------
function detectRED(root) {
  // RED structure: <Reel>.RDM/<Clip>.RDC/<files>.R3D
  const files = listFiles(root);
  const hasRDM = files.some(f => /\.RDM$/i.test(f));
  if (!hasRDM) return null;
  // Try to read first .R3D header to extract model
  // R3D header has camera info in first ~4KB; look for known keywords
  try {
    const rdmDir = files.find(f => /\.RDM$/i.test(f));
    const rdcDirs = listFiles(path.join(root, rdmDir), n => /\.RDC$/i.test(n));
    if (rdcDirs.length) {
      const r3dFiles = listFiles(path.join(root, rdmDir, rdcDirs[0]), n => /\.R3D$/i.test(n));
      if (r3dFiles.length) {
        const r3dPath = path.join(root, rdmDir, rdcDirs[0], r3dFiles[0]);
        const buf = readHead(r3dPath, 4096);
        if (buf) {
          const txt = buf.toString('binary');
          if (/V-?RAPTOR/i.test(txt))   return { brand: 'RED', model: 'VRaptor' };
          if (/KOMODO-?X/i.test(txt))   return { brand: 'RED', model: 'KomodoX' };
          if (/KOMODO/i.test(txt))      return { brand: 'RED', model: 'Komodo' };
          if (/MONSTRO/i.test(txt))     return { brand: 'RED', model: 'Monstro' };
          if (/HELIUM/i.test(txt))      return { brand: 'RED', model: 'Helium' };
          if (/GEMINI/i.test(txt))      return { brand: 'RED', model: 'Gemini' };
        }
      }
    }
  } catch (_) {}
  return { brand: 'RED', model: 'RED' };
}

// ----- Blackmagic (Pocket, URSA, Pyxis) ----------------------------------
function detectBlackmagic(root) {
  // Strong signature: BlamOS-Private-Items folder (modern BMD cameras)
  const hasBlamOS = has(root, '.BlamOS-Private-Items');
  // Older signature: .braw or specific .mov naming directly at root, no DCIM/CONTENTS/etc
  const files = listFiles(root);
  const hasBraw = files.some(f => /\.braw$/i.test(f));
  const hasBmdMov = files.some(f => /^[A-Z]\d{3}_\d{8}_C\d{3}\.mov$/i.test(f));
  if (!hasBlamOS && !hasBraw && !hasBmdMov) return null;

  // Helper: try to find the exact BMD model in a buffer of bytes
  function matchModel(buf) {
    if (!buf) return null;
    return findModelInText(buf.toString('binary'), BMD_MODEL_MAP);
  }

  // Try to extract exact model — strategy:
  //   1. Look for AppleDouble sidecars (._*.mov files written by macOS on
  //      exFAT cards). They contain the full BMD metadata JSON including
  //      "cameraType" — small, fast, and reliable on all platforms.
  //   2. Fallback: sniff the first ~2 MB of the video file itself.
  const videoFiles = files.filter(f => /\.(braw|mov)$/i.test(f) && !f.startsWith('.') && !f.startsWith('_'));

  // First pass: AppleDouble sidecars
  for (const v of videoFiles) {
    const sidecar = path.join(root, '._' + v);
    if (fs.existsSync(sidecar)) {
      // AppleDouble files are typically < 100 KB but read up to 256 KB just in case
      const head = readHead(sidecar, 256 * 1024);
      const model = matchModel(head);
      if (model) return { brand: 'BMD', model };
    }
  }

  // Second pass: sniff the actual video file header (larger window, 2 MB)
  for (const v of videoFiles) {
    const head = readHead(path.join(root, v), 2 * 1024 * 1024);
    const model = matchModel(head);
    if (model) return { brand: 'BMD', model };
  }

  return { brand: 'BMD', model: 'BMD' };
}

// ----- DJI Mic (handheld wireless mic recorders) -------------------------
// Signature: DJI_Audio_xxx/ folder at root, no DCIM/MISC/.db files.
// All current DJI Mic models (Mic 1, Mic 2, Mic Mini) share the same card
// layout with no model identifier in the WAV files — so we return a generic
// 'DJIMic' for all of them.
function detectDJIMic(root) {
  const files = listFiles(root);
  const hasMicFolder = files.some(f => /^DJI_Audio(_\d+)?$/i.test(f));
  if (!hasMicFolder) return null;
  // Sanity check: it must NOT also be a DJI camera/drone card
  // (those have DCIM/DJI_xxx + MISC/, never DJI_Audio_xxx at root)
  if (has(root, 'DCIM') && has(root, 'MISC')) return null;
  return { brand: 'DJI', model: 'DJIMic' };
}

// ----- DJI (drones, Osmo Pocket/Nano, Inspire 3, Ronin) ------------------
function detectDJI(root) {
  const files  = listFiles(root);
  const hasDCIM = has(root, 'DCIM');
  const hasMISC = has(root, 'MISC');

  // Collect .db candidates from MISC/ AND MISC/IDX/ (location varies by device)
  const dbFiles = [];
  if (hasMISC) {
    for (const sub of ['', 'IDX']) {
      const dir = sub ? path.join(root, 'MISC', sub) : path.join(root, 'MISC');
      for (const n of listFiles(dir, n => /\.db$/i.test(n))) dbFiles.push({ dir, name: n });
    }
  }

  // 1) Identify by the .db code (camera code)
  for (const { name } of dbFiles) {
    const code = name.replace(/\.db$/i, '').trim();
    if (DJI_CODE_MAP[code]) return { brand: 'DJI', model: DJI_CODE_MAP[code] };
    for (const pfx in DJI_PREFIX_MAP) {
      if (new RegExp('^' + pfx + '\\d', 'i').test(code)) return { brand: 'DJI', model: DJI_PREFIX_MAP[pfx] };
    }
  }

  // 2) Inspire 3 in ProRes: cinema "reel" folder (A###_XXXX) + MISC + generic
  //    default_sensor_name.db + no DCIM. (Best-effort: single-sample signature.)
  const hasReel      = files.some(f => /^[A-Z]\d{3}_[A-Z0-9]{4,}$/.test(f));
  const hasGenericDb = dbFiles.some(d => /^default_sensor_name\.db$/i.test(d.name));
  if (hasReel && hasMISC && (hasGenericDb || !hasDCIM)) {
    return { brand: 'DJI', model: 'Inspire3' };
  }

  // 3) Looks like a DJI card but code unknown → sniff .db content, else generic.
  //    NOTE: do NOT trigger on (DCIM && MISC) alone — plenty of non-DJI cards
  //    (Canon R5/R6…) have both folders. Require a real DJI marker: DCIM/DJI_* files
  //    or a .db in MISC/.
  const dciDJI = hasDCIM && listFiles(path.join(root, 'DCIM'), n => /^DJI_/i.test(n)).length > 0;
  if (dciDJI || dbFiles.length) {
    for (const { dir, name } of dbFiles) {
      const head = readHead(path.join(dir, name), 64 * 1024);
      if (!head) continue;
      const m = head.toString('binary').match(/DJI\s+([A-Z][A-Z0-9-]{1,9})/);
      if (m && DJI_CODE_MAP[m[1]]) return { brand: 'DJI', model: DJI_CODE_MAP[m[1]] };
    }
    return { brand: 'DJI', model: 'DJI' };
  }
  return null;
}

// ----- Tascam (DR-series audio recorders) --------------------------------
// Signature: root contains SOUND/ + UTILITY/ folders, plus a *.sys file
// whose name encodes the model (e.g. "dr-701d.sys" → DR701D).
function detectTascam(root) {
  if (!has(root, 'SOUND') || !has(root, 'UTILITY')) return null;
  const files = listFiles(root);
  // Find the .sys file at the root
  const sysFiles = files.filter(f => /\.sys$/i.test(f));
  if (sysFiles.length) {
    const sysName = sysFiles[0];
    // Extract model: "dr-701d.sys" → "DR701D"
    const m = sysName.match(/^(dr-?[a-z0-9]+)\.sys$/i);
    if (m) {
      // Normalise: uppercase, strip hyphen
      const model = m[1].toUpperCase().replace(/-/g, '');
      return { brand: 'Tascam', model };
    }
  }
  // Fallback: sniff first bytes of any file for "DR-XXXX" pattern
  for (const f of files) {
    if (!/\.(sys|wav|dat)$/i.test(f)) continue;
    const head = readHead(path.join(root, f), 1024);
    if (!head) continue;
    const txt = head.toString('binary');
    const m = txt.match(/DR-?[0-9]{2,4}[A-Z]?/);
    if (m) {
      return { brand: 'Tascam', model: m[0].toUpperCase().replace(/-/g, '') };
    }
  }
  // Has Tascam-like folder structure but no model marker
  return { brand: 'Tascam', model: 'Tascam' };
}

// ----- Panasonic Lumix (GH, S series) ------------------------------------
function detectPanasonic(root) {
  // Panasonic structural signals: CAMSET/ (present in both DCF and CINE modes),
  // PRIVATE/PANA_GRP, or AVCHD. DCIM alone is not enough to claim Panasonic.
  const hasCamset = has(root, 'CAMSET/AD_LUMIX') || has(root, 'CAMSET/PANA_GRP') || has(root, 'CAMSET');
  const hasPanaPrivate = has(root, 'PRIVATE/PANA_GRP') || has(root, 'AVCHD/BDMV') ||
                         (has(root, 'PRIVATE/AVCHD') && !has(root, 'M4ROOT'));
  if (!hasCamset && !hasPanaPrivate && !has(root, 'DCIM')) return null;

  const candidates = [];
  // 1) DCF Standard: DCIM/<numbered>/*.mp4|mov
  if (has(root, 'DCIM')) {
    const dcimDir = path.join(root, 'DCIM');
    for (const sub of listFiles(dcimDir)) {
      const vids = listFiles(path.join(dcimDir, sub), n => /\.(mp4|mov)$/i.test(n));
      if (vids.length) { candidates.push(path.join(dcimDir, sub, vids[0])); break; }
    }
  }
  // 2) CINE Style: video clips sit in a custom root folder (e.g. PXXX0001/) outside DCIM
  const SKIP = /^(DCIM|PRIVATE|CAMSET|MISC|CONTENTS|VIDEO|XF-AVC|PROXY|\.|System Volume Information)/i;
  for (const sub of listFiles(root)) {
    if (SKIP.test(sub)) continue;
    const subPath = path.join(root, sub);
    try { if (!fs.statSync(subPath).isDirectory()) continue; } catch (_) { continue; }
    const vids = listFiles(subPath, n => /\.(mov|mp4)$/i.test(n));
    if (vids.length) { candidates.push(path.join(subPath, vids[0])); break; }
  }
  // 3) AVCHD stream
  if (has(root, 'PRIVATE/AVCHD/BDMV/STREAM')) {
    const streamDir = path.join(root, 'PRIVATE', 'AVCHD', 'BDMV', 'STREAM');
    const mts = listFiles(streamDir, n => /\.(mts|m2ts)$/i.test(n));
    if (mts.length) candidates.push(path.join(streamDir, mts[0]));
  }

  // Primary path: read the model from the video metadata (works in both naming modes)
  for (const f of candidates) {
    const head = readHead(f, 256 * 1024);
    if (!head) continue;
    const txt = head.toString('binary');
    const panaHit = findModelInText(txt, PANA_MODEL_MAP);
    if (panaHit) return { brand: 'Panasonic', model: panaHit };
    if (/Panasonic|LUMIX/i.test(txt)) return { brand: 'Panasonic', model: 'Panasonic' };
  }

  // Fallback: the DCIM folder suffix (100XXXXX) maps to a known default label.
  // User-configurable, so this is a last resort only, after metadata failed.
  if (has(root, 'DCIM')) {
    const suffixMap = { '_PAN': 'GH4', 'GH5': 'GH5', 'GH6': 'GH6' };
    for (const sub of listFiles(path.join(root, 'DCIM'))) {
      const m = sub.match(/^\d{3}(.+)$/);
      if (m && suffixMap[m[1].toUpperCase()]) return { brand: 'Panasonic', model: suffixMap[m[1].toUpperCase()] };
    }
  }

  // Recognised Panasonic structure but no model → generic brand (only on a real signal).
  if (hasCamset || hasPanaPrivate) return { brand: 'Panasonic', model: 'Panasonic' };
  return null;
}

// ----- GoPro -------------------------------------------------------------
function detectGoPro(root) {
  if (!has(root, 'DCIM')) return null;
  const dcimDir = path.join(root, 'DCIM');
  const subs = listFiles(dcimDir, n => /GOPRO|GP/i.test(n));
  if (subs.length) return { brand: 'GoPro', model: 'GoPro' };
  // Also check for GX/GH prefixed files anywhere in DCIM
  const allSubs = listFiles(dcimDir);
  for (const sub of allSubs) {
    const files = listFiles(path.join(dcimDir, sub), n => /^(GX|GH|GS)\d+\./i.test(n));
    if (files.length) return { brand: 'GoPro', model: 'GoPro' };
  }
  return null;
}

// ----- Insta360 ----------------------------------------------------------
function detectInsta360(root) {
  // Insta360 typical: DCIM/Camera01/ with .insv or .insp files
  if (has(root, 'DCIM')) {
    const dcimDir = path.join(root, 'DCIM');
    const subs = listFiles(dcimDir);
    for (const sub of subs) {
      const files = listFiles(path.join(dcimDir, sub));
      const hasInsv = files.some(f => /\.(insv|insp)$/i.test(f));
      if (hasInsv) {
        // Try to read first .insv for model (Insta360 stores it in EXIF/metadata)
        const insv = files.find(f => /\.insv$/i.test(f));
        if (insv) {
          const head = readHead(path.join(dcimDir, sub, insv), 64 * 1024);
          if (head) {
            const txt = head.toString('binary');
            if (/Insta360\s*X4/i.test(txt))       return { brand: 'Insta360', model: 'Insta360X4' };
            if (/Insta360\s*X3/i.test(txt))       return { brand: 'Insta360', model: 'Insta360X3' };
            if (/Insta360\s*Ace\s*Pro\s*2/i.test(txt)) return { brand: 'Insta360', model: 'Insta360AcePro2' };
            if (/Insta360\s*Ace\s*Pro/i.test(txt)) return { brand: 'Insta360', model: 'Insta360AcePro' };
            if (/Insta360\s*GO\s*3/i.test(txt))   return { brand: 'Insta360', model: 'Insta360GO3' };
            if (/Insta360/i.test(txt))            return { brand: 'Insta360', model: 'Insta360' };
          }
        }
        return { brand: 'Insta360', model: 'Insta360' };
      }
    }
  }
  return null;
}

// ----- Apple iPhone / iPad -----------------------------------------------
function detectApple(root) {
  if (!has(root, 'DCIM')) return null;
  const dcimDir = path.join(root, 'DCIM');
  const subs = listFiles(dcimDir, n => /APPLE/i.test(n));
  if (subs.length) return { brand: 'Apple', model: 'iPhone' };
  return null;
}

// ----- Nikon / Fuji / ZCAM / Phantom -------------------------------------
// These are heavy on EXIF reading; for V1 we provide basic detection.
function detectGenericDCIM(root) {
  // Generic DCIM fallback — try EXIF Make tag in first JPEG/MOV/MP4
  if (!has(root, 'DCIM')) return null;
  const dcimDir = path.join(root, 'DCIM');
  const subs = listFiles(dcimDir);
  for (const sub of subs) {
    const files = listFiles(path.join(dcimDir, sub), n => /\.(jpe?g|mov|mp4|mts|m2ts|nef|raf|cr3|crm|dng)$/i.test(n));
    if (!files.length) continue;
    const head = readHead(path.join(dcimDir, sub, files[0]), 128 * 1024);
    if (!head) continue;
    const txt = head.toString('binary');
    // Nikon
    const nikonHit = findModelInText(txt, NIKON_MODEL_MAP);
    if (nikonHit) return { brand: 'Nikon', model: nikonHit };
    if (/NIKON/i.test(txt)) return { brand: 'Nikon', model: 'Nikon' };
    // Fuji
    const fujiHit = findModelInText(txt, FUJI_MODEL_MAP);
    if (fujiHit) return { brand: 'Fuji', model: fujiHit };
    if (/FUJIFILM/i.test(txt)) return { brand: 'Fuji', model: 'Fuji' };
    // Phantom
    const phantomHit = findModelInText(txt, PHANTOM_MODEL_MAP);
    if (phantomHit) return { brand: 'Phantom', model: phantomHit };
    // Sony (handheld stills/video not via M4ROOT)
    const sonyHit = findModelInText(txt, SONY_MODEL_MAP);
    if (sonyHit) return { brand: 'Sony', model: sonyHit };
    // Canon photo bodies
    const canonHit = findModelInText(txt, CANON_MODEL_MAP);
    if (canonHit) return { brand: 'Canon', model: canonHit };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry point — runs detectors in priority order and returns first hit.
// Returns { brand, model } or null.
// ──────────────────────────────────────────────────────────────────────────
// ----- PicoMic (wireless mic / recorder) ---------------------------------
function detectPicoMic(root) {
  const files = listFiles(root);
  const hasFolder = has(root, 'PicoRecorder');
  const hasFw = files.some(f => /^fw_rec.*\.par$/i.test(f));
  if (!hasFolder && !hasFw) return null;
  return { brand: 'PicoMic', model: 'PicoRecorder' };
}

// ----- Zoom (handheld audio recorder: H6/H5/F6/F8…) ----------------------
function detectZoom(root) {
  // Characteristic multitrack naming: ZOOM####_BU/LR/TrN.WAV
  const hasZoom = listFiles(root, n => /^ZOOM\d+_(BU|LR|Tr\d+)\.wav$/i.test(n)).length > 0;
  if (!hasZoom) return null;
  return { brand: 'Zoom', model: 'Zoom' };
}

// ----- Z CAM (E2 / F6 / F8…) ---------------------------------------------
function detectZCAM(root) {
  // Z-CAM MOV naming: Z###C####_<14-digit datetime>_####.MOV, at root or in DCIM/<sub>/
  const namePat = /^Z\d{3}C\d{4}_\d{14}_\d+\.mov$/i;
  const candidates = [];
  for (const f of listFiles(root, n => namePat.test(n))) candidates.push(path.join(root, f));
  if (has(root, 'DCIM')) {
    const dcimDir = path.join(root, 'DCIM');
    for (const sub of listFiles(dcimDir)) {
      for (const f of listFiles(path.join(dcimDir, sub), n => namePat.test(n)))
        candidates.push(path.join(dcimDir, sub, f));
    }
  }
  if (!candidates.length) return null;
  for (const f of candidates) {
    const head = readHead(f, 128 * 1024);
    if (!head) continue;
    const txt = head.toString('binary');
    if (/Z\s*CAM|Z-CAM|ZCAM/i.test(txt)) {
      if (/F6/i.test(txt)) return { brand: 'ZCAM', model: 'ZCAMF6' };
      if (/F8/i.test(txt)) return { brand: 'ZCAM', model: 'ZCAMF8' };
      if (/E2/i.test(txt)) return { brand: 'ZCAM', model: 'ZCAME2' };
      return { brand: 'ZCAM', model: 'ZCAM' };
    }
  }
  // Naming matched but header uninformative → brand only (honest).
  return { brand: 'ZCAM', model: 'ZCAM' };
}

const DETECTORS = [
  detectSonyMediaPro,   // most reliable Sony signal — check first
  detectSonyXDCAM,      // very specific, check early
  detectSonyXAVCS,
  detectCanonXF,
  detectBlackmagic,     // before generic DCIM checks
  detectDJIMic,         // very specific: DJI_Audio_xxx folder at root
  detectDJI,
  detectTascam,         // SOUND/ + UTILITY/ + dr-xxx.sys signature
  detectPicoMic,        // PicoRecorder/ folder or fw_rec*.par at root
  detectZoom,           // ZOOM####_BU/LR/TrN.WAV at root
  detectRED,
  detectARRI,
  detectPanasonic,
  detectInsta360,
  detectGoPro,
  detectApple,
  detectSonyAVCHD,
  detectZCAM,           // Z###C####_… MOV at root or DCIM (before generic)
  detectGenericDCIM,    // Nikon/Fuji/Phantom/Sony stills fallback
];

function detectCamera(rootPath) {
  if (!rootPath) return null;
  try {
    const stat = fs.statSync(rootPath);
    if (!stat.isDirectory()) return null;
  } catch (_) { return null; }
  for (const fn of DETECTORS) {
    try {
      const res = fn(rootPath);
      if (res && res.model) return res;
    } catch (e) {
      // Silent: a faulty detector shouldn't block the others
    }
  }
  return null;
}

module.exports = { detectCamera };
