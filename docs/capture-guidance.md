# Bounded, candidate-dependent capture guidance

## Status and boundary

`planPrintingGuidance` is a pure advisory policy. Its output is one next step: `read`, `prompt`, `wait`, or `partial`. It cannot eliminate candidates, accept a physical version, change identity/save/recognition gates, change a saved occurrence, choose a quote, or accept price as an input. A completed camera prompt is not evidence that a version is confirmed. An adequate region is permission to schedule its reviewed reader, not permission to accept the reader's result.

The default discriminator registry is **empty**. No Pokémon polarity, MTG premium/reprint marker, Yu-Gi-Oh! rarity, stamp, symbol, foil, or backside detector is shipped or enabled by this module. Callers may inject reviewed, physically validated rules for a specified reader/model and supported evaluation slice. Unit-test rules are synthetic fixtures and are not claims of calibrated detectors. This general rule planner remains unwired. The separate narrow literal-text advisory described below is active in the live printing session; it does not register or validate any physical discriminator rule.

There is no real-user or physical-interaction evidence that these prompts improve recognition, completion time, or abandonment. Deterministic tests establish policy behavior only. Real physical detector tests, expected-absence tests, and frozen held-out interaction evaluation are prerequisites to shipping active rules.

## Input contract

- The candidate snapshot must match encounter, generation, and catalog version. Every capture, task, and prompt also carries model/catalog versions and encounter/generation lineage. Stale work is ignored. Stop, Undo, and New page must invalidate the caller's generation immediately; `active: false` stops advice.
- Provider coverage is explicit. Unknown coverage stops guidance. An unmodeled physical alternative is always preserved: even `known-complete` describes the provider lookup scope, never proof that every physical version is modeled. Missing candidate metadata is represented by `state: "missing"` or an omitted expectation, never by `state: "absent"`. The planner does not remove either kind of candidate.
- Rules include stable ID/version, facet, source URLs and source/review dates, reviewer, game/template/language/family scope, explicit excluded candidates, evaluation slice, calibration/model version, normalized template region, observation type, native quality requirements, validated negative-observation requirements, per-candidate expectations, and permitted actions with cost buckets. Source URLs must parse as HTTPS without embedded credentials. Dates must be valid non-future calendar dates or canonical UTC ISO timestamps.
- Region measurements refer to the original pixel rectangle and source dimensions. Resized crops retain original dimensions and source-capture ID. Generated detail is not readable evidence. Focus, glare, visibility, occlusion, and angle are region-specific; unrelated glare elsewhere on the card is not a reason to reject the footer.
- Backside evidence requires continuous same-object association or explicit user-confirmed binding. An encounter ID and a front association alone do not bind a back. New live captures cannot inherit a departed card's identity from timing. Verified retained captures may still be read for their original encounter.
- `unconfirmedFacets` comes from the independent resolver. `literalContradiction` stops camera advice and asks for identity/association review. The planner never repairs observed text to rescue a candidate.

## Decision order

1. Reject invalid/stale snapshots, unknown coverage, contradictions, or inactive work.
2. Keep only physically validated, model-matched, fully in-scope rules that separate at least two known remaining expectations. Missing metadata does not create a separation. A feature shared by every remaining candidate is not useful.
3. Prefer any adequate retained region over another camera prompt, including an older clear footer when a newer surface view has glare. Completed reads and crops/resizes with the same source lineage are not re-read as independent evidence.
4. Wait for an equivalent in-scope read for at most 8 seconds. A timed-out read cannot suppress guidance indefinitely or trigger an immediate loop on the same source image. Another usable region/rule can still progress.
5. Pick a supported useful view deterministically using differing known-candidate pairs divided by an ordered cost bucket. These are ranking heuristics, not calibrated probabilities or measured information gain. Price is unavailable to the planner.
6. Retire improved or irrelevant requests. After two no-gain outcomes for an action, choose another useful action or stop. Pending prompts have an 8-second watchdog and are retired after timeout. No more than four prompts may be issued for an encounter, even if older records have been evicted. Later adequate native evidence can still be read after the prompt cap.
7. If no supported useful view remains, preserve a partial result. Shared appearances do not create an equivalence group automatically. Any sourced equivalence assertion belongs in the independent reviewed resolver/catalog layer.

Move closer is suppressed when focus has deteriorated. Uncovering, reducing local reflection, holding still, and reframing require corresponding region diagnostics. Tilt is permitted only for an injected, supported temporal-material rule with candidate disagreement, after focus, native detail, occlusion, glare, and clipping prerequisites are satisfied. A material read additionally requires validated motion, at least two distinct views, and explicit sleeve-glare exclusion. Showing the back is never the generic fallback for front OCR failure.

## Bounds and caller responsibilities

The planner stores no images and mutates no input. It accepts at most 64 candidates, 64 rules, 24 retained regions, 24 read tasks, and 12 prompt-history records. Oversized inputs fail closed rather than silently truncating candidates. The caller must retain the encounter-wide `totalPromptsIssued` counter when evicting records, deduplicate capture lineages, update prompt outcomes from actual changed evidence, and release task-owned references without freeing shared buffers.

Every result carries encounter/generation/model/catalog versions and whether the unmodeled alternative remains. Reads also identify capture and source-capture lineage; selected rules carry ID/version and region. `allowNegativeObservation` is only a policy permission for a reviewed negative reader under sufficient coverage. Actual recognition and negative assertions still require the independent evidence gate and explicit observation quality/lineage.

The caller must reject late worker responses and own cancellation/deadline enforcement. A `wait` result does not cancel anything. This pure module does not schedule work or measure real detector performance, and its messages never claim that an identity or occurrence has been saved.

## Evidence basis

The design follows the accompanying candidate-specific guidance policy and exact-version acceptance scenarios. [Branson et al. (ECCV 2010)](https://authors.library.caltech.edu/records/gzd73-r9f52) and [Du et al. (ICCV 2023)](https://openaccess.thecvf.com/content/ICCV2023/papers/Du_Multi-View_Active_Fine-Grained_Visual_Recognition_ICCV_2023_paper.pdf) motivate studying informative interactions and view selection; neither validates this phone-card interaction. [Tesseract's image-quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) motivates region-specific native reading, without establishing thresholds for this implementation.

## Active narrow literal-text advisory

`planPrintingLiteralGuidance` (`literal-guidance-v1`) is a separate, bounded
advisory for the existing literal reader. It replaces the live receipt's generic
“hold a clear close-up” loop without claiming that any general physical rule is
validated. `DEFAULT_PRINTING_DISCRIMINATORS` remains empty.

- An actual local read must have completed. A request is possible only when two
  compatible catalog records have different **known** values for a still-unread
  collector number, printed total, printed set code or literal language marker.
  Missing metadata never means an absent feature. Compatibility is used only to
  choose advice; the independent resolver receives the unchanged catalog.
- Pokémon/Magic advice names the bottom identifier line. Yu-Gi-Oh advice names
  the set-code line below the artwork. These are the existing broad reader zones,
  not newly detected character boxes or guaranteed template coverage.
- The message asks for that line closer **once** and says which text could
  separate catalog matches. This is an acquisition suggestion, not a diagnosis
  that the prior crop is blurred, glared or too small. Pixel energy/clipping
  statistics do not influence the request and are not calibrated readability
  measurements.
- Conflicting literals, known catalog conflicts, missing necessary catalog
  fields and unsupported remaining edition/stamp/finish distinctions lead to
  review. No symbol, foil, backside, language-model inference or repaired text is
  introduced. Unknown physical alternatives remain unknown.
- There is at most one explicit request per saved occurrence. A no-gain next
  read stops that request. Pause/cancellation cannot restore the prompt budget.
  A session remembers at most 2,500 prompted event IDs; after that bound no more
  prompts are issued. These records contain no images.
- A useful first read can still wait for the baseline second original capture,
  including when there is only one catalog candidate. An initially empty
  single-candidate read or transient unavailable catalog keeps the prior bounded
  passive retry path (at most six offers between evidence resets, 1.5 seconds
  apart). No request is issued just to fill this retry budget. Crops/resizes and
  repeated source pixels retain the existing non-independent lineage rules.
- Review may stop optional printing reads but never changes identity acceptance,
  saved quantity, finish, condition, price eligibility or collection totals.

There is still no measured physical-user benefit or calibrated quality diagnosis.
The advisory itself does not change literal parsing, reader configuration,
resolver thresholds or catalog-printing acceptance. The separate bounded reader
region update is described in [printing reader regions](printing-reader-regions.md);
it preserves the resolver and catalog-printing acceptance gates.

## Receipt evidence disclosure and lifecycle

`PrintingEvidenceDetails` accepts a live `PrintingResolution`, persisted
`PersistedPrintingEvidence`, or both. The default native `<details>` control is
collapsed and keyboard accessible. A live result is explicitly a local read,
not a durable-save claim; saved evidence is labeled separately and remains a
historical snapshot. The component does not fetch, store, mutate inventory or
render camera images.

Available detail includes unresolved reasons, uncorrected escaped literal OCR,
normalized fields, original capture/session/fingerprint lineage, configured
reader version, actual rectified region dimensions and reader-input dimensions,
original source short edge, descriptive pixel measurements, and catalog
provider/scope/fetch/snapshot information. Missing historical metadata is stated
explicitly. Pixel measurements do not prove blur, glare, readability or absence.

Live retains diagnostics only with its latest 30 receipts, at most eight reads
and two text regions per read. Undo clears that receipt's transient diagnostics
only after durable removal succeeds; a new session replaces the old receipt list
only after source permission/playback/matcher readiness. Pause/end preserve
already-reported historical details but cancel in-flight work. Event/generation
and durable-receipt guards prevent late callbacks from updating another receipt.
Undo of a different receipt does not interrupt the active event's read.

Unit tests cover candidate-dependent literal selection, missing metadata,
unsupported distinctions, original-capture agreement, prompt/no-gain budgets,
Pause/Undo cancellation, mutable diagnostics isolation, HTML escaping and bounded
rendered evidence. Browser accessibility/layout and real physical capture
interaction require separate verification; unit fixtures do not establish them.
