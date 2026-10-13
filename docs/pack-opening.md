# Pack opening: captured-view recognition

Pack opening is intended for a sequence of moving card reveals. The live-card/binder scanner remains useful for a stationary card or layout. Both use the installed local learned reference pack; neither uploads video frames for recognition.

## Use

1. Install the Pokémon database with the main setup button, then choose **Pack opening**.
2. Start the camera, or choose **Scan local video**. Supported local MP4/WebM files are limited to 250 MB, five minutes and a 1,920-pixel longest edge. Browser codec and native frame-capture support are required. Video files play at their original speed.
3. Keep each card's front visible with useful detail when possible. Capture and verification proceed independently. A queued view may finish after that card moves away; its receipt records the original capture time and processing delay.
4. **Pause pack** pauses acquisition and commits. **Finish capture** drains already captured views. Natural video end also drains. **End session** cancels unsaved work. Navigation and workflow/game changes ask before ending unfinished work. Saved collection entries remain.
5. Inspect saved identities and unmatched views, and use Undo for an incorrect addition. Automatic recognition counts the same identity once per pack. Use **Add another copy** beside a saved name when you explicitly confirm another indistinguishable physical copy. Each copy has its own Undo; motion alone does not establish a new physical copy.

All automatic entries retain unknown physical printing, finish and condition and remain excluded from valuation. Provider quotes are separately labeled market references. An image-reference match does not authenticate a card or establish foil, edition or grade.

## Bounded pipeline

The queue holds at most 12 actual captured views and 48 MiB of queued/in-flight RGBA pixels. That is a pixel-queue limit, **not** the application's total RAM use. Model sessions, browser video surfaces and capture/recycling buffers require additional memory. Similar-view scheduling can replace a redundant view with a clearer one. Overflow is reported; it can lose a fleeting card, so complete capture is never guaranteed.

Each analyzed view gets a fresh full-frame corner proposal, local hash retrieval and complete learned-feature/geometric verification against all shortlisted rivals. There is one model worker and no per-clip card list, expected-order rule or label-driven crop. A nearest candidate alone never authorizes a save. Unknown, obscured or insufficiently detailed cards may remain unmatched.

Native source identity, advancing frame metadata and acquisition freshness are checked before pixels enter the queue. A late result is a receipt for a past captured view, not evidence that the same card remains in the current preview. The separate live-card scanner retains its current-view continuity requirement.

Pack capture may discard an otherwise valid native acquisition that exceeds the 250 ms freshness bound and request a new frame. The discarded frame's identity is consumed, so it cannot be relabeled as fresh. Recovery permits at most two consecutive and eight total retries, reports their count, and never passes the discarded pixels to inference. Invalid/future timestamps, source replacement, muted/ended tracks, malformed readback and missing callbacks still stop the session, subject only to the numerical equality rule below. This recovery does not relax the live-card scanner's proof requirements.

Mac Chromium diagnostics identified two false future-presentation checks caused by arithmetic representation: `524.4` versus `524.3999999761581` ms, and `2356.7` versus `2356.699999988079` ms. The validator permits at most `2^-24` ms (about 59.6 picoseconds) in this presentation-time comparison only: one observed subtraction quantum across 598 recorded native clock values. Raw timestamps are retained. Future callback timestamps, clock/source regressions, meaningful future presentation values and the 250 ms age bound remain strict. This narrowly measured equality rule is not a universal browser/uptime precision guarantee or permission to accept stale frames.

## Current scheduling and quantities

Before queue metadata is allocated, a small sampled-view filter can discard
redundant adjacent captures. Changed/sharper views remain eligible and stationary
views refresh within 600 ms. The visual filter keeps only two sampled descriptors.
It remains conservative: it skipped no views in the moving development clip below.

Adaptive backpressure therefore controls the backlog separately. It estimates
actual worker claim-to-completion time with a bounded EWMA (initial 250 ms,
120–2000 ms samples), targets about 500 ms of pending work, and commits 1–3 pending
views. A two-view reservoir retains a latest view and a stronger earlier candidate
under the shared 12-view/48 MiB hard limits. Reservoir views own their original
pixels and native timestamps; they gain receipts only on chronological promotion.
This is a quality/recency scheduling heuristic, not identity or copy evidence.
Brief views can be replaced before analysis. Native capture cadence, recognition
thresholds and durable-save gates are unchanged.

Debug distinguishes visual skips, committed admissions, reservoir deferrals,
replacements, promotions and cancellations, queue rejections/omissions, hard-cap
losses and completed analyses. Deferral/promotion are overlapping event counts;
capacity loss can overlap a reservoir rejection and must not be counted twice.
At natural drain, captured minus processed reports all acquired views that were
not analyzed. Low overflow alone is not evidence that fewer views were omitted.
Source provenance is consumed before filtering, so skipped views cannot be
relabeled as fresh. Pause retains pending pixels; natural end drains; cancellation
releases the reservoir. Routine presentation snapshots are coalesced at 250 ms;
durable outcomes and terminal state flush immediately, without delaying evidence
or collection writes. Published-snapshot preparation is measured separately from
worker time and excludes React/browser rendering.

Pack automatic counting remains once per matched identity per session. **Add
another copy** on a saved receipt is an explicit user-confirmed quantity increment,
with its own retry-safe event and precise Undo. It does not invent a second camera
observation or rearm the identity latch. Grouped rows show the quantity; expanded
history retains individual copy receipts. Starting a new session resets its count
only after the source and matcher are ready. Denied/cancelled restart keeps the
previous session. Changing view/game/workflow during unfinished capture asks before
ending it, and saved collection entries always remain.

The historical results below belong to the previous frozen scheduling checkpoint.
New prefilter throughput/count evidence must be recorded separately; these figures
do not establish an improvement from the new filter.

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

## Prefilter-only checkpoint, 13 October 2026

The first conservative sampled prefilter did **not** demonstrate a throughput
improvement on the same already-used development clip. At 1× it saved 11/11
identities with no wrong names or duplicate quantities, but skipped zero of 427
native captures: 264 views were processed and 163 were lost to queue capacity.
Capture-to-save latency was 2.277–3.029 seconds (median 2.435 seconds). The earlier
checkpoint above had 102 capacity losses and 255 processed views; these are single
runs, not a controlled multi-run speed estimate.

At 2×, the prefilter-only checkpoint saved 10/11 identities, missing Basic
Lightning Energy, while identifying all ten specifically covered fronts. It again
skipped zero views: 218 captures, 134 processed and 84 capacity losses. Median
capture-to-save latency for the ten saved identities was 2.352 seconds. The absent
exact Energy printing does not erase this miss: an alternate reference had
supported that identity in earlier runs. Both outcomes were retained rather than
selecting only a successful repeat. This motivated a separately evaluated bounded
adaptive backlog/reservoir design, without changing recognition or save gates.

## Adaptive backlog comparison, 13 October 2026

A separately frozen adaptive candidate was evaluated once at each predeclared
speed on the same 59-second development clip and full gallery. Both runs saved
**11/11 correct identities**, with no wrong names or duplicate quantities, and
retained all entries after reload. Printing, finish and condition stayed unknown.
No model, identity threshold or clip-specific card list changed.

At **1×**, capture-to-durable-save latency was **0.623–1.079 seconds**, median
**0.878 seconds**, versus 2.435 seconds in the prefilter-only run. Local worker
time remained similar: median 245.35 ms, p95 285.4 ms. Queue drain was 1.281
seconds. There were **428 acquired views, 258 processed and 170 reservoir
replacements**; visual skips and all other disjoint admission-loss classes were
zero. This improved waiting time, not total loss: the prior run omitted 163 views.
All 11 saves preceded their independently labelled main-focus exits in this run;
those manual boundaries have approximately ±0.2-second uncertainty.

At **2×** (artificially accelerated identical footage), capture-to-save latency
was **0.666–1.041 seconds**, median **0.869 seconds**, versus 2.352 seconds in
the prefilter-only run, which had missed Energy. Worker time was median 256.4 ms,
p95 320.3 ms; drain was 1.167 seconds. **219 acquired views = 121 processed +
98 reservoir replacements**. Other disjoint loss classes and fresh-frame retries
were zero. Playback dropped 6 of 1,770 decoded frames. The earlier missed-Energy
result remains part of the evidence; one successful repeat does not establish
all-card reliability.

Sampled queued-plus-identifying work fell from 12 to 5 at both rates. Using the
independently labelled first-identifiable times rather than the selected capture,
median time-to-save changed from 2.933 to 1.227 seconds at 1× and from 2.537 to
1.129 seconds at 2×. Those figures include earlier obscured/unsuitable views and
approximately ±0.2 source-second annotation uncertainty. At 2×, nine adaptive saves
were before the main-focus exit and two were within that uncertainty; none was
clearly after it.

Renderer PSS peaks were about 651 MiB at 1× and 615 MiB at 2×, with no OOM
counter increase or crash. These measurements do not establish lower total RAM
use. Published UI snapshot preparation took 31.7 ms across 221 snapshots at 1×
and 13.2 ms across 119 at 2×; those totals exclude other snapshot calls, React
commits, browser rendering and inference. These single-run cloud desktop results
are not phone performance or a fresh held-out accuracy evaluation.
