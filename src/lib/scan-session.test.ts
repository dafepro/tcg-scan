import { describe, it, expect } from "vitest";
import { ScanSession } from "./scan-session";
import type { CardDetection, VisionResult } from "./vision/types";
function detection(x = 0, key = "one"): CardDetection {
  return {
    quad: [
      { x, y: 0 },
      { x: x + 100, y: 0 },
      { x: x + 100, y: 140 },
      { x, y: 140 },
    ],
    state: "verified",
    reason: "Verified geometry",
    autoEligible: true,
    quality: {
      laplacianVariance: 100,
      contrast: 40,
      meanLuminance: 120,
      saturatedFraction: 0,
      sourceMinEdge: 100,
      featureCount: 100,
      issues: [],
    },
    candidates: [
      {
        key,
        reference: { key, game: "pokemon", name: key },
        hashDistance: 0,
        tentativeMatches: 60,
        inliers: 55,
        inlierRatio: 0.9,
        interiorInliers: 30,
        coverage: 0.7,
        medianReprojectionError: 1,
        cornerError: 0.01,
        geometricallyVerified: true,
      },
    ],
  };
}
function result(d: CardDetection[]): VisionResult {
  return {
    width: 1000,
    height: 720,
    detections: d,
    timings: { detectionMs: 1, extractionMs: 2, matchingMs: 3, totalMs: 6 },
    coverage: {
      totalReferences: 2,
      byGame: { pokemon: 2, mtg: 0, yugioh: 0 },
      packs: ["test"],
    },
    budgetExhausted: false,
  };
}
function stable(s: ScanSession, d = [detection()], start = 0) {
  s.update(result(d), start);
  s.update(result(d), start + 150);
  return s.update(result(d), start + 300);
}
describe("physical scan sessions", () => {
  it("counts a held card exactly once across 1000 frames and ignores stale callbacks", () => {
    const s = new ScanSession("s", "stream");
    const add = stable(s).additions[0];
    expect(add).toBeTruthy();
    s.acknowledge(add.eventId);
    for (let i = 4; i < 1004; i++)
      expect(s.update(result([detection()]), i * 150).additions).toHaveLength(
        0,
      );
    expect(s.update(result([detection()]), 1).ignored).toBe(true);
  });
  it("counts simultaneous identical copies separately", () => {
    const s = new ScanSession("s", "binder");
    const update = stable(s, [detection(0), detection(200), detection(400)]);
    expect(update.additions).toHaveLength(3);
    expect(new Set(update.additions.map((x) => x.eventId)).size).toBe(3);
  });
  it("does not recount brief occlusion, then rearms after a measured empty interval", () => {
    const s = new ScanSession("s", "stream");
    const add = stable(s).additions[0];
    s.acknowledge(add.eventId);
    s.update(result([]), 500);
    s.update(result([]), 900);
    expect(s.update(result([detection()]), 1000).additions).toHaveLength(0);
    s.update(result([]), 1200);
    expect(s.update(result([]), 2500).resetAfterEmpty).toBe(true);
    expect(stable(s, [detection()], 2700).additions).toHaveLength(1);
  });
  it("binder does not reset when empty; explicit new page counts copies again", () => {
    const s = new ScanSession("s", "binder");
    const add = stable(s).additions[0];
    s.acknowledge(add.eventId);
    s.update(result([]), 500);
    s.update(result([]), 5000);
    expect(stable(s, [detection()], 5500).additions).toHaveLength(0);
    s.newPage();
    expect(stable(s, [detection()], 7000).additions).toHaveLength(1);
  });
  it("never saves ambiguous, poor quality or unfinished shortlist detections", () => {
    for (const state of ["ambiguous", "quality", "unknown"] as const) {
      const s = new ScanSession(state, "stream");
      expect(
        stable(s, [{ ...detection(), state, autoEligible: false }]).additions,
      ).toHaveLength(0);
    }
    const s = new ScanSession("budget", "stream");
    for (let t = 0; t < 1000; t += 150)
      expect(
        s.update(
          {
            ...result([
              { ...detection(), autoEligible: false, deferred: true },
            ]),
            budgetExhausted: true,
          },
          t,
        ).additions,
      ).toHaveLength(0);
  });
  it("resets evidence on changed identity and does not relabel saved tracks", () => {
    const s = new ScanSession("s", "stream");
    s.update(result([detection(0, "a")]), 0);
    s.update(result([detection(0, "a")]), 150);
    expect(s.update(result([detection(0, "b")]), 300).additions).toHaveLength(
      0,
    );
    const add = s.update(result([detection(0, "b")]), 600);
    expect(add.additions).toHaveLength(0);
    const event = s.update(result([detection(0, "b")]), 750).additions[0];
    s.acknowledge(event.eventId);
    s.update(result([detection(0, "a")]), 900);
    expect(
      s.snapshot().find((t) => t.eventId === event.eventId)?.reference?.key,
    ).toBe("b");
  });
  it("failed durability is an error, never added; undo stays suppressed", () => {
    const s = new ScanSession("s", "stream");
    const event = stable(s).additions[0];
    s.acknowledge(event.eventId, "Storage full");
    expect(s.snapshot()[0].status).toBe("error");
    expect(s.snapshot()[0].counted).toBe(false);
    s.undo(event.eventId);
    expect(s.update(result([detection()]), 600).additions).toHaveLength(0);
  });
  it("pause auto-save keeps collecting evidence without an insertion", () => {
    const s = new ScanSession("s", "stream");
    for (let t = 0; t < 1000; t += 150)
      expect(s.update(result([detection()]), t, false).additions).toHaveLength(
        0,
      );
    expect(s.update(result([detection()]), 1200, true).additions).toHaveLength(
      1,
    );
  });
  it("lets completed binder crops progress while other regions are deferred", () => {
    const s = new ScanSession("deferred", "binder");
    const unknown = {
      ...detection(200),
      autoEligible: false,
      deferred: true,
      candidates: [],
    };
    s.update({ ...result([detection(), unknown]), budgetExhausted: true }, 0);
    s.update(
      {
        ...result([
          { ...detection(), autoEligible: false, deferred: true },
          unknown,
        ]),
        budgetExhausted: true,
      },
      150,
    );
    s.update({ ...result([detection(), unknown]), budgetExhausted: true }, 300);
    const update = s.update(
      { ...result([detection(), unknown]), budgetExhausted: true },
      600,
    );
    expect(update.additions).toHaveLength(1);
    expect(update.additions[0].reference.key).toBe("one");
  });
});
