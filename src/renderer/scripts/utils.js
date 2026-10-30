// ═══════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════
// Sizes in decimal units (1 GB = 1,000,000,000 bytes), as the Finder, Windows
// Explorer's drive labels and every card maker count them. Dividing by 1024
// under the same unit names would make a 128 GB card read "119.2 GB", and no
// figure would match the one in the Finder.
function fmtSize(b){if(!b||b<1)return'0 B';const u=['B','KB','MB','GB','TB','PB'],i=Math.min(u.length-1,Math.floor(Math.log10(b)/3));return i?`${(b/Math.pow(1000,i)).toFixed(1)} ${u[i]}`:`${Math.round(b)} B`;}
function fmtSizePair(rem,tot){
  if(!tot||tot<=0)return'-';
  const u=['B','KB','MB','GB','TB'];
  // Use the unit appropriate for the TOTAL so both numbers share the same scale
  const i=Math.min(u.length-1,Math.max(0,Math.floor(Math.log10(tot)/3)));
  const div=Math.pow(1000,i);
  const r=rem<0?0:rem;
  const fr=(r/div).toFixed(i>=3?1:0);
  const ft=(tot/div).toFixed(i>=3?1:0);
  return`${fr} ${u[i]} <span class="stot">(${ft} ${u[i]})</span>`;
}
function fmtSpd(b){return b>0?`${fmtSize(b)}/s`:'-';}
// The same spelling as fmtReportDur(): "11m03s", "1h05m", so the window never
// says "11m3s" while the history and the report say "11m03s".
function fmtEta(s){if(!s||!isFinite(s)||s<=0)return'-';const t=Math.round(s);if(t<60)return`${t}s`;if(t<3600)return`${Math.floor(t/60)}m${String(t%60).padStart(2,'0')}s`;return`${Math.floor(t/3600)}h${String(Math.floor((t%3600)/60)).padStart(2,'0')}m`;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
async function openJE(){await window.ingesto.openExternal('https://www.just-edit.fr');}
