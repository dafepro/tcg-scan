# Continuous card recognition architecture

Developer handoff, researched 12 October 2026. This is a proposed design with live catalogue measurements, not a claim that recognition accuracy or phone performance has been demonstrated.

## Recommendation

Build a persistent camera session backed by a downloadable, whole-game visual index. A card that has never been scanned must be recognizable locally after the pack is installed. OCR followed by online catalogue search and caching can remain an escape hatch, but it does not satisfy local first-scan recognition. Set selection should be optional; users should not need to know their cards' sets before scanning.

### Continuous pipeline

1. Keep the rear-camera preview running. Schedule processing with `requestVideoFrameCallback`, with a fallback where unavailable. Allow only one frame-processing job in flight and drop stale frames instead of queuing them. Keep React renders and image processing separate. [Video frame callback documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
2. In a dedicated worker, downsample for detection, find convex card-sized quadrilaterals, suppress nested/duplicate boxes, and map coordinates back to the original frame. Crop from the higher-resolution frame and apply perspective rectification. OpenCV.js exposes contours, `getPerspectiveTransform`, and `warpPerspective`. [Contours](https://docs.opencv.org/4.x/d5/daa/tutorial_js_contours_begin.html), [rectification](https://docs.opencv.org/4.x/dd/d52/tutorial_js_geometric_transformations.html)
3. Reject insufficient resolution, blur, clipped cards, and severe glare. Compare canonical full-card and artwork-region features against the installed global pack, retaining a shortlist rather than trusting one hash.
4. Verify shortlisted candidates using independent spatial features or ORB correspondence plus geometric consistency. Current OpenCV JavaScript bindings include ORB, matching, and homography estimation. Reference descriptors must already be installed for verification to remain offline. [Binding configuration](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py), [matching and homography](https://docs.opencv.org/4.x/d1/de0/tutorial_py_feature_homography.html)
5. Associate detections with physical tracks using position, overlap, appearance, and motion. Require consistent candidate identity across several usable frames, adequate best-versus-second separation, and an absolute rejection threshold calibrated on out-of-catalogue examples.
6. Persist one collection event per accepted physical track using an idempotency key. Draw the name and state over each card: searching, recognized, added, or unresolved variant. Provide immediate undo. Avoid one modal confirmation per card.

Global card-ID deduplication loses legitimate duplicate copies; frame-by-frame additions overcount stationary cards. Re-entry of visually identical copies is intrinsically ambiguous. Preserve scene continuity, show session counts, and provide an easy add-copy/undo control rather than claiming perfect quantity inference.

## Measured catalogue scale

Measured from public provider responses on 12 October 2026. MB below means decimal megabytes. Response gzip sizes were measured locally with Python gzip, not asserted to be the provider's wire transfer size.

| Provider scope | Measured records | Available image entries | Metadata size |
| --- | ---: | ---: | --- |
| TCGdex English | 23,736 | 21,987 | 2.380 MB JSON; 0.294 MB locally gzipped |
| YGOPRODeck card information | 14,606 | 14,778 artwork entries | 21.350 MB JSON; 2.913 MB locally gzipped |
| Scryfall paper unique print search | 98,783 | Not separately counted | Search result total only |
| Scryfall paper unique art search | 48,577 | Multi-face records may add faces | Search result total only |

Sources: [TCGdex cards](https://api.tcgdex.net/v2/en/cards), [YGOPRODeck cards](https://db.ygoprodeck.com/api/v7/cardinfo.php), [Scryfall print search](https://api.scryfall.com/cards/search?q=game%3Apaper&unique=prints), [Scryfall art search](https://api.scryfall.com/cards/search?q=game%3Apaper&unique=art).

TCGdex totals include digital Pocket cards. Exclude the sets returned under series `tcgp` for a physical-card pack, rather than guessing from ID prefixes. Its documented images are 245×337 low-resolution or 600×825 high-resolution. Eleven successful, evenly spread low-WebP samples averaged 18,316 bytes; one of twelve attempts returned HTTP 503. Multiplying that small sample mean by all image entries suggests about 403 MB of images, an extrapolation rather than a full download measurement. [Pocket integration](https://tcgdex.dev/tcg-pocket), [image dimensions](https://tcgdex.dev/assets)

The current Scryfall bulk manifest reported `jsonl_download_uri` and `compressed_size`: unique artwork 37.88 MB compressed; default cards 78.84 MB; all languages 396.21 MB. Handle the actual manifest schema rather than assuming the older `download_uri` field. [Bulk manifest](https://api.scryfall.com/bulk-data)

### Proposed index storage arithmetic

These are schema calculations, not generated pack measurements. Metadata, model weights, checksums, allocation overhead, and extra card faces are excluded. The hash schema is a proposed pair of 256-bit descriptors, not the default size of every pHash implementation.

| Feature representation | Bytes per face | Pokémon 21,987 images | Yu-Gi-Oh 14,778 images | MTG 48,577 art records |
| --- | ---: | ---: | ---: | ---: |
| Two 256-bit visual hashes | 64 | 1.41 MB | 0.95 MB | 3.11 MB |
| 128-dimensional int8 embedding | 128 | 2.81 MB | 1.89 MB | 6.22 MB |
| Spatial verification descriptor | 256 | 5.63 MB | 3.78 MB | 12.44 MB |
| 64 ORB descriptors with quantized xy | 2,304 | 50.66 MB | 34.05 MB | 111.92 MB |

Sparse ORB arithmetic is 64 × (32 descriptor bytes + 4 coordinate bytes). Feature counts and discriminative quality require validation; difficult cards may need more. At 200 ORB descriptors per face, descriptor bytes alone would be about 141 MB for Pokémon, 95 MB for Yu-Gi-Oh, or 311 MB for the MTG art-record count. [ORB descriptor definition](https://docs.opencv.org/4.10.0/db/d95/classcv_1_1ORB.html)

A small hash/spatial pack is feasible for controlled captures. A larger sparse-ORB pack can support fully local verification. Downloading candidate reference images after a match introduces cold network latency and cannot be advertised as fully local first-scan recognition.

## Offline builder and pack delivery

- Consume provider bulk data or one catalogue response; filter game, physical/digital status, language, image availability, and card faces.
- Download each needed image once into a resumable content-addressed local cache. Use low concurrency, bounded retries/backoff, and provider-specific rate handling. Never refetch the catalogue or its images per camera frame.
- Generate references with exactly the same versioned geometry, color conversion, crop rules, and descriptor definitions as the browser. Maintain artwork-to-printing mappings and ambiguity groups.
- Emit a minimal metadata map, packed typed-array features, optional verifier shards, and a manifest containing source timestamps, preprocessing/model versions, checksums, counts, coverage exclusions, and provenance/license notices. Raw artwork should not be committed with application code.
- Serve generated assets statically. A backend and new credentials are unnecessary for installed-pack scanning. Store packs in IndexedDB or OPFS, check available quota, verify hashes, and update atomically. [Browser storage estimates](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate)
- Onboarding: select game once, or offer a small cross-game starter index; show the actual download size and readiness. Set packs are optional storage/verification accelerators. Failed or incomplete downloads must not silently fall back to an unannounced network-dependent scanner.

## Narrow MVP and stronger recognition

MVP: one whole-game catalogue, complete visible cards, good lighting, a persistent session, multiple non-overlapping detections, local retrieval/verification, calibrated rejection, auto-add, and tracked overlays. A contour detector may support clean binder pages, but clear-pocket edges, reflections, crowded pages, and partial cards must be tested before calling binder support reliable.

Later: train a compact four-corner detector on real phone/binder captures plus synthetic augmentations; replace or supplement hashes with a compact instance-retrieval embedding. A generic classification or CLIP model is not automatically an exact-card matcher. DINOv2 is an available retrieval baseline, but its smallest listed backbone has 21 million parameters. MobileNetV3 Small has about 2.54 million parameters and is a plausible compact backbone requiring task validation/training. These are research options, not ready-made TCG recognition models. [DINOv2 model card](https://github.com/facebookresearch/dinov2/blob/main/MODEL_CARD.md), [MobileNetV3 definitions](https://github.com/pytorch/vision/blob/main/torchvision/models/mobilenetv3.py)

Use ONNX Runtime Web for a selected ONNX model, preferring a successfully initialized WebGPU backend and falling back to WASM. Safari 26 added WebGPU, so older runtime support tables are insufficient; feature-detect and run an actual model smoke test. WASM multithreading requires cross-origin isolation. A dedicated worker is appropriate; ONNX's proxy-worker flag cannot be combined with its WebGPU execution provider. [ONNX WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [runtime flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html), [Safari 26 notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)

Start with exact typed-array/WASM scans over compact features and profile. Add ANN structures only if measured search cost demands them. Approximate retrieval changes recall and requires separate validation.

## Identity and automatic catalogue rules

Separate artwork identity, printed edition, and finish. A confident visual match does not establish foil, reverse holo, first edition, condition, or authenticity when the available image lacks the distinguishing evidence. Automatically save the supported identity with unresolved fields, then batch-review exceptions. Reserve OCR for cropped collector number, language, or set text when it can resolve remaining candidates; never block the primary scan loop on OCR.

TCGdex's variant booleans describe known available printings, and its FAQ acknowledges some marketplace mapping errors. Do not turn those booleans into observed finish claims or treat the returned price as an exact valuation. [TCGdex FAQ](https://tcgdex.dev/faq)

## Acceptance gates

Proposed targets only; none has been measured in this research:

- Named representative iPhone and Android devices, browser versions, input sizes, pack versions, and warm/cold state recorded.
- Warm index lookup: p50 at most 5 ms and p95 at most 15 ms per rectified crop. Report feature extraction, detection, verification, and temporal stabilization separately.
- Preview at least 24 fps while processing 5–10 detection cycles per second, with no growing queue.
- Stable, focused card to confident auto-add: p95 at most 1 second; clean nine-card page settled within 3 seconds.
- Held-out auto-add precision target at least 99.5%, with coverage and abstention reported separately. Set thresholds from held-out real captures, not similarity-to-percentage conversion. A small synthetic test does not establish that precision.
- Test glare, sleeves, rotation, oblique angles, low light, clutter, unknown cards, missing references, same-art reprints, duplicate copies, interrupted camera sessions, page re-entry, and storage eviction. Confirm network-off operation after pack installation.

## Data and publication constraints

- OpenCV is Apache 2.0 from version 4.5 onward; ONNX Runtime is MIT. Preserve required notices. [OpenCV license](https://opencv.org/license/), [ONNX Runtime license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)
- TCGdex labels its database MIT and asks consumers to cache bulk responses. Its images are hosted separately. Database/code licensing is not proof that every third-party card illustration is freely redistributable. [Database repository](https://github.com/tcgdex/cards-database), [FAQ](https://tcgdex.dev/faq)
- YGOPRODeck explicitly requires downloading/storing images rather than continual hotlinking, and sets its API limit at 20 requests/second. Its English image coverage and artwork records do not resolve every physical printing. [API guide](https://ygoprodeck.com/api-guide/)
- Scryfall permits value-added Magic software/research, prohibits bare data repackaging and paywalls, and places restrictions on altered displayed card art and attribution. Its API guidance requests fewer than 10 requests/second and bulk files for large workloads. [Data and images terms](https://scryfall.com/docs/api#use-of-scryfall-data-and-images), [API access guidance](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17)

No reviewed provider text expressly addresses redistribution of compact image-derived recognition descriptors. A value-added scanner index is a plausible use under these policies, but that is an inference, not confirmed permission. Keep raw artwork and publisher assets outside the application's open-source license, record source terms, and resolve distribution uncertainty before publishing generated packs. This research did not publish any packs or contact providers.

## Addendum after physical photo failures

The implementation lead reported zero detected quads on the 1080×1317 CC0 tabletop photo of sleeved/slabbed Pokémon cards, and three detections rejected by quality checks on a separate licensed Magic binder photo. These are real-scene failures. They invalidate any claim that synthetic reference-image transformations alone establish scanner readiness. Research inspected the tabletop image; the implementation/evaluation workers own the reproducible test results.

### Recommended pretrained detector trials

**Small crop refiner: fastweb-single 1.39.** The author's [model card](https://huggingface.co/HanClinto/ccgdetector-fastweb-single) and live model API declare MIT. EfficientViT-B0 with a SimCC corner head has approximately 0.77M parameters and expects 384×384 RGB with ImageNet normalization. The actual file metadata reports **3,185,226 bytes**, SHA256 `05d2b90b928a5a3bf0f49aa90aa86211b2103d9c347c238fd18b4f544b3cb8ca`, at commit `66ffd4976ec57bda0f6ea2d83e15ca6a3add7dd9`. [Pinned weights](https://huggingface.co/HanClinto/ccgdetector-fastweb-single/resolve/66ffd4976ec57bda0f6ea2d83e15ca6a3add7dd9/fastweb-single-1.39.onnx).

It predicts one card's four corners, not multiple cards. Use it as a single-card detector or crop refiner after automatic proposals. The compatibility presence output is constant 1.0; it must never be interpreted as confidence. Its sharpness output measures peaks in corner-coordinate distributions, not optical focus or a calibrated probability. The author's 8.4 ms CPU result is a model-comparison benchmark, not our browser/phone measurement. No standalone LICENSE file was present; preserve pinned model-card license evidence and notices. Run it through an independently written ONNX adapter, without importing the AGPL CollectorVision library.

**Permissive multi-card baseline: Cardstream Seg Nano.** Ximilar's [model documentation](https://github.com/Ximilar-com/cardstream/blob/main/model/README.md) explicitly grants Apache-2.0 separately to its trained weights and architecture. The RF-DETR Seg Nano export is approximately 125 MB, with a verified release archive size of **113,620,517 bytes**. Input is float32 RGB NCHW `[1,3,312,312]`, plain resize, `/255`, then ImageNet normalization. It emits 100 query boxes, two-class logits including the final no-object class, and 78×78 masks for each query. Match masks by original query index; each mask covers the full input, not an individual ROI. Upsample and threshold logits above zero.

The model can provide multiple proposals even though Cardstream's existing application selects one. Its published roughly 82 ms latency is for an Apple M-series CPU. Neither mobile speed nor our scene accuracy is established. [Release asset](https://github.com/Ximilar-com/cardstream/releases/download/v2.0.0/cardstream-segmentation-v2.tar.gz); archive SHA256 `c740782cdab1a65408b6fd55fe6e9a5070307189e036361597201714eb3bce61`. Preserve the [NOTICE](https://github.com/Ximilar-com/cardstream/blob/main/NOTICE). The paid identification endpoint is not needed to evaluate these local detector weights.

**Do not substitute these without resolving their terms:** [Cornelius](https://huggingface.co/HanClinto/cornelius) is AGPL-3.0 and one-card-only; [TCGscanner detector](https://huggingface.co/Adrihp06/TCGscanner-detector) lists an unspecified “other” license; [Cardcaptor v3](https://huggingface.co/AlecKarfonta/cardcaptor-v3) is MIT-labeled but uses Ultralytics YOLO11, whose upstream [licensing documentation](https://docs.ultralytics.com/models/yolo11/) states AGPL/enterprise terms. Do not assume its label clears the upstream chain. An optional download button alone does not establish that AGPL obligations disappear. Prefer the two candidates above; if an AGPL component becomes necessary, make a deliberate licensing decision rather than silently retaining an MIT-only claim.

### Changes to investigate without weakening identity verification

- Separate proposal recall from match acceptance. Four fully visible corners and a narrow projected aspect ratio are poor prerequisites for foreshortened or partially covered cards. Permit rough proposals; require later evidence for identity.
- Preserve source resolution for crops. Downscaling the tabletop image to a maximum dimension of 960 turns 70–130 px source widths into roughly 51–95 px. This puts smaller cards near the current 48 px edge threshold. A 312 px whole-frame model makes them smaller still. Test overlapping tiles with global coordinate mapping and deduplication, recognizing that more tiles increase compute. Upsampling cannot restore absent image detail.
- Refine the inner card rather than the plastic slab. A semantic mask may improve proposals, but visible masks of occluded cards are not necessarily complete card quadrilaterals. Do not force every silhouette into a plausible full-card warp.
- Keep the preview smooth and track between detector passes. For insufficient detail, live “move closer” guidance is preferable to guessing an identity or demanding manual crops.
- The true foreground Charizard reportedly leaves the eight-item hash shortlist when references increase from 155 to 2,000. This is an independent retrieval-recall problem. Measure recall@K before tightening geometric verification. A local ORB-voting fallback may recover candidates; it must retain existing acceptance gates and undergo real-photo/negative tests.

Next decision should follow a frozen real-scene comparison: detector recall by card size/occlusion, corner accuracy, shortlist recall, final accepted precision, empty-scene false proposals, and browser p50/p95 latency and memory. No candidate above has yet been validated by this research. No application code, model execution, or model publication was performed here.
