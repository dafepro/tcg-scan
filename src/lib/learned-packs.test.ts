import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import {
  LEARNED_DATABASE_NAME,
  LEARNED_PACK_FORMAT,
  LEARNED_MODEL_ID,
  LEARNED_MODEL_SHA256,
  LEARNED_MODEL_DATA_SHA256,
  LEARNED_PREPROCESS_ID,
  LEARNED_SELECTION_ID,
  LEARNED_QUANTIZATION_ID,
  LEARNED_RECORD_BYTES,
  LEARNED_SHARD_HEADER_BYTES,
  LEARNED_MAX_MANIFEST_BYTES,
  LEARNED_MAX_REFERENCES,
  LEARNED_MAX_SHARD_RECORDS,
  LEARNED_MAX_SHARD_BYTES,
  importLearnedPack,
  listLearnedPacks,
  loadLearnedIndex,
  loadLearnedReference,
  removeLearnedPack,
  validateLearnedManifest,
  decodeLearnedRecord,
  learnedReferenceCacheStats,
  type LearnedPackManifest,
  type LearnedPackFile,
} from "./learned-packs";
import { MAX_HASH_REFERENCES } from "./vision/hash";
import type { VisionGame } from "./vision/types";
import { addScanEvent } from "./scan-inventory";
import { EMPTY_DATA, parseBackup } from "./storage";
import { CARD_IMAGE_HOSTS } from "./provider-image-policy";

async function sha(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function payload(): ArrayBuffer {
  const bytes = new ArrayBuffer(LEARNED_RECORD_BYTES),
    view = new DataView(bytes);
  for (let i = 0; i < 256; i++) {
    view.setFloat32(i * 8, 10 + (i % 20), true);
    view.setFloat32(i * 8 + 4, 20 + (i % 30), true);
    view.setFloat32(2048 + i * 4, 1 / 1024, true);
    view.setInt8(3072 + i * 64, 127);
  }
  return bytes;
}
async function fixture(
  count = 1,
  perShard = 128,
  game: VisionGame = "pokemon",
  prefix = "fixture",
) {
  const data = payload(),
    recordSha = await sha(data);
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
    name: "Synthetic learned pack",
    createdAt: "2026-10-12T00:00:00Z",
    coverage: {
      scope: "fixture",
      game,
      extractedImages: count,
      names: count,
      missingImages: 0,
      failedImages: 0,
      provider: "Synthetic fixture",
      note: "Only synthetic numerical fixtures. No real artwork.",
    },
    shards: [],
    records: [],
  };
  const binaryFiles: File[] = [];
  for (let start = 0; start < count; start += perShard) {
    const n = Math.min(perShard, count - start),
      shard = manifest.shards.length;
    const bytes = new ArrayBuffer(32 + n * LEARNED_RECORD_BYTES),
      view = new DataView(bytes);
    new Uint8Array(bytes, 0, 8).set(new TextEncoder().encode("TCGLRN01"));
    view.setUint32(8, 1, true);
    view.setUint32(12, LEARNED_RECORD_BYTES, true);
    view.setUint32(16, n, true);
    view.setUint32(20, shard, true);
    for (let i = 0; i < n; i++) {
      const offset = LEARNED_SHARD_HEADER_BYTES + i * LEARNED_RECORD_BYTES;
      new Uint8Array(bytes, offset, data.byteLength).set(new Uint8Array(data));
      manifest.records.push({
        key: `${game}:${prefix}-${start + i}`,
        name: `Fixture ${start + i}`,
        game,
        hash: "0123456789abcdef",
        differenceHash: "fedcba9876543210",
        sha256: recordSha,
        offset,
        shard,
      });
    }
    const name = `features-${String(shard + 1).padStart(5, "0")}.bin`;
    manifest.shards.push({
      file: name,
      count: n,
      bytes: bytes.byteLength,
      sha256: await sha(bytes),
    });
    binaryFiles.push(new File([bytes], name));
  }
  const files = () => [
    new File([JSON.stringify(manifest)], "manifest.learned.json"),
    ...binaryFiles,
  ];
  return { manifest, binaryFiles, files };
}
async function changeStore(
  store: string,
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(LEARNED_DATABASE_NAME, 1);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction(store, "readwrite");
      action(tx.objectStore(store));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}
async function mutateRow(
  store: string,
  key: string,
  mutate: (row: Record<string, unknown>) => void,
) {
  await changeStore(store, (s) => {
    const request = s.get(key);
    request.onsuccess = () => {
      mutate(request.result);
      s.put(request.result);
    };
  });
}
/** Simulate a large durable reservation without allocating a GiB of features. */
async function seedCapacity(
  game: VisionGame,
  cards: number,
  readiness: "ready" | "importing" = "importing",
) {
  const source = await fixture(1, 1, game, "reserved"),
    pack = await importLearnedPack(source.files());
  const { readiness: ignored, error, ...stable } = pack;
  void ignored;
  void error;
  stable.cards = cards;
  stable.byGame[game] = cards;
  stable.coverage.extractedImages = cards;
  const metadataChecksum = await sha(
    new TextEncoder().encode(JSON.stringify(stable)).buffer,
  );
  await mutateRow("packs", pack.id, (row) => {
    Object.assign(row, stable, { readiness, metadataChecksum });
  });
  return { ...stable, readiness };
}

function pauseFirstShard(source: Awaited<ReturnType<typeof fixture>>) {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    }),
    first = source.binaryFiles[0],
    read = first.arrayBuffer.bind(first);
  vi.spyOn(first, "arrayBuffer").mockImplementation(async () => {
    started();
    await gate;
    return read();
  });
  return { entered, release };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network permitted");
    }),
  );
});

describe("closed, versioned learned manifest", () => {
  it("accepts the frozen representation and truthful coverage", async () => {
    const source = await fixture(3, 2),
      result = validateLearnedManifest(source.manifest);
    expect(result.records).toHaveLength(3);
    expect(result.shards).toHaveLength(2);
    expect(result.coverage).toMatchObject({ names: 3, extractedImages: 3 });
  });
  it.each([
    [
      "version",
      (p: LearnedPackManifest) => {
        Object.assign(p, { version: 2 });
      },
    ],
    [
      "unknown field",
      (p: LearnedPackManifest) => {
        Object.assign(p, { script: "alert(1)" });
      },
    ],
    [
      "model identity",
      (p: LearnedPackManifest) => {
        Object.assign(p.model, { sha256: "0".repeat(64) });
      },
    ],
    [
      "preprocessing",
      (p: LearnedPackManifest) => {
        Object.assign(p, { preprocess: "normalize-differently" });
      },
    ],
    [
      "canonical dimensions",
      (p: LearnedPackManifest) => {
        Object.assign(p, { width: 241 });
      },
    ],
    [
      "feature count",
      (p: LearnedPackManifest) => {
        Object.assign(p, { points: 500 });
      },
    ],
    [
      "name coverage",
      (p: LearnedPackManifest) => {
        p.coverage.names = 300;
      },
    ],
    [
      "image coverage",
      (p: LearnedPackManifest) => {
        p.coverage.extractedImages = 300;
      },
    ],
    [
      "full catalog overclaim",
      (p: LearnedPackManifest) => {
        p.coverage.scope = "full-catalog";
      },
    ],
    [
      "bad hash",
      (p: LearnedPackManifest) => {
        p.records[0].hash = "0";
      },
    ],
    [
      "bad checksum",
      (p: LearnedPackManifest) => {
        p.records[0].sha256 = "not-a-checksum";
      },
    ],
    [
      "path traversal",
      (p: LearnedPackManifest) => {
        p.shards[0].file = "../features-00001.bin";
      },
    ],
    [
      "oversized shard",
      (p: LearnedPackManifest) => {
        p.shards[0].bytes = LEARNED_MAX_SHARD_BYTES + 1;
      },
    ],
    [
      "offset overlap",
      (p: LearnedPackManifest) => {
        p.records[1].offset = p.records[0].offset;
      },
    ],
    [
      "duplicate key",
      (p: LearnedPackManifest) => {
        p.records[1].key = p.records[0].key;
      },
    ],
    [
      "game namespace",
      (p: LearnedPackManifest) => {
        p.records[0].key = "mtg:wrong";
      },
    ],
    [
      "unknown provider",
      (p: LearnedPackManifest) => {
        p.records[0].sourceUrl = "https://evil.example/card";
      },
    ],
    [
      "credential URL",
      (p: LearnedPackManifest) => {
        p.records[0].sourceUrl = "https://user:password@api.tcgdex.net/card";
      },
    ],
    [
      "executable URL",
      (p: LearnedPackManifest) => {
        p.records[0].imageUrl = "javascript:alert(1)";
      },
    ],
    [
      "raw artwork",
      (p: LearnedPackManifest) => {
        Object.assign(p.records[0], { image: "base64-image" });
      },
    ],
  ])("rejects %s", async (_label, mutate) => {
    const { manifest } = await fixture(2);
    mutate(manifest);
    expect(() => validateLearnedManifest(manifest)).toThrow();
  });
  it("counts unavailable advertised images separately in full coverage without changing old manifests", async () => {
    const { manifest } = await fixture();
    expect(validateLearnedManifest(manifest).coverage).not.toHaveProperty(
      "unavailableImages",
    );
    Object.assign(manifest.coverage, {
      scope: "full-catalog",
      catalogCards: 3,
      availableImages: 2,
      missingImages: 1,
      failedImages: 0,
      unavailableImages: 1,
    });
    expect(validateLearnedManifest(manifest).coverage).toMatchObject({
      extractedImages: 1,
      failedImages: 0,
      unavailableImages: 1,
      missingImages: 1,
    });
    Object.assign(manifest.coverage, { unavailableImages: 2 });
    expect(() => validateLearnedManifest(manifest)).toThrow(/account for/);
  });
  it("rejects YGO browser artwork hotlinks", async () => {
    const { manifest } = await fixture();
    manifest.coverage.game = "yugioh";
    Object.assign(manifest.records[0], {
      game: "yugioh",
      key: "yugioh:1",
      imageUrl: "https://images.ygoprodeck.com/images/cards/1.jpg",
    });
    expect(() => validateLearnedManifest(manifest)).toThrow(
      /never browser-hotlinked/,
    );
  });
  it("requires complete, unique, exact filenames and bounds manifest before reading", async () => {
    const source = await fixture(2, 1);
    await expect(
      importLearnedPack(source.files().slice(0, 2)),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      importLearnedPack([...source.files(), source.files()[1]]),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      importLearnedPack([...source.files(), new File(["x"], "extra.txt")]),
    ).rejects.toThrow(/extra files/);
    const arrayBuffer = vi.fn();
    const huge = {
      name: "huge.learned.json",
      size: LEARNED_MAX_MANIFEST_BYTES + 1,
      arrayBuffer,
    } as unknown as LearnedPackFile;
    await expect(importLearnedPack([huge])).rejects.toThrow(/64 MiB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(
      importLearnedPack([new File(["{}"], "manifest.json")]),
    ).rejects.toThrow(/learned.json/);
  });
});

describe("learned import image policy matches durable collection storage", () => {
  it("keeps the shared host policy immutable", () => {
    expect(Object.isFrozen(CARD_IMAGE_HOSTS)).toBe(true);
    for (const hosts of Object.values(CARD_IMAGE_HOSTS))
      expect(Object.isFrozen(hosts)).toBe(true);
    expect(CARD_IMAGE_HOSTS).toEqual({
      pokemon: ["assets.tcgdex.net"],
      mtg: ["cards.scryfall.io"],
      yugioh: [],
    });
  });
  it.each<[VisionGame, string]>([
    ["pokemon", "https://cards.scryfall.io/card.jpg"],
    ["pokemon", "https://images.pokemontcg.io/base1/1.png"],
    ["mtg", "https://assets.tcgdex.net/card.webp"],
    ["mtg", "https://images.pokemontcg.io/base1/1.png"],
    ["yugioh", "https://assets.tcgdex.net/card.webp"],
    ["pokemon", "http://assets.tcgdex.net/card.webp"],
    ["pokemon", "https://assets.tcgdex.net:444/card.webp"],
    ["pokemon", "https://user:secret@assets.tcgdex.net/card.webp"],
    ["mtg", "https://cards.scryfall.io:8443/card.jpg"],
  ])(
    "rejects unsaveable %s artwork %s before installation",
    async (game, imageUrl) => {
      const source = await fixture(1, 1, game);
      source.manifest.records[0].imageUrl = imageUrl;
      const read = vi.spyOn(source.binaryFiles[0], "arrayBuffer");
      await expect(importLearnedPack(source.files())).rejects.toMatchObject({
        code: "invalid",
      });
      expect(read).not.toHaveBeenCalled();
      expect(await listLearnedPacks()).toEqual([]);
    },
  );
  it.each<[VisionGame, string | undefined]>([
    ["pokemon", "https://assets.tcgdex.net:443/en/me/30th/001/low.webp"],
    ["mtg", "https://cards.scryfall.io/normal/front/a/b/card.jpg"],
    ["yugioh", undefined],
  ])(
    "accepts %s metadata that survives a durable scan save",
    async (game, imageUrl) => {
      const source = await fixture(1, 1, game);
      Object.assign(source.manifest.records[0], { imageUrl });
      await importLearnedPack(source.files());
      const [reference] = await loadLearnedIndex(game),
        data = {
          ...EMPTY_DATA,
          collection: addScanEvent([], reference, `provider-${game}`),
        };
      expect(
        parseBackup(JSON.stringify(data)).collection[0].card.imageUrl,
      ).toBe(imageUrl ? new URL(imageUrl).href : undefined);
    },
  );
  it("accepts current TCGdex metadata without changing its provider URLs", async () => {
    const source = await fixture();
    Object.assign(source.manifest.records[0], {
      key: "pokemon:30th-001",
      name: "Exeggcute",
      identityKey: "pokemon:exeggcute",
      setName: "30th Celebration",
      number: "001",
      sourceUrl: "https://api.tcgdex.net/v2/en/cards/30th-001",
      imageUrl: "https://assets.tcgdex.net/en/me/30th/001/low.webp",
    });
    expect(validateLearnedManifest(source.manifest).records[0]).toEqual(
      source.manifest.records[0],
    );
    await importLearnedPack(source.files());
    const [reference] = await loadLearnedIndex("pokemon"),
      saved = parseBackup(
        JSON.stringify({
          ...EMPTY_DATA,
          collection: addScanEvent([], reference, "tcgdex-current"),
        }),
      );
    expect(saved.collection[0].card.imageUrl).toBe(reference.imageUrl);
    expect(saved.collection[0].card.sourceUrl).toBe(reference.sourceUrl);
  });
});

describe("bounded per-game learned import reservations", () => {
  it("accepts the exact runtime limit using metadata only, and rejects one more", async () => {
    expect(LEARNED_MAX_REFERENCES).toBe(60_000);
    expect(LEARNED_MAX_REFERENCES).toBe(MAX_HASH_REFERENCES);
    const { manifest } = await fixture(),
      record = manifest.records[0],
      count = LEARNED_MAX_REFERENCES;
    manifest.coverage.extractedImages = count;
    manifest.coverage.names = count;
    manifest.shards = Array.from(
      { length: Math.ceil(count / LEARNED_MAX_SHARD_RECORDS) },
      (_, shard) => {
        const records = Math.min(
          LEARNED_MAX_SHARD_RECORDS,
          count - shard * LEARNED_MAX_SHARD_RECORDS,
        );
        return {
          file: `features-${String(shard + 1).padStart(5, "0")}.bin`,
          count: records,
          bytes: LEARNED_SHARD_HEADER_BYTES + records * LEARNED_RECORD_BYTES,
          sha256: "0".repeat(64),
        };
      },
    );
    manifest.records = Array.from({ length: count }, (_, i) => ({
      ...record,
      key: `pokemon:capacity-${i}`,
      name: `Capacity ${i}`,
      shard: Math.floor(i / LEARNED_MAX_SHARD_RECORDS),
      offset:
        LEARNED_SHARD_HEADER_BYTES +
        (i % LEARNED_MAX_SHARD_RECORDS) * LEARNED_RECORD_BYTES,
    }));
    expect(validateLearnedManifest(manifest).records).toHaveLength(count);
    manifest.records.push({ ...record, key: "pokemon:one-too-many" });
    expect(() => validateLearnedManifest(manifest)).toThrow(
      /record or shard count/,
    );
  });
  it.each(["ready", "importing"] as const)(
    "counts existing %s capacity before reading a shard",
    async (readiness) => {
      const reserved = await seedCapacity(
          "pokemon",
          LEARNED_MAX_REFERENCES,
          readiness,
        ),
        source = await fixture(),
        read = vi.spyOn(source.binaryFiles[0], "arrayBuffer"),
        get = vi.spyOn(IDBObjectStore.prototype, "get"),
        getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
      await expect(importLearnedPack(source.files())).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("60,000"),
      });
      expect(read).not.toHaveBeenCalled();
      expect(
        get.mock.contexts.filter(
          (store) => (store as IDBObjectStore).name === "records",
        ),
      ).toHaveLength(0);
      expect(
        getAll.mock.contexts.filter(
          (store) => (store as IDBObjectStore).name === "records",
        ),
      ).toHaveLength(0);
      expect(await listLearnedPacks()).toEqual([reserved]);
    },
  );
  it("accepts exactly the remaining capacity and frees it after removal", async () => {
    const reserved = await seedCapacity("pokemon", LEARNED_MAX_REFERENCES - 1),
      one = await fixture(1, 1, "pokemon", "one"),
      two = await fixture(1, 1, "pokemon", "two"),
      first = await importLearnedPack(one.files());
    await expect(importLearnedPack(two.files())).rejects.toMatchObject({
      code: "conflict",
    });
    await removeLearnedPack(first.id);
    expect((await importLearnedPack(two.files())).readiness).toBe("ready");
    expect(await listLearnedPacks()).toHaveLength(2);
    await removeLearnedPack(reserved.id);
    expect(await loadLearnedIndex("pokemon")).toHaveLength(1);
  });
  it("counts all three games independently", async () => {
    await seedCapacity("pokemon", LEARNED_MAX_REFERENCES);
    await seedCapacity("mtg", LEARNED_MAX_REFERENCES);
    const yugioh = await fixture(1, 1, "yugioh");
    expect((await importLearnedPack(yugioh.files())).byGame.yugioh).toBe(1);
    for (const game of ["pokemon", "mtg"] as const) {
      const source = await fixture(1, 1, game);
      await expect(importLearnedPack(source.files())).rejects.toMatchObject({
        code: "conflict",
      });
    }
    expect(await loadLearnedIndex("yugioh")).toHaveLength(1);
  });
  it("atomically reserves competing imports without oversubscribing the game", async () => {
    await seedCapacity("pokemon", LEARNED_MAX_REFERENCES - 3);
    const one = await fixture(2, 1, "pokemon", "one"),
      two = await fixture(2, 1, "pokemon", "two"),
      results = await Promise.allSettled([
        importLearnedPack(one.files()),
        importLearnedPack(two.files()),
      ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason.code,
    ).toBe("conflict");
    expect(await listLearnedPacks()).toHaveLength(2);
    expect(await loadLearnedIndex("pokemon")).toHaveLength(2);
  });
  it("reserves before the first shard and releases every slot on cancellation", async () => {
    await seedCapacity("pokemon", LEARNED_MAX_REFERENCES - 2);
    const source = await fixture(2, 1, "pokemon", "cancelled"),
      other = await fixture(2, 1, "pokemon", "other"),
      paused = pauseFirstShard(source),
      controller = new AbortController(),
      pending = importLearnedPack(source.files(), {
        signal: controller.signal,
      });
    await paused.entered;
    await expect(importLearnedPack(other.files())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await loadLearnedIndex("pokemon")).toEqual([]);
    controller.abort();
    paused.release();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(await listLearnedPacks()).toHaveLength(1);
    expect((await importLearnedPack(other.files())).cards).toBe(2);
    expect(await loadLearnedIndex("pokemon")).toHaveLength(2);
  });
  it("releases reservations after quota and overlap failures", async () => {
    await seedCapacity("pokemon", LEARNED_MAX_REFERENCES - 3);
    const source = await fixture(2, 1, "pokemon", "failed"),
      originalAdd = IDBObjectStore.prototype.add,
      add = vi
        .spyOn(IDBObjectStore.prototype, "add")
        .mockImplementation(function (this: IDBObjectStore, ...args) {
          if (this.name === "records")
            throw new DOMException("Disk full", "QuotaExceededError");
          return originalAdd.apply(this, args);
        });
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "quota",
    });
    add.mockRestore();
    const first = await fixture(1, 1, "pokemon", "first");
    await importLearnedPack(first.files());
    source.manifest.records[0].key = first.manifest.records[0].key;
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await listLearnedPacks()).toHaveLength(2);
    const replacement = await fixture(2, 1, "pokemon", "replacement");
    expect((await importLearnedPack(replacement.files())).readiness).toBe(
      "ready",
    );
    expect(await loadLearnedIndex("pokemon")).toHaveLength(3);
  });
});

describe("fixed binary record safety", () => {
  it("decodes explicit little-endian points/scales and signed int8", () => {
    const bytes = payload();
    new DataView(bytes).setInt8(3073, -73);
    const decoded = decodeLearnedRecord("pokemon:fixture", bytes);
    expect(decoded.points.slice(0, 2)).toEqual(new Float32Array([10, 20]));
    expect(decoded.scales[0]).toBe(1 / 1024);
    expect(decoded.descriptors[1]).toBe(-73);
  });
  it.each([
    ["NaN coordinate", (v: DataView) => v.setFloat32(0, NaN, true)],
    ["out-of-range coordinate", (v: DataView) => v.setFloat32(0, 240, true)],
    ["negative coordinate", (v: DataView) => v.setFloat32(0, -1, true)],
    ["NaN scale", (v: DataView) => v.setFloat32(2048, NaN, true)],
    ["zero scale", (v: DataView) => v.setFloat32(2048, 0, true)],
    ["large scale", (v: DataView) => v.setFloat32(2048, 1, true)],
    ["non-normalized vector", (v: DataView) => v.setInt8(3072, 50)],
    ["negative 128", (v: DataView) => v.setInt8(3073, -128)],
  ])("rejects %s", (_name, mutate) => {
    const data = payload();
    mutate(new DataView(data));
    expect(() => decodeLearnedRecord("pokemon:test", data)).toThrow();
  });
  it("rejects trailing or truncated record bytes", () => {
    expect(() =>
      decodeLearnedRecord("pokemon:test", new ArrayBuffer(19457)),
    ).toThrow();
    expect(() =>
      decodeLearnedRecord("pokemon:test", new ArrayBuffer(19455)),
    ).toThrow();
  });
});

describe("atomic visibility and disk-only learned records", () => {
  it("imports, reports accurate counts, reopens, loads lazily, deduplicates and removes", async () => {
    const source = await fixture(3, 2),
      progress: string[] = [];
    const pack = await importLearnedPack(source.files(), {
      onProgress: (p) => progress.push(p.phase),
    });
    expect(pack).toMatchObject({
      cards: 3,
      names: 3,
      readiness: "ready",
      byGame: { pokemon: 3, mtg: 0, yugioh: 0 },
    });
    expect(progress).toEqual([
      "validating",
      "importing",
      "importing",
      "complete",
    ]);
    expect(await importLearnedPack(source.files())).toEqual(pack);
    expect(await listLearnedPacks()).toEqual([pack]);
    const cards = await loadLearnedIndex("pokemon");
    expect(cards).toHaveLength(3);
    expect(cards[0]).not.toHaveProperty("descriptors");
    expect(await loadLearnedIndex("mtg")).toEqual([]);
    expect(await loadLearnedReference(cards[0].featureId)).toMatchObject({
      key: cards[0].key,
      points: expect.any(Float32Array),
      descriptors: expect.any(Int8Array),
      scales: expect.any(Float32Array),
    });
    expect(fetch).not.toHaveBeenCalled();
    await removeLearnedPack(pack.id);
    expect(await listLearnedPacks()).toEqual([]);
    expect(await loadLearnedIndex()).toEqual([]);
    await expect(
      loadLearnedReference(cards[0].featureId),
    ).rejects.toMatchObject({ code: "missing" });
    expect(learnedReferenceCacheStats().references).toBe(0);
    await importLearnedPack(source.files());
    expect((await loadLearnedReference(cards[0].featureId)).key).toBe(
      cards[0].key,
    );
  });
  it("startup and list never read descriptor records, and LRU is bounded at eight", async () => {
    const pack = await fixture(10);
    await importLearnedPack(pack.files());
    const get = vi.spyOn(IDBObjectStore.prototype, "get"),
      getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const cards = await loadLearnedIndex();
    await listLearnedPacks();
    expect(
      get.mock.contexts.filter((s) => (s as IDBObjectStore).name === "records"),
    ).toHaveLength(0);
    expect(
      getAll.mock.contexts.filter(
        (s) => (s as IDBObjectStore).name === "records",
      ),
    ).toHaveLength(0);
    await Promise.all(
      cards.slice(0, 9).map((card) => loadLearnedReference(card.featureId)),
    );
    expect(learnedReferenceCacheStats()).toEqual({
      references: 8,
      bytes: 155648,
      limit: 8,
    });
    const diskReads = () =>
      get.mock.contexts.filter((s) => (s as IDBObjectStore).name === "records")
        .length;
    expect(diskReads()).toBe(9);
    await loadLearnedReference(cards[8].featureId);
    expect(diskReads()).toBe(9);
    await loadLearnedReference(cards[0].featureId);
    expect(diskReads()).toBe(10);
  });
  it("rejects overlaps deterministically without disturbing the original pack", async () => {
    const one = await fixture(2),
      original = await importLearnedPack(one.files());
    one.manifest.name = "Overlapping replacement";
    await expect(importLearnedPack(one.files())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await listLearnedPacks()).toEqual([original]);
    expect(await loadLearnedIndex()).toHaveLength(2);
  });
  it("keeps a pack invisible until the final shard, and cancellation rolls back", async () => {
    const source = await fixture(3, 1),
      controller = new AbortController();
    let observed: Promise<unknown> | undefined;
    await expect(
      importLearnedPack(source.files(), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "importing" && p.completed === 1) {
            observed = loadLearnedIndex();
            controller.abort();
          }
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(await observed).toEqual([]);
    expect(await listLearnedPacks()).toEqual([]);
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("makes incomplete imports removable and refuses silent recovery over an active import", async () => {
    const source = await fixture(),
      pack = await importLearnedPack(source.files());
    await mutateRow("packs", pack.id, (row) => {
      row.readiness = "importing";
    });
    expect((await listLearnedPacks())[0].readiness).toBe("importing");
    expect(await loadLearnedIndex()).toEqual([]);
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "conflict",
    });
    await removeLearnedPack(pack.id);
    expect((await importLearnedPack(source.files())).readiness).toBe("ready");
  });
  it("rolls back early shards when a later file fails integrity", async () => {
    const source = await fixture(3, 1),
      altered = await source.binaryFiles[1].arrayBuffer();
    new Uint8Array(altered)[40] ^= 1;
    source.binaryFiles[1] = new File([altered], source.binaryFiles[1].name);
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(await listLearnedPacks()).toEqual([]);
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("checks per-record integrity independently of the shard checksum", async () => {
    const source = await fixture();
    source.manifest.records[0].sha256 = "0".repeat(64);
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("rejects a recomputed shard with an invalid header", async () => {
    const source = await fixture(),
      altered = await source.binaryFiles[0].arrayBuffer();
    new DataView(altered).setUint32(24, 1, true);
    source.binaryFiles[0] = new File([altered], source.binaryFiles[0].name);
    source.manifest.shards[0].sha256 = await sha(altered);
    await expect(importLearnedPack(source.files())).rejects.toThrow(/header/);
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("detects record corruption lazily, marks the pack corrupt and invalidates cached records", async () => {
    const source = await fixture(2),
      pack = await importLearnedPack(source.files()),
      cards = await loadLearnedIndex();
    await loadLearnedReference(cards[0].featureId);
    await mutateRow("records", cards[1].featureId, (row) => {
      new Uint8Array(row.payload as ArrayBuffer)[100] ^= 1;
    });
    await expect(
      loadLearnedReference(cards[1].featureId),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect((await listLearnedPacks())[0]).toMatchObject({
      id: pack.id,
      readiness: "corrupt",
    });
    expect(learnedReferenceCacheStats().references).toBe(0);
    await expect(
      loadLearnedReference(cards[0].featureId),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("detects index metadata corruption and missing index rows", async () => {
    const source = await fixture(2),
      pack = await importLearnedPack(source.files());
    await mutateRow("index", "pokemon:fixture-0", (row) => {
      (row.card as { name: string }).name = "Tampered name";
    });
    await expect(loadLearnedIndex()).rejects.toMatchObject({ code: "corrupt" });
    await removeLearnedPack(pack.id);
    await importLearnedPack(source.files());
    await changeStore("index", (store) => {
      store.delete("pokemon:fixture-0");
    });
    await expect(loadLearnedIndex()).rejects.toMatchObject({ code: "corrupt" });
  });
  it("rechecks durable readiness even when another context removes a cached pack", async () => {
    const source = await fixture(),
      pack = await importLearnedPack(source.files()),
      [card] = await loadLearnedIndex();
    await loadLearnedReference(card.featureId);
    await changeStore("packs", (store) => {
      store.delete(pack.id);
    });
    await expect(loadLearnedReference(card.featureId)).rejects.toMatchObject({
      code: "missing",
    });
    expect(learnedReferenceCacheStats().references).toBe(0);
  });
  it("reports quota preflight and actual write failures without false readiness", async () => {
    const source = await fixture();
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1, usage: 0 }) },
    });
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "quota",
    });
    expect(await listLearnedPacks()).toEqual([]);
    vi.stubGlobal("navigator", undefined);
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "records")
        throw new DOMException("Disk full", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "quota",
    });
    expect(await listLearnedPacks()).toEqual([]);
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("reports unavailable browser storage and refuses malformed feature IDs", async () => {
    const source = await fixture();
    vi.stubGlobal("indexedDB", undefined);
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      loadLearnedReference("https://evil.example/features"),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("additional durable corruption and concurrency", () => {
  it("checks stored pack metadata before returning an idempotent success", async () => {
    const source = await fixture(),
      pack = await importLearnedPack(source.files());
    await mutateRow("packs", pack.id, (row) => {
      row.cards = 99_999;
    });
    await expect(importLearnedPack(source.files())).rejects.toMatchObject({
      code: "corrupt",
    });
    expect((await listLearnedPacks())[0]).toMatchObject({
      readiness: "corrupt",
      cards: 0,
    });
    expect(await loadLearnedIndex()).toEqual([]);
  });
  it("does not use a cached object after an identical replacement in another context", async () => {
    const source = await fixture(),
      pack = await importLearnedPack(source.files()),
      [card] = await loadLearnedIndex();
    const old = await loadLearnedReference(card.featureId);
    await mutateRow("packs", pack.id, (row) => {
      row.token = "replacement-token";
    });
    expect(await loadLearnedReference(card.featureId)).not.toBe(old);
  });
  it("verifies stored feature keys against the small index", async () => {
    const source = await fixture();
    await importLearnedPack(source.files());
    const [card] = await loadLearnedIndex();
    await mutateRow("records", card.featureId, (row) => {
      row.key = "pokemon:wrong-card";
    });
    await expect(loadLearnedReference(card.featureId)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
  it("resolves concurrent identical imports with one ready pack", async () => {
    const source = await fixture(3, 1);
    const results = await Promise.allSettled([
      importLearnedPack(source.files()),
      importLearnedPack(source.files()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
    ).toBe("conflict");
    expect(await listLearnedPacks()).toHaveLength(1);
    expect(await loadLearnedIndex()).toHaveLength(3);
  });
  it("never returns removed data when removal interrupts a pending import", async () => {
    const source = await fixture(3, 1);
    let removal: Promise<void> | undefined;
    await expect(
      importLearnedPack(source.files(), {
        onProgress: (p) => {
          if (p.phase === "importing" && p.completed === 1)
            removal = listLearnedPacks().then((packs) =>
              removeLearnedPack(packs[0].id),
            );
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    await removal;
    expect(await listLearnedPacks()).toEqual([]);
    expect(await loadLearnedIndex()).toEqual([]);
  });
});

describe("data-only frozen NPZ conversion", () => {
  async function converter() {
    // The standalone Node CLI is JavaScript; keep it out of the browser dependency graph.
    const modulePath = "../../scripts/build-learned-index.mjs";
    return import(modulePath);
  }
  function npy(
    name: "points.npy" | "scales.npy" | "descriptors.npy",
    override?: string,
  ) {
    const settings = {
      "points.npy": ["<f4", "256, 2", 0, 2048],
      "scales.npy": ["<f4", "256,", 2048, 1024],
      "descriptors.npy": ["|i1", "256, 64", 3072, 16384],
    } as const;
    const [dtype, shape, start, size] = settings[name];
    const header = Buffer.from(
        override ??
          `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape}), }\n`,
        "ascii",
      ),
      prefix = Buffer.alloc(10);
    prefix.set([0x93, 78, 85, 77, 80, 89, 1, 0]);
    prefix.writeUInt16LE(header.length, 8);
    return Buffer.concat([prefix, header, Buffer.from(payload(), start, size)]);
  }
  function zip() {
    const parts: Buffer[] = [],
      directories: Buffer[] = [];
    let offset = 0;
    for (const name of [
      "points.npy",
      "scales.npy",
      "descriptors.npy",
    ] as const) {
      const data = npy(name),
        filename = Buffer.from(name),
        local = Buffer.alloc(30),
        central = Buffer.alloc(46);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(filename.length, 26);
      central.writeUInt32LE(0x02014b50);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(filename.length, 28);
      central.writeUInt32LE(offset, 42);
      parts.push(local, filename, data);
      directories.push(central, filename);
      offset += local.length + filename.length + data.length;
    }
    const directory = Buffer.concat(directories),
      end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(3, 8);
    end.writeUInt16LE(3, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
  }
  it("preserves all frozen numeric bytes without eval or pickle", async () => {
    const { decodeFrozenNpz } = await converter();
    expect(decodeFrozenNpz(zip())).toEqual(Buffer.from(payload()));
  });
  it.each([
    "{'descr': '|O', 'fortran_order': False, 'shape': (256, 2), }\n",
    "{'descr': '>f4', 'fortran_order': False, 'shape': (256, 2), }\n",
    "{'descr': '<f4', 'fortran_order': True, 'shape': (256, 2), }\n",
    "{'descr': '<f4', 'fortran_order': False, 'shape': (100000000, 2), }\n",
    "{'descr': '<f4', 'fortran_order': False, 'shape': (256, 2), '__reduce__': 'execute'}\n",
    "__import__('os').system('should never execute')",
  ])("rejects an unsafe NPY header: %s", async (header) => {
    const { parseNpy } = await converter();
    expect(() => parseNpy(npy("points.npy", header), "points.npy")).toThrow();
  });
  it("rejects oversized archives, extra entries, unexpected compression and zip bombs", async () => {
    const { decodeFrozenNpz } = await converter();
    expect(() => decodeFrozenNpz(Buffer.alloc(262145))).toThrow(/bounded/);
    const extra = zip();
    extra.writeUInt16LE(4, extra.length - 12);
    expect(() => decodeFrozenNpz(extra)).toThrow(/three/);
    const compressed = zip(),
      offset = compressed.readUInt32LE(compressed.length - 6);
    compressed.writeUInt16LE(99, offset + 10);
    expect(() => decodeFrozenNpz(compressed)).toThrow(/Unsafe/);
    const bomb = zip(),
      directory = bomb.readUInt32LE(bomb.length - 6);
    bomb.writeUInt32LE(100_000_000, directory + 24);
    expect(() => decodeFrozenNpz(bomb)).toThrow(/Unsafe/);
  });
});

describe("offline builder contract and quantization", () => {
  async function builder() {
    const modulePath = "../../scripts/learned-builder.mjs";
    return import(modulePath);
  }
  function input() {
    return {
      format: "tcg-learned-build-input",
      version: 1,
      name: "Synthetic explicit input",
      game: "pokemon",
      createdAt: "2026-10-12T00:00:00Z",
      coverage: {
        scope: "fixture",
        catalogCards: 2,
        availableImages: 1,
        missingImages: 1,
        provider: "Synthetic tests",
        note: "No real artwork",
        catalogRetrievedAt: "2026-10-12T00:00:00Z",
      },
      rights: {
        usage: "private-local-only",
        notice:
          "Private local tests; no rights to publish artwork or derivative descriptors are asserted.",
      },
      cards: [
        {
          key: "pokemon:a",
          game: "pokemon",
          name: "Card A",
          imagePath: "objects/image.png",
          imageSha256: "1".repeat(64),
          imageBytes: 100,
        },
        { key: "pokemon:b", game: "pokemon", name: "Card B", imagePath: null },
      ],
    };
  }
  it("requires explicit truthful coverage, local files and source/rights notes", async () => {
    const { validateLearnedBuildInput } = await builder(),
      result = validateLearnedBuildInput(input());
    expect(result.cards[0].metadata.key).toBe("pokemon:a");
    expect(result.cards[1].imagePath).toBeNull();
    expect(result.rights.usage).toBe("private-local-only");
  });
  it.each([
    [
      "remote image",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imagePath = "https://example.com/a.png";
      },
    ],
    [
      "parent traversal",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imagePath = "../a.png";
      },
    ],
    [
      "absolute path",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imagePath = "/tmp/a.png";
      },
    ],
    [
      "source checksum",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imageSha256 = "invalid";
      },
    ],
    [
      "empty image",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imageBytes = 0;
      },
    ],
    [
      "oversized source",
      (x: ReturnType<typeof input>) => {
        x.cards[0].imageBytes = 21 * 1024 * 1024;
      },
    ],
    [
      "unknown field",
      (x: ReturnType<typeof input>) => {
        Object.assign(x.cards[0], { executable: true });
      },
    ],
    [
      "duplicate key",
      (x: ReturnType<typeof input>) => {
        x.cards[1].key = x.cards[0].key;
      },
    ],
    [
      "wrong game",
      (x: ReturnType<typeof input>) => {
        x.cards[0].game = "mtg";
      },
    ],
    [
      "rights scope",
      (x: ReturnType<typeof input>) => {
        x.rights.usage = "publish-everywhere";
      },
    ],
    [
      "no source notice",
      (x: ReturnType<typeof input>) => {
        x.rights.notice = "";
      },
    ],
    [
      "inflated availability",
      (x: ReturnType<typeof input>) => {
        x.coverage.availableImages = 3;
      },
    ],
    [
      "full-catalog omission",
      (x: ReturnType<typeof input>) => {
        x.coverage.scope = "full-catalog";
        x.coverage.catalogCards = 3;
        x.coverage.availableImages = 2;
      },
    ],
  ])("rejects %s", async (_label, mutate) => {
    const { validateLearnedBuildInput } = await builder(),
      source = input();
    mutate(source);
    expect(() => validateLearnedBuildInput(source)).toThrow();
  });
  it("implements signed ties-to-even rather than Math.round", async () => {
    const { nearestEven } = await builder();
    expect(
      [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5].map(nearestEven),
    ).toEqual([-4, -2, -2, 0, 0, 2, 2, 4]);
    expect(() => nearestEven(NaN)).toThrow();
  });
  it("keeps source ranking within each cell and uses fixed row-major spatial rounds", async () => {
    const { spatialSelection256 } = await builder(),
      points = new Float32Array(1000);
    for (let i = 0; i < 500; i++) {
      const cell = 23 - (i % 24);
      points[i * 2] = (cell % 4) * 60 + 1;
      points[i * 2 + 1] = Math.floor(cell / 4) * 56 + 1;
    }
    const selected = spatialSelection256(points);
    expect(selected.slice(0, 24)).toEqual(
      Array.from({ length: 24 }, (_, i) => 23 - i),
    );
    expect(selected.slice(24, 48)).toEqual(
      Array.from({ length: 24 }, (_, i) => 47 - i),
    );
    expect(new Set(selected).size).toBe(256);
    expect(() => spatialSelection256(new Float32Array(510))).toThrow(
      /never padded/,
    );
    points[0] = 240;
    expect(() => spatialSelection256(points)).toThrow(/canonical/);
  });
  it("matches float32 scale/division and signed nearest-even payload bytes", async () => {
    const { quantizeLearnedReference } = await builder(),
      points = new Float32Array(512),
      descriptors = new Float32Array(256 * 64);
    for (let i = 0; i < 256; i++) {
      points[i * 2] = 20;
      points[i * 2 + 1] = 30;
      descriptors.set(
        [127 / 128, 0.5 / 128, 1.5 / 128, -0.5 / 128, -1.5 / 128, -2.5 / 128],
        i * 64,
      );
    }
    const bytes = quantizeLearnedReference({ points, descriptors }),
      decoded = decodeLearnedRecord("pokemon:test", bytes);
    expect(bytes.byteLength).toBe(19456);
    expect(decoded.scales[0]).toBe(1 / 128);
    expect(Array.from(decoded.descriptors.slice(0, 6))).toEqual([
      127, 0, 2, 0, -2, -2,
    ]);
    descriptors[0] = NaN;
    expect(() => quantizeLearnedReference({ points, descriptors })).toThrow();
  });
  it("keys resume checkpoints by both image content and extraction contract", async () => {
    const { learnedCacheKey } = await builder(),
      image = "1".repeat(64),
      contract = "2".repeat(64);
    expect(learnedCacheKey(image, contract)).toBe(
      learnedCacheKey(image, contract),
    );
    expect(learnedCacheKey(image, contract)).not.toBe(
      learnedCacheKey("3".repeat(64), contract),
    );
    expect(learnedCacheKey(image, contract)).not.toBe(
      learnedCacheKey(image, "4".repeat(64)),
    );
  });
  it("requires explicit full-catalog execution approval before model or image access", async () => {
    const { buildOfflineLearnedPack } = await builder();
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "learned-full-guard-"));
    try {
      const source = input();
      source.coverage.scope = "full-catalog";
      const filename = join(directory, "input.json");
      await writeFile(filename, JSON.stringify(source));
      await expect(
        buildOfflineLearnedPack({
          input: filename,
          images: join(directory, "absent-images"),
          assets: join(directory, "absent-assets"),
          cache: join(directory, "cache"),
          out: join(directory, "out"),
        }),
      ).rejects.toThrow(/--allow-full-catalog/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  function unavailableInput() {
    const source = input();
    const { imagePath, imageSha256, imageBytes, ...metadata } = source.cards[0];
    void imagePath;
    void imageSha256;
    void imageBytes;
    const advertised = {
      ...metadata,
      imageUrl: "https://assets.tcgdex.net/en/xy/dc1/1/low.webp",
      sourceUrl: "https://api.tcgdex.net/v2/en/cards/dc1-1",
      sourceUnavailable: {
        reason: "http-404",
        advertisedUrl: "https://assets.tcgdex.net/en/xy/dc1/1/low.webp",
        evidenceSha256: "a".repeat(64),
        observedAt: "2026-10-12T14:22:26.673Z",
      },
    };
    return {
      ...source,
      cards: [advertised, source.cards[1]] as [
        typeof advertised,
        (typeof source.cards)[number],
      ],
    };
  }
  it("preserves unavailable advertised sources separately and reproducibly", async () => {
    const { validateLearnedBuildInput } = await builder(),
      source = unavailableInput();
    const one = validateLearnedBuildInput(source),
      two = validateLearnedBuildInput(JSON.parse(JSON.stringify(source)));
    expect(one).toEqual(two);
    expect(one.coverage.availableImages).toBe(1);
    expect(one.coverage.missingImages).toBe(1);
    expect(one.cards[0].sourceUnavailable).toMatchObject({
      reason: "http-404",
      evidenceSha256: "a".repeat(64),
    });
    expect(one.cards[0]).not.toHaveProperty("imagePath");
    expect(one.cards[0]).not.toHaveProperty("imageSha256");
    expect(one.cards[0]).not.toHaveProperty("imageBytes");
    expect(one.cards[1].imagePath).toBeNull();
    Reflect.deleteProperty(source.cards[0].sourceUnavailable, "observedAt");
    expect(
      validateLearnedBuildInput(source).cards[0].sourceUnavailable,
    ).not.toHaveProperty("observedAt");
  });
  it.each([
    [
      "unknown reason",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.reason = "anything";
      },
    ],
    [
      "present null path",
      (x: ReturnType<typeof unavailableInput>) => {
        Object.assign(x.cards[0], { imagePath: null });
      },
    ],
    [
      "present path",
      (x: ReturnType<typeof unavailableInput>) => {
        Object.assign(x.cards[0], { imagePath: "invented.webp" });
      },
    ],
    [
      "invented hash",
      (x: ReturnType<typeof unavailableInput>) => {
        Object.assign(x.cards[0], { imageSha256: "0".repeat(64) });
      },
    ],
    [
      "invented size",
      (x: ReturnType<typeof unavailableInput>) => {
        Object.assign(x.cards[0], { imageBytes: 1 });
      },
    ],
    [
      "missing card provenance",
      (x: ReturnType<typeof unavailableInput>) => {
        Reflect.deleteProperty(x.cards[0], "sourceUrl");
      },
    ],
    [
      "invalid evidence hash",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.evidenceSha256 = "wrong";
      },
    ],
    [
      "unknown image provider",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.advertisedUrl =
          "https://evil.example/x.webp";
      },
    ],
    [
      "wrong game provider",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.advertisedUrl =
          "https://cards.scryfall.io/x.jpg";
      },
    ],
    [
      "advertised URL mismatch",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.advertisedUrl =
          "https://assets.tcgdex.net/other.webp";
      },
    ],
    [
      "embedded credentials",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.advertisedUrl =
          "https://user:secret@assets.tcgdex.net/en/xy/dc1/1/low.webp";
      },
    ],
    [
      "bad timestamp",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.observedAt = "yesterday";
      },
    ],
    [
      "impossible date",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.observedAt = "2026-02-30T14:22:26Z";
      },
    ],
    [
      "timezone-free date",
      (x: ReturnType<typeof unavailableInput>) => {
        x.cards[0].sourceUnavailable.observedAt = "2026-10-12T14:22:26";
      },
    ],
    [
      "extra provenance field",
      (x: ReturnType<typeof unavailableInput>) => {
        Object.assign(x.cards[0].sourceUnavailable, { callback: "execute" });
      },
    ],
  ])("rejects unavailable-source %s", async (_label, mutate) => {
    const { validateLearnedBuildInput } = await builder(),
      source = unavailableInput();
    mutate(source);
    expect(() => validateLearnedBuildInput(source)).toThrow();
  });
  it("reports predeclared unavailable images without attempting extraction", async () => {
    const { buildOfflineLearnedPack } = await builder();
    const { mkdtemp, mkdir, writeFile, readFile, rm } =
        await import("node:fs/promises"),
      { tmpdir } = await import("node:os"),
      { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "learned-unavailable-")),
      progress = vi.fn();
    try {
      const source = unavailableInput(),
        filename = join(directory, "input.json");
      await writeFile(filename, JSON.stringify(source));
      await mkdir(join(directory, "images"));
      await mkdir(join(directory, "assets"));
      await expect(
        buildOfflineLearnedPack({
          input: filename,
          images: join(directory, "images"),
          assets: join(directory, "assets"),
          cache: join(directory, "cache"),
          out: join(directory, "out"),
          onProgress: progress,
        }),
      ).rejects.toThrow(/No valid learned references/);
      const report = JSON.parse(
        await readFile(join(directory, "out.report.json"), "utf8"),
      );
      expect(report.unavailableAdvertisedImages).toHaveLength(1);
      expect(report.missingProviderImages).toHaveLength(1);
      expect(report.failures).toEqual([]);
      expect(report.newlyExtracted).toBe(0);
      expect(
        progress.mock.calls.some(([text]) => String(text).includes("WASM")),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("honors cancellation before touching any source or output", async () => {
    const { buildOfflineLearnedPack } = await builder(),
      controller = new AbortController();
    controller.abort();
    await expect(
      buildOfflineLearnedPack({ signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});
