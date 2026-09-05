#!/usr/bin/env node
// Windows volume names.
//
// A card labelled LUMIX came out of the template as "D_" — the drive letter,
// cleaned. Two defects, both present since the PowerShell scan was written:
//
//   1. the label was read from Get-PSDrive's "Description", which Windows
//      fills for FIXED disks and leaves EMPTY for removable volumes — cards;
//   2. the string used as the card name was the DISPLAY name, letter and
//      parentheses included, so a working label produced "LUMIX (D_)".
//
// The JSON below is the verbatim output of a real Windows 11 machine (a LUMIX
// FAT32 card on D:, a NAS mapped on Z:, an unlettered recovery partition), so
// this suite fails if the merge stops matching what Windows actually answers.
//
//   node scripts/test-win-volumes.js
//
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in main.js`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
const ctx = vm.createContext({ console, JSON, String, Number, Array, Map });
vm.runInContext(extractFn('mergeWinDrives'), ctx);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── Verbatim from the machine that found the bug ────────────────────────────
const PSDRIVE = JSON.stringify([
  { Name:'C', Used:400e9, Free:100e9, Description:'W11',           DisplayRoot:null },
  { Name:'D', Used:2e9,   Free:30e9,  Description:'',              DisplayRoot:null },
  { Name:'G', Used:1e12,  Free:2e12,  Description:'MEDIAS_GABARA', DisplayRoot:null },
  { Name:'Z', Used:5e12,  Free:1e12,  Description:'',              DisplayRoot:'\\\\192.168.2.10\\nas' },
]);
// Note what is NOT here: Z:. Get-Volume does not list mapped network drives.
// And the last row has no drive letter — a recovery partition.
const GETVOLUME = JSON.stringify([
  { DriveLetter:'G',  FileSystemLabel:'MEDIAS_GABARA' },
  { DriveLetter:'C',  FileSystemLabel:'W11' },
  { DriveLetter:'D',  FileSystemLabel:'LUMIX' },
  { DriveLetter:null, FileSystemLabel:'' },
]);

console.log('\nthe machine that found the bug');
{
  const m = ctx.mergeWinDrives(PSDRIVE, GETVOLUME);
  ok(m.get('D').label === 'LUMIX', 'the removable card gets its real name, not its drive letter');
  ok(m.get('C').label === 'W11' && m.get('G').label === 'MEDIAS_GABARA', 'the fixed disks keep theirs');
  ok(m.get('Z') && m.get('Z').displayRoot === '\\\\192.168.2.10\\nas',
     'the mapped network drive survives, though Get-Volume never mentions it');
  ok(m.size === 4, 'the unlettered recovery partition creates no drive (' + m.size + ' drives)');
  ok(m.get('D').free === 30e9 && m.get('D').used === 2e9, 'sizes still come from Get-PSDrive');
}

console.log('\nwhat Get-PSDrive alone used to answer');
{
  const m = ctx.mergeWinDrives(PSDRIVE, '');
  ok(m.get('D').label === '', 'without Get-Volume the card has no name at all — the bug, reproduced');
  ok(m.get('C').label === 'W11', 'and only the fixed disks are named');
}

console.log('\nthe answer shapes PowerShell can produce');
{
  // A char may serialise as "D" or as its code point, depending on the version.
  const asCode = JSON.stringify([{ DriveLetter: 68, FileSystemLabel: 'LUMIX' }]);
  ok(ctx.mergeWinDrives(PSDRIVE, asCode).get('D').label === 'LUMIX',
     'a drive letter serialised as a number is read as a letter');
  // One drive on the machine → ConvertTo-Json emits an object, not an array.
  const single = JSON.stringify({ Name:'E', Used:1, Free:2, Description:'', DisplayRoot:null });
  const one = ctx.mergeWinDrives(single, JSON.stringify({ DriveLetter:'E', FileSystemLabel:'CFEXPRESS' }));
  ok(one.get('E').label === 'CFEXPRESS', 'a single drive is not lost to the array/object difference');
  ok(ctx.mergeWinDrives('', '').size === 0, 'both calls failing yields no drive, not a crash');
  ok(ctx.mergeWinDrives('not json', '{oops').size === 0, 'unparseable output is ignored, not thrown');
  ok(ctx.mergeWinDrives(JSON.stringify([{Name:'D',Description:'OLD'}]),
                        JSON.stringify([{DriveLetter:'d',FileSystemLabel:'NEW'}])).get('D').label === 'NEW',
     'a lower-case drive letter still matches, and Get-Volume wins');
  ok(ctx.mergeWinDrives(JSON.stringify([{Name:'D',Description:'KEEP'}]),
                        JSON.stringify([{DriveLetter:'D',FileSystemLabel:'   '}])).get('D').label === 'KEEP',
     'a blank label from Get-Volume does not erase a good one');
  ok(ctx.mergeWinDrives(JSON.stringify([{Name:'Drive',Description:'X'}]), '').size === 0,
     'anything that is not a single letter is not a drive');
  ok(ctx.mergeWinDrives(JSON.stringify([{Name:'D',Description:' LUMIX '}]), '').get('D').label === 'LUMIX',
     'surrounding spaces are trimmed off a label');
  // 91-96 sit between 'Z' and 'a': "[ \\ ] ^ _ `" are not drive letters.
  ok(ctx.mergeWinDrives('', JSON.stringify([{DriveLetter:92,FileSystemLabel:'X'}])).size === 0,
     'a code point between Z and a is not a drive letter');
}

console.log('\nthe REAL Windows scan, run against that machine');
{
  // Not a mirror of the code — the code itself, with Windows stubbed out at the
  // two places it talks to the system. A test that rebuilt the expected object
  // by hand passed even when the scan stopped calling Get-Volume, and even when
  // the card name was set back to the display string.
  const asked = [];
  const winCtx = vm.createContext({
    console, JSON, String, Number, Array, Map, Boolean,
    process: { env: { SystemDrive: 'C:' }, platform: 'win32' },
    execSync: (cmd) => {
      asked.push(cmd);
      if (cmd.includes('Get-PSDrive')) return PSDRIVE;
      if (cmd.includes('Get-Volume'))  return GETVOLUME;
      return '';
    },
    fs: { statSync: (p) => {
      if (['C:\\', 'D:\\', 'G:\\', 'Z:\\'].includes(p)) return { isDirectory: () => true };
      throw new Error('ENOENT');
    } },
    detectCamera: () => null,
  });
  vm.runInContext(extractFn('mergeWinDrives') + '\n' + extractFn('getMountedVolumesWin'), winCtx);
  const vols = winCtx.getMountedVolumesWin();
  const by = {}; vols.forEach(v => { by[v.path[0]] = v; });

  ok(asked.some(c => c.includes('Get-Volume')),
     'the scan really asks Get-Volume — the only source that names a removable card');
  ok(vols.length === 4, 'four drives found (' + vols.length + ')');
  ok(by.D && by.D.label === 'LUMIX', 'the card is loaded as "LUMIX" (' + (by.D && by.D.label) + ')');
  ok(by.D && by.D.name === 'LUMIX (D:)', 'and shown as "LUMIX (D:)" in the volume list');
  ok(by.D && !/[():]/.test(by.D.label),
     'the card name carries no parenthesis and no colon — a colon becomes "_" in a folder name');
  ok(by.G && by.G.label === 'MEDIAS_GABARA' && by.G.name === 'MEDIAS_GABARA (G:)',
     'a fixed disk behaves the same way');
  ok(by.C && by.C.isSystem === true, 'the system drive is still recognised');
  ok(by.Z && by.Z.isNetwork === true && by.Z.fsType === 'network',
     'the mapped network drive is still recognised, from Get-PSDrive alone');
  ok(by.D && by.D.freeSize === 30e9 && by.D.totalSize === 32e9, 'sizes are right');

  // An unlabelled card must not come back as an empty string: the folder
  // template would then produce nothing at all.
  const noLabel = vm.createContext({
    console, JSON, String, Number, Array, Map, Boolean,
    process: { env: { SystemDrive: 'C:' }, platform: 'win32' },
    execSync: (cmd) => cmd.includes('Get-PSDrive')
      ? JSON.stringify([{ Name:'E', Used:0, Free:1e9, Description:'', DisplayRoot:null }]) : '',
    fs: { statSync: (p) => { if (p === 'E:\\') return { isDirectory: () => true }; throw new Error('ENOENT'); } },
    detectCamera: () => null,
  });
  vm.runInContext(extractFn('mergeWinDrives') + '\n' + extractFn('getMountedVolumesWin'), noLabel);
  const e = noLabel.getMountedVolumesWin()[0];
  ok(e && e.label === 'E' && e.name === 'E:',
     'a card with no label falls back to the bare letter — "E:" would have become the folder "E_"');
  ok(e && !/:/.test(e.label), 'no colon can reach the card name');
}

console.log('\nEVERY route that loads a card asks for the label');
{
  // The first version of this fix touched three call sites and missed three
  // others — a drag from Explorer, the Browse button, and kiosk mode, where
  // Browse is the ONLY way to load a card. All three built the name from the
  // path, so "D:\\" became the card name "D:" and the folder "001_D__noar".
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const grab = (name) => {
    const i = HTML.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let j = HTML.indexOf('{', i), d = 0;
    for (; j < HTML.length; j++) {
      if (HTML[j] === '{') d++;
      else if (HTML[j] === '}') { d--; if (!d) return HTML.slice(i, j + 1); }
    }
    return '';
  };
  // Run each loader for real, with a Windows volume list in place, and record
  // the name it hands to addToZone.
  const VOLS = [{ path: 'D:\\', name: 'LUMIX (D:)', label: 'LUMIX' }];
  const run = (src, call) => {
    let got = null;
    const sandbox = {
      S: { volumes: VOLS, sources: [], copying: false },
      addToZone: (z, e) => { got = e.name; },
      pathToName: (p) => String(p).replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || String(p),
      volCardName: (v) => (v && (v.label || v.name)) || '',
      window: { ingesto: { browseFolder: async () => 'D:\\', detectCamera: async () => null } },
      document: { getElementById: () => null },
      console,
    };
    sandbox.window.ingesto.platform = 'win32';
    const c = vm.createContext(sandbox);
    vm.runInContext(grab('cardNameForPath') + '\n' + src + '\n' + call, c);
    return got;
  };
  ok(/function cardNameForPath\(/.test(HTML), 'there is a single place that names a card from a path');
  ok(run(grab('winVolAdd'), "winVolAdd('D:\\\\','src');") === 'LUMIX',
     'the volume list right-click loads "LUMIX"');
  ok(run(grab('cardNameForPath'), "globalThis.__r = cardNameForPath('D:\\\\');") === null,
     'cardNameForPath alone loads nothing');
  ok(/addToZone\(z,\{name:cardNameForPath\(fp\)/.test(HTML), 'Browse names the card from the volume');
  ok(/addToZone\('src',\{path:fp,name:cardNameForPath\(fp\)\}\)/.test(HTML), 'kiosk Browse does too');
  ok(/cardNameForPath\(full\)/.test(HTML), 'a drop from Explorer or the Finder does too');
  ok(/addToZone\(z,\{name:cardNameForPath\(p\), path:p\}\)/.test(HTML), 'and a drag onto the zone');
  // No loader may build a card name straight from a path any more.
  ok(!/addToZone\([^)]*pathToName\(/.test(HTML),
     'no route left that names a loaded card from its path alone');
}

console.log('\nthe renderer asks for the label, and falls back');
{
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const fn = HTML.match(/function volCardName\(v\)\{[^}]*\}/);
  ok(!!fn, 'volCardName exists');
  const volCardName = new Function('return ' + fn[0] + '; volCardName')();
  ok(volCardName({ label:'LUMIX', name:'LUMIX (D:)' }) === 'LUMIX', 'the label wins when there is one');
  ok(volCardName({ name:'A001' }) === 'A001', 'a volume with no label falls back to its name');
  ok(volCardName(null) === '', 'and nothing at all does not throw');
  ok(!/addToZone\((?:'src'|z),\{name:\s*vol?s?\.name/.test(HTML),
     'no path left where a volume is loaded under its DISPLAY name');
}

console.log('\nWindows device names, refused before the ingest starts');
{
  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are devices on Windows: mkdir fails on
  // them. They only became reachable the day a card's real label started
  // arriving — before that every Windows card was called "D:". A card labelled
  // AUX must be refused up front, not fail in the middle of a copy.
  const DEV = SRC.match(/const WIN_DEVICE_NAME = .*;/)[0];
  const make = (platform) => {
    const c = vm.createContext({ process: { platform }, String, console });
    vm.runInContext(DEV + '\n' + extractFn('isSafeFolderName'), c);
    return c.isSafeFolderName;
  };
  const win = make('win32'), mac = make('darwin');
  for (const n of ['CON','PRN','AUX','NUL','COM1','LPT9','aux','Nul.txt','CON.MOV'])
    ok(win(n) === false, 'Windows refuses a folder named "' + n + '"');
  for (const n of ['AUXILIAIRE','CONCERT','NULL','COM','LPT','A001','LUMIX','COM10'])
    ok(win(n) === true, 'but not "' + n + '" — a real name that merely starts the same way');
  ok(mac('AUX') === true && mac('CON') === true,
     'macOS is not punished for a Windows limitation — no false refusal there');

  // The renderer's pre-flight must agree, or it approves what the engine refuses.
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const rDev = HTML.match(/const WIN_DEVICE_NAME=.*;/)[0];
  const rFn  = HTML.match(/function isSafeFolderName\(n\)\{[\s\S]*?\n\}/)[0];
  const mk = (platform) => {
    const c = vm.createContext({ window: { ingesto: { platform } }, String, console });
    vm.runInContext(rDev + '\n' + rFn, c);
    return c.isSafeFolderName;
  };
  const rwin = mk('win32'), rmac = mk('darwin');
  ok(rwin('AUX') === false && rwin('COM1') === false, 'the pre-flight refuses them too');
  ok(rwin('LUMIX') === true && rmac('AUX') === true, 'and agrees with the engine everywhere else');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
