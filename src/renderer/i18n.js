/* ============================================================
 * ingesto interface translation engine
 * ------------------------------------------------------------
 * Same design as the Chinese translation made by wibi8bo in his fork
 * (github.com/wibi8bo/ingesto, 2.8.1, GPL-3.0), so that a language file
 * written for one plugs into the other unchanged.
 *
 * How it works: index.html and scripts/ stay in English, code untouched.
 * Once the page is loaded, this script replaces the VISIBLE English texts
 * with the chosen language, looked up in a dictionary. A text missing from
 * the dictionary simply stays in English: nothing breaks, nothing is lost.
 *
 * Adding a language = one file in lang/ (it sets its dictionary on window),
 * one <script> line in index.html, and one entry in LANGS below. The
 * language menu in Settings is built from LANGS.
 *
 * Covered: whole paragraphs with their inline tags, text nodes, the title / placeholder / aria-label / data-tip /
 * data-ph attributes, whole innerHTML replacement by element id, text added
 * later by the code (a MutationObserver follows it), window.confirm/alert.
 * Not covered here: what the main process writes (dialogs, notifications,
 * the report files). Those are translated on their own side.
 *
 * What must NEVER be translated is marked data-i18n-skip (index.html, scripts/):
 * user data (card, drive, folder and file names, notes, operator...). A
 * card called "Done" stays "Done". scripts/test-i18n.js checks it.
 * ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'ingesto-language';

  /* Installed languages. dictName is the window variable the file sets. */
  var LANGS = {
    'en': { label: 'English', dictName: null },
    'fr': { label: 'Français', dictName: 'INGESTO_LANG_FR' }
  };

  /* Attributes that are shown to the user. data-ph is the placeholder of the
   * rich notes editor: CSS draws it with content:attr(data-ph), so it is not
   * a text node. */
  var ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'data-ph'];

  /* Never walked into. SVG is walked on purpose: only whitelisted attributes
   * and text nodes are changed, and its only text is an icon <title>. */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1 };

  /* User data, by the class the interface gives it: drive names (.vc-name),
   * loaded cards and destinations (.zi-name, .src-info-name, .sc-name,
   * .kl-name, .tf-nm), history lines (.sess-name, .sess-folder), template
   * parts typed by the user (.tok-txt), notes (.md-note, .mdn), names in the
   * refusal windows (#pf-ov .m), folder names and paths (.sic-preview,
   * .zi-folder, .zi-path, .sc-path, .c-path), file names (.tf-file,
   * .fg-file, .fg-files, .vf-file, .krun-file, .ufc-fitem). Anything else
   * is marked data-i18n-skip where it is built (a saved template's name,
   * history details). docs/notes/i18n/userdata.js checks it with real names.
   */
  var USER_DATA = '[data-i18n-skip], .vc-name, .zi-name, .src-info-name, .sc-name, .kl-name, ' +
                  '.sess-name, .sess-folder, .tok-txt, .md-note, .mdn, #pf-ov .m, ' +
                  '.tf-nm, .sic-preview, .zi-folder, .zi-path, .sc-path, .c-path, .tf-file, .fg-file, ' +
                  '.fg-files, .vf-file, .krun-file, .ufc-fitem';

  var current = 'en';
  var dict = null;          // null in English: the engine then does nothing
  var patterns = [];        // compiled [RegExp, template, source]
  var blockPatterns = [];   // the same, for whole paragraphs (see translateBlock)
  var observer = null;

  /* What was translated, to restore English exactly when switching back.
   * An entry is restored only if the node still shows our translation: if the
   * code changed it since, it is newer than both and is left alone. `key` is
   * the dictionary entry used (the review board numbers them). */
  var touchedText = new Map();   // TextNode -> {orig, applied, key}
  var touchedAttr = new Map();   // Element  -> {attr: {orig, applied, key}}
  var touchedHtml = new Map();   // Element  -> {orig, applied, key}

  /* French puts a no-break space before : ; ? ! and inside « ». Dictionaries
   * are typed with plain spaces (easier to read and to edit); a dictionary
   * that sets frenchSpacing: true gets them here, when the text is applied. */
  function finish(text) {
    if (!dict || !dict.frenchSpacing || text == null) return text;
    return String(text).replace(/ ([:;?!»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
  }

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  /* First launch only (no language chosen yet): the system language if it is
   * installed, English otherwise. Saved at once, so a later change of the
   * system language does not switch the app behind the user's back. */
  function detectSystemLang() {
    try {
      var sys = String(navigator.language || 'en').toLowerCase();
      for (var code in LANGS) {
        if (!has(LANGS, code) || code === 'en') continue;
        var c = code.toLowerCase();
        if (sys === c || sys.indexOf(c.split('-')[0] + '-') === 0 || sys === c.split('-')[0]) {
          if (loadDict(code)) return code;
        }
      }
    } catch (e) { /* fall through */ }
    return 'en';
  }

  function getSavedLang() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }
    if (saved && LANGS[saved]) return saved;
    saved = detectSystemLang();
    saveLang(saved);
    return saved;
  }
  function saveLang(l) {
    try { localStorage.setItem(STORAGE_KEY, l); } catch (e) { /* ignored */ }
  }

  function loadDict(lang) {
    var meta = LANGS[lang];
    return (meta && meta.dictName) ? (window[meta.dictName] || null) : null;
  }

  function compilePatterns(d) {
    var out = [];
    if (d && d.patterns) {
      for (var i = 0; i < d.patterns.length; i++) {
        try { out.push([new RegExp(d.patterns[i][0]), d.patterns[i][1], d.patterns[i][0]]); }
        catch (e) { /* a broken pattern is skipped, the text stays in English */ }
      }
    }
    return out;
  }

  /* Status lines such as "3 cards left · 155.8 MB total · ~5s left" combine
   * freely and cannot all be listed. When the whole line is not found, each
   * part between ' · ' is looked up; the line is rebuilt only if EVERY part
   * was found, so a user name containing ' · ' is never half translated. */
  function lookupComposite(key) {
    var SEP = ' · ';
    if (key.indexOf(SEP) === -1) return null;
    var parts = key.split(SEP);
    var out = [], keys = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) return null;
      var hit = lookup(parts[i]);
      if (hit == null) return null;
      out.push(hit.text); keys.push(hit.key);
    }
    return { text: out.join(SEP), key: keys.join(' + ') };
  }

  /* texts, then attrs, then patterns, then ' · ' parts. null = keep English. */
  function lookup(s) {
    if (!s || !dict) return null;
    var key = norm(s);
    if (!key) return null;
    if (dict.texts && has(dict.texts, key)) return { text: finish(dict.texts[key]), key: key };
    if (dict.attrs && has(dict.attrs, key)) return { text: finish(dict.attrs[key]), key: key };
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i][0].test(key)) return { text: finish(key.replace(patterns[i][0], patterns[i][1])), key: patterns[i][2] };
    }
    return lookupComposite(key);
  }
  function translateString(s) { var h = lookup(s); return h ? h.text : null; }

  function translateTextNode(node) {
    var prev = touchedText.get(node);
    if (prev && node.data === prev.applied) return;
    var orig = node.data;
    var hit = lookup(orig);
    if (hit == null || hit.text === norm(orig)) return;
    var lead = /^\s*/.exec(orig)[0];
    var trail = /\s*$/.exec(orig)[0];
    var applied = lead + hit.text + trail;
    touchedText.set(node, { orig: orig, applied: applied, key: hit.key });
    node.data = applied;
  }

  function translateAttrs(el) {
    if (el.closest && el.closest(USER_DATA)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var orig = el.getAttribute(a);
      var rec = touchedAttr.get(el);
      if (rec && rec[a] && orig === rec[a].applied) continue;
      var hit = lookup(orig);
      if (hit == null || hit.text === orig) continue;
      if (!rec) { rec = {}; touchedAttr.set(el, rec); }
      rec[a] = { orig: orig, applied: hit.text, key: hit.key };
      el.setAttribute(a, hit.text);
    }
  }

  function translateHtmlOverride(el) {
    if (!dict.html || !el.id || !has(dict.html, el.id)) return false;
    var prev = touchedHtml.get(el);
    if (prev && el.innerHTML === prev.applied) return true;
    var orig = el.innerHTML;
    el.innerHTML = dict.html[el.id];
    touchedHtml.set(el, { orig: orig, applied: el.innerHTML, key: '#' + el.id });
    return true;
  }

  /* Whole paragraphs. "<b>Copy only.</b> Files are written..." is one
   * sentence for the reader, but three text nodes for the engine, and words
   * do not come in the same order in every language. A paragraph made only
   * of text and inline tags (b, i, code, span, br...) is first looked up as a
   * whole in dict.blocks, by its HTML, then in dict.blockPatterns (for the
   * ones that carry a name or a number). The translation brings its own
   * tags. Not found: the engine goes down to the text nodes as usual.
   * wibi8bo's `html` (by element id) is honoured too, before this. */
  var INLINE = { B: 1, I: 1, U: 1, S: 1, EM: 1, STRONG: 1, CODE: 1, SPAN: 1, BR: 1, A: 1, KBD: 1, SUB: 1, SUP: 1 };
  function isBlock(el) {
    var text = false, tag = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (/\S/.test(c.data)) text = true; continue; }
      if (c.nodeType !== 1) continue;
      if (!INLINE[c.tagName] || c.hasAttribute('data-i18n-skip') || c.hasAttribute('id')) return false;
      for (var g = c.firstElementChild; g; g = g.nextElementSibling) if (!INLINE[g.tagName]) return false;
      tag = true;
    }
    return text && tag;
  }
  function translateBlock(el) {
    if (!dict.blocks && !blockPatterns.length) return false;
    var prev = touchedHtml.get(el);
    if (prev && el.innerHTML === prev.applied) return true;
    if (!isBlock(el)) return false;
    var key = norm(el.innerHTML);
    var text = null, used = null;
    if (dict.blocks && has(dict.blocks, key)) { text = dict.blocks[key]; used = key; }
    else for (var i = 0; i < blockPatterns.length; i++) {
      if (blockPatterns[i][0].test(key)) { text = key.replace(blockPatterns[i][0], blockPatterns[i][1]); used = blockPatterns[i][2]; break; }
    }
    if (text == null) return false;
    text = finish(text);
    var orig = el.innerHTML;
    el.innerHTML = text;
    touchedHtml.set(el, { orig: orig, applied: el.innerHTML, key: used });
    return true;
  }

  /* A text node or element added inside user data must be left alone, even
   * when the observer reports it on its own (its parent is not walked then). */
  function insideSkip(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest(USER_DATA));
  }

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) { if (!insideSkip(node)) translateTextNode(node); return; }
    if (node.nodeType !== 1) return;
    var el = node;
    if (SKIP_TAGS[el.tagName]) return;
    if (el.matches && el.matches(USER_DATA)) return;
    if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) return;
    if (el.tagName === 'TEXTAREA') { translateAttrs(el); return; }   // its content is the user's
    if (el.getAttribute('contenteditable') === 'true') { translateAttrs(el); return; }
    translateAttrs(el);
    if (translateHtmlOverride(el)) return;
    if (translateBlock(el)) return;
    for (var c = el.firstChild; c; c = c.nextSibling) walk(c);
  }

  function restoreAll() {
    touchedText.forEach(function (r, n) {
      try { if (n.data === r.applied) n.data = r.orig; } catch (e) { /* node gone */ }
    });
    touchedText.clear();
    touchedAttr.forEach(function (attrs, el) {
      for (var a in attrs) {
        if (!has(attrs, a)) continue;
        try { if (el.getAttribute(a) === attrs[a].applied) el.setAttribute(a, attrs[a].orig); }
        catch (e) { /* element gone */ }
      }
    });
    touchedAttr.clear();
    touchedHtml.forEach(function (r, el) {
      try { if (el.innerHTML === r.applied) el.innerHTML = r.orig; } catch (e) { /* element gone */ }
    });
    touchedHtml.clear();
  }

  /* The records above hold every node ever translated. A label rewritten by
   * the code (progress, ~10 times a second during an ingest) is a NEW text
   * node each time, and the old one would stay in the maps for ever: a day
   * of ingests in French would grow the memory by tens of MB. English has no
   * dictionary, records nothing, and is not affected. A node no longer in the
   * page cannot be restored and is dropped; the sweep runs every few
   * thousand changes, which costs nothing next to the changes themselves. */
  var sinceSweep = 0;
  function sweep() {
    sinceSweep = 0;
    touchedText.forEach(function (r, n) { if (!n.isConnected) touchedText.delete(n); });
    touchedAttr.forEach(function (r, el) { if (!el.isConnected) touchedAttr.delete(el); });
    touchedHtml.forEach(function (r, el) { if (!el.isConnected) touchedHtml.delete(el); });
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(function (muts) {
      if (!dict) return;
      sinceSweep += muts.length;
      if (sinceSweep > 2000) sweep();
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        try {
          if (m.type === 'characterData') walk(m.target.parentElement && isBlock(m.target.parentElement) ? m.target.parentElement : m.target);
          else if (m.type === 'attributes') translateAttrs(m.target);
          else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
        } catch (e) { /* one node failing must not stop the others */ }
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  /* The language menu in Settings, built from LANGS. */
  function buildSelect() {
    var sel = document.getElementById('set-language');
    if (!sel) return;
    if (!sel.__i18nBuilt) {
      sel.__i18nBuilt = true;
      sel.innerHTML = '';
      for (var code in LANGS) {
        if (!has(LANGS, code)) continue;
        if (code !== 'en' && !loadDict(code)) continue;
        var o = document.createElement('option');
        o.value = code; o.textContent = LANGS[code].label;
        sel.appendChild(o);
      }
      sel.addEventListener('change', function () {
        setLanguage(sel.value);
        try { if (typeof window.persistPrefs === 'function') window.persistPrefs(); }
        catch (e) { /* ignored */ }
        try { if (typeof window.onLanguageChanged === 'function') window.onLanguageChanged(current); }
        catch (e) { /* ignored */ }
      });
    }
    if (sel.value !== current) sel.value = current;
  }

  /* Native dialogs are not in the page, the observer cannot see them. */
  var nativeConfirm = window.confirm;
  var nativeAlert = window.alert;
  var dialogsWrapped = false;
  function wrapDialogs() {
    if (dialogsWrapped) return;
    dialogsWrapped = true;
    window.confirm = function (msg) {
      var hit = translateString(msg);
      return nativeConfirm.call(window, hit == null ? msg : hit);
    };
    window.alert = function (msg) {
      var hit = translateString(msg);
      nativeAlert.call(window, hit == null ? msg : hit);
    };
  }
  function unwrapDialogs() {
    if (!dialogsWrapped) return;
    dialogsWrapped = false;
    window.confirm = nativeConfirm;
    window.alert = nativeAlert;
  }

  function apply(lang) {
    current = lang;
    restoreAll();
    dict = (lang === 'en') ? null : loadDict(lang);
    if (!dict) current = 'en';
    patterns = compilePatterns(dict);
    blockPatterns = compilePatterns(dict ? { patterns: dict.blockPatterns } : null);
    if (dict) wrapDialogs(); else unwrapDialogs();
    if (document.documentElement) document.documentElement.lang = current;
    if (dict && document.body) walk(document.body);
    buildSelect();
    startObserver();
  }

  function setLanguage(lang) {
    if (!LANGS[lang]) lang = 'en';
    saveLang(lang);
    apply(lang);
  }

  function init() { apply(getSavedLang()); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* For the rest of the code (t() for strings built in JavaScript) and for
   * the tools: touched() lists what is translated on screen right now. */
  window.INGESTO_I18N = {
    setLanguage: setLanguage,
    getLanguage: function () { return current; },
    languages: LANGS,
    t: function (s) { var h = translateString(s); return h == null ? s : h; },
    lookup: lookup,
    isUserData: function (node) { return insideSkip(node); },
    sweep: sweep,
    records: function () { return touchedText.size + touchedAttr.size + touchedHtml.size; },
    touched: function () {
      var out = [];
      touchedText.forEach(function (r, n) { if (n.isConnected && n.data === r.applied) out.push({ node: n, kind: 'text', orig: r.orig, applied: r.applied, key: r.key }); });
      touchedAttr.forEach(function (attrs, el) {
        for (var a in attrs) if (has(attrs, a) && el.isConnected && el.getAttribute(a) === attrs[a].applied)
          out.push({ node: el, kind: a, orig: attrs[a].orig, applied: attrs[a].applied, key: attrs[a].key });
      });
      touchedHtml.forEach(function (r, el) { if (el.isConnected) out.push({ node: el, kind: 'html', orig: r.orig, applied: r.applied, key: r.key }); });
      return out;
    }
  };
})();
