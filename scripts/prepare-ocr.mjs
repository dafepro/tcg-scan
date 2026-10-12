import { mkdir, readdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const destination = resolve("public/ocr");
await mkdir(destination, { recursive: true });
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js",
  `${destination}/worker.min.js`,
);
for (const file of await readdir("node_modules/tesseract.js-core"))
  if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(file))
    await copyFile(
      `node_modules/tesseract.js-core/${file}`,
      `${destination}/${file}`,
    );
console.log("Local OCR worker and WASM runtime prepared.");
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
await copyFile("LICENSE", `${licenses}/tcg-scan.txt`);
await copyFile("THIRD_PARTY_NOTICES.md", `${licenses}/THIRD_PARTY_NOTICES.md`);
