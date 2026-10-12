import type { ExitFrame } from "./vision/exit-tracker";

export type CaptureHistoryFailure =
  | "invalid-frame"
  | "frame-reordered"
  | "frame-size-changed"
  | "sample-gap"
  | "history-overflow"
  | "cancelled";

interface HistoryLimits {
  maxFrames?: number;
  maxBytes?: number;
  maxDurationMs?: number;
  maxGapMs?: number;
}

/** One pending identity capture's grayscale history. This never captures video,
 * recognizes cards, supplies identity votes, or silently drops intermediate
 * frames. Ownership is drained once to a continuity verifier/worker. */
export class CaptureHistory {
  private frames: ExitFrame[] = [];
  private byteCount = 0;
  private totalBytes = 0;
  private totalFrames = 0;
  private firstTimestamp?: number;
  private latest?: Omit<ExitFrame, "gray">;
  private generation = 0;
  private open = false;
  private reason?: CaptureHistoryFailure;
  private readonly limits: Required<HistoryLimits>;

  constructor(limits: HistoryLimits = {}) {
    this.limits = {
      maxFrames: limits.maxFrames ?? 120,
      maxBytes: limits.maxBytes ?? 32 * 1024 * 1024,
      maxDurationMs: limits.maxDurationMs ?? 12_000,
      maxGapMs: limits.maxGapMs ?? 300,
    };
    const { maxFrames, maxBytes, maxDurationMs, maxGapMs } = this.limits;
    if (
      !Number.isInteger(maxFrames) ||
      maxFrames < 3 ||
      maxFrames > 120 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 4096 ||
      maxBytes > 32 * 1024 * 1024 ||
      !Number.isFinite(maxDurationMs) ||
      maxDurationMs < 200 ||
      maxDurationMs > 12_000 ||
      !Number.isFinite(maxGapMs) ||
      maxGapMs < 50 ||
      maxGapMs > 500
    )
      throw new Error(
        "Capture history limits must remain within the bounded replay budget.",
      );
  }

  /** A new token invalidates all callbacks from the previous capture/session. */
  begin(seed: ExitFrame): number {
    this.clear();
    this.generation++;
    this.open = true;
    this.append(seed, this.generation);
    return this.generation;
  }

  append(frame: ExitFrame, token: number): boolean {
    if (!this.open || token !== this.generation) return false;
    const fail = (reason: CaptureHistoryFailure) => {
      this.clear();
      this.reason = reason;
      return false;
    };
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 64 ||
      frame.height < 64 ||
      Math.max(frame.width, frame.height) > 640 ||
      !(frame.gray instanceof Uint8Array) ||
      frame.gray.length !== frame.width * frame.height ||
      !Number.isSafeInteger(frame.frameId) ||
      frame.frameId < 0 ||
      !Number.isFinite(frame.timestampMs) ||
      frame.timestampMs < 0
    )
      return fail("invalid-frame");
    const previous = this.latest;
    if (previous) {
      if (frame.width !== previous.width || frame.height !== previous.height)
        return fail("frame-size-changed");
      if (
        frame.frameId <= previous.frameId ||
        frame.timestampMs <= previous.timestampMs
      )
        return fail("frame-reordered");
      if (frame.frameId !== previous.frameId + 1) return fail("sample-gap");
      if (frame.timestampMs - previous.timestampMs > this.limits.maxGapMs)
        return fail("sample-gap");
    }
    if (
      this.totalFrames + 1 > this.limits.maxFrames ||
      this.totalBytes + frame.gray.byteLength > this.limits.maxBytes ||
      (this.firstTimestamp !== undefined &&
        frame.timestampMs - this.firstTimestamp > this.limits.maxDurationMs)
    )
      return fail("history-overflow");
    // Retain grayscale only, never a parallel RGBA image, canvas or video frame.
    this.frames.push({ ...frame, gray: frame.gray.slice() });
    this.byteCount += frame.gray.byteLength;
    this.totalBytes += frame.gray.byteLength;
    this.totalFrames++;
    this.firstTimestamp ??= frame.timestampMs;
    this.latest = {
      width: frame.width,
      height: frame.height,
      frameId: frame.frameId,
      timestampMs: frame.timestampMs,
    };
    return true;
  }

  /** Drain an ordered prefix while capture continues. Cumulative count/byte/time
   * budgets remain enforced across drains; no hidden eviction resets a budget. */
  drain(token: number): ExitFrame[] | undefined {
    if (!this.open || token !== this.generation) return undefined;
    const frames = this.frames;
    this.frames = [];
    this.byteCount = 0;
    return frames;
  }

  /** Moves all buffers to the caller, which may transfer them to the existing
   * vision worker. A second drain or late append cannot revive this history. */
  take(token: number): ExitFrame[] | undefined {
    if (!this.open || token !== this.generation) return undefined;
    const frames = this.frames;
    this.clear();
    return frames;
  }

  cancel(): void {
    this.clear();
    this.generation++;
    this.reason = "cancelled";
  }

  get status() {
    return {
      open: this.open,
      frames: this.frames.length,
      bytes: this.byteCount,
      recordedFrames: this.totalFrames,
      recordedBytes: this.totalBytes,
      latestFrameId: this.latest?.frameId,
      latestTimestampMs: this.latest?.timestampMs,
      reason: this.reason,
    };
  }

  private clear() {
    this.frames = [];
    this.byteCount = 0;
    this.totalBytes = 0;
    this.totalFrames = 0;
    this.firstTimestamp = undefined;
    this.latest = undefined;
    this.open = false;
    this.reason = undefined;
  }
}
