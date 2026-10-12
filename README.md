# tcg scan

**A home for every card.** An independent, open-source, local-first trading-card scanner and collection manager for Pokémon, Magic: The Gathering, and Yu-Gi-Oh!.

Original implementation inspired by the publicly visible workflow of [Quickdraw](https://www.quickdraw.cards/). This project does not reuse Quickdraw code, branding, artwork, or recognition models and is not affiliated with it.

## What works

- **Camera and photo capture:** frame a card, capture it, and read its printed name with on-device Tesseract OCR. Upload JPG, PNG, or WebP images instead, inspect recognized text, and choose an alternate name when needed.
- **Real catalog lookup:** free, no-key adapters for Scryfall, TCGdex, and YGOPRODeck with cancellation, timeouts, request throttling, response validation, and a bounded catalog cache (24 hours; 48 hours for Yu-Gi-Oh!).
- **Review before saving:** confirm the card, printing, quantity, condition and finish. OCR never silently adds a card to your collection.
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

`npm ci` copies the installed OCR worker, WebAssembly files, and their license notices into `public/ocr/`. The first OCR scan downloads the English language model from `tessdata.projectnaptha.com`. This is a model download, not an upload of your photo.

### Production build / self-hosting

```sh
npm run build
npm run preview
```

Serve the generated `dist/` directory with any static host. Include the `ocr/` and `licenses/` directories and their license notices. Use **HTTPS** on real devices; browsers permit camera access on localhost for development. A plain HTTP LAN address usually cannot use the camera. Internet access is required for uncached catalog searches and the first OCR model download. This release does not include a service worker or promise offline startup.

For hosting under a subdirectory, run `npm run build -- --base=/tcg-scan/`. Vite’s base URL is used for the OCR assets. See [self-hosting](docs/self-hosting.md) for recommended headers.

## Everyday use

1. Select the card game.
2. Start the camera and capture one card, upload a clear photo, or search by name / provider card ID.
3. Choose a catalog candidate, then open **Review**. Verify the set and card number against the physical card.
4. Set quantity, condition and finish; confirm to add it.
5. Export a JSON backup from **Collection** regularly. CSV is a spreadsheet export, not an import format.
6. Use **Deck checker** to compare a list such as `4 Lightning Bolt` against your collection.

Deleting an entry requires confirmation. Backups are imported with a preview and merge confirmation. Opening the app in another tab is supported read-only: if another tab changes the collection, saving pauses until you export/reload, so a stale tab cannot overwrite newer work.

## Privacy and data

Photos, camera frames and recorded clips remain on the device. OCR runs in a browser worker. Catalog lookups send the selected game and searched/extracted card name or ID to that provider; providers also see normal network metadata. Card images are fetched from approved provider image hosts. No analytics, cookies, tracking scripts, or remote collection account are included.

The collection is stored in `localStorage` on the current origin. Browser clearing, private-browsing expiry, switching devices or changing the site address can lose or hide it. Export JSON before doing any of those. Storage quotas vary; failures are shown explicitly and you can export your in-memory work. Import limits: 10 MB JSON, 10,000 collection entries, 1,000 review items and 500 decks. A card entry may hold up to 9,999 copies.

## Honest limits

- Recognition is **English text OCR**, not a trained visual card-art matcher. It is capture-based, not continuous real-time identification. Glare, angled cards, sleeves, tiny print and stylized type can produce incorrect suggestions. Manual search is always available.
- OCR identifies a likely name. Exact printing, set, finish, condition, authenticity and grading require your review. It does not estimate physical condition.
- TCGdex search returns compact summaries; opening a candidate fetches its detailed data and any available prices. Many cards have no price.
- YGOPRODeck entries are at card/passcode level and can cover multiple printings. Their prices may be the lowest across versions. Yu-Gi-Oh! artwork is intentionally omitted to respect the provider’s no-hotlink policy.
- Prices are provider reference snapshots, **not appraisals, guaranteed sale prices, or live market ticks**. Condition, selected finish, grading and fees do not adjust them. The app labels source and source-update or retrieval time.
- Pack clips are local downloads only; no editing, automatic card overlays, social publishing, video-file recognition, cloud synchronization, authentication or marketplace integration is implemented.
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
```

The unit suite exercises provider schemas, throttling, cancellation, timeouts, real-vs-missing price semantics, OCR-name extraction, collection merging, deck quantities, CSV safety and backup validation. Browser tests use clearly identified synthetic fixtures rather than claiming live provider data; live-provider integration requires internet availability. The opt-in browser OCR smoke uses a generated image and real local worker plus English model download; Mac CI enables it. Physical camera hardware and optical recognition across real cards still need device testing. CI runs the aggregate checks and browser suite and retains the test report/screenshots. It targets the owner’s self-hosted macOS ARM64 runner and runs only for `dafepro` pushes/manual dispatches on this repository’s `main` branch. Public pull requests never execute on that personal runner; contributors can run the same checks locally. A missing/offline runner leaves jobs queued.

Stack: React, TypeScript, Vite, Tesseract.js, Lucide, Vitest and Playwright. Browser-only architecture; no backend needed. See [provider behavior and terms](docs/providers.md), [architecture](docs/architecture.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md).

## License and attribution

Original application code is [MIT licensed](LICENSE). Bundled third-party libraries retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Tesseract runtime distributions carry Apache-2.0 notices in the built `ocr/` directory.

Card names, game names, rules text, artwork and trademarks belong to their respective rights holders. The code license does **not** license third-party card content. Pokémon, Magic: The Gathering and Yu-Gi-Oh! are referenced only to describe compatibility. This project is not affiliated with or endorsed by The Pokémon Company, Nintendo, Creatures, Game Freak, Wizards of the Coast, Konami, Quickdraw, or the catalog providers. No card art is bundled in this repository.
