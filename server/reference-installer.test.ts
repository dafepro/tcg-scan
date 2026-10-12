import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer, preview } from "vite";
import { POKEMON_REFERENCE_API_BASE as API } from "../src/lib/pokemon-reference-release";
import {
  ReferenceInstaller,
  referenceInstallerPlugin,
} from "./reference-installer";

const bytes = Buffer.from(
  "A tiny reference archive fixture, streamed and verified.",
);
const release = {
  url: "https://github.com/example/fixed/releases/download/v1/reference.zip",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const fixtures: {
  installer: ReferenceInstaller;
  root: string;
  server: Server;
}[] = [];

async function fixture(
  fetchMock: typeof fetch = vi.fn(async () => new Response(bytes)),
  options: Partial<ConstructorParameters<typeof ReferenceInstaller>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tcg-reference-test-"));
  const installer = new ReferenceInstaller({
    root,
    release,
    fetch: fetchMock,
    retryDelayMs: 1,
    ...options,
  });
  const server = createServer((req, res) =>
    installer.middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  fixtures.push({ installer, root, server });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server missing.");
  const origin = `http://127.0.0.1:${address.port}`;
  const cache = join(root, ".cache/tcg-scan/references");
  const finalPath = join(cache, `${(options.release ?? release).sha256}.zip`);
  const call = (suffix: string, init?: RequestInit) =>
    fetch(origin + (options.apiBase ?? API) + suffix, init);
  const post = (suffix: string, init?: RequestInit) =>
    call(suffix, {
      method: "POST",
      body: "{}",
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...init,
    });
  return {
    installer,
    root,
    server,
    origin,
    cache,
    finalPath,
    partialPath: finalPath + ".part",
    call,
    post,
    fetchMock,
  };
}
async function finished(installer: ReferenceInstaller) {
  await vi.waitFor(() =>
    expect(["ready", "error", "paused"]).toContain(installer.getStatus().state),
  );
  return installer.getStatus();
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.installer.close();
    await new Promise<void>((done) => f.server.close(() => done()));
    await rm(f.root, { recursive: true, force: true });
  }
});

describe("fixed reference download", () => {
  it("does no network work on status GET; explicit POST verifies the whole download", async () => {
    const f = await fixture();
    expect(await (await f.call("/status")).json()).toEqual({
      state: "idle",
      downloadedBytes: 0,
      totalBytes: bytes.length,
    });
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect((await f.post("/start")).status).toBe(202);
    expect(await finished(f.installer)).toEqual({
      state: "ready",
      downloadedBytes: bytes.length,
      totalBytes: bytes.length,
    });
    expect(await readFile(f.finalPath)).toEqual(bytes);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledWith(
      release.url,
      expect.objectContaining({ redirect: "manual", credentials: "omit" }),
    );
  });

  it("serves one bounded inclusive byte range only after verification", async () => {
    const f = await fixture();
    expect(
      (await f.call("/archive", { headers: { Range: "bytes=0-3" } })).status,
    ).toBe(409);
    f.installer.start();
    await finished(f.installer);
    const response = await f.call("/archive", {
      headers: { Range: "bytes=2-11" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 2-11/${bytes.length}`,
    );
    expect(response.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      bytes.subarray(2, 12),
    );
    for (const range of [
      "",
      "bytes=0-",
      "bytes=-3",
      "bytes=0-2,5-7",
      "bytes=6-2",
      `bytes=0-${bytes.length}`,
      "bytes=0-67108864",
      "bytes=999999999999999999-999999999999999999",
    ]) {
      expect(
        (await f.call("/archive", { headers: { Range: range } })).status,
      ).toBe(416);
    }
  });

  it("rehashes the prefix and requests a validated Range to resume", async () => {
    const offset = 12;
    const remote = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("range")).toBe(
          `bytes=${offset}-`,
        );
        return new Response(bytes.subarray(offset), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
            "Content-Length": String(bytes.length - offset),
          },
        });
      },
    );
    const f = await fixture(remote);
    await mkdir(f.cache, { recursive: true });
    await writeFile(f.partialPath, bytes.subarray(0, offset));
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(await readFile(f.finalPath)).toEqual(bytes);
  });

  it("never appends a 200 to a partial file, safely restarting once Range is ignored", async () => {
    const remote = vi.fn(async () => new Response(bytes));
    const f = await fixture(remote);
    await mkdir(f.cache, { recursive: true });
    await writeFile(f.partialPath, bytes.subarray(0, 9));
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(remote).toHaveBeenCalledTimes(2);
    expect(await readFile(f.finalPath)).toEqual(bytes);
  });

  it("pauses, keeps the downloaded prefix, then resumes without duplicate jobs", async () => {
    let streaming: ReadableStreamDefaultController<Uint8Array>;
    let attempt = 0;
    const remote = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (attempt++)
          return new Response(bytes.subarray(10), {
            status: 206,
            headers: {
              "Content-Range": `bytes 10-${bytes.length - 1}/${bytes.length}`,
            },
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streaming = controller;
              controller.enqueue(bytes.subarray(0, 10));
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            },
          }),
        );
      },
    );
    const f = await fixture(remote);
    f.installer.start();
    f.installer.start();
    await vi.waitFor(() =>
      expect(f.installer.getStatus().downloadedBytes).toBe(10),
    );
    expect(streaming!).toBeDefined();
    const paused = await (await f.post("/cancel")).json();
    expect(paused.state).toBe("paused");
    expect(await readFile(f.partialPath)).toEqual(bytes.subarray(0, 10));
    expect(remote).toHaveBeenCalledOnce();
    await f.post("/start");
    expect((await finished(f.installer)).state).toBe("ready");
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("verifies an existing ready cache without fetching and rejects later tampering", async () => {
    const f = await fixture();
    await mkdir(f.cache, { recursive: true });
    await writeFile(f.finalPath, bytes);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(f.fetchMock).not.toHaveBeenCalled();
    await writeFile(f.finalPath, Buffer.alloc(bytes.length));
    expect(
      (await f.call("/archive", { headers: { Range: "bytes=0-1" } })).status,
    ).toBe(409);
    expect(f.installer.getStatus().state).toBe("error");
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects hash mismatch and removes only the corrupt partial", async () => {
    const f = await fixture(
      vi.fn(async () => new Response(Buffer.alloc(bytes.length))),
    );
    await writeFile(join(f.root, "unrelated.txt"), "keep me");
    f.installer.start();
    expect((await finished(f.installer)).error).toMatch(/SHA-256/);
    await expect(stat(f.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.root, "unrelated.txt"), "utf8")).toBe(
      "keep me",
    );
  });

  it("rejects overflow and wrong Content-Length before exposing any ready archive", async () => {
    for (const response of [
      new Response(Buffer.alloc(bytes.length + 1)),
      new Response(bytes, { headers: { "Content-Length": "99999999" } }),
    ]) {
      const f = await fixture(vi.fn(async () => response));
      f.installer.start();
      expect((await finished(f.installer)).state).toBe("error");
      await expect(stat(f.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects mismatched Content-Range or encoded responses", async () => {
    for (const headers of [
      { "Content-Range": `bytes 11-${bytes.length - 1}/${bytes.length}` },
      {
        "Content-Range": `bytes 10-${bytes.length - 1}/${bytes.length}`,
        "Content-Encoding": "gzip",
      },
    ] as Record<string, string>[]) {
      const f = await fixture(
        vi.fn(
          async () =>
            new Response(bytes.subarray(10), { status: 206, headers }),
        ),
      );
      await mkdir(f.cache, { recursive: true });
      await writeFile(f.partialPath, bytes.subarray(0, 10));
      f.installer.start();
      expect((await finished(f.installer)).state).toBe("error");
      expect(await readFile(f.partialPath)).toEqual(bytes.subarray(0, 10));
    }
  });

  it("bounds transient retries and redacts provider exception details", async () => {
    const remote = vi.fn(async () => {
      throw new Error("SECRET token=never-show-this");
    });
    const f = await fixture(remote);
    f.installer.start();
    const status = await finished(f.installer);
    expect(status.state).toBe("error");
    expect(status.error).not.toMatch(/SECRET|token/);
    expect(remote).toHaveBeenCalledTimes(3);
  });

  it("automatically resumes a truncated response using the saved prefix", async () => {
    let attempt = 0;
    const remote = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!attempt++) return new Response(bytes.subarray(0, 8));
        expect(new Headers(init?.headers).get("Range")).toBe("bytes=8-");
        return new Response(bytes.subarray(8), {
          status: 206,
          headers: {
            "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
          },
        });
      },
    );
    const f = await fixture(remote);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it.each(["idleTimeoutMs", "attemptTimeoutMs"] as const)(
    "bounds stalled downloads with %s",
    async (timeout) => {
      const remote = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new DOMException("Timed out", "AbortError"),
                    ),
                  { once: true },
                );
              },
            }),
          ),
      );
      const f = await fixture(remote, { [timeout]: 10 });
      f.installer.start();
      expect((await finished(f.installer)).state).toBe("error");
      expect(remote).toHaveBeenCalledTimes(3);
    },
  );

  it("finishes a fully downloaded partial file without another request", async () => {
    const f = await fixture();
    await mkdir(f.cache, { recursive: true });
    await writeFile(f.partialPath, bytes);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(await readFile(f.finalPath)).toEqual(bytes);
  });

  it("follows only bounded HTTPS redirects on exact approved hosts", async () => {
    const remote = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/steal" },
        }),
    );
    const f = await fixture(remote);
    f.installer.start();
    expect((await finished(f.installer)).error).toMatch(/unapproved host/);
    expect(remote).toHaveBeenCalledOnce();
    for (const bad of [
      "http://github.com/file",
      "https://github.com.evil.example/file",
      "https://user:pass@github.com/file",
      "https://github.com:8443/file",
    ]) {
      const g = await fixture(
        vi.fn(async () => new Response(bytes)),
        { release: { ...release, url: bad } },
      );
      g.installer.start();
      expect((await finished(g.installer)).state).toBe("error");
      expect(g.fetchMock).not.toHaveBeenCalled();
    }
  });

  it("accepts approved redirects and preserves only controlled request headers", async () => {
    let attempt = 0;
    const remote = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return attempt++
          ? new Response(bytes)
          : new Response(null, {
              status: 302,
              headers: {
                Location:
                  "https://release-assets.githubusercontent.com/fixed?signature=fixture",
              },
            });
      },
    );
    const f = await fixture(remote);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("ready");
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("stops redirect loops after six requests", async () => {
    const remote = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: release.url } }),
    );
    const f = await fixture(remote);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("error");
    expect(remote).toHaveBeenCalledTimes(6);
  });

  it("does not follow cache-file symlinks", async () => {
    const f = await fixture();
    await mkdir(f.cache, { recursive: true });
    const target = join(f.root, "user-file.zip");
    await writeFile(target, bytes);
    await symlink(target, f.partialPath);
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("error");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(bytes);
  });

  it("requires same-origin POST, valid local Host, JSON and no arbitrary parameters", async () => {
    const f = await fixture();
    const reject: RequestInit[] = [
      {
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
      },
      { headers: { "Content-Type": "application/json" } },
      {
        headers: {
          Origin: f.origin,
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
      },
      { headers: { Origin: f.origin, "Content-Type": "text/plain" } },
      { body: '{"url":"https://evil.example","path":"../../secrets"}' },
      { body: "[]" },
      { body: "not json" },
      { body: "x".repeat(2_000) },
    ];
    for (const init of reject)
      expect([400, 403]).toContain((await f.post("/start", init)).status);
    expect((await f.call("/start")).status).toBe(405);
    for (const suffix of [
      "/start?url=https://evil.example",
      "/archive?path=../../secrets",
      "/%2e%2e/secrets",
      "/archive/../../../secrets",
    ]) {
      expect((await f.post(suffix)).status).toBe(404);
    }
    const code = await new Promise<number>((done, fail) => {
      const req = request(
        f.origin + API + "/start",
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            Origin: "http://evil.example",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          done(res.statusCode!);
        },
      );
      req.on("error", fail);
      req.end("{}");
    });
    expect(code).toBe(403);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unfinished JSON body within the bounded request deadline", async () => {
    const f = await fixture(undefined, { bodyTimeoutMs: 15 });
    const code = await new Promise<number>((done, fail) => {
      const req = request(
        f.origin + API + "/start",
        {
          method: "POST",
          headers: { Origin: f.origin, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          done(res.statusCode!);
        },
      );
      req.on("error", fail);
      req.write("{");
    });
    expect(code).toBe(400);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects symlinked cache directories before any network or external write", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "outside");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(f.root, ".cache"));
    f.installer.start();
    expect((await finished(f.installer)).state).toBe("error");
    expect(f.fetchMock).not.toHaveBeenCalled();
    await expect(stat(join(elsewhere, "tcg-scan"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports a configured subpath and both Vite development/preview hooks", async () => {
    const f = await fixture(undefined, { apiBase: `/tcg-scan${API}` });
    expect((await f.call("/status")).status).toBe(200);
    expect((await fetch(f.origin + API + "/status")).status).toBe(404);
    await f.post("/start");
    expect((await finished(f.installer)).state).toBe("ready");
    const plugin = referenceInstallerPlugin();
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });

  it("denies direct Vite /@fs and project-path cache access, preserving other deny rules", async () => {
    const f = await fixture();
    await mkdir(f.cache, { recursive: true });
    await writeFile(f.partialPath, "CACHE-MUST-STAY-PRIVATE");
    await writeFile(join(f.root, ".env"), "SECRET");
    await mkdir(join(f.root, "other-private"));
    await writeFile(join(f.root, "other-private", "data"), "SECRET");
    const server = await createViteServer({
      root: f.root,
      configFile: false,
      logLevel: "silent",
      plugins: [referenceInstallerPlugin()],
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { deny: ["**/other-private/**"] },
      },
    });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string")
        throw new Error("No Vite address.");
      for (const path of [
        `/.cache/tcg-scan/references/${release.sha256}.zip.part`,
        `/@fs/${f.partialPath}`,
        "/.env",
        "/other-private/data",
      ]) {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toMatch(
          /CACHE-MUST-STAY-PRIVATE|SECRET/,
        );
      }
    } finally {
      await server.close();
    }
  });

  it("mounts actual Vite development and preview APIs at root and subpaths", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "dist"));
    for (const base of ["/", "/tcg-scan/"]) {
      for (const mode of ["dev", "preview"]) {
        const config = {
          root: f.root,
          configFile: false as const,
          base,
          plugins: [referenceInstallerPlugin()],
          server: { host: "127.0.0.1", port: 0 },
          preview: { host: "127.0.0.1", port: 0 },
          logLevel: "silent" as const,
        };
        const server =
          mode === "dev"
            ? await createViteServer(config)
            : await preview(config);
        try {
          if ("listen" in server) await server.listen();
          const address = server.httpServer!.address();
          if (!address || typeof address === "string")
            throw new Error("No Vite address.");
          const response = await fetch(
            `http://127.0.0.1:${address.port}${base}__tcg_scan/reference/pokemon/status`,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            state: "idle",
            totalBytes: 358_031_963,
          });
        } finally {
          await server.close();
        }
      }
    }
  });

  it("server close cancels owned work, retaining the safe resumable prefix", async () => {
    const remote = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 8));
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("abort", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
    );
    const f = await fixture(remote);
    f.installer.start();
    await vi.waitFor(() =>
      expect(f.installer.getStatus().downloadedBytes).toBe(8),
    );
    await f.installer.close();
    expect(f.installer.getStatus().state).toBe("paused");
    expect(await readFile(f.partialPath)).toEqual(bytes.subarray(0, 8));
    expect((await f.post("/start")).status).toBe(503);
  });
});
