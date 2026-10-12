import type { ReferenceMetadata, VisionGame } from "./vision/types";
import { CARD_IMAGE_HOSTS } from "./provider-image-policy";
import { MAX_HASH_REFERENCES } from "./vision/hash";
import {
  LEARNED_ALGORITHM,
  LEARNED_DESCRIPTOR_DIMENSIONS,
  LEARNED_REFERENCE_POINTS,
  type LearnedIndexCard,
  type LearnedReferenceFeatures,
} from "./vision/learned-types";

/** A different database from the legacy ORB packs; safe in a dedicated Worker. */
export const LEARNED_DATABASE_NAME = "tcg-scan-learned-references";
export const LEARNED_PACK_FORMAT = "tcg-learned-reference-pack";
export const LEARNED_MODEL_ID =
  "xfeat-kornia-1296058905af4117b33e252336f4efa6c01b5beb";
export const LEARNED_PREPROCESS_ID = "opencv240x336-rgb255-bilinear224x320-v1";
export const LEARNED_SELECTION_ID = "spatial4x6-round-robin256-v1";
export const LEARNED_QUANTIZATION_ID = "maxabs127-f32-nearest-even-int8-v1";
export const LEARNED_MODEL_SHA256 =
  "86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0";
export const LEARNED_MODEL_DATA_SHA256 =
  "d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9";
export const LEARNED_RECORD_BYTES = 19_456;
export const LEARNED_SHARD_HEADER_BYTES = 32;
export const LEARNED_MAX_SHARD_RECORDS = 128;
export const LEARNED_MAX_SHARD_BYTES =
  LEARNED_SHARD_HEADER_BYTES + LEARNED_MAX_SHARD_RECORDS * LEARNED_RECORD_BYTES;
export const LEARNED_MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
/** Per-pack and aggregate per-game limit, shared with the bounded runtime. */
export const LEARNED_MAX_REFERENCES = MAX_HASH_REFERENCES;
export const LEARNED_REFERENCE_CACHE_SIZE = 8;
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
const MAGIC = "TCGLRN01";

type GameCounts = Record<VisionGame, number>;
export interface LearnedPackCoverage {
  scope: "selected" | "full-catalog" | "custom" | "fixture";
  game: VisionGame;
  extractedImages: number;
  names: number;
  catalogCards?: number;
  availableImages?: number;
  missingImages: number;
  failedImages: number;
  /** Advertised sources explicitly unavailable before any extraction attempt. */
  unavailableImages?: number;
  duplicateImages?: number;
  provider: string;
  note: string;
  catalogRetrievedAt?: string;
}
export interface LearnedPackRecord extends ReferenceMetadata {
  hash: string;
  differenceHash: string;
  shard: number;
  offset: number;
  sha256: string;
}
export interface LearnedPackShard {
  file: string;
  bytes: number;
  count: number;
  sha256: string;
}
export interface LearnedPackManifest {
  format: typeof LEARNED_PACK_FORMAT;
  version: 1;
  algorithm: typeof LEARNED_ALGORITHM;
  model: {
    id: typeof LEARNED_MODEL_ID;
    sha256: typeof LEARNED_MODEL_SHA256;
    dataSha256: typeof LEARNED_MODEL_DATA_SHA256;
  };
  preprocess: typeof LEARNED_PREPROCESS_ID;
  selection: typeof LEARNED_SELECTION_ID;
  quantization: typeof LEARNED_QUANTIZATION_ID;
  width: 240;
  height: 336;
  points: 256;
  dimensions: 64;
  recordBytes: typeof LEARNED_RECORD_BYTES;
  name: string;
  createdAt: string;
  coverage: LearnedPackCoverage;
  shards: LearnedPackShard[];
  records: LearnedPackRecord[];
}
export interface LearnedPackMetadata {
  id: string;
  name: string;
  algorithm: typeof LEARNED_ALGORITHM;
  cards: number;
  names: number;
  byGame: GameCounts;
  byGameNames: GameCounts;
  bytes: number;
  checksum: string;
  installedAt: string;
  createdAt: string;
  coverage: LearnedPackCoverage;
  readiness: "importing" | "ready" | "corrupt";
  error?: string;
}
export interface LearnedImportProgress {
  phase: "validating" | "importing" | "complete";
  completed: number;
  total: number;
  text: string;
}
export type LearnedPackFile = Blob & { readonly name: string };
export class LearnedStorageError extends Error {
  constructor(
    public code:
      | "invalid"
      | "unavailable"
      | "quota"
      | "corrupt"
      | "conflict"
      | "aborted"
      | "missing",
    message: string,
  ) {
    super(message);
    this.name = "LearnedStorageError";
  }
}
interface StoredPack extends LearnedPackMetadata {
  token: string;
  metadataChecksum: string;
}
interface StoredIndex {
  featureId: string;
  packId: string;
  key: string;
  game: VisionGame;
  card: LearnedIndexCard;
  checksum: string;
  recordChecksum: string;
}
interface StoredRecord {
  featureId: string;
  packId: string;
  key: string;
  checksum: string;
  payload: ArrayBuffer;
}
const referenceCache = new Map<
  string,
  { token: string; features: LearnedReferenceFeatures }
>();
let loadQueue: Promise<unknown> = Promise.resolve();
let cacheFactory: IDBFactory | undefined;

function fail(message: string): never {
  throw new LearnedStorageError("invalid", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Expected a learned-pack object.");
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    fail("Unrecognized learned-pack field.");
}
function string(value: unknown, label: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    fail(`Invalid ${label}.`);
  return value;
}
function count(value: unknown, label: string, max = 10_000_000): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    fail(`Invalid ${label}.`);
  return value;
}
function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("Invalid SHA-256 checksum.");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value))
    fail("Invalid perceptual hash.");
  return value;
}
function date(value: unknown): string {
  const result = string(value, "date", 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    fail("Invalid date.");
  return result;
}
function providerUrl(
  value: unknown,
  image: boolean,
  game: VisionGame,
): string | undefined {
  if (value === undefined) return undefined;
  const raw = string(value, "provider URL", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("Invalid provider URL.");
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
    fail("Only known HTTPS card-provider URLs are allowed.");
  return url.href;
}
function metadata(row: Record<string, unknown>): ReferenceMetadata {
  if (!GAMES.includes(row.game as VisionGame)) fail("Unknown card game.");
  if (row.game === "yugioh" && row.imageUrl !== undefined)
    fail("YGO artwork must remain local, never browser-hotlinked.");
  const result: ReferenceMetadata = {
    key: string(row.key, "reference key", 300),
    game: row.game as VisionGame,
    name: string(row.name, "card name"),
  };
  if (!result.key.startsWith(`${result.game}:`))
    fail("Reference key must be namespaced by game.");
  for (const field of [
    "identityKey",
    "artworkKey",
    "setName",
    "number",
  ] as const) {
    if (row[field] !== undefined)
      result[field] = string(
        row[field],
        field,
        field === "number" ? 100 : field === "setName" ? 500 : 300,
      );
  }
  const imageUrl = providerUrl(row.imageUrl, true, result.game),
    sourceUrl = providerUrl(row.sourceUrl, false, result.game);
  if (imageUrl !== undefined) result.imageUrl = imageUrl;
  if (sourceUrl !== undefined) result.sourceUrl = sourceUrl;
  return result;
}
const METADATA_FIELDS = [
  "key",
  "game",
  "name",
  "identityKey",
  "artworkKey",
  "setName",
  "number",
  "imageUrl",
  "sourceUrl",
];
/** Shared strict metadata validation for the offline builder and binary-pack importer. */
export function validateLearnedReferenceMetadata(
  value: unknown,
): ReferenceMetadata {
  const row = object(value);
  keys(row, METADATA_FIELDS);
  return metadata(row);
}
function validateCoverage(value: unknown): LearnedPackCoverage {
  const row = object(value);
  keys(row, [
    "scope",
    "game",
    "extractedImages",
    "names",
    "catalogCards",
    "availableImages",
    "missingImages",
    "failedImages",
    "unavailableImages",
    "duplicateImages",
    "provider",
    "note",
    "catalogRetrievedAt",
  ]);
  if (
    !["selected", "full-catalog", "custom", "fixture"].includes(
      row.scope as string,
    ) ||
    !GAMES.includes(row.game as VisionGame)
  )
    fail("Invalid learned-pack coverage.");
  const result: LearnedPackCoverage = {
    scope: row.scope as LearnedPackCoverage["scope"],
    game: row.game as VisionGame,
    extractedImages: count(
      row.extractedImages,
      "coverage count",
      LEARNED_MAX_REFERENCES,
    ),
    names: count(row.names, "name count", LEARNED_MAX_REFERENCES),
    missingImages: count(row.missingImages, "missing images"),
    failedImages: count(row.failedImages, "failed images"),
    provider: string(row.provider, "provider", 300),
    note: string(row.note, "coverage note", 2000),
  };
  for (const field of [
    "catalogCards",
    "availableImages",
    "unavailableImages",
    "duplicateImages",
  ] as const)
    if (row[field] !== undefined) result[field] = count(row[field], field);
  if (row.catalogRetrievedAt !== undefined)
    result.catalogRetrievedAt = date(row.catalogRetrievedAt);
  if (
    (result.catalogCards !== undefined &&
      result.catalogCards < result.extractedImages) ||
    (result.availableImages !== undefined &&
      result.availableImages < result.extractedImages)
  )
    fail("Coverage understates installed references.");
  if (
    result.scope === "full-catalog" &&
    (result.availableImages === undefined ||
      result.catalogCards === undefined ||
      result.availableImages !==
        result.extractedImages +
          result.failedImages +
          (result.unavailableImages ?? 0) +
          (result.duplicateImages ?? 0))
  )
    fail("Full-catalog coverage must account for every available image.");
  return result;
}
/** This validator never executes, fetches, or decodes image content. */
export function validateLearnedManifest(value: unknown): LearnedPackManifest {
  const row = object(value);
  keys(row, [
    "format",
    "version",
    "algorithm",
    "model",
    "preprocess",
    "selection",
    "quantization",
    "width",
    "height",
    "points",
    "dimensions",
    "recordBytes",
    "name",
    "createdAt",
    "coverage",
    "shards",
    "records",
  ]);
  if (
    row.format !== LEARNED_PACK_FORMAT ||
    row.version !== 1 ||
    row.algorithm !== LEARNED_ALGORITHM ||
    row.preprocess !== LEARNED_PREPROCESS_ID ||
    row.selection !== LEARNED_SELECTION_ID ||
    row.quantization !== LEARNED_QUANTIZATION_ID ||
    row.width !== 240 ||
    row.height !== 336 ||
    row.points !== LEARNED_REFERENCE_POINTS ||
    row.dimensions !== LEARNED_DESCRIPTOR_DIMENSIONS ||
    row.recordBytes !== LEARNED_RECORD_BYTES
  )
    fail("Unsupported learned-pack version, model, or preprocessing contract.");
  const model = object(row.model);
  keys(model, ["id", "sha256", "dataSha256"]);
  if (
    model.id !== LEARNED_MODEL_ID ||
    model.sha256 !== LEARNED_MODEL_SHA256 ||
    model.dataSha256 !== LEARNED_MODEL_DATA_SHA256
  )
    fail("Learned-pack model identity does not match the frozen model.");
  if (
    !Array.isArray(row.records) ||
    !row.records.length ||
    row.records.length > LEARNED_MAX_REFERENCES ||
    !Array.isArray(row.shards) ||
    !row.shards.length ||
    row.shards.length > LEARNED_MAX_REFERENCES
  )
    fail("Invalid learned-pack record or shard count.");
  const filenames = new Set<string>();
  const shards = row.shards.map((value): LearnedPackShard => {
    const item = object(value);
    keys(item, ["file", "bytes", "count", "sha256"]);
    const file = string(item.file, "shard filename", 100),
      n = count(item.count, "shard records", LEARNED_MAX_SHARD_RECORDS);
    if (
      !/^features-[0-9]{5}\.bin$/.test(file) ||
      filenames.has(file) ||
      !n ||
      item.bytes !== LEARNED_SHARD_HEADER_BYTES + n * LEARNED_RECORD_BYTES
    )
      fail("Invalid, duplicate, or oversized binary shard.");
    filenames.add(file);
    return {
      file,
      bytes: item.bytes as number,
      count: n,
      sha256: checksum(item.sha256),
    };
  });
  const coverage = validateCoverage(row.coverage),
    names = new Set<string>(),
    recordKeys = new Set<string>(),
    positions = shards.map(() => 0);
  const records = row.records.map((value): LearnedPackRecord => {
    const item = object(value);
    keys(item, [
      ...METADATA_FIELDS,
      "hash",
      "differenceHash",
      "shard",
      "offset",
      "sha256",
    ]);
    const card = metadata(item),
      shard = count(item.shard, "shard index", shards.length - 1),
      offset = count(item.offset, "record offset", LEARNED_MAX_SHARD_BYTES);
    if (card.game !== coverage.game || recordKeys.has(card.key))
      fail("Duplicate reference key or conflicting coverage game.");
    if (
      offset !==
        LEARNED_SHARD_HEADER_BYTES + positions[shard] * LEARNED_RECORD_BYTES ||
      positions[shard] >= shards[shard].count
    )
      fail(
        "Record offsets must be contiguous, unique, and within their shard.",
      );
    positions[shard]++;
    recordKeys.add(card.key);
    names.add(
      card.identityKey ??
        `${card.game}:${card.name.toLocaleLowerCase("en-US")}`,
    );
    return {
      ...card,
      hash: hash(item.hash),
      differenceHash: hash(item.differenceHash),
      shard,
      offset,
      sha256: checksum(item.sha256),
    };
  });
  if (
    positions.some((n, i) => n !== shards[i].count) ||
    coverage.extractedImages !== records.length ||
    coverage.names !== names.size
  )
    fail("Learned-pack coverage, names, or shard counts disagree.");
  return {
    format: LEARNED_PACK_FORMAT,
    version: 1,
    algorithm: LEARNED_ALGORITHM,
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
    name: string(row.name, "pack name", 200),
    createdAt: date(row.createdAt),
    coverage,
    shards,
    records,
  };
}
export function validateLearnedShardHeader(
  buffer: ArrayBuffer,
  shard: LearnedPackShard,
  index: number,
): void {
  if (
    buffer.byteLength !== shard.bytes ||
    buffer.byteLength > LEARNED_MAX_SHARD_BYTES
  )
    fail("Binary shard size mismatch.");
  const view = new DataView(buffer);
  if (
    String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== MAGIC ||
    view.getUint32(8, true) !== 1 ||
    view.getUint32(12, true) !== LEARNED_RECORD_BYTES ||
    view.getUint32(16, true) !== shard.count ||
    view.getUint32(20, true) !== index ||
    view.getUint32(24, true) !== 0 ||
    view.getUint32(28, true) !== 0
  )
    fail("Invalid binary shard header or endianness.");
}
export function decodeLearnedRecord(
  key: string,
  payload: ArrayBuffer,
): LearnedReferenceFeatures {
  if (payload.byteLength !== LEARNED_RECORD_BYTES)
    fail("Invalid learned record size.");
  const view = new DataView(payload),
    points = new Float32Array(512),
    scales = new Float32Array(256),
    descriptors = new Int8Array(16384);
  for (let i = 0; i < points.length; i++) {
    const n = view.getFloat32(i * 4, true);
    if (!Number.isFinite(n) || n < 0 || n >= (i % 2 ? 336 : 240))
      fail("Learned point is outside the canonical card.");
    points[i] = n;
  }
  for (let i = 0; i < 256; i++) {
    const scale = view.getFloat32(2048 + i * 4, true);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1 / 127 + 1e-9)
      fail("Invalid learned descriptor scale.");
    scales[i] = scale;
    let maximum = 0;
    for (let j = 0; j < 64; j++) {
      const n = view.getInt8(3072 + i * 64 + j);
      if (n === -128) fail("Learned descriptors cannot contain -128.");
      descriptors[i * 64 + j] = n;
      maximum = Math.max(maximum, Math.abs(n));
    }
    if (maximum !== 127)
      fail("Descriptor is not per-vector maxabs127 quantized.");
  }
  return { key, points, scales, descriptors };
}
async function digest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new LearnedStorageError(
      "unavailable",
      "Secure-context cryptography is required to verify learned packs.",
    );
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function jsonBytes(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}
function storageError(error: unknown): LearnedStorageError {
  if (error instanceof LearnedStorageError) return error;
  if (error instanceof Error && error.name === "QuotaExceededError")
    return new LearnedStorageError(
      "quota",
      "Not enough browser storage for this learned pack. Free space or remove an old pack, then retry.",
    );
  if (error instanceof Error && error.name === "ConstraintError")
    return new LearnedStorageError(
      "conflict",
      "This pack overlaps an installed or incomplete learned pack. Remove the old pack before importing its replacement.",
    );
  return new LearnedStorageError(
    "unavailable",
    `Learned reference storage is unavailable. ${error instanceof Error ? error.message : ""}`.trim(),
  );
}
function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB)
    return Promise.reject(
      new LearnedStorageError(
        "unavailable",
        "IndexedDB is unavailable; learned references cannot be stored locally.",
      ),
    );
  if (cacheFactory !== indexedDB) {
    referenceCache.clear();
    cacheFactory = indexedDB;
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEARNED_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("packs", { keyPath: "id" });
      const index = db.createObjectStore("index", { keyPath: "key" });
      index.createIndex("featureId", "featureId", { unique: true });
      index.createIndex("packId", "packId");
      index.createIndex("game", "game");
      const records = db.createObjectStore("records", { keyPath: "featureId" });
      records.createIndex("packId", "packId");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () =>
      reject(
        new LearnedStorageError(
          "unavailable",
          "Learned storage upgrade is blocked by another open app tab. Close it and retry.",
        ),
      );
  });
}
function read<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly"),
      request = tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result as T | undefined);
    tx.onabort = tx.onerror = () =>
      reject(storageError(tx.error ?? request.error));
  });
}
function write(
  db: IDBDatabase,
  stores: string[],
  perform: (tx: IDBTransaction, abort: (error: Error) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let reason: Error | undefined;
    const tx = db.transaction(stores, "readwrite");
    const abort = (error: Error) => {
      reason = error;
      tx.abort();
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(storageError(reason ?? tx.error));
    tx.onerror = (event) => {
      const target = event.target as IDBRequest | null;
      reason ??= storageError(target?.error ?? tx.error);
    };
    try {
      perform(tx, abort);
    } catch (error) {
      abort(storageError(error));
    }
  });
}
function invalidate(id: string): void {
  for (const key of referenceCache.keys())
    if (key.startsWith(`${id}/`)) referenceCache.delete(key);
}
function publicMetadata(pack: StoredPack): LearnedPackMetadata {
  const { token, metadataChecksum, ...result } = pack;
  void token;
  void metadataChecksum;
  return result;
}
function stablePackMetadata(
  pack: StoredPack,
): Omit<LearnedPackMetadata, "readiness" | "error"> {
  const { readiness, error, ...metadata } = publicMetadata(pack);
  void readiness;
  void error;
  return metadata;
}
async function verifyStoredPack(
  db: IDBDatabase,
  pack: StoredPack,
): Promise<void> {
  if (
    (await digest(jsonBytes(stablePackMetadata(pack)))) !==
      pack.metadataChecksum ||
    pack.id !== `learned:${pack.checksum}` ||
    pack.algorithm !== LEARNED_ALGORITHM
  ) {
    const message =
      "Learned pack metadata is damaged; remove and reimport the pack.";
    await markCorrupt(db, pack.id, message);
    throw new LearnedStorageError("corrupt", message);
  }
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new LearnedStorageError(
      "aborted",
      "Learned-pack import was cancelled. No partial pack is ready.",
    );
}
async function deletePack(
  db: IDBDatabase,
  id: string,
  token?: string,
): Promise<void> {
  await write(db, ["packs", "index", "records"], (tx) => {
    const packs = tx.objectStore("packs"),
      request = packs.get(id);
    request.onsuccess = () => {
      if (
        !request.result ||
        (token !== undefined && request.result.token !== token)
      )
        return;
      packs.delete(id);
      for (const name of ["index", "records"]) {
        const cursor = tx
          .objectStore(name)
          .index("packId")
          .openKeyCursor(IDBKeyRange.only(id));
        cursor.onsuccess = () => {
          if (cursor.result) {
            tx.objectStore(name).delete(cursor.result.primaryKey);
            cursor.result.continue();
          }
        };
      }
    };
  });
  invalidate(id);
}
async function markCorrupt(
  db: IDBDatabase,
  id: string,
  message: string,
): Promise<void> {
  invalidate(id);
  await write(db, ["packs"], (tx) => {
    const store = tx.objectStore("packs"),
      request = store.get(id);
    request.onsuccess = () => {
      if (request.result)
        store.put({ ...request.result, readiness: "corrupt", error: message });
    };
  });
}
/** All files are supplied by the user. This function contains no network calls. */
export async function importLearnedPack(
  files: readonly LearnedPackFile[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: LearnedImportProgress) => void;
  } = {},
): Promise<LearnedPackMetadata> {
  checkSignal(options.signal);
  if (!files.length || files.length > LEARNED_MAX_REFERENCES + 1)
    fail("Select one .learned.json manifest and all its binary shards.");
  const manifests = files.filter((file) => file.name.endsWith(".learned.json"));
  if (manifests.length !== 1)
    fail("Select exactly one .learned.json manifest and its binary shards.");
  const file = manifests[0];
  if (!file.size || file.size > LEARNED_MAX_MANIFEST_BYTES)
    fail("Learned manifest exceeds the 64 MiB limit.");
  options.onProgress?.({
    phase: "validating",
    completed: 0,
    total: 0,
    text: "Checking the learned pack and local storage…",
  });
  const manifestBytes = await file.arrayBuffer();
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
  } catch {
    return fail("This is not a valid UTF-8 learned manifest.");
  }
  const manifest = validateLearnedManifest(value),
    manifestChecksum = await digest(manifestBytes),
    id = `learned:${manifestChecksum}`;
  const supplied = new Map<string, LearnedPackFile>();
  for (const input of files) {
    if (supplied.has(input.name)) fail("Duplicate import filename.");
    supplied.set(input.name, input);
  }
  if (files.length !== manifest.shards.length + 1)
    fail(
      "Select exactly the manifest and all its declared shards, without extra files.",
    );
  for (const shard of manifest.shards)
    if (
      !supplied.has(shard.file) ||
      supplied.get(shard.file)!.size !== shard.bytes
    )
      fail(`Missing or wrong-size binary shard: ${shard.file}.`);
  const db = await openDatabase();
  let token: string | undefined;
  try {
    const old = await read<StoredPack>(db, "packs", id);
    if (old?.readiness === "ready") {
      await verifyStoredPack(db, old);
      return publicMetadata(old);
    }
    if (old)
      throw new LearnedStorageError(
        "conflict",
        "This learned pack is incomplete or damaged. Remove it, then import it again.",
      );
    const bytes =
      file.size + manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0);
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (
      estimate?.quota !== undefined &&
      estimate.quota - (estimate.usage ?? 0) < Math.ceil(bytes * 1.2)
    )
      throw new LearnedStorageError(
        "quota",
        "Not enough browser storage for this learned pack, including import overhead. Remove an old pack or free space, then retry.",
      );
    checkSignal(options.signal);
    const byGame: GameCounts = { pokemon: 0, mtg: 0, yugioh: 0 },
      byGameNames: GameCounts = { pokemon: 0, mtg: 0, yugioh: 0 };
    byGame[manifest.coverage.game] = manifest.records.length;
    byGameNames[manifest.coverage.game] = manifest.coverage.names;
    token = crypto.randomUUID();
    const pack: StoredPack = {
      id,
      name: manifest.name,
      algorithm: LEARNED_ALGORITHM,
      cards: manifest.records.length,
      names: manifest.coverage.names,
      byGame,
      byGameNames,
      bytes,
      checksum: manifestChecksum,
      installedAt: new Date().toISOString(),
      createdAt: manifest.createdAt,
      coverage: manifest.coverage,
      readiness: "importing",
      token,
      metadataChecksum: "",
    };
    pack.metadataChecksum = await digest(jsonBytes(stablePackMetadata(pack)));
    const recordsByShard = manifest.shards.map(() => [] as LearnedPackRecord[]);
    for (const record of manifest.records)
      recordsByShard[record.shard].push(record);
    // Reserve the entire import before reading any descriptors. Read and add in
    // one write transaction so competing Workers/tabs cannot oversubscribe the
    // runtime. An interrupted import keeps its reservation until removed.
    await write(db, ["packs"], (tx, abort) => {
      const store = tx.objectStore("packs"),
        request = store.getAll();
      request.onsuccess = () => {
        try {
          checkSignal(options.signal);
          for (const game of GAMES) {
            if (!pack.byGame[game]) continue;
            let reserved = pack.byGame[game];
            for (const existing of request.result as StoredPack[]) {
              if (
                existing.readiness !== "ready" &&
                existing.readiness !== "importing"
              )
                continue;
              const cards = existing.byGame?.[game];
              if (!Number.isSafeInteger(cards) || cards < 0)
                throw new LearnedStorageError(
                  "corrupt",
                  "Stored learned-pack capacity metadata is damaged. Remove the damaged pack and retry.",
                );
              reserved += cards;
              if (reserved > LEARNED_MAX_REFERENCES)
                throw new LearnedStorageError(
                  "conflict",
                  `The ${game} learned reference limit is ${LEARNED_MAX_REFERENCES.toLocaleString("en-US")} cards, including imports in progress. Remove a ${game} pack before importing this one.`,
                );
            }
          }
          store.add(pack);
        } catch (error) {
          abort(storageError(error));
        }
      };
    });
    let completed = 0;
    for (
      let shardIndex = 0;
      shardIndex < manifest.shards.length;
      shardIndex++
    ) {
      checkSignal(options.signal);
      const shard = manifest.shards[shardIndex],
        buffer = await supplied.get(shard.file)!.arrayBuffer();
      if ((await digest(buffer)) !== shard.sha256)
        throw new LearnedStorageError(
          "corrupt",
          `Binary shard checksum failed: ${shard.file}. Nothing from this pack is ready.`,
        );
      validateLearnedShardHeader(buffer, shard, shardIndex);
      const entries: { index: StoredIndex; record: StoredRecord }[] = [];
      for (const source of recordsByShard[shardIndex]) {
        checkSignal(options.signal);
        const { shard: ignoredShard, offset, sha256, ...cardData } = source;
        void ignoredShard;
        const payload = buffer.slice(offset, offset + LEARNED_RECORD_BYTES);
        if ((await digest(payload)) !== sha256)
          throw new LearnedStorageError(
            "corrupt",
            `Learned record checksum failed: ${source.key}.`,
          );
        decodeLearnedRecord(source.key, payload);
        const featureId = `${id}/${source.shard}/${(offset - LEARNED_SHARD_HEADER_BYTES) / LEARNED_RECORD_BYTES}`,
          card: LearnedIndexCard = { ...cardData, featureId };
        entries.push({
          index: {
            featureId,
            packId: id,
            key: card.key,
            game: card.game,
            card,
            checksum: await digest(jsonBytes(card)),
            recordChecksum: sha256,
          },
          record: {
            featureId,
            packId: id,
            key: card.key,
            checksum: sha256,
            payload,
          },
        });
      }
      checkSignal(options.signal);
      await write(db, ["packs", "index", "records"], (tx, abort) => {
        const request = tx.objectStore("packs").get(id);
        request.onsuccess = () => {
          if (
            request.result?.token !== token ||
            request.result?.readiness !== "importing"
          )
            return abort(
              new LearnedStorageError(
                "aborted",
                "The pack was removed or replaced during import.",
              ),
            );
          try {
            for (const entry of entries) {
              tx.objectStore("index").add(entry.index);
              tx.objectStore("records").add(entry.record);
            }
          } catch (error) {
            abort(storageError(error));
          }
        };
      });
      completed += entries.length;
      options.onProgress?.({
        phase: "importing",
        completed,
        total: pack.cards,
        text: `Stored ${completed.toLocaleString()} of ${pack.cards.toLocaleString()} learned references locally…`,
      });
    }
    checkSignal(options.signal);
    await write(db, ["packs", "index", "records"], (tx, abort) => {
      const request = tx.objectStore("packs").get(id),
        indexCount = tx.objectStore("index").index("packId").count(id),
        recordCount = tx.objectStore("records").index("packId").count(id);
      recordCount.onsuccess = () => {
        if (
          request.result?.token !== token ||
          request.result?.readiness !== "importing" ||
          indexCount.result !== pack.cards ||
          recordCount.result !== pack.cards
        )
          return abort(
            new LearnedStorageError(
              "corrupt",
              "Incomplete learned import cannot be made ready.",
            ),
          );
        tx.objectStore("packs").put({ ...pack, readiness: "ready" });
      };
    });
    invalidate(id);
    options.onProgress?.({
      phase: "complete",
      completed: pack.cards,
      total: pack.cards,
      text: `${pack.cards.toLocaleString()} references covering ${pack.names.toLocaleString()} names are ready for local recognition.`,
    });
    return publicMetadata({ ...pack, readiness: "ready" });
  } catch (error) {
    if (token) {
      try {
        await deletePack(db, id, token);
      } catch {
        /* Interrupted cleanup stays importing, never ready. */
      }
    }
    throw storageError(error);
  } finally {
    db.close();
  }
}
export async function listLearnedPacks(): Promise<LearnedPackMetadata[]> {
  const db = await openDatabase();
  try {
    const packs = await new Promise<StoredPack[]>((resolve, reject) => {
      const tx = db.transaction("packs", "readonly"),
        request = tx.objectStore("packs").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
    const result: LearnedPackMetadata[] = [];
    for (const pack of packs) {
      try {
        await verifyStoredPack(db, pack);
        result.push(publicMetadata(pack));
      } catch (error) {
        const safeCounts: GameCounts = { pokemon: 0, mtg: 0, yugioh: 0 };
        result.push({
          ...publicMetadata(pack),
          name:
            typeof pack.name === "string"
              ? pack.name.slice(0, 200)
              : "Damaged learned pack",
          cards: 0,
          names: 0,
          bytes: 0,
          byGame: safeCounts,
          byGameNames: { ...safeCounts },
          readiness: "corrupt",
          error:
            error instanceof Error
              ? error.message
              : "Damaged learned pack metadata.",
        });
      }
    }
    return result.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  } finally {
    db.close();
  }
}
/** Loads only the small hash/ID/metadata table; never opens the records store. */
export async function loadLearnedIndex(
  game?: VisionGame,
): Promise<LearnedIndexCard[]> {
  if (game !== undefined && !GAMES.includes(game)) fail("Unknown card game.");
  const db = await openDatabase();
  try {
    const packs = await new Promise<StoredPack[]>((resolve, reject) => {
      const tx = db.transaction("packs", "readonly"),
        request = tx.objectStore("packs").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
    for (const pack of packs)
      if (pack.readiness === "ready") await verifyStoredPack(db, pack);
    const ready = new Map(
      packs
        .filter(
          (pack) =>
            pack.readiness === "ready" && (!game || pack.byGame[game] > 0),
        )
        .map((pack) => [pack.id, pack]),
    );
    // getAll is deliberately restricted to the small metadata-only store. It
    // avoids one asynchronous cursor round trip per card on full catalogs.
    const rows = await new Promise<StoredIndex[]>((resolve, reject) => {
      const tx = db.transaction("index", "readonly"),
        store = tx.objectStore("index");
      const request = game
        ? store.index("game").getAll(IDBKeyRange.only(game))
        : store.getAll();
      tx.oncomplete = () =>
        resolve(
          (request.result as StoredIndex[]).filter((row) =>
            ready.has(row.packId),
          ),
        );
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
    const result: LearnedIndexCard[] = [],
      counts = new Map<string, number>();
    for (const row of rows) {
      try {
        keys(object(row.card), [
          ...METADATA_FIELDS,
          "hash",
          "differenceHash",
          "featureId",
        ]);
        const card = {
          ...metadata(object(row.card)),
          hash: hash(row.card.hash),
          differenceHash: hash(row.card.differenceHash),
          featureId: row.card.featureId,
        };
        if (
          row.key !== card.key ||
          row.game !== card.game ||
          row.featureId !== card.featureId ||
          !card.featureId.startsWith(`${row.packId}/`) ||
          checksum(row.recordChecksum) !== row.recordChecksum ||
          (await digest(jsonBytes(card))) !== row.checksum
        )
          throw new Error("Stored index checksum or identity mismatch.");
        result.push(card);
        counts.set(row.packId, (counts.get(row.packId) ?? 0) + 1);
      } catch (error) {
        const message = `Learned index is damaged; remove and reimport the pack. ${error instanceof Error ? error.message : ""}`;
        await markCorrupt(db, row.packId, message);
        throw new LearnedStorageError("corrupt", message);
      }
    }
    for (const pack of ready.values())
      if ((counts.get(pack.id) ?? 0) !== pack.cards) {
        const message =
          "Learned index is incomplete; remove and reimport the pack.";
        await markCorrupt(db, pack.id, message);
        throw new LearnedStorageError("corrupt", message);
      }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  } finally {
    db.close();
  }
}
async function loadOneReference(
  featureId: string,
): Promise<LearnedReferenceFeatures> {
  const match = /^(learned:[a-f0-9]{64})\/[0-9]+\/[0-9]+$/.exec(featureId);
  if (!match) fail("Invalid local learned feature ID.");
  const packId = match[1],
    db = await openDatabase();
  try {
    // Even cache hits check durable readiness, including removals in another Worker/tab.
    const pack = await read<StoredPack>(db, "packs", packId);
    if (!pack || pack.readiness !== "ready") {
      invalidate(packId);
      throw new LearnedStorageError(
        pack?.readiness === "corrupt" ? "corrupt" : "missing",
        "The learned reference pack is unavailable, incomplete, or removed.",
      );
    }
    await verifyStoredPack(db, pack);
    const cached = referenceCache.get(featureId);
    if (cached?.token === pack.token) {
      referenceCache.delete(featureId);
      referenceCache.set(featureId, cached);
      return cached.features;
    }
    referenceCache.delete(featureId);
    try {
      const index = await new Promise<StoredIndex | undefined>(
        (resolve, reject) => {
          const tx = db.transaction("index", "readonly"),
            request = tx.objectStore("index").index("featureId").get(featureId);
          tx.oncomplete = () => resolve(request.result);
          tx.onabort = () => reject(storageError(tx.error));
        },
      );
      const row = await read<StoredRecord>(db, "records", featureId);
      if (
        !index ||
        index.featureId !== featureId ||
        index.packId !== packId ||
        (await digest(jsonBytes(index.card))) !== index.checksum ||
        !row ||
        row.featureId !== featureId ||
        row.packId !== packId ||
        row.key !== index.key ||
        row.checksum !== index.recordChecksum ||
        !(row.payload instanceof ArrayBuffer) ||
        row.payload.byteLength !== LEARNED_RECORD_BYTES ||
        (await digest(row.payload)) !== checksum(row.checksum)
      )
        throw new Error("Stored feature checksum or identity mismatch.");
      const result = decodeLearnedRecord(row.key, row.payload);
      // Recheck after asynchronous reads so deletion during a read cannot populate the cache.
      const current = await read<StoredPack>(db, "packs", packId);
      if (
        !current ||
        current.token !== pack.token ||
        current.readiness !== "ready"
      )
        throw new LearnedStorageError(
          "missing",
          "The learned pack changed while its reference was loading.",
        );
      referenceCache.set(featureId, { token: pack.token, features: result });
      while (referenceCache.size > LEARNED_REFERENCE_CACHE_SIZE)
        referenceCache.delete(referenceCache.keys().next().value!);
      return result;
    } catch (error) {
      if (error instanceof LearnedStorageError && error.code === "missing")
        throw error;
      const message = `Learned features are damaged; remove and reimport the pack. ${error instanceof Error ? error.message : ""}`;
      await markCorrupt(db, packId, message);
      throw new LearnedStorageError("corrupt", message);
    }
  } finally {
    db.close();
  }
}
/** Serialized disk reads and an eight-reference LRU bound decoded storage, even with concurrent callers. Treat returned typed arrays as read-only. */
export function loadLearnedReference(
  featureId: string,
): Promise<LearnedReferenceFeatures> {
  const result = loadQueue.then(() => loadOneReference(featureId));
  loadQueue = result.catch(() => undefined);
  return result;
}
export async function removeLearnedPack(id: string): Promise<void> {
  if (!/^learned:[a-f0-9]{64}$/.test(id)) fail("Invalid learned pack ID.");
  const db = await openDatabase();
  try {
    await deletePack(db, id);
  } finally {
    db.close();
  }
}
/** Diagnostics only: no private descriptors or metadata are exposed. */
export function learnedReferenceCacheStats(): {
  references: number;
  bytes: number;
  limit: number;
} {
  return {
    references: referenceCache.size,
    bytes: referenceCache.size * LEARNED_RECORD_BYTES,
    limit: LEARNED_REFERENCE_CACHE_SIZE,
  };
}
