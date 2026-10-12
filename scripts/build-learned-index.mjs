#!/usr/bin/env -S node --import tsx
/** Offline learned-reference extraction and verified frozen-gallery conversion. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { LEARNED_ALGORITHM } from "../src/lib/vision/learned-types.ts";
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
  validateLearnedManifest,
  decodeLearnedRecord,
} from "../src/lib/learned-packs.ts";

const CONFIG_SHA256 =
  "cfe901caa6c1d9dd581b09a3d8e7a078d3efb5bc6fe9a1d7bd9e52d7822c20ec";
const REFERENCE_MANIFEST_SHA256 =
  "c070563251ee30910cb3715c2b294e52450fd830dcc533cfffb5e2daec6cb33f";
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const exactArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

/** Parse the three fixed NPY arrays using a closed grammar, never Python eval/pickle. */
export function parseNpy(buffer, name) {
  assert(
    buffer.length >= 12 &&
      buffer.subarray(0, 6).equals(Buffer.from([0x93, 78, 85, 77, 80, 89])),
    "Invalid NPY magic.",
  );
  const major = buffer[6],
    minor = buffer[7];
  assert(
    (major === 1 || major === 2) && minor === 0,
    "Unsupported NPY version.",
  );
  const start = major === 1 ? 10 : 12,
    length = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  assert(
    length > 0 && length <= 512 && start + length <= buffer.length,
    "Invalid NPY header length.",
  );
  const header = buffer.subarray(start, start + length).toString("ascii");
  const match =
    /^\{\s*'descr':\s*'([^']+)',\s*'fortran_order':\s*False,\s*'shape':\s*\((\d+)(?:,\s*(\d+))?,?\),?\s*\}\s*$/.exec(
      header,
    );
  assert(
    match,
    "Unsafe or unsupported NPY header; only fixed numeric arrays are accepted.",
  );
  const expected = {
    "points.npy": ["<f4", 256, 2, 2048],
    "scales.npy": ["<f4", 256, undefined, 1024],
    "descriptors.npy": ["|i1", 256, 64, 16384],
  }[name];
  assert(
    expected &&
      match[1] === expected[0] &&
      Number(match[2]) === expected[1] &&
      (match[3] === undefined ? undefined : Number(match[3])) === expected[2] &&
      buffer.length - start - length === expected[3],
    "NPY dtype, shape, endianness, or payload size mismatch.",
  );
  return buffer.subarray(start + length);
}
/** Bounded ZIP central-directory parser. Rejects encryption, archives with extra entries, paths, or ZIP bombs. */
export function decodeFrozenNpz(buffer) {
  assert(
    buffer.length <= 256 * 1024 && buffer.length >= 22,
    "NPZ archive exceeds the bounded size limit.",
  );
  // np.savez has no ZIP comment. Requiring this removes ambiguous trailing data.
  const end = buffer.length - 22;
  assert(
    buffer.readUInt32LE(end) === 0x06054b50 &&
      buffer.readUInt16LE(end + 20) === 0,
    "Invalid NPZ ZIP end record.",
  );
  assert(
    buffer.readUInt16LE(end + 4) === 0 &&
      buffer.readUInt16LE(end + 6) === 0 &&
      buffer.readUInt16LE(end + 8) === 3 &&
      buffer.readUInt16LE(end + 10) === 3,
    "NPZ must contain exactly three numeric arrays on one disk.",
  );
  const directorySize = buffer.readUInt32LE(end + 12),
    directoryOffset = buffer.readUInt32LE(end + 16);
  assert(
    directoryOffset + directorySize === end,
    "Invalid NPZ directory bounds.",
  );
  const entries = new Map();
  let cursor = directoryOffset;
  for (let i = 0; i < 3; i++) {
    assert(
      cursor + 46 <= end && buffer.readUInt32LE(cursor) === 0x02014b50,
      "Invalid ZIP entry.",
    );
    const flags = buffer.readUInt16LE(cursor + 8),
      compression = buffer.readUInt16LE(cursor + 10),
      compressed = buffer.readUInt32LE(cursor + 20),
      uncompressed = buffer.readUInt32LE(cursor + 24),
      filenameLength = buffer.readUInt16LE(cursor + 28),
      extraLength = buffer.readUInt16LE(cursor + 30),
      commentLength = buffer.readUInt16LE(cursor + 32),
      localOffset = buffer.readUInt32LE(cursor + 42);
    assert(
      flags === 0 &&
        (compression === 0 || compression === 8) &&
        compressed <= 32768 &&
        uncompressed <= 32768 &&
        uncompressed > 0 &&
        cursor + 46 + filenameLength + extraLength + commentLength <= end,
      "Unsafe ZIP flags, compression, or array size.",
    );
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + filenameLength)
      .toString("utf8");
    assert(
      ["points.npy", "scales.npy", "descriptors.npy"].includes(name) &&
        !entries.has(name),
      "Unexpected or duplicate NPZ member.",
    );
    assert(
      localOffset + 30 <= directoryOffset &&
        buffer.readUInt32LE(localOffset) === 0x04034b50 &&
        buffer.readUInt16LE(localOffset + 6) === flags &&
        buffer.readUInt16LE(localOffset + 8) === compression,
      "Invalid ZIP local header.",
    );
    const localNameLength = buffer.readUInt16LE(localOffset + 26),
      localExtraLength = buffer.readUInt16LE(localOffset + 28),
      dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert(
      buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8") === name &&
        dataOffset + compressed <= directoryOffset,
      "ZIP entry bounds or name mismatch.",
    );
    const compressedData = buffer.subarray(dataOffset, dataOffset + compressed);
    const content =
      compression === 0
        ? compressedData
        : inflateRawSync(compressedData, { maxOutputLength: 32768 });
    assert(content.length === uncompressed, "ZIP uncompressed size mismatch.");
    entries.set(name, parseNpy(content, name));
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  assert(cursor === end, "Unexpected NPZ directory data.");
  const payload = Buffer.concat([
    entries.get("points.npy"),
    entries.get("scales.npy"),
    entries.get("descriptors.npy"),
  ]);
  decodeLearnedRecord(
    "pokemon:conversion-validation",
    exactArrayBuffer(payload),
  );
  return payload;
}
async function checkedFile(
  path,
  expectedSha,
  expectedBytes,
  max = 16 * 1024 * 1024,
) {
  const info = await stat(path);
  assert(
    info.isFile() &&
      info.size > 0 &&
      info.size <= max &&
      (expectedBytes === undefined || info.size === expectedBytes),
    `Unexpected file size: ${path}`,
  );
  const bytes = await readFile(path);
  assert(sha(bytes) === expectedSha, `Frozen input SHA-256 mismatch: ${path}`);
  return bytes;
}
export async function convertFrozenGallery({
  frozen,
  orb,
  out,
  shardSize = LEARNED_MAX_SHARD_RECORDS,
}) {
  assert(
    frozen &&
      orb &&
      out &&
      Number.isSafeInteger(shardSize) &&
      shardSize >= 1 &&
      shardSize <= LEARNED_MAX_SHARD_RECORDS,
    "Specify --frozen, --orb, --out, and a shard size from 1 to 128.",
  );
  const output = resolve(out),
    frozenRoot = resolve(frozen),
    orbRoot = resolve(orb);
  assert(
    output !== frozenRoot &&
      !output.startsWith(`${frozenRoot}/`) &&
      output !== orbRoot &&
      !output.startsWith(`${orbRoot}/`),
    "Output must not overwrite frozen inputs.",
  );
  try {
    await stat(output);
    throw new Error(
      "Output already exists; use a new empty destination to preserve previous artifacts.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const started = performance.now(),
    baselineMemory = process.memoryUsage();
  let peakHeapUsed = baselineMemory.heapUsed,
    peakArrayBuffers = baselineMemory.arrayBuffers;
  const sample = () => {
    const m = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed);
    peakArrayBuffers = Math.max(peakArrayBuffers, m.arrayBuffers);
  };
  const config = JSON.parse(
    await checkedFile(join(frozenRoot, "CONFIG.json"), CONFIG_SHA256),
  );
  const references = JSON.parse(
    await checkedFile(
      join(frozenRoot, "reference-manifest.json"),
      REFERENCE_MANIFEST_SHA256,
    ),
  );
  assert(
    references.referenceCount === 2000 &&
      references.references.length === 2000 &&
      config.referenceManifest.sha256 === REFERENCE_MANIFEST_SHA256,
    "This converter accepts only the frozen selected 2,000-reference gallery.",
  );
  // The pinned configuration records source paths for its private audit. Resolve
  // only unique file basenames here; callers supply their own local roots.
  const frozenHash = (filename) => {
    const matches = Object.entries(config.baselineGalleryHashes).filter(
      ([path]) => basename(path) === filename,
    );
    assert(
      matches.length === 1,
      "Frozen source filename is missing or ambiguous.",
    );
    return matches[0][1];
  };
  const orbManifestPath = join(orbRoot, "manifest.json"),
    orbManifestSha = frozenHash("manifest.json");
  const orbManifest = JSON.parse(
    await checkedFile(orbManifestPath, orbManifestSha),
  );
  const hashes = new Map();
  for (const entry of orbManifest.packs) {
    const name = basename(entry.file),
      expected = frozenHash(name);
    assert(entry.sha256 === expected, "Frozen ORB pack manifest mismatch.");
    const pack = JSON.parse(
      await checkedFile(join(orbRoot, name), expected, entry.bytes),
    );
    for (const feature of pack.features) {
      assert(!hashes.has(feature.key), "Duplicate ORB reference key.");
      hashes.set(feature.key, {
        hash: feature.hash,
        differenceHash: feature.differenceHash,
      });
    }
    sample();
  }
  assert(
    hashes.size === references.references.length,
    "Frozen ORB/reference membership mismatch.",
  );
  const selected = references.references
      .slice()
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    names = new Set(),
    keys = new Set();
  const staging = `${output}.staging-${randomUUID()}`;
  await mkdir(dirname(output), { recursive: true });
  await mkdir(staging);
  const shards = [],
    records = [];
  for (let start = 0; start < selected.length; start += shardSize) {
    const rows = selected.slice(start, start + shardSize),
      shardIndex = shards.length;
    const buffer = Buffer.alloc(
      LEARNED_SHARD_HEADER_BYTES + rows.length * LEARNED_RECORD_BYTES,
    );
    buffer.write("TCGLRN01", 0, "ascii");
    buffer.writeUInt32LE(1, 8);
    buffer.writeUInt32LE(LEARNED_RECORD_BYTES, 12);
    buffer.writeUInt32LE(rows.length, 16);
    buffer.writeUInt32LE(shardIndex, 20);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      assert(
        !keys.has(row.key) &&
          hashes.has(row.key) &&
          row.metadata.key === row.key,
        "Frozen reference membership or key mismatch.",
      );
      keys.add(row.key);
      const input = await checkedFile(
        row.file,
        row.sha256,
        row.bytes,
        256 * 1024,
      );
      const payload = decodeFrozenNpz(input),
        offset = LEARNED_SHARD_HEADER_BYTES + i * LEARNED_RECORD_BYTES;
      payload.copy(buffer, offset);
      const metadata = Object.fromEntries(
        METADATA_FIELDS.filter((key) => row.metadata[key] !== undefined).map(
          (key) => [key, row.metadata[key]],
        ),
      );
      names.add(
        metadata.identityKey ??
          `${metadata.game}:${metadata.name.toLocaleLowerCase("en-US")}`,
      );
      records.push({
        ...metadata,
        ...hashes.get(row.key),
        shard: shardIndex,
        offset,
        sha256: sha(payload),
      });
      sample();
    }
    const filename = `features-${String(shardIndex + 1).padStart(5, "0")}.bin`;
    await writeFile(join(staging, filename), buffer, { flag: "wx" });
    shards.push({
      file: filename,
      bytes: buffer.length,
      count: rows.length,
      sha256: sha(buffer),
    });
    console.error(
      `Verified and converted ${Math.min(start + shardSize, selected.length)}/${selected.length} references.`,
    );
  }
  const originalCoverage = orbManifest.packs[0].coverage;
  const manifest = validateLearnedManifest({
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
    name: "Pokémon frozen learned subset · 2,000 references",
    createdAt: config.frozenAt,
    coverage: {
      scope: "selected",
      game: "pokemon",
      extractedImages: 2000,
      names: names.size,
      catalogCards: originalCoverage.catalogCards,
      availableImages: originalCoverage.availableImages,
      missingImages: originalCoverage.missingImages,
      failedImages: 0,
      provider: originalCoverage.provider,
      catalogRetrievedAt: originalCoverage.catalogRetrievedAt,
      note: "Private selected 2,000-reference English physical-card subset, not full catalog coverage. Names may repeat across printings. Exact printing and finish remain unconfirmed. No card images are included. Frozen configuration and NPZ sources were verified before conversion.",
    },
    shards,
    records,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(staging, "manifest.learned.json"), manifestBytes, {
    flag: "wx",
  });
  await rename(staging, output);
  sample();
  const report = {
    format: "tcg-learned-conversion-report",
    version: 1,
    output,
    configSha256: CONFIG_SHA256,
    referenceManifestSha256: REFERENCE_MANIFEST_SHA256,
    manifestSha256: sha(manifestBytes),
    references: records.length,
    names: names.size,
    shards: shards.length,
    serializedBytes:
      manifestBytes.length +
      shards.reduce((sum, shard) => sum + shard.bytes, 0),
    manifestBytes: manifestBytes.length,
    binaryBytes: shards.reduce((sum, shard) => sum + shard.bytes, 0),
    payloadBytes: records.length * LEARNED_RECORD_BYTES,
    maxShardBytes: Math.max(...shards.map((shard) => shard.bytes)),
    descriptorLruBytes: 8 * LEARNED_RECORD_BYTES,
    durationMs: performance.now() - started,
    baselineMemory,
    finalMemory: process.memoryUsage(),
    sampledPeakHeapUsed: peakHeapUsed,
    sampledPeakArrayBuffers: peakArrayBuffers,
    processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    noImageOutputs: true,
    noNetwork: true,
    everySourceShaVerified: true,
    scope:
      "Format converter only. No full-catalog extraction, model execution, publication, or artwork redistribution.",
  };
  await writeFile(`${output}.report.json`, JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  return report;
}
const HELP = `Convert the frozen selected 2,000-reference learned gallery locally, without downloads or images.

node --import tsx scripts/build-learned-index.mjs --convert-frozen \
  --frozen /private/frozen-selected --orb /private/original-orb-2000 \
  --out /private/new-learned-2000

Offline extraction from an explicit image-input manifest (no downloads):
node --import tsx scripts/build-learned-index.mjs --input /private/input.json \
  --images /private/cached-originals --assets ./public/vision-models \
  --cache /private/learned-feature-cache --out /private/new-learned-pack
  --allow-full-catalog  Required in addition to a full-catalog input; use only after review

  --frozen DIR      Frozen CONFIG.json and reference-manifest.json (both pinned by SHA-256)
  --orb DIR         Frozen original 2k ORB packs used only for perceptual hashes
  --shard-size N    1–128 fixed-size records per binary shard (default 128)
  --out DIR        Required new private output directory; existing output is never overwritten

Frozen conversion never extracts a full catalog. Explicit-input extraction reuses the shared
verified WASM model extractor and content-addressed private cache. No provider catalogs
are enumerated and no missing images are downloaded. Do not publish private derivatives.
`;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "convert-frozen": { type: "boolean" },
      input: { type: "string" },
      images: { type: "string" },
      assets: { type: "string" },
      cache: { type: "string" },
      "allow-full-catalog": { type: "boolean" },
      out: { type: "string" },
      frozen: { type: "string" },
      orb: { type: "string" },
      "shard-size": { type: "string", default: "128" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(HELP);
  else if (values.input) {
    assert(
      !values["convert-frozen"] && !values.frozen && !values.orb,
      "Choose frozen conversion OR explicit-input extraction.",
    );
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => controller.abort());
    const { buildOfflineLearnedPack } = await import("./learned-builder.mjs");
    console.log(
      JSON.stringify(
        await buildOfflineLearnedPack({
          input: values.input,
          images: values.images,
          assets: values.assets,
          cache: values.cache,
          out: values.out,
          shardSize: Number(values["shard-size"]),
          allowFullCatalog: values["allow-full-catalog"],
          signal: controller.signal,
        }),
        null,
        2,
      ),
    );
  } else {
    assert(
      values["convert-frozen"] && values.frozen && values.orb && values.out,
      HELP,
    );
    console.log(
      JSON.stringify(
        await convertFrozenGallery({
          frozen: values.frozen,
          orb: values.orb,
          out: values.out,
          shardSize: Number(values["shard-size"]),
        }),
        null,
        2,
      ),
    );
  }
}
