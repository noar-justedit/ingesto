# ingesto 2.7.3

A maintenance release for the project itself. Nothing changes in the app you use: the copy engine, the verification and the interface are exactly the same as in 2.7.2.

## For users
- No new feature and no behaviour change. Updating is optional.
- Same requirements as 2.7.2.

## For people who build ingesto from source
- The build launchers are renamed: `scripts/build_mac.command` (Mac) and `scripts/build_win_from_mac.command` (Windows installer, built from a Mac). Double-click them as before.
- A `.gitignore` now keeps `node_modules/`, `dist/` and other generated files out of the repository.

## Project tracking
- New files at the root of the repository: `AGENTS.md` (working rules for anyone, human or AI, who contributes), `ETAT_PROJET.md` (current state, decisions, known issues, next steps), `CHANGELOG.md` (version history).
- The detailed project notes are now published in `docs/notes/`.
- These tracking files and notes are written in French.
- New `scripts/push_github.command`, used by the maintainer to publish a release.

## Tests
1832 checks, all passing (1826 in 2.7.2, plus 6 covering the new publishing scripts).
