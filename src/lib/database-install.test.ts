import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPokemonDatabase,
  createPokemonArchiveSource,
  usesStaticDatabaseInstall,
} from "./database-install";
import {
  POKEMON_REFERENCE_RELEASE as RELEASE,
  type PokemonReferenceDownloadStatus,
} from "./pokemon-reference-release";
import { importLearnedArchiveSource } from "./learned-archive";
import { installStaticPokemonDatabase } from "./static-database-install";
vi.mock("./static-database-install", () => ({
  installStaticPokemonDatabase: vi.fn(),
}));
import {
  listLearnedPacks,
  removeCorruptLearnedPack,
  type LearnedPackMetadata,
} from "./learned-packs";

vi.mock("./learned-archive", () => ({ importLearnedArchiveSource: vi.fn() }));
vi.mock("./learned-packs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./learned-packs")>()),
  listLearnedPacks: vi.fn(),
  removeCorruptLearnedPack: vi.fn(),
}));
const importer = vi.mocked(importLearnedArchiveSource);
const metadata = {
  id: `learned:${RELEASE.manifestSha256}`,
  checksum: RELEASE.manifestSha256,
  cards: RELEASE.referenceCount,
  names: RELEASE.nameCount,
  readiness: "ready",
} as LearnedPackMetadata;
function status(
  state: PokemonReferenceDownloadStatus["state"],
  downloadedBytes = state === "ready" || state === "verifying"
    ? RELEASE.sizeBytes
    : 0,
) {
  return { state, downloadedBytes, totalBytes: RELEASE.sizeBytes };
}
function json(value: unknown, code = 200) {
  return new Response(JSON.stringify(value), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}
function rangeResponse(
  from: number,
  to: number,
  change?: (response: Response) => Response,
) {
  const bytes = new Uint8Array(to - from);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (from + i) % 251;
  const response = new Response(bytes, {
    status: 206,
    headers: {
      "content-range": `bytes ${from}-${to - 1}/${RELEASE.sizeBytes}`,
      "content-length": String(bytes.length),
      "content-type": "application/zip",
    },
  });
  return change ? change(response) : response;
}
function rangeFetch(change?: (response: Response) => Response) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(
      new Headers(init?.headers).get("range") ?? "",
    );
    if (!match) throw new Error("Missing exact byte range");
    return rangeResponse(Number(match[1]), Number(match[2]) + 1, change);
  });
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BASE_URL", "/");
  vi.stubEnv("VITE_TCG_REFERENCE_MODE", "");
  vi.mocked(installStaticPokemonDatabase)
    .mockReset()
    .mockResolvedValue(metadata);
  importer.mockReset();
  importer.mockResolvedValue(metadata);
  vi.mocked(listLearnedPacks).mockReset().mockResolvedValue([]);
  vi.mocked(removeCorruptLearnedPack).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Pokémon database download orchestration", () => {
  it("rejects insufficient browser quota before any download request", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1000, usage: 500 }) },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(installPokemonDatabase()).rejects.toMatchObject({
      code: "quota",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
  });
  it("continues when storage estimates are unavailable", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => {
          throw new Error("Estimate unavailable");
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status("ready"))));
    expect(await installPokemonDatabase()).toEqual(metadata);
  });
  it("clears only the exact corrupt release target on explicit retry", async () => {
    vi.mocked(listLearnedPacks).mockResolvedValue([
      { ...metadata, readiness: "corrupt" },
      { ...metadata, id: `learned:${"1".repeat(64)}`, readiness: "corrupt" },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status("ready"))));
    await installPokemonDatabase();
    expect(removeCorruptLearnedPack).toHaveBeenCalledExactlyOnceWith(
      metadata.id,
    );
  });
  it("preserves existing ready and unrelated corrupt packs", async () => {
    vi.mocked(listLearnedPacks).mockResolvedValue([
      metadata,
      { ...metadata, id: `learned:${"2".repeat(64)}`, readiness: "corrupt" },
    ]);
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 0, usage: 0 }) },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status("ready"))));
    await installPokemonDatabase();
    expect(removeCorruptLearnedPack).not.toHaveBeenCalled();
  });
  it("preserves active importing data and refuses a competing download", async () => {
    vi.mocked(listLearnedPacks).mockResolvedValue([
      { ...metadata, readiness: "importing" },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(installPokemonDatabase()).rejects.toMatchObject({
      code: "conflict",
    });
    expect(removeCorruptLearnedPack).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["/", "/tcg-scan/"])(
    "explicitly starts, polls, and imports pinned data under %s",
    async (base) => {
      vi.stubEnv("BASE_URL", base);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json(status("downloading", 5), 202))
        .mockResolvedValueOnce(json(status("verifying")))
        .mockResolvedValueOnce(json(status("ready")));
      vi.stubGlobal("fetch", fetch);
      const onDownloadProgress = vi.fn(),
        onProgress = vi.fn(),
        controller = new AbortController();
      const result = installPokemonDatabase({
        signal: controller.signal,
        onDownloadProgress,
        onProgress,
      });
      await flush();
      expect(importer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(750);
      expect(importer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(750);
      expect(await result).toEqual(metadata);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(
        ["start", "status", "status"].map(
          (action) => `${base}__tcg_scan/reference/pokemon/${action}`,
        ),
      );
      expect(fetch.mock.calls[0][1]).toMatchObject({
        method: "POST",
        body: "{}",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
      expect(onDownloadProgress.mock.calls.map(([p]) => p.state)).toEqual([
        "downloading",
        "verifying",
        "ready",
      ]);
      expect(importer).toHaveBeenCalledWith(
        expect.objectContaining({ size: RELEASE.sizeBytes }),
        {
          signal: controller.signal,
          onProgress,
          expectedManifestSha256: RELEASE.manifestSha256,
        },
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("uses an already-verified server cache without downloading again", async () => {
    const fetch = vi.fn().mockResolvedValue(json(status("ready")));
    vi.stubGlobal("fetch", fetch);
    expect(await installPokemonDatabase()).toEqual(metadata);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send any request when already aborted", async () => {
    const controller = new AbortController(),
      fetch = vi.fn();
    controller.abort();
    vi.stubGlobal("fetch", fetch);
    await expect(
      installPokemonDatabase({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("awaits a bounded cancel before finishing a download abort", async () => {
    const controller = new AbortController();
    let resolveCancel!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(status("downloading", 123)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCancel = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetch);
    const installing = installPokemonDatabase({ signal: controller.signal });
    const rejection = expect(installing).rejects.toMatchObject({
      code: "aborted",
    });
    let settled = false;
    void installing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    controller.abort();
    await flush();
    expect(fetch.mock.calls[1]).toEqual([
      "/__tcg_scan/reference/pokemon/cancel",
      expect.objectContaining({ method: "POST", body: "{}" }),
    ]);
    expect(settled).toBe(false);
    resolveCancel(json(status("paused", 123)));
    await rejection;
    expect(importer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds best-effort cancel when the server is no longer responding", async () => {
    const controller = new AbortController(),
      fetch = vi
        .fn()
        .mockResolvedValueOnce(json(status("verifying")))
        .mockImplementationOnce(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Abort", "AbortError")),
                { once: true },
              );
            }),
        );
    vi.stubGlobal("fetch", fetch);
    const rejection = expect(
      installPokemonDatabase({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    await flush();
    controller.abort();
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not cancel a ready cache when cancellation occurs in ready progress", async () => {
    const controller = new AbortController(),
      fetch = vi.fn().mockResolvedValue(json(status("ready")));
    vi.stubGlobal("fetch", fetch);
    await expect(
      installPokemonDatabase({
        signal: controller.signal,
        onDownloadProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(importer).not.toHaveBeenCalled();
  });
  it("cancels only the import after the cache is ready", async () => {
    const controller = new AbortController(),
      fetch = vi.fn().mockResolvedValue(json(status("ready")));
    vi.stubGlobal("fetch", fetch);
    importer.mockImplementationOnce(async (_source, options) => {
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(
      installPokemonDatabase({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([404, 405, 501])(
    "explains the static-host fallback for HTTP %s",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ error: "unavailable" }, code)),
      );
      await expect(installPokemonDatabase()).rejects.toThrow(
        /local TCG Scan server.*Install database from ZIP/,
      );
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    { ...status("ready"), downloadedBytes: 1 },
    { ...status("ready"), totalBytes: RELEASE.sizeBytes + 1 },
    { ...status("downloading"), downloadedBytes: -1 },
    { ...status("downloading"), downloadedBytes: 1.1 },
    { ...status("downloading"), state: "invented" },
  ])("rejects malformed status %j", async (bad) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(bad)));
    await expect(installPokemonDatabase()).rejects.toThrow(
      /Install database from ZIP/,
    );
    expect(importer).not.toHaveBeenCalled();
  });
  it("rejects a successful HTML fallback without treating it as installer data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>SPA fallback</html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(installPokemonDatabase()).rejects.toThrow(
      /Install database from ZIP/,
    );
  });
  it("bounds status bodies rather than calling unbounded response.json", async () => {
    const response = new Response(" ".repeat(16385), {
        headers: { "content-type": "application/json" },
      }),
      cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(installPokemonDatabase()).rejects.toThrow(/safe size limit/);
    expect(cancel).toHaveBeenCalled();
  });
  it.each(["idle", "paused", "error"] as const)(
    "stops on terminal download state %s",
    async (state) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          json({
            ...status(state),
            error:
              state === "error" ? "Checksum verification failed" : undefined,
          }),
        ),
      );
      await expect(installPokemonDatabase()).rejects.toThrow(
        state === "error" ? /Checksum/ : /paused/,
      );
      expect(importer).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("reports an offline local server clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(installPokemonDatabase()).rejects.toThrow(
      /Could not reach.*local database server/,
    );
  });
  it("aborts a timed-out request and removes its timer", async () => {
    const fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const rejection = expect(installPokemonDatabase()).rejects.toThrow(
      /too long/,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a mismatched imported identity without any deletion request", async () => {
    const fetch = vi.fn().mockResolvedValue(json(status("ready")));
    vi.stubGlobal("fetch", fetch);
    importer.mockResolvedValueOnce({ ...metadata, checksum: "0".repeat(64) });
    await expect(installPokemonDatabase()).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "https://other.example/",
    "//other.example/",
    "/app?x=1",
    "/app\\bad/",
  ])("rejects unsupported base path %s", async (base) => {
    vi.stubEnv("BASE_URL", base);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(installPokemonDatabase()).rejects.toThrow(/base path/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded same-origin archive range reader", () => {
  it("uses 64 KiB header windows and 4 MiB payload read-ahead", async () => {
    const fetch = rangeFetch();
    vi.stubGlobal("fetch", fetch);
    const source = createPokemonArchiveSource();
    expect(new Uint8Array(await source.read(30, 60))).toEqual(
      Uint8Array.from({ length: 30 }, (_, i) => (30 + i) % 251),
    );
    await source.read(100, 200);
    expect(fetch).toHaveBeenCalledTimes(1);
    await source.read(70_000, 140_000);
    await source.read(140_000, 210_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("range"),
      ),
    ).toEqual(["bytes=0-65535", "bytes=0-4194303"]);
    expect(
      fetch.mock.calls.every(
        ([url]) => url === "/__tcg_scan/reference/pokemon/archive",
      ),
    ).toBe(true);
  });
  it("handles cross-window and final partial-window reads without overfetch", async () => {
    const fetch = rangeFetch();
    vi.stubGlobal("fetch", fetch);
    const source = createPokemonArchiveSource();
    const from = 4 * 1024 * 1024 - 500,
      to = from + 1500;
    const data = new Uint8Array(await source.read(from, to));
    expect(data).toEqual(
      Uint8Array.from({ length: 1500 }, (_, i) => (from + i) % 251),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const end = new Uint8Array(
      await source.read(RELEASE.sizeBytes - 10, RELEASE.sizeBytes),
    );
    expect(end).toHaveLength(10);
    expect(
      new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("range"),
    ).toMatch(new RegExp(`-${RELEASE.sizeBytes - 1}$`));
  });
  it("keeps the number of sequential payload requests proportional to 4 MiB windows", async () => {
    const fetch = rangeFetch();
    vi.stubGlobal("fetch", fetch);
    const source = createPokemonArchiveSource();
    for (let start = 0; start < 10 * 1024 * 1024; start += 65536)
      await source.read(start, start + 65536);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("allows only one active read/fetch", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const source = createPokemonArchiveSource();
    const first = source.read(0, 100);
    await expect(source.read(1, 2)).rejects.toThrow(
      /one database archive range/,
    );
    release(rangeResponse(0, 65536));
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([200, 404, 416])(
    "rejects HTTP %s instead of reading a full archive/error page",
    async (code) => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("Must not read body");
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: code,
            headers: { "content-type": "application/zip" },
          }),
        ),
      );
      await expect(createPokemonArchiveSource().read(0, 30)).rejects.toThrow(
        /requested ZIP byte range/,
      );
    },
  );
  it.each([
    [
      "wrong Content-Range",
      (r: Response) => {
        r.headers.set("content-range", `bytes 1-65536/${RELEASE.sizeBytes}`);
        return r;
      },
    ],
    [
      "wrong total",
      (r: Response) => {
        r.headers.set(
          "content-range",
          `bytes 0-65535/${RELEASE.sizeBytes + 1}`,
        );
        return r;
      },
    ],
    [
      "HTML body",
      (r: Response) => {
        r.headers.set("content-type", "text/html");
        return r;
      },
    ],
    [
      "gzip transport",
      (r: Response) => {
        r.headers.set("content-encoding", "gzip");
        return r;
      },
    ],
    [
      "oversized Content-Length",
      (r: Response) => {
        r.headers.set("content-length", "1000000000");
        return r;
      },
    ],
  ] as const)("rejects %s", async (_name, change) => {
    vi.stubGlobal("fetch", rangeFetch(change));
    await expect(
      createPokemonArchiveSource().read(0, 30),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each([65535, 65537])(
    "rejects actual truncated/oversized range length %s",
    async (length) => {
      vi.stubGlobal(
        "fetch",
        rangeFetch(
          (r) =>
            new Response(new Uint8Array(length), {
              status: 206,
              headers: {
                "content-type": "application/zip",
                "content-range": r.headers.get("content-range")!,
              },
            }),
        ),
      );
      await expect(createPokemonArchiveSource().read(0, 30)).rejects.toThrow(
        /truncated|safe size limit/,
      );
    },
  );
  it("cancels the active body reader on abort and does not poison future readers", async () => {
    const controller = new AbortController(),
      cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      rangeFetch(
        (r) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(1));
              },
              cancel,
            }),
            { status: 206, headers: r.headers },
          ),
      ),
    );
    const rejection = expect(
      createPokemonArchiveSource(controller.signal).read(0, 30),
    ).rejects.toMatchObject({ code: "aborted" });
    await flush();
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [-1, 2],
    [5, 5],
    [4, 3],
    [0, RELEASE.sizeBytes + 1],
    [0, 64 * 1024 * 1024 + 1],
    [0.5, 2],
  ])("rejects invalid ranges %s..%s without fetching", async (start, end) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createPokemonArchiveSource().read(start, end)).rejects.toThrow(
      /Invalid bounded/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("explicit reference transport selection", () => {
  it("uses the pinned static loader only in static mode", async () => {
    vi.stubEnv("VITE_TCG_REFERENCE_MODE", "static");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const options = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDownloadProgress: vi.fn(),
    };
    expect(usesStaticDatabaseInstall()).toBe(true);
    await expect(installPokemonDatabase(options)).resolves.toBe(metadata);
    expect(installStaticPokemonDatabase).toHaveBeenCalledExactlyOnceWith(
      options,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
  });
  it("does not fall back to the relay after a static integrity failure", async () => {
    vi.stubEnv("VITE_TCG_REFERENCE_MODE", "static");
    const failure = new Error("static SHA mismatch"),
      fetch = vi.fn();
    vi.mocked(installStaticPokemonDatabase).mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetch);
    await expect(installPokemonDatabase()).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
  });
  it("rejects unknown mode before networking or storage changes", async () => {
    vi.stubEnv("VITE_TCG_REFERENCE_MODE", "remote");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(installPokemonDatabase()).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(installStaticPokemonDatabase).not.toHaveBeenCalled();
    expect(listLearnedPacks).not.toHaveBeenCalled();
  });
  it("honors already-cancelled installation before loading a transport", async () => {
    vi.stubEnv("VITE_TCG_REFERENCE_MODE", "static");
    await expect(
      installPokemonDatabase({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(installStaticPokemonDatabase).not.toHaveBeenCalled();
  });
});
