import type { ScanTrack } from "./scan-session";
import { printingRegionBounds, validPrintingPixels } from "./printing-regions";
import type { PrintingRegionPixels } from "./printing-regions";
import type { VisionGame } from "./vision/types";

/** Scheduling limits only. None of these measurements can supply evidence,
 * repair a literal read, or change the independent resolver's acceptance. */
export const PRINTING_SCHEDULING_LIMITS = Object.freeze({
  retainedCaptures: 2,
  retainedMs: 8_000,
  unchangedRefreshMs: 6_000,
  sampleWidth: 48,
  sampleHeight: 12,
  settledViewMs: 600,
  settledViewGapMs: 1_500,
  settledViewSamples: 8,
});

export interface PrintingViewSample {
  pixels: Uint8Array;
  sourceMinEdge: number;
  texture: number;
  /** Non-cryptographic repeat hint only. It can reject redundant work, never
   * establish distinct evidence; the reader still hashes every accepted read. */
  repeatKey: string;
}
export interface RecentPrintingView {
  frameId: string;
  capturedAt: number;
  view: PrintingViewSample;
}

/** Tiny samples from the reader's existing fixed regions, before OCR. Their
 * similarity/texture are uncalibrated scheduling hints, never readability or
 * a substitute for the reader's complete source-pixel SHA-256 fingerprint. */
export function samplePrintingView(
  image: PrintingRegionPixels,
  game: VisionGame,
  sourceMinEdge: number,
): PrintingViewSample | undefined {
  if (!validPrintingPixels(image) || !Number.isFinite(sourceMinEdge)) return;
  const regions = printingRegionBounds(game, image.width, image.height);
  let first = 2166136261,
    second = 5381;
  // Full input bytes detect known repeats even when a complete literal is
  // waiting for agreement. Collisions can only defer an optional read.
  const bytes = new DataView(
    image.data.buffer,
    image.data.byteOffset,
    image.data.byteLength,
  );
  for (let i = 0; i < image.data.byteLength; i += 4) {
    const word = bytes.getUint32(i, true);
    first = Math.imul(first ^ word, 16777619);
    second = Math.imul(second, 33) ^ word;
  }
  const { sampleWidth: width, sampleHeight: height } =
    PRINTING_SCHEDULING_LIMITS;
  const pixels = new Uint8Array(regions.length * width * height);
  let gradient = 0;
  for (const [r, region] of regions.entries()) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Integrate the full source footprint. Nearest-point samples alias
        // printed glyph edges: a subpixel rectification shift can otherwise
        // look like a new response while the identifier remains covered.
        const left = (x * region.width) / width;
        const right = ((x + 1) * region.width) / width;
        const top = (y * region.height) / height;
        const bottom = ((y + 1) * region.height) / height;
        let sum = 0;
        for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
          for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
            const weight =
              (Math.min(right, sx + 1) - Math.max(left, sx)) *
              (Math.min(bottom, sy + 1) - Math.max(top, sy));
            const offset =
              ((region.y + Math.min(region.height - 1, sy)) * image.width +
                region.x +
                Math.min(region.width - 1, sx)) *
              4;
            sum +=
              (weight *
                (77 * image.data[offset] +
                  150 * image.data[offset + 1] +
                  29 * image.data[offset + 2])) /
              256;
          }
        }
        const value = Math.round(sum / ((right - left) * (bottom - top)));
        const index = r * width * height + y * width + x;
        pixels[index] = value;
        if (x) gradient += Math.abs(value - pixels[index - 1]);
      }
    }
  }
  return {
    pixels,
    sourceMinEdge,
    texture: gradient / Math.max(1, pixels.length) / 255,
    repeatKey: `${image.width}x${image.height}:${first >>> 0}:${second >>> 0}`,
  };
}

export function printingViewDifference(
  previous: PrintingViewSample,
  next: PrintingViewSample,
): number {
  if (previous.pixels.length !== next.pixels.length) return Infinity;
  let difference = 0;
  for (let i = 0; i < next.pixels.length; i++)
    difference += Math.abs(next.pixels[i] - previous.pixels[i]);
  return difference / Math.max(1, next.pixels.length) / 255;
}

export function printingViewChanged(
  previous: PrintingViewSample,
  next: PrintingViewSample,
): boolean {
  return (
    next.sourceMinEdge >= previous.sourceMinEdge * 1.08 ||
    printingViewDifference(previous, next) >= 0.035
  );
}

/** Observe all eligible offered views, not only views eventually sent to OCR.
 * A moving hand/crop must settle before change can accelerate a prompted read.
 * This is still scheduling advice: no continuity or identity claim is made. */
export function rememberPrintingView(
  history: readonly RecentPrintingView[],
  current: RecentPrintingView,
): RecentPrintingView[] {
  const previous = history.at(-1);
  if (
    previous &&
    (current.capturedAt <= previous.capturedAt ||
      history.some((entry) => entry.frameId === current.frameId))
  )
    return [...history];
  const retained =
    previous &&
    current.capturedAt - previous.capturedAt >
      PRINTING_SCHEDULING_LIMITS.settledViewGapMs
      ? []
      : history;
  return [...retained, current].slice(
    -PRINTING_SCHEDULING_LIMITS.settledViewSamples,
  );
}

export function printingViewSettled(
  history: readonly RecentPrintingView[],
): boolean {
  const latest = history.at(-1);
  if (!latest || history.length < 2) return false;
  let start = -1;
  for (let i = 0; i < history.length - 1; i++)
    if (
      latest.capturedAt - history[i].capturedAt >=
      PRINTING_SCHEDULING_LIMITS.settledViewMs
    )
      start = i;
  if (start < 0) return false;
  for (let i = start; i < history.length; i++)
    for (let j = i + 1; j < history.length; j++)
      if (
        printingViewChanged(history[i].view, history[j].view) ||
        printingViewChanged(history[j].view, history[i].view)
      )
        return false;
  return true;
}

/** Keep a materially more detailed pending view; otherwise prefer the latest
 * original capture. This bounds stale work without ranking by the OCR answer. */
export function preferPrintingView(
  previous: PrintingViewSample,
  next: PrintingViewSample,
): boolean {
  if (next.sourceMinEdge < previous.sourceMinEdge * 0.92) return false;
  if (next.sourceMinEdge >= previous.sourceMinEdge * 1.08) return true;
  if (
    previous.texture > next.texture * 1.2 &&
    previous.texture - next.texture > 0.01
  )
    return false;
  return true;
}

/** Scheduling hints only: a rotated/deferred group can hide a settled stream
 * overlay in the previous result. That must not prevent requesting a crop when
 * its NEXT current-frame identity is verified. The engine and offerPrinting
 * still require fresh eligible pixels; this selector supplies no evidence. */
export function pendingPrintingTracks<
  T extends Pick<ScanTrack, "eventId" | "status">,
>(
  tracks: readonly T[],
  printed: ReadonlySet<string>,
  ready: (eventId: string) => boolean,
  priority: (eventId: string) => number = () => 0,
): T[] {
  return tracks
    .filter(
      (track) =>
        track.status === "added" &&
        !printed.has(track.eventId) &&
        ready(track.eventId),
    )
    .sort((a, b) => priority(b.eventId) - priority(a.eventId));
}
