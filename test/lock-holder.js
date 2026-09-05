/*
 * syncto — test helper: holds a directory lock in a SEPARATE process.
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later.
 *
 * The whole point of the lock is cross-process (cross-machine) exclusion, so
 * the test that matters cannot run in a single process. This child grabs the
 * lock, prints "LOCKED", heartbeats, and releases when told to exit — or is
 * killed outright to simulate a crash.
 *
 *   node test/lock-holder.js <folder> [--forever]
 */

'use strict';

const { NativeFs } = require('../src/main/fs/native');
const { acquireOne } = require('../src/main/core/lock');

(async () => {
  const folder = process.argv[2];
  const fsx = new NativeFs();
  const lock = await acquireOne(fsx, folder, {});
  process.stdout.write('LOCKED\n');

  // Release cleanly on SIGTERM; a SIGKILL leaves the lock behind on purpose.
  const bye = async () => { await lock.release(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('message', m => { if (m === 'release') bye(); });

  setInterval(() => {}, 1000);   // keep the event loop (and the heartbeat) alive
})().catch(err => { process.stderr.write('ERR ' + err.message + '\n'); process.exit(1); });
