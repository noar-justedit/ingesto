# 02 · Architecture

## Deux processus
- **Principal** (`src/main/main.js`, Node) : volumes, copie, vérification,
  rapports, préférences. Expose 38 canaux `ipcMain.handle(...)`.
- **Interface** (`src/renderer/index.html`) : un seul fichier HTML + CSS + JS,
  isolé (`contextIsolation`), qui parle au principal uniquement par
  `window.ingesto` (défini dans `preload.js`). Politique de sécurité (CSP)
  stricte dans la page : aucune ressource externe.

## Le moteur de copie (`start-copy`)
1. Préflight : chemins encore là, place libre, PF-E6 (destination = carte,
   dedans, ou la contient, pour **toutes** les cartes du lot via
   `options.batchSources`), collisions de noms de dossier.
2. Verrou des cartes sources du lot (`lockSource`), levé à la fin du run.
3. Copie en éventail : une lecture de la carte, écrite sur toutes les
   destinations à la fois (`copyFanOut`, blocs de 8 Mo). Fichiers écrits sous
   `*.ingesto-part` puis renommés : un fichier au nom final est un fichier
   complet.
4. Vérification selon le mode :
   - `fast` FAST : aucune ;
   - `normal` SIZE CHECK : tailles seulement ;
   - `slow` SECURE : relecture de chaque destination **sans cache**
     (`nocache.js`) et comparaison xxHash64, destinations en parallèle ;
   - `pro` PRO : SECURE + listes de checksums, MHL, ASC MHL v2.0, algorithme au
     choix (xxHash64/128, MD5), double lecture optionnelle de la source.
   Un fichier qui échoue est mis de côté en `*.ingesto-failed`.
5. Écritures annexes atomiques (`writeFileAtomic` : fichier temporaire, fsync,
   rename, fsync du dossier).
6. Fin : rapport (HTML/CSV/JSON) à la racine de chaque destination
   (`INGESTO_report.*`), notification ntfy, commande post-ingest, Card Handoff
   (`handoff.json`), Card Tracking (`.ingesto.json` sur la carte, si activé).

## Le dossier de destination
Construit depuis un template à jetons (`{counter}`, `{cardname}`,
`{operator}`, `{camera}`, `{pp}`, `{YY}`/`{YYYY}`, `{MM}`, `{DD}`, `{HH}`,
`{MIN}`, `{SS}`, texte libre). Un `/` crée un sous-dossier (4 niveaux max).
`{counter}` doit être dans le dernier niveau. Le compteur est global à la
destination : ingesto parcourt l'arborescence pour trouver le suivant
(`makeCounterMatcher`, qui doit refléter exactement `cleanSegment`).
Le moteur refuse d'écrire dans un dossier de carte qui existe déjà.

## L'interface
- Colonne gauche : cartes chargées (Operator, Camera, Picture profile, Notes
  par carte ; (A)/(M) sur la caméra), compteur. Depuis 2.7.1 ces valeurs sont
  **gardées** d'un ingest à l'autre (Notes vidées), balai `clearCopyInfo()`.
- Centre : volumes, puis **Ingest History** relu dans les rapports des disques
  (`refreshSessionLog`, lignes dépliables `sessDetails`), puis la file d'ingest
  pendant une copie (`body.tf-on` masque l'historique).
- Droite : destinations (dossiers à créer), Folder Structure (menu Insert sur
  deux colonnes, double-clic = saisie brute), Templates (4).
- Mode kiosk : écran verrouillé par PIN (jamais écrit sur disque), une carte à
  la fois, éjection auto. Vide tous les champs entre deux opérateurs.
- Préférences : `ingesto-prefs.json` dans le dossier userData, écrites 400 ms
  après la dernière frappe (`persistPrefs` → `persistPrefsNow`), vidées au
  focusout, à START et à la fermeture.

## Noms de fichiers réservés d'ingesto
`*.ingesto-part`, `*.ingesto-failed`, `*.ingesto-tmp`, `INGESTO_report.*`,
`.ingesto.json` (+ `.tmp`, `.unreadable`). Sur une **carte**, un fichier qui
porte ces noms est un rush comme un autre : jamais supprimé.
