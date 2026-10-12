# Pack opening: captured-view recognition

Pack opening is intended for a sequence of moving card reveals. The live-card/binder scanner remains useful for a stationary card or layout. Both use the installed local learned reference pack; neither uploads video frames for recognition.

## Use

1. Install the Pokémon database with the main setup button, then choose **Pack opening**.
2. Start the camera, or choose **Scan local video**. Supported local MP4/WebM files are limited to 250 MB, five minutes and a 1,920-pixel longest edge. Browser codec and native frame-capture support are required. Video files play at their original speed.
3. Keep each card's front visible with useful detail when possible. Capture and verification proceed independently. A queued view may finish after that card moves away; its receipt records the original capture time and processing delay.
4. **Pause pack** pauses acquisition and commits. **Finish capture** drains already captured views. Natural video end also drains. **Stop pack**, navigation and source replacement cancel unsaved work. Saved collection entries remain.
5. Inspect saved identities and unmatched views, and use Undo for an incorrect addition. The same identity counts once per pack. Adjust Collection quantity for another indistinguishable copy; motion alone does not establish a new physical copy.

All automatic entries retain unknown physical printing, finish and condition and remain excluded from valuation. Provider quotes are separately labeled market references. An image-reference match does not authenticate a card or establish foil, edition or grade.

## Bounded pipeline

The queue holds at most 12 actual captured views and 48 MiB of queued/in-flight RGBA pixels. That is a pixel-queue limit, **not** the application's total RAM use. Model sessions, browser video surfaces and capture/recycling buffers require additional memory. Similar-view scheduling can replace a redundant view with a clearer one. Overflow is reported; it can lose a fleeting card, so complete capture is never guaranteed.

Each analyzed view gets a fresh full-frame corner proposal, local hash retrieval and complete learned-feature/geometric verification against all shortlisted rivals. There is one model worker and no per-clip card list, expected-order rule or label-driven crop. A nearest candidate alone never authorizes a save. Unknown, obscured or insufficiently detailed cards may remain unmatched.

Native source identity, advancing frame metadata and acquisition freshness are checked before pixels enter the queue. A late result is a receipt for a past captured view, not evidence that the same card remains in the current preview. The separate live-card scanner retains its current-view continuity requirement.

Pack capture may discard an otherwise valid native acquisition that exceeds the 250 ms freshness bound and request a new frame. The discarded frame's identity is consumed, so it cannot be relabeled as fresh. Recovery permits at most two consecutive and eight total retries, reports their count, and never passes the discarded pixels to inference. Invalid/future timestamps, source replacement, muted/ended tracks, malformed readback and missing callbacks still stop the session. This recovery does not relax the live-card scanner's proof requirements.

## Public-video evaluation, 12 October 2026

The evaluated input is a continuous 59-second excerpt (source 3:10–4:09) of **ASMR Sometimes — “ASMR - Pokemon TCG: Surging Sparks - Whispering, Gum Chewing, Crinkles.”** The [original creator's video](https://www.youtube.com/watch?v=QGlEC9SRcn0) declares Creative Commons Attribution reuse; the [downloadable mirror](https://peertube.wtf/videos/watch/c9e61ffe-5c3e-4c43-b45e-4b8275ef9f07) also declares Attribution. The excerpt was transcoded to silent H.264 without cropping, internal cuts or speed changes. Attribution belongs with any demonstration using it. Video and commercial card artwork are not bundled in the source repository.

Input: 1,280 × 720, 30 fps, 1,770 frames. Excerpt SHA-256: `32198f50bea0d58613bb7b8eea0c934225495a065e8dfc956621795e2ec27ec5`.

An independent reviewer labeled 11 TCG fronts, including one Energy, plus a non-target code card. Labels were withheld until the unchanged baseline predictions were frozen. The ten Surging Sparks print references were installed; the exact Energy printing was absent, but an alternate reference supported its identity. Holds were roughly one to eight seconds, mostly two to six. This is moderate ASMR pacing, not evidence of a naturally rapid rip.

With the same 19,665-reference gallery, the original live-view workflow saved **0 of 11** cards. It produced two correct eligible identity observations, but their current-view continuity proofs failed after motion. The captured-view workflow then saved **11 of 11 correct identities**, with no wrong names or duplicate quantities, at original 1× playback. All ten specifically covered fronts were identified; Energy remained identity-only via its alternate reference.

The final polished build independently repeated **11/11 correct identities**, with zero wrong names or duplicate quantities and all 11 entries retained after reload. Its capture-to-durable-save interval was **2.346–3.038 seconds** (median **2.621 seconds**). Playback dropped **0 of 1,770 frames**, and pending work drained **3.555 seconds after playback ended**. The bounded verification queue discarded **102 captured views** while still finding every identity in this clip; these omissions are distinct from video playback drops. Across 255 analyzed views, local worker processing was median **257 ms**, p95 **310 ms**. Worker timings exclude queue wait, startup and durable save; they are not millisecond end-to-end recognition.

The earlier pre-recovery checkpoint also saved 11/11, with 2.25–2.95-second capture-to-save latency. Against independently marked main-reveal ends in that run, six saves occurred clearly before the card left its main presentation, three occurred about 0.24–0.33 seconds afterward, and two were within the annotations' ±0.2-second uncertainty. These are main-focus boundaries, not proof that every remaining pixel left the video. It demonstrates why delayed receipts must not be presented as current-view overlays. Renderer PSS peaked at about 661 MiB and fell to about 69 MiB after teardown. The final 1× rerun peaked at about 648 MiB. Neither run increased the operating system's OOM counter.

The final build also completed an artificially accelerated **2× replay** with **11/11 correct identities**, zero wrong names/duplicates and reload persistence. Capture-to-save latency was **1.719–2.760 seconds** (median **2.334 seconds**), queue drain **3.085 seconds**, playback drops **6 of 1,770 frames**, and captured-view queue drops **76**. Renderer PSS peaked at about **686 MiB**. This test used a pass-through native-timestamp observer, without changing pixels or recognition results.

An earlier 2× run stopped safely on a native-frame freshness error after eight correct saves. The final successful repeat did **not** exercise the new age-only retry path: callback and presentation timestamps stayed within the existing bound. Therefore the repeat is not causal proof that retry fixed the earlier stop. Both outcomes are retained; artificially accelerated footage is not a naturally faster source video.

These outcomes are from one cloud Chromium desktop, one clip and one gallery. They do not establish phone performance, broad open-set precision, reliable foil/printing recognition, or complete capture of every quick or hidden card.

A 295-second stability replay on the pre-recovery checkpoint concatenated five unchanged copies of the same excerpt at original speed. All 11 identities remained counted once across the repeated footage; this checks session latching, not recognition of 55 separate physical copies. It dropped 0 of 8,850 playback frames, drained in 2.98 seconds, retained 11 entries after reload and had no crash or OOM-counter increase. Warm renderer PSS over seconds 60–290 was 519–614 MiB (median 559 MiB), with a fitted +0.57 MiB/min slope over that window. Retained queued pixels stayed below 42.2 MiB and 1,258 old non-save receipts were pruned while saved receipts remained. This short, bounded observation does not prove leak-free indefinite sessions or phone suitability.

Lifecycle browser tests use explicitly synthetic video/worker fixtures to verify pause, hidden-tab and deferred-resume handling; Stop/source replacement/navigation; natural drain; durable-write failure and same-event retry; Undo and reload. They establish state-machine behavior rather than recognition accuracy. Public-video predictions are from the genuine local model worker.
