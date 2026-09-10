#!/usr/bin/env node
// The shape of the page itself.
//
// Written after one closing tag too many, added with a new control, closed the
// left panel early: the centre column and the right panel escaped their
// container and stacked at full width, and the left panel collapsed to 29
// pixels. Every one of the twenty-odd suites stayed green, because not one of
// them looks at the markup.
//
// This is not a rendering test. It checks the two things that broke: that the
// tags balance, and that the handful of containers the layout rests on are
// still nested inside one another.
//
//   node scripts/test-markup.js
//
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const SRC = fs.readFileSync(FILE, 'utf8');
// Only the markup: the scripts below it contain "</div>" inside strings.
const BODY = SRC.slice(0, SRC.indexOf('<script>'));

console.log('\nthe markup balances');
{
  // Walked as a stack rather than counted, so the failure names the tag that
  // has no partner instead of just saying the totals differ.
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link',
                        'meta','param','source','track','wbr','path','circle','rect',
                        'line','polyline','polygon','ellipse','use','stop']);
  const stack = [];
  let bad = null, extra = null;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(BODY))) {
    const closing = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3];
    if (VOID.has(tag) || /\/$/.test(attrs)) continue;
    if (!closing) stack.push({ tag, at: m.index });
    else {
      const top = stack.pop();
      if (!top) { extra = extra || { tag, at: m.index }; break; }
      if (top.tag !== tag) { bad = bad || { want: top.tag, got: tag, at: m.index }; break; }
    }
  }
  const lineOf = (i) => BODY.slice(0, i).split('\n').length;
  ok(!extra, extra ? `a </${extra.tag}> at line ${lineOf(extra.at)} closes something that was never opened`
                   : 'no closing tag without an opening one');
  ok(!bad, bad ? `a </${bad.got}> at line ${lineOf(bad.at)} closes a <${bad.want}>`
               : 'every tag is closed by its own kind');
  // <html> and <body> close after the scripts, which is past where this reads.
  const open = stack.filter(e => !['html','head','body'].includes(e.tag));
  ok(open.length === 0, open.length
     ? `${open.length} tag(s) never closed, first: <${open[0].tag}> at line ${lineOf(open[0].at)}`
     : 'and nothing else is left open where the markup ends');
}

console.log('\nthe containers the layout rests on are still nested');
{
  // Each pair: the child must open AND close inside the parent. This is what a
  // stray closing tag breaks, and it breaks it silently.
  const span = (id) => {
    const open = BODY.indexOf(`id="${id}"`);
    if (open < 0) return null;
    const start = BODY.lastIndexOf('<', open);
    // Walk forward to this element's own closing tag.
    const re = /<(\/?)div\b[^>]*>/g;
    re.lastIndex = start;
    let depth = 0, m;
    while ((m = re.exec(BODY))) {
      if (m[1] === '/') { depth--; if (depth === 0) return { start, end: m.index + m[0].length }; }
      else depth++;
    }
    return null;
  };
  const inside = (child, parent) => child && parent &&
                                    child.start > parent.start && child.end < parent.end;

  const app = span('app'), main = span('main'), center = span('center');
  ok(!!app && !!main && !!center, 'the three containers are found');
  ok(inside(main, app), '#main is inside #app');
  ok(inside(center, main), '#center is inside #main, which is what the stray tag broke');

  // The width control lives in the counter's info window, not in the panel:
  // it is chosen once and then left alone.
  const pad = span('counter-pad');
  const cinfo = span('counter-info-ov');
  ok(!!pad, 'the counter width control is there');
  ok(!!cinfo && inside(pad, cinfo), 'inside the counter info window');
  ok(!inside(pad, main), 'and not loose in the panel beside the counter');

  // And the settings section added for the handoff sits in the settings panel.
  const handoff = span('handoff-details');
  ok(!!handoff, 'the handoff settings block is there');
  ok(handoff.start > BODY.indexOf('id="settings-ov"'),
     'inside the settings overlay, not loose in the page');
}

console.log('\nevery id the interface reaches for exists exactly once');
{
  // A duplicate id is the other silent one: getElementById answers with the
  // first, and half the code then updates an element nobody sees.
  const ids = [...BODY.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  ok(dupes.length === 0, dupes.length ? `duplicated: ${dupes.join(', ')}` : `${ids.length} ids, all distinct`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
