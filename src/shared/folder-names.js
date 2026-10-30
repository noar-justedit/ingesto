// Folder names: the one place where a card's destination path is decided.
//
// Shared by the engine (src/main/engine.js and its modules, through require)
// and the window (src/renderer/index.html, through a <script> tag, as
// window.IngestoShared):
// the preview, the pre-flight and the engine resolve a template with the same
// code, so what the window shows is what the engine creates.
//
// Plain JavaScript, no Node or browser API: the platform is passed in where it
// matters (isSafeFolderName).
(function (root) {
'use strict';

// Accents and joined letters to plain letters ("Hélène" gives "Helene",
// "Œuvre" gives "OEuvre"). Used by the 'ascii' folder-name rule.
function asciiFold(x) {
  return String(x == null ? '' : x).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[œŒæÆßøØđĐłŁþÞð]/g, c => ({'œ':'oe','Œ':'OE','æ':'ae','Æ':'AE','ß':'ss','ø':'o','Ø':'O','đ':'d','Đ':'D','ł':'l','Ł':'L','þ':'th','Þ':'TH','ð':'d'})[c]);
}

// A destination folder name must be exactly one usable path segment. Anything
// else (empty, ".", "..", a name containing a separator) means the template is
// broken and the ingest would land somewhere the user did not choose.
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are device names on Windows: mkdir fails.
// A Windows card reaches the template under its real label, so these names can
// turn up: a card labelled AUX would fail in the MIDDLE of an ingest instead of
// being refused before it started. Windows only — the name is perfectly legal
// on macOS and Linux, and refusing it there would be a false refusal.
const WIN_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function isSafeFolderName(name, platform) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[\/\\]/.test(n)) return false;
  if (platform === 'win32' && WIN_DEVICE_NAME.test(n)) return false;
  if (n.length > 200) return false;   // stay clear of ENAMETOOLONG
  return true;
}

// Substitute the template's variables. No cleanup here: the caller cleans each
// destination segment separately, because a "/" in the template means "new
// subfolder" and the two sides of it are two independent folder names.
// `now` is passed in wherever the same template is resolved twice for one
// card (the path and, separately, its last level): two calls a millisecond
// apart could otherwise disagree on {SS}, and a guard would then validate a
// name other than the one written.
function resolveTemplateVars(tpl, src, now) {
  const n=now||new Date(), p=x=>String(x).padStart(2,'0');
  // A "/" creates a subfolder — but only when it is in the TEMPLATE, which the
  // operator wrote. A separator arriving inside a VALUE (a card labelled
  // "A/B", an operator typing "Jean/Marc") would silently add a level the
  // template never asked for, and push the counter out of the card's own
  // folder. Values are flattened before substitution.
  // Folder-name rule, chosen by the interface with each card:
  // 'ascii' (English, French) turns accents into plain letters and drops
  // anything else that is not a letter, a digit, "_" or "-"; 'unicode'
  // (Chinese, and any caller that says nothing) keeps the value as typed.
  const rule = src.nameRule === 'ascii' ? 'ascii' : 'unicode';
  const fold = x => asciiFold(x).replace(/[^A-Za-z0-9_\-]/g, '');
  const v = x => { const f = String(x == null ? '' : x).replace(/[\/\\]/g, '_'); return rule === 'ascii' ? fold(f) : f; };
  // For optional fields (cameraman, camera, pp): replace with empty string if
  // not set so we can clean up orphan separators after
  const cameraman = v((src.cameraman||'').trim());
  const camera    = v((src.camera   ||'').trim());
  // The picture profile the camera was set to (SLOG3, DLOG2, CLOG, HLG...).
  // Optional, flattened and allowed to resolve to nothing, like the camera
  // model, plus one rule of its own: letters and digits only, in capitals.
  // A profile is an acronym everybody spells differently, and two spellings
  // mean two folders for one thing on the same shoot.
  //
  // The interface applies the same rule as the operator types, and again on the
  // way here. It is applied a third time at this point because this is the last
  // line before a folder is created: a value that reached the engine by another
  // door does not get to put a lower-case folder on a drive.
  const pp        = v((src.pp       ||'').trim()).replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  return String(tpl == null ? '' : tpl)
    .replaceAll('{counter}',   v(src.counter)       || '001')
    .replaceAll('{cardname}',  v(src.name)          || 'CARD')
    .replaceAll('{operator}',  cameraman)   // canonical name
    .replaceAll('{cameraman}', cameraman)   // legacy alias — keeps old saved templates working
    .replaceAll('{camera}',    camera)
    .replaceAll('{pp}',        pp)
    // {YYYY} is listed before {YY} for the reader only: "{YY}" is not a
    // substring of "{YYYY}" — there is no closing brace after the second Y — so
    // the two substitutions cannot interfere whatever their order.
    // (A lone brace in a comment inside this function would also break the
    // brace-matching the test suites use to extract it. Keep them paired.)
    .replaceAll('{YYYY}', String(n.getFullYear()))
    .replaceAll('{YY}',  String(n.getFullYear()).slice(-2))
    .replaceAll('{MM}',  p(n.getMonth()+1))
    .replaceAll('{DD}',  p(n.getDate()))
    .replaceAll('{HH}',  p(n.getHours()))
    .replaceAll('{MIN}', p(n.getMinutes()))
    .replaceAll('{SS}',  p(n.getSeconds()));
}

// One destination segment: the cleanup applied to every folder name.
// "/" is NOT mapped here — it is the separator, removed by the
// split above this function.
function cleanSegment(seg) {
  return String(seg == null ? '' : seg)
    // Clean up orphan separators left by empty variables:
    // e.g. "001__card___260503" → "001_card_260503"
    .replace(/[_\-]+/g, m => m[0]) // collapse repeated separators to one
    .replace(/^[_\-]+|[_\-]+$/g, '') // trim leading/trailing separators
    // Remove illegal filesystem chars
    .replace(/[<>:"|?*\\]/g,'_')
    // Windows drops trailing dots and spaces from a directory name, so a
    // segment ending in one is not the folder we think we are creating.
    .replace(/[. ]+$/, '');
}

// The destination path of a card, as a list of folders to create under the
// destination root. A "/" in the template starts a subfolder:
//   "DAY1/{camera}/{counter}_{operator}"  →  ["DAY1", "A_CAM", "001_noar"]
// A segment that resolves to nothing (a card with no camera) creates NO folder
// rather than an unnamed one — the level simply disappears for that card.
function buildFolderSegments(tpl, src, now) {
  return resolveTemplateVars(tpl, src, now).split('/').map(cleanSegment).filter(Boolean);
}

// The card's OWN folder — the last segment. This is what the counter names and
// what "one folder per card" refers to.
function buildFolderName(tpl, src, now) {
  const segs = buildFolderSegments(tpl, src, now);
  return segs.length ? segs[segs.length - 1] : '';
}

// The subfolder levels a template asks for, template-side (before variables are
// resolved). Used by the guards: the counter must live in the card's folder.
//
// A "/" at either end names no level — "{counter}_{cardname}/" is the same
// template as "{counter}_{cardname}". Without this trim the preview would show
// a perfectly good path while the pre-flight refused the ingest with "the
// counter is in a subfolder level", pointing at a level that does not exist.
function templateSegments(tpl) {
  const segs = String(tpl == null ? '' : tpl).split('/');
  while (segs.length && segs[0] === '') segs.shift();
  while (segs.length && segs[segs.length - 1] === '') segs.pop();
  return segs.length ? segs : [''];
}

// The template of the card's OWN folder — the part after the last "/".
function templateLeaf(tpl) {
  const segs = templateSegments(tpl);
  return segs[segs.length - 1];
}
const MAX_FOLDER_DEPTH = 4;

// The variables whose value comes from the CLOCK. Each contributes a fixed
// number of digits to a folder name, which is what lets a pattern know where the
// counter starts — and, below, what makes a whole level predictable.
// One list, used by both: a token added here and forgotten there is the failure
// the round-trip test in scripts/test-template-parity.js exists to catch.
const CLOCK_TOKENS = { '{YYYY}':'\\d{4}', '{YY}':'\\d{2}', '{MM}':'\\d{2}', '{DD}':'\\d{2}', '{HH}':'\\d{2}', '{MIN}':'\\d{2}', '{SS}':'\\d{2}' };

// Build a matcher that extracts the counter from a folder name, given the SAME
// template used to create the folders. Reading only leading digits would see a
// counter only when it is the FIRST thing in the name, so moving {counter}
// behind the date (which the UI actively invites) would make every scan return
// 001 and the collision check blind, silently overwriting earlier reels.
//
// Returns { extract(name) -> number|null }. Falls back to "leading digits" when
// no template (or no {counter} token) is available.
function makeCounterMatcher(tpl) {
  const leading = name => { const m = String(name).match(/^(\d{1,4})(?:[_\-]|$)/); return m ? parseInt(m[1],10) : null; };
  // Only the LAST segment of the template names a card folder; the levels
  // before it are subfolders (DAY1, A_CAM) and never carry a counter.
  if (tpl && typeof tpl === 'string' && tpl.includes('/')) tpl = templateSegments(tpl).pop();
  if (!tpl || typeof tpl !== 'string' || !tpl.includes('{counter}')) return { extract: leading };

  // A date token contributes a FIXED number of digits to the folder name, so
  // the pattern knows exactly where the counter starts. {YYYY} is four of
  // them: without this entry it would fall through to the literal branch and
  // the whole pattern would stop matching — the scan would then find no card
  // at all, restart the counter at 001, and the folder guard would be the
  // only thing left between an ingest and an existing reel.
  const FIXED = CLOCK_TOKENS;
  // {operator} is the canonical name; {cameraman} the legacy alias. BOTH must be
  // here: a token missing from this set falls through to the literal branch and
  // the counter scan then never matches any folder, bringing back the
  // counter-reset/overwrite failure this matcher exists to prevent.
  const VAR   = new Set(['{cardname}','{cameraman}','{operator}','{camera}','{pp}']);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Tokenize the template into {token} pieces and literal runs, then rebuild it
  // as a regex: {counter} → capture, date tokens → fixed digits, free-text
  // tokens → non-greedy any, literals → escaped.
  //
  // CRITICAL: buildFolderName post-processes the substituted name — illegal
  // filesystem chars become "_", separator runs collapse to one, and leading/
  // trailing separators get trimmed (an empty {operator} does exactly that).
  // The regex must mirror ALL of it: template "{counter}_{operator}" with an
  // empty operator creates folder "001", and a pattern demanding the literal
  // "_" would never match it — the scan would return next=001 forever and the
  // overwrite this matcher exists to prevent would come straight back. Literal
  // separator runs therefore become "[_-]*" (flexible, absorbable), after the
  // same illegal-char mapping the engine applies.
  //
  // The counter is anchored on a SEPARATOR BOUNDARY wherever the template puts
  // one there. Without it the digits float: the pattern for
  // "{counter}_{cardname}" would read "1080p_proxies" as counter 1080 and
  // "260902" (a {YY}{MM}{DD} subfolder level) as 2609, and since the counter
  // scan walks the subfolder levels too, the most natural template of all,
  // "{YY}{MM}{DD}/{counter}_{cardname}", would answer next=2610 on day two.
  // The pattern for "{camera}_{counter}_{cardname}" would be worse: the
  // free-text ".*?" stops inside the camera name, so "FX3_001_A001" would read
  // as counter 3: the counter would freeze and the collision check go blind.
  // The anchor is added ONLY where the template itself has that boundary, so a
  // template that glues the counter to something else ("{cardname}{counter}")
  // keeps a looser pattern: over-reading a folder is annoying, MISSING a
  // real card is what overwrites footage.
  const endSep = s => /[_\-]$/.test(String(s));
  const begSep = s => /^[_\-]/.test(String(s));
  let re = '^';
  const parts = tpl.split(/(\{[a-zA-Z]+\})/).filter(s => s !== '');
  // cleanSegment drops the dots and spaces at the END of a folder name (a name
  // Windows refuses, and the Finder hides). The pattern has to drop them too:
  // a template written "{counter}_{cardname}." creates "001_A001" on the drive
  // and, matched against "001_A001\.$", the scan would find no card at all,
  // answer next=001 for ever, and every later ingest would be refused by the
  // "folder already exists" guard with nothing explaining why.
  for (let k = parts.length - 1; k >= 0; k--) {
    const last = parts[k];
    if (last === '{counter}' || FIXED[last] || VAR.has(last)) break;   // a value can end in anything
    const trimmed = String(last).replace(/[. ]+$/, '');
    if (trimmed === last) break;
    if (trimmed) { parts[k] = trimmed; break; }
    parts.pop();                                                        // the whole run was dots and spaces
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '{counter}') {
      const prev = parts[i - 1], next = parts[i + 1];
      // "^|" keeps the empty-value case working: "{camera}_{counter}" with no
      // camera creates the folder "001", where the separator is gone.
      const before = (i === 0 || (prev !== undefined && !FIXED[prev] && !VAR.has(prev) && endSep(prev)))
                     ? '(?:^|(?<=[_\\-]))' : '';
      const after  = (i === parts.length - 1 || (next !== undefined && !FIXED[next] && !VAR.has(next) && begSep(next)))
                     ? '(?=[_\\-]|$)' : '';
      re += before + '(\\d{1,4})' + after;
    }
    else if (FIXED[p]) re += FIXED[p];
    else if (VAR.has(p)) re += '.*?';
    else re += esc(p.replace(/[<>:"|?*\/\\]/g, '_')).replace(/[_\-]+/g, '[_\\-]*');
  }
  re += '$';
  let rx = null; try { rx = new RegExp(re); } catch(_) { rx = null; }
  return { extract: name => {
    if (rx) { const m = String(name).match(rx); if (m && m[1] != null) return parseInt(m[1],10); return null; }
    return leading(name);
  }};
}

// How deep the cards of THIS template sit. A level that resolves to nothing
// for a given card makes it shallower, never deeper.
function templateDepth(tpl) {
  return Math.min(MAX_FOLDER_DEPTH, Math.max(1, templateSegments(tpl).length));
}
// A SUBFOLDER level built only from the clock, fixed text and separators is the
// same folder for every card of that moment: it is structure, not a card. This
// builds one pattern per such level, so the walk can recognise those folders by
// NAME wherever they turn up.
//
// Why by name and not by depth: a level that resolves to nothing creates no
// folder, so the card moves UP — and the levels that vanish are not necessarily
// the ones nearest the card. "{camera}/{YYYY}{MM}{DD}/{counter}_{cardname}"
// with no camera writes the card at "20260907/001_A001", two levels up from
// where the template puts it. A depth floor gets that wrong and stops seeing
// the card at all; a name does not move.
//
// The pattern is built exactly as makeCounterMatcher builds the card pattern, so
// the two agree on what a level looks like. A level containing a variable the
// OPERATOR fills in — {cardname}, {operator}, {camera} — gets no pattern at all:
// it could be anything, and a pattern that matches anything would hide real
// cards. Those levels keep the permissive behaviour, where a subfolder that
// looks like a card only ever pushes the counter forward.
//
// The card's own level (the last one) never gets a pattern: that is the level we
// are looking for.
//
// Known gap, in the safe direction only: a level ending in a dot or a space
// ("{YYYY}." ) builds a pattern for the name with it, while cleanSegment strips
// the character before creating the folder. The level is then not recognised and
// is counted as a card: an over-count, never a miss.
function structuralLevelPatterns(tpl) {
  const segs = templateSegments(tpl);
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const parts = String(segs[i]).split(/(\{[a-zA-Z]+\})/).filter(x => x !== '');
    if (!parts.length) continue;
    let re = '^', clockOnly = true;
    for (const p of parts) {
      if (CLOCK_TOKENS[p]) { re += CLOCK_TOKENS[p]; continue; }
      if (/^\{[a-zA-Z]+\}$/.test(p)) { clockOnly = false; break; }   // an operator-filled variable
      re += esc(p.replace(/[<>:"|?*\/\\]/g, '_')).replace(/[_\-]+/g, '[_\\-]*');
    }
    if (!clockOnly) continue;
    try { out.push(new RegExp(re + '$')); } catch (_) {}
  }
  return out;
}

const api = { asciiFold, WIN_DEVICE_NAME, isSafeFolderName, resolveTemplateVars, cleanSegment,
  buildFolderSegments, buildFolderName, templateSegments, templateLeaf, MAX_FOLDER_DEPTH, CLOCK_TOKENS,
  makeCounterMatcher, templateDepth, structuralLevelPatterns };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.IngestoShared = Object.assign(root.IngestoShared || {}, api);
})(typeof window !== 'undefined' ? window : this);
