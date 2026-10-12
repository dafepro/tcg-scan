import type { Card, CardPrice, Game } from "../types";

/** Free public catalogs. See docs/providers.md for pricing and artwork limits. */
const PROVIDERS: Record<Game, string> = {
  mtg: "Scryfall",
  pokemon: "TCGdex",
  yugioh: "YGOPRODeck",
};
const BASE = {
  mtg: "https://api.scryfall.com/cards",
  pokemon: "https://api.tcgdex.net/v2/en/cards",
  yugioh: "https://db.ygoprodeck.com/api/v7/cardinfo.php",
};
const LIMIT = 12;
const TIMEOUT_MS = 15_000;
const CACHE_KEY = "tcg-scan:catalog-cache:v1";
const DAY = 86_400_000;
const REQUEST_INTERVAL: Record<Game, number> = {
  mtg: 600,
  pokemon: 250,
  yugioh: 250,
};
const cache = new Map<string, { expires: number; cards: Card[] }>();
const queues: Partial<Record<Game, Promise<void>>> = {};
const lastRequest: Partial<Record<Game, number>> = {};
const cooldown: Partial<Record<Game, number>> = {};
let cacheLoaded = false;
type JsonObject = Record<string, unknown>;
type ErrorCode =
  | "network"
  | "timeout"
  | "rate-limit"
  | "not-found"
  | "invalid-response"
  | "invalid-query"
  | "http";

export class CatalogError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly game: Game,
    message: string,
  ) {
    super(`${PROVIDERS[game]}: ${message}`);
    this.name = "CatalogError";
  }
}

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function text(value: unknown, fallback: string): string {
  return string(value) || fallback;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function safeUrl(value: unknown, hosts: string[]): string | undefined {
  try {
    const url = new URL(string(value));
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hosts.includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function aborted(): DOMException {
  return new DOMException("The card lookup was cancelled.", "AbortError");
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
async function requestSlot(game: Game, signal?: AbortSignal): Promise<void> {
  const slot = (queues[game] ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      checkSignal(signal);
      if ((cooldown[game] ?? 0) > Date.now()) {
        throw new CatalogError(
          "rate-limit",
          game,
          "The provider asked us to slow down. Please try again later.",
        );
      }
      const delay = Math.max(
        0,
        (lastRequest[game] ?? 0) + REQUEST_INTERVAL[game] - Date.now(),
      );
      if (delay)
        await withSignal(
          new Promise<void>((resolve) => setTimeout(resolve, delay)),
          signal,
        );
      checkSignal(signal);
      if ((cooldown[game] ?? 0) > Date.now()) {
        throw new CatalogError(
          "rate-limit",
          game,
          "The provider asked us to slow down. Please try again later.",
        );
      }
      lastRequest[game] = Date.now();
    });
  queues[game] = slot.catch(() => undefined);
  await withSignal(slot, signal);
}

interface ApiResult {
  data: unknown;
  retrievedAt: string;
}
async function request(
  game: Game,
  url: string,
  signal?: AbortSignal,
): Promise<ApiResult> {
  checkSignal(signal);
  await requestSlot(game, signal);
  checkSignal(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  try {
    // Browsers supply their own User-Agent; setting it here is not portable.
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      const parsed = retry ? Number(retry) * 1000 : NaN;
      const dateDelay = retry ? Date.parse(retry) - Date.now() : NaN;
      const fallback = game === "yugioh" ? 3_600_000 : 60_000;
      const wait = Number.isFinite(parsed)
        ? parsed
        : Number.isFinite(dateDelay)
          ? dateDelay
          : fallback;
      cooldown[game] = Date.now() + Math.max(fallback, wait);
      throw new CatalogError(
        "rate-limit",
        game,
        "Too many requests. Please try again later; no automatic retries will be sent.",
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (!response.ok)
        throw new CatalogError(
          "http",
          game,
          `The service returned HTTP ${response.status}. Please try again later.`,
        );
      throw new CatalogError(
        "invalid-response",
        game,
        "The service returned unreadable data. Please try again later.",
      );
    }
    const errorText = string(record(data).error);
    if (
      response.status === 404 ||
      (game === "yugioh" && /no card(?:s)? (?:matching|found)/i.test(errorText))
    ) {
      throw new CatalogError(
        "not-found",
        game,
        "No matching card was found. Try a name or a full catalog ID.",
      );
    }
    if (!response.ok) {
      const hint =
        response.status === 400
          ? "Check the spelling or search syntax."
          : "Please try again later.";
      throw new CatalogError(
        "http",
        game,
        `The service returned HTTP ${response.status}. ${hint}`,
      );
    }
    checkSignal(signal);
    return { data, retrievedAt: new Date().toISOString() };
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (timedOut)
      throw new CatalogError(
        "timeout",
        game,
        "The lookup timed out. Check your connection and try again.",
      );
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(
      "network",
      game,
      "Could not connect. Check your connection or try again later.",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function amount(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))
  )
    return undefined;
  const number = Number(value);
  // Catalogs sometimes use zero for unavailable prices. Never turn missing data into a $0 valuation.
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
function price(
  value: unknown,
  currency: "USD" | "EUR",
  source: string,
  retrievedAt: string,
  updated?: unknown,
  note?: string,
): CardPrice[] {
  const number = amount(value);
  if (number === undefined) return [];
  const stamp = string(updated);
  const validDate =
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(stamp) &&
    Number.isFinite(Date.parse(stamp));
  return [
    {
      amount: number,
      currency,
      source,
      updatedAt: validDate ? stamp : retrievedAt,
      note: [
        note,
        !validDate
          ? "Timestamp is retrieval time; the source did not provide a price-update time."
          : "Timestamp is the provider-reported price update.",
      ]
        .filter(Boolean)
        .join(" "),
    },
  ];
}
function identity(
  value: unknown,
  game: Game,
): { row: JsonObject; id: string; name: string } {
  const row = record(value);
  const id =
    typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id >= 0
      ? String(row.id)
      : string(row.id);
  const name = string(row.name);
  if (!id || !name)
    throw new CatalogError(
      "invalid-response",
      game,
      "The service returned an incomplete card. Please try again later.",
    );
  return { row, id, name };
}
function mtgCard(value: unknown, retrievedAt: string): Card {
  const { row, id, name } = identity(value, "mtg");
  const rawPrices = record(row.prices);
  const front = record(array(row.card_faces)[0]);
  const images = record(row.image_uris ?? front.image_uris);
  return {
    id,
    name,
    game: "mtg",
    provider: "Scryfall",
    setName: text(row.set_name, "Set unavailable"),
    setCode: string(row.set),
    number: string(row.collector_number),
    rarity: text(row.rarity, "Unknown"),
    imageUrl: safeUrl(images.normal ?? images.large, ["cards.scryfall.io"]),
    sourceUrl:
      safeUrl(row.scryfall_uri, ["scryfall.com"]) ??
      `${BASE.mtg}/${encodeURIComponent(id)}`,
    description:
      string(row.oracle_text) ||
      array(row.card_faces)
        .map((face) => string(record(face).oracle_text))
        .filter(Boolean)
        .join("\n\n"),
    prices: [
      ...price(
        rawPrices.usd,
        "USD",
        "TCGplayer via Scryfall · nonfoil",
        retrievedAt,
      ),
      ...price(
        rawPrices.usd_foil,
        "USD",
        "TCGplayer via Scryfall · foil",
        retrievedAt,
      ),
      ...price(
        rawPrices.usd_etched,
        "USD",
        "TCGplayer via Scryfall · etched foil",
        retrievedAt,
      ),
      ...price(
        rawPrices.eur,
        "EUR",
        "Cardmarket via Scryfall · nonfoil",
        retrievedAt,
      ),
      ...price(
        rawPrices.eur_foil,
        "EUR",
        "Cardmarket via Scryfall · foil",
        retrievedAt,
      ),
      ...price(
        rawPrices.eur_etched,
        "EUR",
        "Cardmarket via Scryfall · etched foil",
        retrievedAt,
      ),
    ],
  };
}
function pokemonCard(value: unknown, retrievedAt: string): Card {
  const { row, id, name } = identity(value, "pokemon");
  const set = record(row.set);
  const pricing = record(row.pricing);
  const tcgplayer = record(pricing.tcgplayer);
  const cardmarket = record(pricing.cardmarket);
  const prices: CardPrice[] = [];
  // Ignore currencies other than the documented units, instead of silently relabeling them.
  if (!tcgplayer.unit || tcgplayer.unit === "USD") {
    for (const [variant, label] of [
      ["normal", "normal"],
      ["holo", "holo"],
      ["reverse", "reverse holo"],
      ["firstEditionHolofoil", "first edition holo"],
      ["firstEditionNormal", "first edition normal"],
    ]) {
      prices.push(
        ...price(
          record(tcgplayer[variant]).marketPrice,
          "USD",
          `TCGplayer via TCGdex · ${label} market`,
          retrievedAt,
          tcgplayer.updated,
          "Catalog variant estimate; verify edition and condition.",
        ),
      );
    }
  }
  if (!cardmarket.unit || cardmarket.unit === "EUR") {
    prices.push(
      ...price(
        cardmarket.trend,
        "EUR",
        "Cardmarket via TCGdex · trend",
        retrievedAt,
        cardmarket.updated,
        "Trend estimate; verify edition, finish and condition.",
      ),
    );
    prices.push(
      ...price(
        cardmarket["trend-holo"],
        "EUR",
        "Cardmarket via TCGdex · holo trend",
        retrievedAt,
        cardmarket.updated,
        "Trend estimate; verify edition and condition.",
      ),
    );
  }
  const image = safeUrl(row.image, ["assets.tcgdex.net"]);
  const setCode = string(set.id) || id.slice(0, id.lastIndexOf("-"));
  return {
    id,
    name,
    game: "pokemon",
    provider: "TCGdex",
    setName: text(
      set.name,
      setCode
        ? `${setCode.toUpperCase()} · select for details`
        : "Select for set details",
    ),
    setCode,
    number: string(row.localId),
    rarity: text(row.rarity, "Select for details"),
    imageUrl: image ? `${image.replace(/\/$/, "")}/high.webp` : undefined,
    sourceUrl: `${BASE.pokemon}/${encodeURIComponent(id)}`,
    description: string(row.description),
    prices,
  };
}
function yugiohCard(value: unknown, retrievedAt: string): Card {
  const { row, id, name } = identity(value, "yugioh");
  const sets = array(row.card_sets);
  const onlySet = sets.length === 1 ? record(sets[0]) : {};
  const values = record(array(row.card_prices)[0]);
  const note =
    "Lowest across multiple versions, not a verified price for your printing or condition.";
  return {
    id,
    name,
    game: "yugioh",
    provider: "YGOPRODeck",
    setName:
      sets.length > 1
        ? "Multiple printings · verify edition"
        : text(onlySet.set_name, "Printing not specified"),
    setCode: string(onlySet.set_code),
    number: id,
    rarity: text(onlySet.set_rarity, "Varies by printing"),
    // YGOPRODeck prohibits continual hotlinking. This browser-only build intentionally omits art.
    sourceUrl:
      safeUrl(row.ygoprodeck_url, ["ygoprodeck.com", "db.ygoprodeck.com"]) ??
      `${BASE.yugioh}?id=${encodeURIComponent(id)}`,
    description: [
      string(row.desc),
      "Artwork omitted to respect YGOPRODeck’s image-hosting policy.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    prices: [
      ...price(
        values.tcgplayer_price,
        "USD",
        "TCGplayer via YGOPRODeck · lowest",
        retrievedAt,
        undefined,
        note,
      ),
      ...price(
        values.cardmarket_price,
        "EUR",
        "Cardmarket via YGOPRODeck · lowest",
        retrievedAt,
        undefined,
        note,
      ),
      ...price(
        values.ebay_price,
        "USD",
        "eBay via YGOPRODeck · lowest",
        retrievedAt,
        undefined,
        note,
      ),
      ...price(
        values.amazon_price,
        "USD",
        "Amazon via YGOPRODeck · lowest",
        retrievedAt,
        undefined,
        note,
      ),
      ...price(
        values.coolstuffinc_price,
        "USD",
        "CoolStuffInc via YGOPRODeck · lowest",
        retrievedAt,
        undefined,
        note,
      ),
    ],
  };
}
const normalizers = { mtg: mtgCard, pokemon: pokemonCard, yugioh: yugiohCard };

function validCachedCard(value: unknown): value is Card {
  const row = record(value);
  if (!["pokemon", "mtg", "yugioh"].includes(string(row.game))) return false;
  if (
    ![
      "id",
      "name",
      "setName",
      "setCode",
      "number",
      "rarity",
      "sourceUrl",
      "provider",
    ].every((key) => typeof row[key] === "string")
  )
    return false;
  if (
    !safeUrl(row.sourceUrl, [
      "scryfall.com",
      "api.scryfall.com",
      "api.tcgdex.net",
      "ygoprodeck.com",
      "db.ygoprodeck.com",
    ])
  )
    return false;
  if (row.game === "yugioh" && row.imageUrl !== undefined) return false;
  if (
    row.imageUrl !== undefined &&
    !safeUrl(row.imageUrl, ["cards.scryfall.io", "assets.tcgdex.net"])
  )
    return false;
  return (
    Array.isArray(row.prices) &&
    row.prices.every((item) => {
      const p = record(item);
      return (
        typeof p.amount === "number" &&
        amount(p.amount) !== undefined &&
        ["USD", "EUR"].includes(string(p.currency)) &&
        typeof p.source === "string" &&
        typeof p.updatedAt === "string" &&
        Number.isFinite(Date.parse(p.updatedAt)) &&
        (p.note === undefined || typeof p.note === "string")
      );
    }) &&
    (row.description === undefined || typeof row.description === "string")
  );
}
function readCache(key: string): Card[] | undefined {
  if (!cacheLoaded) {
    cacheLoaded = true;
    try {
      const raw = globalThis.localStorage?.getItem(CACHE_KEY);
      if (raw && raw.length <= 1_000_000) {
        const stored: unknown = JSON.parse(raw);
        for (const value of array(stored).slice(-80)) {
          const item = record(value);
          if (
            typeof item.key === "string" &&
            typeof item.expires === "number" &&
            item.expires > Date.now() &&
            item.expires <= Date.now() + 2 * DAY &&
            Array.isArray(item.cards) &&
            item.cards.length <= LIMIT &&
            item.cards.every(validCachedCard)
          ) {
            cache.set(item.key, { expires: item.expires, cards: item.cards });
          }
        }
      }
    } catch {
      /* Private mode, full storage or malformed cache must not break a lookup. */
    }
  }
  const value = cache.get(key);
  if (!value || value.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return structuredClone(value.cards);
}
function saveCache(key: string, cards: Card[], game: Game): void {
  cache.delete(key);
  cache.set(key, {
    expires: Date.now() + (game === "yugioh" ? 2 : 1) * DAY,
    cards: structuredClone(cards),
  });
  while (cache.size > 80) cache.delete(cache.keys().next().value!);
}
function persistCache(): void {
  try {
    let stored = [...cache]
      .filter(([, value]) => value.expires > Date.now())
      .map(([key, value]) => ({ key, ...value }))
      .slice(-40);
    while (JSON.stringify(stored).length > 1_000_000) stored = stored.slice(1);
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(stored));
  } catch {
    /* In-memory caching remains available when persistent storage is blocked. */
  }
}
function input(value: string, game: Game): string {
  const result = value.trim();
  if (result.length > 200)
    throw new CatalogError(
      "invalid-query",
      game,
      "Use a card name or ID under 200 characters.",
    );
  return result;
}
function listPayload(result: ApiResult, game: Game, query: string): Card[] {
  const rows = game === "pokemon" ? result.data : record(result.data).data;
  if (!Array.isArray(rows))
    throw new CatalogError(
      "invalid-response",
      game,
      "The service returned an unexpected result format. Please try again later.",
    );
  // Prefer exact names within the returned page before applying the UI cap.
  // For example, "Lightning Bolt" should precede cards that merely mention it in their name.
  const exact = (row: unknown) =>
    string(record(row).name).toLocaleLowerCase("en") ===
    query.toLocaleLowerCase("en");
  const ordered = [...rows.filter(exact), ...rows.filter((row) => !exact(row))];
  return ordered
    .slice(0, LIMIT)
    .map((row) => normalizers[game](row, result.retrievedAt));
}

/** Returns up to 12 candidates. Pokémon name searches are summaries; call getCard on selection. */
export async function searchCards(
  game: Game,
  query: string,
  signal?: AbortSignal,
): Promise<Card[]> {
  checkSignal(signal);
  const trimmed = input(query, game);
  if (!trimmed) return [];
  const key = `search:${game}:${trimmed}`;
  const cached = readCache(key);
  if (cached) return cached;
  let cards: Card[];
  try {
    const looksLikeId =
      game === "mtg"
        ? /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(trimmed)
        : game === "pokemon"
          ? /^[a-z\d.]+-[a-z]*\d+[a-z\d]*$/i.test(trimmed)
          : /^\d{1,8}$/.test(trimmed);
    if (looksLikeId) cards = [await getCard(game, trimmed, signal)];
    else {
      const url = new URL(game === "mtg" ? `${BASE.mtg}/search` : BASE[game]);
      const params =
        game === "mtg"
          ? { q: trimmed, unique: "prints", order: "name" }
          : game === "pokemon"
            ? {
                name: trimmed,
                "pagination:page": "1",
                "pagination:itemsPerPage": String(LIMIT),
              }
            : { fname: trimmed, num: String(LIMIT), offset: "0" };
      for (const [name, value] of Object.entries(params))
        if (value !== undefined) url.searchParams.set(name, value);
      cards = listPayload(await request(game, url.href, signal), game, trimmed);
    }
  } catch (error) {
    if (error instanceof CatalogError && error.code === "not-found") cards = [];
    else throw error;
  }
  checkSignal(signal);
  saveCache(key, cards, game);
  if (game !== "pokemon")
    for (const card of cards)
      saveCache(`card:${game}:${card.id}`, [card], game);
  persistCache();
  return cards;
}

/** Fetches a full catalog card, including real provider prices when available. */
export async function getCard(
  game: Game,
  id: string,
  signal?: AbortSignal,
): Promise<Card> {
  checkSignal(signal);
  const trimmed = input(id, game);
  if (
    !trimmed ||
    !/^[a-z\d._-]+$/i.test(trimmed) ||
    (game === "yugioh" && !/^\d{1,8}$/.test(trimmed))
  ) {
    throw new CatalogError(
      "invalid-query",
      game,
      "Select a valid catalog card ID.",
    );
  }
  const key = `card:${game}:${trimmed}`;
  const cached = readCache(key);
  if (cached?.[0]) return cached[0];
  const url =
    game === "yugioh"
      ? `${BASE.yugioh}?id=${encodeURIComponent(trimmed)}`
      : `${BASE[game]}/${encodeURIComponent(trimmed)}`;
  const result = await request(game, url, signal);
  const raw =
    game === "yugioh" ? array(record(result.data).data)[0] : result.data;
  const card = normalizers[game](raw, result.retrievedAt);
  checkSignal(signal);
  saveCache(key, [card], game);
  persistCache();
  return card;
}
