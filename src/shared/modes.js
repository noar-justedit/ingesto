// The four copy modes. Shared by the engine and the window.
//
// The VALUES are the ones written everywhere a mode is recorded: the
// preferences, the card log (.ingesto.json), the reports, the handoff
// document, the messages between the window and the engine. They date from
// the first versions and stay as they are, so that every file written by an
// earlier ingesto still reads the same. The NAMES say what each mode is:
//   FAST        copy only
//   SIZE_CHECK  copy, then compare sizes            (value 'normal')
//   SECURE      copy, then read every copy back     (value 'slow')
//   PRO         SECURE, plus manifests, a choice of algorithm and the card re-read
(function (root) {
'use strict';

const MODE = Object.freeze({ FAST: 'fast', SIZE_CHECK: 'normal', SECURE: 'slow', PRO: 'pro' });
const MODES = Object.freeze([MODE.FAST, MODE.SIZE_CHECK, MODE.SECURE, MODE.PRO]);
// SECURE and PRO read every copy back and compare its contents; FAST and
// SIZE CHECK do not, whatever the result says.
function modeVerifiesContents(mode) { return mode === MODE.SECURE || mode === MODE.PRO; }

const api = { MODE, MODES, modeVerifiesContents };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.IngestoShared = Object.assign(root.IngestoShared || {}, api);
})(typeof window !== 'undefined' ? window : this);
