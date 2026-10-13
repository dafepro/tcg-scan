import type { PersistedPrintingEvidence } from "./lib/printing-evidence";

export type Game = "pokemon" | "mtg" | "yugioh";
export type Condition =
  | "Unknown"
  | "Near mint"
  | "Lightly played"
  | "Moderately played"
  | "Heavily played"
  | "Damaged";
export type Finish = "Unknown" | "Normal" | "Foil" | "Reverse holo";
export interface CardPrice {
  amount: number;
  currency: "USD" | "EUR";
  source: string;
  updatedAt: string;
  note?: string;
}
export interface Card {
  id: string;
  game: Game;
  name: string;
  setName: string;
  setCode: string;
  number: string;
  rarity: string;
  imageUrl?: string;
  sourceUrl: string;
  provider: string;
  prices: CardPrice[];
  description?: string;
}
export interface CatalogPrintingRead {
  /** Optional additive migration: old rows remain identity-only and unversioned. */
  evidence?: PersistedPrintingEvidence;
  referenceId: string;
  setName: string;
  setCode: string;
  number: string;
  sourceUrl: string;
  readAt: string;
  unconfirmed: ("language" | "edition" | "rarity" | "finish" | "condition")[];
}
export interface CollectionEntry {
  id: string;
  card: Card;
  quantity: number;
  condition: Condition;
  finish: Finish;
  addedAt: string;
  notes: string;
  /** Live visual matches do not establish edition, finish or physical condition. */
  verification?: "identity-only";
  scanEventId?: string;
  /** Literal catalog identifiers read from two distinct camera frames; no valuation upgrade. */
  printingRead?: CatalogPrintingRead;
}
export interface ReviewItem {
  id: string;
  card: Card;
  addedAt: string;
  origin: "search" | "scan";
}
export interface DeckLine {
  name: string;
  quantity: number;
}
export interface Deck {
  id: string;
  name: string;
  game: Game;
  text: string;
  updatedAt: string;
}
export interface AppData {
  version: 1;
  collection: CollectionEntry[];
  review: ReviewItem[];
  decks: Deck[];
}
export const GAME_LABELS: Record<Game, string> = {
  pokemon: "Pokémon",
  mtg: "Magic: The Gathering",
  yugioh: "Yu-Gi-Oh!",
};
export const GAME_SHORT: Record<Game, string> = {
  pokemon: "Pokémon",
  mtg: "Magic",
  yugioh: "Yu-Gi-Oh!",
};
export const CONDITIONS: Condition[] = [
  "Unknown",
  "Near mint",
  "Lightly played",
  "Moderately played",
  "Heavily played",
  "Damaged",
];
export const FINISHES: Finish[] = ["Unknown", "Normal", "Foil", "Reverse holo"];
