# Original continuous-scanner mechanics fixtures

These files were generated for this repository from original geometric artwork. They contain no commercial card art, private photos, or downloaded executables.

- `continuous-feature-pack.json`: nine original references with ORB descriptors; all names explicitly start with Synthetic. Ref00 and ref00b intentionally share artwork/identity to exercise printing ambiguity.
- `continuous-two-copies.mp4`: 960×720, 12 fps, five seconds, two spatially distinct copies of the same synthetic card.
- `continuous-trace-cap.mp4`: 125 seconds of the same original five-second geometric clip repeated at unchanged 1× speed and copied without re-encoding. It supplies enough real native acquisitions to exercise the bounded trace's 672-record effective capacity. Reproduce with `ffmpeg -stream_loop 24 -i continuous-two-copies.mp4 -map 0:v:0 -c copy -t 125 continuous-trace-cap.mp4`. The earlier 110-second fixture produced 660 acquisitions and correctly did not overflow; its failed coverage assertion is retained in the external QA evidence. This fixture uses a mocked matcher and establishes trace wiring only.

The replay test supplies decoded video frames using a test-only camera adapter. The production app and real vision worker are unchanged. Deterministic tests use explicitly identified worker fixtures. These tests establish control flow and geometry, not physical-camera accuracy, confidence calibration, or phone latency. No fixture price is a real valuation. The fixture source has no private workspace paths.
