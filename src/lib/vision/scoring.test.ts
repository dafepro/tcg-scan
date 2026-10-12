import { describe, expect, it } from "vitest";
import { decideMatch, hasGeometricEvidence } from "./scoring";
import type { MatchEvidence, QualityEvidence } from "./types";
const quality: QualityEvidence = { laplacianVariance: 300, contrast: 50, meanLuminance: 150, saturatedFraction: 0, sourceMinEdge: 200, featureCount: 300, issues: [] };
const good = (key = "one"): MatchEvidence => ({ key, reference: { key, name: key, game: "pokemon" }, hashDistance: 1, tentativeMatches: 60, inliers: 55, inlierRatio: 55 / 60, interiorInliers: 20, coverage: 0.5, medianReprojectionError: 0.6, cornerError: 0.01, geometricallyVerified: true });
describe("evidence-based match rejection", () => {
  it("never treats an exact hash as verification", () => {
    const hashOnly = { ...good(), hashDistance: 0, inliers: 0, geometricallyVerified: false };
    expect(decideMatch([hashOnly], quality).autoEligible).toBe(false);
  });
  it("rejects shared-border features, weak spatial support, and poor alignment", () => {
    expect(hasGeometricEvidence({ ...good(), interiorInliers: 0 })).toBe(false);
    expect(hasGeometricEvidence({ ...good(), coverage: 0.04 })).toBe(false);
    expect(hasGeometricEvidence({ ...good(), cornerError: 0.5 })).toBe(false);
    expect(hasGeometricEvidence({ ...good(), inliers: 20 })).toBe(false);
    expect(hasGeometricEvidence(good())).toBe(true);
  });
  it("requires separation from the next distinct identity", () => {
    expect(decideMatch([good(), { ...good("two"), inliers: 47 }], quality).state).toBe("ambiguous");
    expect(decideMatch([good()], quality)).toMatchObject({ state: "verified", autoEligible: true });
  });
  it("blocks unresolved artwork identities but permits explicit identity-only matches", () => {
    expect(decideMatch([good()], quality, true)).toMatchObject({ state: "ambiguous", autoEligible: false });
    const a = good(), b = good("printing-two");
    a.reference.identityKey = b.reference.identityKey = "one-card";
    expect(decideMatch([a, b], quality)).toMatchObject({ state: "verified", autoEligible: true, printingAmbiguous: true });
    expect(decideMatch([a], quality, { count: 2, identityKey: "one-card" })).toMatchObject({ state: "verified", autoEligible: true, printingAmbiguous: true });
    expect(decideMatch([a], quality, { count: 2, identityKey: "different-card" }).state).toBe("ambiguous");
  });
  it("blocks automatic addition on a failed quality gate", () => {
    expect(decideMatch([good()], { ...quality, issues: ["Refocus."] })).toMatchObject({ state: "quality", autoEligible: false });
    expect(decideMatch([], quality).state).toBe("unknown");
  });
});
