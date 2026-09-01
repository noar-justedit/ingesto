'use strict';
//
// ingesto — Professional Camera Media Ingest
// Copyright (C) 2026 Just Edit (Arnaud Augst)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// ──────────────────────────────────────────────────────────────────────────
// electron-builder `afterSign` hook — Apple notarization.
//
// WHY A HOOK AND NOT electron-builder's OWN `notarize` OPTION:
// this runs at the one moment that matters — the .app is signed, the .dmg is
// not built yet. So the notarization TICKET IS STAPLED INTO THE .app ITSELF,
// and the disk image is then built around an already-stapled application.
// An app that carries its own ticket launches on a machine that has never
// been online. Notarizing only the disk image leaves the app, once dragged
// to /Applications, dependent on a call to Apple's servers at first launch —
// which is exactly the situation on a shoot with no network.
//
// This hook is a NO-OP when the machine cannot sign. ingesto is open source:
// anyone must be able to build it without an Apple Developer account, and a
// contributor's build must not fail because they have no certificate.
//
// Requires, once, on the signing machine:
//   xcrun notarytool store-credentials "ingesto-notarization" \
//     --apple-id "you@example.com" --team-id "XXXXXXXXXX" --password "abcd-efgh-ijkl-mnop"
//
// Environment:
//   INGESTO_NOTARY_PROFILE   keychain profile name (default: ingesto-notarization)
//   INGESTO_SKIP_NOTARIZE=1  sign, but do not notarize (fast local test build)
// ──────────────────────────────────────────────────────────────────────────

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILE = process.env.INGESTO_NOTARY_PROFILE || 'ingesto-notarization';

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
}

// The build script pipes everything through grep, and notarytool reports its
// progress by REWRITING ONE LINE ("Current status: In Progress....") with no
// newline for as long as Apple takes. Down a pipe that line never arrives, and
// a build that is working perfectly looks frozen for twenty minutes.
//
// So the notarization talks to the terminal directly instead of to the pipe.
// Falls back to normal inheritance when there is no terminal (CI).
let TTY = null;
try { TTY = fs.openSync('/dev/tty', 'w'); } catch (_) { TTY = null; }
const LIVE = TTY !== null ? ['ignore', TTY, TTY] : 'inherit';
function say(line) {
  if (TTY !== null) { try { fs.writeSync(TTY, line + '\n'); return; } catch (_) {} }
  console.log(line);
}

// Is there a Developer ID Application certificate WITH ITS PRIVATE KEY on this
// machine? `-p codesigning` is the important part: a certificate imported
// without its key is listed by other commands but cannot sign, and that is the
// single most common way a signing setup looks fine and is not.
function hasDeveloperId() {
  try {
    // Ignore certificates electron-builder itself would refuse: a Developer ID
    // listed with "(Missing required extension)" (or revoked/expired mentions)
    // is filtered out by electron-builder's identity search, so counting it
    // here would make this hook try to notarize an app that was never signed.
    return run('security', ['find-identity', '-v', '-p', 'codesigning'])
      .split('\n')
      .some(l => l.includes('Developer ID Application')
              && !/Missing required extension|CSSMERR|REVOKED|EXPIRED/i.test(l));
  } catch (_) {
    return false;
  }
}

// The one check that cannot lie: is the app on disk actually signed? Between
// this hook and the signing step sit electron-builder's own decisions —
// CSC_IDENTITY_AUTO_DISCOVERY=false, an identity its filters rejected, a CI
// pull-request build — and on macOS its "did sign" flag is unconditionally
// true, so this hook CAN be invoked over an unsigned app. Uploading that to
// Apple wastes twenty minutes and returns an error naming everything but the
// cause.
function assertActuallySigned(appPath) {
  try {
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (err) {
    throw new Error(
      `notarize: ${appPath} is NOT signed (codesign --verify failed), so it cannot be notarized.\n` +
      '  electron-builder found no usable Developer ID identity — the certificate may be\n' +
      '  listed with "(Missing required extension)", auto-discovery may be disabled\n' +
      '  (CSC_IDENTITY_AUTO_DISCOVERY=false), or this is a CI build. Check with:\n' +
      '    security find-identity -v -p codesigning');
  }
}

exports.default = async function notarizeAfterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // `npm run pack` (--dir) is the quick unpackaged build for local poking
  // around; a twenty-minute Apple round-trip there helps nobody. Only skip
  // when EVERY target is `dir` — if the detection cannot decide, notarize:
  // wrongly notarizing a test build costs minutes, wrongly skipping a release
  // build costs a rejected DMG.
  try {
    const ts = context.targets;
    if (Array.isArray(ts) && ts.length > 0 && ts.every(t => ((t && t.name) || '') === 'dir')) {
      say('  · dir-only build (npm run pack) — notarization skipped');
      return;
    }
  } catch (_) {}

  if (process.env.INGESTO_SKIP_NOTARIZE === '1') {
    say('  · notarization skipped (INGESTO_SKIP_NOTARIZE=1) — this build will NOT open on another Mac');
    return;
  }

  if (!hasDeveloperId()) {
    say('  · no Developer ID certificate on this machine — unsigned build, notarization skipped');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`notarize: ${appPath} not found — packaging did not produce an app`);
  }

  // notarytool takes an archive, not a bundle. `ditto -c -k --keepParent` is
  // the only archiver Apple documents for this: zip(1) does not preserve the
  // symlinks and extended attributes inside a .app, and a notarization built
  // on a mangled bundle fails with an error that names nothing useful.
  const zipPath = path.join(os.tmpdir(), `${appName}-${Date.now()}-notarize.zip`);

  assertActuallySigned(appPath);

  try {
    say(`  · packing ${appName}.app for notarization…`);
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);

    say(`  · uploading to Apple (profile "${PROFILE}") — Apple's own progress follows.`);
    say('    A first run may raise a keychain dialog: answer "Always Allow".');
    // --wait blocks until Apple has finished. Output goes straight to the
    // terminal so the operator sees the submission id, which is what
    // `xcrun notarytool log <id>` needs when something is rejected.
    execFileSync('xcrun',
      ['notarytool', 'submit', zipPath, '--keychain-profile', PROFILE, '--wait'],
      { stdio: LIVE });

    say('  · stapling the ticket into the app…');
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: LIVE });

    say('  ✓ app notarized and stapled');
  } catch (err) {
    // Loud, and with the one command that actually explains a rejection.
    say('');
    say('  ✗ NOTARIZATION FAILED — the build is stopped on purpose.');
    say('    A signed-but-not-notarized app is refused by macOS on every other machine,');
    say('    so shipping it would be worse than shipping nothing.');
    say('');
    say('    Apple states the exact reason here (take the submission id printed above):');
    say(`      xcrun notarytool log <submission-id> --keychain-profile "${PROFILE}"`);
    say('');
    say('    Most frequent causes:');
    say(`      · no keychain profile named "${PROFILE}" — create it with:`);
    say('          xcrun notarytool store-credentials');
    say('        (scripts/build-mac.sh checks this BEFORE building; running');
    say('         electron-builder directly skips that check);');
    say('      · an embedded binary left unsigned (typically koffi\'s .node);');
    say('      · the hardened runtime missing;');
    say('      · agreements pending at appstoreconnect.apple.com on a new account.');
    say('');
    throw err;
  } finally {
    try { fs.unlinkSync(zipPath); } catch (_) {}
  }
};
