# Verified inner-region exit tracking

## Status and scope

`src/lib/vision/exit-tracker.ts` is a standalone, experimental evidence module. It is **not connected to the scanner, inventory, UI, or worker protocol**. Identity acceptance thresholds are unchanged. No browser process, model, detector, network request, new dependency, or second OpenCV runtime is created by this module.

The learned corner model's empty-frame behavior must not be used to release an inventory latch. An unknown match, unmatched crop, missing detection, no corners, feature loss, washed-out image, or prediction beyond the camera edge is not absence evidence.

Instead, the module follows points on a previously geometrically verified card and can emit one `verified-roi-exit` for that presentation's event ID. It proves that the continuously measured card moved completely outside a specified inner scan rectangle while the entire card remained visible in the surrounding preview. It does not prove absence from the whole camera, identify a physical copy, or add inventory.

## API and coordinate contract

- Construct `VerifiedCardExitTracker` with the **existing initialized OpenCV runtime** and a normalized `region: { left, top, right, bottom }`.
- `arm({ eventId, geometryVerified: true, quad, frame })` accepts only the exact capture and quadrilateral used by the existing geometric identity verifier. It returns `{ armed, reason? }`. A detector proposal alone must never supply this assertion.
- `frame` contains `gray: Uint8Array`, `width`, `height`, `frameId`, and `timestampMs`. Width and height are at least 64; the longest edge is at most 640. The caller owns downscaling and grayscale conversion. The module copies retained pixels; it does not retain the caller's buffer.
- The quad uses pixel coordinates in that exact low-resolution, unmirrored capture. The region is normalized in that coordinate system. Preview mirroring, rotation, cropping, and `object-fit` require an explicit UI coordinate mapping.
- `ingest(frame)` returns exits, cancellations, an ignored flag, and measured processing time. Frame IDs and capture timestamps must increase strictly. Timestamps are monotonic capture times, not inference completion or wall-clock times.
- `invalidate(reason)` cancels continuity without emitting exit or clearing used event IDs. Call it for pause, hidden page, source changes, discarded history, and interruptions. Call `dispose()` on unmount; a disposed tracker cannot arm again.
- A cancellation must leave the existing counting latch closed. Only an emitted exit can release the matching event latch. A fresh presentation still needs a new event ID, identity verification, normal counting rules, and a successful durable save.
- Successfully armed IDs are never reused or evicted. An explicitly new scan session may create a new tracker; cancellation must not silently create one to rearm a counted card.

Arming must start with the complete convex quad at least 3 pixels inside the inner ROI. The quad area must be at least 1,200 low-resolution pixels. It must fit in at least one preview strip outside the inner ROI, allowing the required margins. Overlapping armed rectangles with bounding-box IoU over 0.05 are refused; tracks that later overlap beyond that bound are cancelled.

The inner ROI must be visible to the user. For a horizontal exit, a card must fit both inside the box and in a left or right preview strip. A centered box therefore generally needs a card narrower than roughly one third of the preview. A close-up filling most of the camera cannot provide this proof. Moving toward a strip that is too narrow cancels rather than extrapolates an exit.

## Conservative measurement rules

The installed `@techstark/opencv-js` build exports `cornerMinEigenVal`, `calcOpticalFlowPyrLK`, and `estimateAffine2D`, but not `goodFeaturesToTrack` or `estimateAffinePartial2D`. The module uses the available Shi–Tomasi minimum-eigenvalue scores, grid-distributed point selection, and distance suppression. It then runs a single batched forward/backward Lucas–Kanade pair for the background and all active cards.

Current bounds, in low-resolution pixels unless stated otherwise:

- Up to 48 original features per card and 48 background features; up to 9 active cards, hence at most 480 tracked points.
- No feature reseeding, identity reacquisition, or replacement-patch learning during an arm. Immutable 7×7 seed patches remain the appearance anchors.
- Forward/backward error at most 0.65 pixels; LK mean errors at most 12; measured per-step displacement at most 24 pixels.
- At least 20 supported card points and 85% of the originally selected points must survive. Affine fitting requires at least 90% inliers with residual at most 0.9 pixels.
- Inliers must span all four card quadrants, at least 42% of its area by convex hull, and at least 65% of both bounding-box dimensions.
- Affine scale along each axis remains within 0.92–1.08 of the verified seed, normalized shear at most 0.05, and rotation at most 0.18 radians. Large perspective changes are deliberately unsupported.
- Immutable seed-patch RMS error must be at most 20 intensity units and current patch contrast at least 8. Severe glare, occlusion, blanks, and appearance substitution fail closed.
- The entire current quad must stay at least 10 pixels inside the preview edges. No corners are predicted beyond a clipped preview.
- The full quad must be more than 3 pixels beyond one side of the inner ROI. The same condition must hold after measured background-translation compensation. A center crossing or partial overlap is insufficient.
- Exit requires at least three genuinely moving observations overall and two moving observations fully outside, separated by at least 60 ms. Card-relative movement must be at least 0.6 pixels for a sample to advance this evidence. A repeated buffer, new timestamp on an old image, stationary card, or sensor-noise-only frame cannot satisfy it.

### Small handheld translation versus camera pan

The background must retain at least 16 features, at least 70% of its original features, all four image quadrants, and a convex hull covering 35% of the image. A textureless desk may prevent arming; lost background support cancels continuity.

The median measured background translation may be within **±2.25 pixels on each axis relative to its original positions**. Its per-frame change may be at most **4.5 pixels per axis**. Background-point residuals against that translation must be at most 0.65 pixels; three inconsistent measured anchors cancel the arm, as does insufficient remaining spatial support.

Card motion is measured after subtracting that translation. This admits the tested alternating ±1 and ±2 pixel horizontal/vertical global jitter while refusing sustained drift: a one-pixel-per-frame pan cancels when its total reaches three pixels. These are absolute seed-relative limits, not per-frame allowances that a slow pan can accumulate.

This does not require a perfectly immobile device, but it is not general handheld stabilization. Rotation, perspective jitter, rolling shutter, moving backgrounds, autofocus changes, or larger translation may cancel. A translating camera and an oppositely moving scene can be observationally identical. Two physically identical copies, or a perfect visually identical swap between captures, also cannot be distinguished from pixels alone. These are presentation events, not proof of unique physical ownership.

## Resource and continuity limits

- One previous grayscale frame is retained; no frame history is stored inside the module. New frames, optical-flow matrices, and pyramids are temporary. Maximum source dimensions are 640×640.
- The default event ledger holds at most 1,024 successful arms, configurable only up to 4,096. When full, additional arms are refused rather than evicting IDs and risking repeated exits.
- The default maximum capture gap is 300 ms, configurable only up to 500 ms. Duplicate/reordered IDs or timestamps, size changes, and longer gaps cancel all continuity.
- Default tracked capture lifetime is 30 seconds; the configurable hard maximum is 60 seconds. A long static presentation can therefore expire conservatively.
- Repeated identical pixels do not advance the last genuinely observed capture time. If buffers stall long enough, the capture-gap rule cancels.
- All cards share one batched optical-flow operation per ingested frame. Card histories consist only of seed geometry/patches, current points, counters, and timestamps.

## Proposed single-worker scheduling integration

This section is an integration recommendation, not implemented production behavior. Renderer crash isolation and real browser/resource checks remain prerequisites.

1. Keep the existing CV worker and its existing OpenCV instance. Do not import another runtime into the UI or start a second heavy worker merely for tracking.
2. Capture actual low-resolution grayscale frames at approximately 10 Hz while expensive identity inference is busy. Assign IDs and timestamps at capture. Keep a ring bounded by **120 frames, 12 seconds of capture history, and 32 MiB**, whichever fills first. At 640×480 this memory cap allows 109 grayscale frames, approximately 10.9 seconds at 10 Hz. Lower-resolution operation needs separate accuracy validation before adopting it.
3. Preserve an ordering barrier for a pending identity capture. After its durable save succeeds, replay any earlier buffered frames up to that capture, arm its event from the exact verified quad/capture, then replay genuinely captured subsequent frames in order. Do not process existing tracks beyond a pending arm's seed and later attempt to rewind them.
4. Delayed identity/save processing is compatible with the API because decisions use capture time, not processing time. The module imposes no wall-clock inference timeout. The proposed ring places an integration latency bound of 12 seconds, or less if the count/byte cap fills. Discarded intermediate history, capture gaps, missing seed pixels, or an exceeded cap must cancel, never skip ahead and claim continuity.
5. Drain small bounded replay batches between heavy analyses, yielding between batches. After replaying the same frames for all current arms, release their buffers. Transfer or reuse a single grayscale buffer where possible; do not keep a parallel RGBA history.
6. Capture, saved-result callbacks, and worker requests must carry the same session/source generation. On pause, hidden page, unmount, or source change, invalidate, discard the ring, and reject late results from the old generation. A delayed saved result must not arm from an old session after a lifecycle interruption.
7. Apply an exit only to its corresponding event. It must not reset a whole binder page or all cards of the same identity. Another simultaneously visible copy keeps its own latch. After an exit, require a fresh verified presentation before another automatic addition.

The same ordering rule applies when arming several saved cards from one capture: arm all eligible, non-overlapping events at that capture before replay moves past it. The API refuses stale seeds against existing active tracks rather than inventing correspondence.

## Validation and reproducible synthetic cost

Run the standalone tests with one Node OpenCV runtime:

```sh
npx vitest run src/lib/vision/exit-tracker.test.ts --maxWorkers=1 --no-file-parallelism
TCG_EXIT_BENCHMARK=1 npx vitest run src/lib/vision/exit-tracker.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --disableConsoleIntercept
```

The 31 tests cover full exit and a fresh same-identity presentation; partial exit; blank/occlusion/glare; different-card substitution and motion swap; repeated and noise-only frames; capture reordering and gaps; fast and slow camera pans; genuine exit with ±1/±2 pixel global jitter; stationary-card jitter; preview clipping; startup outside the ROI; unverified seeds; missing texture/guard band; lifecycle invalidation; simultaneous identical cards; overlapping event seeds; delayed replay and its ordering barrier; and resolution, point, event, and age bounds.

One warmed Node run on 2026-10-12, using original geometric synthetic artwork and a textured synthetic table at 640×480, measured 69 ingested frames per case after one warmup sequence:

| Active cards | Mean ingest |  Median |      p95 |  Maximum |
| ------------ | ----------: | ------: | -------: | -------: |
| 1            |     7.90 ms | 7.60 ms | 10.23 ms | 17.30 ms |
| 2            |     9.29 ms | 9.09 ms | 11.15 ms | 12.16 ms |

These timings include tracker ingest, flow, appearance/geometry validation, and frame copying. They exclude camera capture/downscaling, arm initialization, identity inference, durable saves, worker transport, rendering, and replay queueing. They are synthetic Node measurements on the shared cloud CPU, not browser/mobile performance guarantees, nine-card performance measurements, or photographic recognition accuracy. No browser test was started for this module.
