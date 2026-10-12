# Architecture

## Data flow

1. `Scanner` requests a camera only after a user action or accepts a local image file.
2. `recognition.ts` prepares an image and runs a local Tesseract worker. Only text candidates are handed to the app.
3. `catalog.ts` calls the chosen public API and normalizes its response into the `Card` contract. Search results and full detail are cached with bounds and expiry.
4. Selecting a result fetches full detail and adds it to a review queue. Explicit confirmation creates or increments a collection entry keyed by provider identity, condition and finish.
5. `storage.ts` validates versioned app data before persistence/import. A changed storage snapshot or storage event from another tab pauses writes to avoid stale overwrite.
6. JSON exports preserve collections, pending review and named decks. CSV is an intentionally separate spreadsheet-only output with formula-injection guards.

## Modules

- `src/types.ts`: shared domain contracts.
- `src/lib/catalog.ts`: provider adapters, errors, cache, throttling, safe URL checks.
- `src/lib/recognition.ts`: OCR lifecycle, preprocessing, candidate extraction, file validation.
- `src/lib/collection.ts`: quantity merging, pricing summaries, deck matching and exports.
- `src/lib/storage.ts`: schema validation, import merge and local persistence.
- `src/components/Scanner.tsx`: media lifecycle, preview, capture, cancellation and recording.
- `src/App.tsx`: workflow, views, dialogs and state integration.

## Tradeoffs

Local storage keeps setup simple and collections private, but it is not cross-device synchronization and has browser-specific quotas. Large scale collections would benefit from IndexedDB and migrations. Search-based OCR is intentionally reviewable rather than claiming artwork recognition. Data adapters are isolated so other catalogs can be added without rewriting collection storage.

Catalog data is untrusted. Runtime validation accepts only known provider HTTPS image/link hosts. Imported backups are validated from unknown JSON and reconstructed field by field. No imported object is assigned into application prototypes or executed as HTML. CSV text is quoted and dangerous spreadsheet prefixes are neutralized.

The reference workflow was inspected as public product behavior. All application markup, styling, domain logic, recognition heuristics and assets in this repository were authored independently.
