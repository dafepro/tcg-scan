import { describe, expect, it } from "vitest";
import {
  planPrintingLiteralGuidance,
  PRINTING_LITERAL_GUIDANCE_LIMITS,
} from "./printing-literal-guidance";
import type {
  PrintingCandidate,
  PrintingResolution,
} from "./printing-refinement";
import {
  parsePrintingObservation,
  resolvePrintingEvidence,
} from "./printing-refinement";
import { DEFAULT_PRINTING_DISCRIMINATORS } from "./printing-guidance";

const ref: PrintingCandidate = {
  key: "pokemon:a",
  game: "pokemon",
  name: "Pikachu",
  number: "25",
  printedTotal: "198",
};
const other = { ...ref, key: "pokemon:b", number: "26" };
function observation(rawText = "", index = 1) {
  return parsePrintingObservation({
    jobId: `read-${index}`,
    sessionId: "session",
    eventId: "event",
    frameId: `original-${index}`,
    capturedAt: index * 2000,
    imageFingerprint: `pixels-${index}`,
    game: "pokemon",
    rawText,
  });
}
function unresolved(
  rawText = "",
  candidates = [ref, other],
  index = 1,
): PrintingResolution {
  return resolvePrintingEvidence({
    game: "pokemon",
    sessionId: "session",
    eventId: "event",
    identityName: ref.name,
    candidates,
    catalogCompleteForIdentity: true,
    observations: [observation(rawText, index)],
  });
}
function plan(
  options: {
    resolution?: PrintingResolution;
    candidates?: PrintingCandidate[];
    promptsIssued?: number;
    catalogCompleteForIdentity?: boolean;
  } = {},
) {
  return planPrintingLiteralGuidance({
    game: "pokemon",
    candidates: [ref, other],
    resolution: unresolved(),
    promptsIssued: 0,
    catalogCompleteForIdentity: true,
    ...options,
  });
}
describe("bounded candidate-dependent literal guidance", () => {
  it("asks for the unread collector line only when known catalog values disagree", () => {
    expect(plan()).toMatchObject({
      action: "prompt",
      field: "collectorNumber",
      regionId: "pokemon-footer",
      unmodeledAlternativeRetained: true,
    });
    expect(plan().message).toContain("closer once");
    expect(plan({ candidates: [ref] }).action).toBe("review");
    expect(DEFAULT_PRINTING_DISCRIMINATORS).toEqual([]);
  });
  it("requests a denominator, set code, or language only when that missing field separates compatible candidates", () => {
    for (const [field, patch] of [
      ["printedTotal", { printedTotal: "199" }],
      ["setCode", { setCode: "NEW" }],
      ["locale", { locale: "FR" }],
    ] as const) {
      const a = { ...ref, setCode: "OLD", locale: "EN" };
      const b = { ...a, key: "pokemon:b", ...patch };
      expect(plan({ candidates: [a, b] })).toMatchObject({
        action: "prompt",
        field,
      });
    }
  });
  it("does not interpret missing metadata as an absent marker or a disagreement", () => {
    expect(
      plan({
        candidates: [
          ref,
          {
            ...ref,
            key: "unknown",
            number: undefined,
            printedTotal: undefined,
          },
        ],
      }).action,
    ).toBe("review");
    expect(
      plan({ candidates: [ref, { ...ref, key: "zero", number: "025" }] })
        .action,
    ).toBe("review");
    // A missing row is retained, but two other known values may still justify asking.
    expect(
      plan({
        candidates: [ref, other, { ...ref, key: "unknown", number: undefined }],
      }).action,
    ).toBe("prompt");
  });
  it("stops for unsupported edition, stamp, rarity or finish differences", () => {
    expect(
      plan({
        candidates: [
          ref,
          { ...ref, key: "first", edition: "1ST EDITION", rarity: "holo" },
        ],
      }),
    ).toMatchObject({
      action: "review",
      reason: "no-supported-literal-disagreement",
    });
    expect(
      plan({
        candidates: [ref, { ...ref, key: "first", edition: "1ST EDITION" }],
      }).message,
    ).not.toMatch(/tilt|show the back|glare|blur/i);
  });
  it("retains baseline two-original-capture progress even with one catalog candidate", () => {
    const resolution = unresolved("025/198", [ref]);
    expect(plan({ candidates: [ref], resolution })).toMatchObject({
      action: "wait",
      reason: "another-original-capture-required",
    });
    expect(
      plan({ candidates: [ref], resolution, promptsIssued: 1 }).action,
    ).toBe("wait");
  });
  it("never fixes or explains away contradictory literals or catalog conflicts", () => {
    for (const resolution of [
      unresolved("025/198\n026/198"),
      unresolved("999/999"),
      { ...unresolved(), reasons: ["no-catalog-printing-match"] },
    ]) {
      expect(plan({ resolution }).action).toBe("review");
      expect(plan({ resolution }).message).not.toContain("closer");
    }
  });
  it("stops one no-gain request without turning it into an evidence vote", () => {
    const resolution = unresolved();
    const before = structuredClone(resolution);
    expect(
      plan({
        resolution,
        promptsIssued: PRINTING_LITERAL_GUIDANCE_LIMITS.promptsPerEvent,
      }),
    ).toMatchObject({ action: "review", reason: "prompt-budget-exhausted" });
    expect(resolution).toEqual(before);
    expect(resolution.evidence).toHaveLength(1);
    expect(resolution.state).toBe("unresolved");
  });
  it("does not use repeated crops or pixel metrics as quality or independence proof", () => {
    const resolution = unresolved();
    const changes = [0, 1];
    for (const metric of changes) {
      const modified = structuredClone(resolution);
      modified.evidence[0].regions = [
        {
          regionId: "pokemon-footer",
          registryVersion: "test",
          frameId: "original-1",
          imageFingerprint: "pixels-1",
          x: 0,
          y: 650,
          width: 600,
          height: 190,
          outputWidth: 600,
          outputHeight: 190,
          sourceMinEdge: 600,
          metrics: {
            sampledPixels: 100,
            sharpness: metric,
            contrast: metric,
            highlightClippedFraction: metric,
            shadowClippedFraction: metric,
            transparentFraction: metric,
          },
          qualityReasons: [],
        },
      ];
      expect(plan({ resolution: modified })).toEqual(plan({ resolution }));
    }
  });
  it("uses the existing Yu-Gi-Oh set-code region and never asks for a printed total", () => {
    const candidates: PrintingCandidate[] = [
      { ...ref, game: "yugioh", key: "a", setCode: "LOB-EN025" },
      { ...ref, game: "yugioh", key: "b", setCode: "SDY-EN025" },
    ];
    const resolution = {
      ...unresolved(),
      evidence: [{ ...observation(), game: "yugioh" as const }],
    };
    expect(
      planPrintingLiteralGuidance({
        game: "yugioh",
        candidates,
        resolution,
        promptsIssued: 0,
        catalogCompleteForIdentity: true,
      }),
    ).toMatchObject({
      action: "prompt",
      regionId: "yugioh-set-code",
      field: "setCode",
    });
  });
  it("fails closed for unknown coverage, stale provenance, mixed capture lineage and oversized candidates", () => {
    expect(plan({ catalogCompleteForIdentity: false }).action).toBe("review");
    expect(
      plan({
        candidates: Array.from({ length: 2501 }, (_, index) => ({
          ...ref,
          key: String(index),
        })),
      }).action,
    ).toBe("review");
    const resolution = unresolved();
    resolution.evidence.push({ ...observation(), eventId: "other-event" });
    expect(plan({ resolution }).action).toBe("review");
  });
});
