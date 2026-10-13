import { observePackTrace, type PackTrace } from "./pack-trace";
import {
  FrameCapture,
  CaptureFrameExpiredError,
  CaptureRateLimitError,
} from "./frame-capture";
import type { CapturedPixels, CaptureFrameExpiry } from "./frame-capture";
import type { VisionClient, VisionGame, VisionResult } from "./vision";
import {
  PackPrefilter,
  inspectPackFrame,
  sharperPackSample,
  similarPackSamples,
} from "./pack-prefilter";
import type { PackFrameSample } from "./pack-prefilter";

export const PACK_MAX_VIEWS = 12;
export const PACK_MAX_BYTES = 48 * 1024 * 1024;
export const PACK_BACKLOG_TARGET_MS = 500;
export const PACK_RESERVOIR_MAX_VIEWS = 2;
const INITIAL_WORKER_SERVICE_MS = 250;
const MIN_WORKER_SERVICE_MS = 120;
const MAX_WORKER_SERVICE_MS = 2000;
const MAX_CONSECUTIVE_CAPTURE_RETRIES = 2;
const MAX_SESSION_CAPTURE_RETRIES = 8;
export const packClock = () => performance.timeOrigin + performance.now();

/** Immutable provenance of a genuinely acquired native video frame. Provisional
 * track IDs are capture lineage only; they do not establish a physical copy. */
export interface PackCaptureIdentity {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly captureId: string;
  readonly frameId: number;
  readonly capturedAt: number;
  readonly sourceFrame: Readonly<NonNullable<CapturedPixels["sourceFrame"]>>;
  readonly trackId: string;
  readonly copyLineage: "unproven";
  readonly width: number;
  readonly height: number;
  readonly queuedAt: number;
  readonly qualityScore: number;
  /** Diagnostic acquisition sequence only; never identity or copy evidence. */
  readonly traceViewId?: number;
}
export type PackCaptureView = PackCaptureIdentity;
export interface PackLease {
  readonly view: PackCaptureIdentity;
  /** Consumed by VisionClient.analyze; never reuse this buffer for capture. */
  readonly image: CapturedPixels["image"];
  readonly startedAt: number;
}
export type PackOmissionReason =
  | "similar-view"
  | "better-view-retained"
  | "replaced-by-clearer-view"
  | "queue-overflow"
  | "closed";
export interface PackOmission {
  captureId: string;
  reason: PackOmissionReason;
}
export interface PackQueueAdmission {
  preFiltered: false;
  backpressured: false;
  view: PackCaptureIdentity;
  accepted: boolean;
  omitted: PackOmission[];
  /** At most one discarded buffer, now exclusively owned by the caller. */
  recycled?: ArrayBuffer;
}
export interface PackPrefilterAdmission {
  preFiltered: true;
  backpressured: false;
  accepted: false;
  omitted: [];
  /** No receipt/capture ID is created for a redundant acquisition. */
  view?: never;
  recycled: ArrayBuffer;
}
export interface PackReservoirAdmission {
  preFiltered: false;
  backpressured: true;
  accepted: false;
  /** Retained candidates have owned pixels but no receipt/capture ID yet. */
  retained: boolean;
  view?: never;
  omitted: [];
  recycled?: ArrayBuffer;
}
export type PackAdmission =
  PackQueueAdmission | PackPrefilterAdmission | PackReservoirAdmission;
/** Conservation (including cancellation): captured = preFiltered +
 * backpressureRejected + reservoirReplaced + reservoirCancelled + admitted +
 * queueRejected + reservoirViews. Deferral/promotion counts are events; hard-cap
 * reservoir rejection is also in queueDropped and must not be added twice. */
export interface PackCaptureStats {
  /** Valid native acquisitions observed before scheduling admission. */
  readonly captured: number;
  /** Consecutive redundant views skipped before receipt/queue allocation. */
  readonly preFiltered: number;
  /** Candidates routed to the reservoir, including hard-cap rejections. */
  readonly backpressureDeferred: number;
  /** New candidates lost because no bounded reservoir storage was available. */
  readonly backpressureRejected: number;
  /** Previously retained reservoir candidates superseded before any receipt. */
  readonly reservoirReplaced: number;
  /** Reservoir candidates promoted into receipt-bearing pending work. */
  readonly reservoirPromoted: number;
  /** Retained pre-receipt candidates explicitly cancelled with the session. */
  readonly reservoirCancelled: number;
  /** New receipt-stage attempts rejected, excluding older-entry evictions. */
  readonly queueRejected: number;
  /** Pixel-owning candidates, excluded from queued but included in byte caps. */
  readonly reservoirViews: number;
  /** Desired committed pending work; existing work drains when this shrinks. */
  readonly adaptivePendingLimit: number;
  /** EWMA of claim-to-completion wall time, clamped 120–2000 ms; initial 250. */
  readonly workerServiceMs: number;
  /** All downstream scheduling omissions, including redundant replacements. */
  readonly queueOmitted: number;
  /** Hard-cap loss only, including pre-receipt reservoir capacity rejection. */
  readonly queueDropped: number;
  /** Successful inference completions, including results held behind Pause. */
  readonly processed: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly retainedBytes: number;
  readonly peakRetainedBytes: number;
  readonly peakRetainedViews: number;
  readonly offered: number;
  readonly admitted: number;
  readonly omitted: number;
  readonly replaced: number;
  readonly dropped: number;
  readonly captureEnded: boolean;
  /** Age-only acquisitions discarded before they could enter the queue. */
  readonly expiredAcquisitions: number;
  /** Bounded retry grants; Pause/Resume never replenishes this session budget. */
  readonly captureRetries: number;
  readonly consecutiveExpiredAcquisitions: number;
  readonly lastCaptureExpiry?: CaptureFrameExpiry;
}
interface ReservoirEntry {
  readonly traceViewId?: number;
  readonly capturedAt: number;
  readonly sourceFrame: Readonly<NonNullable<CapturedPixels["sourceFrame"]>>;
  readonly observedAt: number;
  readonly image: CapturedPixels["image"];
  readonly sample: PackFrameSample;
  readonly bytes: number;
}
interface Entry {
  view: PackCaptureIdentity;
  image: CapturedPixels["image"];
  sample: PackFrameSample;
  bytes: number;
}

function difference(a: PackFrameSample, b: PackFrameSample): number {
  let sum = 0;
  for (let i = 0; i < a.signature.length; i++)
    sum += Math.abs(a.signature[i] - b.signature[i]);
  return sum / a.signature.length;
}
function validate(capture: CapturedPixels): void {
  const { image, sourceFrame: source } = capture;
  if (capture.transport !== "videoframe-pool" || !source)
    throw new Error(
      "Pack capture requires fresh native video frames; compatibility capture is preview-only.",
    );
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 64 ||
    image.height < 64 ||
    image.width > 4096 ||
    image.height > 4096 ||
    !(image.data instanceof Uint8ClampedArray) ||
    !(image.data.buffer instanceof ArrayBuffer) ||
    image.data.byteOffset !== 0 ||
    image.data.byteLength !== image.data.buffer.byteLength ||
    image.data.byteLength !== image.width * image.height * 4 ||
    image.data.byteLength > PACK_MAX_BYTES
  )
    throw new Error("Invalid bounded pack capture pixels.");
  if (
    !Number.isFinite(capture.capturedAt) ||
    capture.capturedAt < 0 ||
    !Number.isSafeInteger(source.presentedFrames) ||
    source.presentedFrames < 1 ||
    ![source.mediaTime, source.presentationTime, source.callbackAt].every(
      (v) => Number.isFinite(v) && v >= 0,
    )
  )
    throw new Error("Invalid native pack capture provenance.");
}

/** Bounded actual-image queue, including its one leased/in-flight view. Admission
 * transfers ownership, so a caller's old typed-array alias becomes detached.
 * Similarity suppression is explicitly reported; it never proves same identity
 * or same copy. No video surfaces, canvases, or parallel model worker are retained. */
export class PackCaptureQueue {
  private entries: Entry[] = [];
  private reservoir: ReservoirEntry[] = [];
  private workerServiceMs = INITIAL_WORKER_SERVICE_MS;
  private serviceSamples = 0;
  private active?: { entry: Entry; lease: PackLease; processed?: boolean };
  private previous?: CapturedPixels["sourceFrame"];
  private lastCapture = -Infinity;
  private recent?: { sample: PackFrameSample; capturedAt: number };
  private readonly prefilter = new PackPrefilter();
  private sequence = 0;
  private generation = 1;
  private closed = false;
  private cancelled = false;
  private bytes = 0;
  private counters = {
    captured: 0,
    preFiltered: 0,
    backpressureDeferred: 0,
    backpressureRejected: 0,
    reservoirReplaced: 0,
    reservoirPromoted: 0,
    reservoirCancelled: 0,
    queueRejected: 0,
    processed: 0,
    peakRetainedBytes: 0,
    peakRetainedViews: 0,
    offered: 0,
    admitted: 0,
    omitted: 0,
    replaced: 0,
    dropped: 0,
  };
  constructor(
    readonly sessionId: string,
    readonly sourceId: string,
    private readonly limits = {
      maxViews: PACK_MAX_VIEWS,
      maxBytes: PACK_MAX_BYTES,
    },
    private readonly trace?: PackTrace,
  ) {
    if (
      !sessionId.trim() ||
      !sourceId.trim() ||
      sessionId.length > 200 ||
      sourceId.length > 200 ||
      !Number.isInteger(limits.maxViews) ||
      limits.maxViews < 1 ||
      limits.maxViews > PACK_MAX_VIEWS ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 64 * 64 * 4 ||
      limits.maxBytes > PACK_MAX_BYTES
    )
      throw new Error("Invalid bounded pack queue configuration.");
  }
  offer(capture: CapturedPixels, now = packClock()): PackAdmission {
    validate(capture);
    const source = capture.sourceFrame!;
    if (
      !Number.isFinite(now) ||
      now < capture.capturedAt ||
      (this.previous &&
        (source.presentedFrames <= this.previous.presentedFrames ||
          source.mediaTime <= this.previous.mediaTime)) ||
      capture.capturedAt <= this.lastCapture
    )
      throw new Error(
        "Pack capture repeated or regressed a native source frame.",
      );
    this.previous = { ...source };
    this.lastCapture = capture.capturedAt;
    this.counters.captured++;
    const traceViewId = observePackTrace(this.trace, (trace) =>
      trace.capture(
        source.mediaTime,
        source.presentedFrames,
        capture.capturedAt,
      ),
    );
    // Consume strict native provenance even for skipped views. The prefilter
    // runs before IDs, immutable receipt metadata, or any pending-queue scan.
    const decision =
      this.closed || this.cancelled
        ? undefined
        : this.prefilter.inspect(capture.image, capture.capturedAt);
    if (decision && !decision.admitted) {
      this.counters.preFiltered++;
      observePackTrace(this.trace, (trace) =>
        trace.schedule(traceViewId, "visual-skip", now),
      );
      return {
        preFiltered: true,
        backpressured: false,
        accepted: false,
        omitted: [],
        recycled: capture.image.data.buffer,
      };
    }
    const sample = decision?.sample ?? inspectPackFrame(capture.image);
    // Capture keeps its native cadence. Throughput is controlled before receipt
    // creation by the observed worker service rate, not by visual identity.
    if (
      !this.closed &&
      !this.cancelled &&
      (this.entries.length >= this.pendingLimit || this.reservoir.length)
    )
      return this.defer(capture, sample, now, traceViewId);
    const frameId = ++this.sequence,
      captureId = `${this.sessionId}:capture:${frameId}`;
    const view: PackCaptureIdentity = Object.freeze({
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      generation: this.generation,
      captureId,
      frameId,
      capturedAt: capture.capturedAt,
      sourceFrame: Object.freeze({ ...source }),
      trackId: captureId,
      copyLineage: "unproven",
      width: capture.image.width,
      height: capture.image.height,
      queuedAt: now,
      qualityScore: sample.quality,
      ...(traceViewId === undefined ? {} : { traceViewId }),
    });
    this.counters.offered++;
    const omitted: PackOmission[] = [];
    const omit = (
      id: string,
      reason: PackOmissionReason,
      diagnosticId?: number,
    ) => {
      observePackTrace(this.trace, (trace) =>
        trace.schedule(diagnosticId, reason, now),
      );
      omitted.push({ captureId: id, reason });
      this.counters.omitted++;
      if (reason === "queue-overflow") this.counters.dropped++;
      if (reason === "replaced-by-clearer-view") this.counters.replaced++;
    };
    const reject = (reason: PackOmissionReason): PackQueueAdmission => {
      this.counters.queueRejected++;
      // A candidate that had no storage must not become the visual anchor for
      // suppressing its next opportunity after the worker frees capacity.
      if (reason === "queue-overflow") this.prefilter.reset();
      omit(captureId, reason, traceViewId);
      return {
        preFiltered: false,
        backpressured: false,
        view,
        accepted: false,
        omitted,
        recycled: capture.image.data.buffer,
      };
    };
    if (this.closed || this.cancelled) return reject("closed");
    const bytes = capture.image.data.byteLength;
    if (bytes > this.limits.maxBytes) return reject("queue-overflow");
    const similar = this.entries.find(
      (entry) =>
        entry.view.width === view.width &&
        entry.view.height === view.height &&
        difference(entry.sample, sample) <= 5 &&
        similarPackSamples(entry.sample, sample, 5),
    );
    let recycled: ArrayBuffer | undefined;
    if (similar) {
      if (!sharperPackSample(sample, similar.sample))
        return reject("better-view-retained");
      this.entries.splice(this.entries.indexOf(similar), 1);
      this.bytes -= similar.bytes;
      recycled = similar.image.data.buffer;
      omit(
        similar.view.captureId,
        "replaced-by-clearer-view",
        similar.view.traceViewId,
      );
    } else if (
      this.recent &&
      capture.capturedAt - this.recent.capturedAt < 600 &&
      difference(this.recent.sample, sample) <= 3 &&
      similarPackSamples(this.recent.sample, sample) &&
      !sharperPackSample(sample, this.recent.sample)
    ) {
      return reject("similar-view");
    }
    while (
      this.entries.length + (this.active ? 1 : 0) >= this.limits.maxViews ||
      this.bytes + bytes > this.limits.maxBytes
    ) {
      // Never evict in-flight pixels. Prefer evicting a redundant queued view;
      // otherwise the oldest pending view yields, with an explicit drop notice.
      if (!this.entries.length) return reject("queue-overflow");
      let victim = 0,
        nearest = Infinity;
      for (let i = 0; i < this.entries.length; i++)
        for (let j = 0; j < i; j++) {
          const distance = difference(
            this.entries[i].sample,
            this.entries[j].sample,
          );
          if (distance < nearest) {
            nearest = distance;
            victim =
              this.entries[i].sample.quality < this.entries[j].sample.quality
                ? i
                : j;
          }
        }
      if (nearest > 12) victim = 0;
      const [old] = this.entries.splice(victim, 1);
      this.bytes -= old.bytes;
      recycled = old.image.data.buffer;
      omit(old.view.captureId, "queue-overflow", old.view.traceViewId);
    }
    const owned = structuredClone(capture.image.data.buffer, {
      transfer: [capture.image.data.buffer],
    });
    const image = {
      width: capture.image.width,
      height: capture.image.height,
      data: new Uint8ClampedArray(owned),
    };
    this.entries.push({ view, image, sample, bytes });
    this.bytes += bytes;
    this.recent = { sample, capturedAt: capture.capturedAt };
    this.counters.admitted++;
    observePackTrace(this.trace, (trace) =>
      trace.schedule(traceViewId, "admitted", now, frameId),
    );
    this.counters.peakRetainedBytes = Math.max(
      this.counters.peakRetainedBytes,
      this.bytes,
    );
    this.counters.peakRetainedViews = Math.max(
      this.counters.peakRetainedViews,
      this.entries.length + (this.active ? 1 : 0),
    );
    return {
      preFiltered: false,
      backpressured: false,
      view,
      accepted: true,
      omitted,
      recycled,
    };
  }
  private get pendingLimit(): number {
    return Math.max(
      1,
      Math.min(
        3,
        this.limits.maxViews,
        Math.floor(PACK_BACKLOG_TARGET_MS / this.workerServiceMs),
      ),
    );
  }
  private retainPeaks(): void {
    this.counters.peakRetainedBytes = Math.max(
      this.counters.peakRetainedBytes,
      this.bytes,
    );
    this.counters.peakRetainedViews = Math.max(
      this.counters.peakRetainedViews,
      this.entries.length + this.reservoir.length + (this.active ? 1 : 0),
    );
  }
  private defer(
    capture: CapturedPixels,
    sample: PackFrameSample,
    now: number,
    traceViewId?: number,
  ): PackReservoirAdmission {
    this.counters.backpressureDeferred++;
    const bytes = capture.image.data.byteLength;
    let victim: ReservoirEntry | undefined;
    if (this.reservoir.length === PACK_RESERVOIR_MAX_VIEWS) {
      const [earlier, latest] = this.reservoir;
      // Keep the latest new observation plus the stronger earlier candidate.
      // A bounded service window prevents an old sharp wrapper/background from
      // pinning the best slot forever. These are scheduling heuristics only.
      const windowMs = Math.max(600, Math.min(1500, this.workerServiceMs * 3));
      const quality = (entry: ReservoirEntry) =>
        entry.sample.quality + entry.sample.fineDetail * 0.15;
      const keepEarlier =
        capture.capturedAt - earlier.capturedAt <= windowMs &&
        quality(earlier) >= quality(latest);
      victim = keepEarlier ? latest : earlier;
    }
    const retainedViews =
      this.entries.length + this.reservoir.length + (this.active ? 1 : 0);
    // If only one reservoir slot fits, it remains a latest-view slot. No
    // committed/in-flight view is evicted to create an optional reservoir slot.
    if (
      !victim &&
      this.reservoir.length === 1 &&
      (retainedViews >= this.limits.maxViews ||
        this.bytes + bytes > this.limits.maxBytes)
    )
      victim = this.reservoir[0];
    if (
      retainedViews + (victim ? 0 : 1) > this.limits.maxViews ||
      this.bytes - (victim?.bytes ?? 0) + bytes > this.limits.maxBytes
    ) {
      this.counters.backpressureRejected++;
      observePackTrace(this.trace, (trace) =>
        trace.schedule(traceViewId, "reservoir-rejected", now),
      );
      this.counters.dropped++;
      this.prefilter.reset();
      return {
        preFiltered: false,
        backpressured: true,
        accepted: false,
        retained: false,
        omitted: [],
        recycled: capture.image.data.buffer,
      };
    }
    const owned = structuredClone(capture.image.data.buffer, {
      transfer: [capture.image.data.buffer],
    });
    let recycled: ArrayBuffer | undefined;
    if (victim) {
      this.reservoir.splice(this.reservoir.indexOf(victim), 1);
      this.bytes -= victim.bytes;
      recycled = victim.image.data.buffer;
      this.counters.reservoirReplaced++;
      observePackTrace(this.trace, (trace) =>
        trace.schedule(victim?.traceViewId, "reservoir-replaced", now),
      );
    }
    observePackTrace(this.trace, (trace) =>
      trace.schedule(traceViewId, "reservoir", now),
    );
    this.reservoir.push({
      ...(traceViewId === undefined ? {} : { traceViewId }),
      capturedAt: capture.capturedAt,
      sourceFrame: Object.freeze({ ...capture.sourceFrame! }),
      observedAt: now,
      image: {
        width: capture.image.width,
        height: capture.image.height,
        data: new Uint8ClampedArray(owned),
      },
      sample,
      bytes,
    });
    this.bytes += bytes;
    this.retainPeaks();
    return {
      preFiltered: false,
      backpressured: true,
      accepted: false,
      retained: true,
      omitted: [],
      recycled,
    };
  }
  /** Promote oldest retained candidates, creating receipts only as bounded
   * worker capacity becomes available. Native proof was consumed at acquisition;
   * promotion never fabricates or refreshes source timestamps. Call onQueued for
   * each returned view before claiming/identifying it. Natural end still drains. */
  promote(now = packClock()): PackCaptureIdentity[] {
    if (this.cancelled) return [];
    if (
      !Number.isFinite(now) ||
      this.reservoir.some((entry) => now < entry.observedAt)
    )
      throw new Error("Invalid pack reservoir promotion clock.");
    const promoted: PackCaptureIdentity[] = [];
    while (this.reservoir.length && this.entries.length < this.pendingLimit) {
      const candidate = this.reservoir.shift()!;
      const frameId = ++this.sequence,
        captureId = `${this.sessionId}:capture:${frameId}`;
      const view: PackCaptureIdentity = Object.freeze({
        sessionId: this.sessionId,
        sourceId: this.sourceId,
        generation: this.generation,
        captureId,
        frameId,
        capturedAt: candidate.capturedAt,
        sourceFrame: candidate.sourceFrame,
        trackId: captureId,
        copyLineage: "unproven",
        width: candidate.image.width,
        height: candidate.image.height,
        // Include the reservoir wait in queue timing, rather than making the
        // reported delay disappear when a receipt is created later.
        queuedAt: candidate.observedAt,
        qualityScore: candidate.sample.quality,
        ...(candidate.traceViewId === undefined
          ? {}
          : { traceViewId: candidate.traceViewId }),
      });
      this.entries.push({
        view,
        image: candidate.image,
        sample: candidate.sample,
        bytes: candidate.bytes,
      });
      this.recent = {
        sample: candidate.sample,
        capturedAt: candidate.capturedAt,
      };
      this.counters.offered++;
      this.counters.admitted++;
      this.counters.reservoirPromoted++;
      observePackTrace(this.trace, (trace) =>
        trace.schedule(candidate.traceViewId, "admitted", now, frameId),
      );
      promoted.push(view);
    }
    return promoted;
  }
  claim(now = packClock()): PackLease | undefined {
    if (this.cancelled || this.active || !this.entries.length) return;
    const entry = this.entries.shift()!;
    const lease: PackLease = Object.freeze({
      view: entry.view,
      image: entry.image,
      startedAt: now,
    });
    this.active = { entry, lease };
    observePackTrace(this.trace, (trace) =>
      trace.started(entry.view.traceViewId, now),
    );
    return lease;
  }
  isCurrent(lease: PackLease): boolean {
    return (
      !this.cancelled &&
      this.active?.lease === lease &&
      lease.view.generation === this.generation
    );
  }
  finish(lease: PackLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.bytes -= this.active!.entry.bytes;
    this.active = undefined;
    return true;
  }
  /** Pause/Resume resets only sampled image scheduling history. Native source
   * sequence/timestamps, queued ownership and retry budgets remain untouched. */
  resetAdmissionHistory(): void {
    this.prefilter.reset();
    this.recent = undefined;
  }
  recordProcessed(lease: PackLease, completedAt?: number): void {
    if (this.isCurrent(lease) && !this.active!.processed) {
      this.active!.processed = true;
      this.counters.processed++;
      observePackTrace(this.trace, (trace) =>
        trace.processed(lease.view.traceViewId, completedAt ?? packClock()),
      );
      const elapsed =
        completedAt === undefined ? NaN : completedAt - lease.startedAt;
      if (Number.isFinite(elapsed) && elapsed > 0) {
        const bounded = Math.max(
          MIN_WORKER_SERVICE_MS,
          Math.min(MAX_WORKER_SERVICE_MS, elapsed),
        );
        this.workerServiceMs = this.serviceSamples++
          ? this.workerServiceMs * 0.8 + bounded * 0.2
          : bounded;
      }
    }
  }
  end(): void {
    this.closed = true;
    this.prefilter.reset();
  }
  cancel(now = packClock()): void {
    for (const entry of this.entries)
      observePackTrace(this.trace, (trace) =>
        trace.schedule(entry.view.traceViewId, "cancelled", now),
      );
    for (const entry of this.reservoir)
      observePackTrace(this.trace, (trace) =>
        trace.schedule(entry.traceViewId, "cancelled", now),
      );
    if (this.active)
      observePackTrace(this.trace, (trace) =>
        trace.cancelResult(this.active!.entry.view.traceViewId, now),
      );
    this.closed = true;
    this.cancelled = true;
    this.generation++;
    this.entries = [];
    this.counters.reservoirCancelled += this.reservoir.length;
    this.reservoir = [];
    this.active = undefined;
    this.bytes = 0;
    this.recent = undefined;
    this.prefilter.reset();
  }
  get stats(): PackCaptureStats {
    return {
      queued: this.entries.length,
      reservoirViews: this.reservoir.length,
      adaptivePendingLimit: this.pendingLimit,
      workerServiceMs: this.workerServiceMs,
      inFlight: this.active ? 1 : 0,
      retainedBytes: this.bytes,
      ...this.counters,
      queueOmitted: this.counters.omitted,
      queueDropped: this.counters.dropped,
      captureEnded: this.closed,
      expiredAcquisitions: 0,
      captureRetries: 0,
      consecutiveExpiredAcquisitions: 0,
    };
  }
}

export interface PackResultTiming {
  startedAt: number;
  completedAt: number;
  queueWaitMs: number;
  captureToResultMs: number;
  workerMs: number;
}
interface PackLoopDependencies {
  video: HTMLVideoElement;
  client: Pick<VisionClient, "busy" | "analyze" | "takeFrameBuffer">;
  sessionId: string;
  sourceId: string;
  frameLimit: number;
  game?: VisionGame;
  trace?: PackTrace;
  /** Optional admission reservation; default skips all printing crop work. */
  requestPrintingCrop?(view: PackCaptureIdentity): boolean;
  onQueued(view: PackCaptureIdentity): void;
  onIdentifying?(view: PackCaptureIdentity, startedAt: number): void;
  onOmitted(captureId: string, reason: PackOmissionReason): void;
  onResult(
    view: PackCaptureIdentity,
    result: VisionResult,
    timing: PackResultTiming,
  ): void;
  onStats(stats: PackCaptureStats): void;
  onError(error: unknown): void;
  onDrained(): void;
  /** Dependency injection for lifecycle tests, never a canvas capture fallback. */
  capture?: Pick<FrameCapture, "capture" | "dispose" | "minimumIntervalMs">;
  now?: () => number;
}
/** Capture and one worker proceed independently. Native source freshness is
 * checked during acquisition by FrameCapture. Afterwards, genuine pixels may
 * finish after camera exit or natural end; results are delayed receipts only. */
export class PackCaptureLoop {
  private readonly queue: PackCaptureQueue;
  private readonly capture: Pick<
    FrameCapture,
    "capture" | "dispose" | "minimumIntervalMs"
  >;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private spare?: ArrayBuffer;
  private sampling = false;
  private captureEpoch = 0;
  private sourceTracks: MediaStreamTrack[] = [];
  private running = false;
  private paused = false;
  private ended = false;
  private disposed = false;
  private drained = false;
  private expiredAcquisitions = 0;
  private captureRetries = 0;
  private consecutiveExpiredAcquisitions = 0;
  private lastCaptureExpiry?: CaptureFrameExpiry;
  private held?: {
    lease: PackLease;
    result: VisionResult;
    timing: PackResultTiming;
  };
  constructor(private readonly dependencies: PackLoopDependencies) {
    this.now = dependencies.now ?? packClock;
    this.queue = new PackCaptureQueue(
      dependencies.sessionId,
      dependencies.sourceId,
      undefined,
      dependencies.trace,
    );
    this.capture = dependencies.capture ?? new FrameCapture({ now: this.now });
    const source = dependencies.video.srcObject;
    this.sourceTracks =
      source && "getVideoTracks" in source ? source.getVideoTracks() : [];
    dependencies.video.addEventListener("ended", this.videoEnded);
    for (const name of ["emptied", "loadstart", "abort", "error"])
      dependencies.video.addEventListener(name, this.sourceInterrupted);
    for (const track of this.sourceTracks)
      for (const name of ["ended", "mute"])
        track.addEventListener(name, this.sourceInterrupted);
  }
  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    void this.tick();
  }
  pause(): void {
    this.captureEpoch++;
    this.paused = true;
    observePackTrace(this.dependencies.trace, (trace) =>
      trace.control("paused"),
    );
    this.queue.resetAdmissionHistory();
    if (this.timer) clearTimeout(this.timer);
  }
  resume(): void {
    if (this.disposed || !this.running || !this.paused) return;
    this.paused = false;
    observePackTrace(this.dependencies.trace, (trace) =>
      trace.control(this.ended ? "draining" : "active"),
    );
    if (this.held) {
      const held = this.held;
      this.held = undefined;
      this.deliver(held.lease, held.result, held.timing);
    }
    if (!this.ended) void this.tick();
    void this.pump();
  }
  private sourceInterrupted = (): void => {
    if (!this.disposed && !this.ended)
      this.fail(
        new Error(
          "The pack video source changed, muted or disconnected. Pending views were cancelled.",
        ),
      );
  };
  private videoEnded = (): void => {
    if (this.sourceTracks.length) this.sourceInterrupted();
    else this.finishCapture();
  };
  finishCapture = (): void => {
    if (this.disposed || this.ended) return;
    this.ended = true;
    this.queue.end();
    observePackTrace(this.dependencies.trace, (trace) =>
      trace.control("draining"),
    );
    if (this.timer) clearTimeout(this.timer);
    this.capture.dispose();
    this.spare = undefined;
    this.emit();
    void this.pump();
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.dependencies.video.removeEventListener("ended", this.videoEnded);
    for (const name of ["emptied", "loadstart", "abort", "error"])
      this.dependencies.video.removeEventListener(name, this.sourceInterrupted);
    for (const track of this.sourceTracks)
      for (const name of ["ended", "mute"])
        track.removeEventListener(name, this.sourceInterrupted);
    this.sourceTracks = [];
    this.capture.dispose();
    this.queue.cancel(this.now());
    if (!this.drained)
      observePackTrace(this.dependencies.trace, (trace) =>
        trace.control("cancelled"),
      );
    this.spare = undefined;
    this.held = undefined;
  }
  get stats(): PackCaptureStats {
    return {
      ...this.queue.stats,
      expiredAcquisitions: this.expiredAcquisitions,
      captureRetries: this.captureRetries,
      consecutiveExpiredAcquisitions: this.consecutiveExpiredAcquisitions,
      lastCaptureExpiry: this.lastCaptureExpiry,
    };
  }
  private emit(): void {
    if (!this.disposed) this.dependencies.onStats(this.stats);
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    this.dispose();
    this.dependencies.onError(error);
  }
  private schedule(): void {
    if (this.disposed || this.paused || this.ended || !this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.tick(),
      Math.max(100, this.capture.minimumIntervalMs),
    );
  }
  private async tick(): Promise<void> {
    if (this.disposed || this.paused || this.ended || !this.running) return;
    if (this.sampling) {
      this.schedule();
      return;
    }
    if (this.dependencies.video.ended) {
      this.finishCapture();
      return;
    }
    this.sampling = true;
    const epoch = this.captureEpoch;
    let acquiring = true;
    try {
      const captured = await this.capture.capture(
        this.dependencies.video,
        this.dependencies.frameLimit,
        (bytes) => {
          const spare = this.spare;
          this.spare = undefined;
          return spare?.byteLength === bytes
            ? spare
            : this.dependencies.client.takeFrameBuffer(bytes);
        },
      );
      acquiring = false;
      if (
        this.disposed ||
        this.paused ||
        this.ended ||
        epoch !== this.captureEpoch
      ) {
        // A late paused-epoch buffer is not admitted, but can still be reused by
        // a later genuinely fresh acquisition. Stopped sessions retain nothing.
        if (!this.disposed && !this.ended)
          this.spare = captured.image.data.buffer;
        return;
      }
      const observedAt = this.now();
      for (const view of this.queue.promote(observedAt))
        this.dependencies.onQueued(view);
      const admission = this.queue.offer(captured, observedAt);
      this.consecutiveExpiredAcquisitions = 0;
      this.spare = admission.recycled;
      if (admission.accepted) this.dependencies.onQueued(admission.view);
      for (const omission of admission.omitted)
        this.dependencies.onOmitted(omission.captureId, omission.reason);
      this.emit();
      void this.pump();
    } catch (error) {
      if (
        !this.disposed &&
        !this.ended &&
        !this.paused &&
        epoch === this.captureEpoch
      ) {
        if (this.dependencies.video.ended) this.finishCapture();
        else if (acquiring && error instanceof CaptureFrameExpiredError) {
          this.expiredAcquisitions++;
          this.consecutiveExpiredAcquisitions++;
          this.lastCaptureExpiry = error.expiry;
          const retry =
            this.consecutiveExpiredAcquisitions <=
              MAX_CONSECUTIVE_CAPTURE_RETRIES &&
            this.captureRetries < MAX_SESSION_CAPTURE_RETRIES;
          if (retry) this.captureRetries++;
          this.emit();
          if (!retry) this.fail(error);
          // No pixels from this failed acquisition exist in the queue. The
          // normal scheduled tick requests a genuinely new native callback.
        } else if (!(error instanceof CaptureRateLimitError)) this.fail(error);
      }
    } finally {
      this.sampling = false;
      this.schedule();
    }
  }
  private deliver(
    lease: PackLease,
    result: VisionResult,
    timing: PackResultTiming,
  ): void {
    if (this.disposed || !this.queue.isCurrent(lease)) return;
    try {
      this.dependencies.onResult(lease.view, result, timing);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.queue.finish(lease);
    this.emit();
  }
  private async pump(): Promise<void> {
    if (
      this.disposed ||
      this.paused ||
      !this.running ||
      this.dependencies.client.busy ||
      this.held
    )
      return;
    let lease: PackLease | undefined;
    try {
      for (const view of this.queue.promote(this.now()))
        this.dependencies.onQueued(view);
      lease = this.queue.claim(this.now());
      if (!lease) {
        const stats = this.queue.stats;
        if (
          this.ended &&
          !stats.inFlight &&
          !stats.queued &&
          !stats.reservoirViews &&
          !this.drained
        ) {
          this.drained = true;
          observePackTrace(this.dependencies.trace, (trace) =>
            trace.control("drained"),
          );
          this.dependencies.onDrained();
        }
        return;
      }
      // Claim has freed a pending slot. Fill it immediately rather than waiting
      // for another capture tick; all receipts precede their identifying event.
      for (const view of this.queue.promote(this.now()))
        this.dependencies.onQueued(view);
      this.dependencies.onIdentifying?.(lease.view, lease.startedAt);
      this.emit();
      const cropEpoch = this.captureEpoch;
      let includePrintingCrops = false;
      try {
        includePrintingCrops =
          this.dependencies.requestPrintingCrop?.(lease.view) === true;
      } catch {
        /* Optional admission must never fail identity processing. */
      }
      const result = await this.dependencies.client.analyze(lease.image, {
        mode: "pack",
        game: this.dependencies.game,
        budgetMs: 750,
        ...(includePrintingCrops
          ? { includePrintingCrops: true, maxPrintingCrops: 1 }
          : {}),
      });
      // Pause invalidates optional pixels even when identity delivery waits for
      // Resume. The original identity receipt is still allowed to finish.
      if (cropEpoch !== this.captureEpoch)
        for (const detection of result.detections) {
          delete detection.printingCrop;
          delete detection.printingSourceMinEdge;
        }
      if (this.disposed || !this.queue.isCurrent(lease)) return;
      const completedAt = this.now();
      this.queue.recordProcessed(lease, completedAt);
      const timing: PackResultTiming = {
        startedAt: lease.startedAt,
        completedAt,
        queueWaitMs: lease.startedAt - lease.view.queuedAt,
        captureToResultMs: completedAt - lease.view.capturedAt,
        workerMs: result.timings.totalMs,
      };
      if (this.paused) {
        this.held = { lease, result, timing };
        this.emit();
      } else this.deliver(lease, result, timing);
    } catch (error) {
      observePackTrace(this.dependencies.trace, (trace) =>
        trace.workerError(lease?.view.traceViewId, this.now()),
      );
      this.fail(error);
    } finally {
      if (lease && !this.paused && !this.disposed) void this.pump();
    }
  }
}
