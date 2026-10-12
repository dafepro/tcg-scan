export type Game = "pokemon" | "mtg" | "yugioh";
export type Condition =
  | "Near mint"
  | "Lightly played"
  | "Moderately played"
  | "Heavily played"
  | "Damaged";
export type Finish = "Normal" | "Foil" | "Reverse holo";
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
export interface CollectionEntry {
  id: string;
  card: Card;
  quantity: number;
  condition: Condition;
  finish: Finish;
  addedAt: string;
  notes: string;
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
  "Near mint",
  "Lightly played",
  "Moderately played",
  "Heavily played",
  "Damaged",
];
export const FINISHES: Finish[] = ["Normal", "Foil", "Reverse holo"];
