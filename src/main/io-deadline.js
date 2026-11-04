// A source that stops answering.
//
// A card reader that hangs, or a virtual volume whose service stalls (the
// "_hde" volume of CODEX Platform encodes on the fly while it is read), does
// not fail: it never answers. Every read of a source has a deadline, and the
// engine stops asking a card that has missed one (see engine.js, sourceStalled).
'use strict';

const fs = require('fs');

// Fingerprinting a file (hashPro in hashing.js, used by SECURE, PRO and Verify)
// streams it with a bounded buffer, so RAM stays flat and the read can go
// through the uncached path; stallWatch below gives that stream its deadline.
// ─── A source that stops answering ─────────────────────────────────────────
// A card reader that hangs, or a virtual volume whose service stalls (the
// "_hde" volume of CODEX Platform (ex Device Manager) encodes on the fly while
// it is read), does not fail: it simply never answers. A synchronous call on it
// freezes the whole engine, and an asynchronous one waits for ever. So every
// read of the source has a deadline. Past it, the card is declared silent for
// the rest of the run, so a stuck volume costs one wait, not one per file.
// Shortened by the tests (INGESTO_STALL_MS), never by the application.
const SOURCE_STALL_MS = Number(process.env.INGESTO_STALL_MS) || 60000;
// The volume list is not an ingest: a volume that has not answered in a few
// seconds is shown as such, and asked again at the next refresh.
const VOLUME_PROBE_MS = 3000;
// One call in flight per path: a call that never comes back keeps a worker
// thread busy, and starting a second one on the same path would take another.
const _ioInFlight = new Map();
function settleWithin(key, start, ms) {
  if (key && _ioInFlight.has(key)) return Promise.resolve({ timeout: true });
  const pr = Promise.resolve().then(start).then(v => ({ v }), err => ({ err }));
  if (key) {
    _ioInFlight.set(key, pr);
    pr.then(() => { if (_ioInFlight.get(key) === pr) _ioInFlight.delete(key); });
  }
  let timer = null;
  const late = new Promise(res => { timer = setTimeout(() => res({ timeout: true }), ms); if (timer.unref) timer.unref(); });
  return Promise.race([pr, late]).then(x => { clearTimeout(timer); return x; });
}
function statWithin(p, ms) { return settleWithin('stat:' + p, () => fs.promises.stat(p), ms); }
function stallError(what) {
  return Object.assign(new Error(`the card stopped answering (${what}, no reply for ${Math.round(SOURCE_STALL_MS / 1000)} s)`), { stalled: true });
}
// Watches a read stream: no data for `ms` while it is flowing, and onStall()
// is called once. A stream paused on purpose (a destination still writing the
// previous chunk) is waiting for the DRIVE, not the card, and is not counted.
function stallWatch(stream, ms, onStall) {
  let last = Date.now(), stopped = false;
  const touch = () => { last = Date.now(); };
  stream.on('data', touch); stream.on('resume', touch);
  const t = setInterval(() => {
    if (stopped) return;
    if (stream.destroyed) { stop(); return; }
    if (stream.isPaused()) { touch(); return; }
    if (Date.now() - last > ms) { stop(); onStall(); }
  }, Math.max(20, Math.min(1000, Math.floor(ms / 4))));
  if (t.unref) t.unref();
  function stop() { stopped = true; clearInterval(t); }
  stream.once('end', stop); stream.once('close', stop); stream.once('error', stop);
  return stop;
}

module.exports = { SOURCE_STALL_MS, VOLUME_PROBE_MS, _ioInFlight, settleWithin, statWithin, stallError, stallWatch };
