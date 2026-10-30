const APP_ICON = "data:image/png;base64,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";

// ═══════════════════════════════════════════════════════
// Volume type icons — SVG sprite (uploaded by user), currentColor-driven
// ═══════════════════════════════════════════════════════
const VOL_ICON_SPRITE = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-sdcard" viewBox="0 0 18 22"><path d="M3,21c-1.1,0-2-.9-2-2V3c0-1.1.9-2,2-2h8c.6,0,1.3.3,1.7.7l3.6,3.6c.5.5.7,1.1.7,1.7v12c0,1.1-.9,2-2,2H3Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line x1="4.8" y1="4.8" x2="4.8" y2="6.9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line x1="7.5" y1="4.8" x2="7.5" y2="6.9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line x1="10.3" y1="4.8" x2="10.3" y2="6.9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></symbol>
  <symbol id="i-os" viewBox="0 0 24 24"><path d="M12 17v4"/><path d="m14.305 7.53.923-.382"/><path d="m15.228 4.852-.923-.383"/><path d="m16.852 3.228-.383-.924"/><path d="m16.852 8.772-.383.923"/><path d="m19.148 3.228.383-.924"/><path d="m19.53 9.696-.382-.924"/><path d="m20.772 4.852.924-.383"/><path d="m20.772 7.148.924.383"/><path d="M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="M8 21h8"/><circle cx="18" cy="6" r="3"/></symbol>
  <symbol id="i-network" viewBox="0 0 24 24"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></symbol>
  <symbol id="i-disk" viewBox="0 0 22 18"><path d="M9,13h0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><path d="M1.2,8.6c-.1.3-.2.6-.2.9v5.5c0,1.1.9,2,2,2h16c1.1,0,2-.9,2-2v-5.5c0-.3,0-.6-.2-.9l-3.2-6.5c-.3-.7-1-1.1-1.8-1.1H6.2c-.8,0-1.5.4-1.8,1.1l-3.2,6.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><path d="M20.9,9H1.1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><path d="M5,13h0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></symbol>
</svg>`;
document.body.insertAdjacentHTML('afterbegin', VOL_ICON_SPRITE);

// icon symbol id, per volume classification
function volIconSymbol(v) {
  if (v.isNetwork)                return 'i-network';
  if (v.isSystem)                 return 'i-os';
  if (v.fsType === 'sdcard')      return 'i-sdcard';
  // Disk-level heuristics (protocol/media name) can miss real SD readers that
  // don't report "SD" explicitly. A detected camera on the volume is a much
  // stronger signal that this is actually a memory card, not a generic drive.
  if (v.camera)                   return 'i-sdcard';
  return 'i-disk';                // external / unrecognized
}

function getVolIcon(v, isSrc, isDst) {
  const sym = volIconSymbol(v);
  const color = isSrc ? 'var(--red)' : isDst ? 'var(--green)' : 'var(--text3)';
  return `<svg style="width:48px;height:48px;color:${color}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#${sym}"/></svg>`;
}

function getZoneIcon(zone) {
  if (zone === 'src') {
    return `<svg style="width:20px;height:20px;color:var(--red)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-sdcard"/></svg>`;
  }
  return `<svg style="width:20px;height:20px;color:var(--green)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-folder"/></svg>`;
}
