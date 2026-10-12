# tcg scan

**A home for every card.** An independent, open-source, local-first trading-card scanner and collection manager for Pokémon, Magic: The Gathering, and Yu-Gi-Oh!.

Original implementation inspired by the publicly visible workflow of [Quickdraw](https://www.quickdraw.cards/). This project does not reuse Quickdraw code, branding, artwork, or recognition models and is not affiliated with it.

**Recognition is experimental.** The continuous workflow is implemented, but reliable everyday physical-card recognition has not yet been established. Learned physical-photo validation currently covers a Pokémon subset; Magic and Yu-Gi-Oh! catalog/collection support does not imply equivalent tested visual coverage. Real-photo probes exposed detection and matching misses that synthetic tests did not. No full-game reference pack is bundled. See the [learned validation and release gates](docs/learned-validation.md) and [historical physical-photo evaluation](docs/physical-photo-evaluation.md) before relying on automatic counts.

## What works

- **Continuous local visual scanning:** persistent camera preview, automatic multi-card corner proposals, perspective correction, a local hash shortlist and XFeat learned-feature/RANSAC verification in a persistent worker. The ORB compatibility engine remains available for older packs. Quick mode requires a strong identity match followed by independently captured current-card continuity before saving. Strict mode requires three identity matches plus the same current-view check.
- **Offline reference packs:** import integrity-checked metadata plus binary learned-feature shards into IndexedDB. Only the small whole-index metadata stays resident; eight candidate descriptor blocks are loaded lazily. Older ORB JSON packs are also supported. See [learned packs](docs/learned-reference-packs.md). A resumable offline builder supports whole-game Pokémon, Magic and Yu-Gi-Oh! catalog enumeration. **No full-game reference pack is bundled**; recognition coverage is exactly the installed references. See [reference packs](docs/reference-packs.md).
- **Stream and binder modes:** independent per-card overlays, pause/resume, counted-track suppression, explicit new-page reset, multi-card photo analysis and exact session undo.
- **Assisted photo/text fallback:** Tesseract OCR, JPG/PNG/WebP uploads, editable names and manual catalog lookup for uncovered cards.
- **Real catalog lookup:** free, no-key adapters for Scryfall, TCGdex, and YGOPRODeck with cancellation, timeouts, request throttling, response validation, and a bounded catalog cache (24 hours; 48 hours for Yu-Gi-Oh!).
- **Experimental automatic printing-field reader:** after an identity is saved, a separate local reader attempts literal collector-number/set fields from two distinct high-detail frames against a complete, explicitly scoped provider candidate list. The real reader and cancellation pipeline work, but the tested physical photo’s tiny footer remained unreadable; reliable automatic printing resolution is not established. Small binder slots, unreadable text and ambiguous reprints stay unresolved. No frame is uploaded.
- **Honest identity handling:** automatic visual entries have unconfirmed physical edition, condition and finish. Read catalog identifiers are stored separately from the visual reference and never upgrade valuation. They are excluded from collection price totals. Assisted OCR still requires explicit confirmation.
- **Automatic cached market quotes:** prices refresh separately from capture, with source, variant, scope and timestamps. Missing or stale values are explicit; a generic catalog low is never an exact physical-card valuation.
- **Collection:** per-printing entries, quantities, game/name/set filters, sorting, grid/list layouts and provider-supplied reference prices. USD and EUR remain separate; missing prices stay missing.
- **Portable data:** full JSON backup/import for collection, review queue and decks; CSV export for spreadsheets. Imports merge by stable entry ID and preserve existing entries.
- **Deck checking:** paste a decklist, compare owned quantities across printings, save named decks, and download a missing-card list. Ownership check only, not format legality.
- **Pack clips:** record a local camera clip and download it, where MediaRecorder is supported. No server upload or microphone capture.
- **Responsive interface:** desktop and mobile layouts, native accessible dialogs, reduced-motion support, explicit error states and browser-storage warnings.

## Quick start

Requires Node.js 22.12+ or Node.js 24 LTS and npm.

```sh
git clone https://github.com/dafepro/tcg-scan.git
cd tcg-scan
npm ci
npm run dev
```

Open the local URL printed by Vite. There are **no API keys, environment secrets, backend, database, signup, or paid services** to configure.

`npm ci` copies the installed OCR worker, WebAssembly files, a SHA-256-verified English language model, and license notices into `public/ocr/`. The model is pinned through `@tesseract.js-data/eng@1.0.0` and served by the app itself (10.9 MB compressed). OCR needs no external model CDN, and photos are never uploaded.

The same install step stages pinned XFeat and Fastweb ONNX model data from their exact publisher revisions and the official ONNX Runtime Web WASM package (about 20.2 MB combined). Every asset is size/SHA-256 checked at build time and again before inference. Subsequent browser model loading is same-origin. For a fully offline build, set `TCG_VISION_MODEL_DIR` to the three previously downloaded pinned model files; integrity checks still apply. See [model provenance](licenses/learned-models-NOTICE.md).

### Production build / self-hosting

```sh
npm run build
npm run preview
```

Serve the generated `dist/` directory with any static host. Include the `ocr/`, `vision-models/` and `licenses/` directories and their license notices. Use **HTTPS** on real devices; browsers permit camera access on localhost for development. A plain HTTP LAN address usually cannot use the camera. Internet access is required for uncached catalog searches. OCR runtime and model assets load from your own host. This release does not include a service worker or promise offline startup.

Continuous capture prefers a current browser with `VideoFrame.copyTo` RGBA and `requestVideoFrameCallback` support. It requests bounded camera resolution and checks the actual dimensions. Older implementations use a visibly labeled, reduced-resolution one-frame-per-second fallback with a hard source-plus-readback budget, then stop; photo/text capture remains available. Six-minute strict and Quick cloud-camera replays passed with correct durable counts and no crash or OOM increase. Phone hardware and whole-index behavior remain separate validation gates.

For hosting under a subdirectory, run `npm run build -- --base=/tcg-scan/`. Vite’s base URL is used for OCR, learned-model and runtime assets. See [self-hosting](docs/self-hosting.md) for recommended headers.

## Everyday use

1. Select the game and use **Install learned reference pack** in the setup panel. Select the manifest and every binary shard together. Camera and multi-card photo controls stay disabled until that game has ready references. **Manage offline packs** lets you inspect or remove installed coverage. The repository includes a resumable builder; no third-party artwork or full catalog descriptors are bundled.
2. Choose **One card after another** or **Binder / tabletop**, then **Start continuous camera**. Frames and matching stay on the device. Per-card overlays show local matching, stability, saved, ambiguous or quality states.
3. Choose **Quick** for one strong identity match plus a fresh current-card continuity check, or **Strict** for three identity matches plus that check. Keep the entire card comfortably inside the preview, including a little space beyond all four corners. Different identities save automatically. An identical identity stays counted across gaps, blur and re-entry; after replacing it with another physical copy, tap **Next copy** to rearm only that visible identity. Other saved identities remain counted. Automatic identical-copy exit/re-entry is not verified. Undo accidental counts.
4. In binder mode, keep one page/layout stable; use **New page** when changing it. Separate simultaneous copies have independent tracks. Panning across a large layout or crossing cards can still confuse spatial association, so inspect counts.
5. Automatic entries keep printing, condition and finish unconfirmed. Async market quotes persist with those entries in Collection as labeled comparison choices, excluded from valuation totals. Assisted lookup/review can create a separately confirmed entry for an uncovered card; it does not edit or verify an existing automatic entry. Avoid adding the same physical copy twice.
6. Export JSON regularly. Use **Deck checker** to compare a decklist with owned identities.

Deleting an entry requires confirmation. Backups are imported with a preview and merge confirmation. Opening the app in another tab is supported read-only: if another tab changes the collection, saving pauses until you export/reload, so a stale tab cannot overwrite newer work.

## Privacy and data

Photos, camera frames and recorded clips remain on the device. OpenCV, ONNX Runtime Web learned matching and OCR run locally in browser workers. The WASM-only ONNX Runtime build excludes telemetry; model assets and reference descriptors are never sent to an inference service. Imported descriptor packs remain in IndexedDB. Automatic market-quote requests send the recognized catalog ID to its provider; no frame is sent. Catalog and optional printing-candidate lookups send the selected game and searched/extracted card name or ID to that provider; providers also see normal network metadata. Card images are fetched from approved provider image hosts. No analytics, cookies, tracking scripts, or remote collection account are included.

The collection is stored in `localStorage` on the current origin. Browser clearing, private-browsing expiry, switching devices or changing the site address can lose or hide it. Export JSON before doing any of those. Storage quotas vary; failures are shown explicitly and you can export your in-memory work. Import limits: 10 MB JSON, 10,000 collection entries, 1,000 review items and 500 decks. A card entry may hold up to 9,999 copies.

## Honest limits

- Learned recognition uses pinned XFeat descriptors and Fastweb corner proposals, with conservative geometric verification; the older ORB engine is retained for compatibility. It only recognizes installed references. A source-only install initially has zero visual coverage. Whole-game indexing is an explicit build/download step.
- Synthetic geometry tests establish pipeline mechanics, not physical-camera accuracy. Glare, sleeves, partial/overlapping cards, low resolution and similar reprints can block or confuse matching. A reference-image match does not establish authenticity, physical condition or exact edition.
- A four-photo physical-scene probe produced no automatic identity matches in the baseline engine. The sample includes distant, oblique and overlapping cards and does not measure ordinary close-up scan accuracy. Experimental detector/retrieval improvements are not included merely because they recover one development example. See [physical-photo findings](docs/physical-photo-evaluation.md).
- Timings in the UI are measured local frame processing, excluding model/pack startup, temporal stability, disk save and network prices. No universal millisecond or phone accuracy guarantee is made. See [benchmark methodology](docs/vision-benchmarks.md).
- OCR supports assisted English-name lookup and automatic literal printing-field refinement. The latter needs two genuinely different camera captures with a native card edge of at least 480 pixels; enlarging a small crop cannot satisfy this. Catalog completeness is scoped to the provider and language. Edition/rarity ambiguity, finish, condition, authenticity and grading are not inferred.
- TCGdex search returns compact summaries; opening a candidate fetches its detailed data and any available prices. Many cards have no price.
- YGOPRODeck entries are at card/passcode level and can cover multiple printings. Their prices may be the lowest across versions. Yu-Gi-Oh! artwork is intentionally omitted to respect the provider’s no-hotlink policy.
- Prices are provider reference snapshots, **not appraisals, guaranteed sale prices, or live market ticks**. Condition, selected finish, grading and fees do not adjust them. The app labels source and source-update or retrieval time.
- Pack clips are local downloads only; no editing, social publishing, arbitrary video-file recognition, cloud synchronization, authentication or marketplace integration is implemented. Live camera overlays are available in the continuous scanner.
- This is an independent functional alternative, not a claim of feature parity with Quickdraw.

## Development and checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
# All four:
npm run check

# Browser tests (install once):
npx playwright install --with-deps chromium
npm run test:e2e
# Optional real browser OCR integration on a generated test image:
RUN_LIVE_OCR=1 npm run test:e2e -- tests/scanner.spec.ts --project=desktop-chromium
# Optional genuine OpenCV worker integration with an original synthetic video:
RUN_LIVE_VISION=1 npm run test:e2e -- tests/continuous.spec.ts --project=desktop-chromium
```

The unit suite exercises provider schemas, throttling, cancellation, timeouts, real-vs-missing price semantics, OCR-name extraction, collection merging, deck quantities, CSV safety and backup validation. Browser tests use clearly identified synthetic fixtures rather than claiming live provider data; live-provider integration requires internet availability. The opt-in browser OCR smoke uses a generated image and real local worker plus the packaged English model; Mac CI enables it along with the genuine OpenCV replay. Physical camera hardware and optical recognition across real cards still need device testing. CI runs the aggregate checks and browser suite and retains the test report/screenshots. It targets the owner’s self-hosted macOS ARM64 runner and runs only for `dafepro` pushes/manual dispatches on this repository’s `main` branch. Public pull requests never execute on that personal runner; contributors can run the same checks locally. A missing/offline runner leaves jobs queued.

Stack: React, TypeScript, Vite, OpenCV.js, ONNX Runtime Web, Tesseract.js, Lucide, Vitest and Playwright. Browser-only architecture; no backend needed. See [provider behavior and terms](docs/providers.md), [architecture](docs/architecture.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md).

## License and attribution

Original application code is [MIT licensed](LICENSE). Bundled third-party libraries retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Tesseract runtime distributions carry Apache-2.0 notices in the built `ocr/` directory.

Card names, game names, rules text, artwork and trademarks belong to their respective rights holders. The code license does **not** license third-party card content. Pokémon, Magic: The Gathering and Yu-Gi-Oh! are referenced only to describe compatibility. This project is not affiliated with or endorsed by The Pokémon Company, Nintendo, Creatures, Game Freak, Wizards of the Coast, Konami, Quickdraw, or the catalog providers. No card art is bundled in this repository.
