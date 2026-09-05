/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Fingerprints, via hash-wasm — a single pure-WebAssembly library, no native
// binary to compile, which is what makes cross-building for Windows from a Mac
// possible in the first place.
//
// Copy levels, same ladder as ingesto:
//
//   fast      copy only. Fastest, trusts the filesystem.
//   verified  compares the size of the target after writing. Catches a truncated
//             or interrupted copy, costs nothing.
//   secure    xxHash64 computed on the source while writing, then recomputed by
//             reading the target back. Catches silent corruption. Roughly halves
//             throughput on a fast drive because everything is read twice.
//
// The checksum list written at the secure level (optional, see the settings) is
// what lets anyone re-verify the copy months later without the source.
//
// xxHash is not cryptographic: it detects accidental corruption, not tampering.
// That is the right trade-off here — it runs several GB/s where MD5 crawls.

let _hw = null;
function hw() { if (!_hw) _hw = require('hash-wasm'); return _hw; }

async function createHasher(algo) {
  const h = hw();
  switch (algo) {
    case 'md5':    return h.createMD5();
    case 'sha256': return h.createSHA256();
    case 'xxh64':  return h.createXXHash64();
    case 'xxh128':
    default:       return h.createXXHash128();
  }
}

// syncto has ONE copy mode. Every file is copied, then read back from its
// final location and compared with the fingerprint taken while writing.
//
// It used to offer three levels. Fast and Verified ended up doing exactly the
// same thing — a size check before the rename — while only Secure read
// anything back, so two thirds of the choice was a choice between identical
// behaviours with different names. And a folder synchroniser for rushes has no
// business offering "copy and hope": the whole reason to run one is to know
// the second copy is the same as the first.
const COPY_ALGO = 'xxh64';
function algoFor() { return COPY_ALGO; }

// Streams a file through a hasher. Returns the lowercase hex digest.
function hashStream(fsx, filePath, hasher, onBytes, token) {
  return new Promise((resolve, reject) => {
    hasher.init();
    const rs = fsx.createReadStream(filePath);
    let aborted = false;
    rs.on('data', chunk => {
      if (token && token.cancelled && !aborted) { aborted = true; rs.destroy(); return; }
      try { hasher.update(chunk); } catch (e) { aborted = true; rs.destroy(); reject(e); }
      if (onBytes) onBytes(chunk.length);
    });
    rs.on('error', reject);
    rs.on('close', () => { if (aborted) reject(new Error('cancelled')); });
    rs.on('end', () => resolve(hasher.digest()));
  });
}

// Sidecar checksum list, in the classic "<hash>  <relative path>" shape that
// md5sum / xxhsum and every DIT tool can read back.
function formatChecksumList(algo, entries, meta) {
  const head = [
    `# syncto checksum list`,
    `# algorithm: ${algo}`,
    `# written: ${new Date().toISOString()}`,
  ];
  if (meta && meta.pair) head.push(`# pair: ${meta.pair}`);
  if (meta && meta.side) head.push(`# side: ${meta.side}`);
  const body = entries.map(e => `${e.hash}  ${e.rel}`);
  return head.concat(body).join('\n') + '\n';
}

function parseChecksumList(text) {
  const out = [];
  let algo = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^#\s*algorithm:\s*(\S+)/i.exec(line);
    if (m) { algo = m[1]; continue; }
    if (!line || line.startsWith('#')) continue;
    const mm = /^([0-9a-fA-F]+)\s\s?(.+)$/.exec(line);
    if (mm) out.push({ hash: mm[1].toLowerCase(), rel: mm[2] });
  }
  return { algo, entries: out };
}

module.exports = { createHasher, hashStream, algoFor, formatChecksumList, parseChecksumList };
