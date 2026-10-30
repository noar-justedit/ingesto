// Fingerprints: the hashers of SECURE (xxHash64) and PRO (xxHash64,
// xxHash128, MD5), and the read of a whole file through one of them.
'use strict';

const { stallError, stallWatch } = require('./io-deadline');
const nocache = require('./nocache');

// All fingerprints (SECURE xxHash64, PRO xxHash64/128/MD5, Verify) go through
// hash-wasm — a single library, pure WASM, no native binary. A second library
// such as xxhash-wasm writes its hex output without leading zeros, which gives
// false "hash mismatch" results in Verify (checksum lists written that way by
// earlier versions are normalised by the verify-folder handler in main.js).
let _hashwasm = null;
function getHashWasm() { if (!_hashwasm) _hashwasm = require('hash-wasm'); return _hashwasm; }
const PRO_EXT = { xxh64:'.xxh', xxh128:'.xxh3', md5:'.md5' };
async function newProHasher(algo) {
  const hw = getHashWasm();
  if (algo === 'md5')   return hw.createMD5();
  if (algo === 'xxh64') return hw.createXXHash64();
  return hw.createXXHash128();               // default: xxHash128
}
async function hashPro(fp, hasher, opts) {
  hasher.init();
  // NOTE: no readFile() shortcut for small files. It would bypass the
  // uncached path entirely, so every file under a size threshold would be
  // verified against the OS cache instead of the medium; on a mixed
  // photo/video card that is most of the files. Everything goes through the
  // (uncached on macOS) stream; the cost is negligible next to reading the media.
  return new Promise((res, rej) => {
    // Read-back for verification: uncached on macOS so it hits the medium, not
    // the RAM copy of what we just wrote.
    const s = nocache.createReadStream(fp, { highWaterMark: 4*1024*1024 });
    s.on('data', d => {
      // A hasher failure here must not be swallowed: it would produce a partial
      // digest reported as "checksum mismatch", sending the operator chasing a
      // perfectly healthy card. Surface the real error instead.
      try { hasher.update(d); }
      catch (e) { try { s.destroy(); } catch(_) {} rej(e instanceof Error ? e : new Error('hash update failed')); }
    });
    // digest() can throw (a hasher used by two readers at once, an internal
    // WASM failure). Thrown from a stream listener it would escape the promise
    // entirely and take the whole main process down, killing an ingest in
    // progress. Turn it into a rejection the verify loop can report.
    s.on('end', () => { try { res(hasher.digest()); } catch (e) { rej(e instanceof Error ? e : new Error('hash digest failed')); } });
    s.on('error', rej);
    // Reads of the CARD only (the card re-read): a destination is not watched.
    if (opts && opts.stallMs) stallWatch(s, opts.stallMs, () => { try { s.destroy(); } catch(_) {} rej(stallError('a file could not be read')); });
  });
}

module.exports = { getHashWasm, PRO_EXT, newProHasher, hashPro };
