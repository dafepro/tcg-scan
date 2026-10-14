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
// Real bounded RGBA fixtures: scheduler sampling must never accept missing pixels.
const images = Array.from({ length: 8 }, (_, index) => {
  const data = new Uint8ClampedArray(600 * 840 * 4).fill(index * 30);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  return { width: 600, height: 840, data } as ImageData;
});
function frame(
  index = 1,
  overrides: Partial<PrintingFrame> = {},
): PrintingFrame {
  return {
    sessionId: "session",
    eventId: "event",
    frameId: `frame-${index}`,
    capturedAt: index * 6000,
    reference: ref,
    image: images[index % images.length],
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
function harness(now?: () => number) {
  const read = vi.fn(async (input: PrintingReadInput) => observed(input));
  const dispose = vi.fn();
  const reader = vi.fn((): PrintingReader => ({ read, dispose, busy: false }));
  const catalog = vi.fn(async (): Promise<PrintingCatalogResult> => ({
    candidates: [ref],
    catalogCompleteForIdentity: true,
    scope: "TCGdex English identity results",
  }));
  const isCurrent = vi.fn<(frame: PrintingFrame) => boolean>(() => true);
  const onStatus = vi.fn<(eventId: string, status: string) => void>();
  const onGuidance = vi.fn<(eventId: string, message: string) => void>();
  const onGuidanceComplete = vi.fn<(eventId: string) => void>();
  const onDiagnostics =
    vi.fn<(eventId: string, result: PrintingResolution) => void>();
  const onResolution = vi.fn<
    (eventId: string, result: PrintingResolution) => string | undefined
  >(() => undefined);
  const session = new PrintingSession({
    now,
    catalog,
    reader,
    isCurrent,
    onStatus,
    onGuidance,
    onGuidanceComplete,
    onDiagnostics,
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
    onGuidance,
    onGuidanceComplete,
    onDiagnostics,
    onResolution,
  };
}
const success = (calls: ReturnType<typeof harness>["onStatus"]) =>
  calls.mock.calls.filter(([, status]) =>
    status.startsWith("Printed catalog identifiers read."),
  );
function unread(input: PrintingReadInput): PrintingObservation {
  return { ...observed(input), rawText: "", fields: {} };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("printing session coordination", () => {
  it("issues one candidate-dependent prompt and bounds no-gain follow-up reads", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
    await h.session.offer(frame());
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain("collector number");
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain("closer once");
    expect(h.session.needs("event")).toBe(true);
    await h.session.offer(frame(2));
    expect(h.session.needs("event")).toBe(true);
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "Waiting for the requested view",
    );
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(h.onGuidance.mock.calls[0]).toEqual([
      "event",
      expect.stringContaining("closer once"),
    ]);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(
      h.onDiagnostics.mock.calls[1][1].evidence.map((value) => value.frameId),
    ).toEqual(["frame-1", "frame-2"]);
    expect(
      h.onStatus.mock.calls.filter(([, value]) =>
        value.includes("closer once"),
      ),
    ).toHaveLength(1);
    for (let index = 3; index <= 6; index++)
      await h.session.offer(frame(index));
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "No more automatic reads",
    );
    h.session.dispose();
  });
  it("accepts two fresh literal reads after a delayed response to the actual prompt", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    for (let i = 0; i < 3; i++)
      h.read.mockImplementationOnce(async (input) => ({
        ...observed(input),
        rawText: "",
        fields: {},
      }));
    await h.session.offer(frame(1));
    await h.session.offer(frame(2));
    await h.session.offer(frame(3));
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(4));
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(5));
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(h.onResolution.mock.calls[0][1]).toMatchObject({
      state: "catalog-printing-read",
      priceEligible: false,
      finish: "unknown",
      condition: "unknown",
    });
    expect(h.session.needs("event")).toBe(false);
    h.session.dispose();
  });
  it("does not reset an occurrence's prompt budget on Pause/cancel", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
    await h.session.offer(frame());
    h.session.cancel();
    await h.session.offer(frame(2));
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(
      h.onStatus.mock.calls.filter(([, value]) =>
        value.includes("closer once"),
      ),
    ).toHaveLength(1);
    expect(
      h.onDiagnostics.mock.calls[1][1].evidence.map((value) => value.frameId),
    ).toEqual(["frame-2"]);
    expect(h.session.needs("event")).toBe(true);
    h.session.dispose();
  });
  it("preserves the baseline successful two reads after an initial empty single-candidate read", async () => {
    const h = harness();
    h.read.mockImplementationOnce(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
    await h.session.offer(frame());
    expect(h.session.needs("event")).toBe(true);
    await h.session.offer(frame(2));
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(3));
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(
      h.onStatus.mock.calls.some(([, value]) => value.includes("closer once")),
    ).toBe(false);
    h.session.dispose();
  });
  it("stops camera requests when the remaining catalog difference is unsupported edition text", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "edition", edition: "1ST EDITION" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    await h.session.offer(frame());
    await h.session.offer(frame(2));
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.session.needs("event")).toBe(false);
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain("Review it later");
    expect(
      h.onStatus.mock.calls.some(([, value]) =>
        /tilt|glare|blur|closer/i.test(value),
      ),
    ).toBe(false);
    h.session.dispose();
  });
  it("Undo of a different receipt does not cancel or mutate the active occurrence", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const active = h.session.offer(frame(1, { eventId: "active" }));
    h.session.forget("other");
    expect(h.session.busy).toBe(true);
    expect(h.read.mock.calls[0][0].signal.aborted).toBe(false);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    expect(await active).toBe(true);
    expect(h.onDiagnostics.mock.calls[0][0]).toBe("active");
    h.session.dispose();
  });
  it("a diagnostic callback that cancels the encounter cannot publish a prompt or update a receipt", async () => {
    const h = harness();
    h.onDiagnostics.mockImplementation(() => h.session.cancel());
    const before = h.onStatus.mock.calls.length;
    expect(await h.session.offer(frame())).toBe(false);
    expect(h.onStatus.mock.calls).toHaveLength(before + 1);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
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
  it("reports unresolved reasons and catalog provenance without claiming acceptance", async () => {
    const h = harness();
    const provenance = {
      schemaVersion: 1 as const,
      snapshotId: "sha256:" + "a".repeat(64),
      provider: "fixture-provider",
      scope: "fixture-identity",
      fetchedAt: "2026-10-13T03:30:00.000Z",
      stale: false,
      completeWithinScope: true,
      candidateCount: 1,
    };
    h.catalog.mockResolvedValue({
      candidates: [ref],
      catalogCompleteForIdentity: true,
      scope: "fixture-identity",
      provenance,
    });
    await h.session.offer(frame());
    expect(h.onDiagnostics).toHaveBeenCalledOnce();
    expect(h.onDiagnostics.mock.calls[0]).toMatchObject([
      "event",
      {
        state: "unresolved",
        reasons: ["two-distinct-captures-required"],
        catalogProvenance: provenance,
        priceEligible: false,
      },
    ]);
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(2));
    expect(h.onResolution.mock.calls[0][1].catalogProvenance).toEqual(
      provenance,
    );
    expect(h.onDiagnostics).toHaveBeenCalledTimes(2);
    h.session.dispose();
  });
  it("isolates mutable or throwing diagnostics from evidence and acceptance", async () => {
    const h = harness();
    h.onDiagnostics.mockImplementationOnce((_event, result) => {
      result.state = "catalog-printing-read";
      result.evidence[0].fields.collectorNumber = "999";
      result.evidence[0].frameId = "modified";
    });
    await h.session.offer(frame());
    expect(h.onResolution).not.toHaveBeenCalled();
    h.onDiagnostics.mockImplementationOnce(() => {
      throw new Error("Diagnostics offline");
    });
    await h.session.offer(frame(2));
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(
      h.onResolution.mock.calls[0][1].evidence[0].fields.collectorNumber,
    ).toBe("25");
    expect(h.onResolution.mock.calls[0][1].evidence[0].frameId).toBe("frame-1");
    expect(h.session.busy).toBe(false);
    h.session.dispose();
  });
  it("does not report stale or cancelled reads as region diagnostics", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const offered = h.session.offer(frame());
    const original = observed(h.read.mock.calls[0][0]);
    h.session.cancel();
    pending.resolve(original);
    expect(await offered).toBe(false);
    expect(h.onDiagnostics).not.toHaveBeenCalled();
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.session.busy).toBe(false);
    h.session.dispose();
  });
  it("rechecks lifecycle if a diagnostics subscriber cancels the session", async () => {
    const h = harness();
    await h.session.offer(frame());
    h.onDiagnostics.mockImplementationOnce(() => h.session.cancel());
    expect(await h.session.offer(frame(2))).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(success(h.onStatus)).toHaveLength(0);
    h.session.dispose();
  });
  it("retains only the latest eligible original for one busy occurrence without spending reads", async () => {
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
    expect(h.session.retainedCaptures).toBe(1);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    await vi.waitFor(() => expect(h.session.busy).toBe(false));
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read.mock.calls[1][0]).toMatchObject({
      frameId: "frame-101",
      capturedAt: 606_000,
    });
    expect(h.read.mock.calls[1][0].image).toBe(images[5]);
    expect(h.session.retainedCaptures).toBe(0);
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
    expect(await h.session.offer(frame(2, { capturedAt: 6100 }))).toBe(false);
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
    expect(h.session.ready("first", 42_000)).toBe(false);
    expect(h.session.ready("second", 42_000)).toBe(true);
    await h.session.offer(frame(7, { eventId: "second" }));
    expect(h.session.ready("second", 42_100)).toBe(false);
    expect(h.session.ready("third", 42_100)).toBe(true);
    await h.session.offer(frame(8, { eventId: "third", capturedAt: 42_100 }));
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

function lateLiteralHarness(now?: () => number) {
  const h = harness(now);
  h.catalog.mockResolvedValue({
    candidates: [ref, { ...ref, key: "other", number: "26" }],
    catalogCompleteForIdentity: true,
    scope: "complete",
  });
  for (let index = 0; index < 5; index++)
    h.read.mockImplementationOnce(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
  return h;
}
async function offerNormalBudget(h: ReturnType<typeof harness>) {
  for (let index = 1; index <= 6; index++) await h.session.offer(frame(index));
}

describe("bounded prompt-responsive capture scheduling", () => {
  it("bounds retries for a continuously moving requested view instead of waiting forever or spending them every 1.5 seconds", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    h.read.mockImplementation(async (input) => unread(input));
    await h.session.offer(frame(1, { capturedAt: 2000 }));
    for (let i = 0; i <= 63; i++)
      await h.session.offer(
        frame(i + 2, {
          capturedAt: 3500 + i * 500,
          image: images[2 + (i % 2)],
        }),
      );
    expect(h.read.mock.calls.map(([input]) => input.capturedAt)).toEqual([
      2000, 8000, 14000, 20000, 26000, 32000,
    ]);
    expect(h.session.needs("event")).toBe(false);
    expect(h.onGuidanceComplete).toHaveBeenCalledWith("event");
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("Hold clears partial settling history and a fresh full window can accelerate the response", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    h.read.mockImplementationOnce(async (input) => unread(input));
    await h.session.offer(frame(1, { capturedAt: 2000 }));
    for (let i = 0; i < 3; i++)
      await h.session.offer(
        frame(i + 2, { capturedAt: 4000 + i * 200, image: images[2] }),
      );
    expect(h.read).toHaveBeenCalledOnce();
    h.session.discardPending();
    await h.session.offer(frame(5, { capturedAt: 4600, image: images[2] }));
    expect(h.read).toHaveBeenCalledOnce();
    for (let i = 0; i < 3; i++)
      await h.session.offer(
        frame(i + 6, { capturedAt: 4800 + i * 200, image: images[2] }),
      );
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read.mock.calls[1][0].capturedAt).toBe(5200);
    expect(h.onResolution).not.toHaveBeenCalled();
    await h.session.offer(frame(9, { capturedAt: 6700, image: images[3] }));
    expect(h.onResolution).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("starts another retained occurrence after Undo and ignores the retired reader's late completion", async () => {
    const h = harness();
    const retired = deferred<PrintingObservation>();
    const retained = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => retired.promise);
    h.read.mockImplementationOnce(() => retained.promise);
    const first = h.session.offer(frame(1, { eventId: "undone" }));
    const queued = frame(2, { eventId: "retained" });
    await h.session.offer(queued);
    expect(h.session.retainedCaptures).toBe(1);
    h.session.forget("undone");
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read.mock.calls[1][0].eventId).toBe("retained");
    expect(h.read.mock.calls[1][0].image).toBe(queued.image);
    expect(h.session.retainedCaptures).toBe(0);
    expect(h.session.busy).toBe(true);
    retired.resolve(observed(h.read.mock.calls[0][0]));
    expect(await first).toBe(false);
    expect(h.session.busy).toBe(true);
    expect(h.onDiagnostics).not.toHaveBeenCalled();
    retained.resolve(observed(h.read.mock.calls[1][0]));
    await vi.waitFor(() => expect(h.session.busy).toBe(false));
    expect(h.onDiagnostics).toHaveBeenCalledOnce();
    expect(h.onDiagnostics.mock.calls[0][0]).toBe("retained");
    expect(h.read).toHaveBeenCalledTimes(2);
    h.session.dispose();
  });
  it("does not let a later unchanged view replace a queued response to the live request", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    h.read.mockImplementation(async (input) => unread(input));
    await h.session.offer(frame(1, { capturedAt: 2000 }));
    expect(h.onGuidance).toHaveBeenCalledOnce();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const second = h.session.offer(
      frame(2, { capturedAt: 8000, image: images[1] }),
    );
    for (let i = 0; i < 3; i++)
      await h.session.offer(
        frame(3 + i, { capturedAt: 10000 + i * 200, image: images[2] }),
      );
    const response = frame(6, { capturedAt: 10600, image: images[2] });
    await h.session.offer(response);
    await h.session.offer(frame(7, { capturedAt: 12000, image: images[1] }));
    pending.resolve(unread(h.read.mock.calls[1][0]));
    await second;
    await vi.waitFor(() => expect(h.session.busy).toBe(false));
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.read.mock.calls[2][0].frameId).toBe(response.frameId);
    expect(h.read.mock.calls[2][0].image).toBe(response.image);
    h.session.dispose();
  });
  it("never spends an agreement read on known identical pixels even after the refresh interval", async () => {
    const h = harness();
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      imageFingerprint: "identical-source-bytes",
    }));
    await h.session.offer(frame());
    for (let index = 2; index < 12; index++)
      expect(await h.session.offer(frame(index, { image: images[1] }))).toBe(
        false,
      );
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.session.needs("event")).toBe(true);
    h.session.dispose();
  });
  it("caps retained occurrences at two and does not spend attempts on replacement", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame(1, { eventId: "active" }));
    for (let i = 2; i < 30; i++) {
      await h.session.offer(frame(i, { eventId: `pending-${i}` }));
      expect(h.session.retainedCaptures).toBeLessThanOrEqual(2);
    }
    expect(h.read).toHaveBeenCalledOnce();
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    await vi.waitFor(() => expect(h.session.busy).toBe(false));
    expect(h.read.mock.calls.map(([input]) => input.eventId)).toEqual([
      "active",
      "pending-28",
      "pending-29",
    ]);
    expect(h.session.retainedCaptures).toBe(0);
    h.session.dispose();
  });
  it("keeps a higher-native-detail pending original over a later weaker view", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    const sharper = frame(2, { sourceMinEdge: 800 });
    await h.session.offer(sharper);
    await h.session.offer(frame(3, { sourceMinEdge: 600 }));
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    await vi.waitFor(() => expect(h.session.busy).toBe(false));
    expect(h.read.mock.calls[1][0].image).toBe(sharper.image);
    expect(h.read.mock.calls[1][0]).toMatchObject({
      frameId: sharper.frameId,
      capturedAt: sharper.capturedAt,
      eventId: sharper.eventId,
      sourceMinEdge: 800,
    });
    h.session.dispose();
  });
  it("does not spend blank-read attempts on redundant views but permits a bounded refresh", async () => {
    const h = harness();
    h.read.mockImplementation(async (input) => unread(input));
    await h.session.offer(frame(1, { capturedAt: 2000 }));
    for (const capturedAt of [3500, 4000, 5500, 7999])
      expect(
        await h.session.offer(frame(2, { capturedAt, image: images[1] })),
      ).toBe(false);
    expect(h.read).toHaveBeenCalledOnce();
    expect(
      await h.session.offer(frame(3, { capturedAt: 8000, image: images[1] })),
    ).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.session.needs("event")).toBe(true);
    h.session.dispose();
  });
  it("drops pre-prompt captures, then promptly reads the changed response and a genuine agreement capture", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      candidates: [ref, { ...ref, key: "other", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "complete",
    });
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    await h.session.offer(frame(2));
    pending.resolve(unread(h.read.mock.calls[0][0]));
    await first;
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(h.session.retainedCaptures).toBe(0);
    expect(h.read).toHaveBeenCalledOnce();
    await h.session.offer(frame(2, { capturedAt: 8000, image: images[1] }));
    expect(h.read).toHaveBeenCalledOnce();
    await h.session.offer(frame(3));
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.onResolution).not.toHaveBeenCalled();
    // Similarity does not block the independent resolver's second original vote.
    const secondOriginal = {
      ...images[3],
      data: images[3].data.slice(),
    } as ImageData;
    secondOriginal.data[0]++;
    await h.session.offer(frame(4, { image: secondOriginal }));
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(h.onResolution.mock.calls[0][1]).toMatchObject({
      finish: "unknown",
      condition: "unknown",
      priceEligible: false,
    });
    expect(h.onGuidanceComplete).toHaveBeenCalledWith("event");
    h.session.dispose();
  });
  it.each(["cancel", "forget", "dispose"] as const)(
    "releases pending originals on %s without reviving late work",
    async (method) => {
      const h = harness();
      const pending = deferred<PrintingObservation>();
      h.read.mockImplementationOnce(() => pending.promise);
      const first = h.session.offer(frame());
      await h.session.offer(frame(2));
      expect(h.session.retainedCaptures).toBe(1);
      if (method === "forget") h.session.forget("event");
      else h.session[method]();
      pending.resolve(observed(h.read.mock.calls[0][0]));
      await first;
      expect(h.session.retainedCaptures).toBe(0);
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.onResolution).not.toHaveBeenCalled();
      h.session.dispose();
    },
  );
  it("Hold input discards queued views while allowing the already-started read to finish", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    await h.session.offer(frame(2));
    h.session.discardPending();
    expect(h.session.busy).toBe(true);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    expect(await first).toBe(true);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.session.retainedCaptures).toBe(0);
    h.session.dispose();
  });
  it("expires retained pixels on monotonic time even while the first read is still pending", async () => {
    vi.useFakeTimers();
    let now = 0;
    const h = harness(() => now);
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    await h.session.offer(frame(2));
    now = 8000;
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.session.busy).toBe(true);
    expect(h.session.retainedCaptures).toBe(0);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    expect(h.read).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it("rechecks queued occurrence ownership before dispatch", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame(1, { eventId: "active" }));
    await h.session.offer(frame(2, { eventId: "retired" }));
    h.isCurrent.mockImplementation((input) => input.eventId !== "retired");
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.session.retainedCaptures).toBe(0);
    h.session.dispose();
  });
  it("rejects missing/detached and undersized pixels before retention or OCR", async () => {
    const h = harness();
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const first = h.session.offer(frame());
    for (const image of [
      { width: 600, height: 840 },
      { width: 600, height: 840, data: new Uint8ClampedArray(0) },
    ] as ImageData[])
      expect(await h.session.offer(frame(2, { image }))).toBe(false);
    await h.session.offer(frame(2, { sourceMinEdge: 240 }));
    expect(h.session.retainedCaptures).toBe(0);
    pending.resolve(observed(h.read.mock.calls[0][0]));
    await first;
    expect(h.read).toHaveBeenCalledOnce();
    h.session.dispose();
  });
});

describe("one bounded late-literal confirmation", () => {
  it("keeps another occurrence's expiry live after Undo cancels the active reader", async () => {
    vi.useFakeTimers();
    let now = 0;
    const h = lateLiteralHarness(() => now);
    await offerNormalBudget(h);
    const pending = deferred<PrintingObservation>();
    h.read.mockImplementationOnce(() => pending.promise);
    const active = h.session.offer(frame(7, { eventId: "another-event" }));
    h.session.forget("another-event");
    now = 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.session.needs("event")).toBe(false);
    expect(h.onGuidanceComplete).toHaveBeenCalledWith("event");
    expect(h.onStatus.mock.calls.at(-1)?.[0]).toBe("event");
    pending.resolve(observed(h.read.mock.calls[6][0]));
    await active;
    h.session.dispose();
  });
  it("clears the request when an unused seventh opportunity expires without a new capture", async () => {
    vi.useFakeTimers();
    let now = 0;
    const h = lateLiteralHarness(() => now);
    await offerNormalBudget(h);
    expect(h.session.needs("event")).toBe(true);
    expect(h.onGuidanceComplete).not.toHaveBeenCalled();
    now = 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.session.needs("event")).toBe(false);
    expect(h.onGuidanceComplete).toHaveBeenCalledWith("event");
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "No more automatic reads",
    );
    expect(h.read).toHaveBeenCalledTimes(6);
    h.session.dispose();
  });
  it("does not consume the narrow seventh opportunity with a duplicate of the sixth capture", async () => {
    const h = lateLiteralHarness();
    await offerNormalBudget(h);
    expect(await h.session.offer(frame(7, { image: images[6] }))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.session.needs("event")).toBe(true);
    expect(await h.session.offer(frame(8))).toBe(true);
    expect(h.onResolution).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledTimes(7);
    h.session.dispose();
  });
  it("retires an impossible camera request after a final-attempt storage failure", async () => {
    const h = lateLiteralHarness();
    await offerNormalBudget(h);
    h.onResolution.mockReturnValue("Collection storage is unavailable.");
    await h.session.offer(frame(7));
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "storage is unavailable",
    );
    expect(h.session.needs("event")).toBe(false);
    expect(h.onGuidanceComplete).toHaveBeenCalledWith("event");
    h.session.dispose();
  });
  it("allows exactly one fresh seventh capture after the sixth read first separates the catalog", async () => {
    const h = lateLiteralHarness();
    await offerNormalBudget(h);
    expect(h.onGuidance).toHaveBeenCalledOnce();
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.session.needs("event")).toBe(true);
    expect(h.onStatus.mock.calls.at(-1)?.[1]).toContain(
      "another original capture",
    );
    expect(await h.session.offer(frame(7, { capturedAt: 36_100 }))).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(true);
    expect(h.onResolution).toHaveBeenCalledOnce();
    const result = h.onResolution.mock.calls[0][1];
    expect(result).toMatchObject({
      state: "catalog-printing-read",
      priceEligible: false,
      finish: "unknown",
      condition: "unknown",
    });
    expect(
      result.evidence
        .filter((value) => value.fields.collectorNumber)
        .map((value) => [value.frameId, value.imageFingerprint]),
    ).toEqual([
      ["frame-6", "pixels-frame-6"],
      ["frame-7", "pixels-frame-7"],
    ]);
    for (let index = 8; index <= 30; index++)
      expect(await h.session.offer(frame(index))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(7);
    h.session.dispose();
  });
  it.each([
    "blank",
    "mismatch",
    "ambiguous",
    "unknown-field",
    "edition",
    "stale",
    "incomplete",
  ])("does not grant a seventh read for a final %s result", async (kind) => {
    const h = lateLiteralHarness();
    for (let index = 1; index <= 5; index++)
      await h.session.offer(frame(index));
    if (kind === "blank")
      h.read.mockImplementationOnce(async (input) => ({
        ...observed(input),
        rawText: "",
        fields: {},
      }));
    if (kind === "mismatch")
      h.read.mockImplementationOnce(async (input) => ({
        ...observed(input),
        fields: { collectorNumber: "999", printedTotal: "198" },
      }));
    if (["ambiguous", "unknown-field", "edition"].includes(kind))
      h.catalog.mockResolvedValue({
        candidates: [
          ref,
          {
            ...ref,
            key: "alternative",
            ...(kind === "unknown-field"
              ? { printedTotal: undefined }
              : kind === "edition"
                ? { edition: "1ST EDITION" }
                : {}),
          },
        ],
        catalogCompleteForIdentity: true,
        scope: "complete",
      });
    if (kind === "stale" || kind === "incomplete")
      h.catalog.mockResolvedValue({
        candidates: [ref],
        catalogCompleteForIdentity: kind !== "incomplete",
        scope: "snapshot",
        provenance: {
          schemaVersion: 1,
          snapshotId: "sha256:" + "a".repeat(64),
          provider: "test",
          scope: "test",
          fetchedAt: "2026-10-14T00:00:00Z",
          stale: kind === "stale",
          completeWithinScope: kind !== "incomplete",
          candidateCount: 1,
        },
      });
    await h.session.offer(frame(6));
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("does not treat a repeated earlier literal with identical fingerprints as newly useful", async () => {
    const h = harness();
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      imageFingerprint: "same-pixels",
    }));
    await offerNormalBudget(h);
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it.each([
    "blank",
    "fingerprint",
    "capture-id",
    "conflict",
    "failure",
    "storage-failure",
  ])(
    "consumes the only extra opportunity after %s without renewal",
    async (kind) => {
      const h = lateLiteralHarness();
      await offerNormalBudget(h);
      if (kind === "failure")
        h.read.mockRejectedValueOnce(new Error("reader failed"));
      if (kind === "storage-failure")
        h.onResolution.mockReturnValue("Storage failed");
      if (kind !== "failure")
        h.read.mockImplementationOnce(async (input) => ({
          ...observed(input),
          ...(kind === "blank" ? { rawText: "", fields: {} } : {}),
          ...(kind === "fingerprint"
            ? { imageFingerprint: "pixels-frame-6" }
            : {}),
          ...(kind === "capture-id" ? { frameId: "frame-6" } : {}),
          ...(kind === "conflict"
            ? { fields: { collectorNumber: "26", printedTotal: "198" } }
            : {}),
        }));
      await h.session.offer(frame(7));
      expect(h.session.needs("event")).toBe(false);
      for (let index = 8; index <= 30; index++)
        expect(await h.session.offer(frame(index))).toBe(false);
      expect(h.read).toHaveBeenCalledTimes(7);
      if (kind !== "storage-failure")
        expect(h.onResolution).not.toHaveBeenCalled();
      expect(success(h.onStatus)).toHaveLength(0);
      h.session.dispose();
    },
  );
  it("does not extend when the sixth read is blank after an earlier useful literal", async () => {
    const h = harness();
    await h.session.offer(frame());
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
    for (let index = 2; index <= 6; index++)
      await h.session.offer(frame(index));
    expect(h.session.needs("event")).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("does not extend after an earlier reader failure", async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(new Error("timeout"));
    for (let index = 2; index <= 5; index++)
      h.read.mockImplementationOnce(async (input) => ({
        ...observed(input),
        rawText: "",
        fields: {},
      }));
    await offerNormalBudget(h);
    expect(h.session.needs("event")).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it.each(["cancel", "forget", "dispose", "eof"] as const)(
    "cannot publish a pending extra read after %s",
    async (kind) => {
      const h = lateLiteralHarness();
      await offerNormalBudget(h);
      const pending = deferred<PrintingObservation>();
      h.read.mockImplementationOnce(() => pending.promise);
      const running = h.session.offer(frame(7));
      if (kind === "eof") h.isCurrent.mockReturnValue(false);
      else if (kind === "forget") h.session.forget("event");
      else h.session[kind]();
      const statuses = h.onStatus.mock.calls.length;
      pending.resolve(observed(h.read.mock.calls[6][0]));
      expect(await running).toBe(false);
      expect(h.onResolution).not.toHaveBeenCalled();
      expect(h.onStatus).toHaveBeenCalledTimes(statuses);
      h.session.dispose();
    },
  );
  it.each(["cancel", "forget"] as const)(
    "does not renew the extra opportunity after %s and six fresh normal reads",
    async (kind) => {
      const h = lateLiteralHarness();
      await offerNormalBudget(h);
      if (kind === "forget") h.session.forget("event");
      else h.session.cancel();
      for (let index = 7; index <= 11; index++)
        h.read.mockImplementationOnce(async (input) => ({
          ...observed(input),
          rawText: "",
          fields: {},
        }));
      for (let index = 7; index <= 12; index++)
        await h.session.offer(frame(index));
      expect(h.read).toHaveBeenCalledTimes(12);
      expect(h.session.needs("event")).toBe(false);
      expect(await h.session.offer(frame(13))).toBe(false);
      expect(h.onResolution).not.toHaveBeenCalled();
      h.session.dispose();
    },
  );
  it("does not renew a granted opportunity after the observation cache evicts the event", async () => {
    const h = lateLiteralHarness();
    await offerNormalBudget(h);
    for (let index = 0; index < 30; index++)
      await h.session.offer(frame(1, { eventId: `other-${index}` }));
    for (let index = 7; index <= 11; index++)
      h.read.mockImplementationOnce(async (input) => ({
        ...observed(input),
        rawText: "",
        fields: {},
      }));
    for (let index = 7; index <= 12; index++)
      await h.session.offer(frame(index));
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(13))).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    h.session.dispose();
  });
  it("fails closed for extra opportunities when the bounded lifetime ledger saturates", async () => {
    const h = harness(() => 0);
    h.read.mockImplementation(async (input) => ({
      ...observed(input),
      rawText: "",
      fields: {},
    }));
    for (let index = 0; index < 2500; index++)
      await h.session.offer(frame(1, { eventId: `earlier-${index}` }));
    for (let index = 1; index <= 5; index++)
      await h.session.offer(frame(index));
    h.read.mockImplementationOnce(async (input) => observed(input));
    await h.session.offer(frame(6));
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    h.session.dispose();
  });
  it("does not grant after 90 seconds of actual lifetime even if media timestamps are short", async () => {
    let now = 0;
    const h = lateLiteralHarness(() => now);
    for (let index = 1; index <= 5; index++)
      await h.session.offer(frame(index));
    now = 90_000;
    await h.session.offer(frame(6));
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    h.session.dispose();
  });
  it("expires an unused opportunity 20 seconds after grant", async () => {
    let now = 0;
    const h = lateLiteralHarness(() => now);
    await offerNormalBudget(h);
    now = 19_999;
    expect(h.session.needs("event")).toBe(true);
    now = 20_000;
    expect(h.session.needs("event")).toBe(false);
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(6);
    h.session.dispose();
  });
  it.each([0, 85_000])(
    "times out pending confirmation at the earlier grant/lifetime deadline (grant at %i ms)",
    async (grantAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const h = lateLiteralHarness(() => Date.now());
      for (let index = 1; index <= 5; index++)
        await h.session.offer(frame(index));
      await vi.advanceTimersByTimeAsync(grantAt);
      await h.session.offer(frame(6));
      const pending = deferred<PrintingObservation>();
      h.read.mockImplementationOnce(() => pending.promise);
      const running = h.session.offer(frame(7));
      const remaining = Math.min(20_000, 90_000 - grantAt);
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(h.session.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toBe(false);
      expect(h.session.busy).toBe(false);
      expect(h.read.mock.calls[6][0].signal.aborted).toBe(true);
      expect(h.session.needs("event")).toBe(false);
      pending.resolve(observed(h.read.mock.calls[6][0]));
      await Promise.resolve();
      expect(h.onResolution).not.toHaveBeenCalled();
      expect(await h.session.offer(frame(8))).toBe(false);
      h.session.dispose();
    },
  );
  it("rejects a result past the monotonic deadline even before its timer fires", async () => {
    let now = 0;
    const h = lateLiteralHarness(() => now);
    await offerNormalBudget(h);
    h.read.mockImplementationOnce(async (input) => {
      now = 20_000;
      return observed(input);
    });
    expect(await h.session.offer(frame(7))).toBe(false);
    expect(h.onResolution).not.toHaveBeenCalled();
    expect(h.onDiagnostics).toHaveBeenCalledTimes(6);
    expect(h.session.needs("event")).toBe(false);
    h.session.dispose();
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
