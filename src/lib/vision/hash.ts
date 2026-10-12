/** Small pure functions, shared by the worker and offline feature-pack tooling. */
const COS = Array.from({ length: 8 }, (_, k) => Float64Array.from({ length: 32 }, (_, x) => Math.cos((2 * x + 1) * k * Math.PI / 64)));
function bitsToHex(bits: boolean[]): string {
  let result = "";
  for (let i = 0; i < 64; i += 4) result += ((bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)).toString(16);
  return result;
}
export function perceptualHash(gray32: ArrayLike<number>): string {
  if (gray32.length !== 1024) throw new Error("pHash expects a 32×32 grayscale image.");
  const horizontal = new Float64Array(32 * 8), dct = new Float64Array(64);
  for (let y = 0; y < 32; y++) for (let u = 0; u < 8; u++) {
    let sum = 0;
    for (let x = 0; x < 32; x++) sum += gray32[y * 32 + x] * COS[u][x];
    horizontal[y * 8 + u] = sum;
  }
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0;
    for (let y = 0; y < 32; y++) sum += horizontal[y * 8 + u] * COS[v][y];
    dct[v * 8 + u] = sum;
  }
  const middle = Array.from(dct.slice(1)).sort((a, b) => a - b)[31];
  return bitsToHex(Array.from(dct, (v, i) => i > 0 && v > middle));
}
export function differenceHash(gray9x8: ArrayLike<number>): string {
  if (gray9x8.length !== 72) throw new Error("dHash expects a 9×8 grayscale image.");
  return bitsToHex(Array.from({ length: 64 }, (_, i) => gray9x8[Math.floor(i / 8) * 9 + i % 8] > gray9x8[Math.floor(i / 8) * 9 + i % 8 + 1]));
}
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
export function hashDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < 16; i++) distance += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return distance;
}
interface IndexedHash { key: string; hash: string; differenceHash: string; game: string }
export const MAX_HASH_REFERENCES = 60_000;
const MAX_SHORTLIST = 8;
function popcount32(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
/** Exact compact dual-hash retrieval; only the best eight reach ORB verification.
 * Scans at most 60,000 rows of four uint32 words, never reference descriptors.
 * Unlike bounded hash buckets, a crowded library cannot hide the nearest hash.
 */
export class HashIndex {
  private slots = new Map<string, number>();
  private keys: string[] = [];
  private games: string[] = [];
  private words = new Uint32Array(0);
  set(item: IndexedHash): void {
    let slot = this.slots.get(item.key);
    if (slot === undefined) {
      slot = this.keys.length;
      if (slot >= MAX_HASH_REFERENCES) throw new Error("Local hash index capacity reached (60,000 references).");
      if ((slot + 1) * 4 > this.words.length) {
        const capacity = Math.min(MAX_HASH_REFERENCES, Math.max(256, this.words.length / 2));
        const grown = new Uint32Array(capacity * 4);
        grown.set(this.words); this.words = grown;
      }
      this.slots.set(item.key, slot); this.keys.push(item.key);
    }
    this.games[slot] = item.game;
    const offset = slot * 4;
    this.words[offset] = parseInt(item.hash.slice(0, 8), 16);
    this.words[offset + 1] = parseInt(item.hash.slice(8), 16);
    this.words[offset + 2] = parseInt(item.differenceHash.slice(0, 8), 16);
    this.words[offset + 3] = parseInt(item.differenceHash.slice(8), 16);
  }
  clear(): void { this.slots.clear(); this.keys = []; this.games = []; this.words = new Uint32Array(0); }
  query(hashes: { hash: string; differenceHash: string }[], games: string[], limit = MAX_SHORTLIST): { key: string; distance: number }[] {
    if (!hashes.length || !games.length || !Number.isFinite(limit) || limit < 1) return [];
    limit = Math.min(MAX_SHORTLIST, Math.floor(limit));
    const query = hashes.map(item => [parseInt(item.hash.slice(0, 8), 16), parseInt(item.hash.slice(8), 16), parseInt(item.differenceHash.slice(0, 8), 16), parseInt(item.differenceHash.slice(8), 16)]);
    const result: { key: string; distance: number }[] = [];
    for (let slot = 0; slot < this.keys.length; slot++) {
      if (!games.includes(this.games[slot])) continue;
      const offset = slot * 4;
      let distance = Infinity;
      for (const hash of query) {
        const candidate = popcount32(hash[0] ^ this.words[offset]) + popcount32(hash[1] ^ this.words[offset + 1])
          + 0.4 * (popcount32(hash[2] ^ this.words[offset + 2]) + popcount32(hash[3] ^ this.words[offset + 3]));
        distance = Math.min(distance, candidate);
      }
      const key = this.keys[slot], worst = result[result.length - 1];
      if (result.length >= limit && (distance > worst.distance || (distance === worst.distance && key.localeCompare(worst.key) >= 0))) continue;
      result.push({ key, distance });
      result.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
      if (result.length > limit) result.pop();
    }
    return result;
  }
}
