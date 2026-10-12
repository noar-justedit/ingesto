# 05 · Tester sans build

Un build Electron prend des minutes et une notarisation Apple davantage. Presque
tout se vérifie sans.

## 1. La suite du moteur : `npm test`
30 fichiers `scripts/test-*.js`, lancés par Node seul (pas d'Electron). Ils :
- extraient des fonctions de `main.js` / `index.html` et les exécutent dans un
  contexte `vm` avec de faux voisins (`extractFn`, `extractConst`) ;
- copient de vrais fichiers dans des dossiers temporaires (verrou carte source,
  vérification sabotée octet par octet, reprise) ;
- lisent le balisage pour les promesses de l'interface (aria-label, CSP,
  couleurs des modes, blocs de style).

Règle qui se dégage des audits : **un test est solide quand il appelle la vraie
fonction et vérifie un effet** ; il ne prouve rien quand il réimplémente la
fonction, vérifie seulement un retour, ou ne reçoit jamais d'entrée fautive.
Toujours un cas témoin qui doit réussir à côté du cas qui doit échouer.

## 2. Vérifier un test en le cassant (mutation)
Pour chaque nouveau test : modifier le code pour réintroduire le défaut, lancer
le test, constater le rouge, restaurer. Un test qui reste vert face au défaut
ne protège rien. Garder une copie du fichier avant la mutation et la restaurer
après chaque essai.

## 3. L'interface, sans build : le harnais Playwright
Dossier `docs/notes/harness/` :
- `stub.js` ouvre `src/renderer/index.html` dans Chromium avec un faux
  `window.ingesto` (Proxy : toute méthode non prévue renvoie `null`, tout
  abonnement `onX()` est gardé dans `window.__cb`) et des données de démo
  (volumes, lignes de rapport).
- `exemple.js` : charge une carte et deux destinations, mesure, capture dans
  `docs/notes/harness/out/` (ignoré par git).

Mise en place (à faire valider par Noar : c'est une installation) :
```
npm install --no-save playwright
npx playwright install chromium
node docs/notes/harness/exemple.js
```
`--no-save` n'écrit rien dans `package.json` ; un `npm ci` ultérieur l'efface.

Méthode :
- peupler l'état en appelant les fonctions de l'appli (`addToZone`,
  `onRawInput`, `startCopy`, `clearSources`...), jamais en écrivant le DOM ;
- simuler un ingest : `open(b, { startNever:true })`, `startCopy()`, puis
  `window.__cb.onCopyProgress({...})` avec les champs de `tfProgress` ;
- mesurer par `page.evaluate` (tailles, `scrollHeight` contre `clientHeight`,
  couleurs calculées), **400 ms après** un changement à cause des transitions ;
- tester aux trois largeurs de référence : 1280, 1500, 1920 (points de rupture
  CSS à 1300 et 1500).
- Pour montrer une maquette à Noar : figer la page (retirer les `<script>`,
  écrire les valeurs des champs en attribut) et lui livrer le **HTML**, pas une
  image.

## 4. Ce qui ne se teste qu'en vrai (chez Noar)
Vitesse réelle sur carte et disque navette, relecture sans cache sur NAS SMB,
signature et notarisation, Windows, éjection, cartes protégées en écriture.
Lui donner une liste courte et concrète de gestes à faire.
