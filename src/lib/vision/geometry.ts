import type { Point, Quad } from "./types";

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export function polygonArea(points: Point[]): number {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0)) / 2;
}
/** Clockwise, portrait-oriented order; 180-degree ambiguity is intentional. */
export function orderQuad(points: Point[]): Quad {
  if (points.length !== 4) throw new Error("A quadrilateral needs four corners.");
  const center = points.reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 });
  const ordered = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const topLeft = ordered.reduce((best, p, i) => p.x + p.y < ordered[best].x + ordered[best].y ? i : best, 0);
  let result = [...ordered.slice(topLeft), ...ordered.slice(0, topLeft)] as Quad;
  if (distance(result[0], result[1]) + distance(result[2], result[3]) > distance(result[1], result[2]) + distance(result[3], result[0])) {
    result = [result[1], result[2], result[3], result[0]];
  }
  return result;
}
export function isConvexQuad(quad: Quad): boolean {
  const crosses = quad.map((a, i) => {
    const b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  return crosses.every(v => v > 0) || crosses.every(v => v < 0);
}
export function bounds(points: Point[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function boxIntersectionOverUnion(a: Point[], b: Point[]): number {
  const aa = bounds(a), bb = bounds(b);
  const intersection = Math.max(0, Math.min(aa.x + aa.width, bb.x + bb.width) - Math.max(aa.x, bb.x)) * Math.max(0, Math.min(aa.y + aa.height, bb.y + bb.height) - Math.max(aa.y, bb.y));
  return intersection / Math.max(1, aa.width * aa.height + bb.width * bb.height - intersection);
}
/** Monotonic convex hull gives robust spatial support, not just a bounding box. */
export function hullArea(points: Point[]): number {
  if (points.length < 3) return 0;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (input: Point[]) => {
    const result: Point[] = [];
    for (const p of input) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  return polygonArea([...half(sorted), ...half([...sorted].reverse())]);
}
export function projectPoint(h: ArrayLike<number>, p: Point): Point {
  const z = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / z, y: (h[3] * p.x + h[4] * p.y + h[5]) / z };
}
export function median(values: number[]): number {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
