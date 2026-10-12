import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionBusyError, VisionClient } from "./index";
import type { WorkerRequest, WorkerResponse } from "./types";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | undefined;
  onerror: ((event: ErrorEvent) => void) | undefined;
  onmessageerror: (() => void) | undefined;
  requests: WorkerRequest[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: WorkerRequest) { this.requests.push(message); }
  reply(request: WorkerRequest, result: unknown) { this.onmessage?.({ data: { id: request.id, result } } as MessageEvent<WorkerResponse>); }
}
const coverage = { totalReferences: 0, byGame: { pokemon: 0, mtg: 0, yugioh: 0 }, packs: [] };
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });

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
