import { afterEach, describe, expect, it, vi } from "vitest";
import { PrintingSession } from "./printing-session";
import type { PrintingCatalogResult, PrintingFrame } from "./printing-session";
import {
  parsePrintingObservation,
  PrintingReaderError,
  resolvePrintingEvidence,
} from "./printing-refinement";
import type {
  PrintingCandidate,
  PrintingObservation,
  PrintingReadInput,
  PrintingReader,
  PrintingResolution,
} from "./printing-refinement";
import {
  addScanEvent,
  refineScanPrinting,
  undoScanEvent,
} from "./scan-inventory";
import { backupJson, collectionCsv, referenceTotals } from "./collection";
import { EMPTY_DATA, parseBackup, saveData } from "./storage";

const ref: PrintingCandidate = {
  key: "pokemon:sv1-25",
  game: "pokemon",
  name: "Pikachu",
  identityKey: "pokemon:pikachu",
  setName: "Scarlet & Violet",
  number: "25",
  printedTotal: 198,
};
function frame(
  index = 1,
  overrides: Partial<PrintingFrame> = {},
): PrintingFrame {
  return {
    sessionId: "session",
    eventId: "event",
    frameId: `frame-${index}`,
    capturedAt: index * 2000,
    reference: ref,
    image: { width: 600, height: 840 } as ImageData,
    sourceMinEdge: 600,
    ...overrides,
  };
}
function observed(input: PrintingReadInput): PrintingObservation {
  return parsePrintingObservation({
    jobId: input.jobId,
    sessionId: input.sessionId,
    eventId: input.eventId,
    frameId: input.frameId,
    capturedAt: input.capturedAt,
    game: input.game,
    imageFingerprint: `pixels-${input.frameId}`,
    rawText: "025/198",
  });
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const read = vi.fn(async (input: PrintingReadInput) => observed(input));
  const dispose = vi.fn();
  const reader = vi.fn((): PrintingReader => ({ read, dispose, busy: false }));
  const catalog = vi.fn(async (): Promise<PrintingCatalogResult> => ({
    candidates: [ref],
    catalogCompleteForIdentity: true,
    scope: "TCGdex English identity results",
  }));
  const isCurrent = vi.fn(() => true);
  const onStatus = vi.fn<(eventId: string, status: string) => void>();
  const onResolution = vi.fn<
    (eventId: string, result: PrintingResolution) => string | undefined
  >(() => undefined);
  const session = new PrintingSession({
    catalog,
    reader,
    isCurrent,
    onStatus,
    onResolution,
  });
  return {
    session,
    read,
    dispose,
    reader,
    catalog,
    isCurrent,
    onStatus,
    onResolution,
  };
}
const success = (calls: ReturnType<typeof harness>["onStatus"]) =>
  calls.mock.calls.filter(([, status]) =>
    status.startsWith("Printed catalog identifiers read."),
  );
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("printing session coordination", () => {
  it("reads one frame without resolving, then saves exactly once after two independent frames", async () => {
    const h = harness();
    expect(await h.session.offer(frame())).toBe(true);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.session.needs("event")).toBe(true);
    expect(await h.session.offer(frame(2))).toBe(true);
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(h.onResolution.mock.calls[0][0]).toBe("event");
    expect(h.onResolution.mock.calls[0][1]).toMatchObject({
      state: "catalog-printing-read",
      priceEligible: false,
      finish: "unknown",
      condition: "unknown",
    });
    expect(success(h.onStatus)).toHaveLength(1);
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(3))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(2);
    h.session.dispose();
  });
  it("drops incoming frames while one offer is running instead of enqueueing them", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    expect(h.session.busy).toBe(true);
    const skipped = await Promise.all(
      Array.from({ length: 100 }, (_, i) => h.session.offer(frame(i + 2))),
    );
    expect(skipped.every((value) => value === false)).toBe(true);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.catalog).toHaveBeenCalledOnce();
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    expect(h.session.busy).toBe(false);
    expect(h.read).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("keeps incomplete catalog lookups unresolved despite two clear observations", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref],
      catalogCompleteForIdentity: false,
      scope: "visual-gallery",
    });
    await h.session.offer(frame());
    await h.session.offer(frame(2));
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(success(h.onStatus)).toHaveLength(0);
    expect(h.session.needs("event")).toBe(true);
    h.session.dispose();
  });
  it("does not combine reused capture IDs or identical source pixels into two votes", async () => {
    for (const duplicate of ["id", "pixels"]) {
      const h = harness();
      if (duplicate === "pixels")
        h.read.mockImplementation(async (input) => ({
          ...observed(input),
          imageFingerprint: "same-original",
        }));
      await h.session.offer(frame());
      await h.session.offer(
        frame(2, duplicate === "id" ? { frameId: "frame-1" } : {}),
      );
      expect(h.onResolution).not.toHaveBeenCalled();
      h.session.dispose();
    }
  });
  it("throttles per-event attempts, rejects undersized crops, and caps attempts at six", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [],
      catalogCompleteForIdentity: false,
      scope: "unavailable",
    });
    expect(await h.session.offer(frame(1, { sourceMinEdge: 240 }))).toBe(false);
    expect(
      await h.session.offer(
        frame(1, { image: { width: 240, height: 336 } as ImageData }),
      ),
    ).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    await h.session.offer(frame());
    expect(await h.session.offer(frame(2, { capturedAt: 2100 }))).toBe(false);
    for (let index = 2; index <= 6; index++)
      await h.session.offer(frame(index));
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "Printing remains unconfirmed",
    );
    h.session.dispose();
  });
  it("does not let an exhausted or throttled first card starve later printing reads", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [],
      catalogCompleteForIdentity: false,
      scope: "unavailable",
    });
    for (let index = 1; index <= 6; index++)
      await h.session.offer(frame(index, { eventId: "first" }));
    expect(h.session.ready("first", 14_000)).toBe(false);
    expect(h.session.ready("second", 14_000)).toBe(true);
    await h.session.offer(frame(7, { eventId: "second" }));
    expect(h.session.ready("second", 14_100)).toBe(false);
    expect(h.session.ready("third", 14_100)).toBe(true);
    await h.session.offer(frame(8, { eventId: "third", capturedAt: 14_100 }));
    expect(h.read.mock.calls.map(([input]) => input.eventId)).toEqual([
      ...Array<string>(6).fill("first"),
      "second",
      "third",
    ]);
    h.session.dispose();
  });
  it("allows the same scan to skip an undersized crop and start the next eligible card", async () => {
    const h = harness();
    const pending: Promise<boolean>[] = [];
    for (const candidate of [
      frame(1, { eventId: "small", sourceMinEdge: 240 }),
      frame(1, { eventId: "clear" }),
      frame(1, { eventId: "later" }),
    ]) {
      if (!h.session.ready(candidate.eventId, candidate.capturedAt)) continue;
      pending.push(h.session.offer(candidate));
      if (h.session.busy) break;
    }
    expect(await Promise.all(pending)).toEqual([false, true]);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.read.mock.calls[0][0].eventId).toBe("clear");
    expect(h.session.ready("small", 2000)).toBe(true);
    expect(h.session.ready("later", 2000)).toBe(true);
    h.session.dispose();
  });
  it.each(["cancel", "forget", "dispose"] as const)(
    "ignores a late reader after %s",
    async (method) => {
      const h = harness();
      await h.session.offer(frame());
      const pending = deferred<PrintingObservation>();
      h.read.mockImplementationOnce(() => pending.promise);
      const old = h.session.offer(frame(2));
      if (method === "forget") h.session.forget("event");
      else h.session[method]();
      expect(h.read.mock.calls[1][0].signal.aborted).toBe(true);
      expect(h.dispose).toHaveBeenCalledOnce();
      const statusCount = h.onStatus.mock.calls.length;
      pending.resolve(observed(h.read.mock.calls[1][0]));
      expect(await old).toBe(false);
      expect(h.onResolution).not.toHaveBeenCalled();
      expect(h.onStatus).toHaveBeenCalledTimes(statusCount);
      if (method === "dispose")
        expect(await h.session.offer(frame(3))).toBe(false);
      h.session.dispose();
    },
  );
  it("settles cancel immediately even when both dependencies ignore abort", async () => {
    const h = harness();
    const catalog = deferred<PrintingCatalogResult>(),
      read = deferred<PrintingObservation>();
    h.catalog.mockImplementationOnce(() => catalog.promise);
    h.read.mockImplementationOnce(() => read.promise);
    const running = h.session.offer(frame());
    h.session.cancel();
    await expect(running).resolves.toBe(false);
    expect(h.session.busy).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    catalog.resolve({
      candidates: [ref],
      catalogCompleteForIdentity: true,
      scope: "late",
    });
    read.resolve(observed(h.read.mock.calls[0][0]));
    await Promise.resolve();
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("ignores a late catalog result after undo removes the event", async () => {
    const h = harness();
    await h.session.offer(frame());
    const pending = deferred<PrintingCatalogResult>();
    h.catalog.mockImplementationOnce(() => pending.promise);
    const old = h.session.offer(frame(2));
    h.isCurrent.mockReturnValue(false);
    pending.resolve({
      candidates: [ref],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    expect(await old).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(success(h.onStatus)).toHaveLength(0);
    h.session.dispose();
  });
  it("does not let an old page's finally release a newer active offer", async () => {
    const h = harness();
    const a = deferred<PrintingObservation>(),
      b = deferred<PrintingObservation>();
    h.read
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const old = h.session.offer(frame());
    h.session.cancel();
    const next = h.session.offer(
      frame(2, { sessionId: "new-page", eventId: "new-event" }),
    );
    a.resolve(observed(h.read.mock.calls[0][0]));
    expect(await old).toBe(false);
    expect(h.session.busy).toBe(true);
    b.resolve(observed(h.read.mock.calls[1][0]));
    expect(await next).toBe(true);
    expect(h.session.busy).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.reader).toHaveBeenCalledTimes(2);
    h.session.dispose();
  });
  it("does not combine an observation from before a new-page reset with a fresh observation", async () => {
    const h = harness();
    await h.session.offer(frame());
    h.session.cancel();
    await h.session.offer(frame(2, { sessionId: "new-page" }));
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(3, { sessionId: "new-page" }));
    expect(h.onResolution).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("handles a reader timeout without blocking identity state or the next frame", async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(
      new PrintingReaderError("timeout", "timed out"),
    );
    expect(await h.session.offer(frame())).toBe(false);
    expect(h.session.busy).toBe(false);
    expect(h.read.mock.calls[0][0].signal.aborted).toBe(true);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(success(h.onStatus)).toHaveLength(0);
    await h.session.offer(frame(2));
    await h.session.offer(frame(3));
    expect(h.onResolution).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("rejects wrong-game or wrong-identity catalog records", async () => {
    for (const bad of [
      { ...ref, name: "Raichu" },
      { ...ref, game: "mtg" as const },
      { ...ref, identityKey: "pokemon:raichu" },
    ]) {
      const h = harness();
      h.catalog.mockResolvedValue({
        candidates: [bad],
        catalogCompleteForIdentity: true,
        scope: "bad-provider-response",
      });
      await h.session.offer(frame());
      await h.session.offer(frame(2));
      expect(h.onResolution).not.toHaveBeenCalled();
      h.session.dispose();
    }
  });
  it("never claims a successful read when durable storage rejects the resolution", async () => {
    const h = harness();
    h.onResolution.mockReturnValueOnce(
      "Storage is full. Printing metadata was not saved.",
    );
    await h.session.offer(frame());
    await h.session.offer(frame(2));
    expect(success(h.onStatus)).toHaveLength(0);
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain("not saved");
    // An unsuccessful save must remain retryable instead of silently closing the task.
    expect(h.session.needs("event")).toBe(true);
    await h.session.offer(frame(3));
    expect(h.onResolution).toHaveBeenCalledTimes(2);
    expect(success(h.onStatus)).toHaveLength(1);
    h.session.dispose();
  });
  it("handles a thrown storage callback without emitting success", async () => {
    const h = harness();
    h.onResolution.mockImplementationOnce(() => {
      throw new Error("Quota exceeded");
    });
    await h.session.offer(frame());
    expect(await h.session.offer(frame(2))).toBe(false);
    expect(success(h.onStatus)).toHaveLength(0);
    expect(h.session.needs("event")).toBe(true);
    h.session.dispose();
  });
  it("releases its slot after a reader-construction failure", async () => {
    const h = harness();
    h.reader.mockImplementationOnce(() => {
      throw new Error("Worker unavailable");
    });
    await expect(h.session.offer(frame())).resolves.toBe(false);
    expect(h.session.busy).toBe(false);
    await h.session.offer(frame(2));
    expect(h.read).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("releases its slot if a status callback throws", async () => {
    const h = harness();
    h.onStatus.mockImplementationOnce(() => {
      throw new Error("UI detached");
    });
    await expect(h.session.offer(frame())).resolves.toBe(true);
    expect(h.session.busy).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("places a whole-offer deadline on a catalog that stalls after OCR completes", async () => {
    vi.useFakeTimers();
    const h = harness();
    const stalled = deferred<PrintingCatalogResult>();
    h.catalog.mockImplementationOnce(() => stalled.promise);
    const offer = h.session.offer(frame());
    let settled = false;
    void offer.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(h.session.busy).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    // Bound covers catalog + OCR even if the provider fails to honor abort.
    expect(h.session.busy).toBe(false);
    expect(settled).toBe(true);
    expect(await offer).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(2));
    expect(h.session.busy).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
    stalled.resolve({
      candidates: [ref],
      catalogCompleteForIdentity: true,
      scope: "late",
    });
  });
});

function validResolution(): PrintingResolution {
  const captures = [1, 2].map((index) =>
    observed({
      ...frame(index),
      game: "pokemon",
      jobId: `job-${index}`,
      signal: new AbortController().signal,
    }),
  );
  return resolvePrintingEvidence({
    game: "pokemon",
    sessionId: "session",
    eventId: "event",
    identityName: ref.name,
    identityKey: ref.identityKey,
    candidates: [ref],
    catalogCompleteForIdentity: true,
    observations: captures,
  });
}

describe("durable printing metadata safety", () => {
  it("adds separate metadata to the exact saved event without changing verification, price, finish or identity", () => {
    const referenceOnly = {
      ...ref,
      key: "pokemon:old-1",
      setName: "Wrong visual reprint",
      number: "1",
    };
    const collection = addScanEvent(
      addScanEvent([], referenceOnly, "other"),
      referenceOnly,
      "event",
    );
    collection[0].card.prices = [
      {
        amount: 100,
        currency: "USD",
        source: "control",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    ];
    const refined = refineScanPrinting(collection, "event", validResolution());
    expect(refined[0].printingRead).toMatchObject({
      referenceId: "sv1-25",
      setName: "Scarlet & Violet",
      number: "25",
    });
    expect(refined[0].card).toBe(collection[0].card);
    expect(refined[0]).toMatchObject({
      verification: "identity-only",
      condition: "Unknown",
      finish: "Unknown",
      quantity: 1,
    });
    expect(refined[1]).toBe(collection[1]);
    expect(referenceTotals(refined)).toMatchObject({
      USD: 0,
      EUR: 0,
      priced: 0,
      unpriced: 2,
    });
    expect(collectionCsv(refined)).not.toContain('"100"');
    expect(collectionCsv(refined)).toContain("Read catalog set");
    expect(collectionCsv(refined)).toContain("Scarlet & Violet");
  });
  it("cannot resurrect an undone event or alter a manually confirmed entry", () => {
    const original = addScanEvent([], ref, "event");
    const undone = undoScanEvent(original, "event");
    expect(refineScanPrinting(undone, "event", validResolution())).toBe(undone);
    const manual = [{ ...original[0], verification: undefined }];
    expect(refineScanPrinting(manual, "event", validResolution())).toBe(manual);
  });
  it("rejects mismatched event/game/name and unresolved or insufficient results", () => {
    const original = addScanEvent([], ref, "event");
    const valid = validResolution();
    for (const result of [
      { ...valid, state: "unresolved" as const },
      { ...valid, evidence: valid.evidence.slice(0, 1) },
      { ...valid, reference: { ...ref, name: "Raichu" } },
      { ...valid, reference: { ...ref, game: "mtg" as const } },
      {
        ...valid,
        evidence: valid.evidence.map((observation) => ({
          ...observation,
          eventId: "other-event",
        })),
      },
    ])
      expect(refineScanPrinting(original, "event", result)[0]).toBe(
        original[0],
      );
  });
  it("round-trips optional metadata while preserving unknown physical variants and zero valuation", () => {
    const data = {
      ...EMPTY_DATA,
      collection: refineScanPrinting(
        addScanEvent([], ref, "event"),
        "event",
        validResolution(),
      ),
    };
    const parsed = parseBackup(backupJson(data));
    expect(parsed.collection[0].printingRead).toEqual(
      data.collection[0].printingRead,
    );
    expect(parsed.collection[0].verification).toBe("identity-only");
    expect(parsed.collection[0].printingRead?.unconfirmed).toEqual([
      "language",
      "edition",
      "rarity",
      "finish",
      "condition",
    ]);
    expect(referenceTotals(parsed.collection).priced).toBe(0);
    expect(
      parseBackup(
        backupJson({
          ...EMPTY_DATA,
          collection: addScanEvent([], ref, "event"),
        }),
      ).collection[0].printingRead,
    ).toBeUndefined();
  });
  it("rejects unsafe imported URLs, oversized fields and claims that finish or condition are confirmed", () => {
    const data = {
      ...EMPTY_DATA,
      collection: refineScanPrinting(
        addScanEvent([], ref, "event"),
        "event",
        validResolution(),
      ),
    };
    const read = data.collection[0].printingRead!;
    for (const invalid of [
      { ...read, sourceUrl: "javascript:alert(1)" },
      { ...read, sourceUrl: "https://attacker.invalid/card" },
      { ...read, referenceId: "x".repeat(501) },
      { ...read, readAt: "not-a-date" },
      { ...read, unconfirmed: ["condition"] },
      { ...read, unconfirmed: ["finish"] },
      { ...read, unconfirmed: ["finish", "condition", "guaranteed"] },
    ])
      expect(() =>
        parseBackup(
          JSON.stringify({
            ...data,
            collection: [{ ...data.collection[0], printingRead: invalid }],
          }),
        ),
      ).toThrow();
  });
  it("surfaces durable storage errors without replacing the saved payload", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.stubGlobal("localStorage", { setItem });
    const data = {
      ...EMPTY_DATA,
      collection: refineScanPrinting(
        addScanEvent([], ref, "event"),
        "event",
        validResolution(),
      ),
    };
    expect(saveData(data)).toMatch(/could not|full|save/i);
    expect(setItem).toHaveBeenCalledOnce();
  });
});
