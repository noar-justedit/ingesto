// The state every running ingest shares, and the pause.
//
// One object, `ctl`, read and written by the engine (engine.js, copy-io.js)
// and by the IPC handlers in main.js:
//   cancelCopy       the operator pressed Cancel: every loop stops at the next file
//   pauseCopy        the operator pressed Pause: the engine holds between two files
//   activeCopyCount  ingests in progress, the card re-read included (START is
//                    refused and quitting asks first while it is above 0)
//   forceQuit        the operator confirmed quitting during an ingest
//   pausedMs         time spent paused during the current ingest, measured on
//                    the wall clock, subtracted from the phase durations
//   send(ch, data)   sends a message to the window (set by main.js)
'use strict';

const ctl = {
  cancelCopy: false,
  pauseCopy: false,
  activeCopyCount: 0,
  forceQuit: false,
  pausedMs: 0,
  _pauseStart: 0,          // when the current pause took effect, 0 when not paused
  _pauseHeldSent: false,   // "paused" already announced for this pause
  send: () => {},
};

// Zeroed for each card. A pause still open is closed first, or a pause that
// started between two cards of a batch would be credited to nobody and its
// minutes would land in the next card's phase durations.
function resetPausedMs() { pauseEnd(); ctl.pausedMs = 0; ctl._pauseStart = 0; ctl._pauseHeldSent = false; }
function pauseBegin() { if (!ctl._pauseStart) ctl._pauseStart = Date.now(); }
function pauseEnd() {
  if (ctl._pauseStart) { ctl.pausedMs += Date.now() - ctl._pauseStart; ctl._pauseStart = 0; }
  ctl._pauseHeldSent = false;
}

// Holds the engine between two files while paused, and tells the window when
// the hold actually takes effect (the file in flight finishes first), so it
// can switch from "Pausing…" to "Paused". Cancel breaks the hold.
// The pause is timed from HERE, when a lane actually stops, not from the
// button: the file being finished is not paused time. Several lanes waiting
// through the same pause count it once (it is measured on the clock, not
// added up per lane).
async function pauseGate() {
  if (!ctl.pauseCopy || ctl.cancelCopy) return;
  pauseBegin();
  if (!ctl._pauseHeldSent) { ctl._pauseHeldSent = true; ctl.send('pause-held'); }
  while (ctl.pauseCopy && !ctl.cancelCopy) await new Promise(r => setTimeout(r, 200));
}

module.exports = { ctl, resetPausedMs, pauseBegin, pauseEnd, pauseGate };
