import { afterEach, describe, expect, it, vi } from "vitest";
import { PackCaptureQueue, PackCaptureLoop } from "./pack-capture";
import type { CapturedPixels } from "./frame-capture";
import { PackSession } from "./pack-session";
import { createPackTrace, PackTrace } from "./pack-trace";
import type { VisionResult, VisionOptions } from "./vision";
function capture(frame: number): CapturedPixels {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  // Deterministic changing detailed samples, not fixture card evidence.
  for (let i = 0; i < data.length; i++)
    data[i] = (i * (frame * 13 + 7) + frame * 37) % 256;
  return {
    image: { width: 64, height: 64, data },
    transport: "videoframe-pool",
    capturedAt: frame * 120,
    sourceFrame: {
      mediaTime: 19 + frame * 0.12,
      presentedFrames: frame,
      presentationTime: frame * 120,
      callbackAt: frame * 120,
    },
  };
}
function result(name = "PRIVATE-CARD-NAME"): VisionResult {
  return {
    width: 64,
    height: 64,
    detections: [
      {
        quad: [
          { x: 5, y: 5 },
          { x: 50, y: 5 },
          { x: 50, y: 60 },
          { x: 5, y: 60 },
        ],
        state: "verified",
        reason: "PRIVATE-OCR-TEXT https://secret.invalid/",
        autoEligible: true,
        quality: {
          laplacianVariance: 200,
          contrast: 80,
          meanLuminance: 120,
          saturatedFraction: 0,
          sourceMinEdge: 240,
          featureCount: 100,
          issues: [],
        },
        candidates: [
          {
            key: name,
            reference: {
              key: name,
              game: "pokemon",
              name,
              identityKey: name,
              imageUrl: "https://secret.invalid/image",
              sourceUrl: "https://secret.invalid/provider",
            },
            hashDistance: 0,
            tentativeMatches: 60,
            inliers: 50,
            inlierRatio: 0.9,
            interiorInliers: 20,
            coverage: 0.7,
            medianReprojectionError: 0.5,
            cornerError: 0.01,
            geometricallyVerified: true,
          },
        ],
      },
    ],
    timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 },
    coverage: {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: [],
    },
    budgetExhausted: false,
    detectionComplete: true,
  };
}
function harness(trace?: PackTrace) {
  let now = 1000;
  const queue = new PackCaptureQueue(
    "PRIVATE-SESSION",
    "PRIVATE-URL",
    undefined,
    trace,
  );
  const session = new PackSession("PRIVATE-SESSION", () => now, trace);
  return {
    queue,
    session,
    process(frame: number, outcome = result(), autoSave = true) {
      const admission = queue.offer(capture(frame), frame * 120 + 1);
      if (!admission.accepted) throw new Error("Expected admitted fixture");
      session.queue(admission.view);
      const lease = queue.claim(frame * 120 + 2)!;
      session.identifying(lease.view.captureId, lease.startedAt);
      now = frame * 120 + 60;
      queue.recordProcessed(lease, now);
      const intents = session.consume(
        lease.view.captureId,
        outcome,
        now,
        autoSave,
      );
      queue.finish(lease);
      return intents;
    },
    clock(at: number) {
      now = at;
    },
  };
}

describe("Pack trace production lifecycle hooks", () => {
  it("preserves disabled admission IDs, counts, model options and receipts", () => {
    const off = harness(),
      trace = new PackTrace(),
      on = harness(trace);
    for (let frame = 1; frame <= 8; frame++) {
      const a = off.process(frame, result(frame % 2 ? "A" : "B"));
      const b = on.process(frame, result(frame % 2 ? "A" : "B"));
      expect(b).toEqual(a);
      for (const intent of a) off.session.acknowledge(intent.eventId);
      for (const intent of b) on.session.acknowledge(intent.eventId);
    }
    expect(on.queue.stats).toEqual(off.queue.stats);
    expect(
      on.session.snapshot().map(({ traceViewId: diagnostic, ...receipt }) => {
        void diagnostic;
        return receipt;
      }),
    ).toEqual(off.session.snapshot());
    expect(
      off.session.snapshot().every((receipt) => !("traceViewId" in receipt)),
    ).toBe(true);
  });
  it("keeps actual media time and independent view IDs for replaced reservoir views", () => {
    const trace = new PackTrace(),
      queue = new PackCaptureQueue("pack", "source", undefined, trace);
    for (let frame = 1; frame <= 9; frame++)
      queue.offer(capture(frame), frame * 120 + 1);
    expect(queue.stats.reservoirReplaced).toBeGreaterThan(0);
    const before = trace.snapshot();
    expect(before.records.map((r) => r.sourceMediaSeconds)).toEqual(
      Array.from({ length: 9 }, (_, i) => 19 + (i + 1) * 0.12),
    );
    for (const r of before.records.filter(
      (r) => r.schedule === "reservoir-replaced",
    )) {
      expect(r.receiptFrame).toBeNull();
      expect(r.processedMs).toBeNull();
      expect(r.deferredMs).not.toBeNull();
      expect(r.endedMs).not.toBeNull();
    }
    const lease = queue.claim(1200)!;
    queue.recordProcessed(lease, 1300);
    queue.finish(lease);
    const promoted = queue.promote(1400);
    expect(promoted.length).toBeGreaterThan(0);
    const record = trace
      .snapshot()
      .records.find((r) => r.id === promoted[0].traceViewId)!;
    expect(record.deferredMs).not.toBeNull();
    expect(record.admittedMs).toBe(1280);
    expect(promoted.some((view) => view.traceViewId !== view.frameId)).toBe(
      true,
    );
    queue.cancel(1500);
    expect(
      trace.snapshot().records.filter((r) => r.schedule === "cancelled").length,
    ).toBeGreaterThan(0);
  });
  it("distinguishes rejected, accepted duplicate, preview-only, durable failure/retry/Undo and explicit copies", () => {
    const trace = new PackTrace(),
      h = harness(trace);
    const reject = result();
    reject.detections[0].autoEligible = false;
    reject.detections[0].state = "ambiguous";
    expect(h.process(1, reject)).toEqual([]);
    const [intent] = h.process(2);
    h.session.acknowledge(intent.eventId, "PRIVATE-STORAGE-ERROR");
    expect(trace.snapshot().records[1].save).toBe("failed");
    expect(h.session.retry(intent.eventId)).toEqual(intent);
    h.session.acknowledge(intent.eventId);
    expect(h.process(3)).toEqual([]);
    h.clock(600);
    const copy = h.session.confirmAnotherCopy(intent.receiptId, "copy-1")!;
    h.session.acknowledge(copy.eventId);
    h.session.undo(copy.eventId);
    h.session.undo(intent.eventId);
    h.process(4, result("OTHER-PRIVATE"), false);
    const records = trace.snapshot().records;
    expect(records[0]).toMatchObject({
      matcher: "rejected",
      reason: "ambiguous-identity",
      save: "none",
    });
    expect(records[1]).toMatchObject({
      matcher: "accepted",
      save: "undone",
      eventView: 2,
      saveAttempts: 2,
    });
    expect(records[2]).toMatchObject({
      matcher: "accepted",
      save: "duplicate",
      eventView: 2,
    });
    expect(records[3]).toMatchObject({
      kind: "explicit-copy",
      matcher: "not-run",
      sourceView: 2,
      eventView: 4,
      save: "undone",
      sourceMediaSeconds: null,
      processedMs: null,
    });
    expect(records[4]).toMatchObject({
      matcher: "accepted",
      save: "preview-only",
    });
    expect(trace.exportJson()).not.toMatch(
      /PRIVATE|https:|imageUrl|sourceUrl|quantityConfirmation|scanEventId/,
    );
  });
  it.each([
    [
      "incomplete-verification",
      (r: VisionResult) => {
        r.budgetExhausted = true;
      },
    ],
    [
      "detection-count",
      (r: VisionResult) => {
        r.detections = [];
      },
    ],
    [
      "deferred",
      (r: VisionResult) => {
        r.detections[0].deferred = true;
      },
    ],
    [
      "quality-issues",
      (r: VisionResult) => {
        r.detections[0].quality.issues = ["SECRET quality text"];
      },
    ],
    [
      "no-candidate",
      (r: VisionResult) => {
        r.detections[0].candidates = [];
      },
    ],
    [
      "geometry-unverified",
      (r: VisionResult) => {
        r.detections[0].candidates[0].geometricallyVerified = false;
      },
    ],
    [
      "geometry-gate",
      (r: VisionResult) => {
        r.detections[0].candidates[0].inliers = 0;
      },
    ],
    [
      "missing-reference",
      (r: VisionResult) => {
        r.detections[0].candidates[0].reference.name = "";
      },
    ],
  ])("records closed production rejection %s", (reason, mutate) => {
    const trace = new PackTrace(),
      h = harness(trace),
      value = result();
    mutate(value);
    expect(h.process(1, value)).toEqual([]);
    expect(trace.snapshot().records[0].reason).toBe(reason);
  });
  it("marks processed-but-undelivered cancellation honestly and blocks late consume", () => {
    const trace = new PackTrace(),
      queue = new PackCaptureQueue("pack", "source", undefined, trace),
      session = new PackSession("pack", () => 300, trace);
    const admission = queue.offer(capture(1), 121);
    if (!admission.accepted) throw new Error("fixture");
    session.queue(admission.view);
    const lease = queue.claim(122)!;
    session.identifying(lease.view.captureId, 122);
    queue.recordProcessed(lease, 200);
    queue.cancel(250);
    session.cancel();
    expect(session.consume(lease.view.captureId, result(), 300, true)).toEqual(
      [],
    );
    expect(trace.snapshot().records[0]).toMatchObject({
      processedMs: 80,
      matcher: "cancelled",
      save: "none",
    });
  });
  it("keeps scanning if optional allocation or observation fails", () => {
    expect(
      createPackTrace(false, () => {
        throw Error("not reached");
      }),
    ).toEqual({ failed: false });
    expect(
      createPackTrace(true, () => {
        throw Error("allocation");
      }),
    ).toEqual({ failed: true });
    const trace = new PackTrace();
    trace.capture = () => {
      throw Error("observer");
    };
    trace.noteFailure = () => {
      throw Error("observer error reporter");
    };
    const h = harness(trace);
    expect(h.process(1)).toHaveLength(1);
    expect(h.queue.stats.processed).toBe(1);
  });
  it.each([false, true])(
    "preserves worker options and Pause-held processing with trace=%s",
    async (enabled) => {
      vi.useFakeTimers();
      const trace = enabled ? new PackTrace() : undefined;
      let clock = 120,
        resolve: (value: VisionResult) => void = () => {};
      const video = new EventTarget() as HTMLVideoElement;
      Object.defineProperty(video, "ended", { value: false });
      const onResult = vi.fn();
      const client = {
        busy: false,
        takeFrameBuffer: (bytes: number) => new ArrayBuffer(bytes),
        analyze: vi.fn(
          async (_image: CapturedPixels["image"], _options?: VisionOptions) => {
            void _image;
            void _options;
            client.busy = true;
            const value = await new Promise<VisionResult>((done) => {
              resolve = done;
            });
            client.busy = false;
            return value;
          },
        ),
      };
      let frame = 0;
      const loop = new PackCaptureLoop({
        video,
        client,
        sessionId: "pack",
        sourceId: "source",
        frameLimit: 1920,
        game: "pokemon",
        trace,
        capture: {
          minimumIntervalMs: 120,
          capture: async () => {
            const v = capture(++frame);
            clock = v.capturedAt;
            return v;
          },
          dispose: () => {},
        },
        now: () => clock,
        onQueued: () => {},
        onOmitted: () => {},
        onResult,
        onStats: () => {},
        onError: () => {},
        onDrained: () => {},
      });
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.analyze.mock.calls[0][1]).toEqual({
        mode: "pack",
        game: "pokemon",
        budgetMs: 750,
      });
      loop.pause();
      clock = 180;
      resolve(result());
      await vi.advanceTimersByTimeAsync(0);
      expect(onResult).not.toHaveBeenCalled();
      expect(loop.stats.processed).toBe(1);
      if (trace)
        expect(trace.snapshot().records[0]).toMatchObject({
          processedMs: 60,
          matcher: "pending",
        });
      loop.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(onResult).toHaveBeenCalledOnce();
      loop.dispose();
    },
  );
});
afterEach(() => vi.useRealTimers());
