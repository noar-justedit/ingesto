#!/usr/bin/env node
// scripts/push_github.command, run the way Noar runs it (2.9.2 fix).
//
// The script was only ever tried from the project folder. Double-clicked, the
// .command starts in scripts/, and from there git read "CLAUDE.md" as
// scripts/CLAUDE.md: the private tracking files went to GitHub, and
// version.json was sent before the Release existed (2.9.2, 27.10.2026).
//
// This test builds a small project and a local stand-in for GitHub (a bare
// repository), then runs the real push_github.command from ANOTHER folder,
// with the answers typed in, and looks at what the stand-in received.
// Nothing is sent anywhere: INGESTO_PUSH_REMOTE points at the stand-in, and
// INGESTO_PUSH_RELEASE answers the "is the Release out?" question.
//
//   node scripts/test-push-github.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

if (spawnSync('git', ['--version']).status !== 0) {
  console.log('\ngit is not installed: test skipped.\n\n0 passed, 0 failed');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-push-'));
const ENV  = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', HOME: TMP,
});
const git = (args, cwd) => spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// A project at `version`, with the private files and the real scripts.
function project(dir, version) {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'ingesto', version,
    repository: { type: 'git', url: 'https://github.com/noar-justedit/ingesto.git' } }, null, 2));
  write(path.join(dir, 'version.json'), JSON.stringify({ version, url: 'https://github.com/noar-justedit/ingesto/releases/latest' }, null, 2));
  write(path.join(dir, 'src', 'main.js'), `// ${version}\n`);
  write(path.join(dir, 'README.md'), `# ingesto ${version}\n`);
  write(path.join(dir, 'CLAUDE.md'), 'private\n');
  write(path.join(dir, 'AGENTS.md'), 'private\n');
  write(path.join(dir, 'ETAT_PROJET.md'), `private ${version}\n`);
  write(path.join(dir, 'docs', 'notes', '07-historique.md'), `private ${version}\n`);
  for (const f of ['push_github.sh', 'push_github.command']) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
    fs.chmodSync(path.join(dir, 'scripts', f), 0o755);
  }
}

// "GitHub" as 2.9.1 left it: the private files ARE there (sent by hand).
function github(name) {
  const seed = path.join(TMP, name + '-seed'), bare = path.join(TMP, name + '.git');
  project(seed, '2.9.1');
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'Release 2.9.1'], seed);
  git(['clone', '-q', '--bare', seed, bare], TMP);
  return bare;
}
const tree = (bare) => git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).stdout.split('\n').filter(Boolean);
const show = (bare, f) => git(['--git-dir', bare, 'show', 'main:' + f]).stdout;

// Run the .command as Finder does: from somewhere else, answers typed in.
function run(work, bare, release, answer) {
  return spawnSync('bash', [path.join(work, 'scripts', 'push_github.command')], {
    cwd: TMP, env: Object.assign({}, ENV, { INGESTO_PUSH_REMOTE: bare, INGESTO_PUSH_RELEASE: release }),
    input: answer + '\n\n', encoding: 'utf8', timeout: 60000,
  });
}
const PRIVATE = ['CLAUDE.md', 'AGENTS.md', 'ETAT_PROJET.md', 'docs/notes/07-historique.md'];

console.log('\nthe Release is not out yet');
{
  const bare = github('a'), work = path.join(TMP, 'a-work');
  project(work, '2.9.2');
  const r = run(work, bare, 'empty', 'y');
  const t = tree(bare);
  ok(/Envoye/.test(r.stdout), 'the code is sent');
  ok(show(bare, 'src/main.js').includes('2.9.2'), 'GitHub has the new code');
  ok(PRIVATE.every(f => !t.includes(f)), 'the private files are taken OFF GitHub, double-clicked from Finder' +
     (PRIVATE.some(f => t.includes(f)) ? ' (still there: ' + PRIVATE.filter(f => t.includes(f)).join(', ') + ')' : ''));
  ok(fs.existsSync(path.join(work, 'CLAUDE.md')) && fs.existsSync(path.join(work, 'docs/notes/07-historique.md')),
     'and stay in the folder (the ZIP keeps them)');
  ok(show(bare, 'version.json').includes('"2.9.1"'), 'version.json is held back: installed apps are not told about an empty Release');

  console.log('\nthe Release is out: run it again');
  const r2 = run(work, bare, 'yes', 'y');
  ok(/Envoye/.test(r2.stdout) && show(bare, 'version.json').includes('"2.9.2"'), 'version.json goes out');
  const t2 = tree(bare);
  ok(PRIVATE.every(f => !t2.includes(f)), 'and the private files do not come back');
}

console.log('\nthe same version twice');
{
  const bare = github('b'), work = path.join(TMP, 'b-work');
  project(work, '2.9.1');
  const before = git(['--git-dir', bare, 'rev-parse', 'main']).stdout;
  const r = run(work, bare, 'yes', 'y');
  ok(/n'est pas superieure/.test(r.stdout) && git(['--git-dir', bare, 'rev-parse', 'main']).stdout === before,
     'refused, nothing sent');
}

console.log('\nanswering no');
{
  const bare = github('c'), work = path.join(TMP, 'c-work');
  project(work, '2.9.2');
  const before = git(['--git-dir', bare, 'rev-parse', 'main']).stdout;
  const r = run(work, bare, 'yes', 'n');
  ok(/Annule/.test(r.stdout) && git(['--git-dir', bare, 'rev-parse', 'main']).stdout === before, 'nothing sent');
  ok(/D\tCLAUDE\.md/.test(r.stdout) && /D\tdocs\/notes\/07-historique\.md/.test(r.stdout),
     'the list shown before the question names the private files as removed (D)');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
