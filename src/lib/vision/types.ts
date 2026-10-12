/** All coordinates are pixels in the original input frame. */
export interface Point { x: number; y: number }
export type Quad = [Point, Point, Point, Point];
export type VisionGame = "pokemon" | "mtg" | "yugioh";
export interface ReferenceMetadata {
  key: string;
  game: VisionGame;
  name: string;
  /** Same card identity across printings, when supplied by the provider. */
  identityKey?: string;
  /** Known shared illustration, including visually indistinguishable printings. */
  artworkKey?: string;
  setName?: string;
  number?: string;
  imageUrl?: string;
  sourceUrl?: string;
}
export interface ReferenceInput extends ReferenceMetadata { image: Blob }
/** Portable, JSON-safe ORB feature pack. It contains no executable content. */
export interface FeaturePack {
  version: 1;
  algorithm: "orb-phash-v1";
  width: 240;
  height: 336;
  name: string;
  source?: string;
  createdAt?: string;
  cards: ReferenceMetadata[];
  features: ReferenceFeatures[];
}
export interface ReferenceFeatures {
  key: string;
  /** Sixteen lowercase hex digits, 64-bit DCT perceptual hash. */
  hash: string;
  /** Sixteen lowercase hex digits, 64-bit horizontal difference hash. */
  differenceHash: string;
  /** Flat [x, y, x, y, ...] coordinates in canonical 240 x 336 reference. */
  points: number[];
  /** Base64-encoded, row-major 32-byte ORB descriptors. */
  descriptors: string;
}
export interface MatchEvidence {
  key: string;
  reference: ReferenceMetadata;
  hashDistance: number;
  tentativeMatches: number;
  inliers: number;
  inlierRatio: number;
  /** Inliers inside the game-specific artwork region, excluding shared borders. */
  interiorInliers: number;
  /** Fraction of canonical image area enclosed by matched reference points. */
  coverage: number;
  medianReprojectionError: number;
  /** Mean projected-reference-corner error relative to detected crop diagonal. */
  cornerError: number;
  geometricallyVerified: boolean;
}
export interface QualityEvidence {
  laplacianVariance: number;
  contrast: number;
  meanLuminance: number;
  saturatedFraction: number;
  sourceMinEdge: number;
  featureCount: number;
  issues: string[];
}
export type DetectionState = "verified" | "ambiguous" | "unknown" | "quality";
export interface CardDetection {
  quad: Quad;
  state: DetectionState;
  reason: string;
  quality: QualityEvidence;
  candidates: MatchEvidence[];
  /** True only with feature alignment, spatial support, and distinct-identity separation. */
  autoEligible: boolean;
  /** Multiple printings remain possible; auto eligibility is identity-only. */
  printingAmbiguous?: boolean;
  /** Crop was skipped/incomplete due to this frame’s bounded budget. */
  deferred?: boolean;
  /** Opt-in benchmark diagnostics, not confidence or proof of identity. */
  retrieval?: { shortlistKeys: string[]; retrievalMs: number };
  /** RGBA upright-normalized crop for optional OCR fallback; no OCR runs in this module. */
  crop?: ImageData;
}
export interface VisionOptions {
  game?: VisionGame;
  maxCards?: number;
  includeCrops?: boolean;
  includeDiagnostics?: boolean;
  /** Optional manual ROI, never a fallback for a failed detector. */
  region?: Quad;
  /** Soft bound checked between candidates/cards, capped at 1000 ms. */
  budgetMs?: number;
}
export interface VisionTimings { detectionMs: number; extractionMs: number; matchingMs: number; totalMs: number }
export interface VisionResult {
  width: number;
  height: number;
  detections: CardDetection[];
  timings: VisionTimings;
  coverage: VisionCoverage;
  budgetExhausted: boolean;
}
export interface VisionCoverage {
  totalReferences: number;
  byGame: Record<VisionGame, number>;
  packs: string[];
}
export interface VisionReady { engine: "OpenCV ORB + RANSAC"; coverage: VisionCoverage }
export interface ReferenceAdded { key: string; featureCount: number; coverage: VisionCoverage; features: ReferenceFeatures }
export type WorkerRequest =
  | { id: number; type: "initialize" }
  | { id: number; type: "add-reference"; reference: ReferenceMetadata; image: ImageBitmap | ImageData }
  | { id: number; type: "load-pack"; pack: FeaturePack }
  | { id: number; type: "analyze"; image: ImageBitmap | ImageData; options: VisionOptions }
  | { id: number; type: "clear" };
export type WorkerResponse = { id: number; result?: unknown; error?: string };
