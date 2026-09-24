#!/usr/bin/env node
// The guards of the interface: what it refuses to do while an ingest is in
// flight, what it cleans before a value reaches a folder name, and what the
// written report is allowed to call verified.
//
// Every case here comes from a defect found in the 2.7.0 review of the
// renderer. Each one names the scenario that produced it.
//
//   node scripts/test-ui-guards.js
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function tagOf(src, id) {
  const m = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(src);
  if (!m) throw new Error(`element #${id} not found`);
  return m[0];
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ── 1. The copy mode after the PRO warning ──────────────────────────────────
console.log('\ncancelling the PRO warning leaves the mode where it was');
{
  // FAST, click PRO out of curiosity, click outside the dialog. The mode used
  // to become SECURE, and be persisted, with nothing said.
  const ctx = vm.createContext({
    S: { mode: 'fast', proWarnDismissed: false, _modeBeforeProWarn: null },
    setMode(m) { this.S.mode = m; },
    document: { getElementById: () => ({ checked: false, classList: { add() {}, remove() {} } }) },
  });
  ctx.setMode = (m) => { ctx.S.mode = m; };
  vm.runInContext(extractFn(REND, 'onSelectPro'), ctx);
  vm.runInContext(extractFn(REND, 'proWarnCancel'), ctx);
  vm.runInContext(extractFn(REND, 'proWarnUse'), ctx);

  for (const from of ['fast', 'normal', 'slow']) {
    ctx.S.mode = from;
    ctx.onSelectPro();
    ctx.proWarnCancel();
    ok(ctx.S.mode === from, `from ${from.toUpperCase()}, cancelling goes back to ${from.toUpperCase()}`);
  }
  // Confirming still selects PRO, which is the whole point of the dialog.
  ctx.S.mode = 'fast';
  ctx.onSelectPro();
  ctx.proWarnUse();
  ok(ctx.S.mode === 'pro', 'confirming selects PRO');
  // Nothing selected yet: SECURE is the safe landing.
  ctx.S.mode = null; ctx.S._modeBeforeProWarn = null;
  ctx.proWarnCancel();
  ok(ctx.S.mode === 'slow', 'with no previous mode, cancelling lands on SECURE');
}

// ── 2. The mode printed in the written report ───────────────────────────────
console.log('\nthe report never paints an unverified mode as verified');
{
  const ctx = vm.createContext({});
  vm.runInContext(extractFn(REND, 'reportModeClass'), ctx);
  vm.runInContext(extractFn(REND, 'reportModeLabel'), ctx);

  const cls = m => ctx.reportModeClass({ mode: m });
  const lbl = m => ctx.reportModeLabel({ mode: m, proAlgo: 'xxh64' });

  ok(cls('normal') === 'm-sizecheck', `SIZE CHECK prints as m-sizecheck ("${cls('normal')}")`);
  ok(cls('fast') === 'm-fast' && cls('slow') === 'm-secure' && cls('pro') === 'm-pro',
     'FAST, SECURE and PRO keep their own class');
  ok(/not verified/.test(lbl('normal')), 'and its label still says it is not verified');

  // The colour itself. m-verified is the old name for the same mode: reports
  // written before 2.7.0 carry it, and must stop being green the moment they
  // are re-rendered.
  const dark = /\.m-sizecheck,\.m-verified\{color:#4d90f0/.test(REND);
  const print = /\.m-sizecheck,\.m-verified\{color:#1a73c7/.test(REND);
  ok(dark, 'on screen, size check is blue, like the app');
  ok(print, 'and blue in the print stylesheet too');
  ok(!/\.m-verified\{color:#35c98b/.test(REND) && !/\.m-verified\{color:#0f9d58/.test(REND),
     'no rule paints it green any more');
  ok(/'m-sizecheck'/.test(REND) && /MODE_CLASSES[^;]*'m-verified'/.test(REND),
     'both names stay on the whitelist, so an older report still renders');
  ok(/\.m-fast\{color:#8b909b/.test(REND), 'and FAST is grey, like the app, instead of blue');
}

// ── 3. Kiosk: what reaches a folder name ────────────────────────────────────
console.log('\nkiosk fields are cleaned like the standard window');
{
  // "Jean Marc" used to create 001_A001_Jean Marc_… : the engine flattens only
  // / and \, so a space went straight into the folder name, where the standard
  // window would have written JeanMarc.
  const kop = tagOf(REND, 'k-op');
  const kcam = tagOf(REND, 'k-cam');
  ok(/oninput="[^"]*sanitizeMeta\(this\)/.test(kop), 'the kiosk Operator field is sanitized as you type');
  ok(/oninput="[^"]*kioskUpdateStart\(\)/.test(kop), 'and still enables the Start button');
  ok(/oninput="[^"]*sanitizeMeta\(this\)/.test(kcam), 'the kiosk Camera field is sanitized as you type');

  // And again when Start is pressed, for a value that never went through an
  // input event: restored, pasted by a script, set programmatically.
  const start = extractFn(REND, 'kioskStart');
  ok(/replace\(\/\[\^A-Za-z0-9\]\/g,\s*''\)/.test(start),
     'kioskStart cleans the values again rather than trusting the fields');
  const clean = x => String(x == null ? '' : x).replace(/[^A-Za-z0-9]/g, '');
  ok(clean('Jean Marc') === 'JeanMarc' && clean('A/B') === 'AB' && clean('') === '',
     'the rule itself: letters and digits only');
}

// ── 4. What cannot be done while an ingest is in flight ─────────────────────
console.log('\nnothing leaves under the ingest while it starts');
{
  // S._starting covers START up to the first byte: the counter scan and the
  // free-space check both await, and on a network share that is seconds.
  const eject = extractFn(REND, 'ejectVolumeFromMenu');
  ok(/S\.copying\s*\|\|\s*S\._starting/.test(eject),
     'a volume cannot be ejected during the start-up window either');

  const verify = extractFn(REND, 'startVerifyFolder');
  ok(/S\.copying\s*\|\|\s*S\._starting/.test(verify),
     'a folder verification cannot be started over a running ingest');
  ok(verify.indexOf('S.copying') < verify.indexOf('browseFolder'),
     'and it refuses before opening the folder picker, not after');
}

// ── 5. The retry blocks sleep, like the ingest ──────────────────────────────
console.log('\na retry holds the machine awake');
{
  const fn = extractFn(REND, 'recopyFailed');
  ok(/setPowerBlock\(true\)/.test(fn), 'the retry blocks power save when it starts');
  ok(/setPowerBlock\(false\)/.test(fn), 'and releases it when it ends');
  ok(fn.indexOf('setPowerBlock(true)') < fn.indexOf('setPowerBlock(false)'),
     'in that order');
}

// ── 6. Buttons that are only an icon ────────────────────────────────────────
console.log('\nevery icon-only button has a name');
{
  // data-tip is read by the app's own tooltip and means nothing to VoiceOver.
  for (const id of ['fb-verify', 'fb-settings', 'fb-showhidden', 'refresh-btn']) {
    const tag = tagOf(REND, id);
    ok(/aria-label="[^"]+"/.test(tag), `#${id} is announced`);
  }
}

// ── 7. The 2.7.0 interface ──────────────────────────────────────────────────
console.log('\nduring an ingest the centre column shows the transfers, with no switch');
{
  // The volumes are hidden during a transfer and only then, so a button to
  // bring them back mid-run had nothing left to do.
  ok(!/id="tf-switch"/.test(REND), 'the transfers / volumes switch is gone');
  ok(!/id="tf-sw-t"|id="tf-sw-v"/.test(REND), 'and so are its two buttons');
  ok(!/setCenterView\('volumes'\)/.test(REND), 'nothing else can switch to the volumes mid-run');
  // Every place that used to reach for it must not do so any more: two of the
  // calls were unguarded, and would have thrown at the start of every ingest.
  ok(!/getElementById\('tf-switch'\)/.test(REND), 'no code still looks the switch up');
  ok(!/getElementById\('tf-sw-[tv]'\)/.test(REND), 'nor its buttons');
  ok(/setCenterView\('transfers'\)/.test(extractFn(REND, 'tfEnter')), 'an ingest still opens on the transfers');
  ok(/S\.centerView = 'volumes'/.test(extractFn(REND, 'tfExit')), 'and the volumes come back when it ends');
}

console.log('\nthe Done button of Settings stays in view');
{
  // Eight sections: the button sat at the very end, and closing Settings meant
  // scrolling all the way down first.
  ok(/#settings-ov \.mi-close\{position:sticky;bottom:0/.test(REND), 'it is pinned to the bottom of the window');
  ok(/#settings-ov \.mi-close\{[^}]*box-shadow:[^}]*var\(--card\)/.test(REND),
     'with a band of the card colour, so the text scrolling under it does not show through');
}

console.log('\nthe destinations carry the folders they will create');
{
  // The single "Destination Preview" box is gone: it answered "what am I about
  // to create, and where" for the first destination only.
  ok(!/id="tpl-preview"/.test(REND), 'the separate preview block is gone');
  ok(/function destFolderLines\(/.test(REND), 'each destination lists the folders of the batch');
  const fn = extractFn(REND, 'destFolderLines');
  ok(/all\.length > 3/.test(fn), 'past three cards it shows a count instead of every line');
  ok(/folderPathFromTemplate/.test(fn), 'and it resolves them with the same code as the engine preview');
  ok(/renderZoneList\('dst'\)/.test(extractFn(REND, 'updatePreview')),
     'a change of template or counter redraws them');
}

console.log('\nthe Insert menu replaces the fifteen chips');
{
  ok(!/class="tpl-chips"/.test(REND), 'the chip row is gone');
  ok(/function toggleInsertMenu\(/.test(REND) && /function insPick\(/.test(REND), 'the menu is there');
  const mStart = REND.indexOf('<div class="ins-menu"');
  const menu = REND.slice(mStart, REND.indexOf('<button class="tpl-slash"', mStart));
  for (const g of ['THE CARD', 'THE DATE', 'TYPED BY YOU', 'SEPARATORS'])
    ok(menu.includes(g), `the menu groups "${g}"`);
  ok(menu.indexOf('SEPARATORS') > menu.indexOf('TYPED BY YOU'),
     'the separators are their own group, after the custom text');
  ok(/insPick\('sep','_'\)/.test(menu) && /insPick\('sep','-'\)/.test(menu),
     'underscore and hyphen are two entries, not one line');
  ok(/insPick\('txt'\)/.test(menu), 'custom text is an entry of the same menu');
  const tog = extractFn(REND, 'toggleInsertMenu');
  ok(/removeEventListener/.test(tog), 'its click-away listener is removed when it closes');
  ok(/Escape/.test(tog), 'and Escape closes it');
  ok(/ondblclick="showRawTemplate\(\)"/.test(REND), 'a double-click on the strip switches to typing the template');
  ok(/function showRawTemplate\(/.test(REND) && /function hideRawTemplate\(/.test(REND),
     'and back again when the field loses focus');
}

console.log('\nEscape closes the window that only informs');
{
  ok(/ESC_CLOSERS/.test(REND), 'a single list holds the windows Escape may close');
  const blk = REND.slice(REND.indexOf('const ESC_CLOSERS'), REND.indexOf('function slotClick'));
  for (const id of ['settings-ov', 'modes-info-ov', 'counter-info-ov', 'dr-info-ov', 'pro-warn-ov'])
    ok(blk.includes(id), `${id} closes on Escape`);
  ok(!blk.includes("'sum-ov'") && !blk.includes("'pf-ov'"),
     'the summary and a refusal are left to their own buttons, they carry a decision');
}

console.log('\nwhere a value came from is said beside its label');
{
  ok(/MARK_A/.test(REND) && /MARK_M/.test(REND), 'two marks exist');
  ok(/#35c98b/.test(REND.slice(REND.indexOf('const MARK_A'), REND.indexOf('const MARK_M'))),
     'the detected one is green');
  ok(/#8b909b/.test(REND.slice(REND.indexOf('const MARK_M'), REND.indexOf('const MARK_M') + 500)),
     'the typed one is grey');
  const mk = extractFn(REND, 'srcMark');
  ok(/_forced/.test(mk), 'a field typed by hand loses the green mark');
  const mf = extractFn(REND, 'markForced');
  ok(!/renderSourceInfoCards/.test(mf),
     'and marking it does not redraw the list, which would take the caret out of the field');
}

console.log('\nthe written report opens on its figures');
{
  ok(/class="tiles"/.test(REND), 'the report has a tile row');
  ok(/const totalFiles=records\.reduce/.test(REND), 'files are counted over every record on the drive');
  ok(/const badCount=records\.filter/.test(REND), 'and so are the cards with errors');
  ok(/<td><span class="\$\{rCls\}">/.test(REND),
     'the result is a badge inside its cell, not the whole cell painted');
}

// ── 8. Spelling on screen ───────────────────────────────────────────────────
console.log('\nthe stats strip');
{
  ok(!/Datas Remaining/.test(REND), '"Datas Remaining" is gone');
  ok(/Data Remaining/.test(REND), 'and reads "Data Remaining", beside "Files Remaining"');
}

// ── 8bis. What the 2.7.0 review changed in the interface ────────────────────
console.log('\nthe window is closed to anything it does not carry itself');
{
  ok(/http-equiv="Content-Security-Policy"/.test(REND), 'a content security policy is declared');
  const csp = REND.slice(REND.indexOf('Content-Security-Policy'), REND.indexOf('Content-Security-Policy') + 420);
  ok(/default-src 'none'/.test(csp), "nothing loads by default");
  ok(/connect-src 'none'/.test(csp), 'the window never opens a connection: the network lives in the engine');
  ok(/object-src 'none'/.test(csp) && /frame-src 'none'/.test(csp), 'no plugin, no frame');
}

console.log('\nthe folder to reveal is cleaned before it leaves the window');
{
  const rend = extractFn(REND, 'renderSessionLog');
  ok(/seg !== '\.\.'/.test(rend), 'a ".." segment is dropped');
  ok(/split\('\/'\)/.test(rend) && /filter\(seg =>/.test(rend), 'only plain segments are kept');
  // The rule itself, on the values a hostile report could carry.
  const clean = (f) => String(f || '').replace(/\\/g, '/').split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..').join('/');
  ok(clean('../../payload.command') === 'payload.command', 'a climb out of the drive becomes a plain name');
  ok(clean('/etc/passwd') === 'etc/passwd', 'an absolute path becomes relative');
  ok(clean('001_A001_FX6') === '001_A001_FX6', 'an ordinary folder is untouched');
}

console.log('\nwhat the interface promises, it can do');
{
  const open = extractFn(REND, 'openReport');
  ok(/for\(const d of S\.dests\)/.test(open), 'Open the report tries every destination, not only the first');
  ok(/No report on these destinations yet/.test(open), 'and says so in the plural when none has one');

  const dfl = extractFn(REND, 'destFolderLines');
  ok(/if \(!S\.sources\.length\) return '';/.test(dfl),
     'a destination announces no folder while no card is loaded');
  ok(!/name: ?'A001'/.test(dfl) && !/name:'A001'/.test(dfl), 'the pretend card is gone');

  const auto = extractFn(REND, 'resetCounterOverride');
  ok(/if\(!S\.dests\.length\)/.test(auto) && /showToast/.test(auto),
     'Auto says why it cannot rescan when there is no destination');

  ok(/`Template \$\{_saveSlotIdx\+1\}`/.test(REND), 'the save dialog and the saved name agree on the word template');
  ok(!/`Memory \$\{/.test(REND), 'and "Memory" is gone from the interface');

  const slot = extractFn(REND, 'slotClick');
  ok(/promptSaveSlot\(i\)/.test(slot), 'clicking an empty slot offers to save into it');
  ok(/: 'Template ' \+ \(i \+ 1\);/.test(REND) && !/'Slot ' \+ \(i/.test(REND),
     'an empty entry is named like the one it will become');
  ok(/'Empty · click to save the current template here'/.test(REND), 'and its tooltip says what a click does');
  ok(/ingesting/.test(slot), 'except during an ingest');

  const rsl = extractFn(REND, 'renderSessionLog');
  ok(/hiddenN \? /.test(rsl) && /show again/.test(rsl),
     'a cleared history can be brought back even when the list is not empty');
}

console.log('\nthe keyboard reaches what the mouse reaches');
{
  ok(/class="mem-item [^"]*" role="button" tabindex="0"/.test(REND) || /role="button" tabindex="0"[^>]*mem-item/.test(REND) ||
     /mem-item[^>]*role="button"/.test(REND), 'a template slot is a button for the keyboard too');
  ok(/class="src-info-header" role="button" tabindex="0"/.test(REND), 'and so is the header of a loaded card');
  ok(/aria-expanded="\$\{isOpen \? 'true' : 'false'\}"/.test(REND), 'which announces whether it is open');
  const switches = [...REND.matchAll(/<label class="switch"><input type="checkbox"([^>]*)>/g)];
  const unnamed = switches.filter(m => !/aria-label="/.test(m[1]));
  ok(switches.length > 15 && unnamed.length === 0,
     `every switch is announced (${switches.length} switches, ${unnamed.length} without a name)`);
  for (const id of ['set-ntfy-server', 'set-ntfy-topic', 'set-hook', 'set-handoff'])
    ok(new RegExp(`<label for="${id}"`).test(REND), `the label of #${id} points at its field`);
  ok(/aria-label="Remove \$\{z==='src'\?'card':'destination'\}/.test(REND), 'the remove cross of a row is announced');
  ok(/class="sic-rm" aria-label="Remove card/.test(REND), 'and the one on a loaded card too');
}

console.log('\nthe skin repairs, measured in the running app');
{
  const fixes = REND.slice(REND.indexOf('Reparations, mesurees dans l app qui tourne'));
  ok(/\.drop-zone\{background:var\(--card\) !important;border:1\.5px dashed/.test(fixes),
     'the drop zone has a surface and its dashed outline again');
  ok(/input:focus-visible[^{]*\{[^}]*box-shadow:inset/.test(fixes),
     'a focused field shows where the caret is, which the skin had removed');
  ok(/\.pillbtn\.on[^{]*\{[^}]*rgba\(242,85,90,\.15\)/.test(fixes), 'an active filter pill is visibly active');
  ok(/\.tpl-box\{background:var\(--ins\)/.test(fixes), 'the token strip matches the field it turns into');
}

console.log('\nthe settings are written once per pause, and never lost');
{
  // Behaviour: ten keystrokes, one write; a flush writes what is pending, and
  // only once.
  let writes = 0; const timers = [];
  const ctx = vm.createContext({
    window: { addEventListener(){}, ingesto: {} }, document: { addEventListener(){} },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
  });
  const i = REND.indexOf('let _prefsTimer = null;');
  vm.runInContext(REND.slice(i, REND.indexOf('function persistPrefsNow(', i)) +
                  '\nfunction persistPrefsNow(){ __w(); }', Object.assign(ctx, { __w: () => writes++ }));
  for (let k = 0; k < 10; k++) ctx.persistPrefs();
  ok(writes === 0, 'nothing is written while the operator is typing');
  ctx.flushPrefs();
  ok(writes === 1, 'a flush writes what is pending, once');
  ctx.flushPrefs();
  ok(writes === 1, 'and a second flush has nothing left to write');
  const sc = extractFn(REND, 'startCopy');
  ok(/^\s*flushPrefs\(\);/m.test(sc.slice(sc.indexOf('{') + 1, sc.indexOf('{') + 200)),
     'START writes what was typed a moment ago before anything else');
  ok(/addEventListener\('beforeunload', flushPrefs\)/.test(REND), 'and so does closing the window');
}

// ── 9. The session log ──────────────────────────────────────────────────────
// Last, because it is the only asynchronous case: the log reads the report of
// each destination before it can say anything.
(async () => {

console.log('\nthe session log is read back from the drives, not kept in memory');
{
  const src = extractFn(REND, 'refreshSessionLog');
  ok(/window\.ingesto\.reportRead/.test(src), 'it reads the report written on each destination');
  ok(!/S\.sessionLog/.test(REND), 'nothing is accumulated in memory beside it');

  // Behaviour: the same card written to two drives is ONE line naming both,
  // and a failure on either drive wins over an OK on the other.
  let captured = null;
  const REPORTS = {
    '/Volumes/SHUTTLE_1': { records: [
      { n:'001', card:'A001', folder:'001_A001', bytes:10, rclass:'r-ok' },
      { n:'002', card:'B002', folder:'002_B002', bytes:20, rclass:'r-ok' },
    ]},
    '/Volumes/NAS': { records: [
      { n:'001', card:'A001', folder:'001_A001', bytes:10, rclass:'r-ok' },
      { n:'002', card:'B002', folder:'002_B002', bytes:20, rclass:'r-err' },
    ]},
  };
  const ctx = vm.createContext({
    S: { dests: [{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }, { path:'/Volumes/NAS', name:'NAS' }] },
    window: { ingesto: { reportRead: async (p) => REPORTS[p] || null } },
    document: { getElementById: () => ({ style:{}, textContent:'', innerHTML:'', querySelectorAll: () => [] }) },
    renderSessionLog: (rows) => { captured = rows; },
    Map, Set, Array, String, Number, Promise, console,
  });
  vm.runInContext('let _sessBusy=false,_sessAgain=false,_sessRows=[];', ctx);
  vm.runInContext(extractFn(REND, 'historyKey'), ctx);
  vm.runInContext(src, ctx);

  await ctx.refreshSessionLog();
  ok(captured && captured.length === 2,
     `two drives, two cards, two lines (${captured ? captured.length : 0})`);
  const a  = captured && captured.find(r => r.rec.card === 'A001');
  const bb = captured && captured.find(r => r.rec.card === 'B002');
  ok(a && a.drives.length === 2, 'a card written to both drives names both');
  ok(bb && bb.rec.rclass === 'r-err',
     'a card that failed on ONE destination reads as failed, not as OK');
  ok(captured && captured[0].rec.n === '002', 'the newest card is at the top');

  // A refresh asked for while one is running is remembered, not dropped:
  // dropping two destinations in quick succession used to leave the log
  // describing only the first.
  // Behaviour, not spelling: a second destination dropped WHILE the first read
  // is in flight must end up in the log. The refresh that arrives during a read
  // used to be dropped, and the log then described one drive out of two.
  {
    let slow = true;
    const ctx2 = vm.createContext({
      S: { dests: [{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }] },
      window: { ingesto: { reportRead: async (p) => {
        if (slow) await new Promise(r => setTimeout(r, 30));
        return REPORTS[p] || null;
      } } },
      document: { getElementById: () => ({ style:{}, textContent:'', innerHTML:'', querySelectorAll: () => [] }) },
      renderSessionLog: (rows) => { captured = rows; },
      Map, Set, Array, String, Number, Promise, console, setTimeout,
    });
    vm.runInContext('let _sessBusy=false,_sessAgain=false,_sessRows=[];', ctx2);
    vm.runInContext(extractFn(REND, 'historyKey'), ctx2);
    vm.runInContext(src, ctx2);

    captured = null;
    const first = ctx2.refreshSessionLog();          // starts reading, slowly
    ctx2.S.dests.push({ path:'/Volumes/NAS', name:'NAS' });   // a drive is dropped meanwhile
    slow = false;
    await ctx2.refreshSessionLog();                  // asked during the read
    await first;
    await new Promise(r => setTimeout(r, 60));       // let the queued run finish
    const a2 = captured && captured.find(r => r.rec.card === 'A001');
    ok(a2 && a2.drives.length === 2,
       `a destination added during a read still reaches the log (${a2 ? a2.drives.length : 0} drive(s))`);
  }

  const rend = extractFn(REND, 'renderSessionLog');
  ok(/addEventListener\('click'/.test(rend) && !/onclick="[^"]*revealPath/.test(REND),
     'the folder to reveal is bound in a closure, never written into an onclick');
  ok(/updateReports\(R, reportBase, S\.run\)\.then\(\(\)=>refreshSessionLog\(\)\)/.test(REND),
     'it is refreshed after the reports are written, not before');
}

console.log('\nthe ingest history can be cleared, and nothing on a drive is erased');
{
  // It is called a history, not a session: it is read from the reports on the
  // drives and survives a restart.
  ok(/<span class="sess-lbl">INGEST HISTORY<\/span>/.test(REND), 'the card is titled INGEST HISTORY');
  ok(!/THIS SESSION/.test(REND), 'and no longer claims to be the current session');
  const btn = tagOf(REND, 'sess-clear');
  ok(/aria-label="[^"]+"/.test(btn), 'the clear button is announced');
  ok(REND.includes('m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6'), 'with the lucide eraser icon');

  // Behaviour. The API stub records every call: clearing may READ reports, it
  // must never write, rename or delete one.
  const calls = [];
  let shown = null, saved = null;
  const REP = { '/Volumes/SHUTTLE_1': { records: [
    { n:'001', card:'A001', date:'20.09 21:48', folder:'001_A001', bytes:10, rclass:'r-ok' },
    { n:'002', card:'B002', date:'20.09 22:05', folder:'002_B002', bytes:20, rclass:'r-ok' },
  ]}};
  const api = new Proxy({}, { get: (_, k) => async (...a) => { calls.push(String(k)); return k === 'reportRead' ? REP[a[0]] : null; } });
  const ctx3 = vm.createContext({
    S: { dests: [{ path:'/Volumes/SHUTTLE_1', name:'SHUTTLE_1' }], historyHidden: [], historyClearedAt: '' },
    window: { ingesto: api },
    document: { getElementById: () => ({ style:{}, textContent:'', innerHTML:'', disabled:false, querySelectorAll: () => [] }) },
    renderSessionLog: (rows) => { shown = rows; },
    persistPrefs: () => { saved = { hidden: ctx3.S.historyHidden.slice(), at: ctx3.S.historyClearedAt }; },
    confirm: () => true,
    Map, Set, Array, String, Number, Promise, Date, console,
  });
  vm.runInContext('let _sessBusy=false,_sessAgain=false,_sessRows=[];', ctx3);
  for (const f of ['historyKey', 'refreshSessionLog', 'clearIngestHistory', 'restoreIngestHistory'])
    vm.runInContext(extractFn(REND, f), ctx3);
  const settle = () => new Promise(r => setTimeout(r, 20));

  await ctx3.refreshSessionLog();
  ok(shown && shown.length === 2, 'before clearing, the two cards are listed');
  ctx3.clearIngestHistory(); await settle();
  ok(shown && shown.length === 0, 'after clearing, none is listed');
  ok(saved && saved.hidden.length === 2 && saved.at, 'what was hidden is saved, so it stays cleared after a restart');
  ok(calls.every(c => c === 'reportRead'), `only reports were READ, nothing written or deleted (${[...new Set(calls)].join(', ')})`);

  // A card ingested after the clear shows up.
  REP['/Volumes/SHUTTLE_1'].records.push({ n:'003', card:'C003', date:'21.09 09:10', folder:'003_C003', bytes:5, rclass:'r-ok' });
  await ctx3.refreshSessionLog();
  ok(shown && shown.length === 1 && shown[0].rec.card === 'C003', 'a card ingested after the clear appears');

  // A counter and a card name reused on another shoot are another line.
  ok(ctx3.historyKey({ n:'001', card:'A001', date:'20.09 21:48' }) !== ctx3.historyKey({ n:'001', card:'A001', date:'05.10 08:02' }),
     'the same number and card name on another day is not hidden');

  // And it can be undone.
  ctx3.restoreIngestHistory(); await settle();
  ok(shown && shown.length === 3, 'Show it again brings every line back');

  // Declining the confirmation changes nothing.
  ctx3.clearIngestHistory(); await settle();
  const before = ctx3.S.historyHidden.length;
  ctx3.confirm = () => false;
  vm.runInContext('confirm = () => false;', ctx3);
  ctx3.restoreIngestHistory(); await settle();
  ctx3.clearIngestHistory(); await settle();
  ok(ctx3.S.historyHidden.length === 0 && before === 3, 'declining the confirmation hides nothing');

  // What comes back from the preferences file is checked: it can be edited by
  // hand, or arrive in an imported settings file.
  const load = REND.slice(REND.indexOf('S.historyHidden = Array.isArray(prefs.historyHidden)'),
                          REND.indexOf('S.historyHidden = Array.isArray(prefs.historyHidden)') + 220);
  ok(/typeof k === 'string'/.test(load) && /slice\(-5000\)/.test(load),
     'only strings are read back from the preferences, and at most 5000');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
