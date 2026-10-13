import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createPrintingCatalog, createPrintingCatalogCache, PRINTING_CATALOG_LIMITS,
  type PrintingCatalogCache, type PrintingCatalogCacheEntry, type PrintingCatalogOptions,
} from "./printing-catalog";
import { parsePrintingObservation, resolvePrintingEvidence } from "./printing-refinement";
import type { ReferenceMetadata } from "./vision/types";

const DAY = 86_400_000;
const START = Date.parse("2026-10-12T09:00:00Z");
const ID = "f58dba4f-1abb-47a3-a684-29c32bab95c0";
const ID2 = "f58dba4f-1abb-47a3-a684-29c32bab95c1";
const ORACLE = "4457ed35-7c10-48c8-9776-456485fdf070";
const OTHER = "4457ed35-7c10-48c8-9776-456485fdf071";
const pokemon: ReferenceMetadata = { key: "pokemon:sv01-025", game: "pokemon", name: "Pikachu", identityKey: "pokemon:pikachu" };
const magic: ReferenceMetadata = { key: `mtg:${ID}`, game: "mtg", name: "Lightning Bolt", identityKey: `mtg:${ORACLE}` };
const yugioh: ReferenceMetadata = { key: "yugioh:46986414:art46986414", game: "yugioh", name: "Dark Magician", identityKey: "yugioh:46986414" };
const pkSets = [
  { id: "sv01", name: "Scarlet & Violet", cardCount: { official: 198, total: 258 } },
  { id: "swsh9tg", name: "Trainer Gallery", cardCount: { official: 30, total: 30 } },
  { id: "A1", name: "Genetic Apex", cardCount: { official: 226, total: 286 } },
];
const pkRow = (localId = "025", extras: Record<string, unknown> = {}) => ({ id: `sv01-${localId}`, name: "Pikachu", localId, ...extras });
const magicRow = (extras: Record<string, unknown> = {}) => ({
  object: "card", id: ID, oracle_id: ORACLE, name: "Lightning Bolt", set: "lea", set_name: "Limited Edition Alpha",
  collector_number: "001", rarity: "common", lang: "en", games: ["paper"],
  prints_search_uri: `https://api.scryfall.com/cards/search?order=released&q=oracleid%3A${ORACLE}&unique=prints`,
  ...extras,
});
const ygoSet = (extras: Record<string, unknown> = {}) => ({ set_name: "Legend of Blue Eyes", set_code: "LOB-EN005", set_rarity: "Ultra Rare", ...extras });
const ygoRow = (extras: Record<string, unknown> = {}) => ({ id: 46986414, name: "Dark Magician", card_sets: [ygoSet()], ...extras });
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}
class Cache implements PrintingCatalogCache {
  entries = new Map<string, PrintingCatalogCacheEntry>();
  put = vi.fn(async (entry: PrintingCatalogCacheEntry) => { this.entries.set(entry.key, structuredClone(entry)); });
  get = vi.fn(async (key: string) => structuredClone(this.entries.get(key)));
}
function setup(handler: (url: URL, init?: RequestInit) => unknown | Promise<unknown>, options: PrintingCatalogOptions = {}) {
  let time = START;
  const cache = new Cache();
  const times: number[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    times.push(time);
    const result = await handler(new URL(String(input)), init);
    return result instanceof Response ? result : json(result);
  });
  const catalog = createPrintingCatalog({
    fetch: fetcher as typeof fetch, cache, now: () => time,
    sleep: async (ms) => { time += ms; }, ...options,
  });
  return { catalog, fetcher, cache, times, advance: (ms: number) => { time += ms; }, now: () => time };
}
function pkHandler(rows: unknown[], override?: (url: URL) => unknown) {
  return (url: URL) => {
    const result = override?.(url);
    if (result !== undefined) return result;
    if (url.pathname === "/v2/en/cards") return rows;
    if (url.pathname === "/v2/en/sets") return pkSets;
    if (url.pathname === "/v2/en/series/tcgp") return { id: "tcgp", sets: [{ id: "A1" }] };
    throw new Error(`Unexpected URL ${url.href}`);
  };
}
function magicHandler(rows = [magicRow()], seed = magicRow()) {
  return (url: URL) => url.pathname === `/cards/${ID}` ? seed : { object: "list", has_more: false, total_cards: rows.length, data: rows };
}
function observations() {
  return [1, 2].map((id) => parsePrintingObservation({
    game: "pokemon", jobId: `j${id}`, sessionId: "s", eventId: "e", frameId: `f${id}`,
    capturedAt: id * 1000, imageFingerprint: `p${id}`, rawText: "025/198",
  }));
}
async function tick() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("full-scope Pokémon metadata", () => {
  it("retains more than 12 exact-name records, including rows without images, and requests no art/prices", async () => {
    const rows = Array.from({ length: 16 }, (_, i) => pkRow(String(i + 1).padStart(3, "0")));
    const { catalog, fetcher, times } = setup(pkHandler(rows));
    const result = await catalog.getPrintingCandidates(pokemon);
    expect(result).toMatchObject({ catalogCompleteForIdentity: true, stale: false, provider: "TCGdex", locale: "en", referenceKey: pokemon.key });
    expect(result.candidates).toHaveLength(16);
    expect(result.candidates[0]).toMatchObject({ number: "001", printedTotal: 198, setName: "Scarlet & Violet", locale: "en" });
    expect(result.candidates[0]).not.toHaveProperty("imageUrl");
    expect(result.candidates[0]).not.toHaveProperty("prices");
    expect(result.candidates[0]).not.toHaveProperty("setCode");
    const request = new URL(fetcher.mock.calls[0][0].toString());
    expect([...request.searchParams]).toEqual([["name", "eq:Pikachu"]]);
    expect(times.slice(1).every((time, i) => time - times[i] >= 250)).toBe(true);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  });
  it("uses official counts, excludes Pocket and preserves subset prefixes without fabricating denominators", async () => {
    const { catalog } = setup(pkHandler([pkRow(), pkRow("TG01", { id: "swsh9tg-TG01" }), pkRow("025", { id: "A1-025" })]));
    const result = await catalog.getPrintingCandidates(pokemon);
    expect(result.catalogCompleteForIdentity).toBe(true);
    expect(result.candidates.map((row) => row.key)).toEqual(["pokemon:sv01-025", "pokemon:swsh9tg-TG01"]);
    expect(result.candidates[0].printedTotal).toBe(198);
    expect(result.candidates[1].number).toBe("TG01");
    expect(result.candidates[1].printedTotal).toBeUndefined();
    expect(result.scope).toContain("excluding Pokémon TCG Pocket");
  });
  it("cannot replace exhaustive ambiguity with a limited local gallery", async () => {
    const rows = [pkRow(), pkRow("025", { id: "sv02-025" })];
    const handler = pkHandler(rows, (url) => url.pathname === "/v2/en/sets" ? [...pkSets, { id: "sv02", name: "Another set", cardCount: { official: 198, total: 200 } }] : undefined);
    const full = await setup(handler).catalog.getPrintingCandidates(pokemon);
    const result = resolvePrintingEvidence({ game: "pokemon", sessionId: "s", eventId: "e", identityName: "Pikachu", observations: observations(), ...full });
    expect(result.state).toBe("unresolved");
    expect(result.reasons).toContain("printing-or-variant-ambiguous");
    const limited = await setup(handler, { maxCandidates: 1 }).catalog.getPrintingCandidates(pokemon);
    expect(limited).toMatchObject({ catalogCompleteForIdentity: false, error: "limit" });
  });
  it.each([
    [[pkRow(), pkRow("026", { name: "Raichu" })], "identity-mismatch"],
    [[pkRow(), pkRow()], "invalid-response"],
    [[pkRow("025", { id: "sv01-25" })], "invalid-response"],
    [[pkRow("025", { id: "unlisted-025" })], "invalid-response"],
    [[pkRow("025", { localId: undefined })], "invalid-response"],
  ])("refuses mixed or malformed rows rather than dropping alternatives", async (rows, error) => {
    const { catalog } = setup(pkHandler(rows));
    expect(await catalog.getPrintingCandidates(pokemon)).toMatchObject({ candidates: [], catalogCompleteForIdentity: false, error });
  });
  it("fails closed if Pocket exclusions cannot be verified", async () => {
    const { catalog } = setup(pkHandler([pkRow()], (url) => url.pathname.endsWith("/tcgp") ? { id: "tcgp", sets: [] } : undefined));
    expect(await catalog.getPrintingCandidates(pokemon)).toMatchObject({ catalogCompleteForIdentity: false });
  });
  it("caches set metadata across different card names", async () => {
    const { catalog, fetcher } = setup(pkHandler([pkRow()], (url) => url.pathname === "/v2/en/cards" && url.searchParams.get("name") === "eq:Raichu" ? [pkRow("026", { name: "Raichu" })] : undefined));
    await catalog.getPrintingCandidates(pokemon);
    const second = await catalog.getPrintingCandidates({ ...pokemon, key: "pokemon:sv01-026", name: "Raichu", identityKey: "pokemon:raichu" });
    expect(second.catalogCompleteForIdentity).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("Scryfall Oracle/English/paper scope", () => {
  it("verifies the seed UUID then follows all pages for the same Oracle identity", async () => {
    const { catalog, fetcher, times } = setup((url) => {
      if (url.pathname === `/cards/${ID}`) return magicRow();
      if (url.searchParams.get("page") === "2") return { object: "list", has_more: false, total_cards: 2, data: [magicRow({ id: ID2, collector_number: "007", set: "2ed" })] };
      const next = new URL(url); next.searchParams.set("page", "2");
      return { object: "list", has_more: true, total_cards: 2, data: [magicRow()], next_page: next.href };
    });
    const result = await catalog.getPrintingCandidates(magic);
    expect(result).toMatchObject({ catalogCompleteForIdentity: true, provider: "Scryfall", stale: false });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]).toMatchObject({ key: `mtg:${ID2}`, identityKey: `mtg:${ORACLE}`, number: "007", setCode: "2ed", locale: "en" });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("q")).toBe(`oracleid:${ORACLE} lang:en game:paper`);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(600);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(600);
    expect(result.scope).toContain("English paper");
  });
  it("uses a matching card-face name without confusing shared artwork with a printing", async () => {
    const row = magicRow({ name: "Day // Night", card_faces: [{ name: "Day" }, { name: "Night" }] });
    const { catalog } = setup(magicHandler([row], row));
    const result = await catalog.getPrintingCandidates({ ...magic, key: `mtg:${ID}:face1`, name: "Night" });
    expect(result.catalogCompleteForIdentity).toBe(true);
    expect(result.candidates[0]).toMatchObject({ key: `mtg:${ID}:face1`, name: "Night", identityKey: `mtg:${ORACLE}` });
    expect(result.candidates[0]).not.toHaveProperty("artworkKey");
  });
  it.each([
    [magicRow({ oracle_id: OTHER }), "identity-mismatch"],
    [magicRow({ lang: "ja" }), "identity-mismatch"],
    [magicRow({ games: ["arena"] }), "identity-mismatch"],
    [magicRow({ name: "Shock" }), "identity-mismatch"],
    [magicRow({ collector_number: undefined }), "invalid-response"],
  ])("refuses contradictory or incomplete printing metadata", async (row, error) => {
    const { catalog } = setup(magicHandler([row]));
    expect(await catalog.getPrintingCandidates(magic)).toMatchObject({ catalogCompleteForIdentity: false, error });
  });
  it.each([
    "https://evil.example/cards/search?q=x",
    `https://api.scryfall.com@evil.example/cards/search?q=oracleid:${ORACLE}&unique=prints`,
    `https://secret@api.scryfall.com/cards/search?q=oracleid:${ORACLE}&unique=prints`,
    `http://api.scryfall.com/cards/search?q=oracleid:${ORACLE}&unique=prints`,
    `https://api.scryfall.com/cards/random?q=oracleid:${ORACLE}&unique=prints`,
    `https://api.scryfall.com:444/cards/search?q=oracleid:${ORACLE}&unique=prints`,
    `https://api.scryfall.com/cards/search?q=oracleid:${OTHER}&unique=prints`,
  ])("never follows hostile prints_search_uri %s", async (uri) => {
    const { catalog, fetcher } = setup(magicHandler([], magicRow({ prints_search_uri: uri })));
    expect((await catalog.getPrintingCandidates(magic)).catalogCompleteForIdentity).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("marks a bounded/truncated pagination run incomplete", async () => {
    const { catalog, fetcher } = setup((url) => {
      if (url.pathname === `/cards/${ID}`) return magicRow();
      const next = new URL(url); next.searchParams.set("page", "2");
      return { object: "list", has_more: true, total_cards: 2, data: [magicRow()], next_page: next.href };
    }, { maxPages: 1 });
    expect(await catalog.getPrintingCandidates(magic)).toMatchObject({ catalogCompleteForIdentity: false, error: "limit" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["https://evil.example/cards/search", `https://api.scryfall.com/cards/search?q=oracleid:${OTHER}&unique=prints&page=2`])("rejects changed pagination destinations or queries", async (next_page) => {
    const { catalog, fetcher } = setup((url) => url.pathname === `/cards/${ID}` ? magicRow() : { object: "list", has_more: true, total_cards: 2, data: [magicRow()], next_page });
    expect((await catalog.getPrintingCandidates(magic)).catalogCompleteForIdentity).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("refuses an allegedly final page with a missing record", async () => {
    const { catalog } = setup((url) => url.pathname === `/cards/${ID}` ? magicRow() : { object: "list", has_more: false, total_cards: 2, data: [magicRow()] });
    expect(await catalog.getPrintingCandidates(magic)).toMatchObject({ catalogCompleteForIdentity: false, error: "invalid-pagination" });
  });
});

describe("YGOPRODeck set records", () => {
  it("preserves duplicate codes, distinct rarities and exact duplicate rows without prices or art", async () => {
    const sets = [ygoSet(), ygoSet({ set_rarity: "Rare" }), ygoSet(), ygoSet({ set_code: "SDY-006" })];
    const { catalog, fetcher } = setup(() => ({ data: [ygoRow({ card_sets: sets, card_prices: [{ tcgplayer_price: "0.01" }] })] }));
    const result = await catalog.getPrintingCandidates(yugioh);
    expect(result.catalogCompleteForIdentity).toBe(true);
    expect(result.candidates.map((row) => row.rarity)).toEqual(["Ultra Rare", "Rare", "Ultra Rare", "Ultra Rare"]);
    expect(new Set(result.candidates.map((row) => row.key)).size).toBe(4);
    expect(result.candidates[0]).toMatchObject({ setCode: "LOB-EN005", number: "005", locale: "en" });
    expect(result.candidates[3]).not.toHaveProperty("locale");
    expect(JSON.stringify(result)).not.toContain("0.01");
    expect(result.candidates[0]).not.toHaveProperty("edition");
    expect(result.candidates[0]).not.toHaveProperty("imageUrl");
    expect(String(fetcher.mock.calls[0][0])).toBe("https://db.ygoprodeck.com/api/v7/cardinfo.php?id=46986414");
    expect(result.scope).toContain("not fully exposed");
  });
  it.each([
    ygoRow({ id: 89631139 }),
    ygoRow({ name: "Blue-Eyes White Dragon" }),
    ygoRow({ card_sets: [ygoSet(), { set_name: "Incomplete alternative" }] }),
    ygoRow({ card_sets: [ygoSet({ set_rarity: "" })] }),
  ])("rejects mixed identities or incomplete alternatives", async (row) => {
    const { catalog } = setup(() => ({ data: [row] }));
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ catalogCompleteForIdentity: false, candidates: [] });
  });
  it.each([
    ["LOB-E003", "E003", undefined],
    ["2021-EN001", "001", "en"],
    ["LDK2-ENY10", "Y10", "en"],
    ["LEDD-ENA01", "A01", "en"],
    ["MVP1-ENSV3", "SV3", "en"],
    ["MVP1-ENSE3", "SE3", "en"],
    ["MVP1-ENG54", "G54", "en"],
    ["YGLD-ENC09", "C09", "en"],
  ])("preserves live-provider prefixed code %s without dropping an alternative", async (set_code, number, locale) => {
    const { catalog } = setup(() => ({ data: [ygoRow({ card_sets: [ygoSet({ set_code })] })] }));
    const result = await catalog.getPrintingCandidates(yugioh);
    expect(result.catalogCompleteForIdentity).toBe(true);
    expect(result.candidates[0].setCode).toBe(set_code);
    expect(result.candidates[0].number).toBe(number);
    expect(result.candidates[0].locale).toBe(locale);
  });
  it("uses a 48-hour TTL", async () => {
    const { catalog, fetcher, advance } = setup(() => ({ data: [ygoRow()] }));
    await catalog.getPrintingCandidates(yugioh);
    advance(DAY + 1);
    expect((await catalog.getPrintingCandidates(yugioh)).stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(DAY);
    await catalog.getPrintingCandidates(yugioh);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("bounded fresh-first cache and failure recovery", () => {
  it("serves fresh cached metadata without network, and clones snapshots to prevent caller corruption", async () => {
    const { catalog, fetcher } = setup(pkHandler([pkRow()]));
    const first = await catalog.getPrintingCandidates(pokemon);
    first.candidates[0].name = "Poisoned";
    const second = await catalog.getPrintingCandidates(pokemon);
    expect(second.candidates[0].name).toBe("Pikachu");
    expect(second.catalogCompleteForIdentity).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("returns offline stale metadata with completeness disabled and never overwrites the last good entry", async () => {
    let offline = false;
    const { catalog, cache, advance } = setup((url) => { if (offline) throw new Error("offline"); return pkHandler([pkRow()])(url); });
    const first = await catalog.getPrintingCandidates(pokemon);
    const stored = structuredClone(cache.entries);
    advance(DAY + 1); offline = true;
    const stale = await catalog.getPrintingCandidates(pokemon);
    expect(stale).toMatchObject({ catalogCompleteForIdentity: false, stale: true, error: "network", fetchedAt: first.fetchedAt, candidates: first.candidates });
    expect(cache.entries).toEqual(stored);
  });
  it("never replaces the good cache with a malformed refresh", async () => {
    let malformed = false;
    const { catalog, cache, advance } = setup((url) => pkHandler(malformed ? [pkRow(), pkRow("026", { name: "Raichu" })] : [pkRow()])(url));
    const first = await catalog.getPrintingCandidates(pokemon);
    const stored = structuredClone(cache.entries.get(first.lookupKey));
    malformed = true; advance(DAY + 1);
    const stale = await catalog.getPrintingCandidates(pokemon);
    expect(stale).toMatchObject({ stale: true, catalogCompleteForIdentity: false, error: "identity-mismatch" });
    expect(cache.entries.get(first.lookupKey)).toEqual(stored);
  });
  it("survives quota failures and keeps the previous persistent record intact", async () => {
    const cache = new Cache();
    let version = 1;
    const firstCatalog = setup(() => ({ data: [ygoRow({ card_sets: [ygoSet({ set_name: `Version ${version}` })] })] }), { cache });
    const first = await firstCatalog.catalog.getPrintingCandidates(yugioh);
    const stored = structuredClone(cache.entries);
    firstCatalog.advance(2 * DAY + 1); version = 2;
    cache.put.mockImplementation(async () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    const fresh = await firstCatalog.catalog.getPrintingCandidates(yugioh);
    expect(fresh.catalogCompleteForIdentity).toBe(true);
    expect(fresh.candidates[0].setName).toBe("Version 2");
    expect(cache.entries).toEqual(stored);
    const secondCatalog = setup(() => { throw new Error("offline"); }, { cache, now: firstCatalog.now });
    expect(await secondCatalog.catalog.getPrintingCandidates(yugioh)).toMatchObject({ stale: true, catalogCompleteForIdentity: false, candidates: first.candidates });
  });
  it("rejects corrupt or hostile persisted candidates and refetches instead", async () => {
    const cache = new Cache();
    const first = setup(() => ({ data: [ygoRow()] }), { cache });
    const result = await first.catalog.getPrintingCandidates(yugioh);
    const saved = cache.entries.get(result.lookupKey)!;
    (saved.payload as { candidates: { sourceUrl: string }[] }).candidates[0].sourceUrl = "https://evil.example/private";
    const next = setup(() => ({ data: [ygoRow()] }), { cache });
    expect((await next.catalog.getPrintingCandidates(yugioh)).catalogCompleteForIdentity).toBe(true);
    expect(next.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not fetch on invalid references or credentials embedded in URLs", async () => {
    const { catalog, fetcher } = setup(() => { throw new Error("Must not fetch"); });
    for (const reference of [
      { ...pokemon, name: "Pikachu|Raichu", identityKey: undefined },
      { ...magic, key: "mtg:not-a-uuid" },
      { ...yugioh, key: "yugioh:46986414,89631139" },
      { ...pokemon, sourceUrl: "https://password@api.tcgdex.net/v2/en/cards/base1-58" },
      { ...yugioh, sourceUrl: "javascript:alert(1)" },
    ]) expect((await catalog.getPrintingCandidates(reference)).catalogCompleteForIdentity).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses foreign redirects even from an otherwise successful fetch implementation", async () => {
    const { catalog } = setup(() => {
      const response = json({ data: [ygoRow()] });
      Object.defineProperty(response, "url", { value: "https://evil.example/card" });
      return response;
    });
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ catalogCompleteForIdentity: false, error: "unsafe-url" });
  });
  it("bounds decoded responses before JSON validation", async () => {
    const { catalog } = setup(() => json({ data: [ygoRow()] }, 200, { "Content-Length": String(PRINTING_CATALOG_LIMITS.responseBytes + 1) }));
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ catalogCompleteForIdentity: false, error: "limit" });
  });
  it("honors 429 cooldown without retries, stale promotion, or cache replacement", async () => {
    let limited = false;
    const { catalog, fetcher, cache, advance } = setup(() => limited ? json({}, 429, { "Retry-After": "7200" }) : { data: [ygoRow()] });
    const first = await catalog.getPrintingCandidates(yugioh);
    const stored = structuredClone(cache.entries);
    advance(2 * DAY + 1); limited = true;
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ stale: true, catalogCompleteForIdentity: false, error: "rate-limit", candidates: first.candidates });
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ error: "rate-limit", catalogCompleteForIdentity: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.entries).toEqual(stored);
    advance(3_600_001);
    await catalog.getPrintingCandidates(yugioh);
    expect(fetcher).toHaveBeenCalledTimes(2);
    advance(3_600_001); limited = false;
    expect((await catalog.getPrintingCandidates(yugioh)).catalogCompleteForIdentity).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("deduplicates concurrent identity requests and lets one subscriber cancel independently", async () => {
    let finish!: (value: unknown) => void;
    let networkSignal: AbortSignal | undefined;
    const { catalog, fetcher } = setup((_url, init) => { networkSignal = init?.signal ?? undefined; return new Promise((resolve) => { finish = resolve; }); });
    const firstController = new AbortController(), secondController = new AbortController();
    const first = catalog.getPrintingCandidates(yugioh, { signal: firstController.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = catalog.getPrintingCandidates({ ...yugioh, key: "yugioh:46986414:art123" }, { signal: secondController.signal });
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    firstController.abort(); await rejected;
    expect(networkSignal?.aborted).toBe(false);
    finish({ data: [ygoRow()] });
    expect(await second).toMatchObject({ catalogCompleteForIdentity: true, referenceKey: "yugioh:46986414:art123" });
  });
  it("aborts the provider when all subscribers cancel and makes no cache write", async () => {
    let networkSignal: AbortSignal | undefined;
    const { catalog, cache } = setup((_url, init) => { networkSignal = init?.signal ?? undefined; return new Promise(() => undefined); });
    const controller = new AbortController();
    const promise = catalog.getPrintingCandidates(yugioh, { signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await tick(); controller.abort(); await rejected; await tick();
    expect(networkSignal?.aborted).toBe(true);
    expect(cache.put).not.toHaveBeenCalled();
  });
  it("rejects an already canceled lookup without touching cache or network", async () => {
    const { catalog, cache, fetcher } = setup(() => ({ data: [ygoRow()] }));
    const controller = new AbortController(); controller.abort();
    await expect(catalog.getPrintingCandidates(yugioh, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.get).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds a hung network request with a timeout", async () => {
    vi.useFakeTimers();
    const { catalog, cache } = setup(() => new Promise(() => undefined), { requestTimeoutMs: 20, lookupTimeoutMs: 100 });
    const pending = catalog.getPrintingCandidates(yugioh);
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ error: "timeout", catalogCompleteForIdentity: false });
    expect(cache.put).not.toHaveBeenCalled();
  });
  it("bounds a blocked persistent cache read within the overall lookup deadline", async () => {
    vi.useFakeTimers();
    const cache: PrintingCatalogCache = { get: () => new Promise(() => undefined), put: async () => undefined };
    const { catalog, fetcher } = setup(() => ({ data: [ygoRow()] }), { cache, lookupTimeoutMs: 40 });
    const result = catalog.getPrintingCandidates(yugioh);
    await vi.advanceTimersByTimeAsync(41);
    expect(await result).toMatchObject({ catalogCompleteForIdentity: false, error: "timeout" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("continues through unavailable persistence and never waits forever on a blocked write", async () => {
    vi.useFakeTimers();
    const cache: PrintingCatalogCache = { get: async () => undefined, put: () => new Promise(() => undefined) };
    const { catalog } = setup(() => ({ data: [ygoRow()] }), { cache });
    const result = catalog.getPrintingCandidates(yugioh);
    await vi.advanceTimersByTimeAsync(PRINTING_CATALOG_LIMITS.cacheTimeoutMs + 1);
    expect(await result).toMatchObject({ catalogCompleteForIdentity: true, stale: false });
  });
  it("bounds the actual streamed response even when Content-Length is absent", async () => {
    const { catalog } = setup(() => new Response('"' + "x".repeat(PRINTING_CATALOG_LIMITS.responseBytes) + '"'));
    expect(await catalog.getPrintingCandidates(yugioh)).toMatchObject({ catalogCompleteForIdentity: false, error: "limit" });
  });
  it("bounds memory entries when persistent storage is unavailable", async () => {
    const cache: PrintingCatalogCache = { get: async () => undefined, put: async () => undefined };
    const { catalog, fetcher } = setup((url) => ({ data: [ygoRow({ id: Number(url.searchParams.get("id")) })] }), { cache });
    const reference = (id: number) => ({ ...yugioh, key: `yugioh:${id}`, identityKey: `yugioh:${id}` });
    for (let i = 1; i <= PRINTING_CATALOG_LIMITS.cacheEntries + 1; i++)
      expect((await catalog.getPrintingCandidates(reference(i))).catalogCompleteForIdentity).toBe(true);
    await catalog.getPrintingCandidates(reference(1));
    expect(fetcher).toHaveBeenCalledTimes(PRINTING_CATALOG_LIMITS.cacheEntries + 2);
  });

});

describe("persistent cache bounds", () => {
  it("persists across catalog instances", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cache = createPrintingCatalogCache("persist-test");
    const first = setup(() => ({ data: [ygoRow()] }), { cache });
    const saved = await first.catalog.getPrintingCandidates(yugioh);
    const second = setup(() => { throw new Error("Must use persisted data"); }, { cache: createPrintingCatalogCache("persist-test") });
    expect(await second.catalog.getPrintingCandidates(yugioh)).toEqual(saved);
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it("bounds entries and refuses oversized replacement without erasing a good entry", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cache = createPrintingCatalogCache("bounds-test");
    for (let i = 0; i < PRINTING_CATALOG_LIMITS.cacheEntries + 3; i++)
      await cache.put({ version: 1, key: `entry-${i}`, fetchedAt: START + i, expiresAt: START + DAY + i, payload: { name: "Metadata only" } });
    expect(await cache.get("entry-0")).toBeUndefined();
    const key = `entry-${PRINTING_CATALOG_LIMITS.cacheEntries + 2}`;
    const good = await cache.get(key);
    await expect(cache.put({ version: 1, key, fetchedAt: START + 1000, expiresAt: START + DAY + 1000, payload: "x".repeat(PRINTING_CATALOG_LIMITS.entryBytes + 1) })).rejects.toThrow("too large");
    expect(await cache.get(key)).toEqual(good);
  });
  it("prunes persistent storage by bytes as well as by entry count", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cache = createPrintingCatalogCache("byte-bounds-test");
    for (let i = 0; i < 5; i++)
      await cache.put({ version: 1, key: `large-${i}`, fetchedAt: START + i, expiresAt: START + DAY + i,
        payload: "x".repeat(Math.floor(1.8 * 1024 * 1024)) });
    expect(await cache.get("large-0")).toBeUndefined();
    expect(await cache.get("large-4")).toBeDefined();
  });

});

describe("explicit saved-catalog refresh", () => {
  it("bypasses a valid 24-hour card AND set cache, revalidates HTTP, and leaves normal scanning cached", async () => {
    let official = 198;
    const { catalog, fetcher, advance } = setup(pkHandler([pkRow()], (url) =>
      url.pathname === "/v2/en/sets"
        ? pkSets.map((set) => ({ ...set, cardCount: { ...set.cardCount, official } }))
        : undefined));
    const first = await catalog.getPrintingCandidates(pokemon);
    advance(1000);
    await catalog.getPrintingCandidates(pokemon);
    expect(fetcher).toHaveBeenCalledTimes(3);
    official = 199;
    const refreshed = await catalog.getPrintingCandidates(pokemon, { refresh: true });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(refreshed.candidates[0].printedTotal).toBe(199);
    expect(refreshed.provenance?.snapshotId).not.toBe(first.provenance?.snapshotId);
    expect(refreshed.fetchedAt).not.toBe(first.fetchedAt);
    for (const [, init] of fetcher.mock.calls.slice(3)) expect(init?.cache).toBe("no-cache");
    for (const [, init] of fetcher.mock.calls.slice(0, 3)) expect(init?.cache).toBeUndefined();
    expect(await catalog.getPrintingCandidates(pokemon)).toEqual(refreshed);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("cannot coalesce an explicit refresh into a normal task returning a valid cache hit", async () => {
    let rows = [pkRow()];
    const { catalog, fetcher } = setup((url) => pkHandler(rows)(url));
    const first = await catalog.getPrintingCandidates(pokemon);
    rows = [pkRow(), pkRow("026")];
    const normal = catalog.getPrintingCandidates(pokemon);
    const forced = catalog.getPrintingCandidates(pokemon, { refresh: true });
    expect((await normal).provenance?.snapshotId).toBe(first.provenance?.snapshotId);
    expect((await forced).candidates).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("coalesces refresh subscribers while cancellation stays subscriber-scoped", async () => {
    let release!: (value: unknown) => void;
    const { catalog, fetcher } = setup(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const first = catalog.getPrintingCandidates(yugioh, { refresh: true, signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = catalog.getPrintingCandidates(yugioh, { refresh: true });
    await tick();
    controller.abort();
    release({ data: [ygoRow()] });
    await rejected;
    expect((await second).catalogCompleteForIdentity).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed forced refresh stale even when its fallback TTL has not expired", async () => {
    let offline = false;
    const { catalog, cache, advance } = setup((url) => {
      if (offline) throw new Error("offline");
      return pkHandler([pkRow()])(url);
    });
    const first = await catalog.getPrintingCandidates(pokemon);
    const saved = structuredClone(cache.entries);
    advance(1000); offline = true;
    const result = await catalog.getPrintingCandidates(pokemon, { refresh: true });
    expect(result).toMatchObject({ stale: true, catalogCompleteForIdentity: false, error: "network", fetchedAt: first.fetchedAt });
    expect(result.provenance).toMatchObject({ stale: true, completeWithinScope: false, snapshotId: first.provenance!.snapshotId });
    expect(cache.entries).toEqual(saved);
  });
  it("fails closed when forced set metadata is missing or malformed without replacing the card cache", async () => {
    let broken = false;
    const { catalog, cache } = setup(pkHandler([pkRow()], (url) =>
      broken && url.pathname === "/v2/en/sets" ? [] : undefined));
    const first = await catalog.getPrintingCandidates(pokemon);
    const good = structuredClone(cache.entries.get(first.lookupKey));
    broken = true;
    const result = await catalog.getPrintingCandidates(pokemon, { refresh: true });
    expect(result).toMatchObject({ stale: true, catalogCompleteForIdentity: false, error: "invalid-response" });
    expect(cache.entries.get(first.lookupKey)).toEqual(good);
  });
  it("preserves the shared provider rate limit and cooldown on explicit refreshes", async () => {
    let limited = false;
    const { catalog, fetcher, times } = setup(() => limited
      ? json({}, 429, { "Retry-After": "60" }) : { data: [ygoRow()] });
    await catalog.getPrintingCandidates(yugioh);
    await catalog.getPrintingCandidates(yugioh, { refresh: true });
    limited = true;
    expect(await catalog.getPrintingCandidates(yugioh, { refresh: true })).toMatchObject({ error: "rate-limit", stale: true });
    const count = fetcher.mock.calls.length;
    expect(await catalog.getPrintingCandidates(yugioh, { refresh: true })).toMatchObject({ error: "rate-limit", stale: true });
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(times.slice(1).every((time, i) => time - times[i] >= 250)).toBe(true);
  });
  it("retains response bounds and cancellation for refresh mode", async () => {
    const bounded = setup(pkHandler([pkRow(), pkRow("026")]), { maxCandidates: 1 });
    expect(await bounded.catalog.getPrintingCandidates(pokemon, { refresh: true })).toMatchObject({ error: "limit", catalogCompleteForIdentity: false });
    let signal: AbortSignal | undefined;
    const blocked = setup((_, init) => { signal = init?.signal ?? undefined; return new Promise(() => undefined); });
    const controller = new AbortController();
    const result = blocked.catalog.getPrintingCandidates(yugioh, { refresh: true, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(blocked.cache.put).not.toHaveBeenCalled();
  });
});

it("an older normal lookup cannot overwrite a newer forced-refresh cache when responses finish out of order", async () => {
  const releases: ((value: unknown) => void)[] = [];
  const { catalog, cache, fetcher } = setup(() => new Promise((resolve) => releases.push(resolve)));
  const normal = catalog.getPrintingCandidates(yugioh);
  await tick();
  const refreshed = catalog.getPrintingCandidates(yugioh, { refresh: true });
  await tick();
  releases[1]({ data: [ygoRow({ card_sets: [ygoSet({ set_name: "New snapshot" })] })] });
  const newer = await refreshed;
  releases[0]({ data: [ygoRow({ card_sets: [ygoSet({ set_name: "Old snapshot" })] })] });
  expect((await normal).candidates[0].setName).toBe("Old snapshot");
  expect(await catalog.getPrintingCandidates(yugioh)).toEqual(newer);
  const stored = cache.entries.get(newer.lookupKey)!;
  expect((stored.payload as { candidates: { setName: string }[] }).candidates[0].setName).toBe("New snapshot");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not let older shared Pokémon set metadata replace the refreshed set cache across identities", async () => {
  let releaseSets!: (value: unknown) => void;
  let setRequests = 0;
  const { catalog, cache } = setup((url) => {
    if (url.pathname === "/v2/en/cards") return [pkRow("025", { name: url.searchParams.get("name")!.slice(3) })];
    if (url.pathname === "/v2/en/sets") {
      if (++setRequests === 1) return new Promise((resolve) => { releaseSets = resolve; });
      return pkSets.map((set) => ({ ...set, cardCount: { ...set.cardCount, official: 199 } }));
    }
    return { id: "tcgp", sets: [{ id: "A1" }] };
  });
  const normal = catalog.getPrintingCandidates({ ...pokemon, name: "Raichu", identityKey: "pokemon:raichu" });
  for (let i = 0; i < 10 && !releaseSets; i++) await tick();
  const refreshed = await catalog.getPrintingCandidates(pokemon, { refresh: true });
  expect(refreshed.candidates[0].printedTotal).toBe(199);
  releaseSets(pkSets);
  expect((await normal).candidates[0].printedTotal).toBe(198);
  const sets = cache.entries.get("printing:v1:pokemon:sets-and-pocket")!.payload as { sets: { official: number }[] };
  expect(sets.sets[0].official).toBe(199);
});

it("built-in IndexedDB cache orders overlapping atomic writes on a cold database open", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const cache = createPrintingCatalogCache("concurrent-cold-write-test");
  const old: PrintingCatalogCacheEntry = { version: 1, key: "same", fetchedAt: START, expiresAt: START + DAY, payload: "old" };
  const newer = { ...old, fetchedAt: START + 1, expiresAt: START + DAY + 1, payload: "new" };
  await Promise.all([cache.put(old), cache.put(newer)]);
  expect(await cache.get("same")).toEqual(newer);
});
