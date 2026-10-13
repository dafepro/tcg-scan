import { catalogProvenance } from "./printing-evidence";
import type { PrintingCatalogProvenance } from "./printing-evidence";
import type { PrintingCandidate } from "./printing-refinement";
import type { ReferenceMetadata, VisionGame } from "./vision/types";

/** Metadata only: no photographs, artwork requests, prices, or finish inference. */
export interface PrintingCatalogSnapshot {
  provenance?: PrintingCatalogProvenance;
  candidates: PrintingCandidate[];
  /** Complete only within `scope`, never all physical editions/finishes/languages. */
  catalogCompleteForIdentity: boolean;
  scope: string;
  provider: string;
  locale: "en";
  lookupKey: string;
  referenceKey: string;
  fetchedAt?: string;
  stale: boolean;
  error?: string;
}
export interface PrintingCatalogCacheEntry {
  version: 1;
  key: string;
  fetchedAt: number;
  expiresAt: number;
  payload: unknown;
}
/** put must be atomic: a quota failure must not remove the last good entry. */
export interface PrintingCatalogCache {
  get(key: string): Promise<unknown>;
  put(entry: PrintingCatalogCacheEntry): Promise<void>;
}
export const PRINTING_CATALOG_LIMITS = Object.freeze({
  candidates: 2500,
  sets: 2000,
  pages: 20,
  responseBytes: 4 * 1024 * 1024,
  lookupBytes: 24 * 1024 * 1024,
  entryBytes: 2 * 1024 * 1024,
  memoryBytes: 4 * 1024 * 1024,
  persistentBytes: 8 * 1024 * 1024,
  cacheEntries: 64,
  pendingIdentities: 32,
  requestTimeoutMs: 12_000,
  lookupTimeoutMs: 30_000,
  cacheTimeoutMs: 1_000,
});
const DAY = 86_400_000;
const TTL: Record<VisionGame, number> = { pokemon: DAY, mtg: DAY, yugioh: 2 * DAY };
const INTERVAL: Record<VisionGame, number> = { pokemon: 250, mtg: 600, yugioh: 250 };
const PROVIDER = { pokemon: "TCGdex", mtg: "Scryfall", yugioh: "YGOPRODeck" };
const SCOPE: Record<VisionGame, string> = {
  pokemon: "TCGdex English exact-name card records, excluding Pokémon TCG Pocket. Provider coverage only; physical language, edition, finish and condition remain unconfirmed.",
  mtg: "Scryfall English paper card records for one Oracle identity. Provider coverage only; physical language, edition, finish and condition remain unconfirmed.",
  yugioh: "YGOPRODeck English-language card record and its listed set-code/rarity entries. Edition and finish alternatives are not fully exposed; physical language, edition, finish and condition remain unconfirmed.",
};
const HOST: Record<VisionGame, string> = {
  pokemon: "api.tcgdex.net", mtg: "api.scryfall.com", yugioh: "db.ygoprodeck.com",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PK_ID = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}$/;
// Set suffixes are not always numeric: actual provider records include
// LOB-E003, LDK2-ENY10, YGLD-ENC09 and MVP1-ENSV3. Keep them literally.
const YGO_CODE = /^([A-Z0-9]{2,8})-([A-Z0-9]{1,8})$/;
const YGO_LANGUAGES = new Set(["EN", "DE", "FR", "IT", "ES", "SP", "PT", "JA", "JP", "KO", "KR", "RU", "CN", "TC", "SC", "NL"]);
function ygoFields(code: string): { number: string; locale?: string } {
  const match = code.match(YGO_CODE);
  if (!match || !/\d/.test(match[2])) fail();
  const marker = match[2].slice(0, 2);
  const locale = YGO_LANGUAGES.has(marker) ? marker.toLowerCase() : undefined;
  const number = locale ? match[2].slice(2) : match[2];
  if (!number || !/\d/.test(number)) fail();
  return { number, ...(locale ? { locale } : {}) };
}
const SERIES_KEY = "printing:v1:pokemon:sets-and-pocket";
type Obj = Record<string, unknown>;
interface Lookup { reference: ReferenceMetadata; key: string; id: string; expectedIdentity?: string }
interface Budget { signal: AbortSignal; bytes: number }
interface Pending { controller: AbortController; promise: Promise<PrintingCatalogSnapshot>; subscribers: number; settled: boolean }
interface PokemonSets { sets: { id: string; name: string; official?: number }[]; pocket: string[] }
class CatalogFailure extends Error {
  constructor(public readonly code: string) { super(code); this.name = "PrintingCatalogError"; }
}
function fail(code = "invalid-response"): never { throw new CatalogFailure(code); }
function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Obj;
}
function str(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail();
  return value.trim();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) fail();
  if (value.length > max) fail("limit");
  return value;
}
function sameName(a: string, b: string): boolean {
  return a.normalize("NFKC").trim().toLocaleLowerCase("en-US") === b.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
function safeUrl(value: unknown, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(str(value, 2048)); } catch { return fail("unsafe-url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !hosts.includes(url.hostname)) fail("unsafe-url");
  return url;
}
function abortError(): DOMException { return new DOMException("Printing catalog lookup cancelled.", "AbortError"); }
function check(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
function size(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function clone<T>(value: T): T { return structuredClone(value); }

/** Separate bounded DB. Pruning and replacing happen in ONE transaction. */
export function createPrintingCatalogCache(database = "tcg-scan-printing-metadata-v1"): PrintingCatalogCache {
  let connection: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "key" });
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Metadata cache blocked"));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); connection = undefined; };
          resolve(db);
        };
      });
      connection.catch(() => { connection = undefined; });
    }
    return connection;
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("entries", "readonly");
        const request = tx.objectStore("entries").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async put(entry) {
      const bytes = size(entry);
      if (bytes > PRINTING_CATALOG_LIMITS.entryBytes) throw new Error("Metadata entry too large");
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction("entries", "readwrite");
        const store = tx.objectStore("entries");
        const rows: { key: IDBValidKey; bytes: number; fetchedAt: number }[] = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (cursor.key !== entry.key) rows.push({ key: cursor.key, bytes: size(cursor.value), fetchedAt: Number(cursor.value.fetchedAt) || 0 });
            cursor.continue();
            return;
          }
          rows.sort((a, b) => a.fetchedAt - b.fetchedAt);
          let total = bytes + rows.reduce((sum, row) => sum + row.bytes, 0);
          let count = rows.length + 1;
          for (const row of rows) {
            if (count <= PRINTING_CATALOG_LIMITS.cacheEntries && total <= PRINTING_CATALOG_LIMITS.persistentBytes) break;
            store.delete(row.key);
            count--;
            total -= row.bytes;
          }
          store.put(entry);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Metadata cache write failed"));
      });
    },
  };
}

export interface PrintingCatalogOptions {
  fetch?: typeof fetch;
  cache?: PrintingCatalogCache;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Bounds may be reduced for small devices/tests, never increased. */
  maxPages?: number;
  maxCandidates?: number;
  requestTimeoutMs?: number;
  lookupTimeoutMs?: number;
}
export interface PrintingCatalog {
  getPrintingCandidates(reference: ReferenceMetadata, options?: { signal?: AbortSignal }): Promise<PrintingCatalogSnapshot>;
}
function lowerBound(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(fallback, Math.floor(value))) : fallback;
}

/** Caller schedules this AFTER identity matching; it never touches the camera/vision worker. */
export function createPrintingCatalog(options: PrintingCatalogOptions = {}): PrintingCatalog {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const storage = options.cache ?? createPrintingCatalogCache();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const maxRows = lowerBound(options.maxCandidates, PRINTING_CATALOG_LIMITS.candidates);
  const maxPages = lowerBound(options.maxPages, PRINTING_CATALOG_LIMITS.pages);
  const requestTimeout = lowerBound(options.requestTimeoutMs, PRINTING_CATALOG_LIMITS.requestTimeoutMs);
  const lookupTimeout = lowerBound(options.lookupTimeoutMs, PRINTING_CATALOG_LIMITS.lookupTimeoutMs);
  const memory = new Map<string, PrintingCatalogCacheEntry>();
  let memoryBytes = 0;
  const pending = new Map<string, Pending>();
  const queues: Partial<Record<VisionGame, Promise<void>>> = {};
  const lastRequest: Partial<Record<VisionGame, number>> = {};
  const cooldown: Partial<Record<VisionGame, number>> = {};

  function remember(entry: PrintingCatalogCacheEntry) {
    const bytes = size(entry);
    if (bytes > PRINTING_CATALOG_LIMITS.entryBytes) return;
    const old = memory.get(entry.key);
    if (old) { memoryBytes -= size(old); memory.delete(entry.key); }
    memory.set(entry.key, clone(entry));
    memoryBytes += bytes;
    while (memory.size > PRINTING_CATALOG_LIMITS.cacheEntries || memoryBytes > PRINTING_CATALOG_LIMITS.memoryBytes) {
      const key = memory.keys().next().value!;
      memoryBytes -= size(memory.get(key));
      memory.delete(key);
    }
  }
  async function cacheWork<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    check(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, PRINTING_CATALOG_LIMITS.cacheTimeoutMs);
    try { return await raceSignal(operation(), controller.signal); }
    catch { check(signal); return; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
  async function cached(key: string, ttl: number, signal: AbortSignal): Promise<PrintingCatalogCacheEntry | undefined> {
    try {
      const raw = memory.get(key) ?? await cacheWork(() => storage.get(key), signal);
      if (!raw || size(raw) > PRINTING_CATALOG_LIMITS.entryBytes) return;
      const value = obj(raw);
      if (value.version !== 1 || value.key !== key || typeof value.fetchedAt !== "number" || typeof value.expiresAt !== "number" ||
        !Number.isFinite(value.fetchedAt) || !Number.isFinite(value.expiresAt) || value.fetchedAt > now() || value.fetchedAt <= 0 ||
        value.expiresAt !== value.fetchedAt + ttl) return;
      return raw as PrintingCatalogCacheEntry;
    } catch { check(signal); return; }
  }
  async function save(key: string, payload: unknown, ttl: number, signal: AbortSignal, fetchedAt = now()) {
    check(signal);
    const entry: PrintingCatalogCacheEntry = { version: 1, key, fetchedAt, expiresAt: fetchedAt + ttl, payload };
    remember(entry);
    // A blocked IndexedDB open/write must not hold this lookup indefinitely.
    // A failed write does not clear or replace the prior persistent entry.
    await cacheWork(() => storage.put(entry), signal);
  }
  async function slot(game: VisionGame, signal: AbortSignal) {
    const queued = (queues[game] ?? Promise.resolve()).catch(() => undefined).then(async () => {
      check(signal);
      if ((cooldown[game] ?? 0) > now()) fail("rate-limit");
      const remaining = Math.max(0, (lastRequest[game] ?? -Infinity) + INTERVAL[game] - now());
      if (remaining) await sleep(remaining, signal);
      check(signal);
      if ((cooldown[game] ?? 0) > now()) fail("rate-limit");
      lastRequest[game] = now();
    });
    queues[game] = queued.catch(() => undefined);
    await raceSignal(queued, signal);
  }
  async function request(game: VisionGame, target: URL, budget: Budget): Promise<unknown> {
    safeUrl(target.href, [HOST[game]]);
    check(budget.signal);
    await slot(game, budget.signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    budget.signal.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
    try {
      const response = await raceSignal(fetcher(target.href, {
        method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" }, signal: controller.signal,
      }), controller.signal);
      if (response.redirected || response.type === "opaqueredirect" || (response.url && safeUrl(response.url, [HOST[game]]).href !== target.href)) fail("unsafe-url");
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : NaN;
        const date = retry ? Date.parse(retry) - now() : NaN;
        const fallback = game === "yugioh" ? 3_600_000 : 60_000;
        const wait = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : fallback;
        cooldown[game] = now() + Math.max(fallback, Math.min(wait, DAY));
        fail("rate-limit");
      }
      if (!response.ok) fail(response.status === 404 ? "not-found" : "http");
      const declared = Number(response.headers.get("Content-Length"));
      if (declared > PRINTING_CATALOG_LIMITS.responseBytes) fail("limit");
      if (!response.body) fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await raceSignal(reader.read(), controller.signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          budget.bytes += chunk.value.byteLength;
          if (bytes > PRINTING_CATALOG_LIMITS.responseBytes || budget.bytes > PRINTING_CATALOG_LIMITS.lookupBytes) fail("limit");
          chunks.push(chunk.value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      check(budget.signal);
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) as unknown; } catch { return fail(); }
    } catch (error) {
      if (budget.signal.aborted) throw abortError();
      if (timedOut) fail("timeout");
      if (error instanceof CatalogFailure) throw error;
      fail("network");
    } finally { clearTimeout(timer); budget.signal.removeEventListener("abort", stop); }
  }
  function lookup(reference: ReferenceMetadata): Lookup {
    if (!["pokemon", "mtg", "yugioh"].includes(reference.game)) fail("invalid-reference");
    const name = str(reference.name, 180), key = str(reference.key, 300);
    const sourceHosts = reference.game === "pokemon" ? [HOST.pokemon] : reference.game === "mtg" ? [HOST.mtg, "scryfall.com"] : [HOST.yugioh, "ygoprodeck.com"];
    if (reference.sourceUrl) safeUrl(reference.sourceUrl, sourceHosts);
    let id: string, expectedIdentity: string | undefined;
    if (reference.game === "pokemon") {
      if (name.includes("|")) fail("invalid-reference");
      id = name;
      expectedIdentity = `pokemon:${name.toLowerCase()}`;
      if (reference.identityKey && reference.identityKey !== expectedIdentity) fail("identity-mismatch");
    } else if (reference.game === "mtg") {
      const match = key.match(/^mtg:([^:]+)(?::face\d+)?$/);
      if (!match || !UUID.test(match[1])) fail("invalid-reference");
      id = match[1].toLowerCase();
      if (reference.identityKey) {
        const oracle = reference.identityKey.replace(/^mtg:/, "");
        if (!reference.identityKey.startsWith("mtg:") || !UUID.test(oracle)) fail("invalid-reference");
        expectedIdentity = `mtg:${oracle.toLowerCase()}`;
      }
    } else {
      const match = key.match(/^yugioh:(\d{1,8})(?::art\d{1,10})?$/);
      if (!match || Number(match[1]) <= 0) fail("invalid-reference");
      id = String(Number(match[1]));
      expectedIdentity = `yugioh:${id}`;
      if (reference.identityKey && reference.identityKey !== expectedIdentity) fail("identity-mismatch");
    }
    return { reference: { ...reference, name }, id, expectedIdentity,
      key: `printing:v1:${JSON.stringify([reference.game, expectedIdentity ?? id, name])}` };
  }
  function snapshot(info: Lookup, candidates: PrintingCandidate[], fetchedAt?: number): PrintingCatalogSnapshot {
    const { reference } = info;
    return {
      candidates, catalogCompleteForIdentity: true, scope: SCOPE[reference.game], provider: PROVIDER[reference.game],
      locale: "en", lookupKey: info.key, referenceKey: reference.key,
      ...(fetchedAt !== undefined ? { fetchedAt: new Date(fetchedAt).toISOString() } : {}), stale: false,
    };
  }
  function validateCandidates(value: unknown, info: Lookup): PrintingCandidate[] {
    const seen = new Set<string>();
    return list(value, maxRows).map((raw) => {
      const row = obj(raw);
      const key = str(row.key, 300), name = str(row.name, 180);
      if (row.game !== info.reference.game || !sameName(name, info.reference.name) || seen.has(key)) fail("identity-mismatch");
      seen.add(key);
      if (info.expectedIdentity && row.identityKey !== info.expectedIdentity) fail("identity-mismatch");
      const identityKey = str(row.identityKey, 240), number = str(row.number, 30), setName = str(row.setName, 200);
      const sourceUrl = safeUrl(row.sourceUrl, [HOST[info.reference.game]]).href;
      const result: PrintingCandidate = { key, game: info.reference.game, name, identityKey, number, setName, sourceUrl };
      for (const field of ["setCode", "locale", "rarity"] as const) if (row[field] !== undefined) result[field] = str(row[field], 100);
      if (row.printedTotal !== undefined) {
        if (typeof row.printedTotal !== "number" || !Number.isSafeInteger(row.printedTotal) || row.printedTotal <= 0 || row.printedTotal > 10000) fail();
        result.printedTotal = row.printedTotal;
      }
      if (info.reference.game === "pokemon") {
        if (!key.startsWith("pokemon:") || !PK_ID.test(key.slice(8)) || sourceUrl !== `https://${HOST.pokemon}/v2/en/cards/${encodeURIComponent(key.slice(8))}` || result.locale !== "en") fail();
      } else if (info.reference.game === "mtg") {
        const match = key.match(/^mtg:([^:]+)(?::face\d+)?$/);
        if (!match || !UUID.test(match[1]) || !UUID.test(identityKey.replace(/^mtg:/, "")) || sourceUrl !== `https://${HOST.mtg}/cards/${match[1]}` || result.locale !== "en" || !result.setCode || !result.rarity) fail();
      } else {
        if (!key.startsWith(`${identityKey}:set:`) || sourceUrl !== `https://${HOST.yugioh}/api/v7/cardinfo.php?id=${info.id}` || !result.setCode || !result.rarity) fail();
        const fields = ygoFields(result.setCode);
        if (result.number !== fields.number || result.locale !== fields.locale) fail();
      }
      return result;
    });
  }
  function parseSets(raw: unknown): PokemonSets {
    const value = obj(raw);
    const seen = new Set<string>();
    const sets = list(value.sets, PRINTING_CATALOG_LIMITS.sets).map((rawSet) => {
      const set = obj(rawSet), id = str(set.id, 80), name = str(set.name);
      if (!PK_ID.test(id) || seen.has(id)) fail();
      seen.add(id);
      const official = set.official;
      if (official !== undefined && (typeof official !== "number" || !Number.isSafeInteger(official) || official < 0 || official > 10000)) fail();
      return { id, name, ...(typeof official === "number" ? { official } : {}) };
    });
    const pocket = list(value.pocket, PRINTING_CATALOG_LIMITS.sets).map((item) => str(item, 80));
    if (!sets.length || !pocket.length || pocket.some((id) => !PK_ID.test(id))) fail();
    return { sets, pocket };
  }
  async function pokemonSets(budget: Budget): Promise<PokemonSets> {
    const entry = await cached(SERIES_KEY, DAY, budget.signal);
    if (entry && entry.expiresAt > now()) {
      try { const sets = parseSets(entry.payload); remember(entry); return sets; } catch { /* Re-fetch corrupt metadata. */ }
    }
    const setsData = await request("pokemon", new URL(`https://${HOST.pokemon}/v2/en/sets`), budget);
    const pocketData = obj(await request("pokemon", new URL(`https://${HOST.pokemon}/v2/en/series/tcgp`), budget));
    if (pocketData.id !== "tcgp") fail();
    const sets = list(setsData, PRINTING_CATALOG_LIMITS.sets).map((item) => {
      const row = obj(item), counts = obj(row.cardCount);
      return { id: row.id, name: row.name, official: counts.official };
    });
    const pocket = list(pocketData.sets, PRINTING_CATALOG_LIMITS.sets).map((row) => obj(row).id);
    const parsed = parseSets({ sets, pocket });
    check(budget.signal);
    await save(SERIES_KEY, parsed, DAY, budget.signal);
    return parsed;
  }
  async function pokemon(info: Lookup, budget: Budget): Promise<PrintingCandidate[]> {
    // TCGdex arrays are unpaginated unless pagination:* is explicitly requested.
    // Never use the image-search gallery or catalog.ts's 12-result shortlist here.
    const url = new URL(`https://${HOST.pokemon}/v2/en/cards`);
    url.searchParams.set("name", `eq:${info.reference.name}`);
    const rows = list(await request("pokemon", url, budget), maxRows);
    const metadata = await pokemonSets(budget);
    const sets = new Map(metadata.sets.map((set) => [set.id, set]));
    const excluded = new Set(metadata.pocket);
    const candidates: PrintingCandidate[] = [];
    const ids = new Set<string>();
    for (const raw of rows) {
      const row = obj(raw), id = str(row.id, 80), localId = str(row.localId, 30), name = str(row.name, 180);
      if (!PK_ID.test(id) || !/^[A-Za-z0-9]+$/.test(localId) || ids.has(id)) fail();
      ids.add(id);
      if (name !== info.reference.name) fail("identity-mismatch");
      if (!id.endsWith(`-${localId}`)) fail();
      const setId = id.slice(0, -(localId.length + 1));
      if (excluded.has(setId)) continue;
      const set = sets.get(setId);
      if (!set) fail();
      candidates.push({ key: `pokemon:${id}`, game: "pokemon", name,
        identityKey: `pokemon:${name.toLowerCase()}`, setName: set.name, number: localId,
        // Prefix subsets/promos are not guessed from a numeric count. Their
        // denominator remains unknown, so the resolver can conservatively abstain.
        ...(/^\d+[a-z]?$/i.test(localId) && set.official && set.official > 0 ? { printedTotal: set.official } : {}),
        locale: "en", sourceUrl: `https://${HOST.pokemon}/v2/en/cards/${encodeURIComponent(id)}`,
      });
    }
    return candidates;
  }
  function mtgIdentity(row: Obj, name: string): { oracle: string; face?: number } {
    const fullName = str(row.name, 180);
    const faces = row.card_faces === undefined ? [] : list(row.card_faces, 5).map(obj);
    const face = sameName(fullName, name) ? undefined : faces.findIndex((item) => sameName(str(item.name, 180), name));
    if (face === -1) fail("identity-mismatch");
    const oracle = str(row.oracle_id ?? (face !== undefined ? faces[face]?.oracle_id : undefined), 36).toLowerCase();
    if (!UUID.test(oracle)) fail();
    return { oracle, ...(face !== undefined ? { face } : {}) };
  }
  function searchUrl(raw: unknown, oracle: string, initial?: URL): URL {
    const url = safeUrl(raw, [HOST.mtg]);
    if (url.pathname !== "/cards/search") fail("unsafe-url");
    const allowed = new Set(["q", "unique", "order", "dir", "include_extras", "include_multilingual", "include_variations", "page", "format"]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) fail("unsafe-url");
    if (!initial) {
      if (url.searchParams.get("q")?.trim().toLowerCase() !== `oracleid:${oracle}` || url.searchParams.get("unique") !== "prints" || url.searchParams.has("page")) fail("identity-mismatch");
      url.searchParams.set("q", `oracleid:${oracle} lang:en game:paper`);
      url.searchParams.set("include_extras", "true");
      url.searchParams.set("include_multilingual", "true");
    } else {
      const a = new URL(url), b = new URL(initial);
      a.searchParams.delete("page"); b.searchParams.delete("page");
      a.searchParams.sort(); b.searchParams.sort();
      if (a.href !== b.href || !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "")) fail("identity-mismatch");
    }
    return url;
  }
  async function mtg(info: Lookup, budget: Budget): Promise<PrintingCandidate[]> {
    const seed = obj(await request("mtg", new URL(`https://${HOST.mtg}/cards/${info.id}`), budget));
    if (seed.id !== info.id) fail("identity-mismatch");
    const { oracle } = mtgIdentity(seed, info.reference.name);
    if (info.expectedIdentity && info.expectedIdentity !== `mtg:${oracle}`) fail("identity-mismatch");
    const initial = searchUrl(seed.prints_search_uri, oracle);
    let url = initial, total: number | undefined, count = 0;
    const candidates: PrintingCandidate[] = [], seen = new Set<string>(), pages = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      if (pages.has(url.href)) fail("invalid-pagination");
      pages.add(url.href);
      const response = obj(await request("mtg", url, budget));
      if (response.object !== "list" || typeof response.has_more !== "boolean" || typeof response.total_cards !== "number" || !Number.isSafeInteger(response.total_cards) || response.total_cards < 1) fail();
      if (response.total_cards > maxRows) fail("limit");
      if (total !== undefined && total !== response.total_cards) fail("invalid-pagination");
      total = response.total_cards;
      const rows = list(response.data, maxRows);
      if (!rows.length || count + rows.length > maxRows) fail("limit");
      count += rows.length;
      for (const raw of rows) {
        const row = obj(raw), id = str(row.id, 36).toLowerCase(), identity = mtgIdentity(row, info.reference.name);
        if (!UUID.test(id) || seen.has(id) || identity.oracle !== oracle) fail("identity-mismatch");
        seen.add(id);
        const lang = str(row.lang, 8), games = list(row.games, 10).map((value) => str(value, 20));
        // The query explicitly asks for English paper. Foreign/digital rows are a
        // contradictory response, not permission to silently narrow the list.
        if (lang !== "en" || !games.includes("paper")) fail("identity-mismatch");
        const setCode = str(row.set, 12), number = str(row.collector_number, 30), setName = str(row.set_name), rarity = str(row.rarity, 100);
        if (!/^[a-z0-9]{2,12}$/i.test(setCode)) fail();
        candidates.push({ key: `mtg:${id}${identity.face !== undefined ? `:face${identity.face}` : ""}`,
          game: "mtg", name: info.reference.name, identityKey: `mtg:${oracle}`, setCode,
          number, setName, rarity, locale: "en", sourceUrl: `https://${HOST.mtg}/cards/${id}` });
      }
      if (!response.has_more) {
        if (count !== total || response.next_page !== undefined) fail("invalid-pagination");
        return candidates;
      }
      if (count >= total) fail("invalid-pagination");
      url = searchUrl(response.next_page, oracle, initial);
    }
    return fail("limit");
  }
  async function yugioh(info: Lookup, budget: Budget): Promise<PrintingCandidate[]> {
    const url = new URL(`https://${HOST.yugioh}/api/v7/cardinfo.php`);
    url.searchParams.set("id", info.id);
    const response = obj(await request("yugioh", url, budget));
    if (response.meta !== undefined) fail("invalid-pagination");
    const data = list(response.data, 1);
    if (data.length !== 1) fail();
    const card = obj(data[0]);
    if (String(card.id) !== info.id || !sameName(str(card.name, 180), info.reference.name)) fail("identity-mismatch");
    return list(card.card_sets, maxRows).map((raw, index) => {
      const row = obj(raw), setCode = str(row.set_code, 30), rarity = str(row.set_rarity, 100), setName = str(row.set_name);
      const fields = ygoFields(setCode);
      return { key: `yugioh:${info.id}:set:${encodeURIComponent(setCode)}:${encodeURIComponent(rarity)}:${index}`,
        game: "yugioh", name: info.reference.name, identityKey: `yugioh:${info.id}`, ...fields,
        setName, setCode, rarity, sourceUrl: url.href };
    });
  }
  async function perform(info: Lookup, signal: AbortSignal): Promise<PrintingCatalogSnapshot> {
    let old: PrintingCatalogSnapshot | undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, lookupTimeout);
    try {
      const entry = await cached(info.key, TTL[info.reference.game], controller.signal);
      check(controller.signal);
      if (entry) {
        try {
          const payload = obj(entry.payload);
          if (payload.scope !== SCOPE[info.reference.game]) fail();
          const candidates = validateCandidates(payload.candidates, info);
          if (!candidates.length) fail();
          old = snapshot(info, candidates, entry.fetchedAt);
          remember(entry);
          if (entry.expiresAt > now()) return old;
        } catch { /* Incompatible/old/corrupt caches cannot establish completeness. */ }
      }
      const budget: Budget = { signal: controller.signal, bytes: 0 };
      const raw = await raceSignal(({ pokemon, mtg, yugioh }[info.reference.game])(info, budget), controller.signal);
      const candidates = validateCandidates(raw, info);
      check(controller.signal);
      if (!candidates.length) fail("not-found");
      const fetchedAt = now();
      const result = snapshot(info, candidates, fetchedAt);
      await save(info.key, { scope: result.scope, candidates }, TTL[info.reference.game], controller.signal, fetchedAt);
      check(controller.signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw abortError();
      const code = timedOut ? "timeout" : error instanceof CatalogFailure ? error.code : "network";
      return { ...(old ?? snapshot(info, [])), catalogCompleteForIdentity: false, stale: !!old, error: code };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
  return {
    async getPrintingCandidates(reference, { signal } = {}) {
      check(signal);
      let info: Lookup;
      try { info = lookup(reference); } catch (error) {
        const game = ["pokemon", "mtg", "yugioh"].includes(reference.game) ? reference.game : "pokemon";
        return { candidates: [], catalogCompleteForIdentity: false, scope: SCOPE[game], provider: PROVIDER[game], locale: "en",
          lookupKey: "", referenceKey: reference.key, stale: false, error: error instanceof CatalogFailure ? error.code : "invalid-reference" };
      }
      let task = pending.get(info.key);
      if (!task || task.controller.signal.aborted) {
        if (pending.size >= PRINTING_CATALOG_LIMITS.pendingIdentities) return { ...snapshot(info, []), catalogCompleteForIdentity: false, error: "busy" };
        const controller = new AbortController();
        task = { controller, promise: perform(info, controller.signal), subscribers: 0, settled: false };
        const current = task;
        pending.set(info.key, task);
        void task.promise.then(() => undefined, () => undefined).finally(() => {
          current.settled = true;
          if (pending.get(info.key) === current) pending.delete(info.key);
        });
      }
      task.subscribers++;
      try {
        const value = signal ? await raceSignal(task.promise, signal) : await task.promise;
        check(signal);
        const provenance = await catalogProvenance(value);
        check(signal);
        return { ...clone(value), provenance, referenceKey: reference.key };
      } finally {
        task.subscribers--;
        if (!task.subscribers && !task.settled) task.controller.abort();
      }
    },
  };
}
let defaultCatalog: PrintingCatalog | undefined;
export function getPrintingCandidates(reference: ReferenceMetadata, options?: { signal?: AbortSignal }): Promise<PrintingCatalogSnapshot> {
  defaultCatalog ??= createPrintingCatalog();
  return defaultCatalog.getPrintingCandidates(reference, options);
}
