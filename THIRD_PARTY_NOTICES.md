# Third-party notices

The tcg scan application source is MIT licensed. That license does not replace licenses of dependencies, APIs, card artwork, fonts, trademarks or data.

Runtime dependencies:

- React and React DOM: MIT, https://github.com/facebook/react/blob/main/LICENSE
- Lucide icons: ISC, https://github.com/lucide-icons/lucide/blob/main/LICENSE
- Tesseract.js: Apache-2.0, https://github.com/naptha/tesseract.js/blob/master/LICENSE
- Tesseract.js-core / Tesseract engine: Apache-2.0, https://github.com/naptha/tesseract.js-core/blob/master/LICENSE
- English traineddata downloaded on demand from the Tesseract model distribution: upstream data licensing applies, https://github.com/tesseract-ocr/tessdata

The build stages the installed Tesseract license files and the minified worker’s own third-party notices next to those generated runtime files in `ocr/`. React, React DOM, Scheduler, Lucide and the application license are also staged under `licenses/`. Preserve both directories when redistributing a build. All other npm dependencies retain the licenses included in their packages and lockfile metadata.

No remote fonts are required; the interface uses available system sans-serif fonts. The favicon and decorative card shapes are original project assets.

Card data and externally loaded card imagery are not covered by this repository’s MIT license. Consult the provider policies linked in `docs/providers.md` and the game’s rights holders before reusing or redistributing third-party content. In particular, this app does not hotlink or redistribute YGOPRODeck card images.
