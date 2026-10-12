import { FrameCapture, CaptureFrameExpiredError, CaptureRateLimitError } from "./frame-capture";
import type { CapturedPixels, CaptureFrameExpiry } from "./frame-capture";
import type { VisionClient, VisionGame, VisionResult } from "./vision";

export const PACK_MAX_VIEWS = 12;
export const PACK_MAX_BYTES = 48 * 1024 * 1024;
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
}
export type PackCaptureView = PackCaptureIdentity;
export interface PackLease {
  readonly view: PackCaptureIdentity;
  /** Consumed by VisionClient.analyze; never reuse this buffer for capture. */
  readonly image: CapturedPixels["image"];
  readonly startedAt: number;
}
export type PackOmissionReason = "similar-view" | "better-view-retained" | "replaced-by-clearer-view" | "queue-overflow" | "closed";
export interface PackOmission { captureId: string; reason: PackOmissionReason }
export interface PackAdmission {
  view: PackCaptureIdentity;
  accepted: boolean;
  omitted: PackOmission[];
  /** At most one discarded buffer, now exclusively owned by the caller. */
  recycled?: ArrayBuffer;
}
export interface PackCaptureStats {
  queued: number;
  inFlight: number;
  retainedBytes: number;
  peakRetainedBytes: number;
  peakRetainedViews: number;
  offered: number;
  admitted: number;
  omitted: number;
  replaced: number;
  dropped: number;
  captureEnded: boolean;
  /** Age-only acquisitions discarded before they could enter the queue. */
  expiredAcquisitions: number;
  /** Bounded retry grants; Pause/Resume never replenishes this session budget. */
  captureRetries: number;
  consecutiveExpiredAcquisitions: number;
  lastCaptureExpiry?: CaptureFrameExpiry;
}
interface Sample { signature: Uint8Array; quality: number }
interface Entry { view: PackCaptureIdentity; image: CapturedPixels["image"]; sample: Sample; bytes: number }

/** Small image-derived scheduling signature. It is never identity, copy evidence,
 * confidence, or an acceptance gate. Grid averages reduce single-pixel aliasing. */
function inspect(image: CapturedPixels["image"]): Sample {
  const side = 32, signature = new Uint8Array(side * side * 3);
  let detail = 0, luminance = 0, square = 0;
  const gray = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sum = [0, 0, 0];
    for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
      const px = Math.min(image.width - 1, Math.floor((x + dx) * image.width / side));
      const py = Math.min(image.height - 1, Math.floor((y + dy) * image.height / side));
      const offset = (py * image.width + px) * 4;
      for (let c = 0; c < 3; c++) sum[c] += image.data[offset + c] / 4;
    }
    const i = y * side + x;
    for (let c = 0; c < 3; c++) signature[i * 3 + c] = Math.round(sum[c]);
    const value = (77 * sum[0] + 150 * sum[1] + 29 * sum[2]) / 256;
    gray[i] = value; luminance += value; square += value * value;
  }
  for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
    const i = y * side + x;
    detail += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - side] - gray[i + side]);
  }
  const variance = Math.max(0, square / gray.length - (luminance / gray.length) ** 2);
  return { signature, quality: detail / ((side - 2) ** 2) + Math.sqrt(variance) * .15 };
}
function difference(a: Sample, b: Sample): number {
  let sum = 0;
  for (let i = 0; i < a.signature.length; i++) sum += Math.abs(a.signature[i] - b.signature[i]);
  return sum / a.signature.length;
}
function validate(capture: CapturedPixels): void {
  const { image, sourceFrame: source } = capture;
  if (capture.transport !== "videoframe-pool" || !source)
    throw new Error("Pack capture requires fresh native video frames; compatibility capture is preview-only.");
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 64 || image.height < 64 || image.width > 4096 || image.height > 4096 || !(image.data instanceof Uint8ClampedArray) || !(image.data.buffer instanceof ArrayBuffer) || image.data.byteOffset !== 0 || image.data.byteLength !== image.data.buffer.byteLength || image.data.byteLength !== image.width * image.height * 4 || image.data.byteLength > PACK_MAX_BYTES)
    throw new Error("Invalid bounded pack capture pixels.");
  if (!Number.isFinite(capture.capturedAt) || capture.capturedAt < 0 || !Number.isSafeInteger(source.presentedFrames) || source.presentedFrames < 1 || ![source.mediaTime, source.presentationTime, source.callbackAt].every(v => Number.isFinite(v) && v >= 0))
    throw new Error("Invalid native pack capture provenance.");
}

/** Bounded actual-image queue, including its one leased/in-flight view. Admission
 * transfers ownership, so a caller's old typed-array alias becomes detached.
 * Similarity suppression is explicitly reported; it never proves same identity
 * or same copy. No video surfaces, canvases, or parallel model worker are retained. */
export class PackCaptureQueue {
  private entries: Entry[] = [];
  private active?: { entry: Entry; lease: PackLease };
  private previous?: CapturedPixels["sourceFrame"];
  private lastCapture = -Infinity;
  private recent?: { sample: Sample; capturedAt: number };
  private sequence = 0;
  private generation = 1;
  private closed = false;
  private cancelled = false;
  private bytes = 0;
  private counters = { peakRetainedBytes: 0, peakRetainedViews: 0, offered: 0, admitted: 0, omitted: 0, replaced: 0, dropped: 0 };
  constructor(readonly sessionId: string, readonly sourceId: string, private readonly limits = { maxViews: PACK_MAX_VIEWS, maxBytes: PACK_MAX_BYTES }) {
    if (!sessionId.trim() || !sourceId.trim() || sessionId.length > 200 || sourceId.length > 200 || !Number.isInteger(limits.maxViews) || limits.maxViews < 1 || limits.maxViews > PACK_MAX_VIEWS || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 64 * 64 * 4 || limits.maxBytes > PACK_MAX_BYTES) throw new Error("Invalid bounded pack queue configuration.");
  }
  offer(capture: CapturedPixels, now = packClock()): PackAdmission {
    validate(capture);
    const source = capture.sourceFrame!;
    if (!Number.isFinite(now) || now < capture.capturedAt || (this.previous && (source.presentedFrames <= this.previous.presentedFrames || source.mediaTime <= this.previous.mediaTime)) || capture.capturedAt <= this.lastCapture)
      throw new Error("Pack capture repeated or regressed a native source frame.");
    this.previous = { ...source }; this.lastCapture = capture.capturedAt;
    const frameId = ++this.sequence, captureId = `${this.sessionId}:capture:${frameId}`;
    const sample = inspect(capture.image);
    const view: PackCaptureIdentity = Object.freeze({ sessionId: this.sessionId, sourceId: this.sourceId, generation: this.generation, captureId, frameId, capturedAt: capture.capturedAt, sourceFrame: Object.freeze({ ...source }), trackId: captureId, copyLineage: "unproven", width: capture.image.width, height: capture.image.height, queuedAt: now, qualityScore: sample.quality });
    this.counters.offered++;
    const omitted: PackOmission[] = [];
    const omit = (id: string, reason: PackOmissionReason) => {
      omitted.push({ captureId: id, reason }); this.counters.omitted++;
      if (reason === "queue-overflow") this.counters.dropped++;
      if (reason === "replaced-by-clearer-view") this.counters.replaced++;
    };
    const reject = (reason: PackOmissionReason): PackAdmission => {
      omit(captureId, reason);
      return { view, accepted: false, omitted, recycled: capture.image.data.buffer };
    };
    if (this.closed || this.cancelled) return reject("closed");
    const bytes = capture.image.data.byteLength;
    if (bytes > this.limits.maxBytes) return reject("queue-overflow");
    const similar = this.entries.find(entry => entry.view.width === view.width && entry.view.height === view.height && difference(entry.sample, sample) <= 5);
    let recycled: ArrayBuffer | undefined;
    if (similar) {
      if (sample.quality <= similar.sample.quality * 1.05 + .1) return reject("better-view-retained");
      this.entries.splice(this.entries.indexOf(similar), 1); this.bytes -= similar.bytes;
      recycled = similar.image.data.buffer; omit(similar.view.captureId, "replaced-by-clearer-view");
    } else if (this.recent && capture.capturedAt - this.recent.capturedAt < 600 && difference(this.recent.sample, sample) <= 3) {
      return reject("similar-view");
    }
    while (this.entries.length + (this.active ? 1 : 0) >= this.limits.maxViews || this.bytes + bytes > this.limits.maxBytes) {
      // Never evict in-flight pixels. Prefer evicting a redundant queued view;
      // otherwise the oldest pending view yields, with an explicit drop notice.
      if (!this.entries.length) return reject("queue-overflow");
      let victim = 0, nearest = Infinity;
      for (let i = 0; i < this.entries.length; i++) for (let j = 0; j < i; j++) {
        const distance = difference(this.entries[i].sample, this.entries[j].sample);
        if (distance < nearest) { nearest = distance; victim = this.entries[i].sample.quality < this.entries[j].sample.quality ? i : j; }
      }
      if (nearest > 12) victim = 0;
      const [old] = this.entries.splice(victim, 1); this.bytes -= old.bytes;
      recycled = old.image.data.buffer; omit(old.view.captureId, "queue-overflow");
    }
    const owned = structuredClone(capture.image.data.buffer, { transfer: [capture.image.data.buffer] });
    const image = { width: capture.image.width, height: capture.image.height, data: new Uint8ClampedArray(owned) };
    this.entries.push({ view, image, sample, bytes }); this.bytes += bytes;
    this.recent = { sample, capturedAt: capture.capturedAt }; this.counters.admitted++;
    this.counters.peakRetainedBytes = Math.max(this.counters.peakRetainedBytes, this.bytes);
    this.counters.peakRetainedViews = Math.max(this.counters.peakRetainedViews, this.entries.length + (this.active ? 1 : 0));
    return { view, accepted: true, omitted, recycled };
  }
  claim(now = packClock()): PackLease | undefined {
    if (this.cancelled || this.active || !this.entries.length) return;
    const entry = this.entries.shift()!;
    const lease: PackLease = Object.freeze({ view: entry.view, image: entry.image, startedAt: now });
    this.active = { entry, lease }; return lease;
  }
  isCurrent(lease: PackLease): boolean { return !this.cancelled && this.active?.lease === lease && lease.view.generation === this.generation; }
  finish(lease: PackLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.bytes -= this.active!.entry.bytes; this.active = undefined; return true;
  }
  end(): void { this.closed = true; }
  cancel(): void { this.closed = true; this.cancelled = true; this.generation++; this.entries = []; this.active = undefined; this.bytes = 0; this.recent = undefined; }
  get stats(): PackCaptureStats { return { queued: this.entries.length, inFlight: this.active ? 1 : 0, retainedBytes: this.bytes, ...this.counters, captureEnded: this.closed, expiredAcquisitions: 0, captureRetries: 0, consecutiveExpiredAcquisitions: 0 }; }
}

export interface PackResultTiming { startedAt: number; completedAt: number; queueWaitMs: number; captureToResultMs: number; workerMs: number }
interface PackLoopDependencies {
  video: HTMLVideoElement;
  client: Pick<VisionClient, "busy" | "analyze" | "takeFrameBuffer">;
  sessionId: string;
  sourceId: string;
  frameLimit: number;
  game?: VisionGame;
  onQueued(view: PackCaptureIdentity): void;
  onIdentifying?(view: PackCaptureIdentity, startedAt: number): void;
  onOmitted(captureId: string, reason: PackOmissionReason): void;
  onResult(view: PackCaptureIdentity, result: VisionResult, timing: PackResultTiming): void;
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
  private readonly capture: Pick<FrameCapture, "capture" | "dispose" | "minimumIntervalMs">;
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
  private held?: { lease: PackLease; result: VisionResult; timing: PackResultTiming };
  constructor(private readonly dependencies: PackLoopDependencies) {
    this.now = dependencies.now ?? packClock;
    this.queue = new PackCaptureQueue(dependencies.sessionId, dependencies.sourceId);
    this.capture = dependencies.capture ?? new FrameCapture({ now: this.now });
    const source = dependencies.video.srcObject;
    this.sourceTracks = source && "getVideoTracks" in source ? source.getVideoTracks() : [];
    dependencies.video.addEventListener("ended", this.videoEnded);
    for (const name of ["emptied", "loadstart", "abort", "error"]) dependencies.video.addEventListener(name, this.sourceInterrupted);
    for (const track of this.sourceTracks) for (const name of ["ended", "mute"]) track.addEventListener(name, this.sourceInterrupted);
  }
  start(): void { if (this.disposed || this.running) return; this.running = true; void this.tick(); }
  pause(): void { this.captureEpoch++; this.paused = true; if (this.timer) clearTimeout(this.timer); }
  resume(): void {
    if (this.disposed || !this.running || !this.paused) return;
    this.paused = false;
    if (this.held) { const held = this.held; this.held = undefined; this.deliver(held.lease, held.result, held.timing); }
    if (!this.ended) void this.tick();
    void this.pump();
  }
  private sourceInterrupted = (): void => { if (!this.disposed && !this.ended) this.fail(new Error("The pack video source changed, muted or disconnected. Pending views were cancelled.")); };
  private videoEnded = (): void => { if (this.sourceTracks.length) this.sourceInterrupted(); else this.finishCapture(); };
  finishCapture = (): void => {
    if (this.disposed || this.ended) return;
    this.ended = true; this.queue.end(); if (this.timer) clearTimeout(this.timer);
    this.capture.dispose(); this.spare = undefined; this.emit(); void this.pump();
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.running = false; this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.dependencies.video.removeEventListener("ended", this.videoEnded);
    for (const name of ["emptied", "loadstart", "abort", "error"]) this.dependencies.video.removeEventListener(name, this.sourceInterrupted);
    for (const track of this.sourceTracks) for (const name of ["ended", "mute"]) track.removeEventListener(name, this.sourceInterrupted);
    this.sourceTracks = [];
    this.capture.dispose(); this.queue.cancel(); this.spare = undefined; this.held = undefined;
  }
  get stats(): PackCaptureStats { return { ...this.queue.stats, expiredAcquisitions: this.expiredAcquisitions, captureRetries: this.captureRetries, consecutiveExpiredAcquisitions: this.consecutiveExpiredAcquisitions, lastCaptureExpiry: this.lastCaptureExpiry }; }
  private emit(): void { if (!this.disposed) this.dependencies.onStats(this.stats); }
  private fail(error: unknown): void { if (this.disposed) return; this.dispose(); this.dependencies.onError(error); }
  private schedule(): void {
    if (this.disposed || this.paused || this.ended || !this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(100, this.capture.minimumIntervalMs));
  }
  private async tick(): Promise<void> {
    if (this.disposed || this.paused || this.ended || !this.running) return;
    if (this.sampling) { this.schedule(); return; }
    if (this.dependencies.video.ended) { this.finishCapture(); return; }
    this.sampling = true;
    const epoch = this.captureEpoch;
    let acquiring = true;
    try {
      const captured = await this.capture.capture(this.dependencies.video, this.dependencies.frameLimit, bytes => {
        const spare = this.spare; this.spare = undefined;
        return spare?.byteLength === bytes ? spare : this.dependencies.client.takeFrameBuffer(bytes);
      });
      acquiring = false;
      if (this.disposed || this.paused || this.ended || epoch !== this.captureEpoch) return;
      const admission = this.queue.offer(captured, this.now());
      this.consecutiveExpiredAcquisitions = 0;
      this.spare = admission.recycled;
      if (admission.accepted) this.dependencies.onQueued(admission.view);
      for (const omission of admission.omitted) this.dependencies.onOmitted(omission.captureId, omission.reason);
      this.emit(); void this.pump();
    } catch (error) {
      if (!this.disposed && !this.ended && !this.paused && epoch === this.captureEpoch) {
        if (this.dependencies.video.ended) this.finishCapture();
        else if (acquiring && error instanceof CaptureFrameExpiredError) {
          this.expiredAcquisitions++;
          this.consecutiveExpiredAcquisitions++;
          this.lastCaptureExpiry = error.expiry;
          const retry = this.consecutiveExpiredAcquisitions <= MAX_CONSECUTIVE_CAPTURE_RETRIES && this.captureRetries < MAX_SESSION_CAPTURE_RETRIES;
          if (retry) this.captureRetries++;
          this.emit();
          if (!retry) this.fail(error);
          // No pixels from this failed acquisition exist in the queue. The
          // normal scheduled tick requests a genuinely new native callback.
        } else if (!(error instanceof CaptureRateLimitError)) this.fail(error);
      }
    } finally { this.sampling = false; this.schedule(); }
  }
  private deliver(lease: PackLease, result: VisionResult, timing: PackResultTiming): void {
    if (this.disposed || !this.queue.isCurrent(lease)) return;
    try { this.dependencies.onResult(lease.view, result, timing); }
    catch (error) { this.fail(error); return; }
    this.queue.finish(lease); this.emit();
  }
  private async pump(): Promise<void> {
    if (this.disposed || this.paused || !this.running || this.dependencies.client.busy || this.held) return;
    const lease = this.queue.claim(this.now());
    if (!lease) {
      if (this.ended && !this.queue.stats.inFlight && !this.queue.stats.queued && !this.drained) {
        this.drained = true; this.dependencies.onDrained();
      }
      return;
    }
    try {
      this.dependencies.onIdentifying?.(lease.view, lease.startedAt); this.emit();
      const result = await this.dependencies.client.analyze(lease.image, { mode: "pack", game: this.dependencies.game, budgetMs: 750 });
      if (this.disposed || !this.queue.isCurrent(lease)) return;
      const completedAt = this.now();
      const timing: PackResultTiming = { startedAt: lease.startedAt, completedAt, queueWaitMs: lease.startedAt - lease.view.queuedAt, captureToResultMs: completedAt - lease.view.capturedAt, workerMs: result.timings.totalMs };
      if (this.paused) this.held = { lease, result, timing };
      else this.deliver(lease, result, timing);
    } catch (error) { this.fail(error); }
    finally { if (!this.paused && !this.disposed) void this.pump(); }
  }
}
