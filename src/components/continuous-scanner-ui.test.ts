import { describe, expect, it } from "vitest";
import type { ScanTrack } from "../lib/scan-session";
import {
  cameraFailureMessage,
  printingPromptStatus,
  scannerTrackPresentation,
} from "./continuous-scanner-ui";

const track = (
  autoEligible: boolean,
): Pick<ScanTrack, "status" | "reference" | "evidence" | "message"> => ({
  status: "matching",
  reference: {
    key: "pokemon:candidate",
    game: "pokemon",
    name: "Unverified candidate",
  },
  evidence: { autoEligible } as ScanTrack["evidence"],
  message: "Not enough matching detail",
});

describe("scanner presentation", () => {
  it("keeps the printing request visible through reading without asserting a resolved printing", () => {
    const prompt = {
      eventId: "saved",
      name: "Pikachu",
      message: "Show the bottom identifier line closer once.",
    };
    const tracks = [
      { eventId: "saved", visible: true, status: "added" as const },
    ];
    for (const reading of [false, true]) {
      const status = printingPromptStatus(prompt, tracks, true, reading);
      expect(status).toContain(prompt.message);
      expect(status).toMatch(/printing unconfirmed/i);
      expect(status).toContain("all four card edges");
    }
    expect(printingPromptStatus(prompt, tracks, true, true)).toContain(
      "Checking this view",
    );
  });
  it("does not show an old printing request for paused, hidden, undone or unrelated tracks", () => {
    const prompt = {
      eventId: "saved",
      name: "Pikachu",
      message: "Show the identifier line.",
    };
    expect(
      printingPromptStatus(
        prompt,
        [{ eventId: "saved", visible: true, status: "added" }],
        false,
        false,
      ),
    ).toBeUndefined();
    for (const current of [
      { eventId: "saved", visible: false, status: "added" as const },
      { eventId: "saved", visible: true, status: "undone" as const },
      { eventId: "another", visible: true, status: "added" as const },
    ])
      expect(
        printingPromptStatus(prompt, [current], true, false),
      ).toBeUndefined();
  });
  it("never names a rejected still-photo candidate or leaves it Matching", () => {
    const input = track(false);
    expect(scannerTrackPresentation(input, true, true)).toEqual({
      name: "Unmatched region",
      label: "Not identified",
      message: "Not enough matching detail",
    });
    expect(input.reference?.name).toBe("Unverified candidate");
    expect(input.status).toBe("matching");
  });
  it("names eligible photo identities and distinguishes their durable save", () => {
    const input = { ...track(true), status: "review" as const };
    expect(scannerTrackPresentation(input, true, true).label).toBe(
      "Ready to save",
    );
    expect(scannerTrackPresentation(input, true, true).name).toBe(
      "Unverified candidate",
    );
    expect(
      scannerTrackPresentation({ ...input, status: "added" }, true, true).label,
    ).toBe("Added");
  });
  it("does not promise a review queue with live auto-save off", () => {
    const result = scannerTrackPresentation(
      { ...track(true), status: "review" },
      false,
      false,
    );
    expect(result.label).toBe("Preview only");
    expect(result.message).toContain("nothing is queued");
  });
});

describe("recoverable camera failures", () => {
  it.each([
    ["NotAllowedError", "permission was denied"],
    ["NotFoundError", "No camera was found"],
    ["NotReadableError", "busy or unavailable"],
    ["OverconstrainedError", "requested video"],
    ["AbortError", "interrupted"],
  ])("explains %s and keeps photo recovery available", (name, explanation) => {
    const error = new Error("browser-specific wording");
    error.name = name;
    expect(cameraFailureMessage(error)).toContain(explanation);
    expect(cameraFailureMessage(error)).toContain("photo");
  });
  it("preserves useful unsupported-browser or model detail", () => {
    expect(cameraFailureMessage(new Error("Camera needs HTTPS."))).toBe(
      "Camera needs HTTPS.",
    );
  });
});
