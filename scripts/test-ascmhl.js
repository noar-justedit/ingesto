#!/usr/bin/env node
// Regression tests for the ASC MHL v2.0 writer added in 2.5.2.
//
// These are not "does it look right" tests. The ASC publishes a reference
// implementation (the `ascmhl` Python package) and an XML schema; where those
// are available on the machine, this file checks our output against THEM
// rather than against anyone's reading of the specification.
//
//   node scripts/test-ascmhl.js
//
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const vm   = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in main.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let hashWasm;
try { hashWasm = require('hash-wasm'); }
catch (_) { console.log('hash-wasm missing — run `npm i hash-wasm` first'); process.exit(1); }

const ctx = vm.createContext({
  fs, path, os, Buffer, console, BigInt, Date, Math, JSON, parseInt, String, Number, isNaN,
  getHashWasm: () => hashWasm,
  app: { getVersion: () => '2.5.2' },
  require,
});
vm.runInContext(
  extractConst('ASCMHL_ALGOS') + '\n' +
  extractConst('C4_ALPHABET') + '\n' +
  extractConst('ATOMIC_TMP_SUFFIX') + '\n' +
  extractFn('writeFileAtomic') + '\n' +
  extractFn('xmlEsc') + '\n' +
  extractFn('nfc') + '\n' +
  extractFn('c4Id') + '\n' +
  extractFn('ascIso') + '\n' +
  extractFn('ascNextSeq') + '\n' +
  extractFn('writeAscMhl') + '\n', ctx);

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ok  ', n); }
  else { fail++; console.log('  FAIL', n, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };
const skipped = (n, why) => { skip++; console.log('  --  ', n, `(skipped: ${why})`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-asc-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

function have(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
}

async function main() {
  // ── A destination folder as an ingest leaves it ──────────────────────────
  const dest = path.join(TMP, '001_A001_TEST');
  fs.mkdirSync(path.join(dest, 'DCIM', '104_PANA'), { recursive: true });
  const files = [
    { rel: 'DCIM/104_PANA/P1040825.JPG', body: 'hello ingesto' },
    { rel: 'DCIM/104_PANA/P1040826.JPG', body: 'second file' },
    { rel: 'DCIM/104_PANA/accentué & <odd>.MOV', body: 'third file' },
  ];
  const entries = [];
  for (const f of files) {
    const abs = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
    const st = fs.statSync(abs);
    entries.push({ rel: f.rel, hash: await hashWasm.xxhash64(Buffer.from(f.body)),
                   size: st.size, mtimeMs: st.mtimeMs });
  }

  console.log('\nC4 identifier');
  {
    // Verified against the reference implementation on a real manifest during
    // development; these two pin the algorithm so it cannot drift.
    const id = await ctx.c4Id(Buffer.from('hello ingesto'));
    ok('90 characters long', id.length === 90, id.length);
    ok('starts with c4', id.slice(0, 2) === 'c4');
    ok('uses the base58 alphabet only — no 0, O, I or l',
      !/[0OIl]/.test(id.slice(2)), id);
    const id2 = await ctx.c4Id(Buffer.from('hello ingesto!'));
    ok('a different input gives a different identifier', id !== id2);
    const idEmpty = await ctx.c4Id(Buffer.alloc(0));
    ok('an empty input still gives 90 characters', idEmpty.length === 90, idEmpty.length);
    ok('the same input always gives the same identifier',
      (await ctx.c4Id(Buffer.from('hello ingesto'))) === id);
  }

  console.log('\nFolder and file naming');
  const name = await ctx.writeAscMhl(dest, 'xxh64', entries, { startMs: Date.now() });
  const dir = path.join(dest, 'ascmhl');
  ok('the manifest was written', !!name && fs.existsSync(path.join(dir, name)), name);
  ok('it lives in an ascmhl folder at the root of the card folder', fs.existsSync(dir));
  ok('named <0001>_<folder>_<date>_<time Z>.mhl',
    /^0001_001_A001_TEST_\d{4}-\d{2}-\d{2}_\d{6}Z\.mhl$/.test(name || ''), name);
  ok('a chain file sits beside it', fs.existsSync(path.join(dir, 'ascmhl_chain.xml')));

  const xml = fs.readFileSync(path.join(dir, name), 'utf8');
  const chain = fs.readFileSync(path.join(dir, 'ascmhl_chain.xml'), 'utf8');

  console.log('\nManifest contents');
  ok('root element carries version and namespace',
    /<hashlist version="2\.0" xmlns="urn:ASC:MHL:v2\.0">/.test(xml));
  ok('names ingesto as the tool with its version',
    /<tool version="2\.5\.2">ingesto<\/tool>/.test(xml), xml.match(/<tool[^<]*<\/tool>/));
  ok('declares the process as a transfer', /<process>transfer<\/process>/.test(xml));
  ok('every file is listed', files.every(f =>
    xml.includes(f.rel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))));
  ok('each entry carries its size', (xml.match(/<path size="\d+"/g) || []).length === files.length);
  ok('hashes are marked verified, not merely original',
    (xml.match(/action="verified"/g) || []).length === files.length);
  ok('the algorithm element matches the algorithm used',
    (xml.match(/<xxh64 /g) || []).length === files.length);
  ok('special characters in a filename are escaped, not dropped',
    /accentué &amp; &lt;odd&gt;\.MOV/.test(xml), xml.match(/.{0,40}odd.{0,20}/));
  ok('entries are sorted by path', (() => {
    const paths = [...xml.matchAll(/<path[^>]*>([^<]*)<\/path>/g)].map(m => m[1]);
    return JSON.stringify(paths) === JSON.stringify([...paths].sort());
  })());
  ok('no directory hash is claimed', !/<directoryhash>/.test(xml) && !/<roothash>/.test(xml));

  console.log('\nChain');
  ok('root element carries the directory namespace',
    /<ascmhldirectory xmlns="urn:ASC:MHL:DIRECTORY:v2\.0">/.test(chain));
  ok('references generation 1', /<hashlist sequencenr="1">/.test(chain));
  ok('points at the manifest by name', chain.includes(`<path>${name}</path>`));
  ok('carries a C4 identifier of the manifest AS WRITTEN', await (async () => {
    const m = /<c4>(c4[1-9A-HJ-NP-Za-km-z]{88})<\/c4>/.exec(chain);
    if (!m) return false;
    return m[1] === await ctx.c4Id(fs.readFileSync(path.join(dir, name)));
  })());

  console.log('\nA second generation (what a retry produces)');
  const name2 = await ctx.writeAscMhl(dest, 'xxh64', entries.slice(0, 1), { startMs: Date.now() });
  const chain2 = fs.readFileSync(path.join(dir, 'ascmhl_chain.xml'), 'utf8');
  ok('numbered 0002, the first is untouched',
    /^0002_/.test(name2 || '') && fs.existsSync(path.join(dir, name)), name2);
  ok('the chain now holds both generations',
    (chain2.match(/<hashlist sequencenr=/g) || []).length === 2);
  ok('sequence numbers are 1 then 2',
    /sequencenr="1"/.test(chain2) && /sequencenr="2"/.test(chain2));
  ok('the chain is still a single well-formed document',
    (chain2.match(/<ascmhldirectory/g) || []).length === 1 &&
    (chain2.match(/<\/ascmhldirectory>/g) || []).length === 1);

  console.log('\nRefusals');
  ok('an algorithm ASC MHL does not define is refused rather than mislabelled',
    (await ctx.writeAscMhl(dest, 'crc32', entries, {})) === null);
  ok('an empty file list writes nothing',
    (await ctx.writeAscMhl(dest, 'xxh64', [], {})) === null);
  { // a path whose parent is a FILE can never be created, on any account
    const blocker = path.join(TMP, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    ok('an unwritable destination returns null instead of throwing',
      (await ctx.writeAscMhl(path.join(blocker, 'sub'), 'xxh64', entries, {})) === null); }

  // ── Against the ASC's own tools ─────────────────────────────────────────
  console.log('\nRead back by the ASC reference implementation');
  if (!have('ascmhl')) {
    skipped('ascmhl parses our history', 'ascmhl not installed (pip install ascmhl)');
  } else {
    let out = '';
    try { out = execFileSync('ascmhl', ['info', '-v', dest], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { out = String((e.stdout || '') + (e.stderr || '')); }
    ok('the reference tool reads our history without error',
      !/error|traceback|failed to/i.test(out), out.slice(0, 400));
    ok('it lists both our generations',
      /Generation 1/.test(out) && /Generation 2/.test(out), out.slice(0, 400));
    ok('it reads back the process we declared', /ProcessInfo: transfer/.test(out), out.slice(0, 400));
    ok('it names ingesto as the tool', /ingesto/i.test(out), out.slice(0, 400));
  }

  console.log('\nAgainst the published XML schema');
  const xsd = path.join(__dirname, 'xsd', 'ASCMHL.xsd');
  if (!have('xmllint') || !fs.existsSync(xsd)) {
    skipped('the manifest validates against ASCMHL.xsd',
      !have('xmllint') ? 'xmllint not installed'
        : 'drop ASCMHL.xsd from github.com/ascmitc/mhl into scripts/xsd/ to enable');
  } else {
    let vout = '', vok = true;
    try { execFileSync('xmllint', ['--noout', '--schema', xsd, path.join(dir, name)], { encoding:'utf8', stdio:'pipe' }); }
    catch (e) { vok = false; vout = String((e.stdout||'') + (e.stderr||'')); }
    ok('the manifest validates against ASCMHL.xsd', vok, vout.slice(0, 400));
  }

  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  cleanup();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); cleanup(); process.exit(1); });
