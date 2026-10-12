import type { PackCaptureIdentity } from "./pack-capture";
import { packClock } from "./pack-capture";
import { hasGeometricEvidence } from "./vision/scoring";
import type { ReferenceMetadata, VisionResult, VisionTimings } from "./vision/types";

export type PackReceiptStatus = "queued" | "identifying" | "saving" | "saved" | "review" | "duplicate" | "dropped" | "cancelled" | "error" | "undone";
export interface PackReceipt extends PackCaptureIdentity {
  status: PackReceiptStatus;
  reason: string;
  reference?: ReferenceMetadata;
  eventId?: string;
  startedAt?: number;
  completedAt?: number;
  savedAt?: number;
  error?: string;
  /** Processing measurements only, never confidence. */
  timings?: VisionTimings;
}
export interface PackSaveIntent {
  readonly sessionId: string;
  readonly captureId: string;
  readonly capturedAt: number;
  readonly eventId: string;
  readonly reference: ReferenceMetadata;
}
const identity = (reference: ReferenceMetadata) => `${reference.game}:${reference.identityKey || reference.key}`;
const MAX_RECEIPTS = 512;

/** Delayed captured-view receipts, intentionally independent of ScanSession and
 * current-camera overlays. Each accepted view supplies exactly one observation.
 * Repeated identities remain latched: a time gap or A→B→A is not copy proof. */
export class PackSession {
  private receipts = new Map<string, PackReceipt>();
  private identityEvents = new Map<string, string>();
  private intents = new Map<string, PackSaveIntent>();
  private source?: { sourceId: string; generation: number };
  private cancelled = false;
  private pruned = 0;
  constructor(readonly sessionId: string, private readonly now = packClock) {
    if (!sessionId.trim() || sessionId.length > 200) throw new Error("Invalid pack session identifier.");
  }
  queue(view: PackCaptureIdentity): boolean {
    if (this.cancelled || view.sessionId !== this.sessionId || view.copyLineage !== "unproven") return false;
    if (this.source && (view.sourceId !== this.source.sourceId || view.generation !== this.source.generation)) return false;
    if (this.receipts.has(view.captureId)) return false;
    if (this.receipts.size >= MAX_RECEIPTS) {
      // Receipts are a bounded display history. Only completed, non-durable
      // outcomes may leave it; copy latches and durable/retry/undo intents never
      // depend on these records and are never pruned here.
      const oldest = [...this.receipts.values()].find(receipt =>
        ["review", "duplicate", "dropped", "cancelled"].includes(receipt.status),
      );
      if (!oldest) throw new Error("Pack receipt limit reached. Finish this pack before starting another.");
      this.receipts.delete(oldest.captureId); this.pruned++;
    }
    this.source ??= { sourceId: view.sourceId, generation: view.generation };
    this.receipts.set(view.captureId, { ...view, sourceFrame: Object.freeze({ ...view.sourceFrame }), status: "queued", reason: "Captured view queued for local identification" });
    return true;
  }
  identifying(captureId: string, startedAt: number): boolean {
    const receipt = this.receipts.get(captureId);
    if (this.cancelled || !receipt || receipt.status !== "queued" || !Number.isFinite(startedAt) || startedAt < receipt.queuedAt) return false;
    Object.assign(receipt, { status: "identifying", startedAt, reason: "Identifying this captured view; the card may already have left the camera" }); return true;
  }
  consume(captureId: string, result: VisionResult, completedAt: number, autoSave: boolean): PackSaveIntent[] {
    const receipt = this.receipts.get(captureId);
    if (this.cancelled || !receipt || receipt.status !== "identifying" || !Number.isFinite(completedAt) || completedAt < (receipt.startedAt ?? receipt.queuedAt)) return [];
    receipt.completedAt = completedAt; receipt.timings = { ...result.timings };
    const review = (reason: string): PackSaveIntent[] => { receipt.status = "review"; receipt.reason = reason; return []; };
    if (result.width !== receipt.width || result.height !== receipt.height || result.detectionComplete === false || result.budgetExhausted) return review("Captured view was not completely verified; show the card again");
    // Pack runs one whole-frame proposal. A malformed multi-region response is
    // never silently reduced to whichever identity happened to be strongest.
    if (result.detections.length !== 1) return review("No single card identity was verified in this captured view");
    const detection = result.detections[0], best = detection.candidates[0];
    if (detection.deferred || !detection.autoEligible || detection.state !== "verified" || detection.quality.issues.length || !best?.geometricallyVerified || !hasGeometricEvidence(best) || !best.reference.key || !best.reference.game || !best.reference.name)
      return review(detection.reason || "Not enough clear card detail; show this card again");
    receipt.reference = { ...best.reference };
    const key = identity(best.reference), existing = this.identityEvents.get(key);
    if (existing) {
      receipt.status = "duplicate"; receipt.eventId = existing;
      const original = this.intents.get(existing), prior = original && this.receipts.get(original.captureId);
      receipt.reason = prior?.status === "saved"
        ? "Identity already saved in this pack. A separate physical copy is unconfirmed."
        : prior?.status === "undone"
          ? "This identity was undone and remains excluded for this pack."
          : prior?.status === "error"
            ? "This identity has an earlier failed save. Retry that original receipt; a separate copy is unconfirmed."
            : "This identity has an earlier pending save. A separate physical copy is unconfirmed.";
      return [];
    }
    if (!autoSave) return review("Identity verified from the captured view. Auto-save was off; nothing was saved.");
    const eventId = `${this.sessionId}:pack:${receipt.frameId}`;
    const intent: PackSaveIntent = Object.freeze({ sessionId: this.sessionId, captureId, capturedAt: receipt.capturedAt, eventId, reference: Object.freeze({ ...best.reference }) });
    this.identityEvents.set(key, eventId); this.intents.set(eventId, intent);
    receipt.eventId = eventId; receipt.status = "saving"; receipt.reason = "Saving this captured card identity locally";
    return [intent];
  }
  acknowledge(eventId: string, error?: string): boolean {
    const intent = this.intents.get(eventId), receipt = intent && this.receipts.get(intent.captureId);
    if (this.cancelled || !receipt || receipt.status !== "saving" || receipt.eventId !== eventId) return false;
    if (error) { receipt.status = "error"; receipt.error = error; receipt.reason = error; }
    else { receipt.status = "saved"; receipt.savedAt = this.now(); receipt.error = undefined; receipt.reason = "Saved from this captured view. Printing, finish and condition remain unconfirmed."; }
    return true;
  }
  retry(eventId: string): PackSaveIntent | undefined {
    const intent = this.intents.get(eventId), receipt = intent && this.receipts.get(intent.captureId);
    if (this.cancelled || !intent || !receipt || receipt.status !== "error") return;
    receipt.status = "saving"; receipt.error = undefined; receipt.reason = "Retrying the same local save";
    return { ...intent, reference: { ...intent.reference } };
  }
  /** Call only after the durable collection undo succeeded. Keep the identity
   * latch so a lingering/re-entering card cannot silently recreate the event. */
  undo(eventId: string): boolean {
    const intent = this.intents.get(eventId), receipt = intent && this.receipts.get(intent.captureId);
    if (!receipt || receipt.status !== "saved") return false;
    receipt.status = "undone"; receipt.reason = "Undone; this identity stays excluded for this pack"; return true;
  }
  drop(captureId: string, reason: string): boolean {
    const receipt = this.receipts.get(captureId);
    if (!receipt || receipt.status !== "queued") return false;
    receipt.status = "dropped"; receipt.reason = reason; return true;
  }
  cancel(): void {
    this.cancelled = true;
    for (const receipt of this.receipts.values()) if (["queued", "identifying", "saving", "error"].includes(receipt.status)) {
      receipt.status = "cancelled"; receipt.reason = "Stopped; this pending view will not be saved";
    }
  }
  /** Number of old terminal non-durable receipts omitted from display history. */
  get prunedReceiptCount(): number { return this.pruned; }
  snapshot(): PackReceipt[] {
    return [...this.receipts.values()].map(receipt => ({ ...receipt, ...(receipt.reference ? { reference: { ...receipt.reference } } : {}), ...(receipt.timings ? { timings: { ...receipt.timings } } : {}) }));
  }
}
