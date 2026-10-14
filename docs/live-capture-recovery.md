# Bounded live acquisition recovery

An observed real cloud-browser baseline stopped at source 35.50 seconds with a
future-native-timestamp rejection after a diagnostic input hold/resume. A second
instrumented baseline replay reached EOF without reproducing it. Its cause and
magnitude are therefore **not diagnosed**. No timestamp tolerance was widened.

The revised LiveCaptureLoop can discard an expired or clock-ahead acquisition
and ask for a newer native frame. A discard increments generation, cancels all
continuity history and clears the newest-frame proof before any retry. Rejected
pixels never reach matching or become a continuity vote. Original native frame
identities are consumed even when rejected, so a replay cannot relabel them as
fresh. Raw timestamps are preserved, and every later frame must pass unchanged
native identity, clock, source and 250 ms age checks.

At most two consecutive failures retry at the normal capture cadence; the third
pauses with the existing error. A successful valid acquisition resets only this
consecutive counter. Total dropped acquisitions are reported in Live diagnostics.
Source changes, invalid/nonfinite clocks, counter/timestamp regressions, native
callback timeouts and other errors remain immediately fatal. Pack behavior is
unchanged. Natural file EOF quietly retires pending capture work instead of
showing an erroneous camera-fault message beside the normal completion status.

Unit tests cover stale-worker invalidation, counter consumption, recovery,
repeated rejection, malformed/source errors, EOF, and all previous strict clock
boundaries. These are safety mechanics, not physical camera validation or proof
that the observed browser clock anomaly has been explained.
