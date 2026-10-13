import { describe, expect, it } from "vitest";
import {
  measurePrintingRegions,
  printingRegionBounds,
  PRINTING_REGION_LIMITS,
  PRINTING_REGION_REGISTRY,
  validPrintingPixels,
} from "./printing-regions";
import type { PrintingRegionPixels } from "./printing-regions";
import type { VisionGame } from "./vision/types";

function pixels(width = 600, height = 840, fill = 128): PrintingRegionPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return { width, height, data };
}
function measure(image = pixels(), game: VisionGame = "pokemon") {
  return measurePrintingRegions(image, {
    game,
    frameId: "original-capture",
    imageFingerprint: "full-card-sha256",
    sourceMinEdge: image.width,
  });
}
function paint(
  image: PrintingRegionPixels,
  top: number,
  bottom: number,
  value: (x: number, y: number) => number,
) {
  for (let y = top; y < bottom; y++)
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] =
        image.data[offset + 1] =
        image.data[offset + 2] =
          value(x, y);
    }
}

describe("bounded native printing regions", () => {
  it("preserves all existing game zones in an immutable typed registry", () => {
    expect(Object.isFrozen(PRINTING_REGION_REGISTRY)).toBe(true);
    for (const game of ["pokemon", "mtg", "yugioh"] as const) {
      expect(Object.isFrozen(PRINTING_REGION_REGISTRY[game])).toBe(true);
      expect(PRINTING_REGION_REGISTRY[game].length).toBeLessThanOrEqual(
        PRINTING_REGION_LIMITS.regions,
      );
      expect(PRINTING_REGION_REGISTRY[game].every(Object.isFrozen)).toBe(true);
    }
    expect(printingRegionBounds("pokemon", 600, 840)[0]).toEqual({
      regionId: "pokemon-footer",
      x: 0,
      y: 655,
      width: 600,
      height: 185,
      outputWidth: 600,
      outputHeight: 185,
    });
    expect(printingRegionBounds("mtg", 600, 840)[0]).toMatchObject({
      regionId: "mtg-footer",
      y: 680,
      height: 160,
    });
    expect(
      printingRegionBounds("yugioh", 600, 840).map(({ regionId }) => regionId),
    ).toEqual(["yugioh-set-code", "yugioh-footer"]);
  });
  it("never increases ROI dimensions or treats enlargement as new native detail", () => {
    for (const width of [1, 479, 480, 600, 1800, 2400]) {
      const height = Math.round(width * 1.4);
      for (const game of ["pokemon", "mtg", "yugioh"] as const) {
        for (const region of printingRegionBounds(game, width, height)) {
          expect(region.outputWidth).toBeLessThanOrEqual(region.width);
          expect(region.outputHeight).toBeLessThanOrEqual(region.height);
          expect(region.outputWidth).toBeLessThanOrEqual(1800);
          expect(region.y + region.height).toBeLessThanOrEqual(height);
        }
      }
    }
    expect(printingRegionBounds("pokemon", 2400, 3360)[0]).toMatchObject({
      width: 2400,
      height: 740,
      outputWidth: 1800,
      outputHeight: 555,
    });
    const region = measurePrintingRegions(pixels(), {
      game: "pokemon",
      frameId: "same",
      imageFingerprint: "same",
      sourceMinEdge: 240,
    })[0];
    expect(region.sourceMinEdge).toBe(240);
    expect(region.qualityReasons).toContain("source-detail-limited");
    expect(region).not.toHaveProperty("characterHeight");
  });
  it("measures clipping in the requested footer independently of bright artwork", () => {
    const image = pixels();
    paint(image, 0, 655, () => 255);
    expect(measure(image)[0].metrics.highlightClippedFraction).toBe(0);
    expect(measure(image)[0].qualityReasons).not.toContain(
      "highlight-clipping",
    );
    paint(image, 0, 655, () => 128);
    paint(image, 655, 840, () => 255);
    const footer = measure(image)[0];
    expect(footer.metrics.highlightClippedFraction).toBe(1);
    expect(footer.qualityReasons).toContain("highlight-clipping");
    expect(footer.qualityReasons).not.toContain("glare");
  });
  it("does not let a sharp artwork region imply a sharp footer", () => {
    const image = pixels();
    paint(image, 0, 655, (x) => (x % 2 ? 240 : 10));
    const flat = measure(image)[0];
    expect(flat.metrics.sharpness).toBe(0);
    expect(flat.metrics.contrast).toBe(0);
    expect(flat.qualityReasons).toContain("no-luminance-detail");
    paint(image, 655, 840, (x) => (x % 2 ? 240 : 10));
    expect(measure(image)[0].metrics.sharpness).toBeGreaterThan(
      flat.metrics.sharpness,
    );
    expect(measure(image)[0].metrics.contrast).toBeGreaterThan(
      flat.metrics.contrast,
    );
  });
  it("bounds every metric and computation without conflating clipping, transparency or OCR evidence", () => {
    const image = pixels();
    paint(image, 0, image.height, (x, y) => ((x + y) % 2 ? 255 : 0));
    for (let i = 3; i < image.data.length; i += 8) image.data[i] = 0;
    for (const region of measure(image, "yugioh")) {
      expect(region.metrics.sampledPixels).toBeLessThanOrEqual(
        PRINTING_REGION_LIMITS.sampledPixels,
      );
      expect(region.metrics.sampledPixels).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(region.metrics)) {
        expect(Number.isFinite(value)).toBe(true);
        if (key !== "sampledPixels") {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
      expect(region.qualityReasons).toContain("transparent-pixels");
      expect(region.frameId).toBe("original-capture");
      expect(region.imageFingerprint).toBe("full-card-sha256");
      expect(region.rawText).toBeUndefined();
    }
  });
  it("rejects corrupted/detached-sized and non-byte pixel inputs before sampling", () => {
    const valid = pixels(2, 2);
    const invalid = [
      { ...valid, data: new Uint8ClampedArray(15) },
      { ...valid, data: new Uint8ClampedArray(17) },
      { ...valid, data: new Float32Array(16) },
      { ...valid, data: Array(16).fill(NaN) },
      { ...valid, width: 0 },
      { ...valid, width: 1.2 },
      { ...valid, height: NaN },
      { ...valid, width: 12_000_001 },
    ];
    for (const image of invalid) {
      expect(validPrintingPixels(image as PrintingRegionPixels)).toBe(false);
      expect(() => measure(image as PrintingRegionPixels)).toThrow();
    }
    for (const sourceMinEdge of [0, -1, Infinity, NaN])
      expect(() =>
        measurePrintingRegions(valid, {
          game: "pokemon",
          frameId: "f",
          imageFingerprint: "p",
          sourceMinEdge,
        }),
      ).toThrow();
  });
  it("handles a one-pixel region without invalid gradients and is deterministic", () => {
    const image = pixels(1, 1, 255);
    const first = measure(image);
    expect(first[0].metrics).toEqual({
      sampledPixels: 1,
      sharpness: 0,
      contrast: 0,
      highlightClippedFraction: 1,
      shadowClippedFraction: 0,
      transparentFraction: 0,
    });
    expect(measure(image)).toEqual(first);
  });
});
