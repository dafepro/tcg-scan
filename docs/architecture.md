# Architecture

## Continuous visual path

1. `ContinuousScanner` starts the requested camera after a user action. It initializes a persistent `VisionClient` worker and loads the selected game's installed reference shards from IndexedDB. No recognition request uploads a frame.
2. `vision/engine.ts` finds quadrilateral card regions, rectifies perspective, measures quality, extracts local hashes and ORB features, shortlists indexed references, and verifies feature geometry with RANSAC. Unknown references and insufficient/ambiguous geometry never become eligible solely because they are the nearest candidate.
3. `scan-session.ts` uses global one-to-one spatial/identity track assignment, rejects out-of-order frame replies, requires three eligible observations spanning 250 ms, and creates one event ID per physical presentation. Counted identical identities are conservatively reused within an epoch, preserving the maximum simultaneously seen copies rather than recounting camera pans. A short dropout preserves counting; stream mode rearms after 1.2 seconds with no detected card regions. That is observed detector output, not proof that the camera view is physically empty: prolonged blur/glare can rearm it. Binder mode requires explicit new-page reset and is safer for a layout that should never recount automatically.
4. `scan-inventory.ts` creates an idempotent event row with unknown condition/finish and identity-only verification. App integration validates and synchronously writes storage before acknowledging a durable success. Undo targets the exact scan event. The selected image reference is not proof of exact physical printing, finish or authenticity.
5. `pricing.ts` retrieves provider quotes independently after an accepted match. A cached result may display immediately while refreshing. Variant, currency, catalog-vs-printing scope and source timestamps remain explicit. Identity-only entries are excluded from valuation totals.

The browser worker accepts one in-flight frame. The UI drops work instead of queuing stale frames. Pause, hidden tabs, stop, navigation, game changes and unmount prevent late saves. Video and overlays share the same full-frame geometry without CSS cover-cropping or mirroring.

## Reference data

`reference-packs.ts` validates data-only feature packs, bounds per-shard size/counts, stores checksummed packs in IndexedDB and verifies same-origin prebuilt downloads. Installed and loaded coverage are distinct. No full catalog is bundled, and a fresh source install has zero local visual references.

`scripts/build-index.mjs` builds resumable descriptor shards from provider catalog metadata and locally cached source images using the same preprocessing as the browser. Raw artwork is never committed. Generated-feature redistribution rights are separate from the application's MIT source license. See [reference packs](reference-packs.md) and [recognition design](continuous-recognition-architecture.md).

## Assisted path and collection

`Scanner` / `recognition.ts` remain the local English OCR fallback. Text candidates go to `catalog.ts`, then explicit Review confirmation. Catalog requests have pacing, timeouts, expiry and strict URL validation.

`storage.ts` reconstructs imported app data field-by-field, validates aggregate limits, and persists version-1 JSON in localStorage. Existing backups remain compatible. A changed storage snapshot or another-tab event pauses writes to protect against stale overwrite; this is not a multi-user database or a cross-tab transaction protocol. JSON exports preserve collection/review/decks; CSV protects against spreadsheet formula injection.

## Limits

Spatial tracking cannot prove that an identical physical card is a different copy after leaving view. Binder pans/crossing cards can confuse assignment; use one stable layout and verify counts. Classical visual evidence and synthetic replay tests are not calibrated recognition probabilities or held-out physical-card accuracy. The UI reports measured processing time and exact loaded reference count. Browser storage quotas, cache eviction and origin changes can lose local data, so export collections regularly.

All application code and visual design are independently authored. Card data, artwork and trademarks retain their own rights and attribution requirements.
