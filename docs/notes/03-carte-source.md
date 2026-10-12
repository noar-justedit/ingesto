# 03 · Règle non négociable : la carte source n'est jamais touchée

Décidée par Noar le 22.09.2026, verrouillée dans le code en 2.7.0.

**ingesto ne supprime, ne renomme et n'écrase jamais un fichier sur une carte
source.** Aucune exception, y compris pour un fichier que la carte porte et qui
ressemble à un fichier d'ingesto (`*.ingesto-part`, `*.ingesto-failed` : ce sont
des rushes si la carte les porte).

## Comment c'est tenu
1. **Le verrou** (`src/main/main.js`, bloc « THE SOURCE-CARD LOCK ») : toute
   suppression, tout renommage et toute ouverture en écriture du moteur passe
   par `safeUnlink`, `safeRename`, `safeRmTree` ou `safeWriteTarget`. Pendant un
   ingest (`start-copy`) et une re-copie (`recopy-failed`), chaque carte du lot
   est verrouillée ; toute opération qui la vise est refusée, y compris à
   travers un lien symbolique. Le refus lève une erreur
   (`code='INGESTO_SOURCE_LOCK'`) : jamais de repli qui ferait l'opération.
2. **Durée** : le temps du run, pas la vie de l'app. Un disque navette vidé
   comme source le matin doit pouvoir servir de destination l'après-midi.
3. **Premier verrou** : PF-E6 refuse de démarrer si une destination est une
   carte du lot, est dedans, ou la contient.
4. **Test** `scripts/test-source-lock.js` : échoue si `unlinkSync`,
   `renameSync`, `rmSync`, `rmdirSync` ou `truncate` apparaît dans `main.js`
   hors du verrou, ou une suppression quelconque dans `sentinel.js`. Vérifie
   aussi sur de vrais fichiers qu'une carte verrouillée ressort identique octet
   pour octet.

## La seule écriture autorisée sur une carte : Card Tracking
Désactivé par défaut. Activé, il écrit **son propre journal** à la racine :
`.ingesto.json`, via `.ingesto.json.tmp`, et renomme un journal illisible en
`.ingesto.json.unreadable`. Ces noms exacts et rien d'autre (`journalOnly` dans
`sentinel.js`). Aucune suppression, même de son fichier de travail.

La détection de carte protégée (interrupteur SD) ne crée plus de fichier test :
`fs.accessSync(root, W_OK)`. Limite Windows : le système ne le signale pas pour
un dossier, la carte verrouillée est donc signalée en fin d'ingest.

## Ce qu'ingesto ne peut pas empêcher
La commande post-ingest et le Card Handoff lancent un programme écrit par
l'utilisateur. Ce programme peut effacer une carte ; le document du handoff lui
dit même si c'est sans risque (`safeToErase`). Voulu et documenté.

## Pour toute évolution
Toute nouvelle opération destructive sur le disque passe par le verrou. Si le
test casse, on corrige le code, jamais le test.
