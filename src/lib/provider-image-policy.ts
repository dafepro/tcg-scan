import type { Game } from "../types";

/** Browser artwork hosts accepted by durable collection storage, per game. */
export const CARD_IMAGE_HOSTS: Readonly<Record<Game, readonly string[]>> =
  Object.freeze({
    pokemon: Object.freeze(["assets.tcgdex.net"]),
    mtg: Object.freeze(["cards.scryfall.io"]),
    yugioh: Object.freeze([]),
  });
