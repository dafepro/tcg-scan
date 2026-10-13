import { describe, expect, it } from "vitest";
import { PackSession } from "./pack-session";
import type { PackCaptureView } from "./pack-capture";
import type { VisionResult } from "./vision";
function view(frameId = 1, sessionId = "pack"): PackCaptureView {
  return {
    sessionId,
    sourceId: "source",
    generation: 1,
    captureId: `${sessionId}:capture:${frameId}`,
    frameId,
    capturedAt: frameId * 120,
    sourceFrame: {
      presentedFrames: frameId,
      mediaTime: frameId * 0.12,
      presentationTime: frameId * 120,
      callbackAt: frameId * 120,
    },
    trackId: `track${frameId}`,
    copyLineage: "unproven",
    width: 64,
    height: 64,
    queuedAt: frameId * 120,
    qualityScore: 12,
  };
}
function result(name = "A"): VisionResult {
  return {
    width: 64,
    height: 64,
    detections: [
      {
        quad: [
          { x: 5, y: 5 },
          { x: 50, y: 5 },
          { x: 50, y: 60 },
          { x: 5, y: 60 },
        ],
        state: "verified",
        reason: "Verified",
        autoEligible: true,
        quality: {
          laplacianVariance: 200,
          contrast: 80,
          meanLuminance: 120,
          saturatedFraction: 0,
          sourceMinEdge: 240,
          featureCount: 100,
          issues: [],
        },
        candidates: [
          {
            key: name,
            reference: { key: name, game: "pokemon", name, identityKey: name },
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
      },
    ],
    timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 },
    coverage: {
      totalReferences: 100,
      byGame: { pokemon: 100, mtg: 0, yugioh: 0 },
      packs: [],
    },
    budgetExhausted: false,
    detectionComplete: true,
  };
}
function identify(
  session: PackSession,
  frame: number,
  name: string,
  autoSave = true,
) {
  const captured = view(frame);
  session.queue(captured);
  session.identifying(captured.captureId, captured.queuedAt + 10);
  return session.consume(
    captured.captureId,
    result(name),
    captured.queuedAt + 1000,
    autoSave,
  );
}
describe("captured pack receipts and immutable save intents", () => {
  it("saves delayed A then B with their captured timestamps and idempotent event IDs", () => {
    const session = new PackSession("pack", () => 5000);
    const a = identify(session, 1, "A")[0];
    expect(a.capturedAt).toBe(120);
    expect(a.reference.name).toBe("A");
    expect(session.consume(a.captureId, result("B"), 4000, true)).toEqual([]);
    session.acknowledge(a.eventId);
    const b = identify(session, 2, "B")[0];
    session.acknowledge(b.eventId);
    expect(
      session
        .snapshot()
        .map((r) => [r.status, r.reference?.name, r.capturedAt]),
    ).toEqual([
      ["saved", "A", 120],
      ["saved", "B", 240],
    ]);
    expect(session.snapshot()[0].savedAt).toBe(5000);
    expect(session.acknowledge(a.eventId)).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.reference)).toBe(true);
  });
  it("A→B→A, gaps, printing variants, and a second same-name identity cannot silently count an identical physical copy", () => {
    const session = new PackSession("pack");
    const a = identify(session, 1, "A")[0];
    session.acknowledge(a.eventId);
    const b = identify(session, 2, "B")[0];
    session.acknowledge(b.eventId);
    expect(identify(session, 10, "A")).toEqual([]);
    expect(session.snapshot().at(-1)?.status).toBe("duplicate");
    const v = view(11);
    session.queue(v);
    session.identifying(v.captureId, v.queuedAt);
    const printing = result("A");
    printing.detections[0].candidates[0].reference.key = "A-other-printing";
    expect(session.consume(v.captureId, printing, 9999, true)).toEqual([]);
  });
  it.each([
    "unknown",
    "back",
    "blur",
    "partial",
    "conflict",
    "incomplete",
    "wrong-size",
    "false-geometry",
  ])("keeps %s review-only without borrowing a previous identity", (kind) => {
    const session = new PackSession("pack");
    const first = identify(session, 1, "A")[0];
    session.acknowledge(first.eventId);
    const v = view(2),
      next = result("B");
    if (kind === "unknown" || kind === "back") {
      next.detections[0].autoEligible = false;
      next.detections[0].state = "unknown";
    }
    if (kind === "blur") next.detections[0].quality.issues = ["Blur"];
    if (kind === "partial") next.detections[0].deferred = true;
    if (kind === "conflict") next.detections.push(result("C").detections[0]);
    if (kind === "incomplete") next.detectionComplete = false;
    if (kind === "wrong-size") next.width++;
    if (kind === "false-geometry")
      next.detections[0].candidates[0].inliers = 23;
    session.queue(v);
    session.identifying(v.captureId, v.queuedAt);
    expect(session.consume(v.captureId, next, 1000, true)).toEqual([]);
    expect(session.snapshot().at(-1)?.status).toBe("review");
    expect(session.snapshot().at(-1)?.reference).toBeUndefined();
  });
  it("rejects cross-session/source/generation work and cancellation blocks late save/ack/retry", () => {
    const session = new PackSession("pack");
    expect(session.queue(view(1, "other"))).toBe(false);
    session.queue(view(1));
    expect(session.queue({ ...view(2), sourceId: "other" })).toBe(false);
    expect(session.queue({ ...view(2), generation: 2 })).toBe(false);
    session.identifying(view(1).captureId, 130);
    session.cancel();
    expect(session.consume(view(1).captureId, result(), 1000, true)).toEqual(
      [],
    );
    expect(session.snapshot()[0].status).toBe("cancelled");
    expect(session.queue(view(3))).toBe(false);
  });
  it("retries only the exact failed durable intent, and Undo retains its identity latch", () => {
    const session = new PackSession("pack");
    const intent = identify(session, 1, "A")[0];
    expect(session.retry(intent.eventId)).toBeUndefined();
    session.acknowledge(intent.eventId, "Storage full");
    const retried = session.retry(intent.eventId)!;
    expect(retried).toEqual(intent);
    expect(session.retry(intent.eventId)).toBeUndefined();
    session.acknowledge(intent.eventId);
    expect(session.undo(intent.eventId)).toBe(true);
    expect(session.undo(intent.eventId)).toBe(false);
    expect(identify(session, 2, "A")).toEqual([]);
    expect(session.snapshot()[0].status).toBe("undone");
  });
  it("auto-save off does not create a retryable intent or cache identity votes", () => {
    const session = new PackSession("pack");
    expect(identify(session, 1, "A", false)).toEqual([]);
    expect(session.snapshot()[0].status).toBe("review");
    expect(session.snapshot()[0].eventId).toBeUndefined();
    expect(identify(session, 2, "A")).toHaveLength(1);
  });
  it("drops only pending captures, returns independent metadata snapshots and retains no pixel evidence", () => {
    const session = new PackSession("pack");
    session.queue(view(1));
    expect(session.drop(view(1).captureId, "overflow")).toBe(true);
    expect(session.identifying(view(1).captureId, 140)).toBe(false);
    const saved = identify(session, 2, "B")[0];
    session.acknowledge(saved.eventId);
    const snapshot = session.snapshot();
    snapshot[1].reference!.name = "Changed";
    expect(session.snapshot()[1].reference!.name).toBe("B");
    expect(JSON.stringify(session.snapshot())).not.toContain('"data"');
  });
  it("repeated identity after a failed save never claims that it was counted", () => {
    const session = new PackSession("pack"),
      intent = identify(session, 1, "A")[0];
    session.acknowledge(intent.eventId, "Storage full");
    expect(identify(session, 2, "A")).toEqual([]);
    expect(session.snapshot()[1].reason).toContain("earlier failed save");
    expect(session.snapshot().filter((r) => r.status === "saved")).toHaveLength(
      0,
    );
    expect(session.retry(intent.eventId)?.eventId).toBe(intent.eventId);
  });

  it("prunes only the oldest terminal display receipt at capacity and reports the count", () => {
    const session = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) {
      const captured = view(frame);
      session.queue(captured);
      if (frame % 2) session.drop(captured.captureId, "similar view omitted");
      else {
        session.identifying(captured.captureId, captured.queuedAt);
        const unknown = result();
        unknown.detections[0].autoEligible = false;
        session.consume(
          captured.captureId,
          unknown,
          captured.queuedAt + 1,
          true,
        );
      }
    }
    expect(session.prunedReceiptCount).toBe(0);
    session.queue(view(513));
    session.queue(view(514));
    expect(session.snapshot()).toHaveLength(512);
    expect(session.snapshot()[0].frameId).toBe(3);
    expect(session.snapshot().at(-1)?.frameId).toBe(514);
    expect(session.prunedReceiptCount).toBe(2);
  });
  it("retains saved, failed, active and undone receipts plus all event latches while pruning duplicates", () => {
    const session = new PackSession("pack");
    const saved = identify(session, 1, "Saved")[0];
    session.acknowledge(saved.eventId);
    const failed = identify(session, 2, "Failed")[0];
    session.acknowledge(failed.eventId, "Storage full");
    session.queue(view(3));
    session.queue(view(4));
    session.identifying(view(4).captureId, view(4).queuedAt);
    const saving = identify(session, 5, "Saving")[0];
    const undone = identify(session, 6, "Undone")[0];
    session.acknowledge(undone.eventId);
    session.undo(undone.eventId);
    for (let frame = 7; frame <= 512; frame++)
      expect(identify(session, frame, "Saved")).toEqual([]);
    expect(session.queue(view(513))).toBe(true);
    expect(
      session
        .snapshot()
        .slice(0, 6)
        .map((receipt) => receipt.status),
    ).toEqual(["saved", "error", "queued", "identifying", "saving", "undone"]);
    expect(session.snapshot().some((receipt) => receipt.frameId === 7)).toBe(
      false,
    );
    expect(session.prunedReceiptCount).toBe(1);
    expect(session.retry(failed.eventId)).toEqual(failed);
    expect(session.acknowledge(failed.eventId)).toBe(true);
    expect(session.acknowledge(saving.eventId)).toBe(true);
    expect(session.undo(saved.eventId)).toBe(true);
    for (const [frame, name] of [
      [514, "Saved"],
      [515, "Failed"],
      [516, "Saving"],
      [517, "Undone"],
    ] as const)
      expect(identify(session, frame, name)).toEqual([]);
    expect(
      session.snapshot().filter((receipt) => receipt.status === "saved"),
    ).toHaveLength(2);
    expect(
      session.snapshot().filter((receipt) => receipt.status === "undone"),
    ).toHaveLength(2);
    expect(session.acknowledge(failed.eventId)).toBe(false);
    expect(session.prunedReceiptCount).toBe(5);
  });
  it("keeps the explicit capacity error when all 512 receipts are active or durable", () => {
    const active = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) active.queue(view(frame));
    expect(() => active.queue(view(513))).toThrow("Pack receipt limit reached");
    expect(active.snapshot()).toHaveLength(512);
    expect(active.prunedReceiptCount).toBe(0);
    const durable = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) {
      const intent = identify(durable, frame, `Unique-${frame}`)[0];
      durable.acknowledge(intent.eventId);
    }
    expect(() => durable.queue(view(513))).toThrow(
      "Pack receipt limit reached",
    );
    expect(
      durable.snapshot().filter((receipt) => receipt.status === "saved"),
    ).toHaveLength(512);
    expect(durable.prunedReceiptCount).toBe(0);
  });
});

describe("explicitly confirmed pack copies", () => {
  function savedSession(now = () => 5000) {
    const session = new PackSession("pack", now);
    const original = identify(session, 1, "A")[0];
    expect(session.acknowledge(original.eventId)).toBe(true);
    return { session, original };
  }

  it("issues one independent save per operation, never one per redelivery or repeated frame", () => {
    const { session, original } = savedSession();
    const first = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    expect(first.eventId).not.toBe(original.eventId);
    expect(first.receiptId).not.toBe(original.receiptId);
    expect(first.captureId).toBe(original.captureId);
    expect(first.quantityConfirmation).toEqual({
      operationId: "copy-1",
      sourceReceiptId: original.receiptId,
      confirmedAt: 5000,
    });
    expect(session.snapshot().map((receipt) => receipt.status)).toEqual([
      "saved",
      "saving",
    ]);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeUndefined();
    expect(session.acknowledge(first.eventId)).toBe(true);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeUndefined();
    const second = session.confirmAnotherCopy(original.receiptId, "copy-2")!;
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(session.acknowledge(second.eventId)).toBe(true);
    expect(
      session.snapshot().filter((receipt) => receipt.status === "saved"),
    ).toHaveLength(3);
    expect(identify(session, 2, "A")).toEqual([]);
    expect(session.snapshot().at(-1)?.status).toBe("duplicate");
    expect(session.snapshot().at(-1)?.eventId).toBe(original.eventId);
  });

  it("retries the identical failed event and waits for actual save acknowledgment", () => {
    const { session, original } = savedSession();
    const extra = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    expect(session.retry(extra.eventId)).toBeUndefined();
    expect(session.undo(extra.eventId)).toBe(false);
    expect(
      session.snapshot().filter((receipt) => receipt.status === "saved"),
    ).toHaveLength(1);
    expect(session.acknowledge(extra.eventId, "Storage full")).toBe(true);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeUndefined();
    expect(session.snapshot().at(-1)?.status).toBe("error");
    const retry = session.retry(extra.eventId);
    expect(retry).toBe(extra);
    expect(Object.isFrozen(retry)).toBe(true);
    expect(Object.isFrozen(retry?.reference)).toBe(true);
    expect(Object.isFrozen(retry?.quantityConfirmation)).toBe(true);
    expect(session.retry(extra.eventId)).toBeUndefined();
    expect(session.acknowledge(extra.eventId)).toBe(true);
    expect(session.acknowledge(extra.eventId)).toBe(false);
    expect(
      session.snapshot().filter((receipt) => receipt.status === "saved"),
    ).toHaveLength(2);
    expect(session.snapshot().at(-1)?.reason).toContain(
      "Printing, finish and condition remain unconfirmed",
    );
  });

  it("Undo removes exactly its extra copy and neither replay nor a new frame resurrects it", () => {
    const { session, original } = savedSession();
    const extra = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    const another = session.confirmAnotherCopy(original.receiptId, "copy-2")!;
    session.acknowledge(extra.eventId);
    session.acknowledge(another.eventId);
    expect(session.undo(extra.eventId)).toBe(true);
    expect(session.undo(extra.eventId)).toBe(false);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeUndefined();
    expect(session.retry(extra.eventId)).toBeUndefined();
    expect(
      session.snapshot().map((receipt) => [receipt.eventId, receipt.status]),
    ).toEqual([
      [original.eventId, "saved"],
      [extra.eventId, "undone"],
      [another.eventId, "saved"],
    ]);
    expect(identify(session, 2, "A")).toEqual([]);
    expect(session.undo(original.eventId)).toBe(true);
    expect(identify(session, 3, "A")).toEqual([]);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-3"),
    ).toBeUndefined();
    expect(
      session.snapshot().find((receipt) => receipt.eventId === another.eventId)
        ?.status,
    ).toBe("saved");
  });

  it("preserves original metadata and native provenance without fabricating inference or capture latency", () => {
    const { session, original } = savedSession();
    const before = session.snapshot()[0];
    const extra = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    const pending = session.snapshot()[1];
    for (const key of [
      "sessionId",
      "sourceId",
      "generation",
      "captureId",
      "frameId",
      "capturedAt",
      "sourceFrame",
      "trackId",
      "copyLineage",
      "width",
      "height",
      "queuedAt",
      "qualityScore",
    ] as const)
      expect(pending[key]).toEqual(before[key]);
    expect(pending.reference).toEqual(before.reference);
    expect(pending.copyLineage).toBe("unproven");
    expect(pending.startedAt).toBeUndefined();
    expect(pending.completedAt).toBeUndefined();
    expect(pending.savedAt).toBeUndefined();
    expect(pending.timings).toBeUndefined();
    expect(Object.isFrozen(pending.sourceFrame)).toBe(true);
    expect(Object.isFrozen(pending.quantityConfirmation)).toBe(true);
    pending.reference!.name = "Mutated snapshot";
    expect(session.snapshot()[1].reference?.name).toBe("A");
    session.acknowledge(extra.eventId);
    expect(session.snapshot()[0]).toEqual(before);
    expect(session.snapshot()[1].reason).toContain("extra copy you confirmed");
    expect(session.snapshot()[1].completedAt).toBeUndefined();
    expect(session.snapshot()[1].timings).toBeUndefined();
  });

  it("accepts a saved confirmed-copy receipt as a source while keeping its original native evidence", () => {
    const { session, original } = savedSession();
    const extra = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    expect(
      session.confirmAnotherCopy(extra.receiptId, "copy-2"),
    ).toBeUndefined();
    session.acknowledge(extra.eventId);
    const second = session.confirmAnotherCopy(extra.receiptId, "copy-2")!;
    expect(second.quantityConfirmation?.sourceReceiptId).toBe(extra.receiptId);
    expect(second.captureId).toBe(original.captureId);
    expect(second.capturedAt).toBe(original.capturedAt);
    expect(
      session.confirmAnotherCopy(extra.receiptId, "copy-1"),
    ).toBeUndefined();
    expect(session.acknowledge(second.eventId)).toBe(true);
  });

  it.each([
    "",
    " ",
    " leading",
    "trailing ",
    "with space",
    "line\nbreak",
    "copy\n",
    "copy\r\n",
    "é",
    "copy/1",
    "copy?1",
    "x".repeat(129),
    null,
    123,
  ])(
    "rejects malformed operation ID %j without allocating a record",
    (operationId) => {
      const { session, original } = savedSession();
      expect(
        session.confirmAnotherCopy(original.receiptId, operationId as string),
      ).toBeUndefined();
      expect(session.snapshot()).toHaveLength(1);
    },
  );

  it.each([
    Number.NaN,
    Infinity,
    -Infinity,
    -1,
    4999,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid or regressed confirmation clock %s", (badClock) => {
    let now = 5000;
    const { session, original } = savedSession(() => now);
    now = badClock;
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeUndefined();
    expect(session.snapshot()).toHaveLength(1);
    now = 5001;
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-1"),
    ).toBeDefined();
  });

  it("rejects invalid acknowledgment clocks without inventing a Saved receipt", () => {
    let now = 5000;
    const { session, original } = savedSession(() => now);
    const extra = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    now = NaN;
    expect(session.acknowledge(extra.eventId)).toBe(false);
    expect(session.snapshot()[1].status).toBe("saving");
    now = 5001;
    expect(session.acknowledge(extra.eventId)).toBe(true);
    expect(session.snapshot()[1].savedAt).toBe(5001);
  });

  it("rejects unknown, foreign-session, unsaved, review-only, duplicate and undone sources", () => {
    const { session, original } = savedSession();
    const assertRejected = (receiptId: string) =>
      expect(session.confirmAnotherCopy(receiptId, "copy-1")).toBeUndefined();
    assertRejected("not-a-receipt");
    assertRejected("other:capture:1");
    session.queue(view(2));
    assertRejected(view(2).captureId);
    session.identifying(view(2).captureId, 240);
    assertRejected(view(2).captureId);
    const pending = session.consume(
      view(2).captureId,
      result("B"),
      300,
      true,
    )[0];
    assertRejected(pending.receiptId);
    session.acknowledge(pending.eventId, "Storage full");
    assertRejected(pending.receiptId);
    identify(session, 3, "C", false);
    assertRejected(view(3).captureId);
    identify(session, 4, "A");
    assertRejected(view(4).captureId);
    session.queue(view(5));
    session.drop(view(5).captureId, "omitted");
    assertRejected(view(5).captureId);
    session.undo(original.eventId);
    assertRejected(original.receiptId);
    session.cancel();
    assertRejected(pending.receiptId);
    expect(
      session.snapshot().some((receipt) => receipt.quantityConfirmation),
    ).toBe(false);
  });

  it("permits explicit saved-receipt confirmation after Stop without reviving cancelled callbacks", () => {
    const { session, original } = savedSession();
    const pending = identify(session, 2, "B")[0];
    const failed = identify(session, 3, "C")[0];
    session.acknowledge(failed.eventId, "Storage full");
    session.queue(view(4));
    session.identifying(view(4).captureId, 480);
    session.queue(view(5));
    session.cancel();
    const extra = session.confirmAnotherCopy(
      original.receiptId,
      "copy-after-stop",
    )!;
    expect(extra).toBeDefined();
    expect(session.acknowledge(pending.eventId)).toBe(false);
    expect(session.retry(failed.eventId)).toBeUndefined();
    expect(session.consume(view(4).captureId, result("D"), 6000, true)).toEqual(
      [],
    );
    expect(session.identifying(view(5).captureId, 6000)).toBe(false);
    expect(session.queue(view(6))).toBe(false);
    expect(
      session.confirmAnotherCopy(pending.receiptId, "cancelled-source"),
    ).toBeUndefined();
    expect(session.acknowledge(extra.eventId, "Storage full")).toBe(true);
    expect(session.retry(extra.eventId)).toBe(extra);
    expect(session.acknowledge(extra.eventId)).toBe(true);
    expect(session.undo(extra.eventId)).toBe(true);
    expect(
      session
        .snapshot()
        .slice(1, 5)
        .map((receipt) => receipt.status),
    ).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(session.snapshot()[0].status).toBe("saved");
  });

  it("does not cancel explicit pending/failed confirmations when capture is stopped", () => {
    const { session, original } = savedSession();
    const pending = session.confirmAnotherCopy(original.receiptId, "copy-1")!;
    const failed = session.confirmAnotherCopy(original.receiptId, "copy-2")!;
    session.acknowledge(failed.eventId, "Storage full");
    session.cancel();
    session.cancel();
    expect(session.snapshot().map((receipt) => receipt.status)).toEqual([
      "saved",
      "saving",
      "error",
    ]);
    expect(session.acknowledge(pending.eventId)).toBe(true);
    expect(session.retry(failed.eventId)).toBe(failed);
    expect(session.acknowledge(failed.eventId)).toBe(true);
  });

  it("counts manual receipt history toward the same capacity and retains saved/retry/Undo records", () => {
    const { session, original } = savedSession();
    const extras = [];
    for (let index = 1; index <= 511; index++) {
      const extra = session.confirmAnotherCopy(
        original.receiptId,
        `copy-${index}`,
      )!;
      extras.push(extra);
      session.acknowledge(
        extra.eventId,
        index % 3 === 0 ? "Storage full" : undefined,
      );
      if (index % 3 === 1) session.undo(extra.eventId);
    }
    const before = session.snapshot();
    expect(before).toHaveLength(512);
    expect(new Set(before.map((receipt) => receipt.receiptId)).size).toBe(512);
    expect(
      session.confirmAnotherCopy(original.receiptId, "copy-511"),
    ).toBeUndefined();
    expect(() =>
      session.confirmAnotherCopy(original.receiptId, "copy-overflow"),
    ).toThrow("Pack receipt limit reached");
    expect(() => session.queue(view(2))).toThrow("Pack receipt limit reached");
    expect(session.snapshot()).toEqual(before);
    expect(session.prunedReceiptCount).toBe(0);
    expect(session.retry(extras[2].eventId)).toBe(extras[2]);
    expect(session.acknowledge(extras[2].eventId)).toBe(true);
    expect(session.undo(extras[1].eventId)).toBe(true);
  });

  it("can prune disposable capture history for an explicit copy while preserving cancelled intents", () => {
    const { session, original } = savedSession();
    const cancelledIntent = identify(session, 2, "B")[0];
    for (let frame = 3; frame <= 512; frame++) {
      session.queue(view(frame));
      session.drop(view(frame).captureId, "omitted");
    }
    session.cancel();
    const extra = session.confirmAnotherCopy(
      original.receiptId,
      "copy-after-stop",
    )!;
    expect(extra).toBeDefined();
    expect(session.snapshot()).toHaveLength(512);
    expect(session.snapshot().some((receipt) => receipt.frameId === 3)).toBe(
      false,
    );
    expect(
      session
        .snapshot()
        .find((receipt) => receipt.eventId === cancelledIntent.eventId)?.status,
    ).toBe("cancelled");
    expect(session.acknowledge(cancelledIntent.eventId)).toBe(false);
    expect(session.prunedReceiptCount).toBe(1);
  });

  it("cannot exceed the bound by replacing cancelled automatic intents after Stop", () => {
    const { session, original } = savedSession();
    for (let frame = 2; frame <= 512; frame++)
      identify(session, frame, `Unique-${frame}`);
    session.cancel();
    expect(() =>
      session.confirmAnotherCopy(original.receiptId, "copy-overflow"),
    ).toThrow("Pack receipt limit reached");
    expect(session.snapshot()).toHaveLength(512);
    expect(session.prunedReceiptCount).toBe(0);
  });
});
