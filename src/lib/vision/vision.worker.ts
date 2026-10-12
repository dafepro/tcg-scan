/// <reference lib="webworker" />
import cvModule from "@techstark/opencv-js";
import { VisionEngine } from "./engine";
import type { Cv } from "./engine";
import type { LearnedSimilarity } from "./learned-models";
import type { LearnedVisionEngine } from "./learned-engine";
import { RoiContinuityGuard } from "./roi-continuity";
import { continuityTransfers } from "./types";
import type { RoiContinuityFrame, RoiContinuityResult } from "./roi-continuity";
import type { CardDetection, VisionContinuityRequest, VisionContinuityResult, VisionFrame, VisionInitializeOptions, WorkerRequest, WorkerResponse } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let enginePromise: Promise<VisionEngine | LearnedVisionEngine> | undefined;
let configuration: VisionInitializeOptions = {};
let busy = false;
const lifetime = new AbortController();
let continuity: { batchId: string; guards: Map<string, RoiContinuityGuard>; latest: Omit<RoiContinuityFrame, "gray"> } | undefined;
let continuityGeneration = 0, lastContinuityRequestId = 0;
function resetContinuity(): void {
  continuityGeneration++;
  const old = continuity;
  continuity = undefined;
  for (const guard of old?.guards.values() ?? []) { try { guard.dispose(); } catch { /* No failed guard may remain addressable. */ } }
}
function discardContinuityFrames(request: VisionContinuityRequest): void {
  if (!Array.isArray(request?.frames)) return;
  const buffers = new Set<ArrayBuffer>();
  for (const frame of request.frames) {
    if (frame?.gray instanceof Uint8Array && frame.gray.buffer instanceof ArrayBuffer) buffers.add(frame.gray.buffer);
    if (frame && typeof frame === "object") frame.gray = new Uint8Array(0);
  }
  request.frames.length = 0;
  // Guards copy retained pixels into CV Mats. Modern browsers can immediately
  // detach/free consumed gray storage; older ones simply collect these locals.
  for (const buffer of buffers) {
    const release = (buffer as ArrayBuffer & { transfer?: (byteLength: number) => ArrayBuffer }).transfer;
    if (buffer.byteLength && typeof release === "function") { try { release.call(buffer, 0); } catch { /* References above are already dropped. */ } }
  }
}
function verifyContinuity(request: VisionContinuityRequest, cv: Cv): VisionContinuityResult {
  continuityTransfers(request);
  const first = request.frames[0], last = request.frames.at(-1)!;
  if (request.seeds) {
    if (continuity?.batchId === request.batchId) throw new Error("A continuity seed requires a new batch ID.");
    resetContinuity();
    continuity = { batchId: request.batchId, guards: new Map(), latest: { width: first.width, height: first.height, frameId: first.frameId, timestampMs: first.timestampMs } };
    for (const seed of request.seeds) {
      const guard = new RoiContinuityGuard(cv);
      continuity.guards.set(seed.eventId, guard);
      guard.arm({ ...seed, geometryVerified: true, frame: first });
    }
  } else if (!continuity || continuity.batchId !== request.batchId || first.frameId !== continuity.latest.frameId + 1 || first.timestampMs <= continuity.latest.timestampMs || first.timestampMs - continuity.latest.timestampMs > 300 || first.width !== continuity.latest.width || first.height !== continuity.latest.height) throw new Error("Continuity follow-up must extend the current batch with consecutive captures.");
  const current = continuity!;
  const latest = () => ({ frameId: request.latestFrameId, timestampMs: request.latestTimestampMs, checkedAtTimestampMs: performance.timeOrigin + performance.now() });
  const frames = request.seeds ? request.frames.slice(1) : request.frames;
  const measured = new Map<string, RoiContinuityResult>();
  for (const [eventId, guard] of current.guards) measured.set(eventId, guard.replay(frames, latest()));
  // Recheck freshness after *all* ROIs finish their potentially expensive replay.
  const results = [...current.guards].map(([eventId, guard]) => {
    const result = guard.replay([], latest());
    return { ...result, eventId, processingMs: measured.get(eventId)!.processingMs + result.processingMs, identityObservations: 0 as const, exitEvidence: false as const };
  });
  current.latest = { width: last.width, height: last.height, frameId: last.frameId, timestampMs: last.timestampMs };
  return { batchId: request.batchId, results };
}
function engine(options?: VisionInitializeOptions, progress?: (text: string) => void): Promise<VisionEngine | LearnedVisionEngine> {
  if (options && enginePromise && ((options.matcher ?? "orb") !== (configuration.matcher ?? "orb") || options.game !== configuration.game)) throw new Error("Create a new vision session to change matcher or game.");
  if (!enginePromise) {
    configuration = options ?? configuration;
    enginePromise = (async () => {
      const cv = await (cvModule as unknown as Promise<Cv>);
      if (!cv.Mat || !cv.ORB || !cv.findHomography) throw new Error("The local OpenCV feature-verification runtime could not initialize.");
      if (configuration.matcher !== "learned") return new VisionEngine(cv);
      progress?.("Loading verified local XFeat and corner models…");
      // Dynamic imports keep legacy ORB sessions independent of the learned stack.
      const [{ createLearnedModels, createLearnedSimilarity }, { LearnedVisionEngine }, { loadLearnedIndex, loadLearnedReference }] = await Promise.all([import("./learned-models"), import("./learned-engine"), import("../learned-packs")]);
      const models = await createLearnedModels(cv, { baseUrl: `${import.meta.env.BASE_URL}vision-models/`, signal: lifetime.signal, onProgress: p => progress?.(`Loading local models: ${Math.round(p.loadedBytes / p.totalBytes * 100)}%`) });
      let similarity: LearnedSimilarity | undefined;
      try {
        similarity = await createLearnedSimilarity();
        progress?.("Opening the small local card metadata and hash index…");
        // No per-card descriptors or full feature-pack JSON enters startup/UI.
        const cards = await loadLearnedIndex(configuration.game);
        return new LearnedVisionEngine(cv, models, cards, loadLearnedReference, similarity);
      } catch (error) { try { await similarity?.dispose(); } finally { await models.dispose(); } throw error; }
    })();
  }
  return enginePromise;
}
function readPixels(input: VisionFrame): ImageData {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) throw new Error("Invalid camera frame dimensions.");
  if (input.width > 4096 || input.height > 4096 || input.width * input.height > 16_000_000) throw new Error("Downscale the camera frame before local recognition.");
  if ("data" in input) {
    if (!(input.data instanceof Uint8ClampedArray) || !(input.data.buffer instanceof ArrayBuffer) || input.data.byteLength !== input.width * input.height * 4) throw new Error("Invalid packed RGBA camera frame.");
    // OpenCV and both engines read only width, height and data, not native identity.
    return input as ImageData;
  }
  const canvas = new OffscreenCanvas(input.width, input.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("OffscreenCanvas is unavailable in this browser.");
  context.drawImage(input, 0, 0);
  return context.getImageData(0, 0, input.width, input.height);
}
function inputBuffer(message: WorkerRequest): ArrayBuffer | undefined {
  if (!("image" in message) || !("data" in message.image)) return;
  const data = message.image.data;
  return data instanceof Uint8ClampedArray && data.buffer instanceof ArrayBuffer && data.buffer.byteLength > 0 ? data.buffer : undefined;
}
/** Crops normally own distinct buffers. Copy only exceptional input aliases so
 * recycling next frame cannot overwrite output evidence still held by the UI. */
function collectCropTransfers(detections: CardDetection[], frameBuffer: ArrayBuffer | undefined, transfers: Set<ArrayBuffer>): void {
  const remaining = [...detections], seen = new Set<CardDetection>(), copies = new Map<ImageData, ImageData>();
  while (remaining.length) {
    const detection = remaining.pop()!;
    if (seen.has(detection)) continue;
    seen.add(detection);
    for (const key of ["crop", "printingCrop"] as const) {
      let crop = detection[key];
      if (!crop) continue;
      if (crop.data.buffer === frameBuffer) {
        let copy = copies.get(crop);
        if (!copy) {
          const data = new Uint8ClampedArray(crop.data);
          copy = typeof ImageData === "undefined" ? { width: crop.width, height: crop.height, data, colorSpace: crop.colorSpace ?? "srgb" } : new ImageData(data, crop.width, crop.height, { colorSpace: crop.colorSpace ?? "srgb" });
          copies.set(crop, copy);
        }
        crop = detection[key] = copy;
      }
      transfers.add(crop.data.buffer);
    }
    remaining.push(...(detection.hypotheses ?? []));
  }
}
scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const receiptGeneration = continuityGeneration;
  const frameBuffer = inputBuffer(message);
  const respond = (response: WorkerResponse, transfers = new Set<ArrayBuffer>()) => {
    if (frameBuffer?.byteLength) { response.frameBuffer = frameBuffer; transfers.add(frameBuffer); }
    scope.postMessage(response, [...transfers]);
  };
  if (busy) {
    if ("image" in message && "close" in message.image) message.image.close();
    if (message.type === "verify-continuity" || message.type === "reset-continuity") resetContinuity();
    if (message.type === "verify-continuity") discardContinuityFrames(message.request);
    respond({ id: message.id, error: "Local recognition is busy; drop this request instead of queuing it." }); return;
  }
  busy = true;
  const transfers = new Set<ArrayBuffer>();
  try {
    if (message.type === "verify-continuity" || message.type === "reset-continuity") {
      if (!Number.isSafeInteger(message.id) || message.id <= lastContinuityRequestId) throw new Error("Stale continuity request.");
      lastContinuityRequestId = message.id;
    }
    if (message.type === "reset-continuity") { resetContinuity(); respond({ id: message.id, result: undefined }); return; }
    const local = await engine(message.type === "initialize" ? message.options : undefined, progress => scope.postMessage({ id: message.id, progress } satisfies WorkerResponse));
    let result: unknown;
    switch (message.type) {
      case "initialize": result = { engine: configuration.matcher === "learned" ? "XFeat256/int8 + RANSAC" : "OpenCV ORB + RANSAC", coverage: local.coverage() }; break;
      case "load-pack": if (!(local instanceof VisionEngine)) throw new Error("Import learned packs through the local Library before starting this session."); result = local.loadPack(message.pack); break;
      case "clear": if (!(local instanceof VisionEngine)) throw new Error("Restart the learned session after changing its local packs."); result = local.clear(); break;
      case "add-reference": if (!(local instanceof VisionEngine)) throw new Error("Session photo references are supported only by the legacy ORB matcher."); result = local.addReference(message.reference, readPixels(message.image)); break;
      case "analyze": {
        if (message.options.mode === "pack" && configuration.matcher !== "learned") throw new Error("Pack capture requires the learned verifier.");
        const analyzed = await local.analyze(readPixels(message.image), message.options);
        collectCropTransfers(analyzed.detections, frameBuffer, transfers);
        result = analyzed; break;
      }
      case "verify-continuity": {
        const cv = await (cvModule as unknown as Promise<Cv>);
        if (receiptGeneration !== continuityGeneration) throw new Error("The continuity batch was invalidated before replay.");
        result = verifyContinuity(message.request, cv); break;
      }
    }
    respond({ id: message.id, result }, transfers);
  } catch (error) {
    if (message.type === "verify-continuity" || message.type === "reset-continuity") resetContinuity();
    const detail = error instanceof Error ? error.message : typeof error === "number" ? `OpenCV processing error (${error}).` : String(error);
    respond({ id: message.id, error: detail });
  } finally {
    if (message.type === "verify-continuity") discardContinuityFrames(message.request);
    if ("image" in message && "close" in message.image) message.image.close();
    busy = false;
  }
};
