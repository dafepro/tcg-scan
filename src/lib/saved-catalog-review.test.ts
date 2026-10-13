import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SavedCatalogReviewSession,
  savedCatalogReference,
  compareSavedCatalog,
  catalogReviewLabel,
} from "./saved-catalog-review";
import {
  catalogProvenance,
  summarizePrintingEvidence,
} from "./printing-evidence";
import {
  addScanEvent,
  referenceCard,
  refineScanPrinting,
  undoScanEvent,
} from "./scan-inventory";
import {
  EMPTY_DATA,
  loadData,
  parseBackup,
  saveData,
  STORAGE_KEY,
} from "./storage";
import { backupJson, referenceTotals } from "./collection";
import type { Card, CollectionEntry } from "../types";
import type { PrintingCatalogSnapshot } from "./printing-catalog";
import type {
  PrintingCandidate,
  PrintingResolution,
} from "./printing-refinement";

const NOW = Date.parse("2026-10-13T04:00:00Z");
const candidate: PrintingCandidate = {
  key: "pokemon:base1-58",
  game: "pokemon",
  name: "Pikachu",
  number: "58",
  printedTotal: 102,
  identityKey: "pokemon:pikachu",
  locale: "en",
  setName: "Base Set",
  sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-58",
};
async function snapshot(
  candidates = [candidate],
): Promise<PrintingCatalogSnapshot> {
  const value: PrintingCatalogSnapshot = {
    candidates,
    catalogCompleteForIdentity: true,
    provider: "TCGdex",
    scope: "English provider records",
    referenceKey: candidate.key,
    lookupKey: "fixture",
    locale: "en",
    stale: false,
    fetchedAt: "2026-10-13T03:59:00Z",
  };
  return { ...value, provenance: await catalogProvenance(value) };
}
function resolution(catalog: PrintingCatalogSnapshot): PrintingResolution {
  return {
    state: "catalog-printing-read",
    reference: candidate,
    reasons: [],
    priceEligible: false,
    finish: "unknown",
    condition: "unknown",
    unconfirmed: ["finish", "condition"],
    catalogProvenance: catalog.provenance,
    evidence: [0, 1].map((i) => ({
      jobId: `job-${i}`,
      sessionId: "session",
      eventId: "event",
      frameId: `capture-${i}`,
      imageFingerprint: `pixels-${i}`,
      capturedAt: 1000 + i * 200,
      game: "pokemon",
      rawText: "058/102",
      readerVersion: "frozen-reader",
      fields: { collectorNumber: "58", printedTotal: "102" },
      issues: [],
    })),
  };
}
async function fixture() {
  const current = await snapshot();
  const entry = refineScanPrinting(
    addScanEvent([], candidate, "event"),
    "event",
    resolution(current),
  )[0];
  return { entry, current: structuredClone(current) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("saved-provider reference adapter", () => {
  it("round-trips actual saved scan references for every provider without inventing lost face or Oracle identity", () => {
    const id = "f58dba4f-1abb-47a3-a684-29c32bab95c0";
    const references = [
      {
        key: "pokemon:base1-58",
        game: "pokemon" as const,
        name: "Pikachu",
        identityKey: "pokemon:pikachu",
      },
      {
        key: `mtg:${id}:face1`,
        game: "mtg" as const,
        name: "Night",
        identityKey: "mtg:4457ed35-7c10-48c8-9776-456485fdf070",
      },
      {
        key: "yugioh:46986414:art46986415",
        game: "yugioh" as const,
        name: "Dark Magician",
        identityKey: "yugioh:46986414",
      },
    ];
    for (const reference of references) {
      const saved = addScanEvent([], reference, "roundtrip")[0];
      expect(saved.card).toEqual(referenceCard(reference));
      const restored = parseBackup(
        backupJson({ ...EMPTY_DATA, collection: [saved] }),
      ).collection[0];
      const adapted = savedCatalogReference(restored.card)!;
      expect(adapted).toEqual({
        key: `${reference.game}:${saved.card.id}`,
        game: reference.game,
        name: reference.name,
      });
      expect(adapted).not.toHaveProperty("identityKey");
      expect(adapted).not.toHaveProperty("artworkKey");
      expect(adapted).not.toHaveProperty("sourceUrl");
    }
  });
  it("unsupported legacy IDs are an explicit no-fetch state even with suggestive notes or prices", async () => {
    const { entry, current } = await fixture();
    entry.card.id = "unknown:legacy";
    entry.notes = "Use pokemon:base1-58 as the reference";
    entry.card.prices = [
      {
        amount: 99,
        currency: "USD",
        source: "TCGdex pokemon:base1-58",
        updatedAt: new Date(NOW).toISOString(),
      },
    ];
    const catalog = vi.fn(async () => current);
    const session = new SavedCatalogReviewSession({ catalog });
    session.setEntries([entry]);
    expect(await session.start(entry)).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      phase: "error",
      error: "unsupported-reference",
    });
    expect(catalog).not.toHaveBeenCalled();
  });
  it("uses explicit provider IDs/names without fabricating an identity key or reading notes/prices", async () => {
    const { entry } = await fixture();
    expect(savedCatalogReference(entry.card)).toEqual({
      key: candidate.key,
      game: "pokemon",
      name: "Pikachu",
    });
    const id = "f58dba4f-1abb-47a3-a684-29c32bab95c0";
    expect(
      savedCatalogReference({
        ...entry.card,
        game: "mtg",
        id,
        provider: "Scryfall",
      }),
    ).toEqual({ key: `mtg:${id}`, game: "mtg", name: "Pikachu" });
    expect(
      savedCatalogReference({
        ...entry.card,
        game: "yugioh",
        id: "46986414",
        provider: "YGOPRODeck",
      })?.key,
    ).toBe("yugioh:46986414");
    for (const card of [
      { ...entry.card, provider: "custom" },
      { ...entry.card, id: "../../private" },
      { ...entry.card, game: "mtg", provider: "Scryfall" },
      { ...entry.card, name: "Pikachu|Raichu" },
      { ...entry.card, name: "bad\nname" },
      { ...entry.card, game: "yugioh", provider: "YGOPRODeck", id: "0" },
    ])
      expect(savedCatalogReference(card as Card)).toBeUndefined();
  });
});

describe("historical comparison, never a physical or valuation decision", () => {
  it("accepts semantic row reordering but flags new siblings and versioned field changes", async () => {
    const other = { ...candidate, key: "pokemon:base4-58", number: "59" };
    const old = await snapshot([candidate, other]);
    const evidence = summarizePrintingEvidence("event", resolution(old));
    expect(
      compareSavedCatalog(evidence, await snapshot([other, candidate])).status,
    ).toBe("same-snapshot");
    for (const current of [
      await snapshot([candidate]),
      await snapshot([candidate, { ...other, printedTotal: 103 }]),
    ]) {
      expect(compareSavedCatalog(evidence, current)).toMatchObject({
        status: "review-required",
        changed: true,
      });
    }
    expect(evidence.catalog).toEqual(old.provenance);
  });
  it.each([
    "stale",
    "incomplete",
    "missing",
    "malformed",
    "version",
    "error",
    "scope",
  ])("cannot label %s coverage as the same snapshot", async (kind) => {
    const { entry, current } = await fixture();
    if (kind === "stale") {
      current.stale = true;
      current.provenance!.stale = true;
    }
    if (kind === "incomplete") {
      current.catalogCompleteForIdentity = false;
      current.provenance!.completeWithinScope = false;
    }
    if (kind === "missing") current.provenance = undefined;
    if (kind === "malformed") current.provenance!.snapshotId = "fake";
    if (kind === "version")
      (
        current.provenance as unknown as { schemaVersion: number }
      ).schemaVersion = 2;
    if (kind === "error") current.error = "network";
    if (kind === "scope") {
      current.scope = "Other provider scope";
      current.provenance!.scope = current.scope;
    }
    expect(
      compareSavedCatalog(entry.printingRead!.evidence, current).status,
    ).not.toBe("same-snapshot");
  });
  it("keeps legacy evidence unversioned and missing coverage unavailable", async () => {
    const { current } = await fixture();
    expect(compareSavedCatalog(undefined, current)).toMatchObject({
      status: "legacy-unversioned",
      legacy: true,
    });
    const empty = {
      ...current,
      candidates: [],
      catalogCompleteForIdentity: false,
      error: "not-found",
    };
    empty.provenance = await catalogProvenance(empty);
    expect(compareSavedCatalog(undefined, empty)).toMatchObject({
      status: "unavailable",
      incomplete: true,
      legacy: true,
    });
  });
  it("separates a failed recheck with stale fallback from a fresh check, retaining original fetch date", async () => {
    const { entry, current } = await fixture();
    current.stale = true;
    current.catalogCompleteForIdentity = false;
    current.error = "network";
    current.provenance = await catalogProvenance(current);
    const comparison = compareSavedCatalog(
      entry.printingRead!.evidence,
      current,
    );
    expect(comparison).toMatchObject({
      status: "review-required",
      stale: true,
      incomplete: true,
    });
    expect(comparison.current?.fetchedAt).toBe("2026-10-13T03:59:00Z");
    expect(
      catalogReviewLabel({
        entryId: entry.id,
        name: entry.card.name,
        startedAt: "now",
        checkedAt: "now",
        phase: "complete",
        comparison,
      }),
    ).toBe("Stale fallback · review needed.");
  });
});

describe("bounded saved-catalog session ownership", () => {
  it("runs only when requested, forces refresh, and bounds active requests to one", async () => {
    const { entry, current } = await fixture();
    const work = deferred<PrintingCatalogSnapshot>();
    const catalog = vi.fn(() => work.promise);
    const session = new SavedCatalogReviewSession({ catalog, now: () => NOW });
    session.setEntries([entry]);
    expect(catalog).not.toHaveBeenCalled();
    const first = session.start(entry);
    expect(await session.start(entry)).toBe(false);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog.mock.calls[0]).toEqual([
      { key: candidate.key, name: "Pikachu", game: "pokemon" },
      { signal: expect.any(AbortSignal), refresh: true },
    ]);
    expect(session.getSnapshot()?.phase).toBe("checking");
    work.resolve(current);
    await first;
    expect(session.getSnapshot()).toMatchObject({
      phase: "complete",
      checkedAt: new Date(NOW).toISOString(),
      comparison: { status: "same-snapshot" },
    });
  });
  it("retains a pending request across reorder but discards it on byte-identical entry replacement", async () => {
    const { entry, current } = await fixture();
    const other = { ...entry, id: "other", scanEventId: "other" };
    const work = deferred<PrintingCatalogSnapshot>();
    const session = new SavedCatalogReviewSession({
      catalog: () => work.promise,
    });
    session.setEntries([entry, other]);
    const pending = session.start(entry);
    session.setEntries([other, entry]);
    expect(session.getSnapshot()?.phase).toBe("checking");
    session.setEntries([other, structuredClone(entry)]);
    expect(session.getSnapshot()).toBeNull();
    work.resolve(current);
    expect(await pending).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });
  it.each([
    "delete",
    "undo",
    "event",
    "evidence",
    "reader",
    "card",
    "quantity",
  ])(
    "rejects late responses after %s, with no inventory mutation",
    async (kind) => {
      const { entry, current } = await fixture();
      const work = deferred<PrintingCatalogSnapshot>();
      const session = new SavedCatalogReviewSession({
        catalog: () => work.promise,
      });
      session.setEntries([entry]);
      const pending = session.start(entry);
      let entries: CollectionEntry[] = [entry];
      if (kind === "delete") entries = [];
      if (kind === "undo") entries = undoScanEvent(entries, "event");
      if (kind === "event") entry.scanEventId = "another";
      if (kind === "evidence")
        entry.printingRead!.evidence!.observations[0].literalText =
          "Different literal";
      if (kind === "reader")
        entry.printingRead!.evidence!.observations[0].readerVersion = "changed";
      if (kind === "card") entry.card.id = "base2-58";
      if (kind === "quantity") entry.quantity = 2;
      session.setEntries(entries);
      const unchanged = JSON.stringify(entries);
      work.resolve(current);
      expect(await pending).toBe(false);
      expect(session.getSnapshot()).toBeNull();
      expect(JSON.stringify(entries)).toBe(unchanged);
    },
  );
  it("cancels immediately and protects a new request from the old finalizer and late completion", async () => {
    const { entry, current } = await fixture();
    const first = deferred<PrintingCatalogSnapshot>(),
      next = deferred<PrintingCatalogSnapshot>();
    let calls = 0;
    const signals: AbortSignal[] = [];
    const session = new SavedCatalogReviewSession({
      catalog: (_, options) => {
        signals.push(options!.signal!);
        return calls++ === 0 ? first.promise : next.promise;
      },
    });
    session.setEntries([entry]);
    const a = session.start(entry);
    session.cancel();
    expect(signals[0].aborted).toBe(true);
    expect(session.getSnapshot()?.phase).toBe("cancelled");
    const b = session.start(entry);
    await a;
    expect(session.getSnapshot()?.phase).toBe("checking");
    expect(signals[1].aborted).toBe(false);
    first.resolve(current);
    await Promise.resolve();
    expect(session.getSnapshot()?.phase).toBe("checking");
    next.resolve(current);
    await b;
    expect(session.getSnapshot()).toMatchObject({
      phase: "complete",
      comparison: { status: "same-snapshot" },
    });
  });
  it("clears completed/pending results on navigation and never shows an earlier success after a failed retry", async () => {
    const { entry, current } = await fixture();
    let fail = false;
    const session = new SavedCatalogReviewSession({
      catalog: async () => {
        if (fail) throw new Error("offline");
        return current;
      },
    });
    session.setEntries([entry]);
    await session.start(entry);
    fail = true;
    const retry = session.start(entry);
    expect(session.getSnapshot()).toMatchObject({ phase: "checking" });
    expect(session.getSnapshot()).not.toHaveProperty("comparison");
    await retry;
    expect(session.getSnapshot()).toMatchObject({
      phase: "error",
      error: "network",
    });
    session.clear();
    expect(session.getSnapshot()).toBeNull();
  });
  it("bounds a nonresponsive provider and rejects a response belonging to another reference", async () => {
    const { entry, current } = await fixture();
    vi.useFakeTimers();
    const session = new SavedCatalogReviewSession({
      catalog: () => new Promise(() => undefined),
      timeoutMs: 10,
    });
    session.setEntries([entry]);
    const pending = session.start(entry);
    await vi.advanceTimersByTimeAsync(11);
    await pending;
    expect(session.getSnapshot()).toMatchObject({
      phase: "error",
      error: "timeout",
    });
    const wrong = new SavedCatalogReviewSession({
      catalog: async () => ({ ...current, referenceKey: "another" }),
    });
    wrong.setEntries([entry]);
    await wrong.start(entry);
    expect(wrong.getSnapshot()).toMatchObject({
      phase: "error",
      error: "invalid-response",
    });
  });
  it("round-trips real storage/backups unchanged and drops all check state on reload", async () => {
    const { entry, current } = await fixture();
    const raw = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => raw.set(key, value),
    });
    const data = { ...structuredClone(EMPTY_DATA), collection: [entry] };
    expect(saveData(data)).toBe("");
    const before = raw.get(STORAGE_KEY);
    const original = structuredClone(entry);
    const totals = referenceTotals(data.collection);
    const session = new SavedCatalogReviewSession({
      catalog: async () => current,
    });
    session.setEntries(data.collection);
    await session.start(entry);
    expect(raw.get(STORAGE_KEY)).toBe(before);
    expect(entry).toEqual(original);
    expect(referenceTotals(data.collection)).toEqual(totals);
    const restored = parseBackup(backupJson(data));
    expect(restored.collection[0].printingRead).toEqual(entry.printingRead);
    expect(restored.collection[0]).toMatchObject({
      quantity: 1,
      verification: "identity-only",
      finish: "Unknown",
      condition: "Unknown",
    });
    expect(restored.collection[0].printingRead!.evidence!.priceEligible).toBe(
      false,
    );
    const reloaded = new SavedCatalogReviewSession();
    reloaded.setEntries(loadData().data.collection);
    expect(reloaded.getSnapshot()).toBeNull();
    expect(raw.get(STORAGE_KEY)).toBe(before);
  });
  it("checking a legacy row cannot create evidence or change fields", async () => {
    const { entry, current } = await fixture();
    delete entry.printingRead!.evidence;
    const before = JSON.stringify(entry);
    const session = new SavedCatalogReviewSession({
      catalog: async () => current,
    });
    session.setEntries([entry]);
    await session.start(entry);
    expect(session.getSnapshot()).toMatchObject({
      comparison: { status: "legacy-unversioned" },
    });
    expect(JSON.stringify(entry)).toBe(before);
    expect(
      parseBackup(backupJson({ ...EMPTY_DATA, collection: [entry] }))
        .collection[0].printingRead?.evidence,
    ).toBeUndefined();
  });
});
