import { afterEach, describe, expect, it, vi } from "vitest";
import { PACK_MAX_BYTES, PackCaptureLoop, PackCaptureQueue } from "./pack-capture";
import type { CapturedPixels } from "./frame-capture";
import { CaptureFrameExpiredError, CaptureFreshnessError } from "./frame-capture";
import type { VisionResult } from "./vision";

function capture(frame: number, level = 100, width = 64, height = 64): CapturedPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = level; data[i + 1] = level; data[i + 2] = level; data[i + 3] = 255; }
  return { image: { width, height, data }, capturedAt: frame * 120, transport: "videoframe-pool", sourceFrame: { presentedFrames: frame, mediaTime: frame * .12, presentationTime: frame * 120, callbackAt: frame * 120 } };
}
function detailed(frame: number, contrast: number) {
  const item = capture(frame);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const value = 100 + (((x >> 1) + (y >> 1)) % 2 ? contrast : -contrast);
    for (let c = 0; c < 3; c++) item.image.data[(y * 64 + x) * 4 + c] = value;
  }
  return item;
}
const result = (): VisionResult => ({ width: 64, height: 64, detections: [], timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 }, coverage: { totalReferences: 1, byGame: { pokemon: 1, mtg: 0, yugioh: 0 }, packs: [] }, budgetExhausted: false, detectionComplete: true });
afterEach(() => vi.useRealTimers());

describe("bounded immutable pack queue", () => {
  it("transfers ownership once, freezes source provenance and counts a detached in-flight buffer", () => {
    const queue = new PackCaptureQueue("pack", "camera"), input = capture(1), alias = input.image.data;
    const admitted = queue.offer(input, 125);
    expect(admitted.accepted).toBe(true); expect(alias.byteLength).toBe(0);
    expect(Object.isFrozen(admitted.view)).toBe(true); expect(Object.isFrozen(admitted.view.sourceFrame)).toBe(true);
    input.sourceFrame = capture(5).sourceFrame;
    const lease = queue.claim(130)!;
    expect(lease.view.sourceFrame.presentedFrames).toBe(1);
    const moved = structuredClone(lease.image.data.buffer, { transfer: [lease.image.data.buffer] });
    expect(lease.image.data.byteLength).toBe(0); expect(queue.stats.retainedBytes).toBe(moved.byteLength);
    expect(queue.claim()).toBeUndefined(); expect(queue.finish(lease)).toBe(true); expect(queue.finish(lease)).toBe(false);
    expect(queue.stats.retainedBytes).toBe(0);
  });
  it("never exceeds queue count or bytes under worker backpressure, and reports every overflow", () => {
    const bytes = 64 * 64 * 4, queue = new PackCaptureQueue("pack", "camera", { maxViews: 3, maxBytes: bytes * 3 });
    queue.offer(capture(1, 20), 120); const active = queue.claim(120)!;
    for (let frame = 2; frame <= 20; frame++) {
      queue.offer(capture(frame, frame % 2 ? 210 : 80), frame * 120);
      expect(queue.stats.retainedBytes).toBeLessThanOrEqual(bytes * 3);
      expect(queue.stats.queued + queue.stats.inFlight).toBeLessThanOrEqual(3);
      expect(queue.isCurrent(active)).toBe(true);
    }
    expect(queue.stats.omitted).toBeGreaterThan(0);
    expect(queue.stats.peakRetainedBytes).toBeLessThanOrEqual(bytes * 3);
    queue.cancel(); expect(queue.stats.retainedBytes).toBe(0); expect(queue.finish(active)).toBe(false);
  });
  it("reports overflow rather than evicting the only in-flight view", () => {
    const queue = new PackCaptureQueue("pack", "camera", { maxViews: 1, maxBytes: 64 * 64 * 4 });
    queue.offer(capture(1, 20), 120); const active = queue.claim(120)!;
    const next = capture(2, 200), rejected = queue.offer(next, 240);
    expect(rejected).toMatchObject({ accepted: false, omitted: [{ reason: "queue-overflow" }] });
    expect(next.image.data.byteLength).toBe(64 * 64 * 4); expect(queue.isCurrent(active)).toBe(true);
  });
  it("omits repeated wrapper-like views but periodically admits real fresh observations", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    queue.offer(capture(1), 120); queue.finish(queue.claim(120)!);
    for (let frame = 2; frame <= 5; frame++) expect(queue.offer(capture(frame), frame * 120)).toMatchObject({ accepted: false, omitted: [{ reason: "similar-view" }] });
    expect(queue.offer(capture(6), 720).accepted).toBe(true);
    expect(queue.stats.admitted).toBe(2); expect(queue.stats.omitted).toBe(4);
  });
  it("keeps the sharper pending near-identical view and reports replacement without asserting same-copy proof", () => {
    const queue = new PackCaptureQueue("pack", "camera");
    const initial = queue.offer(detailed(1, 4), 120);
    const improved = queue.offer(detailed(2, 8), 240);
    expect(improved.accepted).toBe(true); expect(improved.omitted).toEqual([{ captureId: initial.view.captureId, reason: "replaced-by-clearer-view" }]);
    expect(queue.offer(detailed(3, 4), 360)).toMatchObject({ accepted: false, omitted: [{ reason: "better-view-retained" }] });
    const lease = queue.claim(360)!; expect(lease.view.frameId).toBe(2); expect(lease.view.copyLineage).toBe("unproven");
  });
  it("rejects compatibility, duplicate source frames, regressing clocks and oversized backing aliases", () => {
    const queue = new PackCaptureQueue("pack", "camera"); queue.offer(capture(1), 120);
    expect(() => queue.offer(capture(1), 130)).toThrow(/regressed/);
    const repeated = capture(2); repeated.sourceFrame = capture(1).sourceFrame;
    expect(() => queue.offer(repeated, 250)).toThrow(/regressed/);
    expect(() => queue.offer({ ...capture(2), transport: "compatibility" }, 250)).toThrow(/native/);
    const aliased = capture(2); aliased.image.data = new Uint8ClampedArray(new ArrayBuffer(64 * 64 * 8), 0, 64 * 64 * 4);
    expect(() => queue.offer(aliased, 250)).toThrow(/pixels/);
    expect(() => new PackCaptureQueue("pack", "camera", { maxViews: 13, maxBytes: PACK_MAX_BYTES })).toThrow(/configuration/);
  });
  it("natural end drains admitted views whereas cancel invalidates them", () => {
    const queue = new PackCaptureQueue("pack", "camera"); queue.offer(capture(1, 20), 120); queue.offer(capture(2, 200), 240);
    queue.end(); expect(queue.offer(capture(3, 50), 360)).toMatchObject({ accepted: false, omitted: [{ reason: "closed" }] });
    expect(queue.finish(queue.claim(400)!)).toBe(true); expect(queue.finish(queue.claim(500)!)).toBe(true); expect(queue.claim()).toBeUndefined();
    expect(queue.stats.retainedBytes).toBe(0);
  });
});

function loopHarness(withTrack = false) {
  const video = new EventTarget() as HTMLVideoElement;
  Object.defineProperty(video, "ended", { value: false, writable: true });
  const track = Object.assign(new EventTarget(), { muted: false, enabled: true, readyState: "live" });
  if (withTrack) video.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream;
  let time = 0, frame = 0, pending: ((value: VisionResult) => void) | undefined;
  const client = {
    busy: false,
    takeFrameBuffer: vi.fn((bytes: number) => new ArrayBuffer(bytes)),
    analyze: vi.fn(async (image: CapturedPixels["image"]) => {
      client.busy = true;
      structuredClone(image.data.buffer, { transfer: [image.data.buffer] });
      const value = await new Promise<VisionResult>(resolve => { pending = resolve; });
      client.busy = false; return value;
    }),
  };
  const source = { minimumIntervalMs: 120 as const, dispose: vi.fn(), capture: vi.fn(async () => {
    const item = capture(++frame, frame % 2 ? 20 : 200); time = item.capturedAt; return item;
  }) };
  const callbacks = { onQueued: vi.fn(), onIdentifying: vi.fn(), onOmitted: vi.fn(), onResult: vi.fn(), onStats: vi.fn(), onError: vi.fn(), onDrained: vi.fn() };
  const loop = new PackCaptureLoop({ video, client, sessionId: "pack", sourceId: "camera", frameLimit: 1920, capture: source, now: () => time, ...callbacks });
  return { loop, client, source, callbacks, video, track, setTime: (value: number) => { time = value; }, resolve: () => { time += 50; pending?.(result()); } };
}
function expired() { return new CaptureFrameExpiredError("callback", { presentedFrames: 1, mediaTime: .12, presentationTime: 120, callbackAt: 120 }, 371); }
describe("separate pack capture lifecycle", () => {
  it("captures during one worker operation, saves captured A after B, and drains after end", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(250);
    expect(h.source.capture).toHaveBeenCalledTimes(3); expect(h.client.analyze).toHaveBeenCalledTimes(1);
    h.loop.finishCapture(); h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult.mock.calls[0][0].frameId).toBe(1);
    expect(h.client.analyze).toHaveBeenCalledTimes(2); h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.client.analyze).toHaveBeenCalledTimes(3); h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onDrained).toHaveBeenCalledOnce(); expect(h.loop.stats.retainedBytes).toBe(0);
    expect(h.callbacks.onResult.mock.calls[0][2]).toMatchObject({ queueWaitMs: 0, workerMs: 60 });
    h.loop.dispose();
  });
  it("holds completed results behind Pause and delivers only on Resume", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.loop.pause(); h.resolve(); await vi.advanceTimersByTimeAsync(500);
    expect(h.callbacks.onResult).not.toHaveBeenCalled(); expect(h.source.capture).toHaveBeenCalledOnce();
    h.loop.resume(); await vi.advanceTimersByTimeAsync(0); expect(h.callbacks.onResult).toHaveBeenCalledOnce();
    h.loop.dispose();
  });
  it("explicit disposal suppresses held or late completion and cannot restart", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(130);
    h.loop.dispose(); h.resolve(); h.loop.resume(); h.loop.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.callbacks.onResult).not.toHaveBeenCalled(); expect(h.callbacks.onDrained).not.toHaveBeenCalled(); expect(h.loop.stats.retainedBytes).toBe(0);
  });
  it("handles natural ended idempotently and propagates acquisition errors as cancellation", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.video.dispatchEvent(new Event("ended")); h.loop.finishCapture(); h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onDrained).toHaveBeenCalledOnce(); h.loop.dispose();
    const failed = loopHarness(); failed.source.capture.mockRejectedValueOnce(new Error("source replaced"));
    failed.loop.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(failed.callbacks.onError).toHaveBeenCalledOnce(); expect(failed.callbacks.onResult).not.toHaveBeenCalled();
  });
  it("pause during acquisition discards stale pixels/errors and Resume obtains a fresh view", async () => {
    vi.useFakeTimers(); const h = loopHarness();
    let reject!: (error: Error) => void;
    h.source.capture.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    h.loop.start(); await vi.advanceTimersByTimeAsync(0); h.loop.pause(); h.loop.resume();
    reject(new Error("Native video paused during frame wait")); await vi.advanceTimersByTimeAsync(130);
    expect(h.callbacks.onError).not.toHaveBeenCalled(); expect(h.callbacks.onQueued).toHaveBeenCalledOnce();
    expect(h.source.capture).toHaveBeenCalledTimes(2); h.loop.dispose();
  });
  it("source replacement cancels rather than impersonating natural completion", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.video.dispatchEvent(new Event("loadstart")); h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onError).toHaveBeenCalledOnce(); expect(h.callbacks.onResult).not.toHaveBeenCalled(); expect(h.callbacks.onDrained).not.toHaveBeenCalled();
  });
  it("a receipt admission error cancels safely before any worker request", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.callbacks.onQueued.mockImplementation(() => { throw new Error("Receipt limit"); });
    h.loop.start(); await vi.advanceTimersByTimeAsync(500);
    expect(h.callbacks.onError).toHaveBeenCalledOnce(); expect(h.client.analyze).not.toHaveBeenCalled(); expect(h.loop.stats.retainedBytes).toBe(0);
  });

  it("discards two age-only acquisitions, then schedules and queues only a fresh view", async () => {
    vi.useFakeTimers(); const h = loopHarness();
    h.source.capture.mockRejectedValueOnce(expired()).mockRejectedValueOnce(expired());
    h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.loop.stats).toMatchObject({ offered: 0, expiredAcquisitions: 1, captureRetries: 1, consecutiveExpiredAcquisitions: 1, lastCaptureExpiry: { stage: "callback", callbackAgeMs: 251 } });
    expect(h.client.analyze).not.toHaveBeenCalled(); expect(h.callbacks.onQueued).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119); expect(h.source.capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(h.source.capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.source.capture).toHaveBeenCalledTimes(3); expect(h.callbacks.onQueued).toHaveBeenCalledOnce(); expect(h.client.analyze).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({ offered: 1, expiredAcquisitions: 2, captureRetries: 2, consecutiveExpiredAcquisitions: 0 });
    expect(h.callbacks.onStats.mock.lastCall![0]).toMatchObject({ captureRetries: 2, expiredAcquisitions: 2 });
    expect(h.callbacks.onOmitted).not.toHaveBeenCalled(); expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it("fails once on the third consecutive expiry and cancels instead of retrying indefinitely", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.source.capture.mockRejectedValue(expired());
    h.loop.start(); await vi.advanceTimersByTimeAsync(2000);
    expect(h.source.capture).toHaveBeenCalledTimes(3); expect(h.source.dispose).toHaveBeenCalledOnce(); expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({ offered: 0, expiredAcquisitions: 3, captureRetries: 2, consecutiveExpiredAcquisitions: 3 });
    expect(h.client.analyze).not.toHaveBeenCalled(); expect(h.callbacks.onDrained).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds cumulative retries to eight despite intervening valid frames and Pause/Resume", async () => {
    vi.useFakeTimers(); const h = loopHarness(), normal = h.source.capture.getMockImplementation()!; let calls = 0;
    h.source.capture.mockImplementation(async () => { if (++calls % 2) throw expired(); return normal(); });
    h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.loop.pause(); await vi.advanceTimersByTimeAsync(1000); expect(calls).toBe(1);
    h.loop.resume(); await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(17); expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.loop.stats).toMatchObject({ offered: 8, expiredAcquisitions: 9, captureRetries: 8, consecutiveExpiredAcquisitions: 1, retainedBytes: 0 });
    h.resolve(); await vi.advanceTimersByTimeAsync(0); expect(h.callbacks.onResult).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset a consecutive failure budget on Pause/Resume", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.source.capture.mockRejectedValue(expired());
    h.loop.start(); await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats.captureRetries).toBe(2); h.loop.pause(); h.loop.resume(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.source.capture).toHaveBeenCalledTimes(3); expect(h.callbacks.onError).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps earlier valid worker results while dropping an expired acquisition", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.source.capture.mockRejectedValueOnce(expired()); await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({ inFlight: 1, captureRetries: 1, admitted: 1 });
    h.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.onResult).toHaveBeenCalledOnce(); expect(h.callbacks.onResult.mock.calls[0][0].frameId).toBe(1);
    await vi.advanceTimersByTimeAsync(120); expect(h.callbacks.onQueued).toHaveBeenCalledTimes(2); expect(h.callbacks.onError).not.toHaveBeenCalled();
    h.loop.dispose();
  });

  it("resets consecutive expiry after a fresh but similarity-omitted acquisition", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    h.source.capture.mockRejectedValueOnce(expired()); await vi.advanceTimersByTimeAsync(120);
    h.source.capture.mockImplementationOnce(async () => { h.setTime(240); return capture(2, 20); });
    await vi.advanceTimersByTimeAsync(120);
    expect(h.loop.stats).toMatchObject({ expiredAcquisitions: 1, captureRetries: 1, consecutiveExpiredAcquisitions: 0, offered: 2, omitted: 1 });
    expect(h.callbacks.onError).not.toHaveBeenCalled(); h.loop.dispose();
  });

  it.each([new CaptureFreshnessError("stale frame callback"), new CaptureFreshnessError("stopped supplying fresh frames"), new Error("source changed"), new Error("invalid pixel layout")])("does not recover generic fatal errors by message matching: %s", async error => {
    vi.useFakeTimers(); const h = loopHarness(); h.source.capture.mockRejectedValueOnce(error); h.loop.start(); await vi.advanceTimersByTimeAsync(2000);
    expect(h.source.capture).toHaveBeenCalledOnce(); expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.loop.stats).toMatchObject({ expiredAcquisitions: 0, captureRetries: 0 }); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a typed error thrown outside native acquisition", async () => {
    vi.useFakeTimers(); const h = loopHarness(); h.callbacks.onQueued.mockImplementation(() => { throw expired(); });
    h.loop.start(); await vi.advanceTimersByTimeAsync(2000);
    expect(h.callbacks.onError).toHaveBeenCalledOnce(); expect(h.source.capture).toHaveBeenCalledOnce(); expect(h.loop.stats.captureRetries).toBe(0);
  });

  it.each(["loadstart", "emptied", "abort", "error", "mute", "track-ended", "dispose", "natural-end"] as const)("does not restart after %s during retry backoff", async event => {
    vi.useFakeTimers(); const h = loopHarness(event === "mute" || event === "track-ended");
    h.source.capture.mockRejectedValueOnce(expired()); h.loop.start(); await vi.advanceTimersByTimeAsync(0);
    if (event === "dispose") h.loop.dispose();
    else if (event === "natural-end") { Object.assign(h.video, { ended: true }); h.video.dispatchEvent(new Event("ended")); }
    else if (event === "mute" || event === "track-ended") h.track.dispatchEvent(new Event(event === "mute" ? "mute" : "ended"));
    else h.video.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.source.capture).toHaveBeenCalledOnce(); expect(h.callbacks.onQueued).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(h.callbacks.onError).toHaveBeenCalledTimes(event === "dispose" || event === "natural-end" ? 0 : 1);
    expect(h.callbacks.onDrained).toHaveBeenCalledTimes(event === "natural-end" ? 1 : 0); h.loop.dispose();
  });

  it("ignores a late expiry from a paused epoch without granting a retry or overlapping capture", async () => {
    vi.useFakeTimers(); const h = loopHarness(); let reject!: (error: Error) => void;
    h.source.capture.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    h.loop.start(); h.loop.pause(); h.loop.resume(); await vi.advanceTimersByTimeAsync(500);
    expect(h.source.capture).toHaveBeenCalledOnce(); reject(expired()); await vi.advanceTimersByTimeAsync(120);
    expect(h.source.capture).toHaveBeenCalledTimes(2); expect(h.loop.stats).toMatchObject({ expiredAcquisitions: 0, captureRetries: 0, admitted: 1 });
    expect(h.callbacks.onError).not.toHaveBeenCalled(); h.loop.dispose();
  });

});
