# Local learned vision: provenance, use and reproduction

These models provide geometric proposals and sparse descriptors, not identity probabilities. Exact printing and finish remain unconfirmed. The original app adapter contains no CollectorVision SDK, AGPL wrapper, upstream Python source, executable serialization, custom operator library or remote-code import.

## XFeat model data

Official Kornia model repository: https://huggingface.co/kornia/xfeat
Pinned revision: 1296058905af4117b33e252336f4efa6c01b5beb
Model card declares Apache-2.0. Exact upstream model card and supplied license are preserved as xfeat-MODEL-CARD.md and xfeat-LICENSE.txt. The ONNX graph (187,433 bytes) and its companion tensor data (2,632,324 bytes) are unchanged. The graph already decodes the keypoint heatmap and upsamples reliability. Our adapter only performs the frozen preprocessing, 5x5 NMS, ranking and bicubic descriptor sampling. No upstream wrapper is used.

## Fastweb model data

Publisher: HanClinto, ccgdetector-fastweb-single
Pinned source: https://huggingface.co/HanClinto/ccgdetector-fastweb-single/blob/66ffd4976ec57bda0f6ea2d83e15ca6a3add7dd9/README.md
The exact publisher model card is preserved as fastweb-MODEL-CARD.md. Its metadata labels the model MIT; the pinned model repository did not supply a separate LICENSE file. This notice preserves that qualification rather than inventing a copyright holder or a license grant. Only the unchanged 3,185,226-byte ONNX data file is used. The associated CollectorVision wrapper/SDK is not included or used. This source repository includes the pinned downloader and these notices, not the generated ONNX weights. Builds retrieve the unchanged model from that pinned publisher revision. Preserve this provenance qualification and review the publisher's terms before redistributing generated weights.

The model's presence output is constant 1.0 and is never treated as confidence. Sharpness is also unused. Full-frame plus row-major 3x3 half-frame proposals, exact Python ties-to-even tile rounding, convex positive-area in-frame validity and greedy polygon-IoU >=0.70 suppression follow the frozen protocol.

## ONNX Runtime Web

Microsoft ONNX Runtime Web 1.30.0, MIT; its license is copied into generated assets. Only the WASM-only entry point is bundled, with its embedded loader. The verified 14,239,897-byte WASM is supplied as env.wasm.wasmBinary; no CDN, dynamic remote script, GPU execution provider or network inference is used. Threads=1, execution=sequential, proxy=false, profiling/debug/tracing=false.

The official 1.30.0 WebAssembly build has telemetry excluded at build time. Its build_args.py target_supports_telemetry explicitly returns false for build_wasm, and parser logic disables use_telemetry. No browser telemetry toggle is exposed, so we do not pretend that the native Python disable API exists on Web.

- https://github.com/microsoft/onnxruntime/blob/v1.30.0/tools/ci_build/build_args.py
- https://github.com/microsoft/onnxruntime/blob/v1.30.0/tools/ci_build/build.py
- https://onnxruntime.ai/docs/api/js/interfaces/Env.WebAssemblyFlags.html
- https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html

## Reproducible staging

Install the exact lockfile dependencies, then run node scripts/prepare-vision-models.mjs. The script downloads only the three pinned official Hugging Face model-data URLs, with no credentials, or uses TCG_VISION_MODEL_DIR pointing to a directory containing exactly the three named model files. Every path checks the exact byte length and SHA-256; a local override cannot bypass verification. The runtime WASM and bundled glue are verified against fixed hashes from the official 1.30.0 npm package. Staged public/vision-models files are generated build assets and must stay gitignored. Browser loading repeats the fixed size and SHA-256 checks before any inference and permits same-origin fetches only, with redirects rejected and credentials omitted.

Offline index tooling can use createLearnedModelsFromAssets with local bytes. It shares the browser's integrity checks, preprocessing and extraction and does not accept executable code or runtime URL overrides. The native CPU results used for the frozen selection are not by themselves proof of browser/mobile parity or latency. Measure those separately; do not claim camera-frame-rate performance from the publisher's native benchmark.

Input limit: at most 4096 pixels per side and 16 million RGBA pixels. Canonical extraction requires 240x336. Queries retain at most 500 float32 64D descriptors. Reference selection/quantization is performed by separate shared index tooling. Inference calls are serialized and outputs/OpenCV Mats disposed. A synchronous WASM inference cannot be cancelled mid-call; cancellation is checked between stages/windows, and the containing Worker can be terminated for immediate cancellation.

## Frozen content checks

The selected experiment's configuration SHA-256 is cfe901caa6c1d9dd581b09a3d8e7a078d3efb5bc6fe9a1d7bd9e52d7822c20ec. Production constants preserve its model data and query/proposal protocol; runtime numerical differences must be checked independently before acceptance claims.

- xfeat_backbone.onnx: 86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0
- xfeat_backbone.onnx.data: d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9
- fastweb-single-1.39.onnx: 05d2b90b928a5a3bf0f49aa90aa86211b2103d9c347c238fd18b4f544b3cb8ca
- ORT1.30.0 ort-wasm-simd-threaded.wasm: 3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2
- ORT1.30.0 ort.wasm.bundle.min.mjs: 11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90

The ONNX artifacts total 6,004,983 bytes; with the WASM asset the initial transfer is 20,244,880 bytes, excluding the app and already-required OpenCV. The runtime's WebAssembly linear-memory allocation can remain reserved after session release; terminate the containing Worker when reclaiming the entire runtime is required. These file sizes are not claims about peak RAM.

## Optional bounded descriptor multiplication

The app can create one tiny, original ONNX graph consisting solely of the standard MatMul operator (opset13, IR9). This is generated from a minimal application-owned protobuf encoder, with no learned weights, downloaded file, custom operators or new dependency. It runs in the already verified WASM runtime and takes query[N,64] and transposed references[64,M], with N<=500 and M<=2048. Its output is at most 4,096,000 bytes. Input/output tensors and the extra session are disposed; the returned CPU array is owned by JavaScript and survives tensor disposal.

The calling matcher must compute first-max mutual nearest neighbours independently within each reference's columns, never across the combined eight-reference matrix. Similarity values remain float32; no probability, approximation, top-k gate or changed acceptance threshold is introduced. Standard float32 matrix accumulation can differ slightly from scalar JavaScript accumulation, so integrated frozen card/group decisions require independent regression before adopting this optimization.
