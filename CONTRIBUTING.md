# Contributing

1. Open an issue describing the bug or proposed feature, including your browser and game where relevant.
2. Keep changes focused and add regression tests for data transformations and bug fixes.
3. Run `npm ci`, `npm run check`, and `npm run test:e2e` before proposing a change.
4. Never commit API keys, collection backups, photos, recordings, accounts, copyrighted card art, or proprietary code/assets.
5. Keep photos on-device. Any new external transmission, API credential, sync system, or price source must have a clear privacy and attribution design.
6. Honor provider rates and terms. Do not make tests flood real APIs; use synthetic documented fixtures for deterministic checks.

By submitting a contribution, you agree to license your original contribution under this repository’s MIT license. The project cannot accept rights it does not hold.

## Verification and runner scope

This development phase runs implementation and browser verification on the project’s cloud VM. Publishing source does not automatically invoke a personal Mac: the existing Mac workflow is manual-dispatch only, still restricted to the repository owner and `main`. Use it only after an explicit request to run verification there. No hosted-runner fallback, credential or runner-registration change is introduced. Record the exact source/build hashes and cloud test results with each reviewed checkpoint; do not present an earlier Mac result as verification of a newer commit.
