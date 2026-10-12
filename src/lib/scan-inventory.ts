import type { Card, CollectionEntry } from "../types";
import type { ReferenceMetadata } from "./vision/types";
export function referenceCard(reference: ReferenceMetadata): Card {
  const prefix = `${reference.game}:`;
  let id = reference.key.startsWith(prefix)
    ? reference.key.slice(prefix.length)
    : reference.key;
  id = id.split(":")[0];
  const sources = {
    pokemon: `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(id)}`,
    mtg: `https://api.scryfall.com/cards/${encodeURIComponent(id)}`,
    yugioh: `https://ygoprodeck.com/card/?search=${encodeURIComponent(id)}`,
  };
  return {
    id,
    game: reference.game,
    name: reference.name,
    setName: reference.setName ?? "Printing unconfirmed",
    setCode: "",
    number: reference.number ?? "",
    rarity: "Unknown",
    sourceUrl: sources[reference.game],
    provider:
      reference.game === "pokemon"
        ? "TCGdex"
        : reference.game === "mtg"
          ? "Scryfall"
          : "YGOPRODeck",
    imageUrl: reference.game === "yugioh" ? undefined : reference.imageUrl,
    prices: [],
  };
}
/** One durable row per physical presentation makes event retry and undo exact. */
export function addScanEvent(
  collection: CollectionEntry[],
  reference: ReferenceMetadata,
  eventId: string,
): CollectionEntry[] {
  if (
    collection.some(
      (e) => e.scanEventId === eventId || e.id === `scan:${eventId}`,
    )
  )
    return collection;
  return [
    {
      id: `scan:${eventId}`,
      scanEventId: eventId,
      card: referenceCard(reference),
      quantity: 1,
      condition: "Unknown",
      finish: "Unknown",
      verification: "identity-only",
      addedAt: new Date().toISOString(),
      notes:
        "Automatically matched by local visual features. Verify printing, finish and condition before using a market quote.",
    },
    ...collection,
  ];
}
export function undoScanEvent(
  collection: CollectionEntry[],
  eventId: string,
): CollectionEntry[] {
  return collection.flatMap((e) =>
    e.scanEventId !== eventId
      ? [e]
      : e.quantity > 1
        ? [{ ...e, quantity: e.quantity - 1, scanEventId: undefined }]
        : [],
  );
}
