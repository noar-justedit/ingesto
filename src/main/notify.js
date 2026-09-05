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

// Phone notification through ntfy — same mechanism as ingesto, deliberately.
//
// A POST of plain text to <server>/<topic>. No account, no SDK, no dependency.
// Whatever the user has subscribed to that topic — the ntfy app on a phone, a
// browser tab — receives it.
//
// The one thing that is easy to get wrong, and that ingesto got bitten by:
// Title, Tags and Priority are HTTP HEADER values. A single accent or emoji in
// them throws ERR_INVALID_CHAR and loses the WHOLE notification, body
// included. So they are stripped to printable ASCII here, while the message
// body — which travels as UTF-8 in the request body — keeps everything.

const https = require('https');
const http  = require('http');

const TIMEOUT_MS = 8000;

// Printable ASCII only. Anything else is dropped rather than escaped: these
// are labels, and a mangled label is better than a lost notification.
function headerSafe(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').trim();
}

// ntfy tags are emoji short codes or plain words, comma separated.
function tagsSafe(s) {
  return headerSafe(s).replace(/[^a-zA-Z0-9_,\-]/g, '').replace(/^,+|,+$/g, '');
}

// opts: { server, topic, token, title, message, tags, priority }
// Never throws and never rejects: a notification is the last thing that should
// be able to fail a synchronization.
function send(opts) {
  return new Promise(resolve => {
    try {
      const topic = String((opts && opts.topic) || '').trim();
      if (!topic) return resolve({ ok: false, error: 'No topic set.' });

      const server = String((opts.server || 'https://ntfy.sh')).trim().replace(/\/+$/, '');
      const url = new URL(server + '/' + encodeURIComponent(topic));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return resolve({ ok: false, error: 'The server address must start with http:// or https://' });
      }

      const body = Buffer.from(String(opts.message || ''), 'utf8');
      const headers = {
        'Content-Type'  : 'text/plain; charset=utf-8',
        'Content-Length': body.length,
      };
      const title = headerSafe(opts.title);
      if (title) headers['Title'] = title;
      const tags = tagsSafe(opts.tags);
      if (tags) headers['Tags'] = tags;
      const p = parseInt(opts.priority, 10);
      if (Number.isFinite(p) && p >= 1 && p <= 5) headers['Priority'] = String(p);
      // Self-hosted servers can require a token. NOT passed through
      // headerSafe: stripping a secret to printable ASCII silently mangles it
      // and the server answers 401. A token that cannot travel as a header is
      // reported, not quietly truncated.
      const token = String(opts.token == null ? '' : opts.token).trim();
      if (token) {
        if (/[^\x20-\x7E]/.test(token)) {
          return resolve({ ok: false, error: 'The access token contains characters that cannot be sent in an HTTP header.' });
        }
        headers['Authorization'] = 'Bearer ' + token;
      }

      const mod = url.protocol === 'http:' ? http : https;
      const req = mod.request(url, { method: 'POST', headers, timeout: TIMEOUT_MS }, res => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve(ok
          ? { ok: true, status: res.statusCode }
          : { ok: false, status: res.statusCode, error: `The server answered ${res.statusCode}.` });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'The server did not answer within 8 s.' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// One retry, two seconds later — a laptop that has just woken a Wi-Fi radio
// misses the first attempt often enough to be worth it. Still never blocking:
// the run is already finished by the time this is called.
async function sendWithRetry(opts) {
  const first = await send(opts);
  if (first.ok) return first;
  await new Promise(r => setTimeout(r, 2000));
  return send(opts);
}

// Builds the notification for a finished run. Kept here, out of the renderer,
// so it can be tested without a window.
//   res: what session.sync() returned
//   jobName: the job's name
// Says what was checked, not just that it ended: "done" tells a DIT waiting on
// a two-hour backup nothing they can act on.
function forRun(res, jobName) {
  const c = res.counters || {};
  const errors = (res.errors || []).length;
  const files = c.files || 0;
  const bytes = c.bytes || 0;
  const name = jobName || 'syncto';

  const gb = bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB'
           : bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB'
           : bytes + ' B';
  const secs = Math.round((res.durationMs || 0) / 1000);
  const dur = secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`
            : secs >= 60   ? `${Math.floor(secs / 60)}m ${secs % 60}s`
            : `${secs}s`;

  const lines = [
    `${files} file${files === 1 ? '' : 's'} · ${gb} · ${dur}`,
  ];
  if (c.deleted) lines.push(`${c.deleted} item${c.deleted === 1 ? '' : 's'} removed`);
  if (c.moved)   lines.push(`${c.moved} move${c.moved === 1 ? '' : 's'}`);

  let title, tags, priority;
  if (res.cancelled) {
    title = `${name} — cancelled`;
    lines.push('Stopped before the end');
    tags = 'x'; priority = 3;
  } else if (res.lockLost) {
    title = `${name} — stopped`;
    lines.push('Another machine took the folder');
    tags = 'warning'; priority = 4;
  } else if (errors) {
    title = `${name} — ${errors} error${errors > 1 ? 's' : ''}`;
    const first = res.errors[0];
    if (first) lines.push(`First: ${first.rel ? first.rel + ' — ' : ''}${first.message}`);
    tags = 'warning'; priority = 4;
  } else {
    // The whole point of the notification is that nobody is at the screen. So
    // it says what was checked, not just that it ended — "done" tells a DIT
    // waiting on a two-hour backup nothing they can act on.
    title = `${name} — done`;
    if (res.verified) {
      lines.push(`✓ ${res.verified} read back and verified (xxHash64)`);
    } else if (!files) {
      lines.push('Both sides already matched');
    }
    tags = 'white_check_mark'; priority = 3;
  }
  return { title, message: lines.join('\n'), tags, priority };
}

module.exports = { send, sendWithRetry, forRun, headerSafe, tagsSafe };
