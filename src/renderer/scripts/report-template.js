// The fixed parts of the HTML ingest report written on each destination: its
// stylesheet and the script that unfolds the file lists and prints the PDF.
// buildReportHtml (reports.js) puts them in every report it writes. They are
// text that ends up in the report file, not code of this window: the report is
// a standalone page that must open anywhere, without ingesto.
const REPORT_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0a0b0e;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 34px;display:flex;flex-direction:column;gap:12px;}
.card{background:#14161c;border-radius:14px;padding:18px 20px;}
.hd{display:flex;align-items:flex-start;gap:16px;}
.brand{font-weight:700;font-size:19px;letter-spacing:-.4px;}.brand span{color:#8b6ff0;}
.ttl{font-size:11px;font-weight:700;letter-spacing:.15em;color:#8b909b;margin-top:7px;}
.path{font-size:12px;color:#aeb3bd;font-family:ui-monospace,Menlo,monospace;margin-top:9px;overflow-wrap:anywhere;}
.meta{font-size:11.5px;color:#808693;margin-top:6px;}
.pdf{flex-shrink:0;padding:9px 15px;border-radius:9px;border:none;background:#0e1014;color:#aeb3bd;
font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;}
.pdf:hover{color:#e8eaf0;}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:16px;}
.tile{background:#0e1014;border-radius:10px;padding:11px 12px;}
.tile b{display:block;font-size:15px;font-weight:600;letter-spacing:-.2px;}
.tile span{display:block;font-size:9px;font-weight:700;letter-spacing:.13em;color:#8b909b;margin-top:5px;}
table{width:100%;border-collapse:separate;border-spacing:0 4px;font-size:12.5px;}
thead th{text-align:left;color:#6f757f;font-weight:700;font-size:9px;letter-spacing:.14em;padding:0 11px 8px;white-space:nowrap;}
tbody td{padding:11px;background:#0e1014;font-family:ui-monospace,Menlo,monospace;white-space:nowrap;vertical-align:middle;}
tbody tr.rec td:first-child{border-radius:9px 0 0 9px;}
tbody tr.rec td:last-child{border-radius:0 9px 9px 0;}
.c-num{color:#8b909b;font-weight:700;}.c-mut{color:#aeb3bd;}.c-r{text-align:right;}
td.m-fast,td.m-sizecheck,td.m-verified,td.m-secure,td.m-pro{white-space:normal;min-width:132px;}
.c-path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#6f757f;margin-top:4px;}
.c-txt{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;white-space:normal;max-width:190px;}
.md-note p,.md-note h3,.md-note ul,.md-note ol{margin:0;}.md-note h3{font-size:inherit;font-weight:700;}
.md-note ul,.md-note ol{padding-left:16px;}.md-note ul.task{list-style:none;padding-left:0;}
.md-note ul.task li::before{content:'☐ ';}.md-note ul.task li.done::before{content:'☑ ';}.md-note ul.task li.done{text-decoration:line-through;opacity:.7;}
/* One colour code, the app's: FAST grey, SIZE CHECK blue, SECURE orange, PRO
   violet. m-verified is the old class name of SIZE CHECK, kept so a report
   written before 2.7.0 stops printing an unverified mode in green. */
.m-fast{color:#8b909b;font-weight:600;}
.m-sizecheck,.m-verified{color:#4d90f0;font-weight:600;}
.m-secure{color:#f2a03d;font-weight:600;}.m-pro{color:#a880ff;font-weight:600;}
.r-ok,.r-err,.r-suspect{font-size:9px;font-weight:700;letter-spacing:.06em;padding:3px 7px;border-radius:4px;}
.r-ok{color:#35c98b;background:rgba(53,201,139,.15);}
.r-err{color:#f2555a;background:rgba(242,85,90,.15);}
.r-suspect{color:#f2a03d;background:rgba(242,160,61,.15);}
.tv{display:inline-block;min-width:38px;text-align:right;}
.t-sep{display:inline-block;width:14px;text-align:center;color:#4a4f58;}
.t-copy{color:#35c98b;font-weight:600;}.t-v1{color:#4d90f0;font-weight:600;}
.t-v2{color:#a880ff;font-weight:600;}.t-na{color:#4a4f58;}
.c-chev{cursor:pointer;color:#6f757f;width:22px;text-align:center;user-select:none;font-family:inherit;}
.c-chev:hover{color:#e8eaf0;}
.det td{background:transparent !important;padding-top:0;}
.fl-hd{font-size:10px;color:#6f757f;font-weight:700;letter-spacing:.12em;margin:2px 0 6px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;}
.fl-list{max-height:260px;overflow:auto;border-radius:9px;padding:8px 11px;margin-bottom:8px;background:#0e1014;}
.fl-row{display:flex;justify-content:space-between;gap:16px;padding:2px 0;font-size:12px;}
.fl-p{color:#aeb3bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fl-s{color:#6f757f;flex-shrink:0;}
.er td{background:transparent !important;padding-top:0;white-space:normal;}
.er-list{border-radius:9px;padding:7px 11px;background:rgba(242,85,90,.07);font-size:11.5px;}
.er-row{display:flex;gap:12px;padding:2px 0;align-items:baseline;}
.er-p{flex-shrink:0;min-width:92px;color:#f2555a;font-weight:700;font-size:9px;letter-spacing:.08em;text-transform:uppercase;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;}
.er-warn .er-p{color:#f2a03d;}
.er-f{flex-shrink:0;color:#e8eaf0;max-width:42%;overflow-wrap:anywhere;}
.er-m{color:#aeb3bd;overflow-wrap:anywhere;}
.er-more{color:#6f757f;}
.r-click{cursor:pointer;user-select:none;}.r-click:hover{filter:brightness(1.25);}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:11px;color:#808693;padding:12px 2px 0;}
.legend b{font-weight:600;}
.ft{font-size:11px;color:#6f757f;padding:0 2px;line-height:1.6;}
@media (max-width:760px){.tiles{grid-template-columns:repeat(2,1fr);}
.wrap{padding:14px 12px 26px;}.card{padding:15px;}}
@media print{:root{color-scheme:light}
body{background:#fff;color:#16181d;}
.wrap{max-width:none;padding:0;gap:14px;}
.card{background:#fff;padding:0 0 12px;border-bottom:1.5px solid #16181d;border-radius:0;}
.pdf,.c-chev{display:none;}
.ttl,.meta,.c-path{color:#666;}.path{color:#333;}
.tile{background:#f4f4f6;}.tile span{color:#666;}
thead th{color:#555;border-bottom:1px solid #ccc;}
tbody td{background:#fff;border-bottom:1px solid #eee;}
tbody tr.rec:nth-child(even) td{background:#fafafa;}
.c-mut{color:#444;}.c-num{color:#555;}
.det td:first-child{display:none;}
.fl-list{max-height:none;overflow:visible;background:#fff;border:1px solid #ddd;}
.fl-hd{color:#555;}.fl-p{color:#333;}.fl-s{color:#666;}
.er-list{background:#fdf3f3;border:1px solid #f3d0d0;}.er-p{color:#c62828;}.er-warn .er-p{color:#a85c00;}
.er-f{color:#16181d;}.er-m{color:#444;}
.det td:first-child,.er td:first-child:not([colspan]){display:none;}
.m-fast{color:#5a6069;}.m-sizecheck,.m-verified{color:#1a73c7;}
.m-secure{color:#b45309;}.m-pro{color:#7c3aed;}
.r-ok{color:#0f7a45;background:#e6f5ec;}.r-err{color:#c62828;background:#fdecec;}
.r-suspect{color:#a85c00;background:#fdf1e0;}
.t-copy{color:#0f7a45;}.t-v1{color:#1a73c7;}.t-v2{color:#6b3fd4;}.t-na,.t-sep{color:#999;}
.legend,.ft{color:#666;}}
`;

const REPORT_VIEWER_JS = `var _D=null,_B=[],_P=null;function _sz(b){if(!b)return'0 B';var u=['B','KB','MB','GB','TB'],i=0;while(b>=1000&&i<4){b/=1000;i++;}return(i?b.toFixed(1):Math.round(b))+' '+u[i];}
function _esc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function _bin(s){var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
// Decoding is kicked off AT LOAD and its result cached, so that everything the
// print path touches stays SYNCHRONOUS. This matters: window.print() blocks the
// main thread, so an async beforeprint handler returns before it has built
// anything and the browser prints empty file lists. Chrome/Firefox/Edge fire
// beforeprint on Cmd+P and on File > Print — the gesture a user is most likely
// to make and least likely to notice is broken.
// Reports written before 2.4.7 hold plain JSON; newer ones hold gzip+base64.
async function _decode(){
  var el=document.getElementById('ingesto-report-data');
  // The data block is emitted before this script, but a report produced by an
  // older version puts it after: wait for the document to finish parsing rather
  // than concluding there is no data.
  if(!el && document.readyState==='loading'){
    await new Promise(function(r){document.addEventListener('DOMContentLoaded',r,{once:true});});
    el=document.getElementById('ingesto-report-data');
  }
  var txt=el?((el.textContent||'').trim()):'';
  try{
    if(!el){ _D={records:[]}; return _D; }
    if(el.type!=='application/gzip+base64'){ _D=JSON.parse(txt); return _D; }
    if(typeof DecompressionStream!=='function'){ _D={records:[],_noDecomp:1}; return _D; }
    var st=new Blob([_bin(txt)]).stream().pipeThrough(new DecompressionStream('gzip'));
    _D=JSON.parse(await new Response(st).text());
  }catch(e){ _D={records:[],_bad:1}; }
  return _D;
}
function _ready(){ if(!_P) _P=_decode(); return _P; }
// Synchronous once _D is in memory; a no-op in the first few ms after load.
function _fill(i){
  if(_B[i]||!_D) return;
  var r=(_D.records||[])[i]||{},f=r.f||[],h='';
  var row=document.getElementById('det-'+i); if(!row) return;
  var c=row.getElementsByTagName('td')[1];
  if(_D._noDecomp){c.innerHTML='<div class="fl-hd">'+_esc(_L.none)+'</div><div class="fl-list"><div class="fl-row">'+_esc(_L.noneWhy)+'</div></div>';_B[i]=1;return;}
  if(_D._bad){c.innerHTML='<div class="fl-hd">'+_esc(_L.bad)+'</div><div class="fl-list"><div class="fl-row">'+_esc(_L.badWhy)+'</div></div>';_B[i]=1;return;}
  for(var k=0;k<f.length;k++){h+='<div class="fl-row"><span class="fl-p">'+_esc(f[k][0])+'</span><span class="fl-s">'+_sz(f[k][1])+'</span></div>';}
  c.innerHTML='<div class="fl-hd">'+_esc((f.length>1?_L.many:_L.one).replace('{n}',f.length))+'</div><div class="fl-list">'+h+'</div>';_B[i]=1;}
// The open/closed state is read AFTER the await, or two fast clicks during
// the first decode both see "closed" and both open the row.
async function tgl(i){
  await _ready();
  var d=document.getElementById('det-'+i),c=document.getElementById('ch-'+i);if(!d)return;
  var open=d.style.display!=='none';
  if(!open)_fill(i);
  d.style.display=open?'none':'table-row';if(c)c.textContent=open?'\u25b8':'\u25be';}
function tge(i){var e=document.getElementById('er-'+i),b=document.getElementById('eb-'+i);if(!e)return;
var open=e.style.display!=='none';e.style.display=open?'none':'table-row';if(b)b.textContent=open?'\u25b8':'\u25be';}
function _all(){var x=document.querySelectorAll('tr.er');
for(var j=0;j<x.length;j++){x[j].style.display='table-row';var eb=document.getElementById('eb-'+x[j].id.slice(3));if(eb)eb.textContent='\u25be';}
var t=document.querySelectorAll('tr.det');
for(var i=0;i<t.length;i++){var n=+t[i].id.slice(4);_fill(n);t[i].style.display='table-row';
var c=document.getElementById('ch-'+n);if(c)c.textContent='\u25be';}}
// Safari implements neither beforeprint nor afterprint, so the button does the
// work itself; everywhere else beforeprint covers Cmd+P and the File menu.
async function _pdf(){await _ready();_all();window.print();}
window.addEventListener('beforeprint',_all);
// Kick off decoding now. The data block above is already in the DOM at this
// point — it MUST stay before this script: when it came after, this call found
// no element and every report opened with an empty history.
_ready();`;
