/** Explicit-input, offline-only learned reference extraction. Never enumerates or downloads a catalog. */
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  realpath,
  rename,
} from "node:fs/promises";
import {
  dirname,
  resolve,
  join,
  relative,
  isAbsolute,
  basename,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { perceptualHash, differenceHash } from "../src/lib/vision/hash.ts";
import {
  createLearnedModelsFromAssets,
  LEARNED_ASSETS,
} from "../src/lib/vision/learned-models.ts";
import {
  LEARNED_PACK_FORMAT,
  LEARNED_MODEL_ID,
  LEARNED_MODEL_SHA256,
  LEARNED_MODEL_DATA_SHA256,
  LEARNED_PREPROCESS_ID,
  LEARNED_SELECTION_ID,
  LEARNED_QUANTIZATION_ID,
  LEARNED_RECORD_BYTES,
  LEARNED_SHARD_HEADER_BYTES,
  LEARNED_MAX_SHARD_RECORDS,
  LEARNED_MAX_REFERENCES,
  validateLearnedManifest,
  decodeLearnedRecord,
  validateLearnedReferenceMetadata,
} from "../src/lib/learned-packs.ts";
import { LEARNED_ALGORITHM } from "../src/lib/vision/learned-types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_FORMAT = "tcg-learned-build-input";
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const METADATA_FIELDS = [
  "key",
  "game",
  "name",
  "identityKey",
  "artworkKey",
  "setName",
  "number",
  "imageUrl",
  "sourceUrl",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const only = (row, allowed, label) => {
  assert(
    row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).every((key) => allowed.includes(key)),
    `Invalid or unknown ${label} fields.`,
  );
};
const text = (value, label, max = 2000) => {
  assert(
    typeof value === "string" &&
      value.trim() &&
      value.length <= max &&
      !Array.from(value).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ),
    `Invalid ${label}.`,
  );
  return value;
};
const hex = (value) => {
  assert(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "Expected SHA-256.",
  );
  return value;
};
const integer = (value, label, max = 10_000_000) => {
  assert(
    Number.isSafeInteger(value) && value >= 0 && value <= max,
    `Invalid ${label}.`,
  );
  return value;
};
const date = (value) => {
  text(value, "date", 40);
  assert(
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
    "Invalid date.",
  );
  return value;
};
const checkCancelled = (signal) => {
  if (signal?.aborted)
    throw new Error(
      "Build cancelled; completed content-addressed cache entries can be reused. No partial pack is ready.",
    );
};

const UNAVAILABLE_REASONS = new Set([
  "http-404",
  "cache-missing",
  "cache-corrupt",
]);
const ADVERTISED_HOSTS = {
  pokemon: new Set(["assets.tcgdex.net", "images.pokemontcg.io"]),
  mtg: new Set(["cards.scryfall.io"]),
  yugioh: new Set(["images.ygoprodeck.com"]),
};
function unavailableSource(value, metadata) {
  only(
    value,
    ["reason", "advertisedUrl", "evidenceSha256", "observedAt"],
    "unavailable source",
  );
  assert(
    UNAVAILABLE_REASONS.has(value.reason),
    "Unsupported unavailable-source reason.",
  );
  const url = new URL(
    text(value.advertisedUrl, "advertised provider image URL", 2048),
  );
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ADVERTISED_HOSTS[metadata.game].has(url.hostname),
    "Unavailable sources require a known HTTPS image provider for the same game.",
  );
  assert(
    metadata.sourceUrl &&
      (!metadata.imageUrl || metadata.imageUrl === url.href),
    "Unavailable sources require provider-card provenance and consistent advertised image metadata.",
  );
  const result = {
    reason: value.reason,
    advertisedUrl: url.href,
    evidenceSha256: hex(value.evidenceSha256),
  };
  if (value.observedAt !== undefined) {
    const observedAt = date(value.observedAt);
    assert(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) &&
        new Date(observedAt).toISOString().slice(0, 19) ===
          observedAt.slice(0, 19),
      "Unavailable-source observedAt must be a valid UTC timestamp.",
    );
    result.observedAt = observedAt;
  }
  return result;
}

export function validateLearnedBuildInput(value) {
  only(
    value,
    [
      "format",
      "version",
      "name",
      "game",
      "createdAt",
      "coverage",
      "rights",
      "cards",
    ],
    "build input",
  );
  assert(
    value.format === INPUT_FORMAT &&
      value.version === 1 &&
      ["pokemon", "mtg", "yugioh"].includes(value.game),
    "Unsupported build-input version or game.",
  );
  assert(
    Array.isArray(value.cards) &&
      value.cards.length > 0 &&
      value.cards.length <= LEARNED_MAX_REFERENCES,
    "Explicit input must contain 1–60,000 card rows.",
  );
  const coverage = value.coverage;
  only(
    coverage,
    [
      "scope",
      "catalogCards",
      "availableImages",
      "missingImages",
      "provider",
      "note",
      "catalogRetrievedAt",
    ],
    "input coverage",
  );
  assert(
    ["selected", "full-catalog", "custom", "fixture"].includes(coverage.scope),
    "Declare selected, full-catalog, custom, or fixture coverage explicitly.",
  );
  const resultCoverage = {
    scope: coverage.scope,
    catalogCards: integer(coverage.catalogCards, "catalogCards"),
    availableImages: integer(coverage.availableImages, "availableImages"),
    missingImages: integer(coverage.missingImages, "missingImages"),
    provider: text(coverage.provider, "provider", 300),
    note: text(coverage.note, "coverage note", 1600),
    catalogRetrievedAt: date(coverage.catalogRetrievedAt),
  };
  assert(
    resultCoverage.availableImages + resultCoverage.missingImages ===
      resultCoverage.catalogCards,
    "Input coverage must account for all catalog rows as available or missing images.",
  );
  const rights = value.rights;
  only(rights, ["usage", "notice"], "rights");
  assert(
    rights.usage === "private-local-only",
    "This builder supports private-local-only output, not publication or redistribution.",
  );
  const resultRights = {
    usage: rights.usage,
    notice: text(rights.notice, "source/rights notice", 4000),
  };
  const keys = new Set();
  let available = 0;
  const cards = value.cards
    .map((row) => {
      only(
        row,
        [
          ...METADATA_FIELDS,
          "imagePath",
          "imageSha256",
          "imageBytes",
          "sourceUnavailable",
        ],
        "card input",
      );
      const metadata = validateLearnedReferenceMetadata(
        Object.fromEntries(
          METADATA_FIELDS.filter((k) => row[k] !== undefined).map((k) => [
            k,
            row[k],
          ]),
        ),
      );
      assert(
        metadata.game === value.game &&
          metadata.key.startsWith(`${value.game}:`) &&
          !keys.has(metadata.key),
        "Duplicate key, wrong game, or missing game namespace.",
      );
      keys.add(metadata.key);
      if (Object.hasOwn(row, "sourceUnavailable")) {
        assert(
          !Object.hasOwn(row, "imagePath") &&
            !Object.hasOwn(row, "imageSha256") &&
            !Object.hasOwn(row, "imageBytes"),
          "Unavailable advertised sources must omit imagePath, imageSha256, and imageBytes.",
        );
        const sourceUnavailable = unavailableSource(
          row.sourceUnavailable,
          metadata,
        );
        available++;
        return { metadata, sourceUnavailable };
      }
      if (row.imagePath === null) {
        assert(
          row.imageSha256 === undefined && row.imageBytes === undefined,
          "A missing provider image cannot have file metadata.",
        );
        return { metadata, imagePath: null };
      }
      const imagePath = text(row.imagePath, "relative cached image path", 1000);
      assert(
        !isAbsolute(imagePath) &&
          !imagePath.includes("\\") &&
          !imagePath.split("/").includes("..") &&
          !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(imagePath),
        "Image paths must be relative files within the explicit images directory, never URLs.",
      );
      const imageSha256 = hex(row.imageSha256),
        imageBytes = integer(row.imageBytes, "imageBytes", MAX_IMAGE_BYTES);
      assert(imageBytes > 0, "Cached images must be nonempty.");
      available++;
      return { metadata, imagePath, imageSha256, imageBytes };
    })
    .sort((a, b) =>
      a.metadata.key < b.metadata.key
        ? -1
        : a.metadata.key > b.metadata.key
          ? 1
          : 0,
    );
  assert(
    value.cards.length <= resultCoverage.catalogCards &&
      available <= resultCoverage.availableImages &&
      value.cards.length - available <= resultCoverage.missingImages,
    "Selected input rows exceed declared catalog coverage.",
  );
  if (coverage.scope === "full-catalog")
    assert(
      value.cards.length === resultCoverage.catalogCards &&
        available === resultCoverage.availableImages,
      "A full-catalog input must enumerate every available and missing-image row.",
    );
  return {
    format: INPUT_FORMAT,
    version: 1,
    name: text(value.name, "pack name", 200),
    game: value.game,
    createdAt: date(value.createdAt),
    coverage: resultCoverage,
    rights: resultRights,
    cards,
  };
}
/** IEEE ties-to-even for either sign; Math.round and floor+floor%2 are wrong for negative ties. */
export function nearestEven(value) {
  assert(Number.isFinite(value), "Cannot quantize a non-finite value.");
  const floor = Math.floor(value),
    fraction = value - floor;
  return fraction === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(value);
}
export function spatialSelection256(points) {
  assert(
    points instanceof Float32Array &&
      points.length % 2 === 0 &&
      points.length >= 512 &&
      points.length <= 1000,
    "At least 256 and at most 500 query points are required; references are never padded.",
  );
  const cells = Array.from({ length: 24 }, () => []);
  for (let i = 0; i < points.length / 2; i++) {
    const x = points[i * 2],
      y = points[i * 2 + 1];
    assert(
      Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        y >= 0 &&
        x < 240 &&
        y < 336,
      "Invalid canonical query point.",
    );
    cells[
      Math.min(5, Math.floor(y / 56)) * 4 + Math.min(3, Math.floor(x / 60))
    ].push(i);
  }
  const selected = [];
  for (let level = 0; selected.length < 256; level++)
    for (const cell of cells) {
      if (level < cell.length) selected.push(cell[level]);
      if (selected.length === 256) break;
    }
  return selected;
}
/** Same float32 scale/division and nearest-even quantization as the frozen NumPy build. */
export function quantizeLearnedReference(query) {
  const selected = spatialSelection256(query.points),
    descriptors = query.descriptors;
  assert(
    descriptors instanceof Float32Array &&
      descriptors.length === (query.points.length / 2) * 64 &&
      descriptors.every(Number.isFinite),
    "Invalid query descriptor matrix.",
  );
  const payload = new ArrayBuffer(LEARNED_RECORD_BYTES),
    view = new DataView(payload);
  for (let i = 0; i < selected.length; i++) {
    const source = selected[i];
    view.setFloat32(i * 8, query.points[source * 2], true);
    view.setFloat32(i * 8 + 4, query.points[source * 2 + 1], true);
    let maximum = 0;
    for (let j = 0; j < 64; j++)
      maximum = Math.max(maximum, Math.abs(descriptors[source * 64 + j]));
    const scale = Math.fround(maximum / 127);
    assert(
      scale > 0 && scale <= 1 / 127 + 1e-9,
      "Reference has a zero or unnormalized descriptor.",
    );
    view.setFloat32(2048 + i * 4, scale, true);
    for (let j = 0; j < 64; j++)
      view.setInt8(
        3072 + i * 64 + j,
        Math.max(
          -127,
          Math.min(
            127,
            nearestEven(Math.fround(descriptors[source * 64 + j] / scale)),
          ),
        ),
      );
  }
  decodeLearnedRecord("pokemon:builder-validation", payload);
  return payload;
}
/** Only the established outer reference resize/hash path. Neural preprocessing stays in learned-models.ts. */
export function canonicalReference(cv, rgba) {
  const source = cv.matFromImageData(rgba),
    resized = new cv.Mat(),
    gray = new cv.Mat(),
    tiny = new cv.Mat(),
    difference = new cv.Mat();
  try {
    cv.resize(source, resized, new cv.Size(240, 336), 0, 0, cv.INTER_AREA);
    cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);
    cv.resize(gray, tiny, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);
    cv.resize(gray, difference, new cv.Size(9, 8), 0, 0, cv.INTER_AREA);
    const image = {
      width: 240,
      height: 336,
      data: new Uint8ClampedArray(resized.data),
      colorSpace: "srgb",
    };
    return {
      image,
      hash: perceptualHash(tiny.data),
      differenceHash: differenceHash(difference.data),
      canonicalSha256: sha(image.data),
    };
  } finally {
    source.delete();
    resized.delete();
    gray.delete();
    tiny.delete();
    difference.delete();
  }
}
async function boundedRead(path, maximum, exactSize) {
  const info = await stat(path);
  assert(
    info.isFile() &&
      info.size > 0 &&
      info.size <= maximum &&
      (exactSize === undefined || info.size === exactSize),
    `Invalid file type or size: ${path}`,
  );
  const bytes = await readFile(path);
  assert(bytes.length === info.size, `File changed while reading: ${path}`);
  return bytes;
}
async function atomic(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { flag: "wx" });
  await rename(temp, path);
}
async function safeDestination(path) {
  const absolute = resolve(path),
    parent = await realpath(dirname(absolute));
  const candidate = join(parent, basename(absolute));
  try {
    return await realpath(candidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return candidate;
  }
}
async function buildContract() {
  const code = {};
  for (const name of [
    "src/lib/vision/learned-models.ts",
    "src/lib/vision/hash.ts",
    "scripts/learned-builder.mjs",
  ])
    code[name] = sha(await readFile(join(ROOT, name)));
  const require = createRequire(import.meta.url),
    cvVersion = require("@techstark/opencv-js/package.json").version;
  const contract = {
    version: 1,
    algorithm: LEARNED_ALGORITHM,
    model: {
      id: LEARNED_MODEL_ID,
      sha256: LEARNED_MODEL_SHA256,
      dataSha256: LEARNED_MODEL_DATA_SHA256,
    },
    preprocess: LEARNED_PREPROCESS_ID,
    canonical: "sharp-default-rgba-no-autorotate-opencv-inter-area240x336-v1",
    selection: LEARNED_SELECTION_ID,
    quantization: LEARNED_QUANTIZATION_ID,
    runtime: "onnxruntime-web@1.30.0/wasm",
    assets: LEARNED_ASSETS,
    opencv: cvVersion,
    sharp: sharp.versions,
    code,
  };
  return { contract, sha256: sha(JSON.stringify(contract)) };
}
export function learnedCacheKey(imageSha256, contractSha256) {
  return sha(
    JSON.stringify({
      imageSha256: hex(imageSha256),
      contractSha256: hex(contractSha256),
    }),
  );
}
async function cachedRecord(cache, key, imageSha256, contractSha256) {
  try {
    const row = JSON.parse(await boundedRead(join(cache, `${key}.json`), 4096));
    only(
      row,
      [
        "version",
        "imageSha256",
        "contractSha256",
        "bytes",
        "sha256",
        "canonicalSha256",
        "hash",
        "differenceHash",
        "metadataSha256",
      ],
      "cache metadata",
    );
    assert(
      row.version === 1 &&
        row.imageSha256 === imageSha256 &&
        row.contractSha256 === contractSha256 &&
        row.bytes === LEARNED_RECORD_BYTES &&
        /^[a-f0-9]{16}$/.test(row.hash) &&
        /^[a-f0-9]{16}$/.test(row.differenceHash),
      "Cache identity/contract mismatch.",
    );
    hex(row.canonicalSha256);
    hex(row.sha256);
    const { metadataSha256, ...checkedMetadata } = row;
    assert(
      sha(JSON.stringify(checkedMetadata)) === metadataSha256,
      "Cache metadata checksum mismatch.",
    );
    const payload = await boundedRead(
      join(cache, `${key}.bin`),
      LEARNED_RECORD_BYTES,
      LEARNED_RECORD_BYTES,
    );
    assert(sha(payload) === row.sha256, "Cached record checksum mismatch.");
    decodeLearnedRecord("pokemon:cache-validation", exactBuffer(payload));
    return { row, payload };
  } catch (error) {
    if (error.code === "ENOENT") return { miss: true };
    if (["EACCES", "EPERM", "EIO"].includes(error.code)) throw error;
    return { corrupt: error.message };
  }
}
async function decodeOriginal(bytes) {
  const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    webp =
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
  assert(
    png || jpeg || webp,
    "Only cached PNG, JPEG, or WebP raster references are allowed.",
  );
  const instance = sharp(bytes, {
    limitInputPixels: 16_000_000,
    animated: false,
    failOn: "error",
  });
  const metadata = await instance.metadata();
  assert(
    !metadata.pages || metadata.pages === 1,
    "Animated/multipage references are unsupported.",
  );
  assert(
    metadata.width > 0 &&
      metadata.height > 0 &&
      metadata.width <= 4096 &&
      metadata.height <= 4096,
    "Reference exceeds 4096 pixels per side.",
  );
  // Do not add rotate, resampling, colour transforms or normalization: this is the frozen outer image decode.
  const { data, info } = await instance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert(
    info.channels === 4,
    "Decoded reference must have four RGBA channels.",
  );
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
    colorSpace: "srgb",
  };
}
async function verifiedAssets(directory) {
  const assets = {};
  for (const [name, expected] of Object.entries(LEARNED_ASSETS)) {
    const bytes = await boundedRead(
      join(directory, name),
      expected.bytes,
      expected.bytes,
    );
    assert(
      sha(bytes) === expected.sha256,
      `Model/runtime SHA-256 mismatch: ${name}`,
    );
    assets[name] = new Uint8Array(bytes);
  }
  return assets;
}
/** Caller must explicitly provide every path; there is no provider lookup, image download, or publication route. */
export async function buildOfflineLearnedPack({
  input,
  images,
  assets,
  cache,
  out,
  shardSize = LEARNED_MAX_SHARD_RECORDS,
  allowFullCatalog = false,
  signal,
  onProgress = (message) => console.error(message),
}) {
  checkCancelled(signal);
  assert(
    input && images && assets && cache && out,
    "Offline builds require --input, --images, --assets, --cache, and --out.",
  );
  assert(
    Number.isSafeInteger(shardSize) &&
      shardSize >= 1 &&
      shardSize <= LEARNED_MAX_SHARD_RECORDS,
    "shard-size must be 1–128.",
  );
  const inputPath = resolve(input),
    inputBytes = await boundedRead(inputPath, MAX_INPUT_BYTES),
    manifest = validateLearnedBuildInput(JSON.parse(inputBytes));
  assert(
    manifest.coverage.scope !== "full-catalog" || allowFullCatalog,
    "Full-catalog extraction requires the explicit --allow-full-catalog flag after separate review.",
  );
  const imageRoot = await realpath(resolve(images)),
    assetRoot = await realpath(resolve(assets)),
    output = await safeDestination(out),
    cacheRoot = await safeDestination(cache);
  assert(
    !inside(imageRoot, output) &&
      !inside(output, imageRoot) &&
      !inside(assetRoot, output) &&
      !inside(output, assetRoot) &&
      !inside(cacheRoot, output) &&
      !inside(output, cacheRoot) &&
      !inside(imageRoot, cacheRoot) &&
      !inside(cacheRoot, imageRoot) &&
      !inside(assetRoot, cacheRoot) &&
      !inside(cacheRoot, assetRoot),
    "Keep source images, model assets, private feature cache, and output separate.",
  );
  try {
    await stat(output);
    throw new Error(
      "Output already exists; use a new destination. Existing artifacts are never replaced.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const contract = await buildContract(),
    cacheDirectory = join(cacheRoot, contract.sha256);
  await mkdir(cacheDirectory, { recursive: true });
  await atomic(
    join(cacheDirectory, "contract.json"),
    JSON.stringify(contract, null, 2),
  );
  const started = performance.now(),
    baselineMemory = process.memoryUsage(),
    staging = `${output}.staging-${randomUUID()}`;
  await mkdir(dirname(output), { recursive: true });
  await mkdir(staging);
  const report = {
    format: "tcg-learned-offline-build-report",
    version: 1,
    status: "building",
    inputSha256: sha(inputBytes),
    contractSha256: contract.sha256,
    scope: manifest.coverage.scope,
    game: manifest.game,
    source: manifest.coverage.provider,
    rights: manifest.rights,
    inputRows: manifest.cards.length,
    extractedImages: 0,
    cacheHits: 0,
    newlyExtracted: 0,
    missingProviderImages: [],
    unavailableAdvertisedImages: [],
    failures: [],
    cacheRepairs: [],
    noNetwork: true,
    noImageOutputs: true,
    output,
    baselineMemory,
    sampledPeakRssBytes: baselineMemory.rss,
    sampledPeakHeapBytes: baselineMemory.heapUsed,
    sampledPeakArrayBufferBytes: baselineMemory.arrayBuffers,
  };
  const sample = () => {
    const m = process.memoryUsage();
    report.sampledPeakRssBytes = Math.max(report.sampledPeakRssBytes, m.rss);
    report.sampledPeakHeapBytes = Math.max(
      report.sampledPeakHeapBytes,
      m.heapUsed,
    );
    report.sampledPeakArrayBufferBytes = Math.max(
      report.sampledPeakArrayBufferBytes,
      m.arrayBuffers,
    );
  };
  let cv,
    models,
    shard = Buffer.alloc(
      LEARNED_SHARD_HEADER_BYTES + shardSize * LEARNED_RECORD_BYTES,
    ),
    shardCount = 0;
  const shards = [],
    records = [],
    names = new Set();
  async function flushShard() {
    if (!shardCount) return;
    shard.write("TCGLRN01", 0, "ascii");
    shard.writeUInt32LE(1, 8);
    shard.writeUInt32LE(LEARNED_RECORD_BYTES, 12);
    shard.writeUInt32LE(shardCount, 16);
    shard.writeUInt32LE(shards.length, 20);
    const bytes = shard.subarray(
        0,
        LEARNED_SHARD_HEADER_BYTES + shardCount * LEARNED_RECORD_BYTES,
      ),
      filename = `features-${String(shards.length + 1).padStart(5, "0")}.bin`;
    await writeFile(join(staging, filename), bytes, { flag: "wx" });
    shards.push({
      file: filename,
      bytes: bytes.length,
      count: shardCount,
      sha256: sha(bytes),
    });
    shard = Buffer.alloc(
      LEARNED_SHARD_HEADER_BYTES + shardSize * LEARNED_RECORD_BYTES,
    );
    shardCount = 0;
  }
  async function getModels() {
    if (!models) {
      onProgress(
        "Verifying local model/runtime assets and starting the shared WASM extractor…",
      );
      cv = await createRequire(import.meta.url)("@techstark/opencv-js");
      let modelAssets = await verifiedAssets(assetRoot);
      models = await createLearnedModelsFromAssets(cv, modelAssets, { signal });
      modelAssets = undefined;
    }
    return models;
  }
  // Fail closed if a dependency unexpectedly attempts a network request during the build.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Offline learned builds cannot make network requests.");
  };
  try {
    for (const [i, item] of manifest.cards.entries()) {
      checkCancelled(signal);
      if (item.sourceUnavailable) {
        report.unavailableAdvertisedImages.push({
          key: item.metadata.key,
          ...item.sourceUnavailable,
        });
        onProgress(
          `Unavailable source ${item.metadata.key}: ${item.sourceUnavailable.reason}; no extraction attempted.`,
        );
        continue;
      }
      if (item.imagePath === null) {
        report.missingProviderImages.push(item.metadata.key);
        continue;
      }
      let stage = "source-integrity";
      try {
        const path = await realpath(resolve(imageRoot, item.imagePath));
        assert(
          inside(imageRoot, path),
          "Cached image resolves outside the explicit image root.",
        );
        const original = await boundedRead(
          path,
          MAX_IMAGE_BYTES,
          item.imageBytes,
        );
        assert(
          sha(original) === item.imageSha256,
          "Cached source image SHA-256 mismatch.",
        );
        const key = learnedCacheKey(item.imageSha256, contract.sha256);
        stage = "cache-read";
        let cached = await cachedRecord(
          cacheDirectory,
          key,
          item.imageSha256,
          contract.sha256,
        );
        if (cached.corrupt)
          report.cacheRepairs.push({
            key: item.metadata.key,
            reason: cached.corrupt,
          });
        if (!cached.payload) {
          stage = "model-initialization";
          const model = await getModels();
          checkCancelled(signal);
          stage = "image-decode";
          const canonical = canonicalReference(
            cv,
            await decodeOriginal(original),
          );
          stage = "feature-extraction";
          const query = await model.extract(canonical.image);
          checkCancelled(signal);
          stage = "feature-quantization";
          const payload = Buffer.from(quantizeLearnedReference(query));
          const row = {
            version: 1,
            imageSha256: item.imageSha256,
            contractSha256: contract.sha256,
            bytes: payload.length,
            sha256: sha(payload),
            canonicalSha256: canonical.canonicalSha256,
            hash: canonical.hash,
            differenceHash: canonical.differenceHash,
          };
          row.metadataSha256 = sha(JSON.stringify(row));
          stage = "cache-write";
          await atomic(join(cacheDirectory, `${key}.bin`), payload);
          await atomic(
            join(cacheDirectory, `${key}.json`),
            JSON.stringify(row),
          );
          cached = { row, payload };
          report.newlyExtracted++;
        } else report.cacheHits++;
        checkCancelled(signal);
        const offset =
          LEARNED_SHARD_HEADER_BYTES + shardCount * LEARNED_RECORD_BYTES;
        cached.payload.copy(shard, offset);
        records.push({
          ...item.metadata,
          hash: cached.row.hash,
          differenceHash: cached.row.differenceHash,
          shard: shards.length,
          offset,
          sha256: cached.row.sha256,
        });
        names.add(
          item.metadata.identityKey ??
            `${item.metadata.game}:${item.metadata.name.toLocaleLowerCase("en-US")}`,
        );
        shardCount++;
        report.extractedImages++;
        if (shardCount === shardSize) {
          stage = "output-write";
          await flushShard();
        }
        sample();
        onProgress(
          `Processed ${i + 1}/${manifest.cards.length}: ${report.extractedImages} ready, ${report.cacheHits} cached, ${report.failures.length} failed.`,
        );
      } catch (error) {
        checkCancelled(signal);
        if (
          ["model-initialization", "cache-write", "output-write"].includes(
            stage,
          )
        )
          throw error;
        report.failures.push({
          key: item.metadata.key,
          imagePath: item.imagePath,
          stage,
          code: error.code ?? "EXTRACTION_FAILED",
          message: error.message,
        });
        onProgress(`Skipped ${item.metadata.key}: ${stage}: ${error.message}`);
      }
    }
    checkCancelled(signal);
    await flushShard();
    assert(
      records.length > 0,
      "No valid learned references were produced. Inspect the failure report; nothing is importable.",
    );
    const coverage = {
      ...manifest.coverage,
      game: manifest.game,
      extractedImages: records.length,
      names: names.size,
      failedImages: report.failures.length,
      ...(report.unavailableAdvertisedImages.length
        ? { unavailableImages: report.unavailableAdvertisedImages.length }
        : {}),
      note: `${manifest.coverage.note} Private offline build: ${records.length} extracted, ${report.failures.length} failed. Exact printing/finish remain unconfirmed.`,
    };
    const pack = validateLearnedManifest({
      format: LEARNED_PACK_FORMAT,
      version: 1,
      algorithm: LEARNED_ALGORITHM,
      model: {
        id: LEARNED_MODEL_ID,
        sha256: LEARNED_MODEL_SHA256,
        dataSha256: LEARNED_MODEL_DATA_SHA256,
      },
      preprocess: LEARNED_PREPROCESS_ID,
      selection: LEARNED_SELECTION_ID,
      quantization: LEARNED_QUANTIZATION_ID,
      width: 240,
      height: 336,
      points: 256,
      dimensions: 64,
      recordBytes: LEARNED_RECORD_BYTES,
      name: manifest.name,
      createdAt: manifest.createdAt,
      coverage,
      shards,
      records,
    });
    const bytes = Buffer.from(JSON.stringify(pack));
    await writeFile(join(staging, "manifest.learned.json"), bytes, {
      flag: "wx",
    });
    checkCancelled(signal);
    Object.assign(report, {
      status:
        report.failures.length ||
        report.missingProviderImages.length ||
        report.unavailableAdvertisedImages.length
          ? "partial"
          : "complete",
      manifestSha256: sha(bytes),
      manifestBytes: bytes.length,
      binaryBytes: shards.reduce((sum, s) => sum + s.bytes, 0),
      names: names.size,
      shards: shards.length,
    });
    const modelNotice = await readFile(
      join(ROOT, "licenses/learned-models-NOTICE.md"),
      "utf8",
    );
    await atomic(
      `${output}.NOTICE.txt`,
      `PRIVATE LOCAL LEARNED REFERENCE PACK\n\nSource: ${manifest.coverage.provider}\nCatalog retrieved: ${manifest.coverage.catalogRetrievedAt}\nInput SHA-256: ${report.inputSha256}\nExtractor/cache contract SHA-256: ${contract.sha256}\n\n${manifest.rights.notice}\n\nNo permission to publish or redistribute card artwork or derivative features is granted. No images are included. Recognition does not establish an exact printing or finish. Provider source URLs remain in card metadata.\n\n${modelNotice}`,
    );
    checkCancelled(signal);
    await rename(staging, output);
  } catch (error) {
    report.status = signal?.aborted ? "cancelled" : "failed";
    report.error = error.message;
    report.unpublishedStagingDirectory = staging;
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await models?.dispose();
    } finally {
      sample();
      report.durationMs = performance.now() - started;
      report.finalMemory = process.memoryUsage();
      await atomic(`${output}.report.json`, JSON.stringify(report, null, 2));
    }
  }
  return report;
}
