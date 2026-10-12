import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearnedModels } from "./learned-types";
import type { CardDetection, Quad, VisionContinuityRequest, VisionContinuityResult, VisionFramePixels, WorkerRequest, WorkerResponse } from "./types";
import type { RoiContinuityFrame, RoiContinuitySeed, RoiLatestCapture } from "./roi-continuity";

const mocks = vi.hoisted(() => ({ createModels: vi.fn(), loadIndex: vi.fn(), loadReference: vi.fn(), analyze: vi.fn(), loadPack: vi.fn(), clear: vi.fn(), addReference: vi.fn(), constructor: vi.fn(), orbConstructor: vi.fn(), continuityConstructor: vi.fn(), continuityArm: vi.fn(), continuityReplay: vi.fn(), continuityDispose: vi.fn() }));
vi.mock("@techstark/opencv-js", () => ({ default: Promise.resolve({ Mat: true, ORB: true, findHomography: true }) }));
vi.mock("./engine", () => ({ VisionEngine: class {
  constructor(cv: unknown) { mocks.orbConstructor(cv); }
  coverage() { return { totalReferences: 0, byGame: { pokemon: 0, mtg: 0, yugioh: 0 }, packs: [] }; }
  analyze = mocks.analyze;
  loadPack = mocks.loadPack;
  clear = mocks.clear;
  addReference = mocks.addReference;
} }));
vi.mock("./learned-engine", () => ({ LearnedVisionEngine: class {
  constructor(...args: unknown[]) { mocks.constructor(...args); }
  coverage() { return { totalReferences: 2000, byGame: { pokemon: 2000, mtg: 0, yugioh: 0 }, packs: ["Metadata index"] }; }
  analyze = mocks.analyze;
} }));
vi.mock("./learned-models", () => ({ createLearnedModels: mocks.createModels, createLearnedSimilarity: async () => ({ multiply: vi.fn(), dispose: vi.fn(async () => {}) }) }));
vi.mock("../learned-packs", () => ({ loadLearnedIndex: mocks.loadIndex, loadLearnedReference: mocks.loadReference }));
vi.mock("./roi-continuity", () => ({ RoiContinuityGuard: class {
  eventId = "";
  samples = 0;
  seed?: RoiContinuitySeed;
  constructor(cv: unknown) { mocks.continuityConstructor(cv); }
  arm(seed: RoiContinuitySeed) {
    this.eventId = seed.eventId; this.seed = seed;
    return mocks.continuityArm(seed, this) ?? { status: "pending", reason: "more-samples", eventId: this.eventId, processingMs: 0, postSeedSamples: 0, identityObservations: 0, exitEvidence: false };
  }
  replay(frames: RoiContinuityFrame[], latest: RoiLatestCapture) {
    if (frames.some(f => f.gray.byteLength !== f.width * f.height)) throw new Error("A gray buffer was discarded before all guards consumed it.");
    this.samples += frames.length;
    const override = mocks.continuityReplay(frames.map(f => ({ frameId: f.frameId, timestampMs: f.timestampMs, grayBytes: f.gray.byteLength })), latest, this);
    if (override) return override;
    const base = { eventId: this.eventId, processingMs: 2, postSeedSamples: this.samples, identityObservations: 0, exitEvidence: false };
    if (latest.checkedAtTimestampMs < latest.timestampMs) return { ...base, status: "rejected", reason: "invalid-latest" };
    if (this.samples < 2) return { ...base, status: "pending", reason: "more-samples" };
    if (latest.checkedAtTimestampMs - latest.timestampMs > 300) return { ...base, status: "pending", reason: "latest-capture-stale" };
    return { ...base, status: "continuous", kind: "verified-roi-continuity", seedFrameId: this.seed!.frame.frameId, latestFrameId: latest.frameId, latestTimestampMs: latest.timestampMs, durationMs: latest.timestampMs - this.seed!.frame.timestampMs, latestQuad: this.seed!.quad, supportingPoints: 24, appearance: { gain: 1, offset: 0, rms: 0 } };
  }
  dispose() { mocks.continuityDispose(this); }
} }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); vi.resetAllMocks(); });
async function worker() {
  const scope = { onmessage: undefined as unknown as (event: MessageEvent<WorkerRequest>) => Promise<void>, postMessage: vi.fn<(message: WorkerResponse, transfers?: Transferable[]) => void>() };
  vi.stubGlobal("self", scope); await import("./vision.worker");
  return { scope, request: (data: WorkerRequest) => scope.onmessage({ data } as MessageEvent<WorkerRequest>) };
}
describe("serialized worker learned startup", () => {
  it.each(["/", "/tcg-scan/"])("loads model data beneath the built application base %s", async base => {
    vi.stubEnv("BASE_URL", base);
    mocks.createModels.mockResolvedValue({ dispose: vi.fn() } as unknown as LearnedModels);
    mocks.loadIndex.mockResolvedValue([]);
    const w = await worker();
    await w.request({ id: 1, type: "initialize", options: { matcher: "learned", game: "pokemon" } });
    expect(mocks.createModels).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ baseUrl: `${base}vision-models/` }));
  });
  it("initializes models and small index, with zero reference descriptor reads", async () => {
    mocks.createModels.mockResolvedValue({ dispose: vi.fn() } as unknown as LearnedModels); mocks.loadIndex.mockResolvedValue([{ key: "metadata-only" }]);
    const w = await worker(); await w.request({ id: 1, type: "initialize", options: { matcher: "learned", game: "pokemon" } });
    expect(mocks.createModels).toHaveBeenCalledOnce(); expect(mocks.loadIndex).toHaveBeenCalledExactlyOnceWith("pokemon"); expect(mocks.loadReference).not.toHaveBeenCalled(); expect(mocks.orbConstructor).not.toHaveBeenCalled();
    expect(w.scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ id: 1, result: { engine: "XFeat256/int8 + RANSAC", coverage: { totalReferences: 2000 } } });
    expect(w.scope.postMessage.mock.calls.some(([r]) => !!r.progress)).toBe(true);
  });
  it("rejects overlapping analyze work without enqueueing or leaking dropped bitmaps", async () => {
    const w = await worker(); await w.request({ id: 1, type: "initialize" });
    let resolve!: (value: unknown) => void; mocks.analyze.mockReturnValue(new Promise(r => { resolve = r; }));
    const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;
    const first = w.request({ id: 2, type: "analyze", image, options: {} }); await Promise.resolve();
    const close = vi.fn(), dropped = { width: 2, height: 2, close } as unknown as ImageBitmap;
    await w.request({ id: 3, type: "analyze", image: dropped, options: {} });
    expect(close).toHaveBeenCalledOnce(); expect(mocks.analyze).toHaveBeenCalledOnce();
    expect(w.scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ id: 3, error: expect.stringContaining("busy") });
    resolve({ detections: [] }); await first;
  });
  it("releases initialized models when local index opening fails closed", async () => {
    const dispose = vi.fn(); mocks.createModels.mockResolvedValue({ dispose }); mocks.loadIndex.mockRejectedValue(new Error("Corrupt local index"));
    const w = await worker(); await w.request({ id: 1, type: "initialize", options: { matcher: "learned" } });
    expect(dispose).toHaveBeenCalledOnce(); expect(mocks.constructor).not.toHaveBeenCalled();
    expect(w.scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ id: 1, error: "Corrupt local index" });
  });
  it("keeps no-argument sessions on ORB with no learned model imports or index reads", async () => {
    const w = await worker(); await w.request({ id: 1, type: "initialize" });
    expect(mocks.orbConstructor).toHaveBeenCalledOnce(); expect(mocks.createModels).not.toHaveBeenCalled(); expect(mocks.loadIndex).not.toHaveBeenCalled();
    expect(w.scope.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ result: { engine: "OpenCV ORB + RANSAC" } });
  });
});

const rgba = (width = 2, height = 2) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) } satisfies VisionFramePixels);
const crop = (data = new Uint8ClampedArray(16)): ImageData => ({ width: 2, height: 2, data, colorSpace: "srgb" });
const result = (detections: Partial<CardDetection>[] = []) => ({ width: 2, height: 2, detections });
async function readyWorker() {
  const w = await worker();
  await w.request({ id: 1, type: "initialize" });
  mocks.analyze.mockResolvedValue(result());
  return w;
}

describe("recycled worker RGBA transfers", () => {
  it("returns the exact consumed buffer without constructing native ImageData", async () => {
    const nativeImageData = vi.fn(() => { throw new Error("Unexpected native allocation"); });
    vi.stubGlobal("ImageData", nativeImageData);
    const w = await readyWorker(), image = rgba();
    await w.request({ id: 2, type: "analyze", image, options: {} });
    expect(mocks.analyze).toHaveBeenCalledExactlyOnceWith(image, {});
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response).toMatchObject({ id: 2, result: result() });
    expect(response.frameBuffer).toBe(image.data.buffer); expect(transfers).toEqual([image.data.buffer]);
    expect(nativeImageData).not.toHaveBeenCalled();
  });
  it("round-trips real detached input and independent result buffers", async () => {
    const w = await readyWorker(), input = rgba(); input.data.fill(41);
    const sent = structuredClone(input, { transfer: [input.data.buffer] });
    expect(input.data.byteLength).toBe(0);
    const original = sent.data.buffer, output = crop(); output.data.fill(87);
    mocks.analyze.mockResolvedValue(result([{ crop: output }]));
    let received!: WorkerResponse;
    w.scope.postMessage.mockImplementation((message, transfers = []) => { received = structuredClone(message, { transfer: transfers }); });
    await w.request({ id: 2, type: "analyze", image: sent, options: { includeCrops: true } });
    expect(original.byteLength).toBe(0); expect(output.data.byteLength).toBe(0);
    expect(received.frameBuffer!.byteLength).toBe(16);
    expect([...new Uint8ClampedArray(received.frameBuffer!)]).toEqual(Array(16).fill(41));
    const live = (received.result as ReturnType<typeof result>).detections[0].crop!;
    new Uint8ClampedArray(received.frameBuffer!).fill(5);
    expect([...live.data]).toEqual(Array(16).fill(87));
    const next = structuredClone({ width: 2, height: 2, data: new Uint8ClampedArray(received.frameBuffer!) }, { transfer: [received.frameBuffer!] });
    expect(live.data.byteLength).toBe(16); expect(next.data[0]).toBe(5);
  });
  it("does not copy or double-transfer distinct crops shared across output fields", async () => {
    const w = await readyWorker(), image = rgba(), normal = crop(), printing = crop();
    const detection = { crop: normal, printingCrop: printing, hypotheses: [{ crop: normal, printingCrop: printing }] } as CardDetection;
    mocks.analyze.mockResolvedValue(result([detection]));
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(transfers).toHaveLength(3);
    expect(new Set(transfers)).toEqual(new Set([image.data.buffer, normal.data.buffer, printing.data.buffer]));
    expect((response.result as ReturnType<typeof result>).detections[0].crop).toBe(normal);
    expect((response.result as ReturnType<typeof result>).detections[0].printingCrop).toBe(printing);
  });
  it("isolates actual input aliases in crops, printing crops, and recursive hypotheses", async () => {
    const w = await readyWorker(), image = rgba(); image.data.fill(123);
    const alias = crop(image.data), independent = crop(); independent.data.fill(77);
    const detection = { crop: alias, printingCrop: independent, hypotheses: [{ printingCrop: alias, hypotheses: [{ crop: alias }] }] } as CardDetection;
    mocks.analyze.mockResolvedValue(result([detection]));
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    const current = (response.result as ReturnType<typeof result>).detections[0];
    const isolated = current.crop!;
    expect(isolated).not.toBe(alias); expect(isolated.data.buffer).not.toBe(image.data.buffer);
    expect(current.hypotheses![0].printingCrop).toBe(isolated);
    expect(current.hypotheses![0].hypotheses![0].crop).toBe(isolated);
    expect(current.printingCrop).toBe(independent);
    expect(transfers).toHaveLength(3); expect(new Set(transfers).size).toBe(3);
    image.data.fill(1);
    expect([...isolated.data]).toEqual(Array(16).fill(123));
    expect([...independent.data]).toEqual(Array(16).fill(77));
  });
  it("copies only the aliased crop view, retaining its dimensions and color space", async () => {
    const w = await readyWorker(), image = rgba(4, 4);
    image.data.set([10, 20, 30, 255], 12);
    const alias = { width: 1, height: 1, data: new Uint8ClampedArray(image.data.buffer, 12, 4), colorSpace: "display-p3" } as ImageData;
    mocks.analyze.mockResolvedValue(result([{ printingCrop: alias }]));
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const output = (w.scope.postMessage.mock.calls.at(-1)![0].result as ReturnType<typeof result>).detections[0].printingCrop!;
    expect(output).toMatchObject({ width: 1, height: 1, colorSpace: "display-p3" });
    expect(output.data.buffer.byteLength).toBe(4); expect([...output.data]).toEqual([10, 20, 30, 255]);
  });
  it("uses native ImageData for an aliased output when the API exists", async () => {
    class NativeImageData {
      colorSpace: PredefinedColorSpace;
      constructor(public data: Uint8ClampedArray, public width: number, public height: number, options: ImageDataSettings = {}) { this.colorSpace = options.colorSpace ?? "srgb"; }
    }
    vi.stubGlobal("ImageData", NativeImageData);
    const w = await readyWorker(), image = rgba();
    mocks.analyze.mockResolvedValue(result([{ crop: crop(image.data) }]));
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const output = (w.scope.postMessage.mock.calls.at(-1)![0].result as ReturnType<typeof result>).detections[0].crop!;
    expect(output).toBeInstanceOf(NativeImageData); expect(output.data.buffer).not.toBe(image.data.buffer);
  });
  it("handles repeated/cyclic diagnostic references without double-transferring", async () => {
    const w = await readyWorker(), image = rgba(), detection = { crop: crop() } as CardDetection;
    detection.hypotheses = [detection];
    mocks.analyze.mockResolvedValue(result([detection, detection]));
    await w.request({ id: 2, type: "analyze", image, options: {} });
    expect(w.scope.postMessage.mock.calls.at(-1)![1]).toHaveLength(2);
  });
  it.each([new Error("Model failed"), "Unexpected engine error", 17])("returns owned input after processing failure %s and remains usable", async error => {
    const w = await readyWorker(), image = rgba();
    mocks.analyze.mockRejectedValueOnce(error);
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response.error).toBe(error instanceof Error ? error.message : typeof error === "number" ? "OpenCV processing error (17)." : error);
    expect(response.frameBuffer).toBe(image.data.buffer); expect(transfers).toEqual([image.data.buffer]);
    await w.request({ id: 3, type: "analyze", image: rgba(), options: {} });
    expect(w.scope.postMessage.mock.calls.at(-1)![0]).toHaveProperty("result");
  });
  it("returns a dropped pixel buffer while another frame is busy, without touching that frame", async () => {
    const w = await readyWorker(), first = rgba(), dropped = rgba();
    let resolve!: (value: unknown) => void;
    mocks.analyze.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = w.request({ id: 2, type: "analyze", image: first, options: {} }); await Promise.resolve();
    await w.request({ id: 3, type: "analyze", image: dropped, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response).toMatchObject({ id: 3, error: expect.stringContaining("busy") });
    expect(response.frameBuffer).toBe(dropped.data.buffer); expect(transfers).toEqual([dropped.data.buffer]);
    expect(mocks.analyze).toHaveBeenCalledOnce();
    resolve(result()); await pending;
    expect(w.scope.postMessage.mock.calls.at(-1)![0].frameBuffer).toBe(first.data.buffer);
  });
  it.each([
    { width: 0, height: 1, data: new Uint8ClampedArray(4) },
    { width: -1, height: 1, data: new Uint8ClampedArray(4) },
    { width: 1.5, height: 1, data: new Uint8ClampedArray(4) },
    { width: 4097, height: 1, data: new Uint8ClampedArray(4) },
    { width: 4096, height: 4096, data: new Uint8ClampedArray(4) },
    { width: 2, height: 2, data: new Uint8ClampedArray(4) },
  ])("returns owned pixels even when their dimensions/data are invalid: $width × $height", async image => {
    const w = await readyWorker();
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response.error).toBeTruthy(); expect(response.frameBuffer).toBe(image.data.buffer);
    expect(transfers).toEqual([image.data.buffer]); expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("rejects empty or non-RGBA input without trying to return an unowned buffer", async () => {
    const w = await readyWorker();
    for (const data of [new Uint8ClampedArray(0), new Uint8Array(16), new Uint8ClampedArray(new SharedArrayBuffer(16))]) {
      await w.request({ id: 2, type: "analyze", image: { width: 2, height: 2, data } as VisionFramePixels, options: {} });
      const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
      expect(response.error).toBeTruthy(); expect(response.frameBuffer).toBeUndefined(); expect(transfers).toEqual([]);
    }
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("returns the input after engine startup fails", async () => {
    const w = await worker(), image = rgba();
    mocks.createModels.mockRejectedValue(new Error("Model load failed"));
    await w.request({ id: 1, type: "initialize", options: { matcher: "learned" } });
    await w.request({ id: 2, type: "analyze", image, options: {} });
    expect(w.scope.postMessage.mock.calls.at(-1)).toEqual([{ id: 2, error: "Model load failed", frameBuffer: image.data.buffer }, [image.data.buffer]]);
  });
  it("returns input on postMessage serialization failure, without retransferring output crops", async () => {
    const w = await readyWorker(), image = rgba(), output = crop();
    mocks.analyze.mockResolvedValue(result([{ crop: output }]));
    w.scope.postMessage.mockImplementationOnce(() => { throw new Error("DataCloneError"); });
    await w.request({ id: 2, type: "analyze", image, options: {} });
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response).toEqual({ id: 2, error: "DataCloneError", frameBuffer: image.data.buffer });
    expect(transfers).toEqual([image.data.buffer]);
  });
  it("also returns structured input used for an ORB reference", async () => {
    const w = await readyWorker(), image = rgba(), reference = { key: "sample", game: "pokemon", name: "Sample" } as const;
    mocks.addReference.mockReturnValue({ key: "sample" });
    await w.request({ id: 2, type: "add-reference", image, reference });
    expect(mocks.addReference).toHaveBeenCalledExactlyOnceWith(reference, image);
    expect(w.scope.postMessage.mock.calls.at(-1)).toEqual([{ id: 2, result: { key: "sample" }, frameBuffer: image.data.buffer }, [image.data.buffer]]);
  });
});

describe("legacy bitmap ownership", () => {
  it.each([false, true])("closes a bitmap exactly once after processing (failure=%s)", async fails => {
    const w = await readyWorker(), pixels = rgba(), close = vi.fn();
    const context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
    vi.stubGlobal("OffscreenCanvas", class { getContext() { return context; } });
    if (fails) mocks.analyze.mockRejectedValueOnce(new Error("Analysis failed"));
    const image = { width: 2, height: 2, close } as unknown as ImageBitmap;
    await w.request({ id: 2, type: "analyze", image, options: {} });
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(mocks.analyze).toHaveBeenCalledWith(pixels, {}); expect(close).toHaveBeenCalledOnce();
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response.frameBuffer).toBeUndefined(); expect(transfers).toEqual([]);
  });
  it("closes a bitmap if canvas conversion fails", async () => {
    const w = await readyWorker(), close = vi.fn();
    vi.stubGlobal("OffscreenCanvas", class { getContext() { return null; } });
    await w.request({ id: 2, type: "analyze", image: { width: 2, height: 2, close } as unknown as ImageBitmap, options: {} });
    expect(close).toHaveBeenCalledOnce(); expect(mocks.analyze).not.toHaveBeenCalled();
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("OffscreenCanvas");
  });
});

const roiQuad: Quad = [{ x: 10, y: 10 }, { x: 54, y: 10 }, { x: 54, y: 54 }, { x: 10, y: 54 }];
const grayFrame = (frameId: number, timestampMs = 1_000_000 + frameId * 100): RoiContinuityFrame => ({ width: 64, height: 64, gray: new Uint8Array(4096), frameId, timestampMs });
function continuityRequest(batchId = "batch-a", ids = [0, 1, 2], eventIds = ["card-a"]): VisionContinuityRequest {
  const frames = ids.map(id => grayFrame(id));
  return { batchId, seeds: eventIds.map(eventId => ({ eventId, quad: roiQuad })), frames, latestFrameId: frames.at(-1)!.frameId, latestTimestampMs: frames.at(-1)!.timestampMs };
}
function mockCaptureClock(now = 250) {
  const clock = { timeOrigin: 1_000_000, now: vi.fn(() => now) };
  vi.stubGlobal("performance", clock); return clock;
}
async function continuityWorker() { mockCaptureClock(); return readyWorker(); }

describe("bounded continuity worker protocol", () => {
  it("arms all ROIs from the same exact seed, replays in order, and adds no identity or exit evidence", async () => {
    const w = await continuityWorker(), request = continuityRequest("batch-a", [0, 1, 2], ["a", "b"]), seed = request.frames[0];
    const inputBuffers = request.frames.map(f => f.gray.buffer);
    await w.request({ id: 2, type: "verify-continuity", request });
    expect(mocks.continuityConstructor).toHaveBeenCalledTimes(2);
    expect(mocks.continuityConstructor.mock.calls[0][0]).toBe(mocks.orbConstructor.mock.calls[0][0]);
    expect(mocks.continuityArm.mock.calls.map(([s]) => s.frame)).toEqual([seed, seed]);
    expect(mocks.continuityArm.mock.calls.every(([s]) => s.geometryVerified === true)).toBe(true);
    expect(mocks.continuityReplay.mock.calls.map(([f]) => f.map((v: { frameId: number }) => v.frameId))).toEqual([[1, 2], [1, 2], [], []]);
    const [response, transfers] = w.scope.postMessage.mock.calls.at(-1)!;
    expect(response.result).toMatchObject({ batchId: "batch-a", results: [{ eventId: "a", status: "continuous", identityObservations: 0, exitEvidence: false }, { eventId: "b", status: "continuous", identityObservations: 0, exitEvidence: false }] });
    expect(mocks.analyze).not.toHaveBeenCalled(); expect(mocks.createModels).not.toHaveBeenCalled(); expect(mocks.loadReference).not.toHaveBeenCalled();
    expect(transfers).toEqual([]); expect(request.frames).toHaveLength(0);
    expect(inputBuffers.every(buffer => buffer.byteLength === 0)).toBe(true);
  });
  it("extends an existing batch without rearming or repeating the seed", async () => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    const next = continuityRequest("batch-a", [3, 4]); delete next.seeds; mockCaptureClock(450);
    await w.request({ id: 3, type: "verify-continuity", request: next });
    expect(mocks.continuityArm).toHaveBeenCalledOnce();
    expect(mocks.continuityReplay.mock.calls.at(-2)![0].map((f: { frameId: number }) => f.frameId)).toEqual([3, 4]);
    expect(w.scope.postMessage.mock.calls.at(-1)![0].result).toMatchObject({ batchId: "batch-a", results: [{ postSeedSamples: 4, latestFrameId: 4 }] });
  });
  it("derives freshness from the absolute worker clock after all replay work", async () => {
    const w = await continuityWorker(), clock = mockCaptureClock(250);
    mocks.continuityReplay.mockImplementation(frames => { if (frames.length) clock.now.mockReturnValue(650); });
    const request = { ...continuityRequest(), checkedAtTimestampMs: 0 };
    await w.request({ id: 2, type: "verify-continuity", request });
    expect(mocks.continuityReplay.mock.calls[0][1].checkedAtTimestampMs).toBe(1_000_250);
    expect(mocks.continuityReplay.mock.calls[1][1].checkedAtTimestampMs).toBe(1_000_650);
    expect(w.scope.postMessage.mock.calls.at(-1)![0].result).toMatchObject({ results: [{ status: "pending", reason: "latest-capture-stale", identityObservations: 0, exitEvidence: false }] });
  });
  it("allows nine guards and disposes all of them when a new batch replaces them", async () => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest("batch-a", [0, 1, 2], Array.from({ length: 9 }, (_, i) => `card-${i}`)) });
    expect(mocks.continuityConstructor).toHaveBeenCalledTimes(9);
    await w.request({ id: 3, type: "verify-continuity", request: continuityRequest("batch-b", [3, 4, 5]) });
    expect(mocks.continuityDispose).toHaveBeenCalledTimes(9); expect(mocks.continuityConstructor).toHaveBeenCalledTimes(10);
  });
  it("rejects a tenth guard before arming and invalidates the old batch", async () => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    await w.request({ id: 3, type: "verify-continuity", request: continuityRequest("batch-b", [3, 4, 5], Array.from({ length: 10 }, (_, i) => `card-${i}`)) });
    expect(mocks.continuityConstructor).toHaveBeenCalledOnce(); expect(mocks.continuityDispose).toHaveBeenCalledOnce();
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("Invalid bounded");
    const old = continuityRequest("batch-a", [3]); delete old.seeds;
    await w.request({ id: 4, type: "verify-continuity", request: old });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("current batch");
  });
  it("accepts 120 frames and rejects 121 without a grayscale ring", async () => {
    const w = await continuityWorker(), accepted = continuityRequest("batch-a", Array.from({ length: 120 }, (_, i) => i)); mockCaptureClock(11_950);
    await w.request({ id: 2, type: "verify-continuity", request: accepted });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toBeUndefined(); expect(accepted.frames).toHaveLength(0);
    const overflow = continuityRequest("batch-b", Array.from({ length: 121 }, (_, i) => i));
    await w.request({ id: 3, type: "verify-continuity", request: overflow });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("Invalid bounded"); expect(overflow.frames).toHaveLength(0);
  });
  it("rejects a logically over-32MiB replay even when frames alias the same buffer", async () => {
    const w = await continuityWorker(), gray = new Uint8Array(640 * 640);
    const frames = Array.from({ length: 82 }, (_, frameId) => ({ width: 640, height: 640, gray, frameId, timestampMs: 1_000_000 + frameId }));
    await w.request({ id: 2, type: "verify-continuity", request: { ...continuityRequest(), frames, latestFrameId: 81, latestTimestampMs: 1_000_081 } });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("Invalid bounded");
    expect(mocks.continuityConstructor).not.toHaveBeenCalled(); expect(gray.byteLength).toBe(0);
  });
  it.each([
    ["empty batch", (r: VisionContinuityRequest) => { r.batchId = ""; }],
    ["oversized batch ID", (r: VisionContinuityRequest) => { r.batchId = "x".repeat(257); }],
    ["duplicate events", (r: VisionContinuityRequest) => { r.seeds!.push(r.seeds![0]); }],
    ["nonfinite quad", (r: VisionContinuityRequest) => { r.seeds = [{ eventId: "a", quad: [{ x: NaN, y: 10 }, ...roiQuad.slice(1)] as Quad }]; }],
    ["empty frames", (r: VisionContinuityRequest) => { r.frames = []; }],
    ["gap", (r: VisionContinuityRequest) => { r.frames[1].frameId = 5; }],
    ["reorder", (r: VisionContinuityRequest) => { r.frames.reverse(); }],
    ["repeated time", (r: VisionContinuityRequest) => { r.frames[1].timestampMs = r.frames[0].timestampMs; }],
    ["nonfinite time", (r: VisionContinuityRequest) => { r.frames[1].timestampMs = NaN; }],
    ["long capture gap", (r: VisionContinuityRequest) => { r.frames[1].timestampMs += 301; }],
    ["latest mismatch", (r: VisionContinuityRequest) => { r.latestFrameId++; }],
    ["latest nonfinite", (r: VisionContinuityRequest) => { r.latestTimestampMs = Infinity; }],
    ["oversized edge", (r: VisionContinuityRequest) => { r.frames[0].width = 641; }],
    ["short edge", (r: VisionContinuityRequest) => { r.frames[0].width = 63; }],
    ["short data", (r: VisionContinuityRequest) => { r.frames[0].gray = new Uint8Array(1); }],
    ["shared data", (r: VisionContinuityRequest) => { r.frames[0].gray = new Uint8Array(new SharedArrayBuffer(4096)); }],
  ] as const)("rejects malformed %s before any guard is advanced", async (_name, mutate) => {
    const w = await continuityWorker(), request = continuityRequest(); mutate(request);
    await w.request({ id: 2, type: "verify-continuity", request });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toBeTruthy();
    expect(mocks.continuityArm).not.toHaveBeenCalled(); expect(mocks.continuityReplay).not.toHaveBeenCalled();
  });
  it.each(["wrong-batch", "gap", "time-gap", "reseed", "stale-request"])("fails closed across follow-up boundaries: %s", async problem => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    const follow = continuityRequest(problem === "wrong-batch" ? "old-batch" : "batch-a", [problem === "gap" ? 4 : 3]);
    if (problem !== "reseed") delete follow.seeds;
    if (problem === "time-gap") follow.latestTimestampMs = follow.frames[0].timestampMs += 301;
    await w.request({ id: problem === "stale-request" ? 2 : 3, type: "verify-continuity", request: follow });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toBeTruthy(); expect(mocks.continuityDispose).toHaveBeenCalledOnce();
  });
  it("reset disposes state, does not call identity analysis, and prevents old-batch follow-up", async () => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    await w.request({ id: 3, type: "reset-continuity" });
    expect(mocks.continuityDispose).toHaveBeenCalledOnce(); expect(mocks.analyze).not.toHaveBeenCalled();
    const follow = continuityRequest("batch-a", [3]); delete follow.seeds;
    await w.request({ id: 4, type: "verify-continuity", request: follow });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("current batch");
  });
  it("busy continuity is rejected, frees input, and invalidates old guards", async () => {
    const w = await continuityWorker();
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    let resolve!: (value: unknown) => void;
    mocks.analyze.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const analysis = w.request({ id: 3, type: "analyze", image: rgba(), options: {} }); await Promise.resolve();
    const request = continuityRequest("batch-b"), buffers = request.frames.map(f => f.gray.buffer);
    await w.request({ id: 4, type: "verify-continuity", request });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("busy");
    expect(mocks.continuityDispose).toHaveBeenCalledOnce(); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
    resolve(result()); await analysis;
  });
  it("a busy reset invalidates an in-flight continuity request before its replay begins", async () => {
    const w = await continuityWorker(), request = continuityRequest();
    const pending = w.request({ id: 2, type: "verify-continuity", request });
    await w.request({ id: 3, type: "reset-continuity" });
    await pending;
    expect(mocks.continuityArm).not.toHaveBeenCalled();
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toContain("invalidated");
  });
  it("guard runtime failures dispose all partial state and release every input buffer", async () => {
    const w = await continuityWorker(), request = continuityRequest("batch-a", [0, 1, 2], ["a", "b"]), buffers = request.frames.map(f => f.gray.buffer);
    mocks.continuityReplay.mockImplementationOnce(() => { throw new Error("CV failure"); });
    await w.request({ id: 2, type: "verify-continuity", request });
    expect(w.scope.postMessage.mock.calls.at(-1)![0].error).toBe("CV failure");
    expect(mocks.continuityDispose).toHaveBeenCalledTimes(2); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
  });
  it("preserves per-event guard rejections as zero-observation, non-exit results", async () => {
    const w = await continuityWorker();
    mocks.continuityReplay.mockImplementation((_frames, _latest, guard) => ({ eventId: guard.eventId, status: "rejected", reason: "appearance-changed", processingMs: 1, postSeedSamples: 0, identityObservations: 0, exitEvidence: false }));
    await w.request({ id: 2, type: "verify-continuity", request: continuityRequest() });
    const response = w.scope.postMessage.mock.calls.at(-1)![0].result as VisionContinuityResult;
    expect(response.results).toEqual([{ eventId: "card-a", status: "rejected", reason: "appearance-changed", processingMs: 2, postSeedSamples: 0, identityObservations: 0, exitEvidence: false }]);
  });
});
