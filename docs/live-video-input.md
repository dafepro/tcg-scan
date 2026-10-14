# Live local video input baseline

Scan options → Test video → Choose test video opens a local MP4/WebM in the Live
scanner. This is diagnostic input, not a separate recognition workflow. The
control explicitly discloses that normal auto-save can add cards to the real
collection. No filename, media bytes or object URL is included in diagnostics.

- Bounded input: nonempty MP4/WebM, at most 250 MiB and five minutes; longest edge
  at most 1920 pixels for stream or 2880 for binder. No resizing workaround is
  introduced for unsupported native readback dimensions.
- Metadata is prepared while playback is stopped. The existing matcher is loaded
  before playback starts at 1×. Only successful source playback and matcher
  readiness commit a new ScanSession. Cancellation, failure and hidden-tab
  preparation preserve the prior session receipts, subtotal and collection.
- Both camera and file sources take the same learned LiveCaptureLoop/FrameCapture
  or existing compatibility matcher path, ScanSession occurrence logic, printing
  scheduler and PrintingSession. Recognition, freshness, save, identity and
  evidence gates are unchanged. Native frame callbacks, not a playback timer,
  establish fresh observations.
- Pause cancels printing work, interrupts scan evidence, pauses acquisition and
  pauses the file. Resume plays the same source/position before resuming capture.
  Late play completion cannot restart a paused or ended session.
- EOF, End session, decoding error and unmount invalidate pending work, stop
  acquisition/printing and release the object URL. EOF never loops or fabricates
  additional observations from its last frame. Receipts remain undoable after
  ordinary end/EOF, as with camera sessions.
- Native autoplay and video controls are absent; the scanner owns playback.
  Switching workflows uses the existing session confirmation and teardown.

## Regression coverage and limits

`src/lib/live-video-source.test.ts` exercises bounded inputs, readiness failure,
metadata timeout/cancellation, source ownership, stale play completion, normal
pause/resume, repeated EOF/error cleanup and a real LiveCaptureLoop/FrameCapture
EOF integration with a pending native frame and a late analysis completion.
Existing frame-capture and live-capture tests retain repeated-frame and stale
native-source regressions.

`tests/live-video.spec.ts` adds browser control-flow regressions for real local
file playback, pause/resume/EOF, preservation after cancelled/hidden/rejected
preparation and navigation cleanup using the existing deterministic matcher.
These tests are authored but have not been run: browser/file-input permission is
pending. They are not public-video accuracy evidence. Theme/mobile/keyboard
visual checks and genuine card-video recognition/printing checks remain pending.

## Separately scoped Test input hold

While a test video is running, **Hold test input** stops the file and acquisition
without cancelling an already-started printing read. It invalidates pending
matcher work and interrupts unsaved identity continuity; it never captures the
held frame again or offers new OCR work. Already-owned printing evidence can
finish and display its real candidate-dependent prompt. Hold creates no new
observation, identity vote or printing evidence.

**Resume test input** is an explicit action that plays the same source and then
resumes normal acquisition. Neither finishing OCR nor displaying guidance resumes
input automatically. The normal **Pause** remains available while held; it clears
the input hold and cancels printing just as before. End, EOF, hidden-tab Pause and
navigation continue to cancel work. Add another copy/New page is disabled while
held so an explicit resume precedes changing the occurrence context.

The held flag is independent of ordinary Pause. It gates matcher/current-view
work and new printing offers, but deliberately does not change ownership of a
crop already offered to PrintingSession. PrintingSession and the reader are
unchanged. The diagnostics snapshot reports waiting during an input hold.

`live-input-hold.test.ts` integrates the production hold helper, LiveCaptureLoop
and PrintingSession with controlled capture/read completions. It checks a real
candidate-dependent prompt, exactly one pre-hold evidence frame, no captures or
extra reads while held, no stale matcher commit, explicit-only resumption and
ordinary Pause/End cancellation. Additional browser cases in `live-video.spec.ts`
cover the control wiring and pending-read prompt. They remain authored but unrun
pending browser permission.
