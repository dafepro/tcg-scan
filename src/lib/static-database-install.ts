import {
  importLearnedPack,
  LEARNED_MAX_SHARD_BYTES,
  LearnedStorageError,
  listLearnedPacks,
  removeCorruptLearnedPack,
  validateLearnedManifest,
  type LearnedImportProgress,
  type LearnedPackFile,
  type LearnedPackMetadata,
  type LearnedPackShard,
} from "./learned-packs";
import {
  POKEMON_REFERENCE_RELEASE as RELEASE,
  type PokemonReferenceDownloadStatus,
} from "./pokemon-reference-release";

const MANIFEST = "manifest.learned.json";
const REQUEST_TIMEOUT_MS = 60_000;
const SHARD_NAME = /^features-[0-9]{5}\.bin$/;

export interface StaticPokemonInstallOptions {
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
function corrupt(message: string): never {
  throw new LearnedStorageError("corrupt", message);
}
/** Only a deployment pathname may vary. Encoded paths, dot segments, credentials,
 * origins, queries, fragments, backslashes, and ambiguous separators fail closed.
 */
function referenceDirectory(): string {
  const base: unknown = import.meta.env.BASE_URL;
  if (typeof base !== "string" || !base.startsWith("/") || base.length > 2048)
    unavailable(
      "The application's base path is not supported by the static database installer.",
    );
  const path = base.slice(1).replace(/\/$/, "");
  if (
    base !== "/" &&
    (!path ||
      path
        .split("/")
        .some(
          (part) =>
            !/^[A-Za-z0-9._~-]+$/.test(part) || part === "." || part === "..",
        ))
  )
    unavailable(
      "The application's base path is not supported by the static database installer.",
    );
  return `${base.endsWith("/") ? base : `${base}/`}reference-data/${RELEASE.id}/`;
}
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
/** Allocate exactly one output buffer; reject before copying any excess chunk. */
async function boundedBody(
  response: Response,
  size: number,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const rawLength = response.headers.get("content-length"),
    encoding = response.headers.get("content-encoding")?.trim().toLowerCase(),
    compressed = encoding !== undefined && encoding !== "identity";
  // Fetch exposes decoded bytes. Common static hosts compress JSON, so their
  // Content-Length is a transport length, never the expected decoded size.
  if (
    (compressed && !["gzip", "br", "deflate"].includes(encoding)) ||
    (rawLength !== null &&
      (!/^\d+$/.test(rawLength) ||
        !Number.isSafeInteger(Number(rawLength)) ||
        Number(rawLength) <= 0 ||
        (compressed
          ? Number(rawLength) > size + 65536
          : Number(rawLength) !== size)))
  ) {
    await discard(response);
    corrupt(
      "The static database response has an invalid size or content encoding. Check the hosted reference files.",
    );
  }
  if (!response.body)
    corrupt("The static database response is missing its body.");
  const reader = response.body.getReader(),
    output = new Uint8Array(size);
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
      if (value.byteLength > size - offset)
        corrupt(
          "The static database response exceeded its exact safe size limit.",
        );
      output.set(value, offset);
      offset += value.byteLength;
      progress(value.byteLength);
      checkSignal(signal);
    }
    if (offset !== size)
      corrupt(
        "The static database response was truncated. Check the hosted reference files.",
      );
    return output.buffer;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function requestFile(
  path: string,
  size: number,
  manifest: boolean,
  signal: AbortSignal | undefined,
  progress: (bytes: number) => void,
): Promise<ArrayBuffer> {
  checkSignal(signal);
  const controller = new AbortController(),
    onAbort = () => controller.abort();
  let timedOut = false;
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    checkSignal(signal);
    const response = await fetch(path, {
      method: "GET",
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      await discard(response);
      throw aborted();
    }
    checkSignal(signal);
    if (response.redirected || !["basic", "default"].includes(response.type)) {
      await discard(response);
      corrupt(
        "The static database response came from an unexpected redirect or origin.",
      );
    }
    if (response.url) {
      const expected = new URL(path, globalThis.location.origin);
      if (response.url !== expected.href) {
        await discard(response);
        corrupt(
          "The static database response came from an unexpected path or origin.",
        );
      }
    }
    if (response.status !== 200) {
      await discard(response);
      unavailable(
        `The hosted reference database returned HTTP ${response.status}. Check that the manifest and all binary shards are deployed, or use Install database from ZIP.`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !(
        manifest
          ? /^application\/json(?:\s*;|$)/i
          : /^application\/octet-stream(?:\s*;|$)/i
      ).test(contentType)
    ) {
      await discard(response);
      corrupt(
        "The hosted reference file has the wrong content type. An HTML app fallback is not database data. Check the static hosting configuration, or use Install database from ZIP.",
      );
    }
    return await boundedBody(response, size, controller.signal, progress);
  } catch (error) {
    checkSignal(signal);
    if (timedOut)
      unavailable(
        "The hosted reference database took too long to respond. Check your connection and retry.",
      );
    if (error instanceof LearnedStorageError) throw error;
    return unavailable(
      "Could not fetch the hosted reference database. Check your connection and the static hosting configuration, then retry or use Install database from ZIP.",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
async function releaseShards(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<LearnedPackShard[]> {
  checkSignal(signal);
  if (!globalThis.crypto?.subtle)
    unavailable(
      "Database verification needs a secure browser context (HTTPS or localhost).",
    );
  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  checkSignal(signal);
  if (checksum !== RELEASE.manifestSha256)
    corrupt(
      "The hosted manifest does not match the pinned Pokémon reference release. No binary shards were downloaded. Check the hosted reference files.",
    );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return corrupt("The hosted manifest is not valid UTF-8 JSON.");
  }
  const manifest = validateLearnedManifest(value);
  if (
    manifest.coverage.game !== "pokemon" ||
    manifest.records.length !== RELEASE.referenceCount ||
    manifest.coverage.names !== RELEASE.nameCount ||
    manifest.shards.length !== RELEASE.shardCount ||
    bytes.byteLength +
      manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0) !==
      RELEASE.referenceBytes ||
    manifest.shards.some(
      (shard) =>
        !SHARD_NAME.test(shard.file) ||
        !Number.isSafeInteger(shard.bytes) ||
        shard.bytes <= 0 ||
        shard.bytes > LEARNED_MAX_SHARD_BYTES,
    )
  )
    corrupt(
      "The hosted manifest does not describe the exact pinned Pokémon database.",
    );
  return manifest.shards;
}
/** Explicit static install only. No request occurs on module load, no caller URL
 * is accepted, and an error never falls back to the local relay. The importer
 * owns shard hashes, sequential durable writes, rollback, and final readiness.
 * We retain only the bounded manifest and the one currently requested shard.
 */
export async function installStaticPokemonDatabase(
  options: StaticPokemonInstallOptions = {},
): Promise<LearnedPackMetadata> {
  checkSignal(options.signal);
  const directory = referenceDirectory(),
    targetId = `learned:${RELEASE.manifestSha256}`,
    existing = (await listLearnedPacks()).find((pack) => pack.id === targetId);
  checkSignal(options.signal);
  if (existing?.readiness === "importing")
    throw new LearnedStorageError(
      "conflict",
      "This database is already being imported. Let that import finish or cancel it before trying again.",
    );
  if (existing?.readiness !== "ready") {
    const estimate = await globalThis.navigator?.storage
      ?.estimate?.()
      .catch(() => undefined);
    checkSignal(options.signal);
    if (
      estimate?.quota !== undefined &&
      estimate.quota - (estimate.usage ?? 0) <
        Math.ceil(RELEASE.referenceBytes * 1.2)
    )
      throw new LearnedStorageError(
        "quota",
        "Not enough browser storage for this database, including import overhead. Free space or remove an old reference pack before downloading it.",
      );
  }
  let downloadedBytes = 0,
    active = false,
    nextShard = 0;
  const report = (state: PokemonReferenceDownloadStatus["state"]) => {
    options.onDownloadProgress?.({
      state,
      downloadedBytes,
      totalBytes: RELEASE.referenceBytes,
    });
    checkSignal(options.signal);
  };
  const progress = (bytes: number) => {
    downloadedBytes += bytes;
    report("downloading");
  };
  try {
    report("downloading");
    const manifestBytes = await requestFile(
        `${directory}${MANIFEST}`,
        RELEASE.manifestBytes,
        true,
        options.signal,
        progress,
      ),
      shards = await releaseShards(manifestBytes, options.signal);
    checkSignal(options.signal);
    if (existing?.readiness === "corrupt")
      await removeCorruptLearnedPack(targetId);
    checkSignal(options.signal);
    const files: LearnedPackFile[] = [
      {
        name: MANIFEST,
        size: manifestBytes.byteLength,
        async arrayBuffer() {
          checkSignal(options.signal);
          return manifestBytes;
        },
      },
      ...shards.map((shard, index): LearnedPackFile => ({
        name: shard.file,
        size: shard.bytes,
        async arrayBuffer() {
          checkSignal(options.signal);
          if (active || index !== nextShard)
            corrupt("Static database shards must be read once, sequentially.");
          active = true;
          try {
            const bytes = await requestFile(
              `${directory}${shard.file}`,
              shard.bytes,
              false,
              options.signal,
              progress,
            );
            nextShard++;
            if (nextShard === shards.length) report("verifying");
            return bytes;
          } finally {
            active = false;
          }
        },
      })),
    ];
    const result = await importLearnedPack(files, {
      signal: options.signal,
      onProgress: options.onProgress,
      expectedManifestSha256: RELEASE.manifestSha256,
    });
    checkSignal(options.signal);
    if (
      result.readiness !== "ready" ||
      result.checksum !== RELEASE.manifestSha256 ||
      result.cards !== RELEASE.referenceCount ||
      result.names !== RELEASE.nameCount ||
      result.bytes !== RELEASE.referenceBytes
    )
      corrupt(
        "The installed database does not match the pinned Pokémon release.",
      );
    // Reusing an already verified installation may download only the manifest.
    // Never claim that existing local shard bytes were downloaded this time.
    report("ready");
    return result;
  } catch (error) {
    checkSignal(options.signal);
    throw error;
  }
}
