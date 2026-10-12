# Offline visual reference packs

The visual engine matches locally loaded card features. Searching a provider or recognizing a name does **not** install that provider's full image catalog. The app must display actual loaded counts and pack scope; no installed pack means zero offline references. Collection JSON backups and OCR-search caches are separate from reference storage.

## What ships

`public/packs/manifest.json` is intentionally empty. No commercial artwork, provider image cache, or commercial-card feature pack is committed. The source includes the reproducible builder and import/install/storage path. Provider image rights and permission to redistribute derived indexes must be reviewed separately before publishing such a pack. A permissive metadata-repository license is not proof that separately hosted art or all image derivatives are freely redistributable.

Locally generated packs contain metadata, 64-bit perceptual/difference hashes, keypoint coordinates and ORB descriptors, never original image pixels. This is a genuine local visual reference index, not a name/OCR search cache.

## Build a selected pack

Node 22+ is recommended. Install the repository's locked dependencies first (`npm ci`). OpenCV, sharp and tsx are pinned by the lockfile; the command runs the same TypeScript preprocessing module as the browser engine.

```sh
node --import tsx scripts/build-index.mjs \
  --game pokemon --sets base1,basep \
  --out /tmp/pokemon-validation
```

The initial real-image validation on 12 October 2026 produced 155 references from Base Set and Wizards Black Star Promos, with zero missing or failed images. Feature JSON was 1,015,772 bytes (about 6.55 KB/reference); engine loading in the development container took 46 ms. This measures build/load behavior, not phone-camera speed or real-card recognition accuracy.

Use a durable **private** cache directory for a long build:

```sh
node --import tsx scripts/build-index.mjs \
  --game pokemon --all \
  --cache /path/to/private-reference-cache \
  --out /path/to/private-feature-packs
```

`--all` is deliberately explicit. Default concurrency is two, with at least 350 ms between request starts globally, retry backoff for HTTP 429/5xx, a 60-second request timeout and a fixed HTTPS host allowlist. `--concurrency 1..4` and `--delay-ms 200..60000` can lower load or accommodate provider guidance. Redirects, credentials in URLs, unexpected hosts, oversized responses and non-image response types are rejected. The builder never needs API keys or paid services.

At the validation snapshot, TCGdex returned 23,736 English records. Excluding the 2,480 records in sets returned by `/series/tcgp` left 21,256 physical-card records, of which 19,666 had image URLs and 1,590 had none. These are provider snapshot counts, not a promise to cover every released printing, language, foil, or regional variant. The complete download takes roughly two hours at the conservative default rate; network latency and retries can extend this. Actual progress is printed every 25 processed references.

### Resume, cancellation and reproducibility

- Ctrl-C or SIGTERM cancels safely. Repeat the same command to reuse successful downloads and extraction checkpoints; failed references are retried.
- Images and metadata live in a content-addressed private cache, with SHA-256-verified URL pointers. Each distinct URL is downloaded once unless its local cache is missing/corrupt; different URLs with identical bytes share one object. YGOPRODeck images are never hotlinked in the browser.
- The default cache is the OS temporary directory's `tcg-scan-reference-cache`; it is outside the repo. For long-lived recovery, choose a durable private directory. Do not commit that cache.
- Provider catalog snapshots are reused. `--refresh-catalog` refreshes metadata, retaining image content already downloaded. `--offline` prohibits all fetches and reports cache misses.
- Feature checkpoints are keyed by provider identity, image content hash, algorithm version and descriptor budget. The v1 extractor uses canonical 240 × 336 RGBA-to-grayscale preprocessing, OpenCV `INTER_AREA` resize, pHash/dHash and ORB with up to 96 spatially balanced features. Live queries can use more features. Any preprocessing change requires a new algorithm/checkpoint version.
- Output serialization and card ordering are stable for a frozen catalog, fixed source images and locked dependencies. Catalog snapshot time is preserved in output; synthetic fixture time comes from manifest mtime. Different source snapshots intentionally change checksums.
- Output files and manifests are written via same-directory temporary files plus atomic rename. SHA-256 sidecars are supplied for every shard; `manifest.json` is installed last. Old content-addressed shards are left alone, so a failed build cannot replace a good manifest with a half-written pack.
- A successful build exits 0. Partial extraction writes an honestly labelled report/manifest and exits 2; cancellation exits 130. `build-report.json` lists failed keys and failure reasons. Missing provider images are counted separately from failures.

The default shard size is 500 references. Each browser-imported file is capped at 5,000 references and 64 MiB; `--shard-size 1..1000` keeps builder outputs well below these limits. Whole-game coverage consists of multiple installed shards, not one oversize JSON upload. The live engine has its own combined capacity of 60,000 references and 256 MiB of descriptors.

## Provider scope and limitations

### Pokémon / TCGdex

- `--sets base1,basep` enumerates those set endpoints; `--all` enumerates `/v2/en/cards` and `/v2/en/sets`.
- Both modes read `/v2/en/series/tcgp`. Pocket set IDs are excluded rather than guessed from ID prefixes. Explicit selection of a Pocket set is rejected.
- The builder uses each provider image's `/low.webp` (typically 245 × 337), then the engine's canonical 240 × 336 preprocessing. If the provider returns 404 for the low asset, it tries that exact card's documented `/high.webp` once, remembers a successful alternative in the private cache, and records the actual image URL in the pack. It never substitutes another card. Failure of both qualities remains an explicit failed reference. No per-card metadata fetch is required.
- Keys are `pokemon:<tcgdex-id>`; `identityKey` is the normalized name so likely same-name printings remain related. Source links point to the card's TCGdex API record.
- The source may lack images, printings, language variants or reliable shared-art identifiers. Visually indistinguishable editions/finishes need user review. Descriptor matching is not proof of authenticity or condition.

Provider documentation: [TCGdex API](https://tcgdex.dev/rest), [image assets](https://tcgdex.dev/assets), [metadata repository license](https://github.com/tcgdex/cards-database).

### Magic / Scryfall

```sh
node --import tsx scripts/build-index.mjs --game mtg --sets lea,leb --out /path/to/private-mtg-packs
node --import tsx scripts/build-index.mjs --game mtg --all --out /path/to/private-mtg-packs
```

The enumerator downloads the `default_cards` bulk snapshot, supports current `jsonl_download_uri` and legacy `download_uri`, streams gzip JSONL/legacy line-delimited JSON objects, and filters to English paper cards. Multi-faced cards contribute each available face image. Keys are `mtg:<UUID>` or `mtg:<UUID>:face<N>`; `identityKey` uses `oracle_id`, and `artworkKey` uses `illustration_id` when supplied. This preserves artwork-to-printing ambiguity rather than pretending one art identifies one printing.

`--all` builds an identity/artwork index: image-bearing faces are deduplicated by explicit `illustration_id` **plus** `oracle_id`. Different card identities that share an illustration remain separate candidates, preserving ambiguity. Rows without explicit illustration IDs stay distinct. Each group picks a deterministic representative printing; its set/number/source metadata are only a lookup representative and must never be presented as a confirmed printing. Selected `--sets` builds continue to retain their selected printing references without this deduplication. `coverage.duplicateImages` records omitted duplicate printing/face rows separately from missing images.

The 12 October 2026 bulk snapshot yielded 106,852 English paper card records, 57,851 distinct identity/artwork references after excluding 52,782 duplicate image-bearing printing/face rows, and 162 card records without usable images. This fits the current 60,000-reference engine cap for **one active game**. The builder rejects a future deduplicated MTG snapshot exceeding that cap rather than silently claiming installability. Full Pokémon and MTG indexes together exceed the combined cap; load the selected game's references. Shared-art matching across frame treatments still needs accuracy testing, and finish/language/exact-printing resolution remains unconfirmed.

The MTG pipeline was validated against the current gzip JSONL bulk snapshot, two real LEA images (295 LEA records enumerated, 2/2 extracted and loaded), and a two-image sample of the deduplicated whole-game catalog. A complete MTG image build and recognition evaluation have not been run in this change.

Provider documentation: [bulk data](https://scryfall.com/docs/api/bulk-data), [data and image use](https://scryfall.com/docs/api#use-of-scryfall-data-and-images).

### Yu-Gi-Oh! / YGOPRODeck

```sh
node --import tsx scripts/build-index.mjs --game yugioh --all --out /path/to/private-ygo-packs
```

The enumerator uses `cardinfo.php?format=tcg`, traverses each card's `card_images`, and downloads each image once to the private cache. Keys are `yugioh:<card-id>:art<image-id>` with separate card identity and art identity. No remote `imageUrl` is emitted in YGO packs, preventing the app from repeatedly hotlinking provider images.

This is English TCG card/artwork coverage, not every set printing, Rush Duel, Speed Duel-only release, language or finish. Provider art IDs do not map uniquely to set printings. Set-specific image building is deliberately rejected; unresolved printings need review. The YGO enumerator was validated against 14,049 TCG card records / 14,218 artwork references, with two real images downloaded, extracted and loaded successfully. A complete YGO image build and recognition evaluation have not been run in this change.

[YGOPRODeck's API guide](https://ygoprodeck.com/api-guide/) requires locally storing downloaded data/images and prohibits continual image hotlinking. It documents a 20-request/second API limit; this builder's default is much lower. Its image-use rules still need a separate redistribution review before hosting derived packs.

## Synthetic mechanics fixture pack

A simple local manifest is accepted:

```json
{
  "name": "Synthetic cards",
  "cards": [
    {
      "key": "pokemon:synthetic-1",
      "game": "pokemon",
      "name": "Synthetic One",
      "imagePath": "references/synthetic-1.png",
      "identityKey": "fixture:one",
      "artworkKey": "fixture:one"
    }
  ]
}
```

Run:

```sh
node --import tsx scripts/build-index.mjs \
  --fixture /path/to/manifest.json --out /tmp/fixture-packs
```

The QA fixture generator's `reference_index: [{id,image,printing_group}]` format is also accepted. Paths are local, resolved against the manifest directory; fixture URLs are rejected. Synthetic tests can verify geometry, temporal state and ambiguity mechanics. They cannot establish real-card accuracy, confidence calibration or real camera performance.

## Browser persistence API

`src/lib/reference-packs.ts` uses a dedicated IndexedDB database (`tcg-scan-visual-references`, version 1):

- `validateFeaturePack(value)`: strict schema, version/preprocessing, counts, keys, hash, point bounds, base64/descriptor alignment and known HTTPS provider links. Unknown fields and arbitrary URLs are rejected.
- `importReferencePack(blob)` / `saveReferencePack(pack, origin)`: validate before writing, compute a content checksum and deduplicate by SHA-256.
- `listReferencePacks()` / `loadReferencePack(id)` / `removeReferencePack(id)`: show source, scope, count, per-game count, size and readiness; loading verifies the stored checksum and reports corruption.
- `cacheReferenceImage(metadata, blob, features?)`: persist a learned PNG/JPEG/WebP image Blob (maximum 12 MiB), metadata and optionally already-extracted features. It does not fetch anything.
- `listCachedReferenceImages()` / `removeCachedReference(key)` / `clearCachedReferences()`: restore learned references without depending on app localStorage. Corrupt cached references are surfaced rather than silently used.
- `getReferenceStorageStatus()`: report IndexedDB availability, estimated usage/quota, persistence and low-space pressure. `ReferenceStorageError` distinguishes invalid input, corruption, unavailable storage and quota exhaustion.
- `loadPrebuiltPackManifest(signal?)` / `installPrebuiltPack(entry, signal?)`: load same-origin `/packs/manifest.json`; stream a size-bounded shard, verify SHA-256 and counts, then store it. Downloads reject redirects and paths outside `/packs/<filename>.json`.

Checksums detect corruption; they do not authenticate the pack author or prove its card metadata/recognition accuracy. Import packs only from builders you trust.

Learned/reference storage survives ordinary app-data changes, but browsers can evict best-effort storage and users can clear site data. Quota or corruption must be shown in the UI; never claim a reference is saved after a failed transaction. The helper does not request persistent storage permission automatically or silently evict user references.

To serve a pack after rights review, copy only its feature JSON shards and matching manifest into `public/packs/`. Do not copy cache objects, raw artwork or build intermediates. Each manifest entry contains a same-origin path, byte count, SHA-256 checksum, reference count and accurate coverage metadata. A full catalog with missing source images still has that limitation after every available shard is installed.

## Verification

Run the dedicated schema/security/storage tests plus the repository checks:

```sh
npx vitest run src/lib/reference-packs.test.ts
npx eslint src/lib/reference-packs.ts src/lib/reference-packs.test.ts scripts/build-index.mjs
npm run check
```

Tests cover incompatible preprocessing, malformed descriptors, mismatched/duplicate keys, unsafe provider URLs, oversized files/streams, checksum corruption, independent Blob/pack persistence, quota failure, missing IndexedDB, same-origin manifest restrictions and an honest empty prebuilt catalog. Keep full-game build counts and actual matching benchmarks separate: a successfully loaded index is necessary, but not sufficient, evidence of recognition quality.
