import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../types";
import { createPricingClient } from "./pricing";
import type { PriceSnapshot, PricingDependencies } from "./pricing";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const DAY = 86_400_000;
const MTG_ID = "f58dba4f-1abb-47a3-a684-29c32bab95c0";
const mtg: Card = {
  id: MTG_ID,
  game: "mtg",
  name: "Lightning Bolt",
  setName: "Magic 2010",
  setCode: "m10",
  number: "146",
  rarity: "common",
  sourceUrl: "https://scryfall.com/card/m10/146",
  provider: "Scryfall",
  prices: [],
};
const pokemon: Card = {
  id: "swsh3-136",
  game: "pokemon",
  name: "Furret",
  setName: "Darkness Ablaze",
  setCode: "swsh3",
  number: "136",
  rarity: "Uncommon",
  sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
  provider: "TCGdex",
  prices: [],
};
const yugioh: Card = {
  id: "46986414",
  game: "yugioh",
  name: "Dark Magician",
  setName: "Multiple printings",
  setCode: "",
  number: "46986414",
  rarity: "Varies by printing",
  sourceUrl: "https://ygoprodeck.com/card/dark-magician-4003",
  provider: "YGOPRODeck",
  prices: [],
};
const mtgPayload = {
  id: MTG_ID,
  name: "Lightning Bolt",
  set: "m10",
  collector_number: "146",
  released_at: "2009-07-17",
  prices: {
    usd: "1.86",
    usd_foil: "7.53",
    usd_etched: "12.01",
    eur: "1.33",
    eur_foil: "5.50",
    eur_etched: "8.00",
    tix: "0.60",
  },
};
const pokemonPayload = {
  id: "swsh3-136",
  name: "Furret",
  set: { id: "swsh3" },
  localId: "136",
  updated: "2020-01-01T00:00:00.000Z",
  pricing: {
    tcgplayer: {
      unit: "USD",
      updated: "2026-10-12T10:00:00.000Z",
      normal: { marketPrice: 0.27 },
      holofoil: { marketPrice: 1.28 },
      "reverse-holofoil": { marketPrice: 0.36 },
    },
    cardmarket: {
      unit: "EUR",
      updated: "2026-10-12T01:00:00.000Z",
      trend: 0.31,
      "trend-holo": 0.39,
    },
  },
};
const yugiohPayload = {
  data: [
    {
      id: 46986414,
      name: "Dark Magician",
      card_sets: [
        { set_code: "SBCB-EN001", set_rarity: "Common", set_price: "1.55" },
        {
          set_code: "SBCB-EN001",
          set_rarity: "Secret Rare",
          set_price: "6.53",
        },
        { set_code: "ZERO-EN001", set_rarity: "Common", set_price: "0.00" },
      ],
      card_prices: [
        {
          tcgplayer_price: "0.36",
          cardmarket_price: "0.02",
          ebay_price: "0.99",
          amazon_price: "14.45",
          coolstuffinc_price: "0.39",
        },
      ],
    },
  ],
};
function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function setup(overrides: PricingDependencies = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const dependencies = {
    fetch,
    storage,
    now: () => Date.now(),
    isOnline: () => true,
    ...overrides,
  };
  return {
    fetch,
    data,
    storage,
    dependencies,
    client: createPricingClient(dependencies),
  };
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider price normalization", () => {
  it("keeps MTG printing, actual currencies and finish separate without inventing provider timestamps", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    const result = await client.getPriceSnapshot(mtg);
    expect(result).toMatchObject({
      cardId: MTG_ID,
      game: "mtg",
      fetchedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + DAY).toISOString(),
      status: "live",
      freshness: "fresh",
      refreshing: false,
    });
    expect(result.identity).toMatchObject({ setCode: "m10", number: "146" });
    expect(result.quotes).toHaveLength(5);
    expect(result.quotes.map((quote) => quote.currency)).toEqual([
      "USD",
      "USD",
      "USD",
      "EUR",
      "EUR",
    ]);
    expect(
      result.quotes.every(
        (quote) =>
          quote.providerUpdatedAt === undefined && quote.scope === "printing",
      ),
    ).toBe(true);
    expect(result.quotes[0]).toMatchObject({
      amount: 1.86,
      variant: "normal",
      source: "TCGplayer via Scryfall · normal",
    });
    expect(
      result.quotes.some((quote) => quote.amount === 0.6 || quote.amount === 8),
    ).toBe(false);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
  });
  it("selects only the requested MTG finish and never falls back to nonfoil", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...mtgPayload,
        prices: { usd: "1.86", eur: "1.33", usd_foil: null },
      }),
    );
    const result = await client.getPriceSnapshot(mtg, { finish: "Foil" });
    expect(result.quotes).toEqual([]);
    expect(result.freshness).toBe("unavailable");
    const normal = await client.getPriceSnapshot(mtg, { finish: "Normal" });
    expect(normal.quotes).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (await client.getPriceSnapshot(mtg, { finish: "Reverse holo" })).quotes,
    ).toEqual([]);
  });
  it("treats Unknown finish as visibly labeled provider choices", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    const result = await client.getPriceSnapshot(mtg, { finish: "Unknown" });
    expect(result.finish).toBe("Unknown");
    expect(new Set(result.quotes.map((quote) => quote.variant)).size).toBe(3);
  });
  it("uses current TCGdex variant keys and separates provider update from retrieval", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(pokemonPayload));
    const result = await client.getPriceSnapshot(pokemon, {
      finish: "Reverse holo",
    });
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({
      amount: 0.36,
      currency: "USD",
      variant: "reverse-holo",
      providerUpdatedAt: "2026-10-12T10:00:00.000Z",
    });
    expect(result.fetchedAt).toBe("2026-10-12T12:00:00.000Z");
    expect(result.quotes[0].note).toContain("physical condition");
  });
  it("keeps Cardmarket buckets ambiguous instead of assuming standard means normal finish", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(pokemonPayload));
    const result = await client.getPriceSnapshot(pokemon);
    expect(
      result.quotes
        .filter((quote) => quote.currency === "EUR")
        .every(
          (quote) =>
            quote.variant === "unspecified" && quote.scope === "catalog",
        ),
    ).toBe(true);
    expect(
      (await client.getPriceSnapshot(pokemon, { finish: "Foil" })).quotes.map(
        (quote) => quote.amount,
      ),
    ).toEqual([1.28]);
  });
  it("selects an exact detailed Pokémon variant and the finish within shared nested pricing", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...pokemonPayload,
        variants_detailed: [
          {
            variantId: "shared-id",
            type: "normal",
            pricing: pokemonPayload.pricing,
          },
          {
            variantId: "reverse-id",
            type: "reverse",
            pricing: pokemonPayload.pricing,
          },
        ],
      }),
    );
    const result = await client.getPriceSnapshot(pokemon, {
      variantId: "reverse-id",
      finish: "Reverse holo",
    });
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({
      amount: 0.36,
      variantId: "reverse-id",
      scope: "printing",
    });
    expect(
      (
        await client.getPriceSnapshot(pokemon, {
          variantId: "reverse-id",
          finish: "Normal",
        })
      ).quotes,
    ).toEqual([]);
    expect(
      (await client.getPriceSnapshot(pokemon)).quotes.every(
        (quote) => quote.scope === "catalog" && quote.variantId === undefined,
      ),
    ).toBe(true);
  });
  it("never substitutes root pricing for an unpriced first-edition or generated variant", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...pokemonPayload,
        variants_detailed: [
          {
            variantId: "first-edition",
            type: "holo",
            stamp: ["1st-edition"],
            pricing: {
              tcgplayer: null,
              cardmarket: { unit: "EUR", trend: 3330.71, "trend-holo": 0 },
            },
          },
          { variantId: "generated", type: "normal" },
        ],
      }),
    );
    const first = await client.getPriceSnapshot(pokemon, {
      variantId: "first-edition",
      finish: "Unknown",
    });
    expect(first.quotes).toHaveLength(1);
    expect(first.quotes[0]).toMatchObject({
      amount: 3330.71,
      currency: "EUR",
      variantId: "first-edition",
      variant: "unspecified",
    });
    expect(
      (await client.getPriceSnapshot(pokemon, { variantId: "generated" }))
        .quotes,
    ).toEqual([]);
    expect(
      (await client.getPriceSnapshot(pokemon, { variantId: "does-not-exist" }))
        .quotes,
    ).toEqual([]);
  });
  it("accepts an edition-specific finish only after the detailed variant is selected", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...pokemonPayload,
        variants_detailed: [
          {
            variantId: "first-edition",
            type: "holo",
            stamp: ["1st-edition"],
            pricing: {
              tcgplayer: {
                unit: "USD",
                "1st-edition-holofoil": { marketPrice: 123 },
              },
            },
          },
        ],
      }),
    );
    const result = await client.getPriceSnapshot(pokemon, {
      variantId: "first-edition",
      finish: "Foil",
    });
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({
      amount: 123,
      variant: "first-edition-foil",
      variantId: "first-edition",
    });
  });
  it("does not replace missing price-update dates with card-metadata dates", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...pokemonPayload,
        pricing: {
          tcgplayer: { updated: "yesterday", normal: { marketPrice: 1 } },
        },
      }),
    );
    const result = await client.getPriceSnapshot(pokemon);
    expect(result.quotes[0].providerUpdatedAt).toBeUndefined();
    expect(result.quotes[0].note).toContain(
      "did not supply a price-update time",
    );
  });

  it("does not confuse a repeated detailed variant ID across Pokémon cards", async () => {
    const { client, fetch } = setup();
    const second = {
      ...pokemon,
      id: "sv03.5-001",
      setCode: "sv03.5",
      number: "001",
    };
    const detail = (amount: number) => [
      {
        variantId: "shared-id",
        type: "normal",
        pricing: { tcgplayer: { normal: { marketPrice: amount } } },
      },
    ];
    fetch
      .mockResolvedValueOnce(
        json({ ...pokemonPayload, variants_detailed: detail(1) }),
      )
      .mockResolvedValueOnce(
        json({
          ...pokemonPayload,
          id: second.id,
          set: { id: second.setCode },
          localId: second.number,
          variants_detailed: detail(100),
        }),
      );
    expect(
      (await client.getPriceSnapshot(pokemon, { variantId: "shared-id" }))
        .quotes[0].amount,
    ).toBe(1);
    const pending = client.getPriceSnapshot(second, { variantId: "shared-id" });
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending).quotes[0].amount).toBe(100);
  });
  it("rejects invalid, null, zero, negative and unsupported-currency amounts", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        ...pokemonPayload,
        pricing: {
          tcgplayer: { unit: "GBP", normal: { marketPrice: 100 } },
          cardmarket: { trend: "", "trend-holo": 0 },
        },
      }),
    );
    expect((await client.getPriceSnapshot(pokemon)).quotes).toEqual([]);
    const other = setup();
    other.fetch.mockResolvedValue(
      json({
        ...mtgPayload,
        prices: {
          usd: null,
          usd_foil: "0.00",
          usd_etched: -5,
          eur: "NaN",
          eur_foil: "-1.23",
        },
      }),
    );
    const result = await other.client.getPriceSnapshot(mtg);
    expect(result.quotes).toEqual([]);
    expect(result.status).toBe("unavailable");
  });
  it("rejects wrong printing identities instead of attaching another card's price", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json({ ...mtgPayload, collector_number: "147" }));
    const result = await client.getPriceSnapshot(mtg);
    expect(result.quotes).toEqual([]);
    expect(result.error).toContain("different printing");
  });
  it("labels broad YGO lows and preserves both currency units with a 48-hour TTL", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(yugiohPayload));
    const result = await client.getPriceSnapshot(yugioh);
    expect(result.quotes).toHaveLength(5);
    expect(
      result.quotes.every(
        (quote) => quote.scope === "catalog" && quote.variant === "unspecified",
      ),
    ).toBe(true);
    expect(result.quotes[1]).toMatchObject({ amount: 0.02, currency: "EUR" });
    expect(result.quotes[0].note).toContain("not an exact printing");
    expect(Date.parse(result.expiresAt!) - Date.parse(result.fetchedAt!)).toBe(
      2 * DAY,
    );
  });
  it("matches YGO set code AND rarity, dedupes the passcode request and separates printing caches", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(yugiohPayload));
    const common = { ...yugioh, setCode: "SBCB-EN001", rarity: "Common" };
    const secret = { ...common, rarity: "Secret Rare" };
    const [first, second] = await Promise.all([
      client.getPriceSnapshot(common),
      client.getPriceSnapshot(secret),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.quotes[0]).toMatchObject({ amount: 1.55, scope: "printing" });
    expect(second.quotes[0]).toMatchObject({ amount: 6.53, scope: "printing" });
    expect(client.readCachedPriceSnapshot(yugioh.id)).toBeNull();
    expect(
      client.readCachedPriceSnapshot(yugioh.id, {
        game: "yugioh",
        setCode: common.setCode,
        rarity: "Common",
      })?.quotes[0].amount,
    ).toBe(1.55);
  });
  it("does not invent exact YGO quotes for missing rarity, ambiguous rows or zero set prices", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(yugiohPayload));
    const result = await client.getPriceSnapshot({
      ...yugioh,
      setCode: "ZERO-EN001",
      rarity: "Common",
    });
    expect(result.quotes.every((quote) => quote.scope === "catalog")).toBe(
      true,
    );
  });
  it("omits ambiguous YGO set rows instead of choosing the first price", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        data: [
          {
            ...yugiohPayload.data[0],
            card_sets: [
              { set_code: "DUP-001", set_rarity: "Rare", set_price: "1.00" },
              { set_code: "DUP-001", set_rarity: "Rare", set_price: "100.00" },
            ],
          },
        ],
      }),
    );
    const result = await client.getPriceSnapshot({
      ...yugioh,
      setCode: "DUP-001",
      rarity: "Rare",
    });
    expect(result.quotes.every((quote) => quote.scope === "catalog")).toBe(
      true,
    );
  });
});

describe("cached-first refresh and offline behavior", () => {
  it("deduplicates simultaneous requests and returns clone-safe fresh cache without network", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    const [one, two] = await Promise.all([
      client.getPriceSnapshot(mtg),
      client.getPriceSnapshot(mtg),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(one.quotes).toEqual(two.quotes);
    one.quotes[0].amount = 999;
    const cached = await client.getPriceSnapshot(mtg);
    expect(cached.quotes[0].amount).toBe(1.86);
    expect(cached.status).toBe("cached");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("returns stale prices immediately and supplies a successful background refresh", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json(mtgPayload));
    const original = await client.getPriceSnapshot(mtg);
    vi.setSystemTime(NOW + DAY + 1);
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const update = vi.fn<(value: PriceSnapshot) => void>();
    const cached = await client.getPriceSnapshot(mtg, { onUpdate: update });
    expect(cached).toMatchObject({
      status: "stale",
      freshness: "stale",
      refreshing: true,
      fetchedAt: original.fetchedAt,
    });
    expect(update).not.toHaveBeenCalled();
    await flush();
    resolve(json({ ...mtgPayload, prices: { usd: "9.99" } }));
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      status: "live",
      freshness: "fresh",
      refreshing: false,
    });
    expect(update.mock.calls[0][0].quotes[0].amount).toBe(9.99);
  });
  it("retains original retrieval time and prices on refresh failure with short retry backoff", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json(mtgPayload));
    const original = await client.getPriceSnapshot(mtg);
    vi.setSystemTime(NOW + DAY + 1);
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await client.getPriceSnapshot(mtg, { force: true });
    expect(result).toMatchObject({
      status: "stale",
      freshness: "stale",
      fetchedAt: original.fetchedAt,
      error: "Failed to fetch",
    });
    expect(result.quotes).toEqual(original.quotes);
    await client.getPriceSnapshot(mtg, { force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("returns offline cached snapshots without sending any requests", async () => {
    let online = true;
    const { client, fetch } = setup({ isOnline: () => online });
    fetch.mockResolvedValue(json(pokemonPayload));
    await client.getPriceSnapshot(pokemon);
    online = false;
    const result = await client.getPriceSnapshot(pokemon, { force: true });
    expect(result.status).toBe("offline");
    expect(result.quotes.length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const cold = await client.getPriceSnapshot(mtg);
    expect(cold).toMatchObject({
      status: "offline",
      freshness: "unavailable",
      quotes: [],
      fetchedAt: null,
    });
  });
  it("reuses persisted stale snapshots after reload and ignores corrupt or invalid-price caches", async () => {
    const { client, fetch, data, dependencies } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    await client.getPriceSnapshot(mtg);
    vi.setSystemTime(NOW + DAY + 1);
    const reloaded = createPricingClient(dependencies);
    expect(reloaded.readCachedPriceSnapshot(mtg.id)?.freshness).toBe("stale");
    const [key, raw] = [...data][0];
    const stored = JSON.parse(raw);
    stored[0].quotes[0].amount = 0;
    data.set(key, JSON.stringify(stored));
    expect(
      createPricingClient(dependencies).readCachedPriceSnapshot(mtg.id),
    ).toBeNull();
    data.set(key, "broken JSON");
    expect(
      createPricingClient(dependencies).readCachedPriceSnapshot(mtg.id),
    ).toBeNull();
  });
  it("rejects a persisted quote whose source points at a different card", async () => {
    const { client, fetch, data, dependencies } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    await client.getPriceSnapshot(mtg);
    const [key, raw] = [...data][0];
    const saved = JSON.parse(raw);
    saved[0].quotes[0].sourceUrl =
      "https://api.scryfall.com/cards/different-card";
    data.set(key, JSON.stringify(saved));
    expect(
      createPricingClient(dependencies).readCachedPriceSnapshot(mtg.id),
    ).toBeNull();
  });

  it("continues in-memory when browser storage reads/writes are blocked", async () => {
    const { client, fetch } = setup({
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("full");
        },
      },
    });
    fetch.mockResolvedValue(json(mtgPayload));
    expect((await client.getPriceSnapshot(mtg)).quotes).toHaveLength(5);
    expect((await client.getPriceSnapshot(mtg)).status).toBe("cached");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("network limits and cancellation", () => {
  it("spaces different Pokémon requests at least 250ms apart", async () => {
    const starts: number[] = [];
    const { client, fetch } = setup();
    fetch.mockImplementation(async (url) => {
      starts.push(Date.now());
      return json({
        ...pokemonPayload,
        id: String(url).split("/").at(-1),
        localId: "136",
      });
    });
    const pending = Promise.all([
      client.getPriceSnapshot(pokemon),
      client.getPriceSnapshot({ ...pokemon, id: "swsh3-137" }),
      client.getPriceSnapshot({ ...pokemon, id: "swsh3-138" }),
    ]);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(251);
    await pending;
    expect(starts).toEqual([NOW, NOW + 250, NOW + 500]);
  });
  it("honors numeric Retry-After across cards and does not send an automatic retry", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({}, 429, { "Retry-After": "120" }));
    const result = await client.getPriceSnapshot(pokemon);
    expect(result.status).toBe("unavailable");
    expect(result.retryAt).toBe(new Date(NOW + 120_000).toISOString());
    await client.getPriceSnapshot({ ...pokemon, id: "swsh3-137" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(json(pokemonPayload));
    expect((await client.getPriceSnapshot(pokemon)).status).toBe("live");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("honors date Retry-After and applies the YGO one-hour fallback when omitted", async () => {
    const first = setup();
    first.fetch.mockResolvedValueOnce(
      json({}, 429, { "Retry-After": new Date(NOW + 180_000).toUTCString() }),
    );
    expect((await first.client.getPriceSnapshot(mtg)).retryAt).toBe(
      new Date(NOW + 180_000).toISOString(),
    );
    const second = setup();
    second.fetch.mockResolvedValueOnce(json({}, 429));
    expect((await second.client.getPriceSnapshot(yugioh)).retryAt).toBe(
      new Date(NOW + 3_600_000).toISOString(),
    );
  });
  it("times out even when a faulty fetch does not honor AbortSignal", async () => {
    const { client, fetch } = setup();
    fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const result = client.getPriceSnapshot(mtg);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({
      status: "unavailable",
      quotes: [],
      fetchedAt: null,
      error: "Scryfall price lookup timed out.",
    });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("also applies the timeout to a stalled response body", async () => {
    const { client, fetch } = setup();
    const response = json(mtgPayload);
    vi.spyOn(response, "json").mockImplementation(
      () => new Promise(() => undefined),
    );
    fetch.mockResolvedValue(response);
    const result = client.getPriceSnapshot(mtg);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({
      status: "unavailable",
      error: "Scryfall price lookup timed out.",
    });
  });
  it("turns malformed successful JSON into unavailable rather than a fabricated price", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(new Response("not-json"));
    const result = await client.getPriceSnapshot(mtg);
    expect(result).toMatchObject({
      status: "unavailable",
      fetchedAt: null,
      quotes: [],
      error: "Scryfall returned unreadable price data.",
    });
  });

  it("aborts one caller without cancelling a shared request needed by another", async () => {
    const { client, fetch } = setup();
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const first = client.getPriceSnapshot(mtg, { signal: controller.signal });
    const rejection = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = client.getPriceSnapshot(mtg);
    await flush();
    controller.abort();
    await rejection;
    resolve(json(mtgPayload));
    expect((await second).status).toBe("live");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("makes no request for an already aborted call and suppresses cancelled background callbacks", async () => {
    const { client, fetch } = setup();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      client.getPriceSnapshot(mtg, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json(mtgPayload));
    await client.getPriceSnapshot(mtg);
    vi.setSystemTime(NOW + DAY + 1);
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const update = vi.fn();
    await client.getPriceSnapshot(mtg, {
      signal: controller.signal,
      onUpdate: update,
    });
    await flush();
    controller.abort();
    resolve(json(mtgPayload));
    await flush();
    expect(update).not.toHaveBeenCalled();
  });
  it("does not fetch, read storage, or install global listeners just by constructing a client", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getItem = vi.fn();
    const setItem = vi.fn();
    createPricingClient({ fetch, storage: { getItem, setItem } });
    expect(fetch).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("pricing identity and freshness audit regressions", () => {
  it("requires full YGO printing qualifiers even when only one printing is cached", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      json({
        data: [
          {
            ...yugiohPayload.data[0],
            card_sets: [
              { set_code: "SET-A", set_rarity: "Rare", set_price: "150" },
            ],
          },
        ],
      }),
    );
    await client.getPriceSnapshot({
      ...yugioh,
      setCode: "SET-A",
      rarity: "Rare",
    });
    expect(client.readCachedPriceSnapshot(yugioh.id)).toBeNull();
    expect(
      client.readCachedPriceSnapshot(yugioh.id, { game: "yugioh" }),
    ).toBeNull();
    expect(
      client.readCachedPriceSnapshot(yugioh.id, { setCode: "SET-A" }),
    ).toBeNull();
    expect(
      client.readCachedPriceSnapshot(yugioh.id, { rarity: "Rare" }),
    ).toBeNull();
    const qualified = client.readCachedPriceSnapshot(yugioh.id, {
      setCode: "SET-A",
      rarity: "Rare",
    });
    expect(qualified?.quotes[0]).toMatchObject({
      amount: 150,
      source: "YGOPRODeck · set reference",
      scope: "printing",
    });
    expect(qualified?.quotes[0].source).not.toContain("TCGplayer");
  });

  it.each([
    ["mtg", mtg, mtgPayload, { setCode: "lea", number: "161" }],
    ["pokemon", pokemon, pokemonPayload, { setCode: "base1", number: "58" }],
  ] as const)(
    "rejects conflicting %s cached metadata while retaining the original correct entry",
    async (_game, card, payload, conflict) => {
      let online = true;
      const { client, fetch } = setup({ isOnline: () => online });
      fetch.mockResolvedValue(json(payload));
      const correct = await client.getPriceSnapshot(card);
      const wrong = { ...card, ...conflict };
      for (const route of ["fresh", "stale", "offline"] as const) {
        if (route === "stale") vi.setSystemTime(NOW + DAY + 1);
        if (route === "offline") online = false;
        const result = await client.getPriceSnapshot(wrong);
        expect(result.quotes, route).toEqual([]);
        expect(result.status, route).toBe("unavailable");
        expect(result.error, route).toContain("conflicts");
        expect(result.refreshing, route).toBe(false);
      }
      expect(client.readCachedPriceSnapshot(card.id)?.identity).toEqual(
        correct.identity,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [mtg, mtgPayload, { setCode: "lea", number: "161" }],
    [pokemon, pokemonPayload, { setCode: "base1", number: "58" }],
  ] as const)(
    "rejects conflicting metadata on cold lookups for $0.game",
    async (card, payload, conflict) => {
      const { client, fetch } = setup();
      fetch.mockResolvedValue(json(payload));
      const result = await client.getPriceSnapshot({ ...card, ...conflict });
      expect(result.quotes).toEqual([]);
      expect(result.error).toContain("different printing");
    },
  );

  it("rechecks the identity of a shared in-flight result for every caller", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    const [correct, wrong] = await Promise.all([
      client.getPriceSnapshot(mtg),
      client.getPriceSnapshot({ ...mtg, setCode: "lea", number: "161" }),
    ]);
    expect(correct.quotes[0].amount).toBe(1.86);
    expect(wrong.quotes).toEqual([]);
    expect(wrong.error).toContain("conflicts");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the canonical printing when the caller leaves printing metadata unspecified", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(mtgPayload));
    const sparse = { ...mtg, setCode: "", number: "" };
    const first = await client.getPriceSnapshot(sparse);
    expect(first.identity).toMatchObject({ setCode: "m10", number: "146" });
    const cached = await client.getPriceSnapshot(sparse);
    expect(cached.identity).toMatchObject({ setCode: "m10", number: "146" });
    expect(cached.quotes[0].amount).toBe(1.86);
  });

  it("labels root Pokémon quotes as catalog references when detailed metadata is absent", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(pokemonPayload));
    const result = await client.getPriceSnapshot(pokemon);
    expect(result.quotes.length).toBeGreaterThan(0);
    expect(result.quotes.every((quote) => quote.scope === "catalog")).toBe(
      true,
    );
    expect(result.quotes[0].note).toContain("edition/subvariant is unresolved");
  });

  it("keeps cache age independent of offline state on both read paths", async () => {
    let online = true;
    const { client, fetch } = setup({ isOnline: () => online });
    fetch.mockResolvedValue(json(mtgPayload));
    const original = await client.getPriceSnapshot(mtg);
    online = false;
    expect(client.readCachedPriceSnapshot(mtg.id)).toMatchObject({
      status: "offline",
      freshness: "fresh",
      fetchedAt: original.fetchedAt,
    });
    expect(await client.getPriceSnapshot(mtg)).toMatchObject({
      status: "offline",
      freshness: "fresh",
      fetchedAt: original.fetchedAt,
    });
    vi.setSystemTime(NOW + DAY + 1);
    expect(client.readCachedPriceSnapshot(mtg.id)).toMatchObject({
      status: "offline",
      freshness: "stale",
    });
    expect(await client.getPriceSnapshot(mtg)).toMatchObject({
      status: "offline",
      freshness: "stale",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an unexpired quote fresh by age when a forced refresh fails", async () => {
    const { client, fetch } = setup();
    fetch
      .mockResolvedValueOnce(json(mtgPayload))
      .mockRejectedValueOnce(new TypeError("Network error"));
    const original = await client.getPriceSnapshot(mtg);
    const pending = client.getPriceSnapshot(mtg, { force: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({
      status: "cached",
      freshness: "fresh",
      error: "Network error",
      fetchedAt: original.fetchedAt,
    });
    expect(client.readCachedPriceSnapshot(mtg.id)).toMatchObject({
      status: "cached",
      freshness: "fresh",
      error: "Network error",
    });
  });

  it.each([
    ["999999999999999999999", 30 * DAY],
    ["-1", 60_000],
    [new Date(NOW - DAY).toUTCString(), 60_000],
  ])(
    "safely bounds invalid or oversized Retry-After %s",
    async (header, delay) => {
      const { client, fetch } = setup();
      fetch.mockResolvedValue(json({}, 429, { "Retry-After": String(header) }));
      const result = await client.getPriceSnapshot(mtg);
      expect(result).toMatchObject({
        status: "unavailable",
        quotes: [],
        retryAt: new Date(NOW + Number(delay)).toISOString(),
      });
      expect(Number.isFinite(Date.parse(result.retryAt!))).toBe(true);
    },
  );
});
