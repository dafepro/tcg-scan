import { describe, expect, it } from "vitest";
import type { CapturedPixels } from "./frame-capture";
import {
  PACK_PREFILTER_MAX_HISTORY_BYTES,
  PACK_PREFILTER_REFRESH_MS,
  PackPrefilter,
  inspectPackFrame,
  similarPackSamples,
} from "./pack-prefilter";

function image(
  pixel: (
    x: number,
    y: number,
  ) => number | readonly [number, number, number] = () => 100,
  width = 64,
  height = 64,
): CapturedPixels["image"] {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y),
        channels = typeof value === "number" ? [value, value, value] : value;
      const i = (y * width + x) * 4;
      data[i] = channels[0];
      data[i + 1] = channels[1];
      data[i + 2] = channels[2];
      data[i + 3] = 255;
    }
  return { width, height, data };
}

describe("bounded consecutive-view pack prefilter", () => {
  it("skips static holds before queue admission and periodically refreshes", () => {
    const filter = new PackPrefilter(),
      admitted: number[] = [];
    for (let time = 0; time <= 2400; time += 120) {
      const decision = filter.inspect(image(), time);
      if (decision.admitted) admitted.push(time);
      expect(decision.reason).toBe(
        time === 0
          ? "first-view"
          : time % PACK_PREFILTER_REFRESH_MS === 0
            ? "periodic-refresh"
            : "redundant-view",
      );
    }
    expect(admitted).toEqual([0, 600, 1200, 1800, 2400]);
  });

  it("does not hide localized subtle changes behind a tiny global mean difference", () => {
    const original = image(),
      changed = image((x, y) =>
        x >= 28 && x < 36 && y >= 48 && y < 52 ? 112 : 100,
      );
    const a = inspectPackFrame(original),
      b = inspectPackFrame(changed);
    const globalMean =
      a.signature.reduce(
        (sum, value, i) => sum + Math.abs(value - b.signature[i]),
        0,
      ) / a.signature.length;
    expect(globalMean).toBeLessThan(0.1);
    expect(similarPackSamples(a, b, 5)).toBe(false);
    const filter = new PackPrefilter();
    filter.inspect(original, 0);
    expect(filter.inspect(changed, 120).admitted).toBe(true);
  });

  it("retains fine title-like changes that cancel out in the coarse grid averages", () => {
    const original = image(),
      changed = image((x, y) =>
        x >= 24 && x < 32 && y >= 48 && y < 56
          ? 100 + ((x + y) % 2 ? 20 : -20)
          : 100,
      );
    expect(inspectPackFrame(original).signature).toEqual(
      inspectPackFrame(changed).signature,
    );
    expect(
      similarPackSamples(
        inspectPackFrame(original),
        inspectPackFrame(changed),
        5,
      ),
    ).toBe(false);
    const filter = new PackPrefilter();
    filter.inspect(original, 0);
    expect(filter.inspect(changed, 120).admitted).toBe(true);
  });

  it("admits a one-frame reveal immediately and also admits the return view", () => {
    const filter = new PackPrefilter();
    const a = () =>
      image((x, y) => (x >= 20 && x < 28 && y >= 24 && y < 40 ? 135 : 100));
    const b = () =>
      image((x, y) => (x >= 36 && x < 44 && y >= 24 && y < 40 ? 135 : 100));
    expect(filter.inspect(a(), 0).admitted).toBe(true);
    expect(filter.inspect(a(), 120).admitted).toBe(false);
    expect(filter.inspect(b(), 240).admitted).toBe(true);
    expect(filter.inspect(a(), 360).admitted).toBe(true);
  });

  it("admits improved sharpness even inside the redundant similarity band", () => {
    const filter = new PackPrefilter();
    const pattern = (contrast: number) =>
      image((x, y) => 100 + (((x >> 1) + (y >> 1)) % 2 ? contrast : -contrast));
    const soft = pattern(4),
      sharper = pattern(5);
    expect(
      similarPackSamples(inspectPackFrame(soft), inspectPackFrame(sharper)),
    ).toBe(true);
    filter.inspect(soft, 0);
    expect(filter.inspect(sharper, 120)).toMatchObject({
      admitted: true,
      reason: "sharper-view",
    });
  });

  it("preserves sharper fine detail even when coarse averages and quality are unchanged", () => {
    const filter = new PackPrefilter();
    const pattern = (contrast: number) =>
      image((x, y) => 100 + ((x + y) % 2 ? contrast : -contrast));
    const soft = pattern(2),
      sharper = pattern(3);
    expect(inspectPackFrame(soft).quality).toBe(
      inspectPackFrame(sharper).quality,
    );
    expect(
      similarPackSamples(inspectPackFrame(soft), inspectPackFrame(sharper)),
    ).toBe(true);
    filter.inspect(soft, 0);
    expect(filter.inspect(sharper, 120)).toMatchObject({
      admitted: true,
      reason: "sharper-view",
    });
  });

  it("compares gradual small changes against the admitted anchor instead of drifting forever", () => {
    const filter = new PackPrefilter();
    filter.inspect(
      image(() => [100, 100, 100]),
      0,
    );
    for (let red = 1; red <= 6; red++)
      expect(
        filter.inspect(
          image(() => [100 + red, 100, 100]),
          red * 20,
        ).admitted,
      ).toBe(false);
    expect(
      filter.inspect(
        image(() => [107, 100, 100]),
        140,
      ),
    ).toMatchObject({ admitted: true, reason: "changed-view" });
  });

  it("tolerates small neutral lighting shifts and gentle jitter but admits substantial motion/color changes", () => {
    const filter = new PackPrefilter();
    filter.inspect(
      image((x) => 80 + x),
      0,
    );
    expect(
      filter.inspect(
        image((x) => 84 + x),
        120,
      ).admitted,
    ).toBe(false);
    expect(
      filter.inspect(
        image((x) => 85 + x),
        240,
      ).admitted,
    ).toBe(false);
    expect(
      filter.inspect(
        image((x) => 100 + x),
        360,
      ).admitted,
    ).toBe(true);
    expect(
      filter.inspect(
        image((x, y) => ((x + y) % 8 < 4 ? 80 : 160)),
        480,
      ).admitted,
    ).toBe(true);
    expect(
      filter.inspect(
        image((x, y) => ((x + y + 1) % 8 < 4 ? 80 : 160)),
        540,
      ).admitted,
    ).toBe(true);
  });

  it("admits changed dimensions and starts fresh after an explicit history reset", () => {
    const filter = new PackPrefilter();
    filter.inspect(image(), 0);
    expect(
      filter.inspect(
        image(() => 100, 128, 64),
        120,
      ).admitted,
    ).toBe(true);
    filter.reset();
    expect(filter.retainedBytes).toBe(0);
    expect(
      filter.inspect(
        image(() => 100, 128, 64),
        130,
      ),
    ).toMatchObject({ admitted: true, reason: "first-view" });
  });

  it("retains at most two fixed-size descriptors, never the captured full-frame history", () => {
    const filter = new PackPrefilter(),
      pixels = image(() => 100, 1920, 1080);
    const first = filter.inspect(pixels, 0);
    expect(first.sample.signature.byteLength).toBe(32 * 32 * 3);
    expect(first.sample.fine.byteLength).toBe(64 * 64 * 3);
    expect(first.sample.signature.buffer).not.toBe(pixels.data.buffer);
    expect(first.sample.fine.buffer).not.toBe(pixels.data.buffer);
    pixels.data.fill(0);
    expect(first.sample.fine[0]).toBe(100);
    for (let frame = 1; frame < 200; frame++) {
      filter.inspect(
        image(() => 100 + (frame % 2)),
        frame * 120,
      );
      expect(filter.retainedBytes).toBeLessThanOrEqual(
        PACK_PREFILTER_MAX_HISTORY_BYTES,
      );
    }
    expect(PACK_PREFILTER_MAX_HISTORY_BYTES).toBe(30_720);
    filter.reset();
    expect(filter.retainedBytes).toBe(0);
  });
});
