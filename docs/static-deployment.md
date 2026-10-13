# Static deployment

## Status and boundary

The intended public application is **tcg-scan** on Cloudflare Workers Static Assets at **tcg.quicktrack.cc**, mounted at **/**. The authorized account, unused hostname and dashboard folder-upload route were checked separately on 2026-10-13. Do not overwrite an existing DNS record or application; recheck the destination immediately before publishing. This is the normal application destination, without a development suffix.

The app supports a static reference installer and a local-only packaging script. Deployment configuration and Cloudflare credentials live in [dafepro/deploy](https://github.com/dafepro/deploy), which owns the `tcg-scan` Worker and intended custom domain. Dashboard inspection found the existing Worker has no active deployment or custom domain. Its first public deployment and smoke checks remain separate gates. A successful local verification or build is not a deployment.

The owner selected Mac-first CI with an explicit GitHub-hosted Ubuntu override. Both CI and retained-release workflows are manual, numeric-owner-only and main-only; public PR code never runs on the personal runner. Repository variable `BUILD_RUNNER=github`, or dispatch input `build_runner=github`, selects hosted execution. GitHub does not automatically reroute an unavailable Mac. Do not add cloud credentials to source, Vite variables, generated assets or the bundle. The source repo receives only the shared central Issues-only request credential; Cloudflare credentials remain in deploy.

## Central release requests

After the migration PR and central controller are reviewed, set `DEPLOY_REQUESTS_ENABLED=true` and manually dispatch `.github/workflows/static-release.yml` on main. It runs normal checks, fetches the public reference ZIP pinned by this checkout, verifies archive and shard identities, builds static mode at `/`, and uses the existing packager to produce a fresh audited tree. It publishes a retained GitHub release containing `worker.tgz` and `release-manifest.json`, then requests a deployment PR through the shared `DEPLOY_REQUEST_TOKEN`. There is no direct Cloudflare deployment in the app repo.

The central controller revalidates the successful source run, retained asset checksums, root base, all payload bytes and pinned reference manifest/shards before deploying. Routine updates use a single-Worker Editor token and version upload/deploy. A separately gated provisioning workflow owns the first custom-domain setup and refuses existing unowned DNS records. Both central tcg-scan switches start false. The retained release has roughly 483 MB of expanded files; this is an explicit release build, not a download in default tests.

## Local server and static mode

- Ordinary `npm run dev` and `npm run preview` use the existing local reference-installer server. An unset mode or `VITE_TCG_REFERENCE_MODE=local` uses that bounded, pinned ZIP relay. Its private cache must never be deployed.
- Build with `VITE_TCG_REFERENCE_MODE=static` for a static host. The explicit **Install Pokémon database** action fetches the fixed same-origin manifest and its shards. It does not require the local installer API, a proxy, a Worker function, GitHub browser CORS access, or an arbitrary remote URL.
- The static mode flag is a Vite build-time setting. Changing a host's environment after uploading an existing build does not change that build. The packaging script requires exactly one static-installer chunk and a reference to it from the entry JavaScript, rejecting an ordinary local-relay build. It also records the same-origin base path inferred from entry HTML, with matching CSS/favicon paths. These checks do not replace building with the command below and smoke-testing the result.
- The installer path is `BASE_URL` followed by `reference-data/pokemon-en-learned-2026-10-12/manifest.learned.json`. Every `features-NNNNN.bin` is served beside that manifest. The manifest pins each shard; `src/lib/pokemon-reference-release.ts` independently pins the manifest, release totals, and reference counts.
- A `/tcg-scan/` base build is suitable only when the host actually mounts these files at that prefix. Uploading its files to the root of a plain `pages.dev` or `workers.dev` site does not automatically create that mount. Use `/` for a root deployment or rebuild for the verified route. Do not guess the final route.
- Failed integrity checks do not fall back silently to a relay or another origin. The user can explicitly choose the complete reference ZIP fallback. Other games still require their own compatible visual references.

## Build in a reviewed workspace

From the reviewed checkout, use its installed lockfile dependencies. On a fresh authorized environment, install with `npm ci` first. Run the normal checks. The aggregate includes the packager's Node tests through `test:packaging`, separately from Vitest:

```sh
npm run check
# Optional focused packaging rerun:
npm run test:packaging
```

Build into a fresh temporary location, outside the checkout. The verified target requires the root base `/` shown below. A previous `/tcg-scan/` build is only a subpath QA artifact; do not upload it to the root destination. Vite's normal build still prepares and includes local OCR/model assets and notices.

```sh
BUILD_ROOT=/absolute/path/on-disk/tcg-static-build
mkdir "$BUILD_ROOT"  # Must not already exist.
VITE_TCG_REFERENCE_MODE=static npm run build -- \
  --base / --outDir "$BUILD_ROOT/dist"
```

Do not reuse an arbitrary output directory or add `--emptyOutDir` to erase one. Do not build from a checkout containing secrets in client-visible Vite variables. The reviewed runtime-pruned static assets are about 55.56 MB before reference data (the published baseline was about 92 MB); the reference data adds about 391 MB. Allow extra disk space for source, build, staging and the browser's IndexedDB import. Check that the chosen paths are disk-backed: a RAM-backed temporary directory can consume the memory needed by the scanner.

## Runtime asset layout

OCR preparation stages only the unchanged SIMD-LSTM and non-SIMD-LSTM self-contained Tesseract wrappers. Both remain required, along with the worker, the unchanged English `4.0.0` model and every license. `ocr/runtime-provenance.json` records wrapper and embedded-WASM hashes. Preparation removes only six exact retired generated filenames whose bytes match the reviewed version; unknown bytes or symlinks fail closed, and other files are preserved. Rebuild rather than manually deleting a fallback.

The exact ORT WASM fallback specifier resolves through Vite to the existing verified `vision-models/ort-wasm-simd-threaded.wasm`, including subpath builds. The official glue and both vendor/staged WASM hashes must match the pinned version before building; a duplicate emitted ORT WASM fails the build. Application-side runtime integrity checks are unchanged. This reduces deployed file inventory, not the browser's already-observed cold download, because those redundant files were not requested.

## Verify, then stage a fresh local bundle

The reference input must be the already-available, reviewed numeric release directory containing exactly `manifest.learned.json` and its 154 manifest-listed shards. It is not an archive, the private dataset parent, an image cache, a user collection, or a directory chosen by glob. The current reviewed source contains no extra top-level notices. Provider and redistribution notices are deliberately sourced from the checkout instead.

Set an explicit local source. Create a parent directory, but leave the actual output path absent:

```sh
REFERENCE_PACK_DIR=/absolute/path/to/reviewed/reference-pack
BUNDLE_PARENT=/absolute/path/on-disk/tcg-static-bundle
mkdir "$BUNDLE_PARENT"  # Must not already exist.
BUNDLE="$BUNDLE_PARENT/tcg-scan"

node scripts/stage-static-reference-data.mjs \
  --source "$REFERENCE_PACK_DIR" \
  --build "$BUILD_ROOT/dist" \
  --output "$BUNDLE" \
  --verify-only
```

`--verify-only` hashes all source files, validates the full plan, prints the final file count, byte total, largest asset, limits, manifest digest, and planned report/checksum digests, and writes nothing. It does not merely trust filenames or sizes. There are no network requests or archive extraction. If verification succeeds and local staging is authorized, run the same command without `--verify-only`:

```sh
node scripts/stage-static-reference-data.mjs \
  --source "$REFERENCE_PACK_DIR" \
  --build "$BUILD_ROOT/dist" \
  --output "$BUNDLE"

cd "$BUNDLE/site"
sha256sum --check SHA256SUMS
```

Only `$BUNDLE/site` is the completed static tree. Preserve the command's successful exit status and audit output. A repeat run must use a new output path: existing output is always rejected, including an empty directory. No overwrite, cleanup, delete, force, token, network, or upload option exists.

### Safety and audit contract

- Pins are read from this script's checkout at `src/lib/pokemon-reference-release.ts` without executing that TypeScript. No command-line or environment pin override is supported.
- Manifest bytes and SHA-256 must match exactly before its data is trusted. Record/name counts, shard order, unique safe filenames, shard sizes/checksums and aggregate byte/record counts must match. Every shard is streamed and verified.
- Reference extras, subdirectories, symlinks and missing files fail closed. Symlinks in any source/build/output ancestor are rejected. The script requires `O_NOFOLLOW`, regular files, stable file identity/size/timestamps across reads, and exclusive destination creation. Use a trusted, non-concurrently-mutating workspace; do not run from an adversarial shared directory.
- Build inputs use an explicit allowlist for the Vite entry/worker assets, favicon, empty legacy packs manifest, OCR/model files, and their required notices. Raw art, source maps, `.env`, server caches, extra JSON, source archives and unreviewed hosting configuration are rejected. The script does not scan JavaScript semantically for secrets; the reviewed build remains a prerequisite.
- Per-file hashing/copying uses a 64 KiB buffer and sequential I/O. Only bounded manifest/entry documents and small generated audit documents are retained. Each copied file is rehashed while writing and its destination is independently read back before success.
- The output must be outside the checkout and disjoint from the source and build. Its existing parent must be a real directory. The script reserves a fresh private output directory and copies into `.staging`; only after all checks pass is that directory renamed to `site`. If a copy fails or the process is interrupted, there is no completed `site` directory. An incomplete directory is left for deliberate inspection/removal; the script never recursively deletes anything.
- `deployment-report.json` records hashes/sizes for all payload files. `SHA256SUMS` covers those files plus the report. The checksum file cannot include its own digest; its digest is printed by the command. The printed file count and size include generated `_headers` and both audit files. `_headers` is also hashed in the report and checksum file, even though Cloudflare consumes it as configuration rather than a served asset. Audit files contain no absolute private source paths.
- `providers.md`, `REFERENCE_DATA_NOTICE.md`, `licenses/`, `ocr/` notices and `vision-models/` notices are included. The built MIT/third-party notices must match the checkout. Numeric descriptors and public catalog metadata are included; raw artwork is not. Metadata retains provider URLs. App licensing does not grant rights to provider data, artwork, trademarks, or game intellectual property; review [provider policies](providers.md) before redistribution.

## Host size limits and reviewed plan

As checked 2026-10-13, [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/) specify 25 MiB per asset. [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) documents 1,000 files for dashboard drag-and-drop and 20,000 for Wrangler. [Workers static asset limits](https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/) retain 25 MiB per asset and 20,000 files on the free plan. The script conservatively enforces **25 MiB per file and 1,000 files for the complete bundle**, without choosing or configuring a route.

The earlier 2026-10-13 `/tcg-scan/` QA build, before generated host headers, had the following plan. It is historical, not the final root release inventory; regenerate the report after all source changes settle:

- 203 complete bundle files; 483,042,292 bytes total
- Largest asset: `assets/vision.worker-CXAXqhy1.js`, 15,552,550 bytes
- 155 reference files: 391,001,940 bytes total
- Manifest: 8,394,772 bytes; largest shard: 2,490,400 bytes
- Manifest SHA-256: `82efef2f91f2d2338c4634a0284912679f994c835b3eef5d3632bcb9c10f5d19`

Do not upload the 358 MB release ZIP as one asset: it exceeds the individual asset limit. The verified extracted files satisfy the per-asset constraint. This does not guarantee a particular account has permission, quota, or a working dashboard upload. Cloudflare project selection, authentication, public/private visibility, route handling, and upload remain separate checks. Production hosting configuration is reviewed in the central deploy repo; source artifacts supply no account IDs, routes or runtime credentials.

## Deterministic Workers response headers and routing

The packager generates the only allowed `_headers` file. It never accepts or merges one from the input build, including a symlink. Rules use the audited base path; the final root build must report `build.basePath` equal to `/`.

- The entry paths `/` and `/index.html` use `Cache-Control: no-cache`.
- Exact Vite hash-named asset paths and the pinned release's manifest/shard paths use `public, max-age=31536000, immutable`. Never replace different bytes at an existing immutable release path.
- Reference JSON uses `application/json; charset=utf-8`; shards use `application/octet-stream`; WASM uses `application/wasm`. Hash-named JS/CSS also receive their explicit media types.
- Stable-name OCR/vision WASM uses `no-cache`. Other stable-name models, notices and runtime files keep the host's normal revalidation policy, with no immutable rule.
- One scoped `X-Content-Type-Options: nosniff` rule is added. No CORS, cookies, CSP, COOP, COEP or content-encoding changes are introduced. Each MIME/cache rule has a single value, avoiding conflicting wildcard overrides.

[Workers header documentation](https://developers.cloudflare.com/workers/static-assets/headers/) describes `_headers` processing, MIME overrides and default browser revalidation. It caps the file at 100 rules and 2,000 characters per line; the packager enforces both. Header rules apply to static responses, not arbitrary Worker-generated responses. The folder uploader must consume this file correctly; validate actual deployed response headers rather than infer success from an accepted upload.

**Headers do not configure routing or turn a fallback response into a 404.** For this root-mounted app, retain strict missing-asset behavior: `assets.not_found_handling` must be `none`, with no SPA fallback or blanket redirect to `index.html`. The app's tab navigation stays at the root, so path-based SPA fallback is unnecessary. This setting is recorded as a deployment requirement in the audit, with `routingVerified: false`; the local packager does not change the account or pretend to verify a host setting. [Workers' configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) documents this setting and its `none` default. [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) is a separate mode that can return the entry HTML for unmatched requests; do not enable it for this release.

The authorized browser has confirmed the actual Workers static folder-upload route. The generic [dashboard guide](https://developers.cloudflare.com/workers/get-started/dashboard/) does not establish the final uploader's MIME or fallback behavior. If dashboard controls cannot demonstrate the intended setting, verify the published responses before calling the release usable. A 200 HTML body at a missing data/model/asset URL fails the release gate, even if a MIME override labels it binary. The pinned installer also checks content, size and hashes, but that is an additional safeguard, not permission to accept broken routing.

## Before calling a deployment usable

After authorization and route selection, publish only the completed `site` tree through the approved Cloudflare path. Preserve all included notices. Keep app code, reference files, WASM/model assets and the selected base path on the same origin; do not add an external reference URL or fetch proxy. Keep the generated `_headers` unchanged. Input `_headers`, redirects, Worker code and other hosting configuration remain rejected. Upload the contents of `site` as the root assets directory, without an extra `tcg-scan/` nesting level.

Verify in the actual HTTPS application URL, with a clean browser profile:

1. The app entry, CSS/JS, OCR and vision assets load at the chosen base path. Camera access requires HTTPS outside localhost; a plain HTTP LAN address is insufficient.
2. Before explicit installation, no reference-data download starts. Choosing **Install Pokémon database** requests the pinned manifest and all 154 shards from their exact same-origin paths. It does not call `/__tcg_scan/reference/pokemon`.
3. Verify the real entry, hashed JS/CSS, at least one WASM/model, the pinned manifest and a known shard return 200 with the expected content and MIME. Check entry `no-cache`, immutable hash/release responses, and revalidation for stable WASM. Verify a deliberately missing manifest path, `features-99999.bin` under the pinned release, a missing model, and a missing JS/WASM asset each return HTTP 404, both as a normal fetch and direct navigation. None may return entry HTML with 200. `_headers` itself should not be served as a public file. Check any compression keeps decoded bytes unchanged, then verify pinned bytes/hashes. Missing/corrupt assets must show actionable errors and never produce a ready database.
4. Cancel, retry, import progress, quota errors, complete ZIP fallback, reload after successful storage, and a second install action behave honestly. Confirm 19,665 references and 4,416 identities/names after the verified import, without claiming exact printing or finish.
5. Confirm real-device camera and local scanning separately. Browser storage belongs to that origin and device; it does not migrate from localhost or another dev URL. Do not promise service-worker offline startup or complete offline catalog/pricing access.

Record the final URL, chosen base path, build/report/checksum identifiers and which checks actually ran. A successful local packager test does not stand in for deployed-browser or physical-card QA.
