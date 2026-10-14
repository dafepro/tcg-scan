import { describe, expect, it, vi } from "vitest";
import {
  pendingPrintingTracks,
  preferPrintingView,
  printingViewChanged,
  printingViewSettled,
  rememberPrintingView,
  samplePrintingView,
} from "./printing-scheduler";
import type {
  PrintingViewSample,
  RecentPrintingView,
} from "./printing-scheduler";
import type { TrackStatus } from "./scan-session";

describe("printing crop request scheduling", () => {
  it("prioritizes the requested view and rotates equally pending targets by read count", () => {
    const tracks = ["read-twice", "fresh", "prompted"].map((eventId) => ({
      eventId,
      status: "added" as const,
    }));
    const priorities: Record<string, number> = {
      "read-twice": -2,
      fresh: 0,
      prompted: 99,
    };
    expect(
      pendingPrintingTracks(
        tracks,
        new Set(),
        () => true,
        (id) => priorities[id],
      ).map((track) => track.eventId),
    ).toEqual(["prompted", "fresh", "read-twice"]);
    expect(tracks.map((track) => track.eventId)).toEqual([
      "read-twice",
      "fresh",
      "prompted",
    ]);
  });
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

describe("answer-independent printing view samples", () => {
  it("requires a full settled window and rejects slow cumulative drift", () => {
    const view = (value: number): PrintingViewSample => ({
      pixels: new Uint8Array(1152).fill(value),
      sourceMinEdge: 600,
      texture: 0,
      repeatKey: String(value),
    });
    let history: RecentPrintingView[] = [];
    for (const [i, value] of [0, 5, 10, 15].entries()) {
      history = rememberPrintingView(history, {
        frameId: `frame-${i}`,
        capturedAt: i * 200,
        view: view(value),
      });
      expect(printingViewSettled(history)).toBe(false);
    }
    for (let i = 4; i <= 7; i++)
      history = rememberPrintingView(history, {
        frameId: `frame-${i}`,
        capturedAt: i * 200,
        view: view(20),
      });
    expect(printingViewSettled(history)).toBe(true);
    for (let i = 8; i < 30; i++)
      history = rememberPrintingView(history, {
        frameId: `frame-${i}`,
        capturedAt: i * 200,
        view: view(20),
      });
    expect(history).toHaveLength(8);
    let tilting: RecentPrintingView[] = [];
    for (let i = 0; i < 4; i++)
      tilting = rememberPrintingView(tilting, {
        frameId: `tilt-${i}`,
        capturedAt: i * 200,
        view: { ...view(20), sourceMinEdge: 600 + i * 20 },
      });
    expect(printingViewSettled(tilting)).toBe(false);
  });
  it("does not turn a retained original or a source gap into settled-view history", () => {
    const view: PrintingViewSample = {
      pixels: new Uint8Array(1152),
      sourceMinEdge: 600,
      texture: 0,
      repeatKey: "same",
    };
    const first = { frameId: "one", capturedAt: 2000, view };
    let history = rememberPrintingView([], first);
    history = rememberPrintingView(history, { ...first, capturedAt: 2600 });
    expect(history).toHaveLength(1);
    expect(printingViewSettled(history)).toBe(false);
    history = rememberPrintingView(history, {
      frameId: "next",
      capturedAt: 2200,
      view,
    });
    history = rememberPrintingView(history, { ...first, capturedAt: 2800 });
    expect(history).toHaveLength(2);
    expect(printingViewSettled(history)).toBe(false);
    history = rememberPrintingView(history, {
      frameId: "two",
      capturedAt: 4000,
      view,
    });
    expect(history).toHaveLength(1);
    expect(printingViewSettled(history)).toBe(false);
  });
  it("does not spend a changed-view read on translated footer text while the identifier stays covered", () => {
    const width = 600,
      height = 840;
    const image = (shift: number, covered = true) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const sx = x - shift;
          const ink = y >= 650 && sx >= 0 && sx % 17 < 2 && y % 13 < 9;
          const value = covered && sx >= 495 && y >= 790 ? 175 : ink ? 20 : 235;
          const offset = (y * width + x) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = value;
          data[offset + 3] = 255;
        }
      return { width, height, data };
    };
    const initial = samplePrintingView(image(0), "pokemon", 600)!;
    expect(
      printingViewChanged(
        initial,
        samplePrintingView(image(1), "pokemon", 600)!,
      ),
    ).toBe(false);
    expect(
      printingViewChanged(
        initial,
        samplePrintingView(image(0, false), "pokemon", 600)!,
      ),
    ).toBe(true);
  });
  const pixels = (value: number) => {
    const data = new Uint8ClampedArray(100 * 140 * 4).fill(value);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width: 100, height: 140, data };
  };
  it("bounds samples, ignores tiny uniform noise, and admits changed footer pixels or native detail", () => {
    const original = samplePrintingView(pixels(128), "pokemon", 600)!;
    expect(original.pixels.length).toBe(2 * 48 * 12);
    expect(
      printingViewChanged(
        original,
        samplePrintingView(pixels(129), "pokemon", 600)!,
      ),
    ).toBe(false);
    expect(
      printingViewChanged(
        original,
        samplePrintingView(pixels(145), "pokemon", 600)!,
      ),
    ).toBe(true);
    expect(
      printingViewChanged(
        original,
        samplePrintingView(pixels(128), "pokemon", 648)!,
      ),
    ).toBe(true);
  });
  it("does not treat unrelated artwork changes as a changed identifier region", () => {
    const before = pixels(128),
      after = pixels(128);
    after.data.fill(245, 0, 70 * 100 * 4);
    expect(
      printingViewChanged(
        samplePrintingView(before, "pokemon", 600)!,
        samplePrintingView(after, "pokemon", 600)!,
      ),
    ).toBe(false);
  });
  it("keeps materially greater native detail, otherwise prefers a current comparable view", () => {
    const old = samplePrintingView(pixels(128), "pokemon", 800)!;
    expect(
      preferPrintingView(old, samplePrintingView(pixels(145), "pokemon", 600)!),
    ).toBe(false);
    expect(
      preferPrintingView(old, samplePrintingView(pixels(145), "pokemon", 800)!),
    ).toBe(true);
  });
  it("rejects incomplete pixels rather than making a scheduling sample", () => {
    expect(
      samplePrintingView(
        { width: 100, height: 140, data: new Uint8ClampedArray(0) },
        "pokemon",
        600,
      ),
    ).toBeUndefined();
  });
  it("uses the same repeat hint for identical RGBA bytes at different buffer offsets", () => {
    const original = pixels(128);
    const data = new Uint8ClampedArray(
      new ArrayBuffer(original.data.length + 1),
      1,
      original.data.length,
    );
    data.set(original.data);
    expect(
      samplePrintingView({ ...original, data }, "pokemon", 600)?.repeatKey,
    ).toBe(samplePrintingView(original, "pokemon", 600)?.repeatKey);
  });
});
