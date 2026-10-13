import { packClock } from "./pack-capture";
import type { PackCaptureIdentity } from "./pack-capture";
import type { PackReceipt } from "./pack-session";
import { createPrintingReader } from "./printing-refinement";
import type {
  PrintingObservation,
  PrintingReader,
  PrintingResolution,
} from "./printing-refinement";
import { validPrintingPixels } from "./printing-regions";
import type { VisionResult } from "./vision";

/** Optional, explicitly opted-in work. None of these limits relax recognition. */
export const PACK_PRINTING_LIMITS = Object.freeze({
  maxCrops: 30,
  cooldownMs: 1500,
  lifetimeMs: 40_000,
  maxWidth: 960,
  maxHeight: 1344,
  maxBytes: 960 * 1344 * 4,
});
export interface PackPrintingUpdate {
  eventId: string;
  receiptId: string;
  status: string;
  resolution?: PrintingResolution;
}
interface Dependencies {
  /** Checks the original saved occurrence, never the current name/camera view. */
  isSaved(receipt: PackReceipt): boolean;
  onUpdate(update: PackPrintingUpdate): void;
  reader?: () => PrintingReader;
  now?: () => number;
}
interface Slot {
  view: PackCaptureIdentity;
  expiresAt: number;
  receipt?: PackReceipt;
  image?: ImageData;
  sourceMinEdge?: number;
  controller: AbortController;
  expiryTimer: ReturnType<typeof setTimeout>;
  startTimer?: ReturnType<typeof setTimeout>;
  reading: boolean;
}

/** A saved Pack receipt owns exactly ONE original observation. There is no
 * name-based event lookup, follow-on live capture, catalog confirmation, or
 * quantity mutation here. A further recapture requires a separate, explicit or
 * proven same-copy association that Pack does not currently provide.
 *
 * One slot covers crop reservation, waiting for durable save, and the reader.
 * Pixels are transient and never emitted/persisted. Limits exclude the reader's
 * bounded temporary copies/model and the primary identity capture queue. */
export class PackPrintingSession {
  private readonly now: () => number;
  private slot?: Slot;
  private reader?: PrintingReader;
  private requests = 0;
  private lastRequest = -Infinity;
  private disposed = false;
  private source?: Pick<
    PackCaptureIdentity,
    "sessionId" | "sourceId" | "generation"
  >;
  private readonly attempted = new Set<string>();
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? packClock;
  }
  get busy() {
    return !!this.slot;
  }
  get retainedBytes() {
    return this.slot?.image?.data.byteLength ?? 0;
  }
  get requestedCrops() {
    return this.requests;
  }
  /** Called immediately before native crop creation by the one identity worker.
   * Reserving, rather than a busy check, closes the pending-analysis race. */
  requestCrop(view: PackCaptureIdentity): boolean {
    const now = this.now();
    if (
      this.disposed ||
      this.slot ||
      this.requests >= PACK_PRINTING_LIMITS.maxCrops ||
      now - this.lastRequest < PACK_PRINTING_LIMITS.cooldownMs ||
      !Number.isFinite(now) ||
      !Number.isFinite(view.capturedAt) ||
      now < view.capturedAt ||
      now >= view.capturedAt + PACK_PRINTING_LIMITS.lifetimeMs ||
      !view.sessionId ||
      !view.sourceId ||
      !view.captureId ||
      view.copyLineage !== "unproven" ||
      (this.source &&
        (view.sessionId !== this.source.sessionId ||
          view.sourceId !== this.source.sourceId ||
          view.generation !== this.source.generation))
    )
      return false;
    this.source ??= {
      sessionId: view.sessionId,
      sourceId: view.sourceId,
      generation: view.generation,
    };
    this.requests++;
    this.lastRequest = now;
    const expiresAt = view.capturedAt + PACK_PRINTING_LIMITS.lifetimeMs;
    const slot: Slot = {
      view: { ...view, sourceFrame: { ...view.sourceFrame } },
      expiresAt,
      controller: new AbortController(),
      reading: false,
      expiryTimer: setTimeout(() => {
        if (this.slot === slot) {
          this.report(
            slot,
            "Retained capture expired. Printing remains unconfirmed.",
          );
          this.release(slot);
        }
      }, expiresAt - now),
    };
    this.slot = slot;
    return true;
  }
  /** Called AFTER the identity save/acknowledgement. Failed saves may wait in the
   * same bounded slot for an explicit retry; no OCR starts before durable Saved. */
  acceptResult(
    view: PackCaptureIdentity,
    result: VisionResult,
    receipt?: PackReceipt,
  ): boolean {
    const slot = this.slot;
    if (
      !slot ||
      slot.image ||
      slot.reading ||
      !this.sameCapture(slot.view, view)
    )
      return false;
    const detection = result.detections[0],
      best = detection?.candidates[0];
    const crop = detection?.printingCrop;
    if (
      !this.current(slot) ||
      !receipt ||
      !this.originalReceipt(slot.view, receipt) ||
      !["saved", "error"].includes(receipt.status) ||
      this.attempted.has(receipt.eventId!) ||
      result.width !== view.width ||
      result.height !== view.height ||
      result.detections.length !== 1 ||
      result.detectionComplete === false ||
      result.budgetExhausted ||
      !detection.autoEligible ||
      detection.deferred ||
      detection.state !== "verified" ||
      !best?.geometricallyVerified ||
      best.reference.key !== receipt.reference!.key ||
      best.reference.game !== receipt.reference!.game ||
      best.reference.name !== receipt.reference!.name ||
      !crop ||
      !validPrintingPixels(crop) ||
      !(crop.data instanceof Uint8ClampedArray) ||
      !(crop.data.buffer instanceof ArrayBuffer) ||
      crop.data.byteOffset !== 0 ||
      crop.data.byteLength !== crop.data.buffer.byteLength ||
      crop.width < 480 ||
      crop.height < 640 ||
      crop.width > PACK_PRINTING_LIMITS.maxWidth ||
      crop.height > PACK_PRINTING_LIMITS.maxHeight ||
      crop.data.byteLength > PACK_PRINTING_LIMITS.maxBytes ||
      !Number.isFinite(detection.printingSourceMinEdge) ||
      detection.printingSourceMinEdge! < 480
    ) {
      if (
        receipt &&
        this.originalReceipt(slot.view, receipt) &&
        receipt.status === "saved" &&
        this.saved(receipt)
      ) {
        slot.receipt = { ...receipt, reference: { ...receipt.reference! } };
        this.report(
          slot,
          "No suitable native crop was retained. Printing remains unconfirmed.",
        );
      }
      this.release(slot);
      return false;
    }
    slot.receipt = { ...receipt, reference: { ...receipt.reference! } };
    slot.image = crop;
    slot.sourceMinEdge = detection.printingSourceMinEdge;
    this.attempted.add(receipt.eventId!);
    if (receipt.status === "saved") this.confirmSaved(receipt);
    else
      this.report(
        slot,
        "Retained capture waits for this identity’s save to succeed.",
      );
    return true;
  }
  /** A retry must acknowledge this precise original receipt, not a same-name copy. */
  confirmSaved(receipt: PackReceipt): boolean {
    const slot = this.slot;
    if (
      !slot?.receipt ||
      !slot.image ||
      slot.reading ||
      slot.startTimer !== undefined ||
      !this.current(slot) ||
      !this.originalReceipt(slot.view, receipt) ||
      receipt.eventId !== slot.receipt.eventId ||
      receipt.status !== "saved" ||
      !this.saved(receipt)
    )
      return false;
    slot.receipt = { ...receipt, reference: { ...receipt.reference! } };
    // Yield to the capture loop's next identity pump. Optional reader work is
    // never awaited by save, onResult, or queue drain.
    slot.startTimer = setTimeout(() => {
      slot.startTimer = undefined;
      void this.read(slot);
    }, 0);
    return true;
  }
  /** Pause/Undo/new session invalidate even pre-analysis reservations. A resumed
   * session keeps cooldown/request/attempt budgets; it cannot re-read old votes. */
  cancel(status = "Printing read cancelled. Printing remains unconfirmed.") {
    if (this.slot) {
      this.report(this.slot, status);
      this.release(this.slot);
    }
    this.reader?.dispose();
    this.reader = undefined;
  }
  dispose() {
    this.cancel();
    this.disposed = true;
  }
  private sameCapture(a: PackCaptureIdentity, b: PackCaptureIdentity) {
    return (
      a.sessionId === b.sessionId &&
      a.sourceId === b.sourceId &&
      a.generation === b.generation &&
      a.captureId === b.captureId &&
      a.frameId === b.frameId &&
      a.capturedAt === b.capturedAt &&
      a.width === b.width &&
      a.height === b.height &&
      a.sourceFrame.presentedFrames === b.sourceFrame.presentedFrames &&
      a.sourceFrame.mediaTime === b.sourceFrame.mediaTime &&
      a.sourceFrame.presentationTime === b.sourceFrame.presentationTime &&
      a.sourceFrame.callbackAt === b.sourceFrame.callbackAt
    );
  }
  private originalReceipt(view: PackCaptureIdentity, receipt: PackReceipt) {
    return (
      this.sameCapture(view, receipt) &&
      receipt.receiptId === view.captureId &&
      !receipt.quantityConfirmation &&
      !!receipt.eventId &&
      !!receipt.reference
    );
  }
  private saved(receipt: PackReceipt) {
    try {
      return this.dependencies.isSaved(receipt);
    } catch {
      return false;
    }
  }
  private current(slot: Slot) {
    return (
      !this.disposed &&
      this.slot === slot &&
      !slot.controller.signal.aborted &&
      this.now() < slot.expiresAt
    );
  }
  private report(slot: Slot, status: string, resolution?: PrintingResolution) {
    if (!slot.receipt?.eventId) return;
    try {
      this.dependencies.onUpdate({
        eventId: slot.receipt.eventId,
        receiptId: slot.receipt.receiptId,
        status,
        ...(resolution ? { resolution } : {}),
      });
    } catch {
      /* Presentation cannot strand optional pixel/worker ownership. */
    }
  }
  private release(slot: Slot) {
    slot.controller.abort();
    clearTimeout(slot.expiryTimer);
    if (slot.startTimer !== undefined) clearTimeout(slot.startTimer);
    slot.image = undefined;
    if (this.slot === slot) {
      this.slot = undefined;
      if (slot.reading) {
        this.reader?.dispose();
        this.reader = undefined;
      }
    }
  }
  private validObservation(slot: Slot, observation: PrintingObservation) {
    const receipt = slot.receipt!;
    return (
      observation.sessionId === receipt.sessionId &&
      observation.eventId === receipt.eventId &&
      observation.frameId === receipt.captureId &&
      observation.capturedAt === receipt.capturedAt &&
      observation.game === receipt.reference!.game &&
      observation.jobId === `${receipt.captureId}:pack-printing` &&
      !!observation.imageFingerprint
    );
  }
  private async read(slot: Slot) {
    const receipt = slot.receipt;
    if (
      !this.current(slot) ||
      !receipt ||
      !slot.image ||
      !this.saved(receipt)
    ) {
      this.release(slot);
      return;
    }
    slot.reading = true;
    try {
      this.reader ??= (this.dependencies.reader ?? createPrintingReader)();
      this.report(
        slot,
        "Reading this saved receipt’s retained capture locally…",
      );
      const observation = await this.reader.read({
        sessionId: receipt.sessionId,
        eventId: receipt.eventId!,
        frameId: receipt.captureId,
        capturedAt: receipt.capturedAt,
        game: receipt.reference!.game,
        jobId: `${receipt.captureId}:pack-printing`,
        image: slot.image,
        sourceMinEdge: slot.sourceMinEdge!,
        signal: slot.controller.signal,
      });
      if (!this.current(slot) || !this.saved(receipt)) return;
      if (!this.validObservation(slot, observation)) {
        this.report(
          slot,
          "Retained read could not be associated with this receipt. Printing remains unconfirmed.",
        );
        return;
      }
      // Deliberately no catalog query or resolution claim. Even a perfect OCR
      // answer from this one original view cannot satisfy the existing resolver.
      this.report(
        slot,
        "One retained capture read. Printing remains unconfirmed.",
        {
          state: "unresolved",
          reasons: [
            "two-distinct-captures-required",
            "same-copy-recapture-not-bound",
            "catalog-not-queried",
          ],
          evidence: [observation],
          finish: "unknown",
          condition: "unknown",
          priceEligible: false,
          unconfirmed: ["language", "edition", "rarity", "finish", "condition"],
        },
      );
    } catch {
      if (this.current(slot) && this.saved(receipt))
        this.report(
          slot,
          "Retained capture could not be read. Printing remains unconfirmed.",
        );
    } finally {
      this.release(slot);
      // No warm OCR worker lives between optional Pack observations.
      if (!this.slot) {
        this.reader?.dispose();
        this.reader = undefined;
      }
    }
  }
}
