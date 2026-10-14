import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintingEvidenceDetails } from "./PrintingEvidenceDetails";
import type { PrintingResolution } from "../lib/printing-refinement";
import { parsePrintingObservation } from "../lib/printing-refinement";
import { summarizePrintingEvidence } from "../lib/printing-evidence";

function resolution(): PrintingResolution {
  const observation = parsePrintingObservation({
    game: "pokemon",
    jobId: "job",
    sessionId: "session",
    eventId: "event",
    frameId: "original",
    capturedAt: 1234,
    imageFingerprint: "original-pixel-hash",
    rawText: '<img src="x" onerror="bad()">\n025/198',
    readerVersion: "reader-fixture",
  });
  observation.regions = [
    {
      regionId: "pokemon-footer",
      registryVersion: "regions-fixture",
      frameId: "original",
      imageFingerprint: "original-pixel-hash",
      x: 0,
      y: 655,
      width: 600,
      height: 185,
      outputWidth: 600,
      outputHeight: 185,
      sourceMinEdge: 540,
      metrics: {
        sampledPixels: 100,
        sharpness: 0.1,
        contrast: 0.2,
        highlightClippedFraction: 0.3,
        shadowClippedFraction: 0.4,
        transparentFraction: 0,
      },
      rawText: "025/198",
      qualityReasons: [],
    },
  ];
  return {
    state: "unresolved",
    reasons: ["two-distinct-captures-required"],
    evidence: [observation],
    catalogProvenance: {
      schemaVersion: 1,
      snapshotId: "sha256:" + "a".repeat(64),
      provider: "Fixture catalog",
      scope: "Fixture English printings",
      fetchedAt: "2026-10-13T03:00:00Z",
      stale: false,
      completeWithinScope: true,
      candidateCount: 2,
    },
    finish: "unknown",
    condition: "unknown",
    priceEligible: false,
    unconfirmed: ["finish", "condition"],
  };
}
describe("printing evidence progressive disclosure", () => {
  it("explains unbound Pack recapture and an unchecked catalog in plain language", () => {
    const value = resolution();
    value.reasons = ["same-copy-recapture-not-bound", "catalog-not-queried"];
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, { resolution: value }),
    );
    expect(html).toContain(
      "A later capture has not been linked to this same physical copy.",
    );
    expect(html).toContain(
      "This retained-capture read has not been checked against a printing catalog.",
    );
    expect(html).not.toContain("same-copy-recapture-not-bound");
    expect(html).not.toContain("catalog-not-queried");
  });
  it("keeps a native collapsed details control and shows uncertainty, real literal text and source version", () => {
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, { resolution: resolution() }),
    );
    expect(html).toContain(
      '<details class="printing-evidence-details"><summary>Printing evidence</summary>',
    );
    expect(html).not.toContain(" open=");
    expect(html).toContain("Printing unconfirmed.");
    expect(html).toContain("Fixture English printings");
    expect(html).toContain("sha256:" + "a".repeat(64));
    expect(html).toContain("reader-fixture");
    expect(html).toContain("original-pixel-hash");
    expect(html).toContain("Original capture: original");
    expect(html).toContain("600 × 185");
    expect(html).toContain("540 px");
    expect(html).toContain("do not establish blur, glare, readability");
    expect(html).toContain("Camera requests are not evidence");
  });
  it("distinguishes enlarged reader input from native capture evidence in live and saved disclosures", () => {
    const value = resolution();
    Object.assign(value.evidence[0].regions![0], {
      regionId: "pokemon-lower-right-identifier",
      width: 85,
      height: 26,
      outputWidth: 170,
      outputHeight: 52,
      resampling: "upsampled",
      pageSegmentationMode: 7,
    });
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, {
        resolution: value,
        evidence: summarizePrintingEvidence("event", {
          ...value,
          state: "catalog-printing-read",
        }),
      }),
    );
    expect(html).toContain("85 × 26");
    expect(html).toContain("170 × 52");
    expect(html).toContain("Upsampled reader input (up to 2×)");
    expect(html).toContain(
      "Resampling adds no native detail or independent capture",
    );
    expect(html).toContain("single line (7)");
    expect(html).toContain("540 px");
  });
  it("escapes malicious literal/catalog text rather than rendering HTML or fetching images", () => {
    const value = resolution();
    value.catalogProvenance!.provider = '<script>alert("catalog")</script>';
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, { resolution: value }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<canvas");
  });
  it("separates transient local reads from saved historical evidence", () => {
    const live = resolution();
    const evidence = summarizePrintingEvidence("saved-event", {
      ...live,
      state: "catalog-printing-read",
    });
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, { resolution: live, evidence }),
    );
    expect(html).toContain("Latest local read");
    expect(html).toContain("Saved evidence");
    expect(html).toContain("saved-event");
    expect(html).toContain("literal-printing-v1");
    expect(html).toContain("Historical snapshot; not a current recheck");
    expect(html).not.toMatch(/value:\s*[$€£]/i);
  });
  it("keeps absent legacy metadata explicit and bounds rendered reads/literal text", () => {
    const value = resolution();
    value.catalogProvenance = undefined;
    value.evidence = Array.from({ length: 20 }, (_, index) => ({
      ...value.evidence[0],
      frameId: `capture-${index}`,
      rawText: "X".repeat(3000),
      regions: undefined,
    }));
    const html = renderToStaticMarkup(
      createElement(PrintingEvidenceDetails, {
        resolution: value,
        summary: "Inspect saved identifiers",
      }),
    );
    expect(html).toContain("Inspect saved identifiers");
    expect(html).toContain("legacy or unavailable");
    expect(html).toContain("Native region geometry was not recorded");
    expect(html).not.toContain("capture-0 ·");
    expect(html).toContain("capture-19 ·");
    expect(html).not.toContain("X".repeat(2049));
    expect(
      renderToStaticMarkup(createElement(PrintingEvidenceDetails)),
    ).toContain("No printing evidence recorded");
  });
});
