// Lists every English text the interface shows in its static markup:
// text nodes, shown attributes, and whole paragraphs (text + inline tags,
// see translateBlock in src/renderer/i18n.js). Writes inventory.json here.
//   NODE_PATH=<playwright> node docs/notes/i18n/inventory.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { open } = require('./page');

(async () => {
  const b = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
  const p = await open(b, { lang: 'en', scale: 1 });
  const inv = await p.evaluate(() => {
    const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'data-ph'];
    const INLINE = { B: 1, I: 1, U: 1, S: 1, EM: 1, STRONG: 1, CODE: 1, SPAN: 1, BR: 1, A: 1, KBD: 1, SUB: 1, SUP: 1 };
    const norm = s => String(s).replace(/\s+/g, ' ').trim();
    const isBlock = el => {
      let text = false, tag = false;
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { if (/\S/.test(c.data)) text = true; continue; }
        if (c.nodeType !== 1) continue;
        if (!INLINE[c.tagName] || c.hasAttribute('data-i18n-skip') || c.hasAttribute('id')) return false;
        for (let g = c.firstElementChild; g; g = g.nextElementSibling) if (!INLINE[g.tagName]) return false;
        tag = true;
      }
      return text && tag;
    };
    const where = el => { const h = el.closest('[id]'); return h ? '#' + h.id : el.tagName.toLowerCase(); };
    const texts = {}, attrs = {}, blocks = {};
    const walk = el => {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(el.tagName) || el.hasAttribute('data-i18n-skip')) return;
      for (const a of ATTRS) if (el.hasAttribute(a)) { const v = norm(el.getAttribute(a)); if (/[A-Za-z]/.test(v)) attrs[v] = attrs[v] || where(el); }
      if (isBlock(el)) { const k = norm(el.innerHTML); blocks[k] = blocks[k] || where(el); return; }
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { const v = norm(c.data); if (/[A-Za-z]/.test(v)) texts[v] = texts[v] || where(el); }
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(document.body);
    return { texts, attrs, blocks };
  });
  fs.writeFileSync(path.join(__dirname, 'inventory.json'), JSON.stringify(inv, null, 1));
  console.log('texts', Object.keys(inv.texts).length, 'attrs', Object.keys(inv.attrs).length, 'blocks', Object.keys(inv.blocks).length);
  await b.close();
})();
