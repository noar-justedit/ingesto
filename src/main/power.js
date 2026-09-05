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

// What happens when the run is over: nothing, quit, sleep, or shut down.
//
// Three actions, not four. There is no "hibernate" here because macOS has no
// such command — `hibernatemode` describes what the Mac does *during* sleep,
// it is not something you can ask for — and on Windows `shutdown /h` only
// works when hibernation is enabled, which it is not by default on machines
// with fast startup. An entry that silently does something else, or nothing,
// on half the machines is worse than no entry. FreeFileSync draws the same
// line: Exit / Sleep / Shut down.
//
// Everything here goes through the OS's normal, unprivileged path. Nothing
// asks for an administrator password, and nothing forces applications to
// close: another app with unsaved work can still stop a shutdown, which is
// the correct outcome.

const { execFile } = require('child_process');

const ACTIONS = ['none', 'quit', 'sleep', 'shutdown'];

// Returns { cmd, args } or null. Exported on its own so the choice of command
// can be tested on every platform without putting a machine to sleep.
function commandFor(action, platform) {
  const p = platform || process.platform;
  if (action === 'sleep') {
    if (p === 'darwin') return { cmd: 'pmset', args: ['sleepnow'] };
    // SetSuspendState(Hibernate, Force, WakeupEventsDisabled). The first
    // argument asks for sleep — but Windows hibernates instead when
    // hibernation is enabled on the machine, and there is no way to force
    // plain sleep from a command line. Either way the machine goes to sleep
    // and wakes up where it was, which is what the setting promises.
    // NOTE for the caller: this call does not return until the machine WAKES
    // UP. Treating its exit as the result of the request reports a failure the
    // next morning for a machine that slept perfectly. See run().
    if (p === 'win32')  return { cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] };
    return { cmd: 'systemctl', args: ['suspend'] };
  }
  if (action === 'shutdown') {
    // Through System Events, not `shutdown -h`, which needs root. This is the
    // same request the Apple menu makes: applications are asked to quit, and
    // one with unsaved work can refuse — which is the behaviour we want.
    if (p === 'darwin') return { cmd: 'osascript', args: ['-e', 'tell application "System Events" to shut down'] };
    if (p === 'win32')  return { cmd: 'shutdown', args: ['/s', '/t', '0'] };
    return { cmd: 'systemctl', args: ['poweroff'] };
  }
  return null;
}

function label(action) {
  return { none: 'Do nothing', quit: 'Quit syncto', sleep: 'Sleep', shutdown: 'Shut down' }[action] || 'Do nothing';
}

// Runs the action. `quit` is handed back to the caller because only the
// Electron app can quit itself cleanly.
// Returns { ok, action, error }.
function run(action, { onQuit } = {}) {
  if (!ACTIONS.includes(action) || action === 'none') return Promise.resolve({ ok: true, action: 'none' });
  if (action === 'quit') {
    if (onQuit) onQuit();
    return Promise.resolve({ ok: true, action });
  }
  const c = commandFor(action);
  if (!c) return Promise.resolve({ ok: false, action, error: 'Not supported on this system.' });

  return new Promise(resolve => {
    // Sleeping is fire-and-forget. On Windows the command blocks until the
    // machine wakes up, and on macOS `pmset sleepnow` returns while the
    // display is already going dark; waiting on either and reporting the exit
    // code showed "Sleep failed" on a machine that had slept exactly as asked.
    // A command that cannot start still reports — that error arrives at once.
    if (action === 'sleep') {
      let settled = false;
      const child = execFile(c.cmd, c.args, () => {});
      child.on('error', e => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, action, error: `${label(action)} failed (${c.cmd}): ${e.message.split('\n')[0]}` });
      });
      setTimeout(() => { if (!settled) { settled = true; resolve({ ok: true, action }); } }, 2000);
      return;
    }
    execFile(c.cmd, c.args, { timeout: 15000 }, err => {
      if (!err) return resolve({ ok: true, action });
      // Say what was attempted. "Command failed" on its own tells the user
      // nothing about why the machine is still on.
      resolve({
        ok: false, action,
        error: `${label(action)} failed (${c.cmd}): ${err.message.split('\n')[0]}`,
      });
    });
  });
}

module.exports = { run, commandFor, label, ACTIONS };
