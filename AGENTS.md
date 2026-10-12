# Règles de développement pour l'IA (projets de Noar)

Ce fichier s'adresse à toute IA qui travaille sur ce dépôt (Claude, Codex,
Cursor, etc.). Lire ensuite `ETAT_PROJET.md` : il contient l'état d'ingesto
et ses règles propres, qui s'ajoutent à celles-ci.

## Contexte
- Noar est monteur et technicien vidéo, pas développeur. Il travaille uniquement sur Mac.
- Ses applications doivent tourner sur Mac et Windows (et sur Linux quand le projet le prévoit).
- Il publie lui-même sur GitHub : le code à partir du ZIP fourni, et les builds dans les Releases.

## 1. Périmètre : rien en dehors de la demande
- Ne modifier que ce qui est demandé.
- Pour tout le reste (outillage, scripts de build, dépendances, organisation des fichiers,
  comportements par défaut) : proposer, expliquer l'impact, puis attendre un « oui » explicite.
  Jamais d'initiative silencieuse.

## 2. Communication
- Répondre en français, simplement, sans jargon.
- Expliquer en quelques phrases ce que fait le code et pourquoi cette méthode plutôt qu'une autre.
- Signaler les conséquences concrètes : ce qui peut casser plus tard, ce qui sera difficile
  à modifier, les limites de la solution, les impacts sur le coût, la sécurité, la maintenance
  et les performances.
- Pas de flatterie. Si Noar se trompe, le lui dire et expliquer pourquoi.

## 3. Builds
- Chaque projet contient des scripts `build_*.command` qui génèrent depuis le Mac
  la version Mac, la version Windows et, selon le projet, les versions Linux (.deb, AppImage).
- Si un build Windows ou Linux depuis le Mac n'est pas réaliste, le dire clairement
  et proposer une autre solution.
- Ces scripts sont créés au démarrage du projet. Toute modification qui n'a pas été demandée
  suit la règle 1.

## 4. Versions
- Aucun bump sans que Noar ait confirmé explicitement le numéro.
- Procédure : proposer un numéro, attendre la confirmation, mettre à jour tous les emplacements
  listés dans `ETAT_PROJET.md` (section « Emplacements de la version »), puis vérifier
  qu'aucun n'a été oublié.
- Format : X.Y.Z.

## 5. Livraison : le ZIP
- À chaque bump, fournir `NomDuProjet_vX.Y.Z.zip`.
- Une fois décompressé, le ZIP correspond exactement à ce que Noar pousse sur GitHub :
  sources, scripts de build, documentation et fichiers de suivi.
- Le ZIP ne contient pas :
  - les builds, qui vont dans les Releases ;
  - les dossiers générés (node_modules, dist, build…) ;
  - aucun secret (mot de passe, clé API, certificat de signature).
- Le ZIP doit suffire à lui seul pour que n'importe quelle IA, pas seulement Claude,
  reprenne le développement.

## 6. Fichiers de suivi (dans le ZIP, à jour à chaque bump)
- `README.md` : ce que fait l'app et comment la builder.
- `AGENTS.md` : ces règles, lisibles par toute IA. `CLAUDE.md` renvoie vers `AGENTS.md`.
- `ETAT_PROJET.md` : état actuel, architecture en bref, décisions prises et leurs raisons,
  problèmes connus, prochaines étapes, emplacements de la version.
- `CHANGELOG.md` : historique des versions.

## 7. Publication sur GitHub : scripts/push_github.command
- Chaque projet contient `scripts/push_github.command`. Noar décompresse le ZIP et
  double-clique ce script dans le dossier obtenu : GitHub devient exactement le
  contenu du dossier (ajouts, modifications et fichiers retirés). Jamais d'envoi
  par l'upload web de GitHub (il ne supprime rien et perd les droits d'exécution).
- Le script travaille dans une copie temporaire du dépôt, affiche la liste des
  changements et attend un « y ». Jamais d'envoi forcé.
- Chaque envoi porte une nouvelle version : le script refuse d'envoyer si la version
  de `version.json` n'est pas strictement supérieure à celle publiée sur GitHub, ou si
  `version.json` et `package.json` ne disent pas le même numéro.
- `version.json` part en dernier : tant que la Release et ses binaires ne sont pas
  publiés, le script garde l'ancien sur GitHub ; on le relance ensuite pour l'envoyer.
- Tout projet doit avoir un `version.json` (le script y lit la version, et l'adresse
  GitHub si `package.json` ne la donne pas).
