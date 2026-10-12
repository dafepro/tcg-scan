import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Cv } from "./engine";
import { VisionEngine } from "./engine";
import { decideLearnedGroup, dequantizeLearnedReference, groupLearnedQuads, LearnedGeometryCadence, LearnedVisionEngine, mutualLearnedMatches, mutualLearnedSimilarity, verifyLearnedCandidate } from "./learned-engine";
import type { LearnedSimilarity } from "./learned-models";
import { learnedPolygonIoU } from "./learned-models";
import { syntheticCard, syntheticScene } from "./test-fixtures";
import type { LearnedIndexCard, LearnedModels, LearnedQueryFeatures, LearnedReferenceFeatures } from "./learned-types";
import type { CardDetection, MatchEvidence, Quad, QualityEvidence } from "./types";

let cv: Cv;
beforeAll(async () => { cv = await (createRequire(import.meta.url)("@techstark/opencv-js") as Promise<Cv>); }, 30_000);
const quad = (x = 0, y = 0, w = 100, h = 140): Quad => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const quality: QualityEvidence = { laplacianVariance: 100, contrast: 80, meanLuminance: 120, saturatedFraction: 0, sourceMinEdge: 240, featureCount: 256, issues: [] };
function reference(seed: number): LearnedReferenceFeatures {
  let state = seed;
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  return { key: `ref-${seed}`, points: Float32Array.from({ length: 512 }, (_, i) => i % 2 ? 12 + Math.floor(i / 2 / 16) * 20 : 10 + (Math.floor(i / 2) % 16) * 14), descriptors: Int8Array.from({ length: 16384 }, () => Math.round(rand() * 254 - 127)), scales: new Float32Array(256).fill(.01) };
}
function queryFor(ref: LearnedReferenceFeatures): LearnedQueryFeatures { return { points: new Float32Array(ref.points), descriptors: dequantizeLearnedReference(ref), scores: new Float32Array(256).fill(1) }; }
const metadata = (key: string): LearnedIndexCard => ({ key, game: "pokemon", name: key, hash: "0000000000000000", differenceHash: "0000000000000000", featureId: key, identityKey: key });
function evidence(key: string): MatchEvidence { return { key, reference: metadata(key), hashDistance: 0, tentativeMatches: 60, inliers: 50, inlierRatio: .9, interiorInliers: 20, coverage: .7, medianReprojectionError: .5, cornerError: .01, geometricallyVerified: true }; }
function detection(key: string, q = quad()): CardDetection { return { quad: q, state: "verified", autoEligible: true, quality, candidates: [evidence(key)], reason: "verified" }; }
function translate(image: ImageData, dx: number, dy: number): ImageData {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const sx = Math.max(0, Math.min(image.width - 1, x - dx)), sy = Math.max(0, Math.min(image.height - 1, y - dy));
    const source = (sy * image.width + sx) * 4;
    data.set(image.data.subarray(source, source + 4), (y * image.width + x) * 4);
  }
  return { ...image, data };
}

describe("frozen learned matching and geometry", () => {
  it("dequantizes scales then unit-normalizes and rejects invalid storage", () => {
    const ref = reference(1), decoded = dequantizeLearnedReference(ref);
    expect(decoded).toHaveLength(16384);
    expect(decoded.slice(0, 64).reduce((sum, v) => sum + v * v, 0)).toBeCloseTo(1, 6);
    const scaled = { ...ref, scales: new Float32Array(256).fill(.003) };
    expect(dequantizeLearnedReference(scaled)[12]).toBeCloseTo(decoded[12], 6);
    expect(() => dequantizeLearnedReference({ ...ref, scales: new Float32Array(256) })).toThrow();
    expect(() => dequantizeLearnedReference({ ...ref, descriptors: new Int8Array(16384).fill(-128) })).toThrow();
  });
  it("uses strict >.82 cosine, mutual bests, first-index ties and no ratio test", () => {
    const q = new Float32Array(128); q[0] = 1; q[64] = 1;
    const r = new Float32Array(128); r[0] = .82; r[1] = Math.sqrt(1 - .82 ** 2); r[64] = -1;
    expect(mutualLearnedMatches(q, r)).toEqual([]);
    r[0] = .820001;
    expect(mutualLearnedMatches(q, r)).toMatchObject([{ query: 0, reference: 0 }]);
    r[0] = 1; r[1] = 0; r[64] = 1;
    expect(mutualLearnedMatches(q, r)).toMatchObject([{ query: 0, reference: 0, cosine: 1 }]);
    expect(mutualLearnedMatches(new Float32Array(), r)).toEqual([]);
  });
  it("keeps batched MNN mutuality within each individual reference", () => {
    const scores = new Float32Array([.9, .1, .9, .1, .1, .9, .1, .9]);
    expect(mutualLearnedSimilarity(scores, 2, 4, 0, 2).map(p => [p.query, p.reference])).toEqual([[0, 0], [1, 1]]);
    expect(mutualLearnedSimilarity(scores, 2, 4, 2, 2).map(p => [p.query, p.reference])).toEqual([[0, 0], [1, 1]]);
    expect(mutualLearnedSimilarity(new Float32Array([.82, .82]), 1, 2, 0, 2)).toEqual([]);
    expect(() => mutualLearnedSimilarity(new Float32Array([NaN]), 1, 1, 0, 1)).toThrow("Nonfinite");
    expect(() => mutualLearnedSimilarity(scores, 501, 4, 0, 2)).toThrow();
  });
  it("preserves RANSAC, coverage and strict artwork gates with learned correspondences", () => {
    const ref = reference(1), query = queryFor(ref), card = metadata(ref.key);
    const good = verifyLearnedCandidate(cv, query, card, ref, query.descriptors, 0);
    expect(good).toMatchObject({ tentativeMatches: 256, inliers: 256, geometricallyVerified: true });
    expect(good.interiorInliers).toBeGreaterThanOrEqual(10);
    const border = { ...ref, points: Float32Array.from(ref.points, (v, i) => i % 2 ? v * .1 : v) };
    expect(verifyLearnedCandidate(cv, queryFor(border), card, border, query.descriptors, 0).geometricallyVerified).toBe(false);
    const noArt = { ...ref, points: Float32Array.from(ref.points, (v, i) => i % 2 ? (v < 170 ? v * .3 : 240 + v * .25) : v) };
    const rejected = verifyLearnedCandidate(cv, queryFor(noArt), card, noArt, query.descriptors, 0);
    expect(rejected.interiorInliers).toBe(0); expect(rejected.geometricallyVerified).toBe(false);
  });
  it("groups all IoU>=.70 connected hypotheses but keeps separate copies separate", () => {
    const proposals = [quad(), quad(10), quad(20), quad(300)];
    expect(groupLearnedQuads(proposals, (a, b) => learnedPolygonIoU(cv, a, b))).toEqual([[0, 1, 2], [3]]);
    expect(groupLearnedQuads([quad(), quad(10)], () => .70)).toEqual([[0, 1]]);
  });
  it("makes all-group identity conflicts and unchecked hypotheses review-only", () => {
    expect(decideLearnedGroup([detection("a"), detection("b")])).toMatchObject({ autoEligible: false, state: "ambiguous" });
    expect(decideLearnedGroup([detection("a"), { ...detection("a"), deferred: true }])).toMatchObject({ autoEligible: false, deferred: true });
    expect(decideLearnedGroup([detection("a"), detection("a")], true)).toMatchObject({ autoEligible: true, hypotheses: expect.any(Array) });
    const a = detection("printing-a"), b = detection("printing-b"); a.candidates[0].reference.identityKey = "same"; b.candidates[0].reference.identityKey = "same";
    expect(decideLearnedGroup([a, b]).autoEligible).toBe(true);
  });
});

describe("bounded geometry-only preview cadence", () => {
  it("reuses antialiased geometry after a tiny translation without extending expiry", () => {
    const cadence = new LearnedGeometryCadence(), image = syntheticScene(syntheticCard(1)), proposals = [quad()];
    cadence.record(image, proposals, 1000);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      expect(cadence.inspect(translate(image, dx, dy), 1200)).toEqual({ refresh: false, quads: proposals });
    }
    expect(cadence.inspect(image, 2499)).toEqual({ refresh: false, quads: proposals });
    expect(cadence.inspect(image, 2500)).toEqual({ refresh: true, quads: undefined });
  });
  it("invalidates changed cards, blank scenes, large motion and dimensions while throttling refresh", () => {
    const image = syntheticScene(syntheticCard(1)), proposals = [quad()];
    const changed = [syntheticScene(syntheticCard(99)), { ...image, data: new Uint8ClampedArray(image.data.length) }, translate(image, 32, 32), { ...image, width: 320, height: 1040 }];
    for (const next of changed) {
      const cadence = new LearnedGeometryCadence();
      cadence.record(image, proposals, 1000);
      expect(cadence.inspect(next, 1200)).toEqual({ refresh: false, quads: undefined });
      // Returning to the seed cannot resurrect an invalidated proposal pass.
      expect(cadence.inspect(image, 1300)).toEqual({ refresh: false, quads: undefined });
      expect(cadence.inspect(next, 2500)).toEqual({ refresh: true, quads: undefined });
    }
  });
  it.each([[2, 3], [31, 29], [65, 67]])("keeps the strict per-channel >12 threshold at %ix%i", (width, height) => {
    const image = { ...syntheticCard(1), width, height, data: new Uint8ClampedArray(width * height * 4).fill(80) };
    const altered = (redChange: number) => ({ ...image, data: Uint8ClampedArray.from(image.data, (value, i) => value + (i % 4 === 0 ? redChange : 0)) });
    const cadence = new LearnedGeometryCadence(), proposals = [quad()];
    cadence.record(image, proposals, 1000);
    expect(cadence.inspect(altered(12), 1200)).toEqual({ refresh: false, quads: proposals });
    expect(cadence.inspect(altered(13), 1300)).toEqual({ refresh: false, quads: undefined });
  });
  it("clears geometry and the proposal throttle together", () => {
    const cadence = new LearnedGeometryCadence(), image = syntheticCard(1), proposals = [quad()];
    expect(cadence.inspect(image, 0)).toEqual({ refresh: true, quads: undefined });
    cadence.record(image, proposals, 1000);
    expect(cadence.inspect(image, 1200)).toEqual({ refresh: false, quads: proposals });
    cadence.clear(); expect(cadence.inspect(image, 1300)).toEqual({ refresh: true, quads: undefined });
  });
});

describe("persistent learned engine lazy access and lifecycle", () => {
  async function fixture(count = 9, similarity?: LearnedSimilarity) {
    const image = syntheticScene(syntheticCard(1)), canonical = quad(200, 90, 239, 335), preprocessing = new VisionEngine(cv), source = cv.matFromImageData(image);
    const hash = preprocessing.prepareLearnedCrop(source, canonical).hashes[0]; source.delete(); preprocessing.dispose();
    const refs = Array.from({ length: count }, (_, i) => reference(i + 1)), cards = refs.map(ref => ({ ...metadata(ref.key), ...hash }));
    const load = vi.fn(async (key: string) => refs.find(r => r.key === key)!);
    const models: LearnedModels = { propose: vi.fn(async () => [canonical]), extract: vi.fn(async () => queryFor(refs[0])), dispose: vi.fn() };
    return { image, refs, cards, load, models, engine: new LearnedVisionEngine(cv, models, cards, load, similarity) };
  }
  it("starts with metadata only, evaluates every shortlist rival, and caps decoded LRU8", async () => {
    const f = await fixture();
    expect(f.load).not.toHaveBeenCalled(); expect(f.engine.coverage().totalReferences).toBe(9);
    const result = await f.engine.analyze(f.image, { mode: "photo", includeDiagnostics: true });
    expect(result.detections).toHaveLength(1); expect(result.detections[0].autoEligible).toBe(true);
    expect(result.detections[0].hypotheses?.length).toBeGreaterThanOrEqual(1);
    for (const hypothesis of result.detections[0].hypotheses!) expect(hypothesis.candidates).toHaveLength(8);
    expect(new Set(f.load.mock.calls.map(call => call[0])).size).toBe(8);
    expect(f.engine.decodedReferenceCount).toBeLessThanOrEqual(8);
    await f.engine.dispose(); expect(f.models.dispose).toHaveBeenCalledOnce();
  });
  it("recomputes current crops, identities and all eight rivals when antialiased geometry is reused", async () => {
    const f = await fixture(), current = translate(f.image, 1, 0);
    // A one-level exposure change also distinguishes freshly rectified crops
    // whose current contour exactly compensates for the one-pixel translation.
    for (let i = 0; i < current.data.length; i++) if (i % 4 !== 3) current.data[i]++;
    let selected = 0;
    f.models.extract = vi.fn(async () => queryFor(f.refs[selected]));
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const first = await f.engine.analyze(f.image, { mode: "binder", includeDiagnostics: true });
      const firstExtractions = vi.mocked(f.models.extract).mock.calls.length, firstReads = f.load.mock.calls.length;
      expect(first.detections[0].autoEligible).toBe(true);
      expect(first.detections[0].candidates[0].key).toBe("ref-1");
      selected = 1;
      const second = await f.engine.analyze(current, { mode: "binder", includeDiagnostics: true });
      expect(second.scheduling).toMatchObject({ proposalRefresh: false, proposalCacheReused: true });
      expect(f.models.propose).toHaveBeenCalledOnce();
      expect(second.detections[0].autoEligible).toBe(true);
      expect(second.detections[0].candidates[0].key).toBe("ref-2");
      const calls = vi.mocked(f.models.extract).mock.calls, freshExtractions = calls.length - firstExtractions;
      expect(freshExtractions).toBeGreaterThan(0);
      expect(calls[firstExtractions][0]).not.toBe(calls[0][0]);
      expect(calls[firstExtractions][0].data.some((value, i) => value !== calls[0][0].data[i])).toBe(true);
      expect(f.load.mock.calls.length - firstReads).toBe(freshExtractions * 8);
      expect(new Set(f.load.mock.calls.slice(firstReads).map(call => call[0])).size).toBe(8);
      for (const result of [first, second]) for (const hypothesis of result.detections[0].hypotheses!) expect(hypothesis.candidates).toHaveLength(8);
      expect(second.detections[0].candidates[0]).not.toBe(first.detections[0].candidates[0]);
      f.load.mockImplementation(async key => { if (key === "ref-8") throw new Error("Corrupt current rival"); return f.refs.find(r => r.key === key)!; });
      await expect(f.engine.analyze(current, { mode: "binder" })).rejects.toThrow("Corrupt current rival");
      expect(f.models.propose).toHaveBeenCalledOnce();
      expect(f.engine.decodedReferenceCount).toBe(0);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });
  it("does not return partially verified evidence when a later local rival is missing", async () => {
    const f = await fixture();
    f.load.mockImplementation(async key => { if (key === "ref-8") throw new Error("Corrupt local rival"); return f.refs.find(r => r.key === key)!; });
    await expect(f.engine.analyze(f.image, { mode: "photo" })).rejects.toThrow("Corrupt");
    expect(f.engine.decodedReferenceCount).toBe(0); await f.engine.dispose();
  });
  it("defers the whole group if a photo deadline leaves any rival unchecked", async () => {
    const f = await fixture(); let time = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time += 20);
    try {
      const result = await f.engine.analyze(f.image, { mode: "photo", budgetMs: 200, includeDiagnostics: true });
      expect(result.budgetExhausted).toBe(true); expect(result.detections.every(d => !d.autoEligible && d.deferred)).toBe(true);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });
  it("drops concurrent work and rejects stale completed inference after cancellation", async () => {
    const f = await fixture(); let release!: (value: Quad[]) => void;
    f.models.propose = vi.fn(() => new Promise<Quad[]>(resolve => { release = resolve; }));
    const pending = f.engine.analyze(f.image, { mode: "photo" });
    await expect(f.engine.analyze(f.image, { mode: "photo" })).rejects.toThrow("busy");
    f.engine.cancel(); release([]);
    await expect(pending).rejects.toThrow("canceled");
    expect(f.load).not.toHaveBeenCalled(); await f.engine.dispose();
  });
  it("photo ignores maxCards and manual regions fail closed", async () => {
    const f = await fixture();
    await expect(f.engine.analyze(f.image, { mode: "photo", region: quad() })).rejects.toThrow("automatic");
    const result = await f.engine.analyze(f.image, { mode: "photo", maxCards: 0 });
    expect(result.detections.length).toBeGreaterThan(0); await f.engine.dispose();
  });
  it("keeps learned query points below35 ineligible even with good geometry", async () => {
    const f = await fixture();
    const query = queryFor(f.refs[0]);
    f.models.extract = async () => ({ points: query.points.slice(0, 68), descriptors: query.descriptors.slice(0, 34 * 64), scores: query.scores.slice(0, 34) });
    const result = await f.engine.analyze(f.image, { mode: "photo" });
    expect(result.detections[0]).toMatchObject({ autoEligible: false, state: "quality" });
    expect(result.detections[0].quality.issues.join(" ")).toContain("learned");
    await f.engine.dispose();
  });
  it("uses three fresh current-frame group turns despite proposal overrun, then advances", async () => {
    const f = await fixture(); let time = 0;
    f.models.propose = vi.fn(async () => { time += 1000; return [quad(200, 90, 239, 335), quad(10, 10, 100, 140), quad(470, 300, 100, 140)]; });
    f.models.extract = vi.fn(async () => { time += 100; return queryFor(f.refs[0]); });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      const first = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80 });
      const second = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80 });
      const third = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80 });
      expect(first.scheduling).toMatchObject({ processedGroups: 1, deferredGroups: 2, proposalRefresh: true });
      expect(first.scheduling!.overrunMs).toBeGreaterThan(900);
      expect(first.detections[0].autoEligible).toBe(true);
      expect(second.detections[0].quad).toEqual(first.detections[0].quad);
      expect(third.detections[0].quad).toEqual(first.detections[0].quad);
      expect([first.scheduling!.burstFrame, second.scheduling!.burstFrame, third.scheduling!.burstFrame]).toEqual([1, 2, 3]);
      const fourth = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80 });
      expect(fourth.detections[0].quad).toEqual(quad(10, 10, 100, 140));
      expect(f.models.propose).toHaveBeenCalledOnce();
      expect(f.models.extract).toHaveBeenCalledTimes(7); // Two NEW crops each turn, then one in next group.
      expect(second.detections.slice(1).every(d => d.deferred && !d.autoEligible)).toBe(true);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });
  it("opt-in one-observation scheduling rotates groups without reusing identity evidence", async () => {
    const f = await fixture(); let time = 0;
    f.models.propose = vi.fn(async () => { time += 1000; return [quad(200, 90, 239, 335), quad(10, 10, 100, 140), quad(470, 300, 100, 140)]; });
    f.models.extract = vi.fn(async () => { time += 100; return queryFor(f.refs[0]); });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      const first = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80, previewBurstObservations: 1 });
      const second = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80, previewBurstObservations: 1 });
      expect(first.scheduling!.focusedGroup).toBe(0);
      expect(second.scheduling!.focusedGroup).toBe(1);
      expect(first.scheduling!.focusAttempt).toBe(1);
      expect(second.scheduling!.focusAttempt).toBe(1);
      expect(second.detections[0].quad).not.toEqual(first.detections[0].quad);
      expect(f.models.extract).toHaveBeenCalledTimes(3);
      const strict = await f.engine.analyze(f.image, { mode: "binder", budgetMs: 80, previewBurstObservations: 3 });
      expect(strict.scheduling!.focusedGroup).toBe(0);
      expect(strict.scheduling!.burstFrame).toBe(1);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });

  it("bounds an optional matrix batch to8references and fails closed on backend errors", async () => {
    const backend: LearnedSimilarity = { multiply: vi.fn(async (query, _transposed, columns) => new Float32Array(query.length / 64 * columns)), dispose: vi.fn(async () => {}) };
    const f = await fixture(9, backend);
    const result = await f.engine.analyze(f.image, { mode: "photo", includeDiagnostics: true });
    expect(result.detections.every(d => !d.autoEligible)).toBe(true);
    const calls = vi.mocked(backend.multiply).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [query, transposed, columns] of calls) { expect(query.length).toBeLessThanOrEqual(500 * 64); expect(columns).toBe(2048); expect(transposed.length).toBe(64 * columns); }
    vi.mocked(backend.multiply).mockRejectedValue(new Error("Matrix backend failure"));
    await expect(f.engine.analyze(f.image, { mode: "photo" })).rejects.toThrow("Matrix backend failure");
    expect(f.engine.decodedReferenceCount).toBe(0); await f.engine.dispose(); expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it("never upscales a too-small source into printing eligibility", async () => {
    const f = await fixture();
    const result = await f.engine.analyze(f.image, { mode: "photo", includePrintingCrops: true, maxPrintingCrops: 100 });
    expect(result.detections[0].autoEligible).toBe(true);
    expect(result.detections[0].printingCrop).toBeUndefined(); expect(result.detections[0].printingSourceMinEdge).toBeUndefined();
    const preprocessing = new VisionEngine(cv), large = cv.matFromImageData({ width: 800, height: 1000, data: new Uint8ClampedArray(800 * 1000 * 4).fill(120) } as ImageData);
    try {
      expect(preprocessing.preparePrintingCrop(large, quad(20, 20, 479, 672))).toBeUndefined();
      const crop = preprocessing.preparePrintingCrop(large, quad(20, 20, 480, 672))!;
      expect(crop.sourceMinEdge).toBe(480); expect(crop.image.width).toBe(480); expect(crop.image.height).toBe(672);
      expect(preprocessing.preparePrintingCrop(large, quad(20, 20, 600, 900))!.image).toMatchObject({ width: 600, height: 840 });
      expect(() => preprocessing.preparePrintingCrop(large, quad(20, 20, 900, 1200))).toThrow("inside the current frame");
      const largest = cv.matFromImageData({ width: 1200, height: 1600, data: new Uint8ClampedArray(1200 * 1600 * 4) } as ImageData);
      try { expect(preprocessing.preparePrintingCrop(largest, quad(20, 20, 1000, 1400))!.image).toMatchObject({ width: 960, height: 1344 }); } finally { largest.delete(); }
    } finally { preprocessing.dispose(); large.delete(); await f.engine.dispose(); }
  });
  it("makes the high-resolution current crop opt-in without changing identity evidence", async () => {
    const f = await fixture(), input = cv.matFromImageData(f.image), resized = new cv.Mat();
    cv.resize(input, resized, new cv.Size(f.image.width * 3, f.image.height * 3));
    const image = { width: resized.cols, height: resized.rows, data: new Uint8ClampedArray(resized.data) } as ImageData;
    input.delete(); resized.delete();
    const current = quad(600, 270, 717, 1005); f.models.propose = async () => [current];
    const without = await f.engine.analyze(image, { mode: "photo" });
    expect(without.detections[0].autoEligible).toBe(true); expect(without.detections[0].printingCrop).toBeUndefined();
    const withCrop = await f.engine.analyze(image, { mode: "photo", includePrintingCrops: true, printingRegions: [current] });
    const selected = withCrop.detections.find(d => d.printingCrop)!;
    expect(selected.autoEligible).toBe(true); expect(selected.printingCrop!.width).toBe(Math.min(960, Math.floor(selected.printingSourceMinEdge!))); expect(selected.printingCrop!.height).toBe(Math.round(selected.printingCrop!.width * 336 / 240)); expect(selected.printingSourceMinEdge).toBeGreaterThanOrEqual(480);
    expect(selected.candidates[0].key).toBe(without.detections[0].candidates[0].key);
    await expect(f.engine.analyze(image, { mode: "photo", printingRegions: [current, current, current] })).rejects.toThrow("at most two");
    await f.engine.dispose();
  });

  it("keeps separate physical copies and caps requested printing crops at2", async () => {
    const f = await fixture(), input = cv.matFromImageData(syntheticCard(1)), resized = new cv.Mat();
    cv.resize(input, resized, new cv.Size(720, 1008));
    const data = new Uint8ClampedArray(2400 * 1200 * 4).fill(35), starts = [30, 830, 1630];
    for (const x of starts) for (let y = 0; y < 1008; y++) data.set(resized.data.subarray(y * 720 * 4, (y + 1) * 720 * 4), ((y + 50) * 2400 + x) * 4);
    input.delete(); resized.delete();
    const image = { width: 2400, height: 1200, data } as ImageData, regions = starts.map(x => quad(x, 50, 719, 1007));
    f.models.propose = async () => regions;
    const result = await f.engine.analyze(image, { mode: "photo", includePrintingCrops: true, maxPrintingCrops: 999, printingRegions: [regions[2], regions[0]] });
    expect(result.detections.filter(d => d.autoEligible)).toHaveLength(3);
    const crops = result.detections.filter(d => d.printingCrop); expect(crops).toHaveLength(2);
    expect(crops.every(d => d.printingSourceMinEdge! >= 480)).toBe(true);
    expect(crops.every(d => d.quad[0].x < 100 || d.quad[0].x > 1600)).toBe(true);
    await f.engine.dispose();
  });

  it("resets preview bursts on motion, mode, game, resolution and cancellation", async () => {
    const f = await fixture(); let time = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(1);
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(2);
      const blank = { ...f.image, data: new Uint8ClampedArray(f.image.data.length).fill(127) };
      const invalidated = await f.engine.analyze(blank, { mode: "binder" });
      expect(invalidated.detectionComplete).toBe(false); expect(invalidated.detections.every(d => !d.autoEligible && d.deferred)).toBe(true);
      time = 2000;
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(1);
      expect((await f.engine.analyze(f.image, { mode: "stream" })).scheduling!.burstFrame).toBe(1);
      expect((await f.engine.analyze(f.image, { mode: "stream", game: "pokemon" })).scheduling!.burstFrame).toBe(1);
      const data = new Uint8ClampedArray((f.image.width + 1) * f.image.height * 4);
      for (let y = 0; y < f.image.height; y++) data.set(f.image.data.subarray(y * f.image.width * 4, (y + 1) * f.image.width * 4), y * (f.image.width + 1) * 4);
      expect((await f.engine.analyze({ ...f.image, width: f.image.width + 1, data }, { mode: "stream", game: "pokemon" })).scheduling!.burstFrame).toBe(1);
      f.engine.cancel();
      expect((await f.engine.analyze(f.image, { mode: "stream", game: "pokemon" })).scheduling!.burstFrame).toBe(1);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });
  it("resets a burst if a geometry component gains or loses a hypothesis", async () => {
    const f = await fixture(), canonical = quad(200, 90, 239, 335);
    const detector = vi.spyOn(VisionEngine.prototype, "detect").mockReturnValue([canonical]);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(1);
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(2);
      detector.mockReturnValue([]);
      expect((await f.engine.analyze(f.image, { mode: "binder" })).scheduling!.burstFrame).toBe(1);
    } finally { clock.mockRestore(); detector.mockRestore(); await f.engine.dispose(); }
  });

  it("rotates after3completed attempts even when expiry resets every evidence burst", async () => {
    const f = await fixture(); let time = 0;
    f.models.propose = async () => [quad(200, 90, 239, 335), quad(10, 10, 100, 140)];
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      const results = [];
      for (let i = 0; i < 4; i++) { results.push(await f.engine.analyze(f.image, { mode: "binder" })); time += 2000; }
      expect(results.map(r => r.scheduling!.burstFrame)).toEqual([1, 1, 1, 1]);
      expect(results.map(r => r.scheduling!.focusAttempt)).toEqual([1, 2, 3, 1]);
      expect(results.slice(0, 3).every(r => r.detections[0].autoEligible)).toBe(true);
      expect(results[3].detections[0].quad).toEqual(quad(10, 10, 100, 140));
      expect(results[3].detections[0].autoEligible).toBe(false);
    } finally { clock.mockRestore(); await f.engine.dispose(); }
  });

  it("pack uses a fresh single-window proposal and all eight rivals even beyond its soft budget", async () => {
    const f = await fixture(), detector = vi.spyOn(VisionEngine.prototype, "detect"), clock = vi.spyOn(performance, "now");
    let time = 0; clock.mockImplementation(() => time += 100);
    f.models.extract = vi.fn(async () => ({ ...queryFor(f.refs[0]), timings: { preprocessingMs: 2, inferenceMs: 3, postprocessingMs: 4, totalMs: 9 } }));
    try {
      const first = await f.engine.analyze(f.image, { mode: "pack", budgetMs: 80, includeDiagnostics: true });
      const second = await f.engine.analyze(translate(f.image, 32, 0), { mode: "pack", budgetMs: 80, includeDiagnostics: true });
      expect(detector).not.toHaveBeenCalled(); expect(f.models.propose).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.models.propose).mock.calls.every(call => call[1] === "pack")).toBe(true);
      for (const result of [first, second]) {
        expect(result.detectionComplete).toBe(true); expect(result.budgetExhausted).toBe(false);
        expect(result.scheduling).toMatchObject({ proposalRefresh: true, proposalCacheReused: false, processedGroups: 1, deferredGroups: 0 });
        expect(result.detections[0].hypotheses![0].candidates).toHaveLength(8);
        expect(result.timings).toMatchObject({ xfeatPreprocessingMs: 2, xfeatInferenceMs: 3, xfeatPostprocessingMs: 4 });
      }
      expect(f.load).toHaveBeenCalledTimes(16); expect(f.models.extract).toHaveBeenCalledTimes(2);
    } finally { detector.mockRestore(); clock.mockRestore(); await f.engine.dispose(); }
  });
  it("pack rejects extra detector hypotheses and fails closed if any rival is unreadable", async () => {
    const f = await fixture();
    try {
      f.models.propose = vi.fn(async () => [quad(200, 90, 239, 335), quad(10, 10)]);
      await expect(f.engine.analyze(f.image, { mode: "pack" })).rejects.toThrow("Invalid learned corner proposals");
      f.models.propose = vi.fn(async () => [quad(200, 90, 239, 335)]);
      f.load.mockRejectedValueOnce(new Error("Corrupt reference"));
      await expect(f.engine.analyze(f.image, { mode: "pack" })).rejects.toThrow("Corrupt reference");
    } finally { await f.engine.dispose(); }
  });

});
