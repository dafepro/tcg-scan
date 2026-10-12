import { describe, expect, it } from "vitest";
import { PackSession } from "./pack-session";
import type { PackCaptureView } from "./pack-capture";
import type { VisionResult } from "./vision";
function view(frameId = 1, sessionId = "pack"): PackCaptureView {
  return { sessionId, sourceId: "source", generation: 1, captureId: `${sessionId}:capture:${frameId}`, frameId, capturedAt: frameId * 120, sourceFrame: { presentedFrames: frameId, mediaTime: frameId * .12, presentationTime: frameId * 120, callbackAt: frameId * 120 }, trackId: `track${frameId}`, copyLineage: "unproven", width: 64, height: 64, queuedAt: frameId * 120, qualityScore: 12 };
}
function result(name = "A"): VisionResult {
  return { width: 64, height: 64, detections: [{ quad: [{ x: 5, y: 5 }, { x: 50, y: 5 }, { x: 50, y: 60 }, { x: 5, y: 60 }], state: "verified", reason: "Verified", autoEligible: true, quality: { laplacianVariance: 200, contrast: 80, meanLuminance: 120, saturatedFraction: 0, sourceMinEdge: 240, featureCount: 100, issues: [] }, candidates: [{ key: name, reference: { key: name, game: "pokemon", name, identityKey: name }, hashDistance: 0, tentativeMatches: 60, inliers: 50, inlierRatio: .9, interiorInliers: 20, coverage: .7, medianReprojectionError: .5, cornerError: .01, geometricallyVerified: true }] }], timings: { detectionMs: 10, extractionMs: 20, matchingMs: 30, totalMs: 60 }, coverage: { totalReferences: 100, byGame: { pokemon: 100, mtg: 0, yugioh: 0 }, packs: [] }, budgetExhausted: false, detectionComplete: true };
}
function identify(session: PackSession, frame: number, name: string, autoSave = true) {
  const captured = view(frame); session.queue(captured); session.identifying(captured.captureId, captured.queuedAt + 10);
  return session.consume(captured.captureId, result(name), captured.queuedAt + 1000, autoSave);
}
describe("captured pack receipts and immutable save intents", () => {
  it("saves delayed A then B with their captured timestamps and idempotent event IDs", () => {
    const session = new PackSession("pack", () => 5000);
    const a = identify(session, 1, "A")[0]; expect(a.capturedAt).toBe(120); expect(a.reference.name).toBe("A");
    expect(session.consume(a.captureId, result("B"), 4000, true)).toEqual([]);
    session.acknowledge(a.eventId); const b = identify(session, 2, "B")[0]; session.acknowledge(b.eventId);
    expect(session.snapshot().map(r => [r.status, r.reference?.name, r.capturedAt])).toEqual([["saved", "A", 120], ["saved", "B", 240]]);
    expect(session.snapshot()[0].savedAt).toBe(5000); expect(session.acknowledge(a.eventId)).toBe(false);
    expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.reference)).toBe(true);
  });
  it("A→B→A, gaps, printing variants, and a second same-name identity cannot silently count an identical physical copy", () => {
    const session = new PackSession("pack"); const a = identify(session, 1, "A")[0]; session.acknowledge(a.eventId);
    const b = identify(session, 2, "B")[0]; session.acknowledge(b.eventId);
    expect(identify(session, 10, "A")).toEqual([]); expect(session.snapshot().at(-1)?.status).toBe("duplicate");
    const v = view(11); session.queue(v); session.identifying(v.captureId, v.queuedAt);
    const printing = result("A"); printing.detections[0].candidates[0].reference.key = "A-other-printing";
    expect(session.consume(v.captureId, printing, 9999, true)).toEqual([]);
  });
  it.each(["unknown", "back", "blur", "partial", "conflict", "incomplete", "wrong-size", "false-geometry"])("keeps %s review-only without borrowing a previous identity", kind => {
    const session = new PackSession("pack"); const first = identify(session, 1, "A")[0]; session.acknowledge(first.eventId);
    const v = view(2), next = result("B");
    if (kind === "unknown" || kind === "back") { next.detections[0].autoEligible = false; next.detections[0].state = "unknown"; }
    if (kind === "blur") next.detections[0].quality.issues = ["Blur"];
    if (kind === "partial") next.detections[0].deferred = true;
    if (kind === "conflict") next.detections.push(result("C").detections[0]);
    if (kind === "incomplete") next.detectionComplete = false;
    if (kind === "wrong-size") next.width++;
    if (kind === "false-geometry") next.detections[0].candidates[0].inliers = 23;
    session.queue(v); session.identifying(v.captureId, v.queuedAt);
    expect(session.consume(v.captureId, next, 1000, true)).toEqual([]);
    expect(session.snapshot().at(-1)?.status).toBe("review"); expect(session.snapshot().at(-1)?.reference).toBeUndefined();
  });
  it("rejects cross-session/source/generation work and cancellation blocks late save/ack/retry", () => {
    const session = new PackSession("pack"); expect(session.queue(view(1, "other"))).toBe(false);
    session.queue(view(1)); expect(session.queue({ ...view(2), sourceId: "other" })).toBe(false); expect(session.queue({ ...view(2), generation: 2 })).toBe(false);
    session.identifying(view(1).captureId, 130); session.cancel(); expect(session.consume(view(1).captureId, result(), 1000, true)).toEqual([]);
    expect(session.snapshot()[0].status).toBe("cancelled"); expect(session.queue(view(3))).toBe(false);
  });
  it("retries only the exact failed durable intent, and Undo retains its identity latch", () => {
    const session = new PackSession("pack"); const intent = identify(session, 1, "A")[0];
    expect(session.retry(intent.eventId)).toBeUndefined(); session.acknowledge(intent.eventId, "Storage full");
    const retried = session.retry(intent.eventId)!; expect(retried).toEqual(intent); expect(session.retry(intent.eventId)).toBeUndefined();
    session.acknowledge(intent.eventId); expect(session.undo(intent.eventId)).toBe(true); expect(session.undo(intent.eventId)).toBe(false);
    expect(identify(session, 2, "A")).toEqual([]); expect(session.snapshot()[0].status).toBe("undone");
  });
  it("auto-save off does not create a retryable intent or cache identity votes", () => {
    const session = new PackSession("pack"); expect(identify(session, 1, "A", false)).toEqual([]);
    expect(session.snapshot()[0].status).toBe("review"); expect(session.snapshot()[0].eventId).toBeUndefined();
    expect(identify(session, 2, "A")).toHaveLength(1);
  });
  it("drops only pending captures, returns independent metadata snapshots and retains no pixel evidence", () => {
    const session = new PackSession("pack"); session.queue(view(1)); expect(session.drop(view(1).captureId, "overflow")).toBe(true);
    expect(session.identifying(view(1).captureId, 140)).toBe(false);
    const saved = identify(session, 2, "B")[0]; session.acknowledge(saved.eventId);
    const snapshot = session.snapshot(); snapshot[1].reference!.name = "Changed";
    expect(session.snapshot()[1].reference!.name).toBe("B"); expect(JSON.stringify(session.snapshot())).not.toContain('"data"');
  });
  it("repeated identity after a failed save never claims that it was counted", () => {
    const session = new PackSession("pack"), intent = identify(session, 1, "A")[0];
    session.acknowledge(intent.eventId, "Storage full"); expect(identify(session, 2, "A")).toEqual([]);
    expect(session.snapshot()[1].reason).toContain("earlier failed save");
    expect(session.snapshot().filter(r => r.status === "saved")).toHaveLength(0);
    expect(session.retry(intent.eventId)?.eventId).toBe(intent.eventId);
  });

  it("prunes only the oldest terminal display receipt at capacity and reports the count", () => {
    const session = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) {
      const captured = view(frame); session.queue(captured);
      if (frame % 2) session.drop(captured.captureId, "similar view omitted");
      else {
        session.identifying(captured.captureId, captured.queuedAt);
        const unknown = result(); unknown.detections[0].autoEligible = false;
        session.consume(captured.captureId, unknown, captured.queuedAt + 1, true);
      }
    }
    expect(session.prunedReceiptCount).toBe(0);
    session.queue(view(513)); session.queue(view(514));
    expect(session.snapshot()).toHaveLength(512);
    expect(session.snapshot()[0].frameId).toBe(3);
    expect(session.snapshot().at(-1)?.frameId).toBe(514);
    expect(session.prunedReceiptCount).toBe(2);
  });
  it("retains saved, failed, active and undone receipts plus all event latches while pruning duplicates", () => {
    const session = new PackSession("pack");
    const saved = identify(session, 1, "Saved")[0]; session.acknowledge(saved.eventId);
    const failed = identify(session, 2, "Failed")[0]; session.acknowledge(failed.eventId, "Storage full");
    session.queue(view(3));
    session.queue(view(4)); session.identifying(view(4).captureId, view(4).queuedAt);
    const saving = identify(session, 5, "Saving")[0];
    const undone = identify(session, 6, "Undone")[0]; session.acknowledge(undone.eventId); session.undo(undone.eventId);
    for (let frame = 7; frame <= 512; frame++) expect(identify(session, frame, "Saved")).toEqual([]);
    expect(session.queue(view(513))).toBe(true);
    expect(session.snapshot().slice(0, 6).map(receipt => receipt.status)).toEqual(["saved", "error", "queued", "identifying", "saving", "undone"]);
    expect(session.snapshot().some(receipt => receipt.frameId === 7)).toBe(false);
    expect(session.prunedReceiptCount).toBe(1);
    expect(session.retry(failed.eventId)).toEqual(failed);
    expect(session.acknowledge(failed.eventId)).toBe(true);
    expect(session.acknowledge(saving.eventId)).toBe(true);
    expect(session.undo(saved.eventId)).toBe(true);
    for (const [frame, name] of [[514, "Saved"], [515, "Failed"], [516, "Saving"], [517, "Undone"]] as const) expect(identify(session, frame, name)).toEqual([]);
    expect(session.snapshot().filter(receipt => receipt.status === "saved")).toHaveLength(2);
    expect(session.snapshot().filter(receipt => receipt.status === "undone")).toHaveLength(2);
    expect(session.acknowledge(failed.eventId)).toBe(false);
    expect(session.prunedReceiptCount).toBe(5);
  });
  it("keeps the explicit capacity error when all 512 receipts are active or durable", () => {
    const active = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) active.queue(view(frame));
    expect(() => active.queue(view(513))).toThrow("Pack receipt limit reached");
    expect(active.snapshot()).toHaveLength(512); expect(active.prunedReceiptCount).toBe(0);
    const durable = new PackSession("pack");
    for (let frame = 1; frame <= 512; frame++) {
      const intent = identify(durable, frame, `Unique-${frame}`)[0]; durable.acknowledge(intent.eventId);
    }
    expect(() => durable.queue(view(513))).toThrow("Pack receipt limit reached");
    expect(durable.snapshot().filter(receipt => receipt.status === "saved")).toHaveLength(512);
    expect(durable.prunedReceiptCount).toBe(0);
  });

});
