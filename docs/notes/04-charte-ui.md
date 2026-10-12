# 04 · Charte UI

Partie A : ce qui est propre à ingesto. Partie B : la charte commune à toutes
les applis de Noar (arrêtée sur ingesto 2.7.0). La page `charte-ui-noar.html`
à côté de ce fichier rend chaque composant : c'est la référence à regarder.

## A. Spécifique à ingesto

- Accent de marque : `#8b6ff0` (violet), logo et pastille seulement.
- **Couleurs des modes**, identiques dans l'appli et dans le rapport :
  FAST gris, SIZE CHECK bleu (`m-sizecheck` ; l'ancienne classe `m-verified`
  est gardée et repeinte en bleu), SECURE orange, PRO violet.
- Folder Structure : un jeton **avant le dernier `/`** est un sous-dossier, en
  **bleu** ; après, le dossier de la carte, en **vert**. Variable en gras,
  texte libre en italique. C'est voulu, même si un template qui commence par
  des sous-dossiers paraît « tout bleu ».
- Marques d'origine : (A) vert = lu sur cette carte (`_camDetected`), (M) gris
  = tapé, sur cette carte ou repris de la précédente.
- Tous les correctifs de style depuis la refonte sont dans le bloc
  « Reparations, mesurees dans l app qui tourne » en fin de feuille, numérotés
  (1 à 11 en 2.7.2). En ajouter un = un nouveau numéro, avec en commentaire ce
  qui était cassé et comment on l'a mesuré.
- Barres de défilement globales : 8 px, pouce `#2a2d36`, toujours dessinées
  (macOS les masque sinon au trackpad, c'est ce qui a caché la fin du menu
  Insert à un utilisateur en 2.7.1).
- Menus : sur `#1b1d24`, jamais sur la couleur de la carte dessous ; tout doit
  tenir sans défilement à la plus petite fenêtre (1280 × 760).

## B. Charte commune

## 1. La règle

Le groupement est porté par **le fond**, jamais par un trait.

Trois niveaux de surface, jamais quatre :

| Niveau | Jeton | Valeur | Ce que c'est |
|---|---|---|---|
| 1 | `--page` | `#0a0b0e` | le fond de fenêtre |
| 2 | `--card` | `#14161c` | une carte, c'est-à-dire un groupe d'informations |
| 3 | `--ins` | `#0e1014` | un creux dans une carte : champ, tuile, ligne de liste |
| flottant | `--raise` | `#1b1d24` | menu, infobulle, survol, posés au-dessus |

`--raise` n'est pas un quatrième niveau de structure : rien ne s'y empile, il
ne sert qu'à ce qui flotte au-dessus du reste et repart aussitôt.

**Aucune bordure, aucun filet de séparation.** Le seul contour autorisé est
celui qui dit un état : sélection, focus clavier, alerte.

12 px entre deux cartes. Rayons : carte 14, creux 11, champ 8, badge 4.

---

## 2. Jetons

```css
:root{
  /* surfaces */
  --page:#0a0b0e; --card:#14161c; --ins:#0e1014; --raise:#1b1d24;
  /* texte */
  --text:#e8eaf0; --text2:#aeb3bd; --text3:#8b909b; --text4:#6f757f;
  /* états, communs à toutes les applications */
  --green:#35c98b; --red:#f2555a; --blue:#4d90f0; --orange:#f2a03d;
  /* accent : LA SEULE VALEUR PROPRE À CHAQUE APPLICATION */
  --accent:#8b6ff0;
  /* rayons */
  --r-card:14px; --r-ins:11px; --r-field:8px; --r-badge:4px;
  /* polices */
  --font:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,monospace;
}
```

**Le sens des couleurs d'état ne change jamais d'une application à l'autre :**
vert ce qui est fait et vérifié, rouge ce qui a échoué ou ce qui est une
source, bleu une information neutre, orange ce qui manque ou ce qui demande une
décision.

**L'accent ne sert qu'à la marque** : logo, pastille d'identité. Jamais pour
marquer un état, sinon il entre en concurrence avec les quatre couleurs
ci-dessus. C'est la seule valeur à remplacer quand on porte la charte : tout le
reste est commun, ce qui donne une famille reconnaissable sans que deux
applications se confondent. Pour presto, reprendre la valeur déjà décidée dans
`claude/presto-code-couleur.md` plutôt que d'en inventer une.

---

## 3. Composants

### Badge

Un seul gabarit pour toutes les notions : numéro de source, état, modèle de
matériel, mode. Seule la couleur change.

```css
.badge{ font-size:9px; font-weight:700; letter-spacing:.06em;
        color:{couleur}; background:{couleur}26;
        padding:2px 6px; border-radius:4px; }
```

`{couleur}26` est la couleur en hexadécimal à huit chiffres, soit 15 %
d'opacité. Ne jamais poser un badge sur un fond plein.

### Étiquette de champ

```css
.lbl{ display:flex; align-items:center;
      height:12px; line-height:12px;   /* indispensable */
      gap:6px; font-size:10px; font-weight:700; letter-spacing:.14em;
      color:var(--text3); margin-bottom:6px; }
```

La hauteur fixe est ce qui garde deux colonnes de champs alignées quand l'une
porte un picto de 12 px et l'autre non. Sans elle, la ligne grandit et tout le
champ descend d'un pixel.

### D'où vient une valeur

Quand l'application remplit un champ toute seule, elle le dit : rond vert
**(A)** détecté, rond gris **(M)** saisi à la main, 12 px, à côté de
l'étiquette. Le picto disparaît si le champ n'est jamais rempli
automatiquement.

```html
<svg width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="détecté">
  <circle cx="12" cy="12" r="10" fill="none" stroke="#35c98b" stroke-width="2"/>
  <text x="12" y="12" text-anchor="middle" dominant-baseline="central"
        fill="#35c98b" font-size="13" font-weight="700">A</text></svg>
```

`dominant-baseline="central"` et non une position calculée à la main : c'est ce
qui centre la lettre quelle que soit la police du système.

### Champ

```css
.field{ background:var(--ins); border:none; border-radius:8px;
        padding:9px 10px; color:var(--text); font-size:14px; }
.field:focus{ outline:none; box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); }
```

Une unité, un jeton ou un suffixe se pose à droite **dans le même creux**, en
chasse fixe, 10 px, `--text4`.

### Boutons

Trois formes, pas davantage.

- **Discret** : `background:var(--ins); border:none; border-radius:9px;
  padding:8px 14px; font-size:12px; font-weight:600;`
- **Icône seule** : carré de 28, rayon 8, sur `--card`. **Toujours un
  `aria-label` et un `title`** : une icône ne se lit pas.
- **Action principale** : pleine largeur, rayon 14, fond teinté de sa couleur
  d'état (`#0f2c1d` pour une action verte), texte de cette couleur.

### Listes

Une ligne est un creux. Les lignes sont séparées par un écart, jamais par un
filet.

Dans une liste de choix, **l'élément actif est le seul posé sur un fond**, les
autres sont à plat sur la carte. C'est la présence de la surface qui dit
« celui-là », ce qui évite de consommer une couleur pour ça. Une coche verte
peut s'ajouter, rien d'autre.

### Interrupteur

34 × 20, pastille de 14. Allumé : fond vert, pastille blanche à droite. Éteint :
fond `--ins`, liseré intérieur à 9 % de blanc, pastille grise à gauche.

### Menus et infobulles

Posés sur `--raise`, rayon 12, ombre `0 18px 44px rgba(0,0,0,.6)`.

Au-delà d'une dizaine d'entrées, un menu est **groupé**, et chaque entrée montre
à droite, en chasse fixe, ce qu'elle écrit réellement. Une infobulle dit la
règle, pas le nom du bouton : elle remplace une ligne d'aide permanente.

### Débordement

**Aucune poignée déplaçable.** Elle introduit une position à mémoriser, à
restaurer et à corriger à chaque changement de taille de fenêtre.

Une zone qui peut grandir sans fin montre deux rangées ou deux écrans, puis
défile sur elle-même, en-tête et pied de carte fixes. On laisse **dépasser une
lichette** de la rangée suivante : une coupe nette donne l'impression que tout
est affiché.

```css
.scroll{ max-height:<deux rangées + une lichette>; overflow-y:auto;
         scrollbar-width:thin; scrollbar-color:#2a2d36 transparent; }
.scroll::-webkit-scrollbar{ width:8px; }
.scroll::-webkit-scrollbar-thumb{ background:#2a2d36; border-radius:8px; }
```

La hauteur se mesure, elle ne se devine pas : rendre la page, lire la hauteur
réelle d'une tuile, calculer `2 × tuile + écart + marges de la carte`.

### Fenêtres

Carte sur un voile noir à 66 à 72 %, rayon 18, ombre
`0 30px 80px rgba(0,0,0,.6)`. Les sections sont des cartes, les sous-options
descendent dans le creux, les boutons sont pleine largeur en bas.

**Échap ferme toute fenêtre qui ne fait qu'informer.** Une fenêtre qui porte une
décision (un refus, un résumé de fin d'opération) garde ses boutons : la fermer
d'une touche reviendrait à choisir à la place de l'utilisateur.

### Typographie

| Usage | Taille / graisse |
|---|---|
| Titre de fenêtre | 26 / 700, interlettrage -.6 |
| Titre de carte | 18 / 600, -.3 |
| Nom d'objet | 16 / 600, -.2 |
| Texte de champ | 14 / 400 |
| Texte courant | 12.5 / 400 |
| Aide, précision | 11.5 / 400, `--text3` |
| Étiquette | 10 / 700, interlettrage .14em, capitales, `--text3` |

Chasse fixe pour tout ce qui est un chemin, un nom de fichier, un jeton, un
nombre destiné à être comparé. Jamais pour de la prose.

---

## 4. Comment porter la charte sur une application existante

C'est la partie qui fait gagner du temps. Elle a été éprouvée sur ingesto, dont
l'interface tient dans un fichier de 7 500 lignes.

### 4.1 Ne pas réécrire les règles existantes

Ajouter **un bloc unique à la fin de la feuille de style**, qui redéfinit
par-dessus. Avantages concrets :

- la refonte se lit d'un seul tenant, et se retire d'un bloc si elle déplaît ;
- le reste du code n'est pas touché, donc rien d'autre ne peut casser ;
- les correctifs de style se font tous au même endroit.

Attention dans un fichier unique : si l'application contient un gabarit de
document (un rapport HTML par exemple) écrit dans une chaîne, il contient lui
aussi une balise `</style>`. Insérer le bloc avant **la première**, pas avant la
dernière.

Ordre du bloc :

1. redéfinir `:root` (surfaces, accent) ;
2. supprimer les bordures et filets de structure (colonnes, en-têtes, sections) ;
3. transformer les conteneurs de section en cartes ;
4. faire descendre les champs, tuiles et lignes au niveau creux ;
5. retirer les contours des petits contrôles (puces, pilules, boutons à icône).

### 4.2 Vérifier en exécutant, jamais en imaginant

À chaque étape, l'application est **réellement lancée** et capturée. Pour une
application Electron, cela se fait sans build, en ouvrant le fichier de
l'interface dans un navigateur avec l'API du processus principal simulée :

```js
await page.addInitScript(() => {
  const api = { platform:'darwin', getVolumes: async () => [...],
                loadPrefs: async () => ({}), /* … */ };
  window.<nom_du_pont> = new Proxy(api, {
    get(t,k){ if(k in t) return t[k];
              if(typeof k==='string' && k.startsWith('on')) return () => {};
              return async () => null; }
  });
});
```

Le Proxy est ce qui évite d'écrire le bouchon complet : toute méthode non prévue
répond `null`, tout abonnement `onX` ne fait rien. On peuple ensuite l'état en
appelant les fonctions de l'application elle-même, puis on capture.

### 4.3 Ordre des tranches

Faire dans cet ordre, et livrer entre chaque :

1. **Les surfaces.** Beaucoup d'effet, aucun risque, aucune logique touchée.
2. **La zone la plus chargée** de l'interface, souvent une colonne de réglages.
3. **Les autres zones**, une par une.
4. **Les fenêtres** : réglages, alertes, modes particuliers.
5. **Les documents produits** (rapport imprimable, export) en dernier, avec une
   feuille d'impression : fond blanc, couleurs assombries, contrôles masqués.

### 4.4 Ce qu'il faut tester

Une refonte de style peut casser des tests qui lisaient le balisage. Ils ne sont
pas à supprimer : leur intention reste valable, seule leur façon de lire change.
Exemple vécu : un test lisait les variables offertes en cherchant
`addTok('var','X')` ; le menu appelle désormais `insPick('var','X')`. La
correction est d'élargir la lecture aux deux formes, pas de retirer le test.

Ajouter des tests sur ce que la charte promet et qui peut régresser en silence :
présence d'un `aria-label` sur chaque bouton à icône, absence de la classe
supprimée, couleur d'un état dans la feuille, touche Échap qui ferme.

Et vérifier chaque test par mutation : casser volontairement le code, constater
que le bon test passe au rouge, remettre en état.

---

## 5. Le contrat, en dix lignes

1. Trois surfaces : page, carte, creux. Jamais une quatrième.
2. Aucun filet, aucune bordure, sauf pour dire un état.
3. 12 px entre deux cartes ; rayons 14, 11, 8, 4.
4. Un seul gabarit de badge, la couleur porte le sens.
5. Vert fait et vérifié, rouge échoué ou source, bleu neutre, orange à décider.
6. L'accent ne sert qu'à la marque, et c'est la seule valeur propre à l'appli.
7. Étiquettes en capitales 10/700, hauteur fixe 12 px.
8. Chasse fixe pour les chemins et les nombres, jamais pour la prose.
9. Deux rangées puis ascenseur, une lichette qui dépasse, pas de poignée.
10. Toute icône seule porte un `aria-label`. Échap ferme ce qui informe.
