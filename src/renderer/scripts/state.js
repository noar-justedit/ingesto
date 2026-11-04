// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════
// The four copy modes. Anything else is not a mode, wherever it came from.
const { MODE, MODES, modeVerifiesContents } = window.IngestoShared;

// Clamped to what the folder scan can read back. The scanner captures at most
// four digits, so a folder numbered 10000 is invisible to it AND to the guard
// that refuses to write over an existing reel: the counter would restart and
// the next card would land on an earlier one. With a four-digit width on offer,
// that number is easy to reach by holding the + button.
const COUNTER_MAX = 9999;

// How many digits the counter is written with. A MINIMUM, never a maximum:
// with two digits, 99 is followed by 100. It never truncates and never wraps,
// which would put two reels in the same folder.
const COUNTER_WIDTHS = [2,3,4];
function prefsCounterWidth(prefs){
  const raw = prefs && prefs.counterWidth;
  // The type first, as for the counter itself: Number([3]) is 3, and a width
  // that arrived as an array is not a width, whatever it coerces to.
  if(typeof raw !== 'number' && typeof raw !== 'string') return null;
  const w = Number(raw);
  return COUNTER_WIDTHS.includes(w) ? w : null;
}
// `width` is passed explicitly by everything that runs AFTER an ingest (the
// report, the phone notification): those describe folders that already exist,
// and must use the width the run was started with, not whatever the setting
// says by then.
function padCounter(n, width){
  const w = COUNTER_WIDTHS.includes(width) ? width
          : (COUNTER_WIDTHS.includes(S.counterWidth) ? S.counterWidth : 3);
  return String(n).padStart(w,'0');
}

// The preferences file is a file on disk. ingesto writes it, and it is also
// editable by anyone, syncable by anything, and truncatable by a power cut.
// Everything read out of it is checked before it becomes state.
//
// The counter is a number the folder name is built from. Unchecked, a string, a
// NaN or a zero would go into S.counter and into every folder ingesto creates.
function prefsCounter(prefs){
  const raw = prefs && prefs.counter;
  // The type first: Number([4]) is 4, and a counter that arrived as an array
  // is not a counter, whatever it coerces to.
  if(typeof raw !== 'number' && typeof raw !== 'string') return null;
  const c = Number(raw);
  // Same ceiling as the buttons: past four digits the folder scan can no
  // longer read the number back, and the collision guard goes blind with it.
  return (Number.isInteger(c) && c >= 1 && c <= COUNTER_MAX) ? c : null;
}
const S = {
  counterWidth:3,           // digits in the folder counter: a minimum, not a maximum
  volumes:[], sources:[], dests:[],
  kioskMode:false, kioskPin:'',
  writeReport:true,
  reportHtml:true, reportCsv:false, reportJson:false, reportFull:true,
  writeChecksum:true,
  cksumList:true, cksumMhl:false, ascMhl:false,
  ntfyEnabled:false, ntfyServer:'https://ntfy.sh', ntfyTopic:'',
  hookEnabled:false, exportInclude:null,
  hookCommand:'',
  // The per card handoff. Off by default: with it off, no file is
  // written and no command is run, ever.
  handoffEnabled:false,
  handoffCommand:'',
  mode:MODE.SECURE,
  proAlgo:'xxh128',
  proDoubleRead:false,
  proWarnDismissed:false,
  historyHidden:[], historyClearedAt:"",
  filters:{system:false,network:false},
  hiddenVolumes:new Set(),  // paths hidden by the user; session-only, cleared on relaunch
  showHidden:false,         // when true, hidden volumes are shown (dimmed) so they can be un-hidden
  tokens:[],
  counter:1,           // next counter value (auto or overridden)
  noteMode:'rich',     // notes shown formatted ('rich') or as markdown ('md'), saved in prefs
  sessionOps:[],       // operators of this session, most recent first. NEVER saved: empty at each launch
  counterOverride:false, // true = user set a manual value
  counterMax:0,          // highest counter found in destinations
  copying:false, paused:false,
  dragVol:null,
  dragTokId:null,
  presets:[null,null,null,null],
  // File filter — main switch is session-only (always OFF at launch);
  // per-format choices and the two options persist across sessions.
  fileFilter:false,
  fileFilterFormats:null,      // { ext:bool } — null until first activation
  copyEmptyFolders:false,
  reorganizeFiles:false,
  activePreset:-1,
  ctxSlot:-1,
  writeSentinel:false,      // OFF by default: nothing is written on the card until the user opts in
  _clearSrcOnClose:false,   // clear sources when summary is dismissed

  // ── Set while the app runs (not saved, except where said) ──
  appVersion:'',            // this build's version, from the main process
  updateDismissedVersion:'',// the update notice the operator closed (saved with the preferences)
  centerView:null,          // 'volumes' or 'transfers' once a view was chosen
  _knownVolPaths:null,      // volumes already seen: a new one may open the new-drive prompt
  _modeBeforeProWarn:null,  // the mode to go back to if the PRO warning is cancelled
  // The ingest in progress
  _starting:false,          // between START and the first progress message: a second START does nothing
  _restartWanted:false,     // START again once the current check ends (a new card, a re-check)
  _batchSuppress:false,     // a batch is stopping: the remaining cards are not started
  recopyCanceled:false,     // Cancel during a retry of failed files
  run:null,                 // the run frozen at START: sources, destinations, options
  tf:null,                  // the transfers view: one entry per card, its phases and lanes
  _tfSig:'',                // what the transfers view last drew, so it redraws only on change
  spd:null,                 // speeds per phase, smoothed: { copy, dest, source }
  tfSpd:0,                  // the overall speed shown in the transfers view, smoothed
  _spark:[],                // the last speeds, drawn as the sparkline in the header
  // The summary of the last ingest
  _lastRun:null,            // its results, for the phone notification and the retry
  _cardGroups:null,         // its cards, for the eject buttons
  _revealPaths:null,        // the destination folder of each result, for "show in Finder"
  _failedGroups:null,       // its failed files, by card, for the retry
  _quarantineSeen:null,     // the *.ingesto-failed paths already reported
  _redo:null,               // the card re-read (PRO) that can be run again from the summary
  _summaryNotes:[],         // the remarks shown on the summary
  _lateNotes:[],            // remarks that arrive after the summary is drawn (the handoff)
  _ntfyFailed:null,         // why the phone notification was not delivered
  _ufcList:'',              // the file list of the unformatted-card dialog, for Copy
};

let tokId=0, rawFocused=false;
// {operator} is the canonical variable name; {cameraman} is its legacy alias.
// Canonicalize at every token entry point (button, raw typing, saved prefs,
// presets, imports) so old templates load, display and serialize as {operator}
// while the engine keeps resolving both.
const VAR_CANON={cameraman:'operator'};
const canonKey=k=>VAR_CANON[k]||k;
const mkTok=(type,key)=>({type,key:type==='var'?canonKey(key):key,id:tokId++});

function defaultTokens(){
  return[
    mkTok('var','counter'),mkTok('sep','_'),
    mkTok('var','cardname'),mkTok('sep','_'),
    mkTok('var','operator'),mkTok('sep','_'),
    mkTok('var','camera'),mkTok('sep','_'),
    mkTok('var','YY'),mkTok('var','MM'),mkTok('var','DD'),mkTok('sep','_'),
    mkTok('var','HH'),mkTok('var','MIN'),
  ];
}
S.tokens=defaultTokens();
