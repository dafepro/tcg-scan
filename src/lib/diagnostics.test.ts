import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsStore,
  MAX_DIAGNOSTIC_EVENTS,
  sanitizeDiagnosticFields,
} from "./diagnostics";

describe("local bounded structured diagnostics", () => {
  it("allows known observations and no free-text payloads", () => {
    const fields = sanitizeDiagnosticFields({
      status: "running",
      active: true,
      game: "pokemon",
      width: 1920,
      totalMs: 123.456,
      photo: "data:image/jpeg;base64,private",
      cardName: "private card",
      url: "https://secret.invalid",
      token: "private token",
      message: "raw private error",
      reason: "https://secret.invalid",
      nested: { password: "private" },
    });
    expect(fields).toEqual({
      status: "running",
      game: "pokemon",
      active: true,
      width: 1920,
      totalMs: 123.46,
    });
    expect(JSON.stringify(fields)).not.toContain("private");
  });
  it("clears an obsolete failure reason after recovery without rewriting history", () => {
    const store = createDiagnosticsStore();
    store.record("pack", "error", {
      status: "failed",
      reason: "save-failed",
      saved: 1,
    });
    store.update("pack", { saved: 2 });
    expect(store.getSnapshot().latest.pack?.reason).toBe("save-failed");
    store.update("pack", { status: "running", saved: 2 });
    expect(store.getSnapshot().latest.pack?.reason).toBeUndefined();
    expect(store.getSnapshot().events[0].fields.reason).toBe("save-failed");
    store.record("pack", "warning", {
      status: "blocked",
      reason: "storage-blocked",
    });
    store.update("pack", { status: "blocked", saved: 2 });
    expect(store.getSnapshot().latest.pack?.reason).toBe("storage-blocked");
  });
  it("keeps captured, skipped, dropped, processed and retries distinct", () => {
    expect(
      sanitizeDiagnosticFields({
        captured: 8,
        skipped: 3,
        dropped: 2,
        processed: 5,
        retries: 1,
      }),
    ).toEqual({
      captured: 8,
      skipped: 3,
      dropped: 2,
      processed: 5,
      retries: 1,
    });
  });
  it("keeps reservoir events separate from visual and capacity loss", () => {
    const counts = {
      captured: 20,
      skipped: 2,
      admitted: 8,
      backpressureDeferred: 12,
      backpressureRejected: 3,
      reservoirReplaced: 5,
      reservoirPromoted: 4,
      reservoirViews: 1,
      queueRejected: 1,
      reservoirCancelled: 0,
      dropped: 1,
      adaptivePendingLimit: 2,
      workerServiceMs: 250.1,
    };
    expect(sanitizeDiagnosticFields(counts)).toEqual(counts);
  });
  it("records bounded snapshot preparation separately from frame inference", () => {
    expect(
      sanitizeDiagnosticFields({
        presentationSnapshots: 12,
        presentationMs: 2.3456,
        presentationMaxMs: 0.9876,
        totalMs: 250,
        renderMs: 1,
      }),
    ).toEqual({
      presentationSnapshots: 12,
      presentationMs: 2.35,
      presentationMaxMs: 0.99,
      totalMs: 250,
    });
    expect(
      sanitizeDiagnosticFields({
        presentationMs: Infinity,
        presentationMaxMs: -1,
      }),
    ).toEqual({});
  });
  it("rejects invalid, unbounded, and non-finite observations", () => {
    expect(
      sanitizeDiagnosticFields({
        totalMs: Infinity,
        detectionMs: NaN,
        extractionMs: -1,
        matchingMs: 3600001,
        active: "true",
        references: 1e10,
        width: 16385,
        progress: 1.01,
        mode: "custom",
        status: "x".repeat(10000),
      }),
    ).toEqual({});
    expect(
      sanitizeDiagnosticFields({
        saved: 1e9,
        bytes: 2 ** 40,
        width: 16384,
        progress: 1,
        paused: false,
        unknown: 0,
        tracks: 3.9,
      }),
    ).toEqual({
      paused: false,
      tracks: 3,
      unknown: 0,
      saved: 1e9,
      width: 16384,
      bytes: 2 ** 40,
      progress: 1,
    });
  });
  it.each([null, undefined, 1, "text", ["secret"]])(
    "ignores unsupported field containers",
    (input) => {
      expect(sanitizeDiagnosticFields(input)).toEqual({});
    },
  );
  it("never invokes user-supplied accessors or copies prototypes", () => {
    const source = Object.create({ status: "running" });
    Object.defineProperty(source, "references", {
      get() {
        throw new Error("must not run");
      },
    });
    source.active = true;
    expect(sanitizeDiagnosticFields(source)).toEqual({ active: true });
    expect(
      sanitizeDiagnosticFields(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("blocked");
            },
          },
        ),
      ),
    ).toEqual({});
  });
  it("prunes old events at 128 and keeps ordered immutable snapshots", () => {
    let time = 0;
    const store = createDiagnosticsStore({ now: () => (time += 1001) });
    for (let count = 0; count < 200; count++)
      store.record("live", "scan", { tracks: count });
    const snapshot = store.getSnapshot();
    expect(snapshot.events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(snapshot.events[0].id).toBe(73);
    expect(snapshot.events.at(-1)?.id).toBe(200);
    expect(snapshot.latest.live).toEqual({ tracks: 199 });
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.events[0].fields)).toBe(true);
    expect(store.getSnapshot()).toBe(snapshot);
  });
  it("publishes measured snapshots without inventing defaults", () => {
    const store = createDiagnosticsStore();
    expect(store.getSnapshot()).toEqual({ events: [], latest: {} });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update("vision", { totalMs: 80, references: 42 });
    const snapshot = store.getSnapshot();
    store.update("vision", { totalMs: 80 });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    store.update("live", { active: false });
    expect(store.getSnapshot().latest).toEqual({
      vision: { references: 42, totalMs: 80 },
      live: { active: false },
    });
    expect(store.getSnapshot().events).toEqual([]);
    unsubscribe();
    store.update("vision", { totalMs: 100 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("rate limits high-frequency frame events but still updates their latest observations", () => {
    let now = 0;
    const store = createDiagnosticsStore({ now: () => now });
    expect(store.record("live", "scan", { tracks: 1 })).toBe(true);
    now = 100;
    expect(store.record("live", "scan", { tracks: 2 })).toBe(false);
    expect(store.getSnapshot().events).toHaveLength(1);
    expect(store.getSnapshot().latest.live?.tracks).toBe(2);
    now = 250;
    expect(store.record("live", "scan", { tracks: 3 })).toBe(true);
  });
  it("deduplicates identical chatter without suppressing distinct save outcomes", () => {
    let now = 0;
    const store = createDiagnosticsStore({ now: () => now });
    expect(
      store.record("storage", "error", { reason: "storage-blocked" }),
    ).toBe(true);
    now = 900;
    expect(
      store.record("storage", "error", { reason: "storage-blocked" }),
    ).toBe(false);
    now = 1000;
    expect(
      store.record("storage", "error", { reason: "storage-blocked" }),
    ).toBe(true);
    expect(store.record("live", "save", { saved: 1 })).toBe(true);
    expect(store.record("live", "save", { saved: 2 })).toBe(true);
  });
  it("clears only the event buffer, retains current observations, and resets dedupe", () => {
    const store = createDiagnosticsStore({ now: () => 0 });
    store.record("live", "ready", { active: false });
    const previous = store.getSnapshot();
    store.clear();
    expect(store.getSnapshot()).toEqual({
      events: [],
      latest: { live: { active: false } },
    });
    expect(previous.events).toHaveLength(1);
    expect(store.record("live", "ready", { active: false })).toBe(true);
    store.reset("live");
    expect(store.getSnapshot().latest).toEqual({});
    expect(store.getSnapshot().events).toHaveLength(1);
  });
  it("drops invalid sources and events instead of retaining arbitrary text", () => {
    const store = createDiagnosticsStore();
    expect(store.record("private card" as never, "error", {})).toBe(false);
    expect(store.record("app", "https://secret.invalid" as never, {})).toBe(
      false,
    );
    store.update("private card" as never, {});
    expect(store.getSnapshot()).toEqual({ events: [], latest: {} });
  });
  it("handles clocks moving backward and sanitizes invalid time", () => {
    let now = 10;
    const store = createDiagnosticsStore({ now: () => now });
    expect(store.record("live", "ready")).toBe(true);
    now = 0;
    expect(store.record("live", "ready")).toBe(true);
    now = Infinity;
    store.record("app", "mount");
    expect(store.getSnapshot().events.at(-1)?.timestamp).toBe(0);
  });
});
