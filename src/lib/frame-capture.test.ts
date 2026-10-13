import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CaptureCompatibilityError,
  CaptureFrameExpiredError,
  CaptureFreshnessError,
  CaptureRateLimitError,
  CaptureResolutionError,
  FrameCapture,
} from "./frame-capture";
import { LiveCaptureLoop } from "./live-capture";

function video(width = 900, height = 1200, automatic = true, now = () => 1000) {
  let nextId = 0;
  let presentedFrames = 0;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  const present = (
    metadata: Partial<VideoFrameCallbackMetadata> = {},
    callbackAt = now(),
  ) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    presentedFrames++;
    const sample = {
      presentedFrames,
      mediaTime: presentedFrames / 30,
      presentationTime: now(),
      expectedDisplayTime: now(),
      width,
      height,
      ...metadata,
    } as VideoFrameCallbackMetadata;
    for (const callback of pending) callback(callbackAt, sample);
  };
  const requestVideoFrameCallback = vi.fn(
    (callback: VideoFrameRequestCallback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      if (automatic)
        queueMicrotask(() => {
          if (callbacks.has(id)) present();
        });
      return id;
    },
  );
  const cancelVideoFrameCallback = vi.fn((id: number) => callbacks.delete(id));
  return Object.assign(new EventTarget(), {
    videoWidth: width,
    videoHeight: height,
    readyState: 2,
    paused: false,
    ended: false,
    muted: true,
    srcObject: null,
    src: "",
    currentSrc: "",
    requestVideoFrameCallback,
    cancelVideoFrameCallback,
    present,
    callbacks,
  }) as unknown as HTMLVideoElement & {
    present: typeof present;
    callbacks: typeof callbacks;
    requestVideoFrameCallback: typeof requestVideoFrameCallback;
    cancelVideoFrameCallback: typeof cancelVideoFrameCallback;
  };
}
function harness(readbackOffset = 0) {
  let clock = 1000;
  const frames: {
    close: ReturnType<typeof vi.fn>;
    source: CanvasImageSource;
    init: VideoFrameInit;
  }[] = [];
  const behavior = {
    copy: undefined as undefined | (() => Promise<void>),
    allocationDelta: 0,
    badLayout: false,
  };
  class Frame {
    close = vi.fn();
    constructor(
      readonly source: CanvasImageSource,
      readonly init: VideoFrameInit,
    ) {
      frames.push(this);
    }
    allocationSize(options: VideoFrameCopyToOptions) {
      return (
        options.layout![0].stride *
          (this.source as HTMLVideoElement).videoHeight +
        behavior.allocationDelta
      );
    }
    async copyTo(buffer: ArrayBuffer, options: VideoFrameCopyToOptions) {
      await behavior.copy?.();
      new Uint8Array(buffer).fill(127);
      return behavior.badLayout ? [{ offset: 4, stride: 1 }] : options.layout!;
    }
  }
  const getImageData = vi.fn(
    (_: number, __: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
  );
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage: vi.fn(), getImageData })),
  } as unknown as HTMLCanvasElement;
  const createCanvas = vi.fn(() => canvas);
  const capture = new FrameCapture({
    frameConstructor: Frame as unknown as typeof VideoFrame,
    createCanvas,
    now: () => clock + readbackOffset,
    frameNow: () => clock,
  });
  const takeBuffer = vi.fn((bytes: number) => new ArrayBuffer(bytes));
  return {
    capture,
    frames,
    behavior,
    canvas,
    createCanvas,
    getImageData,
    takeBuffer,
    tick: (ms = 1100) => {
      clock += ms;
    },
    now: () => clock,
    video: (width = 900, height = 1200, automatic = true) =>
      video(width, height, automatic, () => clock),
  };
}

afterEach(() => vi.useRealTimers());

describe("bounded camera frame capture", () => {
  it("copies directly from the video into caller-owned RGBA without allocating ImageData or a canvas", async () => {
    const h = harness(),
      source = h.video();
    const pixels = await h.capture.capture(source, 1920, h.takeBuffer);
    expect(pixels).toMatchObject({
      capturedAt: 1000,
      transport: "videoframe-pool",
      image: { width: 900, height: 1200 },
    });
    expect(pixels.image.data.byteLength).toBe(4_320_000);
    expect(pixels.image.data[0]).toBe(127);
    expect(h.takeBuffer).toHaveBeenCalledWith(4_320_000);
    expect(h.frames[0].source).toBe(source);
    expect(h.frames[0].init.timestamp).toBe(33333);
    expect(pixels.sourceFrame).toEqual({
      presentedFrames: 1,
      mediaTime: 1 / 30,
      presentationTime: 1000,
      callbackAt: 1000,
    });
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.createCanvas).not.toHaveBeenCalled();
    h.capture.dispose();
    expect(h.frames[0].close).toHaveBeenCalledOnce();
  });
  it("can refill a round-tripped buffer without retaining a second pixel buffer", async () => {
    const h = harness();
    const source = h.video(64, 64);
    let buffer = new ArrayBuffer(64 * 64 * 4);
    for (let i = 0; i < 4; i++) {
      const result = await h.capture.capture(source, 1920, () => buffer);
      expect(result.image.data.buffer).toBe(buffer);
      buffer = structuredClone(buffer, { transfer: [buffer] });
      expect(result.image.data.byteLength).toBe(0);
    }
    expect(h.frames).toHaveLength(4);
    expect(h.frames.every((f) => f.close.mock.calls.length === 1)).toBe(true);
  });
  it("rejects ignored camera constraints instead of silently using the high-memory resized-canvas route", async () => {
    const h = harness();
    await expect(
      h.capture.capture(h.video(3840, 2160), 1920, h.takeBuffer),
    ).rejects.toBeInstanceOf(CaptureResolutionError);
    expect(h.frames).toHaveLength(0);
    expect(h.createCanvas).not.toHaveBeenCalled();
  });
  it.each(["allocation", "buffer", "layout"] as const)(
    "closes a frame after invalid %s data and does not retry endlessly",
    async (kind) => {
      const h = harness();
      if (kind === "allocation") h.behavior.allocationDelta = 4;
      if (kind === "layout") h.behavior.badLayout = true;
      if (kind === "buffer") h.takeBuffer.mockReturnValue(new ArrayBuffer(0));
      await expect(
        h.capture.capture(h.video(), 1920, h.takeBuffer),
      ).rejects.toThrow();
      expect(h.frames[0].close).toHaveBeenCalledOnce();
      expect(h.createCanvas).not.toHaveBeenCalled();
    },
  );
  it("closes in-flight resources immediately on cancellation and discards the late result", async () => {
    const h = harness();
    const source = h.video();
    let release!: () => void;
    h.behavior.copy = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toThrow(
      /in flight/,
    );
    h.capture.dispose();
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    release();
    await expect(result).rejects.toThrow(/closed/);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toThrow(
      /closed/,
    );
  });
  it("falls back only once when exposed WebCodecs lacks RGBA copy and enforces reduced rate/resolution", async () => {
    const h = harness();
    const source = h.video();
    h.behavior.copy = async () => {
      throw new DOMException("RGBA unavailable", "NotSupportedError");
    };
    const result = await h.capture.capture(source, 1920, h.takeBuffer);
    expect(result).toMatchObject({
      transport: "compatibility",
      image: { width: 720, height: 960 },
    });
    expect(h.capture.minimumIntervalMs).toBe(1000);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    await expect(
      h.capture.capture(source, 1920, h.takeBuffer),
    ).rejects.toBeInstanceOf(CaptureRateLimitError);
    h.tick();
    await h.capture.capture(source, 1920, h.takeBuffer);
    expect(h.frames).toHaveLength(1);
    h.capture.dispose();
    expect(h.canvas.width).toBe(0);
  });
  it("stops compatibility capture at its cumulative allocation budget", async () => {
    const h = harness();
    const capture = new FrameCapture({
      frameConstructor: undefined,
      createCanvas: h.createCanvas,
      now: h.now,
    });
    const source = video();
    let frames = 0;
    for (; frames < 30; frames++) {
      try {
        await capture.capture(source, 1920, h.takeBuffer);
      } catch (error) {
        expect(error).toBeInstanceOf(CaptureCompatibilityError);
        break;
      }
      h.tick();
    }
    expect(frames).toBe(7);
    expect(h.takeBuffer).not.toHaveBeenCalled();
    await expect(
      capture.capture(source, 1920, h.takeBuffer),
    ).rejects.toBeInstanceOf(CaptureCompatibilityError);
  });
  it("bounds even tiny compatibility captures by frame count", async () => {
    const h = harness();
    const capture = new FrameCapture({
      frameConstructor: undefined,
      createCanvas: h.createCanvas,
      now: h.now,
    });
    const source = video(64, 64);
    for (let i = 0; i < 24; i++) {
      await capture.capture(source, 1920, h.takeBuffer);
      h.tick();
    }
    await expect(
      capture.capture(source, 1920, h.takeBuffer),
    ).rejects.toBeInstanceOf(CaptureCompatibilityError);
  });
});

describe("native camera source freshness", () => {
  it("does not turn successful reads of constant callback metadata into fresh samples", async () => {
    const h = harness();
    const source = h.video(64, 64, false);
    const first = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: 10, mediaTime: 1 });
    await expect(first).resolves.toMatchObject({
      transport: "videoframe-pool",
    });
    for (let i = 0; i < 4; i++) {
      h.tick(150);
      const repeated = h.capture.capture(source, 1920, h.takeBuffer);
      // Callback and readback clocks are new, but the camera image is not.
      source.present({ presentedFrames: 10, mediaTime: 1 });
      await expect(repeated).rejects.toBeInstanceOf(CaptureFreshnessError);
    }
    expect(h.frames).toHaveLength(1);
    expect(h.takeBuffer).toHaveBeenCalledOnce();
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.createCanvas).not.toHaveBeenCalled();
    expect(h.capture.transport).toBe("videoframe-pool");
  });

  it.each([
    { presentedFrames: 10, mediaTime: 2 },
    { presentedFrames: 11, mediaTime: 1 },
    { presentedFrames: 9, mediaTime: 2 },
    { presentedFrames: 11, mediaTime: 0.5 },
    { presentedFrames: NaN, mediaTime: 2 },
    { presentedFrames: 11, mediaTime: NaN },
    { presentedFrames: 10.5, mediaTime: 2 },
  ])(
    "rejects duplicate, regressing or invalid native metadata: %j",
    async (metadata) => {
      const h = harness();
      const source = h.video(64, 64, false);
      const first = h.capture.capture(source, 1920, h.takeBuffer);
      source.present({ presentedFrames: 10, mediaTime: 1 });
      await first;
      h.tick(150);
      const next = h.capture.capture(source, 1920, h.takeBuffer);
      source.present(metadata);
      await expect(next).rejects.toThrow(/repeated or regressed/);
      expect(h.frames).toHaveLength(1);
      expect(h.createCanvas).not.toHaveBeenCalled();
    },
  );

  it("accepts strictly advancing native frames while keeping source and readback clocks separate", async () => {
    const epoch = 1_700_000_000_000;
    const h = harness(epoch);
    const source = h.video(64, 64, false);
    for (let i = 0; i < 3; i++) {
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      source.present({ presentedFrames: 10 + i, mediaTime: 25 + i / 30 });
      const pixels = await result;
      expect(pixels.capturedAt).toBe(epoch + 1000 + i * 150);
      expect(pixels.sourceFrame).toMatchObject({
        presentedFrames: 10 + i,
        mediaTime: 25 + i / 30,
      });
      expect(h.frames[i].init.timestamp).toBe(
        Math.round((25 + i / 30) * 1_000_000),
      );
      h.tick(150);
    }
    expect(h.frames).toHaveLength(3);
    expect(h.createCanvas).not.toHaveBeenCalled();
  });

  it.each(["requestVideoFrameCallback", "cancelVideoFrameCallback"] as const)(
    "uses bounded compatibility without %s and emits no native source proof",
    async (missing) => {
      const h = harness();
      const source = h.video();
      Object.assign(source, { [missing]: undefined });
      const pixels = await h.capture.capture(source, 1920, h.takeBuffer);
      expect(pixels.transport).toBe("compatibility");
      expect(pixels.sourceFrame).toBeUndefined();
      expect(h.capture.minimumIntervalMs).toBe(1000);
      expect(h.frames).toHaveLength(0);
      expect(h.takeBuffer).not.toHaveBeenCalled();
      expect(h.createCanvas).toHaveBeenCalledOnce();
      await expect(
        h.capture.capture(source, 1920, h.takeBuffer),
      ).rejects.toBeInstanceOf(CaptureRateLimitError);
    },
  );

  it("times out a stalled callback, cancels it and releases the single-flight lock", async () => {
    vi.useFakeTimers();
    const h = harness();
    const source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    const rejected = expect(result).rejects.toThrow(
      /stopped supplying fresh frames/,
    );
    expect(h.capture.busy).toBe(true);
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toThrow(
      /in flight/,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(h.capture.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(source.cancelVideoFrameCallback).toHaveBeenCalledExactlyOnceWith(1);
    expect(source.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.capture.busy).toBe(false);
    expect(h.frames).toHaveLength(0);
    const retry = h.capture.capture(source, 1920, h.takeBuffer);
    source.present();
    await retry;
    expect(h.frames).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the callback and timeout on disposal and ignores a late callback", async () => {
    vi.useFakeTimers();
    const h = harness();
    const source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    const callback = source.callbacks.get(1)!;
    h.capture.dispose();
    await expect(result).rejects.toThrow(/closed/);
    expect(source.cancelVideoFrameCallback).toHaveBeenCalledExactlyOnceWith(1);
    expect(source.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    callback(1000, {
      presentedFrames: 1,
      mediaTime: 1,
      presentationTime: 1000,
    } as VideoFrameCallbackMetadata);
    await Promise.resolve();
    expect(h.frames).toHaveLength(0);
    expect(h.takeBuffer).not.toHaveBeenCalled();
    expect(h.capture.busy).toBe(false);
    expect(h.capture.isSourceCurrent()).toBe(false);
    h.capture.dispose();
    expect(source.cancelVideoFrameCallback).toHaveBeenCalledOnce();
  });

  it.each(["paused", "ended"] as const)(
    "rejects %s video before requesting a callback",
    async (state) => {
      const h = harness();
      const source = h.video();
      Object.assign(source, { [state]: true });
      await expect(
        h.capture.capture(source, 1920, h.takeBuffer),
      ).rejects.toThrow(/paused or has ended/);
      expect(source.requestVideoFrameCallback).not.toHaveBeenCalled();
      expect(h.capture.isSourceCurrent()).toBe(false);
      expect(h.frames).toHaveLength(0);
    },
  );

  it.each(["pause", "ended"])(
    "cancels a pending callback on a %s event",
    async (event) => {
      vi.useFakeTimers();
      const h = harness();
      const source = h.video(64, 64, false);
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      Object.assign(
        source,
        event === "pause" ? { paused: true } : { ended: true },
      );
      source.dispatchEvent(new Event(event));
      await expect(result).rejects.toThrow(/paused or has ended/);
      expect(source.cancelVideoFrameCallback).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.capture.isSourceCurrent()).toBe(false);
      expect(h.frames).toHaveLength(0);
    },
  );

  it.each([{ muted: true }, { enabled: false }, { readyState: "ended" }])(
    "rejects unusable MediaStream tracks, even with advancing callbacks: %j",
    async (state) => {
      const h = harness();
      const source = h.video(64, 64, false);
      const track = { muted: false, enabled: true, readyState: "live" };
      source.srcObject = {
        getVideoTracks: () => [track],
      } as unknown as MediaStream;
      const first = h.capture.capture(source, 1920, h.takeBuffer);
      source.present();
      await first;
      expect(source.muted).toBe(true); // Audio-muted previews remain valid.
      expect(h.capture.isSourceCurrent()).toBe(true);
      const next = h.capture.capture(source, 1920, h.takeBuffer);
      Object.assign(track, state);
      expect(h.capture.isSourceCurrent()).toBe(false);
      source.present();
      await expect(next).rejects.toThrow(/track is muted, disabled or ended/);
      expect(h.frames).toHaveLength(1);
    },
  );

  it.each([
    "callback",
    "presentation",
    "future callback",
    "future presentation",
  ])(
    "rejects stale or future %s timestamps without trusting the readback clock",
    async (kind) => {
      const h = harness();
      const source = h.video(64, 64, false);
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      const callbackAt =
        kind === "callback" ? 749 : kind === "future callback" ? 1001 : 1000;
      const presentationTime =
        kind === "presentation"
          ? 749
          : kind === "future presentation"
            ? 1001
            : 1000;
      source.present({ presentationTime }, callbackAt);
      await expect(result).rejects.toThrow(kind.startsWith("future") ? /future native frame timestamps/ : /stale frame callback/);
      expect(h.frames).toHaveLength(0);
      expect(h.createCanvas).not.toHaveBeenCalled();
    },
  );

  it("rejects a readback that completes after its source frame expires", async () => {
    const h = harness();
    h.behavior.copy = async () => {
      h.tick(251);
    };
    await expect(
      h.capture.capture(h.video(), 1920, h.takeBuffer),
    ).rejects.toThrow(/stale frame callback/);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.createCanvas).not.toHaveBeenCalled();
  });

  it.each(["callback", "presentation", "both"] as const)("distinguishes age-only %s expiry at the exact 250 ms boundary", async (kind) => {
    for (const age of [250, 251]) {
      const h = harness(), source = h.video(64, 64, false);
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      source.present({ presentationTime: kind === "callback" ? 1000 : 1000 - age }, kind === "presentation" ? 1000 : 1000 - age);
      if (age === 250) await expect(result).resolves.toMatchObject({ transport: "videoframe-pool" });
      else {
        const error = await result.catch(error => error);
        expect(error).toBeInstanceOf(CaptureFrameExpiredError);
        expect(error).toBeInstanceOf(CaptureFreshnessError);
        expect(error.expiry).toMatchObject({ stage: "callback", checkedAt: 1000, callbackAgeMs: kind === "presentation" ? 0 : age, presentationAgeMs: kind === "callback" ? 0 : age });
        expect(Object.isFrozen(error.expiry)).toBe(true);
        expect(Object.isFrozen(error.expiry.sourceFrame)).toBe(true);
        expect(Object.keys(error.expiry).sort()).toEqual(["callbackAgeMs", "checkedAt", "presentationAgeMs", "sourceFrame", "stage"]);
        expect(h.frames).toHaveLength(0);
        expect(h.takeBuffer).not.toHaveBeenCalled();
      }
      h.capture.dispose();
    }
  });

  it.each([
    { now: 524.3999999761581, callbackAt: 520.6, presentationTime: 524.4, presentedFrames: 6, mediaTime: .397014 },
    { now: 2356.699999988079, callbackAt: 2353.58, presentationTime: 2356.7, presentedFrames: 27, mediaTime: 2.166667 },
  ])("accepts the observed native subtraction residue without rewriting source evidence: %j", async sample => {
    const h = harness(), source = h.video(64, 64, false);
    h.tick(sample.now - h.now()); expect(h.now()).toBe(sample.now);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.present(sample, sample.callbackAt);
    const pixels = await result;
    expect(pixels.capturedAt).toBe(sample.now);
    expect(pixels.sourceFrame).toEqual({ presentedFrames: sample.presentedFrames, mediaTime: sample.mediaTime, callbackAt: sample.callbackAt, presentationTime: sample.presentationTime });
    expect(h.capture.isSourceCurrent()).toBe(true);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    h.capture.dispose();
  });

  // At 1000 ms, one double ULP is 2^-43 ms. All these offsets are exactly
  // representable, including the very next double beyond the correction bound.
  it.each([
    { lead: 2 ** -24 - 2 ** -43, accepted: true },
    { lead: 2 ** -24, accepted: true },
    { lead: 2 ** -24 + 2 ** -43, accepted: false },
    { lead: 1e-6, accepted: false },
    { lead: .0001, accepted: false },
    { lead: .1, accepted: false },
    { lead: 1, accepted: false },
  ])("bounds only presentation arithmetic equality: %j", async ({ lead, accepted }) => {
    const h = harness(), source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentationTime: 1000 + lead }, 1000);
    if (accepted) {
      const pixels = await result;
      expect(pixels.sourceFrame!.presentationTime).toBe(1000 + lead);
      expect(h.capture.isSourceCurrent()).toBe(true);
    } else {
      const error = await result.catch(error => error);
      expect(error).toBeInstanceOf(CaptureFreshnessError);
      expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
      expect(error.message).toMatch(/future native frame timestamps/);
      expect(h.frames).toHaveLength(0);
    }
    h.capture.dispose();
  });

  it("keeps even a one-ULP future callback timestamp strictly fatal", async () => {
    const h = harness(), source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentationTime: 1000 }, 1000 + 2 ** -43);
    const error = await result.catch(error => error);
    expect(error).toBeInstanceOf(CaptureFreshnessError);
    expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    expect(error.message).toMatch(/future native frame timestamps/);
    expect(h.frames).toHaveLength(0); h.capture.dispose();
  });

  it.each(["clock", "callback", "presentation"] as const)("keeps even one-ULP %s regression strictly fatal", async kind => {
    const h = harness(), source = h.video(64, 64, false);
    const first = h.capture.capture(source, 1920, h.takeBuffer); source.present(); await first;
    if (kind === "clock") h.tick(-(2 ** -43));
    const next = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentationTime: kind === "presentation" ? 1000 - 2 ** -43 : 1000 }, kind === "callback" ? 1000 - 2 ** -43 : 1000);
    const error = await next.catch(error => error);
    expect(error).toBeInstanceOf(CaptureFreshnessError);
    expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    expect(error.message).toMatch(/regressed/);
    expect(h.frames).toHaveLength(1); h.capture.dispose();
  });

  it("does not relax native identity advancement for numerical-equality captures", async () => {
    const h = harness(), source = h.video(64, 64, false);
    const metadata = { presentedFrames: 10, mediaTime: 1, presentationTime: 1000 + 2 ** -24 };
    const first = h.capture.capture(source, 1920, h.takeBuffer); source.present(metadata, 1000); await first;
    const repeated = h.capture.capture(source, 1920, h.takeBuffer); source.present(metadata, 1000);
    await expect(repeated).rejects.toThrow(/repeated or regressed/);
    expect(h.frames).toHaveLength(1); h.capture.dispose();
  });

  it("keeps source replacement fatal before applying numerical equality", async () => {
    const h = harness(), source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.src = "replacement";
    source.present({ presentationTime: 1000 + 2 ** -24 }, 1000);
    await expect(result).rejects.toThrow(/source changed/);
    expect(h.frames).toHaveLength(0); h.capture.dispose();
  });

  it.each(["before-copy", "after-copy"] as const)("keeps the 250 ms age gate strict to one ULP at %s", async stage => {
    const h = harness(), source = h.video(64, 64, false);
    const advance = () => h.tick(250 + 2 ** -42); // One ULP above 1250 ms.
    if (stage === "after-copy") h.behavior.copy = async () => advance();
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.present();
    if (stage === "before-copy") advance();
    await expect(result).rejects.toMatchObject({ name: "CaptureFrameExpiredError", expiry: { stage } });
    expect(h.frames).toHaveLength(stage === "after-copy" ? 1 : 0);
    if (stage === "after-copy") expect(h.frames[0].close).toHaveBeenCalledOnce();
    h.capture.dispose();
  });

  it.each([NaN, Infinity, -1, 1001])("keeps invalid/future timestamps fatal even when the other timestamp expired: %s", async invalid => {
    for (const field of ["callback", "presentation"] as const) {
      const h = harness(), source = h.video(64, 64, false);
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      source.present({ presentationTime: field === "presentation" ? invalid : 749 }, field === "callback" ? invalid : 749);
      const error = await result.catch(error => error);
      expect(error).toBeInstanceOf(CaptureFreshnessError);
      expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
      expect(h.frames).toHaveLength(0);
      h.capture.dispose();
    }
  });

  it("consumes an expired callback identity without treating it as live-current proof", async () => {
    const h = harness(), source = h.video(64, 64, false);
    const expired = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: 10, mediaTime: 1, presentationTime: 749 }, 749);
    await expect(expired).rejects.toBeInstanceOf(CaptureFrameExpiredError);
    expect(h.capture.isSourceCurrent()).toBe(false);
    const repeated = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: 10, mediaTime: 1 });
    const error = await repeated.catch(error => error);
    expect(error).toBeInstanceOf(CaptureFreshnessError);
    expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    expect(h.frames).toHaveLength(0);
    const fresh = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: 11, mediaTime: 1.1 });
    await expect(fresh).resolves.toMatchObject({ sourceFrame: { presentedFrames: 11, mediaTime: 1.1 } });
    expect(source.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
    expect(h.capture.isSourceCurrent()).toBe(true);
    h.capture.dispose();
  });

  it.each([NaN, Infinity, -1])("keeps an invalid monotonic check clock fatal: %s", async now => {
    const h = harness(), source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    h.tick(now - 1000); source.present({ presentationTime: 749 }, 749);
    const error = await result.catch(error => error);
    expect(error).toBeInstanceOf(CaptureFreshnessError);
    expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    expect(error.message).toMatch(/clock is invalid/);
    expect(h.frames).toHaveLength(0); h.capture.dispose();
  });

  it.each(["counter", "media", "callback", "presentation", "clock"] as const)("keeps regressing %s fatal even when a frame has expired", async kind => {
    const h = harness(), source = h.video(64, 64, false);
    const first = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: 10, mediaTime: 1 }); await first;
    h.tick(500);
    const next = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentedFrames: kind === "counter" ? 10 : 11, mediaTime: kind === "media" ? 1 : 2, presentationTime: kind === "presentation" ? 999 : 1000 }, kind === "callback" ? 999 : 1000);
    if (kind === "clock") {
      // The previous callback was valid but expired at 1500; checking at 1499
      // must not turn a backwards check clock into another retryable expiry.
      await expect(next).rejects.toBeInstanceOf(CaptureFrameExpiredError);
      h.tick(-1);
      const backwards = h.capture.capture(source, 1920, h.takeBuffer);
      source.present({ presentedFrames: 12, mediaTime: 3, presentationTime: 1000 }, 1000);
      const error = await backwards.catch(error => error);
      expect(error).toBeInstanceOf(CaptureFreshnessError);
      expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    } else {
      const error = await next.catch(error => error);
      expect(error).toBeInstanceOf(CaptureFreshnessError);
      expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    }
    expect(h.frames).toHaveLength(1);
    h.capture.dispose();
  });

  it("discards expiry before copy and requests an entirely new callback", async () => {
    const h = harness(), source = h.video(64, 64, false);
    const expired = h.capture.capture(source, 1920, h.takeBuffer);
    source.present(); h.tick(251);
    await expect(expired).rejects.toMatchObject({ expiry: { stage: "before-copy" } });
    expect(h.frames).toHaveLength(0);
    const next = h.capture.capture(source, 1920, h.takeBuffer);
    expect(source.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    source.present(); await next;
    expect(h.frames).toHaveLength(1);
    h.capture.dispose();
  });

  it("closes and discards an expired readback without retaining pixels in its metadata", async () => {
    const h = harness(), source = h.video(64, 64);
    h.behavior.copy = async () => h.tick(251);
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toMatchObject({ expiry: { stage: "after-copy", callbackAgeMs: 251, presentationAgeMs: 251 } });
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.capture.busy).toBe(false);
    expect(h.capture.isSourceCurrent()).toBe(false);
    h.behavior.copy = undefined;
    const next = await h.capture.capture(source, 1920, h.takeBuffer);
    expect(next.sourceFrame!.presentedFrames).toBe(2);
    expect(h.frames).toHaveLength(2);
    expect(h.frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
    h.capture.dispose();
  });

  it.each(["layout", "source", "paused", "ended", "muted"] as const)("does not disguise a %s failure as recoverable readback expiry", async kind => {
    const h = harness(), source = h.video(64, 64);
    const track = { muted: false, enabled: true, readyState: "live" };
    source.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream;
    h.behavior.copy = async () => {
      h.tick(251);
      if (kind === "layout") h.behavior.badLayout = true;
      if (kind === "source") source.src = "replacement";
      if (kind === "paused") Object.assign(source, { paused: true });
      if (kind === "ended") Object.assign(source, { ended: true });
      if (kind === "muted") track.muted = true;
    };
    const error = await h.capture.capture(source, 1920, h.takeBuffer).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CaptureFrameExpiredError);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.createCanvas).not.toHaveBeenCalled();
    h.capture.dispose();
  });

  it("leaves Live mode fail-closed on a typed age-only acquisition failure", async () => {
    vi.useFakeTimers();
    const h = harness(), source = h.video(64, 64, false);
    const onFrame = vi.fn(async () => {}), onError = vi.fn();
    const loop = new LiveCaptureLoop({ video: source, capture: h.capture, client: { busy: false, takeFrameBuffer: h.takeBuffer }, frameLimit: 1920, onFrame, onError, onTransport: vi.fn() });
    loop.start(); source.present({ presentationTime: 749 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(CaptureFrameExpiredError);
    expect(onFrame).not.toHaveBeenCalled();
    expect(source.requestVideoFrameCallback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    loop.dispose();
  });

  it.each(["paused", "ended"] as const)(
    "rejects video that becomes %s during successful readback",
    async (state) => {
      const h = harness();
      const source = h.video();
      h.behavior.copy = async () => {
        Object.assign(source, { [state]: true });
      };
      await expect(
        h.capture.capture(source, 1920, h.takeBuffer),
      ).rejects.toThrow(/paused or has ended/);
      expect(h.frames).toHaveLength(1);
      expect(h.frames[0].close).toHaveBeenCalledOnce();
      expect(h.capture.isSourceCurrent()).toBe(false);
      expect(h.createCanvas).not.toHaveBeenCalled();
    },
  );

  it.each(["element", "srcObject", "src", "currentSrc", "track"])(
    "fails closed for a changed %s instead of resetting native counters",
    async (kind) => {
      const h = harness();
      let source = h.video(64, 64, false);
      let track = { muted: false, enabled: true, readyState: "live" };
      source.srcObject = {
        getVideoTracks: () => [track],
      } as unknown as MediaStream;
      const first = h.capture.capture(source, 1920, h.takeBuffer);
      source.present();
      await first;
      if (kind === "element") source = h.video(64, 64, false);
      if (kind === "srcObject") source.srcObject = null;
      if (kind === "src") source.src = "other-camera";
      if (kind === "currentSrc")
        Object.assign(source, { currentSrc: "other-camera" });
      if (kind === "track") track = { ...track };
      await expect(
        h.capture.capture(source, 1920, h.takeBuffer),
      ).rejects.toThrow(/source changed/);
      expect(h.capture.isSourceCurrent()).toBe(false);
      expect(h.frames).toHaveLength(1);
      expect(h.createCanvas).not.toHaveBeenCalled();
    },
  );

  it("rejects source replacement while waiting for a callback and stays invalid after restoration", async () => {
    const h = harness();
    const source = h.video(64, 64, false);
    const result = h.capture.capture(source, 1920, h.takeBuffer);
    source.src = "replacement";
    source.present();
    await expect(result).rejects.toThrow(/source changed/);
    source.src = "";
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toThrow(
      /source changed/,
    );
    expect(h.frames).toHaveLength(0);
  });

  it.each(["emptied", "loadstart"])(
    "cancels waiting and invalidates a source on %s",
    async (event) => {
      vi.useFakeTimers();
      const h = harness();
      const source = h.video(64, 64, false);
      const result = h.capture.capture(source, 1920, h.takeBuffer);
      source.dispatchEvent(new Event(event));
      await expect(result).rejects.toThrow(/source changed/);
      expect(source.cancelVideoFrameCallback).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.capture.isSourceCurrent()).toBe(false);
    },
  );

  it("rejects source replacement during successful copyTo and closes its frame", async () => {
    const h = harness();
    const source = h.video();
    h.behavior.copy = async () => {
      source.src = "replacement";
    };
    await expect(h.capture.capture(source, 1920, h.takeBuffer)).rejects.toThrow(
      /source changed/,
    );
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    expect(h.capture.isSourceCurrent()).toBe(false);
    expect(h.createCanvas).not.toHaveBeenCalled();
  });
  it("expires native presentation freshness before a delayed proof can commit", async () => {
    const h = harness(),
      source = h.video(64, 64, false);
    const pending = h.capture.capture(source, 1920, h.takeBuffer);
    source.present({ presentationTime: h.now() - 240 });
    const captured = await pending;
    expect(h.capture.isSourceCurrent()).toBe(true);
    h.tick(80);
    expect(h.now() - captured.capturedAt).toBe(80);
    expect(h.now() - captured.sourceFrame!.presentationTime).toBe(320);
    expect(h.capture.isSourceCurrent()).toBe(false);
    const next = h.capture.capture(source, 1920, h.takeBuffer);
    source.present();
    await next;
    expect(h.capture.isSourceCurrent()).toBe(true);
    h.capture.dispose();
  });
});
