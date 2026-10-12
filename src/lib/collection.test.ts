import { describe, it, expect } from "vitest";
import {
  addToCollection,
  checkDeck,
  collectionCsv,
  normalizeName,
  parseDeck,
  referenceTotals,
} from "./collection";
import { EMPTY_DATA, mergeBackup, parseBackup } from "./storage";
import type { Card } from "../types";
const card: Card = {
  id: "test-1",
  game: "mtg",
  name: "Test Mage",
  setName: "Test set",
  setCode: "test",
  number: "1",
  rarity: "Rare",
  sourceUrl: "https://scryfall.com/",
  provider: "fixture",
  prices: [
    {
      amount: 2.5,
      currency: "USD",
      source: "test",
      updatedAt: "2026-10-12T00:00:00Z",
    },
  ],
};
describe("collection", () => {
  it("combines same printing, finish and condition, not variants", () => {
    const a = addToCollection([], card, 2, "Near mint", "Normal");
    const b = addToCollection(a, card, 3, "Near mint", "Normal");
    expect(b).toHaveLength(1);
    expect(b[0].quantity).toBe(5);
    expect(addToCollection(b, card, 1, "Near mint", "Foil")).toHaveLength(2);
  });
  it("rejects unsafe quantities", () => {
    expect(() => addToCollection([], card, 0, "Near mint", "Normal")).toThrow();
    expect(() =>
      addToCollection([], card, 1.5, "Near mint", "Normal"),
    ).toThrow();
  });
  it("keeps currencies separate and counts missing prices", () => {
    const a = addToCollection([], card, 2, "Near mint", "Normal");
    expect(referenceTotals(a)).toEqual({
      USD: 5,
      EUR: 0,
      priced: 2,
      unpriced: 0,
    });
  });
  it("exports quoted CSV and guards spreadsheet formula injection", () => {
    const a = addToCollection(
      [],
      { ...card, name: '=HYPERLINK("bad")' },
      1,
      "Near mint",
      "Normal",
    );
    expect(collectionCsv(a)).toContain("'=HYPERLINK");
    expect(collectionCsv(a)).toContain('""bad""');
  });
  it("exports an automatic visual reference without claiming its set, number or value", () => {
    const entries = addToCollection([], card, 1, "Unknown", "Unknown");
    entries[0].verification = "identity-only";
    const csv = collectionCsv(entries);
    const row = csv.split("\r\n")[1].split(",");
    expect(row.slice(2, 5)).toEqual(['""', '""', '""']);
    expect(row.slice(8, 12)).toEqual(['""', '""', '""', '""']);
    expect(row.slice(13, 16)).toEqual(['"Unconfirmed"', '"Test set"', '"1"']);
    expect(row.slice(16)).toEqual(['""', '""', '""', '""']);
    expect(referenceTotals(entries).unpriced).toBe(1);
  });
});
describe("deck checker", () => {
  it("normalizes names and sums duplicates", () => {
    expect(normalizeName(" POKÉMON  ’ ")).toBe("pokemon '");
    expect(
      parseDeck("Deck\n2 Test Mage\n1x Test Mage\n# comment").lines,
    ).toEqual([{ name: "Test Mage", quantity: 3 }]);
  });
  it("reports owned and missing for the chosen game", () => {
    const a = addToCollection([], card, 2, "Near mint", "Normal");
    expect(checkDeck("4 Test Mage", "mtg", a).lines[0].missing).toBe(2);
    expect(checkDeck("4 Test Mage", "pokemon", a).lines[0].owned).toBe(0);
  });
  it("reports invalid quantities rather than silently changing them", () => {
    expect(parseDeck("0 Test Mage\n10000 Other").warnings).toHaveLength(2);
  });
});
describe("backup validation", () => {
  it("roundtrips valid data", () => {
    const data = {
      ...EMPTY_DATA,
      collection: addToCollection([], card, 2, "Near mint", "Normal"),
    };
    expect(parseBackup(JSON.stringify(data))).toEqual(data);
  });
  it("rejects malformed structures and unsafe links", () => {
    expect(() => parseBackup("{}")).toThrow();
    expect(() => parseBackup("nope")).toThrow();
    const data = {
      ...EMPTY_DATA,
      collection: addToCollection(
        [],
        { ...card, sourceUrl: "javascript:alert(1)" },
        2,
        "Near mint",
        "Normal",
      ),
    };
    expect(() => parseBackup(JSON.stringify(data))).toThrow("unsafe link");
  });
  it("merges backups without doubling identical entries", () => {
    const data = {
      ...EMPTY_DATA,
      collection: addToCollection([], card, 2, "Near mint", "Normal"),
    };
    expect(mergeBackup(data, data).collection).toHaveLength(1);
  });
});

describe("backup boundaries and privacy", () => {
  it("rejects merged backup overflow before replacing existing data", () => {
    const cards = addToCollection([], card, 1, "Near mint", "Normal");
    const base = {
      ...EMPTY_DATA,
      review: Array.from({ length: 1000 }, (_, i) => ({
        id: `r${i}`,
        card,
        addedAt: "2026-10-12T00:00:00Z",
        origin: "search" as const,
      })),
    };
    const incoming = {
      ...EMPTY_DATA,
      collection: cards,
      review: [{ ...base.review[0], id: "one-more" }],
    };
    expect(() => mergeBackup(base, incoming)).toThrow("too many");
    expect(base.review).toHaveLength(1000);
  });
  it("rejects imported tracking images and embedded credentials", () => {
    for (const imageUrl of [
      "https://example.com/tracker.png",
      "https://user:password@cards.scryfall.io/card.jpg",
    ]) {
      const data = {
        ...EMPTY_DATA,
        collection: addToCollection(
          [],
          { ...card, imageUrl },
          1,
          "Near mint",
          "Normal",
        ),
      };
      expect(() => parseBackup(JSON.stringify(data))).toThrow("unsafe link");
    }
  });
  it("rejects Yu-Gi-Oh artwork hotlinks in imported backups", () => {
    const data = {
      ...EMPTY_DATA,
      collection: addToCollection(
        [],
        {
          ...card,
          game: "yugioh",
          sourceUrl: "https://ygoprodeck.com/card/test",
          imageUrl: "https://images.ygoprodeck.com/images/cards/1.jpg",
        },
        1,
        "Near mint",
        "Normal",
      ),
    };
    expect(() => parseBackup(JSON.stringify(data))).toThrow("unsafe link");
  });
  it("preserves approved provider image URLs", () => {
    const data = {
      ...EMPTY_DATA,
      collection: addToCollection(
        [],
        {
          ...card,
          imageUrl: "https://cards.scryfall.io/normal/front/test.jpg",
        },
        1,
        "Near mint",
        "Normal",
      ),
    };
    expect(parseBackup(JSON.stringify(data)).collection[0].card.imageUrl).toBe(
      "https://cards.scryfall.io/normal/front/test.jpg",
    );
  });
});

describe("export/import consistency", () => {
  it("rejects UTF-8 byte overflow even when character count is smaller", () => {
    expect(() => parseBackup('"' + "é".repeat(5_000_000) + '"')).toThrow(
      "too large",
    );
  });
  it("neutralizes newline and fullwidth spreadsheet formula prefixes", () => {
    for (const prefix of ["\n=", "＝", "＋", "－", "＠"]) {
      const entries = addToCollection(
        [],
        { ...card, name: prefix + "TEST" },
        1,
        "Near mint",
        "Normal",
      );
      expect(collectionCsv(entries)).toContain("\"'" + prefix + 'TEST"');
    }
  });
});
