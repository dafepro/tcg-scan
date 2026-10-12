import type { RoiContinuityFrame, RoiContinuityResult } from "./roi-continuity";
export type { RoiContinuityFrame, RoiContinuityResult } from "./roi-continuity";

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
  /** Opt-in learned whole-photo diagnostic evidence for every grouped corner hypothesis. */
  hypotheses?: CardDetection[];
  /** Opt-in native-width480..960 downstream OCR crop (336/240 aspect), produced only for a final eligible group. */
  printingCrop?: ImageData;
  /** Native current-frame minimum quad edge BEFORE warp; always>=480 if present. */
  printingSourceMinEdge?: number;
  /** RGBA upright-normalized crop for optional OCR fallback; no OCR runs in this module. */
  crop?: ImageData;
}
export interface VisionInitializeOptions { matcher?: "orb" | "learned"; game?: VisionGame }
export interface VisionOptions {
  /** Photo uses the entire frozen automatic proposal protocol and a larger budget. */
  mode?: "stream" | "binder" | "photo";
  game?: VisionGame;
  maxCards?: number;
  includeCrops?: boolean;
  includeDiagnostics?: boolean;
  /** Off by default. At most2 native-resolution crops after learned identity verification. */
  includePrintingCrops?: boolean;
  /** Defaults1, capped2. Does not affect matching or proposals. */
  maxPrintingCrops?: number;
  /** At most2 optional downstream crop targets; never matcher/proposal overrides. */
  printingRegions?: Quad[];
  /** Optional manual ROI, never a fallback for a failed detector. */
  region?: Quad;
  /** Soft bound: ORB <=1000ms; learned photo <=120000ms, preview <=4000ms. */
  budgetMs?: number;
  /** Opt-in preview scheduling only; default remains three identity observations. */
  previewBurstObservations?: 1 | 3;
}
export interface VisionTimings { detectionMs: number; extractionMs: number; matchingMs: number; totalMs: number; descriptorMatchingMs?: number; geometryMs?: number; referenceReadMs?: number }
export interface VisionResult {
  width: number;
  height: number;
  detections: CardDetection[];
  timings: VisionTimings;
  coverage: VisionCoverage;
  budgetExhausted: boolean;
  /** False means the full current-frame proposal pass is unavailable; never infer an empty scene. */
  detectionComplete?: boolean;
  /** Learned scheduling diagnostics; timings are observations, never FPS promises. */
  scheduling?: { processedGroups: number; deferredGroups: number; proposalRefresh: boolean; proposalCacheReused: boolean; softBudgetMs: number; overrunMs: number; focusedGroup?: number; burstFrame?: number; focusAttempt?: number };
}
export interface VisionCoverage {
  totalReferences: number;
  byGame: Record<VisionGame, number>;
  packs: string[];
}
export interface VisionReady { engine: "OpenCV ORB + RANSAC" | "XFeat256/int8 + RANSAC"; coverage: VisionCoverage }
export interface ReferenceAdded { key: string; featureCount: number; coverage: VisionCoverage; features: ReferenceFeatures }
/** Plain packed RGBA pixels are accepted without allocating a native ImageData. */
export interface VisionFramePixels {
  width: number;
  height: number;
  /** Runtime validation rejects shared, detached, or incorrectly sized storage. */
  data: Uint8ClampedArray;
}
export type VisionFrame = ImageBitmap | VisionFramePixels;
export interface VisionContinuityRequest {
  batchId: string;
  /** A new batch only: ROIs from the unchanged identity/geometric verifier.
   * Every quad is in the shared first grayscale frame's coordinates. */
  seeds?: Array<{ eventId: string; quad: Quad }>;
  /** Ownership is consumed. One to 120 consecutive real captures, at most 32 MiB. */
  frames: RoiContinuityFrame[];
  latestFrameId: number;
  /** Same absolute monotonic clock as performance.timeOrigin + performance.now(). */
  latestTimestampMs: number;
}
export interface VisionContinuityResult { batchId: string; results: RoiContinuityResult[] }

/** Shared wire validation runs before transfer and again in the worker. */
export function continuityTransfers(request: VisionContinuityRequest): ArrayBuffer[] {
  const invalid = () => { throw new Error("Invalid bounded ROI continuity request."); };
  const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && value.trim().length > 0;
  if (!request || !identifier(request.batchId) || !Array.isArray(request.frames) || request.frames.length < 1 || request.frames.length > 120 || !Number.isSafeInteger(request.latestFrameId) || request.latestFrameId < 0 || !Number.isFinite(request.latestTimestampMs) || request.latestTimestampMs < 0) return invalid();
  if (request.seeds !== undefined) {
    if (!Array.isArray(request.seeds) || request.seeds.length < 1 || request.seeds.length > 9) return invalid();
    const ids = new Set<string>();
    for (const seed of request.seeds) {
      if (!seed || !identifier(seed.eventId) || ids.has(seed.eventId) || !Array.isArray(seed.quad) || seed.quad.length !== 4 || !seed.quad.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return invalid();
      ids.add(seed.eventId);
    }
  }
  const transfers = new Set<ArrayBuffer>();
  let bytes = 0, backingBytes = 0, previous: RoiContinuityFrame | undefined;
  for (const frame of request.frames) {
    if (!frame || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 64 || frame.height < 64 || Math.max(frame.width, frame.height) > 640 || !(frame.gray instanceof Uint8Array) || !(frame.gray.buffer instanceof ArrayBuffer) || frame.gray.length !== frame.width * frame.height || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0 || !Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) return invalid();
    bytes += frame.gray.byteLength;
    if (!transfers.has(frame.gray.buffer)) { backingBytes += frame.gray.buffer.byteLength; transfers.add(frame.gray.buffer); }
    if (bytes > 32 * 1024 * 1024 || backingBytes > 32 * 1024 * 1024) return invalid();
    if (previous && (frame.width !== previous.width || frame.height !== previous.height || frame.frameId !== previous.frameId + 1 || frame.timestampMs <= previous.timestampMs || frame.timestampMs - previous.timestampMs > 300)) return invalid();
    previous = frame;
  }
  if (previous!.frameId !== request.latestFrameId || previous!.timestampMs !== request.latestTimestampMs || previous!.timestampMs - request.frames[0].timestampMs > 12_000) return invalid();
  return [...transfers];
}
export type WorkerRequest =
  | { id: number; type: "initialize"; options?: VisionInitializeOptions }
  | { id: number; type: "add-reference"; reference: ReferenceMetadata; image: VisionFrame }
  | { id: number; type: "load-pack"; pack: FeaturePack }
  | { id: number; type: "analyze"; image: VisionFrame; options: VisionOptions }
  | { id: number; type: "verify-continuity"; request: VisionContinuityRequest }
  | { id: number; type: "reset-continuity" }
  | { id: number; type: "clear" };
export type WorkerResponse = {
  id: number;
  result?: unknown;
  error?: string;
  progress?: string;
  /** Returned input ownership, never shared with any live result crop. */
  frameBuffer?: ArrayBuffer;
};
