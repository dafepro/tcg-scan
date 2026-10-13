import {
  observePackTrace,
  packTraceRejection,
  type PackTrace,
  type PackTraceReason,
} from "./pack-trace";
import type { PackCaptureIdentity } from "./pack-capture";
import { packClock } from "./pack-capture";
import { hasGeometricEvidence } from "./vision/scoring";
import type {
  ReferenceMetadata,
  VisionResult,
  VisionTimings,
} from "./vision/types";

export type PackReceiptStatus =
  | "queued"
  | "identifying"
  | "saving"
  | "saved"
  | "review"
  | "duplicate"
  | "dropped"
  | "cancelled"
  | "error"
  | "undone";
/** An explicit quantity assertion by the user, never fresh visual evidence. */
export interface PackQuantityConfirmation {
  readonly operationId: string;
  readonly sourceReceiptId: string;
  readonly confirmedAt: number;
}
export interface PackReceipt extends PackCaptureIdentity {
  /** Unique display/save record; captureId always retains native-frame provenance. */
  readonly receiptId: string;
  readonly quantityConfirmation?: PackQuantityConfirmation;
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
  readonly receiptId: string;
  readonly captureId: string;
  readonly capturedAt: number;
  readonly eventId: string;
  readonly reference: ReferenceMetadata;
  readonly quantityConfirmation?: PackQuantityConfirmation;
}
const identity = (reference: ReferenceMetadata) =>
  `${reference.game}:${reference.identityKey || reference.key}`;
const MAX_RECEIPTS = 512;
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const validTimestamp = (value: number, notBefore: number) =>
  Number.isFinite(value) &&
  value >= notBefore &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

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
  constructor(
    readonly sessionId: string,
    private readonly now = packClock,
    private readonly trace?: PackTrace,
  ) {
    if (!sessionId.trim() || sessionId.length > 200)
      throw new Error("Invalid pack session identifier.");
  }
  private reserveReceipt(): void {
    if (this.receipts.size >= MAX_RECEIPTS) {
      // Receipts are a bounded display history. Only completed, non-durable
      // outcomes may leave it. Even a cancelled automatic save keeps its owned
      // intent/receipt, so every retained intent and latch has a bounded record.
      const oldest = [...this.receipts.values()].find(
        (receipt) =>
          ["review", "duplicate", "dropped", "cancelled"].includes(
            receipt.status,
          ) &&
          (!receipt.eventId ||
            this.intents.get(receipt.eventId)?.receiptId !== receipt.receiptId),
      );
      if (!oldest)
        throw new Error(
          "Pack receipt limit reached. Finish this pack before starting another.",
        );
      this.receipts.delete(oldest.receiptId);
      this.pruned++;
    }
  }
  queue(view: PackCaptureIdentity): boolean {
    if (
      this.cancelled ||
      view.sessionId !== this.sessionId ||
      view.copyLineage !== "unproven"
    )
      return false;
    if (
      this.source &&
      (view.sourceId !== this.source.sourceId ||
        view.generation !== this.source.generation)
    )
      return false;
    if (this.receipts.has(view.captureId)) return false;
    this.reserveReceipt();
    this.source ??= { sourceId: view.sourceId, generation: view.generation };
    this.receipts.set(view.captureId, {
      ...view,
      receiptId: view.captureId,
      sourceFrame: Object.freeze({ ...view.sourceFrame }),
      status: "queued",
      reason: "Captured view queued for local identification",
    });
    return true;
  }
  identifying(captureId: string, startedAt: number): boolean {
    const receipt = this.receipts.get(captureId);
    if (
      this.cancelled ||
      !receipt ||
      receipt.status !== "queued" ||
      !Number.isFinite(startedAt) ||
      startedAt < receipt.queuedAt
    )
      return false;
    Object.assign(receipt, {
      status: "identifying",
      startedAt,
      reason:
        "Identifying this captured view; the card may already have left the camera",
    });
    return true;
  }
  consume(
    captureId: string,
    result: VisionResult,
    completedAt: number,
    autoSave: boolean,
  ): PackSaveIntent[] {
    const receipt = this.receipts.get(captureId);
    if (
      this.cancelled ||
      !receipt ||
      receipt.status !== "identifying" ||
      !Number.isFinite(completedAt) ||
      completedAt < (receipt.startedAt ?? receipt.queuedAt)
    )
      return [];
    receipt.completedAt = completedAt;
    receipt.timings = { ...result.timings };
    const review = (
      reason: string,
      traceReason?: PackTraceReason,
    ): PackSaveIntent[] => {
      if (traceReason)
        observePackTrace(this.trace, (trace) =>
          trace.decision(receipt.traceViewId, false, traceReason, this.now()),
        );
      receipt.status = "review";
      receipt.reason = reason;
      return [];
    };
    if (
      result.width !== receipt.width ||
      result.height !== receipt.height ||
      result.detectionComplete === false ||
      result.budgetExhausted
    )
      return review(
        "Captured view was not completely verified; show the card again",
        "incomplete-verification",
      );
    // Pack runs one whole-frame proposal. A malformed multi-region response is
    // never silently reduced to whichever identity happened to be strongest.
    if (result.detections.length !== 1)
      return review(
        "No single card identity was verified in this captured view",
        "detection-count",
      );
    const detection = result.detections[0],
      best = detection.candidates[0];
    if (
      detection.deferred ||
      !detection.autoEligible ||
      detection.state !== "verified" ||
      detection.quality.issues.length ||
      !best?.geometricallyVerified ||
      !hasGeometricEvidence(best) ||
      !best.reference.key ||
      !best.reference.game ||
      !best.reference.name
    )
      return review(
        detection.reason ||
          "Not enough clear card detail; show this card again",
        observePackTrace(this.trace, () => packTraceRejection(detection)),
      );
    observePackTrace(this.trace, (trace) =>
      trace.decision(receipt.traceViewId, true, "verified", this.now()),
    );
    receipt.reference = { ...best.reference };
    const key = identity(best.reference),
      existing = this.identityEvents.get(key);
    if (existing) {
      receipt.status = "duplicate";
      receipt.eventId = existing;
      const original = this.intents.get(existing),
        prior = original && this.receipts.get(original.receiptId);
      observePackTrace(this.trace, (trace) =>
        trace.save(
          receipt.traceViewId,
          "duplicate",
          this.now(),
          prior?.traceViewId,
        ),
      );
      receipt.reason =
        prior?.status === "saved"
          ? "Identity already saved in this pack. A separate physical copy is unconfirmed."
          : prior?.status === "undone"
            ? "This identity was undone and remains excluded for this pack."
            : prior?.status === "error"
              ? "This identity has an earlier failed save. Retry that original receipt; a separate copy is unconfirmed."
              : "This identity has an earlier pending save. A separate physical copy is unconfirmed.";
      return [];
    }
    if (!autoSave) {
      observePackTrace(this.trace, (trace) =>
        trace.save(receipt.traceViewId, "preview-only", this.now()),
      );
      return review(
        "Identity verified from the captured view. Auto-save was off; nothing was saved.",
      );
    }
    const eventId = `${this.sessionId}:pack:${receipt.frameId}`;
    const intent: PackSaveIntent = Object.freeze({
      sessionId: this.sessionId,
      receiptId: receipt.receiptId,
      captureId,
      capturedAt: receipt.capturedAt,
      eventId,
      reference: Object.freeze({ ...best.reference }),
    });
    this.identityEvents.set(key, eventId);
    this.intents.set(eventId, intent);
    receipt.eventId = eventId;
    receipt.status = "saving";
    receipt.reason = "Saving this captured card identity locally";
    observePackTrace(this.trace, (trace) =>
      trace.save(
        receipt.traceViewId,
        "pending",
        this.now(),
        receipt.traceViewId,
      ),
    );
    return [intent];
  }
  /** Explicitly confirm exactly one more physical copy of a saved receipt.
   * The caller must retain a stable operation ID across repeated delivery. An
   * existing ID never issues another write, even after failure or Undo; retry
   * failures only through retry(eventId). Invalid inputs/states return nothing;
   * exhausting durable history throws the same bounded-capacity error as queue.
   *
   * This user action remains available after normal drain, Pause, or Stop.
   * It does not resume the capture lifecycle or authorize cancelled callbacks.
   * Neither automatic identity latches nor printing/finish/condition change. */
  confirmAnotherCopy(
    sourceReceiptId: string,
    operationId: string,
  ): PackSaveIntent | undefined {
    if (
      typeof sourceReceiptId !== "string" ||
      typeof operationId !== "string" ||
      operationId !== operationId.trim() ||
      !OPERATION_ID.test(operationId)
    )
      return;
    const source = this.receipts.get(sourceReceiptId);
    if (
      !source ||
      source.sessionId !== this.sessionId ||
      source.status !== "saved" ||
      !source.reference ||
      !source.eventId
    )
      return;
    const sourceIntent = this.intents.get(source.eventId);
    if (
      !sourceIntent ||
      sourceIntent.receiptId !== sourceReceiptId ||
      sourceIntent.sessionId !== this.sessionId
    )
      return;
    const receiptId = `${this.sessionId}:confirmed-copy:${operationId}`;
    const eventId = `${this.sessionId}:pack:confirmed-copy:${operationId}`;
    if (this.intents.has(eventId) || this.receipts.has(receiptId)) return;
    const confirmedAt = this.now();
    if (!validTimestamp(confirmedAt, source.savedAt ?? source.capturedAt))
      return;
    this.reserveReceipt();
    const quantityConfirmation = Object.freeze({
      operationId,
      sourceReceiptId,
      confirmedAt,
    });
    const reference = Object.freeze({ ...sourceIntent.reference });
    const intent: PackSaveIntent = Object.freeze({
      sessionId: this.sessionId,
      receiptId,
      captureId: source.captureId,
      capturedAt: source.capturedAt,
      eventId,
      reference,
      quantityConfirmation,
    });
    const traceViewId = observePackTrace(this.trace, (trace) =>
      trace.copy(source.traceViewId, confirmedAt),
    );
    // Copy only actual acquisition provenance. Processing/saved timestamps and
    // timings belong to the original observation and must not look newly seen.
    this.receipts.set(receiptId, {
      sessionId: source.sessionId,
      sourceId: source.sourceId,
      generation: source.generation,
      captureId: source.captureId,
      frameId: source.frameId,
      capturedAt: source.capturedAt,
      sourceFrame: Object.freeze({ ...source.sourceFrame }),
      trackId: source.trackId,
      copyLineage: source.copyLineage,
      width: source.width,
      height: source.height,
      queuedAt: source.queuedAt,
      qualityScore: source.qualityScore,
      ...(traceViewId === undefined ? {} : { traceViewId }),
      receiptId,
      quantityConfirmation,
      reference: { ...reference },
      eventId,
      status: "saving",
      reason:
        "Saving one extra copy you confirmed; no new captured card was observed",
    });
    this.intents.set(eventId, intent);
    return intent;
  }
  acknowledge(eventId: string, error?: string): boolean {
    const intent = this.intents.get(eventId),
      receipt = intent && this.receipts.get(intent.receiptId);
    if (
      !intent ||
      (this.cancelled && !intent.quantityConfirmation) ||
      !receipt ||
      receipt.status !== "saving" ||
      receipt.eventId !== eventId
    )
      return false;
    if (error) {
      receipt.status = "error";
      receipt.error = error;
      receipt.reason = error;
      observePackTrace(this.trace, (trace) =>
        trace.save(receipt.traceViewId, "failed", this.now()),
      );
    } else {
      const savedAt = this.now();
      if (
        !validTimestamp(
          savedAt,
          intent.quantityConfirmation?.confirmedAt ?? receipt.capturedAt,
        )
      )
        return false;
      receipt.status = "saved";
      receipt.savedAt = savedAt;
      observePackTrace(this.trace, (trace) =>
        trace.save(receipt.traceViewId, "saved", savedAt),
      );
      receipt.error = undefined;
      receipt.reason = intent.quantityConfirmation
        ? "Saved one extra copy you confirmed. Printing, finish and condition remain unconfirmed."
        : "Saved from this captured view. Printing, finish and condition remain unconfirmed.";
    }
    return true;
  }
  retry(eventId: string): PackSaveIntent | undefined {
    const intent = this.intents.get(eventId),
      receipt = intent && this.receipts.get(intent.receiptId);
    if (
      !intent ||
      (this.cancelled && !intent.quantityConfirmation) ||
      !receipt ||
      receipt.status !== "error"
    )
      return;
    receipt.status = "saving";
    receipt.error = undefined;
    receipt.reason = "Retrying the same local save";
    observePackTrace(this.trace, (trace) =>
      trace.save(receipt.traceViewId, "pending", this.now()),
    );
    return intent;
  }
  /** Call only after the durable collection undo succeeded. Keep the identity
   * latch so a lingering/re-entering card cannot silently recreate the event. */
  undo(eventId: string): boolean {
    const intent = this.intents.get(eventId),
      receipt = intent && this.receipts.get(intent.receiptId);
    if (!intent || !receipt || receipt.status !== "saved") return false;
    receipt.status = "undone";
    observePackTrace(this.trace, (trace) =>
      trace.save(receipt.traceViewId, "undone", this.now()),
    );
    receipt.reason = intent.quantityConfirmation
      ? "Undone this extra copy; automatic identity counting remains unchanged"
      : "Undone; this identity stays excluded for this pack";
    return true;
  }
  drop(captureId: string, reason: string): boolean {
    const receipt = this.receipts.get(captureId);
    if (!receipt || receipt.status !== "queued") return false;
    receipt.status = "dropped";
    receipt.reason = reason;
    return true;
  }
  cancel(): void {
    this.cancelled = true;
    for (const receipt of this.receipts.values())
      if (
        !receipt.quantityConfirmation &&
        ["queued", "identifying", "saving", "error"].includes(receipt.status)
      ) {
        receipt.status = "cancelled";
        observePackTrace(this.trace, (trace) =>
          trace.cancelResult(receipt.traceViewId, this.now()),
        );
        receipt.reason = "Stopped; this pending view will not be saved";
      }
  }
  /** Number of old terminal non-durable receipts omitted from display history. */
  get prunedReceiptCount(): number {
    return this.pruned;
  }
  snapshot(): PackReceipt[] {
    return [...this.receipts.values()].map((receipt) => ({
      ...receipt,
      ...(receipt.reference ? { reference: { ...receipt.reference } } : {}),
      ...(receipt.timings ? { timings: { ...receipt.timings } } : {}),
      ...(receipt.quantityConfirmation
        ? {
            quantityConfirmation: Object.freeze({
              ...receipt.quantityConfirmation,
            }),
          }
        : {}),
    }));
  }
}
