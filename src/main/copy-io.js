// Writing a file to the destinations: the copy itself (read once, written to
// every destination), the flush to disk, the temporary names, and the clean-up
// of what an interrupted run left behind.
'use strict';

const { ctl } = require('./run-control');
const { safeUnlink, safeWriteTarget } = require('./source-lock');
const { sleep } = require('./util');
const { stallError, stallWatch } = require('./io-deadline');
const fs = require('fs');
const nocache = require('./nocache');
const path = require('path');

// ─── Copy engine — read the source ONCE, write to every destination ─────────
// One full copy per destination in parallel would make N simultaneous read
// passes over the same card, all competing for the (usually slow) source
// medium. The fan-out engine reads each file once and streams the chunks to
// all destinations at the same time.

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
//    read side. F_NOCACHE (macOS) and FILE_FLAG_NO_BUFFERING (Windows) need
//    fcntl/CreateFile, which Node does not expose (O_DIRECT exists in
//    fs.constants but on Linux only), so nocache.js reaches them natively,
//    best-effort. Where that fails, a later "Verify folder" run on a cold
//    cache is the only fully independent check.
//  • On macOS, fsync(2) does not flush the drive's own write cache; that needs
//    fcntl(F_FULLFSYNC), also unavailable from Node (nocache.fullFsync calls
//    it natively, see below).
//
// Opened 'r+' (not 'r'): Windows' FlushFileBuffers needs a write-capable handle.
// This is called BEFORE the source's permissions are copied onto the file:
// doing it the other way round would make every fsync fail with EACCES whenever
// the source card is mounted read-only (write-protect switch), silently
// disabling the whole guarantee. Errors are reported to the caller instead of
// being swallowed.
// Returns { ok:true } on success, { ok:false, unsupported:true, code } when the
// filesystem simply has no flush operation (some network shares, some FUSE
// mounts) — that is a weaker guarantee, not a failed copy, so it is surfaced as
// a warning. Any other error is a real problem and is thrown.
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
// The file is fully written and closed by the time we get here; these codes mean
// "something else is holding it right now", not "the copy is bad". On Windows a
// virus scanner opens every freshly written file for a moment; treating that
// as a failure would DELETE a perfectly good multi-GB copy and report a copy
// error. Retry
// briefly, then downgrade to the same warning as an unsupported filesystem.
// EACCES is deliberately NOT here: that one means the file's own permissions
// deny us, which is the write-protected-source failure this code exists to
// surface, not a transient lock.
const FSYNC_BUSY = new Set(['EBUSY', 'EPERM']);
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
// Does this folder hold anything that is not ingesto's own scratch? Used to
// decide whether a card folder that already exists may be written into: only
// when every file in it is *.ingesto-part residue of an interrupted run. An
// unreadable folder, a symbolic link, or any real file means NO.
// OS litter (.DS_Store, ._AppleDouble, Spotlight, fseventsd…) is not content:
// opening the folder in Finder to see what happened must not poison it.
// A *.ingesto-part written in the last two minutes is NOT residue either — it
// is a copy happening right now, on another machine sharing this drive; the
// single-instance lock only covers one computer.
const RESIDUE_FRESH_MS = 2 * 60 * 1000;
// Directories the OS creates on its own. A card folder holding one of these
// and nothing else is still an empty folder. The list is deliberately short:
// every OTHER directory is descended into, whatever it is called.
const OS_LITTER_DIRS = new Set(['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems',
                                '.DocumentRevisions-V100', 'System Volume Information',
                                '$RECYCLE.BIN']);
// Files the OS creates on its own. AppleDouble ("._name") belongs HERE and
// only here: it is a file convention. Treating a DIRECTORY named "._x" as
// litter would let a full card folder read as empty, so the next card would be
// written into it and replace the first card's footage. The card scanner
// copies "._x/" as ordinary content (isAppleDouble tests isFile() too), so the
// two views of the same folder would disagree.
function isOsLitterFile(name) {
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' ||
         name.startsWith('._');
}
function holdsForeignContent(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return true; }
  for (const e of entries) {
    // Directories first, and by an explicit list: never by a name pattern.
    if (e.isDirectory()) {
      if (OS_LITTER_DIRS.has(e.name)) continue;
      if (holdsForeignContent(path.join(dir, e.name))) return true;
      continue;
    }
    if (isOsLitterFile(e.name)) continue;
    if (e.isFile() && e.name.endsWith(PART_SUFFIX)) {
      let st = null; try { st = fs.statSync(path.join(dir, e.name)); } catch (_) { return true; }
      if (Date.now() - st.mtimeMs < RESIDUE_FRESH_MS) return true;   // being written NOW
      continue;
    }
    return true;   // a file, a symlink, anything else
  }
  return false;
}
// Remove every leftover *.ingesto-part under a folder (crash or power-loss
// residue from an earlier run). Returns the number of files removed.
//
// Runs BEFORE the copy phase, never after it: run afterwards, it would delete
// a file this very run had just copied from the card (a source file whose name
// happens to end in ".ingesto-part": a folder from an interrupted ingest,
// re-ingested as a card). In FAST mode nothing would notice.
// `keep` — absolute paths this run delivered under their final name; never
// touched, whatever they are called.
function sweepPartFiles(root, keep) {
  let n = 0;
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(PART_SUFFIX) && !(keep && keep.has(full))) {
        try { safeUnlink(full); n++; } catch (_) {}
      }
    }
  })(root);
  return n;
}
// Is the cache eviction actually working on THIS medium, right now?
//
// Why a probe rather than a speed heuristic: a check that declares the second
// read "served from memory" when it runs 3x faster than the copy AND above
// 300 MB/s fails both ways.
//  • It is BLIND in MD5. A RAM-served read is capped by the hashing itself at
//    ~300 MB/s in MD5 (measured: 293 MB/s, against 683 in xxHash on the same
//    drive), which is indistinguishable from a fast card. MD5 is also one of
//    the two algorithms that produce an MHL manifest, so the archival workflow
//    would be the one with the weakest guard.
//  • It FALSE-ALARMS on a common professional setup. Fast card, slow shuttle
//    drives: the copy is bounded by writing, so a perfectly physical re-read is
//    legitimately three times faster, and the operator would be told the check
//    had not really run.
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
    // read-ahead state is warm (without this the cold read carries ~1 ms of
    // setup the warm read does not, worth a 2.7x ratio out of nothing), AND —
    // the part that actually matters — this exact block is known to be in the
    // cache. The whole test rests on that: if the purge does nothing, the
    // "cold" read must be served from the cache so the two times match. Warming
    // a DIFFERENT region would leave the measured block's residency to chance:
    // on a large card the first file's opening bytes are long evicted by LRU,
    // so a purge that silently does nothing would still look like it worked.
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
function copyFanOut(src, destFiles, onBytes, hasher, stallMs) {
  return new Promise((resolve, reject) => {
    if (hasher) hasher.init();
    // In SECURE/PRO (hasher present) the destination is read back for
    // verification, so write it uncached on macOS — its pages then never sit in
    // RAM and the read-back is forced to come from the medium. In FAST there is
    // no read-back, so a plain cached write (faster) is fine.
    //
    // The SOURCE, however, is read through the normal cached path on every
    // platform. Opening it uncached on macOS too would be redundant: the caller
    // purges the source file from the cache immediately before this call in
    // exactly the same modes (isPro || isSecure), so the read already hits the
    // card. Keeping F_NOCACHE on for the whole read would also disable the
    // kernel's read-ahead, costing ~35% on macOS (measured on the same card:
    // 60 MB/s uncached vs 76-79 on Windows/Linux, which only evict and then
    // read normally, vs 91 MB/s in FAST).
    const mkWrite = hasher ? nocache.createWriteStream : fs.createWriteStream;
    const CHUNK = 8*1024*1024;
    const rs = fs.createReadStream(src, { highWaterMark: CHUNK });
    const N = destFiles.length;
    const wss = new Array(N);
    const state = new Array(N).fill('open');   // open | done | failed
    const failed = new Array(N).fill(null);
    let pendingFinish = N, readEnded = false, settled = false;

    const maybeSettle = () => {
      if (settled || !readEnded || pendingFinish > 0) return;
      settled = true;
      // Same hazard as in hashPro (hashing.js): thrown from a stream listener,
      // this escapes the promise entirely and takes the whole main process down
      // mid-copy.
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
      // immediately would let the caller unlink the .part while the handle is
      // still open: a no-op error on POSIX, but EPERM on Windows, leaving
      // orphan .ingesto-part files in a delivered folder.
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
      // Same buffer as the read, and this is the single biggest win in the
      // copy path. A write stream opened with the default 64 KB always answers
      // "full" to an 8 MB chunk, so rs.pause() would fire on EVERY chunk: the
      // card would never be read while a destination is being written, and the
      // two halves would run strictly in turn instead of overlapping.
      // Twice the chunk, deliberately: a stream whose buffer is EQUAL to the
      // chunk still answers "full" after taking it, so the reader would stop
      // either way. With room for two, the card is read while the previous
      // chunk is still being written. Bounded cost: destinations x 16 MB.
      const ws = mkWrite(safeWriteTarget(destFiles[i]), { highWaterMark: CHUNK * 2 });
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
      // Mid-file cancellation, so a 200 GB clip does not ignore "Cancel" until
      // it finishes. Abort the read now; the partial .part files are cleaned up by
      // the caller. `aborted` is flagged so the caller does not log it as an error.
      if (ctl.cancelCopy) {
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
        // A destination that never drains (wedged SMB/NAS share) would make
        // Cancel completely inert: no 'data' event ever fires again, so the
        // cancel check above is never reached. Poll while paused and tear the
        // stuck streams down on cancel — their 'close' unblocks via onGone.
        cancelPoll = setInterval(() => {
          if (!ctl.cancelCopy) return;
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
    const onReadError = err => {
      for (let i = 0; i < N; i++) {
        if (state[i] === 'open') { state[i]='failed'; failed[i]=err; pendingFinish--; try { wss[i].destroy(); } catch (_) {} }
      }
      if (settled) return;
      settled = true;
      reject(err);
    };
    rs.on('error', onReadError);
    // The card stops answering in the middle of a file: the read would wait
    // for ever. Same way out as a read error, with its own message.
    if (stallMs) stallWatch(rs, stallMs, () => { try { rs.destroy(); } catch (_) {} onReadError(stallError('a file could not be read')); });
  });
}

module.exports = { PART_SUFFIX, FAILED_SUFFIX, FSYNC_UNSUPPORTED, FSYNC_BUSY, resetFsyncBusyState, fsyncFile, RESIDUE_FRESH_MS, OS_LITTER_DIRS, isOsLitterFile, holdsForeignContent, sweepPartFiles, PROBE_BYTES, probeCacheEviction, copyFanOut };
