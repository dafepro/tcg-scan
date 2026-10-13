export interface CapturedPixels {
  image: {
    width: number;
    height: number;
    data: Uint8ClampedArray<ArrayBuffer>;
  };
  /** Readback clock, which may be epoch-based. It is not source-frame proof. */
  capturedAt: number;
  transport: "videoframe-pool" | "compatibility";
  /** Native source identity and monotonic presentation/callback times. */
  sourceFrame?: SourceFrame;
}

interface SourceFrame {
  readonly presentedFrames: number;
  readonly mediaTime: number;
  readonly presentationTime: number;
  readonly callbackAt: number;
}

export class CaptureFreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureFreshnessError";
  }
}

export interface CaptureFrameExpiry {
  readonly stage: "callback" | "before-copy" | "after-copy";
  readonly checkedAt: number;
  readonly callbackAgeMs: number;
  readonly presentationAgeMs: number;
  readonly sourceFrame: Readonly<SourceFrame>;
}

/** Only an otherwise valid native acquisition that aged out may be discarded
 * and retried by Pack mode. This error owns metadata, never pixels or surfaces. */
export class CaptureFrameExpiredError extends CaptureFreshnessError {
  readonly expiry: CaptureFrameExpiry;
  constructor(stage: CaptureFrameExpiry["stage"], source: SourceFrame, checkedAt: number) {
    super("The camera supplied a stale frame callback. Restart the camera.");
    this.name = "CaptureFrameExpiredError";
    this.expiry = Object.freeze({
      stage,
      checkedAt,
      callbackAgeMs: checkedAt - source.callbackAt,
      presentationAgeMs: checkedAt - source.presentationTime,
      sourceFrame: Object.freeze({
        presentedFrames: source.presentedFrames,
        mediaTime: source.mediaTime,
        presentationTime: source.presentationTime,
        callbackAt: source.callbackAt,
      }),
    });
  }
}

export class CaptureCompatibilityError extends Error {
  constructor() {
    super(
      "This browser's compatibility capture has reached its safe session limit. Saved cards are retained. Use a current browser for continuous scanning, or use photo capture.",
    );
    this.name = "CaptureCompatibilityError";
  }
}
export class CaptureRateLimitError extends Error {
  constructor() {
    super("Compatibility capture is limited to one frame per second.");
  }
}
export class CaptureResolutionError extends Error {
  constructor() {
    super(
      "The camera ignored the requested resolution limit. Choose a lower-resolution camera or use photo capture.",
    );
    this.name = "CaptureResolutionError";
  }
}

interface CaptureDependencies {
  createCanvas(): HTMLCanvasElement;
  frameConstructor?: typeof VideoFrame;
  now(): number;
  /** Same time origin as requestVideoFrameCallback, independent of now(). */
  frameNow(): number;
}
const FALLBACK_BYTES = 48 * 1024 * 1024;
const FALLBACK_FRAMES = 24;
const SOURCE_WAIT_MS = 1000;
const SOURCE_MAX_AGE_MS = 250;
// Chromium can subtract two already-serialized absolute clock values for now(),
// while serializing presentationTime after subtracting the document origin.
// In Mac Chromium 156 CI, all 598 retained now() values lay on a 2^-24 ms grid;
// the two false-future presentation residues were ~0.4 and ~0.2 of that unit.
// Allow at most ONE observed subtraction unit (~59.6 ps) for this comparison.
// This is not a browser-resolution/timing allowance or a universal precision
// guarantee. Raw timestamps, callback/clock ordering and the 250 ms age bound
// stay unchanged; any larger presentation lead still fails closed.
const PRESENTATION_ARITHMETIC_UNIT_MS = 2 ** -24;

interface CaptureSource {
  video: HTMLVideoElement;
  srcObject: HTMLVideoElement["srcObject"];
  src: string;
  currentSrc: string;
  tracks?: MediaStreamTrack[];
}

function videoTracks(video: HTMLVideoElement) {
  const source = video.srcObject;
  return source && "getVideoTracks" in source
    ? source.getVideoTracks()
    : undefined;
}

/** A single reusable readback surface. The caller owns the one returned RGBA
 * buffer and transfers it to the existing worker, which returns it for reuse.
 * No native ImageData is constructed on the preferred path. */
export class FrameCapture {
  private canvas?: HTMLCanvasElement;
  private disposed = false;
  private capturing = false;
  private activeFrame?: VideoFrame;
  private compatibility: boolean;
  private fallbackBytes = 0;
  private fallbackFrames = 0;
  private lastCapture = -Infinity;
  private source?: CaptureSource;
  private sourceChanged = false;
  private lastSourceFrame?: SourceFrame;
  /** Includes age-discarded callbacks, without refreshing live-current proof. */
  private lastObservedSourceFrame?: SourceFrame;
  private lastFrameCheckAt = -Infinity;
  private cancelFrameWait?: (error: Error) => void;
  private readonly dependencies: CaptureDependencies;

  constructor(dependencies?: Partial<CaptureDependencies>) {
    this.dependencies = {
      createCanvas: () => document.createElement("canvas"),
      frameConstructor:
        typeof VideoFrame === "undefined" ? undefined : VideoFrame,
      now: () => performance.now(),
      frameNow: () => performance.now(),
      ...dependencies,
    };
    this.compatibility = !this.dependencies.frameConstructor;
  }

  get minimumIntervalMs() {
    return this.compatibility ? 1000 : 120;
  }
  get busy() {
    return this.capturing;
  }
  get transport() {
    return this.compatibility ? "compatibility" : "videoframe-pool";
  }

  /** Recheck the bound native source before an asynchronous proof commits. */
  isSourceCurrent() {
    if (!this.source || this.disposed || this.sourceChanged) return false;
    try {
      this.assertSource(this.source.video);
      if (!this.compatibility) {
        if (!this.lastSourceFrame) return false;
        this.assertFreshSourceFrame(this.lastSourceFrame);
      }
      return true;
    } catch {
      return false;
    }
  }

  private readonly invalidateSource = () => {
    this.sourceChanged = true;
    this.cancelFrameWait?.(
      new CaptureFreshnessError(
        "The camera source changed. Restart the camera to scan a new source.",
      ),
    );
  };

  private assertSource(video: HTMLVideoElement) {
    if (this.disposed) throw new Error("Capture session is closed.");
    const tracks = videoTracks(video);
    const source = this.source;
    if (!source) {
      this.source = {
        video,
        srcObject: video.srcObject,
        src: video.src,
        currentSrc: video.currentSrc,
        tracks,
      };
      // A reload of the same URL/provider must not reset native counters and
      // silently become another source within a current-view proof.
      video.addEventListener("emptied", this.invalidateSource);
      video.addEventListener("loadstart", this.invalidateSource);
    } else if (
      source.video !== video ||
      source.srcObject !== video.srcObject ||
      source.src !== video.src ||
      source.currentSrc !== video.currentSrc ||
      source.tracks?.length !== tracks?.length ||
      source.tracks?.some((track, index) => track !== tracks?.[index])
    ) {
      this.sourceChanged = true;
    }
    if (this.sourceChanged)
      throw new CaptureFreshnessError(
        "The camera source changed. Restart the camera to scan a new source.",
      );
    if (video.paused || video.ended)
      throw new CaptureFreshnessError(
        "The camera is paused or has ended. Restart the camera.",
      );
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2)
      throw new CaptureFreshnessError(
        "The camera has not supplied a usable frame.",
      );
    if (
      tracks &&
      (!tracks.length ||
        tracks.some(
          (track) =>
            track.muted || !track.enabled || track.readyState !== "live",
        ))
    )
      throw new CaptureFreshnessError(
        "The camera video track is muted, disabled or ended. Restart the camera.",
      );
  }

  private assertFreshSourceFrame(frame: SourceFrame, stage?: CaptureFrameExpiry["stage"]) {
    const now = this.dependencies.frameNow();
    if (!Number.isFinite(now) || now < 0)
      throw new CaptureFreshnessError("The native frame clock is invalid. Restart the camera.");
    if (
      !Number.isFinite(frame.callbackAt) ||
      !Number.isFinite(frame.presentationTime) ||
      frame.callbackAt < 0 ||
      frame.presentationTime < 0
    )
      throw new CaptureFreshnessError("The camera supplied invalid native frame timestamps. Restart the camera.");
    if (now < this.lastFrameCheckAt)
      throw new CaptureFreshnessError("The native frame clock regressed. Restart the camera.");
    if (
      now < frame.callbackAt ||
      frame.presentationTime - now > PRESENTATION_ARITHMETIC_UNIT_MS
    )
      throw new CaptureFreshnessError("The camera supplied future native frame timestamps. Restart the camera.");
    if (stage === "callback") {
      const previous = this.lastObservedSourceFrame;
      if (previous && (frame.callbackAt < previous.callbackAt || frame.presentationTime < previous.presentationTime))
        throw new CaptureFreshnessError("The camera regressed its native frame timestamps. Restart the camera.");
      // Consume an otherwise valid identity even when its age will reject it.
      // A later callback cannot relabel these discarded pixels as a new frame.
      this.lastObservedSourceFrame = frame;
    }
    this.lastFrameCheckAt = now;
    if (now - frame.callbackAt > SOURCE_MAX_AGE_MS || now - frame.presentationTime > SOURCE_MAX_AGE_MS) {
      if (stage) throw new CaptureFrameExpiredError(stage, frame, now);
      throw new CaptureFreshnessError("The camera supplied a stale frame callback. Restart the camera.");
    }
  }

  private waitForSourceFrame(video: HTMLVideoElement): Promise<SourceFrame> {
    return new Promise((resolve, reject) => {
      let callbackId: number | undefined;
      let settled = false;
      const cleanup = () => {
        if (callbackId !== undefined) {
          video.cancelVideoFrameCallback(callbackId);
          callbackId = undefined;
        }
        clearTimeout(timer);
        video.removeEventListener("pause", unavailable);
        video.removeEventListener("ended", unavailable);
        if (this.cancelFrameWait === fail) this.cancelFrameWait = undefined;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const unavailable = () =>
        fail(
          new CaptureFreshnessError(
            "The camera is paused or has ended. Restart the camera.",
          ),
        );
      this.cancelFrameWait = fail;
      video.addEventListener("pause", unavailable);
      video.addEventListener("ended", unavailable);
      const timer = setTimeout(
        () =>
          fail(
            new CaptureFreshnessError(
              "The camera stopped supplying fresh frames. Restart the camera.",
            ),
          ),
        SOURCE_WAIT_MS,
      );
      try {
        const id = video.requestVideoFrameCallback((callbackAt, metadata) => {
          if (settled) return;
          callbackId = undefined; // A delivered callback is no longer pending.
          try {
            this.assertSource(video);
            const frame: SourceFrame = Object.freeze({
              presentedFrames: metadata.presentedFrames,
              mediaTime: metadata.mediaTime,
              presentationTime: metadata.presentationTime,
              callbackAt,
            });
            const previous = this.lastObservedSourceFrame;
            if (
              !Number.isSafeInteger(frame.presentedFrames) ||
              frame.presentedFrames < 1 ||
              !Number.isFinite(frame.mediaTime) ||
              frame.mediaTime < 0 ||
              (previous &&
                (frame.presentedFrames <= previous.presentedFrames ||
                  frame.mediaTime <= previous.mediaTime))
            )
              throw new CaptureFreshnessError(
                "The camera repeated or regressed a source frame. Restart the camera.",
              );
            this.assertFreshSourceFrame(frame, "callback");
            // Consume the identity before readback, even if copyTo later fails.
            this.lastSourceFrame = frame;
            settled = true;
            cleanup();
            resolve(frame);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        if (!settled) callbackId = id;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async capture(
    video: HTMLVideoElement,
    frameLimit: number,
    takeBuffer: (byteLength: number) => ArrayBuffer,
  ): Promise<CapturedPixels> {
    if (this.disposed) throw new Error("Capture session is closed.");
    if (this.capturing) throw new Error("A capture is already in flight.");
    if (!Number.isFinite(frameLimit) || frameLimit < 64 || frameLimit > 4096)
      throw new Error("Invalid camera frame limit.");
    this.capturing = true;
    try {
      this.assertSource(video);
      // A readback clock or VideoFrame constructor timestamp cannot establish
      // source freshness. Browsers without cancellable native frame callbacks
      // get only the existing bounded, non-auto-save compatibility transport.
      if (
        typeof video.requestVideoFrameCallback !== "function" ||
        typeof video.cancelVideoFrameCallback !== "function"
      )
        this.compatibility = true;
      const sourceFrame = this.compatibility
        ? undefined
        : await this.waitForSourceFrame(video);
      const capture = async (): Promise<CapturedPixels> => {
        this.assertSource(video);
        if (!this.compatibility) this.assertFreshSourceFrame(sourceFrame!, "before-copy");
        const capturedAt = this.dependencies.now();
        if (this.compatibility && capturedAt - this.lastCapture < 1000)
          throw new CaptureRateLimitError();
        const limit = this.compatibility
          ? Math.min(frameLimit, 960)
          : frameLimit;
        const scale = Math.min(
          1,
          limit / Math.max(video.videoWidth, video.videoHeight),
        );
        // The direct video path has measured bounded memory. A canvas-resize
        // path needs its own browser evidence; never silently substitute it.
        if (!this.compatibility && scale < 1)
          throw new CaptureResolutionError();
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        const bytes = width * height * 4;
        // Canvas drawing may retain the native source surface as well as the
        // resized readback. Count both, not only the smaller destination.
        const fallbackCost = bytes + video.videoWidth * video.videoHeight * 4;
        if (bytes > 64_000_000)
          throw new Error("Camera frame exceeds the local memory limit.");
        if (
          this.compatibility &&
          (this.fallbackBytes + fallbackCost > FALLBACK_BYTES ||
            this.fallbackFrames >= FALLBACK_FRAMES)
        )
          throw new CaptureCompatibilityError();
        if (this.compatibility) {
          const canvas = (this.canvas ??= this.dependencies.createCanvas());
          // Explicitly discard canvas recording/backing state on this bounded
          // legacy path instead of retaining an unlimited drawing history.
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
            alpha: false,
          });
          if (!context) throw new Error("Camera pixel capture is unavailable.");
          context.drawImage(video, 0, 0, width, height);
          this.fallbackBytes += fallbackCost;
          this.fallbackFrames++;
          this.lastCapture = capturedAt;
          const pixels = context.getImageData(0, 0, width, height);
          return {
            image: { width, height, data: pixels.data },
            capturedAt,
            transport: "compatibility",
          };
        }
        const Frame = this.dependencies.frameConstructor!;
        const frame = new Frame(video, {
          timestamp: Math.round(sourceFrame!.mediaTime * 1_000_000),
          alpha: "discard",
        });
        this.activeFrame = frame;
        try {
          const options: VideoFrameCopyToOptions = {
            format: "RGBA",
            colorSpace: "srgb",
            layout: [{ offset: 0, stride: width * 4 }],
          };
          if (frame.allocationSize(options) !== bytes)
            throw new Error(
              "The browser returned an unexpected camera pixel layout.",
            );
          const buffer = takeBuffer(bytes);
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes)
            throw new Error("Camera pixel buffer has an invalid size.");
          const layout = await frame.copyTo(buffer, options);
          this.assertSource(video);
          if (
            layout.length !== 1 ||
            layout[0].offset !== 0 ||
            layout[0].stride !== width * 4
          )
            throw new Error(
              "The browser returned an unexpected camera pixel layout.",
            );
          this.assertFreshSourceFrame(sourceFrame!, "after-copy");
          this.lastCapture = capturedAt;
          return {
            image: { width, height, data: new Uint8ClampedArray(buffer) },
            capturedAt,
            transport: "videoframe-pool",
            sourceFrame,
          };
        } finally {
          if (this.activeFrame === frame) {
            frame.close();
            this.activeFrame = undefined;
          }
        }
      };
      try {
        return await capture();
      } catch (error) {
        // Older implementations may expose VideoFrame but not RGBA copyTo.
        // Fall back once, at reduced resolution/rate and a hard allocation cap.
        if (
          !this.disposed &&
          !this.compatibility &&
          (error instanceof TypeError ||
            (error instanceof DOMException &&
              error.name === "NotSupportedError"))
        ) {
          this.compatibility = true;
          return await capture();
        }
        throw error;
      }
    } finally {
      this.capturing = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.cancelFrameWait?.(new Error("Capture session is closed."));
    this.activeFrame?.close();
    this.activeFrame = undefined;
    this.source?.video.removeEventListener("emptied", this.invalidateSource);
    this.source?.video.removeEventListener("loadstart", this.invalidateSource);
    this.source = undefined;
    this.lastSourceFrame = undefined;
    this.lastObservedSourceFrame = undefined;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = undefined;
  }
}
