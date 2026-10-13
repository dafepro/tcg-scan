# Optional Pack retained-capture text evidence

This next-cut implementation adds actual Pack receipt UI wiring for a bounded
original-capture text read. It is **experimental and off by default**. It has not
yet established public-video throughput parity or physical-card OCR accuracy.
No synthetic fixture or unit test can promote the feature to default-on.

## Behavior and ownership

The user may enable “Read a retained native capture after saving” before starting
a Pack camera/video session. The primary matcher still runs the unchanged Pack
identity and durable-save gates. After that save succeeds, optional text reading
can finish even when the card is no longer in the preview, or after natural video
end/Finish capture has drained the identity queue. The result appears only beside
the exact original saved receipt, under the shared Printing evidence disclosure.
A running read can be cancelled from that receipt.

Acquisition provenance, receipt ID, and save event are all checked. A duplicate
identity's receipt may carry the earlier event ID for quantity latching, but this
is **not** same-copy association and cannot supply another observation. Separate
same-name captures, A → B → A, and user-confirmed Add another copy records cannot
inherit or combine the original receipt's printing evidence. Original capture ID
is used for every region and OCR pass. UI aggregation never transfers this data
onto a later quantity-confirmed copy; the original remains under recent captured-
view details if its name is grouped behind the latest copy.

One original view emits an unresolved partial result, literal reader text, native
region measurements, and source lineage. It cannot satisfy the existing
two-distinct-capture resolver, regardless of how many crops or text passes it
contains. There is deliberately no catalog request or persisted printing update
from this path. Finish and condition stay unknown; price eligibility stays false;
collection quantity and valuation do not change. Reading and comparison are not
claims that OCR characters are correct.

A further fresh recapture would need a separately implemented explicit or proven
same-physical-copy association. Current Pack timing, same-name latching, and a
user's quantity assertion do not establish that association. This path does not
ask the user to hold the next card as though it belonged to a departed receipt.

## Resource and latency limits

- One admission reservation covers native crop creation, waiting for a failed
  durable save to be explicitly retried, and the active reader. No secondary queue.
- Native crops are requested at most once per 1.5 seconds and at most 30 times per
  session, with maxPrintingCrops = 1. Busy/reserved slots skip native crop creation.
  Pause/Resume never replenishes the acquisition or already-attempted budgets.
- The retained crop is at most 960 × 1344 RGBA (5,160,960 bytes, 4.93 MiB), with a
  native source shorter edge of at least 480 pixels. Upscaling does not qualify.
  A subarray retaining unrelated backing-buffer bytes is rejected.
- A 40-second deadline measured from the original acquisition covers reservation,
  waiting for save, and reader work. Expiry aborts and releases task-owned image
  references. Pixels are not stored in the collection or partial-evidence UI.
- One local printing reader runs at a time and is disposed after the read. Reader
  model memory and its bounded temporary hash/canvas/region image copies are
  additional to the retained-crop bound and Pack's separate 48 MiB identity queue.
- Durable identity save and acknowledgement run first. Optional reading is placed
  on a later task, never awaited by identity analysis, save, or queue drain. This
  avoids adding reader latency to a save promise but does **not** prove CPU,
  allocation, memory, or end-to-end throughput isolation. Native crop preparation
  itself adds work to the identity worker. Keeping the feature off preserves the
  original analysis options.

## Boundaries and failure behavior

Pause (including hidden-tab Pause), explicit End session, Undo, unmount/workflow
change, and preparation of another source invalidate optional work. Results from
an in-flight native crop requested before Pause are stripped before any resumed
identity delivery. Cancelled/late OCR cannot update a new session or resurrect an
undone occurrence. Natural capture drain alone is not an invalidation: the already
associated read may finish against its still-saved original receipt.

A failed durable identity save starts no reader. Its original crop may wait only
within the same deadline for a successful retry of that exact receipt/event. A
late retry still saves through the existing identity path, but expired/cancelled
pixels do not reappear. Reader startup, admission, read, or presentation failures
do not mutate quantity or turn a failed identity save into success.

## Verification completed in this cut

Deterministic tests cover delayed receipt-bound evidence after another identity,
no same-name merging, one-view resolver refusal, failed-save retry, user-confirmed
copy separation, wrong capture/receipt/reader lineage, one reservation and reader,
40-second expiry, cancelled startup and late callbacks, Pause/Stop/Undo/new session,
old-finally/new-slot races, crop dimensions/backing-buffer ownership, per-session
acquisition budget/cooldown, default-off analysis options, max-one crop options,
optional admission failure, and Pause invalidation without losing identity results.
A rendered HTML test checks the unchecked opt-in and truthful resource/throughput
wording. These tests validate scheduling and policy, not OCR or perception accuracy.

The existing 11/11 public-video identity/no-wrong-name/no-duplicate/reload gate must
be replayed on the integrated build. Compare opt-in on/off capture-to-durable-save
latency, processing service time, queue/reservoir omissions, video drops, drain,
peak memory, and lifecycle behavior before considering default-on. Until that
real-video gate passes, no throughput improvement or parity is claimed. Browser
keyboard/mobile/theme checks and a genuine OCR retained-capture replay remain
separate required evidence.
