# ingesto : état du projet

À lire après `AGENTS.md` (règles générales). Ce fichier donne l'état d'ingesto,
ses règles propres et ce qui reste à faire. Le détail est dans `docs/notes/`.

## En bref
ingesto est une application Electron gratuite (GPL-3.0) qui copie les cartes
caméra vers plusieurs destinations à la fois et vérifie chaque fichier (DIT,
tournage). Mac, Windows et Linux. Dépôt : github.com/noar-justedit/ingesto.
Auteur : Noar (Arnaud Augst, Just Edit).

- Version du dossier : **2.9.1** (24.10.2026) : corrections et harmonisation
  après la revue complète du code (voir « Fait en 2.9.1 »).
- 2.9.0 (23.10.2026, ZIP livré, non publié) : interface en français (et
  ouverte aux autres langues), règle des noms de dossier selon la langue,
  bouton INSERT YOUR CARD, zones de dépôt vides teintées.
- 2.8.1 (23.10.2026, ZIP livré) : correctif du champ `folder` des rapports,
  fichiers de suivi gardés hors de GitHub, tiret du titre du rapport HTML.
- 2.8.0 (13.10.2026, publiée) : Electron 44, notes en markdown, menu des
  picture profiles, liste des opérateurs de la session, Operator / Camera /
  Profile sur une ligne (Copy Info, cartes, kiosk).
- Dernière version publiée sur GitHub : 2.8.0 (commit db36b69, tags `vX.Y.Z`,
  vérifié le 24.10.2026). 2.8.1, 2.9.0 et 2.9.1 arrivent ensemble : la note de
  release 2.9.1 les couvre.
- Electron **44.7.1** : **macOS 13 Ventura minimum** (les 2.7 tournent encore
  sur macOS 12), Windows 10/11 64 bits, Linux x64.
- Tests : `npm test`, 35 suites, 2044 vérifications, toutes vertes au 24.10.2026.

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
version qu'il décrit (2.8.0 aujourd'hui). Il se met à jour quand on le
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
5. Interface, messages, rapport, README, notes de version : **en anglais**
   dans le code. Les autres langues passent par les dictionnaires de
   `src/renderer/lang/` (voir `docs/notes/i18n/README.md`). Commentaires du
   code en anglais, qui expliquent le pourquoi.
6. Diagnostiquer et proposer avant de coder quand Noar pose une question ou
   signale un problème.
7. Ne jamais affirmer l'état du dépôt GitHub : le mesurer (`git ls-remote`,
   clone) ou demander.
8. Maquettes visuelles : **en HTML**, pas en image.
9. Jamais Google Drive, sous aucune forme.
10. **Modification d'interface** (décision de Noar, 23.10.2026) : ne lui
    montrer que l'anglais. Un nouveau texte : montrer l'anglais et écrire dans
    la réponse sa traduction française.
11. **Tout nouveau texte visible** entre dans `lang/fr.js` dans la même
    livraison. Un texte construit en JavaScript (notification, rapport) passe
    par `tr()` / `trf()` (interface) ou `i18n.t()` (processus principal) ;
    `test-i18n.js` refuse un texte passé par ces fonctions et absent d'un
    dictionnaire.
12. **Noms de dossier** : en anglais et en français, ASCII seulement (voir
    `nameRule()` dans index.html, miroir dans `resolveTemplateVars()` de
    main.js) ; en chinois, seuls les caractères interdits par Windows sont
    retirés. Gardé par `test-folder-names.js`.

## Architecture en bref
```
src/main/main.js          moteur : copie, vérification, IPC (38 canaux), verrou carte source
src/main/sentinel.js      Card Tracking : journal .ingesto.json sur la carte (off par défaut)
src/main/nocache.js       relecture sans cache (F_NOCACHE / purge) via koffi
src/main/camera-detect.js détection marque/modèle depuis l'arborescence de la carte
src/main/preload.js       pont window.ingesto (contextIsolation)
src/main/lang.js          textes du processus principal dans la langue choisie (lit lang/*.js)
src/renderer/index.html   TOUTE l'interface (~9 400 lignes : HTML + CSS + JS) et le rapport HTML, en anglais
src/renderer/i18n.js      moteur de traduction de l'interface (2.9.0)
src/renderer/lang/fr.js   dictionnaire français (un fichier par langue)
scripts/test-*.js         34 suites lancées par npm test, sans Electron
docs/notes/i18n/          outils de traduction (captures, planche de relecture)
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
   `# ingesto X.Y.Z`, sections par thème, section `## Tests` avec le compte réel),
   écrite dans `docs/notes/releases/RELEASE_NOTE_X.Y.Z.md` et livrée dans le ZIP
   (décision de Noar du 12.10.2026). Noar la colle dans la Release GitHub.
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
- **Electron 44** (10.10.2026, appliqué en 2.8.0) : décision de Noar.
  Conséquence acceptée : macOS 12 n'est plus pris en charge.
- **Notes en markdown** (13.10.2026, 2.8.0) : fichier `001_note.md` (en-tête
  markdown, valeurs échappées). Verify reconnaît `_note.md` ET `_note.txt`,
  sinon les dossiers des versions 2.7 passeraient au rouge. Le champ reste un
  `<textarea>` qui porte le markdown ; la vue mise en forme est construite
  autour (`mdnInit`) : tout le code qui lit `.value` est inchangé. Le
  souligné, absent du markdown, est écrit `<u>texte</u>` (choix de Noar).
  Rapport HTML et historique : note mise en forme par `mdToHtml()`, qui
  échappe tout d'abord. CSV et ntfy : markdown brut. Mode Aa/MD unique pour
  tous les champs, gardé dans les préférences (`noteMode`).
- **Menu Profile** (13.10.2026, 2.8.0) : liste figée dans `PP_GROUPS`, à
  compléter au fil des retours. `DLOG2` et `RLOG` de l'ancienne liste n'y
  sont plus (non confirmés comme profils réels) : toujours possibles via le
  champ libre du menu.
- **Liste des opérateurs** (13.10.2026, 2.8.0) : en mémoire seulement
  (`S.sessionOps`), jamais dans les préférences, remplie au START, 30 noms
  maximum, aussi en kiosk. Le dernier opérateur reste pré-rempli au lancement,
  comme depuis la 2.7.1.
- **Suivi du projet dans le ZIP** (03.10.2026) : `docs/notes/` et les fichiers
  de suivi sont dans le ZIP pour qu'une autre IA reprenne avec le ZIP seul.
  Publiés sur GitHub en 2.8.0, retirés à partir de la 2.8.1 (voir « Décidé
  pour la 2.8.1 »). Aucun secret dedans (vérifié : seulement des noms de
  profil de trousseau).
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

- **Notes markdown lues ailleurs** : deux lignes qui se suivent forment un seul
  paragraphe dans certains lecteurs markdown (GitHub, par exemple) ; ingesto et
  Obsidian les affichent sur deux lignes.
- La mise en forme dans l'éditeur passe par `document.execCommand`, déclarée
  obsolète par les navigateurs mais toujours présente dans Chromium. À
  remplacer si elle disparaît un jour.

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
- `#meta-pp`, `#k-pp` et les profils des cartes sont des `<input>` cachés, et
  les notes des `<textarea>` : le bouton et la vue mise en forme suivent leur
  `.value` grâce à `hookValue()`. Écrire `.value` par script suffit, ne pas
  toucher au bouton ni à la vue directement.
- Un fichier qui change seulement de droits d'exécution est presque toujours un
  accident de décompression : `push_github.command` le signale avant l'envoi.
- Ne pas nommer une classe CSS `empty` : une règle générique `.empty` existe
  (centrage, grande hauteur). Les zones de dépôt vides utilisent `dz-empty`.
- Traduction : le dictionnaire est cherché avec les espaces nettoyés ; une clé
  qui commence par une espace ne sera jamais trouvée (test-i18n le refuse).
  Un même texte anglais a une seule traduction partout : vérifier les mots
  courts (« Add », « Copy ») avant de les traduire.
- Toute donnée de l'utilisateur affichée dans l'interface doit être exclue de
  la traduction (liste `USER_DATA` de i18n.js ou `data-i18n-skip`), sinon une
  carte nommée « Done » s'afficherait « Terminé ». Vérifier avec
  `docs/notes/i18n/userdata.js` après une modification d'interface.
- Le bloc de données du rapport HTML (`slim`) et les valeurs du JSON restent
  en anglais ; le HTML affiché, le CSV et les champs `modeLabel` /
  `resultLabel` du JSON suivent la langue.
- Les tests qui extraient une fonction appelant `tr()` / `trf()` doivent
  extraire `tr` aussi (`extractFn(REND, 'tr')`).
- Tailles : unités décimales partout (`fmtSize`, `fmtSizePair`, `_sz` du
  rapport, `fmtBytes` du moteur) : 1 GB = 10^9 octets, comme le Finder.
- Commandes (après ingest, remise de la carte) : le processus principal
  demande une fois par commande exacte (`approveCommand`), réponses gardées
  dans `ingesto-trusted-commands.json` (dossier userData). Le hook reçoit la
  commande telle que tapée (`tpl`) en plus de `argv` et vérifie que l'un est
  l'autre avec ses variables remplies (`argvMatchesTemplate`).

## Fait en 2.8.1 (23.10.2026)
- **`folder` perdu dans les rapports** (constaté le 14.10.2026). Le bloc de
  données caché du rapport HTML (`slim` dans `buildReportHtml`) ne recopiait
  ni `folder` ni `skipped`, et `report-read` relit ce bloc avant le JSON : à
  chaque ingest, les cartes précédentes perdaient `folder`, dans le HTML comme
  dans le JSON (le JSON est réécrit depuis les mêmes enregistrements). Corrigé.
  Nouveau `scripts/test-report-data.js` : lit la liste des champs dans
  `updateReports()` et vérifie que chacun revient du bloc, puis deux ingests à
  la suite. Un champ ajouté plus tard à `updateReports()` sans être recopié
  fait échouer ce test. Les rapports déjà écrits ne sont pas réparables.
- **Fichiers de suivi hors de GitHub** (22.10.2026, décision de Noar) :
  `CLAUDE.md`, `AGENTS.md`, `ETAT_PROJET.md` et `docs/notes/` restent dans le
  ZIP mais ne sont plus publiés. `push_github.sh` les écarte (liste `PRIVATE`)
  et les retire de GitHub, où la 2.8.0 les avait mis. `CHANGELOG.md` reste
  public. Essayé contre un faux GitHub en 2.8.0 : 15 fichiers retirés, le
  dossier local intact, rien d'autre de touché.
- **Tiret long dans le titre du rapport HTML** (`INGESTO — Ingest Report`,
  devenu `INGESTO - Ingest Report`). `test-no-emdash.js` lisait les chaînes
  ligne par ligne et ne voyait pas les gabarits sur plusieurs lignes ; il lit
  maintenant aussi ces gabarits en entier.

## Fait en 2.9.1 (24.10.2026)
Revue complète du code (moteur, interface, cohérence), puis choix de Noar :
- Historique : COPIED pour FAST et SIZE CHECK, VERIFIED pour SECURE et PRO.
- Sortie du kiosk : fenêtre principale redessinée, START sans carte ou sans
  destination ne fait rien.
- Mémoire de la traduction : les traces des nœuds retirés de la page sont
  effacées (`sweep()` dans i18n.js ; `docs/notes/i18n/leak.js` le mesure :
  ~800 traces après 3000 événements, contre 15 000+ en 2.9.0). Le problème
  n'existait qu'en français : en anglais le moteur ne garde rien.
- Relecture de la carte (macOS) depuis un dossier dans la carte : chemin
  recalculé sous le nouveau point de montage. Non testable ici (diskutil).
- `lang.js` garde le code de langue nettoyé ; date au format fixe.
- JSON : valeurs en anglais + `modeLabel` / `resultLabel`.
- Deux confirmations traduites ; aucun `confirm()` avec un texte brut (test).
- Windows : dossiers système ignorés à la lecture de la source ; scan des
  volumes et `is-removable` asynchrones (le PowerShell bloquait la copie).
- Moteur : refus d'un second ingest simultané (`refuseIfCopying`).
- Double lecture PRO : index des écritures réussies construit une fois.
- Sécurité : approbation des commandes par le processus principal (voir les
  pièges).
- Harmonisation : kiosk vert comme ailleurs ; point du logo violet partout ;
  « Verify » et « Card re-read » (abrégé RE-READ, tuile « Re-read »), CSV
  renommé ; dates JJ.MM.AAAA HH:MM, durées 11m03s, tailles décimales ;
  « ingesto » en minuscules partout (sauf noms de fichiers INGESTO_report et
  outil des manifestes MHL) ; libellés des boutons − / + / ×.
- Gardé tel quel, à la demande de Noar : la règle stricte du texte fixe des
  modèles (point 4 de la revue : les points et espaces des modèles enregistrés
  sont retirés), le violet d'accent sur certains états, le bouton orange
  inactif INSERT YOUR CARD.
- Tuiles de la fenêtre de fin : un libellé trop long passe sur deux lignes au
  lieu d'être coupé (français).

## Fait en 2.9.0 (23.10.2026)
Décidé avec Noar le 23.10 :
- Traduction : français seulement pour commencer (Noar l'a relu en entier sur
  la planche : 737 textes, aucune correction). Les autres langues viendront
  par des contributeurs. Langue du système au premier lancement, choix dans
  les réglages. Vocabulaire gardé : GB, « ingest », « checksum », noms des
  modes en anglais (pas de réponse aux questions de la planche).
- Rapports HTML et CSV traduits. JSON et Card Handoff : noms de champs et
  codes fixes en anglais, seuls `mode` et `result` suivent la langue.
- Noms de dossier selon la langue (règle 12 ci-dessus). Les variables restent
  en anglais. Autres langues : on verra le moment venu (aujourd'hui, toute
  langue autre que le chinois suit la règle ASCII).
- Moteur sur le modèle de celui de wibi8bo, pour que son `zh-CN.js` se branche.

Fait :
- `src/renderer/i18n.js`, `src/renderer/lang/fr.js`, `src/main/lang.js`,
  menu Langue en tête des réglages. En anglais, rien ne change.
- Lot 2 : notifications ntfy, rapport HTML (textes, liste des fichiers),
  colonnes du CSV, `mode`/`result` du JSON, dialogues système pour quitter,
  titres des fenêtres d'export/import, libellés et date de la note `.md` (sa
  première ligne reste en anglais : Vérifier la reconnaît par elle).
- Règle des noms de dossier : `nameRule()`, `asciiFold()`, `tplText()`
  (index.html), miroir dans `resolveTemplateVars()` (main.js), règle transmise
  avec chaque carte (`nameRule`), modèles enregistrés repassés par la règle.
  Changement aussi pour l'anglais : un modèle enregistré avec « Journée » crée
  désormais « Journee ».
- Interface : INSERT YOUR CARD (orange, respire) sans carte ; zones de dépôt
  vides teintées (rouge sources, vert destinations).
- Tests : `test-i18n.js`, `test-folder-names.js`, mutations détectées.
- Planche de relecture : https://claude.ai/artifact/5ynQ27d15BXmiofB1LV3gA

Non fait, volontairement :
- Manuel utilisateur : toujours en 2.8.0, sans la section Langue ni la règle
  des noms de dossier (`capture.js` décale déjà les réglages d'un cran).
- Captures du README : non refaites (le bouton et les zones vides ont changé).
- Menus système de macOS (Édition, Fenêtre) : gérés par Electron, en anglais.

Fork wibi8bo (relevé le 23.10) : il a publié sa propre « 2.8.1 » et son
`UPDATE_URL` (main.js) pointe toujours vers notre `version.json` avec le même
`appId`. Noar lui écrit après la publication de la 2.9.0 (brouillon du mail
dans la conversation du 23.10) : intégrer son chinois, renommer son fork.

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
7. Manuel 2.9.0 (section Langue, noms de dossier) et captures du README.
8. Chinois de wibi8bo, s'il envoie une pull request : vérifier ses clés
   contre la 2.9.0 (`board.js zh-CN`, `test-i18n.js`).

## Pour aller plus loin
`docs/notes/` : 01 conventions, 02 architecture, 03 carte source, 04 charte UI,
05 tests sans build (harnais Playwright), 06 signature Mac, 07 historique,
`i18n/` traduction.
