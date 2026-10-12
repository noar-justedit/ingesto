# 06 · Signature et notarisation (macOS)

- macOS **signé et notarisé** depuis 2.5.5. Identité :
  `Developer ID Application: Arnaud AUGST (S488B2Z5LN)` (compte individuel).
- Windows et Linux **non signés**, décision de Noar du 31.08 (SmartScreen au
  premier lancement : attendu, documenté dans le README). Ne pas reproposer
  SignPath Foundation. Alternatives payantes seulement si Just Edit devient une
  personne morale.

## Chaîne (`scripts/build_mac.command` → `build-mac.sh`)
1. Pré-vol : interroge Apple avec le profil de trousseau
   **`ingesto-notarization`** avant de construire (« No submission history » =
   réponse normale d'un compte neuf).
2. electron-builder signe (identité détectée, jamais exigée : sans certificat,
   build non signé pour les contributeurs).
3. `scripts/notarize.js` (hook `afterSign`) : vérifie la signature réelle,
   `ditto`, `notarytool submit --wait`, `stapler staple`. Sortie vers `/dev/tty`.
4. DMG construit autour de l'app agrafée, notarisé et agrafé à son tour.
5. Contrôles finaux : `codesign --verify --deep --strict`, `spctl`.

Variables : `INGESTO_SKIP_NOTARIZE=1` (build local sans attente),
`INGESTO_NOTARY_PROFILE` (autre profil).

## Secrets
Rien de secret dans le dépôt : seulement des NOMS de profil. Le `.p12`
(certificat + clé) est sauvegardé hors ligne par Noar ; jamais dans le dépôt
(ignoré par `.gitignore`). Mot de passe pour application invalidé si le mot de
passe Apple change : recréer avec `xcrun notarytool store-credentials` et le
même nom de profil. Adhésion Apple 99 $/an.

## Le test qui compte à chaque publication
Télécharger le DMG depuis GitHub (pas depuis `dist/`), idéalement sur une autre
machine, double-clic. `xattr -p com.apple.quarantine` doit répondre sur le
fichier téléchargé, `spctl --status` doit dire `assessments enabled`.

## Build Windows depuis le Mac
`scripts/build_win_from_mac.command` : croisé, installeur NSIS non signé. Linux
se construit sur Linux (`build-linux.sh`).
