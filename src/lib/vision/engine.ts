import type * as OpenCv from "@techstark/opencv-js";
import { bounds, boxIntersectionOverUnion, distance, hullArea, isConvexQuad, median, orderQuad, polygonArea, projectPoint } from "./geometry";
import { differenceHash, HashIndex, MAX_HASH_REFERENCES, perceptualHash } from "./hash";
import { decideMatch, evidenceRank, hasGeometricEvidence } from "./scoring";
import type { CardDetection, FeaturePack, MatchEvidence, Point, Quad, QualityEvidence, ReferenceAdded, ReferenceFeatures, ReferenceMetadata, VisionCoverage, VisionOptions, VisionResult } from "./types";

export type Cv = typeof OpenCv;
type Mat = OpenCv.Mat;
const WIDTH = 240, HEIGHT = 336;
const ALL_GAMES = ["pokemon", "mtg", "yugioh"] as const;
const MAX_REFERENCES = MAX_HASH_REFERENCES;
const MAX_DESCRIPTOR_BYTES = 256 * 1024 * 1024;
const now = () => performance.now();
const canonicalCorners: Quad = [{ x: 0, y: 0 }, { x: WIDTH - 1, y: 0 }, { x: WIDTH - 1, y: HEIGHT - 1 }, { x: 0, y: HEIGHT - 1 }];
const emptyQuality = (): QualityEvidence => ({ laplacianVariance: 0, contrast: 0, meanLuminance: 0, saturatedFraction: 0, sourceMinEdge: 0, featureCount: 0, issues: [] });
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function pixels(mat: Mat): ImageData {
  const data = new Uint8ClampedArray(mat.data);
  return typeof ImageData !== "undefined" ? new ImageData(data, mat.cols, mat.rows) : { data, width: mat.cols, height: mat.rows, colorSpace: "srgb" } as ImageData;
}
interface StoredReference { metadata: ReferenceMetadata; features: ReferenceFeatures }
interface Extracted { descriptor: Mat; points: Point[]; hashes: { hash: string; differenceHash: string }[]; quality: QualityEvidence }

/** Pure synchronous engine. Run in vision.worker.ts; exported for offline pack building/tests. */
export class VisionEngine {
  private readonly orb: OpenCv.ORB;
  private readonly matcher: OpenCv.BFMatcher;
  private readonly index = new HashIndex();
  private readonly references = new Map<string, StoredReference>();
  private readonly artGroups = new Map<string, Set<string>>();
  private readonly packs = new Set<string>();
  private readonly artIdentities = new Map<string, Map<string, number>>();
  private readonly decoded = new Map<string, Mat>();
  private descriptorBytes = 0;
  private counts = { pokemon: 0, mtg: 0, yugioh: 0 };
  private disposed = false;
  private frameNumber = 0;
  constructor(private readonly cv: Cv) {
    this.orb = new cv.ORB(500, 1.2, 8, 15, 0, 2, cv.ORB_HARRIS_SCORE, 31, 12);
    this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  }
  coverage(): VisionCoverage {
    return { totalReferences: this.references.size, byGame: { ...this.counts }, packs: [...this.packs] };
  }
  private assertOpen(): void { if (this.disposed) throw new Error("Vision engine is disposed."); }
  private store(reference: StoredReference): void {
    const { metadata, features } = reference;
    const previous = this.references.get(metadata.key);
    if (previous) {
      this.descriptorBytes -= previous.features.points.length / 2 * 32;
      this.counts[previous.metadata.game]--;
      if (previous.metadata.artworkKey) {
        const group = `${previous.metadata.game}:${previous.metadata.artworkKey}`;
        this.artGroups.get(group)?.delete(metadata.key);
        const identities = this.artIdentities.get(group), identity = previous.metadata.identityKey || `unknown:${previous.metadata.key}`;
        if (identities) { const count = (identities.get(identity) || 1) - 1; if (count) identities.set(identity, count); else identities.delete(identity); }
      }
    }
    this.decoded.get(metadata.key)?.delete(); this.decoded.delete(metadata.key);
    this.references.set(metadata.key, reference);
    this.counts[metadata.game]++;
    this.descriptorBytes += features.points.length / 2 * 32;
    this.index.set({ key: metadata.key, game: metadata.game, hash: features.hash, differenceHash: features.differenceHash });
    if (metadata.artworkKey) {
      const group = `${metadata.game}:${metadata.artworkKey}`;
      if (!this.artGroups.has(group)) this.artGroups.set(group, new Set());
      this.artGroups.get(group)!.add(metadata.key);
      if (!this.artIdentities.has(group)) this.artIdentities.set(group, new Map());
      const identities = this.artIdentities.get(group)!, identity = metadata.identityKey || `unknown:${metadata.key}`;
      identities.set(identity, (identities.get(identity) || 0) + 1);
    }
  }
  loadPack(pack: FeaturePack): VisionCoverage {
    this.assertOpen();
    if (pack?.version !== 1 || pack.algorithm !== "orb-phash-v1" || pack.width !== WIDTH || pack.height !== HEIGHT || !Array.isArray(pack.cards) || !Array.isArray(pack.features)) throw new Error("Unsupported feature pack. Expected orb-phash-v1 at 240×336.");
    if (pack.cards.length > MAX_REFERENCES || pack.features.length > MAX_REFERENCES || typeof pack.name !== "string" || pack.name.length > 200) throw new Error("Feature pack exceeds the bounded local index limits.");
    const cards = new Map<string, ReferenceMetadata>();
    for (const card of pack.cards) {
      if (!card || typeof card.key !== "string" || !card.key || card.key.length > 300 || typeof card.name !== "string" || card.name.length > 500 || !ALL_GAMES.includes(card.game) || cards.has(card.key)) throw new Error("Feature pack contains invalid or duplicate card metadata.");
      for (const field of [card.identityKey, card.artworkKey, card.setName, card.number, card.imageUrl, card.sourceUrl]) if (field !== undefined && (typeof field !== "string" || field.length > 2000)) throw new Error("Invalid reference metadata.");
      cards.set(card.key, card);
    }
    let extraBytes = 0, extraCount = 0;
    const seen = new Set<string>();
    const entries: StoredReference[] = [];
    for (const features of pack.features) {
      const metadata = cards.get(features?.key);
      if (!metadata || seen.has(features.key) || !/^[0-9a-f]{16}$/.test(features.hash) || !/^[0-9a-f]{16}$/.test(features.differenceHash) || !Array.isArray(features.points) || features.points.length < 40 || features.points.length > 1000 || features.points.length % 2 || !features.points.every((v, i) => Number.isFinite(v) && v >= 0 && v < (i % 2 ? HEIGHT : WIDTH)) || typeof features.descriptors !== "string" || features.descriptors.length > 22000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(features.descriptors)) throw new Error("Feature pack contains invalid hashes, points, or descriptors.");
      const bytes = base64ToBytes(features.descriptors);
      if (bytes.length !== features.points.length / 2 * 32) throw new Error("ORB descriptor count does not match keypoints.");
      seen.add(features.key);
      const old = this.references.get(features.key);
      extraCount += old ? 0 : 1;
      extraBytes += bytes.length - (old ? old.features.points.length / 2 * 32 : 0);
      entries.push({ metadata: { ...metadata }, features: { ...features, points: [...features.points] } });
    }
    if (this.references.size + extraCount > MAX_REFERENCES || this.descriptorBytes + extraBytes > MAX_DESCRIPTOR_BYTES) throw new Error("Local index capacity reached (60,000 references / 256 MiB descriptors). Load a smaller game or set pack.");
    // Validation is atomic; a malformed pack never partially mutates the index.
    for (const entry of entries) this.store(entry);
    this.packs.add(pack.name);
    return this.coverage();
  }
  addReference(metadata: ReferenceMetadata, image: ImageData): ReferenceAdded {
    this.assertOpen();
    const cv = this.cv, source = cv.matFromImageData(image), resized = new cv.Mat(), gray = new cv.Mat();
    let extracted: Extracted | undefined;
    try {
      cv.resize(source, resized, new cv.Size(WIDTH, HEIGHT), 0, 0, cv.INTER_AREA);
      cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);
      extracted = this.extract(gray, Math.min(image.width, image.height));
      if (extracted.points.length < 20) throw new Error("Reference image has too few usable local features.");
      const features: ReferenceFeatures = { key: metadata.key, ...extracted.hashes[0], points: extracted.points.flatMap(p => [p.x, p.y]), descriptors: bytesToBase64(extracted.descriptor.data) };
      this.loadPack({ version: 1, algorithm: "orb-phash-v1", width: WIDTH, height: HEIGHT, name: "Session references", cards: [metadata], features: [features] });
      return { key: metadata.key, featureCount: extracted.points.length, coverage: this.coverage(), features };
    } finally { extracted?.descriptor.delete(); source.delete(); resized.delete(); gray.delete(); }
  }
  private hash(gray: Mat): { hash: string; differenceHash: string } {
    const cv = this.cv, tiny = new cv.Mat(), difference = new cv.Mat();
    try {
      cv.resize(gray, tiny, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);
      cv.resize(gray, difference, new cv.Size(9, 8), 0, 0, cv.INTER_AREA);
      return { hash: perceptualHash(tiny.data), differenceHash: differenceHash(difference.data) };
    } finally { tiny.delete(); difference.delete(); }
  }
  private extract(gray: Mat, sourceMinEdge: number): Extracted {
    const cv = this.cv, keypoints = new cv.KeyPointVector(), descriptor = new cv.Mat(), mask = new cv.Mat(), reversed = new cv.Mat(), lap = new cv.Mat();
    try {
      cv.Laplacian(gray, lap, cv.CV_64F);
      let sum = 0, squares = 0, lapSum = 0, lapSquares = 0, saturated = 0;
      // Exclude the rectification boundary from quality statistics.
      let count = 0;
      const grayData = gray.data, lapData = lap.data64F;
      for (let y = 8; y < HEIGHT - 8; y++) for (let x = 8; x < WIDTH - 8; x++) {
        const i = y * WIDTH + x, v = grayData[i], l = lapData[i];
        sum += v; squares += v * v; lapSum += l; lapSquares += l * l; saturated += v >= 250 ? 1 : 0; count++;
      }
      const mean = sum / count, contrast = Math.sqrt(Math.max(0, squares / count - mean * mean));
      const variance = Math.max(0, lapSquares / count - (lapSum / count) ** 2);
      cv.flip(gray, reversed, -1);
      const hashes = [this.hash(gray), this.hash(reversed)];
      this.orb.detectAndCompute(gray, mask, keypoints, descriptor);
      const points: Point[] = [];
      for (let i = 0; i < keypoints.size(); i++) { const p = keypoints.get(i).pt as Point; points.push({ x: p.x, y: p.y }); }
      const issues: string[] = [];
      if (sourceMinEdge < 90) issues.push("Move closer; the card is too small.");
      if (variance < 45) issues.push("Hold still and refocus; the crop is blurred.");
      if (contrast < 18 || mean < 25 || (mean > 238 && contrast < 25)) issues.push("Improve lighting; the crop has too little visible detail.");
      if (saturated / count > 0.62 && mean > 205) issues.push("Reduce glare; most of the card is washed out.");
      if (points.length < 35) issues.push("Too few usable local features.");
      return { descriptor, points, hashes, quality: { laplacianVariance: variance, contrast, meanLuminance: mean, saturatedFraction: saturated / count, sourceMinEdge, featureCount: points.length, issues } };
    } catch (error) { descriptor.delete(); throw error; }
    finally { keypoints.delete(); mask.delete(); reversed.delete(); lap.delete(); }
  }
  private detect(source: Mat, maxCards: number): Quad[] {
    const cv = this.cv, small = new cv.Mat(), gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    try {
      const scale = Math.min(1, 960 / Math.max(source.cols, source.rows));
      cv.resize(source, small, new cv.Size(Math.round(source.cols * scale), Math.round(source.rows * scale)), 0, 0, cv.INTER_AREA);
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 35, 110);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const candidates: Quad[] = [], frameArea = small.cols * small.rows;
      for (let i = 0; i < Math.min(contours.size(), 3000); i++) {
        const contour = contours.get(i), approximation = new cv.Mat();
        try {
          const area = cv.contourArea(contour);
          if (area < frameArea * 0.004 || area > frameArea * 0.96) continue;
          cv.approxPolyDP(contour, approximation, cv.arcLength(contour, true) * 0.025, true);
          if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;
          const data = approximation.data32S;
          const quad = orderQuad(Array.from({ length: 4 }, (_, j) => ({ x: data[j * 2], y: data[j * 2 + 1] })));
          const sides = quad.map((p, j) => distance(p, quad[(j + 1) % 4]));
          const ratio = (sides[0] + sides[2]) / (sides[1] + sides[3]);
          if (ratio < 0.48 || ratio > 0.88 || Math.min(...sides) < 48 || Math.max(sides[0] / sides[2], sides[2] / sides[0], sides[1] / sides[3], sides[3] / sides[1]) > 2) continue;
          // A clipped border does not provide a safe perspective crop.
          if (quad.some(p => p.x < 2 || p.y < 2 || p.x >= small.cols - 2 || p.y >= small.rows - 2)) continue;
          candidates.push(quad.map(p => ({ x: p.x / scale, y: p.y / scale })) as Quad);
        } finally { contour.delete(); approximation.delete(); }
      }
      candidates.sort((a, b) => polygonArea(b) - polygonArea(a));
      const kept: Quad[] = [];
      for (const candidate of candidates) {
        const box = bounds(candidate);
        if (kept.some(other => {
          if (boxIntersectionOverUnion(candidate, other) > 0.62) return true;
          const outer = bounds(other);
          return box.x >= outer.x && box.y >= outer.y && box.x + box.width <= outer.x + outer.width && box.y + box.height <= outer.y + outer.height;
        })) continue;
        kept.push(candidate);
        if (kept.length >= maxCards) break;
      }
      return kept;
    } finally { small.delete(); gray.delete(); blur.delete(); edges.delete(); contours.delete(); hierarchy.delete(); kernel.delete(); }
  }
  private rectify(source: Mat, quad: Quad): Mat {
    const cv = this.cv, from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y])), to = cv.matFromArray(4, 1, cv.CV_32FC2, canonicalCorners.flatMap(p => [p.x, p.y]));
    const output = new cv.Mat();
    let transform: Mat | undefined;
    try {
      transform = cv.getPerspectiveTransform(from, to);
      cv.warpPerspective(source, output, transform, new cv.Size(WIDTH, HEIGHT), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      return output;
    } catch (error) { output.delete(); throw error; }
    finally { from.delete(); to.delete(); transform?.delete(); }
  }
  private descriptorFor(key: string): Mat {
    let mat = this.decoded.get(key);
    if (mat) { this.decoded.delete(key); this.decoded.set(key, mat); return mat; }
    const features = this.references.get(key)!.features;
    mat = this.cv.matFromArray(features.points.length / 2, 32, this.cv.CV_8U, base64ToBytes(features.descriptors));
    this.decoded.set(key, mat);
    if (this.decoded.size > 24) { const oldest = this.decoded.keys().next().value!; this.decoded.get(oldest)!.delete(); this.decoded.delete(oldest); }
    return mat;
  }
  private verify(query: Extracted, key: string, hashDistance: number): MatchEvidence {
    const cv = this.cv, ref = this.references.get(key)!, matches = new cv.DMatchVectorVector();
    const evidence: MatchEvidence = { key, reference: ref.metadata, hashDistance, tentativeMatches: 0, inliers: 0, inlierRatio: 0, interiorInliers: 0, coverage: 0, medianReprojectionError: Infinity, cornerError: Infinity, geometricallyVerified: false };
    let from: Mat | undefined, to: Mat | undefined, mask: Mat | undefined, h: Mat | undefined;
    try {
      this.matcher.knnMatch(query.descriptor, this.descriptorFor(key), matches, 2);
      const good: { query: number; reference: number; distance: number }[] = [];
      for (let i = 0; i < matches.size(); i++) {
        const pair = matches.get(i);
        try {
          if (pair.size() < 2) continue;
          const a = pair.get(0) as { distance: number; queryIdx: number; trainIdx: number }, b = pair.get(1) as { distance: number };
          if (a.distance < 62 && a.distance < b.distance * 0.76) good.push({ query: a.queryIdx, reference: a.trainIdx, distance: a.distance });
        } finally { pair.delete(); }
      }
      // Enforce distinct destination points; repeated card text cannot vote many times.
      const used = new Set<number>();
      const unique = good.sort((a, b) => a.distance - b.distance).filter(p => { if (used.has(p.reference)) return false; used.add(p.reference); return true; });
      evidence.tentativeMatches = unique.length;
      if (unique.length < 8) return evidence;
      const referencePoints = unique.map(p => ({ x: ref.features.points[p.reference * 2], y: ref.features.points[p.reference * 2 + 1] }));
      const queryPoints = unique.map(p => query.points[p.query]);
      from = cv.matFromArray(unique.length, 1, cv.CV_32FC2, referencePoints.flatMap(p => [p.x, p.y]));
      to = cv.matFromArray(unique.length, 1, cv.CV_32FC2, queryPoints.flatMap(p => [p.x, p.y]));
      mask = new cv.Mat();
      h = cv.findHomography(from, to, cv.RANSAC, 3, mask, 500, 0.995);
      if (h.empty()) return evidence;
      const homography = h.data64F, inliers: Point[] = [], errors: number[] = [];
      for (let i = 0; i < unique.length; i++) if (mask.data[i]) {
        const p = referencePoints[i]; inliers.push(p); errors.push(distance(projectPoint(homography, p), queryPoints[i]));
        const top = ref.metadata.game === "yugioh" ? 0.22 : 0.2;
        const bottom = ref.metadata.game === "yugioh" ? 0.62 : ref.metadata.game === "pokemon" ? 0.54 : 0.57;
        if (p.x > WIDTH * 0.15 && p.x < WIDTH * 0.85 && p.y > HEIGHT * top && p.y < HEIGHT * bottom) evidence.interiorInliers++;
      }
      evidence.inliers = inliers.length; evidence.inlierRatio = inliers.length / unique.length;
      evidence.coverage = hullArea(inliers) / (WIDTH * HEIGHT);
      evidence.medianReprojectionError = median(errors);
      const projected = canonicalCorners.map(p => projectPoint(homography, p)) as Quad;
      if (!projected.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) || !isConvexQuad(projected)) return evidence;
      // Supports upright and upside-down cards, while rejecting artwork-only crops.
      evidence.cornerError = Math.min(...[0, 2].map(offset => projected.reduce((sum, p, i) => sum + distance(p, canonicalCorners[(i + offset) % 4]), 0) / 4 / Math.hypot(WIDTH, HEIGHT)));
      evidence.geometricallyVerified = hasGeometricEvidence(evidence);
      return evidence;
    } finally { matches.delete(); from?.delete(); to?.delete(); mask?.delete(); h?.delete(); }
  }
  analyze(image: ImageData, options: VisionOptions = {}): VisionResult {
    this.assertOpen();
    if (image.width > 4096 || image.height > 4096 || image.width * image.height > 16_000_000) throw new Error("Frame is too large. Downscale to at most 4096 pixels per side.");
    const start = now(), cv = this.cv, source = cv.matFromImageData(image);
    const result: VisionResult = { width: image.width, height: image.height, detections: [], timings: { detectionMs: 0, extractionMs: 0, matchingMs: 0, totalMs: 0 }, coverage: this.coverage(), budgetExhausted: false };
    const budget = Number.isFinite(options.budgetMs) ? options.budgetMs! : 400;
    const maxCards = Number.isFinite(options.maxCards) ? Math.floor(options.maxCards!) : 9;
    const deadline = start + Math.min(1000, Math.max(80, budget));
    try {
      if (options.region && (!isConvexQuad(options.region) || options.region.some(p => p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height))) throw new Error("Manual region must be a convex quadrilateral inside the frame.");
      const quads = options.region ? [orderQuad(options.region)] : this.detect(source, Math.max(1, Math.min(9, maxCards)));
      result.timings.detectionMs = now() - start;
      // Round-robin prevents the final binder slots starving on slower devices.
      const offset = this.frameNumber++ % Math.max(1, quads.length);
      const orderedQuads = [...quads.slice(offset), ...quads.slice(0, offset)];
      for (const quad of orderedQuads) {
        const detection: CardDetection = { quad, state: "unknown", autoEligible: false, printingAmbiguous: false, deferred: false, reason: "Frame budget reached; awaiting another frame.", quality: emptyQuality(), candidates: [] };
        result.detections.push(detection);
        if (now() > deadline) { result.budgetExhausted = true; detection.deferred = true; continue; }
        const extractionStart = now(), crop = this.rectify(source, quad), gray = new cv.Mat();
        let extracted: Extracted | undefined;
        try {
          cv.cvtColor(crop, gray, cv.COLOR_RGBA2GRAY);
          extracted = this.extract(gray, Math.min(...quad.map((p, i) => distance(p, quad[(i + 1) % 4]))));
          detection.quality = extracted.quality;
          if (options.includeCrops) detection.crop = pixels(crop);
          result.timings.extractionMs += now() - extractionStart;
          if (extracted.quality.issues.length) { Object.assign(detection, decideMatch([], extracted.quality)); continue; }
          const matchingStart = now();
          const retrievalStart = now();
          const shortlist = this.index.query(extracted.hashes, options.game ? [options.game] : [...ALL_GAMES], 8);
          if (options.includeDiagnostics) detection.retrieval = { shortlistKeys: shortlist.map(candidate => candidate.key), retrievalMs: now() - retrievalStart };
          let incomplete = false;
          for (const candidate of shortlist) {
            if (now() > deadline) { incomplete = true; result.budgetExhausted = true; break; }
            detection.candidates.push(this.verify(extracted, candidate.key, candidate.distance));
          }
          detection.candidates.sort((a, b) => evidenceRank(b) - evidenceRank(a));
          const best = detection.candidates[0];
          const siblings = best?.reference.artworkKey ? this.artGroups.get(`${best.reference.game}:${best.reference.artworkKey}`) : undefined;
          const group = best?.reference.artworkKey ? this.artIdentities.get(`${best.reference.game}:${best.reference.artworkKey}`) : undefined;
          const sharedArt = siblings ? { count: siblings.size, identityKey: group?.size === 1 ? group.keys().next().value : undefined } : false;
          Object.assign(detection, decideMatch(detection.candidates, extracted.quality, sharedArt));
          // A time cutoff cannot establish separation from an unchecked rival.
          if (incomplete) Object.assign(detection, { state: "unknown", autoEligible: false, deferred: true, reason: "Verification budget reached; keep the card still for another frame." });
          detection.candidates = detection.candidates.slice(0, 5);
          result.timings.matchingMs += now() - matchingStart;
        } finally { extracted?.descriptor.delete(); crop.delete(); gray.delete(); }
      }
      return result;
    } finally { source.delete(); result.timings.totalMs = now() - start; }
  }
  clear(): VisionCoverage {
    for (const mat of this.decoded.values()) mat.delete();
    this.decoded.clear(); this.references.clear(); this.artGroups.clear(); this.artIdentities.clear(); this.packs.clear(); this.index.clear(); this.descriptorBytes = 0; this.counts = { pokemon: 0, mtg: 0, yugioh: 0 };
    return this.coverage();
  }
  dispose(): void { if (this.disposed) return; this.clear(); this.orb.delete(); this.matcher.delete(); this.disposed = true; }
}
