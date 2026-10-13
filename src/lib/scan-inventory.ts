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
export interface ScanSaveOptions {
  quantitySource?: "user-confirmed";
}

/** One durable row per physical presentation makes event retry and undo exact. */
export function addScanEvent(
  collection: CollectionEntry[],
  reference: ReferenceMetadata,
  eventId: string,
  options?: ScanSaveOptions,
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
        options?.quantitySource === "user-confirmed"
          ? "Another physical copy explicitly confirmed by you using an earlier matched identity. Printing, finish and condition remain unconfirmed."
          : "Automatically matched by local visual features. Verify printing, finish and condition before using a market quote.",
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

/** Refines catalog identifiers without pretending to verify edition, finish or value. */
export function refineScanPrinting(
  collection: CollectionEntry[],
  eventId: string,
  resolution: import("./printing-refinement").PrintingResolution,
): CollectionEntry[] {
  const reference = resolution.reference;
  if (
    resolution.state !== "catalog-printing-read" ||
    !reference ||
    resolution.priceEligible !== false ||
    resolution.evidence.length < 2 ||
    new Set(resolution.evidence.map((e) => e.frameId)).size < 2 ||
    new Set(resolution.evidence.map((e) => e.imageFingerprint)).size < 2 ||
    new Set(resolution.evidence.map((e) => e.sessionId)).size !== 1 ||
    Math.max(...resolution.evidence.map((e) => e.capturedAt)) -
      Math.min(...resolution.evidence.map((e) => e.capturedAt)) <
      100 ||
    !resolution.unconfirmed.includes("finish") ||
    !resolution.unconfirmed.includes("condition")
  )
    return collection;
  const card = referenceCard(reference);
  let changed = false;
  const next = collection.map((entry) => {
    if (
      entry.scanEventId !== eventId ||
      entry.verification !== "identity-only" ||
      entry.card.game !== reference.game ||
      entry.card.name.normalize("NFKC").trim().toLowerCase() !==
        reference.name.normalize("NFKC").trim().toLowerCase()
    )
      return entry;
    if (
      resolution.evidence.some(
        (observation) =>
          observation.eventId !== eventId ||
          observation.game !== reference.game,
      )
    )
      return entry;
    changed = true;
    return {
      ...entry,
      printingRead: {
        referenceId: card.id,
        setName: card.setName,
        setCode: reference.setCode ?? "",
        number: card.number,
        sourceUrl: card.sourceUrl,
        readAt: new Date().toISOString(),
        unconfirmed: [...resolution.unconfirmed],
      },
    };
  });
  return changed ? next : collection;
}
