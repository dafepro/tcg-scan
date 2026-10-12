# Current-ROI continuity experiment

## Status

`src/lib/vision/roi-continuity.ts` is integrated into the learned scanner through a serialized worker protocol and a bounded real-capture history. The Quick-mode integration is still undergoing independent browser safety and performance checks. It takes the existing initialized OpenCV instance. It loads no runtime, model, dependency, network resource, or browser process, and does not change identity acceptance thresholds.

Its intended role is narrowly bounded: after one unchanged strong geometric identity verification, test whether the same observed card appearance can be continuously measured through independently captured subsequent frames, including the current capture. The result is a current-geometry continuity check, **not another identity observation**. Quick mode requires one existing strong identity verification and this separate current-view proof. Strict mode keeps three fresh identity observations and additionally requires the same current-view proof. Neither policy changes the identity matcher thresholds.

No detector presence score, learned corner proposal, unknown/no-match result, or lack of detections participates in the proof. This module never emits exit or absence evidence, and it must never release a counting latch. Background texture is deliberately unnecessary.

## API

Create one `RoiContinuityGuard(existingCv, options?)` per verified presentation/ROI. Multiple guards may reuse the same worker's OpenCV instance; do not start another runtime for them.

1. Call `arm({ eventId, geometryVerified: true, quad, frame })` with the **exact identity-verified capture and geometry**, projected into that capture's low-resolution coordinates. A detector proposal alone cannot supply `geometryVerified`.
2. Call `replay(readonlyFrames, latestCapture)` with the ordered, genuinely captured history after the seed. The input is a supplied immutable array; the guard retains no video ring. Replays can be split into small chronological batches.
3. Read the discriminated result:
   - `continuous`: the sole usable proof state. Includes the seed and latest capture IDs, latest timestamp, measured `latestQuad`, supporting-point count, capture duration, bounded lighting fit, and processing time.
   - `pending`: no usable proof yet. More captures, more capture duration, or a genuinely fresh tail are required. A stale result stays pending while preserving the measured state so the next captured tail can catch up.
   - `rejected`: no usable proof. Tracking failures and malformed replay permanently cancel the guard. Callers must not silently recreate it from the same old seed after lost continuity.
4. Call `invalidate("paused" | "hidden" | "source-changed" | "explicit")` on interruptions, lost history, source changes, or session changes. Call `dispose()` on unmount. Invalidation permanently closes this single-presentation guard; late replay and late arming cannot revive it.

Every result explicitly includes `identityObservations: 0` and `exitEvidence: false`. A result must not be adapted into a synthetic identity detection to satisfy an existing multi-observation threshold. It also does not confirm a printing beyond the original identity verifier's evidence.

### Captures, ordering, and freshness

A frame has `gray: Uint8Array`, `width`, `height`, `frameId`, and `timestampMs`. It is grayscale, with each dimension at least 64 and the longest edge at most 640. Coordinates are in the unmirrored captured pixels, not CSS preview coordinates. The caller owns downscaling and coordinate mapping.

Assign consecutive IDs to the **sampled capture stream**, not to inference completions or every underlying camera frame. A real frame acquired by the sampler advances the ID and monotonic capture timestamp. Missing sampled IDs, duplicated/reordered IDs or timestamps, dimension changes, or excessive capture gaps reject the supplied batch before any partial proof is exposed.

Identical pixels can be genuine fresh still captures. They are accepted when their real capture IDs/timestamps advance. Re-labeling an old cached buffer is prohibited: no pixel-only algorithm can distinguish a legitimate perfectly identical fresh capture from a replay with invented capture metadata. The capture-history producer must enforce provenance.

`latestCapture` has `{ frameId, timestampMs, checkedAtTimestampMs }`. Its capture ID/time must exactly match the final supplied capture or the guard's current capture for an empty batch. `checkedAtTimestampMs` must:

- Use the same monotonic clock as the captures.
- Be measured when the worker actually runs this check, not when a request was queued before a long inference.
- Be no earlier than the capture timestamp or a previous freshness check.

The guard adds its own measured replay cost to the declared age. A proof is withheld when the latest frame is too old. Intermediate historical batches can therefore be pending until a current tail has been replayed. Empty replays or re-reading a result cannot create more post-seed observations.

The consumer must still verify the event, session/source generation, returned latest capture, and current age before acting. A camera can capture newer frames while a worker is busy or a response is in transit. Reject an out-of-date result or replay the new genuine tail. A caller-supplied stale clock cannot establish present-time freshness.

## Measurement and acceptance rules

The installed OpenCV build supplies Shi–Tomasi `cornerMinEigenVal`, Lucas–Kanade `calcOpticalFlowPyrLK`, and `estimateAffine2D`. The guard uses them without modifying the existing exit tracker or identity verifier.

### Geometry

- Require an initially convex, fully visible quad of at least 1,200 low-resolution pixels, with at least an 8-pixel preview margin throughout tracking.
- Select up to 48 grid-distributed original Shi–Tomasi features inside the card. At least 20 features, all four card quadrants, a convex hull covering 42% of the card, and 65% of both bounding-box dimensions are required.
- Track forward and backward with a 15×15 LK window and two pyramid levels. Forward/backward error is at most 0.7 pixels; LK mean errors are at most 35 intensity units to permit the separately checked bounded lighting changes. Point and quad-corner motion per sampled step are limited to 24 pixels.
- At least 85% of the original features must survive. Fit from original seed points to current measured points, require at least 90% affine inliers with residual no more than 0.9 pixels, and retain the same spatial support.
- Seed-relative axis scales are limited to 0.92–1.08, normalized shear to 0.05, and rotation to 0.18 radians. Large perspective changes fail closed.
- No feature reseeding, predictive exit, identity reacquisition, replacement template, or learned constant-presence score is used.

### Appearance and lighting

Immutable seed appearance is sampled at up to 192 dense card-interior anchor locations, using 5×5 patches. These cover relatively flat card areas as well as textured regions. Each current patch is sampled using the measured affine geometry.

A single card-wide intensity gain/offset is fitted against the original seed. Gain must stay within 0.8–1.2 and offset within ±24 grayscale levels. Both seed/current intensity variance must remain at least 100, normalized correlation at least 0.97, total fitted residual RMS at most 9, and no more than two anchor patches may exceed RMS 15. The template is never updated to learn a replacement card.

These limits admit the tested ±1–2 pixel translation jitter, +14/−14 brightness shifts, and a 0.95 gain with +12 offset. They reject the tested different-art swap, partial occlusion, local glare, removal, blank frame, excessive illumination change, and altered low-feature region. Those are original synthetic controls, not photographic coverage or a guarantee that every tiny occlusion is detectable.

Camera and card translation are observationally interchangeable without other information. Both can retain valid current card continuity when the card remains visible. This is acceptable for this narrow presence check, but **neither can produce exit evidence**. Two physically identical copies or a visually indistinguishable swap between captures cannot be distinguished; the evidence concerns observed appearance continuity, not unique physical ownership.

## Bounded resources and replay

Defaults and hard limits:

| Bound                                         |    Default |     Hard allowed limit |
| --------------------------------------------- | ---------: | ---------------------: |
| Post-seed samples per guard                   |        120 |                    120 |
| Capture duration from seed                    |  12,000 ms |              12,000 ms |
| Gap between sampled captures                  |     300 ms |                 500 ms |
| Minimum capture duration                      |     160 ms | Cannot be below 100 ms |
| Minimum post-seed captures                    |          2 |             Fixed at 2 |
| Latest-frame age, including replay            |     300 ms |                 500 ms |
| Supplied replay bytes plus current gray frame |     32 MiB |                 32 MiB |
| Longest image edge                            | 640 pixels |             640 pixels |

Only one previous grayscale frame is retained per active guard. The seed survives as bounded geometry, at most 48 point tracks, and at most 192 small appearance patches. Input arrays are not retained. The current image and native optical-flow/affine matrices are temporary and freed after each step; lifecycle cancellation releases all native frame and patch state. Seed pixels/geometry are copied, and returned quads are detached from internal state.

Use the separate capture-history owner to retain and clear the bounded camera history. Do not duplicate its ring inside the guard, retain a parallel RGBA history, create another OpenCV instance, or run unlimited guards. Binder integration must cap independent ROI guards and run them through the existing serialized worker. Image downscaling/capture, transfer ownership, WASM memory high-water behavior, and renderer OOM controls still require separate integration validation.

## Tests and synthetic timing

```sh
npx vitest run src/lib/vision/roi-continuity.test.ts --maxWorkers=1 --no-file-parallelism
TCG_ROI_BENCHMARK=1 npx vitest run src/lib/vision/roi-continuity.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --disableConsoleIntercept
```

There are 35 tests, using the actual shared Node OpenCV instance and original geometric artwork. They cover still/identical fresh captures on a completely textureless background, jitter, moderate lighting, changed-card swaps, partial occlusion, glare, changed flat regions, blanks/removal, no-motion duration requirements, stale results, processing-time freshness, duplicate/reordered/missing samples, incomplete latest history, lifecycle cancellation, resolution/preview clipping, camera/card translation without exit evidence, two independent identical-card ROIs, caller-buffer isolation, delayed batched replay, and resource/overflow bounds.

One warmed 2026-10-12 cloud Node run at 640×480 measured four ten-frame jitter batches after one warmup batch: 6.75 ms mean per replayed frame, 8.31 ms for the slowest batch's per-frame mean, and 8.53 ms mean arm initialization. These measurements exclude camera capture/downscaling, identity inference, worker transport, durable saves, rendering, and capture-history storage. They are not browser/mobile guarantees or photographic accuracy measurements. These module measurements preceded integration. Browser integration evidence and remaining gates are recorded in [learned validation](learned-validation.md).
