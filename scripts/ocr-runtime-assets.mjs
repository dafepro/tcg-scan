/** Reviewed Tesseract 6 LSTM-only staging. Never delete unknown files or directories. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const OCR_CORE_ASSETS = [
  {
    name: "tesseract-core-lstm.wasm.js",
    bytes: 3954181,
    sha256: "775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687",
    wasm: "tesseract-core-lstm.wasm",
    wasmBytes: 2871085,
    wasmSha256:
      "220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b",
  },
  {
    name: "tesseract-core-simd-lstm.wasm.js",
    bytes: 3954569,
    sha256: "9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7",
    wasm: "tesseract-core-simd-lstm.wasm",
    wasmBytes: 2871377,
    wasmSha256:
      "187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d",
  },
];
export const RETIRED_OCR_ASSETS = [
  {
    name: "tesseract-core.wasm",
    bytes: 3468788,
    sha256: "740f7e466a2f026e1f1e54a2e0d9957e386d8166110d1290224abd3d08986106",
  },
  {
    name: "tesseract-core-simd.wasm",
    bytes: 3469078,
    sha256: "ca11ee92a02023e4f5083eefd0966fb83b297416da54e997b9f6ce445f719c9b",
  },
  ...OCR_CORE_ASSETS.map(
    ({ wasm: name, wasmBytes: bytes, wasmSha256: sha256 }) => ({
      name,
      bytes,
      sha256,
    }),
  ),
  {
    name: "tesseract-core.wasm.js",
    bytes: 4750805,
    sha256: "e66872f6a76f5ad414d73d21512245df0de3060ad4871a97c47efceaab27b955",
  },
  {
    name: "tesseract-core-simd.wasm.js",
    bytes: 4751193,
    sha256: "3b0678c47a8dea6abb931b214171c08b742a5b9a9fcbbb1a028a08d5de6e9d4c",
  },
];
function verify(bytes, expected) {
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
    throw new Error(`Unreviewed OCR runtime bytes: ${expected.name}`);
  return bytes;
}
async function optionalRegularFile(path) {
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && !stat.isFile())
    throw new Error(`OCR output must be a regular file: ${path}`);
  return stat;
}
async function safeDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`OCR output must use real directories: ${current}`);
  }
}
export async function stageOcrCoreAssets(packageDirectory, destination) {
  const pkg = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  if (pkg.version !== "6.1.2")
    throw new Error(
      "Install locked tesseract.js-core@6.1.2 before staging OCR.",
    );
  await safeDirectory(dirname(destination));
  await mkdir(destination, { recursive: true });
  await safeDirectory(destination);
  const prepared = [];
  for (const asset of OCR_CORE_ASSETS) {
    const bytes = verify(
      await readFile(join(packageDirectory, asset.name)),
      asset,
    );
    const encoded = [
      ...bytes
        .toString("utf8")
        .matchAll(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/g),
    ];
    const embedded =
      encoded.length === 1 && Buffer.from(encoded[0][1], "base64");
    const wasm = verify(await readFile(join(packageDirectory, asset.wasm)), {
      name: asset.wasm,
      bytes: asset.wasmBytes,
      sha256: asset.wasmSha256,
    });
    if (!embedded || !embedded.equals(wasm))
      throw new Error(`OCR embedded WASM mismatch: ${asset.name}`);
    await optionalRegularFile(join(destination, asset.name));
    prepared.push({ asset, bytes });
  }
  await optionalRegularFile(join(destination, "runtime-provenance.json"));
  const retired = [];
  for (const asset of RETIRED_OCR_ASSETS) {
    const path = join(destination, asset.name);
    if (await optionalRegularFile(path)) {
      verify(await readFile(path), asset); // Refuse to delete changed/user-owned bytes.
      retired.push({ path, asset });
    }
  }
  for (const { asset, bytes } of prepared)
    await writeFile(join(destination, asset.name), bytes);
  // This fixed six-name allowlist is the only cleanup. No glob or recursive delete.
  for (const { path, asset } of retired) {
    await optionalRegularFile(path);
    verify(await readFile(path), asset);
    await unlink(path);
  }
  await writeFile(
    join(destination, "runtime-provenance.json"),
    JSON.stringify(
      {
        format: "tcg-ocr-runtime-assets-v1",
        tesseractJs: "6.0.1",
        tesseractCore: "6.1.2",
        lstmOnly: true,
        assets: OCR_CORE_ASSETS.map(
          ({ name, bytes, sha256, wasmBytes, wasmSha256 }) => ({
            name,
            bytes,
            sha256,
            embeddedWasmBytes: wasmBytes,
            embeddedWasmSha256: wasmSha256,
          }),
        ),
      },
      null,
      2,
    ) + "\n",
  );
}
