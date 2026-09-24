#!/usr/bin/env node
// The picture profile: {pp}.
//
// A free-text field beside the camera model (SLog3, DLog, VLog, LogC4...) and
// a template variable that puts it in the folder name.
//
// The danger is not the field, it is the variable. Every free-text token in a
// template is also read BACK out of a folder name by makeCounterMatcher(),
// which decides the next free counter. A token the matcher does not know falls
// through to its literal branch, the pattern then matches nothing at all, the
// scan answers "next = 001" for ever, and the next card is written on top of
// the first. That is the whole reason this suite exists, and the round-trip
// section below is the part of it that matters.
//
// The rest checks the plumbing: what the operator types has to arrive at the
// engine, in the shooting note, in the report, and in the handoff document. A
// field that is typed and then dropped is worse than no field at all, because
// the operator believes the information was recorded.
//
//   node scripts/test-picture-profile.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const REND = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

function extractConst(src, name, where) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in ${where}`);
  return m[0];
}
function extractFn(src, name, where) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in ${where}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name} (${where})`);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── The engine ──────────────────────────────────────────────────────────────
const eng = vm.createContext({ console });
vm.runInContext([
  extractConst(MAIN, 'CLOCK_TOKENS',      'main.js'),
  extractFn(MAIN, 'resolveTemplateVars', 'main.js'),
  extractFn(MAIN, 'cleanSegment',        'main.js'),
  extractFn(MAIN, 'buildFolderSegments', 'main.js'),
  extractFn(MAIN, 'buildFolderName',     'main.js'),
  extractFn(MAIN, 'templateSegments',    'main.js'),
  extractFn(MAIN, 'makeCounterMatcher',  'main.js'),
  extractFn(MAIN, 'structuralLevelPatterns', 'main.js'),
].join('\n'), eng);

// ── The interface ───────────────────────────────────────────────────────────
// getElementById returns null throughout: the card's own values are the only
// input, exactly as they are once a card has been loaded and its fields filled.
const ren = vm.createContext({
  console,
  S: { counter: 7, counterWidth: 3 },
  COUNTER_WIDTHS: [2, 3, 4],
  document: { getElementById: () => null },
});
vm.runInContext(extractFn(REND, 'padCounter',     'index.html'), ren);
vm.runInContext(extractFn(REND, 'resolveTplSegs', 'index.html'), ren);

const CLOCK = new Date(2026, 0, 5, 3, 4, 5);
const CARD = (over) => Object.assign(
  { counter: '007', name: 'A001', cameraman: 'noar', camera: 'FX6', pp: 'SLog3' }, over);
const engName = (tpl, over) => eng.buildFolderName(tpl, CARD(over), CLOCK);
const renSegs = (tpl, over) => {
  const c = CARD(over);
  return ren.resolveTplSegs(tpl, { name: c.name, operator: c.cameraman, camera: c.camera, pp: c.pp },
                            0, CLOCK).join('/');
};

console.log('\nthe profile lands in the folder name');
{
  ok(engName('{counter}_{cardname}_{pp}') === '007_A001_SLOG3', 'at the end of the name, in capitals whatever was typed');
  ok(engName('{pp}_{counter}') === 'SLOG3_007', 'at the start of it');
  ok(engName('{counter}_{camera}_{pp}') === '007_FX6_SLOG3', 'next to the camera model');
  ok(eng.buildFolderSegments('{pp}/{counter}_{cardname}', CARD(), CLOCK).join('/') === 'SLOG3/007_A001',
     'and as a subfolder level of its own');
}

console.log('\none form, whatever was typed');
{
  // A profile is an acronym and everyone writes it differently. Left as typed,
  // the same shoot gets SLOG3 on one card and SLog3 on the next: two folders
  // for one thing, and a script routing on the name has to guess.
  const npp = vm.createContext({ console });
  vm.runInContext(extractFn(REND, 'normPP', 'index.html'), npp);
  const n = npp.normPP;
  ok(n('SLog3') === 'SLOG3', 'capitals');
  ok(n('s-log3') === 'SLOG3', 'a dash is dropped');
  ok(n('S Log 3') === 'SLOG3', 'so are spaces');
  ok(n('d.log2') === 'DLOG2', 'and a dot');
  ok(n('  hlg  ') === 'HLG', 'padding disappears');
  ok(n('C-Log') === 'CLOG', 'C-Log is CLOG');
  ok(n('Rec.709') === 'REC709', 'Rec.709 is REC709');
  ok(n('') === '' && n(null) === '' && n(undefined) === '', 'nothing stays nothing');
  ok(n('S/Log3') === 'SLOG3', 'a separator cannot survive it either');
  ok(n('..') === '' && n('   ') === '', 'a value made only of punctuation comes out empty');
  ok(n(n('S-Log3')) === n('S-Log3'), 'and applying it twice changes nothing');
  // The caret. sanitizePP fires on a case-only change, where nothing is
  // removed, which sanitizeMeta never could: a caret at position 0 must not be
  // thrown to the end of the value by a test that reads 0 as "no caret".
  {
    const box = vm.createContext({ console, String, Math });
    vm.runInContext(extractFn(REND, 'normPP', 'index.html'), box);
    vm.runInContext(extractFn(REND, 'sanitizePP', 'index.html'), box);
    const field = (value, caret) => { let at = -1;
      return { value, selectionStart: caret, setSelectionRange(a){ at = a; }, get caretAt(){ return at; } }; };
    const f0 = field('slog3', 0); box.sanitizePP(f0);
    ok(f0.value === 'SLOG3' && f0.caretAt === 0, 'a caret at the start stays at the start');
    const f3 = field('slog3', 3); box.sanitizePP(f3);
    ok(f3.value === 'SLOG3' && f3.caretAt === 3, 'a caret in the middle stays where it was');
    const fr = field('s-log3', 2); box.sanitizePP(fr);
    ok(fr.value === 'SLOG3' && fr.caretAt === 1, 'and moves back only by what was removed');
    const fn = field('SLOG3', 2); box.sanitizePP(fn);
    ok(fn.value === 'SLOG3' && fn.caretAt === -1, 'a value already in form is left completely alone');
  }
  // Applied at the field AND on the way to the engine: a value that arrived by
  // another door (an imported settings file, an old preferences file) is not
  // allowed to put a lower-case folder on the drive.
  ok(/pp:\s*normPP\(/.test(REND.slice(REND.indexOf('sources:    S.sources.map('),
                                       REND.indexOf('sources:    S.sources.map(') + 420)),
     'the frozen run list applies it');
  ok(/pp:\s*normPP\(/.test(REND.slice(REND.indexOf('cameraman: s.operator || globalOp'),
                                       REND.indexOf('cameraman: s.operator || globalOp') + 260)),
     'and so does the payload handed to the engine');
  // The suggestions have to be in the form the folders will carry, or picking
  // one from the list and typing the same thing by hand give two answers.
  const list = REND.slice(REND.indexOf('<datalist id="pp-list">'),
                          REND.indexOf('</datalist>'));
  const opts = [...list.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
  ok(opts.length >= 12, `the suggestion list was read (${opts.length} profiles)`);
  ok(opts.every(o => n(o) === o), 'every suggestion is already in that form: ' + opts.join(' '));
  for (const must of ['SLOG3', 'DLOG2', 'CLOG', 'HLG'])
    ok(opts.includes(must), `${must} is offered`);
}

console.log('\nan empty profile leaves no orphan separator behind');
{
  // The operator who never fills the field must not get "007_A001_" or
  // "_007_A001" on every destination for the rest of the shoot.
  ok(engName('{counter}_{cardname}_{pp}', { pp: '' }) === '007_A001', 'trailing separator is trimmed');
  ok(engName('{pp}_{counter}_{cardname}', { pp: '' }) === '007_A001', 'leading separator is trimmed');
  ok(engName('{counter}_{pp}_{cardname}', { pp: '' }) === '007_A001', 'and a separator run in the middle collapses');
  ok(eng.buildFolderSegments('{pp}/{counter}', CARD({ pp: '' }), CLOCK).join('/') === '007',
     'a subfolder level that resolves to nothing disappears instead of being created empty');
  ok(engName('{counter}_{cardname}_{pp}', { pp: '   ' }) === '007_A001', 'spaces alone count as nothing');
  ok(engName('{counter}_{cardname}_{pp}', { pp: null }) === '007_A001', 'so does a card that carries no field at all');
  ok(engName('{counter}_{cardname}_{pp}', { pp: undefined }) === '007_A001', 'and one where it is undefined');
}

console.log('\na separator typed into the profile never creates a subfolder');
{
  // Same rule as the card name and the operator: a "/" only ever means a new
  // level when the TEMPLATE has it. A profile typed as "S/Log3" that split the
  // path would push the counter out of the card's own folder.
  ok(eng.buildFolderSegments('{counter}_{pp}', CARD({ pp: 'S/Log3' }), CLOCK).length === 1,
     'a forward slash stays inside one level');
  // The engine applies the rule itself, as a last line before the folder is
  // created: a value that got here without passing the field is normalised
  // rather than written as it stands.
  ok(engName('{counter}_{pp}', { pp: 'S/Log3' }) === '007_SLOG3', 'and the separator is dropped, not kept');
  ok(engName('{counter}_{pp}', { pp: 's log 3' }) === '007_SLOG3', 'so are spaces, in the engine itself');
  ok(eng.buildFolderSegments('{counter}_{pp}', CARD({ pp: 'S\\Log3' }), CLOCK).length === 1,
     'a backslash does not split it either');
}

console.log('\nthe preview shows exactly what the engine will create');
{
  for (const tpl of ['{counter}_{cardname}_{pp}', '{pp}/{counter}_{cardname}',
                     '{camera}_{pp}_{counter}', '{counter}_{operator}_{camera}_{pp}',
                     '{pp}_{pp}_{counter}', '{YYYY}{MM}{DD}/{pp}/{counter}']) {
    for (const profile of ['SLog3', '', 'S/Log3', 'VLog']) {
      const a = eng.buildFolderSegments(tpl, CARD({ pp: profile }), CLOCK).join('/');
      const b = renSegs(tpl, { pp: profile });
      ok(a === b, `${tpl} with ${JSON.stringify(profile)} → ${a === b ? (a || '(nothing)') : `engine "${a}" vs preview "${b}"`}`);
    }
  }
}

console.log('\nTHE ONE THAT MATTERS: the counter is still read back out of the name');
{
  // With {pp} absent from the VAR set in makeCounterMatcher(), every one of
  // these returns null: the scan finds no card on the drive, restarts at 001,
  // and the next ingest is written over the previous one.
  const cases = [
    '{pp}_{counter}',
    '{counter}_{pp}',
    '{pp}_{counter}_{cardname}',
    '{counter}_{cardname}_{pp}',
    '{camera}_{pp}_{counter}',
    '{counter}_{operator}_{camera}_{pp}',
    '{pp}_{cardname}_{counter}_{operator}',
  ];
  for (const tpl of cases) {
    const name = engName(tpl);
    const got = eng.makeCounterMatcher(tpl).extract(name);
    ok(got === 7, `${tpl} → "${name}" → counter ${got === 7 ? '7' : String(got) + ' (expected 7)'}`);
  }
  // And with the field left empty, which is the folder most operators will
  // actually have on the drive.
  for (const tpl of cases) {
    const name = eng.buildFolderName(tpl, CARD({ pp: '' }), CLOCK);
    const got = eng.makeCounterMatcher(tpl).extract(name);
    ok(got === 7, `${tpl} with no profile → "${name}" → counter ${got === 7 ? '7' : String(got) + ' (expected 7)'}`);
  }
  // A folder from a DIFFERENT card must not be read as this one's counter.
  const m = eng.makeCounterMatcher('{pp}_{counter}_{cardname}');
  ok(m.extract('SLog3_012_B002') === 12, 'a later reel gives its own number back');
  ok(m.extract('VLog_003_C003') === 3, 'whatever profile it was shot on');
}

console.log('\na profile subfolder level is still counted as a card level');
{
  // structuralLevelPatterns() marks the levels built from the CLOCK or from
  // fixed text, which are never cards. A level the operator fills in is not one
  // of them. If {pp} were mistaken for a structural level, a card sitting under
  // it would be skipped by the scan and the counter would restart.
  ok(eng.structuralLevelPatterns('{pp}/{counter}_{cardname}').length === 0,
     'a profile level is not read as structure');
  ok(eng.structuralLevelPatterns('{YYYY}/{pp}/{counter}').length === 1,
     'the year beside it still is, and only it');
  ok(eng.structuralLevelPatterns('DAY1/{pp}/{counter}').length === 1,
     'so is a level of fixed text');
}

console.log('\nthe profile is in the shooting note');
{
  // The note is the one artefact that stays with the footage and is read by a
  // human months later. A profile typed at ingest and missing from it would
  // have to be guessed from the picture.
  // lastIndexOf, not indexOf: the first occurrence is the NOTE_HEADER constant
  // Verify uses to recognise our own note, not the block that writes it.
  const noteAt = MAIN.lastIndexOf('ingesto - Shooting Note');
  const note = MAIN.slice(noteAt, noteAt + 800);
  ok(/Profile\s*:\s*'\s*\+\s*\(source\.pp/.test(note), 'the note writes a Profile line from source.pp');
  ok(note.includes("'Unknown'"), 'and says Unknown rather than leaving it blank');
  // The columns of that little block line up in a fixed-width font; a label of
  // the wrong length would step out of the column.
  const labels = [...note.matchAll(/'([A-Za-z]+ *): '/g)].map(m => m[1]);
  ok(labels.length >= 5, `the labels were read (${labels.length})`);
  ok(new Set(labels.map(l => l.length)).size === 1, 'every label is the same width: ' + labels.join('|'));
}

console.log('\nthe profile survives the run payload, frozen at START');
{
  // S.run is built at START and everything written afterwards reads from it.
  // A field present in the live list but absent from the frozen one would be
  // in the preview and missing from the report.
  const start = REND.indexOf('sources:    S.sources.map(');
  ok(start > 0, 'the frozen source list was found');
  const frozen = REND.slice(start, start + 420);
  ok(/pp:\s*normPP\(x\.pp \|\| globalPP\)/.test(frozen),
     'it carries the profile, normalised, with the same global fallback the engine gets');
  ok(/operator: x\.operator \|\| globalOp/.test(frozen) && /camera:   x\.camera   \|\| globalCam/.test(frozen),
     'and the operator and the camera fall back the same way');

  // And the list handed to the engine falls back to the global field.
  const s2 = REND.indexOf('cameraman: s.operator || globalOp');
  ok(s2 > 0, 'the engine payload was found');
  const payload = REND.slice(s2, s2 + 260);
  ok(/pp:\s*normPP\(s\.pp \|\| globalPP\)/.test(payload),
     'the card value wins, the global field is the fallback, and the rule is applied once more here');
  ok(/const globalPP\s*=\s*document\.getElementById\('meta-pp'\)/.test(REND),
     'and that global field is read from the interface');
}

console.log('\nthe frozen list and the engine payload describe the SAME card');
{
  // Two lists are built from S.sources at START: the one handed to the engine,
  // which decides the folder on the drive, and the frozen one the report, the
  // phone notification and the handoff document are written from. They are
  // written a hundred lines apart and they used to disagree: the engine fell
  // back to the global Operator / Camera / Picture profile fields, the frozen
  // list did not. A card is "customised" the moment anything on it is edited,
  // a note included, and a customised card stops receiving the global fields.
  // So a note plus the global fields produced a folder carrying the operator,
  // the camera and the profile, and a report and a handoff document saying all
  // three were empty.
  //
  // Both expressions are taken FROM THE SOURCE and run side by side, so this
  // cannot be satisfied by a comment claiming they match.
  const takeMap = (needle) => {
    const at = REND.indexOf(needle);
    if (at < 0) throw new Error('not found: ' + needle);
    const start = REND.indexOf('(', REND.indexOf('=>', at));
    let depth = 0;
    for (let j = start; j < REND.length; j++) {
      if (REND[j] === '(') depth++;
      else if (REND[j] === ')') { depth--; if (depth === 0) return REND.slice(start, j + 1); }
    }
    throw new Error('unbalanced: ' + needle);
  };
  const frozenExpr = takeMap('sources:    S.sources.map(x =>');
  const engineExpr = takeMap('const sources=S.sources.map((s,i)=>');

  const box = vm.createContext({ console, Object, String, Number, Array });
  vm.runInContext(extractFn(REND, 'normPP', 'index.html'), box);
  vm.runInContext(extractFn(REND, 'padCounter', 'index.html'), box);
  box.COUNTER_WIDTHS = [2, 3, 4];
  box.S = { counter: 7, counterWidth: 3, run: { base: 7, counterWidth: 3 } };
  vm.runInContext(`var frozenOf = (x, globalOp, globalCam, globalPP) => ${frozenExpr};`, box);
  vm.runInContext(`var engineOf = (s, i, globalOp, globalCam, globalPP) => ${engineExpr};`, box);

  const CASES = [
    ['nothing on the card, everything global',
     { path:'/c', name:'A001', operator:'', camera:'', pp:'', note:'' }, 'Noar', 'FX6', 'SLOG3'],
    ['a note typed on the card, which makes it customised',
     { path:'/c', name:'A001', operator:'', camera:'', pp:'', note:'day 2' }, 'Noar', 'FX6', 'SLOG3'],
    ['the card overrides all three',
     { path:'/c', name:'A001', operator:'Ana', camera:'FX3', pp:'VLOG', note:'' }, 'Noar', 'FX6', 'SLOG3'],
    ['the card overrides one of them',
     { path:'/c', name:'A001', operator:'', camera:'FX3', pp:'', note:'' }, 'Noar', 'FX6', 'SLOG3'],
    ['nothing anywhere',
     { path:'/c', name:'A001', operator:'', camera:'', pp:'', note:'' }, '', '', ''],
    ['a profile that still has to be normalised',
     { path:'/c', name:'A001', operator:'', camera:'', pp:'s-log 3', note:'' }, '', '', 'd.log2'],
  ];
  for (const [label, card, gOp, gCam, gPP] of CASES) {
    const a = box.frozenOf(card, gOp, gCam, gPP);
    const b = box.engineOf(card, 0, gOp, gCam, gPP);
    ok(a.pp === b.pp, `${label}: profile — frozen "${a.pp}" vs engine "${b.pp}"`);
    ok(a.operator === b.cameraman, `${label}: operator — frozen "${a.operator}" vs engine "${b.cameraman}"`);
    ok(a.camera === b.camera, `${label}: camera — frozen "${a.camera}" vs engine "${b.camera}"`);
  }
  // And the global fields have to be read ABOVE the freeze, or the frozen list
  // cannot use them at all.
  const startAt = REND.indexOf('S.copying=true;updateBtn();');
  const freezeAt = REND.indexOf('  S.run = {', startAt);
  ok(startAt > 0 && freezeAt > startAt, 'the freeze was found');
  ok(REND.slice(startAt, freezeAt).includes("getElementById('meta-pp')"),
     'the global profile field is read before the run is frozen');
}

console.log('\nthe profile is in the report, all three formats');
{
  const csvHead = REND.slice(REND.indexOf("const head=['#','Date'"), REND.indexOf("const head=['#','Date'") + 260);
  ok(csvHead.includes("'Profile'"), 'the CSV has a Profile column');
  const csvRow = REND.slice(REND.indexOf('return [r.n,r.date,r.card,r.folder'), REND.indexOf('return [r.n,r.date,r.card,r.folder') + 200);
  ok(/r\.pp\s*\|\|\s*''/.test(csvRow), 'and fills it');
  // The CSV header and its row must have the SAME number of cells, or every
  // column after Profile is shifted by one and the sheet is wrong throughout.
  const headCells = (csvHead.match(/'[^']*'/g) || []).length;
  const rowCells  = csvRow.replace(/fmtSize\([^)]*\)/g, 'X').replace(/num\([^)]*\)/g, 'X')
                          .replace(/fmtReportDur\([^)]*\)/g, 'X');
  ok(headCells >= 20, `the header row was read (${headCells} columns)`);
  ok(/r\.pp/.test(rowCells) && /'Profile'/.test(csvHead), 'header and row both name it');

  ok(/pp:\s*src\.pp\s*\|\|\s*''/.test(REND), 'the report record carries the profile');
  ok(/pp:\s*r\.pp\s*\|\|\s*''/.test(REND), 'and so does the slim record embedded in the HTML report');
  ok(/r\.pp\?`<div class="c-path">\$\{escH\(r\.pp\)\}<\/div>`/.test(REND),
     'the HTML report shows it under the camera, and escapes it');
}

console.log('\nthe profile is in the handoff document');
{
  const ctx = vm.createContext({ console, Set, Map, Math, Date, Array, String, Number, JSON,
                                 S: { appVersion: 'test' } });
  vm.runInContext(extractFn(REND, 'modeVerifiesContents', 'index.html'), ctx);
  vm.runInContext(extractFn(REND, 'buildHandoff', 'index.html'), ctx);
  const RUN = { dests: [{ path: '/Volumes/SHUTTLE_1', name: 'SHUTTLE_1' }],
                runId: 'r1', cksum: true, cksumList: true, cksumMhl: false, ascMhl: false,
                sources: [{ path: '/Volumes/A001', name: 'A001', operator: 'noar', camera: 'FX6', pp: 'SLog3' },
                          { path: '/Volumes/B002', name: 'B002', operator: 'ana',  camera: 'FX3', pp: 'VLog'  }] };
  const r = { sourceName: 'A001', sourcePath: '/Volumes/A001',
              destPath: '/Volumes/SHUTTLE_1/001_A001', relFolder: '001_A001',
              mode: 'pro', proAlgo: 'xxh128', proDoubleRead: true,
              success: true, canceled: false, errors: 0, errorList: [],
              failedFiles: [], unstableFiles: [], quarantinedPaths: [], sidecarFailed: [],
              scanIncomplete: false, coldVerify: true, doubleReadCached: false,
              seenFiles: 186, totalFiles: 186, copiedFiles: 186, skippedFiles: 0 };

  const d0 = ctx.buildHandoff([r], RUN, 0);
  ok(d0.source.pictureProfile === 'SLog3', 'the document names the profile of the card it is about');
  ok(d0.source.camera === 'FX6' && d0.source.operator === 'noar', 'with the camera and the operator beside it');
  ok(d0.safeToErase === true, 'and a clean run still says yes');

  // The CARD decides which entry, not the position. Card two of a batch handed
  // over with card one's profile would send the wrong LUT and nobody would
  // notice until the grade.
  const r2 = Object.assign({}, r, { sourceName: 'B002', sourcePath: '/Volumes/B002' });
  const d1 = ctx.buildHandoff([r2], RUN, 1);
  ok(d1.source.pictureProfile === 'VLog', 'the second card of a batch gets its own profile');
  ok(d1.source.camera === 'FX3', 'and its own camera');

  // The position is NOT what is trusted. A card refused at pre-flight, or
  // results arriving in another order, shifts every card after it: matching by
  // position would hand card two the profile of card one, in a document that
  // looks perfectly well formed.
  ok(ctx.buildHandoff([r2], RUN, 0).source.pictureProfile === 'VLog',
     'a card at the wrong position is still matched by its path');
  ok(ctx.buildHandoff([r], RUN, 1).source.pictureProfile === 'SLog3',
     'and so is the first one');
  // Two cards with the same label are two cards: the path separates them.
  const SAME = { dests: RUN.dests, runId: 'r1', cksum: true, cksumList: true,
                 cksumMhl: false, ascMhl: false,
                 sources: [{ path: '/Volumes/A001',   name: 'A001', pp: 'SLog3' },
                           { path: '/Volumes/A001-1', name: 'A001', pp: 'LogC4' }] };
  const rDup = Object.assign({}, r, { sourceName: 'A001', sourcePath: '/Volumes/A001-1' });
  ok(ctx.buildHandoff([rDup], SAME, 0).source.pictureProfile === 'LogC4',
     'two cards labelled the same are told apart by their path');

  // A run object from before this version, or one that never carried the list,
  // still has to produce a document. It is the last thing said about a card
  // that may be erased next.
  const bare = Object.assign({}, RUN); delete bare.sources;
  const db = ctx.buildHandoff([r], bare, 0);
  ok(db.source.pictureProfile === '' && db.source.camera === '',
     'a run without the list leaves the fields empty rather than failing');
  ok(db.safeToErase === true, 'and still answers the question it exists to answer');
  // A result that carries no path falls back to the label. It should not
  // happen, and the document is still written if it does.
  const noPath = Object.assign({}, r, { sourceName: 'B002', sourcePath: '' });
  ok(ctx.buildHandoff([noPath], RUN, 0).source.pictureProfile === 'VLog',
     'a result with no path is matched by the card label');

  const unknown = Object.assign({}, r, { sourceName: 'Z999', sourcePath: '/Volumes/Z999' });
  ok(ctx.buildHandoff([unknown], RUN, 9).source.pictureProfile === '',
     'a card that is in no list leaves the field empty rather than guessing');
}

console.log('\nthe dry run shows the fields, and still answers no');
{
  // The dry run is how the script that erases cards gets written. A field that
  // comes out empty there reads as a field that does not exist, and the script
  // is written without it.
  const ctx = vm.createContext({ console, Set, Map, Math, Date, Array, String, Number, JSON,
                                 COUNTER_WIDTHS: [2, 3, 4] });
  let handed = null;
  ctx.window = { ingesto: { handoff: async (payload) => { handed = payload; return { ok: true }; } } };
  ctx.document = { getElementById: () => null };
  ctx.S = { mode: 'pro', proAlgo: 'xxh128', proDoubleRead: true, counter: 1, counterWidth: 3,
            handoffCommand: '/bin/echo', appVersion: 'test' };
  vm.runInContext(extractFn(REND, 'tokenizeCommand',      'index.html'), ctx);
  vm.runInContext(extractFn(REND, 'padCounter',           'index.html'), ctx);
  vm.runInContext(extractFn(REND, 'modeVerifiesContents', 'index.html'), ctx);
  vm.runInContext(extractFn(REND, 'buildHandoff',         'index.html'), ctx);
  vm.runInContext(extractFn(REND, 'handoffDryRun',        'index.html'), ctx);
  return vm.runInContext('handoffDryRun()', ctx).then(() => {
    ok(handed !== null, 'the dry run produced a document');
    ok(handed.dryRun === true, 'marked as a dry run');
    ok(handed.safeToErase === false, 'and answering no, whatever the rest of it says');
    ok(handed.source.pictureProfile === 'EXAMPLE', 'the profile field is filled in, not empty');
    ok(handed.source.camera === 'EXAMPLE' && handed.source.operator === 'EXAMPLE',
       'and so are the camera and the operator');
    ok(!/\/Volumes\/[A-Z0-9_]*$/.test(handed.source.path) || handed.source.path.includes('EXAMPLE'),
       'and the card it names is still the fictional one');
    rest();
  });
}

function rest(){
console.log('\nthe interface offers the field, everywhere a card is described');
{
  ok(/id="meta-pp"/.test(REND), 'the main panel has a Picture profile field');
  ok(/id="k-pp"/.test(REND), 'and so does the kiosk screen');
  ok(/updateSrcField\(\$\{i\},'pp'/.test(REND), 'each loaded card has its own');
  ok(/(?:addTok|insPick)\('var','pp'\)/.test(REND), 'and the Insert menu offers the variable');
  // The same sanitiser as the operator and the camera: what goes in a folder
  // name is letters and digits, decided in one place rather than three.
  const PP_LBL = '<div class="sif-label">PICTURE PROFILE</div>';
  const perCard = REND.slice(REND.indexOf(PP_LBL), REND.indexOf(PP_LBL) + 380);
  ok(/sanitizePP\(this\);updateSrcField/.test(perCard), 'the per-card field is normalised as it is typed');
  const global = REND.slice(REND.indexOf('id="meta-pp"'), REND.indexOf('id="meta-pp"') + 200);
  ok(/sanitizePP\(this\)/.test(global), 'so is the global one');
  const kiosk = REND.slice(REND.indexOf('id="k-pp"'), REND.indexOf('id="k-pp"') + 220);
  ok(/sanitizePP\(this\)/.test(kiosk), 'and so is the kiosk one');
  ok(/list="pp-list"/.test(global), 'and it suggests the usual profiles');
  ok(/<datalist id="pp-list">/.test(REND), 'from a list the page carries');

  // Cleared with the rest. A profile left behind after the card is removed is
  // inherited by the next card silently, and ends up in its folder name.
  const clear = REND.slice(REND.indexOf('function clearSources()'), REND.indexOf('function clearSources()') + 900);
  ok(/getElementById\('meta-pp'\)/.test(clear), 'removing the cards clears the profile too');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
