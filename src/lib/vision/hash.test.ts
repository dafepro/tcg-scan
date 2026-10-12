import { describe, expect, it } from "vitest";
import { differenceHash, HashIndex, hashDistance, MAX_HASH_REFERENCES, perceptualHash } from "./hash";

describe("local shortlist hashes", () => {
  it("computes repeatable 64-bit perceptual and difference hashes", () => {
    const pixels = Array.from({ length: 1024 }, (_, i) => (i * 17 + i * i) % 255);
    expect(perceptualHash(pixels)).toMatch(/^[0-9a-f]{16}$/);
    expect(perceptualHash(pixels)).toBe(perceptualHash(pixels));
    expect(differenceHash(Array.from({ length: 72 }, (_, i) => i % 9))).toBe("0000000000000000");
    expect(differenceHash(Array.from({ length: 72 }, (_, i) => 9 - i % 9))).toBe("ffffffffffffffff");
    expect(hashDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });
  it("shortlists within game and replaces old hash entries", () => {
    const index = new HashIndex();
    index.set({ key: "match", game: "pokemon", hash: "123456789abcdef0", differenceHash: "123456789abcdef0" });
    index.set({ key: "wrong-game", game: "mtg", hash: "123456789abcdef0", differenceHash: "123456789abcdef0" });
    const query = [{ hash: "123456789abcdef0", differenceHash: "123456789abcdef0" }];
    expect(index.query(query, ["pokemon"])[0]).toEqual({ key: "match", distance: 0 });
    expect(index.query(query, ["yugioh"])).toEqual([]);
    index.set({ key: "match", game: "pokemon", hash: "ffffffffffffffff", differenceHash: "ffffffffffffffff" });
    expect(index.query(query, ["pokemon"]).every(c => c.distance !== 0)).toBe(true);
  });
  it("does not lose a nearest hash behind rare probes or crowded exact buckets", () => {
    const index = new HashIndex();
    const add = (key: string, coordinate: number, value: number) => {
      const bytes = Array.from({ length: 16 }, (_, i) => i === coordinate ? value.toString(16).padStart(2, "0") : "ff");
      index.set({ key, game: "pokemon", hash: bytes.slice(0, 8).join(""), differenceHash: bytes.slice(8).join("") });
    };
    for (let coordinate = 0; coordinate < 16; coordinate++) {
      // Each exact bucket is deliberately more common than every probe bucket.
      for (let n = 0; n < 60; n++) add(`exact-noise:${coordinate}:${n}`, coordinate, 0);
      for (let bit = 0; bit < 8; bit++) for (let n = 0; n < 7; n++) add(`probe-noise:${coordinate}:${bit}:${n}`, coordinate, 1 << bit);
    }
    const query = { hash: "0000000000000000", differenceHash: "0000000000000000" };
    index.set({ key: "exact-target", game: "pokemon", ...query });
    // The former bounded bucket search lost this zero-distance target behind
    // 896 rare-probe candidates. Exact compact scanning must retain it.
    expect(index.query([query, query], ["pokemon"], 8)[0]).toEqual({ key: "exact-target", distance: 0 });
  });
  it("agrees with a slow dual-hash oracle across orientations and game filters", () => {
    const index = new HashIndex();
    let seed = 910247;
    const word = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0).toString(16).padStart(8, "0"); };
    const entries = Array.from({ length: 2400 }, (_, n) => ({ key: `card-${n}`, game: ["pokemon", "mtg", "yugioh"][n % 3], hash: word() + word(), differenceHash: word() + word() }));
    for (const entry of entries) index.set(entry);
    for (let n = 0; n < 12; n++) {
      const hashes = [entries[n * 53], { hash: word() + word(), differenceHash: word() + word() }];
      const games = n % 2 ? ["pokemon"] : ["pokemon", "mtg", "yugioh"];
      const expected = entries.filter(entry => games.includes(entry.game)).map(entry => ({ key: entry.key, distance: Math.min(...hashes.map(hash => hashDistance(hash.hash, entry.hash) + 0.4 * hashDistance(hash.differenceHash, entry.differenceHash))) })).sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key)).slice(0, 8);
      expect(index.query(hashes, games)).toEqual(expected);
    }
  });
  it("orders ties by key, replaces games and hashes, and clears all rows", () => {
    const index = new HashIndex();
    const query = { hash: "0000000000000000", differenceHash: "0000000000000000" };
    for (const key of ["z", "b", "a"]) index.set({ key, game: "pokemon", ...query });
    expect(index.query([query], ["pokemon"]).map(c => c.key)).toEqual(["a", "b", "z"]);
    index.set({ key: "a", game: "mtg", hash: "ffffffffffffffff", differenceHash: "ffffffffffffffff" });
    expect(index.query([query], ["pokemon"]).map(c => c.key)).toEqual(["b", "z"]);
    expect(index.query([query], ["mtg"])).toEqual([{ key: "a", distance: 89.6 }]);
    index.clear();
    expect(index.query([query], ["pokemon", "mtg"])).toEqual([]);
    index.set({ key: "fresh", game: "pokemon", ...query });
    expect(index.query([query], ["pokemon"])).toEqual([{ key: "fresh", distance: 0 }]);
  });
  it("handles empty inputs and never returns more than eight candidates", () => {
    const index = new HashIndex(), query = { hash: "0000000000000000", differenceHash: "0000000000000000" };
    expect(index.query([query], ["pokemon"])).toEqual([]);
    for (let n = 0; n < 20; n++) index.set({ key: `key-${n}`, game: "pokemon", ...query });
    expect(index.query([], ["pokemon"])).toEqual([]);
    expect(index.query([query], [])).toEqual([]);
    expect(index.query([query], ["pokemon"], 0)).toEqual([]);
    expect(index.query([query], ["pokemon"], 2)).toHaveLength(2);
    expect(index.query([query], ["pokemon"], 100)).toHaveLength(8);
  });
  it("enforces the full index cap while allowing replacement at capacity", () => {
    const index = new HashIndex(), hashes = { hash: "0000000000000000", differenceHash: "0000000000000000" };
    for (let n = 0; n < MAX_HASH_REFERENCES; n++) index.set({ key: `card-${n}`, game: "pokemon", ...hashes });
    expect(() => index.set({ key: "over-cap", game: "pokemon", ...hashes })).toThrow("capacity");
    expect(() => index.set({ key: "card-0", game: "mtg", ...hashes })).not.toThrow();
    expect(index.query([hashes], ["mtg"])).toEqual([{ key: "card-0", distance: 0 }]);
  });
  it("bounds shortlist size even for a large colliding library", () => {
    const index = new HashIndex();
    for (let i = 0; i < 3000; i++) index.set({ key: String(i), game: "pokemon", hash: "0123456789abcdef", differenceHash: "0123456789abcdef" });
    expect(index.query([{ hash: "0123456789abcdef", differenceHash: "0123456789abcdef" }], ["pokemon"], 8)).toHaveLength(8);
  });
});
