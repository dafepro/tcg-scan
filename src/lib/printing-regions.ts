import type { VisionGame } from "./vision/types";

/** Geometry/configuration version, not a claim of validated template coverage. */
export const PRINTING_REGION_VERSION = "printing-regions-v1";
export const PRINTING_REGION_LIMITS = Object.freeze({
  regions: 2,
  sampledPixels: 16_384,
  maxPixels: 12_000_000,
  outputWidth: 1800,
  rawText: 2048,
});

export type PrintingRegionId =
  "pokemon-footer" | "mtg-footer" | "yugioh-set-code" | "yugioh-footer";
export interface PrintingRegionDefinition {
  readonly id: PrintingRegionId;
  readonly game: VisionGame;
  readonly top: number;
  readonly height: number;
}
/** Preserve the existing reader's geometry; these are broad fallback zones,
 * not detected glyph bounds or proof that every card template is supported. */
export const PRINTING_REGION_REGISTRY: Readonly<
  Record<VisionGame, readonly PrintingRegionDefinition[]>
> = Object.freeze({
  pokemon: Object.freeze([
    Object.freeze({
      id: "pokemon-footer",
      game: "pokemon",
      top: 0.78,
      height: 0.22,
    } as const),
  ]),
  mtg: Object.freeze([
    Object.freeze({
      id: "mtg-footer",
      game: "mtg",
      top: 0.81,
      height: 0.19,
    } as const),
  ]),
  yugioh: Object.freeze([
    Object.freeze({
      id: "yugioh-set-code",
      game: "yugioh",
      top: 0.51,
      height: 0.18,
    } as const),
    Object.freeze({
      id: "yugioh-footer",
      game: "yugioh",
      top: 0.88,
      height: 0.12,
    } as const),
  ]),
});

export type PrintingRegionQualityReason =
  | "no-luminance-detail"
  | "highlight-clipping"
  | "shadow-clipping"
  | "transparent-pixels"
  | "source-detail-limited";
export interface PrintingRegionMetrics {
  sampledPixels: number;
  /** Mean adjacent-pixel luminance difference / 255, sampled before OCR resizing.
   * A descriptive texture statistic, not focus, readability or OCR confidence. */
  sharpness: number;
  /** Sampled luminance standard deviation / 127.5, bounded to [0, 1]. */
  contrast: number;
  /** Fraction with all RGB channels >= 250. White print can also trigger this;
   * neither this nor shadow clipping establishes glare, material or finish. */
  highlightClippedFraction: number;
  /** Fraction with all RGB channels <= 5. */
  shadowClippedFraction: number;
  transparentFraction: number;
}
export interface PrintingRegionEvidence {
  regionId: PrintingRegionId;
  registryVersion: string;
  /** ORIGINAL full-card capture lineage. Multiple regions never add votes. */
  frameId: string;
  imageFingerprint: string;
  /** Actual ROI pixels in the rectified capture, before reader downscaling.
   * Rectification may already have downscaled; these are not character sizes. */
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  /** Native source-quad shorter edge, before rectification/resizing. */
  sourceMinEdge: number;
  metrics: PrintingRegionMetrics;
  /** Advisory measurements only. Never feed these into acceptance/absence rules. */
  qualityReasons: PrintingRegionQualityReason[];
  /** Literal, uncorrected region read, bounded independently of the joined read. */
  rawText?: string;
  rawTextTruncated?: boolean;
}
export interface PrintingRegionPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Validate before hashing/sampling, including detached/short/overlong buffers. */
export function validPrintingPixels(image: PrintingRegionPixels): boolean {
  return (
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.width * image.height <= PRINTING_REGION_LIMITS.maxPixels &&
    (image.data instanceof Uint8ClampedArray ||
      image.data instanceof Uint8Array) &&
    image.data.length === image.width * image.height * 4
  );
}

export function printingRegionBounds(
  game: VisionGame,
  width: number,
  height: number,
): Pick<
  PrintingRegionEvidence,
  "regionId" | "x" | "y" | "width" | "height" | "outputWidth" | "outputHeight"
>[] {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > PRINTING_REGION_LIMITS.maxPixels
  )
    throw new Error("Invalid printing region dimensions");
  return PRINTING_REGION_REGISTRY[game].map((region) => {
    const y = Math.floor(region.top * height);
    const cropHeight = Math.min(height - y, Math.ceil(region.height * height));
    const scale = Math.min(1, PRINTING_REGION_LIMITS.outputWidth / width);
    return {
      regionId: region.id,
      x: 0,
      y,
      width,
      height: cropHeight,
      outputWidth: Math.max(1, Math.round(width * scale)),
      outputHeight: Math.max(1, Math.round(cropHeight * scale)),
    };
  });
}

/** Bounded, deterministic sampling of native-resolution ROI pixels. There is no
 * calibrated readability cutoff, glyph-size estimator, occlusion classifier or
 * glare detector here. Do not turn a missing read into evidence of absence. */
export function measurePrintingRegions(
  image: PrintingRegionPixels,
  input: {
    game: VisionGame;
    frameId: string;
    imageFingerprint: string;
    sourceMinEdge: number;
  },
): PrintingRegionEvidence[] {
  if (!validPrintingPixels(image))
    throw new Error("Invalid printing RGBA pixels");
  if (!Number.isFinite(input.sourceMinEdge) || input.sourceMinEdge <= 0)
    throw new Error("Invalid native source dimensions");
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  const luminance = (offset: number) =>
    image.data[offset] * 0.2126 +
    image.data[offset + 1] * 0.7152 +
    image.data[offset + 2] * 0.0722;
  return printingRegionBounds(input.game, image.width, image.height).map(
    (region) => {
      const count = Math.min(
        region.width * region.height,
        PRINTING_REGION_LIMITS.sampledPixels,
      );
      let mean = 0,
        squaredDeviation = 0,
        gradient = 0,
        edges = 0;
      let highlights = 0,
        shadows = 0,
        transparent = 0;
      // Evenly spaced linear samples cap work independently of source dimensions.
      // Gradients always compare immediate neighbours, never the sampling stride.
      for (let sample = 0; sample < count; sample++) {
        const index = Math.floor(
          (sample * region.width * region.height) / count,
        );
        const x = index % region.width,
          y = Math.floor(index / region.width);
        const offset = ((region.y + y) * image.width + region.x + x) * 4;
        const value = luminance(offset);
        const delta = value - mean;
        mean += delta / (sample + 1);
        squaredDeviation += delta * (value - mean);
        if (x + 1 < region.width) {
          gradient += Math.abs(value - luminance(offset + 4));
          edges++;
        }
        if (y + 1 < region.height) {
          gradient += Math.abs(value - luminance(offset + image.width * 4));
          edges++;
        }
        if (
          image.data[offset] >= 250 &&
          image.data[offset + 1] >= 250 &&
          image.data[offset + 2] >= 250
        )
          highlights++;
        if (
          image.data[offset] <= 5 &&
          image.data[offset + 1] <= 5 &&
          image.data[offset + 2] <= 5
        )
          shadows++;
        if (image.data[offset + 3] < 255) transparent++;
      }
      const variance = Math.max(0, squaredDeviation / count);
      const metrics: PrintingRegionMetrics = {
        sampledPixels: count,
        sharpness: unit(edges ? gradient / edges / 255 : 0),
        contrast: unit(Math.sqrt(variance) / 127.5),
        highlightClippedFraction: unit(highlights / count),
        shadowClippedFraction: unit(shadows / count),
        transparentFraction: unit(transparent / count),
      };
      const qualityReasons: PrintingRegionQualityReason[] = [];
      if (metrics.contrast === 0 && metrics.sharpness === 0)
        qualityReasons.push("no-luminance-detail");
      if (highlights) qualityReasons.push("highlight-clipping");
      if (shadows) qualityReasons.push("shadow-clipping");
      if (transparent) qualityReasons.push("transparent-pixels");
      if (input.sourceMinEdge < Math.min(image.width, image.height))
        qualityReasons.push("source-detail-limited");
      return {
        ...region,
        registryVersion: PRINTING_REGION_VERSION,
        frameId: input.frameId,
        imageFingerprint: input.imageFingerprint,
        sourceMinEdge: input.sourceMinEdge,
        metrics,
        qualityReasons,
      };
    },
  );
}
