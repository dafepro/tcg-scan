import { expect, it } from "vitest";
import { addScanEvent, undoScanEvent, referenceCard } from "./scan-inventory";
import { referenceTotals, addToCollection, collectionCsv } from "./collection";
import { parseBackup } from "./storage";
const ref = {
  key: "pokemon:basep-1",
  game: "pokemon" as const,
  name: "Pikachu",
  setName: "Wizards Black Star Promos",
  number: "1",
};
it("persists idempotent unknown-condition scan events and undo removes only one copy", () => {
  let entries = addScanEvent([], ref, "event1");
  entries = addScanEvent(entries, ref, "event1");
  expect(entries).toHaveLength(1);
  entries = addScanEvent(entries, ref, "event2");
  expect(entries).toHaveLength(2);
  const parsed = parseBackup(
    JSON.stringify({ version: 1, collection: entries, review: [], decks: [] }),
  );
  expect(parsed.collection[0].verification).toBe("identity-only");
  expect(parsed.collection[0].condition).toBe("Unknown");
  expect(undoScanEvent(entries, "event1")).toHaveLength(1);
});
it("never values unconfirmed printing and does not merge a confirmed manual copy", () => {
  const entries = addScanEvent([], ref, "event1");
  entries[0].card.prices = [
    {
      amount: 100,
      currency: "USD",
      source: "test",
      updatedAt: new Date().toISOString(),
    },
  ];
  expect(referenceTotals(entries).USD).toBe(0);
  expect(collectionCsv(entries)).not.toContain('"100"');
  expect(
    addToCollection(entries, referenceCard(ref), 1, "Unknown", "Unknown"),
  ).toHaveLength(2);
});

import { refineScanPrinting } from "./scan-inventory";
import type { PrintingResolution } from "./printing-refinement";
const printingResolution = (): PrintingResolution => ({
  state: "catalog-printing-read",
  reference: {
    ...ref,
    key: "pokemon:base1-58",
    setName: "Base Set",
    number: "58",
  },
  reasons: [],
  finish: "unknown",
  condition: "unknown",
  priceEligible: false,
  unconfirmed: ["edition", "finish", "condition"],
  evidence: [0, 1].map((i) => ({
    jobId: `job${i}`,
    sessionId: "session",
    eventId: "event1",
    frameId: `frame${i}`,
    capturedAt: 1000 + i * 200,
    game: "pokemon",
    imageFingerprint: `image${i}`,
    rawText: "58/102",
    fields: { collectorNumber: "58", printedTotal: "102" },
    issues: [],
  })),
});
it("durably preserves catalog reads without changing physical verification or prices", () => {
  const before = addScanEvent([], ref, "event1");
  const refined = refineScanPrinting(before, "event1", printingResolution());
  expect(refined[0].printingRead?.setName).toBe("Base Set");
  expect(refined[0].card).toEqual(before[0].card);
  expect(refined[0].verification).toBe("identity-only");
  expect(refined[0].condition).toBe("Unknown");
  expect(referenceTotals(refined).USD).toBe(0);
  const parsed = parseBackup(
    JSON.stringify({ version: 1, collection: refined, review: [], decks: [] }),
  );
  expect(parsed.collection[0].printingRead).toEqual(refined[0].printingRead);
  expect(collectionCsv(refined)).toContain("Read catalog set");
  expect(collectionCsv(refined)).toContain("Base Set");
});
it("does not refine removed, mismatched or nonindependent events", () => {
  const entries = addScanEvent([], ref, "event1");
  expect(refineScanPrinting(entries, "removed", printingResolution())).toBe(
    entries,
  );
  for (const mutate of [
    (r: PrintingResolution) => {
      r.reference!.name = "Other";
    },
    (r: PrintingResolution) => {
      r.evidence[1].eventId = "other";
    },
    (r: PrintingResolution) => {
      r.evidence[1].sessionId = "other";
    },
    (r: PrintingResolution) => {
      r.evidence[1].frameId = r.evidence[0].frameId;
    },
    (r: PrintingResolution) => {
      r.evidence[1].imageFingerprint = r.evidence[0].imageFingerprint;
    },
    (r: PrintingResolution) => {
      r.unconfirmed = ["condition"];
    },
  ]) {
    const r = printingResolution();
    mutate(r);
    expect(refineScanPrinting(entries, "event1", r)).toBe(entries);
  }
});
it("rejects hostile or overclaiming printing metadata in imports", () => {
  const entries = refineScanPrinting(
    addScanEvent([], ref, "event1"),
    "event1",
    printingResolution(),
  );
  for (const mutate of [
    () => {
      entries[0].printingRead!.sourceUrl = "https://evil.example/track";
    },
    () => {
      entries[0].printingRead!.unconfirmed = [];
    },
  ]) {
    mutate();
    expect(() =>
      parseBackup(
        JSON.stringify({
          version: 1,
          collection: entries,
          review: [],
          decks: [],
        }),
      ),
    ).toThrow();
  }
});
