import type { Card, Finish, Game } from "../types";

/** Provider estimates are not an appraisal of the condition of a physical copy. */
export type PriceFinish = Finish | "Etched foil" | "Unknown";
export type PriceVariant =
  | "normal"
  | "foil"
  | "reverse-holo"
  | "etched-foil"
  | "first-edition-normal"
  | "first-edition-foil"
  | "unlimited-normal"
  | "unlimited-foil"
  | "unspecified";
export interface PriceIdentity {
  cardId: string;
  game: Game;
  name: string;
  setCode: string;
  number: string;
  rarity: string;
}
export interface PriceQuote {
  amount: number;
  currency: "USD" | "EUR";
  source: string;
  sourceUrl: string;
  variant: PriceVariant;
  /** Catalog quotes may span several printings or unresolved editions. */
  scope: "printing" | "catalog";
  providerUpdatedAt?: string;
  note: string;
  variantId?: string;
}
export interface PriceSnapshot {
  cardId: string;
  game: Game;
  identity: PriceIdentity;
  finish?: PriceFinish;
  quotes: PriceQuote[];
  /** Null means no successful provider response has been received. */
  fetchedAt: string | null;
  expiresAt: string | null;
  freshness: "fresh" | "stale" | "unavailable";
  status: "live" | "cached" | "stale" | "offline" | "unavailable";
  refreshing: boolean;
  error?: string;
  retryAt?: string;
}
export interface PriceOptions {
  signal?: AbortSignal;
  /** Await a fresh response instead of returning the cached value first. */
  force?: boolean;
  finish?: PriceFinish;
  /** Exact TCGdex variants_detailed ID, when explicitly resolved. */
  variantId?: string;
  onUpdate?: (snapshot: PriceSnapshot) => void;
}
export interface CachedPriceOptions {
  game?: Game;
  finish?: PriceFinish;
  variantId?: string;
  /** Disambiguates different Yu-Gi-Oh printings of the same passcode. */
  setCode?: string;
  rarity?: string;
}
export interface PricingClient {
  getPriceSnapshot(card: Card, options?: PriceOptions): Promise<PriceSnapshot>;
  readCachedPriceSnapshot(
    cardId: string,
    options?: CachedPriceOptions,
  ): PriceSnapshot | null;
}
export interface PricingDependencies {
  fetch?: typeof globalThis.fetch;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  isOnline?: () => boolean;
}

type JsonObject = Record<string, unknown>;
interface StoredSnapshot {
  identity: PriceIdentity;
  quotes: PriceQuote[];
  fetchedAt: string;
  expiresAt: string;
}
interface Failure {
  message: string;
  retryAt: number;
}
const DAY = 86_400_000;
const CACHE_KEY = "tcg-scan:price-cache:v1";
const MAX_AGE = 90 * DAY;
const MAX_CACHE = 200;
const PROVIDER: Record<Game, string> = {
  pokemon: "TCGdex",
  mtg: "Scryfall",
  yugioh: "YGOPRODeck",
};
const INTERVAL: Record<Game, number> = { pokemon: 250, mtg: 600, yugioh: 250 };
const TTL: Record<Game, number> = { pokemon: DAY, mtg: DAY, yugioh: 2 * DAY };
const VARIANTS: PriceVariant[] = [
  "normal",
  "foil",
  "reverse-holo",
  "etched-foil",
  "first-edition-normal",
  "first-edition-foil",
  "unlimited-normal",
  "unlimited-foil",
  "unspecified",
];
const FINISH_VARIANT: Record<PriceFinish, PriceVariant> = {
  Unknown: "unspecified",
  Normal: "normal",
  Foil: "foil",
  "Reverse holo": "reverse-holo",
  "Etched foil": "etched-foil",
};
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function positive(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))
  )
    return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
function date(value: unknown): string | undefined {
  const valueString = string(value);
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(valueString) &&
    Number.isFinite(Date.parse(valueString))
    ? valueString
    : undefined;
}
function identity(card: Card): PriceIdentity {
  return {
    cardId: card.id,
    game: card.game,
    name: card.name,
    setCode: card.setCode,
    number: card.number,
    rarity: card.rarity,
  };
}
function compatibleIdentity(
  requested: PriceIdentity,
  canonical: PriceIdentity,
): boolean {
  if (
    requested.game !== canonical.game ||
    requested.cardId !== canonical.cardId
  )
    return false;
  if (requested.game === "yugioh")
    return (
      requested.setCode === canonical.setCode &&
      requested.rarity === canonical.rarity
    );
  return (
    (!requested.setCode || requested.setCode === canonical.setCode) &&
    (!requested.number || requested.number === canonical.number)
  );
}
function identityKey(value: PriceIdentity): string {
  // YGO passcodes do not identify a set/rarity. Never reuse another printing's set quote.
  return JSON.stringify([
    value.game,
    value.cardId,
    value.game === "yugioh" ? value.setCode : "",
    value.game === "yugioh" ? value.rarity : "",
  ]);
}
function sourceUrl(game: Game, id: string): string {
  if (game === "pokemon")
    return `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(id)}`;
  if (game === "mtg")
    return `https://api.scryfall.com/cards/${encodeURIComponent(id)}`;
  return `https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${encodeURIComponent(id)}`;
}
function safeSourceUrl(value: unknown): boolean {
  try {
    const url = new URL(string(value));
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["api.tcgdex.net", "api.scryfall.com", "db.ygoprodeck.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
function abortError(): DOMException {
  return new DOMException("The price lookup was cancelled.", "AbortError");
}
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
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
class PriceRequestError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

function normalize(card: Card, payload: unknown, now: number): StoredSnapshot {
  const outer = object(payload);
  const row =
    card.game === "yugioh"
      ? object(
          array(outer.data).find((item) => String(object(item).id) === card.id),
        )
      : outer;
  if (String(row.id ?? "") !== card.id || !string(row.name))
    throw new PriceRequestError(
      `${PROVIDER[card.game]} returned a different or incomplete card identity.`,
    );
  if (
    card.game === "mtg" &&
    ((card.setCode && string(row.set) !== card.setCode) ||
      (card.number && string(row.collector_number) !== card.number))
  )
    throw new PriceRequestError("Scryfall returned a different printing.");
  if (
    card.game === "pokemon" &&
    ((card.setCode && string(object(row.set).id) !== card.setCode) ||
      (card.number && String(row.localId ?? "") !== card.number))
  )
    throw new PriceRequestError("TCGdex returned a different printing.");
  const quotes: PriceQuote[] = [];
  const url = sourceUrl(card.game, card.id);
  const add = (
    value: unknown,
    currency: PriceQuote["currency"],
    source: string,
    variant: PriceVariant,
    scope: PriceQuote["scope"],
    note: string,
    updated?: unknown,
    variantId?: string,
  ) => {
    const amount = positive(value);
    if (amount === undefined) return;
    const providerUpdatedAt = date(updated);
    quotes.push({
      amount,
      currency,
      source,
      sourceUrl: url,
      variant,
      scope,
      providerUpdatedAt,
      variantId,
      note: `${note} ${providerUpdatedAt ? "Provider-reported price update time is shown separately from retrieval time." : "The provider did not supply a price-update time."}`,
    });
  };
  if (card.game === "mtg") {
    const prices = object(row.prices);
    const fields: [string, PriceQuote["currency"], PriceVariant, string][] = [
      ["usd", "USD", "normal", "TCGplayer"],
      ["usd_foil", "USD", "foil", "TCGplayer"],
      ["usd_etched", "USD", "etched-foil", "TCGplayer"],
      ["eur", "EUR", "normal", "Cardmarket"],
      ["eur_foil", "EUR", "foil", "Cardmarket"],
    ];
    // MTGO tickets and undocumented currency/finish fields are intentionally excluded.
    for (const [field, currency, variant, market] of fields)
      add(
        prices[field],
        currency,
        `${market} via Scryfall · ${variant}`,
        variant,
        "printing",
        "Printing/finish reference estimate; physical condition is not priced.",
      );
  } else if (card.game === "pokemon") {
    const details = array(row.variants_detailed);
    const pricing = object(row.pricing);
    // Missing detailed metadata is not evidence that the root quote identifies a physical edition.
    const scope = "catalog";
    const note =
      "Catalog reference; edition/subvariant is unresolved. Verify the printing and physical condition.";
    const player = object(pricing.tcgplayer);
    const mappings: [string[], PriceVariant][] = [
      [["normal"], "normal"],
      [["holo", "holofoil"], "foil"],
      [["reverse", "reverse-holofoil"], "reverse-holo"],
      [["firstEditionNormal", "1st-edition"], "first-edition-normal"],
      [["firstEditionHolofoil", "1st-edition-holofoil"], "first-edition-foil"],
      [["unlimited"], "unlimited-normal"],
      [["unlimited-holofoil"], "unlimited-foil"],
    ];
    if (!player.unit || player.unit === "USD") {
      for (const [aliases, variant] of mappings) {
        const field = aliases.find((key) => Object.hasOwn(player, key));
        if (field)
          add(
            object(player[field]).marketPrice,
            "USD",
            `TCGplayer via TCGdex · ${variant} market`,
            variant,
            scope,
            note,
            player.updated,
          );
      }
    }
    const market = object(pricing.cardmarket);
    if (!market.unit || market.unit === "EUR") {
      add(
        market.trend,
        "EUR",
        "Cardmarket via TCGdex · standard trend",
        "unspecified",
        "catalog",
        "Provider standard-price bucket; finish and edition are not resolved.",
        market.updated,
      );
      // Cardmarket's generic holo bucket does not distinguish regular and reverse holo.
      add(
        market["trend-holo"],
        "EUR",
        "Cardmarket via TCGdex · holo trend",
        "unspecified",
        "catalog",
        "Holo reference; regular/reverse finish and edition are not resolved.",
        market.updated,
      );
    }
    // Detailed edition mappings are deliberately not inferred from names or array order.
    // Exact variants can be added only when the provider explicitly attaches pricing to that ID.
    for (const value of details) {
      const detail = object(value);
      const variantId = string(detail.variantId);
      if (!variantId) continue;
      const detailPricing = object(detail.pricing);
      const detailPlayer = object(detailPricing.tcgplayer);
      const finish = (
        { normal: "normal", holo: "foil", reverse: "reverse-holo" } as Record<
          string,
          PriceVariant
        >
      )[string(detail.type)];
      for (const [aliases, variant] of mappings) {
        if (
          (detailPlayer.unit && detailPlayer.unit !== "USD") ||
          !finish ||
          (variant !== finish && !variant.endsWith(`-${finish}`))
        )
          continue;
        const field = aliases.find((key) => Object.hasOwn(detailPlayer, key));
        if (field)
          add(
            object(detailPlayer[field]).marketPrice,
            "USD",
            `TCGplayer via TCGdex · ${variantId} · ${variant} market`,
            variant,
            "printing",
            "Explicit provider subvariant; physical condition is not priced.",
            detailPlayer.updated,
            variantId,
          );
      }
      const detailMarket = object(detailPricing.cardmarket);
      if (!detailMarket.unit || detailMarket.unit === "EUR") {
        for (const [field, label] of [
          ["trend", "standard trend"],
          ["trend-holo", "holo trend"],
        ]) {
          add(
            detailMarket[field],
            "EUR",
            `Cardmarket via TCGdex · ${variantId} · ${label}`,
            "unspecified",
            "printing",
            "Explicit provider subvariant and price bucket; the bucket does not establish regular/reverse finish or physical condition.",
            detailMarket.updated,
            variantId,
          );
        }
      }
    }
  } else {
    const sets = array(row.card_sets)
      .map(object)
      .filter(
        (set) =>
          string(set.set_code) === card.setCode &&
          string(set.set_rarity) === card.rarity,
      );
    if (card.setCode && card.rarity && sets.length === 1) {
      add(
        sets[0].set_price,
        "USD",
        "YGOPRODeck · set reference",
        "unspecified",
        "printing",
        "Set code and rarity match. Edition, condition and finish are not independently verified.",
      );
    }
    const prices = object(array(row.card_prices)[0]);
    const fields: [string, PriceQuote["currency"], string][] = [
      ["tcgplayer_price", "USD", "TCGplayer"],
      ["cardmarket_price", "EUR", "Cardmarket"],
      ["ebay_price", "USD", "eBay"],
      ["amazon_price", "USD", "Amazon"],
      ["coolstuffinc_price", "USD", "CoolStuffInc"],
    ];
    for (const [field, currency, market] of fields)
      add(
        prices[field],
        currency,
        `${market} via YGOPRODeck · catalog lowest`,
        "unspecified",
        "catalog",
        "Lowest across card versions, not an exact printing/finish/condition valuation. YGOPRODeck may cache provider data for two days.",
      );
  }
  const canonical = identity(card);
  canonical.name = string(row.name);
  if (card.game === "mtg") {
    canonical.setCode = string(row.set);
    canonical.number = string(row.collector_number);
  } else if (card.game === "pokemon") {
    canonical.setCode = string(object(row.set).id);
    canonical.number = String(row.localId ?? "");
  }
  return {
    identity: canonical,
    quotes,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL[card.game]).toISOString(),
  };
}

function selectedQuotes(
  stored: StoredSnapshot,
  options: Pick<PriceOptions, "finish" | "variantId">,
): PriceQuote[] {
  return stored.quotes.filter((quote) => {
    if (
      options.variantId
        ? quote.variantId !== options.variantId
        : quote.variantId !== undefined
    )
      return false;
    if (!options.finish || options.finish === "Unknown") return true;
    if (stored.identity.game === "yugioh") return true; // Remains visibly unverified in scope and note.
    const variant = FINISH_VARIANT[options.finish];
    return (
      quote.variant === variant ||
      (!!options.variantId && quote.variant.endsWith(`-${variant}`))
    );
  });
}
function validStored(value: unknown, now: number): value is StoredSnapshot {
  const row = object(value),
    card = object(row.identity);
  if (
    !["pokemon", "mtg", "yugioh"].includes(string(card.game)) ||
    !["cardId", "name", "setCode", "number", "rarity"].every(
      (key) => typeof card[key] === "string",
    ) ||
    !card.cardId
  )
    return false;
  const fetched = date(row.fetchedAt),
    expires = date(row.expiresAt);
  if (
    !fetched ||
    !expires ||
    Date.parse(fetched) > now + 300_000 ||
    Date.parse(fetched) < now - MAX_AGE ||
    Date.parse(expires) !== Date.parse(fetched) + TTL[card.game as Game]
  )
    return false;
  return (
    Array.isArray(row.quotes) &&
    row.quotes.length <= 80 &&
    row.quotes.every((value) => {
      const quote = object(value);
      return (
        typeof quote.amount === "number" &&
        positive(quote.amount) !== undefined &&
        ["USD", "EUR"].includes(string(quote.currency)) &&
        typeof quote.source === "string" &&
        safeSourceUrl(quote.sourceUrl) &&
        quote.sourceUrl ===
          sourceUrl(card.game as Game, card.cardId as string) &&
        VARIANTS.includes(quote.variant as PriceVariant) &&
        ["printing", "catalog"].includes(string(quote.scope)) &&
        !(
          card.game === "pokemon" &&
          quote.scope === "printing" &&
          !quote.variantId
        ) &&
        !(
          card.game === "yugioh" &&
          quote.scope === "printing" &&
          quote.source !== "YGOPRODeck · set reference"
        ) &&
        typeof quote.note === "string" &&
        (quote.providerUpdatedAt === undefined ||
          date(quote.providerUpdatedAt) !== undefined) &&
        (quote.variantId === undefined || typeof quote.variantId === "string")
      );
    })
  );
}

/** Isolated clients make cache/network behavior deterministic without changing browser globals. */
export function createPricingClient(
  dependencies: PricingDependencies = {},
): PricingClient {
  const now = dependencies.now ?? (() => Date.now());
  const online =
    dependencies.isOnline ??
    (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const cache = new Map<string, StoredSnapshot>();
  const inFlight = new Map<string, Promise<unknown>>();
  const refreshes = new Map<string, Promise<StoredSnapshot>>();
  const failures = new Map<string, Failure>();
  const queues: Partial<Record<Game, Promise<void>>> = {};
  const lastRequest: Partial<Record<Game, number>> = {};
  const cooldown: Partial<Record<Game, number>> = {};
  let loaded = false;
  const storage = () => {
    try {
      return dependencies.storage !== undefined
        ? dependencies.storage
        : globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = storage()?.getItem(CACHE_KEY);
      if (!raw || raw.length > 2_000_000) return;
      for (const entry of array(JSON.parse(raw)).slice(-MAX_CACHE))
        if (validStored(entry, now()))
          cache.set(identityKey(entry.identity), entry);
    } catch {
      /* Storage permissions and damaged caches never prevent a price lookup. */
    }
  }
  function save(stored: StoredSnapshot) {
    const key = identityKey(stored.identity);
    cache.delete(key);
    cache.set(key, structuredClone(stored));
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    try {
      let entries = [...cache.values()].filter(
        (item) => Date.parse(item.fetchedAt) >= now() - MAX_AGE,
      );
      while (JSON.stringify(entries).length > 2_000_000)
        entries = entries.slice(1);
      storage()?.setItem(CACHE_KEY, JSON.stringify(entries));
    } catch {
      /* In-memory caching remains available in private mode or with full storage. */
    }
  }
  function snapshot(
    card: PriceIdentity,
    stored: StoredSnapshot | undefined,
    options: Pick<PriceOptions, "finish" | "variantId">,
    status?: PriceSnapshot["status"],
    error?: Failure,
  ): PriceSnapshot {
    // Recheck every cached/shared result: caller-supplied metadata must never relabel another printing's quotes.
    if (stored && !compatibleIdentity(card, stored.identity)) {
      stored = undefined;
      status = "unavailable";
      error = {
        message:
          "The requested printing conflicts with the cached provider identity. No price was applied.",
        retryAt: now(),
      };
    }
    const quotes = stored ? selectedQuotes(stored, options) : [];
    const stale = !!stored && Date.parse(stored.expiresAt) <= now();
    return structuredClone({
      cardId: card.cardId,
      game: card.game,
      identity: stored?.identity ?? card,
      finish: options.finish,
      quotes,
      fetchedAt: stored?.fetchedAt ?? null,
      expiresAt: stored?.expiresAt ?? null,
      freshness: quotes.length ? (stale ? "stale" : "fresh") : "unavailable",
      status:
        status ?? (!quotes.length ? "unavailable" : stale ? "stale" : "cached"),
      refreshing: false,
      ...(error
        ? {
            error: error.message,
            retryAt: new Date(error.retryAt).toISOString(),
          }
        : {}),
    });
  }
  async function slot(game: Game): Promise<void> {
    const scheduled = (queues[game] ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if ((cooldown[game] ?? 0) > now())
          throw new PriceRequestError(
            `${PROVIDER[game]} asked us to pause requests.`,
            cooldown[game],
          );
        const delay = Math.max(
          0,
          (lastRequest[game] ?? -Infinity) + INTERVAL[game] - now(),
        );
        if (delay)
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if ((cooldown[game] ?? 0) > now())
          throw new PriceRequestError(
            `${PROVIDER[game]} asked us to pause requests.`,
            cooldown[game],
          );
        lastRequest[game] = now();
      });
    queues[game] = scheduled.catch(() => undefined);
    return scheduled;
  }
  async function request(card: Card): Promise<unknown> {
    const requestKey = `${card.game}:${card.id}`;
    const pending = inFlight.get(requestKey);
    if (pending) return pending;
    const work = (async () => {
      await slot(card.game);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new PriceRequestError(
                `${PROVIDER[card.game]} price lookup timed out.`,
              ),
            );
          }, 15_000);
        });
        const response = await Promise.race([
          (dependencies.fetch ?? globalThis.fetch)(
            sourceUrl(card.game, card.id),
            {
              signal: controller.signal,
              credentials: "omit",
              referrerPolicy: "no-referrer",
              headers: { Accept: "application/json" },
            },
          ),
          timedOut,
        ]);
        if (response.status === 429) {
          const value = response.headers.get("Retry-After")?.trim();
          const fallback = card.game === "yugioh" ? 3_600_000 : 60_000;
          const seconds =
            value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
          const at =
            value && !/^[-+]?\d+(?:\.\d+)?$/.test(value)
              ? Date.parse(value)
              : NaN;
          const wait = Number.isFinite(seconds)
            ? seconds
            : Number.isFinite(at) && at > now()
              ? at - now()
              : fallback;
          // Provider headers are untrusted. Bound the pause to a serializable date and never retry-loop on past dates.
          cooldown[card.game] =
            now() + Math.min(30 * DAY, Math.max(1_000, wait));
          throw new PriceRequestError(
            `${PROVIDER[card.game]} rate limit reached. Cached prices are retained; no automatic retry was sent.`,
            cooldown[card.game],
          );
        }
        if (!response.ok)
          throw new PriceRequestError(
            `${PROVIDER[card.game]} price lookup returned HTTP ${response.status}.`,
          );
        try {
          return await Promise.race([response.json(), timedOut]);
        } catch (error) {
          if (error instanceof PriceRequestError) throw error;
          throw new PriceRequestError(
            `${PROVIDER[card.game]} returned unreadable price data.`,
          );
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    })();
    inFlight.set(requestKey, work);
    void work.then(
      () => inFlight.delete(requestKey),
      () => inFlight.delete(requestKey),
    );
    return work;
  }
  function refresh(card: Card): Promise<StoredSnapshot> {
    const key = identityKey(identity(card));
    const pending = refreshes.get(key);
    if (pending) return pending;
    const work = request(card)
      .then((payload) => {
        const result = normalize(card, payload, now());
        save(result);
        failures.delete(key);
        return result;
      })
      .catch((error) => {
        failures.set(key, {
          message:
            error instanceof Error
              ? error.message
              : "Could not refresh prices. Check your connection.",
          retryAt:
            error instanceof PriceRequestError && error.retryAt
              ? error.retryAt
              : now() + 30_000,
        });
        throw error;
      });
    refreshes.set(key, work);
    void work.then(
      () => refreshes.delete(key),
      () => refreshes.delete(key),
    );
    return work;
  }
  return {
    readCachedPriceSnapshot(cardId, options = {}) {
      load();
      const matches = [...cache.values()].filter(
        (item) =>
          item.identity.cardId === cardId &&
          (!options.game || item.identity.game === options.game) &&
          (item.identity.game !== "yugioh" ||
            !item.identity.setCode ||
            (options.setCode !== undefined && options.rarity !== undefined)) &&
          (options.setCode === undefined ||
            item.identity.setCode === options.setCode) &&
          (options.rarity === undefined ||
            item.identity.rarity === options.rarity),
      );
      // An ambiguous passcode must not silently return another physical printing.
      if (matches.length !== 1) return null;
      const stored = matches[0];
      return snapshot(
        stored.identity,
        stored,
        options,
        online() ? undefined : "offline",
        failures.get(identityKey(stored.identity)),
      );
    },
    async getPriceSnapshot(card, options = {}) {
      if (options.signal?.aborted) throw abortError();
      load();
      const id = identity(card),
        key = identityKey(id),
        stored = cache.get(key);
      if (stored && !compatibleIdentity(id, stored.identity))
        return snapshot(id, stored, options);
      if (!online())
        return snapshot(id, stored, options, "offline", {
          message: "Offline. Showing the last saved estimate when available.",
          retryAt: now(),
        });
      const failed = failures.get(key);
      const providerPause =
        (cooldown[card.game] ?? 0) > now()
          ? {
              message: `${PROVIDER[card.game]} asked us to pause requests.`,
              retryAt: cooldown[card.game]!,
            }
          : undefined;
      if (providerPause || (failed && failed.retryAt > now()))
        return snapshot(
          id,
          stored,
          options,
          stored
            ? Date.parse(stored.expiresAt) <= now()
              ? "stale"
              : "cached"
            : "unavailable",
          providerPause ?? failed,
        );
      if (stored && Date.parse(stored.expiresAt) > now() && !options.force)
        return snapshot(id, stored, options);
      const result = refresh(card).then(
        (value) =>
          snapshot(
            id,
            value,
            options,
            selectedQuotes(value, options).length ? "live" : "unavailable",
          ),
        () =>
          snapshot(id, cache.get(key), options, undefined, failures.get(key)),
      );
      // A caller abort affects only its subscription, not another caller sharing this fetch.
      if (stored && !options.force) {
        void result
          .then((value) => {
            if (!options.signal?.aborted) options.onUpdate?.(value);
          })
          .catch(() => undefined);
        return { ...snapshot(id, stored, options), refreshing: true };
      }
      return withSignal(result, options.signal);
    },
  };
}

let defaultClient: PricingClient | undefined;
function client(): PricingClient {
  return (defaultClient ??= createPricingClient());
}
export function getPriceSnapshot(
  card: Card,
  options?: PriceOptions,
): Promise<PriceSnapshot> {
  return client().getPriceSnapshot(card, options);
}
export function readCachedPriceSnapshot(
  cardId: string,
  options?: CachedPriceOptions,
): PriceSnapshot | null {
  return client().readCachedPriceSnapshot(cardId, options);
}
