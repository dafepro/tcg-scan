# Bounded literal identifier reader regions

This reader configuration adds one fixed Pokémon lower-right identifier region
beside the unchanged broad footer. It does not detect character boxes or establish
coverage for all card templates. Modern identifiers elsewhere on the card still
rely on the broad footer. No physical readability or accuracy improvement is
claimed from this configuration change.

The additional region starts at 84% of rectified card width and 95% of height,
with 14% width and 3% height. Its reader input is resampled by up to 2×, capped at
1,800 pixels wide, and read with Tesseract single-line mode 7. Broad regions use
sparse-text mode 11. Each region explicitly resets the persistent worker's mode,
including when the next capture is for another game. English model/OEM/DPI remain
pinned. There are still at most two regions per capture and one reader job, with
the existing busy, timeout, cancellation and canvas-cleanup behavior.

Native region x/y/width/height, original source short edge, full-card fingerprint
and original capture ID remain unchanged. Measurements are made before reader
resampling. Reader-input dimensions, native/downsampled/upsampled processing and
page-segmentation mode are recorded separately. Upsampling adds neither native
pixels nor an independent observation. Persisted evidence accepts enlargement
only with matching bounded explicit processing metadata; historical records
without that metadata retain the old downscale-only validation.

Each region's literal text is parsed in isolation. Joined text is display-only:
`4` in one region and `/102` in another cannot create `4/102`. No missing slash or
confused character is repaired. Complete fields may combine, but any conflicting
literal value or truncated read preserves abstention. Two regions, or repeated
passes of one source, never supply the resolver's two distinct captures.

The catalog resolver, same-copy/session lifecycle, identity and durable-save
gates, optional Pack default-off behavior, finish/condition uncertainty and
`priceEligible: false` are unchanged. A correct identifier read is not proof of
physical printing, foil, condition, authenticity or price.

## Verification scope

Deterministic tests cover native versus reader dimensions, bounded resampling,
source lineage, per-region mode reset, isolated parsing, literal conflicts,
legacy backup migration, invalid enlargement metadata and disclosure wording.
The opt-in Node OCR test includes a synthetic single-line control through the
configured crop dimensions and 2× resampling. It tests the pinned local model,
not the browser canvas/worker adapter or physical-card accuracy. Browser Live
video, physical camera use, OCR-under-load and held-out tiny-text accuracy require
separate validation.

## Frozen offline source-image comparison, 2026-10-14

A Node Tesseract run used the three existing 600×825 TCGdex catalog source
images, plus two explicit synthetic masks. Source hashes, exact region geometry,
uncorrected text and per-read timings are preserved in the
[failed first-candidate record](benchmarks/printing-reader-node-candidate-a-2026-10-14.json).
Sharp linear resampling prepared the Node input; this does not exercise the
browser canvas/worker adapter. The first candidate used x=62%, y=91%, width=36%, height=7%.

The broad footer yielded no complete fraction for `base1-4` or `base4-4`, and
correctly read `87/130` for `base4-87`. The additional region produced,
respectively, `CE Ee 4/1 1 *`, `¢ wd Te L 4 *`, and `BA se 5) LJ`.
The first malformed read parses literally as `4/1`, an incorrect identifier.
This is not corrected to the source card's number. One capture cannot pass the
resolver; catalog contradiction and all existing gates remain necessary. The
other two added-region reads provide no fraction. Thus this comparison provides
no observed identifier recovery benefit and does not establish physical OCR
accuracy or production readiness.

Masking the lower-right region of `base1-4`, and masking the entire broad footer
of `base4-87`, yielded no parsed identifiers. Both blank lower-right reads
nevertheless emitted literal `a`, illustrating that OCR output is not a reliable
absence detector. These synthetic negative results do not validate a detector
for occlusion, glare, foil or missing print.


### One locked geometry correction

Visual inspection established that the first region included flavor text rather
than a single identifier line. A second classic-layout hypothesis was locked at
x=84%, y=95%, width=14%, height=3%, with no further output-based tuning. The same
three sources and the exact same masks were run once. The
[second-candidate record](benchmarks/printing-reader-node-candidate-b-2026-10-14.json)
preserves all literal output. The additional region read `an x` for `base1-4`,
`4/130 x` for `base4-4`, and `87130 @` for `base4-87`. Only `base4-4` gained a
correct complete fraction; `87130` has no slash and was not repaired. The broad
footer continued to read `87/130`. Both unchanged synthetic masks still produced
no parsed identifier. This tiny reused source-image comparison is not held-out
accuracy or physical camera evidence.

The normalized width uses bounded upward rounding. For these 600×825 sources,
floating-point evaluation gives an 85-pixel-wide native region rather than the
ideal-arithmetic 84. The measured pixel bounds are authoritative:
**x=504, y=783, width=85, height=25; reader input=170×50**. This measured
implementation is preserved unchanged for the checkpoint. Tests lock the actual
pixel bounds. No additional source-image OCR run was made; final arithmetic
matches the measured run.
