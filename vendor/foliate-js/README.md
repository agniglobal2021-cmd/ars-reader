# foliate-js (vendored)

Upstream: https://github.com/johnfactotum/foliate-js, commit in `UPSTREAM`. MIT, see `LICENSE`.

Only the modules the reader uses are copied. Changes against upstream:

- `tags.js` (new): custom element names carry the plugin version (`foliate-view-0-1-0`, …), and
  `define()` skips names that are already registered. An updated plugin then works without
  restarting Obsidian, and turning the plugin off and on again does not throw.
- `view.js`, `paginator.js`, `fixed-layout.js`: use `TAG` and `define()` from `tags.js`.
- `view.js`: PDF is not opened by foliate's `pdf.js`. `src/pdf.ts` makes the book with the PDF.js
  Obsidian already ships, so PDF.js is not bundled; its sections return `{ src, onZoom }`.
- `paginator.js`: `View.render()` returns when its frame is already detached. Closing a pane could
  otherwise let a last resize reach a frame without a document and throw.
- `paginator.js`: the page curl (`turn` attribute: `curl`, `slide`, `none`). A drag pulls the page
  by its corner (`src/curl.ts` draws it); a second view of the section shows the page under the
  turning one, with section loads counted so that both views can share a section. The `turning`
  attribute is set while a page turns.
- `fixed-layout.js`: the same curl for fixed layouts (PDF, comics, fixed-layout EPUB). The pages
  stand in a sheet; a turn draws the target spread in a second sheet under it and swaps the two
  when it is done, so nothing loads twice. The next spread is drawn ahead; a turn waits for a
  PDF page's picture (`onZoom` may return a promise). Without the curl a swipe still turns the
  page. `paper`/`paper-dark` attributes give the colour of the page's back.
- `fb2.js`: the metadata also carries `publishYear` and `isbn` from `publish-info` (the paper
  edition). The cover is taken only from a picture inside the book (`data:`), never fetched from
  an address the book names.

Scripts in books are blocked outside this folder, in `src/sanitize.ts`: every section passes
through it before it is shown, whatever the format.

Vendored by foliate-js itself, in `vendor/`:

- zip.js by Gildas Lormeau, BSD-3-Clause license: https://github.com/gildas-lormeau/zip.js
- fflate by Arjun Barrett, MIT license: https://github.com/101arrowz/fflate
