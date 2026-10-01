// Produit docs/manual/ingesto-manual-en.pdf et ingesto-manual-fr.pdf a partir de
// manual-en.html / manual-fr.html. Mode d'emploi : docs/manual/tools/README.md
//   node docs/manual/tools/build-pdf.js          les deux langues
//   node docs/manual/tools/build-pdf.js fr       une seule
//
// Un seul rendu par langue : la numerotation et le pied de page sont faits en CSS
// (@page et ses marges), sans fusion de PDF. Fusionner avec PDFKit ou l'outil
// d'Automator recompressait les images et triplait la taille du fichier.
const path = require('path');
const { chromium } = require('playwright');

const DIR = path.resolve(__dirname, '..');
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'fr'];

(async () => {
  const b = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
  for (const l of langs) {
    const p = await b.newPage();
    await p.goto('file://' + path.join(DIR, `manual-${l}.html`), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.pdf({ path: path.join(DIR, `ingesto-manual-${l}.pdf`), printBackground: true, preferCSSPageSize: true, tagged: true, outline: true });
    console.log('ok', l);
  }
  await b.close();
})();
