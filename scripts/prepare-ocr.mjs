import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { stageOcrCoreAssets } from "./ocr-runtime-assets.mjs";
const runtime = JSON.parse(
  await readFile("node_modules/tesseract.js/package.json", "utf8"),
);
if (runtime.version !== "6.0.1")
  throw new Error("Install exactly tesseract.js@6.0.1 before preparing OCR.");
const destination = resolve("public/ocr");
await stageOcrCoreAssets(
  resolve("node_modules/tesseract.js-core"),
  destination,
);
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js",
  `${destination}/worker.min.js`,
);
const modelSource =
  "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz";
const modelSha256 =
  "ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468";
const model = await readFile(modelSource);
if (createHash("sha256").update(model).digest("hex") !== modelSha256)
  throw new Error("The pinned English OCR model checksum did not match.");
await copyFile(modelSource, `${destination}/eng.traineddata.gz`);
await copyFile(
  "licenses/tessdata-LICENSE.txt",
  `${destination}/TESSDATA-LICENSE.txt`,
);
await writeFile(
  `${destination}/model-provenance.json`,
  JSON.stringify(
    {
      package: "@tesseract.js-data/eng",
      version: "1.0.0",
      model: "4.0.0/eng.traineddata.gz",
      bytes: model.length,
      sha256: modelSha256,
      rawSha256:
        "daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047",
      source: "https://github.com/naptha/tessdata",
      dataLicense: "Apache-2.0",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Local OCR worker, WASM runtime and verified English model prepared.",
);
for (const [source, name] of [
  ["node_modules/tesseract.js/LICENSE.md", "TESSERACT-JS-LICENSE.txt"],
  [
    "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt",
    "worker.min.js.LICENSE.txt",
  ],
  ["node_modules/tesseract.js-core/LICENSE", "TESSERACT-CORE-LICENSE.txt"],
])
  await copyFile(source, `${destination}/${name}`);
const licenses = resolve("public/licenses");
await mkdir(licenses, { recursive: true });
for (const name of ["react", "react-dom", "scheduler", "lucide-react"])
  await copyFile(`node_modules/${name}/LICENSE`, `${licenses}/${name}.txt`);
await copyFile(
  "node_modules/@techstark/opencv-js/LICENSE",
  `${licenses}/opencv-js.txt`,
);
await copyFile("LICENSE", `${licenses}/tcg-scan.txt`);
await copyFile("THIRD_PARTY_NOTICES.md", `${licenses}/THIRD_PARTY_NOTICES.md`);
