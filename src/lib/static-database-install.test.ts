import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  LEARNED_MODEL_DATA_SHA256,
  LEARNED_MODEL_ID,
  LEARNED_MODEL_SHA256,
  LEARNED_PACK_FORMAT,
  LEARNED_PREPROCESS_ID,
  LEARNED_QUANTIZATION_ID,
  LEARNED_RECORD_BYTES,
  LEARNED_SELECTION_ID,
  LEARNED_SHARD_HEADER_BYTES,
  importLearnedPack,
  listLearnedPacks,
  removeCorruptLearnedPack,
  type LearnedPackManifest,
  type LearnedPackMetadata,
} from "./learned-packs";
import { installStaticPokemonDatabase } from "./static-database-install";
import type { PokemonReferenceDownloadStatus } from "./pokemon-reference-release";

const release = vi.hoisted(() => ({
  id: "pokemon-en-learned-2026-10-12",
  manifestBytes: 0,
  manifestSha256: "",
  shardCount: 2,
  referenceBytes: 0,
  referenceCount: 2,
  nameCount: 2,
}));
vi.mock("./pokemon-reference-release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pokemon-reference-release")>()),
  POKEMON_REFERENCE_RELEASE: release,
}));
vi.mock("./learned-packs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./learned-packs")>();
  return {
    ...actual,
    importLearnedPack: vi.fn(actual.importLearnedPack),
    listLearnedPacks: vi.fn(actual.listLearnedPacks),
    removeCorruptLearnedPack: vi.fn(actual.removeCorruptLearnedPack),
  };
});
const importer = vi.mocked(importLearnedPack),
  list = vi.mocked(listLearnedPacks),
  remove = vi.mocked(removeCorruptLearnedPack),
  directory = "/reference-data/pokemon-en-learned-2026-10-12/";
let manifest: LearnedPackManifest,
  manifestBytes: ArrayBuffer,
  binaries: Map<string, ArrayBuffer>;
async function sha(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Original synthetic numerical records, with no provider data or artwork. */
async function fixture(): Promise<void> {
  const payload = new ArrayBuffer(LEARNED_RECORD_BYTES),
    view = new DataView(payload);
  for (let i = 0; i < 256; i++) {
    view.setFloat32(i * 8, 10 + (i % 20), true);
    view.setFloat32(i * 8 + 4, 20 + (i % 30), true);
    view.setFloat32(2048 + i * 4, 1 / 1024, true);
    view.setInt8(3072 + i * 64, 127);
  }
  const recordSha = await sha(payload);
  manifest = {
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
    name: "Original static-install synthetic fixture",
    createdAt: "2026-10-12T00:00:00Z",
    coverage: {
      scope: "fixture",
      game: "pokemon",
      extractedImages: 2,
      names: 2,
      missingImages: 0,
      failedImages: 0,
      provider: "Original numerical fixture",
      note: "No card art or provider metadata.",
    },
    shards: [],
    records: [],
  };
  binaries = new Map();
  for (let i = 0; i < 2; i++) {
    const bytes = new ArrayBuffer(
        LEARNED_SHARD_HEADER_BYTES + payload.byteLength,
      ),
      header = new DataView(bytes);
    new Uint8Array(bytes, 0, 8).set(new TextEncoder().encode("TCGLRN01"));
    header.setUint32(8, 1, true);
    header.setUint32(12, LEARNED_RECORD_BYTES, true);
    header.setUint32(16, 1, true);
    header.setUint32(20, i, true);
    new Uint8Array(bytes, LEARNED_SHARD_HEADER_BYTES).set(
      new Uint8Array(payload),
    );
    const file = `features-${String(i + 1).padStart(5, "0")}.bin`;
    binaries.set(file, bytes);
    manifest.shards.push({
      file,
      count: 1,
      bytes: bytes.byteLength,
      sha256: await sha(bytes),
    });
    manifest.records.push({
      key: `pokemon:static-fixture-${i}`,
      name: `Original fixture ${i}`,
      game: "pokemon",
      hash: "0123456789abcdef",
      differenceHash: "fedcba9876543210",
      shard: i,
      offset: LEARNED_SHARD_HEADER_BYTES,
      sha256: recordSha,
    });
  }
  release.shardCount = release.referenceCount = release.nameCount = 2;
  await repinManifest();
}
async function repinManifest(value: unknown = manifest): Promise<void> {
  manifestBytes = new TextEncoder().encode(JSON.stringify(value)).buffer;
  release.manifestBytes = manifestBytes.byteLength;
  release.manifestSha256 = await sha(manifestBytes);
  release.referenceBytes =
    release.manifestBytes +
    [...binaries.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
}
function response(
  bytes: ArrayBuffer,
  type = "application/octet-stream",
): Response {
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "content-length": String(bytes.byteLength),
    },
  });
}
function manifestResponse(): Response {
  return response(manifestBytes, "application/json; charset=utf-8");
}
function fixtureFetch() {
  return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const name = String(url).split("/").at(-1)!;
    if (name === "manifest.learned.json") return manifestResponse();
    const bytes = binaries.get(name);
    return bytes ? response(bytes) : new Response("Missing", { status: 404 });
  });
}
function metadata(): LearnedPackMetadata {
  return {
    id: `learned:${release.manifestSha256}`,
    checksum: release.manifestSha256,
    cards: release.referenceCount,
    names: release.nameCount,
    bytes: release.referenceBytes,
    readiness: "ready",
  } as LearnedPackMetadata;
}
beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("BASE_URL", "/");
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("location", { origin: "https://tcg.example" });
  vi.stubGlobal("navigator", {
    storage: {
      estimate: vi.fn().mockResolvedValue({ quota: 1_000_000_000, usage: 0 }),
    },
  });
  const actual =
    await vi.importActual<typeof import("./learned-packs")>("./learned-packs");
  importer.mockReset().mockImplementation(actual.importLearnedPack);
  list.mockReset().mockImplementation(actual.listLearnedPacks);
  remove.mockReset().mockImplementation(actual.removeCorruptLearnedPack);
  await fixture();
  vi.stubGlobal("fetch", fixtureFetch());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("explicit pinned static Pokémon installation", () => {
  it("has no eager requests and imports real synthetic shards through durable storage", async () => {
    const fetch = vi.mocked(globalThis.fetch),
      states: PokemonReferenceDownloadStatus[] = [],
      stored: number[] = [];
    expect(fetch).not.toHaveBeenCalled();
    const result = await installStaticPokemonDatabase({
      onDownloadProgress: (s) => states.push(s),
      onProgress: (p) => {
        if (p.phase === "importing") stored.push(p.completed);
      },
    });
    expect(result).toMatchObject(metadata());
    expect((await listLearnedPacks())[0].readiness).toBe("ready");
    expect(stored).toEqual([1, 2]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${directory}manifest.learned.json`,
      `${directory}features-00001.bin`,
      `${directory}features-00002.bin`,
    ]);
    for (const [, init] of fetch.mock.calls)
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        mode: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    expect(states[0]).toEqual({
      state: "downloading",
      downloadedBytes: 0,
      totalBytes: release.referenceBytes,
    });
    expect(states.at(-1)).toEqual({
      state: "ready",
      downloadedBytes: release.referenceBytes,
      totalBytes: release.referenceBytes,
    });
    expect(states.map((s) => s.downloadedBytes)).toEqual(
      states.map((s) => s.downloadedBytes).sort((a, b) => a - b),
    );
  });
  it.each(["/tcg-scan/", "/apps/cards", "/some-name_2/v1.2~/"])(
    "supports the safe deployment subpath %s",
    async (base) => {
      vi.stubEnv("BASE_URL", base);
      await installStaticPokemonDatabase();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(([url]) =>
            String(url).startsWith(`${base.replace(/\/$/, "")}${directory}`),
          ),
      ).toBe(true);
    },
  );
  it.each([
    "",
    "./",
    "app/",
    "https://other.example/",
    "//other.example/",
    "/a//b/",
    "/./",
    "/a/../",
    "/%2e%2e/",
    "/%2f%2fother/",
    "/a%5cb/",
    "/a\\b/",
    "/a?b/",
    "/a#b/",
    "/a\nb/",
    "/a b/",
    "/a:b/",
    "/".repeat(2049),
  ])(
    "rejects unsafe base %j before network or database access",
    async (base) => {
      vi.stubEnv("BASE_URL", base);
      await expect(installStaticPokemonDatabase()).rejects.toThrow(/base path/);
      expect(fetch).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );
  it("checks the manifest hash before importer access, shard requests, or corrupt-pack cleanup", async () => {
    list.mockResolvedValue([{ ...metadata(), readiness: "corrupt" }]);
    new Uint8Array(manifestBytes)[0] ^= 1;
    await expect(installStaticPokemonDatabase()).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(importer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("passes the pinned hash and the caller's cancellation/progress into the existing importer", async () => {
    const controller = new AbortController(),
      onProgress = vi.fn();
    await installStaticPokemonDatabase({
      signal: controller.signal,
      onProgress,
    });
    expect(importer.mock.calls[0][1]).toEqual({
      expectedManifestSha256: release.manifestSha256,
      signal: controller.signal,
      onProgress,
    });
  });
  it("keeps shard reads lazy, sequential, uncached, and under importer control", async () => {
    importer.mockImplementationOnce(async (files) => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(files.map((f) => f.name)).toEqual([
        "manifest.learned.json",
        ...binaries.keys(),
      ]);
      expect(await files[0].arrayBuffer()).toBe(await files[0].arrayBuffer());
      await expect(files[2].arrayBuffer()).rejects.toThrow(/sequentially/);
      const first = files[1].arrayBuffer();
      await expect(files[2].arrayBuffer()).rejects.toThrow(/sequentially/);
      expect(await first).toEqual(binaries.get(files[1].name));
      await expect(files[1].arrayBuffer()).rejects.toThrow(/sequentially/);
      expect(await files[2].arrayBuffer()).toEqual(binaries.get(files[2].name));
      return metadata();
    });
    await installStaticPokemonDatabase();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not fetch another shard while the first response is still streaming", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      normal = fixtureFetch();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("features-00001.bin")) {
        const bytes = new Uint8Array(binaries.get("features-00001.bin")!);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.subarray(0, 100));
              finish = () => {
                c.enqueue(bytes.subarray(100));
                c.close();
              };
              entered();
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        );
      }
      return normal(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const installing = installStaticPokemonDatabase();
    await started;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await listLearnedPacks())[0].readiness).toBe("importing");
    finish();
    await installing;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("reuses a verified local installation without claiming to download its shards again", async () => {
    await installStaticPokemonDatabase();
    const fetch = fixtureFetch(),
      states: PokemonReferenceDownloadStatus[] = [];
    vi.stubGlobal("fetch", fetch);
    const result = await installStaticPokemonDatabase({
      onDownloadProgress: (s) => states.push(s),
    });
    expect(result.readiness).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      state: "ready",
      downloadedBytes: release.manifestBytes,
    });
  });
  it("preflights insufficient storage and active imports before downloading", async () => {
    vi.mocked(navigator.storage.estimate).mockResolvedValueOnce({
      quota: 5,
      usage: 0,
    });
    await expect(installStaticPokemonDatabase()).rejects.toMatchObject({
      code: "quota",
    });
    list.mockResolvedValueOnce([{ ...metadata(), readiness: "importing" }]);
    await expect(installStaticPokemonDatabase()).rejects.toMatchObject({
      code: "conflict",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("removes only the pinned corrupt pack after verifying the replacement manifest", async () => {
    list.mockResolvedValueOnce([{ ...metadata(), readiness: "corrupt" }]);
    await installStaticPokemonDatabase();
    expect(remove).toHaveBeenCalledExactlyOnceWith(metadata().id);
  });
  it("rejects an unexpected importer result instead of reporting ready", async () => {
    importer.mockResolvedValueOnce({ ...metadata(), checksum: "0".repeat(64) });
    const onDownloadProgress = vi.fn();
    await expect(
      installStaticPokemonDatabase({ onDownloadProgress }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(
      onDownloadProgress.mock.calls.some(([p]) => p.state === "ready"),
    ).toBe(false);
  });
});

describe("fail-closed static responses and manifest contract", () => {
  it.each([404, 206, 301, 500])(
    "rejects HTTP %s with no relay or alternate-origin retry",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("Missing", { status })),
      );
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it.each(["text/html", "text/plain", "application/octet-stream", ""])(
    "rejects manifest content type %j including successful SPA fallback",
    async (type) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response(manifestBytes, type)),
      );
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        /content type/,
      );
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it.each(["text/html", "application/json", "image/png", ""])(
    "rejects binary content type %j and rolls back",
    async (type) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(manifestResponse())
          .mockResolvedValue(
            response(binaries.get("features-00001.bin")!, type),
          ),
      );
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        /content type/,
      );
      expect(await listLearnedPacks()).toEqual([]);
    },
  );
  it.each(["-1", "1.5", "99999999999999999999", "0", "1", "1000000000"])(
    "rejects invalid exact Content-Length %s before body reading",
    async (length) => {
      const res = manifestResponse();
      res.headers.set("content-length", length);
      const cancel = vi.spyOn(res.body!, "cancel");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        /invalid size/,
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each([-1, 1])(
    "bounds actual manifest bytes without a Content-Length (%s byte discrepancy)",
    async (delta) => {
      const res = response(
        new ArrayBuffer(manifestBytes.byteLength + delta),
        "application/json",
      );
      res.headers.delete("content-length");
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        /truncated|safe size limit/,
      );
      expect(cancel).toHaveBeenCalled();
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it.each([-1, 1])(
    "bounds actual shard bytes (%s byte discrepancy) and rolls back",
    async (delta) => {
      const res = response(new ArrayBuffer(manifest.shards[0].bytes + delta));
      res.headers.delete("content-length");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(manifestResponse())
          .mockResolvedValue(res),
      );
      await expect(installStaticPokemonDatabase()).rejects.toThrow(
        /truncated|safe size limit/,
      );
      expect(await listLearnedPacks()).toEqual([]);
    },
  );
  it("requires an actual response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(installStaticPokemonDatabase()).rejects.toThrow(
      /missing its body/,
    );
  });
  it.each(["gzip", "br", "deflate"])(
    "checks exact decoded bytes when Fetch reports %s transport encoding",
    async (encoding) => {
      const normal = fixtureFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init) => {
          const res = await normal(url, init);
          // Fetch decodes HTTP content encodings before exposing the response stream.
          res.headers.set("content-encoding", encoding);
          res.headers.set("content-length", "50");
          return res;
        }),
      );
      expect((await installStaticPokemonDatabase()).readiness).toBe("ready");
    },
  );
  it("rejects unknown encodings and oversized compressed transfer metadata", async () => {
    const res = manifestResponse();
    res.headers.set("content-encoding", "invented");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res));
    await expect(installStaticPokemonDatabase()).rejects.toThrow(
      /content encoding/,
    );
    const excessive = manifestResponse();
    excessive.headers.set("content-encoding", "gzip");
    excessive.headers.set(
      "content-length",
      String(release.manifestBytes + 65537),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(excessive));
    await expect(installStaticPokemonDatabase()).rejects.toThrow(
      /invalid size/,
    );
  });
  it.each([
    ["redirected", true],
    ["type", "opaque"],
    ["type", "cors"],
    [
      "url",
      "https://other.example/reference-data/pokemon-en-learned-2026-10-12/manifest.learned.json",
    ],
    ["url", "https://tcg.example/unexpected/manifest.learned.json"],
  ])("rejects changed response %s=%s", async (key, value) => {
    const res = manifestResponse();
    Object.defineProperty(res, key, { value });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    await expect(installStaticPokemonDatabase()).rejects.toThrow(/unexpected/);
    expect(importer).not.toHaveBeenCalled();
  });
  it("accepts the exact same-origin response URL", async () => {
    const normal = fixtureFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const res = await normal(url, init);
        Object.defineProperty(res, "url", {
          value: `https://tcg.example${url}`,
        });
        return res;
      }),
    );
    await expect(installStaticPokemonDatabase()).resolves.toMatchObject({
      readiness: "ready",
    });
  });
  it("does not retry redirects or network failure through the relay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Redirect forbidden")),
    );
    await expect(installStaticPokemonDatabase()).rejects.toThrow(
      /Could not fetch/,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${directory}manifest.learned.json`,
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it.each([
    "../features-00001.bin",
    "/features-00001.bin",
    "features-00001.bin?x=1",
    "features-%30%30%30%30%31.bin",
    "https://other.example/x.bin",
  ])(
    "rejects unsafe shard filename %s in a pinned fixture before shard requests",
    async (name) => {
      manifest.shards[0].file = name;
      await repinManifest();
      await expect(installStaticPokemonDatabase()).rejects.toMatchObject({
        code: "invalid",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it.each([
    "referenceCount",
    "nameCount",
    "shardCount",
    "referenceBytes",
  ] as const)("enforces the release's exact %s", async (field) => {
    release[field]++;
    await expect(installStaticPokemonDatabase()).rejects.toThrow(
      /exact pinned/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate shard names and undeclared extra manifest fields", async () => {
    manifest.shards[1].file = manifest.shards[0].file;
    await repinManifest();
    await expect(installStaticPokemonDatabase()).rejects.toThrow(/duplicate/);
    await fixture();
    await repinManifest({ ...manifest, extra: "unexpected data" });
    await expect(installStaticPokemonDatabase()).rejects.toMatchObject({
      code: "invalid",
    });
  });
  it("fails on a missing shard without making any references ready", async () => {
    binaries.delete("features-00002.bin");
    await expect(installStaticPokemonDatabase()).rejects.toThrow(/HTTP 404/);
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("ignores unreferenced hosted files without ever fetching them", async () => {
    binaries.set("extra.bin", new ArrayBuffer(100));
    await installStaticPokemonDatabase();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
      `${directory}extra.bin`,
    );
  });
  it("uses the existing shard hash verifier and rolls back a later shard failure", async () => {
    new Uint8Array(binaries.get("features-00002.bin")!)[100] ^= 1;
    const onDownloadProgress = vi.fn();
    await expect(
      installStaticPokemonDatabase({ onDownloadProgress }),
    ).rejects.toThrow(/checksum failed/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await listLearnedPacks()).toEqual([]);
    expect(
      onDownloadProgress.mock.calls.some(([p]) => p.state === "ready"),
    ).toBe(false);
  });
  it("rejects invalid UTF-8 before parsing even if its synthetic hash is pinned", async () => {
    manifestBytes = Uint8Array.from([0xff, 0xfe, 0xfd]).buffer;
    release.manifestBytes = manifestBytes.byteLength;
    release.manifestSha256 = await sha(manifestBytes);
    await expect(installStaticPokemonDatabase()).rejects.toThrow(/UTF-8 JSON/);
    expect(importer).not.toHaveBeenCalled();
  });
  it("rejects non-JSON content even when a fixture deliberately pins its hash and JSON type", async () => {
    manifestBytes = new TextEncoder().encode("<html>fallback</html>").buffer;
    release.manifestBytes = manifestBytes.byteLength;
    release.manifestSha256 = await sha(manifestBytes);
    await expect(installStaticPokemonDatabase()).rejects.toThrow(/UTF-8 JSON/);
    expect(importer).not.toHaveBeenCalled();
  });
});

describe("static installation cancellation", () => {
  it("does no work when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      installStaticPokemonDatabase({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(list).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors cancellation from initial download progress before fetching", async () => {
    const controller = new AbortController();
    await expect(
      installStaticPokemonDatabase({
        signal: controller.signal,
        onDownloadProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["manifest.learned.json", "features-00002.bin"])(
    "cancels a blocked %s stream and leaves nothing ready",
    async (target) => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        cancel = vi.fn(),
        normal = fixtureFetch(),
        controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init) => {
          if (!String(url).endsWith(target)) return normal(url, init);
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(1));
                entered();
              },
              cancel,
            }),
            {
              headers: {
                "content-type": target.endsWith("json")
                  ? "application/json"
                  : "application/octet-stream",
              },
            },
          );
        }),
      );
      const installing = installStaticPokemonDatabase({
          signal: controller.signal,
        }),
        rejected = expect(installing).rejects.toMatchObject({
          code: "aborted",
        });
      await started;
      controller.abort();
      await rejected;
      expect(cancel).toHaveBeenCalled();
      expect(await listLearnedPacks()).toEqual([]);
    },
  );
  it("cancels a reader already waiting for more manifest bytes", async () => {
    const controller = new AbortController(),
      cancel = vi.fn();
    let received!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const rejected = expect(
      installStaticPokemonDatabase({
        signal: controller.signal,
        onDownloadProgress: (p) => {
          if (p.downloadedBytes === 1) received();
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    await started;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(importer).not.toHaveBeenCalled();
  });
  it("aborts before the importer if cancellation happens during manifest hashing", async () => {
    const controller = new AbortController(),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
      async (...args) => {
        const result = await digest(...args);
        controller.abort();
        return result;
      },
    );
    await expect(
      installStaticPokemonDatabase({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(importer).not.toHaveBeenCalled();
  });
  it("cancels between completed shard writes without fetching the next shard", async () => {
    const controller = new AbortController();
    await expect(
      installStaticPokemonDatabase({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "importing" && p.completed === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await listLearnedPacks()).toEqual([]);
  });
  it("times out and cancels an incomplete response stream", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue([]);
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const rejected = expect(installStaticPokemonDatabase()).rejects.toThrow(
      /too long/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops a timed-out fetch and cleans up its timer", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const rejected = expect(installStaticPokemonDatabase()).rejects.toThrow(
      /too long/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
