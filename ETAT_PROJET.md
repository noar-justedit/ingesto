# ingesto : état du projet

À lire après `AGENTS.md` (règles générales). Ce fichier donne l'état d'ingesto,
ses règles propres et ce qui reste à faire. Le détail est dans `docs/notes/`.

## En bref
ingesto est une application Electron gratuite (GPL-3.0) qui copie les cartes
caméra vers plusieurs destinations à la fois et vérifie chaque fichier (DIT,
tournage). Mac, Windows et Linux. Dépôt : github.com/noar-justedit/ingesto.
Auteur : Noar (Arnaud Augst, Just Edit).

- Version du dossier : **2.7.3** (03.10.2026). Rien ne change dans l'application
  par rapport à la 2.7.2 : la 2.7.3 met en place le suivi du projet et la
  publication par `scripts/push_github.command`.
- Dernière version publiée avec binaires : 2.7.2 (tags GitHub `vX.Y.Z`).
- Tests : `npm test`, 30 suites, 1832 vérifications (1826 en 2.7.2, plus 6 pour les deux scripts de publication), toutes vertes au 03.10.2026.

## Emplacements de la version
À mettre à jour ensemble à chaque bump, puis vérifier avec
`grep -rn "X.Y.Z" --exclude-dir=node_modules .` :

1. `package.json` : champ `version`.
2. `package-lock.json` : **seulement** les deux entrées du paquet `ingesto`
   (lignes 3 et 9). Ne pas toucher aux versions des dépendances.
3. `version.json` : champ `version`. Les applications installées le lisent pour
   proposer une mise à jour : il part sur GitHub **après** la Release
   (`push_github.command` s'en charge).
4. `CHANGELOG.md` : nouvelle entrée.

Hors liste, volontairement : le manuel (`docs/manual/`) porte le numéro de la
version qu'il décrit (2.7.2 aujourd'hui). Il se met à jour quand on le
régénère (`docs/manual/tools/README.md`), pas à chaque bump.

## Règles propres à ingesto (s'ajoutent à `AGENTS.md`)
1. **La carte source n'est jamais touchée.** ingesto ne supprime, ne renomme,
   n'écrase aucun fichier d'une carte source. Toute opération destructive du
   moteur passe par le verrou (`safeUnlink`, `safeRename`, `safeRmTree`,
   `safeWriteTarget` dans `src/main/main.js`). Si `scripts/test-source-lock.js`
   casse, on corrige le code, **jamais le test**. Détail :
   `docs/notes/03-carte-source.md`.
2. **Aucun tiret cadratin** (U+2014) dans un texte visible : interface,
   messages, rapport, notes de version, documentation ajoutée. Gardé par
   `scripts/test-no-emdash.js`. Le README contient des tirets hérités : ne pas
   en ajouter.
3. **`npm test` vert avant chaque livraison.** Chaque nouveau test est vérifié
   par mutation : casser le code, voir le rouge, remettre en état.
4. **Ne jamais affaiblir** `test-source-lock.js` ni `test-executables.js`.
5. Interface, messages, rapport, README, notes de version : **en anglais**.
   Commentaires du code en anglais, qui expliquent le pourquoi.
6. Diagnostiquer et proposer avant de coder quand Noar pose une question ou
   signale un problème.
7. Ne jamais affirmer l'état du dépôt GitHub : le mesurer (`git ls-remote`,
   clone) ou demander.
8. Maquettes visuelles : **en HTML**, pas en image.
9. Jamais Google Drive, sous aucune forme.

## Architecture en bref
```
src/main/main.js          moteur : copie, vérification, IPC (38 canaux), verrou carte source
src/main/sentinel.js      Card Tracking : journal .ingesto.json sur la carte (off par défaut)
src/main/nocache.js       relecture sans cache (F_NOCACHE / purge) via koffi
src/main/camera-detect.js détection marque/modèle depuis l'arborescence de la carte
src/main/preload.js       pont window.ingesto (contextIsolation)
src/renderer/index.html   TOUTE l'interface (~8 700 lignes : HTML + CSS + JS) et le rapport HTML
scripts/test-*.js         30 suites lancées par npm test, sans Electron
scripts/build_*.command   builds depuis le Mac (lanceurs de build-mac.sh, build-win-from-mac.sh)
scripts/push_github.*     publication sur GitHub (règle 7 de AGENTS.md)
docs/manual/              manuel utilisateur EN/FR (HTML + PDF)
docs/notes/               mémoire détaillée du projet (en français)
```
Deux processus : le principal (Node) fait tout le travail disque ; l'interface,
isolée, ne lui parle que par `window.ingesto`. Copie en éventail (une lecture
de la carte, écrite sur toutes les destinations), fichiers écrits en
`*.ingesto-part` puis renommés, vérification selon le mode : FAST aucune, SIZE
CHECK tailles, SECURE relecture sans cache + xxHash64, PRO SECURE + manifestes
(MHL, ASC MHL). Détail : `docs/notes/02-architecture.md`.

## Builds
- `scripts/build_mac.command` : app Mac signée et notarisée (Apple Silicon).
  Sans certificat, build non signé. Détail : `docs/notes/06-signature-mac.md`.
- `scripts/build_win_from_mac.command` : installeur Windows croisé depuis le
  Mac, non signé (décision du 31.08 : SmartScreen au premier lancement,
  documenté).
- Linux (`.deb`, `.AppImage`) : `scripts/build-linux.sh`, **sur une machine
  Linux** (choix déjà en place, `docs/notes/06-signature-mac.md`). Pas de
  lanceur `.command` pour Linux.

## Publier une version
1. Noar confirme le numéro ; bump de tous les emplacements ci-dessus.
2. `npm test` vert. Note de version en anglais pour la Release (titre
   `# ingesto X.Y.Z`, sections par thème, section `## Tests` avec le compte réel).
3. Livraison de `ingesto_vX.Y.Z.zip`.
4. Noar décompresse, double-clique `scripts/push_github.command` : le code part,
   `version.json` est retenu.
5. Noar builde (Mac, Windows, Linux) et publie la Release `vX.Y.Z` avec les
   binaires.
6. Il relance `scripts/push_github.command` : `version.json` part, les applis
   installées voient la mise à jour.

## Décisions prises et leurs raisons
- **Verrou carte source** (22.09.2026, code en 2.7.0) : une carte est le seul
  exemplaire des rushes tant que l'ingest n'est pas fini.
- **Windows et Linux non signés** (31.08) : coût. SignPath Foundation : ne pas
  reproposer. Signature payante seulement si Just Edit devient une société.
- **Card Tracking désactivé par défaut** : seule écriture autorisée sur une
  carte, uniquement son propre journal.
- **Publication par `push_github.command`** (03.10.2026, 2.7.3) : l'envoi web
  de GitHub ne supprimait rien et perdait le bit exécutable des scripts.
- **Scripts de build renommés en `build_*.command`** (03.10.2026) : convention
  commune aux projets de Noar.
- **Suivi du projet public** (03.10.2026) : `docs/notes/` et les fichiers de
  suivi sont dans le dépôt pour qu'une autre IA reprenne avec le ZIP seul.
  Aucun secret dedans (vérifié : seulement des noms de profil de trousseau).
- Refusé ou abandonné, ne pas reproposer sans élément nouveau : presets Copy
  Info ; métadonnées médias dans le rapport ; signature Windows/Linux ; file de
  jobs pendant un ingest ; poignée déplaçable entre zones.

## Problèmes connus
- **Build universel Intel** : `electron-builder.yml` exclut `!(darwin_arm64)`.
  La tranche Intel d'un build universel partirait sans koffi, donc sans
  relecture sans cache, sans le signaler.
- **Destination montée en lecture seule** non détectée par `check-paths`.
- `npm audit` signale des vulnérabilités dans les dépendances, non traitées
  (`audit fix` changerait le lock).
- Reliquats d'audit : manifestes réécrits en « copy new files only » ; deux
  machines sur un même NAS couvertes par « `.part` frais = refus », pas par un
  vrai verrou ; identité de carte à 1 % de capacité près ; parcours du compteur
  synchrone (SMB lent) ; `run-hook` sans liste blanche.
- À vérifier dans l'appli réelle : dans File Filter, les interrupteurs par
  extension semblent mordre sur leur libellé (vu sur le harnais seulement).
- `test-ascmhl.js` saute 4 cas sans `pip install ascmhl` : normal.

## Pièges pour qui modifie le code
- `index.html` contient aussi le gabarit du rapport HTML dans une chaîne :
  attention aux remplacements globaux. Les retouches de style vont dans le bloc
  « Reparations, mesurees dans l app qui tourne », avant le **premier**
  `</style>`.
- Transitions CSS : mesurer `getComputedStyle` ~400 ms après un changement.
- `window.ingesto.checkCounterCollision` renvoie `null` sans collision ; tout
  objet est lu comme un refus.
- `test-p0.js` / `test-ascmhl.js` extraient des fonctions de `main.js` dans un
  contexte `vm` : une nouvelle fonction appelée par elles doit y être ajoutée.
- Un fichier qui change seulement de droits d'exécution est presque toujours un
  accident de décompression : `push_github.command` le signale avant l'envoi.

## Prochaines étapes proposées (aucune décidée)
1. Mesurer le tampon d'écriture 16 Mo (2.7.0) sur vraie carte et disque navette.
2. Build universel Intel (voir Problèmes connus).
3. Détection d'une destination en lecture seule (fichier témoin au Start, sur la
   destination, jamais sur la carte).
4. Client Companion (tableau de production sur le NAS) : trancher d'abord les
   noms de champs d'API, encore en français.
5. Optimisations écartées en 2.7.0, seulement mesures en main.
6. Page de téléchargement qui ne propose pas Linux alors que la Release
   contient `.AppImage` et `.deb` : savoir de quelle page il s'agit.

## Pour aller plus loin
`docs/notes/` : 01 conventions, 02 architecture, 03 carte source, 04 charte UI,
05 tests sans build (harnais Playwright), 06 signature Mac, 07 historique.
