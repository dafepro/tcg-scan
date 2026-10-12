/** Original numerical ZIP fixture. No card artwork, extracted commercial features,
 * camera pixels, private paths, or matching-accuracy claims. */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  LEARNED_MODEL_DATA_SHA256,
  LEARNED_MODEL_ID,
  LEARNED_MODEL_SHA256,
  LEARNED_PACK_FORMAT,
  LEARNED_PREPROCESS_ID,
  LEARNED_QUANTIZATION_ID,
  LEARNED_RECORD_BYTES,
  LEARNED_SELECTION_ID,
} from "../../src/lib/learned-packs";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Minimal ordinary ZIP writer, independent of the production reader. */
function zip(entries: { name: string; bytes: Buffer }[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name),
      body = deflateRawSync(bytes),
      checksum = crc32(bytes);
    const h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(checksum, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(filename.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(h, filename, body);
    central.push(c, filename);
    offset += h.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function originalInstallerArchive() {
  const record = Buffer.alloc(LEARNED_RECORD_BYTES);
  for (let i = 0; i < 256; i++) {
    record.writeFloatLE(10 + (i % 20), i * 8);
    record.writeFloatLE(20 + (i % 30), i * 8 + 4);
    record.writeFloatLE(1 / 1024, 2048 + i * 4);
    record.writeInt8(127, 3072 + i * 64);
  }
  const binary = Buffer.alloc(32 + record.length);
  binary.write("TCGLRN01");
  binary.writeUInt32LE(1, 8);
  binary.writeUInt32LE(record.length, 12);
  binary.writeUInt32LE(1, 16);
  record.copy(binary, 32);
  const manifest = {
    format: LEARNED_PACK_FORMAT,
    version: 1,
    algorithm: "xfeat256-int8-v1",
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
    recordBytes: record.length,
    name: "Original installer mechanics fixture",
    createdAt: "2026-10-12T00:00:00Z",
    coverage: {
      scope: "fixture",
      game: "pokemon",
      extractedImages: 1,
      names: 1,
      missingImages: 0,
      failedImages: 0,
      provider: "Original numerical fixture",
      note: "Installation mechanics only; not artwork or recognition evidence.",
    },
    shards: [
      {
        file: "features-00001.bin",
        count: 1,
        bytes: binary.length,
        sha256: sha(binary),
      },
    ],
    records: [
      {
        key: "pokemon:installer-fixture",
        name: "Installer fixture",
        game: "pokemon",
        hash: "0123456789abcdef",
        differenceHash: "fedcba9876543210",
        sha256: sha(record),
        offset: 32,
        shard: 0,
      },
    ],
  };
  return zip([
    {
      name: "manifest.learned.json",
      bytes: Buffer.from(JSON.stringify(manifest)),
    },
    { name: "features-00001.bin", bytes: binary },
  ]);
}
