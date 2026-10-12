import {
  importLearnedArchiveSource,
  type LearnedArchiveSource,
} from "./learned-archive";
import {
  LearnedStorageError,
  listLearnedPacks,
  removeCorruptLearnedPack,
  type LearnedImportProgress,
  type LearnedPackMetadata,
} from "./learned-packs";
import {
  POKEMON_REFERENCE_API_BASE,
  POKEMON_REFERENCE_RELEASE,
  type PokemonReferenceDownloadStatus,
} from "./pokemon-reference-release";

const STATUS_BYTES = 16 * 1024;
const HEADER_WINDOW = 64 * 1024;
const PAYLOAD_WINDOW = 4 * 1024 * 1024;
const POLL_MS = 750;
const REQUEST_TIMEOUT_MS = 30_000;
const UNSUPPORTED =
  "Automatic database installation needs the local TCG Scan server. This host does not provide the installer. Download the reference ZIP and use Install database from ZIP instead.";
interface InstallOptions {
  signal?: AbortSignal;
  onDownloadProgress?: (progress: PokemonReferenceDownloadStatus) => void;
  onProgress?: (progress: LearnedImportProgress) => void;
}
function aborted(): LearnedStorageError {
  return new LearnedStorageError(
    "aborted",
    "Pokémon database installation cancelled.",
  );
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}
function unavailable(message: string): never {
  throw new LearnedStorageError("unavailable", message);
}
function endpoint(action: "status" | "start" | "cancel" | "archive"): string {
  const base = import.meta.env.BASE_URL;
  // Vite supplies an absolute-path deployment prefix. Never use a caller URL,
  // external origin, protocol-relative prefix, or credentials for installation.
  if (
    typeof base !== "string" ||
    !base.startsWith("/") ||
    base.startsWith("//") ||
    /[?#\\]/.test(base)
  )
    unavailable(
      "The application's base path is not supported by the local database installer. Use Install database from ZIP instead.",
    );
  return `${base.replace(/\/$/, "")}${POKEMON_REFERENCE_API_BASE}/${action}`;
}
async function withRequest<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  consume: (response: Response, requestSignal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  checkSignal(signal);
  const controller = new AbortController(),
    onAbort = () => controller.abort();
  let timedOut = false;
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    checkSignal(signal);
    const response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    checkSignal(signal);
    return await consume(response, controller.signal);
  } catch (error) {
    checkSignal(signal);
    if (timedOut)
      unavailable(
        "The local database server took too long to respond. Try again, or use Install database from ZIP.",
      );
    if (error instanceof LearnedStorageError) throw error;
    return unavailable(
      "Could not reach the local database server. Check that TCG Scan is running, then retry or use Install database from ZIP.",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
/** Read only a fixed bounded response, cancelling immediately on excess bytes. */
async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
  exact?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const rawLength = response.headers.get("content-length");
  if (
    rawLength !== null &&
    (!/^\d+$/.test(rawLength) ||
      !Number.isSafeInteger(Number(rawLength)) ||
      Number(rawLength) > limit ||
      (exact !== undefined && Number(rawLength) !== exact))
  ) {
    await response.body?.cancel().catch(() => {});
    unavailable(
      "The database server returned an invalid response size. Retry the installation.",
    );
  }
  if (!response.body)
    unavailable("The database server returned an empty response.");
  const reader = response.body.getReader(),
    output = new Uint8Array(limit);
  let offset = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const { done, value } = await reader.read();
      checkSignal(signal);
      if (done) break;
      if (value.byteLength > limit - offset)
        unavailable(
          "The database server response exceeded its safe size limit.",
        );
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (
      (exact !== undefined && offset !== exact) ||
      (rawLength !== null && offset !== Number(rawLength))
    )
      unavailable(
        "The database download was truncated. Retry the installation.",
      );
    return offset === output.length ? output : output.slice(0, offset);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
function validateStatus(value: unknown): PokemonReferenceDownloadStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unavailable(UNSUPPORTED);
  const status = value as Record<string, unknown>;
  if (
    !(
      [
        "idle",
        "downloading",
        "paused",
        "verifying",
        "ready",
        "error",
      ] as unknown[]
    ).includes(status.state) ||
    !Number.isSafeInteger(status.downloadedBytes) ||
    Number(status.downloadedBytes) < 0 ||
    status.totalBytes !== POKEMON_REFERENCE_RELEASE.sizeBytes ||
    Number(status.downloadedBytes) > status.totalBytes ||
    (status.error !== undefined &&
      (typeof status.error !== "string" || status.error.length > 2000)) ||
    (status.state === "ready" && status.downloadedBytes !== status.totalBytes)
  )
    unavailable(UNSUPPORTED);
  return {
    state: status.state as PokemonReferenceDownloadStatus["state"],
    downloadedBytes: status.downloadedBytes as number,
    totalBytes: status.totalBytes,
    ...(typeof status.error === "string" ? { error: status.error } : {}),
  };
}
async function requestStatus(
  action: "status" | "start",
  signal?: AbortSignal,
): Promise<PokemonReferenceDownloadStatus> {
  return withRequest(
    endpoint(action),
    action === "start"
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }
      : { method: "GET" },
    signal,
    async (response, requestSignal) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([404, 405, 501].includes(response.status)) unavailable(UNSUPPORTED);
        unavailable(
          `The local database installer returned HTTP ${response.status}. Retry or use Install database from ZIP.`,
        );
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel().catch(() => {});
        unavailable(UNSUPPORTED);
      }
      const bytes = await boundedBody(response, STATUS_BYTES, requestSignal);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        return unavailable(UNSUPPORTED);
      }
      return validateStatus(value);
    },
  );
}
function pause(signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        reject(aborted());
      },
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, POLL_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
async function cancelDownload(): Promise<void> {
  try {
    await withRequest(
      endpoint("cancel"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      undefined,
      async (response) => {
        await response.body?.cancel().catch(() => {});
      },
      3000,
    );
  } catch {
    /* Best-effort stop; the user's abort still wins. */
  }
}
interface RangeCache {
  start: number;
  bytes: Uint8Array<ArrayBuffer>;
}
/** Fixed same-origin archive only. At most one fetch, a 4 MiB payload cache, and
 * a 64 KiB header cache are retained; callers receive exact bounded byte ranges.
 */
export function createPokemonArchiveSource(
  signal?: AbortSignal,
): LearnedArchiveSource {
  let payload: RangeCache | undefined,
    header: RangeCache | undefined,
    active = false;
  const size = POKEMON_REFERENCE_RELEASE.sizeBytes;
  return {
    size,
    async read(start, end, readSignal) {
      checkSignal(signal);
      checkSignal(readSignal);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > size ||
        end - start > 64 * 1024 * 1024
      )
        unavailable("Invalid bounded database archive range.");
      if (active)
        unavailable(
          "Only one database archive range may be fetched at a time.",
        );
      active = true;
      const controller = new AbortController(),
        onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      readSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        checkSignal(signal);
        checkSignal(readSignal);
        const result = new Uint8Array(end - start),
          window = result.length <= 1024 ? HEADER_WINDOW : PAYLOAD_WINDOW;
        let offset = start;
        while (offset < end) {
          checkSignal(controller.signal);
          let cached = [payload, header].find(
            (item) =>
              item &&
              offset >= item.start &&
              offset < item.start + item.bytes.length,
          );
          if (!cached) {
            const from = Math.floor(offset / window) * window,
              to = Math.min(size, from + window);
            const bytes = await withRequest(
              endpoint("archive"),
              {
                method: "GET",
                headers: { Range: `bytes=${from}-${to - 1}` },
              },
              controller.signal,
              async (response, requestSignal) => {
                if (
                  response.status !== 206 ||
                  response.headers.get("content-range") !==
                    `bytes ${from}-${to - 1}/${size}` ||
                  !/^(?:application\/zip|application\/octet-stream)(?:\s*;|$)/i.test(
                    response.headers.get("content-type") ?? "",
                  ) ||
                  (response.headers.has("content-encoding") &&
                    response.headers.get("content-encoding") !== "identity")
                ) {
                  await response.body?.cancel().catch(() => {});
                  unavailable(
                    "The local server did not return the requested ZIP byte range. Use Install database from ZIP if this host does not support database installation.",
                  );
                }
                return boundedBody(
                  response,
                  to - from,
                  requestSignal,
                  to - from,
                );
              },
            );
            cached = { start: from, bytes };
            if (window === HEADER_WINDOW) header = cached;
            else payload = cached;
          }
          const count = Math.min(
            end - offset,
            cached.bytes.length - (offset - cached.start),
          );
          result.set(
            cached.bytes.subarray(
              offset - cached.start,
              offset - cached.start + count,
            ),
            offset - start,
          );
          offset += count;
        }
        return result.buffer;
      } finally {
        active = false;
        signal?.removeEventListener("abort", onAbort);
        readSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
/** Explicit install action: let the local server fetch and verify the one pinned
 * public ZIP, then install it through the same lazy, CRC/SHA-checked ZIP importer.
 */
export async function installPokemonDatabase(
  options: InstallOptions = {},
): Promise<LearnedPackMetadata> {
  checkSignal(options.signal);
  const targetId = `learned:${POKEMON_REFERENCE_RELEASE.manifestSha256}`,
    existing = (await listLearnedPacks()).find((pack) => pack.id === targetId);
  checkSignal(options.signal);
  if (existing?.readiness === "importing")
    throw new LearnedStorageError(
      "conflict",
      "This database is already being imported. Let that import finish or cancel it before trying again.",
    );
  if (existing?.readiness === "corrupt")
    await removeCorruptLearnedPack(targetId);
  checkSignal(options.signal);
  if (existing?.readiness !== "ready") {
    const estimate = await globalThis.navigator?.storage
      ?.estimate?.()
      .catch(() => undefined);
    checkSignal(options.signal);
    if (
      estimate?.quota !== undefined &&
      estimate.quota - (estimate.usage ?? 0) <
        Math.ceil(POKEMON_REFERENCE_RELEASE.referenceBytes * 1.2)
    )
      throw new LearnedStorageError(
        "quota",
        "Not enough browser storage for this database, including import overhead. Free space or remove an old reference pack before downloading it.",
      );
  }
  let started = false,
    ready = false;
  try {
    started = true;
    let status = await requestStatus("start", options.signal);
    while (true) {
      ready = status.state === "ready";
      options.onDownloadProgress?.(status);
      checkSignal(options.signal);
      if (ready) break;
      if (status.state === "error")
        unavailable(
          status.error ||
            "The reference database could not be downloaded. Retry or use Install database from ZIP.",
        );
      if (status.state === "paused" || status.state === "idle")
        unavailable(
          "The database download is paused. Choose Install database again to resume it.",
        );
      await pause(options.signal);
      status = await requestStatus("status", options.signal);
    }
    const result = await importLearnedArchiveSource(
      createPokemonArchiveSource(options.signal),
      {
        signal: options.signal,
        onProgress: options.onProgress,
        expectedManifestSha256: POKEMON_REFERENCE_RELEASE.manifestSha256,
      },
    );
    if (
      result.checksum !== POKEMON_REFERENCE_RELEASE.manifestSha256 ||
      result.cards !== POKEMON_REFERENCE_RELEASE.referenceCount ||
      result.names !== POKEMON_REFERENCE_RELEASE.nameCount
    )
      throw new LearnedStorageError(
        "corrupt",
        "The installed database does not match the verified Pokémon release. No existing packs were removed. Use the verified reference ZIP or remove the unexpected pack before retrying.",
      );
    return result;
  } catch (error) {
    if (options.signal?.aborted) {
      if (started && !ready) await cancelDownload();
      throw aborted();
    }
    throw error;
  }
}
