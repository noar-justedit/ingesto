# 07 · Historique et points ouverts

État au 13.10.2026 : dossier en **2.8.0**, dernière Release publiée : **2.7.2**
(la 2.7.3 n'a pas été publiée seule, la 2.8.0 la contient). Le résumé à jour
est dans `ETAT_PROJET.md` et `CHANGELOG.md` à la racine.

## Journal 10.10 au 13.10 (Cowork) : 2.8.0
- Electron 44.7.1 (macOS 13 minimum, accepté par Noar). Essai réel sous
  Electron 44 : l'app démarre, ingest SECURE et PRO réels, copies identiques
  à la carte, koffi chargé, note `001_note.md` écrite.
- Copy Info : Operator / Camera / Profile sur une ligne (Copy Info, cartes,
  kiosk), menu Profile (`PP_GROUPS`), liste des opérateurs de la session
  (`S.sessionOps`, mémoire seulement), notes markdown (`mdnInit`, `mdToHtml`,
  `htmlToMd`). Maquettes validées par Noar le 13.10.
- Les champs d'origine sont gardés (`<input>` caché, `<textarea>`) et suivis par
  `hookValue()` : aucun code qui lit `.value` n'a changé.
- Nouveau `scripts/test-copy-info.js` (46 vérifications), tests note, profil et
  historique mis à jour. 15 mutations, toutes détectées.
- Manuel EN/FR passé en 2.8.0 : version, macOS 13, champs, trois sections
  nouvelles (menu Profile, opérateurs de la journée, notes en markdown),
  captures 35 à 38 ajoutées dans `capture.js`, toutes les captures refaites,
  PDF reconstruits (36 et 37 pages). Les 4 captures du README refaites avec
  les mêmes données de démo qu'en 2.7.1, script gardé hors du dépôt.
- Piège trouvé en essai : texte puis Cmd+B dans un champ vide laisse deux nœuds
  frères ; `htmlToMd` les lisait comme deux lignes. Corrigé (suite de nœuds en
  ligne = une ligne), testé.

## Journal 03.10 (Cowork) : 2.7.3
- Règles ARNO DEV adoptées : `AGENTS.md` (règles générales), `ETAT_PROJET.md`
  (état et règles propres), `CHANGELOG.md`, `CLAUDE.md` réduit à un renvoi.
- `build-mac.command` et `build-win-from-mac.command` renommés en
  `build_mac.command` et `build_win_from_mac.command` (README, test mis à jour).
- `.gitignore` ajouté. `Icon?` et pas `Icon*` : avec la casse ignorée sur Mac,
  `Icon*` masquerait `build-resources/icon.icns`.
- `scripts/push_github.command` (+ `push_github.sh`) : clone temporaire, `git
  add -A` sur le dossier, liste, « y », push normal ; refuse si la version
  n'est pas supérieure à celle publiée ou si `version.json` et `package.json`
  divergent ; retient `version.json` tant que la Release `vX.Y.Z` n'a pas de
  binaire (API GitHub) ; signale les fichiers qui changent seulement de droits.
  Testé ici contre un dépôt local (7 scénarios), pas contre GitHub : l'API
  GitHub n'est pas joignable depuis l'environnement de test.

## Journal 01.10 au 03.10 (Claude Code)
- Dossier local rattaché à GitHub : `git init`, `origin`, `reset` sur
  `origin/main` sans toucher un fichier. `CLAUDE.md` et `docs/notes/` restent
  **locaux** (exclus par `.git/info/exclude`, pas par un `.gitignore`).
- `dd8a2f7` (poussé) : bit exécutable des 8 scripts shell (`git update-index
  --chmod=+x`). `test-executables.js` passe sur un clone frais.
- `f982936` (poussé) : manuel utilisateur `docs/manual/`, EN + FR, 33 pages
  chacun, 18 chapitres, 32 captures de la vraie interface avec données de démo.
  Interface en anglais seulement : le manuel FR cite les libellés anglais.
  Régénération : `docs/manual/tools/README.md` (Playwright installé hors du
  projet, `package.json` inchangé).
- `npm ci` fait en local : `npm test` vert, 30 suites, 1825 vérifications
  (1826 annoncées en 2.7.2 ; écart probable lié aux cas ASC MHL sautés sans
  `pip install ascmhl`, non vérifié). `npm audit` signale des vulnérabilités
  dans les dépendances : non traitées (`audit fix` changerait le lock).
- À vérifier dans l'appli réelle : dans File Filter, les interrupteurs par
  extension semblent mordre sur leur libellé (vu sur capture du harnais, non
  confirmé sur l'appli).

## Versions récentes
| Version | Contenu |
|---|---|
| 2.7.2 | Menu Insert sur deux colonnes (la fin était cachée sous le bord, macOS masque la barre de défilement au trackpad) ; « Custom text… » ; menus sur `#1b1d24` ; barres de défilement sombres partout. 1826 vérifications. |
| 2.7.1 | Issue #11 (Manuel) : historique dépliable (date, fichiers, taille, durées, vitesse, destinations, opérateur…) ; Operator/Camera/Profile **gardés** d'un ingest à l'autre, Notes vidées, balai pour tout vider ; (M) pour une caméra reprise. Plus les correctifs trouvés en refaisant les captures : historique qui écrasait la file pendant la copie, SELECTED coupé, cases de chiffres coupées, caméra non détectée en kiosk. README et 4 captures refaits. |
| 2.7.0 | Refonte complète de l'interface (charte), historique d'ingest relu des rapports + gomme, verrou carte source, revue complète : reveal qui ouvrait un fichier (faille), nom de note nettoyé, journal plafonné à 64 Mo, CSP, refus du journal plus silencieux, PF-E6 sur tout le lot, compteur avec point final, fsync des manifestes, perf (tampon 16 Mo, progression 10/s, préférences différées). |
| 2.6.6 | Variable `{pp}` (picture profile normalisé), scripts de build exécutables. |
| 2.6.5 | Largeur du compteur 2 à 4 chiffres (issue #9), Card Handoff `handoff.json` + `safeToErase` (issue #10). |
| 2.6.3 / 2.6.4 | Réécriture de tous les messages (70 cas), version de sûreté (11 correctifs). |
| 2.6.0 à 2.6.2 | Sous-dossiers dans le template, `{YYYY}`, nom de carte Windows, `package-lock` + `npm ci`. |
| 2.5.5 | Première version signée et notarisée macOS. |

Refusé ou abandonné, ne pas reproposer sans élément nouveau : presets Copy
Info (29.09, inutiles puisque les valeurs sont gardées) ; métadonnées médias
dans le rapport ; signature Windows/Linux ; file de jobs pendant un ingest ;
poignée déplaçable entre zones.

## README
Règles posées par Noar (09.09) : en-tête sur trois lignes
(`# ingesto` / `### Professional Camera Media Ingest` / `by just edit`, en
minuscules) ; bloc vidéo YouTube `_rSURz65jlo` sans légende, juste après
« macOS · Windows · Linux. ». Les 4 captures de `docs/screenshots/` sont des
rendus du vrai `index.html` avec données de démo et cadre macOS dessiné, pas
des captures du Mac (police proche de SF, pas SF) ; Noar peut les remplacer
par de vraies captures sous les mêmes noms. Le README contient 63 tirets
cadratins hérités : les retirer seulement si Noar le demande.

## GitHub
- Issue #11 (Manuel Perez) : répondue en 2.7.1, puis menu corrigé en 2.7.2.
- Issue #8 (sous-dossiers) : traitée par la 2.6.0.
- Scripts shell en 755 depuis `dd8a2f7` (01.10).
- Release v2.7.2 : contient `.dmg` arm64, `.exe`, `.AppImage` et `.deb`
  (mesuré le 01.10 par `gh release view`).

## Points ouverts, par ordre proposé
1. ~~Remettre le dépôt d'aplomb~~ : fait le 01.10, sauf le `.gitignore`. Le
   dépôt n'en a toujours pas ; `node_modules/` et `dist/` ne sont exclus que
   par `.git/info/exclude` de ce dossier. Un clone ailleurs les verrait. À
   proposer.
2. **Mesurer le tampon d'écriture 16 Mo** (2.7.0) sur une vraie carte et un
   disque navette lent : gain non mesurable dans l'environnement de test. S'il
   est nul, le signaler.
3. **Build universel Intel** : `electron-builder.yml` exclut
   `!(darwin_arm64)`, la tranche Intel d'un build universel partirait sans
   koffi (donc sans relecture sans cache), silencieusement.
4. **Destination montée en lecture seule** non détectée par `check-paths`
   (piste : fichier témoin au Start, nom aléatoire, puis supprimé : c'est une
   destination, pas une carte).
5. **Client Companion** (tableau de production sur le NAS, livré 1.0 le 23.08,
   non publié) : ingesto doit devenir un simple client d'envoi (outbox sur
   disque, jamais bloquant). À trancher d'abord : noms de champs d'API encore
   en français (`projet`, `numero`, `cadreur`...).
6. Optimisations écartées en 2.7.0, à ne reprendre que mesures en main :
   suppression du calcul de taille de dossier, cache des `statSync`,
   déduplication mémoire, MD5 en worker. Le retrait de F_NOCACHE est exclu :
   il touche la vérification.
7. Reliquats d'audit : manifestes réécrits en « copy new files only » ;
   fichier « unstable » en PRO laissé sous son nom (voulu : hors manifeste,
   signalé) ; deux machines sur un même NAS couvertes par « `.part` frais =
   refus », pas par un vrai verrou ; identité de carte à 1 % de capacité près ;
   parcours du compteur synchrone (SMB lent) ; `run-hook` sans liste blanche.
8. Question ouverte depuis septembre : la miniature YouTube annonce
   MAC · WINDOWS · LINUX, le dépôt construit bien Linux mais la page de
   téléchargement ne le propose pas. Au 01.10, la release GitHub contient bien
   `.AppImage` et `.deb` : reste à savoir de quelle page de téléchargement il
   s'agit.
