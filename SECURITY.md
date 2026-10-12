# Security

Do not post credentials, personal card photographs, collection backups, or exploit details containing personal data in a public issue. For a security-sensitive issue, use the repository owner’s GitHub profile to find an appropriate private contact before disclosing details. A dedicated private reporting channel is not configured by this project.

Current security model: browser-local recognition and collection storage; no accounts, API credentials or remote collection storage. The optional local app server only downloads and serves the fixed reference database described below. Public catalog responses, imported backups and descriptor packs are treated as untrusted. Descriptor imports are bounded data-only JSON metadata and binary typed feature blocks with validated shapes, checksums, metadata and URLs; IndexedDB payloads and same-origin downloaded shards are integrity checked. Imported descriptor packs are never evaluated as JavaScript. Pinned ONNX model data and the official WASM runtime are size/SHA-256 checked before inference, and runtime assets load only from the same origin. No remote code, custom model operator, GPU telemetry or external inference service is used. Photos/recordings stay local. Imported links are restricted to known provider hosts, and CSV spreadsheet-formula prefixes are neutralized.

Keep dependencies current and run `npm audit` as well as tests when updating. Unit tests and defensive validation reduce risk; they are not a formal security audit.

## Reference database installer

The development and preview servers expose a same-origin, fixed-asset installer. It accepts no caller URL or credential, follows only allowlisted GitHub asset redirects, and verifies the pinned size and SHA-256 before serving bounded byte ranges. Start/cancel requests require same-origin JSON requests; GET requests never initiate a download. Cache files use controlled paths and are excluded from direct Vite file serving and Git. Camera frames, photographs and collections are never sent to this endpoint. Do not expose a development server as a public production service.

ZIP imports are treated as untrusted data. The importer bounds archive size, directory entries, paths, decompressed output and reference shapes; rejects traversal, encryption, unsupported formats and symlinks; and checks ZIP CRCs plus manifest/shard SHA-256. An interrupted import cannot be used for recognition. The official install path pins the exact manifest before any reservation/write, and a retry only removes that exact release's corrupt installation.

## Self-hosted CI

The workflow intentionally has no `pull_request` or `pull_request_target` trigger. Its job gate restricts execution to the `dafepro` actor, this repository, the `main` branch, and trusted push/manual events. It uses verified macOS/ARM64 runner labels, read-only repository permissions, and checkout without persisted credentials. Do not relax these checks on a personal self-hosted runner or run untrusted fork code there. Registering a runner and granting persistent machine access is a separate owner-admin action.
