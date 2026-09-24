#!/usr/bin/env node
// The build scripts have to be executable.
//
// README step 3 is "double-click build-mac.command". Finder will not run a
// file without the executable bit: it opens it in a text editor, or does
// nothing at all. For somebody who downloaded the source to build the app
// themselves, that is where the road ends, and nothing on screen says why.
//
// This is not hypothetical. Every file in the repository has been mode 100644
// since the first commit, because the files were added through the GitHub web
// uploader, which stores everything as non-executable. The .command files
// already carry `chmod +x ./*.sh` for exactly this reason, which repairs the
// .sh scripts, but a .command file cannot repair its own bit: it never runs.
//
// A `diff` patch carries no permissions either, so this cannot be left to the
// patch. It has to be right in the repository, and it has to stay right:
//
//   git update-index --chmod=+x scripts/build-mac.command
//
//   node scripts/test-executables.js
//
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

console.log('\nevery build script can actually be run');

// Windows has no executable bit, and Node reports a mode there that says
// nothing about it. Checking anyway would fail on every Windows machine for a
// reason that does not exist on Windows.
if (process.platform === 'win32') {
  skip++;
  console.log('  skip Windows has no executable bit');
} else {
  const dir = path.join(ROOT, 'scripts');
  const names = fs.readdirSync(dir).filter(n => /\.(command|sh)$/.test(n)).sort();
  ok(names.length >= 6, `the scripts folder was read (${names.length} shell scripts)`);
  // Named explicitly as well as swept: a file that disappears from the folder
  // would silently stop being checked, and these two are the ones a person
  // double-clicks.
  for (const must of ['build-mac.command', 'build-win-from-mac.command'])
    ok(names.includes(must), `${must} is there`);

  for (const n of names) {
    const mode = fs.statSync(path.join(dir, n)).mode;
    ok((mode & 0o111) !== 0,
       `${n} is executable` + ((mode & 0o111) ? '' :
         ` (mode ${(mode & 0o777).toString(8)}; fix with: git update-index --chmod=+x scripts/${n})`));
  }

  // A shebang as well. An executable bit on a file the shell does not know how
  // to start is the same dead end one step further along.
  for (const n of names) {
    const head = fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 64).split('\n')[0];
    ok(head.startsWith('#!'), `${n} starts with a shebang (${JSON.stringify(head.slice(0, 40))})`);
  }

  // The double-click launchers repair the .sh scripts on the way past, because
  // a source download can arrive without the bit whatever the repository says.
  for (const n of names.filter(x => x.endsWith('.command'))) {
    const body = fs.readFileSync(path.join(dir, n), 'utf8');
    ok(/chmod \+x/.test(body), `${n} restores the bit on the scripts it calls`);
    ok(/\bbash \.\//.test(body), `${n} runs its script through bash rather than relying on the bit`);
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
