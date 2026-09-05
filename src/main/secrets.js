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

// Where server passwords live.
//
// Not in preferences.json. Electron's safeStorage encrypts with a key held by
// the operating system's own credential store — the macOS Keychain, DPAPI on
// Windows, the desktop keyring on Linux — so what lands on disk is ciphertext
// that only this user account on this machine can read.
//
// WHY NOT keytar, the usual answer: it is a compiled native module, and syncto
// deliberately has none. That property is the whole reason a Windows build can
// be produced from a Mac (hash-wasm is WebAssembly, ssh2 is plain JavaScript).
// Adding one native dependency would end cross-building for a password field.
//
// This module is also loaded by the test suite, which runs on plain node with
// no Electron around it — hence the guarded require and the honest "not
// available" answer rather than a crash.

let safeStorage = null;
let probed = false;

function store() {
  if (probed) return safeStorage;
  probed = true;
  try {
    const electron = require('electron');
    if (electron && electron.safeStorage) safeStorage = electron.safeStorage;
  } catch (_) { /* not running inside Electron */ }
  return safeStorage;
}

// False on a machine whose keyring cannot be reached (a fresh Linux session
// with no desktop keyring, mostly). Callers must then decline to remember the
// password rather than fall back to writing it down — see Prefs.saveServer.
function available() {
  const s = store();
  try { return !!(s && s.isEncryptionAvailable()); } catch (_) { return false; }
}

// Returns a base64 blob to store, or null when nothing can be stored safely.
function encrypt(plain) {
  if (!plain) return null;
  if (!available()) return null;
  try { return store().encryptString(String(plain)).toString('base64'); }
  catch (_) { return null; }
}

// Returns '' for anything that cannot be read back — a blob written by another
// user account, or by another machine if the preferences were copied over.
function decrypt(blob) {
  if (!blob) return '';
  if (!available()) return '';
  try { return store().decryptString(Buffer.from(String(blob), 'base64')); }
  catch (_) { return ''; }
}

module.exports = { available, encrypt, decrypt };
