import { describe, expect, it } from "vitest";
import { boxIntersectionOverUnion, hullArea, isConvexQuad, orderQuad, polygonArea, projectPoint } from "./geometry";

describe("local card geometry", () => {
  it("orders four corners clockwise with the short edge first", () => {
    const quad = orderQuad([{ x: 10, y: 160 }, { x: 110, y: 10 }, { x: 10, y: 10 }, { x: 110, y: 160 }]);
    expect(quad).toEqual([{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 160 }, { x: 10, y: 160 }]);
    expect(isConvexQuad(quad)).toBe(true);
    expect(polygonArea(quad)).toBe(15000);
  });
  it("rotates a landscape quadrilateral into portrait without inventing orientation", () => {
    const quad = orderQuad([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }, { x: 0, y: 100 }]);
    expect(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)).toBe(100);
  });
  it("rejects crossed geometry and gives zero support to collinear matches", () => {
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }])).toBe(false);
    expect(hullArea([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(0);
  });
  it("measures inlier convex support and perspective projection", () => {
    expect(hullArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }])).toBe(100);
    expect(projectPoint([1, 0, 10, 0, 1, 20, 0, 0, 1], { x: 5, y: 8 })).toEqual({ x: 15, y: 28 });
    expect(boxIntersectionOverUnion([{ x: 0, y: 0 }, { x: 10, y: 10 }], [{ x: 20, y: 20 }, { x: 30, y: 30 }])).toBe(0);
  });
});
