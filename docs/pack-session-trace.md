# Opt-in bounded local Pack trace

This diagnostic cut records ordinary application recognition lifecycle metadata.
It does not inspect network traffic, use browser DevTools, or bypass browser or
organization policy. It changes no matcher model, acceptance gate, scheduling
threshold, save policy or physical-copy rule.

## Use and scope

Open **Local session trace (optional)**, enable **Record bounded diagnostics for
the next Pack session**, then start a camera or local video normally. The setting
is off on a fresh mount/reload and never stored. **Inspect local trace** takes a
frozen in-memory snapshot. Source-time filters and 50-row paging inspect earlier
views even after the ordinary receipt window has moved on. Refresh is explicit;
a closed trace panel or an unchanged snapshot does not rerender its record list
with capture telemetry. **Export local trace JSON** explicitly downloads one
local JSON file. No automatic persistence, provider request or upload is added.

The trace begins with valid native acquisitions offered to the production Pack
queue, before prefilter/reservoir decisions. Acquisitions rejected earlier by
native freshness checks, source validation or a late Pause/End boundary are
outside this trace. Existing counters still describe fresh-frame retries. Thus
an absent source-time interval alone does not prove no card was ever visible.

Each view has a separate numeric diagnostic ID. It never increments or replaces
production capture, receipt, track, event or physical-copy identifiers. Media
time is the actual native `sourceFrame.mediaTime` in seconds, unchanged by queue
wait or reservoir promotion. Other times are milliseconds relative to the first
recorded acquisition. Records retain acquisition order; admission/processing
order can differ. `deferredMs` and `admittedMs` preserve reservoir waiting.

Records contain only fixed keys, finite bounded numbers/nulls and closed enums.
They contain no pixels, card names/keys, OCR text, notes, error text, provider
payloads, collection IDs, credentials, source names, file paths, URLs or network
data. Source dimensions and recognition scores are not added. Rejection enums
classify a production rejection that already happened; they do not accept or
re-evaluate a card. `matcher: accepted` includes verified duplicate-latched and
preview-only views. Those are separate save outcomes, not matcher rejections.
`processedMs` can be present with a cancelled matcher outcome if inference
finished behind Pause but delivery was cancelled.

## Bounds and completeness

Both limits apply: at most **2,048 records** and **512 KiB serialized JSON**.
This version conservatively reserves 768 bytes for every record's complete
future lifecycle plus 8 KiB for the fixed envelope and saturating counters. The
byte limit therefore binds first at **672 retained records** with default
settings. The UI and export state that effective capacity. Earlier records are
never rolled out to make room for newer captures. Capture, explicit-copy and
save-result counters continue after overflow; missing updates are counted.

`overflowRecords`, `recordLimitOverflows`, `byteLimitOverflows`,
`unretainedUpdates`, `truncatedUpdates`, `invalidMetadata` and `observerErrors`
make lost diagnostic evidence explicit. `complete` means no diagnostic loss
inside the stated scope, not that capture has ended or every card was saved.
The separate `state` describes active/paused/draining/drained/cancelled. Do not
make complete-history conclusions from an overflowed/failed trace. `retries`
counts retained records' repeated save attempts; cancellation counters describe
queue/reservoir scheduling events, while a record's matcher/save fields describe
active or pending-save cancellation. Counters are event totals, not mutually
exclusive loss classes or current collection quantities.

The store has one bounded Map and fixed-shape records, no growing event arrays,
raw-input references or per-view string maps. Only a single bounded record is
copied/serialized on update, not the full history. Inspection holds at most one
bounded defensive snapshot. Export serializes only on demand, checks the final
byte cap, and retains at most one local Blob URL with timed/unmount cleanup.
JavaScript object overhead and transient snapshot/export copies mean the 512 KiB
limit is a serialized-data limit, not a claim of 512 KiB total heap usage. Actual
retained object count and every record field are bounded independently.

## Durable linkage and boundaries

A displayed receipt's `data-trace-view-id` and captured-view detail label identify
its diagnostic record. `receiptFrame` maps an admitted view to the production
session frame sequence. No raw collection/event identifier is exported.
`eventView` links a save to its diagnostic record; a duplicate references the
original event record but has save state `duplicate`, never a new durable save.
Save success is recorded only in the existing durable acknowledgement path.
Failed saves retain `failed`; retry updates the same record/event; Undo updates
only after durable removal succeeds. The successful-save counter is historical,
so subtracting Undo or inspecting `save` is necessary for current quantities.

An explicit Add another copy creates a new `explicit-copy` record, with its own
`eventView` and `sourceView` link. It has no fresh source media/frame/capture or
processing timestamp, and `matcher: not-run`. It does not borrow the original
view's matching evidence or rearm automatic counting. Links may point to omitted
records after overflow; this does not repair missing history.

Pause keeps the trace. End cancels pending views and preserves saved/undone
records. Natural drain retains the completed trace. Failed/cancelled source
preparation preserves the previous session and trace. Only a successfully ready
new source commits a replacement trace; leaving Pack or reloading drops it.
Pack has no New page operation; switching to the separate binder workflow drops
the Pack component and trace. Binder's New page and all counting semantics are
unchanged. Export beforehand if the old trace is needed.

All optional observer calls, classifier calls and initialization are guarded.
Diagnostic failure cannot propagate into capture/acceptance or durable writes.
Inspection/download failure is shown locally and cannot claim export succeeded.

## Evidence and remaining validation

The original first live public run remains **10/11**, missing Basic Lightning
Energy around source 19–21 seconds: 438 valid acquisitions, 255 processed and
183 reservoir replacements. Its relevant receipts were no longer visible. This
implementation cannot retroactively explain that run and does not fix it.

Focused unit coverage checks caps/overflow and worst numeric representations,
redaction, independent IDs, source/admission ordering, reservoir replacement,
Pause-held processing/cancellation, closed rejection branches, durable failure/
retry/Undo/copy links, disabled-path parity and observer-failure isolation.
Portable browser tests use explicitly synthetic matcher results and original
geometric video. `continuous-trace-cap.mp4` is 25 stream-copied repeats of the
existing five-second `continuous-two-copies.mp4` (125 seconds, unchanged 1×
frames), for cap wiring only; it is not a card-recognition benchmark.

Independent browser verification and one frozen original-speed diagnostic run
on the already-used public clip are required before publication. A successful
repeat is not held-out validation and does not erase the preserved miss. Report
whether Energy-window acquisitions were replaced before processing or reached
the matcher and which rejection/save outcomes occurred. If bounded evidence
cannot answer, report that limitation rather than tune clip-specific thresholds.
