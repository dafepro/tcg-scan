import { expect, it } from "vitest";
import { printingDiagnosticFields } from "./printing-diagnostics";
import {
  createDiagnosticsStore,
  sanitizeDiagnosticFields,
} from "./diagnostics";
import type { PrintingResolution } from "./printing-refinement";
it("exposes measured region sizes and bounded reasons without OCR/card/capture identifiers", () => {
  const resolution: PrintingResolution = {
    state: "unresolved",
    reasons: ["no-unambiguous-footer-evidence"],
    finish: "unknown",
    condition: "unknown",
    priceEligible: false,
    unconfirmed: ["finish", "condition"],
    evidence: [
      {
        jobId: "private-job",
        sessionId: "private-session",
        eventId: "private-event",
        frameId: "private-frame",
        imageFingerprint: "private-hash",
        rawText: "private literal",
        capturedAt: 1000,
        game: "pokemon",
        fields: {},
        issues: [],
        regions: [
          {
            regionId: "pokemon-footer",
            registryVersion: "printing-regions-v1",
            frameId: "private-frame",
            imageFingerprint: "private-hash",
            x: 0,
            y: 500,
            width: 600,
            height: 160,
            outputWidth: 600,
            outputHeight: 160,
            sourceMinEdge: 620,
            metrics: {
              sampledPixels: 16000,
              sharpness: 0.12,
              contrast: 0.4,
              highlightClippedFraction: 0.15,
              shadowClippedFraction: 0.1,
              transparentFraction: 0,
            },
            qualityReasons: [],
          },
        ],
      },
    ],
  };
  const fields = printingDiagnosticFields(resolution);
  expect(fields.printingRegionWidth).toBe(600);
  expect(fields.printingHighlightPercent).toBe(15);
  expect(fields.printingReason).toBe("no-unambiguous-footer-evidence");
  expect(JSON.stringify(fields)).not.toContain("private");
  const store = createDiagnosticsStore();
  store.record("printing", "scan", fields);
  expect(store.getSnapshot().latest.printing).toEqual(fields);
});
it("rejects arbitrary reason text and never promotes an unknown metric", () => {
  const resolution: PrintingResolution = {
    state: "unresolved",
    reasons: ["private OCR string"],
    finish: "unknown",
    condition: "unknown",
    priceEligible: false,
    unconfirmed: ["finish", "condition"],
    evidence: [],
  };
  expect(printingDiagnosticFields(resolution)).toEqual({
    printingState: "unresolved",
    printingObservations: 0,
    printingRegions: 0,
  });
});

it("preserves meaningful sub-percent ROI diagnostics without changing count rounding", () => {
  expect(
    sanitizeDiagnosticFields({
      printingHighlightPercent: 0.1932,
      printingEdgeEnergyPercent: 0.4157,
      printingRegions: 1.9,
    }),
  ).toEqual({
    printingHighlightPercent: 0.19,
    printingEdgeEnergyPercent: 0.42,
    printingRegions: 1,
  });
});
