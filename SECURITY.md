# Security

Do not post credentials, personal card photographs, collection backups, or exploit details containing personal data in a public issue. For a security-sensitive issue, use the repository owner’s GitHub profile to find an appropriate private contact before disclosing details. A dedicated private reporting channel is not configured by this project.

Current security model: static browser application; no accounts, backend, API credentials or remote collection storage. Public catalog responses, imported backups and descriptor packs are treated as untrusted. Descriptor imports are bounded data-only JSON metadata and binary typed feature blocks with validated shapes, checksums, metadata and URLs; IndexedDB payloads and same-origin downloaded shards are integrity checked. Imported descriptor packs are never evaluated as JavaScript. Pinned ONNX model data and the official WASM runtime are size/SHA-256 checked before inference, and runtime assets load only from the same origin. No remote code, custom model operator, GPU telemetry or external inference service is used. Photos/recordings stay local. Imported links are restricted to known provider hosts, and CSV spreadsheet-formula prefixes are neutralized.

Keep dependencies current and run `npm audit` as well as tests when updating. Unit tests and defensive validation reduce risk; they are not a formal security audit.

## Self-hosted CI

The workflow intentionally has no `pull_request` or `pull_request_target` trigger. Its job gate restricts execution to the `dafepro` actor, this repository, the `main` branch, and trusted push/manual events. It uses verified macOS/ARM64 runner labels, read-only repository permissions, and checkout without persisted credentials. Do not relax these checks on a personal self-hosted runner or run untrusted fork code there. Registering a runner and granting persistent machine access is a separate owner-admin action.
