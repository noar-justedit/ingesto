#!/usr/bin/env node
/*
 * syncto — FreeFileSync job converter
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
 *
 * Converts FreeFileSync .ffs_gui / .ffs_batch configurations into .syncto jobs.
 *
 *   node scripts/ffs-convert.js MyJob.ffs_gui [more.ffs_gui …] [-o outputDir]
 *
 * One .syncto file per FreeFileSync configuration — syncto jobs are
 * multi-pair, so every folder pair of the source file lands in the same job.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Minimal XML reading — the .ffs_gui format is flat and regular ──────────
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}
function tagAttrs(xml, name) {
  const m = new RegExp(`<${name}((?:\\s+[\\w]+="[^"]*")*)\\s*/?>`).exec(xml);
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/([\w]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return attrs;
}
function items(xml, section) {
  const body = tag(xml, section);
  if (!body) return [];
  return [...body.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]
    .map(m => decode(m[1].trim()))
    .filter(Boolean);
}
function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// ── Semantic mapping ───────────────────────────────────────────────────────
function mapCompare(v) {
  return { TimeAndSize: 'timeSize', Content: 'content', Size: 'size' }[v] || 'timeSize';
}

// FreeFileSync writes <Differences .../> for by-difference variants and
// nothing at all for the default Two way.
function mapSyncVariant(xml) {
  const d = tagAttrs(xml, 'Differences');
  if (!d) return { variant: 'twoWay' };
  const dir = k => (d[k] || 'none').toLowerCase();
  const dirs = { leftOnly: dir('LeftOnly'), rightOnly: dir('RightOnly'),
                 leftNewer: dir('LeftNewer'), rightNewer: dir('RightNewer') };
  const all = [dirs.leftOnly, dirs.rightOnly, dirs.leftNewer, dirs.rightNewer];
  if (all.every(x => x === 'right')) return { variant: 'mirror' };
  if (dirs.leftOnly === 'right' && dirs.leftNewer === 'right' &&
      dirs.rightOnly === 'none' && dirs.rightNewer === 'none') return { variant: 'update' };
  return { variant: 'custom', custom: dirs };
}

// FFS filter items → syncto's anchoring rule:
//   "*/name" or "*\name" with a bare tail → "name"  (name pattern, any depth)
//   backslashes → slashes; a leading separator stays (anchored to the root).
function mapFilterItem(it) {
  let s = it.replace(/\\/g, '/');
  const m = /^\*\/(.+)$/.exec(s);
  // "*/name" and "*/name/" mean "this name anywhere" — that is exactly what a
  // bare name pattern does in syncto, at every depth instead of just one.
  if (m && !m[1].replace(/\/+$/, '').includes('/')) s = m[1];
  return s;
}

function mapDeletion(xml) {
  const p = tag(xml, 'DeletionPolicy');
  if (p === 'Permanent') return 'permanent';
  if (p === 'Versioning') return 'recycler';   // syncto has no versioning — falls back to trash
  return 'recycler';
}

function convert(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const baseName = path.basename(file).replace(/\.(ffs_gui|ffs_batch)$/i, '')
                                      .replace(/^[0-9a-f]{8}-/, '');   // strip upload prefixes

  const pairs = [...(tag(xml, 'FolderPairs') || '').matchAll(
    /<Pair>[\s\S]*?<Left>([\s\S]*?)<\/Left>[\s\S]*?<Right>([\s\S]*?)<\/Right>[\s\S]*?<\/Pair>/g
  )].map(m => ({ left: decode(m[1].trim()), right: decode(m[2].trim()) }));

  if (!pairs.length) throw new Error('no folder pair found');

  const sync    = mapSyncVariant(xml);
  const errors  = tagAttrs(xml, 'Errors') || {};
  const include = items(xml, 'Include').map(mapFilterItem);
  const exclude = items(xml, 'Exclude').map(mapFilterItem);
  const versioningDropped = tag(xml, 'DeletionPolicy') === 'Versioning';

  const job = {
    format : 'syncto-job',
    version: 1,
    name   : baseName,
    pairId : null,
    pairs  : pairs.map(p => ({ left: p.left, right: p.right })),
    compare: {
      compareVariant: mapCompare(tag(xml, 'Variant')),
      detectMoves   : true,
      includeFilter : include.length ? include.join('\n') : '*',
      excludeFilter : exclude.join('\n'),
    },
    sync: {
      variant  : sync.variant,
      ...(sync.custom ? { custom: sync.custom } : {}),
      copyLevel: 'verified',
      deletion : mapDeletion(xml),
      retryCount  : parseInt(errors.Retry, 10) || 0,
      retryDelayMs: (parseInt(errors.Delay, 10) || 5) * 1000,
      ignoreErrors: errors.Ignore === 'true',
    },
    _converted: {
      from: path.basename(file),
      date: new Date().toISOString().slice(0, 10),
      ...(versioningDropped ? { note: 'FreeFileSync used Versioning; syncto maps it to the trash.' } : {}),
    },
  };
  return { name: baseName, job, pairs };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const oIdx = args.indexOf('-o');
  const outDir = oIdx >= 0 ? args.splice(oIdx, 2)[1] : '.';
  const files = args;
  if (!files.length) {
    console.log('Usage: node scripts/ffs-convert.js <job.ffs_gui> [...] [-o outputDir]');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const f of files) {
    try {
      const { name, job, pairs } = convert(f);
      const out = path.join(outDir, `${name}.syncto`);
      fs.writeFileSync(out, JSON.stringify(job, null, 2));
      console.log(`  ${path.basename(f)}  ->  ${name}.syncto  (${pairs.length} pair${pairs.length > 1 ? 's' : ''}, ${job.sync.variant})`);
      for (const p of pairs) console.log(`      ${p.left}  ->  ${p.right}`);
      total++;
    } catch (err) {
      console.error(`  !! ${path.basename(f)}: ${err.message}`);
    }
  }
  console.log(`${total} syncto job(s) written to ${path.resolve(outDir)}`);
}

module.exports = { convert };
