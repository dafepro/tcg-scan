import { VisionEngine } from "./engine";
import type { Cv } from "./engine";
import { distance, hullArea, isConvexQuad, median, projectPoint } from "./geometry";
import { HashIndex, MAX_HASH_REFERENCES } from "./hash";
import { learnedPolygonIoU } from "./learned-models";
import type { LearnedSimilarity } from "./learned-models";
import { decideMatch, evidenceRank, hasGeometricEvidence } from "./scoring";
import type { LearnedIndexCard, LearnedModels, LearnedQueryFeatures, LearnedReferenceFeatures } from "./learned-types";
import type { CardDetection, MatchEvidence, Point, Quad, QualityEvidence, VisionCoverage, VisionOptions, VisionResult, VisionTimings } from "./types";

const WIDTH = 240, HEIGHT = 336, DIMENSIONS = 64, CACHE_LIMIT = 8;
const canonicalCorners: Quad = [{ x: 0, y: 0 }, { x: WIDTH - 1, y: 0 }, { x: WIDTH - 1, y: HEIGHT - 1 }, { x: 0, y: HEIGHT - 1 }];
export const LEARNED_PREVIEW_REFRESH_MS = 1500;
const emptyQuality = (): QualityEvidence => ({ laplacianVariance: 0, contrast: 0, meanLuminance: 0, saturatedFraction: 0, sourceMinEdge: 0, featureCount: 0, issues: [] });
const identity = (candidate: MatchEvidence) => candidate.reference.identityKey || candidate.key;
function deferred(quad: Quad, reason = "Verification is incomplete; keep this card for another frame."): CardDetection {
  return { quad, state: "unknown", reason, quality: emptyQuality(), candidates: [], autoEligible: false, deferred: true };
}
function validateQuery(query: LearnedQueryFeatures): void {
  const count = query.points.length / 2;
  if (!Number.isInteger(count) || count > 500 || query.descriptors.length !== count * DIMENSIONS || query.scores.length !== count || !query.points.every((v, i) => Number.isFinite(v) && v >= 0 && v < (i % 2 ? HEIGHT : WIDTH)) || !query.descriptors.every(Number.isFinite) || !query.scores.every(Number.isFinite)) throw new Error("Invalid learned query features; recognition stopped.");
  for (let row = 0; row < count; row++) {
    let sum = 0;
    for (let d = 0; d < DIMENSIONS; d++) sum += query.descriptors[row * DIMENSIONS + d] ** 2;
    if (Math.abs(sum - 1) > .002) throw new Error("Learned query descriptors are not L2-normalized.");
  }
}
/** Frozen per-vector signed int8*float32 scale, followed by L2 normalization. */
export function dequantizeLearnedReference(features: LearnedReferenceFeatures): Float32Array {
  if (features.points.length !== 512 || features.descriptors.length !== 256 * DIMENSIONS || features.scales.length !== 256 || !features.points.every((v, i) => Number.isFinite(v) && v >= 0 && v < (i % 2 ? HEIGHT : WIDTH)) || !features.scales.every(v => Number.isFinite(v) && v > 0) || features.descriptors.some(v => v < -127)) throw new Error("Invalid learned reference descriptor block.");
  const output = new Float32Array(features.descriptors.length);
  for (let row = 0; row < 256; row++) {
    let square = 0;
    for (let d = 0; d < DIMENSIONS; d++) { const index = row * DIMENSIONS + d; output[index] = features.descriptors[index] * features.scales[row]; square += output[index] ** 2; }
    const norm = Math.max(Math.sqrt(square), 1e-12);
    if (square === 0) throw new Error("Corrupt zero learned reference descriptor.");
    for (let d = 0; d < DIMENSIONS; d++) output[row * DIMENSIONS + d] /= norm;
  }
  return output;
}
export interface LearnedPair { query: number; reference: number; cosine: number }
/** Exact exhaustive MNN. No ratio test, approximate retrieval, or changed threshold.
 * Float32 comparison mirrors numpy's float32 > .82; equal maxima choose first.
 */
export function mutualLearnedMatches(query: Float32Array, reference: Float32Array): LearnedPair[] {
  if (query.length % DIMENSIONS || reference.length % DIMENSIONS || query.length > 500 * DIMENSIONS || reference.length > 256 * DIMENSIONS || !query.every(Number.isFinite) || !reference.every(Number.isFinite)) throw new Error("Invalid learned descriptor matrix.");
  const queries = query.length / DIMENSIONS, references = reference.length / DIMENSIONS;
  if (!queries || !references) return [];
  const queryBest = new Int32Array(queries), referenceBest = new Int32Array(references), queryCosine = new Float32Array(queries).fill(-Infinity), referenceCosine = new Float32Array(references).fill(-Infinity);
  for (let q = 0; q < queries; q++) for (let r = 0; r < references; r++) {
    let cosine = 0;
    for (let d = 0; d < DIMENSIONS; d++) cosine += query[q * DIMENSIONS + d] * reference[r * DIMENSIONS + d];
    cosine = Math.fround(cosine);
    if (cosine > queryCosine[q]) { queryCosine[q] = cosine; queryBest[q] = r; }
    if (cosine > referenceCosine[r]) { referenceCosine[r] = cosine; referenceBest[r] = q; }
  }
  const pairs: LearnedPair[] = [];
  for (let q = 0; q < queries; q++) if (referenceBest[queryBest[q]] === q && queryCosine[q] > Math.fround(.82)) pairs.push({ query: q, reference: queryBest[q], cosine: queryCosine[q] });
  return pairs;
}

/** First maxima and mutuality are computed within ONE reference block, never
 * across the combined batch. This reducer preserves float32 >.82 exactly. */
export function mutualLearnedSimilarity(scores: Float32Array, queries: number, columns: number, offset: number, references = 256): LearnedPair[] {
  if (!Number.isInteger(queries) || queries < 0 || queries > 500 || !Number.isInteger(columns) || columns < 0 || columns > 2048 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(references) || references < 0 || references > 256 || offset + references > columns || scores.length !== queries * columns) throw new Error("Invalid learned similarity matrix.");
  if (!queries || !references) return [];
  const queryBest = new Int32Array(queries), referenceBest = new Int32Array(references), queryCosine = new Float32Array(queries).fill(-Infinity), referenceCosine = new Float32Array(references).fill(-Infinity);
  for (let q = 0; q < queries; q++) for (let r = 0; r < references; r++) {
    const score = scores[q * columns + offset + r];
    if (!Number.isFinite(score)) throw new Error("Nonfinite learned similarity matrix.");
    if (score > queryCosine[q]) { queryCosine[q] = score; queryBest[q] = r; }
    if (score > referenceCosine[r]) { referenceCosine[r] = score; referenceBest[r] = q; }
  }
  const pairs: LearnedPair[] = [];
  for (let q = 0; q < queries; q++) if (referenceBest[queryBest[q]] === q && queryCosine[q] > Math.fround(.82)) pairs.push({ query: q, reference: queryBest[q], cosine: queryCosine[q] });
  return pairs;
}

/** Connected components, not greedy union suppression. Retain all corner hypotheses. */
export function groupLearnedQuads(quads: Quad[], iou: (a: Quad, b: Quad) => number): number[][] {
  const parent = quads.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < quads.length; i++) for (let j = 0; j < i; j++) if (iou(quads[i], quads[j]) >= .70) parent[root(i)] = root(j);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < quads.length; i++) { const key = root(i); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(i); }
  return [...groups.values()];
}
/** Frozen group policy: exactly one supported identity, conflicts always review-only. */
export function decideLearnedGroup(hypotheses: CardDetection[], diagnostics = false): CardDetection {
  if (!hypotheses.length) throw new Error("Empty learned geometry group.");
  const accepted = hypotheses.filter(d => d.autoEligible && d.candidates[0]);
  const identities = new Set(accepted.map(d => identity(d.candidates[0])));
  const pool = accepted.length ? accepted : hypotheses;
  const best = [...pool].sort((a, b) => (b.candidates[0] ? evidenceRank(b.candidates[0]) : -1) - (a.candidates[0] ? evidenceRank(a.candidates[0]) : -1))[0];
  const result: CardDetection = { ...best, quality: { ...best.quality, issues: [...best.quality.issues] }, candidates: [...best.candidates] };
  if (hypotheses.some(d => d.deferred)) Object.assign(result, { state: "unknown", autoEligible: false, deferred: true, reason: "Not every geometry hypothesis and rival has been checked; keep this card for review." });
  else if (identities.size > 1) Object.assign(result, { state: "ambiguous", autoEligible: false, reason: "Conflicting card identities across corner hypotheses. Keep this card for review." });
  else if (identities.size === 1) Object.assign(result, { state: "verified", autoEligible: true, printingAmbiguous: accepted.some(d => d.printingAmbiguous), reason: "Card identity verified by XFeat local features and unchanged RANSAC/spatial/artwork gates. Printing, finish, and condition remain unconfirmed." });
  if (diagnostics) result.hypotheses = hypotheses;
  return result;
}

/** A geometry-only preview heuristic; never stores identities or crop descriptors.
 * Any antialiased RGB change >12/255 invalidates immediately. Expiry also invalidates.
 * Full frozen10-window passes are throttled to >=1500ms from completion, including
 * while moving. Until a new pass may run, all contours remain deferred. Photo
 * ignores this cache and always executes every frozen window.
 */
export class LearnedGeometryCadence {
  private sample: Uint8Array | undefined;
  private width = 0;
  private height = 0;
  private expires = -Infinity;
  private nextRefresh = -Infinity;
  private quads: Quad[] | undefined;
  inspect(image: ImageData, now: number): { quads?: Quad[]; refresh: boolean } {
    const sample = this.fingerprint(image);
    const changed = !this.sample || this.width !== image.width || this.height !== image.height || sample.some((v, i) => Math.abs(v - this.sample![i]) > 12);
    if (changed || now >= this.expires) this.quads = undefined;
    return { quads: this.quads, refresh: !this.quads && now >= this.nextRefresh };
  }
  record(image: ImageData, quads: Quad[], now: number): void {
    this.sample = this.fingerprint(image); this.width = image.width; this.height = image.height;
    this.quads = quads; this.expires = now + LEARNED_PREVIEW_REFRESH_MS; this.nextRefresh = this.expires;
  }
  clear(): void { this.sample = undefined; this.quads = undefined; this.expires = -Infinity; this.nextRefresh = -Infinity; }
  private fingerprint(image: ImageData): Uint8Array {
    // Integrate each whole source-pixel footprint before decimation. A single
    // native pixel aliases fine card detail under even tiny camera translations.
    // Fixed 32x32 RGB area means + a standard 3x3 binomial filter only schedule
    // geometry refreshes; every retained quad still gets fresh identity evidence.
    // Scratch is 12 KiB Float32 + 3 KiB Uint8 (18 KiB including the retained sample).
    const area = new Float32Array(32 * 32 * 3), sample = new Uint8Array(area.length);
    const scaleX = image.width / 32, scaleY = image.height / 32, footprint = scaleX * scaleY;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const left = x * scaleX, right = (x + 1) * scaleX, top = y * scaleY, bottom = (y + 1) * scaleY;
      let red = 0, green = 0, blue = 0;
      for (let row = Math.floor(top); row < Math.ceil(bottom); row++) {
        const vertical = Math.min(bottom, row + 1) - Math.max(top, row);
        for (let column = Math.floor(left); column < Math.ceil(right); column++) {
          const weight = vertical * (Math.min(right, column + 1) - Math.max(left, column)), pixel = (row * image.width + column) * 4;
          red += image.data[pixel] * weight; green += image.data[pixel + 1] * weight; blue += image.data[pixel + 2] * weight;
        }
      }
      const offset = (y * 32 + x) * 3;
      area[offset] = red / footprint; area[offset + 1] = green / footprint; area[offset + 2] = blue / footprint;
    }
    // [1,2,1] x [1,2,1] /16 with replicated edges and a single final rounding.
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const row = Math.min(31, Math.max(0, y + dy)), column = Math.min(31, Math.max(0, x + dx));
        sum += area[(row * 32 + column) * 3 + c] * (dy === 0 ? 2 : 1) * (dx === 0 ? 2 : 1);
      }
      sample[(y * 32 + x) * 3 + c] = Math.round(sum / 16);
    }
    return sample;
  }
}

export function verifyLearnedCandidate(cv: Cv, query: LearnedQueryFeatures, reference: LearnedIndexCard, features: LearnedReferenceFeatures, descriptors: Float32Array, hashDistance: number, timings?: VisionTimings, providedPairs?: LearnedPair[]): MatchEvidence {
    const matchingStart = performance.now(), pairs = providedPairs ?? mutualLearnedMatches(query.descriptors, descriptors), geometryStart = performance.now();
    if (timings) timings.descriptorMatchingMs = (timings.descriptorMatchingMs ?? 0) + geometryStart - matchingStart;
    const evidence: MatchEvidence = { key: reference.key, reference, hashDistance, tentativeMatches: pairs.length, inliers: 0, inlierRatio: 0, interiorInliers: 0, coverage: 0, medianReprojectionError: Infinity, cornerError: Infinity, geometricallyVerified: false };
    if (pairs.length < 8) return evidence;
    const rp = pairs.map(p => ({ x: features.points[p.reference * 2], y: features.points[p.reference * 2 + 1] })), qp = pairs.map(p => ({ x: query.points[p.query * 2], y: query.points[p.query * 2 + 1] }));
    let from: InstanceType<Cv["Mat"]> | undefined, to: InstanceType<Cv["Mat"]> | undefined, mask: InstanceType<Cv["Mat"]> | undefined, h: InstanceType<Cv["Mat"]> | undefined;
    try {
      from = cv.matFromArray(rp.length, 1, cv.CV_32FC2, rp.flatMap(p => [p.x, p.y])); to = cv.matFromArray(qp.length, 1, cv.CV_32FC2, qp.flatMap(p => [p.x, p.y])); mask = new cv.Mat(); h = cv.findHomography(from, to, cv.RANSAC, 3, mask, 500, .995);
      if (h.empty()) return evidence;
      const homography = h.data64F, inliers: Point[] = [], errors: number[] = [];
      for (let i = 0; i < pairs.length; i++) if (mask.data[i]) {
        const p = rp[i]; inliers.push(p); errors.push(distance(projectPoint(homography, p), qp[i]));
        const top = reference.game === "yugioh" ? .22 : .2, bottom = reference.game === "yugioh" ? .62 : reference.game === "pokemon" ? .54 : .57;
        if (p.x > WIDTH * .15 && p.x < WIDTH * .85 && p.y > HEIGHT * top && p.y < HEIGHT * bottom) evidence.interiorInliers++;
      }
      evidence.inliers = inliers.length; evidence.inlierRatio = inliers.length / pairs.length; evidence.coverage = hullArea(inliers) / (WIDTH * HEIGHT); evidence.medianReprojectionError = median(errors);
      const projected = canonicalCorners.map(p => projectPoint(homography, p)) as Quad;
      if (!projected.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) || !isConvexQuad(projected)) return evidence;
      evidence.cornerError = Math.min(...[0, 2].map(offset => projected.reduce((sum, p, i) => sum + distance(p, canonicalCorners[(i + offset) % 4]), 0) / 4 / Math.hypot(WIDTH, HEIGHT)));
      evidence.geometricallyVerified = hasGeometricEvidence(evidence); return evidence;
    } finally { from?.delete(); to?.delete(); mask?.delete(); h?.delete(); if (timings) timings.geometryMs = (timings.geometryMs ?? 0) + performance.now() - geometryStart; }
  }

export class LearnedVisionEngine {
  private readonly preprocessing: VisionEngine;
  private readonly index = new HashIndex();
  private readonly references = new Map<string, LearnedIndexCard>();
  private readonly artGroups = new Map<string, { count: number; identities: Set<string> }>();
  private readonly decoded = new Map<string, { source: LearnedReferenceFeatures; descriptors: Float32Array }>();
  private readonly cadence = new LearnedGeometryCadence();
  private groupCursor = 0;
  private burstFrames = 0;
  private focusAttempts = 0;
  private focusQuad: Quad | undefined;
  private previousGroups: Quad[][] | undefined;
  private previewContext: string | undefined;
  private busy = false;
  private disposed = false;
  private invalidation = 0;
  constructor(private readonly cv: Cv, private readonly models: LearnedModels, cards: LearnedIndexCard[], private readonly loadReference: (featureId: string) => Promise<LearnedReferenceFeatures>, private readonly similarity?: LearnedSimilarity) {
    if (cards.length > MAX_HASH_REFERENCES) throw new Error("Learned index exceeds 60,000 references.");
    for (const card of cards) {
      if (!card.key || this.references.has(card.key) || !card.featureId || !["pokemon", "mtg", "yugioh"].includes(card.game) || !/^[0-9a-f]{16}$/.test(card.hash) || !/^[0-9a-f]{16}$/.test(card.differenceHash)) throw new Error("Invalid or duplicate learned index metadata.");
      this.references.set(card.key, card); this.index.set(card);
      if (card.artworkKey) { const key = `${card.game}:${card.artworkKey}`; const group = this.artGroups.get(key) ?? { count: 0, identities: new Set<string>() }; group.count++; group.identities.add(card.identityKey || `unknown:${card.key}`); this.artGroups.set(key, group); }
    }
    this.preprocessing = new VisionEngine(cv);
  }
  coverage(): VisionCoverage {
    const byGame = { pokemon: 0, mtg: 0, yugioh: 0 };
    for (const reference of this.references.values()) byGame[reference.game]++;
    return { totalReferences: this.references.size, byGame, packs: this.references.size ? ["Local XFeat256/int8 index"] : [] };
  }
  /** Exposed bounded-cache statistic for diagnostics/tests, never descriptor data. */
  get decodedReferenceCount(): number { return this.decoded.size; }
  private assertCurrent(version: number): void { if (this.disposed || version !== this.invalidation) throw new Error("Learned recognition canceled."); }
  private async descriptorFor(metadata: LearnedIndexCard, version: number): Promise<{ features: LearnedReferenceFeatures; descriptors: Float32Array }> {
    // Even decoded hits consult storage: a removed/corrupt/reimported pack must
    // invalidate recognition. Storage performs its own bounded raw-cache check.
    const features = await this.loadReference(metadata.featureId); this.assertCurrent(version);
    if (features.key !== metadata.key) throw new Error("Learned reference identity does not match its local index.");
    let entry = this.decoded.get(metadata.featureId);
    if (!entry || entry.source !== features) entry = { source: features, descriptors: dequantizeLearnedReference(features) };
    this.decoded.delete(metadata.featureId); this.decoded.set(metadata.featureId, entry);
    while (this.decoded.size > CACHE_LIMIT) this.decoded.delete(this.decoded.keys().next().value!);
    return { features, descriptors: entry.descriptors };
  }
  async analyze(image: ImageData, options: VisionOptions = {}): Promise<VisionResult> {
    if (this.busy) throw new Error("Learned engine is busy; drop the frame instead of queuing it.");
    this.assertCurrent(this.invalidation);
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 2 || image.height < 2 || image.width > 4096 || image.height > 4096 || image.width * image.height > 16_000_000 || image.data.length !== image.width * image.height * 4) throw new Error("Frame must be RGBA and at most 4096 pixels per side / 16 million pixels.");
    if (options.region) throw new Error("Learned recognition requires the automatic whole-photo protocol; manual regions are not supported.");
    if (options.printingRegions && (options.printingRegions.length > 2 || options.printingRegions.some(q => q.length !== 4 || !isConvexQuad(q) || q.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height)))) throw new Error("Printing crop targets must be at most two convex quadrilaterals inside the frame.");
    const version = this.invalidation, start = performance.now(), photo = options.mode === "photo";
    if (options.previewBurstObservations !== undefined && options.previewBurstObservations !== 1 && options.previewBurstObservations !== 3) throw new Error("Preview identity scheduling must use one or three fresh observations.");
    const burstObservations = options.previewBurstObservations ?? 3;
    const context = `${options.mode ?? "stream"}:${options.game ?? "all"}:${image.width}x${image.height}:${burstObservations}`;
    if (context !== this.previewContext) { this.resetPreview(); this.previewContext = context; }
    const budget = Number.isFinite(options.budgetMs) ? options.budgetMs! : photo ? 120_000 : 600;
    const deadline = start + Math.min(photo ? 120_000 : 4000, Math.max(80, budget));
    const source = this.cv.matFromImageData(image);
    this.busy = true;
    const result: VisionResult = { width: image.width, height: image.height, detections: [], timings: { detectionMs: 0, extractionMs: 0, matchingMs: 0, totalMs: 0 }, coverage: this.coverage(), budgetExhausted: false, detectionComplete: true, scheduling: { processedGroups: 0, deferredGroups: 0, proposalRefresh: false, proposalCacheReused: false, softBudgetMs: deadline - start, overrunMs: 0 } };
    try {
      // maxCards never truncates automatic learned proposals. Frozen contour cap9
      // and every retained Fastweb hypothesis are grouped before any scheduling.
      const contours = this.preprocessing.detect(source, 9);
      let fastweb: Quad[] | undefined;
      if (photo) { result.scheduling!.proposalRefresh = true; fastweb = await this.models.propose(image); this.assertCurrent(version); }
      else {
        const cached = this.cadence.inspect(image, performance.now());
        if (!cached.quads) { this.burstFrames = 0; this.previousGroups = undefined; }
        fastweb = cached.quads; result.scheduling!.proposalCacheReused = !!fastweb;
        if (cached.refresh) { result.scheduling!.proposalRefresh = true; fastweb = await this.models.propose(image); this.assertCurrent(version); this.cadence.record(image, fastweb, performance.now()); }
      }
      result.timings.detectionMs = performance.now() - start;
      if (!fastweb) {
        result.detectionComplete = false;
        result.detections = contours.map(q => deferred(q, "Motion invalidated corner proposals; waiting for the next complete local detector pass.")); result.scheduling!.deferredGroups = contours.length; result.budgetExhausted = true; return result;
      }
      if (fastweb.length > 10 || fastweb.some(q => q.length !== 4 || !isConvexQuad(q) || q.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height))) throw new Error("Invalid learned corner proposals.");
      const quads = [...contours, ...fastweb], groups = groupLearnedQuads(quads, (a, b) => learnedPolygonIoU(this.cv, a, b));
      result.timings.detectionMs = performance.now() - start;
      if (!photo) {
        const current = groups.map(g => g.map(i => quads[i]));
        // Geometry only, never previous identity/descriptor evidence. A changed
        // component membership/order or loss of the same physical region resets
        // the burst. Subpixel corner noise inside the same IoU group is allowed.
        const same = this.previousGroups && current.length === this.previousGroups.length && current.every((g, i) => g.length === this.previousGroups![i].length && g.every((q, j) => learnedPolygonIoU(this.cv, q, this.previousGroups![i][j]) >= .70));
        if (!same) this.burstFrames = 0;
        this.previousGroups = current;
      }
      const offset = photo ? 0 : this.groupCursor % Math.max(1, groups.length);
      if (!photo && groups.length) {
        const focused = groups[offset].map(i => quads[i]);
        if (this.focusQuad && !focused.some(q => learnedPolygonIoU(this.cv, q, this.focusQuad!) >= .70)) this.focusAttempts = 0;
        this.focusQuad = focused[0];
      }
      const ordered = [...groups.slice(offset), ...groups.slice(0, offset)];
      for (let groupIndex = 0; groupIndex < ordered.length; groupIndex++) {
        const group = ordered[groupIndex], hypotheses: CardDetection[] = [];
        // Preview gives one group the requested number of CURRENT-frame turns
        // before rotating. Every turn repeats all hypotheses and all eight rivals.
        // This changes scheduling only: no identity/query evidence is retained.
        // A separate three-completed-attempt work cap survives evidence resets,
        // so slow groups cannot starve others. It carries no identity evidence.
        // One indivisible group may exceed the soft budget; others stay deferred.
        if ((!photo && groupIndex > 0) || (photo && performance.now() > deadline)) { result.detections.push(decideLearnedGroup(group.map(i => deferred(quads[i])), options.includeDiagnostics)); result.budgetExhausted = true; continue; }
        for (const index of group) {
          this.assertCurrent(version);
          const quad = quads[index], extractionStart = performance.now(), prepared = this.preprocessing.prepareLearnedCrop(source, quad);
          const query = await this.models.extract(prepared.image); this.assertCurrent(version); validateQuery(query);
          const quality: QualityEvidence = { ...prepared.quality, issues: [...prepared.quality.issues], featureCount: query.points.length / 2 };
          if (quality.featureCount < 35) quality.issues.push("Too few usable learned local features.");
          const detection: CardDetection = { quad, state: "unknown", autoEligible: false, quality, candidates: [], reason: "No reference passed local verification." };
          if (options.includeCrops) detection.crop = prepared.image;
          result.timings.extractionMs += performance.now() - extractionStart;
          const matchingStart = performance.now(), retrievalStart = performance.now();
          // The frozen driver supplied no shortlist when original quality failed.
          const shortlist = prepared.quality.issues.length ? [] : this.index.query(prepared.hashes, options.game ? [options.game] : ["pokemon", "mtg", "yugioh"], 8);
          if (options.includeDiagnostics && !prepared.quality.issues.length) detection.retrieval = { shortlistKeys: shortlist.map(c => c.key), retrievalMs: performance.now() - retrievalStart };
          const batch: { metadata: LearnedIndexCard; features: LearnedReferenceFeatures; descriptors: Float32Array; distance: number }[] = [];
          for (const candidate of shortlist) {
            // A partial reference batch never establishes rival separation.
            if (photo && performance.now() > deadline) { detection.deferred = true; result.budgetExhausted = true; break; }
            const readStart = performance.now(), metadata = this.references.get(candidate.key)!, decoded = await this.descriptorFor(metadata, version);
            result.timings.referenceReadMs = (result.timings.referenceReadMs ?? 0) + performance.now() - readStart;
            batch.push({ metadata, ...decoded, distance: candidate.distance });
          }
          let similarities: Float32Array | undefined;
          const columns = batch.length * 256;
          if (this.similarity && batch.length && query.points.length) {
            const matrixStart = performance.now(), transposed = new Float32Array(DIMENSIONS * columns);
            for (let b = 0; b < batch.length; b++) for (let r = 0; r < 256; r++) for (let d = 0; d < DIMENSIONS; d++) transposed[d * columns + b * 256 + r] = batch[b].descriptors[r * DIMENSIONS + d];
            similarities = await this.similarity.multiply(query.descriptors, transposed, columns); this.assertCurrent(version);
            result.timings.descriptorMatchingMs = (result.timings.descriptorMatchingMs ?? 0) + performance.now() - matrixStart;
          }
          for (let b = 0; b < batch.length; b++) {
            if (photo && performance.now() > deadline) { detection.deferred = true; result.budgetExhausted = true; break; }
            const candidate = batch[b], reduceStart = performance.now();
            const pairs = similarities ? mutualLearnedSimilarity(similarities, query.points.length / 2, columns, b * 256) : undefined;
            if (similarities) result.timings.descriptorMatchingMs = (result.timings.descriptorMatchingMs ?? 0) + performance.now() - reduceStart;
            detection.candidates.push(verifyLearnedCandidate(this.cv, query, candidate.metadata, candidate.features, candidate.descriptors, candidate.distance, result.timings, pairs));
          }
          detection.candidates.sort((a, b) => evidenceRank(b) - evidenceRank(a));
          const best = detection.candidates[0], art = best?.reference.artworkKey ? this.artGroups.get(`${best.reference.game}:${best.reference.artworkKey}`) : undefined;
          const shared = art ? { count: art.count, identityKey: art.identities.size === 1 ? [...art.identities][0] : undefined } : false;
          Object.assign(detection, decideMatch(detection.candidates, quality, shared));
          if (detection.autoEligible) detection.reason = "Card identity verified by XFeat local features and unchanged RANSAC/spatial/artwork gates. Printing, finish, and condition remain unconfirmed.";
          if (detection.deferred) Object.assign(detection, { state: "unknown", autoEligible: false, reason: "Not all eight shortlisted rivals were checked; verification is incomplete." });
          result.timings.matchingMs += performance.now() - matchingStart; hypotheses.push(detection);
          if (photo && performance.now() > deadline) { for (const remaining of group.slice(hypotheses.length)) hypotheses.push(deferred(quads[remaining])); result.budgetExhausted = true; break; }
        }
        result.detections.push(decideLearnedGroup(hypotheses, options.includeDiagnostics));
      }
      if (options.includePrintingCrops) {
        const limit = Math.min(2, Math.max(1, Number.isFinite(options.maxPrintingCrops) ? Math.floor(options.maxPrintingCrops!) : 1));
        const eligible = result.detections.filter(d => d.autoEligible && !d.deferred && Math.min(...d.quad.map((p, i) => distance(p, d.quad[(i + 1) % 4]))) >= 480);
        const selected: CardDetection[] = [];
        const center = (q: Quad): Point => q.reduce((p, n) => ({ x: p.x + n.x / 4, y: p.y + n.y / 4 }), { x: 0, y: 0 });
        for (const target of options.printingRegions ?? []) {
          const nearest = [...eligible].filter(d => !selected.includes(d)).sort((a, b) => distance(center(a.quad), center(target)) - distance(center(b.quad), center(target)))[0];
          if (nearest) selected.push(nearest);
          if (selected.length >= limit) break;
        }
        if (!options.printingRegions?.length) selected.push(...eligible.slice(0, limit));
        for (const detection of selected) {
          const crop = this.preprocessing.preparePrintingCrop(source, detection.quad);
          if (crop) { detection.printingCrop = crop.image; detection.printingSourceMinEdge = crop.sourceMinEdge; }
        }
      }
      result.scheduling!.processedGroups = result.detections.filter(d => !d.deferred).length; result.scheduling!.deferredGroups = result.detections.filter(d => d.deferred).length;
      if (!photo && result.scheduling!.processedGroups > 0) {
        this.burstFrames++; this.focusAttempts++;
        result.scheduling!.burstFrame = this.burstFrames;
        result.scheduling!.focusAttempt = this.focusAttempts;
        result.scheduling!.focusedGroup = offset;
        if (this.focusAttempts >= burstObservations) { this.groupCursor = (offset + 1) % Math.max(1, groups.length); this.burstFrames = 0; this.focusAttempts = 0; this.focusQuad = undefined; }
        else this.groupCursor = offset;
      }
      this.assertCurrent(version); return result;
    } catch (error) {
      // Corruption/runtime errors never return partial eligible results.
      this.decoded.clear(); this.resetPreview(); throw error;
    } finally { source.delete(); this.busy = false; result.timings.totalMs = performance.now() - start; result.scheduling!.overrunMs = Math.max(0, result.timings.totalMs - result.scheduling!.softBudgetMs); }
  }
  private resetPreview(): void { this.cadence.clear(); this.groupCursor = 0; this.burstFrames = 0; this.focusAttempts = 0; this.focusQuad = undefined; this.previousGroups = undefined; this.previewContext = undefined; }
  cancel(): void { this.invalidation++; this.resetPreview(); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.cancel(); this.decoded.clear(); this.preprocessing.dispose(); try { await this.similarity?.dispose(); } finally { await this.models.dispose(); } }
}
