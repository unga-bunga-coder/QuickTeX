# QuickTeX

Phone-first LaTeX maths notebook. One pane, Obsidian-style live preview: maths renders in place
when the cursor leaves it; tapping an equation reveals its source with a preview bubble.
Gilles Castel-style snippets (mk, dm, x1 → x_1, sr, //, ;a → α, …) and a maths key row above the keyboard.

## Layout

- `src/core.js`: pure logic (block parsing, maths detection, snippets, jump, .tex export, backup merge). No DOM, no storage. Tested by `test-core.mjs`.
- `src/store.js`: notes in IndexedDB (`quicktex` database).
- `src/app.js`: edges. MathJax renderer, CodeMirror 6 live-preview editor (decorations + widgets), UI, export/import, service worker registration and update prompt.
- `src/vendor.js`: the CodeMirror exports, bundled to a global `CM`.
- `src/page.html`: the document, styles and markup; `/*FONTS*/ /*VENDOR*/ /*CORE*/ /*STORE*/ /*APP*/` placeholders.
- `src/sw.js`: service worker, cache-first. The build prepends `VERSION` (hash of the cached files) and `FILES`.
- `src/icons/`: `icon.svg` is the source; the PNGs (512, 192, 180 apple-touch) were rasterised from it with headless Chrome.
- `build.mjs`: writes the site to `dist/`: `index.html` with everything inlined, `mathjax.js` (MathJax 3 `es5/tex-svg-full.js`),
  `fonts/` (woff2 from @fontsource), `icons/`, `manifest.webmanifest` (theme colours read from the CSS tokens), `sw.js`,
  and `THIRD_PARTY_LICENSES.txt` (licence notices for every package bundled, found via the esbuild metafile).

Dependency rule: `app.js` uses `core.js` and `store.js`, never the reverse.

Run: `npm install && npm run build && npm test`. To try it, serve `dist/` (e.g. `python3 -m http.server -d dist`).

## Current state

Standalone offline PWA, deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`
(npm ci, build, test, deploy). No network requests at runtime. Notes live in IndexedDB on the device only;
"Export all notes" writes one JSON file and "Import" merges by note id, newest `updated` wins.

## Next job

Optional: sync notes as `.md`/`.tex` files to a private GitHub repo, for phone ↔ laptop sync.

## Style

Writing in UI copy: concise, natural, no em dashes.
