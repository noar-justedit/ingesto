// ═══════════════════════════════════════════════════════
// Settings: one table for saving, loading, exporting and importing
// ═══════════════════════════════════════════════════════
// Every setting kept between launches is listed once in SETTINGS. The same
// entry decides how it is written to the preferences file, how it is read
// back at launch, and, for those that travel, how it goes into and comes out
// of an exported settings file.
//
// The rule for reading, at launch and at import alike: a value that is
// missing, or not of the expected kind, takes the default of ingesto, the
// value of a first installation (the S literal in state.js). An old or damaged
// file therefore gives a fresh ingesto on that point, never a value that was
// guessed.
//
// An entry:
//   key      the field of S, and its name in the files
//   cat      the export category it belongs to (the switches of the export
//            panel); null for a setting of this computer that never travels
//   valid    (value) => true when the value read from a file can be used
//   read     (value, ctx) => what goes into S, for a valid value (default: as is)
//   write    (value) => what goes into the file (default: as is)
//   file     the name in the preferences file when it differs from key
//   legacy   (prefs) => the value to use when an old preferences file has no
//            such field but said the same thing another way
const isBool  = v => typeof v === 'boolean';
const isText  = v => typeof v === 'string';
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

const SETTINGS = [
  // The naming template, and the width of its counter.
  { key:'tokens', cat:'namingTemplate', file:'lastTemplate',
    valid: v => Array.isArray(v) && v.length > 0,
    read: (v, ctx) => { tokId = 200; return tokensFromStored(v, ctx.legacy); },
    write: v => v.map(t => ({ type:t.type, key:t.key })) },
  { key:'counterWidth', cat:'namingTemplate',
    valid: v => prefsCounterWidth({ counterWidth: v }) !== null,
    read: v => prefsCounterWidth({ counterWidth: v }) },
  { key:'presets', cat:'namingPresets',
    valid: Array.isArray,
    read: (v, ctx) => normPresets(v, ctx.legacy) },
  // The copy mode.
  { key:'mode', cat:'copyMode', valid: v => MODES.includes(v) },
  { key:'proAlgo', cat:'copyMode', valid: v => ['xxh64','xxh128','md5'].includes(v) },
  { key:'proDoubleRead', cat:'copyMode', valid: isBool },
  // Card tracking.
  { key:'writeSentinel', cat:'cardTracking', valid: isBool },
  // Checksum lists and manifests.
  { key:'writeChecksum', cat:'writeChecksum', valid: isBool },
  { key:'cksumList', cat:'writeChecksum', valid: isBool },
  { key:'cksumMhl', cat:'writeChecksum', valid: isBool },
  { key:'ascMhl', cat:'writeChecksum', valid: isBool },
  // The ingest report.
  { key:'writeReport', cat:'ingestReport', valid: isBool },
  { key:'reportHtml', cat:'ingestReport', valid: isBool },
  { key:'reportCsv', cat:'ingestReport', valid: isBool },
  { key:'reportJson', cat:'ingestReport', valid: isBool },
  { key:'reportFull', cat:'ingestReport', valid: isBool },
  // The file filter. Its main switch is never saved: it is off at each launch.
  // A format added to ingesto after the file was written gets its category's
  // default (every format is copied, OTHERS excepted).
  { key:'fileFilterFormats', cat:'fileFilter', valid: isPlainObject,
    read: v => {
      const out = Object.assign({}, v);
      for (const [cat, def] of Object.entries(FILTER_CATS))
        for (const e of def.exts) if (!(e in out)) out[e] = (cat !== 'OTHERS');
      return out;
    } },
  { key:'copyEmptyFolders', cat:'fileFilter', valid: isBool },
  { key:'reorganizeFiles', cat:'fileFilter', valid: isBool },
  // Settings of this computer, never exported.
  { key:'proWarnDismissed', cat:null, valid: isBool },
  { key:'historyHidden', cat:null, valid: Array.isArray,
    // Only strings, capped: the file can be edited by hand or imported.
    read: v => v.filter(k => typeof k === 'string').slice(-5000) },
  { key:'historyClearedAt', cat:null, valid: isText },
  { key:'updateDismissedVersion', cat:null, valid: isText },
  { key:'noteMode', cat:null, valid: v => v === 'md' || v === 'rich' },
  { key:'activePreset', cat:null, valid: v => Number.isInteger(v) && v >= -1 && v < 4 },
  { key:'ntfyEnabled', cat:null, valid: isBool },
  { key:'ntfyServer', cat:null, valid: v => isText(v) && v.trim() !== '' },
  { key:'ntfyTopic', cat:null, valid: isText },
  // A preferences file from before the switch existed holds only the command:
  // a command that was typed meant a command that runs.
  { key:'hookEnabled', cat:null, valid: isBool,
    legacy: p => (isText(p.hookCommand) && p.hookCommand.trim()) ? true : undefined },
  { key:'hookCommand', cat:null, valid: isText },
  { key:'handoffEnabled', cat:null, valid: isBool },
  { key:'handoffCommand', cat:null, valid: isText },
  { key:'exportInclude', cat:null, valid: isPlainObject },
];

// The default of each setting: S as state.js creates it, before anything is
// read. Copied, so that a setting changed later never changes its default.
const SETTING_DEFAULTS = (() => {
  const out = {};
  for (const def of SETTINGS) out[def.key] = structuredClone(S[def.key]);
  return out;
})();

// Puts into S the settings found in `data`, a preferences file or an exported
// settings file. `from` says which ('prefs' or 'export': the template is
// stored as lastTemplate in one and tokens in the other). `cats`, for an
// import, lists the categories the file carries: the others are not touched.
// `legacy`: the file predates tplVersion (see tokensFromStored).
function applySettings(data, { from, cats, legacy }) {
  const src = (data && typeof data === 'object') ? data : {};
  for (const def of SETTINGS) {
    if (from === 'export' && !(def.cat && cats && cats[def.cat])) continue;
    const name = (from === 'prefs' && def.file) ? def.file : def.key;
    let v = src[name];
    if (v === undefined && from === 'prefs' && def.legacy) v = def.legacy(src);
    S[def.key] = (v !== undefined && def.valid(v))
      ? (def.read ? def.read(v, { legacy: !!legacy }) : v)
      : structuredClone(SETTING_DEFAULTS[def.key]);
  }
}

// The settings, as written to a file. For an export, only the categories
// switched on in `cats`; the preferences file gets them all.
function settingsForFile({ to, cats }) {
  const out = {};
  for (const def of SETTINGS) {
    if (to === 'export' && !(def.cat && cats && cats[def.cat])) continue;
    const name = (to === 'prefs' && def.file) ? def.file : def.key;
    out[name] = def.write ? def.write(S[def.key]) : S[def.key];
  }
  return out;
}

// Shows the settings held in S on every control of the window, after a launch
// or an import.
function showSettings() {
  setMode(S.mode, false);
  setProAlgo(S.proAlgo, false);
  { const cb = document.getElementById('pro-dr-toggle');
    if (cb) { cb.checked = S.proDoubleRead; cb.closest('.pa-item')?.classList.toggle('on', S.proDoubleRead); } }
  { const sw = document.getElementById('sentinel-toggle'); if (sw) sw.checked = S.writeSentinel; }
  const check = (id, on) => { const el = document.getElementById(id); if (el) el.checked = on; };
  check('report-toggle', S.writeReport);
  check('rf-html', S.reportHtml); check('rf-csv', S.reportCsv);
  check('rf-json', S.reportJson); check('rf-full', S.reportFull);
  updateReportDetailNote();
  check('cksum-toggle', S.writeChecksum);
  check('cf-list', S.cksumList); check('cf-mhl', S.cksumMhl); check('cf-ascmhl', S.ascMhl);
  // A master switch with no format under it is shown off (see initMaster).
  initMaster('report-toggle', (S.reportHtml||S.reportCsv||S.reportJson), v=>S.writeReport=v, ()=>S.writeReport);
  initMaster('cksum-toggle', (S.cksumList||S.cksumMhl||S.ascMhl), v=>S.writeChecksum=v, ()=>S.writeChecksum);
  check('set-ntfy-en', S.ntfyEnabled);
  { const sv = document.getElementById('set-ntfy-server'); if (sv) sv.value = S.ntfyServer;
    const tp = document.getElementById('set-ntfy-topic'); if (tp) tp.value = S.ntfyTopic; }
  { const hf = document.getElementById('set-handoff'); if (hf) hf.value = S.handoffCommand; }
  check('set-handoff-en', S.handoffEnabled);
  { const hk = document.getElementById('set-hook'); if (hk) hk.value = S.hookCommand; }
  check('set-hook-en', S.hookEnabled);
  if (S.exportInclude) for (const [id, key] of Object.entries(EXPORT_INC))
    if (typeof S.exportInclude[key] === 'boolean') check(id, S.exportInclude[key]);
  renderCounterWidth();
  if (S.fileFilter && S.fileFilterFormats) renderFilterList();
  updateSettingsDetails();
}
