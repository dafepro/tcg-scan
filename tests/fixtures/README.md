# Original continuous-scanner mechanics fixtures

These files were generated for this repository from original geometric artwork. They contain no commercial card art, private photos, or downloaded executables.

- `continuous-feature-pack.json`: nine original references with ORB descriptors; all names explicitly start with Synthetic. Ref00 and ref00b intentionally share artwork/identity to exercise printing ambiguity.
- `continuous-two-copies.mp4`: 960×720, 12 fps, five seconds, two spatially distinct copies of the same synthetic card.

The replay test supplies decoded video frames using a test-only camera adapter. The production app and real vision worker are unchanged. Deterministic tests use explicitly identified worker fixtures. These tests establish control flow and geometry, not physical-camera accuracy, confidence calibration, or phone latency. No fixture price is a real valuation. The fixture source has no private workspace paths.
