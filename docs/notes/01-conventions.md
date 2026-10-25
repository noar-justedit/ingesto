# 01 · Conventions

## Langues
- Conversation avec Noar : **français**, vocabulaire simple pour le code.
- Interface, messages, rapport, README, notes de version : **anglais**.
- Commentaires du code : anglais, et ils expliquent le **pourquoi** (l'incident
  ou le raisonnement), pas le quoi. C'est la tradition du fichier : la garder.
- Les commentaires des blocs de style ajoutés en fin de feuille sont en
  français sans accents (historique, garder la forme).

## Versions
- Trois endroits : `package.json`, `version.json`, et dans `package-lock.json`
  seulement les deux entrées du paquet `ingesto` (lignes 3 et 9 environ).
  Ne pas toucher aux versions des dépendances (ex. `jiti` est aussi en 2.7.0).
- `version.json` est lu par les applis installées pour proposer une mise à
  jour (`UPDATE_URL` dans `main.js`) : il se publie **après** les binaires.
- Numérotation : correctifs en Z (2.7.1, 2.7.2), fonctions en Y. Noar confirme
  chaque numéro.
- **Une version = un périmètre recettable en une séance** (leçon de la 2.5.6,
  abandonnée parce que trop grosse).

## Livrables d'une version
- Note de version en anglais : titre `# ingesto X.Y.Z`, une phrase de
  périmètre, sections par thème, section `## Tests` avec le compte réel de
  vérifications. Dire ce qui n'a PAS changé quand c'est rassurant (« The copy
  engine and the verification are unchanged. »).
- Donner à Noar, en français : ce qui change, ce qui est à tester chez lui (liste
  courte et concrète), ce qui n'a pas pu être prouvé.

## Écriture
- Aucun tiret cadratin dans un texte visible (test `test-no-emdash.js`).
- Messages d'erreur : ce qui s'est passé, puis ce qui est sûr (« Nothing has
  been written. »), puis quoi faire. Codes de refus `PF-xx`, `CV-x`.
- Le mot *verified* est réservé à un run où chaque fichier a été relu depuis la
  destination et comparé (SECURE, PRO). FAST dit *not verified*, SIZE CHECK
  *sizes checked*.

## Git
- Le dépôt était alimenté par l'uploader web de GitHub (« Add files via
  upload ») : ça perd le bit exécutable des scripts et ne supprime rien.
  Depuis la 2.7.3 : Noar publie avec `scripts/push_github.command`.
  Depuis la 2.8.1, ce script ne publie pas les fichiers de suivi (`CLAUDE.md`,
  `AGENTS.md`, `ETAT_PROJET.md`, `docs/notes/`) : ils ne vivent que dans le ZIP.
- Messages de commit courts, en anglais, au présent.
