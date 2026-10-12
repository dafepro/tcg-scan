/** Credentials-free, hash-pinned model-data staging. Never executes upstream repository code. */
import { readFile, mkdir, writeFile, copyFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "public/vision-models");
const xfeatRevision = "1296058905af4117b33e252336f4efa6c01b5beb";
const fastwebRevision = "66ffd4976ec57bda0f6ea2d83e15ca6a3add7dd9";
const assets = [
  { name: "xfeat_backbone.onnx", bytes: 187433, sha256: "86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0", url: `https://huggingface.co/kornia/xfeat/resolve/${xfeatRevision}/xfeat_backbone.onnx` },
  { name: "xfeat_backbone.onnx.data", bytes: 2632324, sha256: "d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9", url: `https://huggingface.co/kornia/xfeat/resolve/${xfeatRevision}/xfeat_backbone.onnx.data` },
  { name: "fastweb-single-1.39.onnx", bytes: 3185226, sha256: "05d2b90b928a5a3bf0f49aa90aa86211b2103d9c347c238fd18b4f544b3cb8ca", url: `https://huggingface.co/HanClinto/ccgdetector-fastweb-single/resolve/${fastwebRevision}/fastweb-single-1.39.onnx` },
  { name: "ort-wasm-simd-threaded.wasm", bytes: 14239897, sha256: "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2", local: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" },
];
function verify(asset, data) {
  if (data.length !== asset.bytes || createHash("sha256").update(data).digest("hex") !== asset.sha256) throw new Error(`Pinned vision asset integrity failed: ${asset.name}`);
  return data;
}
async function download(asset) {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000), credentials: "omit" });
  if (!response.ok || !response.body) throw new Error(`Vision model download failed: ${asset.name} (${response.status})`);
  const data = Buffer.alloc(asset.bytes), reader = response.body.getReader(); let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      if (length + value.byteLength > data.length) throw new Error(`Oversized vision model ${asset.name}`);
      data.set(value, length); length += value.byteLength;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (length !== asset.bytes) throw new Error(`Incomplete vision model ${asset.name}`);
  return verify(asset, data);
}
await mkdir(destination, { recursive: true });
const runtime = JSON.parse(await readFile(resolve(root, "node_modules/onnxruntime-web/package.json"), "utf8"));
if (runtime.version !== "1.30.0") throw new Error("Install exactly onnxruntime-web@1.30.0 before preparing models.");
// Check the bundled official glue as well as the external WASM; bundlers import the glue through /wasm.
const glue = await readFile(resolve(root, "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs"));
verify({ name: "ORT WASM bundle", bytes: 73054, sha256: "11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90" }, glue);
for (const asset of assets) {
  const target = resolve(destination, asset.name);
  let data;
  try { data = verify(asset, await readFile(target)); } catch { /* Rebuild a missing or stale generated asset. */ }
  if (!data) {
    if (asset.local) data = verify(asset, await readFile(resolve(root, asset.local)));
    else if (process.env.TCG_VISION_MODEL_DIR) data = verify(asset, await readFile(resolve(process.env.TCG_VISION_MODEL_DIR, asset.name)));
    else data = await download(asset);
    await writeFile(`${target}.tmp`, data); await rename(`${target}.tmp`, target);
  }
}
for (const name of ["xfeat-LICENSE.txt", "xfeat-MODEL-CARD.md", "fastweb-MODEL-CARD.md", "learned-models-NOTICE.md"]) await copyFile(resolve(root, "licenses", name), resolve(destination, name));
await copyFile(resolve(root, "licenses/onnxruntime-LICENSE.txt"), resolve(destination, "onnxruntime-LICENSE.txt"));
await writeFile(resolve(destination, "provenance.json"), JSON.stringify({ version: 1, runtime: "onnxruntime-web@1.30.0/wasm", xfeatRevision, fastwebRevision, assets: assets.map(({ name, bytes, sha256, url }) => ({ name, bytes, sha256, ...(url ? { source: url } : {}) })) }, null, 2) + "\n");
console.log("Pinned XFeat, Fastweb and telemetry-free ORT Web WASM verified and staged locally.");
