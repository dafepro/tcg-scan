import type {
  FeaturePack,
  ReferenceFeatures,
  ReferenceInput,
  ReferenceMetadata,
  VisionGame,
} from "./vision/types";
import { CARD_IMAGE_HOSTS } from "./provider-image-policy";

/** Limits apply to each shard, not the complete game catalog. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_PACK_REFERENCES = 5_000;
export const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;
export const REFERENCE_DATABASE_NAME = "tcg-scan-visual-references";
const DATABASE_VERSION = 1;
const GAMES: VisionGame[] = ["pokemon", "mtg", "yugioh"];
const SOURCE_HOSTS = new Set([
  "api.tcgdex.net",
  "tcgdex.net",
  "www.tcgdex.net",
  "api.scryfall.com",
  "scryfall.com",
  "ygoprodeck.com",
  "www.ygoprodeck.com",
  "db.ygoprodeck.com",
]);

export interface PackCoverage {
  scope: "fixture" | "selected-sets" | "full-catalog" | "learned" | "custom";
  game?: VisionGame;
  sets?: string[];
  catalogCards?: number;
  availableImages?: number;
  extractedImages: number;
  missingImages: number;
  failedImages: number;
  excludedCards?: number;
  /** Image-bearing printing/face rows excluded by an explicit artwork identity. */
  duplicateImages?: number;
  catalogRetrievedAt?: string;
  provider?: string;
  note?: string;
  shard?: { index: number; total: number };
}
export type ReferenceFeaturePack = FeaturePack & { coverage?: PackCoverage };
export interface StoredPackMetadata {
  id: string;
  name: string;
  source?: string;
  origin: "imported" | "prebuilt" | "learned";
  cards: number;
  byGame: Record<VisionGame, number>;
  bytes: number;
  checksum: string;
  installedAt: string;
  createdAt?: string;
  coverage?: PackCoverage;
  readiness: "ready" | "corrupt";
  error?: string;
}
interface StoredPack extends StoredPackMetadata {
  pack: ReferenceFeaturePack;
}
export interface CachedReference extends ReferenceInput {
  features?: ReferenceFeatures;
  cachedAt: string;
  bytes: number;
}
export interface ReferenceStorageStatus {
  available: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  persistent: boolean;
  pressure: "normal" | "low-space" | "unknown";
  error?: string;
}
export interface PrebuiltPackEntry {
  id: string;
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  cards: number;
  game?: VisionGame;
  coverage?: PackCoverage;
}
export interface PrebuiltPackManifest {
  version: 1;
  packs: PrebuiltPackEntry[];
}
export class ReferenceStorageError extends Error {
  code: "unavailable" | "quota" | "corrupt" | "invalid";
  constructor(code: ReferenceStorageError["code"], message: string) {
    super(message);
    this.name = "ReferenceStorageError";
    this.code = code;
  }
}
function invalid(message: string): never {
  throw new ReferenceStorageError("invalid", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected an object.");
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("Unrecognized feature-pack field.");
}
function text(value: unknown, label: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((char) => {
      const n = char.charCodeAt(0);
      return n < 32 && n !== 9 && n !== 10 && n !== 13;
    })
  )
    invalid(`Invalid ${label}.`);
  return value;
}
function integer(value: unknown, label: string, max = 10_000_000): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    invalid(`Invalid ${label}.`);
  return value;
}
function optionalText(
  row: Record<string, unknown>,
  key: string,
  max?: number,
): string | undefined {
  return row[key] === undefined ? undefined : text(row[key], key, max);
}
function date(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, label, 40);
  if (!Number.isFinite(Date.parse(result))) invalid(`Invalid ${label}.`);
  return result;
}
function safeUrl(
  value: unknown,
  image: boolean,
  game: VisionGame,
): string | undefined {
  if (value === undefined) return undefined;
  const raw = text(value, "provider URL", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("Invalid provider URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(image
      ? CARD_IMAGE_HOSTS[game].includes(url.hostname)
      : SOURCE_HOSTS.has(url.hostname))
  )
    invalid("Only known HTTPS card-provider URLs are allowed.");
  return url.href;
}
export function validateReferenceMetadata(value: unknown): ReferenceMetadata {
  const row = object(value);
  onlyKeys(row, [
    "key",
    "game",
    "name",
    "identityKey",
    "artworkKey",
    "setName",
    "number",
    "imageUrl",
    "sourceUrl",
  ]);
  if (!GAMES.includes(row.game as VisionGame)) invalid("Unknown card game.");
  if (row.game === "yugioh" && row.imageUrl !== undefined)
    invalid("YGO artwork must be cached locally, never browser-hotlinked.");
  return {
    key: text(row.key, "reference key", 300),
    game: row.game as VisionGame,
    name: text(row.name, "card name"),
    identityKey: optionalText(row, "identityKey", 300),
    artworkKey: optionalText(row, "artworkKey", 300),
    setName: optionalText(row, "setName"),
    number: optionalText(row, "number", 100),
    imageUrl: safeUrl(row.imageUrl, true, row.game as VisionGame),
    sourceUrl: safeUrl(row.sourceUrl, false, row.game as VisionGame),
  };
}
function validateFeatures(value: unknown): ReferenceFeatures {
  const row = object(value);
  onlyKeys(row, ["key", "hash", "differenceHash", "points", "descriptors"]);
  const key = text(row.key, "feature key", 300);
  if (
    typeof row.hash !== "string" ||
    !/^[a-f0-9]{16}$/.test(row.hash) ||
    typeof row.differenceHash !== "string" ||
    !/^[a-f0-9]{16}$/.test(row.differenceHash)
  )
    invalid("Invalid perceptual hash.");
  if (
    !Array.isArray(row.points) ||
    row.points.length < 40 ||
    row.points.length > 1000 ||
    row.points.length % 2 !== 0
  )
    invalid("Invalid ORB points.");
  const points = row.points.map((n, i) => {
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < 0 ||
      n >= (i % 2 ? 336 : 240)
    )
      invalid("ORB point is outside the canonical card.");
    return n;
  });
  if (
    typeof row.descriptors !== "string" ||
    row.descriptors.length > 22000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      row.descriptors,
    )
  )
    invalid("Invalid base64 ORB descriptors.");
  const bytes =
    (row.descriptors.length * 3) / 4 -
    (row.descriptors.endsWith("==")
      ? 2
      : row.descriptors.endsWith("=")
        ? 1
        : 0);
  if (bytes !== (points.length / 2) * 32)
    invalid("ORB descriptor and point counts disagree.");
  return {
    key,
    hash: row.hash,
    differenceHash: row.differenceHash,
    points,
    descriptors: row.descriptors,
  };
}
function validateCoverage(value: unknown): PackCoverage | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  onlyKeys(row, [
    "scope",
    "game",
    "sets",
    "catalogCards",
    "availableImages",
    "extractedImages",
    "missingImages",
    "failedImages",
    "excludedCards",
    "duplicateImages",
    "catalogRetrievedAt",
    "provider",
    "note",
    "shard",
  ]);
  if (
    !["fixture", "selected-sets", "full-catalog", "learned", "custom"].includes(
      String(row.scope),
    )
  )
    invalid("Invalid pack coverage scope.");
  if (row.game !== undefined && !GAMES.includes(row.game as VisionGame))
    invalid("Invalid coverage game.");
  const result: PackCoverage = {
    scope: row.scope as PackCoverage["scope"],
    game: row.game as VisionGame | undefined,
    extractedImages: integer(row.extractedImages, "extracted image count"),
    missingImages: integer(row.missingImages, "missing image count"),
    failedImages: integer(row.failedImages, "failed image count"),
    catalogRetrievedAt: date(row.catalogRetrievedAt, "catalog retrieval date"),
    provider: optionalText(row, "provider"),
    note: optionalText(row, "note", 2000),
  };
  for (const key of [
    "catalogCards",
    "availableImages",
    "excludedCards",
    "duplicateImages",
  ] as const)
    if (row[key] !== undefined) result[key] = integer(row[key], key);
  if (row.sets !== undefined) {
    if (!Array.isArray(row.sets) || row.sets.length > 5000)
      invalid("Invalid set coverage.");
    result.sets = row.sets.map((item) => text(item, "set ID", 100));
  }
  if (row.shard !== undefined) {
    const shard = object(row.shard);
    onlyKeys(shard, ["index", "total"]);
    const index = integer(shard.index, "shard index"),
      total = integer(shard.total, "shard total");
    if (index < 1 || total < index) invalid("Invalid shard numbering.");
    result.shard = { index, total };
  }
  return result;
}
/** Copies whitelisted fields only. Feature packs cannot introduce executable URLs or HTML. */
export function validateFeaturePack(value: unknown): ReferenceFeaturePack {
  const row = object(value);
  onlyKeys(row, [
    "version",
    "algorithm",
    "width",
    "height",
    "name",
    "source",
    "createdAt",
    "cards",
    "features",
    "coverage",
  ]);
  if (
    row.version !== 1 ||
    row.algorithm !== "orb-phash-v1" ||
    row.width !== 240 ||
    row.height !== 336
  )
    invalid(
      "Unsupported pack version or preprocessing. Rebuild for orb-phash-v1 (240 × 336).",
    );
  if (
    !Array.isArray(row.cards) ||
    !row.cards.length ||
    row.cards.length > MAX_PACK_REFERENCES ||
    !Array.isArray(row.features) ||
    row.features.length !== row.cards.length
  )
    invalid(
      `A pack must contain 1–${MAX_PACK_REFERENCES} cards, each with features.`,
    );
  const cards = row.cards.map(validateReferenceMetadata);
  const features = row.features.map(validateFeatures);
  const cardKeys = new Set(cards.map((card) => card.key)),
    featureKeys = new Set(features.map((feature) => feature.key));
  if (
    cardKeys.size !== cards.length ||
    featureKeys.size !== features.length ||
    features.some((feature) => !cardKeys.has(feature.key))
  )
    invalid("Duplicate or mismatched reference keys.");
  const coverage = validateCoverage(row.coverage);
  if (coverage && coverage.extractedImages !== cards.length)
    invalid("Coverage count does not match this pack's references.");
  return {
    version: 1,
    algorithm: "orb-phash-v1",
    width: 240,
    height: 336,
    name: text(row.name, "pack name", 200),
    source: optionalText(row, "source", 1000),
    createdAt: date(row.createdAt, "creation date"),
    cards,
    features,
    coverage,
  };
}
function storageError(error: unknown): ReferenceStorageError {
  if (error instanceof ReferenceStorageError) return error;
  if (
    error instanceof Error &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  )
    return new ReferenceStorageError(
      "quota",
      "Reference storage is full. Remove a reference pack or free browser storage, then try again.",
    );
  return new ReferenceStorageError(
    "unavailable",
    error instanceof Error
      ? error.message
      : "Browser reference storage is unavailable.",
  );
}
async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    throw new ReferenceStorageError(
      "unavailable",
      "IndexedDB is unavailable. Reference packs cannot persist in this browser.",
    );
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REFERENCE_DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("packs"))
        db.createObjectStore("packs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("references"))
        db.createObjectStore("references", { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () =>
      reject(
        new ReferenceStorageError(
          "unavailable",
          "Reference storage is blocked by an older open tab. Close other tabs and retry.",
        ),
      );
  });
}
async function transaction<T>(
  store: "packs" | "references",
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(storageError(tx.error ?? request.error));
    };
  });
}
async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new ReferenceStorageError(
      "unavailable",
      "Secure-context cryptography is required to verify reference packs.",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function serialized(pack: ReferenceFeaturePack): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(pack));
}
export async function saveReferencePack(
  value: FeaturePack,
  origin: StoredPackMetadata["origin"] = "imported",
): Promise<StoredPackMetadata> {
  const pack = validateFeaturePack(value),
    bytes = serialized(pack);
  if (bytes.length > MAX_PACK_BYTES)
    invalid("Pack exceeds the 64 MiB per-file limit. Import smaller shards.");
  const checksum = await sha256(bytes),
    id = `sha256:${checksum}`;
  const byGame = { pokemon: 0, mtg: 0, yugioh: 0 };
  pack.cards.forEach((card) => byGame[card.game]++);
  const metadata: StoredPackMetadata = {
    id,
    name: pack.name,
    source: pack.source,
    origin,
    cards: pack.cards.length,
    byGame,
    bytes: bytes.length,
    checksum,
    installedAt: new Date().toISOString(),
    createdAt: pack.createdAt,
    coverage: pack.coverage,
    readiness: "ready",
  };
  try {
    await transaction("packs", "readwrite", (store) =>
      store.put({ ...metadata, pack }),
    );
  } catch (error) {
    throw storageError(error);
  }
  return metadata;
}
export async function importReferencePack(
  file: Blob,
): Promise<StoredPackMetadata> {
  if (file.size > MAX_PACK_BYTES)
    invalid("Pack exceeds the 64 MiB per-file limit. Import smaller shards.");
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    return invalid("This file is not a valid JSON feature pack.");
  }
  return saveReferencePack(validateFeaturePack(value), "imported");
}
export async function listReferencePacks(): Promise<StoredPackMetadata[]> {
  const db = await openDatabase();
  // A full game can span hundreds of megabytes. Cursor iteration avoids cloning
  // every pack into one getAll() result just to render its small metadata list.
  return new Promise((resolve, reject) => {
    const tx = db.transaction("packs", "readonly");
    const request = tx.objectStore("packs").openCursor();
    const metadata: StoredPackMetadata[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const { pack, ...item } = cursor.value as StoredPack;
      try {
        validateFeaturePack(pack);
        metadata.push(item);
      } catch (error) {
        metadata.push({
          ...item,
          readiness: "corrupt",
          error: error instanceof Error ? error.message : "Corrupt pack",
        });
      }
      cursor.continue();
    };
    tx.oncomplete = () => {
      db.close();
      resolve(metadata.sort((a, b) => a.name.localeCompare(b.name)));
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(storageError(tx.error ?? request.error));
    };
  });
}
export async function loadReferencePack(
  id: string,
): Promise<ReferenceFeaturePack | undefined> {
  const value = await transaction<StoredPack | undefined>(
    "packs",
    "readonly",
    (store) => store.get(id),
  );
  if (!value) return undefined;
  try {
    const pack = validateFeaturePack(value.pack);
    if ((await sha256(serialized(pack))) !== value.checksum)
      throw new Error("Stored checksum does not match.");
    return pack;
  } catch (error) {
    throw new ReferenceStorageError(
      "corrupt",
      `Reference pack is damaged; remove it and import again. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
export async function removeReferencePack(id: string): Promise<void> {
  await transaction("packs", "readwrite", (store) => store.delete(id));
}
export async function cacheReferenceImage(
  metadata: ReferenceMetadata,
  image: Blob,
  features?: ReferenceFeatures,
): Promise<void> {
  const card = validateReferenceMetadata(metadata);
  if (
    !(image instanceof Blob) ||
    image.size === 0 ||
    image.size > MAX_REFERENCE_IMAGE_BYTES ||
    !["image/png", "image/jpeg", "image/webp"].includes(image.type)
  )
    invalid("Reference images must be PNG, JPEG, or WebP, at most 12 MiB.");
  const feature = features ? validateFeatures(features) : undefined;
  if (feature && feature.key !== card.key)
    invalid("Cached feature key does not match its card.");
  const value: CachedReference = {
    ...card,
    image,
    features: feature,
    bytes: image.size,
    cachedAt: new Date().toISOString(),
  };
  await transaction("references", "readwrite", (store) => store.put(value));
}
export async function listCachedReferenceImages(): Promise<CachedReference[]> {
  const values = await transaction<CachedReference[]>(
    "references",
    "readonly",
    (store) => store.getAll(),
  );
  for (const value of values) {
    const { image, features, bytes, cachedAt, ...metadata } = value;
    try {
      validateReferenceMetadata(metadata);
      if (
        !(image instanceof Blob) ||
        image.size !== bytes ||
        image.size === 0 ||
        image.size > MAX_REFERENCE_IMAGE_BYTES ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.type) ||
        !Number.isFinite(Date.parse(cachedAt))
      )
        throw new Error("Invalid cached image.");
      if (features && validateFeatures(features).key !== value.key)
        throw new Error("Feature key mismatch.");
    } catch {
      throw new ReferenceStorageError(
        "corrupt",
        "A learned reference is damaged. Clear learned references and scan it again.",
      );
    }
  }
  return values;
}
export async function removeCachedReference(key: string): Promise<void> {
  await transaction("references", "readwrite", (store) => store.delete(key));
}
export async function clearCachedReferences(): Promise<void> {
  await transaction("references", "readwrite", (store) => store.clear());
}
export async function getReferenceStorageStatus(): Promise<ReferenceStorageStatus> {
  try {
    const db = await openDatabase();
    db.close();
    const storage =
      typeof navigator === "undefined" ? undefined : navigator.storage;
    const estimate = await storage?.estimate?.();
    const persistent = (await storage?.persisted?.()) ?? false;
    return {
      available: true,
      usageBytes: estimate?.usage,
      quotaBytes: estimate?.quota,
      persistent,
      pressure: estimate?.quota
        ? (estimate.usage ?? 0) / estimate.quota > 0.85
          ? "low-space"
          : "normal"
        : "unknown",
    };
  } catch (error) {
    return {
      available: false,
      persistent: false,
      pressure: "unknown",
      error: storageError(error).message,
    };
  }
}
function packUrl(file: string): string {
  if (
    !/^\/packs\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(file) ||
    file.includes("..")
  )
    invalid("Prebuilt packs must use a same-origin /packs/ JSON path.");
  return file;
}
export function validatePrebuiltManifest(value: unknown): PrebuiltPackManifest {
  const row = object(value);
  onlyKeys(row, ["version", "packs"]);
  if (row.version !== 1 || !Array.isArray(row.packs) || row.packs.length > 5000)
    invalid("Invalid prebuilt pack manifest.");
  const ids = new Set<string>();
  const packs = row.packs.map((value) => {
    const item = object(value);
    onlyKeys(item, [
      "id",
      "name",
      "file",
      "sha256",
      "bytes",
      "cards",
      "game",
      "coverage",
    ]);
    const id = text(item.id, "pack ID", 300);
    if (ids.has(id)) invalid("Duplicate prebuilt pack ID.");
    ids.add(id);
    if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
      invalid("Invalid prebuilt checksum.");
    if (item.game !== undefined && !GAMES.includes(item.game as VisionGame))
      invalid("Invalid prebuilt game.");
    const cards = integer(item.cards, "pack references", MAX_PACK_REFERENCES),
      bytes = integer(item.bytes, "pack bytes", MAX_PACK_BYTES);
    if (!cards || !bytes) invalid("Prebuilt packs must be nonempty.");
    const coverage = validateCoverage(item.coverage);
    if (coverage && coverage.extractedImages !== cards)
      invalid("Manifest coverage count mismatch.");
    return {
      id,
      name: text(item.name, "pack name", 200),
      file: packUrl(text(item.file, "pack path")),
      sha256: item.sha256,
      bytes,
      cards,
      game: item.game as VisionGame | undefined,
      coverage,
    };
  });
  return { version: 1, packs };
}
async function boundedFetch(
  url: string,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal,
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Reference pack download failed (${response.status}).`);
  if (Number(response.headers.get("Content-Length")) > max)
    invalid("Reference pack download exceeds the size limit.");
  if (!response.body) invalid("Reference pack download has no body.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max)
        invalid("Reference pack download exceeds the size limit.");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}
export async function loadPrebuiltPackManifest(
  signal?: AbortSignal,
): Promise<PrebuiltPackManifest> {
  const bytes = await boundedFetch(
    "/packs/manifest.json",
    2 * 1024 * 1024,
    signal,
  );
  return validatePrebuiltManifest(JSON.parse(new TextDecoder().decode(bytes)));
}
export async function installPrebuiltPack(
  value: PrebuiltPackEntry,
  signal?: AbortSignal,
): Promise<StoredPackMetadata> {
  const entry = validatePrebuiltManifest({ version: 1, packs: [value] })
    .packs[0];
  const bytes = await boundedFetch(
    entry.file,
    Math.min(entry.bytes, MAX_PACK_BYTES),
    signal,
  );
  if (bytes.length !== entry.bytes || (await sha256(bytes)) !== entry.sha256)
    throw new ReferenceStorageError(
      "corrupt",
      "Prebuilt pack checksum or size mismatch. Nothing was installed.",
    );
  const pack = validateFeaturePack(JSON.parse(new TextDecoder().decode(bytes)));
  if (
    pack.cards.length !== entry.cards ||
    (entry.game && pack.cards.some((card) => card.game !== entry.game))
  )
    invalid("Prebuilt pack metadata does not match its manifest.");
  return saveReferencePack(pack, "prebuilt");
}
