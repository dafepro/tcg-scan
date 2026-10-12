# Self-hosting

Build with `npm ci && npm run build`, then serve all of `dist/` over HTTPS. No secret or API-key configuration is required. Never expose a development server to the public internet as a production host.

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
