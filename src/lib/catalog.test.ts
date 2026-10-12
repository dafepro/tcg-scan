import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MTG_ID = "f58dba4f-1abb-47a3-a684-29c32bab95c0";
const mtg = {
  id: MTG_ID,
  name: "Lightning Bolt",
  set: "lea",
  set_name: "Limited Edition Alpha",
  collector_number: "161",
  rarity: "common",
  scryfall_uri: "https://scryfall.com/card/lea/161/lightning-bolt",
  image_uris: { normal: "https://cards.scryfall.io/normal/front/example.jpg" },
  prices: {
    usd: "12.34",
    usd_foil: null,
    eur: "8.90",
    eur_foil: "0.00",
    tix: "2.00",
  },
};
const pokemonBrief = {
  id: "base1-58",
  localId: "58",
  name: "Pikachu",
  image: "https://assets.tcgdex.net/en/base/base1/58",
};
const pokemon = {
  ...pokemonBrief,
  set: { id: "base1", name: "Base Set" },
  rarity: "Common",
  pricing: {
    tcgplayer: {
      unit: "USD",
      updated: "2026-10-11T22:54:34.008Z",
      normal: { marketPrice: 11.19 },
      reverse: { marketPrice: null },
    },
    cardmarket: {
      unit: "EUR",
      updated: "2026-10-11T22:54:32.643Z",
      trend: 41.53,
      "trend-holo": 0,
    },
  },
};
const yugioh = {
  id: 46986414,
  name: "Dark Magician",
  desc: "The ultimate wizard.",
  ygoprodeck_url: "https://ygoprodeck.com/card/dark-magician-4003",
  card_images: [
    { image_url: "https://images.ygoprodeck.com/images/cards/46986414.jpg" },
  ],
  card_sets: [
    {
      set_name: "Starter Deck: Yugi",
      set_code: "SDY-006",
      set_rarity: "Ultra Rare",
    },
    { set_name: "Other printing" },
  ],
  card_prices: [
    {
      tcgplayer_price: "1.23",
      cardmarket_price: "0.42",
      amazon_price: "0.00",
      ebay_price: null,
    },
  ],
};
let fetchMock: ReturnType<typeof vi.fn>;
let storage: Map<string, string>;
function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
async function catalog() {
  return import("./catalog");
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1_000);
  return promise;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T09:00:00.000Z"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public catalog normalization", () => {
  it("keeps MTG printing identity, currencies, source and retrieval timestamp without inventing missing prices", async () => {
    fetchMock.mockResolvedValue(json({ data: [mtg] }));
    const { searchCards } = await catalog();
    const [card] = await searchCards("mtg", "Lightning Bolt");
    expect(card).toMatchObject({
      id: MTG_ID,
      setCode: "lea",
      number: "161",
      provider: "Scryfall",
    });
    expect(card.prices).toHaveLength(2);
    expect(card.prices[0]).toMatchObject({
      amount: 12.34,
      currency: "USD",
      updatedAt: "2026-10-12T09:00:00.000Z",
    });
    expect(card.prices[0].source).toContain("TCGplayer");
    expect(card.prices[0].note).toContain("retrieval time");
    expect(card.prices[1]).toMatchObject({ amount: 8.9, currency: "EUR" });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("unique")).toBe("prints");
    expect(url.searchParams.get("q")).toBe("Lightning Bolt");
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe("application/json");
  });

  it("prefers an exact name over partial-name matches before applying the result cap", async () => {
    fetchMock.mockResolvedValue(
      json({
        data: [
          ...Array.from({ length: 12 }, (_, index) => ({
            ...mtg,
            id: `other-${index}`,
            name: "Emeritus of Conflict // Lightning Bolt",
          })),
          mtg,
        ],
      }),
    );
    const cards = await (await catalog()).searchCards("mtg", "Lightning Bolt");
    expect(cards).toHaveLength(12);
    expect(cards[0].name).toBe("Lightning Bolt");
  });

  it("uses the front-face image and face text for double-faced MTG cards", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...mtg,
        image_uris: undefined,
        card_faces: [
          { image_uris: mtg.image_uris, oracle_text: "Front" },
          { oracle_text: "Back" },
        ],
      }),
    );
    const { getCard } = await catalog();
    const card = await getCard("mtg", MTG_ID);
    expect(card.imageUrl).toBe(mtg.image_uris.normal);
    expect(card.description).toBe("Front\n\nBack");
  });

  it("returns Pokémon summaries then fetches full details with dated provider prices", async () => {
    fetchMock
      .mockResolvedValueOnce(json([pokemonBrief]))
      .mockResolvedValueOnce(json(pokemon));
    const { searchCards, getCard } = await catalog();
    const [summary] = await searchCards("pokemon", "Pikachu");
    expect(summary).toMatchObject({
      id: "base1-58",
      setCode: "base1",
      number: "58",
      prices: [],
    });
    expect(summary.imageUrl).toBe(
      "https://assets.tcgdex.net/en/base/base1/58/high.webp",
    );
    const query = new URL(fetchMock.mock.calls[0][0]);
    expect(query.searchParams.get("pagination:itemsPerPage")).toBe("12");
    expect(query.searchParams.get("pagination:page")).toBe("1");
    const full = await settle(getCard("pokemon", summary.id));
    expect(full.setName).toBe("Base Set");
    expect(full.prices).toHaveLength(2);
    expect(full.prices[0]).toMatchObject({
      amount: 11.19,
      currency: "USD",
      updatedAt: "2026-10-11T22:54:34.008Z",
    });
    expect(full.prices[1]).toMatchObject({ amount: 41.53, currency: "EUR" });
  });

  it("does not mislabel unsupported Pokémon currencies or invalid price values", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...pokemon,
        pricing: {
          tcgplayer: { unit: "GBP", normal: { marketPrice: 100 } },
          cardmarket: { unit: "EUR", trend: "", "trend-holo": -1 },
        },
      }),
    );
    expect(
      (await (await catalog()).getCard("pokemon", "base1-58")).prices,
    ).toEqual([]);
  });

  it("uses retrieval time when a Pokémon price update date is missing or invalid", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...pokemon,
        pricing: {
          tcgplayer: { normal: { marketPrice: "2.10" }, updated: "yesterday" },
        },
      }),
    );
    const card = await (await catalog()).getCard("pokemon", "base1-58");
    expect(card.prices[0]).toMatchObject({
      amount: 2.1,
      updatedAt: "2026-10-12T09:00:00.000Z",
    });
    expect(card.prices[0].note).toContain("retrieval time");
  });

  it("omits YGO art and arbitrary first-printing claims while labeling cross-version low prices", async () => {
    fetchMock.mockResolvedValue(json({ data: [yugioh] }));
    const [card] = await (
      await catalog()
    ).searchCards("yugioh", "Dark Magician");
    expect(card.imageUrl).toBeUndefined();
    expect(card.setName).toContain("Multiple printings");
    expect(card.setCode).toBe("");
    expect(card.number).toBe("46986414");
    expect(card.prices).toHaveLength(2);
    expect(card.prices[0]).toMatchObject({ amount: 1.23, currency: "USD" });
    expect(card.prices[1]).toMatchObject({ amount: 0.42, currency: "EUR" });
    expect(card.prices[0].note).toContain("Lowest across multiple versions");
    expect(card.description).toContain("image-hosting policy");
  });

  it.each([
    ["pokemon", "base1-58", pokemon],
    ["mtg", MTG_ID, mtg],
    ["yugioh", "46986414", { data: [yugioh] }],
  ] as const)("supports %s catalog IDs", async (game, id, payload) => {
    fetchMock.mockResolvedValue(json(payload));
    const cards = await (await catalog()).searchCards(game, id);
    expect(cards[0].id).toBe(id);
    expect(fetchMock.mock.calls[0][0]).toContain(id);
  });

  it("treats a hyphenated Pokémon name as a name, not an ID", async () => {
    fetchMock.mockResolvedValue(json([{ ...pokemonBrief, name: "Ho-Oh" }]));
    await (await catalog()).searchCards("pokemon", "Ho-Oh");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("name")).toBe(
      "Ho-Oh",
    );
  });

  it("caps all candidate lists at 12 even when a provider ignores pagination", async () => {
    fetchMock.mockResolvedValue(
      json(
        Array.from({ length: 20 }, (_, index) => ({
          ...pokemonBrief,
          id: `base1-${index}`,
        })),
      ),
    );
    expect(
      await (await catalog()).searchCards("pokemon", "Pikachu"),
    ).toHaveLength(12);
  });

  it("rejects untrusted image/source URL schemes and hosts", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...mtg,
        image_uris: { normal: "https://evil.example/art.jpg" },
        scryfall_uri: "javascript:alert(1)",
      }),
    );
    const card = await (await catalog()).getCard("mtg", MTG_ID);
    expect(card.imageUrl).toBeUndefined();
    expect(card.sourceUrl).toBe(`https://api.scryfall.com/cards/${MTG_ID}`);
  });
});

describe("empty results, validation and failures", () => {
  it("does not fetch for an empty query", async () => {
    expect(await (await catalog()).searchCards("mtg", "  ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["mtg", { object: "error", details: "No cards found" }, 404],
    ["pokemon", [], 200],
    [
      "yugioh",
      { error: "No card matching your query was found in the database." },
      400,
    ],
  ] as const)(
    "normalizes %s no-results responses",
    async (game, payload, status) => {
      fetchMock.mockResolvedValue(json(payload, status));
      expect(await (await catalog()).searchCards(game, "zzzzz")).toEqual([]);
    },
  );

  it("rejects a missing direct card instead of returning a fabricated card", async () => {
    fetchMock.mockResolvedValue(json({ error: "Not found" }, 404));
    await expect(
      (await catalog()).getCard("pokemon", "base1-999"),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it.each([null, { data: "wrong type" }, { data: [{ id: "123" }] }])(
    "rejects unexpected API shapes",
    async (payload) => {
      fetchMock.mockResolvedValue(json(payload));
      await expect(
        (await catalog()).searchCards("mtg", "Bolt"),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("rejects malformed JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>maintenance</html>", { status: 200 }),
    );
    await expect(
      (await catalog()).searchCards("mtg", "Bolt"),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("reports provider HTTP errors with the status", async () => {
    fetchMock.mockResolvedValue(json({ error: "down" }, 503));
    await expect(
      (await catalog()).searchCards("pokemon", "Pikachu"),
    ).rejects.toThrow("TCGdex: The service returned HTTP 503");
  });

  it("reports network failures usefully without exposing raw errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      (await catalog()).searchCards("mtg", "Bolt"),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("rejects overly long input and invalid IDs before making a request", async () => {
    const { searchCards, getCard } = await catalog();
    await expect(searchCards("mtg", "x".repeat(201))).rejects.toMatchObject({
      code: "invalid-query",
    });
    await expect(getCard("pokemon", "../cards")).rejects.toMatchObject({
      code: "invalid-query",
    });
    await expect(getCard("yugioh", "Dark Magician")).rejects.toMatchObject({
      code: "invalid-query",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cancellation, throttling and cache", () => {
  it("honors a pre-aborted signal without hitting the network or cache", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      (await catalog()).searchCards("pokemon", "Pikachu", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight fetch promptly", async () => {
    fetchMock.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    const pending = (await catalog()).searchCards(
      "mtg",
      "Bolt",
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("turns the 15 second timeout into an informative error", async () => {
    fetchMock.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = (await catalog()).searchCards("mtg", "Bolt");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it("spaces Scryfall requests at least 600ms, respecting the 500ms search limit", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: [mtg] })));
    const { searchCards } = await catalog();
    const one = searchCards("mtg", "Bolt");
    const two = searchCards("mtg", "Angel");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(599);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels while waiting for a provider slot without sending the queued request", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: [mtg] })));
    const { searchCards } = await catalog();
    await searchCards("mtg", "Bolt");
    const controller = new AbortController();
    const pending = searchCards("mtg", "Angel", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry 429 and refuses new requests during the cooldown", async () => {
    fetchMock.mockResolvedValue(json({}, 429, { "Retry-After": "120" }));
    const { searchCards } = await catalog();
    await expect(searchCards("mtg", "Bolt")).rejects.toMatchObject({
      code: "rate-limit",
    });
    await expect(searchCards("mtg", "Angel")).rejects.toMatchObject({
      code: "rate-limit",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(searchCards("mtg", "Goblin")).rejects.toMatchObject({
      code: "rate-limit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops an already queued request if an earlier response triggers a cooldown", async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    const { searchCards } = await catalog();
    const one = expect(searchCards("mtg", "Bolt")).rejects.toMatchObject({
      code: "rate-limit",
    });
    const two = expect(searchCards("mtg", "Angel")).rejects.toMatchObject({
      code: "rate-limit",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds persisted cache size even after many distinct searches", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: [mtg] })));
    const { searchCards } = await catalog();
    for (let index = 0; index < 50; index++)
      await settle(searchCards("mtg", `Card ${index}`));
    const saved = [...storage.values()][0];
    expect(JSON.parse(saved)).toHaveLength(40);
    expect(saved.length).toBeLessThanOrEqual(1_000_000);
  });

  it("reuses cached searches and MTG details, protects cached values from mutation", async () => {
    fetchMock.mockResolvedValue(json({ data: [mtg] }));
    const { searchCards, getCard } = await catalog();
    const first = await searchCards("mtg", "Bolt");
    first[0].name = "Locally changed";
    first[0].prices[0].amount = 99999;
    expect((await searchCards("mtg", "Bolt"))[0].name).toBe("Lightning Bolt");
    expect((await getCard("mtg", MTG_ID)).prices[0].amount).toBe(12.34);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists bounded cached data across module reloads and preserves retrieval dates", async () => {
    fetchMock.mockResolvedValue(json({ data: [yugioh] }));
    const first = await (await catalog()).searchCards("yugioh", "Magician");
    expect(storage.size).toBe(1);
    vi.resetModules();
    vi.setSystemTime(new Date("2026-10-13T09:00:00.000Z"));
    const restored = await (await catalog()).searchCards("yugioh", "Magician");
    expect(restored).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expires MTG data after 24 hours", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: [mtg] })));
    const { searchCards } = await catalog();
    await searchCards("mtg", "Bolt");
    vi.setSystemTime(new Date("2026-10-13T09:00:01.000Z"));
    await searchCards("mtg", "Bolt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues normally when local storage is unavailable or malformed", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "{bad json",
      setItem: () => {
        throw new Error("quota");
      },
    });
    fetchMock.mockResolvedValue(json({ data: [mtg] }));
    expect(await (await catalog()).searchCards("mtg", "Bolt")).toHaveLength(1);
  });
});
