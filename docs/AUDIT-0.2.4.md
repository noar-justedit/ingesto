# syncto 0.2.4 — audit de code

Base : commit `0adbf1d`, `npm test` → 179 passed / 0 failed.
Périmètre : `src/main/core/`, `src/main/fs/`, `src/main/main.js`, `src/main/preload.js`,
`src/main/config.js`, `src/renderer/`.

Les entrées marquées **[reproduit]** ont été déclenchées par exécution réelle du moteur,
pas déduites par lecture.

---

## A. Perte de données — critique

### A1 — Dossier source absent ⇒ mirror efface tout le côté droit **[reproduit]**
`src/main/core/compare.js:186` · garde : `src/main/core/session.js:253`

`run()` pousse `Left folder not found — it will be created.` **sans `fatal: true`**.
`_list` renvoie alors une Map vide pour la gauche, tout le côté droit devient `RIGHT_ONLY`,
et `mirror` en fait `DELETE_RIGHT`. `Session.sync()` ne bloque que sur `e.fatal` : rien n'arrête la course.

Déclencheur réaliste : SSD externe ou point de montage démonté (ENOENT, pas EACCES).
Le commentaire de `_list` documente exactement ce risque pour un dossier *illisible* — mais pas
pour un dossier *absent*.

```
errors: [{"message":"Left folder not found — it will be created."}]
deleteRight: 4 · deleted: 4 · errors: 0 · côté droit après run: []
```

### A2 — `archiveExisting` détruit la version remplacée sans un mot **[reproduit]**
`src/main/core/sync.js:473-487`

Asymétrie avec `dispose()` : la **suppression** lève une erreur quand aucun dossier de révisions
n'est configuré pour ce côté, mais l'**écrasement** fait `return;` et laisse `copyOne` renommer
par-dessus. Même trou en mode corbeille : le résultat de `trashItem()` n'est pas vérifié, et
`supportsTrash()` faux (SFTP/NAS) passe en silence.

Déclencheur : `deletion: 'versioning'`, dossier de révisions renseigné d'un seul côté —
`migrateJob` (`config.js:165`) ne rabat sur la corbeille que si **les deux** sont vides.

### A3 — Comparaison périmée : la synchro s'exécute sur les anciens dossiers
`src/renderer/app.js:924-929` (swap), `:1093-1105`, `:1119-1128`, `:1166-1176` · `core/session.js:583-627`

`state.stats` n'est remis à `null` que dans `newJob`. `MultiSession.sync()` ne relit jamais
`job.pairs` : elle boucle sur `this.pairs` mémorisé à la dernière comparaison.

Comparer A→B, cliquer SWAP, puis SYNCHRONISER : la fenêtre de confirmation affiche les nouveaux
libellés, le moteur exécute le plan A→B. L'utilisateur qui a inversé les côtés pour remonter B
vers A voit B écrasé par A. Variante avec un job rechargé : les chemins sont ceux de A, mais
`deletion`/`copyLevel` viennent de B — des suppressions prévues en corbeille deviennent définitives.

### A4 — L'identité d'une machine est `hostname + username` ⇒ vol de lock immédiat
`src/main/core/lock.js:88-101`

`processStatus()` considère le lock « à nous » dès que hostname et user correspondent, puis
tranche avec un `process.kill(pid, 0)` **local**. Deux postes déployés depuis la même image
(`WIN-DIT01` / `admin`, ou deux Mac `MacBook-Pro` / `admin`) : B lit le lock de A, le PID
n'existe pas chez B → `notRunning` → `takeOver()` immédiat, sans les 12 s d'attente.
Deux runs en parallèle sur le même dossier. Le `lockId` GUID généré ligne 79 — qui règlerait
exactement ça — n'est jamais utilisé pour l'identité.

### A5 — Déconnexion SFTP : la synchro se fige pour toujours, sans erreur
`src/main/fs/sftp.js:66-99,161-167`

Vérifié dans ssh2 v1.17 : `tryWritePayload` retourne sans rien envoyer quand le canal est fermé,
alors que la requête est déjà enregistrée — **le callback n'est jamais appelé**. Ici : `connect()`
mémorise `_connectPromise` et ne revalide jamais l'état du canal ; `_q()` sérialise tout sur
`this._chain`, donc le premier `stat()` post-coupure **bloque la file entière définitivement** ;
les streams ouverts sur le handle mort n'émettent ni `open`, ni `error`, ni `finish`.
Aucun timeout par requête.

Portable mis en veille entre le compare et le sync : barre figée, aucune erreur, `withRetry`
jamais atteint, et **le bouton Annuler ne répond pas** (le token n'est testé qu'entre deux `await`).

### A6 — Le heartbeat ne revérifie pas la propriété, `release()` supprime le lock d'autrui
`src/main/core/lock.js:133-154`

`beat()` avale ses échecs (`.catch(() => {})`) ; `release()` fait `unlink` sans vérifier que le
fichier est toujours le nôtre. NAS injoignable 15 s pendant une grosse copie : B prend le lock,
A reprend et son `appendByte` en flag `'a'` **alimente le lock de B**, puis en fin de course A
**supprime le lock de B** alors que B synchronise encore. Trois runs simultanés deviennent possibles.

---

## B. Intégrité et silence — majeur

### B1 — `preserveTimes: false` ⇒ ping-pong infini en two-way **[reproduit]**
`src/main/core/sync.js:421`

```js
if (st) { dstId = st.id; if (!mtimeKept && this.cfg.preserveTimes !== false) dstMtime = st.mtime; }
```

Quand `preserveTimes === false`, la seconde condition est fausse : la base enregistre pour la
destination une date qu'elle n'a jamais portée — exactement ce que le commentaire au-dessus dit
vouloir éviter. Reproduit sur 5 runs : le fichier est réécrit à chaque fois, alternativement dans
chaque sens. Si l'utilisateur l'édite entre deux runs, `CONFLICT` permanent.

### B2 — Comparaison annulée présentée comme complète **[reproduit]**
`core/compare.js:130,230,244` · `core/session.js:465,485` · `main.js:298-310` · `app.js:551-572`

`equalContent` sort de sa boucle avec `equal = false` sur annulation → `CAT.DIFFERENT`.
`run()` renvoie normalement, `MultiSession.compare` repose `comparedAt` inconditionnellement
après le `break`, le handler ne renvoie aucun `cancelled`, le renderer réactive SYNCHRONISER.

6 fichiers de 8 Mio identiques, `compareVariant: 'content'`, annulation à 60 ms :
`f3` est bit-à-bit identique mais programmé en écrasement ; `f4`/`f5` ont disparu de l'arbre.
Sous versioning, une révision bidon est créée. Le résumé affiche « Completed successfully ».

### B3 — `ignoreErrors` n'est jamais lu
`src/main/core/sync.js:118` déclaré · jamais consulté (`:555`, `:576`, `:599`, `:657`)

Case à cocher persistée, passée au `SyncRunner`, référencée nulle part dans le moteur. Le
comportement est câblé sur « ignorer toujours ». NAS qui tombe en cours de route : les 3 000
fichiers restants sont tentés, et la phase de **suppression** continue malgré les erreurs d'écriture.

### B4 — Échec d'écriture de la base : simple note, run rapporté « réussi » **[reproduit]**
`src/main/core/session.js:321-323`

Ni `counters.errors++`, ni entrée dans `run.errors` → `buildReport` affiche « Completed successfully ».
Conséquence en two-way : run N crée `Y` à droite sans écrire la base ; l'utilisateur supprime `Y`
à gauche ; run N+1 lit l'ancienne base → **`Y` est ressuscité à gauche**. Aucune alerte.

### B5 — `.syncto.db` réécrite non atomiquement
`src/main/core/db.js:58-65,77-80` · lecture `:74`

`createWriteStream` sur le chemin final : tronqué dès l'ouverture. Pas de `.tmp` + `rename`, alors
que tout le reste du moteur applique cette règle (`sync.js:28-31`). `savePairDb` fusionne **toutes**
les sessions du dossier et réécrit le document entier : une coupure pendant l'écriture fait perdre
son historique à **chaque paire** partageant ce dossier de base. `readDb` avale l'erreur et renvoie
« pas encore de base » alors que le fichier existe et est corrompu.

### B6 — Corbeille : supprimer un dossier emporte les fichiers exclus par le filtre **[reproduit]**
`src/main/core/sync.js:295-299`

En mode `recycler`, `dispose(side, rel, isFolder=true)` corbeille le **dossier entier** et ne passe
jamais par `rmdirClean` — précisément le garde-fou qui laisse `rmdir` échouer bruyamment sur ce qui
n'est pas de la litière OS. Mirror + `excludeFilter: '*.bak'` : `old/keepme.bak` part à la corbeille
sans un mot. En `permanent` / `versioning` le même cas échoue en ENOTEMPTY (comportement voulu).

### B7 — SFTP : `finish` arrive avant l'acquittement du CLOSE
`src/main/fs/sftp.js:165-167,266`

ssh2 `WriteStream._final` appelle `cb()` de façon synchrone après `destroy()`. Or beaucoup de
serveurs ne signalent quota dépassé / ENOSPC **que** dans la réponse au CLOSE. Cette erreur arrive
après que `copyStream` a résolu, et le handler la jette (`if (settled) return`). `flush()` est un
no-op côté SFTP. En `copyLevel: 'fast'`, aucun contrôle de taille : `sync.js:390` renomme un
fichier tronqué **par-dessus le bon fichier** de destination, sans erreur rapportée.

### B8 — `flush()` ne vérifie pas ce que le niveau « secure » promet
`src/main/fs/native.js:154-159`

`fsync` pousse les pages sales vers le support mais **n'invalide pas le page cache** : la relecture
de vérification (`sync.js:618-620`) est servie depuis la RAM. Un secteur défectueux, une carte SD
contrefaite ou un contrôleur qui ment ne sont pas détectés. Et si `copyPermissions` a recopié un
mode 0444, `open(p, 'r+')` échoue en EACCES, avalé ligne 157 : même le fsync n'a pas lieu.
Rapport « Verified, 0 errors » sur des rushes corrompus.

### B9 — `rename()` SFTP supprime la destination avant de renommer
`src/main/fs/sftp.js:228-242`

Le fallback se déclenche dès que source et cible existent, **quelle que soit la cause** de l'échec
du premier rename ; entre `unlink(dst)` et `_rawRename` il y a un aller-retour réseau complet.
Chemin utilisé à **chaque** écrasement (`sync.js:390`). Si la session se dégrade au mauvais moment,
la destination est définitivement supprimée et il ne reste qu'un `.syncto_tmp`. En `permanent`,
`archiveExisting` n'a rien conservé.

### B10 — `Delete.0..syncto.lock` résiduel bloque à vie toute prise de lock en SFTP
`src/main/core/lock.js:63-72,251-268`

`takeOver()` renomme toujours vers le même nom (`ABANDONED_LEVEL_MAX` et le compteur sont du code
mort), et `unlink(doomed)` est best-effort. En SFTPv3, `SSH_FXP_RENAME` échoue si la cible existe
(ssh2 n'utilise pas `posix-rename@openssh.com`) : dès qu'un résidu subsiste, chaque `renameStrict`
échoue, l'erreur est avalée, et `acquireOne` boucle indéfiniment. L'UI reste sur « Waiting for… »
à vie. Seule une suppression manuelle sur le serveur répare.

### B11 — `renameStrict` n'est pas exclusif : la garantie « un seul gagnant » est fausse
`src/main/fs/native.js:143`

En POSIX comme sur Windows, `rename` **écrase** silencieusement la cible ; ce qui départage A et B
n'est que l'`ENOENT` sur la *source*. Deux machines en attente sur un lock abandonné, décalées de
quelques dizaines de ms (un aller-retour SMB suffit) : B renomme après que A a recréé son lock,
supprime le lock de A et crée le sien. A tourne sans lock, B avec.

### B12 — `acquireAll` saute silencieusement tout dossier non `stat`-able
`src/main/core/lock.js:284-292`

Le `catch (_) {}` confond « n'existe pas encore » (skip voulu) et « stat a échoué » (permission,
hoquet réseau, timeout SFTP). Deux postes lancent leur **première** sauvegarde vers le même dossier
neuf du NAS : aucun des deux ne pose de lock. Le couple n'est protégé qu'à partir du deuxième run.

### B13 — NFD/NFC : doublons côté SFTP et Windows
`src/main/core/compare.js:247` · `src/main/core/sync.js:159` · `src/main/fs/sftp.js:38-42`

Pas de recopie infinie (`compare.js:210` indexe en NFC), mais `name = (l || r).name` prend
l'orthographe **du côté gauche** et `sync.js` la réinjecte telle quelle dans le chemin de
destination. Mac (NFD) → serveur Linux/partage Windows (NFC) : un **second** fichier est créé.
Au run suivant les deux entrées s'effondrent sur la même clé → « differ only by upper/lower case »,
et l'un des deux n'est plus jamais synchronisé.

### B14 — Une connexion SFTP ratée laisse une session SSH vivante
`src/main/fs/sftp.js:72-104` · `src/main/fs/afs.js:116-123`

Si `conn.sftp()` échoue (sous-système désactivé, chroot, MaxSessions), on `reject` mais `conn`
n'est jamais `end()`é et `this.conn` reste null — `closeAll()` ne peut plus rien nettoyer.
Dix tentatives sur un serveur mal configuré = dix sessions SSH vivantes avec leur keepalive.
Par ailleurs `afs.js` met le backend en cache **avant** `await backend.connect()`, et
`_connectPromise` n'est jamais remis à null : la promesse rejetée est rejouée pour tout le cycle.

### B15 — Symlinks recopiés à chaque run
`src/main/fs/native.js:145-148`

Pas de `lutimes` exposé ; `copyOne` sort avant toute pose de date pour un symlink, et le lien
recréé porte la date du jour, alors que `compare.js:353` compare les mtime obtenus par `lstat`.
Un projet contenant des symlinks est vu `LEFT_NEWER` à chaque nuit, et sous versioning une
révision de plus est archivée à chaque fois.

---

## C. Electron, IPC, configuration — majeur

### C1 — Aucune CSP, aucun garde-fou de navigation, `sandbox: false`
`src/renderer/index.html:20-22` · `src/main/main.js:105-113`

Ni `<meta http-equiv="Content-Security-Policy">`, ni `onHeadersReceived`, ni `setWindowOpenHandler`,
ni `will-navigate`. Sous Electron 34, l'absence de `setWindowOpenHandler` vaut « allow » : toute
fenêtre enfant hérite du `webPreferences`, **preload compris**.

Chemin le plus court : `installDropZones()` n'est appelé qu'après deux allers-retours IPC
(`app.js:1511-1526`) alors que la fenêtre est déjà affichée. Un `.html` lâché dessus pendant cette
fenêtre fait naviguer le webContents principal, et la page conserve `window.syncto` :
`openPath()` (exécution d'un fichier arbitraire), `openExternal()`, `verifyFolder()` (lecture
récursive arbitraire) et `loadPrefs()` — qui renvoie `prefs.sftp`, donc les logins et les chemins
de clés privées.

### C2 — `shell.openExternal` sans liste blanche de schéma, alimenté par un JSON distant
`src/main/main.js:210` · `main.js:60-67` · `app.js:1479`

`data.url` de `version.json` n'est ni validé ni contraint. Une URL `file:///…/payload.app` ou une
UNC `file://\\attaquant\share\setup.exe` est passée telle quelle à `ShellExecute`/`open` au clic
sur « Get it ».

### C3 — Écritures non atomiques : `preferences.json` et les fichiers `.syncto`
`src/main/config.js:138,182` · `load()` avale l'exception `:127-132`

Coupure pendant l'écriture (voir C4 : elles sont très fréquentes) → au lancement suivant, app
vierge sans message : récents perdus, réglages perdus, table `sftp` (identifiants) réinitialisée.
Pour un `.syncto`, c'est le fichier de job — conçu pour être partagé — qui est détruit.

### C4 — `fs.writeFileSync` à chaque événement `resize`
`src/main/main.js:117-121`

Aucun debounce ; `Prefs.save` fait un merge profond de toute la structure puis une écriture
synchrone dans le process principal. Redimensionner 3 s = ~150-200 sérialisations complètes.
Comme la synchronisation tourne dans ce même process, redimensionner pendant un gros transfert
gèle l'event loop, bloque les IPC de progression et fait chuter le débit.

### C5 — Écrasement silencieux d'un job existant
`src/main/main.js:274-282`

`showSaveDialog` valide `NAS-backup` (inexistant, donc aucun avertissement), puis le code ajoute
`.syncto` et écrase `NAS-backup.syncto` sans confirmation.

### C6 — Réentrance : compare et sync concurrents sur la même `MultiSession`
`src/renderer/app.js:632,639-649,1346` · `main.js:298,323`

`doCompareQuiet` ne positionne jamais `state.busy`. À la fin d'une synchro, les boutons sont
réactivés puis la re-comparaison silencieuse démarre. Reclic sur COMPARER : un second
`MultiSession.compare()` fait `await this.close()` — fermeture du pool FS/SFTP que le premier
walker utilise encore — et réassigne `this.sessions`. Erreurs d'E/S fantômes, arbres mélangés,
ou « Run a comparison first » inexplicable.

---

## D. Mineurs

| # | Fichier | Problème |
|---|---|---|
| D1 | `core/sync.js:597` | `this.done.files++` s'exécute aussi dans le `catch` : le rapport affiche « Files copied: 10 » et « Errors: 3 » côte à côte |
| D2 | `core/sync.js:337` · `core/compare.js:205` | Les `.syncto_tmp` orphelins (coupure, SIGKILL) ne sont jamais nettoyés et sont invisibles à la comparaison. 180 Gio perdus sur un NAS sans explication dans l'app |
| D3 | `core/compare.js:302-304` | Le filtre souple ne regarde que le côté gauche : en two-way, une modification récente à droite est écartée si la copie de gauche est vieille |
| D4 | `core/versioning.js:155-164` | `streamCopy` : `pipe` ne propage pas les erreurs, aucun nettoyage, écriture directe au nom final — une révision tronquée est indiscernable d'une bonne |
| D5 | `main.js:262-269` | Toute erreur de lecture d'un job (partage non monté, EACCES, JSON corrompu) est traitée comme « fichier disparu » et supprime l'entrée des récents |
| D6 | `config.js:171-177` + `app.js:165` | `loadJob` ne valide que `format` : un `"compare": null` provoque un `TypeError` non intercepté au milieu de la mise à jour de l'UI |
| D7 | `main.js:39-56` | `version.json` : corps non borné (OOM possible), `cb` appelable deux fois, redirections cross-host suivies |
| D8 | `main.js:239,288` | `lastJobPath` est écrit mais jamais relu : au relancement le job se détache de son fichier — c'est le chemin qui mène à C5 |
| D9 | `fs/native.js:63-68` | Pas de préfixe `\\?\` : sur Windows sans long-path, les 12 caractères de `.syncto_tmp` font basculer au-delà de 260 |
| D10 | `fs/sftp.js:38-42` | `normalize()` remplace tous les `\` par `/` : un fichier légitimement nommé `a\b.txt` sur Linux devient un chemin |

---

## Vérifié et écarté

- **Injection HTML dans le renderer : aucune.** Les 30 `innerHTML` de `app.js` ont été revus un par
  un ; toute donnée externe (noms de fichiers, chemins, messages du moteur, motifs de filtre,
  entrées récentes) passe par `esc()`. Les seules interpolations brutes sont des entiers ou des
  énumérés produits par le moteur. Cela dit, cette sûreté repose entièrement sur la discipline
  d'appel : sans CSP (C1), le premier `esc()` oublié devient une exécution de code.
- `'wx'` est bien supporté par ssh2 (`SSH_FXF_EXCL` réel) : la primitive exclusive du lock est
  correcte en SFTP.
- Les fichiers `Delete.N..syncto.lock` sont bien exclus de la comparaison (`compare.js:80-85`).
- L'arrondi à la seconde de `sftp.js:251-256` est couvert par la tolérance de 2 s par défaut.
- La détection de staleness est indépendante des horloges (croissance de taille mesurée avec
  l'horloge locale du guetteur) : pas de bug de décalage entre machines.
