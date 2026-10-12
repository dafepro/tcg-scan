import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VisionEngine } from "./engine";
import type { Cv } from "./engine";
import { extractReferenceFeatures } from "./features";
import type { FeaturePack, Quad } from "./types";

import { syntheticCard as card, syntheticScene as scene } from "./test-fixtures";

let cv: Cv, engine: VisionEngine, pack: FeaturePack;
beforeAll(async () => {
  const runtime = createRequire(import.meta.url)("@techstark/opencv-js");
  cv = await (runtime as unknown as Promise<Cv>);
  pack = { version: 1, algorithm: "orb-phash-v1", width: 240, height: 336, name: "Original test shapes", cards: [1, 2, 3].map(seed => ({ key: `original-${seed}`, game: "pokemon", name: `Original shapes ${seed}` })), features: [1, 2, 3].map(seed => extractReferenceFeatures(cv, card(seed), `original-${seed}`)) };
  engine = new VisionEngine(cv); engine.loadPack(pack);
}, 30_000);
afterAll(() => engine?.dispose());

describe("actual OpenCV local pipeline", () => {
  it("detects and feature-verifies an upright and upside-down card", () => {
    for (const reversed of [false, true]) {
      const result = engine.analyze(scene(card(1), reversed), { budgetMs: 1000, includeCrops: true, includeDiagnostics: true });
      expect(result.detections).toHaveLength(1);
      const detection = result.detections[0];
      expect(detection.state).toBe("verified"); expect(detection.autoEligible).toBe(true);
      expect(detection.candidates[0].key).toBe("original-1");
      expect(detection.candidates[0].inliers).toBeGreaterThanOrEqual(24);
      expect(detection.candidates[0].interiorInliers).toBeGreaterThanOrEqual(10);
      expect(detection.crop?.width).toBe(240);
      expect(detection.retrieval?.shortlistKeys).toContain("original-1");
      expect(detection.retrieval?.retrievalMs).toBeGreaterThanOrEqual(0);
    }
  });
  it("does not accept an out-of-index card with the same border/layout", () => {
    const result = engine.analyze(scene(card(99)), { budgetMs: 1000 });
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].autoEligible).toBe(false);
    expect(result.detections[0].state).toBe("unknown");
  });
  it("rejects a flat low-detail manual crop", () => {
    const image = scene(card(1)); image.data.fill(240);
    const region: Quad = [{ x: 200, y: 90 }, { x: 439, y: 90 }, { x: 439, y: 425 }, { x: 200, y: 425 }];
    const detection = engine.analyze(image, { region, budgetMs: 1000 }).detections[0];
    expect(detection.state).toBe("quality"); expect(detection.autoEligible).toBe(false);
  });
  it("returns no phantom card for a blank frame", () => {
    const blank = scene(card(1)); blank.data.fill(120);
    expect(engine.analyze(blank, { budgetMs: 1000 }).detections).toEqual([]);
  });
  it("marks budget-skipped crops deferred and never auto-eligible", () => {
    let tick = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => tick += 100);
    try {
      const result = engine.analyze(scene(card(1)), { budgetMs: 80 });
      expect(result.budgetExhausted).toBe(true);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0]).toMatchObject({ deferred: true, autoEligible: false, state: "unknown" });
    } finally { clock.mockRestore(); }
  });
  it("validates imported packs atomically and marks shared-art printings ambiguous", () => {
    expect(() => engine.loadPack({ ...pack, features: [{ ...pack.features[0], descriptors: "bad" }] })).toThrow();
    expect(engine.coverage().totalReferences).toBe(3);
    const a = { ...pack.cards[0], artworkKey: "same-art" }, b = { ...a, key: "printing-b" };
    engine.loadPack({ ...pack, cards: [a, b], features: [pack.features[0], { ...pack.features[0], key: b.key }] });
    const detection = engine.analyze(scene(card(1)), { budgetMs: 1000 }).detections[0];
    expect(detection.state).toBe("ambiguous"); expect(detection.autoEligible).toBe(false);
    expect(engine.coverage().totalReferences).toBe(4);
    engine.loadPack({ ...pack, cards: [{ ...a, identityKey: "same-identity" }, { ...b, identityKey: "same-identity" }], features: [pack.features[0], { ...pack.features[0], key: b.key }] });
    const identityOnly = engine.analyze(scene(card(1)), { budgetMs: 1000 }).detections[0];
    expect(identityOnly).toMatchObject({ state: "verified", autoEligible: true, printingAmbiguous: true });
    expect(identityOnly.reason).toContain("unconfirmed");
  });
});
