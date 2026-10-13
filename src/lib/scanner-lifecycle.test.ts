import { describe, expect, it } from "vitest";
import {
  needsSessionEndConfirmation,
  sameScannerLifecycle,
  type ScannerLifecycle,
} from "./scanner-lifecycle";
describe("explicit scanner navigation boundary", () => {
  const state: ScannerLifecycle = {
    phase: "idle",
    sessionId: null,
    savedCount: 0,
  };
  it.each(["preparing", "active", "paused", "draining", "review"] as const)(
    "requires a deliberate end while %s",
    (phase) => {
      expect(needsSessionEndConfirmation({ ...state, phase })).toBe(true);
    },
  );
  it("does not prompt for idle or explicitly ended sessions", () => {
    expect(needsSessionEndConfirmation(null)).toBe(false);
    expect(needsSessionEndConfirmation(state)).toBe(false);
    expect(
      needsSessionEndConfirmation({
        ...state,
        phase: "ended",
        sessionId: "old",
        savedCount: 3,
      }),
    ).toBe(false);
  });
  it("preserves each meaningful state change while coalescing identical reports", () => {
    expect(sameScannerLifecycle(null, state)).toBe(false);
    expect(sameScannerLifecycle(state, { ...state })).toBe(true);
    expect(sameScannerLifecycle(state, { ...state, sessionId: "new" })).toBe(
      false,
    );
    expect(sameScannerLifecycle(state, { ...state, savedCount: 1 })).toBe(
      false,
    );
    expect(sameScannerLifecycle(state, { ...state, phase: "preparing" })).toBe(
      false,
    );
  });
});
