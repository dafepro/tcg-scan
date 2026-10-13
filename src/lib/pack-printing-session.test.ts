import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PACK_PRINTING_LIMITS,
  PackPrintingSession,
} from "./pack-printing-session";
import type { PackPrintingUpdate } from "./pack-printing-session";
import type { PackCaptureIdentity } from "./pack-capture";
import { PackSession } from "./pack-session";
import type { PackReceipt } from "./pack-session";
import {
  parsePrintingObservation,
  resolvePrintingEvidence,
} from "./printing-refinement";
import type {
  PrintingObservation,
  PrintingReadInput,
  PrintingReader,
} from "./printing-refinement";
import type { VisionResult } from "./vision";

function view(frameId = 1): PackCaptureIdentity {
  return {
    sessionId: "pack",
    sourceId: "video",
    generation: 1,
    captureId: `pack:capture:${frameId}`,
    frameId,
    capturedAt: Date.now() - 200,
    sourceFrame: {
      presentedFrames: frameId,
      mediaTime: frameId / 10,
      presentationTime: Date.now() - 200,
      callbackAt: Date.now() - 200,
    },
    trackId: `pack:capture:${frameId}`,
    copyLineage: "unproven",
    width: 1280,
    height: 720,
    queuedAt: Date.now() - 190,
    qualityScore: 50,
  };
}
function result(name = "Pikachu"): VisionResult {
  return {
    width: 1280,
    height: 720,
    detections: [
      {
        quad: [
          { x: 0, y: 0 },
          { x: 480, y: 0 },
          { x: 480, y: 672 },
          { x: 0, y: 672 },
        ],
        state: "verified",
        reason: "Verified",
        autoEligible: true,
        quality: {
          laplacianVariance: 200,
          contrast: 80,
          meanLuminance: 120,
          saturatedFraction: 0,
          sourceMinEdge: 480,
          featureCount: 100,
          issues: [],
        },
        candidates: [
          {
            key: name,
            reference: {
              key: name,
              game: "pokemon",
              name,
              identityKey: name,
              number: "25",
            },
            hashDistance: 0,
            tentativeMatches: 60,
            inliers: 50,
            inlierRatio: 0.9,
            interiorInliers: 20,
            coverage: 0.7,
            medianReprojectionError: 0.5,
            cornerError: 0.01,
            geometricallyVerified: true,
          },
        ],
        printingCrop: {
          width: 480,
          height: 672,
          data: new Uint8ClampedArray(480 * 672 * 4),
        } as ImageData,
        printingSourceMinEdge: 480,
      },
    ],
    timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 },
    coverage: {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: [],
    },
    budgetExhausted: false,
    detectionComplete: true,
  };
}
function observed(input: PrintingReadInput) {
  return parsePrintingObservation({
    jobId: input.jobId,
    sessionId: input.sessionId,
    eventId: input.eventId,
    frameId: input.frameId,
    capturedAt: input.capturedAt,
    game: input.game,
    rawText: "025/198",
    imageFingerprint: `pixels-${input.frameId}`,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function harness() {
  const pack = new PackSession("pack", Date.now);
  const read = vi.fn(async (input: PrintingReadInput) => observed(input));
  const dispose = vi.fn();
  const reader = vi.fn((): PrintingReader => ({ read, dispose, busy: false }));
  const isSaved = vi.fn((receipt: PackReceipt) =>
    pack
      .snapshot()
      .some(
        (item) =>
          item.receiptId === receipt.receiptId &&
          item.eventId === receipt.eventId &&
          item.status === "saved",
      ),
  );
  const onUpdate = vi.fn<(update: PackPrintingUpdate) => void>();
  const printing = new PackPrintingSession({
    reader,
    isSaved,
    onUpdate,
    now: Date.now,
  });
  function identify(v = view(), r = result(), failure?: string) {
    pack.queue(v);
    pack.identifying(v.captureId, Date.now() - 100);
    const intents = pack.consume(v.captureId, r, Date.now() - 50, true);
    for (const intent of intents) pack.acknowledge(intent.eventId, failure);
    return pack
      .snapshot()
      .find((receipt) => receipt.receiptId === v.captureId)!;
  }
  return { pack, printing, read, dispose, reader, isSaved, onUpdate, identify };
}
const evidenceUpdates = (h: ReturnType<typeof harness>) =>
  h.onUpdate.mock.calls
    .map(([update]) => update)
    .filter((update) => update.resolution);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("one original retained Pack printing capture", () => {
  it("reads the exact saved receipt after its card exits without enriching the next card", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    expect(h.printing.requestCrop(a)).toBe(true);
    const receipt = h.identify(a, pixels);
    expect(h.printing.acceptResult(a, pixels, receipt)).toBe(true);
    // The save is complete and reader has not started on this identity's stack.
    expect(h.read).not.toHaveBeenCalled();
    h.identify(view(2), result("Raichu"));
    await vi.advanceTimersByTimeAsync(1);
    const [update] = evidenceUpdates(h);
    expect(update.eventId).toBe(receipt.eventId);
    expect(update.receiptId).toBe(a.captureId);
    expect(update.resolution).toMatchObject({
      state: "unresolved",
      finish: "unknown",
      condition: "unknown",
      priceEligible: false,
    });
    expect(update.resolution!.evidence).toHaveLength(1);
    expect(update.resolution!.evidence[0]).toMatchObject({
      frameId: a.captureId,
      rawText: "025/198",
    });
    expect(h.pack.snapshot().filter((r) => r.status === "saved")).toHaveLength(
      2,
    );
    expect(h.printing.retainedBytes).toBe(0);
    expect(h.dispose).toHaveBeenCalledOnce();
    // Even complete matching catalog metadata cannot promote this one view.
    const resolution = resolvePrintingEvidence({
      game: "pokemon",
      sessionId: "pack",
      eventId: receipt.eventId!,
      identityName: "Pikachu",
      candidates: [{ ...receipt.reference!, printedTotal: 198 }],
      catalogCompleteForIdentity: true,
      observations: update.resolution!.evidence,
    });
    expect(resolution.reasons).toContain("two-distinct-captures-required");
    h.printing.dispose();
  });
  it("never combines a later same-name capture with a name-latched event", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(2000);
    const next = view(2),
      repeated = result();
    expect(h.printing.requestCrop(next)).toBe(true);
    const receipt = h.identify(next, repeated);
    expect(receipt.status).toBe("duplicate");
    expect(h.printing.acceptResult(next, repeated, receipt)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledOnce();
    expect(evidenceUpdates(h)).toHaveLength(1);
    expect(h.pack.snapshot().filter((r) => r.status === "saved")).toHaveLength(
      1,
    );
    h.printing.dispose();
  });
  it("does not read a failed durable save, but accepts retry of that original event", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.printing.requestCrop(a);
    const failed = h.identify(a, pixels, "Storage full");
    h.printing.acceptResult(a, pixels, failed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.printing.retainedBytes).toBe(480 * 672 * 4);
    expect(h.printing.confirmSaved({ ...failed, status: "saved" })).toBe(false);
    const retry = h.pack.retry(failed.eventId!)!;
    h.pack.acknowledge(retry.eventId);
    expect(h.printing.confirmSaved(h.pack.snapshot()[0])).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledOnce();
    expect(evidenceUpdates(h)[0].eventId).toBe(failed.eventId);
    expect(h.pack.snapshot()).toHaveLength(1);
    h.printing.dispose();
  });
  it("cannot inherit evidence onto a user-confirmed additional copy", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    const original = h.identify(a, pixels);
    const copy = h.pack.confirmAnotherCopy(original.receiptId, "extra")!;
    h.pack.acknowledge(copy.eventId);
    const receipt = h.pack.snapshot().find((r) => r.eventId === copy.eventId)!;
    h.printing.requestCrop(a);
    expect(h.printing.acceptResult(a, pixels, receipt)).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.pack.snapshot().filter((r) => r.status === "saved")).toHaveLength(
      2,
    );
    h.printing.dispose();
  });
  it.each(["Pause", "Stop", "Undo", "new session"])(
    "rejects pending reader completion after %s",
    async (boundary) => {
      const h = harness(),
        a = view(),
        pixels = result(),
        pending = deferred<PrintingObservation>();
      h.read.mockImplementationOnce(() => pending.promise);
      h.printing.requestCrop(a);
      const receipt = h.identify(a, pixels);
      h.printing.acceptResult(a, pixels, receipt);
      await vi.advanceTimersByTimeAsync(1);
      if (boundary === "Undo") h.pack.undo(receipt.eventId!);
      if (boundary === "Stop" || boundary === "new session")
        h.printing.dispose();
      else h.printing.cancel();
      expect(h.read.mock.calls[0][0].signal.aborted).toBe(true);
      expect(h.printing.busy).toBe(false);
      expect(h.printing.retainedBytes).toBe(0);
      pending.resolve(observed(h.read.mock.calls[0][0]));
      await vi.advanceTimersByTimeAsync(1);
      expect(evidenceUpdates(h)).toHaveLength(0);
      h.printing.dispose();
    },
  );
  it("drops queued read before reader startup when paused", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    h.printing.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reader).not.toHaveBeenCalled();
    h.printing.dispose();
  });
  it("holds only one reservation/pending/read slot and one bounded pixel buffer", async () => {
    const h = harness(),
      a = view(),
      pixels = result(),
      pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    expect(h.printing.requestCrop(a)).toBe(true);
    expect(h.printing.requestCrop(view(2))).toBe(false);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.printing.requestCrop(view(3))).toBe(false);
    expect(h.printing.retainedBytes).toBeLessThanOrEqual(
      PACK_PRINTING_LIMITS.maxBytes,
    );
    expect(h.reader).toHaveBeenCalledOnce();
    h.printing.cancel();
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(1);
    h.printing.dispose();
  });
  it("expires pending failed-save pixels and cannot read a late retry", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.printing.requestCrop(a);
    const receipt = h.identify(a, pixels, "Disk full");
    h.printing.acceptResult(a, pixels, receipt);
    await vi.advanceTimersByTimeAsync(PACK_PRINTING_LIMITS.lifetimeMs);
    expect(h.printing.busy).toBe(false);
    expect(h.printing.retainedBytes).toBe(0);
    h.pack.retry(receipt.eventId!);
    h.pack.acknowledge(receipt.eventId!);
    expect(h.printing.confirmSaved(h.pack.snapshot()[0])).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    h.printing.dispose();
  });
  it("bounds even a reader that ignores abort and returns late", async () => {
    const h = harness(),
      a = view(),
      pixels = result(),
      pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(PACK_PRINTING_LIMITS.lifetimeMs);
    expect(h.dispose).toHaveBeenCalled();
    expect(h.printing.busy).toBe(false);
    expect(h.printing.retainedBytes).toBe(0);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(1);
    expect(evidenceUpdates(h)).toHaveLength(0);
    h.printing.dispose();
  });
  it("rejects late native results after cancellation and mismatched receipt provenance", () => {
    const h = harness(),
      a = view(),
      pixels = result();
    const receipt = h.identify(a, pixels);
    h.printing.requestCrop(a);
    h.printing.cancel();
    expect(h.printing.acceptResult(a, pixels, receipt)).toBe(false);
    vi.setSystemTime(12_000);
    const b = view(2);
    h.printing.requestCrop(b);
    expect(h.printing.acceptResult(b, pixels, receipt)).toBe(false);
    expect(h.printing.busy).toBe(false);
    h.printing.dispose();
  });
  it("does not let an old reader finally free a newer reserved crop", async () => {
    const h = harness(),
      a = view(),
      pixels = result(),
      pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(2000);
    h.printing.cancel();
    expect(h.printing.requestCrop(view(2))).toBe(true);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.printing.busy).toBe(true);
    h.printing.dispose();
  });
  it("enforces cooldown and a session acquisition budget even for unusable/duplicate crops", () => {
    const h = harness();
    for (let i = 1; i <= PACK_PRINTING_LIMITS.maxCrops; i++) {
      const a = view(i);
      expect(h.printing.requestCrop(a)).toBe(true);
      h.printing.acceptResult(a, result());
      expect(h.printing.requestCrop(view(i + 1))).toBe(false);
      h.printing.cancel(); // Pause never replenishes budgets.
      vi.setSystemTime(Date.now() + PACK_PRINTING_LIMITS.cooldownMs);
    }
    expect(h.printing.requestCrop(view(40))).toBe(false);
    expect(h.printing.requestedCrops).toBe(30);
    h.printing.dispose();
  });
  it("requires a new adapter for a different source/session/generation", () => {
    const h = harness();
    h.printing.requestCrop(view());
    h.printing.cancel();
    vi.setSystemTime(12_000);
    for (const patch of [
      { sourceId: "other" },
      { sessionId: "new" },
      { generation: 2 },
    ])
      expect(h.printing.requestCrop({ ...view(2), ...patch })).toBe(false);
    h.printing.dispose();
  });
  it.each(["oversized", "aliased", "upscaled", "wrong-identity"])(
    "rejects %s crop metadata",
    (problem) => {
      const h = harness(),
        a = view(),
        pixels = result();
      const receipt = h.identify(a, pixels);
      if (problem === "oversized")
        pixels.detections[0].printingCrop = {
          width: 1000,
          height: 1400,
          data: new Uint8ClampedArray(1000 * 1400 * 4),
        } as ImageData;
      if (problem === "aliased")
        pixels.detections[0].printingCrop = {
          ...pixels.detections[0].printingCrop!,
          data: new Uint8ClampedArray(new ArrayBuffer(480 * 672 * 4 + 4), 4),
        };
      if (problem === "upscaled")
        pixels.detections[0].printingSourceMinEdge = 240;
      if (problem === "wrong-identity")
        pixels.detections[0].candidates[0].reference = {
          ...receipt.reference!,
          key: "wrong",
        };
      h.printing.requestCrop(a);
      expect(h.printing.acceptResult(a, pixels, receipt)).toBe(false);
      expect(h.printing.retainedBytes).toBe(0);
      h.printing.dispose();
    },
  );
  it("rejects an observation bearing another event/capture even if the reader resolves", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.read.mockImplementationOnce(async (input) => ({
      ...observed(input),
      eventId: "next-card",
    }));
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(1);
    expect(evidenceUpdates(h)).toHaveLength(0);
    expect(h.printing.busy).toBe(false);
    h.printing.dispose();
  });
  it("optional reader/reporting failure cannot change saved quantity or strand pixels", async () => {
    const h = harness(),
      a = view(),
      pixels = result();
    h.reader.mockImplementationOnce(() => {
      throw new Error("Worker unavailable");
    });
    h.onUpdate.mockImplementation(() => {
      throw new Error("Unmounted");
    });
    h.printing.requestCrop(a);
    h.printing.acceptResult(a, pixels, h.identify(a, pixels));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.printing.busy).toBe(false);
    expect(h.pack.snapshot()[0].status).toBe("saved");
    h.printing.dispose();
  });
});
