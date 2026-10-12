import { continuityTransfers } from "./types";
import type { FeaturePack, ReferenceAdded, ReferenceInput, VisionContinuityRequest, VisionContinuityResult, VisionCoverage, VisionFrame, VisionInitializeOptions, VisionOptions, VisionReady, VisionResult, WorkerRequest, WorkerResponse } from "./types";
export type * from "./types";

type ClientRequest = { [K in WorkerRequest["type"]]: Omit<Extract<WorkerRequest, { type: K }>, "id"> }[WorkerRequest["type"]];
interface ContinuitySession { batchId: string; eventIds: string[]; latestFrameId: number; latestTimestampMs: number; width: number; height: number }
function validContinuityResponse(value: unknown, expected: ContinuitySession): value is VisionContinuityResult {
  if (!value || typeof value !== "object" || !("batchId" in value) || value.batchId !== expected.batchId || !("results" in value) || !Array.isArray(value.results) || value.results.length !== expected.eventIds.length) return false;
  return value.results.every((result, i) => {
    if (!result || result.eventId !== expected.eventIds[i] || result.identityObservations !== 0 || result.exitEvidence !== false || !Number.isFinite(result.processingMs) || result.processingMs < 0 || !Number.isSafeInteger(result.postSeedSamples) || result.postSeedSamples < 0 || result.postSeedSamples > 120) return false;
    if (result.status === "pending" || result.status === "rejected") return typeof result.reason === "string" && result.reason.length > 0;
    return result.status === "continuous" && result.kind === "verified-roi-continuity" && result.postSeedSamples >= 2 && Number.isSafeInteger(result.seedFrameId) && result.seedFrameId >= 0 && result.seedFrameId < expected.latestFrameId && result.latestFrameId === expected.latestFrameId && result.latestTimestampMs === expected.latestTimestampMs && Number.isFinite(result.durationMs) && result.durationMs >= 160 && result.durationMs <= 12_000 && Number.isSafeInteger(result.supportingPoints) && result.supportingPoints >= 20 && result.supportingPoints <= 48 && Array.isArray(result.latestQuad) && result.latestQuad.length === 4 && result.latestQuad.every((point: { x: number; y: number }) => point && Number.isFinite(point.x) && Number.isFinite(point.y)) && result.appearance && [result.appearance.gain, result.appearance.offset, result.appearance.rms].every(Number.isFinite) && result.appearance.gain >= 0.8 && result.appearance.gain <= 1.2 && Math.abs(result.appearance.offset) <= 24 && result.appearance.rms >= 0 && result.appearance.rms <= 9;
  });
}

const MAX_FRAME_BYTES = 16_000_000 * 4;
function validFrameBytes(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength <= MAX_FRAME_BYTES && byteLength % 4 === 0;
}
/** A malformed response must not let subsequent capture overwrite live crops. */
function resultAliasesFrame(result: unknown, buffer: ArrayBuffer): boolean {
  if (!result || typeof result !== "object" || !("detections" in result) || !Array.isArray(result.detections)) return false;
  const remaining: unknown[] = [...result.detections], seen = new Set<object>();
  while (remaining.length) {
    const detection = remaining.pop();
    if (!detection || typeof detection !== "object" || seen.has(detection)) continue;
    seen.add(detection);
    for (const key of ["crop", "printingCrop"] as const) {
      if (key in detection) {
        const crop = (detection as Record<string, unknown>)[key];
        if (crop && typeof crop === "object" && "data" in crop && ArrayBuffer.isView(crop.data) && crop.data.buffer === buffer) return true;
      }
    }
    if ("hypotheses" in detection && Array.isArray(detection.hypotheses)) remaining.push(...detection.hypotheses);
  }
  return false;
}
export class VisionBusyError extends Error {
  constructor() { super("A frame is already being analyzed; drop this frame instead of queuing it."); this.name = "VisionBusyError"; }
}
/** Own one client per camera session. All image analysis runs off the UI thread. */
export class VisionClient {
  private worker: Worker | undefined;
  private initialization: Promise<VisionReady> | undefined;
  private nextId = 1;
  private analysis: object | undefined;
  private frameBuffer: ArrayBuffer | undefined;
  private continuity: ContinuitySession | undefined;
  private disposed = false;
  private configuration: VisionInitializeOptions | undefined;
  private onProgress: ((text: string) => void) | undefined;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout>; frameByteLength?: number; continuity?: ContinuitySession }>();
  get busy(): boolean { return this.analysis !== undefined; }
  /** Takes the sole matching spare, or allocates one. The caller owns it until analyze.
   * A size change discards the old spare; no frame buffers are queued. */
  takeFrameBuffer(byteLength: number): ArrayBuffer {
    if (this.disposed) throw new Error("Vision client is disposed.");
    if (!validFrameBytes(byteLength)) throw new RangeError("Frame buffer size must be a positive RGBA byte count of at most 64,000,000 bytes.");
    const spare = this.frameBuffer;
    this.frameBuffer = undefined;
    return spare?.byteLength === byteLength ? spare : new ArrayBuffer(byteLength);
  }
  initialize(options?: VisionInitializeOptions, onProgress?: (text: string) => void): Promise<VisionReady> {
    if (this.disposed) return Promise.reject(new Error("Vision client is disposed."));
    if (options && this.configuration && ((options.matcher ?? "orb") !== (this.configuration.matcher ?? "orb") || options.game !== this.configuration.game)) return Promise.reject(new Error("Create a new vision client to change matcher or game."));
    if (onProgress) this.onProgress = onProgress;
    if (this.initialization) return this.initialization;
    this.configuration ??= options ?? {};
    if (typeof Worker === "undefined") return Promise.reject(new Error("This browser does not support the local recognition worker."));
    const worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module", name: "local-card-recognition" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.disposed || this.worker !== worker) return;
      const response = event.data;
      const malformed = () => this.fail(new Error("The local vision worker returned an invalid response. Restart the scanner."));
      if (!response || typeof response !== "object" || !Number.isSafeInteger(response.id)) { malformed(); return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      const hasResult = "result" in response, hasError = "error" in response;
      if ("progress" in response) {
        if (typeof response.progress !== "string" || hasResult || hasError || "frameBuffer" in response) { malformed(); return; }
        try { this.onProgress?.(response.progress); } catch { /* User callback cannot corrupt worker lifecycle. */ }
        return;
      }
      if (hasResult === hasError || (hasError && (typeof response.error !== "string" || !response.error))) { malformed(); return; }
      if (hasResult && pending.continuity && !validContinuityResponse(response.result, pending.continuity)) { malformed(); return; }
      if ("frameBuffer" in response) {
        const buffer = response.frameBuffer;
        if (!(buffer instanceof ArrayBuffer) || !validFrameBytes(buffer.byteLength) || buffer.byteLength !== pending.frameByteLength || resultAliasesFrame(response.result, buffer)) { malformed(); return; }
        this.frameBuffer = buffer;
      }
      this.pending.delete(response.id); clearTimeout(pending.timeout);
      if (hasError) pending.reject(new Error(response.error)); else pending.resolve(response.result);
    };
    worker.onerror = event => { if (this.worker === worker) this.fail(new Error(event.message || "The local vision worker stopped unexpectedly.")); };
    worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error("The browser could not transfer a frame to the local vision worker.")); };
    this.initialization = this.request<VisionReady>({ type: "initialize", ...(Object.keys(this.configuration).length ? { options: this.configuration } : {}) });
    return this.initialization;
  }
  private request<T>(message: ClientRequest, transfers: Transferable[] = []): Promise<T> {
    if (!this.worker || this.disposed) return Promise.reject(new Error("Vision client is not initialized."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error("Local recognition timed out. Restart the scanner to reset the worker.")), message.type === "initialize" ? 120_000 : message.type === "analyze" && message.options.mode === "photo" ? 180_000 : message.type === "verify-continuity" || message.type === "reset-continuity" ? 10_000 : 30_000);
      const frameByteLength = message.type === "analyze" && "data" in message.image ? message.image.data.buffer.byteLength : undefined;
      const continuity = message.type === "verify-continuity" ? this.continuity : undefined;
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout, frameByteLength, continuity });
      try { this.worker!.postMessage({ ...message, id }, transfers); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  async loadPack(pack: FeaturePack): Promise<VisionCoverage> { await this.initialize(); return this.request({ type: "load-pack", pack }); }
  async addReference(input: ReferenceInput): Promise<ReferenceAdded> {
    await this.initialize();
    const { image, ...reference } = input;
    const bitmap = await createImageBitmap(image);
    try { return await this.request({ type: "add-reference", reference, image: bitmap }, [bitmap]); }
    catch (error) { bitmap.close(); throw error; }
  }
  /** Consumes/transfers a bitmap or packed RGBA buffer. Call only when !busy.
   * Pixels can be plain structured data; a native ImageData is unnecessary. */
  async analyze(image: VisionFrame, options: VisionOptions = {}): Promise<VisionResult> {
    if (this.busy) { if ("close" in image) image.close(); throw new VisionBusyError(); }
    const analysis = {};
    this.analysis = analysis;
    try {
      if ("data" in image && (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || image.width > 4096 || image.height > 4096 || !(image.data instanceof Uint8ClampedArray) || !(image.data.buffer instanceof ArrayBuffer) || !validFrameBytes(image.data.buffer.byteLength) || image.data.byteLength !== image.width * image.height * 4)) throw new RangeError("Invalid packed RGBA camera frame.");
      await this.initialize();
      if (this.analysis !== analysis) throw new Error("The local vision session ended before this frame could be analyzed.");
      const transfer = "data" in image ? image.data.buffer as ArrayBuffer : image;
      return await this.request({ type: "analyze", image, options }, [transfer]);
    } catch (error) { if ("close" in image) image.close(); throw error; }
    finally { if (this.analysis === analysis) this.analysis = undefined; }
  }
  async clearReferences(): Promise<VisionCoverage> { await this.initialize(); return this.request({ type: "clear" }); }
  /** Consumes a bounded grayscale replay without adding identity or exit evidence. */
  async verifyContinuity(request: VisionContinuityRequest): Promise<VisionContinuityResult> {
    if (this.busy) throw new VisionBusyError();
    const analysis = {};
    this.analysis = analysis;
    try {
      const transfers = continuityTransfers(request), first = request.frames[0];
      if (request.seeds) {
        if (request.batchId === this.continuity?.batchId) throw new Error("A continuity seed requires a new batch ID.");
      } else if (!this.continuity || request.batchId !== this.continuity.batchId || first.frameId !== this.continuity.latestFrameId + 1 || first.timestampMs <= this.continuity.latestTimestampMs || first.timestampMs - this.continuity.latestTimestampMs > 300 || first.width !== this.continuity.width || first.height !== this.continuity.height) throw new Error("Continuity follow-up must extend the current batch with consecutive captures.");
      this.continuity = { batchId: request.batchId, eventIds: request.seeds?.map(seed => seed.eventId) ?? this.continuity!.eventIds, latestFrameId: request.latestFrameId, latestTimestampMs: request.latestTimestampMs, width: first.width, height: first.height };
      await this.initialize();
      if (this.analysis !== analysis) throw new Error("The local vision session ended before continuity could be verified.");
      const result = await this.request<VisionContinuityResult>({ type: "verify-continuity", request }, transfers);
      if (this.analysis !== analysis || this.continuity?.batchId !== request.batchId) throw new Error("The continuity batch ended before its result could be used.");
      return result;
    } catch (error) {
      // A locally invalid tail must also release the worker's older proof state.
      if (this.analysis === analysis) {
        this.continuity = undefined;
        if (this.worker) {
          try { await this.request<void>({ type: "reset-continuity" }); }
          catch { if (this.analysis === analysis) this.fail(new Error("The local continuity session could not be reset.")); }
        }
      }
      throw error;
    } finally { if (this.analysis === analysis) this.analysis = undefined; }
  }
  async resetContinuity(): Promise<void> {
    if (this.busy) throw new VisionBusyError();
    if (this.disposed) throw new Error("Vision client is disposed.");
    const analysis = {};
    this.analysis = analysis; this.continuity = undefined;
    try { if (this.worker) await this.request<void>({ type: "reset-continuity" }); }
    finally { if (this.analysis === analysis) this.analysis = undefined; }
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    this.pending.clear(); this.worker?.terminate(); this.worker = undefined; this.initialization = undefined; this.analysis = undefined; this.frameBuffer = undefined; this.continuity = undefined;
  }
  /** Pause/stop is terminal for this client; recreate it on resume. Pending and
   * stale worker responses are rejected/dropped, with no queued image evidence. */
  dispose(): void { this.disposed = true; this.onProgress = undefined; this.fail(new Error("Vision client disposed.")); }
}
