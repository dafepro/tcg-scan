import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  REFERENCE_DATABASE_NAME,
  MAX_PACK_BYTES,
  ReferenceStorageError,
  validateFeaturePack,
  validateReferenceMetadata,
  validatePrebuiltManifest,
  saveReferencePack,
  importReferencePack,
  listReferencePacks,
  loadReferencePack,
  removeReferencePack,
  cacheReferenceImage,
  listCachedReferenceImages,
  clearCachedReferences,
  getReferenceStorageStatus,
  installPrebuiltPack,
  loadPrebuiltPackManifest,
} from "./reference-packs";
import type { ReferenceFeaturePack } from "./reference-packs";
import type { VisionGame } from "./vision/types";
import { addScanEvent } from "./scan-inventory";
import { EMPTY_DATA, parseBackup } from "./storage";

function fixture(): ReferenceFeaturePack {
  return {
    version: 1,
    algorithm: "orb-phash-v1",
    width: 240,
    height: 336,
    name: "Test set",
    source: "Synthetic test",
    createdAt: "2026-10-12T00:00:00Z",
    cards: [
      {
        key: "pokemon:fixture-1",
        game: "pokemon",
        name: "Test Card",
        imageUrl: "https://assets.tcgdex.net/en/base/base1/1/low.webp",
      },
    ],
    features: [
      {
        key: "pokemon:fixture-1",
        hash: "0123456789abcdef",
        differenceHash: "fedcba9876543210",
        points: Array.from({ length: 40 }, (_, i) => 20 + i),
        descriptors: btoa(String.fromCharCode(...new Uint8Array(640))),
      },
    ],
    coverage: {
      scope: "fixture",
      catalogCards: 1,
      availableImages: 1,
      extractedImages: 1,
      missingImages: 0,
      failedImages: 0,
    },
  };
}
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("strict feature pack import", () => {
  it("accepts portable descriptors with accurate coverage", () => {
    const pack = validateFeaturePack(fixture());
    expect(pack.cards[0].game).toBe("pokemon");
    expect(pack.coverage?.extractedImages).toBe(1);
  });
  it.each([
    [
      "schema version",
      (pack: ReferenceFeaturePack) => {
        (pack as unknown as { version: number }).version = 2;
      },
    ],
    [
      "preprocessing",
      (pack: ReferenceFeaturePack) => {
        (pack as unknown as { width: number }).width = 241;
      },
    ],
    [
      "hash",
      (pack: ReferenceFeaturePack) => {
        pack.features[0].hash = "not-a-hash";
      },
    ],
    [
      "descriptor shape",
      (pack: ReferenceFeaturePack) => {
        pack.features[0].descriptors = "AAAA";
      },
    ],
    [
      "out-of-bounds geometry",
      (pack: ReferenceFeaturePack) => {
        pack.features[0].points[0] = 240;
      },
    ],
    [
      "NaN geometry",
      (pack: ReferenceFeaturePack) => {
        pack.features[0].points[0] = NaN;
      },
    ],
    [
      "feature identity",
      (pack: ReferenceFeaturePack) => {
        pack.features[0].key = "other";
      },
    ],
    [
      "unknown image host",
      (pack: ReferenceFeaturePack) => {
        pack.cards[0].imageUrl = "https://evil.example/card.jpg";
      },
    ],
    [
      "executable URL",
      (pack: ReferenceFeaturePack) => {
        pack.cards[0].sourceUrl = "javascript:alert(1)";
      },
    ],
    [
      "embedded credentials",
      (pack: ReferenceFeaturePack) => {
        pack.cards[0].imageUrl = "https://user:pass@assets.tcgdex.net/card.jpg";
      },
    ],
    [
      "inflated coverage",
      (pack: ReferenceFeaturePack) => {
        pack.coverage!.extractedImages = 50000;
      },
    ],
  ])("rejects invalid %s", (_name, mutate) => {
    const pack = fixture();
    mutate(pack);
    expect(() => validateFeaturePack(pack)).toThrow(ReferenceStorageError);
  });
  it("preserves explicit duplicate-image coverage without inflating installed count", () => {
    const pack = fixture();
    pack.coverage!.duplicateImages = 52782;
    expect(validateFeaturePack(pack).coverage).toMatchObject({
      duplicateImages: 52782,
      extractedImages: 1,
    });
  });
  it("rejects YGO image hotlinks even on the known provider host", () => {
    const pack = fixture();
    pack.cards[0].game = "yugioh";
    pack.cards[0].imageUrl = "https://images.ygoprodeck.com/images/cards/1.jpg";
    expect(() => validateFeaturePack(pack)).toThrow(/never browser-hotlinked/);
  });
  it("rejects extra fields, duplicates and empty packs", () => {
    expect(() =>
      validateFeaturePack({ ...fixture(), script: "alert(1)" }),
    ).toThrow();
    const duplicate = fixture();
    duplicate.cards.push(duplicate.cards[0]);
    duplicate.features.push(duplicate.features[0]);
    expect(() => validateFeaturePack(duplicate)).toThrow(/Duplicate/);
    expect(() =>
      validateFeaturePack({ ...fixture(), cards: [], features: [] }),
    ).toThrow();
  });
  it("rejects huge uploads before reading their content", async () => {
    const text = vi.fn();
    const fake = { size: MAX_PACK_BYTES + 1, text } as unknown as Blob;
    await expect(importReferencePack(fake)).rejects.toThrow(/64 MiB/);
    expect(text).not.toHaveBeenCalled();
    await expect(importReferencePack(new Blob(["not json"]))).rejects.toThrow(
      /valid JSON/,
    );
  });
});

describe("legacy metadata uses the durable per-game image policy", () => {
  it.each<[VisionGame, string]>([
    ["pokemon", "https://cards.scryfall.io/card.jpg"],
    ["pokemon", "https://images.pokemontcg.io/base1/1.png"],
    ["mtg", "https://assets.tcgdex.net/card.webp"],
    ["mtg", "https://images.pokemontcg.io/base1/1.png"],
    ["yugioh", "https://cards.scryfall.io/card.jpg"],
    ["pokemon", "http://assets.tcgdex.net/card.webp"],
    ["pokemon", "https://assets.tcgdex.net:444/card.webp"],
    ["mtg", "https://user:secret@cards.scryfall.io/card.jpg"],
  ])(
    "rejects unsaveable %s artwork %s before installation",
    async (game, imageUrl) => {
      const source = fixture();
      Object.assign(source.cards[0], {
        game,
        imageUrl,
        key: `${game}:fixture-1`,
      });
      source.features[0].key = source.cards[0].key;
      await expect(saveReferencePack(source)).rejects.toMatchObject({
        code: "invalid",
      });
      expect(await listReferencePacks()).toEqual([]);
    },
  );
  it.each<[VisionGame, string | undefined]>([
    ["pokemon", "https://assets.tcgdex.net:443/en/me/30th/001/low.webp"],
    ["mtg", "https://cards.scryfall.io/normal/front/a/b/card.jpg"],
    ["yugioh", undefined],
  ])(
    "keeps accepted %s artwork compatible with a durable scan save",
    async (game, imageUrl) => {
      const reference = validateReferenceMetadata({
          key: `${game}:fixture-1`,
          game,
          name: "Fixture",
          imageUrl,
        }),
        source = fixture();
      source.cards[0] = reference;
      source.features[0].key = reference.key;
      const installed = await saveReferencePack(source),
        loaded = (await loadReferencePack(installed.id))!.cards[0],
        data = {
          ...EMPTY_DATA,
          collection: addScanEvent([], loaded, `legacy-${game}`),
        };
      expect(
        parseBackup(JSON.stringify(data)).collection[0].card.imageUrl,
      ).toBe(imageUrl ? new URL(imageUrl).href : undefined);
    },
  );
});

describe("independent IndexedDB reference persistence", () => {
  it("imports, deduplicates, survives storage reopen and removes packs", async () => {
    const pack = fixture(),
      stored = await importReferencePack(new Blob([JSON.stringify(pack)]));
    await saveReferencePack(pack);
    expect(await listReferencePacks()).toMatchObject([
      {
        id: stored.id,
        cards: 1,
        readiness: "ready",
        byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      },
    ]);
    expect(await loadReferencePack(stored.id)).toEqual(
      validateFeaturePack(pack),
    );
    await removeReferencePack(stored.id);
    expect(await listReferencePacks()).toEqual([]);
    expect(await loadReferencePack(stored.id)).toBeUndefined();
  });
  it("persists learned Blobs and optional features without localStorage", async () => {
    const pack = fixture(),
      blob = new Blob(["synthetic image bytes"], { type: "image/png" });
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("Do not use localStorage");
      },
      setItem() {
        throw new Error("Do not use localStorage");
      },
    });
    await cacheReferenceImage(pack.cards[0], blob, pack.features[0]);
    const rows = await listCachedReferenceImages();
    expect(rows).toHaveLength(1);
    expect(await rows[0].image.text()).toBe("synthetic image bytes");
    expect(rows[0].features).toEqual(pack.features[0]);
    await clearCachedReferences();
    expect(await listCachedReferenceImages()).toEqual([]);
  });
  it("rejects unsafe learned image formats and mismatched features", async () => {
    const pack = fixture();
    await expect(
      cacheReferenceImage(
        pack.cards[0],
        new Blob(["<svg/>"], { type: "image/svg+xml" }),
      ),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(
      cacheReferenceImage(
        pack.cards[0],
        new Blob(["x"], { type: "image/png" }),
        { ...pack.features[0], key: "other" },
      ),
    ).rejects.toThrow(/does not match/);
  });
  it("detects checksum corruption on load", async () => {
    const stored = await saveReferencePack(fixture());
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(REFERENCE_DATABASE_NAME, 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("packs", "readwrite"),
          store = tx.objectStore("packs"),
          read = store.get(stored.id);
        read.onsuccess = () => {
          const row = read.result;
          row.pack.cards[0].name = "tampered";
          store.put(row);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    await expect(loadReferencePack(stored.id)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
  it("reports unavailable browser storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await getReferenceStorageStatus()).toMatchObject({
      available: false,
      pressure: "unknown",
    });
    await expect(saveReferencePack(fixture())).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  it("reports quota failure instead of claiming a pack was saved", async () => {
    vi.spyOn(IDBFactory.prototype, "open").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await expect(saveReferencePack(fixture())).rejects.toMatchObject({
      code: "quota",
    });
  });
});

describe("same-origin, checksum-verified prebuilt installation", () => {
  async function bundle() {
    const raw = new TextEncoder().encode(JSON.stringify(fixture()));
    const hash = await crypto.subtle.digest("SHA-256", raw);
    const sha256 = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      raw,
      entry: {
        id: "test",
        name: "Test",
        file: "/packs/test.json",
        sha256,
        bytes: raw.length,
        cards: 1,
        game: "pokemon" as const,
      },
    };
  }
  it("installs only validated bytes and records source", async () => {
    const { raw, entry } = await bundle();
    const fetch = vi.fn().mockResolvedValue(new Response(raw));
    vi.stubGlobal("fetch", fetch);
    const stored = await installPrebuiltPack(entry);
    expect(stored.origin).toBe("prebuilt");
    expect(fetch).toHaveBeenCalledWith(
      "/packs/test.json",
      expect.objectContaining({ redirect: "error" }),
    );
    expect((await loadReferencePack(stored.id))?.cards).toHaveLength(1);
  });
  it("rejects checksum mismatch without storing anything", async () => {
    const { raw, entry } = await bundle();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw)));
    await expect(
      installPrebuiltPack({ ...entry, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await listReferencePacks()).toEqual([]);
  });
  it.each([
    "https://evil.example/pack.json",
    "//evil.example/pack.json",
    "/packs/../secret.json",
    "/packs/test.json?url=https://evil.example",
    "/packs/a/test.json",
  ])("rejects path %s", async (file) => {
    const { entry } = await bundle();
    expect(() =>
      validatePrebuiltManifest({ version: 1, packs: [{ ...entry, file }] }),
    ).toThrow();
  });
  it("accepts the honest empty manifest and downloads it same-origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"version":1,"packs":[]}')),
    );
    expect(await loadPrebuiltPackManifest()).toEqual({ version: 1, packs: [] });
  });
  it.each(["/", "/tcg-scan/"])(
    "routes manifest and validated pack bytes beneath app base %s",
    async (base) => {
      vi.stubEnv("BASE_URL", base);
      const { raw, entry } = await bundle();
      const controller = new AbortController();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"version":1,"packs":[]}'))
        .mockResolvedValueOnce(new Response(raw));
      vi.stubGlobal("fetch", fetch);
      expect(await loadPrebuiltPackManifest(controller.signal)).toEqual({
        version: 1,
        packs: [],
      });
      const stored = await installPrebuiltPack(entry, controller.signal);
      expect(stored.origin).toBe("prebuilt");
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        `${base}packs/manifest.json`,
        `${base}packs/test.json`,
      ]);
      for (const [, options] of fetch.mock.calls)
        expect(options).toMatchObject({
          signal: controller.signal,
          redirect: "error",
          credentials: "same-origin",
        });
      expect(entry.file).toBe("/packs/test.json");
    },
  );
  it.each([
    "https://evil.example/",
    "//evil.example/",
    "../",
    "/app/../",
    "/app?x/",
    "/app#x/",
    "/app\\path/",
  ])("rejects an unsafe app base %s before fetching", async (base) => {
    vi.stubEnv("BASE_URL", base);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(loadPrebuiltPackManifest()).rejects.toThrow(
      /same-origin app base/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels oversized streamed responses", async () => {
    const { raw, entry } = await bundle();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(raw.length + 1))),
    );
    await expect(installPrebuiltPack(entry)).rejects.toThrow(/size limit/);
  });
});
