import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../types";
import type { PriceOptions, PriceSnapshot, PricingClient } from "./pricing";
import {
  createReferenceQuoteController,
  createReferenceVisibilityGate,
  getReferenceClock,
  matchesReferenceIdentity,
  readReferenceQuoteCache,
  referenceQuoteAge,
  referenceQuoteIdentity,
  subscribeReferenceClock,
  type ReferenceQuoteState,
} from "./reference-quotes";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const card: Card = {
  id: "mtg-card",
  game: "mtg",
  name: "Lightning Bolt",
  setName: "Magic 2010",
  setCode: "m10",
  number: "146",
  rarity: "common",
  sourceUrl: "https://api.scryfall.com/cards/mtg-card",
  provider: "Scryfall",
  prices: [],
};
function snapshot(overrides: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    cardId: card.id,
    game: card.game,
    identity: {
      cardId: card.id,
      game: card.game,
      name: card.name,
      setCode: card.setCode,
      number: card.number,
      rarity: card.rarity,
    },
    finish: "Unknown",
    quotes: [
      {
        amount: 1.86,
        currency: "USD",
        source: "TCGplayer via Scryfall",
        sourceUrl: card.sourceUrl,
        variant: "normal",
        scope: "printing",
        note: "Printing and physical condition remain unconfirmed.",
      },
    ],
    fetchedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    freshness: "fresh",
    status: "live",
    refreshing: false,
    ...overrides,
  };
}
function client(cached: PriceSnapshot | null = null) {
  return {
    readCachedPriceSnapshot: vi.fn<PricingClient["readCachedPriceSnapshot"]>(
      () => cached,
    ),
    getPriceSnapshot: vi.fn<PricingClient["getPriceSnapshot"]>(async () =>
      snapshot(),
    ),
  };
}
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("reference quote identity", () => {
  it("ignores unrelated prop-object churn but changes for printing constraints", () => {
    expect(
      referenceQuoteIdentity({ ...card, prices: [], setName: "renamed" }),
    ).toBe(referenceQuoteIdentity(card));
    for (const key of ["id", "setCode", "number", "rarity", "name"] as const)
      expect(referenceQuoteIdentity({ ...card, [key]: "different" })).not.toBe(
        referenceQuoteIdentity(card),
      );
  });

  it("rejects wrong collector numbers before displaying cached values", () => {
    const cached = snapshot();
    const prices = client(cached);
    expect(
      readReferenceQuoteCache({ ...card, number: "999" }, prices),
    ).toBeNull();
    expect(readReferenceQuoteCache(card, prices)).toEqual(cached);
    expect(prices.readCachedPriceSnapshot).toHaveBeenLastCalledWith(card.id, {
      game: "mtg",
      finish: "Unknown",
      setCode: "m10",
      rarity: undefined,
    });
    expect(prices.getPriceSnapshot).not.toHaveBeenCalled();
  });

  it("requires exact Yu-Gi-Oh set and rarity, including unresolved empty sets", () => {
    const ygo: Card = {
      ...card,
      game: "yugioh",
      setCode: "SET-001",
      rarity: "Rare",
    };
    const saved = snapshot({
      game: "yugioh",
      identity: {
        ...snapshot().identity,
        game: "yugioh",
        setCode: "SET-001",
        rarity: "Rare",
      },
    });
    expect(matchesReferenceIdentity(ygo, saved)).toBe(true);
    expect(matchesReferenceIdentity({ ...ygo, setCode: "" }, saved)).toBe(
      false,
    );
    expect(matchesReferenceIdentity({ ...ygo, rarity: "Common" }, saved)).toBe(
      false,
    );
    const prices = client(saved);
    readReferenceQuoteCache({ ...ygo, setCode: "" }, prices);
    expect(prices.readCachedPriceSnapshot).toHaveBeenCalledWith(ygo.id, {
      game: "yugioh",
      finish: "Unknown",
      setCode: "",
      rarity: "Rare",
    });
  });

  it("handles unavailable storage without a network fallback", () => {
    const prices = client();
    prices.readCachedPriceSnapshot.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readReferenceQuoteCache(card, prices)).toBeNull();
    expect(prices.getPriceSnapshot).not.toHaveBeenCalled();
  });
});

describe("reference quote subscription", () => {
  it("does not fetch until explicitly loaded and always keeps finish Unknown", async () => {
    const original = structuredClone(card);
    const prices = client();
    const updates = vi.fn<(state: ReferenceQuoteState) => void>();
    const view = createReferenceQuoteController(card, prices, updates);
    expect(view.getState()).toEqual({
      snapshot: null,
      loading: false,
      attempted: false,
    });
    expect(prices.getPriceSnapshot).not.toHaveBeenCalled();
    view.load();
    view.load();
    await flush();
    expect(prices.getPriceSnapshot).toHaveBeenCalledTimes(1);
    expect(prices.getPriceSnapshot.mock.calls[0][1]).toMatchObject({
      finish: "Unknown",
      force: false,
    });
    expect(view.getState().loading).toBe(false);
    expect(view.getState().snapshot?.quotes[0].amount).toBe(1.86);
    view.load();
    await flush();
    expect(prices.getPriceSnapshot).toHaveBeenCalledTimes(1);
    view.load(true);
    await flush();
    expect(prices.getPriceSnapshot).toHaveBeenCalledTimes(2);
    expect(card).toEqual(original);
    view.dispose();
  });

  it("disposal before the first request prevents that request", async () => {
    const prices = client();
    const view = createReferenceQuoteController(card, prices, vi.fn());
    view.load();
    view.dispose();
    await flush();
    expect(prices.getPriceSnapshot).not.toHaveBeenCalled();
  });

  it("aborts its subscription and ignores late promises and onUpdate after unmount", async () => {
    const prices = client();
    let options: PriceOptions | undefined;
    let finish: (value: PriceSnapshot) => void = () => undefined;
    prices.getPriceSnapshot.mockImplementation((_, incoming) => {
      options = incoming;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const updates = vi.fn();
    const view = createReferenceQuoteController(card, prices, updates);
    view.load();
    await flush();
    view.dispose();
    const calls = updates.mock.calls.length;
    expect(options?.signal?.aborted).toBe(true);
    options?.onUpdate?.(snapshot());
    finish(snapshot());
    await flush();
    expect(updates).toHaveBeenCalledTimes(calls);
  });

  it("keeps a stale cached quote while awaiting the final provider update", async () => {
    const stale = snapshot({ status: "stale", freshness: "stale" });
    const prices = client(stale);
    let options: PriceOptions | undefined;
    prices.getPriceSnapshot.mockImplementation(async (_, incoming) => {
      options = incoming;
      return { ...stale, refreshing: true };
    });
    const view = createReferenceQuoteController(card, prices, vi.fn());
    expect(view.getState().snapshot).toEqual(stale);
    view.load();
    await flush();
    expect(view.getState()).toMatchObject({
      loading: true,
      snapshot: { status: "stale" },
    });
    options?.onUpdate?.(snapshot());
    expect(view.getState()).toMatchObject({
      loading: false,
      snapshot: { status: "live" },
    });
    view.dispose();
  });

  it("does not overwrite a fast refreshed update with the stale seed", async () => {
    const prices = client();
    prices.getPriceSnapshot.mockImplementation(async (_, options) => {
      options?.onUpdate?.(snapshot());
      return snapshot({
        status: "stale",
        freshness: "stale",
        refreshing: true,
      });
    });
    const view = createReferenceQuoteController(card, prices, vi.fn());
    view.load();
    await flush();
    expect(view.getState()).toMatchObject({
      loading: false,
      snapshot: { status: "live" },
    });
    view.dispose();
  });

  it.each(["reject", "throw"])(
    "stops loading after a %s and preserves saved quotes",
    async (mode) => {
      const saved = snapshot({ status: "cached" });
      const prices = client(saved);
      if (mode === "reject")
        prices.getPriceSnapshot.mockRejectedValue(new Error("network"));
      else
        prices.getPriceSnapshot.mockImplementation(() => {
          throw new Error("network");
        });
      const view = createReferenceQuoteController(card, prices, vi.fn());
      view.load();
      await flush();
      expect(view.getState()).toMatchObject({
        loading: false,
        snapshot: saved,
        error: expect.any(String),
      });
      view.dispose();
    },
  );

  it("rejects a mismatched result without relabeling its prices", async () => {
    const prices = client();
    prices.getPriceSnapshot.mockResolvedValue(
      snapshot({ identity: { ...snapshot().identity, number: "999" } }),
    );
    const view = createReferenceQuoteController(card, prices, vi.fn());
    view.load();
    await flush();
    expect(view.getState()).toMatchObject({
      snapshot: null,
      loading: false,
      error: expect.stringContaining("does not match"),
    });
    view.dispose();
  });

  it("finishes an offline/no-quote response as unavailable instead of loading forever", async () => {
    const prices = client();
    const offline = snapshot({
      quotes: [],
      status: "offline",
      freshness: "unavailable",
      fetchedAt: null,
      expiresAt: null,
    });
    prices.getPriceSnapshot.mockResolvedValue(offline);
    const view = createReferenceQuoteController(card, prices, vi.fn());
    view.load();
    await flush();
    expect(view.getState()).toEqual({
      snapshot: offline,
      attempted: true,
      loading: false,
    });
    view.dispose();
  });
});

describe("shared reference visibility", () => {
  function observerSetup() {
    let report: (
      entries: {
        target: Element;
        isIntersecting: boolean;
        intersectionRatio: number;
      }[],
    ) => void = () => undefined;
    const observer = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    const factory = vi.fn((callback: typeof report) => {
      report = callback;
      return observer;
    });
    const gate = createReferenceVisibilityGate(factory);
    return {
      gate,
      factory,
      observer,
      report: (target: Element, visible: boolean, ratio = 1) =>
        report([{ target, isIntersecting: visible, intersectionRatio: ratio }]),
    };
  }
  it("uses one observer for 10,000 rows and only loads genuinely visible rows once", () => {
    const { gate, factory, report } = observerSetup();
    const visible = vi.fn();
    const elements = Array.from({ length: 10_000 }, () => ({}) as Element);
    const watchers = elements.map((element) => gate.observe(element, visible));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(visible).not.toHaveBeenCalled();
    report(elements[1], false);
    report(elements[2], true, 0);
    expect(visible).not.toHaveBeenCalled();
    report(elements[3], true);
    report(elements[3], true);
    expect(visible).toHaveBeenCalledTimes(1);
    watchers.forEach((watcher) => watcher.dispose());
  });

  it("ignores queued observer entries after a row is removed", () => {
    const { gate, report, observer } = observerSetup();
    const element = {} as Element;
    const visible = vi.fn();
    const watcher = gate.observe(element, visible);
    watcher.dispose();
    report(element, true);
    expect(visible).not.toHaveBeenCalled();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("requires explicit loading when observation is unavailable or fails", () => {
    const visible = vi.fn();
    expect(
      createReferenceVisibilityGate(null).observe({} as Element, visible)
        .automatic,
    ).toBe(false);
    const gate = createReferenceVisibilityGate(() => {
      throw new Error("unsupported");
    });
    expect(gate.observe({} as Element, visible).automatic).toBe(false);
    expect(visible).not.toHaveBeenCalled();
  });
});

describe("quote timestamps", () => {
  it("distinguishes ages and does not turn a future provider time into a fresh update", () => {
    expect(referenceQuoteAge(new Date(NOW - 20_000).toISOString(), NOW)).toBe(
      "just now",
    );
    expect(referenceQuoteAge(new Date(NOW - 120_000).toISOString(), NOW)).toBe(
      "2 min ago",
    );
    expect(
      referenceQuoteAge(new Date(NOW - 7_200_000).toISOString(), NOW),
    ).toBe("2 hours ago");
    expect(
      referenceQuoteAge(new Date(NOW - 172_800_000).toISOString(), NOW),
    ).toBe("2 days ago");
    expect(
      referenceQuoteAge(new Date(NOW + 86_400_000).toISOString(), NOW),
    ).toBe("provider-reported future time");
  });

  it("shares one clock and stops it after the last displayed snapshot unmounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = subscribeReferenceClock(first);
    const stopSecond = subscribeReferenceClock(second);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(getReferenceClock()).toBe(NOW + 60_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});
