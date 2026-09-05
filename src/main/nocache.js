// ─── Cache control for honest verification ──────────────────────────────────
//
// Why this exists: after a file is copied, SECURE/PRO reads it back and compares
// checksums. But the OS keeps freshly-written (and freshly-read) data in a RAM
// cache, so that read-back can be served from RAM instead of the disk — the copy
// is then compared against itself and a bad physical write (or a failing card)
// goes unnoticed until a later cold-cache Verify.
//
// Two complementary mechanisms, per platform:
//
//  UNCACHED I/O (macOS only) — fcntl(fd, F_NOCACHE, 1): keeps the data out of
//  the cache in the first place, per descriptor, with no alignment constraints.
//  Applied to the copy's DESTINATION WRITE stream and to verification READS in
//  SECURE/PRO. Note that some filesystem drivers (exFAT — i.e. every camera
//  card) ignore it. Since 2.4.6 it is NOT applied to the copy's source read:
//  the purge below already runs on the source immediately before the copy, and
//  holding F_NOCACHE for the whole read also disables the kernel's read-ahead,
//  which cost ~35% of copy speed on macOS (60 MB/s vs 91 in FAST on the same
//  card, where Windows/Linux — purge only, then a normal read — hit 76-79).
//
//  CACHE PURGE (macOS / Windows / Linux) — evict a file's cached pages so the
//  NEXT read must come from the medium. Used right before every verification
//  read (destination read-back and PRO source re-read) AND before reading each
//  source file during a SECURE/PRO copy.
//   • macOS   : mmap + msync(MS_INVALIDATE) — works in the VM layer, below the
//               filesystem driver, which is why it succeeds where F_NOCACHE is
//               ignored (verified in the field: exFAT card re-read dropped from
//               RAM speed to true card speed).
//   • Windows : the technique fio (the reference I/O benchmark) uses — briefly
//               open the file with FILE_FLAG_NO_BUFFERING and close it. The
//               cache manager drops the file's cached pages for coherency. No
//               aligned I/O involved. Best-effort: it only works when nothing
//               else holds the file open (e.g. an antivirus scanning it).
//   • Linux   : posix_fadvise(POSIX_FADV_DONTNEED) — drops the file's clean
//               pages. Our verify targets are fsync'd (destinations) or
//               read-only (sources), so their pages are clean by then.
//
// Everything here is best-effort and MUST NEVER throw or degrade a copy:
// koffi missing, library not found, call fails → return false, callers fall
// back to plain cached behavior. The worst case is "no better than before",
// never "worse". The speed-based detector in main.js remains the truth-teller
// when a purge silently fails.

const fs = require('fs');

// macOS <sys/fcntl.h> / <sys/mman.h>
const F_NOCACHE     = 48;
const F_FULLFSYNC   = 51;
const PROT_READ     = 0x01;
const MAP_SHARED    = 0x0001;
const MS_INVALIDATE = 0x0002;
const PURGE_CHUNK   = 256 * 1024 * 1024;   // map at most 256 MB at a time

// Windows
const FILE_SHARE_ALL         = 0x1 | 0x2 | 0x4;   // READ | WRITE | DELETE (fio uses the same)
const OPEN_EXISTING          = 3;
const FILE_FLAG_NO_BUFFERING = 0x20000000;
const INVALID_HANDLE         = -1;

// Linux <fcntl.h>
const POSIX_FADV_DONTNEED = 4;

let _fcntl = null;                                  // darwin
let _mmap = null, _msync = null, _munmap = null;    // darwin purge
let _koffi = null;
let _CreateFileW = null, _CloseHandle = null;       // win32 purge
let _fadvise = null;                                // linux purge
let _init = false;
let _io = false, _purge = false;                    // capabilities

function ready() {
  if (_init) return _io || _purge;
  _init = true;
  let koffi = null;
  try { koffi = require('koffi'); } catch (_) { return false; }
  _koffi = koffi;

  if (process.platform === 'darwin') {
    try {
      const candidates = ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib', 'libc.dylib'];
      let lib = null;
      for (const name of candidates) {
        try { lib = koffi.load(name); break; } catch (_) { /* try next */ }
      }
      if (!lib) return false;
      // fcntl is VARIADIC: `int fcntl(int fildes, int cmd, ...)`. It must be
      // declared as such. On Apple Silicon (AArch64 Apple ABI) variadic
      // arguments are passed on the STACK while fixed arguments go in
      // registers — declaring it `int fcntl(int,int,int)` puts the third
      // argument where the real fcntl never looks, so F_NOCACHE was silently
      // never applied on M-series Macs.
      _fcntl = lib.func('int fcntl(int, int, ...)');
      _io = true;
      try {
        _mmap   = lib.func('void *mmap(void *, size_t, int, int, int, int64_t)');
        _msync  = lib.func('int msync(void *, size_t, int)');
        _munmap = lib.func('int munmap(void *, size_t)');
        _purge  = true;
      } catch (_) { _mmap = _msync = _munmap = null; }
    } catch (_) { _fcntl = null; }
  } else if (process.platform === 'win32') {
    try {
      const k32 = koffi.load('kernel32.dll');
      // HANDLE is pointer-sized; declared int64 (the x64 build is the only
      // target). str16 marshals a JS string to UTF-16, which CreateFileW wants.
      _CreateFileW = k32.func('int64_t CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)');
      _CloseHandle = k32.func('int CloseHandle(int64_t)');
      _purge = true;
    } catch (_) { _CreateFileW = _CloseHandle = null; }
  } else if (process.platform === 'linux') {
    try {
      let lib = null;
      for (const name of ['libc.so.6', 'libc.so']) {
        try { lib = koffi.load(name); break; } catch (_) { /* try next */ }
      }
      if (lib) { _fadvise = lib.func('int posix_fadvise(int, int64_t, int64_t, int)'); _purge = true; }
    } catch (_) { _fadvise = null; }
  }
  return _io || _purge;
}

// True when this machine can make verification reads hit the medium — either
// through real uncached I/O (macOS) or through a pre-read cache purge
// (all three platforms). Drives the coldVerify flag in the results.
function available() { return ready(); }

// True only for real per-descriptor uncached I/O (macOS).
function uncachedIOAvailable() { ready(); return _io; }

// Flip F_NOCACHE on an open descriptor (macOS). Returns true on success.
function setUncached(fd) {
  if (!ready() || !_io) return false;
  // Variadic call: the extra argument is passed as a (type, value) pair.
  try { return _fcntl(fd, F_NOCACHE, 'int', 1) === 0; }
  catch (_) { return false; }
}

// Force a descriptor's data all the way to the physical drive (macOS,
// F_FULLFSYNC). Plain fsync(2) on macOS stops at the drive's own write cache.
function fullFsync(fd) {
  if (!ready() || !_io) return false;
  try { return _fcntl(fd, F_FULLFSYNC, 'int', 0) === 0; }
  catch (_) { return false; }
}

// Windows long-path form for the raw CreateFileW call (Node normally adds this
// itself, but we are bypassing Node here). Only applied when needed.
function winPath(p) {
  const s = String(p);
  if (s.length < 240) return s;
  if (s.startsWith('\\\\?\\')) return s;
  if (s.startsWith('\\\\')) return '\\\\?\\UNC\\' + s.slice(2);
  return '\\\\?\\' + s;
}

// Evict a file's cached pages so the NEXT read has to come from the medium.
// Returns true when the eviction call succeeded (best-effort — see header).
// Never throws.
function purgeFileCache(pathname) {
  if (!ready() || !_purge) return false;

  if (process.platform === 'win32') {
    // fio's technique: a zero-access, share-everything, non-buffered open that
    // is closed immediately. The open itself makes the cache manager drop the
    // file's cached pages for coherency. Works only if nothing else has the
    // file open — which is the normal state for our just-copied files.
    try {
      const h = _CreateFileW(winPath(pathname), 0, FILE_SHARE_ALL, null,
                             OPEN_EXISTING, FILE_FLAG_NO_BUFFERING, null);
      if (h === INVALID_HANDLE || h === 0) return false;
      _CloseHandle(h);
      return true;
    } catch (_) { return false; }
  }

  if (process.platform === 'linux') {
    // Drops CLEAN pages only; our verify targets are fsync'd or read-only by
    // the time this runs, so their pages are clean.
    let fd = null;
    try {
      fd = fs.openSync(pathname, 'r');
      return _fadvise(fd, 0, 0, POSIX_FADV_DONTNEED) === 0;   // len 0 = whole file
    } catch (_) { return false; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  }

  // macOS — mmap chunks + msync(MS_INVALIDATE)
  if (!_mmap || !_msync || !_munmap) return false;
  let fd = null, allOk = true;
  try {
    fd = fs.openSync(pathname, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return true;
    for (let off = 0; off < size; off += PURGE_CHUNK) {
      const len = Math.min(PURGE_CHUNK, size - off);
      let p = null;
      try {
        p = _mmap(null, len, PROT_READ, MAP_SHARED, fd, off);
        const addr = _koffi.address(p);
        // MAP_FAILED is (void*)-1, which koffi.address() reports as the
        // UNSIGNED BigInt 0xFFFFFFFFFFFFFFFF — never -1. A failed mapping must
        // not be msync'd.
        if (!addr || addr === 0xFFFFFFFFFFFFFFFFn || addr === -1n || addr === -1) { allOk = false; continue; }
        if (_msync(p, len, MS_INVALIDATE) !== 0) allOk = false;
      } catch (_) { allOk = false; }
      finally { if (p) { try { _munmap(p, len); } catch (_) {} } }
    }
    return allOk;
  } catch (_) { return false; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Drop-in for fs.createReadStream(pathname, opts) that reads uncached when it
// can (macOS). Falls back to a normal cached stream on any hiccup.
function createReadStream(pathname, opts = {}) {
  if (ready() && _io) {
    let fd = null;
    try {
      fd = fs.openSync(pathname, 'r');
      setUncached(fd);
      return fs.createReadStream(null, Object.assign({}, opts, { fd, autoClose: true }));
    } catch (_) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      // fall through to the plain path
    }
  }
  return fs.createReadStream(pathname, opts);
}

// Drop-in for fs.createWriteStream(pathname) that writes uncached when it can
// (macOS). Opened with 'w' (create/truncate), matching the previous behavior.
function createWriteStream(pathname, opts = {}) {
  if (ready() && _io) {
    let fd = null;
    try {
      fd = fs.openSync(pathname, 'w');
      setUncached(fd);
      return fs.createWriteStream(null, Object.assign({}, opts, { fd, autoClose: true }));
    } catch (_) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  return fs.createWriteStream(pathname, opts);
}

module.exports = { available, uncachedIOAvailable, setUncached, fullFsync, purgeFileCache, createReadStream, createWriteStream };
