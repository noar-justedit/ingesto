// The copy engine: one card, copied to every destination, verified.
// performCopyMulti() is the whole run, phase by phase.
'use strict';

const { ctl, pauseGate, resetPausedMs } = require('./run-control');
const { FAILED_SUFFIX, OS_LITTER_DIRS, PART_SUFFIX, copyFanOut, fsyncFile, holdsForeignContent, probeCacheEviction, sweepPartFiles } = require('./copy-io');
const { fmtBytes, freeName } = require('./util');
const { hashPro, newProHasher } = require('./hashing');
const { isHdeSource } = require('../shared/sources');
const { isVirtualSource } = require('./mounts');
const folderNames = require('../shared/folder-names');
const { MAX_FOLDER_DEPTH, buildFolderSegments, cleanSegment, resolveTemplateVars, templateLeaf, templateSegments } = folderNames;
const { MODE, MODES } = require('../shared/modes');
const { NOTE_HEADER, isAppleDouble, mdEscapeText, writeAscMhl, writeChecksumList, writeFileAtomic, writeMHL } = require('./manifests');
const { pathContains, safeRename, safeUnlink } = require('./source-lock');
const { SOURCE_STALL_MS, settleWithin, stallError, statWithin } = require('./io-deadline');
const fs = require('fs');
const i18n = require('./lang');
const nocache = require('./nocache');
const path = require('path');

// A folder name the destination's filesystem accepts (Windows device names are
// refused on Windows only).
function isSafeFolderName(name) { return folderNames.isSafeFolderName(name, process.platform); }

// Split a list into groups that can safely be read AT THE SAME TIME: one group
// per physical device, so two folders on the same disk stay in the same group
// and are read one after the other. Falls back to "each on its own" when the
// device cannot be determined — parallel reads of two paths that turn out to
// share a disk cost speed, never correctness.
function groupByDevice(items, pathOf) {
  const byDev = new Map();
  for (const it of items) {
    let k;
    try { k = 'd' + fs.statSync(pathOf(it)).dev; }
    catch (_) { k = 'p' + pathOf(it); }
    if (!byDev.has(k)) byDev.set(k, []);
    byDev.get(k).push(it);
  }
  return [...byDev.values()];
}
// Why a card ended up with nothing to copy — or null when there is nothing to
// complain about. "Nothing to do" is a legitimate outcome when every file was
// already ingested; it is NOT one when the folder was empty or the format
// filter excluded everything. Reported as success:true, those two would give a
// green summary, an "all verified" notification, and in kiosk mode the card
// ejected with "You can remove your card" on screen, having read not one of its
// files.
function emptyRunReason(seenFiles, skippedAlready, totalFiles) {
  if (totalFiles > 0 || skippedAlready > 0) return null;
  return seenFiles === 0
    ? 'no file was found on this card. Check that you selected the card itself and not an empty folder inside it'
    : `all ${seenFiles} file${seenFiles > 1 ? 's' : ''} on this card were excluded by the file filter, so nothing was copied`;
}

// One result per destination, refused or run: every field is always there,
// at its neutral value when the run did not get that far. The window, the
// reports and the card journal read one shape.
function makeResult(fields) {
  return Object.assign({
    success: false, canceled: false, scanIncomplete: false,
    refused: false, refusalCode: null, refusalData: null,
    coldVerify: null, doubleReadCached: false, doubleReadSpeed: 0, cacheProbe: null,
    copySpeed: 0, recheckList: null, proAlgoUsed: null,
    sourceName: '', sourcePath: '', destPath: '', relFolder: '',
    totalFiles: 0, copiedFiles: 0, totalBytes: 0, copiedBytes: 0, skippedFiles: 0,
    errors: 0, errorList: [], notes: [], emptyReason: null, seenFiles: 0,
    sidecarFailed: [], quarantinedPaths: [],
    failedFiles: [], failedMap: {}, unstableFiles: [], _cksumEntries: [],
    mode: null, proAlgo: null, proDoubleRead: false,
    copyMs: 0, verify1Ms: 0, verify2Ms: 0, duration: 0,
    _copiedForSentinel: [],
  }, fields);
}

// ── One ingest: a card copied to every destination ─────────────────────────
// performCopyMulti (at the end of this file) runs the phases below in order.
// They share one object, `run`, made by startRun: the card, the destinations,
// the options, what was decided before the copy (mode, folder, HDE), and the
// counters and clocks the phases update (run.copiedBytes, run.tCopyEnd...).
// A phase that creates something a later phase needs adds it to `run`
// (Object.assign at its end). The values a phase only reads are taken out of
// `run` on its first line; the counters are always written as run.x.

// The run: what this card, these destinations and these options mean for the
// whole ingest, decided once.
async function startRun(source, destinations, options, onProgress) {
  const t0 = Date.now();
  // tCopyStart is stamped just before the first file is read. t0 is kept for the
  // ingest's overall duration, but "COPY" must not include the recursive source
  // scan nor the destination tree pre-creation: on a card with tens of
  // thousands of files across three destinations that would be seconds to tens
  // of seconds billed as copying, which would also understate the copy speed.
  let tCopyStart=t0, tCopyEnd=0, tV1End=0, tV2End=0;
  // Paused time is measured per phase and subtracted from each.
  resetPausedMs();
  let pausedAtCopyStart=0, pausedAtCopyEnd=0, pausedAtV1End=0, pausedAtV2End=0;
  // Times the SOURCE cache eviction refused to run (SECURE/PRO). The copy reads
  // the card through the normal cached path, so this purge is the only thing
  // keeping the copy — and the PRO second read — off the OS cache. A failure
  // must be reported, never swallowed. The two phases are counted SEPARATELY:
  // a purge that failed while copying says nothing about whether the second
  // read hit the card, and mixing them would raise a "the card check didn't
  // really run" alarm on ingests whose second read is genuine.
  let copyPurgeFails = 0, dblPurgeFails = 0;
  let copiedBytes=0, totalBytes=0, totalFiles=0;
  // How the scan ended, so that "nothing to copy" can be told apart from
  // "nothing worth copying" — see emptyRunReason.
  let seenFiles=0, skippedAlready=0;
  // Set once the card has stopped answering (see SOURCE_STALL_MS): from then
  // on nothing more is asked of it during this run.
  let sourceStalled = null;
  // A mode this engine does not know would match none of the branches below,
  // so the copy would run with no verification at all while the operator
  // believes they are in SECURE. The safe reading of an unknown mode is the careful one:
  // verify. It is also what the window will then say, so the two agree.
  if (!MODES.includes(options.mode)) options.mode = MODE.SECURE;
  const isPro    = options.mode === MODE.PRO;
  const isSecure = options.mode === MODE.SECURE;
  const proAlgo  = options.proAlgo || 'xxh128';
  const cksumAlgo = isPro ? proAlgo : 'xxh64';        // SECURE fingerprints are xxHash64
  const hasher   = (isPro || isSecure) ? await newProHasher(isPro ? proAlgo : 'xxh64') : null;
  // An HDE volume (CODEX Platform (ex Device Manager), "A003_hde"): its files are encoded
  // while they are read and exist nowhere else. Its announced sizes are not
  // the sizes that arrive, the cache cannot be purged, and a second read only
  // runs the encoder again: the card re-read is off there.
  // HDE by name, or any volume produced on read (see isVirtualSource): the
  // same care for both. On an ordinary card both are false and nothing below
  // changes.
  const hdeSource = isHdeSource(source.path) || await isVirtualSource(source.path);
  const proDouble = isPro && options.proDoubleRead === true && !hdeSource;
  const hdeSkippedReread = isPro && options.proDoubleRead === true && hdeSource;
  // The card's destination, level by level. Without a "/" in the template this
  // is a single segment: the card's folder, directly in the destination root.
  const tplNow     = new Date();   // ONE clock reading for this card
  const folderSegs = options.fixedDestPath ? [] : buildFolderSegments(options.folderTemplate, source, tplNow);
  const relFolder  = folderSegs.join('/');
  const destNames  = destinations.map(d => d.name).filter(Boolean).join(' + ');

  // A REFUSAL, not a failure: the engine looked at what it was being asked to
  // do, decided it would destroy or lose footage, and stopped before touching
  // anything. The interface has to be able to tell the two apart, because the
  // operator's next move is not the same: after a refusal nothing is on the
  // drive and the fix is in the settings; after a failure something IS on the
  // drive and the fix is to copy again. Without this distinction both would
  // arrive as "Finished with Errors".
  // `code` names the case so the window can carry the right text and the right
  // buttons; `data` carries what that text has to name.
  const abort = (code, msg, data) => destinations.map(d => makeResult({
    refused: true, refusalCode: code, refusalData: data || {},
    sourceName: source.name, sourcePath: source.path,
    destPath: options.fixedDestPath || path.join(d.path, ...folderSegs),
    relFolder,
    errors: 1, errorList: [{ file: '(pre-flight)', error: msg, phase: 'setup', refused: true }],
    mode: options.mode, proAlgo: isPro ? proAlgo : null, proDoubleRead: proDouble,
  }));
  return { source, destinations, options, onProgress, t0, tCopyStart, tCopyEnd, tV1End, tV2End,
    pausedAtCopyStart, pausedAtCopyEnd, pausedAtV1End, pausedAtV2End, copyPurgeFails,
    dblPurgeFails, copiedBytes, totalBytes, totalFiles, seenFiles, skippedAlready, sourceStalled,
    isPro, isSecure, proAlgo, cksumAlgo, hasher, hdeSource, proDouble, hdeSkippedReread, tplNow,
    folderSegs, relFolder, destNames, abort,
    nothingToCopy: false,   // set by scanCard: the card holds nothing to copy
  };
}

// The checks that refuse the ingest before anything is written. Returns the
// refusal (one result per destination) or null.
function refuseBeforeStart(run) {
  const { source, destinations, options, tplNow, folderSegs, relFolder, abort } = run;
  // ── Pre-flight guards — refuse to start rather than write in the wrong place ──
  // Without these checks the ingest would run, report success, and either
  // overwrite existing footage or copy nothing at all.

  // 1. An empty / "." / ".." folder name would drop the whole card into the
  //    destination ROOT (path.join(dest,'') === dest), where the next card
  //    silently overwrites it.
  if (!options.fixedDestPath) {
    if (!folderSegs.length) {
      return abort('PF-E1', 'The folder template produced an empty name, which would write straight into the destination root. Nothing was written.', { card: source.name });
    }
    // The card's OWN folder must exist. A level that resolves to nothing simply
    // disappears — intended for a subfolder (a card with no camera moves up one
    // level), NEVER for the last one: "{YY}{MM}{DD}/{operator}_{camera}" with
    // both fields empty resolves to "260903" alone, and every card of the day
    // is then written INTO that folder, mixed together, tomorrow's over
    // today's. Without a "/" this is an empty name, refused by guard 1; the
    // "/" must not make it legal.
    if (!cleanSegment(resolveTemplateVars(templateLeaf(options.folderTemplate), source, tplNow))) {
      return abort('PF-E2', 'The last level of the folder template, the card\'s own folder, resolved to nothing, so the card would be written into the subfolder it shares with every other card. Nothing was written.', { card: source.name, shared: folderSegs.join('/') });
    }
    // Every level is a folder name in its own right: "..", a separator or a
    // reserved character in ANY of them would place the card outside the
    // destination, not just in the wrong folder.
    for (const seg of folderSegs) {
      if (!isSafeFolderName(seg)) {
        return abort('PF-E3', `The folder template produced "${seg}" as a folder level, which is not a usable folder name. Nothing was written.`, { card: source.name, seg });
      }
    }
    if (folderSegs.length > MAX_FOLDER_DEPTH) {
      return abort('PF-E4', `The folder template asks for ${folderSegs.length} levels of subfolders (limit ${MAX_FOLDER_DEPTH}). Nothing was written.`, { card: source.name, levels: folderSegs.length, limit: MAX_FOLDER_DEPTH });
    }
    // The counter identifies the CARD, so it belongs to the card's own folder.
    // In a subfolder it would number a day or a camera instead, and the
    // collision check, the counter scan and the report would all describe
    // something other than the cards.
    const tplSegs = templateSegments(options.folderTemplate);
    if (tplSegs.slice(0, -1).some(t => t.includes('{counter}'))) {
      return abort('PF-E5', 'The counter is in a subfolder level of the template. It must be part of the card\'s own folder, the last level, after the final "/". Nothing was written.', { card: source.name });
    }
  }

  // 2. A destination equal to, or inside, the source card copies the card into
  //    itself; the card is then flagged as ingested and offered for ejection.
  //
  // Checked against EVERY card of the batch, not only the one being copied.
  // Otherwise a destination that sits inside another card of the same batch
  // would pass here and be refused later by the source-card lock, in the middle
  // of the copy, with a message about a card the operator is not copying. The
  // answer belongs before the first byte.
  const batchRoots = (Array.isArray(options.batchSources) && options.batchSources.length)
    ? options.batchSources : [source.path];
  for (const d of destinations) {
    const dp = options.fixedDestPath || d.path;
    const clash = batchRoots.find(sp => pathContains(sp, dp) || pathContains(dp, sp));
    if (clash) {
      return abort('PF-E6',
        `Destination "${d.name || dp}" is the same as, or inside, a card of this ingest${clash === source.path ? '' : ` ("${path.basename(clash)}")`}. Nothing was written.`,
        { card: source.name, dest: d.name || dp, destPath: dp });
    }
  }

  // 3. File filter enabled with every format unchecked: the engine would skip
  //    every single file and still report a successful, verified ingest.
  if (options.fileFilter && options.fileFilter.extCat &&
      Object.keys(options.fileFilter.extCat).length === 0) {
    return abort('PF-E7', 'The file filter is enabled but no format is selected, so nothing would be copied. Nothing was written.', { card: source.name });
  }

  // 4. The destination must actually BE there. mkdirSync({recursive:true})
  //    below happily recreates "/Volumes/BACKUP/001_A001" on the system disk
  //    when the drive is unplugged between the check and the copy: the run
  //    would then succeed, verify against itself, and the real drive would
  //    hold nothing of it. A retry (fixedDestPath) points at a folder that a
  //    previous run created: it must exist too, and it must never be recreated.
  for (const d of destinations) {
    const root = options.fixedDestPath || d.path;
    let st = null; try { st = fs.statSync(root); } catch (_) {}
    if (!st || !st.isDirectory()) {
      return abort('PF-E8', `Destination "${d.name || root}" is not there any more (${root}). Nothing was written.`, { card: source.name, dest: d.name || root, destPath: root });
    }
  }

  // 5. The card's folder must be NEW. This is the last line of defence against
  //    overwriting footage, and it lives in the engine on purpose: every guard
  //    above it (the counter scan, the collision check, the pre-flight) is an
  //    interface heuristic that only recognises a NUMBER in a folder name. A
  //    template without {counter}, two cards labelled "NO NAME", a folder that
  //    is a symbolic link, a counter read wrong, two ingesto windows on one
  //    drive: each of them can land a card on top of an earlier one, and every
  //    file of the earlier card with the same name would be silently replaced.
  //    ingesto never writes into an existing card folder. The one thing it
  //    tolerates there is its own residue from an interrupted run
  //    (*.ingesto-part), which the sweep below removes.
  if (!options.fixedDestPath) {
    for (const d of destinations) {
      const cardDir = path.join(d.path, ...folderSegs);
      let lst = null; try { lst = fs.lstatSync(cardDir); } catch (_) {}
      if (!lst) continue;
      if (lst.isSymbolicLink() || !lst.isDirectory() || holdsForeignContent(cardDir)) {
        return abort('PF-E9', `The folder "${relFolder}" already exists on destination "${d.name || d.path}" and is not empty. Nothing was written.`, { card: source.name, dest: d.name || d.path, folder: relFolder, absPath: path.join(d.path, relFolder) });
      }
    }
  }
  return null;
}

// run.R: one entry per destination, filled by every phase that follows.
function initDestinationResults(run) {
  const { destinations, options, isPro, isSecure, hdeSource, hdeSkippedReread, folderSegs,
    relFolder } = run;
  // Per-destination state
  const R = destinations.map((d, i) => ({
    di: i,
    name: d.name || '',
    destPath: options.fixedDestPath || path.join(d.path, ...folderSegs),
    relFolder,
    active: true,
    copiedFiles: 0, errors: 0, errorList: [], failedFiles: [], failedMap: {}, unstableFiles: [],
    copied: [],               // { rel, src, dest, size, mtimeMs, srcHash, _writeOk }
    copiedForSentinel: [], cksumEntries: [],
    _tmps: new Set(),         // every *.ingesto-part THIS run opened — the only ones it may clean up
  }));
  // Said on the window (a remark) and in the report (a warning line): what an
  // HDE copy can and cannot prove.
  if (hdeSource) for (const r of R) {
    // What is claimed follows the mode: FAST and SIZE CHECK verify nothing,
    // and must not be credited with a check they did not make.
    const verified = isPro || isSecure;
    (r.notes || (r.notes = [])).push({ code: 'HDE',
      text: verified ? 'Virtual volume: the copies were checked against what it delivered, not against the card.'
                     : 'Virtual volume: its files are produced while they are read.',
      detail: !verified ? 'HDE with CODEX Platform, for example. ingesto copied what it delivered; nothing was compared with the card itself.'
        : hdeSkippedReread
        ? 'Its files are produced while they are read (HDE with CODEX Platform, for example). The card re-read (PRO) was not run: it would only have produced them again.'
        : 'Its files are produced while they are read (HDE with CODEX Platform, for example).' });
    r.errorList.push({ file: '(card)', phase: 'warning',
      error: (verified ? 'Virtual volume (HDE, for example): checked against what it delivered, not against the card.'
                       : 'Virtual volume (HDE, for example): its files are produced while they are read.')
             + (hdeSkippedReread ? ' Card re-read not run.' : '') });
  }
  Object.assign(run, { R });
}

// Lists the card. Returns a refusal (one result per destination) when the
// card cannot be copied as it is, otherwise null.
async function scanCard(run) {
  const { source, options, onProgress, abort, R } = run;
  // ── Scan the source ONCE ────────────────────────────────────────────────
  const onlyRel = options.onlyRel ? new Set(options.onlyRel.map(p => p.replace(/\\/g,'/'))) : null;
  // File filter (optional): { extCat: {ext:'VIDEO'|'AUDIO'|'PICTURES'|'OTHERS'},
  //                           copyEmpty: bool, reorganize: bool }
  const FF = options.fileFilter && options.fileFilter.extCat ? options.fileFilter : null;
  const ffReorg = !!(FF && FF.reorganize);
  const allFiles=[], allDirs=[], skippedRels=[];
  // What the OS puts on a volume by itself is never footage. The same list as
  // the card inspection (sentinel.js) and the destination guard
  // (OS_LITTER_DIRS). It includes "System Volume Information" and
  // "$RECYCLE.BIN", which Windows protects on NTFS: reading them fails, so
  // without them an NTFS drive used as a source could never finish green.
  const SKIP = new Set(['.DS_Store', ...OS_LITTER_DIRS]);
  const skipKeys = new Set(options.skipKeys || []);
  const SENTINEL_FILENAME = '.ingesto.json';
  // Anything we cannot even READ on the card is an error, never a silent skip:
  // otherwise a dying CFexpress that throws EIO on one folder would produce a
  // green "100 %, 0 error" ingest with a whole subtree missing.
  const scanErrors = [];
  // A scan failure is by definition a read of the CARD. Without `origin` the
  // interface would group it under "On the destination", which is the opposite
  // conclusion: change the drive, versus stop using this card.
  const scanFail = (p, e, what) => scanErrors.push({
    file: (path.relative(source.path, p) || '.').replace(/\\/g,'/'),
    error: `${what} could not be read on the source: ${e && e.message ? e.message : e}`,
    phase: 'scan', origin: 'source',
  });
  // Asynchronous, with a deadline on every call: a synchronous scan freezes
  // the whole application on a card that stops answering.
  const scanStalled = (p, what) => {
    run.sourceStalled = stallError(what);
    scanErrors.push({ file: (path.relative(source.path, p) || '.').replace(/\\/g,'/'),
      error: `${run.sourceStalled.message}. The rest of the card was not read.`, phase: 'scan', origin: 'source', stalled: true });
  };
  await (async function scan(dir) {
    if (run.sourceStalled) return;
    const rd = await settleWithin('readdir:' + dir, () => fs.promises.readdir(dir, { withFileTypes: true }), SOURCE_STALL_MS);
    if (rd.timeout) { scanStalled(dir, 'a folder could not be listed'); return; }
    if (rd.err) { scanFail(dir, rd.err, 'folder'); return; }
    const entries = rd.v;
    if (!entries.length) { allDirs.push(dir); return; }
    for (const e of entries) {
      if (run.sourceStalled) return;
      if (SKIP.has(e.name) || isAppleDouble(e)) continue;
      // Same rule as sentinel.listAllFiles: skip the tracking log AND its
      // siblings (.unreadable / .tmp), so card bookkeeping is never ingested.
      if ((e.name === SENTINEL_FILENAME || e.name.startsWith(SENTINEL_FILENAME + '.')) && dir === source.path) continue;
      // The write-protect probe (.ingesto_wtest_<ms>) is unlinked right after
      // it is created; one left behind by a yanked card or an antivirus lock
      // would otherwise be copied, counted and "verified" as footage.
      if (e.name.startsWith('.ingesto_wtest_') && dir === source.path) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { allDirs.push(full); await scan(full); }
        else {
          const sr = await statWithin(full, SOURCE_STALL_MS);
          if (sr.timeout) { scanStalled(full, 'a file could not be measured'); return; }
          if (sr.err) throw sr.err;
          const s = sr.v;
          const rel = path.relative(source.path, full).replace(/\\/g, '/');
          run.seenFiles++;
          if (onlyRel && !onlyRel.has(rel)) continue;
          if (skipKeys.size) {
            const key = `${rel}|${s.size}|${Math.floor(s.mtimeMs/1000)}`;
            // Kept, not just counted: a file that is being SKIPPED is a file
            // this run is relying on already being on the drive. The pre-copy
            // residue sweep must be told about it, or it deletes the very copy
            // that justified the skip. See sweepPartFiles below.
            if (skipKeys.has(key)) { run.skippedAlready++; skippedRels.push(rel); continue; }
          }
          let cat = null;
          if (FF) {
            const ext = path.extname(e.name).slice(1).toLowerCase();
            // Own-property lookup only. A file literally named "CLIP.constructor"
            // or "CLIP.__proto__" would otherwise resolve through
            // Object.prototype, come back truthy, and be copied even though no
            // format matching it is enabled, and with Reorganize on, land in a
            // folder named "[object Object]". The card's contents decide this key, so it is
            // untrusted input.
            cat = Object.prototype.hasOwnProperty.call(FF.extCat, ext) ? FF.extCat[ext] : null;
            if (!cat) continue;                       // format not enabled → skipped
            if (ffReorg && cat === 'OTHERS') continue; // Others never reorganized
          }
          allFiles.push({src:full,size:s.size,mtimeMs:s.mtimeMs,rel,cat});
          run.totalBytes+=s.size;
        }
      } catch(e) { scanFail(full, e, 'entry'); }
    }
  })(source.path);
  run.totalFiles = allFiles.length;

  // A retry is a CHECKLIST, not a filter: every file it was asked for must be
  // accounted for. Otherwise a requested file that is missing from the card
  // would vanish from the run: "2 of 2 copied, Transfer Complete", the retry
  // button gone, and the third clip unrecoverable from the interface.
  if (onlyRel) {
    const found = new Set(allFiles.map(f => f.rel));
    for (const rel of onlyRel) {
      if (found.has(rel)) continue;
      for (const r of R) {
        r.errors++;
        r.errorList.push({ file: rel, error: 'this file is no longer on the card, so it could not be re-copied', phase: 'scan' });
        r.failedFiles.push(rel);
        if (options.destRelOverride && options.destRelOverride[rel]) r.failedMap[rel] = options.destRelOverride[rel];
      }
    }
  }

  { const why = emptyRunReason(run.seenFiles, run.skippedAlready, run.totalFiles);
    // An empty card is a misunderstanding, not a failure: nothing was copied
    // and nothing was lost. The interface needs to tell the two apart, and it
    // also needs to know WHICH of the two ("no file on the card" and "the
    // filter excluded all of them" call for opposite instructions).
    run.nothingToCopy = !!why;
    if (why) for (const r of R) {
      r.errors++;
      r.emptyReason = run.seenFiles === 0 ? 'no-files' : 'filtered-out';
      r.seenFiles = run.seenFiles;
      r.errorList.push({ file:'(card)', error: why, phase:'scan' });
    } }

  // A card whose files were ALL legitimately skipped as already ingested does
  // no work at all, and therefore would emit no progress event whatsoever.
  // The queue view marks a card it never heard from as an ERROR (that rule is
  // what keeps a card the engine refused from being painted verified), so a
  // perfectly healthy "nothing new on this card" run would show up in red
  // while the summary calls it a success. One event saying "seen, and complete" is
  // all the view needs to tell those two silences apart.
  if (run.totalFiles === 0 && run.skippedAlready > 0 && scanErrors.length === 0) {
    try {
      onProgress({ sourceName: source.name, sourcePath: source.path, currentFile: '',
        phase: 'copy', destIndex: 0, copiedFiles: 0, totalFiles: 0, remainingFiles: 0,
        copiedBytes: 0, totalBytes: 0, progress: 1, speed: 0, eta: 0, errors: 0 });
    } catch (_) {}
  }

  // Surface the scan failures on every destination result: they must count as
  // errors so the run can never come back success:true, and so the sentinel is
  // not written on a card whose content was only partially seen.
  if (scanErrors.length) {
    for (const r of R) { r.errors += scanErrors.length; r.errorList.push(...scanErrors.map(e => ({...e}))); }
  }

  // Destination-relative path per file. Normally identical to the source rel;
  // with "Reorganize files on destination" every kept file is flattened into
  // /VIDEO, /AUDIO or /PICTURES, with an _2/_3… suffix on basename collisions.
  // The suffixed name must itself be checked and reserved: a card holding
  // 100/CLIP.MOV, 101/CLIP.MOV and 102/CLIP_2.MOV would otherwise send two
  // files to the same VIDEO/CLIP_2.MOV, and the second would overwrite the first.
  const usedNames = new Set();
  for (const f of allFiles) {
    if (!ffReorg) { f.destRel = f.rel; continue; }
    const base = path.basename(f.rel);
    const ext  = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = f.cat + '/' + base;
    let n = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      n++;
      candidate = f.cat + '/' + stem + '_' + n + ext;
    }
    usedNames.add(candidate.toLowerCase());
    f.destRel = candidate;
  }
  // Retry runs pin each file to the destination path it FAILED at (recorded by
  // the original run), so a reorganize retry overwrites the bad copy in place.
  if (options.destRelOverride) {
    for (const f of allFiles) {
      const o = options.destRelOverride[f.rel];
      if (typeof o === 'string' && o && !o.includes('..')) f.destRel = o;
    }
  }

  // A card that carries BOTH "X.MOV" and "X.MOV.ingesto-part" cannot be copied
  // safely: the temp name of the first file is the final name of the second.
  // Whichever order they are handled in, one is destroyed, the temp open
  // truncates the delivered file or the post-copy sweep deletes it, and in
  // FAST the run would still report "2 copied" over a folder holding one file.
  // This happens for real when a folder left by an interrupted ingest is
  // re-ingested as a card. Refused before anything is written, rather than
  // patched over: the operator has to decide which of the two is the footage.
  // Checked on destRel, the name actually written, so Reorganize is covered.
  {
    const relSet = new Set(allFiles.map(f => f.destRel));
    const clash = [];
    for (const rel of relSet) {
      for (const suffix of [PART_SUFFIX, FAILED_SUFFIX]) {
        if (rel.endsWith(suffix) && relSet.has(rel.slice(0, -suffix.length))) clash.push(rel);
      }
    }
    if (clash.length) {
      return abort('PF-E10',
        `This card holds ${clash.length} file${clash.length > 1 ? 's' : ''} whose name collides with the temporary name ingesto uses while copying (${clash.slice(0, 3).join(', ')}). Nothing was written.`,
        { card: source.name, files: clash.slice(0, 20), count: clash.length });
    }
  }
  Object.assign(run, { onlyRel, FF, ffReorg, allFiles, allDirs, skippedRels, scanErrors });
  return null;
}

// Creates the card's folder and its tree on every destination.
async function prepareDestinations(run) {
  const { source, options, R, onlyRel, FF, ffReorg, allDirs, skippedRels } = run;
  // ── Destination roots, folder tree, note file ───────────────────────────
  for (const r of R) {
    try { fs.mkdirSync(r.destPath, {recursive:true}); }
    catch (e) {
      r.active = false; r.errors++;
      r.errorList.push({ file:'(destination)', error:e.message, phase:'copy' });
    }
    // Residue of an interrupted run (the only content guard 5 tolerates) goes
    // BEFORE anything is copied, so the sweep can never meet this run's files.
    //
    // Except the files it is SKIPPING. "Copy new files only" leaves a file
    // alone because a good copy is already on this drive; if that copy is
    // itself named "*.ingesto-part" (an interrupted ingest's folder that was
    // later ingested as a card), the sweep would delete it a moment after the
    // skip decision, and the run would end green over a folder it had just
    // emptied.
    if (r.active && !options.fixedDestPath)
      sweepPartFiles(r.destPath, new Set(skippedRels.map(rel => path.join(r.destPath, rel))));
  }
  // Full source tree is pre-created only when copying everything, or when the
  // filter is on WITH "Copy empty folders". Filter without that option: folders
  // are created on demand per file, so dirs left empty by filtering never appear.
  // Reorganize ignores the source tree entirely (/VIDEO etc. created per file).
  if (!onlyRel && !ffReorg && (!FF || FF.copyEmpty)) {
    for (const d of allDirs) {
      const rel = path.relative(source.path, d);
      // The folder dates are a nicety: a card that does not answer is not
      // asked (and the copy below reports it).
      let st=null;
      if (!run.sourceStalled) { const sr = await statWithin(d, SOURCE_STALL_MS); if (sr.timeout) run.sourceStalled = stallError('a folder could not be measured'); else st = sr.v || null; }
      for (const r of R) {
        if (!r.active) continue;
        try {
          const dd = path.join(r.destPath, rel);
          fs.mkdirSync(dd,{recursive:true});
          if (st) fs.utimesSync(dd,st.atime,st.mtime);
        } catch(_){}
      }
    }
  }

  const spd=[], speedPush=(b,ms)=>{ if(ms>0){ spd.push(b/ms*1000); if(spd.length>12)spd.shift(); } };
  const avgSpd=()=>spd.length?spd.reduce((a,b)=>a+b)/spd.length:0;
  Object.assign(run, { spd, speedPush, avgSpd });
}

// Reads every file of the card once and writes it to every destination.
async function copyCard(run) {
  const { source, options, onProgress, isPro, isSecure, hasher, hdeSource, destNames, R, onlyRel,
    FF, ffReorg, allFiles, speedPush, avgSpd } = run;
  // ── PHASE 1 — read once, write to every destination (green bar) ─────────
  run.tCopyStart = Date.now(); run.pausedAtCopyStart = ctl.pausedMs;
  { let lastB=0, lastT=Date.now(), lastEmit=0;
    // Every file not yet copied, once the card has gone silent: each one is
    // reported (the retry needs the list), none of them is asked for.
    const failRemaining = (from, act) => {
      for (let j = from; j < allFiles.length; j++) for (const r of act) {
        r.errors++;
        r.errorList.push({ file: allFiles[j].rel, phase: 'copy', origin: 'source', stalled: true,
          error: `not copied: ${run.sourceStalled.message}` });
        r.failedFiles.push(allFiles[j].rel); r.failedMap[allFiles[j].rel] = allFiles[j].destRel;
      }
    };
    for (let i=0; i<allFiles.length; i++) {
      if (ctl.cancelCopy) break;
      await pauseGate();
      if (ctl.cancelCopy) break;
      const act = R.filter(r=>r.active);
      if (!act.length) break;
      if (run.sourceStalled) { failRemaining(i, act); break; }
      const file=allFiles[i], rel=file.rel;
      const destFilesAbs = act.map(r => path.join(r.destPath, file.destRel));
      // Write under a temporary name; promote to the final name only once the
      // file is complete (and fsynced, in SECURE/PRO).
      const destTmpAbs   = destFilesAbs.map(p => p + PART_SUFFIX);
      act.forEach((r, k) => r._tmps.add(destTmpAbs[k]));   // what a post-copy clean-up may touch
      let fileBytes = 0;                                   // read from the CARD for this file
      // One message per 8 MB chunk, unthrottled, would be a full repaint of
      // the transfer view per chunk: on a card of small files, one file = one
      // chunk = one repaint, tens of times a second, and the serialising is
      // done by the very process that is copying. The copy phase therefore
      // throttles to 100 ms, like the verify phase. The last event of a file
      // is never dropped, so a bar always reaches its end.
      const onB = (b, force) => {
        run.copiedBytes+=b; fileBytes+=b;
        const now=Date.now();
        if (now-lastT>=150){ speedPush(run.copiedBytes-lastB,now-lastT); lastB=run.copiedBytes; lastT=now; }
        if (!force && now-lastEmit < 100) return;
        lastEmit = now;
        const sp=avgSpd();
        onProgress({ sourceName:source.name, sourcePath:source.path, currentFile:rel, phase:'copy',
          destIndex:0, destName:destNames,
          copiedFiles:R[0].copiedFiles, totalFiles: run.totalFiles, remainingFiles:run.totalFiles-i-1,
          // Clamped: a file that GREW since the scan pushes copiedBytes past the
          // total, and the bar would then report 103% and an ETA in the past.
          // HDE: the sizes are only known once read, so the bar counts files
          // and no time left is promised.
          copiedBytes: run.copiedBytes, totalBytes: run.totalBytes,
          progress: hdeSource ? (run.totalFiles>0 ? Math.min(1, i/run.totalFiles) : 0) : (run.totalBytes>0?Math.min(1,run.copiedBytes/run.totalBytes):0),
          speed:sp, eta: hdeSource ? 0 : (sp>0?Math.max(0,(run.totalBytes-run.copiedBytes)/sp):0),
          errors:R.reduce((a,r)=>a+r.errors,0) });
      };
      try {
        // On-demand parent dir: retry runs (onlyRel), filtered copies without
        // "Copy empty folders", and reorganize (/VIDEO etc.) all skip the
        // upfront tree creation, so make sure each file's parent exists.
        if (onlyRel || ffReorg || options.destRelOverride || (FF && !FF.copyEmpty)) for (const df of destFilesAbs) { try { fs.mkdirSync(path.dirname(df),{recursive:true}); } catch(_){} }
        // SECURE/PRO: evict this source file from the OS cache before reading
        // it, so the copy reads what the card delivers NOW — not what a
        // previous ingest of the same card left sitting in RAM (observed on
        // Windows: re-ingesting a 75 MB/s card ran the copy at 300-600 MB/s
        // from cache). The bytes were originally read from the card either
        // way, but SECURE's promise is about the card as it is at THIS ingest.
        // FAST/VERIFIED make no such claim and keep the free speed-up.
        // The card is asked first, with a deadline: the cache purge below
        // opens the file synchronously, and a card that does not answer
        // would hold the whole application there.
        { const pre = await statWithin(file.src, SOURCE_STALL_MS);
          if (pre.timeout) { run.sourceStalled = stallError('a file could not be opened'); failRemaining(i, act); break; } }
        if ((isPro || isSecure) && !hdeSource) {
          let purged = false;
          try { purged = nocache.purgeFileCache(file.src); } catch(_) {}
          if (!purged) run.copyPurgeFails++;
        }
        const { digest, failed } = await copyFanOut(file.src, destTmpAbs, onB, hasher, SOURCE_STALL_MS);
        onB(0, true);   // the end of a file always shows, whatever the throttle
        const srcHash = digest == null ? null : String(digest);
        let st=null;
        { const post = await statWithin(file.src, SOURCE_STALL_MS);
          if (post.timeout) run.sourceStalled = stallError('a file could not be measured');
          else st = post.v || null; }

        // ── The file changed on the card WHILE it was being copied ───────────
        //
        // A camera still finalising a clip, a card pulled and pushed back, a
        // network source someone else is writing to. The copy then holds a
        // prefix, a mixture, or a torn file. Nothing downstream noticed: the
        // checksum is computed over what was read, so source and destination
        // agree perfectly, the file is delivered, the manifest vouches for it,
        // and the operator formats the card.
        //
        // Three independent readings of the same file, taken before and after
        // the read. They must agree.
        //
        // With ONE exception, and it matters more than the check itself: when
        // every destination has failed, the engine stops reading the card on
        // purpose. The read is then short because the DRIVE died, not because
        // the card moved, and blaming the card here would both hide the real
        // error (ENOSPC, EIO, the drive unplugged) and tell the operator to
        // throw away a healthy card and reader. When that happens the destination
        // error below is the whole story, and this check says nothing.
        const readWasCutShort = failed.every(Boolean);
        // NOT guarded by `st`. The byte count needs nothing from the card, and
        // the card failing to answer a stat is itself a reason to distrust
        // what was just read: otherwise a short read plus a card that vanished
        // would fall through this whole check and deliver the truncated file
        // under its real name, with the manifest vouching for it.
        // HDE: the size announced by the volume is not the size of what it
        // delivers, so the comparisons below would condemn every file. What
        // was read IS the file: it becomes its size for the rest of the run
        // (verify, manifests, report). A file the volume cannot
        // measure once read is still refused.
        if (hdeSource && !ctl.cancelCopy && !readWasCutShort && st) {
          run.totalBytes += fileBytes - (Number(file.size) || 0);
          file.size = fileBytes;
        }
        if (!ctl.cancelCopy && !readWasCutShort) {
          const scanSize = Number(file.size) || 0;
          let why = null;
          if (hdeSource) { if (!st) why = 'the card stopped answering as soon as it had been read'; }
          else if (fileBytes !== scanSize)
            why = `${fmtBytes(fileBytes)} of it could be read, not the ${fmtBytes(scanSize)} the card announced`;
          else if (!st)
            why = 'the card stopped answering as soon as it had been read';
          else if (st.size !== scanSize)
            why = `it was ${fmtBytes(scanSize)} when the card was scanned and is ${fmtBytes(st.size)} now`;
          else if (file.mtimeMs && Math.abs(st.mtimeMs - file.mtimeMs) > 1)
            why = 'it was written again while ingesto was reading it';
          if (why) {
            // Nothing has been promoted yet: the copies still carry the
            // temporary name, so dropping them leaves no half-file behind.
            for (const tmp of destTmpAbs) { try { safeUnlink(tmp); } catch(_) {} }
            for (const r of act) {
              r.errors++;
              r.errorList.push({ file: rel, phase: 'copy', origin: 'source',
                error: `this file changed on the card while it was being copied (${why}). The copy was not kept.` });
              r.failedFiles.push(rel); r.failedMap[rel] = file.destRel;
            }
            continue;
          }
        }
        for (let k=0; k<act.length; k++) {
          const r = act[k], df = destFilesAbs[k], tmp = destTmpAbs[k], err = failed[k];
          if (err) {
            // Drop the partial write. It never carried the final name, so there
            // is nothing on the destination that could pass for a good file.
            try { safeUnlink(tmp); } catch(_) {}
            // A user cancellation is not a copy error — don't inflate the count.
            // `origin` says WHICH side failed, for the interface. Without it,
            // a drive that stopped answering and a card that cannot be read
            // would produce the same line, though the operator's next move is
            // opposite (change the drive, or stop using the card).
            if (!err.aborted) { r.errors++; r.errorList.push({file:rel,error:err.message,phase:'copy',origin:'destination'}); r.failedFiles.push(rel); r.failedMap[rel]=file.destRel; }
            continue;
          }
          try {
            // Order matters: flush BEFORE copying the source's permissions onto
            // the file, or a read-only source makes every fsync fail (EACCES).
            if (isPro || isSecure) {
              const fres = await fsyncFile(tmp);
              if (!fres.ok && fres.unsupported && !r._fsyncWarned) {
                r._fsyncWarned = true;   // warn once per destination, not per file
                r.errorList.push({ file: '(destination)', phase: 'warning',
                  error: `this drive did not confirm when files were fully written (common on network drives, or while antivirus is scanning). The copy completed. For extra certainty, run Verify on this folder later.` });
              }
            }
            safeRename(tmp, df);               // atomic promotion to the final name
            if (st) { try { fs.chmodSync(df,st.mode); fs.utimesSync(df,st.atime,st.mtime); } catch(_){} }
            r.copiedFiles++;
            r.copied.push({rel,destRel:file.destRel,src:file.src,dest:df,size:file.size,mtimeMs:file.mtimeMs,srcHash});
          } catch(e) {
            // Flush or rename failed — the file is NOT on the destination under
            // its final name, and that is reported, never swallowed.
            try { safeUnlink(tmp); } catch(_) {}
            r.errors++;
            r.errorList.push({file:rel,error:`could not be committed to the destination: ${e.message}`,phase:'copy',origin:'destination'});
            r.failedFiles.push(rel); r.failedMap[rel]=file.destRel;
          }
        }
      } catch(e){
        // Source read failure — the file failed for every active destination.
        for (const tmp of destTmpAbs) { try { safeUnlink(tmp); } catch(_) {} }
        for (const r of act) { r.errors++; r.errorList.push({file:rel,error:e.message,phase:'copy',origin:'source',...(e.stalled?{stalled:true}:{})}); r.failedFiles.push(rel); r.failedMap[rel]=file.destRel; }
        // The card went silent in the middle of this file: the next ones are
        // not asked for (see failRemaining at the top of the loop).
        if (e && e.stalled) run.sourceStalled = e;
      }
    }
  }
  run.tCopyEnd = Date.now(); run.tV1End = run.tCopyEnd; run.tV2End = run.tCopyEnd;
  run.pausedAtCopyEnd = run.pausedAtV1End = run.pausedAtV2End = ctl.pausedMs;
}

// After the copy: the warning about the card read from memory, and the
// shooting note on each destination.
function finishCopy(run) {
  const { source, options, isPro, isSecure, R } = run;
  // The SECURE/PRO promise is about the card as it is at THIS ingest. If the
  // cache eviction refused to run, the copy may have been answered from RAM by
  // a previous ingest of the same card — the bytes are still the bytes we
  // fingerprinted, so nothing is corrupt, but "we read your card just now" is
  // not something we can claim. Say so instead of staying silent.
  // nocache.available() first: on a machine with no cache-control capability at
  // all (koffi missing), every purge "fails" by definition and this warning
  // would fire on every single SECURE/PRO ingest. That case is already covered
  // by coldVerify, which turns the "verify later" hint back on.
  if (!ctl.cancelCopy && (isPro || isSecure) && run.copyPurgeFails > 0 && R.length && nocache.available()) {
    R[0].errorList.push({ file: '(card read)', phase: 'warning',
      error: `the computer kept part of this card in its memory, so the copy may not have re-read the card itself. If this card was already ingested on this machine, run Verify on the destination later to be sure.` });
  }

  const srcNote = source.note || options.note || '';
  // Written AFTER the copy, not before: a run interrupted before its first
  // file would otherwise leave the note behind, and the folder (otherwise pure
  // residue) would then be refused for ever.
  if (!ctl.cancelCopy && !options.fixedDestPath && srcNote && srcNote.trim()) {
    // The counter comes from the interface. It names a FILE here, so it is
    // reduced to what a name may hold: anything else (a separator, "..") would
    // put the note outside the destination folder. Every other write of the
    // engine checks this too.
    const counterSafe = String(source.counter || '001').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || '001';
    // Markdown: the note is typed formatted or as markdown in the
    // interface, and it is written as it was typed, under a header that any
    // markdown viewer lays out.
    const noteFileName = `${counterSafe}_note.md`;
    const noteContent = [
      '# ' + NOTE_HEADER, '',
      // The first line (NOTE_HEADER) is how Verify recognises the note: it
      // stays in English. The labels below are for a person.
      // DD.MM.YYYY HH:MM, the format of the report and the history.
      '- **' + i18n.t('Date:') + '** ' + mdEscapeText((() => { const d = new Date(), p = x => String(x).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; })()),
      '- **' + i18n.t('Counter:') + '** ' + mdEscapeText(source.counter || '001'),
      '- **' + i18n.t('Card:') + '** ' + mdEscapeText(source.name),
      '- **' + i18n.t('Operator:') + '** ' + mdEscapeText(source.cameraman || i18n.t('Unknown')),
      '- **' + i18n.t('Camera:') + '** ' + mdEscapeText(source.camera || i18n.t('Unknown')),
      '- **' + i18n.t('Profile:') + '** ' + mdEscapeText(source.pp || i18n.t('Unknown')),
      '', '---', '', srcNote.trim().replace(/\r\n?/g, '\n'), ''
    ].join('\n');
    for (const r of R) {
      if (!r.active) continue;
      // Never over a file this run delivered. writeFileAtomic renames onto its
      // target, so a card carrying "001_note.md" of its own would have that
      // file replaced by the note: silently in FAST, and in SECURE the NOTE
      // would be the one quarantined while the card's file is missing from the
      // folder. The note steps aside to "001-2_note.md" instead.
      //
      // The suffix goes BEFORE "_note.md", not at the end of the path: Verify
      // recognises our own note by a name ending in "_note.md", so a note
      // called "001_note.md-2" would be reported as a stranger for ever.
      let notePath = path.join(r.destPath, noteFileName);
      if (r.copied.some(c => c.dest === notePath)) {
        const stem = counterSafe;
        notePath = path.join(r.destPath, `${stem}-${Date.now()}_note.md`);
        for (let i = 2; i < 1000; i++) {
          const cand = path.join(r.destPath, `${stem}-${i}_note.md`);
          if (!fs.existsSync(cand) && !r.copied.some(c => c.dest === cand)) { notePath = cand; break; }
        }
        (r.notes || (r.notes = [])).push({
          code: 'CV-10',
          text: `This card already held a file called ${noteFileName}.`,
          detail: `Your shooting note was saved next to it as ${path.basename(notePath)}. The card's own file was not touched.` });
      }
      try { writeFileAtomic(notePath, noteContent); }
      catch (e) {
        // The operator believes they left a note for the editor. It is not on
        // the drive, so the window has to say it.
        console.error('Note file write failed:', e.message);
        (r.notes || (r.notes = [])).push({
          code: 'CV-9',
          text: `The shooting notes were not saved to ${path.basename(r.destPath || '') || 'the destination'}.`,
          detail: 'Your note is still in ingesto and in the ingest report.' });
      }
    }
  }
}

function dropUnpromotedTemps(run) {
  const { R } = run;
  // Clear the temp files THIS run opened and did not promote (a cancelled
  // run). Never a walk of the folder: a walk would delete a delivered file
  // whose name ends in ".ingesto-part" (on a retry, one that an earlier run
  // has already verified).
  // Each error path above already drops its own temp; this loop is the last
  // resort for a file that left none of those paths.
  //
  // And never a path this run DELIVERED under its final name. The temp name of
  // one file is the final name of another when a card carries both "X.MOV" and
  // "X.MOV.ingesto-part": the sweep would then delete the delivered
  // X.MOV.ingesto-part because the run registered that exact path as its own
  // temp. PF-E10 refuses that card before a byte is written, so this line is a second lock
  // on the same door: a delete driven by a NAME is never left unguarded.
  for (const r of R) {
    const delivered = new Set(r.copied.map(c => c.dest));
    for (const tmp of r._tmps) {
      if (delivered.has(tmp)) continue;
      try { if (fs.existsSync(tmp)) safeUnlink(tmp); } catch (_) {}
    }
  }
}

// The verification pass, in three steps that share `pass` (built by
// verifyDestinations): its byte counters and the progress messages.
//
// Every destination read back and compared with the fingerprints taken while
// copying (SIZE CHECK compares sizes only).
async function verifyEachDestination(run, pass) {
  const { isPro, isSecure, proAlgo, hasher, hdeSource, proDouble, R } = run;
  const { emitDest } = pass;
  // 2a — verify every destination against the fingerprint taken during copy.
  //
  // Destinations are verified CONCURRENTLY, but only when they sit on
  // different physical devices. Two folders on the same disk are read one
  // after the other: making that disk seek between two streams is slower
  // than reading them in turn. The grouping reads the machine's actual
  // topology (the filesystem's device id) instead of guessing from paths.
  //
  // Worst case is "no gain", never a regression: the reads are asynchronous
  // and the total amount of hashing is unchanged, so if the fingerprint
  // calculation is what saturates, the lanes simply take turns on it.
  const lanes = groupByDevice(R, r => r.destPath);
  // ONE HASHER PER LANE. hashPro() calls hasher.init() then streams into it;
  // two concurrent calls on the same instance would interleave their updates
  // and produce a digest belonging to neither file — a silent false
  // "checksum mismatch", the worst possible failure for this application.
  const laneHashers = [];
  for (let i = 0; i < lanes.length; i++) {
    laneHashers.push(!hasher ? null
      : (i === 0 ? hasher : await newProHasher(isPro ? proAlgo : 'xxh64')));
  }

  const runLane = async (group, laneHasher) => {
    for (const r of group) {
      if (!r.copied.length) continue;   // nothing was written here
      for (const c of r.copied) {
        if (ctl.cancelCopy) return;
        await pauseGate();
        if (ctl.cancelCopy) return;
        let okv=false;
        try {
          if (isPro || isSecure) {
            // Evict this destination file's cached pages first, so the
            // read-back is forced to hit the disk. On macOS the uncached write
            // already kept most pages out (APFS); this covers Windows/Linux —
            // where the copy is fully cached and the read-back would otherwise
            // compare RAM with itself — and exFAT/NTFS destinations on macOS, whose
            // drivers ignore F_NOCACHE. The RESULT is kept: a failed purge
            // (antivirus holding the file, exotic filesystem) means this
            // read-back may come from RAM, and coldVerify must say so.
            try { if (!nocache.purgeFileCache(c.dest)) r._purgeFails = (r._purgeFails||0) + 1; }
            catch(_) { r._purgeFails = (r._purgeFails||0) + 1; }
            if (await hashPro(c.dest,laneHasher) !== c.srcHash) throw new Error(isPro?'checksum mismatch':'xxHash mismatch');
          } else {
            // Two reads, and they are not the same side. A source file that
            // vanished mid-run must not be blamed on the drive.
            let srcSize;
            // HDE: the volume cannot give the size back (see the copy);
            // the size compared is the number of bytes it delivered.
            if (hdeSource) srcSize = c.size;
            else {
              if (run.sourceStalled) { const err = new Error(`not checked: ${run.sourceStalled.message}`); err._origin = 'source'; throw err; }
              const sr = await statWithin(c.src, SOURCE_STALL_MS);
              if (sr.timeout) run.sourceStalled = stallError('a file could not be measured');
              if (sr.timeout || sr.err) { const err = new Error(sr.timeout ? run.sourceStalled.message : sr.err.message); err._origin = 'source'; throw err; }
              srcSize = sr.v.size;
            }
            if (srcSize !== fs.statSync(c.dest).size) throw new Error('Size mismatch');
          }
          okv=true;
        } catch(e){
          // A verify mismatch is a DESTINATION failure: the card gave the
          // same bytes, the drive gave back something else.
          r.errors++; r.errorList.push({file:c.rel,error:e.message,phase:'verify',
                                        origin: e._origin || 'destination'});
          r.failedFiles.push(c.rel); r.failedMap[c.rel]=c.destRel;
          // Quarantine the bad copy. Otherwise it would keep its FINAL name
          // while being left out of the checksum list, so if the operator
          // never runs "Re-copy failed files" the folder holds a corrupt clip
          // under its real name, and a later Verify on that folder lists it
          // merely as an "extra file" and still reports "Verification passed".
          // The whole point of the .ingesto-part protocol is that a real name
          // means a good file; this holds it for the verify phase too.
          // Remember the EXACT name it was set aside under: a retry deletes
          // from this list only. Deleting by name pattern ("<rel>.ingesto-failed"
          // and every "-2…-N") would erase a delivered, verified file that
          // happens to carry that name on the card.
          try { const q = freeName(c.dest + FAILED_SUFFIX);
                safeRename(c.dest, q); c._quarantined = true;
                (r.quarantinedPaths || (r.quarantinedPaths = [])).push(q); }
          catch(_) {
            // The bad copy is still sitting there under its REAL name. Left
            // silent, a later Verify would list it merely as an "extra file"
            // and still report "Verification passed". Say it explicitly.
            r.errorList.push({ file:c.rel, phase:'verify', origin:'destination', notQuarantined:true,
              destRel:c.destRel||c.rel,
              error:'this file failed verification and could NOT be set aside. A bad copy is still in the destination under its real name. Delete it by hand or re-copy the card.' });
          }
        }
        c._writeOk = okv;
        if (okv && !proDouble) {
          r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
          if (isPro || isSecure) r.cksumEntries.push({ rel:c.destRel||c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
        }
        pass.verifiedBytes+=c.size; pass.passBytes+=c.size; pass.verifiedFiles++;
        r._vBytes += c.size;
        emitDest(r, c.rel, r._vBytes >= r._vTotal);
      }
      // This destination is finished: say so even if the throttle just ate
      // the last update, or its bar would sit at 97% for the rest of the run.
      emitDest(r, '', true);
    }
  };
  await Promise.all(lanes.map((g, i) => runLane(g, laneHashers[i])));
  run.tV1End = Date.now(); run.tV2End = run.tV1End;
  run.pausedAtV1End = run.pausedAtV2End = ctl.pausedMs;
}

// PRO + DOUBLE READ: the card read a second time, once whatever the number of
// destinations.
async function rereadCard(run, pass) {
  const { hasher, proDouble, destNames, R } = run;
  const { srcByRel, srcPassTotal, emit } = pass;
  // 2b — PRO double-read: re-read the SOURCE (once, whatever the number of
  // destinations) to catch a failing/unstable card.
  if (proDouble && !ctl.cancelCopy) {
    pass.passBytes=0; pass.passTotal=srcPassTotal;
    // Measure ONCE, before re-reading anything, whether cache eviction really
    // works on this card in this machine. This is the guarantee the whole
    // double read rests on, so it is tested rather than inferred.
    var probe = { ok:false };
    for (const c of srcByRel.values()) {
      if (c.size >= 1024*1024) { probe = probeCacheEviction(c.src); break; }
    }
    // Which destinations hold a good write of each file, built ONCE. Looking
    // it up with R.filter(...copied.some(...)) for every file costs the square
    // of the file count: about 10 s of CPU on a 30,000-file stills card,
    // billed to the second read.
    const writtenOk = new Map();
    for (const r of R) for (const x of r.copied) {
      if (!x._writeOk) continue;
      let list = writtenOk.get(x.rel);
      if (!list) { list = []; writtenOk.set(x.rel, list); }
      if (!list.includes(r)) list.push(r);
    }
    for (const c of srcByRel.values()) {
      if (ctl.cancelCopy) break;
      await pauseGate();
      if (ctl.cancelCopy) break;
      // Only meaningful if at least one destination wrote this file OK
      const holders = R.filter(r => (writtenOk.get(c.rel) || []).includes(r));
      if (holders.length) {
        let stable=false;
        // Evict this file's cached pages first, so the re-read is forced to
        // hit the card. Without it the OS answers from RAM and this whole
        // pass compares memory with itself (see purgeFileCache).
        // A card that stopped answering is not "unstable": it gave no
        // second answer at all. Said as such, and not asked again.
        let silent = run.sourceStalled;
        if (!silent) { const pre = await statWithin(c.src, SOURCE_STALL_MS); if (pre.timeout) silent = run.sourceStalled = stallError('a file could not be opened'); }
        if (!silent) {
          let purged = false;
          try { purged = nocache.purgeFileCache(c.src); } catch(_) {}
          if (!purged) run.dblPurgeFails++;
          try { stable = (await hashPro(c.src, hasher, { stallMs: SOURCE_STALL_MS }) === c.srcHash); }
          catch(e){ stable=false; if (e && e.stalled) silent = run.sourceStalled = e; }
        }
        for (const r of holders) {
          if (silent) {
            r.errors++;
            // The copy itself was verified: it is not a failed file, and a
            // re-copy would not help. Like an unstable file, it is left out
            // of the manifest and the card log.
            r.errorList.push({ file:c.rel, error:`not re-read: ${silent.message}`, phase:'source', origin:'source', stalled:true });
          } else if (stable) {
            r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
            r.cksumEntries.push({ rel:c.destRel||c.rel, hash:c.srcHash, size:c.size, mtimeMs:c.mtimeMs });
          } else {
            r.errors++;
            r.errorList.push({ file:c.rel, error:'source read unstable', phase:'source' });
            r.unstableFiles.push(c.rel);
          }
        }
      }
      pass.verifiedBytes+=c.size; pass.passBytes+=c.size; pass.verifiedFiles++;
      emit(c.rel,'source',0,destNames);
    }
    run.tV2End = Date.now(); run.pausedAtV2End = ctl.pausedMs;

    // ── Was the source actually re-read, or served from RAM? ─────────────
    // The whole point of the PRO double read is to ask the CARD a second
    // time. If the OS page cache answers instead, the pass compares memory
    // with itself and always passes — worse than useless, because it looks
    // like a guarantee.
    //
    // The verdict comes from the probe above (a measurement, see
    // probeCacheEviction), not from comparing pass speeds. Two triggers, one
    // remedy — the forced unmount/remount re-check:
    //   • the probe showed the eviction does not work on this medium, or
    //   • an eviction call outright failed during the pass.
    // A probe that could not run (every file under 1 MB, timings too small to
    // compare) says nothing and does NOT raise an alarm; dblPurgeFails still
    // covers the case where the mechanism is plainly unavailable.
    const copyMs = Math.max(1, run.tCopyEnd - run.tCopyStart);
    const dblMs  = Math.max(1, run.tV2End - run.tV1End);
    const copySpeed = run.copiedBytes / (copyMs / 1000);
    const dblSpeed  = srcPassTotal / (dblMs / 1000);
    const probeSaysCached = probe.ok && !probe.evicted;
    if (srcPassTotal > 0 && (probeSaysCached || run.dblPurgeFails > 0)) {
      for (const r of R) {
        r.doubleReadCached = true;
        r.doubleReadSpeed  = dblSpeed;
        r.copySpeedMeasured = copySpeed;
        // Only when the PROBE is what raised the alarm. When the trigger was
        // a purge that failed mid-pass, showing a 50x separation under the
        // words "too close to be a real read" contradicts the alarm itself.
        r.probe = probeSaysCached ? { coldMs: probe.coldMs, warmMs: probe.warmMs } : null;
        // Source-relative path + the hash read during the copy, so the user
        // can ask for a real (unmount/remount) re-check afterwards.
        r.recheckList = [...srcByRel.values()]
          .filter(c => c.srcHash)
          .map(c => ({ rel: c.rel, hash: String(c.srcHash) }));
      }
      // One entry, on one result only: the source pass happens once per
      // card, and on every result a 3-destination ingest would list the same
      // line thrice.
      // Wording is aimed at non-technical operators: what happened, and that
      // their footage is fine.
      R[0].errorList.push({ file: '(card double-check)', phase: 'warning',
        error: `skipped: the card could not be read a second time, the computer answered from its memory. All files are still fully verified (SECURE level).` });
    }
  }
}

// The checksum lists and manifests written beside the footage (SECURE, PRO).
async function writeManifests(run) {
  const { options, t0, isPro, isSecure, proAlgo, cksumAlgo, R } = run;
  // Fingerprint sidecars at each destination folder root (SECURE & PRO).
  // A sidecar that cannot be written goes into errorList, not into r.errors,
  // so `ok` stays true; on that alone the window would say "Complete!", the
  // tick would be green and EJECT would light up over a drive holding no
  // manifest at all. The whole
  // point of PRO is that the manifest exists. `sidecarFailed` carries it out
  // so the window can say it and the EJECT button can refuse.
  for (const r of R) {
    const wantCk = !ctl.cancelCopy && !options.fixedDestPath && options.writeChecksum !== false
                   && (isPro || isSecure) && r.cksumEntries.length;
    if (wantCk && options.cksumList !== false) {
      const ckName = writeChecksumList(r.destPath, cksumAlgo, r.cksumEntries);
      if (!ckName) { r.errorList.push({ file:'(checksum list)', error:'could not be written to destination', phase:'sidecar' });
                       r.sidecarFailed = (r.sidecarFailed||[]).concat(['checksum list']); }
    }
    if (wantCk && isPro && options.cksumMhl === true && (proAlgo==='xxh64'||proAlgo==='md5')) {
      const mhlName = writeMHL(r.destPath, proAlgo, r.cksumEntries, { startMs:t0 });
      if (!mhlName) { r.errorList.push({ file:'(MHL manifest)', error:'could not be written to destination', phase:'sidecar' });
                       r.sidecarFailed = (r.sidecarFailed||[]).concat(['MHL manifest']); }
    }
    // ASC MHL comes IN ADDITION to the classic manifest, and covers every
    // algorithm ingesto can produce — not only the two the 2005 format knew.
    if (wantCk && options.ascMhl === true) {
      const ascName = await writeAscMhl(r.destPath, cksumAlgo, r.cksumEntries, { startMs:t0 });
      if (!ascName) { r.errorList.push({ file:'(ASC MHL manifest)', error:'could not be written to destination', phase:'sidecar' });
                       r.sidecarFailed = (r.sidecarFailed||[]).concat(['ASC MHL manifest']); }
    }
  }
}

// The checks of the mode: destinations re-read (SIZE CHECK, SECURE, PRO), the
// card re-read (PRO + DOUBLE READ), and the checksum manifests.
async function verifyDestinations(run) {
  const { source, options, onProgress, isPro, isSecure, proDouble, R, spd, speedPush, avgSpd } = run;
  // ── PHASE 2 — VERIFY each destination (blue), then optional source pass ─
  if (!ctl.cancelCopy && (options.mode === MODE.SIZE_CHECK || isSecure || isPro)) {
    const pass = {};
    spd.length=0;
    // Unique source files copied OK to at least one destination (for the PRO
    // double-read pass, which reads the source ONCE, not once per dest).
    const srcByRel = new Map();
    for (const r of R) for (const c of r.copied) if (!srcByRel.has(c.rel)) srcByRel.set(c.rel, c);
    const destPassTotal = R.reduce((a,r)=>a + r.copied.reduce((x,c)=>x+c.size,0), 0);
    const srcPassTotal  = proDouble ? [...srcByRel.values()].reduce((a,c)=>a+c.size,0) : 0;
    const verifyTotalBytes = destPassTotal + srcPassTotal;
    const totalSteps = R.reduce((a,r)=>a+r.copied.length,0) + (proDouble ? srcByRel.size : 0);
    pass.verifiedBytes = 0; pass.verifiedFiles = 0; let lastB=0; let lastT=Date.now();
    pass.passBytes = 0; pass.passTotal = destPassTotal;
    const emit=(cur,pass,di,dn,extra)=>{
      const now=Date.now();
      if (now-lastT>=120){ speedPush(pass.verifiedBytes-lastB,now-lastT); lastB=pass.verifiedBytes; lastT=now; }
      const sp=avgSpd();
      onProgress({ sourceName:source.name, sourcePath:source.path, currentFile:cur, phase:'verify',
        destIndex:di, destName:dn,
        copiedFiles:pass.verifiedFiles, totalFiles:totalSteps, remainingFiles:totalSteps-pass.verifiedFiles,
        copiedBytes:pass.verifiedBytes, totalBytes:verifyTotalBytes||1,
        progress:verifyTotalBytes>0?pass.verifiedBytes/verifyTotalBytes:1,
        passProgress: pass.passTotal>0 ? pass.passBytes/pass.passTotal : 1,
        speed:sp, eta:sp>0?(verifyTotalBytes-pass.verifiedBytes)/sp:0,
        errors:R.reduce((a,r)=>a+r.errors,0), pass, ...(extra||{}) });
    };

    // Per-destination progress and throughput. Each destination reports its
    // own progress and its own speed. With ONE cumulative figure for the whole
    // pass, the renderer would have to work out each destination's share by
    // arithmetic, which is error-prone and becomes meaningless once
    // destinations are verified at the same time.
    for (const r of R) {
      r._vTotal = r.copied.reduce((a,c)=>a+c.size, 0);
      r._vBytes = 0; r._vSpd = []; r._sB = 0; r._sT = Date.now(); r._lastEmit = 0;
    }
    const destSpeed = (r) => {
      const now = Date.now(), ms = now - r._sT;
      if (ms >= 150) {
        r._vSpd.push((r._vBytes - r._sB) / ms * 1000);
        if (r._vSpd.length > 12) r._vSpd.shift();
        r._sB = r._vBytes; r._sT = now;
      }
      return r._vSpd.length ? r._vSpd.reduce((a,b)=>a+b) / r._vSpd.length : 0;
    };
    const emitDest = (r, cur, force) => {
      const now = Date.now();
      // Several lanes reporting per file would flood the renderer; one update
      // per destination per 100 ms is more than the eye can follow, and the
      // last file of a destination always gets through.
      if (!force && now - r._lastEmit < 100) return;
      r._lastEmit = now;
      emit(cur, 'dest', r.di, r.name, {
        destProgress: r._vTotal > 0 ? Math.min(1, r._vBytes / r._vTotal) : 1,
        destSpeed: destSpeed(r),
      });
    };
    Object.assign(pass, { srcByRel, srcPassTotal, emit, emitDest });
    await verifyEachDestination(run, pass);
    await rereadCard(run, pass);
    await writeManifests(run);
  } else if (!ctl.cancelCopy) {
    // FAST mode — no verification; every copied file is recorded for the sentinel.
    // A CANCELLED run must never land here: this branch would declare every
    // copied file good, which would then feed the ingest report's "verified"
    // file list.
    for (const r of R) for (const c of r.copied)
      r.copiedForSentinel.push({ p:c.rel.replace(/\\/g,'/'), s:c.size, m:Math.floor(c.mtimeMs/1000), ...(c.destRel&&c.destRel!==c.rel?{d:c.destRel}:{}) });
  }
}

// One result object per destination: what the window, the reports and the
// card journal read.
function buildResults(run) {
  const { source, options, t0, isPro, isSecure, proAlgo, proDouble, R, scanErrors } = run;
  return R.map(r => makeResult({
    // Copying zero files out of a non-empty card is a failure, not a success.
    success: !ctl.cancelCopy && !r.errors && !scanErrors.length
             && !(run.totalFiles > 0 && r.copiedFiles === 0),
    canceled: ctl.cancelCopy,
    scanIncomplete: scanErrors.length > 0,
    // True when read-back verification actually bypassed the OS cache (macOS).
    // When false in SECURE/PRO, the UI suggests a later cold Verify.
    // True only when the machine CAN defeat the cache AND no destination
    // read-back purge failed. Capability alone is not enough: on a Windows
    // box where an antivirus holds each fresh file open, every purge fails
    // and the read-back comes from RAM — the "check again later" hint must
    // then reappear instead of being silenced by a mechanism that exists but
    // didn't work. (The PRO card re-read has its own guard: doubleReadCached.)
    coldVerify: (isPro || isSecure) ? (nocache.available() && !(r._purgeFails > 0)) : null,
    // True when the PRO source re-read was demonstrably answered by the OS
    // cache rather than the card — the pass proves nothing in that case.
    doubleReadCached: !!r.doubleReadCached,
    doubleReadSpeed: r.doubleReadSpeed || 0,   // bytes/s of the source re-read
    // Probe timings (ms for an 8 MB block, cold vs warm) when the double read
    // was judged cached — useful in a bug report, never shown as-is.
    cacheProbe: r.probe || null,
    copySpeed: r.copySpeedMeasured || 0,       // bytes/s sustained while copying
    recheckList: r.recheckList || null,        // {rel,hash}[] for a forced re-check
    proAlgoUsed: isPro ? proAlgo : null,
    sourceName: source.name, sourcePath: source.path, destPath: r.destPath,
    // Where the card landed, relative to the destination root — what the
    // ingest report records, so the report never describes a structure that
    // does not exist on the drive.
    relFolder: r.relFolder || '',
    totalFiles: run.totalFiles, copiedFiles: r.copiedFiles, totalBytes: run.totalBytes, copiedBytes: run.copiedBytes,
    // Files passed over because a verified copy already sits on this
    // destination ("copy new files only"). Recorded so that "2 of 2 copied"
    // can never pass for a whole card without saying what was left out.
    skippedFiles: run.skippedAlready,
    errors: r.errors, errorList: r.errorList,
    // Remarks: things that did not happen, on a run where nothing failed. They
    // go in an orange block under the destinations, on a window whose title
    // stays green. Nothing failed; something was not done.
    notes: r.notes || [],
    // 'no-files' or 'filtered-out' when the card produced nothing to copy.
    // The count of files WALKED on the card, always, not only on a card that
    // produced nothing. Set in one branch only, every successful run would
    // report "0 files on the card" while also reporting files copied: a
    // handoff document would then say 0 on card and 5 copied, and refuse itself.
    emptyReason: r.emptyReason || null, seenFiles: run.seenFiles,
    // Which sidecars this destination is missing. Empty on a normal run.
    sidecarFailed: r.sidecarFailed || [],
    // The exact paths this run set aside as *.ingesto-failed, so a retry can
    // drop those and nothing else.
    quarantinedPaths: r.quarantinedPaths || [],
    failedFiles: r.failedFiles, failedMap: r.failedMap, unstableFiles: r.unstableFiles,
    _cksumEntries: r.cksumEntries,
    mode: options.mode, proAlgo: isPro ? proAlgo : null,
    // Whether the card was read a second time. The summary shows it as an
    // option of the mode ("PRO + DOUBLE READ"); inferring it from verify2Ms
    // would call a pass that finished in under a millisecond a single read.
    proDoubleRead: proDouble,
    // Each phase minus the time the operator held it paused.
    copyMs:    Math.max(0, (run.tCopyEnd-run.tCopyStart) - (run.pausedAtCopyEnd-run.pausedAtCopyStart)),
    verify1Ms: Math.max(0, (run.tV1End-run.tCopyEnd)     - (run.pausedAtV1End-run.pausedAtCopyEnd)),
    verify2Ms: Math.max(0, (run.tV2End-run.tV1End)       - (run.pausedAtV2End-run.pausedAtV1End)),
    // Pause excluded here as well: the four summary tiles are COPY + V1 + V2
    // against TOTAL, and leaving pause in only the total would make them
    // contradict each other on screen.
    duration: Math.max(0, (Date.now()-t0) - ctl.pausedMs),
    _copiedForSentinel: r.copiedForSentinel,
  }));
}

// Copy one source to every destination. Returns one result object PER
// destination.
async function performCopyMulti(source, destinations, options, onProgress) {
  const run = await startRun(source, destinations, options, onProgress);
  const refusal = refuseBeforeStart(run);
  if (refusal) return refusal;
  initDestinationResults(run);
  const refused = await scanCard(run);
  if (refused) return refused;
  // Nothing to copy (an empty card, or a filter that excludes every file):
  // the run stops here and writes nothing, not even the card's folder. An
  // empty folder would take a counter value and read as an ingested card.
  if (run.nothingToCopy) return buildResults(run);
  await prepareDestinations(run);
  await copyCard(run);
  finishCopy(run);
  dropUnpromotedTemps(run);
  await verifyDestinations(run);
  return buildResults(run);
}

module.exports = { groupByDevice, emptyRunReason, performCopyMulti };
