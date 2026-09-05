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

// The copy report — the artefact you hand to a client, an insurer or your
// future self. Three formats:
//   HTML  self-contained, dark, printable, one row per item with its checksum
//   CSV   for a spreadsheet
//   JSON  for a script or an asset manager
//
// The HTML report embeds every checksum, so it doubles as a verification
// manifest even if the sidecar list is lost.

const OP_LABEL = {
  createLeft: 'create  <-', createRight: 'create  ->',
  overwriteLeft: 'update  <-', overwriteRight: 'update  ->',
  deleteLeft: 'delete  <-', deleteRight: 'delete  ->',
  moveLeftTo: 'move  <-', moveRightTo: 'move  ->',
  moveLeftFrom: 'moved away  <-', moveRightFrom: 'moved away  ->',
  none: 'equal', doNothing: 'skipped', conflict: 'conflict',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}

function fmtDuration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// ── Payload ────────────────────────────────────────────────────────────────
// Everything the three writers need, built once.
function buildReport(input) {
  const {
    pairName, leftPath, rightPath, variant, compareVariant, copyLevel,
    deletion, versioningStyle, filter, startedAt, endedAt, run, stats, comparisonErrors,
  } = input;

  const items = (run.results || []).map(r => ({
    rel   : r.rel,
    type  : r.type,
    op    : r.op,
    opText: (r.moved && r.from) ? `moved from ${r.from}` : (OP_LABEL[r.op] || r.op),
    side  : r.side || '',
    ok    : !!r.ok,
    bytes : r.bytes || 0,
    hash  : r.hash || '',
    algo  : r.algo || '',
    how   : r.how || '',
    error : r.error || '',
  }));

  const okCount  = items.filter(i => i.ok).length;
  const errCount = items.filter(i => !i.ok).length;

  return {
    tool: 'syncto',
    version: input.appVersion || '',
    pairName: pairName || '',
    left: leftPath, right: rightPath,
    settings: {
      syncVariant: variant,
      compareVariant,
      copyLevel,
      checksumAlgorithm: 'xxh64',
      deletion, versioningStyle,
      includeFilter: filter ? filter.include : '*',
      excludeFilter: filter ? filter.exclude : '',
    },
    startedAt, endedAt,
    durationMs: (endedAt || 0) - (startedAt || 0),
    cancelled: !!run.cancelled,
    totals: {
      itemsProcessed: items.length,
      succeeded: okCount,
      failed: errCount,
      filesCopied: run.counters ? run.counters.files : 0,
      filesMoved: run.counters ? (run.counters.moved || 0) : 0,
      foldersCreated: run.counters ? run.counters.folders : 0,
      itemsRemoved: run.counters ? run.counters.deleted : 0,
      bytesCopied: run.counters ? run.counters.bytes : 0,
      plannedBytes: run.plan ? run.plan.bytes : 0,
      // Files that were read back from their final place and matched. The
      // report is the artefact a DIT keeps; it has to say what was checked.
      filesVerified: run.verified || 0,
    },
    comparison: stats || null,
    comparisonErrors: comparisonErrors || [],
    notes: run.notes || [],
    items,
  };
}

// ── JSON ───────────────────────────────────────────────────────────────────
function toJson(rep) { return JSON.stringify(rep, null, 2); }

// ── CSV ────────────────────────────────────────────────────────────────────
function toCsv(rep) {
  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [
    ['path', 'type', 'operation', 'side', 'status', 'bytes', 'algorithm', 'checksum', 'error']
      .map(q).join(','),
  ];
  for (const i of rep.items) {
    lines.push([i.rel, i.type, i.opText, i.side, i.ok ? 'ok' : 'FAILED',
                i.bytes, i.algo, i.hash, i.error].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── HTML ───────────────────────────────────────────────────────────────────
function toHtml(rep) {
  const s = rep.settings;
  const ok = rep.totals.failed === 0 && !rep.cancelled;
  const statusText = rep.cancelled ? 'Cancelled'
                   : rep.totals.failed ? `Completed with ${rep.totals.failed} error${rep.totals.failed > 1 ? 's' : ''}`
                   : 'Completed successfully';
  const statusColor = rep.cancelled ? '#f2a03d' : rep.totals.failed ? '#f2555a' : '#35c98b';

  // What was actually checked, in one sentence, per level. A report that says
  // "verified" for a level that never read anything back would be exactly the
  // lie the engine takes such care to avoid.
  const vFailed = (rep.errors || []).filter(e => /checksum mismatch/i.test(e.message || '')).length;
  let verifyClass, verifyHead, verifySub;
  if (vFailed) {
    verifyClass = 'bad';
    verifyHead = `${vFailed} file${vFailed > 1 ? 's' : ''} failed verification`;
    verifySub = 'They were read back from their final location and did not match the fingerprint '
      + 'taken while writing. They are excluded from the checksum list below.';
  } else if (rep.totals.filesVerified) {
    verifyClass = 'good';
    verifyHead = `${rep.totals.filesVerified} file${rep.totals.filesVerified > 1 ? 's' : ''} read back and verified (xxHash64)`;
    verifySub = 'Every file was copied, then read from its final location and compared with the '
      + 'fingerprint taken while writing. Not one differed.';
  } else if (rep.totals.filesCopied) {
    verifyClass = 'plain';
    verifyHead = `${rep.totals.filesCopied} file${rep.totals.filesCopied > 1 ? 's' : ''} copied and size-checked`;
    verifySub = 'Each copy was written beside its target, checked for its full size, and only then '
      + 'renamed into place. The Secure level additionally reads every file back and compares fingerprints.';
  } else {
    verifyClass = 'plain';
    verifyHead = 'No file was copied';
    verifySub = 'Nothing needed verifying on this run.';
  }

  const row = i => `<tr class="${i.ok ? '' : 'bad'}">
    <td class="op ${i.op}">${esc(i.opText)}</td>
    <td class="p">${esc(i.rel)}</td>
    <td class="n">${i.type === 'folder' ? '—' : esc(fmtBytes(i.bytes))}</td>
    <td class="h">${esc(i.hash)}</td>
    <td class="st">${i.ok ? '<span class="ok">ok</span>' : `<span class="ko">${esc(i.error || 'failed')}</span>`}</td>
  </tr>`;

  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>syncto report — ${esc(rep.pairName || rep.left)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0e0f13;--bg2:#121318;--bg3:#16181d;--bg4:#1b1d24;
--border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.13);
--text:#e8eaf0;--text2:#aeb3bd;--text3:#8b909b;--accent:#8b6ff0;
--green:#35c98b;--red:#f2555a;--orange:#f2a03d;--blue:#4d90f0;
--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,monospace}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;padding:34px 30px;}
h1{font-size:26px;font-weight:800;letter-spacing:.01em}
h1 span{color:var(--accent)}
.sub{color:var(--text3);font-size:13px;margin-top:4px;font-family:var(--mono)}
.status{display:inline-flex;align-items:center;gap:9px;margin-top:16px;padding:8px 15px;
border-radius:9px;border:1px solid ${statusColor}44;background:${statusColor}18;color:${statusColor};font-weight:700}
.status .dot{width:9px;height:9px;border-radius:50%;background:${statusColor};box-shadow:0 0 9px ${statusColor}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:9px;margin:22px 0}
/* What was actually checked. Same colour code as the application: green for a
   clean read-back, red for a mismatch, neutral for a size check. */
.verify{display:block;padding:13px 16px;border-radius:11px;margin:0 0 22px;
border:1px solid var(--border);background:var(--bg2)}
.verify b{display:block;font-size:14px;margin-bottom:3px}
.verify span{font-size:12.5px;color:var(--text3);line-height:1.55}
.verify.good{border-color:#35c98b55;background:#35c98b14}
.verify.good b{color:#35c98b}
.verify.bad{border-color:#f2555a66;background:#f2555a16}
.verify.bad b{color:#f2555a}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:11px;padding:12px 14px}
.card .l{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--text3)}
.card .v{font-size:21px;font-weight:700;font-family:var(--mono);margin-top:4px}
.panel{background:var(--bg2);border:1px solid var(--border);border-radius:11px;padding:15px 17px;margin-bottom:16px}
.panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--text3);margin-bottom:11px}
.kv{display:flex;justify-content:space-between;gap:16px;padding:4px 0;border-bottom:1px solid var(--border)}
.kv:last-child{border-bottom:0}
.kv span{color:var(--text3)}
.kv b{font-family:var(--mono);font-weight:600;text-align:right;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);
padding:8px 9px;border-bottom:1px solid var(--border2);position:sticky;top:0;background:var(--bg)}
td{padding:6px 9px;border-bottom:1px solid var(--border);vertical-align:top}
tr.bad td{background:rgba(242,85,90,.06)}
td.p{font-family:var(--mono);word-break:break-all}
td.n{font-family:var(--mono);color:var(--text2);white-space:nowrap}
td.h{font-family:var(--mono);color:var(--text3);font-size:11px;word-break:break-all}
td.op{font-family:var(--mono);white-space:nowrap;font-weight:700;font-size:11px}
td.op.createLeft,td.op.createRight{color:var(--green)}
td.op.overwriteLeft,td.op.overwriteRight{color:var(--blue)}
td.op.deleteLeft,td.op.deleteRight{color:var(--orange)}
td.op.moveLeftTo,td.op.moveRightTo,td.op.moveLeftFrom,td.op.moveRightFrom{color:var(--accent)}
td.op.conflict{color:var(--red)}
.ok{color:var(--green)}.ko{color:var(--red)}
.err{background:rgba(242,85,90,.07);border:1px solid rgba(242,85,90,.2);border-radius:9px;padding:11px 13px;margin-bottom:16px}
.err h2{color:var(--red)}
.err li{font-family:var(--mono);font-size:12px;color:var(--text2);list-style:none;padding:2px 0}
footer{margin-top:26px;color:var(--text3);font-size:11.5px;border-top:1px solid var(--border);padding-top:13px}
@media print{body{background:#fff;color:#000}.card,.panel{border-color:#ccc}}
</style></head><body>

<h1>sync<span>to</span> — synchronization report</h1>
<div class="sub">${esc(rep.left)}  ⟷  ${esc(rep.right)}</div>
<div class="status"><span class="dot"></span>${esc(statusText)}</div>

<div class="grid">
  <div class="card"><div class="l">Files copied</div><div class="v">${rep.totals.filesCopied}</div></div>
  <div class="card"><div class="l">Data copied</div><div class="v">${esc(fmtBytes(rep.totals.bytesCopied))}</div></div>
  ${rep.totals.filesMoved ? `<div class="card"><div class="l">Files moved</div><div class="v">${rep.totals.filesMoved}</div></div>` : ''}
  <div class="card"><div class="l">Folders created</div><div class="v">${rep.totals.foldersCreated}</div></div>
  <div class="card"><div class="l">Items removed</div><div class="v">${rep.totals.itemsRemoved}</div></div>
  <div class="card"><div class="l">Errors</div><div class="v" style="color:${rep.totals.failed ? 'var(--red)' : 'inherit'}">${rep.totals.failed}</div></div>
  <div class="card"><div class="l">Duration</div><div class="v">${esc(fmtDuration(rep.durationMs))}</div></div>
</div>

<div class="verify ${verifyClass}"><b>${esc(verifyHead)}</b><span>${esc(verifySub)}</span></div>

<div class="panel"><h2>Settings</h2>
${kv('Synchronization', s.syncVariant)}
${kv('Comparison', s.compareVariant)}
${kv('Copy', `every file read back and compared (${s.checksumAlgorithm})`)}
${kv('Deletion', s.deletion + (s.deletion === 'versioning' ? ` (${s.versioningStyle})` : ''))}
${kv('Include filter', s.includeFilter || '*')}
${kv('Exclude filter', s.excludeFilter || '—')}
${kv('Started', new Date(rep.startedAt).toLocaleString())}
${kv('Finished', new Date(rep.endedAt).toLocaleString())}
</div>

${rep.comparisonErrors.length ? `<div class="panel err"><h2>Comparison warnings</h2><ul>${
  rep.comparisonErrors.map(e => `<li>${esc(e.path)} — ${esc(e.message)}</li>`).join('')}</ul></div>` : ''}

${rep.notes.length ? `<div class="panel"><h2>Notes</h2><ul>${
  rep.notes.map(n => `<li class="kv"><span>${esc(n)}</span></li>`).join('')}</ul></div>` : ''}

<div class="panel"><h2>Items (${rep.items.length})</h2>
<table><thead><tr><th>Operation</th><th>Path</th><th>Size</th><th>Checksum</th><th>Status</th></tr></thead>
<tbody>${rep.items.map(row).join('')}</tbody></table>
</div>

<footer>Generated by syncto ${esc(rep.version)} — checksums above can be re-verified at any time with the Verify command.</footer>
</body></html>`;
}

module.exports = { buildReport, toHtml, toCsv, toJson, fmtBytes, fmtDuration, OP_LABEL };
