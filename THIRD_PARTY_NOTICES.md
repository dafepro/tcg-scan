# Third-party notices

The tcg scan application source is MIT licensed. That license does not replace licenses of dependencies, APIs, card artwork, fonts, trademarks or data.

Runtime dependencies:

- React and React DOM: MIT, https://github.com/facebook/react/blob/main/LICENSE
- Lucide icons: ISC, https://github.com/lucide-icons/lucide/blob/main/LICENSE
- OpenCV.js via @techstark/opencv-js: Apache-2.0, https://github.com/TechStark/opencv-js/blob/master/LICENSE and https://opencv.org/license/
- ONNX Runtime Web1.30.0: MIT, https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE. The app uses the verified WASM-only build with telemetry excluded. Vite resolves the official bundle's exact WASM fallback specifier to the identical, hash-verified `vision-models/` copy; vendor JavaScript and WASM bytes are not modified.
- XFeat ONNX model: official Kornia repository, Apache-2.0; Fastweb single-card corner model: pinned publisher model card declares MIT (no separate upstream LICENSE file). Preserve the exact model cards, XFeat license, runtime license and qualifications in `licenses/learned-models-NOTICE.md` and generated `vision-models/`.
- Tesseract.js: Apache-2.0, https://github.com/naptha/tesseract.js/blob/master/LICENSE
- Tesseract.js-core / Tesseract engine: Apache-2.0, https://github.com/naptha/tesseract.js-core/blob/master/LICENSE
- English traineddata: Apache-2.0 upstream data, https://github.com/naptha/tessdata/blob/gh-pages/LICENSE and https://github.com/tesseract-ocr/tessdata. Installed from pinned `@tesseract.js-data/eng@1.0.0`, using `4.0.0/eng.traineddata.gz`; the package wrapper declares MIT, but no wrapper JavaScript is bundled. The build verifies the model's SHA-256, copies the data unchanged, and includes its Apache-2.0 license and provenance beside the same-origin model. The source license copy is in `licenses/tessdata-LICENSE.txt`.

The app uses Tesseract.js 6.0.1 with locked Tesseract.js-core 6.1.2 in LSTM-only mode. Both SIMD and non-SIMD LSTM `.wasm.js` wrappers are copied unchanged; each embeds its complete verified WASM binary. Legacy-engine wrappers and redundant standalone WASM files are not shipped. Runtime hashes and embedded-WASM hashes are recorded in `ocr/runtime-provenance.json`. The default English model remains unchanged.

The build stages the installed Tesseract license files and the minified worker’s own third-party notices next to those generated runtime files in `ocr/`. React, React DOM, Scheduler, Lucide, OpenCV.js and the application license are also staged under `licenses/`. Preserve those directories and the generated `vision-models/` notices when redistributing a build. All other npm dependencies retain the licenses included in their packages and lockfile metadata.

No remote fonts are required; the interface uses available system sans-serif fonts. The favicon and decorative card shapes are original project assets.

Card data and externally loaded card imagery are not covered by this repository’s MIT license. Consult the provider policies linked in `docs/providers.md` and the game’s rights holders before reusing or redistributing third-party content. In particular, this app does not hotlink or redistribute YGOPRODeck card images.
