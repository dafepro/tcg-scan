import { describe, expect, it } from "vitest";
import { addScanEvent, undoScanEvent } from "./scan-inventory";
import { parseBackup } from "./storage";

describe("explicit extra-copy inventory", () => {
  const reference = {
    key: "pokemon:base1-58",
    game: "pokemon" as const,
    name: "Pikachu",
  };
  it("keeps manual provenance, separate durable events, unknown physical attributes and exact Undo", () => {
    const first = addScanEvent([], reference, "captured");
    const second = addScanEvent(first, reference, "confirmed-copy", {
      quantitySource: "user-confirmed",
    });
    expect(second).toHaveLength(2);
    expect(second[0].notes).toContain("explicitly confirmed by you");
    expect(second[0].notes).not.toContain("Automatically matched");
    expect(second[0]).toMatchObject({
      verification: "identity-only",
      quantity: 1,
      condition: "Unknown",
      finish: "Unknown",
    });
    expect(second[0].card.prices).toEqual([]);
    expect(
      addScanEvent(second, reference, "confirmed-copy", {
        quantitySource: "user-confirmed",
      }),
    ).toBe(second);
    expect(undoScanEvent(second, "confirmed-copy")).toEqual(first);
    const roundTrip = parseBackup(
      JSON.stringify({ version: 1, collection: second, review: [], decks: [] }),
    );
    expect(roundTrip.collection.map((entry) => entry.notes)).toEqual(
      second.map((entry) => entry.notes),
    );
  });
});
