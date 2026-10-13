# Research implementation status

This candidate follows issues [1](https://github.com/dafepro/tcg-scan/issues/1) and [2](https://github.com/dafepro/tcg-scan/issues/2). This source checkpoint follows `e398855`. A checked-in module is not evidence of physical recognition accuracy or public deployment.

## Implemented in the candidate

- Runtime-only packaging removes unused OCR alternatives and the duplicate emitted ORT WASM while preserving both actual LSTM loader outcomes, verified embedded WASM, base-aware fallback paths, model bytes and recognition policy. The separately frozen runtime build measured 55,556,127 bytes, versus 91,976,464 bytes: 36,420,337 bytes less deployment inventory. These previously unused files were not cold scan transfers.
- The database installer accepts browser-decoded Zstandard responses under the same decoded-byte, checksum, MIME, redirect, origin and rollback checks as other supported encodings.
- Native printing-region instrumentation preserves the existing game zones, downscale-only crop geometry and original capture lineage. Descriptive measurements do not establish readability, glare, foil or calibrated quality thresholds. OCR remains the pinned original English reader.
- Provider snapshots receive a SHA-256 semantic content ID with provider scope, fetch time, stale/completeness state and candidate count. Reordering already-keyed candidates does not change the ID; new siblings or discriminating-field changes do. YGOPRODeck keys currently contain provider row indexes, so a reordered provider response can still change the snapshot ID and conservatively require review.
- A successful existing catalog-printing read now durably saves bounded literal OCR, normalized lookup fields, original capture IDs/fingerprints, reader configuration and catalog provenance. No camera image is added to backups. Version-1 collection backups are migrated additively: legacy rows remain unversioned and identity-only.
- A catalog-status comparison requires review after a snapshot change, stale response or incomplete coverage. It preserves the old evidence instead of rewriting history. Automatic background re-evaluation and review UI are not connected yet.
- A pure next-useful-view planner and scoped discriminator interface are implemented. The default reviewed-rule registry is empty; no physical stamp, symbol, finish or back-side detector is enabled. See `capture-guidance.md` for the tested policy and evidence needed before enabling rules.
- A pure variant-market scope validator separates mapped provider product/variant keys, physical facet assertions, catalog version, quote metric/currency and provider/fetch dates. Missing detailed quotes cannot fall back to root-card prices. This foundation is not connected to collection valuation and always returns `physicalValuationEnabled: false`.

## Evidence already established separately

- Actual cloud Chromium wire tests exercised gzip/Brotli/Zstandard and fail-closed integrity, size, cancellation and timeout handling. Final public-host negotiation remains unverified.
- With a persistent browser profile and unchanged original headers, a warm reload reused the large worker and revalidated the WASM with zero HTTP response-body bytes. An earlier off-the-record test retransferred those resources; it was not proof of a deployed caching defect. No cache-policy rewrite is justified by it.
- A controlled 36-read comparison found no exact recovery of the two tiny physical footers with baseline, best_int or fast English assets. Smaller language files and faster initialization do not justify a default change or an OCR accuracy claim.

## Experimental, never substituted for production

The bounded learned-head experiment uses existing XFeat and 256 fitting/64 identity-disjoint synthetic-validation groups, four actual image augmentations, fixed training and unchanged verification gates. Its retrieval and verifier results, all arms and resource measurements are reported separately. The 67 physical crops remain reused development regressions. Index byte arithmetic excludes the large detailed verifier; neither a small head nor a small proposal index proves tiny full-catalog offline recognition.

The earlier on-demand verifier prototype remains experimental: cold occurrence recall failed and candidate-record demand stayed large. The earlier compact VLAD pilot and blind point-halving were rejected by their frozen gates. No acceptance thresholds are loosened to compensate for these failures.

## Explicitly not delivered

- A new compact full-catalog offline recognizer or new card-trained RGB backbone
- A calibrated small symbol/footer/material classifier
- Automatic exact physical finish/edition, authentication, professional grading, or valuation
- Proven benefit from guided acquisition on new physical user/card interactions
- Automatic Pack refinement from multiple same-name captures: the current Pack identity latch does not prove the same physical copy. Retained capture lineage and same-copy association need their own adapter/tests.
- Real iPhone/Android latency, thermal, memory or camera measurements
- A live public deployment, offline browser restart guarantee, or a small functioning reference-free scanner

Keep useful partial identities, unknown facets and `priceEligible: false`. Broaden each supported physical slice only after collecting the required hard-pair evidence and freezing the final resolver, catalog and prompt policy.

## Bounded learned-head outcome (completed)

One 256→128 linear supervised-contrastive head was genuinely trained using 256 normalized-identity groups and four prescribed image transforms; 64 disjoint groups were reserved for synthetic validation. Extraction took 19.98 seconds and training 0.62 seconds on the cloud CPU. The 32,768-parameter head plus int8 gallery would be 2.81 MB for 19,665 rows by arithmetic, excluding metadata and detailed verification.

Every eligible arm failed its frozen advancement gate. On the 67 reused quality-passing physical crops, hash retrieved 54 at K=8, the learned head 48, and the fixed 4+4 union 56. The union nevertheless lost one previously accepted Charizard crop; the head lost nine previously accepted crops. The unchanged verifier accepted 51/67 for hash, 47/67 for the head and 53/67 for the union. Nonpositive candidate diversity increased from 611 distinct records to 690/703. Synthetic validation retrieved 255/256 for hash/union and 252/256 FP32 or 251/256 int8 for the head, but the unchanged local verifier rejected all 64 half-turn transforms. Retrieval success is not end-to-end acceptance.

No trained head, new index or candidate union was added to the app. Fresh physical/art-family/device-disjoint data and a substantially better encoder/verifier hypothesis are required before another advancement claim.
