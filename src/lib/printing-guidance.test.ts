import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRINTING_DISCRIMINATORS,
  PRINTING_GUIDANCE_LIMITS,
  planPrintingGuidance,
} from "./printing-guidance";
import type {
  PrintingDiscriminatorRule,
  PrintingGuidanceInput,
  PrintingGuidancePrompt,
  PrintingGuidanceRegion,
  PrintingGuidanceTask,
} from "./printing-guidance";

const now = Date.parse("2026-10-13T12:00:00Z");

const lineage = {
  encounterId: "card-1",
  generation: 3,
  catalogVersion: "catalog-2",
  modelVersion: "reader-test",
};

/** Synthetic policy fixtures: these are not deployed/validated card detectors. */
function rule(): PrintingDiscriminatorRule {
  return {
    id: "footer-test",
    version: "1",
    facet: "printed-identifier",
    source: {
      urls: ["https://example.com/synthetic-policy-fixture"],
      sourceDate: "2026-10-13",
      reviewedBy: "unit-test",
      reviewedAt: "2026-10-13",
    },
    supportedSlice: {
      game: "test",
      templates: ["template"],
      languages: ["en"],
      families: ["family"],
      excludedCandidateIds: [],
      evaluationSlice: "synthetic-fixture-only",
    },
    calibration: {
      version: "fixture-1",
      modelVersion: "reader-test",
      physicalImagesValidated: true,
    },
    region: {
      id: "footer",
      side: "front",
      rect: { x: 0, y: 0.8, width: 1, height: 0.2 },
    },
    observationType: "literal-text",
    expectations: {
      a: { state: "value", value: "001/100" },
      b: { state: "value", value: "001/200" },
    },
    observability: {
      minNativeShortEdge: 40,
      minFocus: 0.8,
      minVisibleFraction: 0.95,
      maxGlareFraction: 0.05,
      maxOcclusionFraction: 0.05,
      allowedAngles: ["front"],
      negative: {
        validated: false,
        minVisibleFraction: 1,
        maxGlareFraction: 0,
        maxOcclusionFraction: 0,
      },
    },
    actions: [
      { kind: "move-closer", cost: "low" },
      { kind: "hold-still", cost: "low" },
      { kind: "move-reflection", cost: "low" },
      { kind: "uncover", cost: "low" },
      { kind: "reframe", cost: "low" },
    ],
  };
}

function region(
  overrides: Partial<PrintingGuidanceRegion> = {},
): PrintingGuidanceRegion {
  return {
    ...lineage,
    captureId: "capture-1",
    sourceCaptureId: "source-1",
    regionId: "footer",
    capturedAt: now - 1_000,
    pixels: "native",
    association: "verified-front",
    originalRect: { x: 0, y: 800, width: 700, height: 200 },
    sourceWidth: 700,
    sourceHeight: 1_000,
    focus: 1,
    visibleFraction: 1,
    glareFraction: 0,
    occlusionFraction: 0,
    angle: "front",
    ...overrides,
  };
}

function input(
  overrides: Partial<PrintingGuidanceInput> = {},
): PrintingGuidanceInput {
  return {
    ...lineage,
    now,
    active: true,
    candidates: ["a", "b"].map((id) => ({
      id,
      game: "test",
      template: "template",
      language: "en",
      family: "family",
    })),
    coverage: "known-complete",
    unconfirmedFacets: ["printed-identifier"],
    candidateSnapshot: { ...lineage },
    rules: [rule()],
    regions: [region()],
    tasks: [],
    promptHistory: [],
    totalPromptsIssued: 0,
    liveAssociation: "unbound",
    ...overrides,
  };
}

function task(
  overrides: Partial<PrintingGuidanceTask> = {},
): PrintingGuidanceTask {
  return {
    ...lineage,
    ruleId: "footer-test",
    ruleVersion: "1",
    sourceCaptureId: "source-1",
    startedAt: now - 1_000,
    state: "pending",
    ...overrides,
  };
}

function prompt(
  overrides: Partial<PrintingGuidancePrompt> = {},
): PrintingGuidancePrompt {
  return {
    ...lineage,
    ruleId: "footer-test",
    ruleVersion: "1",
    action: "hold-still",
    issuedAt: now - 1_000,
    outcome: "no-gain",
    ...overrides,
  };
}

function stampRule() {
  const stamp = rule();
  stamp.observationType = "stamp";
  stamp.expectations = {
    a: { state: "value", value: "stamp-present" },
    b: { state: "absent" },
  };
  stamp.observability.negative.validated = true;
  return stamp;
}

describe("advisory printing guidance", () => {
  it("retains unmodeled physical alternatives even when a provider lookup is complete", () => {
    expect(
      planPrintingGuidance(input({ coverage: "known-complete" })),
    ).toMatchObject({
      action: "read",
      unmodeledAlternativeRetained: true,
    });
  });

  it("does not grant negative permission from a positive-only read with weaker visibility", () => {
    const positive = rule();
    positive.observability.negative.validated = true;
    for (const measurements of [
      { visibleFraction: 0.98 },
      { glareFraction: 0.01 },
      { occlusionFraction: 0.01 },
    ]) {
      expect(
        planPrintingGuidance(
          input({ rules: [positive], regions: [region(measurements)] }),
        ),
      ).toMatchObject({ action: "read", allowNegativeObservation: false });
    }
  });

  it.each(["not-a-date", "2026-02-30", "2026-10-14", "2026-10-13T24:00:00Z"])(
    "rejects invalid or future provenance: %s",
    (date) => {
      for (const field of ["sourceDate", "reviewedAt"] as const) {
        const invalid = rule();
        invalid.source[field] = date;
        expect(planPrintingGuidance(input({ rules: [invalid] })).reason).toBe(
          "unsupported-discriminator",
        );
      }
    },
  );

  it.each([
    "https://reader:secret@example.com/source",
    "https://reader@example.com/source",
    "http://example.com/source",
    "https://",
    "https://example.com/ source",
  ])("rejects unsafe source URLs: %s", (url) => {
    const invalid = rule();
    invalid.source.urls = [url];
    expect(planPrintingGuidance(input({ rules: [invalid] })).reason).toBe(
      "unsupported-discriminator",
    );
  });

  it("accepts canonical UTC provenance timestamps", () => {
    const valid = rule();
    valid.source.reviewedAt = "2026-10-13T10:00:00Z";
    expect(planPrintingGuidance(input({ rules: [valid] })).action).toBe("read");
  });

  it("ships no active discriminator rules and never manufactures a default finish", () => {
    expect(DEFAULT_PRINTING_DISCRIMINATORS).toEqual([]);
    expect(planPrintingGuidance(input({ rules: undefined }))).toMatchObject({
      action: "partial",
      reason: "unsupported-discriminator",
    });
  });

  it("reads an adequate original region before asking for a view", () => {
    expect(planPrintingGuidance(input())).toMatchObject({
      action: "read",
      reason: "existing-region-readable",
      captureId: "capture-1",
      sourceCaptureId: "source-1",
      ruleVersion: "1",
      ...lineage,
      allowNegativeObservation: false,
    });
  });

  it("keeps an older good footer when a newer surface view has glare", () => {
    const newer = region({
      captureId: "newer",
      sourceCaptureId: "newer",
      capturedAt: now - 500,
      glareFraction: 0.8,
    });
    expect(
      planPrintingGuidance(input({ regions: [newer, region()] })).captureId,
    ).toBe("capture-1");
  });

  it("ignores glare outside the relevant region because only region measurements are inputs", () => {
    expect(planPrintingGuidance(input()).action).toBe("read");
  });

  it("does not request a feature shared by every remaining candidate", () => {
    const shared = rule();
    shared.expectations = {
      a: { state: "value", value: "same" },
      b: { state: "value", value: "same" },
    };
    shared.actions = [{ kind: "tilt", cost: "low" }];
    expect(
      planPrintingGuidance(input({ rules: [shared], regions: [] })).action,
    ).toBe("partial");
  });

  it.each([undefined, { state: "missing" } as const])(
    "does not confuse missing metadata (%j) with an absent feature",
    (expectation) => {
      const incomplete = rule();
      incomplete.expectations = {
        a: { state: "value", value: "stamp-present" },
        ...(expectation ? { b: expectation } : {}),
      };
      expect(planPrintingGuidance(input({ rules: [incomplete] })).reason).toBe(
        "unsupported-discriminator",
      );
    },
  );

  it("retains missing metadata candidates and the unmodeled alternative while advising on a known disagreement", () => {
    const initial = input();
    const snapshot = input({
      candidates: [
        ...initial.candidates,
        { ...initial.candidates[0], id: "unknown" },
      ],
      coverage: "known-incomplete",
    });
    const before = structuredClone(snapshot);
    expect(planPrintingGuidance(snapshot)).toMatchObject({
      action: "read",
      unmodeledAlternativeRetained: true,
    });
    expect(snapshot).toEqual(before);
  });

  it("asks to uncover a useful stamp region and cannot admit a negative read through occlusion", () => {
    expect(
      planPrintingGuidance(
        input({
          rules: [stampRule()],
          regions: [region({ occlusionFraction: 0.2 })],
        }),
      ),
    ).toMatchObject({ action: "prompt", viewAction: "uncover" });
  });

  it("allows absence only with validated negative coverage and visibility", () => {
    expect(planPrintingGuidance(input({ rules: [stampRule()] }))).toMatchObject(
      { action: "read", allowNegativeObservation: true },
    );
    expect(
      planPrintingGuidance(
        input({
          rules: [stampRule()],
          regions: [region({ visibleFraction: 0.98 })],
        }),
      ).action,
    ).toBe("prompt");
    const unsupported = stampRule();
    unsupported.observability.negative.validated = false;
    expect(planPrintingGuidance(input({ rules: [unsupported] })).reason).toBe(
      "unsupported-discriminator",
    );
  });

  it.each([
    "calibration",
    "language",
    "template",
    "exception",
    "model",
    "source",
  ])("rejects a rule outside its reviewed support: %s", (kind) => {
    const unsupported = rule();
    if (kind === "calibration")
      unsupported.calibration.physicalImagesValidated = false;
    if (kind === "language") unsupported.supportedSlice.languages = ["ja"];
    if (kind === "template")
      unsupported.supportedSlice.templates = ["different"];
    if (kind === "exception")
      unsupported.supportedSlice.excludedCandidateIds = ["b"];
    if (kind === "model") unsupported.calibration.modelVersion = "old-reader";
    if (kind === "source") unsupported.source.urls = [];
    expect(planPrintingGuidance(input({ rules: [unsupported] })).reason).toBe(
      "unsupported-discriminator",
    );
  });

  it("does not turn a lookup contradiction into a camera prompt or repaired winner", () => {
    expect(
      planPrintingGuidance(input({ literalContradiction: true })),
    ).toMatchObject({ action: "partial", reason: "candidate-contradiction" });
  });

  it.each(["encounterId", "generation", "catalogVersion"] as const)(
    "rejects a stale candidate snapshot: %s",
    (field) => {
      const snapshot = input();
      snapshot.candidateSnapshot = {
        ...snapshot.candidateSnapshot,
        [field]: field === "generation" ? 2 : "old",
      };
      expect(planPrintingGuidance(snapshot).reason).toBe("stale-candidates");
    },
  );

  it("keeps unsupported catalog coverage explicit", () => {
    expect(planPrintingGuidance(input({ coverage: "unknown" }))).toMatchObject({
      action: "partial",
      reason: "unknown-coverage",
      unmodeledAlternativeRetained: true,
    });
  });

  it("waits for an equivalent read only inside its watchdog", () => {
    expect(planPrintingGuidance(input({ tasks: [task()] })).reason).toBe(
      "equivalent-read-pending",
    );
    expect(
      planPrintingGuidance(
        input({ tasks: [task({ startedAt: now - 9_000 })] }),
      ),
    ).toMatchObject({ action: "partial", reason: "read-timeout" });
  });

  it("ignores pending work from an invalidated generation", () => {
    expect(
      planPrintingGuidance(input({ tasks: [task({ generation: 2 })] })).action,
    ).toBe("read");
    expect(
      planPrintingGuidance(input({ active: false, tasks: [task()] })).reason,
    ).toBe("inactive");
  });

  it("does not reread resizes or crops of an already-consumed observation lineage", () => {
    expect(
      planPrintingGuidance(
        input({
          regions: [region({ captureId: "resize", pixels: "resampled" })],
          tasks: [task({ state: "unreadable" })],
        }),
      ).action,
    ).toBe("partial");
  });

  it("does not treat generated detail as native evidence", () => {
    expect(
      planPrintingGuidance(
        input({ regions: [region({ pixels: "generated" })] }),
      ).action,
    ).not.toBe("read");
    expect(
      planPrintingGuidance(
        input({
          regions: [
            region({
              pixels: "resampled",
              originalRect: { x: 0, y: 800, width: 120, height: 20 },
            }),
          ],
        }),
      ),
    ).toMatchObject({ action: "prompt", viewAction: "move-closer" });
  });

  it("does not advise moving closer when focus has already deteriorated", () => {
    expect(
      planPrintingGuidance(
        input({
          regions: [
            region({
              focus: 0.1,
              originalRect: { x: 0, y: 800, width: 120, height: 20 },
            }),
          ],
        }),
      ),
    ).toMatchObject({ action: "prompt", viewAction: "hold-still" });
  });

  it("waits once for a useful prompt and retires a hung pending prompt", () => {
    const blurry = input({
      regions: [region({ focus: 0.1 })],
      promptHistory: [prompt({ outcome: "pending" })],
      totalPromptsIssued: 1,
    });
    expect(planPrintingGuidance(blurry).reason).toBe("prompt-pending");
    blurry.now = now + 10_000;
    expect(planPrintingGuidance(blurry).action).toBe("partial");
  });

  it.each(["improved", "irrelevant"] as const)(
    "retires a %s prompt without confirming a variant",
    (outcome) => {
      const result = planPrintingGuidance(
        input({
          regions: [region({ focus: 0.1 })],
          promptHistory: [prompt({ outcome })],
          totalPromptsIssued: 1,
        }),
      );
      expect(result.action).toBe("partial");
      expect(result).not.toHaveProperty("resolvedCandidate");
    },
  );

  it("retires a prompt after its feature stops separating the remaining candidates", () => {
    const candidate = input().candidates[0];
    expect(
      planPrintingGuidance(
        input({
          candidates: [candidate],
          promptHistory: [prompt({ outcome: "pending" })],
          totalPromptsIssued: 1,
        }),
      ).reason,
    ).toBe("no-candidate-disagreement");
  });

  it("stops after repeated unchanged blurry observations instead of inventing certainty", () => {
    expect(
      planPrintingGuidance(
        input({
          regions: [region({ focus: 0.1 })],
          promptHistory: [prompt(), prompt({ issuedAt: now - 500 })],
          totalPromptsIssued: 2,
        }),
      ).action,
    ).toBe("partial");
  });

  it("changes action when repeated no-gain leaves another useful request", () => {
    expect(
      planPrintingGuidance(
        input({
          regions: [region({ focus: 0.1, occlusionFraction: 0.5 })],
          promptHistory: [prompt(), prompt({ issuedAt: now - 500 })],
          totalPromptsIssued: 2,
        }),
      ),
    ).toMatchObject({ action: "prompt", viewAction: "uncover" });
  });

  it("retains the encounter prompt budget when recent history is evicted", () => {
    expect(
      planPrintingGuidance(
        input({ regions: [region({ focus: 0.1 })], totalPromptsIssued: 4 }),
      ),
    ).toMatchObject({ action: "partial", reason: "prompt-budget-exhausted" });
    // The cap limits prompts, not a later useful native read.
    expect(planPrintingGuidance(input({ totalPromptsIssued: 4 })).action).toBe(
      "read",
    );
  });

  it("does not tilt for a text feature even if a malformed action list proposes it", () => {
    const text = rule();
    text.actions = [{ kind: "tilt", cost: "low" }];
    expect(
      planPrintingGuidance(
        input({ rules: [text], regions: [region({ angle: "side" })] }),
      ).action,
    ).toBe("partial");
  });

  it("requires a scoped material reader and rejects sleeve-only or clipped evidence", () => {
    const material = rule();
    material.observationType = "temporal-material";
    material.actions = [{ kind: "tilt", cost: "medium" }];
    const sleeve = region({
      material: {
        distinctViews: 3,
        validatedMotion: true,
        sleeveGlareExcluded: false,
      },
    });
    expect(
      planPrintingGuidance(input({ rules: [material], regions: [sleeve] }))
        .action,
    ).not.toBe("read");
    expect(
      planPrintingGuidance(
        input({
          rules: [material],
          regions: [
            region({
              material: {
                distinctViews: 3,
                validatedMotion: true,
                sleeveGlareExcluded: true,
              },
            }),
          ],
        }),
      ).action,
    ).toBe("read");
    expect(
      planPrintingGuidance(
        input({
          rules: [material],
          regions: [
            region({
              visibleFraction: 0.5,
              material: {
                distinctViews: 3,
                validatedMotion: true,
                sleeveGlareExcluded: true,
              },
            }),
          ],
        }),
      ).action,
    ).toBe("partial");
  });

  it("never asks for the back without same-object association", () => {
    const back = rule();
    back.region.side = "back";
    back.observationType = "back-design";
    back.actions = [{ kind: "show-back", cost: "high" }];
    expect(
      planPrintingGuidance(input({ rules: [back], regions: [] })).reason,
    ).toBe("association-required");
    expect(
      planPrintingGuidance(
        input({ rules: [back], regions: [], liveAssociation: "continuous" }),
      ),
    ).toMatchObject({ action: "prompt", viewAction: "show-back" });
    expect(
      planPrintingGuidance(
        input({ rules: [back], regions: [region({ association: "unbound" })] }),
      ).action,
    ).toBe("partial");
    expect(
      planPrintingGuidance(
        input({
          rules: [back],
          regions: [region({ association: "verified-front" })],
        }),
      ).action,
    ).toBe("partial");
    expect(
      planPrintingGuidance(
        input({
          rules: [back],
          regions: [region({ association: "user-confirmed" })],
        }),
      ).action,
    ).toBe("read");
  });

  it("does not bind a new capture to an exited encounter by Promise timing", () => {
    expect(
      planPrintingGuidance(
        input({ regions: [region({ encounterId: "next-card" })] }),
      ).action,
    ).not.toBe("read");
    expect(
      planPrintingGuidance(input({ regions: [region({ generation: 2 })] }))
        .action,
    ).not.toBe("read");
  });

  it.each([
    "candidates",
    "rules",
    "regions",
    "tasks",
    "promptHistory",
  ] as const)(
    "fails closed on oversized %s without dropping ambiguity",
    (field) => {
      const snapshot = input();
      const exemplar = {
        candidates: snapshot.candidates[0],
        rules: rule(),
        regions: region(),
        tasks: task(),
        promptHistory: prompt(),
      }[field];
      const oversized = {
        ...snapshot,
        [field]: Array.from(
          { length: PRINTING_GUIDANCE_LIMITS[field] + 1 },
          () => exemplar,
        ),
      };
      expect(planPrintingGuidance(oversized).reason).toBe("invalid-input");
    },
  );

  it("keeps price outside the recognition/planning input contract", () => {
    const priceFree: PrintingGuidanceInput = {
      ...input(),
      // @ts-expect-error Prices cannot be supplied through the guidance API.
      price: 100_000,
    };
    // Extra runtime fields have no influence on the planner.
    expect(planPrintingGuidance(priceFree)).toEqual(
      planPrintingGuidance(input()),
    );
  });
});
