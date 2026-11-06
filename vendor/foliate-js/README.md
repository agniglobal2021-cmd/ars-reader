# foliate-js (vendored)

Upstream: https://github.com/johnfactotum/foliate-js, commit in `UPSTREAM`. MIT, see `LICENSE`.

Only the modules the reader uses are copied. Changes against upstream:

- `tags.js` (new): custom element names carry the plugin version (`foliate-view-0-1-0`, …), and
  `define()` skips names that are already registered. An updated plugin then works without
  restarting Obsidian, and turning the plugin off and on again does not throw.
- `view.js`, `paginator.js`, `fixed-layout.js`: use `TAG` and `define()` from `tags.js`.
- `view.js`: PDF is not opened here (Obsidian has its own PDF viewer), so PDF.js is not bundled.

Scripts in books are blocked outside this folder, in `src/sanitize.ts`: every section passes
through it before it is shown, whatever the format.

Vendored by foliate-js itself, in `vendor/`:

- zip.js by Gildas Lormeau, BSD-3-Clause license: https://github.com/gildas-lormeau/zip.js
- fflate by Arjun Barrett, MIT license: https://github.com/101arrowz/fflate
