/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Holds one comparison in memory and drives it through to synchronization.
// The renderer never receives the whole tree: it asks for windows of rows and
// sends back edits by index. That keeps a 200 000-file comparison responsive.

const { Comparer, CAT, OP, CHECKSUM_FILE } = require('./compare');
const { PathFilter } = require('./filter');
const { applyDirections, computeStats, operationFor, applyFolderRules,
        detectMoves, dissolveMove, usesDatabase } = require('./direction');
const { loadPairDb, savePairDb, buildSession, pairIdFor, readSideSession } = require('./db');
const { SyncRunner } = require('./sync');
const { FsPool, parseLocation, redactLocation } = require('../fs/afs');
const { NativeFs } = require('../fs/native');
const { buildReport, toHtml, toCsv, toJson } = require('./report');
const { formatChecksumList, parseChecksumList, createHasher, hashStream } = require('./hash');
const { acquireAll, clearStaleLock, DETECT_ABANDONED_MS } = require('./lock');

class Session {
  constructor() {
    this.pool   = new FsPool();
    this.nodes  = [];
    this.stats  = null;
    this.errors = [];
    this.job    = null;
    this.left   = null;
    this.right  = null;
    this.db     = null;
    this.dbNote = null;
    this.byChange = false;
    this.comparedAt = 0;
  }

  async _openSides(job, credentials) {
    const l = parseLocation(job.left,  credentials);
    const r = parseLocation(job.right, credentials);
    if (!l.path || !r.path) throw new Error('Both folders must be set.');
    this.left  = await this.pool.open(l);
    this.right = await this.pool.open(r);
    this.leftPhrase  = l.phrase;
    this.rightPhrase = r.phrase;
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  async compare(job, opts) {
    const { onProgress, token, credentials } = opts || {};
    this.job = job;
    await this._openSides(job, credentials);

    const cmp = Object.assign({}, job.compare);

    // The database is read for two reasons: Two way and Update decide their
    // directions with it, and move detection needs the file ids it remembers.
    // A mirror job with move detection on therefore reads (and later writes)
    // the database too, even though its directions never depend on it.
    //
    // It is read BEFORE the scan, not after, for a third reason: it remembers
    // how many items these two folders held last time. Walking a tree has no
    // knowable total — you find out how big it is by finishing — so without
    // that number the interface cannot honestly show progress at all. With it,
    // a backup that runs every day can say "about 60%" and mean it.
    this.db = null; this.dbNote = null;
    this.pairId = pairIdFor(job.pairId, this.left.path, this.right.path);
    this.wantMoves = cmp.detectMoves !== false;
    if (usesDatabase(job.sync.variant) || this.wantMoves) {
      const { db, reason } = await loadPairDb(this.left, this.right, this.pairId);
      this.db = db;
      // "no database yet" is only worth mentioning when directions depend on it.
      this.dbNote = usesDatabase(job.sync.variant) ? reason : null;
    }
    this.expected = (this.db && this.db.items) ? Object.keys(this.db.items).length : 0;

    const comparer = new Comparer({
      left: this.left, right: this.right,
      config: cmp, token, onProgress,
      expected: this.expected,
    });
    const res = await comparer.run();
    this.nodes  = res.nodes;
    this.errors = res.errors;
    this.leftovers = res.leftovers || [];
    this.locks = res.locks || [];
    this.cancelled = !!res.cancelled;

    // A base folder that does not resolve is either gone or renamed, and the
    // two look identical from here. Ask the surviving side what it remembers.
    await this._inspectMissingRoots();

    const applied = applyDirections(this.nodes, job.sync, cmp, this.db);
    this.byChange = applied.byChange;
    this.movesFound = this.wantMoves ? detectMoves(this.nodes, this.db) : 0;
    this.stats = computeStats(this.nodes);
    // A cancelled comparison stopped somewhere in the middle of the tree.
    // Stamping it as compared let the interface re-enable SYNCHRONIZE on a
    // partial plan — only the scanned fraction would have been copied, and the
    // summary would have said "completed successfully".
    this.comparedAt = this.cancelled ? 0 : Date.now();

    return {
      count : this.nodes.length,
      stats : this.stats,
      errors: this.errors,
      // Lock files a previous run never cleared. Reported, never removed on
      // the way past: a lock file is the one thing standing between two
      // machines writing the same files.
      staleLocks: (this.locks || []).filter(l => l.stale),
      cancelled: this.cancelled,
      byChange: this.byChange,
      dbNote: this.dbNote,
      movesFound: this.movesFound,
      pairId: this.pairId,
      left  : this.left.path,
      right : this.right.path,
    };
  }

  // ── Grid access ──────────────────────────────────────────────────────────
  // view: { showEqual, showExcluded, search, onlyCategory, onlyOperation }
  _visibleIndices(view) {
    const v = view || {};
    const needle = (v.search || '').trim().toLowerCase();
    const out = [];
    // Filtering BY "no action" is itself a request to see those rows. The
    // window used to get there by switching "show identical" on behind the
    // user's back — which then got saved to the preferences and came back
    // ticked at every launch from then on.
    const askedForEqual = v.onlyOperation === OP.NONE;
    // Scoped to one folder, from a click in the overview: that folder and
    // everything under it, nothing else.
    const scope = v.scope && v.scope.rel ? v.scope.rel : '';
    for (const n of this.nodes) {
      if (scope && n.rel !== scope && !n.rel.startsWith(scope + '/')) continue;
      if (!v.showEqual && !askedForEqual && n.op === OP.NONE) continue;
      if (!v.showExcluded && !n.active) continue;
      if (v.onlyCategory && n.cat !== v.onlyCategory) continue;
      if (v.onlyOperation && n.op !== v.onlyOperation) continue;
      if (needle && !n.rel.toLowerCase().includes(needle)) continue;
      out.push(n.idx);
    }
    return out;
  }

  rows(offset, limit, view) {
    const idx = this._visibleIndices(view);
    const slice = idx.slice(offset || 0, (offset || 0) + (limit || 200));
    return {
      total: idx.length,
      pairs: 1,
      pairsShown: idx.length ? 1 : 0,
      rows : slice.map(i => this._row(this.nodes[i])),
    };
  }

  _row(n) {
    return {
      idx: n.idx, rel: n.rel, name: n.name, type: n.type, depth: n.depth,
      cat: n.cat, catMsg: n.catMsg, dir: n.dir, op: n.op, active: n.active,
      mv: n.movePair != null ? (this.nodes[n.movePair] ? this.nodes[n.movePair].rel : null) : null,
      l: n.left.exists  ? { size: n.left.size,  mtime: n.left.mtime  } : null,
      r: n.right.exists ? { size: n.right.size, mtime: n.right.mtime } : null,
    };
  }

  // ── Manual edits ─────────────────────────────────────────────────────────
  setDirection(indices, dir) {
    for (const i of indices) {
      const n = this.nodes[i];
      if (!n) continue;
      // Overriding one half of a move pair dissolves the pair: both rows fall
      // back to their plain copy/delete, then the requested direction applies.
      if (n.movePair != null) dissolveMove(this.nodes, n);
      n.dir = dir;
      n.op  = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  // Excluding a folder excludes everything inside it — the whole subtree is
  // expanded here so the grid, the overview and the Space shortcut all agree.
  _expand(indices) {
    const out = new Set();
    for (const i of indices) {
      const n = this.nodes[i];
      if (!n) continue;
      out.add(n.idx);
      if (n.type === 'folder') {
        const prefix = n.rel + '/';
        for (const d of this.nodes) if (d.rel.startsWith(prefix)) out.add(d.idx);
      }
    }
    return [...out];
  }

  setActive(indices, active) {
    for (const i of this._expand(indices)) {
      const n = this.nodes[i];
      if (n.movePair != null) dissolveMove(this.nodes, n);
      n.active = !!active;
      n.op = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  // Flip based on the clicked node's current state, applied uniformly to its
  // subtree — this is what Space and "Exclude temporarily" call.
  toggleActive(indices) {
    const first = this.nodes[indices[0]];
    if (!first) return this.stats;
    return this.setActive(indices, !first.active);
  }

  // Flips every direction, e.g. to turn a mirror right into a mirror left
  // without re-running the comparison.
  invertAll() {
    for (const n of this.nodes) {
      if (n.movePair != null) dissolveMove(this.nodes, n);
    }
    for (const n of this.nodes) {
      if (n.dir === 'left') n.dir = 'right';
      else if (n.dir === 'right') n.dir = 'left';
      n.op = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  visibleIndices(view) { return this._visibleIndices(view); }

  // ── Overview — one line per top-level item, like FreeFileSync's panel ────
  // Sizes count every file underneath (the larger of the two sides, so a
  // half-copied folder is not under-reported); pct is the share of the total.
  // Zone 2: where the work of this run sits, folder by folder.
  //
  // It used to walk every compared node, so two folders already in sync still
  // produced a full listing with percentage bars — a screen full of numbers
  // describing nothing to do. A row now has to carry actual work to appear,
  // and its size is the data that will really move, not the size of what is
  // already there. "Show identical" opts back into the whole tree, for when
  // you want to click a folder that is NOT changing and find it in the grid.
  overview(view) {
    const all = !!(view && view.showEqual);
    const groups = new Map();   // top-level rel -> { name, type, items, bytes, idx, active }
    for (const n of this.nodes) {
      const top = n.rel.includes('/') ? n.rel.slice(0, n.rel.indexOf('/')) : n.rel;
      let g = groups.get(top);
      if (!g) {
        g = { name: top, type: n.rel === top ? n.type : 'folder', items: 0, bytes: 0, idx: -1, active: true, work: 0 };
        groups.set(top, g);
      }
      // The top-level row itself is what the grid jumps to, so it is recorded
      // whatever it does — a folder is almost always "equal" while its
      // contents are not.
      if (n.rel === top) {
        g.idx = n.idx;
        g.active = n.active;
        if (n.type === 'folder') g.type = 'folder';
      }

      const busy = n.active && n.op !== OP.NONE && n.op !== OP.DO_NOTHING &&
                   n.op !== OP.MOVE_LEFT_FROM && n.op !== OP.MOVE_RIGHT_FROM;
      if (busy) g.work++;

      if (all) {
        if (n.rel !== top) g.items++;
        else if (n.type !== 'folder') g.items = 1;
        if (n.type !== 'folder') {
          g.bytes += Math.max(n.left.exists ? n.left.size || 0 : 0,
                              n.right.exists ? n.right.size || 0 : 0);
        }
      } else if (busy) {
        g.items++;
        // The bytes that will cross: the source side of a copy. A deletion
        // moves nothing, and a detected move is a rename — counting either
        // would inflate the bars with data that never travels.
        if (n.type !== 'folder') {
          if (n.op === OP.CREATE_RIGHT || n.op === OP.OVERWRITE_RIGHT) {
            g.bytes += n.left.exists ? (n.left.size || 0) : 0;
          } else if (n.op === OP.CREATE_LEFT || n.op === OP.OVERWRITE_LEFT) {
            g.bytes += n.right.exists ? (n.right.size || 0) : 0;
          }
        }
      }
    }
    const rows = [...groups.values()].filter(g => all || g.work > 0);
    const total = rows.reduce((s, g) => s + g.bytes, 0) || 1;
    rows.forEach(g => { g.pct = Math.round((g.bytes / total) * 100); });
    rows.sort((a, b) => b.bytes - a.bytes);
    return { rows, totalBytes: total === 1 ? 0 : total, identical: rows.length === 0 };
  }

  // Fills in what the surviving side knows about a missing one: whether these
  // two folders were ever synchronized, when, and whether a folder carrying
  // this pair's history is sitting next to the missing path under another name.
  //
  // Runs ONLY when a root is missing, so a normal comparison pays nothing.
  async _inspectMissingRoots() {
    for (const e of this.errors) {
      if (!e.missingRoot) continue;
      const other = e.missingRoot === 'left' ? this.right : this.left;
      const sess = await readSideSession(other.fs, other.path, this.pairId);
      if (!sess) continue;             // never synchronized: a genuinely new folder
      e.hadHistory = true;
      e.lastRun = sess.updated || 0;
      e.items = sess.items ? Object.keys(sess.items).length : 0;
    }
  }

  // A base folder that is GONE reads as an empty side, and an empty side plus
  // a mirror is a mass deletion of the healthy one. Returns the message to
  // refuse with, or null.
  //
  // This MUST be answered before the folder locks are taken: acquireAll
  // creates a base folder that is not there yet, so asking afterwards meant
  // the missing mount point existed by then — and the NEXT comparison, finding
  // an empty folder instead of a missing one, planned the mass deletion for
  // real.
  missingRootProblem() {
    for (const e of this.errors) {
      if (!e.missingRoot) continue;
      const otherSide = e.missingRoot === 'left' ? 'right' : 'left';
      const doomed = this.nodes.filter(n => n.active &&
        n.op === (otherSide === 'left' ? OP.DELETE_LEFT : OP.DELETE_RIGHT));
      if (doomed.length) {
        return `The ${e.missingRoot} folder is not there (${e.path}), which makes that side look empty — ` +
          `and this job would delete ${doomed.length} item${doomed.length > 1 ? 's' : ''} from the ${otherSide} side because of it. ` +
          `Reconnect the drive or fix the path, then compare again.`;
      }
      // Nothing would be DELETED, so the guard above stays quiet — and that is
      // exactly the case that let a renamed destination be copied again from
      // scratch, in full, beside the folder that already held it. A folder that
      // has a history and is no longer there is a problem whichever way the
      // files were about to move.
      if (!e.hadHistory) continue;
      const when = e.lastRun ? new Date(e.lastRun).toLocaleString() : 'an earlier run';
      return `The ${e.missingRoot} folder is not there (${e.path}), but it was synchronized on ${when}` +
        `${e.items ? ` and held ${e.items} items` : ''}. Copying everything again would duplicate it. ` +
        `Reconnect the drive or point that row at the right folder, then compare again.`;
    }
    return null;
  }

  // Everything that would make the run refuse, checked WITHOUT running it, so
  // the confirmation dialog can say it while the user still has a choice.
  // Returns [] when the job is good to go.
  async preflight(job, opts) {
    if (!this.nodes.length) return [];
    const missing = this.missingRootProblem();
    if (missing) return [{ message: missing, preflight: true }];
    const runner = new SyncRunner({
      left: this.left, right: this.right,
      nodes: this.nodes,
      config: Object.assign({}, job.sync),
      trashItem: (opts || {}).trashItem,
      token: { cancelled: false },
    });
    try {
      await runner.preflight(runner.buildPlan());
      return [];
    } catch (err) {
      return [{ message: err.message, preflight: !!err.preflight }];
    }
  }

  // ── Synchronize ──────────────────────────────────────────────────────────
  // opts.skipReport: MultiSession aggregates one report across pairs itself.
  async sync(job, opts) {
    const { onProgress, token, trashItem, appVersion, defaultReportFolder, skipReport } = opts || {};
    if (!this.nodes.length && !this.comparedAt) throw new Error('Run a comparison first.');

    // A folder that could not be READ during the comparison looks empty, and
    // an empty side plus a mirror is a mass deletion. FreeFileSync stops here
    // too: no synchronization on top of a broken comparison, ever.
    const fatal = this.errors.filter(e => e.fatal);
    if (fatal.length) {
      throw new Error(`The comparison could not read ${fatal.length === 1 ? 'a folder' : fatal.length + ' folders'} ` +
        `(${fatal[0].path}: ${fatal[0].message}) — synchronizing now could delete healthy files. Fix the error and compare again.`);
    }

    // A base folder that is GONE reads as an empty side, and an empty side plus
    // a mirror is a mass deletion of the healthy one. That is what happens when
    // an external drive is unmounted or a share drops: ENOENT, not EACCES, so
    // the fatal-error guard above never saw it. Creating a missing TARGET is
    // legitimate — deleting the other side because of it is not, so the run is
    // refused only when the plan actually removes something over there.
    const missing = this.missingRootProblem();
    if (missing) throw new Error(missing);

    const startedAt = Date.now();

    const runner = new SyncRunner({
      left: this.left, right: this.right,
      nodes: this.nodes,
      leftovers: this.leftovers || [],
      config: Object.assign({}, job.sync),
      token, onProgress, trashItem,
    });
    const run = await runner.run();
    const endedAt = Date.now();

    // Checksum sidecars, one per side that actually received data. The list is
    // MERGED with what is already there: each run only re-hashes what it
    // copied, and a sidecar reduced to today's three files would silently stop
    // vouching for the thousand verified last month.
    const sidecars = [];
    const wantList = !!job.sync.writeChecksumList;
    if (wantList) {
      for (const side of ['left', 'right']) {
        const list = run.checksums[side];
        if (!list.length) continue;
        const algo = 'xxh64';
        const target = this[side];
        const p = target.fs.join(target.path, CHECKSUM_FILE);
        try {
          const byRel = new Map();
          try {
            const prevText = await readText(target.fs, p);
            if (prevText != null) {
              const prev = parseChecksumList(prevText);
              if (!prev.algo || prev.algo === algo) {
                for (const e of prev.entries) byRel.set(e.rel, e);
              }
            }
          } catch (_) { /* unreadable previous list: start fresh */ }
          // Entries deleted or re-copied this run must not survive from the
          // old list with a stale hash.
          for (const [rel, res] of run.applied) if (res.deleted) byRel.delete(rel);
          for (const e of list) byRel.set(e.rel, e);
          const merged = [...byRel.values()].sort((a, b) => a.rel < b.rel ? -1 : 1);
          await writeText(target.fs, p, formatChecksumList(algo, merged, { pair: job.name, side }));
          sidecars.push(p);
        } catch (err) {
          run.notes.push(`Could not write the checksum list on the ${side} side: ${err.message}`);
        }
      }
    }

    // Update the database so the next run knows what "in sync" means — needed
    // by two-way/update for their directions, and by every variant for move
    // detection (the ids recorded now are tomorrow's rename evidence).
    let dbStamp = null;
    // A lock lost mid-run means another machine owns these folders now, and it
    // may already have written its own database there. Merging ours on top
    // would replace a real synchronous state with our partial one — the next
    // run would then decide two-way directions from a state that never existed.
    if (opts && typeof opts.lockLost === 'function' && opts.lockLost()) {
      run.notes.push('The synchronization database was NOT updated: the folder lock was lost, ' +
        'so another machine may already have written its own.');
    } else if (usesDatabase(job.sync.variant) || this.wantMoves) {
      try {
        const pairId = this.pairId || pairIdFor(job.pairId, this.left.path, this.right.path);
        // Entries hidden by the current hard filter keep their history.
        const pf = new PathFilter(job.compare.includeFilter, job.compare.excludeFilter);
        const keepRel = (rel, e) => (e.t === 'd' ? !pf.passFolder(rel) : !pf.passFile(rel));
        const session = buildSession(
          this.nodes, run.applied, this.db,
          job.compare.compareVariant || 'timeSize',
          this.left.path, this.right.path, keepRel);
        dbStamp = await savePairDb(this.left, this.right, pairId, session);
      } catch (err) {
        // This is an ERROR, not a note. A two-way run whose database was not
        // written looks perfect and lies to the next one: delete a file the
        // run had just created and the following run, reading yesterday's
        // database, puts it straight back. The report used to say "Completed
        // successfully" over exactly that.
        const msg = `The synchronization database could not be written (${err.message}). ` +
          `The next run will not know what this one did — two-way jobs may resurrect deleted files. ` +
          `Check the permissions and the free space on both folders.`;
        run.notes.push(msg);
        run.errors.push({ rel: '.syncto.db', message: msg });
        run.counters.errors++;
      }
    }

    // Report.
    const report = buildReport({
      appVersion,
      pairName: job.name, leftPath: this.left.path, rightPath: this.right.path,
      variant: job.sync.variant, compareVariant: job.compare.compareVariant,
      copyLevel: job.sync.copyLevel,
      deletion: job.sync.deletion, versioningStyle: job.sync.versioning.style,
      filter: { include: job.compare.includeFilter, exclude: job.compare.excludeFilter },
      startedAt, endedAt, run, stats: this.stats, comparisonErrors: this.errors,
    });

    const written = [];
    const rc = job.sync.report || {};
    if (rc.enabled && !skipReport) {
      const stamp = run.stamp.replace(/[: ]/g, '_');
      const baseName = `syncto_${(job.name || 'job').replace(/[^\w.-]+/g, '_')}_${stamp}`;
      // Reports never land inside a synchronized folder by default: the next
      // mirror run would see them as strays on the target and delete them.
      const outDir = rc.folder || defaultReportFolder || null;
      const targets = [];
      if (rc.html) targets.push([baseName + '.html', toHtml(report)]);
      if (rc.csv)  targets.push([baseName + '.csv',  toCsv(report)]);
      if (rc.json) targets.push([baseName + '.json', toJson(report)]);
      for (const [name, content] of targets) {
        try {
          if (outDir) {
            const nfs = this.pool.native;
            await nfs.mkdir(outDir);
            await writeText(nfs, nfs.join(outDir, name), content);
            written.push(nfs.join(outDir, name));
          } else {
            const t = this.right;
            const p = t.fs.join(t.path, name);
            await writeText(t.fs, p, content);
            written.push(p);
          }
        } catch (err) {
          run.notes.push(`Could not write the report ${name}: ${err.message}`);
        }
      }
    }

    this.lastResults = run.results;   // MultiSession reads these for its merged report
    return {
      counters : run.counters,
      verified : run.verified || 0,
      plan     : run.plan,
      errors   : run.errors,
      notes    : run.notes,
      cancelled: run.cancelled,
      stopped  : run.stopped,
      startedAt, endedAt,
      durationMs: endedAt - startedAt,
      reportFiles: written,
      checksumFiles: sidecars,
      dbStamp,
      report,
    };
  }

  async close() { await this.pool.closeAll(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// MultiSession — several folder pairs, one job, one merged view.
//
// Each pair keeps its own Session (its own tree, database, checksum sidecars).
// This layer runs them in sequence and presents ONE grid, ONE set of stats,
// ONE overview and ONE report to the outside world.
//
// Row addressing: a global index encodes (pair, node) as p*PAIR_BASE + idx, so
// the renderer keeps sending plain integers and never learns about pairs.
// The grid also receives synthetic header rows (one per pair) so the merged
// list stays readable.
// ═══════════════════════════════════════════════════════════════════════════

// Up to a billion items per pair. It used to be a million, which a single
// backup of a card archive can genuinely exceed — and when it did, item
// 1 000 000 of pair 0 got the same global index as item 0 of pair 1, so
// ticking a row in one pair silently changed a row in another. A billion is
// far past any real folder, and pair 0..9 000 000 still stays inside
// Number.MAX_SAFE_INTEGER. _split also refuses an index it cannot decode
// rather than acting on the wrong pair.
const PAIR_BASE = 1_000_000_000;

function mergeStats(list) {
  const out = {
    rows: 0, createLeft: 0, createRight: 0, updateLeft: 0, updateRight: 0,
    deleteLeft: 0, deleteRight: 0, moveLeft: 0, moveRight: 0,
    conflicts: 0, equal: 0, excluded: 0, doNothing: 0,
    bytesLeft: 0, bytesRight: 0, bytesTotal: 0, filesToProcess: 0,
    conflictList: [], catCounts: {},
  };
  for (const s of list) {
    if (!s) continue;
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'number') out[k] += s[k] || 0;
    }
    out.conflictList.push(...(s.conflictList || []).slice(0, 5));
    for (const c of Object.keys(s.catCounts || {})) {
      out.catCounts[c] = (out.catCounts[c] || 0) + s.catCounts[c];
    }
  }
  return out;
}

function pairLabel(p) {
  // Redacted FIRST. An sftp:// address with no path made `split('/').pop()`
  // return "user:secret@host", and that label travels into error rows, the
  // report and the body of the phone notification.
  const base = s => {
    const r = redactLocation(s);
    return r.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r;
  };
  return `${base(p.left)} → ${base(p.right)}`;
}

class MultiSession {
  constructor() {
    this.sessions = [];       // one Session per pair
    this.pairs = [];
    this.stats = null;
    this.comparedAt = 0;
  }

  _pairsOf(job) {
    const pairs = (Array.isArray(job.pairs) && job.pairs.length)
      ? job.pairs
      : [{ left: job.left || '', right: job.right || '' }];
    return pairs.filter(p => (p.left || '').trim() && (p.right || '').trim());
  }

  _split(gidx) {
    if (!Number.isSafeInteger(gidx) || gidx < 0) return { s: null, idx: -1, p: -1 };
    const p = Math.floor(gidx / PAIR_BASE);
    const idx = gidx % PAIR_BASE;
    const s = this.sessions[p];
    // A row index past the end of that pair means the caller is working from a
    // stale grid (a comparison finished in between). Doing nothing is the only
    // safe answer — the alternative is toggling whatever now sits there.
    if (!s || !Array.isArray(s.nodes) || idx >= s.nodes.length) return { s: null, idx: -1, p };
    return { s, idx, p };
  }

  async compare(job, opts) {
    const { onProgress, token, credentials } = opts || {};
    await this.close();
    // A failed or cancelled comparison must not leave yesterday's comparedAt
    // standing — sync() would happily run against half-compared sessions.
    this.comparedAt = 0;
    this.stats = null;
    this.pairs = this._pairsOf(job);
    if (!this.pairs.length) throw new Error('Set at least one folder pair.');
    this.sessions = this.pairs.map(() => new Session());
    const multi = this.pairs.length > 1;

    const perPair = [];
    const errors = [];
    let movesFound = 0, dbNote = null, cancelled = false;
    const lockSeen = new Map();
    let scannedBefore = 0, bytesBefore = 0;
    const startedAt = Date.now();
    for (let i = 0; i < this.pairs.length; i++) {
      if (token && token.cancelled) { cancelled = true; break; }
      const pairJob = Object.assign({}, job, {
        left: this.pairs[i].left, right: this.pairs[i].right,
        // A job-level pairId predates multi-pair: shared by every pair, it
        // would make them overwrite each other's session in a shared base
        // folder. Path-derived ids are unambiguous — use them.
        pairId: multi ? null : job.pairId,
      });
      // Every pair scans from zero, so a per-pair counter falls back to 0 at
      // each one and the ring empties and refills — which reads as a run
      // starting over rather than one making progress. What the window gets is
      // the RUNNING TOTAL across the whole comparison, plus where in the list
      // of pairs we are, so nothing on screen ever goes backwards.
      let lastScanned = 0, lastBytes = 0;
      const res = await this.sessions[i].compare(pairJob, {
        token, credentials,
        onProgress: p => {
          lastScanned = p.scanned || 0;
          lastBytes   = p.bytes || 0;
          if (onProgress) onProgress(Object.assign({}, p, {
            pair: i + 1, pairs: this.pairs.length, pairLabel: pairLabel(this.pairs[i]),
            pairIndex: i,
            scannedTotal: scannedBefore + lastScanned,
            bytesTotal  : bytesBefore + lastBytes,
            elapsedMs   : Date.now() - startedAt,
          }));
        },
      });
      // Carry the pair's own final counts forward, not a derived number: this
      // has to match the last figure the window was shown, or the total jumps
      // at every pair boundary.
      scannedBefore += lastScanned;
      bytesBefore   += lastBytes;
      perPair.push(res);
      movesFound += res.movesFound || 0;
      if (res.cancelled) cancelled = true;
      if (res.dbNote && !dbNote) dbNote = res.dbNote;
      errors.push(...res.errors.map(e => Object.assign({}, e, { pair: i + 1 })));
      // Two pairs can share a base folder; its lock must be listed once.
      for (const l of res.staleLocks || []) if (!lockSeen.has(l.path)) lockSeen.set(l.path, l);
    }

    this.stats = mergeStats(this.sessions.map(s => s.stats));
    // Same rule as a single pair: a comparison that was interrupted — in the
    // middle of a pair or between two of them — is not a comparison. Stamping
    // it here undid the deliberate reset at the top of this method.
    this.comparedAt = cancelled ? 0 : Date.now();
    return {
      count: this.sessions.reduce((n, s) => n + s.nodes.length, 0),
      stats: this.stats,
      cancelled,
      errors,
      staleLocks: [...lockSeen.values()],
      movesFound,
      dbNote,
      pairs: this.pairs.map((p, i) => ({ ...p, label: pairLabel(p), stats: perPair[i] && perPair[i].stats })),
      left : this.pairs[0].left,
      right: this.pairs[0].right,
    };
  }

  // One header pseudo-row per pair (only when there are several), followed by
  // that pair's visible rows carrying globalized indices.
  // A scope names ONE pair's folder, so the other pairs drop out entirely —
  // otherwise clicking "Rushes" in the overview would also show a "Rushes"
  // that happens to exist in another pair.
  _inScope(p, view) {
    const sc = view && view.scope;
    return !sc || sc.p === undefined || sc.p === null || sc.p === p;
  }

  rows(offset, limit, view) {
    const multi = this.sessions.length > 1;
    const all = [];
    let shown = 0;
    for (let p = 0; p < this.sessions.length; p++) {
      if (!this._inScope(p, view)) continue;
      const s = this.sessions[p];
      const vis = s._visibleIndices(view);
      // A heading with nothing under it says nothing. A pair that is entirely
      // in sync — the ordinary state of a backup that is kept up to date —
      // used to leave its heading behind, so five synchronized pairs produced
      // a list of five rows that looked like work and hid the "nothing to do"
      // message the window has for exactly this case.
      if (vis.length) { if (multi) all.push({ hdr: true, p }); shown++; }
      for (const i of vis) all.push({ p, i });
    }
    const slice = all.slice(offset || 0, (offset || 0) + (limit || 200));
    return {
      total: all.length,
      pairs: this.sessions.length,
      pairsShown: shown,
      rows: slice.map(e => {
        if (e.hdr) {
          const pr = this.pairs[e.p];
          const st = this.sessions[e.p].stats || {};
          return {
            hdr: true, idx: -1,
            pair: e.p + 1, pairs: this.pairs.length,
            left: pr.left, right: pr.right, label: pairLabel(pr),
            todo: st.filesToProcess || 0,
          };
        }
        const r = this.sessions[e.p]._row(this.sessions[e.p].nodes[e.i]);
        r.idx = e.p * PAIR_BASE + r.idx;
        if (r.mv != null) r.mv = r.mv;   // rel string, display only
        return r;
      }),
    };
  }

  // Where a row's item actually lives, for "Reveal in Finder". Resolved here
  // rather than in the window: the renderer knows a row index and a relative
  // path, not which pair it belongs to, which side is a server, or how that
  // side spells the name (a Mac stores accents decomposed, a Linux share
  // composed — handing the wrong spelling to the Finder reveals nothing).
  //
  // Returns { ok, path } or { ok:false, error }.
  locate(gidx, side) {
    const { s, idx } = this._split(gidx);
    if (!s || !s.nodes || !s.nodes[idx]) return { ok: false, error: 'That row is no longer there — compare again.' };
    const node = s.nodes[idx];
    const base = side === 'left' ? s.left : s.right;
    if (!base) return { ok: false, error: 'That side is not open.' };

    // A server has no Finder window. Say so rather than doing nothing.
    if (base.kind && base.kind !== 'native') {
      return { ok: false, error: 'That side is on a server, so it cannot be opened in a file window.' };
    }

    const state = side === 'left' ? node.left : node.right;
    if (!state || !state.exists) {
      return { ok: false, error: 'That item does not exist on this side — nothing to reveal.',
               fallback: base.path };
    }
    const rel = (side === 'left' ? node.relL : node.relR) || node.rel;
    return { ok: true, path: base.fs.join(base.path, ...rel.split('/')) };
  }

  _apply(indices, fn) {
    const bySession = new Map();
    for (const g of indices) {
      const { s, idx } = this._split(g);
      if (!s) continue;
      if (!bySession.has(s)) bySession.set(s, []);
      bySession.get(s).push(idx);
    }
    for (const [s, list] of bySession) fn(s, list);
    this.stats = mergeStats(this.sessions.map(s => s.stats));
    return this.stats;
  }

  setDirection(indices, dir) { return this._apply(indices, (s, l) => s.setDirection(l, dir)); }
  setActive(indices, act)    { return this._apply(indices, (s, l) => s.setActive(l, act)); }
  toggleActive(indices)      { return this._apply(indices, (s, l) => s.toggleActive(l)); }

  invertAll() {
    for (const s of this.sessions) s.invertAll();
    this.stats = mergeStats(this.sessions.map(s => s.stats));
    return this.stats;
  }

  // Global indices, in the same order as rows() (headers excluded — these are
  // selectable data rows only).
  visibleIndices(view) {
    const out = [];
    for (let p = 0; p < this.sessions.length; p++) {
      if (!this._inScope(p, view)) continue;
      for (const i of this.sessions[p]._visibleIndices(view)) out.push(p * PAIR_BASE + i);
    }
    return out;
  }

  overview(view) {
    const rows = [];
    let total = 0;
    for (let p = 0; p < this.sessions.length; p++) {
      const ov = this.sessions[p].overview(view);
      // Biggest first WITHIN a pair, and pairs kept in their own order. Sorting
      // every pair's folders into one list by size interleaved them with no
      // visible clue where each came from, which read as a random jumble of
      // root folders and sub-folders.
      ov.rows.sort((a, b) => b.bytes - a.bytes);
      ov.rows.forEach((g, i) => {
        g.idx = g.idx >= 0 ? p * PAIR_BASE + g.idx : -1;
        g.pairIdx = p;
        g.pair = p + 1;
        g.pairLabel = pairLabel(this.pairs[p]);
        g.first = i === 0;               // the renderer puts a heading here
        rows.push(g);
      });
      total += ov.totalBytes;
    }
    rows.forEach(g => { g.pct = total > 0 ? Math.round((g.bytes / (total || 1)) * 100) : 0; });
    return { rows, totalBytes: total, pairs: this.sessions.length, identical: rows.length === 0 };
  }

  // Same check as Session.preflight, across every pair, before anything runs.
  async preflight(job, opts) {
    const out = [];
    for (let p = 0; p < this.sessions.length; p++) {
      const pairJob = Object.assign({}, job, {
        left: this.pairs[p].left, right: this.pairs[p].right,
      });
      const w = await this.sessions[p].preflight(pairJob, opts);
      for (const x of w) {
        out.push(Object.assign({}, x, {
          pair: p + 1,
          label: this.sessions.length > 1 ? pairLabel(this.pairs[p]) : '',
        }));
      }
    }
    return out;
  }

  async sync(job, opts) {
    const { onProgress, token, trashItem, appVersion, defaultReportFolder } = opts || {};
    if (!this.comparedAt) throw new Error('Run a comparison first.');

    // The plan in memory belongs to the folders that were COMPARED. Nothing
    // used to check that they were still the folders on screen: swapping the
    // two sides, editing a path or loading another job left the grid and the
    // confirmation dialog showing the new folders while the engine replayed
    // the old plan — the classic way to mirror A over B when you meant B over A.
    const wanted = this._pairsOf(job);
    const same = wanted.length === this.pairs.length &&
      wanted.every((p, i) => p.left === this.pairs[i].left && p.right === this.pairs[i].right);
    if (!same) {
      throw new Error('The folders changed since the last comparison. Compare again before synchronizing.');
    }

    // Before the locks, not after: acquireAll creates a base folder that does
    // not exist yet, which would make a missing drive look like an empty one
    // from the next comparison on.
    const blocking = await this.preflight(job, opts);
    if (blocking.length) {
      const b = blocking[0];
      throw new Error((b.label ? `[${b.label}] ` : '') + b.message);
    }

    const startedAt = Date.now();
    const multi = this.sessions.length > 1;

    // Lock every folder this run will write to, before touching anything.
    // Another machine synchronizing the same folders waits (or we wait for it).
    let locks = null;
    let lockLost = null;
    if (job.sync.lockFolders !== false) {
      const folders = [];
      for (const s of this.sessions) { folders.push(s.left, s.right); }
      locks = await acquireAll(folders, {
        token,
        // Losing a lock mid-run means another machine now owns that folder and
        // may already be writing to it. Stopping is the only safe answer: two
        // engines renaming the same .syncto_tmp is how files get shredded.
        onLost: reason => {
          lockLost = lockLost || reason;
          if (token) token.cancelled = true;
        },
        onStatus: st => onProgress && onProgress({
          phase: 'lock', current: st.takingOver
            ? `Taking over an abandoned lock from ${st.holder}…`
            : `Waiting for ${st.holder}${st.secondsLeft != null ? ` — ${st.secondsLeft}s` : ''}`,
          waiting: true, holder: st.holder, secondsLeft: st.secondsLeft,
        }),
      });
    }
    try {

    // Grand totals first, so the progress ring covers the whole job.
    const verifyFactor = 2;          // every byte is written, then read back
    let bytesTotal = 0, filesTotal = 0;
    for (const s of this.sessions) {
      const st = s.stats || {};
      bytesTotal += (st.bytesTotal || 0) * verifyFactor;   // written + read back
      filesTotal += st.filesToProcess || 0;
    }

    const perPair = [];
    let doneBytes = 0, doneFiles = 0, cancelled = false;
    const counters = { files: 0, bytes: 0, deleted: 0, folders: 0, moved: 0, errors: 0, failed: 0 };
    let verified = 0;
    const allErrors = [], allNotes = [], reportFiles = [], checksumFiles = [];

    for (let p = 0; p < this.sessions.length; p++) {
      if (token && token.cancelled) { cancelled = true; break; }
      const pr = this.pairs[p];
      const pairJob = Object.assign({}, job, {
        left: pr.left, right: pr.right,
        pairId: multi ? null : job.pairId,   // same rule as compare()
      });
      let res;
      try {
        res = await this.sessions[p].sync(pairJob, {
          token, trashItem, appVersion, defaultReportFolder,
          lockLost: () => !!lockLost,
          skipReport: multi,             // one merged report at the end instead
          onProgress: prog => onProgress && onProgress(Object.assign({}, prog, {
            pair: p + 1, pairs: this.pairs.length, pairLabel: pairLabel(pr),
            bytesDone: doneBytes + (prog.bytesDone || 0),
            bytesTotal,
            filesDone: doneFiles + (prog.filesDone || 0),
            filesTotal,
          })),
        });
      } catch (err) {
        // One pair failing must not throw away what the pairs BEFORE it just
        // did — their copies are on disk and belong in the report. Record the
        // failure and move on to the next pair, like FreeFileSync.
        if (/cancelled/i.test(err.message || '')) { cancelled = true; break; }
        counters.errors++;
        allErrors.push({ rel: multi ? `[${pairLabel(pr)}]` : '', message: err.message || String(err) });
        continue;
      }
      perPair.push(res);
      // The progress offset counts WORK bytes (a secure copy reads everything
      // back: 2× the data), same unit as bytesTotal above — mixing in plain
      // copied bytes made the ring jump backwards between pairs.
      doneBytes += res.counters.workBytes != null ? res.counters.workBytes : (res.counters.bytes || 0);
      doneFiles += (res.counters.files || 0) + (res.counters.moved || 0) + (res.counters.deleted || 0);
      // res.counters.errors already counts this pair's errors — adding
      // res.errors.length again would double every one of them.
      for (const k of Object.keys(counters)) counters[k] += res.counters[k] || 0;
      verified += res.verified || 0;
      allErrors.push(...res.errors.map(e => Object.assign({}, e, {
        rel: multi ? `[${pairLabel(pr)}] ${e.rel}` : e.rel,
      })));
      allNotes.push(...res.notes.map(n => multi ? `[${pairLabel(pr)}] ${n}` : n));
      reportFiles.push(...(res.reportFiles || []));
      checksumFiles.push(...(res.checksumFiles || []));
      cancelled = cancelled || res.cancelled;
    }
    const endedAt = Date.now();

    // Merged report (multi-pair only — a single pair already wrote its own).
    if (multi && job.sync.report && job.sync.report.enabled && perPair.length) {
      const mergedRun = {
        results: [], counters, plan: { bytes: bytesTotal },
        notes: allNotes, cancelled,
      };
      // Rebuild raw results with pair-prefixed paths for the report writer.
      for (let p = 0; p < perPair.length; p++) {
        const lbl = pairLabel(this.pairs[p]);
        for (const r of (this.sessions[p].lastResults || [])) {
          mergedRun.results.push(Object.assign({}, r, { rel: `[${lbl}] ${r.rel}` }));
        }
      }
      const report = buildReport({
        appVersion,
        pairName: job.name,
        leftPath : this.pairs.map(x => x.left).join('  ·  '),
        rightPath: this.pairs.map(x => x.right).join('  ·  '),
        variant: job.sync.variant, compareVariant: job.compare.compareVariant,
        copyLevel: job.sync.copyLevel,
        deletion: job.sync.deletion, versioningStyle: '',
        filter: { include: job.compare.includeFilter, exclude: job.compare.excludeFilter },
        startedAt, endedAt, run: mergedRun,
        stats: this.stats, comparisonErrors: [],
      });
      const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '_');
      const baseName = `syncto_${(job.name || 'job').replace(/[^\w.-]+/g, '_')}_${stamp}`;
      const outDir = job.sync.report.folder || defaultReportFolder || null;
      if (outDir) {
        const nfs = this.sessions[0].pool.native;
        try {
          await nfs.mkdir(outDir);
          const targets = [];
          if (job.sync.report.html) targets.push([baseName + '.html', toHtml(report)]);
          if (job.sync.report.csv)  targets.push([baseName + '.csv',  toCsv(report)]);
          if (job.sync.report.json) targets.push([baseName + '.json', toJson(report)]);
          for (const [name, content] of targets) {
            await writeText(nfs, nfs.join(outDir, name), content);
            reportFiles.push(nfs.join(outDir, name));
          }
        } catch (err) {
          allNotes.push(`Could not write the merged report: ${err.message}`);
        }
      }
    }

    if (lockLost) {
      const msg = `The folder lock was lost during the run (${lockLost}) — another machine took over, ` +
        `so syncto stopped to avoid two engines writing the same files. Nothing after that point was done.`;
      allNotes.push(msg);
      allErrors.push({ rel: '.syncto.lock', message: msg });
      counters.errors++;
    } else if (locks && locks.hiccups) {
      // The run survived the network dropping out. Said as a note, because a
      // run that finished correctly is not an error — but a share that stops
      // answering for half a minute is worth knowing about before it stops
      // answering for two.
      const h = locks.hiccups();
      if (h.count) {
        allNotes.push(`The network stopped answering ${h.count} time${h.count > 1 ? 's' : ''} ` +
          `during the run (longest ${Math.round(h.worstMs / 1000)} s). The run rode it out — ` +
          `a folder is only given up after ${Math.round(DETECT_ABANDONED_MS / 1000)} s of complete silence.`);
      }
    }

    return {
      counters,
      verified,
      errors: allErrors,
      notes : allNotes,
      cancelled,
      lockLost,
      startedAt, endedAt,
      durationMs: endedAt - startedAt,
      reportFiles, checksumFiles,
      locked: locks ? locks.count : 0,
      pairsDone: perPair.length, pairsTotal: this.pairs.length,
    };
    } finally {
      if (locks) await locks.release();
    }
  }

  async close() {
    for (const s of this.sessions) { try { await s.close(); } catch (_) {} }
    this.sessions = [];
  }
}

// ── Verification of an existing folder ─────────────────────────────────────
// Reads back a syncto-checksums.txt sidecar and re-hashes every file it lists.
async function verifyFolder(pool, phrase, opts) {
  const { onProgress, token, credentials } = opts || {};
  const loc = parseLocation(phrase, credentials);
  const { fs: fsx, path: root } = await pool.open(loc);

  const listPath = fsx.join(root, CHECKSUM_FILE);
  const text = await readText(fsx, listPath);
  if (text == null) throw new Error(`No ${CHECKSUM_FILE} found in this folder.`);

  const { algo, entries } = parseChecksumList(text);
  if (!entries.length) throw new Error('The checksum list is empty.');

  const results = [];
  let done = 0, okCount = 0, badCount = 0, missingCount = 0;
  for (const e of entries) {
    if (token && token.cancelled) break;
    const p = fsx.join(root, ...e.rel.split('/'));
    const st = await fsx.stat(p);
    if (!st) { missingCount++; results.push({ rel: e.rel, status: 'missing' }); done++; continue; }
    try {
      const hasher = await createHasher(algo || 'xxh64');
      const got = await hashStream(fsx, p, hasher, null, token);
      if (got === e.hash) { okCount++; results.push({ rel: e.rel, status: 'ok' }); }
      else { badCount++; results.push({ rel: e.rel, status: 'mismatch', expected: e.hash, got }); }
    } catch (err) {
      badCount++; results.push({ rel: e.rel, status: 'error', error: err.message });
    }
    done++;
    if (onProgress && done % 5 === 0) {
      onProgress({ done, total: entries.length, current: e.rel, verified: okCount, mismatched: badCount, missing: missingCount });
    }
  }
  if (onProgress) onProgress({ done, total: entries.length, current: '', verified: okCount, mismatched: badCount, missing: missingCount });
  // Field names deliberately avoid "ok": the IPC layer wraps this in { ok: true }.
  return { algo, total: entries.length, verified: okCount, mismatched: badCount, missing: missingCount, results };
}

// ── Small text helpers that work on any backend ────────────────────────────
function writeText(fsx, p, content) {
  return new Promise((resolve, reject) => {
    const ws = fsx.createWriteStream(p);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(Buffer.from(content, 'utf8'));
  });
}

async function readText(fsx, p) {
  const st = await fsx.stat(p);
  if (!st || st.type !== 'file') return null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = fsx.createReadStream(p);
    rs.on('data', c => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    rs.on('error', reject);
  });
}

// ── Clearing a lock a previous run left behind ────────────────────────────
// Deliberately separate from the comparison that found them. Finding one costs
// a stat; removing one has to earn the right, and that can mean watching the
// file for twelve seconds to be sure nobody is still feeding it.
async function clearStaleLocks(job, items, opts) {
  const { onStatus, token, credentials } = opts || {};
  const pool = new FsPool();
  const results = [];
  try {
    for (const item of items || []) {
      if (!item || !item.path || !item.folder) continue;
      let fsx, target;
      try {
        // pool.open takes a parsed location, not a raw path.
        const side = await pool.open(parseLocation(item.folder, credentials));
        fsx = side.fs;
        target = Object.assign({}, item, { path: fsx.join(side.path, item.name) });
      } catch (err) {
        results.push({ path: item.path, status: 'failed', error: err.message || String(err) });
        continue;
      }
      let status = 'failed', error = null;
      try { status = await clearStaleLock(fsx, target, { onStatus, token }); }
      catch (err) { error = err.message || String(err); }
      results.push(error ? { path: item.path, status: 'failed', error } : { path: item.path, status });
    }
  } finally {
    try { await pool.closeAll(); } catch (_) {}
  }
  return results;
}

// ── Checking a job's folders WITHOUT comparing anything ────────────────────
// Called when a job is opened, which is the moment a stale path can still be
// fixed cheaply — before a comparison plans a full copy against it, and before
// a run refuses. Every native side of every pair is stat'ed; a missing one gets
// the same treatment a missing root gets during a comparison: does the other
// side remember this pair, and is there a folder next to it carrying that pair's
// database under another name.
//
// SFTP sides are skipped. Answering "does it exist" there means opening a
// connection and possibly asking for a password, which is not something opening
// a job should do on its own.
async function checkJobPaths(job, opts) {
  const pairs = (Array.isArray(job.pairs) && job.pairs.length)
    ? job.pairs
    : [{ left: job.left || '', right: job.right || '' }];
  const multi = pairs.length > 1;
  const fsx = new NativeFs();
  const out = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const left = String(pair.left || '').trim();
    const right = String(pair.right || '').trim();
    if (!left || !right) continue;                       // an unfinished row is not a problem yet
    const remote = p => /^sftp:\/\//i.test(p);

    for (const side of ['left', 'right']) {
      const here  = side === 'left' ? left : right;
      const other = side === 'left' ? right : left;
      if (remote(here)) continue;
      let exists = false;
      try { const st = await fsx.stat(fsx.resolve(here)); exists = !!st && st.type === 'folder'; }
      catch (_) { exists = true; }   // unreadable is not missing — never claim it is
      if (exists) continue;

      const entry = {
        pairIndex: i, pair: i + 1, side, path: here,
        label: multi ? `Pair ${i + 1}` : '',
        hadHistory: false, lastRun: 0, items: 0,
      };

      // What the surviving side remembers. Without it there is nothing to say
      // beyond "this folder is not there" — which is still worth saying.
      if (!remote(other)) {
        try {
          const pairId = pairIdFor(job.pairId, left, right);
          const sess = await readSideSession(fsx, fsx.resolve(other), pairId);
          if (sess) {
            entry.hadHistory = true;
            entry.lastRun = sess.updated || 0;
            entry.items = sess.items ? Object.keys(sess.items).length : 0;
          }
        } catch (_) { /* what the folder held is a bonus, never a reason to fail */ }
      }
      out.push(entry);
    }
  }
  return out;
}

module.exports = { Session, MultiSession, verifyFolder, CHECKSUM_FILE, writeText, readText,
  pairLabel, checkJobPaths, clearStaleLocks };
