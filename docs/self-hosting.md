# Self-hosting

Build with `npm ci && npm run build`, then serve all of `dist/` over HTTPS. The included development and preview servers additionally provide the one-click reference installer described below. No secret or API-key configuration is required. Never expose a development server to the public internet as a production host.

For a subpath such as `/tcg-scan/`, build using `npm run build -- --base=/tcg-scan/`. The application uses local view state instead of deep-link routing, so no history rewrite is required beyond serving `index.html` at the app root.

Recommended response headers:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://cards.scryfall.io https://assets.tcgdex.net; media-src 'self' blob:; connect-src 'self' https://api.scryfall.com https://api.tcgdex.net https://db.ygoprodeck.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(self), microphone=(), geolocation=()
```

Test your host’s CSP with an actual visual and OCR scan before enabling it; WebAssembly and blob workers are required. Hosts with blanket cross-origin restrictions can block provider APIs. OCR has no external model dependency. Serve `.wasm` as `application/wasm` when possible. Use long immutable cache headers only for hashed assets; keep `index.html` revalidatable to pick up new builds.

`public/ocr/` is generated from locked npm dependencies and excluded from Git. The build copies it to `dist/ocr/` including required license notices. The pinned English model is SHA-256-verified during staging, served locally as `ocr/eng.traineddata.gz` (10.9 MB), and cached by Tesseract in the browser. Serve that `.gz` file as opaque `application/gzip` bytes, not with a second `Content-Encoding: gzip` layer that automatically decompresses it. Its source/model provenance and Apache-2.0 notice are included. No application server receives photos.

The OpenCV worker is bundled into hashed assets (about 15.5 MB uncompressed / 3.9 MB gzip in the measured build). Enable HTTP compression for JavaScript and JSON reference shards. Whole-game packs are separate one-time downloads/imports and can be large; preserve exact checksums rather than rewriting JSON. A first source-only install has zero visual references until a pack is installed. See [reference packs](reference-packs.md).

Changing the site’s origin changes its browser storage namespace. Export a JSON backup before moving hosts. Do not automatically upload or migrate a collector’s data to a server.

## Learned vision assets

Preserve the generated `vision-models/` directory, binary MIME types and license/model-card notices. `npm ci` stages pinned model data; cold builds need the exact official model download URLs or `TCG_VISION_MODEL_DIR`. Runtime inference and model loads are same-origin. No Microsoft telemetry domain or external model CDN belongs in `connect-src`. The runtime uses one WASM thread and does not require cross-origin-isolation headers.

Learned reference packs are imported separately into each browser's IndexedDB. Metadata is loaded globally, while candidate features use a bounded LRU. Model file size, pack disk size and peak browser RAM are distinct measurements. Browser quota failures leave unfinished packs unavailable; remove the failed installation before retrying.

## One-click Pokémon reference setup

`npm run dev` and `npm run preview` mount a fixed same-origin installer under
`/__tcg_scan/reference/pokemon/` (prefixed by the configured Vite base path).
The browser's **Install Pokémon database** button starts the download explicitly.
The local server fetches only the pinned public GitHub release archive, follows
only allowed GitHub asset redirects, verifies the exact size and SHA-256, and
keeps its cache under `.cache/tcg-scan/`. It does not accept arbitrary URLs or
receive photographs, scan frames or collections.

The archive is approximately 358 MB; the installed reference payload is approximately
391 MB, before database overhead. The server cache and each browser's IndexedDB
are separate copies. Interrupted downloads retain their partial cache for resume.
The browser reads bounded ranges from the checked cache and validates the ZIP,
manifest and individual reference hashes while importing. Cancellation does not
make a partial database ready for scanning.

**Static hosting with matching data:** build with
`VITE_TCG_REFERENCE_MODE=static npm run build`. Place the reviewed, unchanged
`manifest.learned.json` and its 154 binary shards under
`dist/reference-data/pokemon-en-learned-2026-10-12/`. The same install button then
reads only these fixed same-origin files, verifies the pinned manifest before
requesting shards, and installs sequentially with bounded buffers. No backend or
GitHub CORS is required. The manifest is 8,394,772 bytes; the largest shard is
2,490,400 bytes. The complete decoded payload is 391,001,940 bytes. Preserve
binary content and serve JSON/binary MIME types, not SPA fallback HTML. Ordinary
HTTP compression is supported, while decoded length and hashes remain exact.
Cancellation rolls back incomplete browser storage; retry restarts the static
file download. It does not claim the local server's resumable ZIP cache.

The build mode is explicit: unset/`local` uses the local relay, `static` uses the
fixed static files, and other values fail closed. A static hash/transport failure
never silently falls back to another host. Hosting only the default `dist/`
without matching reference files does not make the database available.

**ZIP fallback:** GitHub release assets do not provide browser-readable CORS in
the verified route. On a host without either installation method, download the
complete release ZIP and select it through **Use a downloaded reference ZIP**. Do not add a public CORS proxy
or put GitHub credentials in browser code. Preserve provider/model notices if you
redistribute reference data. The source software's MIT license does not relicense
underlying Pokémon artwork or assert blanket rights in derived data.

See [static deployment](static-deployment.md) for the reviewed local packaging path and the intended public app destination.
