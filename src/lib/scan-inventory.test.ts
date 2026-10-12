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
