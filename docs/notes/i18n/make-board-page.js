// Turns board.json (made by board.js) into the review page: one HTML file
// plus the captures, ready to publish as a claude.ai Artifact.
//
//   node docs/notes/i18n/make-board-page.js <board folder> <out folder>
//
// The page stores each review in the artifact's database (collection
// "review", one document per dictionary entry, id = "e" + hash of the
// entry). read-reviews.js, next to this file, turns them back into edits.
const fs = require('fs');
const path = require('path');

const IN = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const board = JSON.parse(fs.readFileSync(path.join(IN, 'board.json'), 'utf8'));
const VERSION = require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });

// Stable id of a dictionary entry: FNV-1a over kind + key.
function idOf(kind, key) {
  let h = 0x811c9dc5;
  const s = kind + '\u0000' + key;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'e' + h.toString(36);
}
const kindOfEntry = { text: 'text', attr: 'attr', pattern: 'pattern', block: 'block', blockPattern: 'blockPattern' };

// Dictionary entries, numbered in the order the screens show them.
const byKey = new Map();   // key -> entry
for (const e of board.entries) byKey.set(e.key, e);
const order = [];
const num = new Map();
const take = key => { if (!num.has(key) && byKey.has(key)) { num.set(key, order.length + 1); order.push(key); } };
for (const s of board.screens) for (const it of s.items) for (const k of String(it.key).split(' + ')) take(k);
const unseen = board.entries.filter(e => !num.has(e.key));
for (const e of unseen) take(e.key);

// A regex made readable: groups become [1], [2]...
function readable(src) {
  let n = 0;
  return src.replace(/^\^|\$$/g, '')
    .replace(/\((?!\?)(?:[^()\\]|\\.)*\)/g, () => '[' + (++n) + ']')
    .replace(/\(\?:([^()]*)\)/g, (m, a) => a.split('|')[0])
    .replace(/\\(.)/g, '$1').replace(/s\?/g, 's');
}
const readableTpl = t => t.replace(/\$(\d)/g, '[$1]');

const entries = order.map(k => {
  const e = byKey.get(k);
  const isPat = e.kind === 'pattern' || e.kind === 'blockPattern';
  const ex = [];
  for (const s of board.screens) for (const it of s.items) if (it.key === k && ex.length < 1) ex.push({ en: it.en, tr: it.tr });
  return {
    id: idOf(kindOfEntry[e.kind], k), n: num.get(k), kind: e.kind, section: e.section || '',
    key: k, tr: e.tr,
    en: ex[0] ? ex[0].en : (isPat ? readable(k) : k),
    fr: ex[0] ? ex[0].tr : (isPat ? readableTpl(e.tr) : e.tr),
    pattern: isPat, seen: e.seen,
  };
});
const idByKey = new Map(entries.map(e => [e.key, e.id]));

const screens = board.screens.map(s => {
  fs.copyFileSync(path.join(IN, s.img), path.join(OUT, s.img));
  const marks = [], ids = [];
  for (const it of s.items) {
    const parts = String(it.key).split(' + ').map(k => idByKey.get(k)).filter(Boolean);
    for (const id of parts) if (!ids.includes(id)) ids.push(id);
    for (const id of parts) {
      marks.push({ id, kind: it.kind, x: +(Math.max(it.x, 18) / s.w * 100).toFixed(2), cy: +((it.y + it.h / 2) / s.h * 100).toFixed(2) });
      break;   // a line built from parts gets one marker, on its first part
    }
  }
  return { id: s.id, title: s.title, img: s.img, w: s.w, h: s.h, marks, ids,
           english: s.english.map(x => x.text) };
});

const DATA = { version: VERSION, made: board.made, screens, entries };
const QUESTIONS = [
  { id: 'q-units', q: 'Unités de taille', a: ['GB, TB (comme en anglais)', 'Go, To (usage français)'], hint: 'Aujourd\'hui : « 26.4 GB libres ». En français on écrit aussi 26,4 Go, avec une virgule.' },
  { id: 'q-ingest', q: 'Le mot « ingest »', a: ['Garder « ingest »', 'Dire « copie »', 'Dire « déchargement »'], hint: 'Aujourd\'hui : « Lancer l\'ingest », « Historique des ingests ».' },
  { id: 'q-checksum', q: 'Le mot « checksum »', a: ['Garder « checksum »', 'Dire « somme de contrôle »'], hint: 'Aujourd\'hui : « Liste de checksums ».' },
  { id: 'q-modes', q: 'Noms des modes FAST, SIZE CHECK, SECURE, PRO', a: ['Les garder en anglais', 'Les traduire'], hint: 'Ils sont aussi écrits dans les rapports et le JSON.' },
];

const page = fs.readFileSync(path.join(__dirname, 'board-page.html'), 'utf8')
  .replace('/*@@DATA@@*/null', () => JSON.stringify(DATA).replace(/</g, '\\u003c'))
  .replace('/*@@QUESTIONS@@*/null', () => JSON.stringify(QUESTIONS).replace(/</g, '\\u003c'))
  .replace(/@@VERSION@@/g, VERSION);
fs.writeFileSync(path.join(OUT, 'relecture-fr.html'), page);
console.log(`${entries.length} entrées, ${screens.length} écrans -> ${path.join(OUT, 'relecture-fr.html')}`);
