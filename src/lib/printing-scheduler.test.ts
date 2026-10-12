import { describe, expect, it, vi } from "vitest";
import { pendingPrintingTracks } from "./printing-scheduler";
import type { TrackStatus } from "./scan-session";

describe("printing crop request scheduling", () => {
  it("retains ready settled targets across visible/deferred/fresh group rotations", () => {
    const ready = vi.fn(() => true);
    for (const visible of [true, false, false, true]) {
      const track = {
        eventId: "saved-card",
        status: "added" as const,
        visible,
      };
      expect(pendingPrintingTracks([track], new Set(), ready)).toEqual([track]);
      expect(track.visible).toBe(visible);
    }
    expect(ready).toHaveBeenCalledTimes(4);
  });
  it("never requests crop evidence for unsaved, undone or failed tracks", () => {
    const statuses: TrackStatus[] = [
      "matching",
      "stabilizing",
      "review",
      "quality",
      "saving",
      "undone",
      "error",
    ];
    const ready = vi.fn(() => true);
    expect(
      pendingPrintingTracks(
        statuses.map((status) => ({ eventId: status, status })),
        new Set(),
        ready,
      ),
    ).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
  });
  it("skips finished and throttled events without starving another ready target", () => {
    const tracks = ["finished", "throttled", "ready"].map((eventId) => ({
      eventId,
      status: "added" as const,
      visible: false,
    }));
    const ready = vi.fn((eventId: string) => eventId !== "throttled");
    expect(pendingPrintingTracks(tracks, new Set(["finished"]), ready)).toEqual(
      [tracks[2]],
    );
    expect(ready.mock.calls.map((call) => call[0])).toEqual([
      "throttled",
      "ready",
    ]);
  });
  it("does not invent a target or mutate the caller's settled tracks", () => {
    const tracks = Object.freeze([
      Object.freeze({
        eventId: "one",
        status: "added" as const,
        visible: false,
      }),
    ]);
    expect(pendingPrintingTracks(tracks, new Set(), () => false)).toEqual([]);
    expect(tracks[0]).toEqual({
      eventId: "one",
      status: "added",
      visible: false,
    });
  });
});
