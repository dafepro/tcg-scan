import { afterEach, describe, expect, it, vi } from "vitest";
import { grayscaleSample, LiveCaptureLoop } from "./live-capture";
import type { LiveCaptureContext } from "./live-capture";
import type { CapturedPixels } from "./frame-capture";
import {
  CaptureFrameClockAheadError,
  CaptureFrameExpiredError,
  CaptureFreshnessError,
} from "./frame-capture";

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function harness(onFrame: (context: LiveCaptureContext) => Promise<void>) {
  let timestamp = 1000,
    recycled: ArrayBuffer | undefined;
  const source = { current: true };
  const allocate = vi.fn((bytes: number) => {
    const buffer =
      recycled?.byteLength === bytes ? recycled : new ArrayBuffer(bytes);
    recycled = undefined;
    return buffer;
  });
  const capture = vi.fn(
    async (
      _video: HTMLVideoElement,
      _limit: number,
      take: (bytes: number) => ArrayBuffer,
    ): Promise<CapturedPixels> => {
      timestamp += 120;
      const data = new Uint8ClampedArray(take(64 * 64 * 4));
      data.fill(127);
      return {
        image: { width: 64, height: 64, data },
        capturedAt: timestamp,
        transport: "videoframe-pool",
      };
    },
  );
  const dispose = vi.fn(),
    onError = vi.fn(),
    onTransport = vi.fn(),
    onDiscard = vi.fn();
  const video = { ended: false } as HTMLVideoElement;
  const loop = new LiveCaptureLoop({
    video,
    client: { busy: false, takeFrameBuffer: allocate },
    frameLimit: 1920,
    onFrame,
    onError,
    onTransport,
    onDiscard,
    capture: {
      capture,
      dispose,
      minimumIntervalMs: 120,
      isSourceCurrent: () => source.current,
    },
  });
  return {
    loop,
    capture,
    allocate,
    dispose,
    onError,
    onTransport,
    onDiscard,
    video,
    source,
    recycle: (buffer: ArrayBuffer) => {
      recycled = buffer;
    },
  };
}
afterEach(() => vi.useRealTimers());

const rejectedSource = {
  presentedFrames: 4,
  mediaTime: 0.4,
  presentationTime: 1001,
  callbackAt: 1000,
};

describe("bounded rejected-frame recovery", () => {
  it("invalidates old continuity before retrying a rejected native capture", async () => {
    vi.useFakeTimers();
    const work = pending();
    let old!: LiveCaptureContext;
    let saves = 0;
    const handler = vi.fn(async (context: LiveCaptureContext) => {
      if (!old) {
        old = context;
        await work.promise;
      }
      if (context.isCurrent()) saves++;
    });
    const h = harness(handler);
    const original = h.capture.getMockImplementation()!;
    let n = 0;
    h.capture.mockImplementation(async (...args) => {
      if (++n === 2)
        throw new CaptureFrameClockAheadError(rejectedSource, 1000);
      return original(...args);
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(125);
    expect(old.isCurrent()).toBe(false);
    expect(old.latest()).toBeUndefined();
    expect(old.history.status.open).toBe(false);
    expect(h.onDiscard).toHaveBeenCalledWith("clock-ahead", 1);
    expect(h.onError).not.toHaveBeenCalled();
    work.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(saves).toBeGreaterThan(0);
    expect(handler).toHaveBeenCalledTimes(3);
    h.loop.dispose();
  });

  it.each(["expired", "clock-ahead"] as const)(
    "stops after three consecutive %s rejections with no admitted evidence",
    async (reason) => {
      vi.useFakeTimers();
      const handler = vi.fn(async () => {}),
        h = harness(handler);
      const error =
        reason === "expired"
          ? new CaptureFrameExpiredError("callback", rejectedSource, 1500)
          : new CaptureFrameClockAheadError(rejectedSource, 1000);
      h.capture.mockRejectedValue(error);
      h.loop.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.capture).toHaveBeenCalledTimes(3);
      expect(h.onDiscard.mock.calls).toEqual([
        [reason, 1],
        [reason, 2],
        [reason, 3],
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(h.onError).toHaveBeenCalledExactlyOnceWith(error);
      h.loop.dispose();
    },
  );

  it("resets consecutive failures only after a genuinely successful acquisition", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {}),
      h = harness(handler);
    const original = h.capture.getMockImplementation()!;
    let n = 0;
    h.capture.mockImplementation(async (...args) => {
      if ([1, 2, 4, 5].includes(++n))
        throw new CaptureFrameClockAheadError(rejectedSource, 1000);
      return original(...args);
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(h.onDiscard).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(h.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });

  it("keeps source replacement and malformed provenance immediately fatal", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {}),
      h = harness(handler);
    const error = new CaptureFreshnessError("The camera source changed.");
    h.capture.mockRejectedValue(error);
    h.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.onDiscard).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    h.loop.dispose();
  });

  it("lets natural EOF retire capture without a false camera-fault message", async () => {
    vi.useFakeTimers();
    const h = harness(vi.fn(async () => {}));
    h.capture.mockImplementation(async () => {
      Object.defineProperty(h.video, "ended", { value: true });
      throw new CaptureFreshnessError("The camera is paused or has ended.");
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });
});

describe("continuous sampling with worker backpressure", () => {
  it("keeps capturing only bounded grayscale history while exactly one operation runs", async () => {
    vi.useFakeTimers();
    const work = pending();
    let context!: LiveCaptureContext;
    const handler = vi.fn(async (c: LiveCaptureContext) => {
      context = c;
      const moved = structuredClone(c.capture.image.data.buffer, {
        transfer: [c.capture.image.data.buffer],
      });
      await work.promise;
      h.recycle(moved);
    });
    const h = harness(handler);
    h.loop.start();
    await vi.advanceTimersByTimeAsync(650);
    expect(handler).toHaveBeenCalledOnce();
    expect(h.capture.mock.calls.length).toBeGreaterThan(4);
    expect(h.allocate).toHaveBeenCalledTimes(2);
    expect(context.history.status).toMatchObject({
      open: true,
      recordedFrames: 6,
    });
    expect(context.history.status.bytes).toBe(6 * 64 * 64);
    expect(
      context.history.drain(context.historyToken)!.map((f) => f.frameId),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    await vi.advanceTimersByTimeAsync(120);
    expect(
      context.history.drain(context.historyToken)!.map((f) => f.frameId),
    ).toEqual([7]);
    h.loop.dispose();
    work.resolve();
    await Promise.resolve();
  });
  it("drops late work after pause, resumes without overlapping it, and never restarts after stop", async () => {
    vi.useFakeTimers();
    const work = pending();
    let context!: LiveCaptureContext;
    let durable = 0;
    const handler = vi.fn(async (c: LiveCaptureContext) => {
      context = c;
      await work.promise;
      if (c.isCurrent()) durable++;
    });
    const h = harness(handler);
    h.loop.start();
    await vi.advanceTimersByTimeAsync(150);
    h.loop.pause();
    const count = h.capture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.capture).toHaveBeenCalledTimes(count);
    expect(context.isCurrent()).toBe(false);
    expect(context.history.status.bytes).toBe(0);
    h.loop.resume();
    await vi.advanceTimersByTimeAsync(250);
    expect(handler).toHaveBeenCalledOnce();
    h.loop.dispose();
    work.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect(durable).toBe(0);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });
  it("withholds the previous frame while a newer source readback is pending", async () => {
    vi.useFakeTimers();
    const work = pending(),
      readback = pending();
    let context!: LiveCaptureContext;
    const h = harness(async (c) => {
      context = c;
      await work.promise;
    });
    const original = h.capture.getMockImplementation()!;
    let captures = 0;
    h.capture.mockImplementation(async (...args) => {
      captures++;
      if (captures === 4) await readback.promise;
      return original(...args);
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(context.latest()?.frameId).toBe(3);
    await vi.advanceTimersByTimeAsync(120);
    expect(captures).toBe(4);
    expect(context.isCurrent()).toBe(true);
    expect(context.latest()).toBeUndefined();
    expect(context.history.status.recordedFrames).toBe(3);
    readback.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.latest()?.frameId).toBe(4);
    expect(context.history.status.recordedFrames).toBe(4);
    h.loop.dispose();
    work.resolve();
  });
  it("cancels old history on page/source interruption without inventing new observations", async () => {
    vi.useFakeTimers();
    const work = pending();
    let context!: LiveCaptureContext;
    const h = harness(async (c) => {
      context = c;
      await work.promise;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(250);
    h.loop.interrupt();
    expect(context.isCurrent()).toBe(false);
    expect(context.latest()).toBeUndefined();
    expect(context.history.status.open).toBe(false);
    h.loop.dispose();
    work.resolve();
  });
  it("withholds current evidence immediately when the bound source becomes unusable", async () => {
    vi.useFakeTimers();
    const work = pending();
    let context!: LiveCaptureContext,
      saves = 0;
    const h = harness(async (c) => {
      context = c;
      await work.promise;
      if (c.isCurrent() && c.latest()) saves++;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(context.latest()?.frameId).toBe(3);
    h.source.current = false;
    expect(context.isCurrent()).toBe(false);
    expect(context.latest()).toBeUndefined();
    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toBe(0);
    h.loop.dispose();
  });
  it("halts capture on history overflow rather than dropping samples or queuing raw frames", async () => {
    vi.useFakeTimers();
    const work = pending();
    let context!: LiveCaptureContext;
    const h = harness(async (c) => {
      context = c;
      await work.promise;
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(context.history.status).toMatchObject({
      open: false,
      bytes: 0,
      reason: "history-overflow",
    });
    const captures = h.capture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.capture).toHaveBeenCalledTimes(captures);
    expect(h.allocate).toHaveBeenCalledTimes(2);
    h.loop.dispose();
    work.resolve();
  });
  it("reports a pipeline error once and stops scheduling", async () => {
    vi.useFakeTimers();
    const h = harness(async () => {
      throw new Error("failed proof transport");
    });
    h.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.capture).toHaveBeenCalledOnce();
    h.loop.dispose();
  });
  it("handles a late pending camera copy after disposal without starting model work", async () => {
    vi.useFakeTimers();
    const work = pending();
    const handler = vi.fn(async () => {});
    const h = harness(handler);
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementationOnce(async (...args) => {
      await work.promise;
      return original(...args);
    });
    h.loop.start();
    h.loop.dispose();
    work.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).not.toHaveBeenCalled();
    expect(h.capture).toHaveBeenCalledOnce();
  });
});

describe("typed-array grayscale sampling", () => {
  it("area-averages subpixel texture instead of aliasing a one-pixel translation", () => {
    const width = 1280,
      height = 960;
    const sample = (phase: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = (x + y + phase) % 2 ? 255 : 0;
          data[i + 3] = 255;
        }
      return grayscaleSample(
        { width, height, data },
        phase + 1,
        1000 + phase * 200,
      );
    };
    const first = sample(0),
      shifted = sample(1);
    expect(first.gray.every((value) => value === 128)).toBe(true);
    expect(shifted.gray).toEqual(first.gray);
  });
  it("uses clamped binomial borders and rounds only after the vertical pass", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data[0] = 255;
    const frame = grayscaleSample({ width: 4, height: 4, data }, 1, 1000);
    expect(Array.from(frame.gray)).toEqual([
      43, 14, 0, 0, 14, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(data[0]).toBe(255);
  });
  it("preserves coordinate aspect ratio, bounds memory, and uses deterministic RGB luminance", () => {
    const pixels = new Uint8ClampedArray(1280 * 960 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 3] = 255;
    }
    const frame = grayscaleSample(
      { width: 1280, height: 960, data: pixels },
      12,
      1234,
    );
    expect(frame).toMatchObject({
      width: 640,
      height: 480,
      frameId: 12,
      timestampMs: 1234,
    });
    expect(frame.gray.byteLength).toBe(307200);
    expect(frame.gray.every((value) => value === 77)).toBe(true);
  });
});
