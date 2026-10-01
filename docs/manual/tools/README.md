# Regenerate the user manual

The manual is written in `docs/manual/manual-en.html` and `manual-fr.html`,
styled by `manual.css`, illustrated by `images/`. Two scripts rebuild it:

- `capture.js` takes the screenshots from the real interface
  (`src/renderer/index.html`) with demo data, without building the app.
- `build-pdf.js` prints the two HTML files to PDF.

Both need Playwright, which is **not** a dependency of ingesto. Install it
outside the project so `package.json` and `node_modules` stay untouched:

```
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm install playwright
npx playwright install chromium
```

Then, from the ingesto folder:

```
NODE_PATH=/tmp/pw/node_modules node docs/manual/tools/capture.js
NODE_PATH=/tmp/pw/node_modules node docs/manual/tools/build-pdf.js
```

`capture.js 15 22` retakes only the screenshots whose name starts with `15` or
`22`. `PW_EXE=/path/to/chromium` uses a Chromium already installed.

## For a new version

1. Retake the screenshots: the version number shown in the app comes from
   `package.json`.
2. Update the version in the two HTML files: the cover, the `<title>`, and the
   page footer (`@page` rule in the `<style>` at the top).
3. Update the text for anything that changed in the interface.
4. Rebuild the PDFs and read them page by page.

No em dash or en dash anywhere, as in the rest of the project.
