import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PACK_MAX_BYTES,
  PackCaptureLoop,
  PackCaptureQueue,
} from "./pack-capture";
import type { CapturedPixels } from "./frame-capture";
import {
  CaptureFrameExpiredError,
  CaptureFreshnessError,
} from "./frame-capture";
import type { VisionResult } from "./vision";

function capture(
  frame: number,
  level = 100,
  width = 64,
  height = 64,
): CapturedPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = level;
    data[i + 1] = level;
    data[i + 2] = level;
    data[i + 3] = 255;
  }
  return {
    image: { width, height, data },
    capturedAt: frame * 120,
    transport: "videoframe-pool",
    sourceFrame: {
      presentedFrames: frame,
      mediaTime: frame * 0.12,
      presentationTime: frame * 120,
      callbackAt: frame * 120,
    },
  };
}
function detailed(frame: number, contrast: number) {
  const item = capture(frame);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const value = 100 + (((x >> 1) + (y >> 1)) % 2 ? contrast : -contrast);
      for (let c = 0; c < 3; c++) item.image.data[(y * 64 + x) * 4 + c] = value;
    }
  return item;
}
const result = (): VisionResult => ({
  width: 64,
  height: 64,
  detections: [],
  timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 },
  coverage: {
    totalReferences: 1,
    byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
    packs: [],
  },
  budgetExhausted: false,
  detectionComplete: true,
});
afterEach(() => vi.useRealTimers());

describe("bounded immutable pack queue", () => {
  it("transfers ownership once, freezes source provenance and counts a detached in-flight buffer", () => {
    const queue = new PackCaptureQueue("pack", "camera"),
      input = capture(1),
      alias = input.image.data;
    const admitted = queue.offer(input, 125);
    expect(admitted.accepted).toBe(true);
    expect(alias.byteLength).toBe(0);
    if (!admitted.view) throw new Error("First view must be admitted");
    expect(Object.isFrozen(admitted.view)).toBe(true);
    expect(Object.isFrozen(admitted.view.sourceFrame)).toBe(true);
    input.sourceFrame = capture(5).sourceFrame;
    const lease = queue.claim(130)!;
    expect(lease.view.sourceFrame.presentedFrames).toBe(1);
    const moved = structuredClone(lease.image.data.buffer, {
      transfer: [lease.image.data.buffer],
    });
    expect(lease.image.data.byteLength).toBe(0);
    expect(queue.stats.retainedBytes).toBe(moved.byteLength);
    expect(queue.claim()).toBeUndefined();
    expect(queue.finish(lease)).toBe(true);
    expect(queue.finish(lease)).toBe(false);
    expect(queue.stats.retainedBytes).toBe(0);
  });
  it("never exceeds queue count or bytes under worker backpressure, and reports every overflow", () => {
    const bytes = 64 * 64 * 4,
      queue = new PackCaptureQueue("pack", "camera", {
        maxViews: 3,
        maxBytes: bytes * 3,
      });
    queue.offer(capture(1, 20), 120);
    const active = queue.claim(120)!;
    for (let frame = 2; frame <= 20; frame++) {
      queue.offer(capture(frame, frame % 2 ? 210 : 80), frame * 120);
      expect(queue.stats.retainedBytes).toBeLessThanOrEqual(bytes * 3);
      expect(
        queue.stats.queued + queue.stats.inFlight + queue.stats.reservoirViews,
      ).toBeLessThanOrEqual(3);
      expect(queue.isCurrent(active)).toBe(true);
    }
    expect(queue.stats.queueDropped).toBeGreaterThan(0);
    expect(queue.stats.peakRetainedBytes).toBeLessThanOrEqual(bytes * 3);
    queue.cancel();
    expect(queue.stats.retainedBytes).toBe(0);
    expect(queue.finish(active)).toBe(false);
  });
  it("reports overflow rather than evicting the only in-flight view", () => {
    const queue = new PackCaptureQueue("pack", "camera", {
      maxViews: 1,
      maxBytes: 64 * 64 * 4,
    });
    queue.offer(capture(1, 20), 120);
    const active = queue.claim(120)!;
    const next = capture(2, 200),
      rejected = queue.offer(next, 240);
    expect(rejected).toMatchObject({
      accepted: false,
      omitted: [{ reason: "queue-overflow" }],
    });
    expect(next.image.data.byteLength).toBe(64 * 64 * 4);
    expect(queue.isCurrent(active)).toBe(true);
  });
  it("omits repeated wrapper-like views but periodically admits real fresh observations", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120);
    queue.finish(queue.claim(120)!);
    for (let frame = 2; frame <= 5; frame++)
      expect(queue.offer(capture(frame), frame * 120)).toMatchObject({
        preFiltered: true,
        accepted: false,
        omitted: [],
      });
    const refreshed = queue.offer(capture(6), 720);
    expect(refreshed.accepted).toBe(true);
    expect(refreshed.view?.frameId).toBe(2);
    expect(refreshed.view?.sourceFrame.presentedFrames).toBe(6);
    expect(queue.stats).toMatchObject({
      captured: 6,
      preFiltered: 4,
      offered: 2,
      admitted: 2,
      omitted: 0,
      queueOmitted: 0,
      queueDropped: 0,
    });
  });
  it("keeps the sharper pending near-identical view and reports replacement without asserting same-copy proof", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    const initial = queue.offer(detailed(1, 4), 120);
    const improved = queue.offer(detailed(2, 8), 240);
    expect(improved.accepted).toBe(true);
    expect(improved.omitted).toEqual([
      {
        captureId: initial.view?.captureId,
        reason: "replaced-by-clearer-view",
      },
    ]);
    expect(queue.offer(detailed(3, 4), 360)).toMatchObject({
      accepted: false,
      omitted: [{ reason: "better-view-retained" }],
    });
    const lease = queue.claim(360)!;
    expect(lease.view.frameId).toBe(2);
    expect(lease.view.copyLineage).toBe("unproven");
    expect(queue.stats).toMatchObject({
      captured: 3,
      preFiltered: 0,
      offered: 3,
      queueOmitted: 2,
      queueDropped: 0,
      replaced: 1,
    });
  });
  it("preserves a localized one-frame reveal through both prefilter and queue similarity", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120);
    const reveal = capture(2);
    for (let y = 48; y < 52; y++)
      for (let x = 28; x < 36; x++)
        for (let c = 0; c < 3; c++)
          reveal.image.data[(y * 64 + x) * 4 + c] = 112;
    expect(queue.offer(reveal, 240)).toMatchObject({
      preFiltered: false,
      accepted: true,
      omitted: [],
    });
    expect(queue.stats).toMatchObject({
      captured: 2,
      preFiltered: 0,
      queued: 2,
      queueOmitted: 0,
      queueDropped: 0,
    });
    expect(queue.claim(300)?.view.copyLineage).toBe("unproven");
  });
  it("consumes strict source/timestamp provenance on filtered acquisitions and never resets it with image history", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120);
    expect(queue.offer(capture(2), 240).preFiltered).toBe(true);
    expect(() => queue.offer(capture(2), 250)).toThrow(/regressed/);
    const sourceRegression = capture(3);
    sourceRegression.sourceFrame = {
      ...sourceRegression.sourceFrame!,
      mediaTime: 0.12,
    };
    expect(() => queue.offer(sourceRegression, 360)).toThrow(/regressed/);
    const clockRegression = capture(3);
    clockRegression.capturedAt = 240;
    expect(() => queue.offer(clockRegression, 360)).toThrow(/regressed/);
    const invalid = capture(3);
    invalid.sourceFrame = { ...invalid.sourceFrame!, callbackAt: NaN };
    expect(() => queue.offer(invalid, 360)).toThrow(/provenance/);
    queue.resetAdmissionHistory();
    expect(() => queue.offer(capture(2), 360)).toThrow(/regressed/);
    expect(queue.stats).toMatchObject({
      captured: 2,
      preFiltered: 1,
      offered: 1,
    });
  });
  it("recycles a skipped buffer without retaining or transferring its pixels", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120);
    const active = queue.claim(120)!;
    const held = queue.stats.retainedBytes,
      input = capture(2),
      buffer = input.image.data.buffer;
    const skipped = queue.offer(input, 240);
    expect(skipped).toMatchObject({
      preFiltered: true,
      accepted: false,
      omitted: [],
    });
    expect(skipped.view).toBeUndefined();
    expect(skipped.recycled).toBe(buffer);
    expect(buffer.byteLength).toBe(64 * 64 * 4);
    expect(queue.stats.retainedBytes).toBe(held);
    input.image.data.fill(250);
    expect(active.image.data[0]).toBe(100);
    const returned = capture(3);
    returned.image.data = new Uint8ClampedArray(buffer);
    expect(queue.offer(returned, 360).accepted).toBe(true);
    expect(buffer.byteLength).toBe(0);
    queue.cancel();
    expect(queue.stats.retainedBytes).toBe(0);
  });
  it("keeps overflow, downstream omissions and processed completions distinct", () => {
    const queue = new PackCaptureQueue("pack", "camera", {
      maxViews: 1,
      maxBytes: 64 * 64 * 4,
    });
    queue.offer(capture(1), 120);
    const active = queue.claim(120)!;
    queue.offer(capture(2), 240);
    queue.offer(capture(3, 200), 360);
    expect(queue.stats).toMatchObject({
      captured: 3,
      preFiltered: 1,
      offered: 2,
      queueOmitted: 1,
      queueDropped: 1,
      processed: 0,
    });
    queue.recordProcessed(active);
    queue.recordProcessed(active);
    expect(queue.stats.processed).toBe(1);
    queue.finish(active);
    queue.recordProcessed(active);
    expect(queue.stats.processed).toBe(1);
  });
  it("rejects compatibility, duplicate source frames, regressing clocks and oversized backing aliases", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120);
    expect(() => queue.offer(capture(1), 130)).toThrow(/regressed/);
    const repeated = capture(2);
    repeated.sourceFrame = capture(1).sourceFrame;
    expect(() => queue.offer(repeated, 250)).toThrow(/regressed/);
    expect(() =>
      queue.offer({ ...capture(2), transport: "compatibility" }, 250),
    ).toThrow(/native/);
    const aliased = capture(2);
    aliased.image.data = new Uint8ClampedArray(
      new ArrayBuffer(64 * 64 * 8),
      0,
      64 * 64 * 4,
    );
    expect(() => queue.offer(aliased, 250)).toThrow(/pixels/);
    expect(
      () =>
        new PackCaptureQueue("pack", "camera", {
          maxViews: 13,
          maxBytes: PACK_MAX_BYTES,
        }),
    ).toThrow(/configuration/);
  });
  it("natural end drains admitted views whereas cancel invalidates them", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1, 20), 120);
    queue.offer(capture(2, 200), 240);
    queue.end();
    expect(queue.offer(capture(3, 50), 360)).toMatchObject({
      accepted: false,
      omitted: [{ reason: "closed" }],
    });
    expect(queue.finish(queue.claim(400)!)).toBe(true);
    expect(queue.finish(queue.claim(500)!)).toBe(true);
    expect(queue.claim()).toBeUndefined();
    expect(queue.stats.retainedBytes).toBe(0);
  });
});

function expectConservation(queue: PackCaptureQueue | PackCaptureLoop) {
  const s = queue.stats;
  expect(s.captured).toBe(
    s.preFiltered +
      s.backpressureRejected +
      s.reservoirReplaced +
      s.reservoirCancelled +
      s.admitted +
      s.queueRejected +
      s.reservoirViews,
  );
}
function congestedQueue(limits?: { maxViews: number; maxBytes: number }) {
  const queue = new PackCaptureQueue("pack", "camera", limits);
  queue.offer(capture(1, 10), 120);
  const active = queue.claim(120)!;
  queue.offer(capture(2, 40), 240);
  queue.offer(capture(3, 70), 360);
  return { queue, active };
}
describe("adaptive pack backlog and latest/best reservoir", () => {
  it("bounds the pending target using measured wall service and an explicit bounded EWMA", () => {
    const q = new PackCaptureQueue("pack", "camera");
    expect(q.stats).toMatchObject({
      workerServiceMs: 250,
      adaptivePendingLimit: 2,
    });
    q.offer(capture(1, 10), 120);
    let lease = q.claim(120)!;
    q.recordProcessed(lease, 170);
    expect(q.stats).toMatchObject({
      workerServiceMs: 120,
      adaptivePendingLimit: 3,
    });
    q.recordProcessed(lease, 10000);
    expect(q.stats.workerServiceMs).toBe(120);
    q.finish(lease);
    q.offer(capture(2, 100), 240);
    lease = q.claim(240)!;
    q.recordProcessed(lease, 5000);
    expect(q.stats.workerServiceMs).toBe(120 * 0.8 + 2000 * 0.2);
    expect(q.stats.adaptivePendingLimit).toBe(1);
    expectConservation(q);
  });
  it("holds owned pixels before receipt creation and promotes original provenance chronologically", () => {
    const { queue, active } = congestedQueue(),
      input = capture(4, 100),
      alias = input.image.data;
    const deferred = queue.offer(input, 485);
    expect(deferred).toMatchObject({
      backpressured: true,
      accepted: false,
      retained: true,
      omitted: [],
    });
    expect(deferred.view).toBeUndefined();
    expect(alias.byteLength).toBe(0);
    input.sourceFrame = capture(99).sourceFrame;
    queue.offer(capture(5, 160), 600);
    expect(queue.stats).toMatchObject({
      queued: 2,
      reservoirViews: 2,
      retainedBytes: 5 * 64 * 64 * 4,
      offered: 3,
      admitted: 3,
    });
    expect(queue.stats.peakRetainedViews).toBe(5);
    expect(queue.promote(700)).toEqual([]);
    queue.finish(active);
    const second = queue.claim(700)!;
    const promoted = queue.promote(700);
    expect(promoted.map((view) => view.sourceFrame.presentedFrames)).toEqual([
      4,
    ]);
    expect(promoted[0]).toMatchObject({
      capturedAt: 480,
      queuedAt: 485,
      copyLineage: "unproven",
    });
    expect(Object.isFrozen(promoted[0].sourceFrame)).toBe(true);
    queue.finish(second);
    queue.claim(800);
    expect(
      queue.promote(800).map((view) => view.sourceFrame.presentedFrames),
    ).toEqual([5]);
    expectConservation(queue);
    queue.cancel();
    expectConservation(queue);
  });
  it("preserves a tiny one-frame local reveal and latest view without calling replacements visually redundant", () => {
    const { queue, active } = congestedQueue();
    const brief = capture(4);
    for (let y = 44; y < 48; y++)
      for (let x = 28; x < 32; x++)
        for (let c = 0; c < 3; c++)
          brief.image.data[(y * 64 + x) * 4 + c] = 128;
    queue.offer(brief, 480);
    queue.offer(capture(5, 130), 600);
    const latest = queue.offer(capture(6, 170), 720);
    expect(latest).toMatchObject({
      backpressured: true,
      retained: true,
      omitted: [],
    });
    expect(latest.recycled?.byteLength).toBe(64 * 64 * 4);
    expect(queue.stats).toMatchObject({
      captured: 6,
      preFiltered: 0,
      backpressureDeferred: 3,
      reservoirReplaced: 1,
      queueDropped: 0,
      queueOmitted: 0,
    });
    queue.end();
    queue.recordProcessed(active);
    queue.finish(active);
    const seen: number[] = [];
    while (queue.stats.queued || queue.stats.reservoirViews) {
      queue.promote(2000);
      const lease = queue.claim(2000)!;
      seen.push(lease.view.sourceFrame.presentedFrames);
      queue.recordProcessed(lease);
      queue.finish(lease);
      expectConservation(queue);
    }
    expect(seen).toEqual([2, 3, 4, 6]);
    expect(queue.stats).toMatchObject({
      retainedBytes: 0,
      reservoirViews: 0,
      reservoirPromoted: 2,
      processed: 5,
      admitted: 5,
    });
    expectConservation(queue);
  });
  it("keeps sustained overload within a small actual pixel backlog while reporting every lost candidate", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    let active: ReturnType<PackCaptureQueue["claim"]>;
    for (let frame = 1; frame <= 120; frame++) {
      const now = frame * 120;
      queue.promote(now);
      queue.offer(capture(frame, (frame * 17) % 240), now);
      if (!active) {
        active = queue.claim(now);
        queue.promote(now);
      }
      if (frame % 3 === 0 && active) {
        queue.recordProcessed(active, now + 50);
        queue.finish(active);
        queue.promote(now + 50);
        active = queue.claim(now + 50);
        queue.promote(now + 50);
      }
      expect(queue.stats.queued).toBeLessThanOrEqual(3);
      expect(queue.stats.reservoirViews).toBeLessThanOrEqual(2);
      expect(queue.stats.retainedBytes).toBeLessThanOrEqual(6 * 64 * 64 * 4);
      expect(queue.stats.peakRetainedViews).toBeLessThanOrEqual(6);
      expectConservation(queue);
    }
    expect(queue.stats.reservoirReplaced).toBeGreaterThan(0);
    expect(queue.stats.queueDropped).toBe(0);
    expect(queue.stats.preFiltered).toBe(0);
    queue.end();
    if (active) {
      queue.recordProcessed(active);
      queue.finish(active);
    }
    while (queue.stats.queued || queue.stats.reservoirViews) {
      queue.promote(20000);
      const lease = queue.claim(20000)!;
      queue.recordProcessed(lease);
      queue.finish(lease);
    }
    expect(queue.stats.retainedBytes).toBe(0);
    expect(queue.stats.captured).toBe(
      queue.stats.processed + queue.stats.reservoirReplaced,
    );
    expectConservation(queue);
  });
  it("retains improved reservoir quality deterministically and bounds old best-view tenure", () => {
    const { queue, active } = congestedQueue();
    queue.offer(detailed(4, 4), 480);
    queue.offer(detailed(5, 10), 600);
    queue.offer(capture(6, 170), 720);
    queue.finish(active);
    queue.claim(720);
    expect(
      queue.promote(720).map((view) => view.sourceFrame.presentedFrames),
    ).toEqual([5]);
    queue.cancel();
    expectConservation(queue);
    const held = congestedQueue();
    held.queue.offer(detailed(4, 20), 480);
    for (let frame = 5; frame <= 12; frame++)
      held.queue.offer(capture(frame, frame % 2 ? 160 : 210), frame * 120);
    held.queue.finish(held.active);
    held.queue.claim(1440);
    const views = held.queue.promote(1440);
    expect(views[0].sourceFrame.presentedFrames).toBeGreaterThan(4);
    expect(held.queue.stats.reservoirViews).toBe(1);
    expectConservation(held.queue);
    held.queue.cancel();
  });
  it("does not visually suppress the next opportunity for a candidate rejected without storage", () => {
    const bytes = 64 * 64 * 4,
      queue = new PackCaptureQueue("pack", "camera", {
        maxViews: 1,
        maxBytes: bytes,
      });
    queue.offer(capture(1, 10), 120);
    const first = queue.claim(120)!;
    expect(queue.offer(capture(2, 150), 240)).toMatchObject({
      accepted: false,
      omitted: [{ reason: "queue-overflow" }],
    });
    queue.finish(first);
    expect(queue.offer(capture(3, 150), 360).accepted).toBe(true);
    expect(queue.stats.preFiltered).toBe(0);
    expectConservation(queue);
  });
  it("counts all reservoir pixels against hard caps and reports pre-receipt capacity loss separately", () => {
    const bytes = 64 * 64 * 4,
      { queue, active } = congestedQueue({ maxViews: 3, maxBytes: bytes * 3 });
    const input = capture(4, 150),
      rejected = queue.offer(input, 480);
    expect(rejected).toMatchObject({
      backpressured: true,
      retained: false,
      omitted: [],
    });
    expect(rejected.recycled).toBe(input.image.data.buffer);
    expect(queue.stats).toMatchObject({
      retainedBytes: bytes * 3,
      peakRetainedViews: 3,
      backpressureDeferred: 1,
      backpressureRejected: 1,
      queueDropped: 1,
      queueOmitted: 0,
    });
    expect(queue.isCurrent(active)).toBe(true);
    expectConservation(queue);
    queue.cancel();
    expectConservation(queue);
  });
  it("replaces a single bounded latest slot without detaching recycled ownership or exceeding bytes", () => {
    const bytes = 64 * 64 * 4,
      { queue } = congestedQueue({ maxViews: 4, maxBytes: bytes * 4 });
    const input = capture(4, 100);
    queue.offer(input, 480);
    const replaced = queue.offer(capture(5, 160), 600);
    expect(replaced).toMatchObject({ backpressured: true, retained: true });
    expect(input.image.data.byteLength).toBe(0);
    expect(replaced.recycled?.byteLength).toBe(bytes);
    new Uint8ClampedArray(replaced.recycled!).fill(0);
    expect(queue.stats).toMatchObject({
      reservoirViews: 1,
      retainedBytes: bytes * 4,
      reservoirReplaced: 1,
    });
    expectConservation(queue);
    queue.cancel();
    expect(queue.stats.reservoirCancelled).toBe(1);
    expectConservation(queue);
  });
  it("rejects a larger deferred buffer without destroying the smaller retained candidate", () => {
    const bytes = 64 * 64 * 4,
      { queue, active } = congestedQueue({ maxViews: 4, maxBytes: bytes * 4 });
    queue.offer(capture(4, 100), 480);
    const bigger = capture(5, 150, 128, 64),
      buffer = bigger.image.data.buffer;
    const rejected = queue.offer(bigger, 600);
    expect(rejected).toMatchObject({
      backpressured: true,
      retained: false,
      omitted: [],
    });
    expect(rejected.recycled).toBe(buffer);
    expect(buffer.byteLength).toBe(bytes * 2);
    expect(queue.stats).toMatchObject({
      retainedBytes: bytes * 4,
      reservoirViews: 1,
      reservoirReplaced: 0,
      backpressureRejected: 1,
    });
    queue.finish(active);
    queue.claim(600);
    expect(queue.promote(600)[0].sourceFrame.presentedFrames).toBe(4);
    expectConservation(queue);
    queue.cancel();
    expectConservation(queue);
  });
  it("consumes native provenance before deferral and preserves it across pause history reset", () => {
    const { queue } = congestedQueue();
    queue.offer(capture(4, 100), 480);
    expect(() => queue.offer(capture(4, 100), 500)).toThrow(/regressed/);
    queue.resetAdmissionHistory();
    expect(() => queue.offer(capture(4, 100), 500)).toThrow(/regressed/);
    expect(() => queue.promote(479)).toThrow(/clock/);
    expectConservation(queue);
    queue.cancel();
    expect(queue.promote(1000)).toEqual([]);
    expect(queue.stats).toMatchObject({
      retainedBytes: 0,
      reservoirViews: 0,
      reservoirCancelled: 1,
    });
    expectConservation(queue);
  });
});

function loopHarness(withTrack = false) {
  const video = new EventTarget() as HTMLVideoElement;
  Object.defineProperty(video, "ended", { value: false, writable: true });
  const track = Object.assign(new EventTarget(), {
    muted: false,
    enabled: true,
    readyState: "live",
  });
  if (withTrack)
    video.srcObject = {
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
  let time = 0,
    frame = 0,
    pending: ((value: VisionResult) => void) | undefined;
  const client = {
    busy: false,
    takeFrameBuffer: vi.fn((bytes: number) => new ArrayBuffer(bytes)),
    analyze: vi.fn(async (image: CapturedPixels["image"]) => {
      client.busy = true;
      structuredClone(image.data.buffer, { transfer: [image.data.buffer] });
      const value = await new Promise<VisionResult>((resolve) => {
        pending = resolve;
      });
      client.busy = false;
      return value;
    }),
  };
  const source = {
    minimumIntervalMs: 120 as const,
    dispose: vi.fn(),
    capture: vi.fn(
      async (
        ..._args: [
          HTMLVideoElement?,
          number?,
          ((bytes: number) => ArrayBuffer)?,
        ]
      ) => {
        void _args;
        const item = capture(++frame, frame % 2 ? 20 : 200);
        time = item.capturedAt;
        return item;
      },
    ),
  };
  const callbacks = {
    onQueued: vi.fn(),
    onIdentifying: vi.fn(),
    onOmitted: vi.fn(),
    onResult: vi.fn(),
    onStats: vi.fn(),
    onError: vi.fn(),
    onDrained: vi.fn(),
  };
  const loop = new PackCaptureLoop({
    video,
    client,
    sessionId: "pack",
    sourceId: "camera",
    frameLimit: 1920,
    capture: source,
    now: () => time,
    ...callbacks,
  });
  return {
    loop,
    client,
    source,
    callbacks,
    video,
    track,
    setTime: (value: number) => {
      time = value;
    },
    resolve: () => {
      time += 50;
      pending?.(result());
    },
  };
}
function expired() {
  return new CaptureFrameExpiredError(
    "callback",
    {
      presentedFrames: 1,
      mediaTime: 0.12,
      presentationTime: 120,
      callbackAt: 120,
    },
    371,
  );
}
describe("separate pack capture lifecycle", () => {
  it("captures during one worker operation, saves captured A after B, and drains after end", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.source.capture).toHaveBeenCalledTimes(3);
    expect(h.client.analyze).toHaveBeenCalledTimes(1);
    h.loop.finishCapture();
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult.mock.calls[0][0].frameId).toBe(1);
    expect(h.client.analyze).toHaveBeenCalledTimes(2);
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.analyze).toHaveBeenCalledTimes(3);
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onDrained).toHaveBeenCalledOnce();
    expect(h.loop.stats.retainedBytes).toBe(0);
    expect(h.callbacks.onResult.mock.calls[0][2]).toMatchObject({
      queueWaitMs: 0,
      workerMs: 60,
    });
    h.loop.dispose();
  });
  it("holds completed results behind Pause and delivers only on Resume", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.loop.pause();
    h.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.source.capture).toHaveBeenCalledOnce();
    expect(h.loop.stats.processed).toBe(1);
    expect(h.callbacks.onStats.mock.lastCall![0].processed).toBe(1);
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult).toHaveBeenCalledOnce();
    h.loop.dispose();
  });
  it("reuses the prefiltered buffer at the same capture cadence without receipts or worker calls", async () => {
    vi.useFakeTimers();
    const h = loopHarness(),
      buffers: ArrayBuffer[] = [];
    let frame = 0;
    h.source.capture.mockImplementation(async (_video, _limit, takeBuffer) => {
      const item = capture(++frame);
      h.setTime(item.capturedAt);
      const buffer = takeBuffer!(item.image.data.byteLength);
      buffers.push(buffer);
      new Uint8ClampedArray(buffer).set(item.image.data);
      item.image.data = new Uint8ClampedArray(buffer);
      return item;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(480);
    expect(h.source.capture).toHaveBeenCalledTimes(5);
    expect(h.client.analyze).toHaveBeenCalledOnce();
    expect(h.callbacks.onQueued).toHaveBeenCalledOnce();
    expect(h.callbacks.onOmitted).not.toHaveBeenCalled();
    expect(h.loop.stats).toMatchObject({
      captured: 5,
      preFiltered: 4,
      offered: 1,
      queueOmitted: 0,
      queueDropped: 0,
      processed: 0,
    });
    expect(h.client.takeFrameBuffer).toHaveBeenCalledTimes(2);
    expect(buffers[0].byteLength).toBe(0);
    expect(buffers[1]).toBe(buffers[2]);
    expect(buffers[2]).toBe(buffers[4]);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({
      captured: 6,
      preFiltered: 4,
      admitted: 2,
    });
    expect(h.callbacks.onQueued).toHaveBeenCalledTimes(2);
    h.loop.dispose();
    h.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.loop.stats).toMatchObject({ retainedBytes: 0, processed: 0 });
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
  });
  it("Resume admits a fresh static view immediately while retaining strict provenance", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let frame = 0;
    h.source.capture.mockImplementation(async () => {
      const item = capture(++frame);
      h.setTime(item.capturedAt);
      return item;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({
      captured: 2,
      preFiltered: 1,
      admitted: 1,
    });
    h.loop.pause();
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loop.stats).toMatchObject({
      captured: 3,
      preFiltered: 1,
      admitted: 2,
      processed: 1,
    });
    expect(
      h.callbacks.onQueued.mock.lastCall![0].sourceFrame.presentedFrames,
    ).toBe(3);
    h.loop.dispose();
  });
  it("drains the reservoir after natural end, with receipts before identification and Pause still holding results", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let frame = 0;
    const announced = new Set<string>();
    h.source.capture.mockImplementation(async () => {
      const value = capture(++frame, frame * 20);
      h.setTime(value.capturedAt);
      return value;
    });
    h.callbacks.onQueued.mockImplementation((view) => {
      announced.add(view.captureId);
    });
    h.callbacks.onIdentifying.mockImplementation((view) => {
      expect(announced.has(view.captureId)).toBe(true);
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(720);
    expect(h.loop.stats).toMatchObject({
      captured: 7,
      queued: 2,
      reservoirViews: 2,
      reservoirReplaced: 2,
      offered: 3,
    });
    expect(h.callbacks.onQueued).toHaveBeenCalledTimes(3);
    expectConservation(h.loop);
    h.loop.pause();
    h.loop.finishCapture();
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.callbacks.onDrained).not.toHaveBeenCalled();
    expect(h.loop.stats.reservoirViews).toBe(2);
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    for (let pending = 0; pending < 4; pending++) {
      h.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(
      h.callbacks.onResult.mock.calls.map(
        ([view]) => view.sourceFrame.presentedFrames,
      ),
    ).toEqual([1, 2, 3, 4, 7]);
    expect(h.callbacks.onQueued).toHaveBeenCalledTimes(5);
    expect(h.callbacks.onDrained).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({
      processed: 5,
      reservoirPromoted: 2,
      queued: 0,
      reservoirViews: 0,
      retainedBytes: 0,
    });
    expectConservation(h.loop);
    h.loop.dispose();
  });
  it("cancels safely if creating a promoted receipt fails, before another worker request", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let frame = 0;
    h.source.capture.mockImplementation(async () => {
      const value = capture(++frame, frame * 20);
      h.setTime(value.capturedAt);
      return value;
    });
    h.callbacks.onQueued.mockImplementation((view) => {
      if (view.sourceFrame.presentedFrames >= 4)
        throw new Error("Promoted receipt rejected");
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(480);
    h.loop.finishCapture();
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The slower measured first call reduces the target to one pending entry;
    // after the second result, a slot opens and promotion invokes the callback.
    if (!h.callbacks.onError.mock.calls.length) {
      h.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.client.analyze.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.loop.stats).toMatchObject({ retainedBytes: 0, reservoirViews: 0 });
    expectConservation(h.loop);
  });
  it("uses actual roundtrip time rather than worker-reported timing for adaptive admission", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.loop.finishCapture();
    h.setTime(1000);
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loop.stats.workerServiceMs).toBe(930);
    expect(h.loop.stats.adaptivePendingLimit).toBe(1);
    expect(h.callbacks.onResult.mock.calls[0][2].workerMs).toBe(60);
    h.loop.dispose();
  });
  it("cancels every reservoir buffer and suppresses late completions on source replacement", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let frame = 0;
    h.source.capture.mockImplementation(async () => {
      const value = capture(++frame, frame * 20);
      h.setTime(value.capturedAt);
      return value;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.loop.stats.reservoirViews).toBe(2);
    h.video.dispatchEvent(new Event("loadstart"));
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loop.stats).toMatchObject({
      reservoirCancelled: 2,
      reservoirViews: 0,
      retainedBytes: 0,
      processed: 0,
    });
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.callbacks.onDrained).not.toHaveBeenCalled();
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expectConservation(h.loop);
  });
  it("explicit disposal suppresses held or late completion and cannot restart", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(130);
    h.loop.dispose();
    h.resolve();
    h.loop.resume();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.callbacks.onDrained).not.toHaveBeenCalled();
    expect(h.loop.stats.retainedBytes).toBe(0);
  });
  it("handles natural ended idempotently and propagates acquisition errors as cancellation", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.video.dispatchEvent(new Event("ended"));
    h.loop.finishCapture();
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onDrained).toHaveBeenCalledOnce();
    h.loop.dispose();
    const failed = loopHarness();
    failed.source.capture.mockRejectedValueOnce(new Error("source replaced"));
    failed.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed.callbacks.onError).toHaveBeenCalledOnce();
    expect(failed.callbacks.onResult).not.toHaveBeenCalled();
  });
  it("pause during acquisition discards stale pixels/errors and Resume obtains a fresh view", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let reject!: (error: Error) => void;
    h.source.capture.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.loop.pause();
    h.loop.resume();
    reject(new Error("Native video paused during frame wait"));
    await vi.advanceTimersByTimeAsync(130);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.callbacks.onQueued).toHaveBeenCalledOnce();
    expect(h.source.capture).toHaveBeenCalledTimes(2);
    h.loop.dispose();
  });
  it("recycles late paused-epoch pixels only as storage for a newly acquired native frame", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let complete!: (value: CapturedPixels) => void;
    const old = capture(1),
      oldBuffer = old.image.data.buffer;
    let reused: ArrayBuffer | undefined;
    h.source.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    h.source.capture.mockImplementationOnce(
      async (_video, _limit, takeBuffer) => {
        const fresh = capture(2, 200);
        h.setTime(fresh.capturedAt);
        reused = takeBuffer!(fresh.image.data.byteLength);
        new Uint8ClampedArray(reused).set(fresh.image.data);
        fresh.image.data = new Uint8ClampedArray(reused);
        return fresh;
      },
    );
    h.loop.start();
    h.loop.pause();
    h.loop.resume();
    complete(old);
    await vi.advanceTimersByTimeAsync(120);
    expect(reused).toBe(oldBuffer);
    expect(h.client.takeFrameBuffer).not.toHaveBeenCalled();
    expect(h.callbacks.onQueued).toHaveBeenCalledOnce();
    expect(
      h.callbacks.onQueued.mock.calls[0][0].sourceFrame.presentedFrames,
    ).toBe(2);
    expect(h.loop.stats).toMatchObject({
      captured: 1,
      preFiltered: 0,
      offered: 1,
    });
    expect(oldBuffer.byteLength).toBe(0);
    h.loop.dispose();
  });
  it("source replacement cancels rather than impersonating natural completion", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.video.dispatchEvent(new Event("loadstart"));
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(h.callbacks.onDrained).not.toHaveBeenCalled();
  });
  it("a receipt admission error cancels safely before any worker request", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.callbacks.onQueued.mockImplementation(() => {
      throw new Error("Receipt limit");
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.client.analyze).not.toHaveBeenCalled();
    expect(h.loop.stats.retainedBytes).toBe(0);
  });

  it("discards two age-only acquisitions, then schedules and queues only a fresh view", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.source.capture
      .mockRejectedValueOnce(expired())
      .mockRejectedValueOnce(expired());
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loop.stats).toMatchObject({
      offered: 0,
      expiredAcquisitions: 1,
      captureRetries: 1,
      consecutiveExpiredAcquisitions: 1,
      lastCaptureExpiry: { stage: "callback", callbackAgeMs: 251 },
    });
    expect(h.client.analyze).not.toHaveBeenCalled();
    expect(h.callbacks.onQueued).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119);
    expect(h.source.capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.source.capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.source.capture).toHaveBeenCalledTimes(3);
    expect(h.callbacks.onQueued).toHaveBeenCalledOnce();
    expect(h.client.analyze).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({
      offered: 1,
      expiredAcquisitions: 2,
      captureRetries: 2,
      consecutiveExpiredAcquisitions: 0,
    });
    expect(h.callbacks.onStats.mock.lastCall![0]).toMatchObject({
      captureRetries: 2,
      expiredAcquisitions: 2,
    });
    expect(h.callbacks.onOmitted).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails once on the third consecutive expiry and cancels instead of retrying indefinitely", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.source.capture.mockRejectedValue(expired());
    h.loop.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.source.capture).toHaveBeenCalledTimes(3);
    expect(h.source.dispose).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({
      offered: 0,
      expiredAcquisitions: 3,
      captureRetries: 2,
      consecutiveExpiredAcquisitions: 3,
    });
    expect(h.client.analyze).not.toHaveBeenCalled();
    expect(h.callbacks.onDrained).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds cumulative retries to eight despite intervening valid frames and Pause/Resume", async () => {
    vi.useFakeTimers();
    const h = loopHarness(),
      normal = h.source.capture.getMockImplementation()!;
    let calls = 0;
    h.source.capture.mockImplementation(async () => {
      if (++calls % 2) throw expired();
      return normal();
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.loop.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(17);
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({
      captured: 8,
      expiredAcquisitions: 9,
      captureRetries: 8,
      consecutiveExpiredAcquisitions: 1,
      retainedBytes: 0,
    });
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset a consecutive failure budget on Pause/Resume", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.source.capture.mockRejectedValue(expired());
    h.loop.start();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats.captureRetries).toBe(2);
    h.loop.pause();
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.source.capture).toHaveBeenCalledTimes(3);
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps earlier valid worker results while dropping an expired acquisition", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.source.capture.mockRejectedValueOnce(expired());
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({
      inFlight: 1,
      captureRetries: 1,
      admitted: 1,
    });
    h.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult).toHaveBeenCalledOnce();
    expect(h.callbacks.onResult.mock.calls[0][0].frameId).toBe(1);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.callbacks.onQueued).toHaveBeenCalledTimes(2);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });

  it("resets consecutive expiry after a fresh but similarity-omitted acquisition", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    h.source.capture.mockRejectedValueOnce(expired());
    await vi.advanceTimersByTimeAsync(120);
    h.source.capture.mockImplementationOnce(async () => {
      h.setTime(240);
      return capture(2, 20);
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({
      expiredAcquisitions: 1,
      captureRetries: 1,
      consecutiveExpiredAcquisitions: 0,
      captured: 2,
      preFiltered: 1,
      offered: 1,
      omitted: 0,
    });
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });

  it.each([
    new CaptureFreshnessError("stale frame callback"),
    new CaptureFreshnessError("stopped supplying fresh frames"),
    new Error("source changed"),
    new Error("invalid pixel layout"),
  ])(
    "does not recover generic fatal errors by message matching: %s",
    async (error) => {
      vi.useFakeTimers();
      const h = loopHarness();
      h.source.capture.mockRejectedValueOnce(error);
      h.loop.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.source.capture).toHaveBeenCalledOnce();
      expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(h.loop.stats).toMatchObject({
        expiredAcquisitions: 0,
        captureRetries: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not retry a typed error thrown outside native acquisition", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    h.callbacks.onQueued.mockImplementation(() => {
      throw expired();
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.source.capture).toHaveBeenCalledOnce();
    expect(h.loop.stats.captureRetries).toBe(0);
  });

  it.each([
    "loadstart",
    "emptied",
    "abort",
    "error",
    "mute",
    "track-ended",
    "dispose",
    "natural-end",
  ] as const)(
    "does not restart after %s during retry backoff",
    async (event) => {
      vi.useFakeTimers();
      const h = loopHarness(event === "mute" || event === "track-ended");
      h.source.capture.mockRejectedValueOnce(expired());
      h.loop.start();
      await vi.advanceTimersByTimeAsync(0);
      if (event === "dispose") h.loop.dispose();
      else if (event === "natural-end") {
        Object.assign(h.video, { ended: true });
        h.video.dispatchEvent(new Event("ended"));
      } else if (event === "mute" || event === "track-ended")
        h.track.dispatchEvent(new Event(event === "mute" ? "mute" : "ended"));
      else h.video.dispatchEvent(new Event(event));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.source.capture).toHaveBeenCalledOnce();
      expect(h.callbacks.onQueued).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.callbacks.onError).toHaveBeenCalledTimes(
        event === "dispose" || event === "natural-end" ? 0 : 1,
      );
      expect(h.callbacks.onDrained).toHaveBeenCalledTimes(
        event === "natural-end" ? 1 : 0,
      );
      h.loop.dispose();
    },
  );

  it("ignores a late expiry from a paused epoch without granting a retry or overlapping capture", async () => {
    vi.useFakeTimers();
    const h = loopHarness();
    let reject!: (error: Error) => void;
    h.source.capture.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.loop.start();
    h.loop.pause();
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.source.capture).toHaveBeenCalledOnce();
    reject(expired());
    await vi.advanceTimersByTimeAsync(120);
    expect(h.source.capture).toHaveBeenCalledTimes(2);
    expect(h.loop.stats).toMatchObject({
      expiredAcquisitions: 0,
      captureRetries: 0,
      admitted: 1,
    });
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });
});
