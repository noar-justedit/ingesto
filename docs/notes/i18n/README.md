# Traduction de l'interface (2.9.0)

## Comment ça marche
- `src/renderer/i18n.js` : le moteur. `index.html` reste en anglais ; une fois
  la page chargée, le moteur remplace les textes visibles par ceux du
  dictionnaire de la langue choisie. Un texte absent du dictionnaire reste en
  anglais. En anglais, le moteur ne fait rien.
- `src/renderer/lang/fr.js` : le dictionnaire français. Même format que le
  `zh-CN.js` de wibi8bo (fork github.com/wibi8bo/ingesto, 2.8.1), plus deux
  sections : `blocks` (paragraphes entiers avec leurs balises `<b>`, `<code>`)
  et `blockPatterns` (les mêmes avec un nom ou un nombre). Son fichier chinois
  se branche donc tel quel : une ligne `<script>` dans `index.html`, une
  entrée dans `LANGS` (i18n.js).
- Jamais traduit : ce que l'utilisateur a tapé ou ce qui vient des disques
  (noms de cartes, de disques, de dossiers, de fichiers, notes, opérateur,
  modèles enregistrés). Liste `USER_DATA` dans i18n.js, plus
  `data-i18n-skip` là où le HTML est construit.
- Langue : celle du système au premier lancement si elle existe, sinon
  l'anglais ; ensuite celle choisie dans Réglages, gardée dans les
  préférences (`language`).
- Hors de la fenêtre (depuis 2.9.0) : les textes construits en JavaScript
  passent par `tr()` / `trf()` (index.html : notifications, rapports HTML et
  CSV, `mode`/`result` du JSON) ; le processus principal par `i18n.t()`
  (`src/main/lang.js`, qui lit les mêmes fichiers `lang/*.js` : dialogues
  pour quitter, titres d'export/import, libellés de la note `.md`). Dans le
  JSON et le Card Handoff, noms de champs et codes restent en anglais.
- `trf('{n} files', {n})` : le texte est traduit, puis les `{valeurs}`
  remplacées. Les clés n'ont jamais d'espace au début ni à la fin.
- Noms de dossier : règle selon la langue (`nameRule()`), voir ETAT_PROJET.

## Outils de ce dossier (navigateur Chromium, Playwright)
Playwright n'est pas une dépendance du projet : l'installer à part et donner
son chemin dans `NODE_PATH`.

- `page.js` : ouvre la vraie interface avec un faux `window.ingesto` et des
  données de démo, dans la langue voulue.
- `inventory.js` : liste les textes anglais du HTML statique.
- `userdata.js` : donne aux cartes, disques, dossiers et notes des noms qui
  sont dans le dictionnaire (« Missing », « Matched »…) et échoue si l'un
  d'eux sort traduit. À relancer après toute modification de l'interface.
- `board.js <langue> <dossier>` : capture 42 écrans dans la langue, repère
  chaque texte traduit sur la capture, liste ce qui est resté en anglais.
  Écrit `board.json` et `screens/*.png`.
- `make-board-page.js <dossier board> <dossier page>` + `board-page.html` :
  fabrique la planche de relecture publiée en Artifact. Chaque avis (OK,
  correction) est rangé dans la base de l'Artifact : collection `review`,
  un document par entrée du dictionnaire (`status`, `fr`, `key`, `was`),
  et `questions` pour les choix de vocabulaire.

## Planche de relecture FR
- Publiée le 23.10.2026 : https://claude.ai/artifact/5ynQ27d15BXmiofB1LV3gA
  (privée, sur le compte de Noar). Relue le 23.10 : 737 textes validés, aucune
  correction. Les textes ajoutés ensuite (lot 2, INSERT YOUR CARD) n'y sont
  pas : republier la planche pour les relire.
- Pour appliquer les corrections : lire la collection `review` (outil
  ArtifactData), reporter chaque `fr` dans `lang/fr.js` à la clé `key`,
  relancer `npm test`, `userdata.js`, `board.js`, puis republier la planche
  pour un second passage sur ce qui a changé.

## Vérifications automatiques (npm test)
`scripts/test-i18n.js` : le moteur est chargé au bon endroit, la langue est
sauvée et relue, les données utilisateur sont exclues, et pour chaque
dictionnaire : pas de tiret long, pas de traduction vide, motifs valides et
ancrés, chaque valeur capturée (nom, nombre) réaffichée, chaque `{variable}`
gardée, mêmes balises dans les paragraphes, noms des modes gardés.
