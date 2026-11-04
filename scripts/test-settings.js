#!/usr/bin/env node
// The settings kept between launches: one table (src/renderer/scripts/
// preferences.js) for the preferences file and the exported settings file.
// Run with the real state.js (the defaults) and the real table.
//
// The rule checked here, at launch and at import alike: a value that is
// missing, or not of the expected kind, takes the default of ingesto.
//
//   node scripts/test-settings.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { RENDERER: REND, extractFn } = require('./lib/source');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const DIR = path.join(__dirname, '..', 'src', 'renderer', 'scripts');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');

// A fresh window: state.js, then preferences.js, as index.html loads them.
// Top-level const/let of a vm script stay out of the context object, so the
// names the test reads are handed out explicitly at the end.
function freshWindow() {
  const shared = require('../src/shared/modes');
  const ctx = vm.createContext({ console, structuredClone, window: { IngestoShared: shared }, Number, String, Array, Object });
  const filterCats = (read('file-filter.js').match(/^const FILTER_CATS = \{[\s\S]*?\n\};/m) || [''])[0];
  vm.runInContext([
    read('state.js'),
    filterCats,
    extractFn(REND, 'normPresets'),
    // The template reader is not what is tested here: it records what it got.
    'function tokensFromStored(list, legacy){ return list.map(t => ({ type:t.type, key:t.key, legacy:!!legacy })); }',
    read('preferences.js'),
    'globalThis.T = { S, SETTINGS, SETTING_DEFAULTS, applySettings, settingsForFile };',
  ].join('\n'), ctx);
  return ctx.T;
}

console.log('\na file with nothing in it gives a fresh ingesto');
{
  const T = freshWindow();
  const before = JSON.stringify(T.settingsForFile({ to: 'prefs' }));
  T.applySettings({}, { from: 'prefs' });
  ok(JSON.stringify(T.settingsForFile({ to: 'prefs' })) === before, 'every setting keeps its default');
  ok(T.S.mode === 'slow' && T.S.writeReport === true && T.S.writeSentinel === false, 'SECURE, a report, no card log');
  T.applySettings(null, { from: 'prefs' });
  ok(T.S.mode === 'slow', 'and a file that is not even an object changes nothing either');
}

console.log('\na value of the wrong kind is never taken');
{
  const T = freshWindow();
  T.applySettings({ mode: 'secure', proAlgo: 'sha1', proDoubleRead: 'yes', writeReport: 'no', reportHtml: 0,
                    cksumMhl: 1, counterWidth: 7, presets: 'none', historyHidden: 'x', noteMode: 'big',
                    activePreset: 9, ntfyServer: '  ', fileFilterFormats: ['mov'], exportInclude: [] },
                  { from: 'prefs' });
  const D = T.SETTING_DEFAULTS;
  const bad = ['mode','proAlgo','proDoubleRead','writeReport','reportHtml','cksumMhl','counterWidth','presets',
               'historyHidden','noteMode','activePreset','ntfyServer','fileFilterFormats','exportInclude']
    .filter(k => JSON.stringify(T.S[k]) !== JSON.stringify(D[k]));
  ok(bad.length === 0, 'each one takes its default' + (bad.length ? ' : ' + bad.join(', ') : ''));
  for (const m of ['secure', 'verified', 'SLOW', '', null, 3, {}, ['pro']]) {
    T.S.mode = 'fast';
    T.applySettings({ mode: m }, { from: 'prefs' });
    ok(T.S.mode === 'slow', `${JSON.stringify(m)} is not a mode: SECURE, the default`);
  }
}

console.log('\na good value is taken as it is');
{
  const T = freshWindow();
  T.applySettings({ mode: 'pro', proAlgo: 'md5', proDoubleRead: true, writeReport: false, reportCsv: true,
                    counterWidth: 4, noteMode: 'md', activePreset: 2, historyHidden: ['a', 3, 'b'],
                    ntfyServer: 'https://n.example', fileFilterFormats: { mov: false } }, { from: 'prefs' });
  const S = T.S;
  ok(S.mode === 'pro' && S.proAlgo === 'md5' && S.proDoubleRead === true, 'the copy mode');
  ok(S.writeReport === false && S.reportCsv === true, 'the report switches');
  ok(S.counterWidth === 4 && S.noteMode === 'md' && S.activePreset === 2, 'the counter width, the notes, the preset');
  ok(JSON.stringify(S.historyHidden) === '["a","b"]', 'the hidden history entries, strings only');
  const T2 = freshWindow();
  T2.applySettings({ historyHidden: Array.from({ length: 6000 }, (_, i) => 'k' + i) }, { from: 'prefs' });
  ok(T2.S.historyHidden.length === 5000 && T2.S.historyHidden[4999] === 'k5999', 'and at most the last 5000');
  ok(S.ntfyServer === 'https://n.example', 'the notification server');
  ok(S.fileFilterFormats.mov === false && S.fileFilterFormats.mp4 === true && S.fileFilterFormats.xml === false,
     'the filter keeps its choices, and a format it did not know gets its default');
}

console.log('\nwhat the preferences file holds comes back the same');
{
  const A = freshWindow();
  A.applySettings({ mode: 'normal', counterWidth: 2, writeChecksum: false, ascMhl: true, hookCommand: 'echo',
                    hookEnabled: true, presets: [{ name: 'P', tokens: [{ type: 'var', key: 'counter' }] }] }, { from: 'prefs' });
  const file = JSON.parse(JSON.stringify(A.settingsForFile({ to: 'prefs' })));
  const B = freshWindow();
  B.applySettings(file, { from: 'prefs', legacy: false });
  ok(JSON.stringify(B.settingsForFile({ to: 'prefs' })) === JSON.stringify(file), 'written, read back, written again: identical');
  // Every field the preferences file held in 2.10.2 is still written.
  const KEPT = ['presets','mode','proAlgo','proDoubleRead','proWarnDismissed','updateDismissedVersion','historyHidden',
    'historyClearedAt','lastTemplate','noteMode','activePreset','writeSentinel','writeReport','counterWidth','reportHtml',
    'reportCsv','reportJson','reportFull','writeChecksum','cksumList','cksumMhl','ascMhl','ntfyEnabled','ntfyServer',
    'ntfyTopic','hookEnabled','exportInclude','hookCommand','handoffEnabled','handoffCommand','fileFilterFormats',
    'copyEmptyFolders','reorganizeFiles'];
  const missing = KEPT.filter(k => !(k in file));
  ok(missing.length === 0, 'no field of the earlier preferences file is lost' + (missing.length ? ' : ' + missing.join(', ') : ''));
  ok(!('fileFilter' in file), 'the filter main switch is not saved (it is off at each launch)');
}

console.log('\nan earlier preferences file keeps what it meant');
{
  const T = freshWindow();
  T.applySettings({ hookCommand: 'say done' }, { from: 'prefs' });
  ok(T.S.hookEnabled === true, 'a command saved before the on/off switch existed still runs');
  T.applySettings({ hookCommand: '  ' }, { from: 'prefs' });
  ok(T.S.hookEnabled === false, 'an empty one does not');
  T.applySettings({ lastTemplate: [{ type: 'sep', key: 'a/b' }] }, { from: 'prefs', legacy: true });
  ok(T.S.tokens[0].legacy === true, 'a template saved without tplVersion is read the old way');
  T.applySettings({ lastTemplate: [] }, { from: 'prefs' });
  ok(T.S.tokens.length === T.SETTING_DEFAULTS.tokens.length && !T.S.tokens[0].legacy, 'an empty template gives the default one');
}

console.log('\nimport: the file says what it carries, and the same rule applies');
{
  const T = freshWindow();
  T.S.mode = 'pro'; T.S.writeReport = false; T.S.writeSentinel = true;
  T.applySettings({ include: { ingestReport: true }, reportCsv: true }, { from: 'export', cats: { ingestReport: true } });
  ok(T.S.writeReport === true, 'a category carried without its switch: the switch takes its default (on)');
  ok(T.S.reportCsv === true, 'what the file gives is taken');
  ok(T.S.mode === 'pro' && T.S.writeSentinel === true, 'a category the file does not carry is left alone');
  T.applySettings({ mode: 'banana' }, { from: 'export', cats: { copyMode: true } });
  ok(T.S.mode === 'slow', 'an unusable mode in an imported file: SECURE, the default');
  T.applySettings({ hookCommand: 'rm -rf /', hookEnabled: true, ntfyTopic: 'x' },
                  { from: 'export', cats: { copyMode: true, ingestReport: true, fileFilter: true, namingTemplate: true,
                                            namingPresets: true, cardTracking: true, writeChecksum: true } });
  ok(T.S.hookCommand === '' && T.S.hookEnabled === false && T.S.ntfyTopic === '',
     'nothing outside the export categories ever comes in from a file: no command, no notification');
}

console.log('\nexport: only the categories switched on, and they come back the same');
{
  const A = freshWindow();
  A.applySettings({ mode: 'fast', reportJson: true, counterWidth: 2 }, { from: 'prefs' });
  const out = A.settingsForFile({ to: 'export', cats: { copyMode: true, namingTemplate: true } });
  ok('mode' in out && 'tokens' in out && 'counterWidth' in out && !('reportJson' in out) && !('lastTemplate' in out),
     'the copy mode and the template, under the names of an exported file, and nothing else');
  ok(!Object.keys(out).some(k => /hook|ntfy|handoff/.test(k)), 'never a command or a notification');
  const B = freshWindow();
  B.applySettings(JSON.parse(JSON.stringify(out)), { from: 'export', cats: { copyMode: true, namingTemplate: true } });
  ok(B.S.mode === 'fast' && B.S.counterWidth === 2, 'imported elsewhere, they give the same settings');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
