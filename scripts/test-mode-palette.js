#!/usr/bin/env node
// The four copy modes are named and coloured in several places, and those
// places used to disagree. SIZE CHECK wore GREEN on its COPY MODE badge (a
// leftover from when the mode was called VERIFIED) while the end-of-ingest
// window painted the same mode ORANGE, and the info panel still called it
// "VERIFIED". Green also means "the transfer worked" everywhere else in the
// app, so the one mode that does NOT check contents wore the colour meaning
// "verified".
//
// Nothing enforced the agreement, so this suite reads the real CSS and the real
// tables out of index.html and pins them together:
//
//   FAST        grey    no check
//   SIZE CHECK  blue    partial check (sizes)
//   SECURE      orange  contents verified
//   PRO         violet  verified and the card read back
//
//   node scripts/test-mode-palette.js
//
const fs   = require('fs');
const path = require('path');

const REND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// The palette, once. Every check below reads back to this table.
const WANT = {
  fast:   { badge: 'bf', name: 'FAST',       token: '--grey',   sel: '#mode-fast.on'   },
  normal: { badge: 'bn', name: 'SIZE CHECK', token: '--blue',   sel: '#mode-normal.on' },
  slow:   { badge: 'bs', name: 'SECURE',     token: '--orange', sel: '#mode-slow.on'   },
  pro:    { badge: 'bp', name: 'PRO',        token: '--pro',    sel: '#mode-pro.on'    },
};

console.log('\nthe COPY MODE badges');
for (const k of Object.keys(WANT)) {
  const w = WANT[k];
  const m = REND.match(new RegExp('^\\.' + w.badge + '\\{([^}]*)\\}', 'm'));
  ok(!!m, `.${w.badge} exists`);
  if (m) ok(new RegExp('color:var\\(' + w.token + '\\)').test(m[1]),
            `${w.name} badge is ${w.token} (${(m[1] || '').trim()})`);
  // The badge text must be the mode's real name: "VERIFIED" lived on for two
  // versions after the mode was renamed.
  ok(new RegExp('class="mbadge ' + w.badge + '">' + w.name + '<').test(REND),
     `and it reads "${w.name}"`);
}

console.log('\nthe selected-button tint agrees with the badge');
for (const k of Object.keys(WANT)) {
  const w = WANT[k];
  const m = REND.match(new RegExp('^' + w.sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
  ok(!!m && new RegExp('border-color:var\\(' + w.token + '\\)').test(m[1]),
     `${w.sel} borders in ${w.token}`);
  const s = REND.match(new RegExp('^' + w.sel.replace(/[.#]/g, '\\$&') + ' \\.msel\\{([^}]*)\\}', 'm'));
  ok(!!s && new RegExp('color:var\\(' + w.token + '\\)').test(s[1]),
     `and its "Selected" label too`);
}

console.log('\nthe end-of-ingest window uses the same four colours');
{
  const m = REND.match(/const MODE_UI=\{([\s\S]*?)\};/);
  ok(!!m, 'MODE_UI is there');
  const body = m ? m[1] : '';
  for (const k of Object.keys(WANT)) {
    const w = WANT[k];
    const e = body.match(new RegExp(k + ":\\['([^']*)','var\\((--[a-z0-9]+)\\)'\\]"));
    ok(!!e, `MODE_UI.${k} is declared`);
    if (e) {
      ok(e[1] === w.name, `MODE_UI.${k} is named "${w.name}" (found "${e[1]}")`);
      ok(e[2] === w.token, `MODE_UI.${k} is ${w.token} (found ${e[2]})`);
    }
  }
}

console.log('\nthe info panel says the same thing');
for (const k of Object.keys(WANT)) {
  const w = WANT[k];
  ok(new RegExp('mi-badge[^>]*color:var\\(' + w.token + '\\)[^>]*>' + w.name + '(</span>| ·)').test(REND),
     `the "${w.name}" entry carries ${w.token}`);
}
ok(!/>VERIFIED</.test(REND), 'and the old "VERIFIED" name is gone from the interface');

console.log('\ngreen and red stay reserved for the result of a transfer');
{
  const badges = Object.values(WANT).map(w => {
    const m = REND.match(new RegExp('^\\.' + w.badge + '\\{([^}]*)\\}', 'm'));
    return m ? m[1] : '';
  }).join(' ');
  ok(!/var\(--green\)/.test(badges), 'no mode badge is green');
  ok(!/var\(--red\)/.test(badges), 'no mode badge is red');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
