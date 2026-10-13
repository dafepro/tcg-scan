import type { CapturedPixels } from "./frame-capture";

const COARSE_SIDE = 32;
const FINE_SIDE = COARSE_SIDE * 2;
const TILE_SIDE = 4;
export const PACK_PREFILTER_REFRESH_MS = 600;
export const PACK_PREFILTER_MAX_HISTORY_BYTES =
  2 * (COARSE_SIDE ** 2 + FINE_SIDE ** 2) * 3;

/** Scheduling evidence only. These tiny samples never establish a card identity,
 * physical copy, model confidence, or permission to save. No full-frame buffer or source-array alias is
 * retained: both sampled arrays are independent bounded allocations. */
export interface PackFrameSample {
  readonly width: number;
  readonly height: number;
  readonly signature: Uint8Array;
  readonly fine: Uint8Array;
  readonly mean: readonly [number, number, number];
  readonly quality: number;
  readonly fineDetail: number;
}

/** The same 4,096 source-pixel reads used by the original 32x32 inspection,
 * retaining the unaveraged samples as well to avoid hiding localized changes.
 * Work and sample storage are independent of full-frame dimensions. The caller
 * must first validate the native capture and its bounded, owned pixel layout. */
export function inspectPackFrame(
  image: CapturedPixels["image"],
): PackFrameSample {
  const signature = new Uint8Array(COARSE_SIDE ** 2 * 3);
  const fine = new Uint8Array(FINE_SIDE ** 2 * 3);
  const gray = new Float32Array(COARSE_SIDE ** 2);
  const fineGray = new Float32Array(FINE_SIDE ** 2);
  let luminance = 0,
    square = 0,
    red = 0,
    green = 0,
    blue = 0;
  for (let y = 0; y < COARSE_SIDE; y++)
    for (let x = 0; x < COARSE_SIDE; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(
            image.width - 1,
            Math.floor(((x + 0.25 + dx * 0.5) * image.width) / COARSE_SIDE),
          );
          const py = Math.min(
            image.height - 1,
            Math.floor(((y + 0.25 + dy * 0.5) * image.height) / COARSE_SIDE),
          );
          const offset = (py * image.width + px) * 4;
          const index = (y * 2 + dy) * FINE_SIDE + x * 2 + dx;
          const sr = image.data[offset],
            sg = image.data[offset + 1],
            sb = image.data[offset + 2];
          r += sr / 4;
          g += sg / 4;
          b += sb / 4;
          fine[index * 3] = sr;
          fine[index * 3 + 1] = sg;
          fine[index * 3 + 2] = sb;
          fineGray[index] = (77 * sr + 150 * sg + 29 * sb) / 256;
        }
      const i = y * COARSE_SIDE + x;
      signature[i * 3] = Math.round(r);
      signature[i * 3 + 1] = Math.round(g);
      signature[i * 3 + 2] = Math.round(b);
      const value = (77 * r + 150 * g + 29 * b) / 256;
      gray[i] = value;
      luminance += value;
      square += value * value;
      red += r;
      green += g;
      blue += b;
    }
  const detail = (values: Float32Array, side: number) => {
    let sum = 0;
    for (let y = 1; y < side - 1; y++)
      for (let x = 1; x < side - 1; x++) {
        const i = y * side + x;
        sum += Math.abs(
          4 * values[i] -
            values[i - 1] -
            values[i + 1] -
            values[i - side] -
            values[i + side],
        );
      }
    return sum / (side - 2) ** 2;
  };
  const variance = Math.max(
    0,
    square / gray.length - (luminance / gray.length) ** 2,
  );
  return {
    width: image.width,
    height: image.height,
    signature,
    fine,
    mean: [red / gray.length, green / gray.length, blue / gray.length],
    quality: detail(gray, COARSE_SIDE) + Math.sqrt(variance) * 0.15,
    fineDetail: detail(fineGray, FINE_SIDE),
  };
}

export function sharperPackSample(
  candidate: PackFrameSample,
  reference: PackFrameSample,
): boolean {
  return (
    candidate.quality > reference.quality * 1.05 + 0.1 ||
    candidate.fineDetail > reference.fineDetail * 1.05 + 0.1
  );
}

/** Conservative sampled similarity with a local guard. A low global average is
 * insufficient: every 4x4 fine-sample tile must also stay close. Only a small,
 * nearly neutral lighting offset is discounted, never arbitrary color changes
 * or motion compensation. Ambiguous movement is admitted, not discarded. */
export function similarPackSamples(
  a: PackFrameSample,
  b: PackFrameSample,
  meanLimit = 2,
): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const dr = a.mean[0] - b.mean[0],
    dg = a.mean[1] - b.mean[1],
    db = a.mean[2] - b.mean[2];
  const neutral = (dr + dg + db) / 3;
  const offset =
    Math.abs(neutral) <= 6 && Math.max(dr, dg, db) - Math.min(dr, dg, db) <= 1
      ? neutral
      : 0;
  let total = 0;
  for (let ty = 0; ty < FINE_SIDE; ty += TILE_SIDE)
    for (let tx = 0; tx < FINE_SIDE; tx += TILE_SIDE) {
      let tile = 0;
      for (let y = ty; y < ty + TILE_SIDE; y++)
        for (let x = tx; x < tx + TILE_SIDE; x++) {
          const index = (y * FINE_SIDE + x) * 3;
          for (let c = 0; c < 3; c++)
            tile += Math.abs(a.fine[index + c] - b.fine[index + c] - offset);
        }
      if (tile > TILE_SIDE ** 2 * 3 * 5) return false;
      total += tile;
    }
  return total <= a.fine.length * meanLimit;
}

export type PackPrefilterReason =
  | "first-view"
  | "changed-view"
  | "sharper-view"
  | "periodic-refresh"
  | "redundant-view";
export interface PackPrefilterDecision {
  admitted: boolean;
  reason: PackPrefilterReason;
  sample: PackFrameSample;
}

/** Consecutive-view admission before receipts/queue metadata. Both the previous
 * observation and the last admitted anchor must be redundant before skipping;
 * incremental changes therefore cannot indefinitely move the comparison anchor.
 * A single-frame reveal needs no debounce. Stable views refresh every 600 ms.
 * Only two small sampled descriptors are retained, never a full-frame buffer. */
export class PackPrefilter {
  private previous?: PackFrameSample;
  private anchor?: PackFrameSample;
  private admittedAt = -Infinity;

  inspect(
    image: CapturedPixels["image"],
    capturedAt: number,
  ): PackPrefilterDecision {
    const sample = inspectPackFrame(image);
    let reason: PackPrefilterReason;
    if (!this.previous || !this.anchor) reason = "first-view";
    else if (sharperPackSample(sample, this.anchor)) reason = "sharper-view";
    else if (
      !similarPackSamples(sample, this.previous) ||
      !similarPackSamples(sample, this.anchor)
    )
      reason = "changed-view";
    else if (capturedAt - this.admittedAt >= PACK_PREFILTER_REFRESH_MS)
      reason = "periodic-refresh";
    else reason = "redundant-view";
    this.previous = sample;
    if (reason !== "redundant-view") {
      this.anchor = sample;
      this.admittedAt = capturedAt;
    }
    return { admitted: reason !== "redundant-view", reason, sample };
  }

  reset(): void {
    this.previous = undefined;
    this.anchor = undefined;
    this.admittedAt = -Infinity;
  }
  get retainedBytes(): number {
    const bytes = (sample?: PackFrameSample) =>
      sample ? sample.signature.byteLength + sample.fine.byteLength : 0;
    return (
      bytes(this.previous) +
      (this.anchor === this.previous ? 0 : bytes(this.anchor))
    );
  }
}
