// The source text of the application, for the tests that read or extract
// code: the engine (src/main and the src/shared files it requires) and the
// window (src/renderer: index.html and its scripts).
//
// A function moved from one file to another is still found: the tests ask
// for a function by name, not for a file.
//
//   const SRC = require('./lib/source');
//   SRC.ENGINE         every engine file, shared files first, as one text
//   SRC.RENDERER       index.html with its stylesheet and scripts in place, as one text
//   SRC.files(dir)     [{ rel, text }] for every .js under src/<dir>
//   SRC.extractFn(text, name)      a top-level `function name(...) {...}`
//   SRC.extractConst(text, name)   a top-level one-line `const name = ...;`
const fs   = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

function files(dir, ext) {
  const out = [];
  const want = ext || /\.js$/;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (want.test(e.name)) out.push({ rel: path.relative(SRC_DIR, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  })(path.join(SRC_DIR, dir));
  return out;
}

const SHARED   = files('shared').map(f => f.text).join('\n');
const MAIN_DIR = files('main');
const ENGINE   = SHARED + '\n' + MAIN_DIR.map(f => f.text).join('\n');
// The window as the browser runs it: index.html with its stylesheet and its
// own scripts (those under src/renderer, not lang/ nor ../shared) put back in
// place of the tags that load them, in that order.
const REND_DIR = path.join(SRC_DIR, 'renderer');
const RENDERER = fs.readFileSync(path.join(REND_DIR, 'index.html'), 'utf8')
  .replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) =>
    '<style>\n' + fs.readFileSync(path.join(REND_DIR, href), 'utf8') + '</style>')
  .replace(/<script src="([^"]+)"><\/script>/g, (m, src) =>
    (src.startsWith('../') || src.startsWith('lang/')) ? m
      : '<script>\n' + fs.readFileSync(path.join(REND_DIR, src), 'utf8') + '</script>');

function extractFn(src, name) {
  let start = src.search(new RegExp(`(^|[^A-Za-z0-9_$.])function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  start = src.indexOf(`function ${name}(`, start);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

module.exports = { SRC_DIR, files, SHARED, ENGINE, RENDERER, extractFn, extractConst };
