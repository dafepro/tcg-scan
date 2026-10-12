import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionBusyError, VisionClient } from "./index";
import type { Quad, VisionContinuityRequest, VisionContinuityResult, VisionFramePixels, WorkerRequest, WorkerResponse } from "./types";
class FakeWorker {
  static instances: FakeWorker[] = [];
  static transferMessages = false;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | undefined;
  onerror: ((event: ErrorEvent) => void) | undefined;
  onmessageerror: (() => void) | undefined;
  requests: WorkerRequest[] = [];
  transfers: Transferable[][] = [];
  received: WorkerResponse[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: WorkerRequest, transfers: Transferable[] = []) {
    this.transfers.push(transfers);
    this.requests.push(FakeWorker.transferMessages ? structuredClone(message, { transfer: transfers }) : message);
  }
  receive(response: WorkerResponse, transfers: Transferable[] = []) {
    const data = FakeWorker.transferMessages ? structuredClone(response, { transfer: transfers }) : response;
    this.received.push(data);
    this.onmessage?.({ data } as MessageEvent<WorkerResponse>);
  }
  reply(request: WorkerRequest, result: unknown, frameBuffer?: ArrayBuffer) {
    this.receive({ id: request.id, result, ...(frameBuffer ? { frameBuffer } : {}) }, frameBuffer ? [frameBuffer] : []);
  }
}
const coverage = { totalReferences: 0, byGame: { pokemon: 0, mtg: 0, yugioh: 0 }, packs: [] };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWorker.instances = []; FakeWorker.transferMessages = false; });

describe("persistent bounded vision worker client", () => {
  it("reuses one worker and drops concurrent frames instead of queuing them", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient();
    const bitmap = () => ({ width: 320, height: 240, close: vi.fn() }) as unknown as ImageBitmap;
    const first = bitmap(), dropped = bitmap();
    const analysis = client.analyze(first);
    expect(client.busy).toBe(true);
    await expect(client.analyze(dropped)).rejects.toBeInstanceOf(VisionBusyError);
    expect(dropped.close).toHaveBeenCalledOnce();
    const worker = FakeWorker.instances[0];
    worker.reply(worker.requests[0], { engine: "OpenCV ORB + RANSAC", coverage });
    await Promise.resolve(); await Promise.resolve();
    expect(worker.requests).toHaveLength(2);
    const result = { width: 320, height: 240, detections: [], coverage, budgetExhausted: false, timings: { detectionMs: 1, extractionMs: 0, matchingMs: 0, totalMs: 1 } };
    worker.reply(worker.requests[1], result);
    await expect(analysis).resolves.toEqual(result);
    expect(client.busy).toBe(false);
    await client.initialize();
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects pending work and closes an untransferred bitmap when disposed", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const pending = client.analyze(bitmap);
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(bitmap.close).toHaveBeenCalled();
    await expect(client.initialize()).rejects.toThrow("disposed");
  });
});

describe("learned client configuration and stale callbacks", () => {
  it("forwards learned initialization once and treats progress as nonterminal", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), progress = vi.fn();
    const initialized = client.initialize({ matcher: "learned", game: "pokemon" }, progress);
    const worker = FakeWorker.instances[0], request = worker.requests[0];
    expect(request).toMatchObject({ type: "initialize", options: { matcher: "learned", game: "pokemon" } });
    worker.onmessage?.({ data: { id: request.id, progress: "Opening local metadata…" } } as MessageEvent<WorkerResponse>);
    expect(progress).toHaveBeenCalledWith("Opening local metadata…");
    worker.reply(request, { engine: "XFeat256/int8 + RANSAC", coverage });
    await expect(initialized).resolves.toMatchObject({ engine: "XFeat256/int8 + RANSAC" });
    await client.initialize(); expect(worker.requests).toHaveLength(1);
    await expect(client.initialize({ matcher: "orb" })).rejects.toThrow("new vision client");
    client.dispose();
  });
  it("drops progress/results from a disposed session", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), progress = vi.fn();
    const initialized = client.initialize({ matcher: "learned" }, progress);
    const worker = FakeWorker.instances[0], request = worker.requests[0];
    client.dispose();
    worker.onmessage?.({ data: { id: request.id, progress: "Too late" } } as MessageEvent<WorkerResponse>);
    worker.reply(request, { engine: "XFeat256/int8 + RANSAC", coverage });
    await expect(initialized).rejects.toThrow("disposed"); expect(progress).not.toHaveBeenCalled();
  });
  it("permits an explicit long photo budget while keeping one frame in flight", async () => {
    vi.useFakeTimers(); vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), initialize = client.initialize({ matcher: "learned" });
    const worker = FakeWorker.instances[0]; worker.reply(worker.requests[0], { engine: "XFeat256/int8 + RANSAC", coverage }); await initialize;
    const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData;
    const pending = client.analyze(image, { mode: "photo", budgetMs: 120_000 });
    await Promise.resolve(); await Promise.resolve();
    vi.advanceTimersByTime(35_000); expect(worker.terminate).not.toHaveBeenCalled(); expect(client.busy).toBe(true);
    worker.reply(worker.requests[1], { detections: [] }); await pending; client.dispose(); vi.useRealTimers();
  });
});

const rgba = (width = 2, height = 2) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) } satisfies VisionFramePixels);
const emptyResult = { width: 2, height: 2, detections: [], coverage, budgetExhausted: false, timings: { detectionMs: 0, extractionMs: 0, matchingMs: 0, totalMs: 0 } };
async function readyClient() {
  vi.stubGlobal("Worker", FakeWorker);
  const client = new VisionClient(), pending = client.initialize();
  const worker = FakeWorker.instances.at(-1)!;
  worker.reply(worker.requests[0], { engine: "OpenCV ORB + RANSAC", coverage });
  await pending;
  return { client, worker };
}
async function submitted(client: VisionClient, worker: FakeWorker, image = rgba()) {
  const pending = client.analyze(image);
  await Promise.resolve(); await Promise.resolve();
  const request = worker.requests.at(-1)!;
  expect(request.type).toBe("analyze");
  return { pending, request };
}

describe("recycled RGBA client ownership", () => {
  it.each([0, -4, 1, 2, 5, 1.5, NaN, Infinity, 64_000_004])("rejects invalid buffer size %s", byteLength => {
    const client = new VisionClient();
    expect(() => client.takeFrameBuffer(byteLength)).toThrow(RangeError);
    client.dispose();
  });
  it("transfers plain pixels and takes the same returned buffer only once", async () => {
    const { client, worker } = await readyClient(), image = rgba();
    const input = image.data.buffer, { pending, request } = await submitted(client, worker, image);
    expect(worker.transfers.at(-1)).toEqual([input]);
    expect(request).toMatchObject({ image });
    worker.reply(request, emptyResult, input);
    await pending;
    expect(client.takeFrameBuffer(16)).toBe(input);
    expect(client.takeFrameBuffer(16)).not.toBe(input);
    client.dispose();
  });
  it("round-trips transferred ownership repeatedly without retaining detached buffers", async () => {
    FakeWorker.transferMessages = true;
    const { client, worker } = await readyClient();
    let returned: ArrayBuffer | undefined;
    for (let frame = 0; frame < 64; frame++) {
      const buffer = client.takeFrameBuffer(16);
      if (returned) expect(buffer).toBe(returned);
      const data = new Uint8ClampedArray(buffer); data.fill(frame);
      const { pending, request } = await submitted(client, worker, { width: 2, height: 2, data });
      expect(buffer.byteLength).toBe(0);
      const incoming = (request as Extract<WorkerRequest, { type: "analyze" }>).image as VisionFramePixels;
      expect([...incoming.data]).toEqual(Array(16).fill(frame));
      const consumed = incoming.data.buffer as ArrayBuffer;
      worker.reply(request, emptyResult, consumed);
      expect(consumed.byteLength).toBe(0);
      await pending;
      returned = worker.received.at(-1)!.frameBuffer!;
      expect([...new Uint8ClampedArray(returned)]).toEqual(Array(16).fill(frame));
    }
    client.dispose();
  });
  it("retains only the latest spare and discards mismatched sizes", async () => {
    const { client, worker } = await readyClient(), first = rgba(), second = rgba();
    const a = await submitted(client, worker, first); worker.reply(a.request, emptyResult, first.data.buffer); await a.pending;
    const b = await submitted(client, worker, second); worker.reply(b.request, emptyResult, second.data.buffer); await b.pending;
    expect(client.takeFrameBuffer(16)).toBe(second.data.buffer);
    const fresh = client.takeFrameBuffer(16);
    expect(fresh).not.toBe(first.data.buffer); expect(fresh).not.toBe(second.data.buffer);
    const c = await submitted(client, worker, first); worker.reply(c.request, emptyResult, first.data.buffer); await c.pending;
    expect(client.takeFrameBuffer(32).byteLength).toBe(32);
    expect(client.takeFrameBuffer(16)).not.toBe(first.data.buffer);
    client.dispose();
  });
  it.each(["Processing failed", "Local recognition is busy; drop this request instead of queuing it."])("recycles worker error responses: %s", async error => {
    const { client, worker } = await readyClient(), image = rgba();
    const { pending, request } = await submitted(client, worker, image);
    worker.receive({ id: request.id, error, frameBuffer: image.data.buffer });
    await expect(pending).rejects.toThrow(error);
    expect(client.busy).toBe(false); expect(client.takeFrameBuffer(16)).toBe(image.data.buffer);
    client.dispose();
  });
  it("drops concurrent RGBA without transferring it or replacing the returning spare", async () => {
    const { client, worker } = await readyClient(), image = rgba(), dropped = rgba();
    const { pending, request } = await submitted(client, worker, image);
    await expect(client.analyze(dropped)).rejects.toBeInstanceOf(VisionBusyError);
    expect(worker.requests).toHaveLength(2); expect(dropped.data.byteLength).toBe(16);
    worker.reply(request, emptyResult, image.data.buffer); await pending;
    expect(client.takeFrameBuffer(16)).toBe(image.data.buffer);
    client.dispose();
  });
  it("accepts an exact-length RGBA view inside a larger transferable backing buffer", async () => {
    const { client, worker } = await readyClient(), buffer = new ArrayBuffer(32);
    const { pending, request } = await submitted(client, worker, { width: 2, height: 2, data: new Uint8ClampedArray(buffer, 4, 16) });
    worker.reply(request, emptyResult, buffer); await pending;
    expect(client.takeFrameBuffer(32)).toBe(buffer);
    client.dispose();
  });
  it.each([
    { width: 0, height: 2, data: new Uint8ClampedArray(0) },
    { width: -1, height: 2, data: new Uint8ClampedArray(0) },
    { width: 1.5, height: 2, data: new Uint8ClampedArray(12) },
    { width: 1, height: 1, data: new Uint8ClampedArray(0) },
    { width: 2, height: 2, data: new Uint8ClampedArray(12) },
    { width: 2, height: 2, data: new Uint8Array(16) },
    { width: 4097, height: 1, data: new Uint8ClampedArray(4097 * 4) },
  ])("rejects invalid pixels before creating a worker: $width × $height", async image => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient();
    await expect(client.analyze(image as VisionFramePixels)).rejects.toThrow("Invalid packed RGBA");
    expect(FakeWorker.instances).toHaveLength(0); expect(client.busy).toBe(false);
    client.dispose();
  });
  it("rejects SharedArrayBuffer pixels rather than attempting an invalid transfer", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient();
    const image = { width: 2, height: 2, data: new Uint8ClampedArray(new SharedArrayBuffer(16)) };
    await expect(client.analyze(image as VisionFramePixels)).rejects.toThrow("Invalid packed RGBA");
    expect(FakeWorker.instances).toHaveLength(0); client.dispose();
  });
});

describe("recycled response validation and session lifecycle", () => {
  it.each([new ArrayBuffer(0), new ArrayBuffer(8), new Uint8ClampedArray(16), { byteLength: 16 }, undefined])("rejects malformed returned buffers (%s)", async frameBuffer => {
    const { client, worker } = await readyClient(), { pending, request } = await submitted(client, worker);
    worker.receive({ id: request.id, result: emptyResult, frameBuffer } as WorkerResponse);
    await expect(pending).rejects.toThrow("invalid response");
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(client.busy).toBe(false);
    expect(client.takeFrameBuffer(16).byteLength).toBe(16); client.dispose();
  });
  it.each([
    null,
    {},
    { result: emptyResult },
    { result: emptyResult, error: "Both terminal variants" },
    { error: "" },
    { progress: 42 },
    { progress: "Still loading", frameBuffer: new ArrayBuffer(16) },
  ])("fails closed on malformed terminal or progress envelopes: %s", async malformed => {
    const { client, worker } = await readyClient(), { pending, request } = await submitted(client, worker);
    const response = malformed === null ? null : { id: request.id, ...malformed };
    // The result-only case intentionally loses the request ID.
    if (malformed && Object.keys(malformed).length === 1 && "result" in malformed) delete (response as Partial<WorkerResponse>).id;
    worker.receive(response as WorkerResponse);
    await expect(pending).rejects.toThrow("invalid response");
    expect(worker.terminate).toHaveBeenCalledOnce(); client.dispose();
  });
  it("never accepts an unsolicited frame buffer on initialization", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), pending = client.initialize(), worker = FakeWorker.instances[0];
    worker.reply(worker.requests[0], { engine: "OpenCV ORB + RANSAC", coverage }, new ArrayBuffer(16));
    await expect(pending).rejects.toThrow("invalid response"); client.dispose();
  });
  it.each(["crop", "printingCrop", "nested"])("rejects returned input aliasing a live %s", async key => {
    const { client, worker } = await readyClient(), image = rgba(), { pending, request } = await submitted(client, worker, image);
    const crop = { ...image, colorSpace: "srgb" };
    const detection = key === "nested" ? { hypotheses: [{ hypotheses: [{ printingCrop: crop }] }] } : { [key]: crop };
    worker.reply(request, { ...emptyResult, detections: [detection] }, image.data.buffer);
    await expect(pending).rejects.toThrow("invalid response");
    expect(client.takeFrameBuffer(16)).not.toBe(image.data.buffer); client.dispose();
  });
  it("does not mistake independent crop output for recycled input", async () => {
    const { client, worker } = await readyClient(), image = rgba(), crop = rgba();
    const { pending, request } = await submitted(client, worker, image);
    worker.reply(request, { ...emptyResult, detections: [{ crop }] }, image.data.buffer);
    await expect(pending).resolves.toMatchObject({ detections: [{ crop }] });
    new Uint8ClampedArray(client.takeFrameBuffer(16)).fill(123);
    expect([...crop.data]).toEqual(Array(16).fill(0)); client.dispose();
  });
  it("ignores duplicate and unknown replies without overwriting a spare", async () => {
    const { client, worker } = await readyClient(), image = rgba(), late = new ArrayBuffer(16);
    const { pending, request } = await submitted(client, worker, image);
    worker.reply(request, emptyResult, image.data.buffer); await pending;
    worker.reply(request, emptyResult, late);
    worker.receive({ id: request.id + 1, result: emptyResult, frameBuffer: late });
    expect(client.takeFrameBuffer(16)).toBe(image.data.buffer); client.dispose();
  });
  it("disposal clears a spare, rejects pending work, and drops all late results", async () => {
    const { client, worker } = await readyClient(), image = rgba();
    const first = await submitted(client, worker, image); worker.reply(first.request, emptyResult, image.data.buffer); await first.pending;
    const second = await submitted(client, worker);
    client.dispose();
    worker.reply(second.request, emptyResult, image.data.buffer);
    await expect(second.pending).rejects.toThrow("disposed");
    expect(() => client.takeFrameBuffer(16)).toThrow("disposed");
    expect(client.busy).toBe(false);
  });
  it.each(["error", "messageerror", "timeout"])("clears the spare and quarantines stale worker callbacks after %s", async failure => {
    vi.useFakeTimers();
    const { client, worker } = await readyClient(), image = rgba();
    const first = await submitted(client, worker, image); worker.reply(first.request, emptyResult, image.data.buffer); await first.pending;
    const old = await submitted(client, worker);
    if (failure === "error") worker.onerror?.({ message: "Worker failed" } as ErrorEvent);
    else if (failure === "messageerror") worker.onmessageerror?.();
    else vi.advanceTimersByTime(30_000);
    await expect(old.pending).rejects.toThrow();
    expect(client.takeFrameBuffer(16)).not.toBe(image.data.buffer);
    const initialized = client.initialize(), replacement = FakeWorker.instances.at(-1)!;
    worker.reply(old.request, emptyResult, image.data.buffer);
    worker.onerror?.({ message: "Stale failure" } as ErrorEvent); worker.onmessageerror?.();
    expect(replacement.terminate).not.toHaveBeenCalled();
    replacement.reply(replacement.requests[0], { engine: "OpenCV ORB + RANSAC", coverage }); await initialized;
    expect(client.takeFrameBuffer(16)).not.toBe(image.data.buffer);
    client.dispose();
  });
  it("an old rejected analysis cannot clear a newer frame's backpressure", async () => {
    const { client, worker } = await readyClient(), old = await submitted(client, worker);
    worker.onerror?.({ message: "Worker failed" } as ErrorEvent);
    const nextImage = rgba(), next = client.analyze(nextImage), replacement = FakeWorker.instances.at(-1)!;
    await expect(old.pending).rejects.toThrow("Worker failed");
    expect(client.busy).toBe(true);
    replacement.reply(replacement.requests[0], { engine: "OpenCV ORB + RANSAC", coverage });
    await Promise.resolve(); await Promise.resolve();
    replacement.reply(replacement.requests.at(-1)!, emptyResult, nextImage.data.buffer);
    await next; expect(client.busy).toBe(false); client.dispose();
  });
  it("clears a failed synchronous transfer request without leaving a timeout", async () => {
    vi.useFakeTimers();
    const { client, worker } = await readyClient();
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => { throw new Error("DataCloneError"); });
    await expect(client.analyze(rgba())).rejects.toThrow("DataCloneError");
    expect(client.busy).toBe(false);
    vi.advanceTimersByTime(180_000); expect(worker.terminate).not.toHaveBeenCalled(); client.dispose();
  });
});

const continuityQuad: Quad = [{ x: 10, y: 10 }, { x: 54, y: 10 }, { x: 54, y: 54 }, { x: 10, y: 54 }];
function continuityInput(batchId = "batch-a", ids = [0, 1, 2], eventIds = ["a"]): VisionContinuityRequest {
  const frames = ids.map(frameId => ({ width: 64, height: 64, gray: new Uint8Array(4096), frameId, timestampMs: 1_000_000 + frameId * 100 }));
  return { batchId, seeds: eventIds.map(eventId => ({ eventId, quad: continuityQuad })), frames, latestFrameId: frames.at(-1)!.frameId, latestTimestampMs: frames.at(-1)!.timestampMs };
}
function continuityResult(request: VisionContinuityRequest, eventIds = request.seeds?.map(s => s.eventId) ?? ["a"]): VisionContinuityResult {
  return { batchId: request.batchId, results: eventIds.map(eventId => ({ eventId, status: "pending", reason: "more-samples", processingMs: 1, postSeedSamples: 0, identityObservations: 0, exitEvidence: false })) };
}
async function submitContinuity(client: VisionClient, worker: FakeWorker, input = continuityInput()) {
  const pending = client.verifyContinuity(input);
  await Promise.resolve(); await Promise.resolve();
  const request = worker.requests.at(-1)!;
  expect(request.type).toBe("verify-continuity");
  return { pending, request, input };
}
async function acknowledgeReset(worker: FakeWorker) {
  await Promise.resolve(); await Promise.resolve();
  expect(worker.requests.at(-1)!.type).toBe("reset-continuity");
  worker.reply(worker.requests.at(-1)!, undefined);
}

describe("bounded continuity client protocol", () => {
  it("transfers grayscale ownership through the existing worker and forwards new/follow-up batches", async () => {
    FakeWorker.transferMessages = true;
    const { client, worker } = await readyClient(), input = continuityInput("batch-a", [0, 1, 2], ["a", "b"]), buffers = input.frames.map(f => f.gray.buffer);
    const first = await submitContinuity(client, worker, input);
    expect(client.busy).toBe(true); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(worker.transfers.at(-1)).toHaveLength(3);
    worker.reply(first.request, continuityResult(input)); await first.pending;
    const follow = continuityInput("batch-a", [3, 4]); delete follow.seeds;
    const next = await submitContinuity(client, worker, follow);
    expect(next.request).toMatchObject({ type: "verify-continuity", request: { batchId: "batch-a", latestFrameId: 4 } });
    worker.reply(next.request, continuityResult(follow, ["a", "b"])); await next.pending;
    expect(FakeWorker.instances).toHaveLength(1); expect(client.busy).toBe(false); client.dispose();
  });
  it("deduplicates aliased gray transfers without inventing capture observations", async () => {
    const { client, worker } = await readyClient(), input = continuityInput(), gray = input.frames[0].gray;
    input.frames.forEach(f => { f.gray = gray; });
    const sent = await submitContinuity(client, worker, input);
    expect(worker.transfers.at(-1)).toEqual([gray.buffer]);
    worker.reply(sent.request, continuityResult(input));
    const response = await sent.pending;
    expect(response.results[0]).toMatchObject({ identityObservations: 0, exitEvidence: false }); client.dispose();
  });
  it("shares one-flight backpressure with analyze and reset, without transferring rejected frames", async () => {
    const { client, worker } = await readyClient(), active = await submitContinuity(client, worker), dropped = continuityInput("batch-b");
    const bitmap = { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap;
    await expect(client.analyze(bitmap)).rejects.toBeInstanceOf(VisionBusyError); expect(bitmap.close).toHaveBeenCalledOnce();
    await expect(client.verifyContinuity(dropped)).rejects.toBeInstanceOf(VisionBusyError);
    await expect(client.resetContinuity()).rejects.toBeInstanceOf(VisionBusyError);
    expect(dropped.frames[0].gray.byteLength).toBe(4096); expect(worker.requests).toHaveLength(2);
    worker.reply(active.request, continuityResult(active.input)); await active.pending;
    const analysis = await submitted(client, worker);
    await expect(client.verifyContinuity(continuityInput("batch-c"))).rejects.toBeInstanceOf(VisionBusyError);
    worker.reply(analysis.request, emptyResult); await analysis.pending; client.dispose();
  });
  it.each([
    ["empty batch", (r: VisionContinuityRequest) => { r.batchId = ""; }],
    ["too many ROIs", (r: VisionContinuityRequest) => { r.seeds = Array.from({ length: 10 }, (_, i) => ({ eventId: `${i}`, quad: continuityQuad })); }],
    ["too many frames", (r: VisionContinuityRequest) => { r.frames = Array.from({ length: 121 }, () => r.frames[0]); }],
    ["bad gray", (r: VisionContinuityRequest) => { r.frames[0].gray = new Uint8Array(0); }],
    ["nonfinite latest", (r: VisionContinuityRequest) => { r.latestTimestampMs = NaN; }],
    ["gap", (r: VisionContinuityRequest) => { r.frames[1].frameId++; }],
  ] as const)("rejects %s before initializing or transferring", async (_name, mutate) => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new VisionClient(), input = continuityInput(); mutate(input);
    await expect(client.verifyContinuity(input)).rejects.toThrow("Invalid bounded");
    expect(FakeWorker.instances).toHaveLength(0); expect(client.busy).toBe(false); client.dispose();
  });
  it.each(["gap", "wrong-batch", "reseed", "time-gap"])("resets prior worker guards when a client follow-up is invalid: %s", async problem => {
    const { client, worker } = await readyClient(), first = await submitContinuity(client, worker);
    worker.reply(first.request, continuityResult(first.input)); await first.pending;
    const follow = continuityInput(problem === "wrong-batch" ? "old-batch" : "batch-a", [problem === "gap" ? 4 : 3]);
    if (problem !== "reseed") delete follow.seeds;
    if (problem === "time-gap") follow.latestTimestampMs = follow.frames[0].timestampMs += 301;
    const invalid = client.verifyContinuity(follow);
    await acknowledgeReset(worker);
    await expect(invalid).rejects.toThrow(/continuity|Continuity/);
    expect(follow.frames[0].gray.byteLength).toBe(4096); expect(client.busy).toBe(false); client.dispose();
  });
  it("resets after a rejected worker request while preserving the initialized model worker", async () => {
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    worker.receive({ id: sent.request.id, error: "Continuity rejected" });
    await acknowledgeReset(worker);
    await expect(sent.pending).rejects.toThrow("Continuity rejected");
    expect(worker.terminate).not.toHaveBeenCalled(); expect(client.busy).toBe(false); client.dispose();
  });
  it("reset waits for acknowledgment, drops the batch, and is a no-op before initialization", async () => {
    const unused = new VisionClient(); await unused.resetContinuity(); expect(FakeWorker.instances).toHaveLength(0); unused.dispose();
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    worker.reply(sent.request, continuityResult(sent.input)); await sent.pending;
    const reset = client.resetContinuity(); expect(client.busy).toBe(true);
    await acknowledgeReset(worker); await reset; expect(client.busy).toBe(false);
    const follow = continuityInput("batch-a", [3]); delete follow.seeds;
    const invalid = client.verifyContinuity(follow); await acknowledgeReset(worker);
    await expect(invalid).rejects.toThrow("current batch"); client.dispose();
  });
  it.each(["wrong-batch", "wrong-event", "identity-observation", "exit-evidence", "nonfinite-time", "missing-results", "wrong-latest", "missing-samples", "invalid-appearance"])("fails the session on malformed proof: %s", async problem => {
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    const proof: Record<string, unknown> = { eventId: "a", status: "continuous", kind: "verified-roi-continuity", processingMs: 1, postSeedSamples: 2, identityObservations: 0, exitEvidence: false, seedFrameId: 0, latestFrameId: 2, latestTimestampMs: 1_000_200, durationMs: 200, latestQuad: continuityQuad, supportingPoints: 24, appearance: { gain: 1, offset: 0, rms: 0 } };
    if (problem === "wrong-event") proof.eventId = "other";
    if (problem === "identity-observation") proof.identityObservations = 1;
    if (problem === "exit-evidence") proof.exitEvidence = true;
    if (problem === "nonfinite-time") proof.processingMs = NaN;
    if (problem === "wrong-latest") proof.latestFrameId = 1;
    if (problem === "missing-samples") proof.postSeedSamples = 0;
    if (problem === "invalid-appearance") proof.appearance = { gain: 1, offset: 0, rms: 999 };
    worker.reply(sent.request, { batchId: problem === "wrong-batch" ? "old-batch" : "batch-a", results: problem === "missing-results" ? [] : [proof] });
    await expect(sent.pending).rejects.toThrow("invalid response");
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(client.busy).toBe(false); client.dispose();
  });
  it("accepts a well-formed continuous result without changing its observation counts", async () => {
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    const proof = { eventId: "a", status: "continuous", kind: "verified-roi-continuity", processingMs: 1, postSeedSamples: 2, identityObservations: 0, exitEvidence: false, seedFrameId: 0, latestFrameId: 2, latestTimestampMs: 1_000_200, durationMs: 200, latestQuad: continuityQuad, supportingPoints: 24, appearance: { gain: 1, offset: 0, rms: 0 } };
    worker.reply(sent.request, { batchId: "batch-a", results: [proof] });
    await expect(sent.pending).resolves.toEqual({ batchId: "batch-a", results: [proof] }); client.dispose();
  });
  it("bounds continuity processing to ten seconds and drops late results", async () => {
    vi.useFakeTimers();
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    vi.advanceTimersByTime(9_999); expect(worker.terminate).not.toHaveBeenCalled(); expect(client.busy).toBe(true);
    vi.advanceTimersByTime(1); worker.reply(sent.request, continuityResult(sent.input));
    await expect(sent.pending).rejects.toThrow("timed out"); expect(worker.terminate).toHaveBeenCalledOnce(); client.dispose();
  });
  it("dispose rejects pending continuity and cannot revive results or reset the old worker", async () => {
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    client.dispose(); worker.reply(sent.request, continuityResult(sent.input));
    await expect(sent.pending).rejects.toThrow("disposed");
    await expect(client.resetContinuity()).rejects.toThrow("disposed");
    expect(worker.requests).toHaveLength(2); expect(client.busy).toBe(false);
  });
  it("old rejected work cannot clear a replacement continuity batch or its busy lock", async () => {
    const { client, worker } = await readyClient(), old = await submitContinuity(client, worker);
    worker.onerror?.({ message: "Worker failed" } as ErrorEvent);
    const nextInput = continuityInput("batch-b", [3, 4, 5]), next = client.verifyContinuity(nextInput), replacement = FakeWorker.instances.at(-1)!;
    await expect(old.pending).rejects.toThrow("Worker failed"); expect(client.busy).toBe(true);
    worker.reply(old.request, continuityResult(old.input));
    replacement.reply(replacement.requests[0], { engine: "OpenCV ORB + RANSAC", coverage });
    await Promise.resolve(); await Promise.resolve();
    replacement.reply(replacement.requests.at(-1)!, continuityResult(nextInput));
    await next; expect(client.busy).toBe(false);
    const follow = continuityInput("batch-b", [6]); delete follow.seeds;
    const tail = await submitContinuity(client, replacement, follow);
    replacement.reply(tail.request, continuityResult(follow)); await tail.pending; client.dispose();
  });
  it("does not commit a result whose session fails before its awaiting caller resumes", async () => {
    const { client, worker } = await readyClient(), sent = await submitContinuity(client, worker);
    worker.reply(sent.request, continuityResult(sent.input));
    worker.onerror?.({ message: "Worker ended" } as ErrorEvent);
    await expect(sent.pending).rejects.toThrow("batch ended"); client.dispose();
  });
});
