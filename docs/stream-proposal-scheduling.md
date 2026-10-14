# Explicit single-card proposal scheduling

## Scope

`VisionOptions.mode: "stream"` is the UI's “One card after another” mode. It now requests one whole-frame Fastweb inference per proposal refresh. It still runs the unchanged OpenCV contour detector (cap nine), groups all retained contour and Fastweb hypotheses, and verifies the focused group's hypotheses against every shortlisted rival. It does not simply accept the one proposed card.

`binder`, `photo`, and calls with no explicit mode retain the full-frame plus nine tiled Fastweb windows. The existing `pack` mode retains its fresh, single-frame proposal without contours. Stream's 1,500 ms geometry-only cadence and image-change invalidation remain intact. Switching between omitted mode and explicit stream clears the cache; their different proposal coverage cannot leak across modes.

Fastweb preprocessing, model bytes, corner validation, XFeat extraction, similarity thresholds, RANSAC, artwork/spatial gates, rival comparisons, and current-frame evidence are unchanged. This patch does not modify quantity, current-view/liveness, printing, or storage code. Fastweb's constant presence output is still ignored.

## Mechanical verification on 2026-10-14

Focused installed-local Vitest run: **53 passed, one skipped** across `learned-engine.test.ts` and `learned-models.test.ts`. The skipped test requires separately supplied model-parity artifacts; it was not run or treated as a pass. Focused ESLint, application TypeScript, and tools TypeScript checks passed.

The tests cover:

- Exactly one whole-frame window in explicit stream/pack; ten in full/default
- Stream retaining all contour hypotheses and evaluating every focused hypothesis and all eight rivals, including after a soft-budget overrun
- Fresh crop, identity, and rival evidence when geometry is reused in either binder or stream
- Fail-closed behavior for excess one-card proposals or unreadable rivals
- Full ten-proposal coverage for binder/photo/omitted mode even with `maxCards: 1`
- Fresh proposal passes when switching between full/default and stream profiles

A separate local Node experiment used the actual pinned, integrity-checked **ORT Web WASM** models, single threaded, with no browser, network, or external artwork. Input: the repository's original `syntheticCard(1)`, OpenCV bilinear-resized to 480×672 and placed at (300, 204) on a 1080×1080 RGB(40, 50, 55) background. RGBA SHA-256: `dca005d2ceee922cf485a9b4c5a9327b10d083acc08eba25d095510f9ffcf6cd`.

After one stream warmup, alternating/profile-paired samples were:

| Profile | Fastweb inferences | Retained proposals | Proposal time, ms |
| --- | ---: | ---: | ---: |
| full | 10 | 10 | 1128.66 |
| stream | 1 | 1 | 82.06 |
| stream | 1 | 1 | 81.53 |
| full | 10 | 10 | 805.65 |
| full | 10 | 10 | 796.93 |
| stream | 1 | 1 | 84.12 |

The full-frame quad was numerically identical in all six runs. The deterministic inference-count reduction is 90%; sample median proposal time was 805.65 ms for full versus 82.06 ms for stream. These are three observations per profile on one cloud CPU fixture, including input preparation and proposal filtering, not a robust latency benchmark or end-to-end save measurement.

## Optical and release limits

The change deliberately removes nine alternative tiled views in explicit one-card mode. A small, off-center, occluded, glared, or perspective-distorted card might be localized only by a tiled view when contours and whole-frame Fastweb fail. Recognition recall can therefore regress even though acceptance thresholds are unchanged. Existing contours provide additional hypotheses but do not establish optical equivalence.

The initial implementation benchmark did not include physical-card, held-out-photo, phone-camera, thumb-occlusion or end-to-end browser save tests. Subsequent actual cloud-browser replays are documented in [Phase 2 controlled browser validation](phase2-validation.md), including fixed distance/tilt/occlusion inputs, conservative counts, an actual prompt/reveal response and the failed earlier iteration. Those known-art synthetic development trials do not establish physical-phone or held-out accuracy. The earlier reports in `learned-validation.md` describe their tested builds and do not certify this profile change. Before broader claims, compare representative small/off-center physical cards, glare and occlusion, and measure first save, identity errors, duplicate counts and current-view cancellation. Binder/photo retain their prior proposal coverage.
