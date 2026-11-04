// Shared test harness: the real engine, run outside Electron.
//
// Loads src/main/main.js with a stand-in for the `electron` module, keeps
// every IPC handler it registers, and gives the tests what they need to run
// a real ingest on real folders: temporary folders, deterministic card
// contents, and a way to describe what an ingest left on disk.
//
//   const H = require('./lib/harness');
//   const { call } = H.loadMain();                // once per process
//   const card = H.card(H.fresh('card'), H.CARD_CLASSIC);
//   const results = await call('start-copy', {...});
//   const snap = H.snapshotTree(dest);            // {rel: {size, hash}} for every file
//
// Nothing here knows about any particular test: it is the part every
// outside-in test used to copy.
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

// ── Temporary folders ──────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-test-'));
function fresh(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

// ── Deterministic file contents ────────────────────────────────────────────
// The same name and size always give the same bytes, on every machine, so a
// hash recorded on one machine means the same thing on another.
function bytes(name, size) {
  const out = Buffer.alloc(size);
  let seed = crypto.createHash('sha256').update(name).digest();
  for (let off = 0; off < size; off += seed.length) {
    seed.copy(out, off, 0, Math.min(seed.length, size - off));
    seed = crypto.createHash('sha256').update(seed).digest();
  }
  return out;
}
// Writes the files of a card: { 'DIR/FILE.EXT': size | 'literal text' | null (empty folder) }.
// Every file gets a fixed modification time, so a run on another day leaves
// the same card behind.
const FIXED_MTIME = new Date('2026-01-15T10:00:00Z');
function card(dir, files) {
  for (const [rel, what] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (what === null) { fs.mkdirSync(p, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof what === 'number' ? bytes(rel, what) : what);
    fs.utimesSync(p, FIXED_MTIME, FIXED_MTIME);
  }
  return dir;
}
// A card the way a camera leaves it: nested folders, big and small files, an
// empty folder, the litter macOS adds, a file with an accent in its name.
const CARD_CLASSIC = {
  'PRIVATE/M4ROOT/CLIP/C0001.MP4': 3 * 1024 * 1024 + 123,
  'PRIVATE/M4ROOT/CLIP/C0001M01.XML': 4096,
  'PRIVATE/M4ROOT/CLIP/C0002.MP4': 1024 * 1024,
  'PRIVATE/M4ROOT/CLIP/C0002M01.XML': 4100,
  'PRIVATE/M4ROOT/MEDIAPRO.XML': 900,
  'DCIM/100MSDCF/DSC00001.JPG': 50 * 1024,
  'DCIM/100MSDCF/DSC00002.JPG': 0,
  'DCIM/100MSDCF/Été_01.JPG': 1200,
  'AUDIO/take 1.wav': 70000,
  'EMPTY': null,
  '.DS_Store': 'litter',
  'DCIM/._DSC00001.JPG': 'apple double',
};

// ── The real engine ────────────────────────────────────────────────────────
let loaded = null;
function loadMain(opts = {}) {
  if (loaded) return loaded;
  const handlers = {};
  const sent = [];                           // every message sent to the window
  const userData = fresh('userData');
  const webContents = { send: (ch, payload) => sent.push({ ch, payload }), isDestroyed: () => false };
  const electron = {
    app: { whenReady: () => new Promise(() => {}), on: () => {}, requestSingleInstanceLock: () => true, quit: () => {},
           getVersion: () => opts.version || 'test', getPath: () => userData, getName: () => 'ingesto',
           isPackaged: false, setAboutPanelOptions: () => {} },
    BrowserWindow: class { static getAllWindows() { return []; } },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } },
    dialog: Object.assign({ showMessageBox: async () => ({ response: 1 }) }, opts.dialog || {}),
    screen: {},
    shell: { openPath: async () => {}, showItemInFolder: () => {}, openExternal: async () => {} },
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
  };
  const realLoad = Module._load;
  Module._load = function (req, ...rest) { if (req === 'electron') return electron; return realLoad.call(this, req, ...rest); };
  require(path.join(ROOT, 'src', 'main', 'main.js'));
  const call = (ch, ...args) => {
    if (!handlers[ch]) throw new Error('no IPC handler for ' + ch);
    return handlers[ch]({ sender: webContents }, ...args);
  };
  loaded = { call, handlers, sent, userData, electron };
  return loaded;
}

// ── What an ingest left on disk ────────────────────────────────────────────
function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
// Every file under `dir`, with its size and a hash of its bytes. Empty
// folders are listed too (as "DIR/"): the engine recreates them on purpose.
function snapshotTree(dir, normalise) {
  const out = {};
  (function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length && d !== dir) { out[path.relative(dir, d).split(path.sep).join('/') + '/'] = { dir: true }; return; }
    for (const e of entries) {
      const p = path.join(d, e.name), rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        // The engine copies the card's dates onto the copies: a file that
        // kept the card's date says "card", one written by the run says "run".
        const mtime = Math.abs(st.mtimeMs - FIXED_MTIME.getTime()) < 2000 ? 'card' : 'run';
        const text = normalise ? normalise(rel, fs.readFileSync(p, 'utf8')) : null;
        out[rel] = text != null ? { size: st.size, mtime, text } : { size: st.size, mtime, hash: sha(p) };
      }
    }
  })(dir);
  return out;
}

module.exports = { ROOT, TMP, fresh, cleanup, bytes, card, CARD_CLASSIC, FIXED_MTIME, loadMain, snapshotTree, sha };
