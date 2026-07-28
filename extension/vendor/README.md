# Vendored libraries

These are prebuilt browser bundles copied in at development time so the
extension has **no build step** — clone the repo, `Load unpacked`, done.

Content scripts are classic scripts, not ES modules, so every file here must
work when loaded with a plain `<script>` and must expose a global.

| File | Package | Version | License | Global it defines |
| --- | --- | --- | --- | --- |
| `turndown.js` | [turndown](https://github.com/mixmark-io/turndown) | 7.2.4 | MIT | `TurndownService` |
| `turndown-plugin-gfm.js` | [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | 1.0.2 | MIT | `turndownPluginGfm` |
| `readability.js` | [@mozilla/readability](https://github.com/mozilla/readability) | 0.6.0 | Apache-2.0 | `Readability` |
| `finder.js` | [@medv/finder](https://github.com/antonmedv/finder) | 4.0.2 | MIT | `FinderLib` (`.finder`) |

Full license texts are in `licenses/`.

## Which build was taken, and why

- **turndown** — `lib/turndown.browser.umd.js`, not `lib/turndown.umd.js`. The
  browser build drops the `@mixmark-io/domino` DOM shim, which is dead weight in
  a page that already has a real DOM.
- **turndown-plugin-gfm** — `dist/turndown-plugin-gfm.js`. Adds tables and
  strikethrough. Without it Turndown passes tables through as raw HTML, which is
  precisely the content a scraper cares about most.
- **@mozilla/readability** — `Readability.js` as shipped. It declares
  `function Readability` at top level, so loading it as a classic script is
  enough; its trailing `typeof module === "object"` guard is inert here.
- **@medv/finder** — ships as ES modules only, so it was bundled to IIFE:

  ```bash
  npx esbuild node_modules/@medv/finder/finder.js \
    --bundle --format=iife --global-name=FinderLib \
    --target=chrome110 --outfile=finder.js
  ```

## Updating

Reinstall the package, copy the file listed above into place, and update the
version in the table. For `finder`, re-run the esbuild command.
