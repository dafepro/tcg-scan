import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  importLearnedArchive,
  importLearnedArchiveSource,
  LEARNED_ARCHIVE_LIMITS,
} from "./learned-archive";
import {
  LEARNED_DATABASE_NAME,
  LEARNED_MAX_MANIFEST_BYTES,
  LEARNED_MAX_SHARD_BYTES,
  LEARNED_MODEL_DATA_SHA256,
  LEARNED_MODEL_ID,
  LEARNED_MODEL_SHA256,
  LEARNED_PACK_FORMAT,
  LEARNED_PREPROCESS_ID,
  LEARNED_QUANTIZATION_ID,
  LEARNED_RECORD_BYTES,
  LEARNED_SELECTION_ID,
  listLearnedPacks,
  removeCorruptLearnedPack,
  loadLearnedIndex,
  loadLearnedReference,
  type LearnedPackManifest,
} from "./learned-packs";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
interface InputEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  attributes?: number;
  expanded?: number;
  crc?: number;
  descriptor?: "signed" | "unsigned";
  extra?: Uint8Array;
}
/** Original minimal ZIP fixture writer, independent of the production reader. */
function zip(input: InputEntry[], comment = "") {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  const positions: {
    local: number;
    data: number;
    end: number;
    central: number;
  }[] = [];
  let offset = 0,
    centralSize = 0;
  for (const entry of input) {
    const filename = Buffer.from(entry.name),
      extra = Buffer.from(entry.extra ?? []),
      method = entry.method ?? 8,
      compressed =
        method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data),
      flags = (entry.flags ?? 0x0800) | (entry.descriptor ? 8 : 0),
      crc = entry.crc ?? crc32(entry.data),
      expanded = entry.expanded ?? entry.data.length,
      head = Buffer.alloc(30),
      directory = Buffer.alloc(46),
      descriptor = Buffer.alloc(
        entry.descriptor === "signed" ? 16 : entry.descriptor ? 12 : 0,
      );
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(compressed.length, 18);
      head.writeUInt32LE(expanded, 22);
    }
    head.writeUInt16LE(filename.length, 26);
    head.writeUInt16LE(extra.length, 28);
    if (entry.descriptor) {
      const base = entry.descriptor === "signed" ? 4 : 0;
      if (base) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, base);
      descriptor.writeUInt32LE(compressed.length, base + 4);
      descriptor.writeUInt32LE(expanded, base + 8);
    }
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(expanded, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(
      entry.attributes ?? (entry.name.endsWith("/") ? 0x41ed0010 : 0x81a40000),
      38,
    );
    directory.writeUInt32LE(offset, 42);
    const data = offset + 30 + filename.length + extra.length;
    positions.push({
      local: offset,
      data,
      end: data + compressed.length,
      central: centralSize,
    });
    local.push(head, filename, extra, compressed, descriptor);
    central.push(directory, filename, extra);
    offset = data + compressed.length + descriptor.length;
    centralSize += 46 + filename.length + extra.length;
  }
  for (const position of positions) position.central += offset;
  const end = Buffer.alloc(22),
    commentBytes = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(input.length, 8);
  end.writeUInt16LE(input.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  const bytes = Buffer.concat([...local, ...central, end, commentBytes]);
  return {
    bytes,
    positions,
    eocd: bytes.length - commentBytes.length - 22,
    file: () => new File([Uint8Array.from(bytes)], "references.zip"),
  };
}
function pack(count = 3, prefix = "reference-pack/") {
  const payload = Buffer.alloc(LEARNED_RECORD_BYTES);
  for (let i = 0; i < 256; i++) {
    payload.writeFloatLE(10 + (i % 20), i * 8);
    payload.writeFloatLE(20 + (i % 30), i * 8 + 4);
    payload.writeFloatLE(1 / 1024, 2048 + i * 4);
    payload.writeInt8(127, 3072 + i * 64);
  }
  const manifest: LearnedPackManifest = {
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
    recordBytes: LEARNED_RECORD_BYTES,
    name: "Synthetic archive pack",
    createdAt: "2026-10-12T00:00:00Z",
    coverage: {
      scope: "fixture",
      game: "pokemon",
      extractedImages: count,
      names: count,
      missingImages: 0,
      failedImages: 0,
      provider: "Synthetic tests",
      note: "Synthetic numbers only; no artwork.",
    },
    shards: [],
    records: [],
  };
  const entries: InputEntry[] = [];
  for (let i = 0; i < count; i++) {
    const data = Buffer.alloc(32 + payload.length),
      filename = `features-${String(i + 1).padStart(5, "0")}.bin`;
    data.write("TCGLRN01", 0);
    data.writeUInt32LE(1, 8);
    data.writeUInt32LE(LEARNED_RECORD_BYTES, 12);
    data.writeUInt32LE(1, 16);
    data.writeUInt32LE(i, 20);
    data.set(payload, 32);
    manifest.shards.push({
      file: filename,
      count: 1,
      bytes: data.length,
      sha256: sha(data),
    });
    manifest.records.push({
      key: `pokemon:zip-${i}`,
      game: "pokemon",
      name: `Fixture ${i}`,
      hash: "0123456789abcdef",
      differenceHash: "fedcba9876543210",
      shard: i,
      offset: 32,
      sha256: sha(payload),
    });
    entries.push({ name: prefix + filename, data });
  }
  entries.unshift({
    name: prefix + "manifest.learned.json",
    data: Buffer.from(JSON.stringify(manifest)),
  });
  return { entries, manifest };
}
async function rowCounts() {
  return new Promise<Record<string, number>>((resolve, reject) => {
    const request = indexedDB.open(LEARNED_DATABASE_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const result: Record<string, number> = {};
      const tx = db.transaction(["packs", "records", "index"], "readonly");
      for (const name of ["packs", "records", "index"]) {
        const count = tx.objectStore(name).count();
        count.onsuccess = () => {
          result[name] = count.result;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
function pauseRead(file: File, start: number) {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    slice = file.slice.bind(file);
  vi.spyOn(file, "slice").mockImplementation((from, to) => {
    const blob = slice(from, to),
      read = blob.arrayBuffer.bind(blob);
    if (from === start)
      vi.spyOn(blob, "arrayBuffer").mockImplementation(async () => {
        started();
        await gate;
        return read();
      });
    return blob;
  });
  return { entered, release };
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("one-file learned-pack ZIP import", () => {
  it("pins an expected manifest before opening or reserving storage", async () => {
    const source = pack(1),
      archive = zip(source.entries),
      open = vi.spyOn(indexedDB, "open");
    await expect(
      importLearnedArchive(archive.file(), {
        expectedManifestSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(open).not.toHaveBeenCalled();
    await expect(
      importLearnedArchive(archive.file(), {
        expectedManifestSha256: "not-a-checksum",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(open).not.toHaveBeenCalled();
    const installed = await importLearnedArchive(archive.file(), {
      expectedManifestSha256: sha(source.entries[0].data),
    });
    expect(installed.readiness).toBe("ready");
    await expect(
      importLearnedArchive(archive.file(), {
        expectedManifestSha256: "1".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await listLearnedPacks()).toEqual([installed]);
    expect(await rowCounts()).toEqual({ packs: 1, records: 1, index: 1 });
  });
  it("uses the same bounded importer for a stable byte-range source", async () => {
    const archive = zip(pack(2).entries),
      controller = new AbortController(),
      read = vi.fn(async (start: number, end: number, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(archive.bytes.length);
        expect(end - start).toBeLessThanOrEqual(65557);
        return Uint8Array.from(archive.bytes.subarray(start, end)).buffer;
      });
    expect(
      (
        await importLearnedArchiveSource(
          { size: archive.bytes.length, read },
          {
            signal: controller.signal,
          },
        )
      ).cards,
    ).toBe(2);
    expect(read).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a byte-range source that returns a different range length", async () => {
    const archive = zip(pack(2).entries);
    await expect(
      importLearnedArchiveSource({
        size: archive.bytes.length,
        read: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/truncated/);
    expect(await listLearnedPacks()).toEqual([]);
  });
  it.each(["", "reference-pack/", "One folder/", "One folder/reference-pack/"])(
    "imports all shards from %s lazily and verifies persisted features",
    async (prefix) => {
      const source = pack(3, prefix),
        root = prefix.startsWith("One folder/") ? "One folder/" : "";
      const archive = zip(
        [
          ...source.entries,
          { name: root + "LICENSES/", data: new Uint8Array(), method: 0 },
          {
            name: root + "LICENSES/notice.txt",
            data: Buffer.from("Documentation is not imported."),
          },
        ],
        "ZIP comment",
      );
      const progress = vi.fn(),
        file = archive.file(),
        wholeRead = vi.spyOn(file, "arrayBuffer");
      const result = await importLearnedArchive(file, { onProgress: progress });
      expect(result).toMatchObject({ readiness: "ready", cards: 3, names: 3 });
      expect(wholeRead).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
        phase: "complete",
        completed: 3,
      });
      const index = await loadLearnedIndex("pokemon");
      expect(index).toHaveLength(3);
      const features = await loadLearnedReference(index[0].featureId);
      expect(features?.descriptors[0]).toBe(127);
    },
  );
  it.each([0, 8])(
    "supports compression method %s and mixed Stored/Deflate",
    async (method) => {
      const source = pack(2);
      source.entries[0].method = method;
      source.entries[1].method = 0;
      expect(
        (await importLearnedArchive(zip(source.entries).file())).cards,
      ).toBe(2);
    },
  );
  it.each(["signed", "unsigned"] as const)(
    "supports %s data descriptors",
    async (descriptor) => {
      const entries = pack(2).entries.map((entry) => ({
        ...entry,
        descriptor,
      }));
      expect((await importLearnedArchive(zip(entries).file())).cards).toBe(2);
    },
  );
  it("rejects a false data descriptor before creating a pack", async () => {
    const archive = zip(
      pack().entries.map((entry) => ({ ...entry, descriptor: "signed" })),
    );
    archive.bytes.writeUInt32LE(123, archive.positions[0].end + 4);
    await expect(importLearnedArchive(archive.file())).rejects.toThrow(
      /data descriptor/,
    );
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("keeps an already-installed pack intact and avoids rereading its shards", async () => {
    const archive = zip(pack().entries),
      installed = await importLearnedArchive(archive.file()),
      file = archive.file();
    const slice = vi.spyOn(file, "slice");
    expect(await importLearnedArchive(file)).toEqual(installed);
    for (const entry of archive.positions.slice(1))
      expect(slice.mock.calls.some(([from]) => from === entry.data)).toBe(
        false,
      );
    expect(await rowCounts()).toEqual({ packs: 1, records: 3, index: 3 });
  });
  it("does not read any descriptor payload until quota validation succeeds", async () => {
    const archive = zip(pack().entries),
      file = archive.file(),
      slice = vi.spyOn(file, "slice");
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1, usage: 0 }) },
    });
    await expect(importLearnedArchive(file)).rejects.toMatchObject({
      code: "quota",
    });
    for (const entry of archive.positions.slice(1))
      expect(slice.mock.calls.some(([from]) => from === entry.data)).toBe(
        false,
      );
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("retains one-entry-at-a-time lazy reads and never loads ignored document payloads", async () => {
    const source = pack(5);
    const archive = zip([
      {
        name: "unread-document.txt",
        data: Buffer.alloc(200_000, 7),
        method: 0,
      },
      ...source.entries.map((entry) => ({ ...entry, method: 0 })),
    ]);
    const file = archive.file(),
      original = file.slice.bind(file),
      requests: [number, number][] = [];
    let active = 0,
      maxActive = 0;
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(
      new Error("whole-file read prohibited"),
    );
    vi.spyOn(file, "slice").mockImplementation((start = 0, end = file.size) => {
      requests.push([start, end]);
      const blob = original(start, end),
        read = blob.arrayBuffer.bind(blob);
      vi.spyOn(blob, "arrayBuffer").mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await read();
        } finally {
          active--;
        }
      });
      return blob;
    });
    await importLearnedArchive(file);
    expect(maxActive).toBe(1);
    expect(Math.max(...requests.map(([a, b]) => b - a))).toBeLessThanOrEqual(
      65557,
    );
    const document = archive.positions[0];
    expect(requests.some(([a]) => a >= document.data && a < document.end)).toBe(
      false,
    );
  });
});

describe("ZIP structure and bounded extraction", () => {
  it.each([
    "../evil",
    "/absolute",
    "C:/evil",
    "x\\evil",
    "x/../evil",
    "x//evil",
    "./evil",
    "nul\u0000evil",
    "x/ /evil",
    "x./evil",
  ])("rejects unsafe path %j before storage", async (name) => {
    await expect(
      importLearnedArchive(
        zip([...pack().entries, { name, data: Buffer.from("x") }]).file(),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await listLearnedPacks()).toEqual([]);
  });
  it.each(["README.txt", "readme.TXT", "README.txt/"])(
    "rejects duplicate or conflicting paths %s",
    async (name) => {
      await expect(
        importLearnedArchive(
          zip([
            ...pack().entries,
            { name: "README.txt", data: Buffer.from("x") },
            { name, data: new Uint8Array(), method: 0 },
          ]).file(),
        ),
      ).rejects.toThrow(/duplicate|ambiguous/i);
    },
  );
  it("rejects Unicode-normalized duplicate paths", async () => {
    await expect(
      importLearnedArchive(
        zip([
          ...pack().entries,
          { name: "é.txt", data: new Uint8Array() },
          { name: "e\u0301.txt", data: new Uint8Array() },
        ]).file(),
      ),
    ).rejects.toThrow(/duplicate/);
  });
  it("rejects a file that doubles as an ancestor directory", async () => {
    await expect(
      importLearnedArchive(
        zip([
          ...pack().entries,
          { name: "LICENSES", data: new Uint8Array() },
          { name: "LICENSES/a.txt", data: new Uint8Array() },
        ]).file(),
      ),
    ).rejects.toThrow(/also used as a directory/);
  });
  it.each([0xa1ff0000, 0x61b60000, 0x21b60000])(
    "rejects symlinks and special modes %s",
    async (attributes) => {
      const entries = pack().entries;
      entries.push({ name: "special", data: new Uint8Array(), attributes });
      await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
        /symlinks|special/,
      );
    },
  );
  it.each([1, 0x40, 0x2000, 0x10, 0x4000])(
    "rejects encrypted or unsupported flags %s",
    async (flags) => {
      const entries = pack().entries;
      entries[0].flags = flags;
      await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
        /encrypted|unsupported/,
      );
    },
  );
  it("rejects unsupported compression even in ignored documentation", async () => {
    await expect(
      importLearnedArchive(
        zip([
          ...pack().entries,
          { name: "readme", data: Buffer.from("abc"), method: 12 },
        ]).file(),
      ),
    ).rejects.toThrow(/only Stored and Deflate/);
  });
  it.each([
    [
      "archive disk",
      (z: ReturnType<typeof zip>) => z.bytes.writeUInt16LE(1, z.eocd + 4),
    ],
    [
      "entry disk",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt16LE(1, z.positions[0].central + 34),
    ],
    [
      "ZIP64 directory",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(0xffffffff, z.eocd + 16),
    ],
    [
      "ZIP64 entry",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(0xffffffff, z.positions[0].central + 24),
    ],
    [
      "entry count",
      (z: ReturnType<typeof zip>) => {
        z.bytes.writeUInt16LE(4097, z.eocd + 8);
        z.bytes.writeUInt16LE(4097, z.eocd + 10);
      },
    ],
    [
      "directory bound",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(
          LEARNED_ARCHIVE_LIMITS.centralDirectoryBytes + 1,
          z.eocd + 12,
        ),
    ],
    [
      "local overlap",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(1, z.positions[1].central + 42),
    ],
    [
      "duplicate local offset",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(0, z.positions[1].central + 42),
    ],
    [
      "local name",
      (z: ReturnType<typeof zip>) => {
        z.bytes[z.positions[0].local + 30] ^= 1;
      },
    ],
    [
      "local size",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(1, z.positions[0].local + 18),
    ],
    [
      "out-of-bounds payload",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(500_000, z.positions[0].central + 20),
    ],
    [
      "central filename bound",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt16LE(65535, z.positions[0].central + 28),
    ],
    [
      "local extra bound",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt16LE(65535, z.positions[0].local + 28),
    ],
    [
      "declared manifest size",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(
          LEARNED_MAX_MANIFEST_BYTES + 1,
          z.positions[0].central + 24,
        ),
    ],
    [
      "compressed entry cap",
      (z: ReturnType<typeof zip>) =>
        z.bytes.writeUInt32LE(
          LEARNED_ARCHIVE_LIMITS.compressedEntryBytes + 1,
          z.positions[0].central + 20,
        ),
    ],
  ] as const)("rejects malformed %s", async (_name, mutate) => {
    const archive = zip(pack().entries);
    mutate(archive);
    await expect(importLearnedArchive(archive.file())).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await listLearnedPacks()).toEqual([]);
  });
  it.each([1, 8, 22, 100])(
    "rejects a ZIP truncated by %s bytes",
    async (cut) => {
      const archive = zip(pack().entries);
      await expect(
        importLearnedArchive(
          new File(
            [Uint8Array.from(archive.bytes.subarray(0, -cut))],
            "truncated.zip",
          ),
        ),
      ).rejects.toMatchObject({ code: "invalid" });
    },
  );
  it("rejects a short underlying Blob read", async () => {
    const file = zip(pack().entries).file();
    vi.spyOn(file, "slice").mockReturnValue(new Blob([]));
    await expect(importLearnedArchive(file)).rejects.toThrow(/truncated/);
  });
  it("rejects an oversized archive before reading anything", async () => {
    const file = zip(pack().entries).file(),
      slice = vi.spyOn(file, "slice");
    Object.defineProperty(file, "size", {
      value: LEARNED_ARCHIVE_LIMITS.archiveBytes + 1,
    });
    await expect(importLearnedArchive(file)).rejects.toThrow(/1.5 GiB/);
    expect(slice).not.toHaveBeenCalled();
  });
  it("bounds total declared expansion including ignored documentation", async () => {
    const entries = pack().entries;
    for (let i = 0; i < 25; i++)
      entries.push({
        name: `document-${i}`,
        data: Buffer.from("x"),
        expanded: LEARNED_ARCHIVE_LIMITS.entryBytes,
      });
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /expanded archive/,
    );
  });
  it.each([
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([1]),
    Buffer.from([2, 0, 9, 0]),
  ])("rejects ZIP64 or malformed extra fields %j", async (extra) => {
    const entries = pack().entries;
    entries[0].extra = extra;
    await expect(
      importLearnedArchive(zip(entries).file()),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("bounds the binary shard before decompressing it", async () => {
    const entries = pack().entries;
    entries[1].expanded = LEARNED_MAX_SHARD_BYTES + 1;
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /binary shard exceeds/,
    );
  });
  it("rejects missing, duplicated, misplaced, or ambiguous packs", async () => {
    const { entries } = pack();
    for (const invalidEntries of [
      entries.slice(1),
      [...entries, entries[0]],
      [...entries, { ...entries[0], name: "other/manifest.learned.json" }],
      pack(1, "a/b/").entries,
      [
        ...pack(1, "folder/reference-pack/").entries,
        { name: "outside", data: new Uint8Array() },
      ],
      [entries[0], { ...entries[1], name: "other/features-00001.bin" }],
    ])
      await expect(
        importLearnedArchive(zip(invalidEntries).file()),
      ).rejects.toMatchObject({ code: "invalid" });
  });
  it("enforces the manifest's exact shard list and SHA-256 beyond ZIP CRC32", async () => {
    const missing = pack();
    missing.entries.pop();
    await expect(
      importLearnedArchive(zip(missing.entries).file()),
    ).rejects.toMatchObject({ code: "invalid" });
    const changed = pack();
    changed.entries[2].data[100] ^= 1;
    await expect(
      importLearnedArchive(zip(changed.entries).file()),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await rowCounts()).toEqual({ packs: 0, index: 0, records: 0 });
  });
  it("validates CRC32 for the manifest before creating a reservation", async () => {
    const entries = pack().entries;
    entries[0].crc = 0;
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /CRC32/,
    );
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("rejects understated deflate output immediately and cancels the reader", async () => {
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const entries = [
      {
        name: "manifest.learned.json",
        data: Buffer.alloc(2_000_000, 32),
        expanded: 64,
      },
    ];
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /exceeds the declared size/,
    );
    expect(cancel).toHaveBeenCalled();
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("rejects overstated expanded output and corrupted deflate streams", async () => {
    const entries = pack().entries;
    entries[0].expanded = entries[0].data.length + 1;
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /expanded size/,
    );
    const archive = zip(pack().entries);
    archive.bytes[archive.positions[0].data] = 0xff;
    await expect(importLearnedArchive(archive.file())).rejects.toMatchObject({
      code: "corrupt",
    });
  });
  it("gives a compatibility error with no unbounded fallback", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    await expect(
      importLearnedArchive(zip(pack().entries).file()),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/Update your browser.*Advanced setup/),
    });
    expect(await listLearnedPacks()).toEqual([]);
    const stored = pack(1).entries.map((entry) => ({ ...entry, method: 0 }));
    expect((await importLearnedArchive(zip(stored).file())).cards).toBe(1);
  });
});

describe("ZIP cancellation, visibility, and token-scoped rollback", () => {
  it("rechecks corrupt-only cleanup transactionally and preserves ready/importing replacements", async () => {
    const installed = await importLearnedArchive(zip(pack(1).entries).file());
    async function readiness(value: "ready" | "importing" | "corrupt") {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(LEARNED_DATABASE_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("packs", "readwrite"),
            store = tx.objectStore("packs"),
            row = store.get(installed.id);
          row.onsuccess = () => store.put({ ...row.result, readiness: value });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    }
    await removeCorruptLearnedPack(installed.id);
    expect(await rowCounts()).toEqual({ packs: 1, records: 1, index: 1 });
    // A stale caller may have seen corrupt before another task replaced it.
    await readiness("importing");
    await removeCorruptLearnedPack(installed.id);
    expect(await rowCounts()).toEqual({ packs: 1, records: 1, index: 1 });
    await readiness("corrupt");
    await removeCorruptLearnedPack(installed.id);
    expect(await rowCounts()).toEqual({ packs: 0, records: 0, index: 0 });
  });
  it("cancels before any archive read", async () => {
    const controller = new AbortController(),
      file = zip(pack().entries).file(),
      slice = vi.spyOn(file, "slice");
    controller.abort();
    await expect(
      importLearnedArchive(file, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(slice).not.toHaveBeenCalled();
  });
  it("keeps a partly stored pack unavailable and cancels an active reader", async () => {
    const archive = zip(pack().entries),
      file = archive.file(),
      gate = pauseRead(file, archive.positions[2].data),
      controller = new AbortController(),
      cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const importing = importLearnedArchive(file, { signal: controller.signal });
    const rejection = expect(importing).rejects.toMatchObject({
      code: "aborted",
    });
    await gate.entered;
    expect((await listLearnedPacks())[0].readiness).toBe("importing");
    expect(await loadLearnedIndex()).toEqual([]);
    expect(await rowCounts()).toEqual({ packs: 1, records: 1, index: 1 });
    controller.abort();
    // Cancellation is not dependent on the pending bounded Blob read finishing.
    await rejection;
    expect(cancel).toHaveBeenCalled();
    gate.release();
    expect(await rowCounts()).toEqual({ packs: 0, records: 0, index: 0 });
  });
  it("cleans up earlier shards after a later CRC32 failure", async () => {
    const entries = pack().entries;
    entries[2].crc = 1;
    await expect(importLearnedArchive(zip(entries).file())).rejects.toThrow(
      /CRC32/,
    );
    expect(await rowCounts()).toEqual({ packs: 0, index: 0, records: 0 });
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("does not delete a preexisting ready pack when another import fails", async () => {
    const old = await importLearnedArchive(zip(pack(1).entries).file());
    const source = pack(3),
      replacement = JSON.parse(
        source.entries[0].data.toString(),
      ) as LearnedPackManifest;
    replacement.records = replacement.records.map((record, i) => ({
      ...record,
      key: `pokemon:new-${i}`,
    }));
    source.entries[0].data = Buffer.from(JSON.stringify(replacement));
    source.entries[2].crc = 1;
    await expect(
      importLearnedArchive(zip(source.entries).file()),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await listLearnedPacks()).toEqual([old]);
    expect(await rowCounts()).toEqual({ packs: 1, records: 1, index: 1 });
  });
  it("rejects a concurrent duplicate without deleting the first import", async () => {
    const archive = zip(pack().entries),
      first = archive.file(),
      gate = pauseRead(first, archive.positions[1].data);
    const importing = importLearnedArchive(first);
    await gate.entered;
    await expect(importLearnedArchive(archive.file())).rejects.toMatchObject({
      code: "conflict",
    });
    gate.release();
    expect((await importing).readiness).toBe("ready");
    expect(await rowCounts()).toEqual({ packs: 1, records: 3, index: 3 });
  });
});
