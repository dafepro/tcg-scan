# Bounded, candidate-dependent capture guidance

## Status and boundary

`planPrintingGuidance` is a pure advisory policy. Its output is one next step: `read`, `prompt`, `wait`, or `partial`. It cannot eliminate candidates, accept a physical version, change identity/save/recognition gates, change a saved occurrence, choose a quote, or accept price as an input. A completed camera prompt is not evidence that a version is confirmed. An adequate region is permission to schedule its reviewed reader, not permission to accept the reader's result.

The default discriminator registry is **empty**. No Pokémon polarity, MTG premium/reprint marker, Yu-Gi-Oh! rarity, stamp, symbol, foil, or backside detector is shipped or enabled by this module. Callers may inject reviewed, physically validated rules for a specified reader/model and supported evaluation slice. Unit-test rules are synthetic fixtures and are not claims of calibrated detectors. This module is not wired into the live session; generic native-footer quality diagnostics can be integrated independently without activating candidate-specific rules.

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
