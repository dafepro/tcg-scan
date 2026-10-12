import { CONDITIONS, FINISHES } from "../types";
import { CARD_IMAGE_HOSTS as IMAGE_HOSTS } from "./provider-image-policy";
import type {
  AppData,
  Card,
  CardPrice,
  CollectionEntry,
  Deck,
  Game,
  ReviewItem,
} from "../types";
export const STORAGE_KEY = "tcg-scan:data:v1";
export const EMPTY_DATA: AppData = {
  version: 1,
  collection: [],
  review: [],
  decks: [],
};
const games = new Set(["pokemon", "mtg", "yugioh"]);
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function str(v: unknown, max = 500): string {
  if (typeof v !== "string" || v.length > max)
    throw new Error("Backup contains invalid or oversized text.");
  return v;
}
function optionalStr(v: unknown, max = 500) {
  return v === undefined ? undefined : str(v, max);
}
function date(v: unknown) {
  const s = str(v);
  if (!Number.isFinite(Date.parse(s)))
    throw new Error("Backup contains an invalid date.");
  return s;
}
function safeUrl(v: unknown, hosts: readonly string[]) {
  const s = str(v, 2048);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !hosts.includes(u.hostname)
    )
      throw new Error();
    return u.href;
  } catch {
    throw new Error(
      "Backup contains an unsafe link. Only known HTTPS catalog links are supported.",
    );
  }
}
const SOURCE_HOSTS: Record<Game, string[]> = {
  mtg: ["scryfall.com", "api.scryfall.com"],
  pokemon: ["api.tcgdex.net"],
  yugioh: ["ygoprodeck.com", "db.ygoprodeck.com"],
};
function parseCard(v: unknown): Card {
  if (
    !record(v) ||
    !games.has(String(v.game)) ||
    !Array.isArray(v.prices) ||
    v.prices.length > 20
  )
    throw new Error("Backup contains an invalid card.");
  const prices: CardPrice[] = v.prices.map((p) => {
    if (
      !record(p) ||
      typeof p.amount !== "number" ||
      !Number.isFinite(p.amount) ||
      p.amount < 0 ||
      p.amount > 1e9 ||
      !["USD", "EUR"].includes(String(p.currency))
    )
      throw new Error("Backup contains an invalid price.");
    return {
      amount: p.amount,
      currency: p.currency as "USD" | "EUR",
      source: str(p.source),
      updatedAt: date(p.updatedAt),
      note: optionalStr(p.note, 1000),
    };
  });
  return {
    id: str(v.id),
    game: v.game as Game,
    name: str(v.name),
    setName: str(v.setName),
    setCode: str(v.setCode),
    number: str(v.number),
    rarity: str(v.rarity),
    sourceUrl: safeUrl(v.sourceUrl, SOURCE_HOSTS[v.game as Game]),
    provider: str(v.provider),
    imageUrl: v.imageUrl
      ? safeUrl(v.imageUrl, IMAGE_HOSTS[v.game as Game])
      : undefined,
    prices,
    description: optionalStr(v.description, 20000),
  };
}
function parsePrintingRead(
  v: unknown,
  game: Game,
): CollectionEntry["printingRead"] {
  if (v === undefined) return undefined;
  if (
    !record(v) ||
    !Array.isArray(v.unconfirmed) ||
    v.unconfirmed.length > 5 ||
    !v.unconfirmed.includes("finish") ||
    !v.unconfirmed.includes("condition") ||
    v.unconfirmed.some(
      (field) =>
        !["language", "edition", "rarity", "finish", "condition"].includes(
          String(field),
        ),
    )
  )
    throw new Error("Backup contains an invalid printing read.");
  return {
    referenceId: str(v.referenceId),
    setName: str(v.setName),
    setCode: str(v.setCode),
    number: str(v.number),
    sourceUrl: safeUrl(v.sourceUrl, SOURCE_HOSTS[game]),
    readAt: date(v.readAt),
    unconfirmed: [...new Set(v.unconfirmed)] as NonNullable<
      CollectionEntry["printingRead"]
    >["unconfirmed"],
  };
}
export function parseBackup(text: string): AppData {
  if (new TextEncoder().encode(text).byteLength > 10_000_000)
    throw new Error("Backup is too large. The limit is 10 MB.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      "This file is not valid JSON. Choose a tcg scan JSON backup.",
    );
  }
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.collection) ||
    !Array.isArray(raw.review) ||
    !Array.isArray(raw.decks)
  )
    throw new Error("Choose a version 1 tcg scan JSON backup.");
  if (
    raw.collection.length > 10000 ||
    raw.review.length > 1000 ||
    raw.decks.length > 500
  )
    throw new Error(
      "Backup has too many entries (10,000 collection entries, 1,000 review cards, or 500 decks maximum).",
    );
  const collection: CollectionEntry[] = raw.collection.map((v) => {
    if (
      !record(v) ||
      !Number.isInteger(v.quantity) ||
      Number(v.quantity) < 1 ||
      Number(v.quantity) > 9999 ||
      !CONDITIONS.includes(v.condition as never) ||
      !FINISHES.includes(v.finish as never) ||
      (v.verification !== undefined && v.verification !== "identity-only")
    )
      throw new Error("Backup contains an invalid collection entry.");
    return {
      id: str(v.id),
      card: parseCard(v.card),
      quantity: Number(v.quantity),
      condition: v.condition as CollectionEntry["condition"],
      finish: v.finish as CollectionEntry["finish"],
      addedAt: date(v.addedAt),
      notes: str(v.notes, 5000),
      verification:
        v.verification === "identity-only" ? "identity-only" : undefined,
      scanEventId: optionalStr(v.scanEventId, 200),
      printingRead: parsePrintingRead(v.printingRead, (v.card as Card).game),
    };
  });
  const scanIds = collection.flatMap((entry) =>
    entry.scanEventId ? [entry.scanEventId] : [],
  );
  if (new Set(scanIds).size !== scanIds.length)
    throw new Error("Backup contains duplicate scan event IDs.");
  const review: ReviewItem[] = raw.review.map((v) => {
    if (!record(v) || !["search", "scan"].includes(String(v.origin)))
      throw new Error("Backup contains an invalid review entry.");
    return {
      id: str(v.id),
      card: parseCard(v.card),
      addedAt: date(v.addedAt),
      origin: v.origin as ReviewItem["origin"],
    };
  });
  const decks: Deck[] = raw.decks.map((v) => {
    if (!record(v) || !games.has(String(v.game)))
      throw new Error("Backup contains an invalid deck.");
    return {
      id: str(v.id),
      name: str(v.name, 200),
      game: v.game as Game,
      text: str(v.text, 100000),
      updatedAt: date(v.updatedAt),
    };
  });
  for (const items of [collection, review, decks])
    if (new Set(items.map((v) => v.id)).size !== items.length)
      throw new Error("Backup contains duplicate entry IDs.");
  return { version: 1, collection, review, decks };
}
export function loadData(): { data: AppData; warning: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return {
      data: raw ? parseBackup(raw) : structuredClone(EMPTY_DATA),
      warning: "",
    };
  } catch {
    return {
      data: structuredClone(EMPTY_DATA),
      warning:
        "Browser storage could not be read. Your existing backup has not been overwritten. Export anything you add before leaving this page.",
    };
  }
}
export function saveData(data: AppData): string {
  try {
    const serialized = JSON.stringify(data);
    parseBackup(serialized);
    localStorage.setItem(STORAGE_KEY, serialized);
    return "";
  } catch {
    return "Your changes are only in memory. Browser storage is full, blocked, or this collection exceeds the backup limits. Export a JSON backup before closing this page.";
  }
}
export function mergeBackup(current: AppData, incoming: AppData): AppData {
  // Imports merge by stable entry ID, making repeated import idempotent. Existing entries win.
  const merge = <T extends { id: string }>(a: T[], b: T[]) => [
    ...a,
    ...b.filter((item) => !a.some((existing) => existing.id === item.id)),
  ];
  const merged: AppData = {
    version: 1,
    collection: merge(current.collection, incoming.collection),
    review: merge(current.review, incoming.review),
    decks: merge(current.decks, incoming.decks),
  };
  return parseBackup(JSON.stringify(merged));
}
