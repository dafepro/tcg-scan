import type { DetectionState, MatchEvidence, QualityEvidence } from "./types";

export const VERIFICATION = { minInliers: 24, minInlierRatio: 0.48, minCoverage: 0.22, maxReprojectionError: 2.8, maxCornerError: 0.12, minInteriorInliers: 10 } as const;
export function hasGeometricEvidence(e: Omit<MatchEvidence, "reference" | "key" | "geometricallyVerified">): boolean {
  return e.inliers >= VERIFICATION.minInliers && e.inlierRatio >= VERIFICATION.minInlierRatio && e.coverage >= VERIFICATION.minCoverage && e.medianReprojectionError <= VERIFICATION.maxReprojectionError && e.cornerError <= VERIFICATION.maxCornerError && e.interiorInliers >= VERIFICATION.minInteriorInliers;
}
export function evidenceRank(e: MatchEvidence): number {
  // Ranking score only. This is deliberately never presented as confidence.
  return e.inliers * e.inlierRatio * Math.sqrt(e.coverage) / (1 + e.medianReprojectionError / 3);
}
export function decideMatch(candidates: MatchEvidence[], quality: QualityEvidence, sharedArtwork: boolean | { count: number; identityKey?: string } = false): { state: DetectionState; autoEligible: boolean; printingAmbiguous: boolean; reason: string } {
  if (quality.issues.length) return { state: "quality", autoEligible: false, printingAmbiguous: false, reason: quality.issues.join(" ") };
  const sorted = [...candidates].sort((a, b) => evidenceRank(b) - evidenceRank(a));
  const best = sorted[0];
  if (!best?.geometricallyVerified) return { state: "unknown", autoEligible: false, printingAmbiguous: false, reason: candidates.length ? "No reference passed local feature and perspective verification." : "No nearby reference in the loaded local index." };
  const bestIdentity = best.reference.identityKey || best.key;
  const rival = sorted.find(c => (c.reference.identityKey || c.key) !== bestIdentity);
  const printingRival = sorted.find(c => c.key !== best.key && c.geometricallyVerified && ((c.reference.artworkKey && c.reference.artworkKey === best.reference.artworkKey) || (c.reference.identityKey && c.reference.identityKey === best.reference.identityKey)));
  const closeRival = rival && (rival.inliers >= best.inliers * 0.72 || evidenceRank(rival) >= evidenceRank(best) * 0.67) && rival.inliers >= 14 && rival.coverage >= 0.12;
  const knownSharedArt = sharedArtwork === true || (typeof sharedArtwork === "object" && sharedArtwork.count > 1);
  const artIdentityUnresolved = knownSharedArt && (sharedArtwork === true || !best.reference.identityKey || (typeof sharedArtwork === "object" && sharedArtwork.identityKey !== best.reference.identityKey));
  const printingAmbiguous = knownSharedArt || !!printingRival;
  if (artIdentityUnresolved || closeRival) return { state: "ambiguous", autoEligible: false, printingAmbiguous, reason: "Matching artwork is not clearly separated from another identity. Keep this card for review." };
  // Automatic collection rows are explicitly identity-only. Known alternate
  // printings may share one identity, but no edition/finish/condition is inferred.
  return { state: "verified", autoEligible: true, printingAmbiguous, reason: printingAmbiguous ? "Card identity verified across matching printings. Exact printing and finish remain unconfirmed." : "Card identity verified by local ORB features and RANSAC alignment. Printing and finish remain unconfirmed." };
}
