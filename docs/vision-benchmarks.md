# Local vision engine: measurements and limits

Last measured: 2026-10-12. Engine source: `src/lib/vision/`.

## What this establishes

The application performs real OpenCV contour detection, perspective rectification, local feature extraction, Hamming matching, and RANSAC homography verification in a persistent browser worker. Perceptual hashes only retrieve candidates. They never identify a card by themselves. Camera pixels and ORB matching stay on the device.

These measurements establish reproducible offline pipeline behavior, not production recognition accuracy. No held-out physical-camera dataset, comprehensive false-positive calibration, mobile benchmark, or full-catalog recall benchmark has been completed. A successful source-image transformation is easier than photographing a physical sleeved card.

## Reproduce without downloading any artwork

From the repository root, after installing the locked dependencies:

```sh
npx vitest run src/lib/vision
node --import tsx scripts/benchmark-vision.ts \
  --single-runs 60 --binder-runs 20 \
  --output /tmp/vision-benchmark.json
```

The script generates original geometric artwork entirely offline. Its generator is shared with the actual-OpenCV integration tests. No provider API is contacted. The report includes runtime identification, parameters, measured per-stage percentiles, and the final frame's evidence/state. Five warm-up frames precede each timed scenario. Percentiles use the nearest-rank method. Timings include image-to-Mat conversion and synchronous analysis; they exclude camera capture, browser-worker transfer/startup, rendering, OCR, tracking/stabilization, persistence, and reference downloading.

## Recorded reference run

- Node v24.19.0; Linux x64
- Cloud host: AMD EPYC 9V74 80-Core Processor, 9 visible logical CPUs, 10 GiB visible memory. This is **not a phone**.
- `@techstark/opencv-js` exactly `5.0.0-release.1`, WebAssembly
- Eight indexed synthetic references; 96 spatially balanced ORB descriptors per reference
- Up to 500 query ORB features, eight-reference verification shortlist
- Canonical crop: 240 × 336; soft frame budget: 1,000 ms
- Single input: 640 × 520, one 240 × 336 card
- Binder input: 960 × 720, nine 144 × 202 card rectangles; seven clear indexed identities, one unknown identity, one strongly glare-obscured indexed identity

| Stage | Single p50 / p95 (60 frames) | Nine-card p50 / p95 (20 frames) |
| --- | ---: | ---: |
| Detection | 7.29 / 9.61 ms | 16.94 / 19.80 ms |
| Rectification, quality, hashes, ORB | 10.51 / 13.95 ms | 101.70 / 110.91 ms |
| Hash retrieval + feature verification | 25.77 / 32.36 ms | 284.19 / 319.22 ms |
| Entire synchronous analysis | 44.15 / 54.23 ms | 399.55 / 447.53 ms |

Stage percentiles do not sum to the whole-frame percentile. Hash retrieval is included in matching time; no separate sub-5-ms retrieval claim is made. Reference loading took about 4.5 ms in an earlier run of the same eight-reference fixture. Timing varies with host contention and JIT warm-up.

### Recorded outcomes and conservative rejections

- Single card: detected and verified; 96 inliers, including 20 within the artwork region.
- Binder: **all nine quadrilaterals detected**. Five of seven clear indexed identities verified. Two clear indexed identities remained unknown because their fine synthetic artwork did not provide enough matching interior features after reduction to 144 px width. The thresholds were not weakened to make this fixture pass.
- The out-of-index card remained unknown. The glare-obscured card was rejected by quality checks.
- Shared artwork with absent/different identity metadata remained ambiguous and not auto-eligible.
- Two matching printings with the same explicit identity key were identity-verified and auto-eligible with `printingAmbiguous: true`. This permits an identity-only collection entry; it does not invent an edition, finish, condition, or price.
- An independent original polygon-art fixture detected nine cards and verified all seven clear known identities, rejecting the unknown and glare-obscured cards. Its earlier warm measurements were single p50/p95 42/49 ms and nine-card 298/352 ms. These differing outcomes illustrate sensitivity to artwork and source resolution; the checked-in fixture above is the reproducible baseline.

## Source-image checks against a real 155-reference index

A separately built TCGdex English Base Set + Wizards Black Star Promos pack contained 155 successfully extracted references, 96 descriptors each, about 1.02 MB of JSON. One actual Pikachu promo #1 source image was checked against all 155 references:

- Perspective projection with visible surrounding background: correct `pokemon:basep-1`, 67 RANSAC inliers, 18 artwork-region inliers
- Upside-down perspective projection: correct identity, 69 inliers, 19 artwork-region inliers
- Reduced to approximately 150 px width with perspective: correct identity, 50 inliers, 17 artwork-region inliers
- Original tightly cropped 600 × 825 image in normal detector mode: the outer card boundary was not visible. An interior artwork rectangle was proposed, then safely rejected as unknown by verification.
- The same tight image with an **explicit user-selected whole-image region**: correct identity, 67/71 inliers, 19 artwork-region inliers, 65.4% spatial support, 0.284 px median reprojection error. No implicit full-frame forced-match fallback is used.

A separate deterministic source-image check selected every thirteenth entry in that 155-reference pack (12 indexed examples) and 24 cached provider images whose identities were outside the pack. Perspective-warped 640 × 480 scenes produced 12/12 correct auto-eligible indexed identities and 0/24 false-eligible out-of-index examples. This small, source-derived sample is a sanity check, not a calibrated false-positive rate or a held-out physical-camera evaluation.

To repeat the source-image checks with locally available files:

```sh
node --import tsx scripts/benchmark-vision.ts \
  --single-runs 10 --binder-runs 5 \
  --pack /path/to/pokemon-feature-pack.json \
  --reference-image /path/to/pikachu-promo-1.png \
  --reference-key pokemon:basep-1 \
  --output /tmp/vision-with-source-image.json
```

The script reports the expected key alongside actual results. It does not download the pack or image. Source-image transformations are not held-out camera examples and do not establish catalog-wide accuracy.

## Larger real index: 2,000-reference subset

A follow-up on the same cloud host loaded four SHA-256-verified shards containing **2,000 actual Pokémon references**, 96 sparse ORB descriptors each. The shards total 13,006,224 bytes of JSON. Reading, parsing, hash verification, and engine loading took 536.71 ms together. This is an explicitly labeled subset of 19,666 catalog images, not whole-game coverage.

The offline benchmark selected 64 evenly spaced indexed references, 64 cached out-of-pack references whose explicit identity keys were already represented, and 64 cached references with genuinely unrepresented identities. Each source produced three 640 × 480 scenes: perspective upright, upside-down perspective, and approximately 150-px card width. Two repeats were timed after five warm-up analyses: **192 source images, 576 distinct scenes, 1,152 timed analyses**. Outcome counts use only the first repeat and are not inflated by repeated frames.

| Outcome | Indexed artworks | Unseen references of known identities | Unseen identities |
| --- | ---: | ---: | ---: |
| Source images / transformed scenes | 64 / 192 | 64 / 192 | 64 / 192 |
| Scenes with a detected quadrilateral | 185 | 187 | 189 |
| Correct identity auto-eligible | 185 | 0 | 0 |
| Wrong identity auto-eligible | 0 | 0 | 0 |
| Exact supplied reference ranked first | 182 | 0 | 0 |
| Unknown detected crops | 0 | 187 | 189 |
| Ambiguous / quality / budget-deferred scenes | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Indexed exact-reference shortlist misses, when queried | 0 | Not applicable | Not applicable |

The seven indexed detector misses comprised all three views of Mewtwo ex (`30th-157`), all three views of Shaymin-EX (`bw11-RC21`), and the upright view of Zekrom-EX (`bw4-97`). These are failed detections, not hash-retrieval misses. No fallback fabricated a match.

Three auto-eligible indexed scenes selected another reference with the same explicit identity: White Kyurem-EX (`bw11-101` → `bw7-103`, upright) and Mewtwo-EX (`bw11-54` → `bw4-54`, upright and small). This is direct evidence that an identity match must **not** be labeled an exact-printing identification. The application's automatic entries remain identity-only and outside confirmed-printing valuations. Pokémon identity keys in this catalog are normalized card names, so matching that key does not establish identical collector number, rules text, edition, finish, or condition.

### Historical warm latency with 2,000 real references (before compact-hash correction)

| Stage | Indexed scenes p50 / p95 | All three groups p50 / p95 |
| --- | ---: | ---: |
| Detection | 6.90 / 8.86 ms | 6.85 / 9.47 ms |
| Rectification, quality, hashes, ORB | 12.28 / 14.70 ms | 12.03 / 15.97 ms |
| Hash retrieval + verification | 27.21 / 39.05 ms | 23.93 / 37.70 ms |
| Hash retrieval alone, included above | 3.59 / 4.59 ms | 3.55 / 5.12 ms |
| Entire synchronous analysis | 46.14 / 59.06 ms | 43.38 / 58.81 ms |

The timings retain the Node-only exclusions described above. They are single-card scenes, not a nine-card page benchmark at this index size. Zero false-eligible outcomes in this finite, source-derived sample is not a measured production false-positive rate. The held-out images are provider artwork transformed synthetically, not independent photos of physical cards. No thresholds or feature preprocessing were changed to improve these results.

### Reproduce or replay this source selection

The runner reads only an existing pack and content-addressed image cache; it never downloads anything. Use the cache created by the offline index builder:

```sh
node --import tsx scripts/benchmark-reference-index.ts \
  --manifest /path/to/pokemon-2000/manifest.json \
  --cache /path/to/reference-cache \
  --known 64 --held-out 64 --repeats 2 \
  --output /tmp/vision-2000.json
```

The cache can grow while another build runs, so a fresh sample may include different held-out sources. For the **exact recorded source set**, add:

```sh
--selection docs/benchmarks/vision-2000-2026-10-12.json
```

The [checked-in report](benchmarks/vision-2000-2026-10-12.json) contains shard hashes, source keys/scopes, stage percentiles, and all 576 first-repeat scene outcomes, including detector misses and alternate-printing matches. The replay fails if a required source is not cached or if its scope no longer matches the supplied index. The full runtime report additionally includes all per-repeat timings and eight-candidate shortlists. Engine retrieval diagnostics are opt-in and never act as identity evidence.

## Compact exact-hash correction and development-photo checks

A photographed Pikachu revealed a real retrieval failure: its nearest two global hashes were absent from the bounded bucket pool. Rare one-bit probe buckets consumed the limit before relevant exact buckets. Prioritizing exact buckets corrected the 2,000-reference case but failed again with 10,000 references when exact buckets became crowded. Neither failure came from identity/printing ambiguity or the geometric rejection gates.

The production shortlist now scans compact numeric hashes exactly. Each reference occupies four uint32 words (two 64-bit hashes); only the nearest eight references proceed to ORB/Hamming/RANSAC. No feature preprocessing, sparse-reference density, verification threshold, or identity-only policy changed. A zero-distance hash can no longer be omitted because a posting budget was exhausted. This does **not** ensure that every photographed artwork has one of the eight nearest whole-card hashes.

The [compact-hash report](benchmarks/vision-compact-hash-2026-10-12.json) records source hashes, pack hashes, outcome counts, development-image hashes, memory, and timings. The original historical report above is preserved.

### Replayed source-derived scenes

The exact original 576 scenes were replayed twice (1,152 timed analyses) on the same Node v24.19.0 / AMD EPYC cloud runtime. All acceptance states were unchanged: 185 indexed scenes remained identity-eligible, seven indexed scenes still lacked detections, and all 384 out-of-pack scenes remained non-eligible. There were no newly false-eligible outcomes in this finite source-derived sample.

| Stage | Indexed scenes p50 / p95 | All three groups p50 / p95 |
| --- | ---: | ---: |
| Compact hash retrieval | 0.33 / 0.52 ms | 0.34 / 0.49 ms |
| Entire synchronous analysis | 41.61 / 53.71 ms | 39.11 / 52.71 ms |

Use the existing replay command above with the current source and the original selection JSON. The final timing run was coordinated to avoid the separate experimental feature extractor; these remain shared-host Node measurements with the browser/camera exclusions already listed.

### Eight convenience development photographs

Whole-frame analysis at both 2,000 and 10,000 references produced 26 quadrilaterals and 17 identity-eligible detections across the same eight photographs. The wood Pikachu changed from a missed shortlist to a verified identity. Previously accepted names were preserved. The nine-card holo binder remained entirely non-eligible; two separate close photographs still had no detected quadrilateral. These are disclosed development examples, not an independent accuracy test, and 17/26 is **not** a recall or accuracy estimate.

With three repeats per photograph and the first excluded from latency, compact retrieval was 0.23/0.40 ms p50/p95 at 2,000 references and 1.49/3.01 ms at 10,000. Mixed whole-frame latency was 104.08/355.47 ms and 87.58/414.36 ms respectively; different numbers of detected cards dominate these mixed-scene timings. No phone-speed claim follows.

To reproduce whole-photo outcomes with already downloaded photos, make a photo manifest as documented by `scripts/evaluate-photos.ts --help`, then run:

```sh
node --import tsx scripts/evaluate-photos.ts \
  --manifest /path/to/development-photos.json \
  --pack-manifest /path/to/pokemon-10000/manifest.json \
  --budget-ms 1000 --max-cards 9 --output /tmp/development-results.json
```

The report lists the eight exact filenames and SHA-256 image hashes. Labels are never supplied to retrieval. Repeat with the 2,000-reference pack for the size comparison. Existing physical held-out images were not accessed during this correction.

### Storage and limits

The hash buffer grows geometrically: 10,000 loaded references currently allocate 16,384 rows, or 262,144 bytes. At the hard 60,000-reference cap it occupies 960,000 bytes. Key/game arrays and a replacement-slot map are additional, as are the much larger feature pack and OpenCV runtime. The former hash posting sets were removed.

A separate forced-GC Node load of the 10,000-reference sparse96 pack increased heap used from 51.25 MB to 121.04 MB and RSS from 271.19 MB to 479.76 MB. This includes the whole engine and loaded reference objects; it is not hash-index-only memory or a mobile/browser peak. Disposal released the hash array and most live JavaScript objects, but RSS did not immediately fall to startup levels.

An isolated compact-hash prototype capacity check repeated existing rows to simulate 60,000 hashes: 2.62/3.58 ms p50/p95 for one two-orientation query. Those repeated rows are a computation-load test, not 60,000 distinct reference coverage or a measured full-catalog accuracy result. Production import remains capped at 60,000 references / 256 MiB raw descriptors, and at most eight geometric verifications per crop.

## Implemented rejection gates

The values below are conservative engineering thresholds, **not statistically calibrated confidence**:

1. Visible convex four-sided boundary with card-like aspect ratio. Normal detection rejects frame-clipped boundaries and heavily distorted shapes. One to nine candidates are retained after nested/duplicate suppression. Background margin is recommended; a user-selected region is supported for an explicitly declared tightly cropped card.
2. Source minimum edge at least 90 px; normalized Laplacian variance at least 45; sufficient contrast and feature count. Severe overexposure/glare is rejected. Other foil/reflection patterns may only fail feature verification.
3. Exact compact DCT pHash and difference-hash retrieval, considering upright and upside-down hashes. Four uint32 words per reference are scanned to rank the nearest eight by pHash distance plus 0.4 × dHash distance. The retrieved set is a shortlist, never proof.
4. ORB nearest-neighbor Hamming ratio test (`0.76`) with distance below 62 and unique destination points.
5. At least 24 RANSAC inliers, inlier ratio at least 0.48, convex-hull spatial support at least 0.22 of the full crop, median reprojection error at most 2.8 px, and mean corner error at most 0.12 of crop diagonal.
6. At least ten inliers inside a game-specific artwork region. This rejects cards that align through shared borders/text while the art differs. Nonstandard full-art, landscape, split, borderless, or unusually laid-out cards may be rejected more often.
7. Separation from credible alternate identities. Known shared-art groups with unresolved/different identity keys remain ambiguous. Multiple verified printings can be auto-eligible only at identity level when their explicit identity keys agree.

An out-of-index identity or a visually indistinguishable printing absent from the pack can still resemble an indexed reference. These gates reduce risk; they do not prove universal uniqueness. Coverage counts are the actual number of loaded descriptor references. The UI must not label a partial library as whole-game coverage.

## Bounded execution and ownership

- One persistent worker and one in-flight frame per client. New concurrent frames are dropped with `VisionBusyError`; there is no analysis backlog.
- Input ImageBitmaps are transferred and closed; ImageData buffers are transferred. The caller must regard either input as consumed.
- All temporary OpenCV Mats and vectors are deleted. Cached reference Mats use a 24-entry LRU and are deleted on eviction/clear. Terminating the worker releases its remaining runtime.
- Detector resolution is at most 960 px on the long side; at most 3,000 contours are examined. Large input frames above 4,096 px per side or 16 megapixels are rejected.
- Hash retrieval scans at most 60,000 compact rows (four uint32 words each), then verifies at most eight references per crop. It never exhaustively ORB-matches the library. Numeric hash storage tops out at 960,000 bytes, plus key/game arrays and a replacement-slot map. Work is linear in loaded hash rows and capped by import capacity. Exact nearest-hash ranking removes bucket-truncation misses, but the correct artwork can still fall outside the eight nearest hashes.
- Import capacity is 60,000 references and 256 MiB of raw descriptor bytes. JSON/object/hash-index/WASM overhead is additional and can be material on mobile. Large-pack memory use and first-load latency need device measurement.
- Budgets are soft, checked between cards/candidates, not interruptions of individual OpenCV calls. A crop with an incomplete shortlist is `deferred: true`, `autoEligible: false`. Other independently completed crops may remain verified when `budgetExhausted` is true for the frame.
- Card processing rotates each frame to prevent later binder positions from starving on slower devices. Deferred crops are not new negative evidence and should not advance temporal stabilization.
- Matching does not decide how many physical copies exist. The parent tracker owns temporal observations, leave/re-enter semantics, and idempotent collection writes. Three agreeing observations is a consistency check, not a measured probability.

## Automated tests and remaining QA

The vision tests exercise real WASM ORB/RANSAC, upright/upside-down rectification, out-of-index shared layouts, blank/low-detail rejection, malformed-pack atomicity, shared-art identity handling, budget deferral, geometry, hash retrieval bounds, scoring rejection, one-worker reuse, concurrent-frame dropping, and disposal.

Required before stronger accuracy/performance claims: held-out physical photos/video across games and devices; sleeve/glare/binder/occlusion cases; reprints and near-identical artwork; large actual reference packs; out-of-index and non-card negatives; worker startup/memory soak; camera FPS and capture-to-stable-add latency. Browser QA is reported separately from these Node results.

## Algorithm references

- [OpenCV ORB planar tracking](https://docs.opencv.org/3.3.1/dc/d16/tutorial_akaze_tracking.html)
- [OpenCV feature matching + homography tutorial](https://github.com/opencv/opencv/blob/5.x/doc/tutorials/features/feature_homography/feature_homography.markdown)
- [OpenCV JavaScript package and initialization](https://github.com/TechStark/opencv-js)
