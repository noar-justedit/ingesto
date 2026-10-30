// What kind of source a path is. Shared by the engine and the window (see
// folder-names.js for how a shared file is loaded on each side).
(function (root) {
'use strict';

// A CODEX Platform HDE volume: its name ends in "_hde" (A003_hde), and a folder
// dropped from inside it carries that segment in its path. A volume produced
// on read under its ordinary name (CODEX Platform on ALEXA LF media) is found
// by the engine from the mount table instead (isVirtualSource, mounts.js).
function isHdeSource(p) {
  return String(p || '').split(/[\\/]/).some(seg => /_hde$/i.test(seg));
}

const api = { isHdeSource };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.IngestoShared = Object.assign(root.IngestoShared || {}, api);
})(typeof window !== 'undefined' ? window : this);
