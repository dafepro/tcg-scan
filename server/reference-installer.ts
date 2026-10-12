import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  POKEMON_REFERENCE_API_BASE,
  POKEMON_REFERENCE_RELEASE,
  type PokemonReferenceDownloadStatus,
} from "../src/lib/pokemon-reference-release";

const MAX_RANGE_BYTES = 64 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const ROUTES = new Set(["/status", "/start", "/cancel", "/archive"]);
const PUBLIC_ERROR =
  "The database download could not be completed. Try again to resume.";

interface Release {
  url: string;
  sizeBytes: number;
  sha256: string;
}
interface InstallerOptions {
  root: string;
  /** Injected only by tests, never taken from an HTTP request. */
  release?: Release;
  fetch?: typeof fetch;
  retryDelayMs?: number;
  idleTimeoutMs?: number;
  attemptTimeoutMs?: number;
  allowedHosts?: string[];
  apiBase?: string;
  bodyTimeoutMs?: number;
}
class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly discardPartial = false,
  ) {
    super(message);
  }
}
function isAbort(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
function abortError() {
  return new DOMException("Download paused.", "AbortError");
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function validSource(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}
function sendJson(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

/** One fixed asset, one active download, bounded memory and no network on page/status GET. */
export class ReferenceInstaller {
  private readonly release: Release;
  private readonly fetch: typeof fetch;
  private readonly cacheDirectory: string;
  private readonly finalPath: string;
  private readonly partialPath: string;
  private status: PokemonReferenceDownloadStatus;
  private activeJob?: Promise<void>;
  private jobController?: AbortController;
  private verified?: BigIntStats;
  private closed = false;
  private readonly reads = new Set<AbortController>();
  private readonly requests = new Set<Promise<void>>();

  constructor(private readonly options: InstallerOptions) {
    this.release = options.release ?? POKEMON_REFERENCE_RELEASE;
    if (
      !/^[a-f0-9]{64}$/.test(this.release.sha256) ||
      !Number.isSafeInteger(this.release.sizeBytes) ||
      this.release.sizeBytes < 1
    ) {
      throw new Error("Invalid reference release configuration.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.cacheDirectory = resolve(options.root, ".cache/tcg-scan/references");
    this.finalPath = resolve(this.cacheDirectory, `${this.release.sha256}.zip`);
    this.partialPath = `${this.finalPath}.part`;
    this.status = {
      state: "idle",
      downloadedBytes: 0,
      totalBytes: this.release.sizeBytes,
    };
  }

  getStatus(): PokemonReferenceDownloadStatus {
    return { ...this.status };
  }

  start(): PokemonReferenceDownloadStatus {
    if (this.closed) throw new Error("Reference installer is closed.");
    if (!this.activeJob && this.status.state !== "ready") {
      this.jobController = new AbortController();
      this.status = { ...this.status, state: "verifying", error: undefined };
      const signal = this.jobController.signal;
      this.activeJob = this.run(signal).finally(() => {
        this.activeJob = undefined;
        this.jobController = undefined;
      });
    }
    return this.getStatus();
  }

  async cancel(): Promise<PokemonReferenceDownloadStatus> {
    this.jobController?.abort();
    await this.activeJob;
    return this.getStatus();
  }

  async close() {
    this.closed = true;
    for (const controller of this.reads) controller.abort();
    await this.cancel();
    await Promise.all(this.requests);
  }

  private async file(path: string, flags: number): Promise<FileHandle> {
    const handle = await open(path, flags | constants.O_NOFOLLOW, 0o600);
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      throw new DownloadError("The reference cache is not a regular file.");
    }
    return handle;
  }

  private async hashFile(
    handle: FileHandle,
    size: number,
    signal: AbortSignal,
  ) {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(HASH_BUFFER_BYTES, Math.max(size, 1)));
    for (let offset = 0; offset < size;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytesRead)
        throw new DownloadError(
          "The reference cache is incomplete.",
          false,
          true,
        );
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    signal.throwIfAborted();
    return hash;
  }

  private async existingReady(signal: AbortSignal) {
    let handle: FileHandle;
    try {
      handle = await this.file(this.finalPath, constants.O_RDONLY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        before.size !== BigInt(this.release.sizeBytes) ||
        (await this.hashFile(handle, this.release.sizeBytes, signal)).digest(
          "hex",
        ) !== this.release.sha256 ||
        !sameFile(before, await handle.stat({ bigint: true }))
      ) {
        await handle.close();
        await rm(this.finalPath, { force: true });
        return false;
      }
      this.verified = before;
      this.status = {
        state: "ready",
        downloadedBytes: this.release.sizeBytes,
        totalBytes: this.release.sizeBytes,
      };
      return true;
    } finally {
      await handle.close();
    }
  }

  private async ensureCacheDirectory() {
    let directory = resolve(this.options.root);
    for (const component of [".cache", "tcg-scan", "references"]) {
      directory = resolve(directory, component);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await lstat(directory)).isDirectory())
        throw new DownloadError("The database cache directory is unsafe.");
    }
  }

  private async run(signal: AbortSignal) {
    try {
      if (!validSource(this.release.url))
        throw new DownloadError(
          "The public database release is not available yet.",
        );
      await this.ensureCacheDirectory();
      if (await this.existingReady(signal)) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.download(signal);
          return;
        } catch (error) {
          if (signal.aborted) throw abortError();
          if (error instanceof DownloadError && error.discardPartial) {
            await rm(this.partialPath, { force: true });
            this.status.downloadedBytes = 0;
          }
          if (
            !(error instanceof DownloadError) ||
            !error.retryable ||
            attempt === 2
          )
            throw error;
          await new Promise<void>((resolveWait, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(abortError());
            };
            const timer = setTimeout(
              () => {
                signal.removeEventListener("abort", onAbort);
                resolveWait();
              },
              (this.options.retryDelayMs ?? 1_000) * 2 ** attempt,
            );
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
    } catch (error) {
      this.status = {
        ...this.status,
        state: signal.aborted || isAbort(error) ? "paused" : "error",
        error:
          signal.aborted || isAbort(error)
            ? undefined
            : error instanceof DownloadError
              ? error.message
              : PUBLIC_ERROR,
      };
    }
  }

  private async download(signal: AbortSignal) {
    const handle = await this.file(
      this.partialPath,
      constants.O_CREAT | constants.O_RDWR,
    );
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const attemptTimer = setTimeout(
      cancel,
      this.options.attemptTimeoutMs ?? 15 * 60_000,
    );
    let idleTimer: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(cancel, this.options.idleTimeoutMs ?? 30_000);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const before = await handle.stat();
      let offset = before.size;
      if (offset > this.release.sizeBytes)
        throw new DownloadError(
          "The partial database has an invalid size.",
          false,
          true,
        );
      this.status = {
        state: "verifying",
        downloadedBytes: offset,
        totalBytes: this.release.sizeBytes,
      };
      const hash = await this.hashFile(handle, offset, signal);
      if (offset < this.release.sizeBytes) {
        this.status.state = "downloading";
        let url = this.release.url;
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (!validSource(url))
            throw new DownloadError(
              "The database download redirected to an unapproved host.",
            );
          touch();
          try {
            response = await this.fetch(url, {
              method: "GET",
              redirect: "manual",
              credentials: "omit",
              signal: controller.signal,
              headers: {
                "Accept-Encoding": "identity",
                ...(offset ? { Range: `bytes=${offset}-` } : {}),
              },
            });
          } catch {
            throw new DownloadError(PUBLIC_ERROR, true);
          }
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 5)
            throw new DownloadError(
              "The database download has an invalid redirect.",
            );
          try {
            url = new URL(location, url).href;
          } catch {
            throw new DownloadError(
              "The database download has an invalid redirect.",
            );
          }
        }
        if (!response) throw new DownloadError(PUBLIC_ERROR, true);
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          throw new DownloadError(
            "The database host is temporarily unavailable. Try again to resume.",
            true,
          );
        }
        if (response.status !== (offset ? 206 : 200)) {
          await response.body?.cancel();
          throw new DownloadError(
            offset && response.status === 200
              ? "The database host did not support resume. Restarting the download safely."
              : "The database host returned an unexpected response.",
            offset > 0 && response.status === 200,
            offset > 0 && response.status === 200,
          );
        }
        const expectedLength = this.release.sizeBytes - offset;
        const length = response.headers.get("content-length");
        const encoding = response.headers.get("content-encoding");
        const range = response.headers.get("content-range");
        if (
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) !== expectedLength)) ||
          (encoding && encoding !== "identity") ||
          (offset
            ? range !==
              `bytes ${offset}-${this.release.sizeBytes - 1}/${this.release.sizeBytes}`
            : range !== null)
        ) {
          await response.body?.cancel();
          throw new DownloadError(
            "The database host returned an invalid size or byte range.",
          );
        }
        if (!response.body)
          throw new DownloadError("The database response was empty.", true);
        reader = response.body.getReader();
        while (true) {
          signal.throwIfAborted();
          touch();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            throw new DownloadError(PUBLIC_ERROR, true);
          }
          if (chunk.done) break;
          if (offset + chunk.value.byteLength > this.release.sizeBytes) {
            throw new DownloadError(
              "The database exceeded its expected size.",
              false,
              true,
            );
          }
          let written = 0;
          while (written < chunk.value.byteLength) {
            signal.throwIfAborted();
            const result = await handle.write(
              chunk.value,
              written,
              chunk.value.byteLength - written,
              offset + written,
            );
            if (!result.bytesWritten) throw new DownloadError(PUBLIC_ERROR);
            written += result.bytesWritten;
          }
          hash.update(chunk.value);
          offset += chunk.value.byteLength;
          this.status.downloadedBytes = offset;
        }
        if (offset !== this.release.sizeBytes)
          throw new DownloadError(
            "The database download was interrupted. Try again to resume.",
            true,
          );
      }
      clearTimeout(idleTimer!);
      this.status.state = "verifying";
      signal.throwIfAborted();
      if (hash.digest("hex") !== this.release.sha256)
        throw new DownloadError(
          "The database failed its SHA-256 integrity check. Please retry.",
          false,
          true,
        );
      await handle.sync();
      signal.throwIfAborted();
      const verified = await handle.stat({ bigint: true });
      if (verified.size !== BigInt(this.release.sizeBytes))
        throw new DownloadError(
          "The database size changed during verification.",
          false,
          true,
        );
      await rename(this.partialPath, this.finalPath);
      this.verified = await handle.stat({ bigint: true });
      this.status = {
        state: "ready",
        downloadedBytes: this.release.sizeBytes,
        totalBytes: this.release.sizeBytes,
      };
    } finally {
      clearTimeout(attemptTimer);
      clearTimeout(idleTimer!);
      signal.removeEventListener("abort", cancel);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await handle.close();
    }
  }

  private sameOrigin(req: IncomingMessage) {
    const host = req.headers.host;
    if (!host || host.includes(",") || /[\s/@\\]/.test(host)) return false;
    try {
      const protocol =
        "encrypted" in req.socket && req.socket.encrypted ? "https:" : "http:";
      const expected = new URL(`${protocol}//${host}`);
      const name = expected.hostname.toLowerCase();
      const allowed = [
        "localhost",
        "127.0.0.1",
        "[::1]",
        ...(this.options.allowedHosts ?? []),
      ];
      const local = req.socket.localAddress;
      if (
        !allowed.some((value) =>
          value.startsWith(".")
            ? name === value.slice(1) || name.endsWith(value)
            : name === value,
        ) &&
        name !== local &&
        name !== `[${local}]`
      )
        return false;
      if (req.headers.origin !== expected.origin) return false;
      const site = req.headers["sec-fetch-site"];
      return site === undefined || site === "same-origin" || site === "none";
    } catch {
      return false;
    }
  }

  private async emptyJson(req: IncomingMessage) {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] ?? "",
      )
    )
      return false;
    if (Number(req.headers["content-length"] ?? 0) > 1_024) return false;
    return new Promise<boolean>((done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (valid: boolean) => {
        clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", invalid);
        req.off("aborted", invalid);
        if (!valid) req.pause();
        done(valid);
      };
      const invalid = () => finish(false);
      const onData = (data: Buffer) => {
        size += data.byteLength;
        if (size > 1_024) finish(false);
        else chunks.push(data);
      };
      const onEnd = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) {
          finish(true);
          return;
        }
        try {
          const value = JSON.parse(text);
          finish(
            value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              Object.keys(value).length === 0,
          );
        } catch {
          finish(false);
        }
      };
      const timer = setTimeout(invalid, this.options.bodyTimeoutMs ?? 5_000);
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", invalid);
      req.on("aborted", invalid);
    });
  }

  private async archive(req: IncomingMessage, res: ServerResponse) {
    if (this.status.state !== "ready" || !this.verified)
      return sendJson(res, 409, {
        error: "The database is not verified and ready.",
      });
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= this.release.sizeBytes ||
      end - start + 1 > MAX_RANGE_BYTES
    ) {
      res.setHeader("Content-Range", `bytes */${this.release.sizeBytes}`);
      return sendJson(res, 416, {
        error: "Request one explicit byte range of at most 64 MiB.",
      });
    }
    let handle: FileHandle;
    try {
      handle = await this.file(this.finalPath, constants.O_RDONLY);
    } catch {
      this.verified = undefined;
      this.status = {
        ...this.status,
        state: "error",
        error:
          "The cached database is unavailable. Download it again before importing.",
      };
      return sendJson(res, 409, { error: this.status.error });
    }
    const controller = new AbortController();
    this.reads.add(controller);
    const abort = () => controller.abort();
    const destroy = () => res.destroy();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    controller.signal.addEventListener("abort", destroy, { once: true });
    res.on("close", abort);
    try {
      if (!sameFile(this.verified, await handle.stat({ bigint: true }))) {
        this.verified = undefined;
        this.status = {
          ...this.status,
          state: "error",
          error:
            "The cached database changed. Verify it again before importing.",
        };
        return sendJson(res, 409, { error: this.status.error });
      }
      res.writeHead(206, {
        "Content-Type": "application/zip",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${this.release.sizeBytes}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const buffer = Buffer.alloc(Math.min(64 * 1024, end - start + 1));
      for (let position = start; position <= end;) {
        controller.signal.throwIfAborted();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(abort, this.options.idleTimeoutMs ?? 30_000);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, end - position + 1),
          position,
        );
        if (!bytesRead) throw new Error("Unexpected end of verified archive.");
        await new Promise<void>((resolveWrite, reject) => {
          res.write(buffer.subarray(0, bytesRead), (error) =>
            error ? reject(error) : resolveWrite(),
          );
        });
        position += bytesRead;
      }
      res.end();
    } finally {
      clearTimeout(idleTimer);
      res.off("close", abort);
      controller.signal.removeEventListener("abort", destroy);
      this.reads.delete(controller);
      await handle.close();
    }
  }

  middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if (
      !req.url?.startsWith(this.options.apiBase ?? POKEMON_REFERENCE_API_BASE)
    ) {
      next();
      return;
    }
    const work = this.route(req, res).catch(() => {
      if (!res.headersSent)
        sendJson(res, 500, {
          error: "The local database cache could not be read. Try again.",
        });
      else res.destroy();
    });
    this.requests.add(work);
    void work.then(
      () => this.requests.delete(work),
      () => this.requests.delete(work),
    );
  };

  private async route(req: IncomingMessage, res: ServerResponse) {
    const route = req.url!.slice(
      (this.options.apiBase ?? POKEMON_REFERENCE_API_BASE).length,
    );
    if (!ROUTES.has(route))
      return sendJson(res, 404, { error: "Unknown database endpoint." });
    if (req.method === "GET" && route === "/status")
      return sendJson(res, 200, this.getStatus());
    if (req.method === "GET" && route === "/archive") {
      if (this.closed)
        return sendJson(res, 503, {
          error: "The local database server is shutting down.",
        });
      return this.archive(req, res);
    }
    if (req.method !== "POST" || !["/start", "/cancel"].includes(route))
      return sendJson(res, 405, { error: "Method not allowed." });
    if (!this.sameOrigin(req))
      return sendJson(res, 403, {
        error: "Database changes require a same-origin request.",
      });
    if (!(await this.emptyJson(req))) {
      res.setHeader("Connection", "close");
      return sendJson(res, 400, {
        error: "Send application/json with an empty object and no parameters.",
      });
    }
    if (this.closed)
      return sendJson(res, 503, {
        error: "The local database server is shutting down.",
      });
    if (route === "/start") return sendJson(res, 202, this.start());
    return sendJson(res, 200, await this.cancel());
  }
}

export function referenceInstallerPlugin(): Plugin {
  let root = process.cwd();
  let allowedHosts: string[] = [];
  let apiBase = POKEMON_REFERENCE_API_BASE;
  const installers = new Set<ReferenceInstaller>();
  const install = (server: {
    middlewares: {
      use: (handler: ReferenceInstaller["middleware"]) => unknown;
    };
    httpServer: {
      once: (event: "close", callback: () => void) => unknown;
    } | null;
  }) => {
    const installer = new ReferenceInstaller({ root, allowedHosts, apiBase });
    installers.add(installer);
    server.middlewares.use(installer.middleware);
    server.httpServer?.once("close", () => {
      void installer.close().finally(() => installers.delete(installer));
    });
  };
  return {
    name: "tcg-scan-reference-installer",
    config() {
      // Include Vite's default deny patterns: replacing this array must never
      // expose secrets while keeping the reference cache behind its API.
      return {
        server: {
          fs: {
            deny: [
              ".env",
              ".env.*",
              "*.{crt,pem}",
              "**/.git/**",
              "**/.cache/tcg-scan/**",
            ],
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
      apiBase = `${new URL(config.base, "http://local").pathname.replace(/\/$/, "")}${POKEMON_REFERENCE_API_BASE}`;
      allowedHosts = [
        ...(Array.isArray(config.server.allowedHosts)
          ? config.server.allowedHosts
          : []),
        ...(Array.isArray(config.preview.allowedHosts)
          ? config.preview.allowedHosts
          : []),
        ...(typeof config.server.host === "string" ? [config.server.host] : []),
        ...(typeof config.preview.host === "string"
          ? [config.preview.host]
          : []),
      ];
    },
    async closeBundle() {
      await Promise.all([...installers].map((installer) => installer.close()));
      installers.clear();
    },
    configureServer: install,
    configurePreviewServer: install,
  };
}
