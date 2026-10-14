import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVideoSource } from "./live-video-source";
import { FrameCapture } from "./frame-capture";
import { LiveCaptureLoop } from "./live-capture";
import type { LiveCaptureContext } from "./live-capture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(readyState = 1) {
  const element = Object.assign(new EventTarget(), {
    src: "",
    srcObject: null,
    currentSrc: "",
    duration: 10,
    videoWidth: 64,
    videoHeight: 64,
    readyState,
    paused: true,
    ended: false,
    error: null,
    loop: true,
    muted: false,
    autoplay: true,
    playbackRate: 2,
    currentTime: 0,
    load: vi.fn(),
    pause: vi.fn(() => {
      element.paused = true;
      element.dispatchEvent(new Event("pause"));
    }),
    play: vi.fn(async () => {
      element.paused = false;
    }),
    removeAttribute: vi.fn((name: string) => {
      if (name === "src") element.src = "";
    }),
  });
  const video = element as unknown as HTMLVideoElement;
  const ended = vi.fn(),
    failed = vi.fn();
  const source = new LiveVideoSource(video, ended, failed);
  const file = new File(["test"], "test.mp4", { type: "video/mp4" });
  return { element, video, source, file, ended, failed };
}
beforeEach(() => {
  let id = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:test-${++id}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Live local video lifecycle", () => {
  it("prepares without playback, runs at 1×, and resumes the same position and source", async () => {
    const h = fixture();
    await h.source.open(h.file, 1920);
    const url = h.element.src;
    expect(h.element.play).not.toHaveBeenCalled();
    expect(h.element).toMatchObject({
      autoplay: false,
      muted: true,
      loop: false,
    });
    expect(await h.source.play()).toBe(true);
    h.element.currentTime = 4.2;
    h.source.pause();
    expect(h.element.paused).toBe(true);
    expect(await h.source.play()).toBe(true);
    expect(h.element).toMatchObject({
      currentTime: 4.2,
      src: url,
      playbackRate: 1,
    });
    h.source.dispose();
    h.source.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(h.element.src).toBe("");
  });

  it("cancels pending metadata and removes listeners/timer without committing late setup", async () => {
    vi.useFakeTimers();
    const h = fixture(0);
    const pending = h.source.open(h.file, 1920);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    h.source.dispose();
    h.element.dispatchEvent(new Event("loadedmetadata"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(h.element.play).not.toHaveBeenCalled();
    expect(await h.source.play()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("a stale play completion cannot start capture or clear a replacement source", async () => {
    const h = fixture();
    await h.source.open(h.file, 1920);
    const pending = deferred();
    h.element.play.mockImplementationOnce(() => pending.promise);
    const playback = h.source.play();
    h.source.dispose();
    const replacement = new LiveVideoSource(h.video, vi.fn(), vi.fn());
    await replacement.open(h.file, 1920);
    const replacementUrl = h.element.src;
    pending.resolve();
    expect(await playback).toBe(false);
    h.source.dispose();
    expect(h.element.src).toBe(replacementUrl);
    replacement.dispose();
  });

  it("Pause invalidates an outstanding resume without revoking the source", async () => {
    const h = fixture();
    await h.source.open(h.file, 1920);
    const pending = deferred();
    h.element.play.mockImplementationOnce(async () => {
      await pending.promise;
      h.element.paused = false;
    });
    const playback = h.source.play();
    h.source.pause();
    pending.resolve();
    expect(await playback).toBe(false);
    expect(h.element.paused).toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    h.source.dispose();
  });

  it.each(["ended", "error"])(
    "%s terminates once, releases its URL and never replays",
    async (event) => {
      const h = fixture();
      await h.source.open(h.file, 1920);
      await h.source.play();
      h.element.dispatchEvent(new Event(event));
      h.element.dispatchEvent(new Event(event));
      expect(event === "ended" ? h.ended : h.failed).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
      expect(await h.source.play()).toBe(false);
    },
  );

  it("handles an already-ended element before its native ended event arrives", async () => {
    const h = fixture();
    await h.source.open(h.file, 1920);
    h.element.ended = true;
    expect(await h.source.play()).toBe(false);
    expect(h.ended).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it.each([0, Infinity, 301])(
    "rejects duration %s and releases its source",
    async (duration) => {
      const h = fixture();
      h.element.duration = duration;
      await expect(h.source.open(h.file, 1920)).rejects.toThrow("five minutes");
      expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    },
  );

  it("rejects oversized dimensions without substituting resized evidence", async () => {
    const h = fixture();
    h.element.videoWidth = 1921;
    await expect(h.source.open(h.file, 1920)).rejects.toThrow("1920 pixels");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("cleans failed decoding and metadata timeouts", async () => {
    vi.useFakeTimers();
    const h = fixture(0);
    const pending = h.source.open(h.file, 1920);
    const failure = expect(pending).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const bad = fixture(0);
    const rejected = expect(bad.source.open(bad.file, 1920)).rejects.toThrow(
      "decoded",
    );
    bad.element.dispatchEvent(new Event("error"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid files before allocating a URL", async () => {
    const h = fixture();
    await expect(
      h.source.open(new File([], "empty.mp4"), 1920),
    ).rejects.toThrow("nonempty");
    await expect(
      h.source.open(new File(["test"], "text.txt"), 1920),
    ).rejects.toThrow("MP4");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

it("EOF cancels the actual Live capture history, rejects a pending native frame and prevents late work", async () => {
  vi.useFakeTimers();
  const h = fixture(2);
  let callback: VideoFrameRequestCallback | undefined;
  let frameNumber = 0;
  Object.assign(h.element, {
    requestVideoFrameCallback: vi.fn((next: VideoFrameRequestCallback) => {
      callback = next;
      return 1;
    }),
    cancelVideoFrameCallback: vi.fn(() => {
      callback = undefined;
    }),
  });
  class Frame {
    allocationSize() {
      return 64 * 64 * 4;
    }
    async copyTo() {
      return [{ offset: 0, stride: 256 }];
    }
    close() {}
  }
  const source = new LiveVideoSource(h.video, () => loop.dispose(), h.failed);
  await source.open(h.file, 1920);
  await source.play();
  const work = deferred();
  let context: LiveCaptureContext | undefined;
  const commits = vi.fn();
  const onFrame = vi.fn(async (next: LiveCaptureContext) => {
    context = next;
    await work.promise;
    if (next.isCurrent()) commits();
  });
  const onError = vi.fn();
  const loop = new LiveCaptureLoop({
    video: h.video,
    client: { busy: false, takeFrameBuffer: (n) => new ArrayBuffer(n) },
    frameLimit: 1920,
    onFrame,
    onError,
    onTransport: vi.fn(),
    capture: new FrameCapture({
      frameConstructor: Frame as unknown as typeof VideoFrame,
      now: () => 1000,
      frameNow: () => 1000,
    }),
  });
  const present = () => {
    const next = callback;
    callback = undefined;
    next?.(1000, {
      presentedFrames: ++frameNumber,
      mediaTime: frameNumber / 30,
      presentationTime: 1000,
    } as VideoFrameCallbackMetadata);
  };
  loop.start();
  present();
  await vi.advanceTimersByTimeAsync(0);
  expect(onFrame).toHaveBeenCalledOnce();
  expect(context?.isCurrent()).toBe(true);
  await vi.advanceTimersByTimeAsync(120); // Waiting for the next genuine native sample.
  h.element.ended = true;
  h.element.dispatchEvent(new Event("ended"));
  expect(context?.isCurrent()).toBe(false);
  expect(context?.history.status.open).toBe(false);
  work.resolve();
  await vi.advanceTimersByTimeAsync(5000);
  expect(commits).not.toHaveBeenCalled();
  expect(onFrame).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  expect(callback).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
