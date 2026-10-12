# Local learned reference packs

The learned matcher uses a compact metadata/hash index and reads only shortlisted feature records from IndexedDB. It never loads a JSON gallery of descriptor arrays at startup. Importing a pack does not fetch provider URLs or upload anything. The format contains numerical descriptors and card metadata, never raw artwork.

This is a separate storage path from legacy `orb-phash-v1` packs. Old ORB imports are not silently converted or used as XFeat references.

## Current scope and limits

- The first reproducible converter covers the frozen, independently selected **2,000-reference Pokémon subset**, containing **804 distinct name identities**. It is explicitly partial coverage.
- Names can occur in multiple printings. Recognition does **not** confirm exact printing, language variants with identical artwork, finish, or condition.
- A versioned pack identifies one game and has at most 60,000 references. Each shard contains at most 128 records, or **2,490,400 bytes** including its header. The metadata-only UTF-8 manifest is capped at 64 MiB before reading.
- Ready and importing packs reserve capacity per game, up to 60,000 references in total for that game. Separate games have independent reservations. An over-capacity import is rejected before its binary records are staged.
- Local storage is origin-specific. Browser eviction, clearing site data, private-browsing policies, quota limits, and changing the app origin can remove or hide an installed pack. The included Pokémon database can be reinstalled with its button; keep source ZIPs for custom packs.
- Frozen conversion never rebuilds a catalog. A separate explicit-input offline extraction mode is implemented, with reproducible small-fixture tests and resumable content-verified caching. A full English paper-Pokémon extraction has completed with 19,665 references; expanded-gallery browser checks are recorded separately in [learned validation](learned-validation.md). No phone-performance result is claimed here. Full-catalog input requires an additional explicit flag after performance review. Neither mode publishes anything.
- A checksum establishes byte integrity, not copyright permission, authenticity, or correctness of the supplied metadata. Packs are local user-provided data, not signed provider distributions. The prepared Pokémon snapshot is distributed separately with its own provider/provenance notices after explicit repository-owner approval. This is not a blanket license to redistribute artwork or arbitrary derived packs. Do not commit raw artwork, private evaluation photographs or build caches.

## Completed English Pokémon extraction

On 2026-10-12, the explicit-input builder completed the available-image English paper-card snapshot: **19,665 references, 4,416 name identities, 154 binary shards**, and **391,001,940 bytes** including the 8,394,772-byte manifest. The manifest SHA-256 is `82efef2f91f2d2338c4634a0284912679f994c835b3eef5d3632bcb9c10f5d19`. Every output shard was independently size/hash-checked after atomic publication of the output directory.

The input contains 21,256 paper-card records. It separately accounts for 1,590 records with no provider image and one advertised image that returned HTTP 404; there were **zero extraction failures**. Another 2,480 Pocket records were explicitly excluded from the paper-card input. A full-catalog snapshot does not mean every printing has an image, every visual identity can be recognized, or the provider catalog is universally complete.

A resumed, sequential Node/WASM run reused 7,171 content-verified feature records and extracted the remaining 12,494 in about 596 seconds; the builder sampled a 563,019,776-byte process-RSS peak. These are offline build figures, not browser startup, camera latency or a from-scratch whole-build duration. Images and feature caches were kept in private disk-backed storage. The builder made no network requests and emitted no source images.

This pack is a separate [public reference release](https://github.com/dafepro/tcg-scan/releases/tag/reference-data-pokemon-en-2026-10-12) with provider/provenance notices. Its 358,031,963-byte ZIP has SHA-256 `a57c832645744a7766473c2bda188f83e9cd4fa5f4e0aaf7c894242133fd585f`. This distribution is not a blanket artwork redistribution grant. Expanded-gallery browser recognition and controls are reported in [learned validation](learned-validation.md); they are separate from successful extraction and remain limited cloud-browser evidence, not a whole-game accuracy guarantee.

## Install the prepared database

In the included local app server, choose **Install Pokémon database**. The app downloads the fixed release, verifies it and installs the references; progress and Cancel are available. An interrupted download can resume, and a cancelled partial browser import is retried safely. Static hosts without the installer backend can use **Use a downloaded reference ZIP** and select the complete ZIP directly, without extracting it. Individual manifest/shard selection remains an advanced option. See [self-hosting](self-hosting.md) for the server/cache and static-host boundaries.

## API

`src/lib/learned-packs.ts` has no DOM, canvas, image-fetching, or window dependency and is usable from a dedicated Worker.

```ts
importLearnedPack(files, { signal?, onProgress? }): Promise<LearnedPackMetadata>
listLearnedPacks(): Promise<LearnedPackMetadata[]>
loadLearnedIndex(game?): Promise<LearnedIndexCard[]>
loadLearnedReference(featureId): Promise<LearnedReferenceFeatures>
removeLearnedPack(id): Promise<void>
```

For advanced direct-file import, select one `*.learned.json` file and **all** binary files declared by it. The converter emits `manifest.learned.json` and `features-00001.bin`, `features-00002.bin`, etc. Missing, duplicate, extra, incorrectly sized, or differently named files are rejected. Import never resolves a manifest path over the network.

`onProgress` receives `{phase, completed, total, text}`, where phase is `validating`, `importing`, or `complete`. The import checks cancellation before each shard/record and before activation. A SHA operation or IndexedDB transaction already in progress is allowed to finish before cancellation is handled.

Pack metadata exposes ID, name, algorithm, reference count, distinct name-identity count, per-game counts, bytes, creation/install timestamps, coverage, and readiness. `readiness` is `importing`, `ready`, or `corrupt`. Error codes distinguish invalid input, unavailable storage, insufficient quota, corruption, overlap conflict, cancellation, and a missing reference.

`loadLearnedIndex` returns only card metadata, two 64-bit hashes, and an opaque local feature ID. `loadLearnedReference` returns canonical float32 points, signed-int8 descriptors, and float32 per-vector scales. Treat the returned typed arrays as read-only; the storage module reuses them in its bounded LRU. The engine separately maintains an eight-reference normalized float32 matching cache.

## Frozen feature contract

The closed v1 manifest rejects unknown fields and requires these exact values:

- Format: `tcg-learned-reference-pack`, version `1`
- Algorithm: `xfeat256-int8-v1`
- Model ID: `xfeat-kornia-1296058905af4117b33e252336f4efa6c01b5beb`
- ONNX SHA-256: `86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0`
- ONNX data SHA-256: `d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9`
- Preprocessing ID: `opencv240x336-rgb255-bilinear224x320-v1`
- Selection ID: `spatial4x6-round-robin256-v1`
- Quantization ID: `maxabs127-f32-nearest-even-int8-v1`
- Canonical image: 240 × 336; reference points: 256; descriptor dimensions: 64

Canonical reference resize/query warp is the established OpenCV path. XFeat consumes RGB float32 values in 0–255, bilinearly resized to 224 × 320 and laid out NCHW. There is no external `/255` or ImageNet normalization. Query extraction retains up to 500 points. References use the frozen row-major 4 × 6 spatial round-robin selection to retain 256 points.

Quantization uses one float32 scale per descriptor: `max(abs(vector))/127`. Values divided by this stored scale are rounded to nearest-even, clipped to −127…127, and stored as signed int8. A matching implementation reconstructs `int8 * scale` and L2-normalizes. JavaScript `Math.round` does not implement nearest-even; the offline builder uses signed ties-to-even after float32 division, including negative half-way values.

The model and proposal implementation lives in `src/lib/vision/learned-models.ts`. The explicit-input builder calls `createLearnedModelsFromAssets` with exact verified local assets and uses its query extraction, then applies the frozen selection/quantization. It does not create another neural preprocessing implementation. The initial converter performs no inference and simply copies verified numeric arrays.

## Binary layout

Each shard is a 32-byte header followed by contiguous fixed **19,456-byte** records. All multi-byte integers and floating-point values use explicit little-endian encoding. There is no compression, external URI, executable section, alignment padding, or trailing data.

| Header byte offset | Size | Value                                  |
| ------------------ | ---: | -------------------------------------- |
| 0                  |    8 | ASCII `TCGLRN01`                       |
| 8                  |    4 | uint32 version = 1                     |
| 12                 |    4 | uint32 record bytes = 19456            |
| 16                 |    4 | uint32 record count, 1–128             |
| 20                 |    4 | uint32 zero-based manifest shard index |
| 24                 |    4 | uint32 flags = 0                       |
| 28                 |    4 | uint32 reserved = 0                    |

| Record byte offset |   Size | Value                                            |
| ------------------ | -----: | ------------------------------------------------ |
| 0                  |  2,048 | 256 × 2 interleaved x/y float32LE coordinates    |
| 2,048              |  1,024 | 256 float32LE quantization scales                |
| 3,072              | 16,384 | 256 × 64 row-major signed-int8 descriptor values |

Coordinates must be finite and within the canonical image; scales must be finite, positive, and no greater than `1/127` with float32 tolerance. Each vector must contain a magnitude-127 component and no −128 values. Payload size, header fields, dimensions, and record boundaries are checked before activation.

The manifest has a `shards` array of `{file, bytes, count, sha256}` and a `records` array of card metadata plus `{hash, differenceHash, shard, offset, sha256}`. Offsets must enumerate each shard contiguously starting at 32, without duplication, overlap, holes, or extra records. Each entire shard and every individual record has a SHA-256 digest. The pack ID is `learned:` followed by the SHA-256 of the manifest's exact UTF-8 bytes.

Only known HTTPS card-provider hosts are accepted for optional source/image metadata. Credentials, alternate schemes, custom ports, unknown hosts, control characters, unknown metadata fields, and out-of-range lengths are rejected. YGO artwork hotlinks are rejected even on its known provider; artwork must stay local. These URLs are metadata and are not fetched by the storage module.

## Storage and recovery

Database: `tcg-scan-learned-references`, schema version 1.

- `packs`: small status/count/coverage records, with checksummed immutable metadata and a fresh import token.
- `index`: small hash/ID/card-metadata rows. Each row has an index checksum and an expected record checksum. A unique namespaced reference key prevents silent cross-pack replacement.
- `records`: individual raw ArrayBuffers, indexed by opaque feature ID and pack ID. There is no descriptor JSON or complete shard stored in a metadata row.

Import verifies the metadata contract and exact supplied files, then checks storage estimates with 20% headroom. The estimate is advisory; actual `QuotaExceededError` failures are also handled explicitly. An importing marker is created first. One small binary shard is read and verified at a time, and at most that shard's records are staged for an IndexedDB transaction. No whole-catalog binary buffer is assembled.

Only after every shard succeeds and stored index/record counts agree does a final transaction make the pack ready. Failed or cancelled imports roll back their own records. An abrupt process stop can leave an `importing` marker; it is visible in the pack list but never contributes to recognition. Remove that incomplete pack and retry. Cleanup failure also cannot turn it ready.

Identical ready-manifest imports are idempotent. An incomplete/damaged pack requires explicit removal before retry. Overlapping reference keys in different packs are rejected deterministically, including simultaneous imports. **Remove a selected 2k pack before importing an expanded pack that contains those same keys.** There is intentionally no silent replace/merge behavior. A future explicit replacement flow should preserve atomic visibility and get the user's intent first.

Removal is one transaction across all three stores, using key-only cursors so it does not decode features. It invalidates the LRU. Every LRU hit checks durable readiness and the import token, including changes made in another tab/Worker. Uncached reads check the small index's key/checksum, payload size, payload checksum, and numeric shape. Detected corruption marks the pack corrupt, evicts cached references, and fails closed. Readiness means import completed; corruption audits of binary records remain lazy rather than rereading the full catalog on startup.

`loadLearnedIndex` reads only pack metadata and the metadata-only index. It does not open the `records` store. Metadata rows use one `getAll` request instead of a cursor round trip per card. Candidate feature reads are serialized; the LRU retains at most eight records, **155,648 bytes** of typed-array payload. Other callers must also bound their own retained matching arrays.

## Reproducible selected-gallery conversion

Run locally in this checkout:

```sh
node --import tsx scripts/build-learned-index.mjs \
  --convert-frozen \
  --frozen /path/to/frozen-selected \
  --orb /path/to/original-pokemon-2000 \
  --out /path/to/new-private-learned-pack
```

The output directory must not already exist or be inside the frozen input directories. A private staging directory is renamed into place only when complete. Interrupted staging output can be inspected/removed; the command does not overwrite an earlier artifact. A separate `<output>.report.json` records measurements and input/output checksums; do not include that report when selecting import files.

The input is pinned to:

- `CONFIG.json`: `cfe901caa6c1d9dd581b09a3d8e7a078d3efb5bc6fe9a1d7bd9e52d7822c20ec`
- `reference-manifest.json`: `c070563251ee30910cb3715c2b294e52450fd830dcc533cfffb5e2daec6cb33f`

Every NPZ file's size and SHA-256 are verified against the pinned manifest. The original ORB manifest and each original ORB shard are also verified against the frozen configuration before copying perceptual hashes for identical keys. No ORB descriptors are included in the output.

The converter's NPZ reader uses a closed numeric NPY header grammar. It does not invoke Python, `eval`, pickle, or model code. Only the three required arrays, exact shapes/dtypes, bounded stored/deflated ZIP entries, and explicit numeric endianness are accepted. Object dtypes, executable header expressions, encrypted archives, unknown compression, extra members, duplicate members, paths, and oversized decompression are rejected.

## Explicit-input offline extraction

The second mode is implemented in `scripts/learned-builder.mjs` and selected through the same CLI:

```sh
node --import tsx scripts/build-learned-index.mjs \
  --input /private/catalog-input.json \
  --images /private/cached-original-images \
  --assets ./public/vision-models \
  --cache /private/learned-feature-cache \
  --out /private/new-learned-pack
```

All five paths are required. Output/cache parent directories must already exist; output must be new. Symlink-resolved images, assets, feature cache, and output must be separate. Every image is a relative path inside the explicit image root; traversal, URL paths, and symlink escape are rejected. There is no catalog discovery, provider request, missing-image download, or publication step. An unexpected `fetch` during extraction fails closed.

The closed input schema is illustrated below. Replace placeholder checksums with the exact cached original's SHA-256 and byte count. `createdAt` is part of the reproducible artifact; the builder never inserts the current time into a pack.

```json
{
  "format": "tcg-learned-build-input",
  "version": 1,
  "name": "Private selected references",
  "game": "pokemon",
  "createdAt": "2026-10-12T00:00:00Z",
  "coverage": {
    "scope": "selected",
    "catalogCards": 2,
    "availableImages": 1,
    "missingImages": 1,
    "provider": "Provider name and catalog scope",
    "note": "Explicitly selected private test input, not full catalog coverage.",
    "catalogRetrievedAt": "2026-10-12T00:00:00Z"
  },
  "rights": {
    "usage": "private-local-only",
    "notice": "Source and applicable rights limitations; no redistribution permission is asserted."
  },
  "cards": [
    {
      "key": "pokemon:example-1",
      "game": "pokemon",
      "name": "Example card",
      "imagePath": "objects/cached-image.webp",
      "imageSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "imageBytes": 12345
    },
    {
      "key": "pokemon:example-2",
      "game": "pokemon",
      "name": "Example without a provider image",
      "imagePath": null
    }
  ]
}
```

Card rows additionally permit the same optional identity/artwork/set/number/provider-URL metadata as a pack. A declared missing provider image uses `imagePath: null` and has no checksum or byte count. An advertised image known to be unavailable is a separate case: omit `imagePath`, `imageSha256`, and `imageBytes` entirely, and add `sourceUnavailable`. It has exactly `reason` (`http-404`, `cache-missing`, or `cache-corrupt`), `advertisedUrl` (known HTTPS image host for that game), `evidenceSha256` (the accompanying verified audit/report checksum), and optional `observedAt` (a valid UTC timestamp). Provider-card `sourceUrl` is mandatory; an existing metadata `imageUrl` must agree with the advertised URL. Never fabricate an image digest, byte count, or observation timestamp for an unavailable asset. Input preparation is responsible for preserving the actual evidence identified by that checksum. `availableImages + missingImages` must equal `catalogCards`. Selected/custom/fixture inputs may enumerate a subset; a `full-catalog` input must enumerate every available and missing row and additionally requires `--allow-full-catalog`. This is a deliberate execution guard, not permission to launch an unreviewed full rebuild.

Original files are checked by exact size and SHA-256 on every run, including cache hits. Only PNG/JPEG/WebP signatures are accepted; sources are capped at 20 MiB, 4096 pixels per side, and 16 million pixels. Animated/multipage inputs are rejected. Sharp performs the unchanged RGBA decode without an added autorotation/color transform; OpenCV performs the frozen 240 × 336 `INTER_AREA` resize and perceptual hashes. Shared XFeat extraction then performs the frozen neural preprocessing. References with fewer than 256 keypoints, non-finite data, or invalid descriptors fail explicitly and are never padded.

The private cache is keyed by original image content plus a versioned extraction-contract hash: model/data/runtime hashes, algorithm/preprocess/selection/quantization IDs, source-code hashes, OpenCV version, and Sharp/decoder versions. A matching valid cache entry reuses an individual 19,456-byte record. Payload, canonical-image, source-image, metadata, and contract checks prevent silent reuse after corruption or changes. Corrupt entries are reported and rebuilt; inaccessible entries are reported rather than bypassed. Cache files are atomically replaced, with the metadata published last. A cancelled run can reuse completed entries without trusting an incomplete output directory.

Processing is sequential and retains one original image, one canonical image/query, and one small output shard, plus the metadata manifest and constant-size model runtime. It does not accumulate full-catalog descriptors. A staging directory is renamed to the requested output only after successful pack validation. Completed feature cache entries survive cancellation or an output failure. Never treat a staging directory as an installed pack.

The sibling `<output>.report.json` separates provider-missing images (`missingProviderImages`), predeclared advertised-but-unavailable images (`unavailableAdvertisedImages`), attempted source/decode/extraction/quantization failures (`failures`), repaired cache entries, cache hits, and newly extracted references. Predeclared unavailable sources are never opened or sent to the extractor. Pack coverage preserves that distinction as optional `unavailableImages`; full-catalog accounting is extracted + failed + unavailable + explicitly deduplicated images = advertised available images. Older manifests omit the optional field and retain their exact serialization. The pack coverage counts successful and failed references honestly. Fatal model/runtime or output/cache-write errors stop the build. The sibling `<output>.NOTICE.txt` includes source/rights information and the model notice; neither file belongs in the manifest+binary import selection. New build outputs remain local until explicitly distributed, and these notices grant no new card-artwork or redistribution rights.

### Small-fixture verification

Only two already-cached original references were extracted for the control pack. Four diagnostic rows separately exercised a bad source checksum, a blank image with fewer than 256 points, a missing cached file, and a provider-missing image. The output correctly contains two references and reports all four exclusions.

A fresh extraction, a content-cache resume, and an independent fresh-cache extraction produced byte-identical manifest and binary shards. Resume reused both valid references with zero new successful extractions. A separate interruption test stopped after the first completed cache entry, published no output, then resumed with one cached and one newly extracted reference. Corrupting a cached binary record was detected and repaired; recovered outputs remained byte-identical. The fixture manifest SHA-256 is `22afcbd6196b75fb07e1d8b6fd876b42b3b3f2d794a33937c79870cf8b5d3f4c`. Fresh fixture runs including model startup took approximately 0.85–0.89 seconds in Node/WASM; sampled process RSS was approximately 372–400 MB, including OpenCV and the shared model runtime. These tiny-fixture results are not full-catalog or browser benchmarks.

A separate seeded 500-point numerical control matched NumPy's exact 256 selected indices and every byte of the 19,456-byte quantized record, including the float32 scale/division contract. Control payload SHA-256: `712eb3604185dc52e45a75dff4448e94ab73fc11a5cca7fcf092327eb76ff350`.

The two real controls reproduce frozen canonical RGBA, both perceptual hashes, and selected point coordinates exactly. New WASM descriptors have 6 and 11 int8 scalar differences versus the frozen Python extraction (minimum decoded cosine 0.9999962 and 0.9999931). Therefore new extraction is kept separate from the preserved frozen gallery. The frozen converter still reproduces all 17 original output files byte-for-byte; no validated gallery has been silently rebuilt or replaced.

## Verified measurements and tests

Measurements on the frozen 2,000-reference subset, 2026-10-12:

| Artifact                                       |      Bytes |
| ---------------------------------------------- | ---------: |
| Complete pack, manifest + 16 shards            | 39,755,008 |
| Manifest                                       |    842,496 |
| Binary shards including headers                | 38,912,512 |
| Numeric record payload                         | 38,912,000 |
| Largest shard                                  |  2,490,400 |
| Runtime metadata/hash index serialized as JSON |    818,383 |
| Eight-reference quantized typed-array LRU      |    155,648 |

A repeated converter run produced byte-identical manifest and shards. Manifest SHA-256: `adca431b559c3aeca72009c6e96f222306abd7a4f112a330688c7c2215c46400`.

The first converter run took 869 ms, with sampled peak heap 25,734,152 bytes, sampled peak ArrayBuffers 50,188,559 bytes, and process peak RSS 156,393,472 bytes. Those process-wide values include Node, parsing, retained input metadata, garbage-collection timing, and temporary copies; the algorithm retains only one shard's feature data at a time.

A **Node 24.19.0 / fake-indexeddb simulation**, with forced GC around retained-memory samples, measured:

- Import: 600 ms; sampled process peak RSS 192,258,048 bytes, heap 22,631,272 bytes, ArrayBuffers 87,121,068 bytes.
- Metadata-only index load: 103 ms, **zero descriptor-store reads**, 2,857,280 additional retained heap bytes, zero additional retained ArrayBuffer bytes.
- Ten lazy feature reads: 7.5 ms; final LRU eight records / 155,648 payload bytes.
- Removal: zero remaining packs, index entries, and cached references.

These are **not browser performance claims**. Fake IndexedDB holds simulated database buffers in the Node process instead of browser-managed disk. A separate supported cloud-desktop Chromium route subsequently imported and used the 2,000-reference pack in actual built-app tests, including a subdirectory deployment and sustained camera replay. See [learned validation](learned-validation.md) for those distinct browser results. Do not extrapolate the Node figures above or the selected-gallery browser results to phones or a full catalog.

The dedicated `learned-packs.test.ts` suite has 97 deterministic tests for schema/version/model/preprocessing rejection, malicious URLs, truthful coverage, oversized input, binary bounds and numeric validation, safe NPZ parsing, two-level integrity, quota errors, rollback/cancellation, concurrent imports, incomplete-state visibility, duplicate conflicts, cross-context replacement/removal, metadata-only startup, bounded lazy cache, corruption fail-closed behavior, explicit offline input/rights validation, typed unavailable-source provenance, no-extraction handling of predeclared unavailable images, spatial selection, signed float32 nearest-even quantization, and content/version cache keys.

```sh
npx vitest run src/lib/learned-packs.test.ts
npx eslint src/lib/learned-packs.ts src/lib/learned-packs.test.ts scripts/build-learned-index.mjs scripts/learned-builder.mjs
npx tsc -b --pretty false
```
