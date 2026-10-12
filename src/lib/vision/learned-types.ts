import type { Quad, ReferenceMetadata } from "./types";

/** Frozen XFeat256/int8 reference representation. Scores are not probabilities. */
export const LEARNED_ALGORITHM = "xfeat256-int8-v1" as const;
export const LEARNED_REFERENCE_POINTS = 256;
export const LEARNED_DESCRIPTOR_DIMENSIONS = 64;
export const LEARNED_MAX_QUERY_POINTS = 500;

export interface LearnedIndexCard extends ReferenceMetadata {
  hash: string;
  differenceHash: string;
  /** Local storage locator, never a remote URL. */
  featureId: string;
}

export interface LearnedReferenceFeatures {
  key: string;
  /** Canonical 240 x 336 coordinates, interleaved x/y. */
  points: Float32Array;
  /** Row-major signed int8, 256 x 64. */
  descriptors: Int8Array;
  /** One float32 quantization scale per descriptor. */
  scales: Float32Array;
}

export interface LearnedQueryFeatures {
  /** Canonical 240 x 336 coordinates, interleaved x/y. */
  points: Float32Array;
  /** L2-normalized row-major float32 descriptors, up to 500 x 64. */
  descriptors: Float32Array;
  scores: Float32Array;
  timings?: {
    preprocessingMs: number;
    inferenceMs: number;
    postprocessingMs: number;
    totalMs: number;
  };
}

export interface LearnedModels {
  extract(image: ImageData): Promise<LearnedQueryFeatures>;
  /** Default remains the frozen full-frame + 3 x 3 protocol. Pack explicitly uses one whole-frame inference. */
  propose(image: ImageData, profile?: "full" | "pack"): Promise<Quad[]>;
  dispose(): void | Promise<void>;
}
