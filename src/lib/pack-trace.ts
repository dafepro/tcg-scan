/** Opt-in local diagnostics, not recognition evidence. No images, free text,
 * identity names/keys, source IDs, URLs or collection data enter this store. */
export const PACK_TRACE_MAX_RECORDS = 2048;
export const PACK_TRACE_MAX_BYTES = 512 * 1024;
// Reserve every record's full future lifecycle before admitting it. Fixed-shape
// records have only bounded numbers and closed enums; updates cannot steal space
// from earlier acquisitions. Includes JSON punctuation and worst numeric widths.
const RECORD_RESERVE_BYTES = 768;
const ENVELOPE_RESERVE_BYTES = 8192;
export const PACK_TRACE_EFFECTIVE_RECORDS = Math.min(
  PACK_TRACE_MAX_RECORDS,
  Math.floor(
    (PACK_TRACE_MAX_BYTES - ENVELOPE_RESERVE_BYTES) / RECORD_RESERVE_BYTES,
  ),
);
const MAX = Number.MAX_SAFE_INTEGER;
export type PackTraceSchedule =
  | "captured"
  | "reservoir"
  | "admitted"
  | "visual-skip"
  | "reservoir-replaced"
  | "reservoir-rejected"
  | "similar-view"
  | "better-view-retained"
  | "replaced-by-clearer-view"
  | "queue-overflow"
  | "closed"
  | "cancelled";
export type PackTraceReason =
  | "pending"
  | "verified"
  | "incomplete-verification"
  | "detection-count"
  | "deferred"
  | "quality-issues"
  | "ambiguous-identity"
  | "no-candidate"
  | "geometry-unverified"
  | "geometry-gate"
  | "ineligible"
  | "unverified-state"
  | "missing-reference"
  | "explicit-copy"
  | "cancelled"
  | "worker-error";
export type PackTraceSave =
  | "none"
  | "pending"
  | "saved"
  | "failed"
  | "undone"
  | "cancelled"
  | "duplicate"
  | "preview-only";
export type PackTraceState =
  "active" | "paused" | "draining" | "drained" | "cancelled";
const schedules: readonly PackTraceSchedule[] = [
  "captured",
  "reservoir",
  "admitted",
  "visual-skip",
  "reservoir-replaced",
  "reservoir-rejected",
  "similar-view",
  "better-view-retained",
  "replaced-by-clearer-view",
  "queue-overflow",
  "closed",
  "cancelled",
];
const reasons: readonly PackTraceReason[] = [
  "pending",
  "verified",
  "incomplete-verification",
  "detection-count",
  "deferred",
  "quality-issues",
  "ambiguous-identity",
  "no-candidate",
  "geometry-unverified",
  "geometry-gate",
  "ineligible",
  "unverified-state",
  "missing-reference",
  "explicit-copy",
  "cancelled",
  "worker-error",
];
const saves: readonly PackTraceSave[] = [
  "none",
  "pending",
  "saved",
  "failed",
  "undone",
  "cancelled",
  "duplicate",
  "preview-only",
];
export interface PackTraceRecord {
  id: number;
  kind: "view" | "explicit-copy";
  sourceMediaSeconds: number | null;
  sourceFrame: number | null;
  capturedMs: number | null;
  deferredMs: number | null;
  admittedMs: number | null;
  startedMs: number | null;
  processedMs: number | null;
  decidedMs: number | null;
  endedMs: number | null;
  savedMs: number | null;
  undoneMs: number | null;
  receiptFrame: number | null;
  sourceView: number | null;
  eventView: number | null;
  schedule: PackTraceSchedule;
  matcher:
    "pending" | "accepted" | "rejected" | "cancelled" | "error" | "not-run";
  reason: PackTraceReason;
  save: PackTraceSave;
  saveAttempts: number;
}
const increment = (value: number) => Math.min(MAX, value + 1);
const numeric = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX
    ? value
    : null;
const ordinal = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

/** Failure isolation for optional observers. Never let diagnostics change the
 * capture scheduler, matcher acceptance, physical counting or durable writes. */
export function observePackTrace<T>(
  trace: PackTrace | undefined | null,
  observe: (trace: PackTrace) => T,
): T | undefined {
  if (!trace) return;
  try {
    return observe(trace);
  } catch {
    try {
      trace.noteFailure();
    } catch {
      /* Observer failure stays isolated. */
    }
    return;
  }
}
export class PackTrace {
  private records = new Map<number, PackTraceRecord>();
  private sequence = 0;
  private origin: number | null = null;
  private state: PackTraceState = "active";
  private counters = {
    captured: 0,
    explicitCopies: 0,
    admitted: 0,
    reservoir: 0,
    replaced: 0,
    visualSkipped: 0,
    schedulingRejected: 0,
    processed: 0,
    matcherAccepted: 0,
    matcherRejected: 0,
    cancelled: 0,
    saveSucceeded: 0,
    saveFailed: 0,
    undoSucceeded: 0,
    retries: 0,
    pauses: 0,
    resumes: 0,
    overflowRecords: 0,
    recordLimitOverflows: 0,
    byteLimitOverflows: 0,
    unretainedUpdates: 0,
    truncatedUpdates: 0,
    invalidMetadata: 0,
    observerErrors: 0,
  };
  constructor(
    private readonly limits = {
      maxRecords: PACK_TRACE_MAX_RECORDS,
      maxBytes: PACK_TRACE_MAX_BYTES,
    },
  ) {
    if (
      !Number.isInteger(limits.maxRecords) ||
      limits.maxRecords < 1 ||
      limits.maxRecords > PACK_TRACE_MAX_RECORDS ||
      !Number.isInteger(limits.maxBytes) ||
      limits.maxBytes < ENVELOPE_RESERVE_BYTES + RECORD_RESERVE_BYTES ||
      limits.maxBytes > PACK_TRACE_MAX_BYTES
    )
      throw new Error("Invalid bounded trace limits.");
    this.limits = { maxRecords: limits.maxRecords, maxBytes: limits.maxBytes };
  }
  noteFailure(): void {
    this.counters.observerErrors = increment(this.counters.observerErrors);
  }
  private ms(at: number): number | null {
    const valid = numeric(at);
    if (valid === null) {
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
      return null;
    }
    this.origin ??= valid;
    const elapsed = numeric(valid - this.origin);
    if (elapsed === null)
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
    return elapsed;
  }
  private insert(record: PackTraceRecord): number {
    const recordLimit = this.records.size >= this.limits.maxRecords;
    const byteLimit =
      ENVELOPE_RESERVE_BYTES + (this.records.size + 1) * RECORD_RESERVE_BYTES >
      this.limits.maxBytes;
    if (recordLimit || byteLimit) {
      this.counters.overflowRecords = increment(this.counters.overflowRecords);
      if (recordLimit)
        this.counters.recordLimitOverflows = increment(
          this.counters.recordLimitOverflows,
        );
      if (byteLimit)
        this.counters.byteLimitOverflows = increment(
          this.counters.byteLimitOverflows,
        );
    } else this.records.set(record.id, record);
    return record.id;
  }
  private update(
    id: number | undefined,
    change: (record: PackTraceRecord) => void,
  ): void {
    if (id === undefined) return;
    const record = this.records.get(id);
    if (!record) {
      this.counters.unretainedUpdates = increment(
        this.counters.unretainedUpdates,
      );
      return;
    }
    const candidate = { ...record };
    change(candidate);
    // All keys/strings are ASCII closed enums, hence JS length equals UTF-8 bytes.
    if (JSON.stringify(candidate).length + 1 > RECORD_RESERVE_BYTES) {
      this.counters.truncatedUpdates = increment(
        this.counters.truncatedUpdates,
      );
      return;
    }
    this.records.set(id, candidate);
  }
  capture(mediaTime: number, sourceFrame: number, capturedAt: number): number {
    this.counters.captured = increment(this.counters.captured);
    const id = (this.sequence = increment(this.sequence));
    const sourceMediaSeconds = numeric(mediaTime),
      frame = ordinal(sourceFrame);
    if (sourceMediaSeconds === null || frame === null)
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
    return this.insert({
      id,
      kind: "view",
      sourceMediaSeconds,
      sourceFrame: frame,
      capturedMs: this.ms(capturedAt),
      deferredMs: null,
      admittedMs: null,
      startedMs: null,
      processedMs: null,
      decidedMs: null,
      endedMs: null,
      savedMs: null,
      undoneMs: null,
      receiptFrame: null,
      sourceView: null,
      eventView: null,
      schedule: "captured",
      matcher: "pending",
      reason: "pending",
      save: "none",
      saveAttempts: 0,
    });
  }
  schedule(
    id: number | undefined,
    stage: PackTraceSchedule,
    at: number,
    receiptFrame?: number,
  ): void {
    if (!schedules.includes(stage)) {
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
      return;
    }
    if (stage === "admitted")
      this.counters.admitted = increment(this.counters.admitted);
    else if (stage === "reservoir")
      this.counters.reservoir = increment(this.counters.reservoir);
    else if (stage === "reservoir-replaced")
      this.counters.replaced = increment(this.counters.replaced);
    else if (stage === "visual-skip")
      this.counters.visualSkipped = increment(this.counters.visualSkipped);
    else if (stage === "cancelled")
      this.counters.cancelled = increment(this.counters.cancelled);
    else if (stage !== "captured")
      this.counters.schedulingRejected = increment(
        this.counters.schedulingRejected,
      );
    this.update(id, (r) => {
      r.schedule = stage;
      if (stage === "reservoir") r.deferredMs = this.ms(at);
      if (stage === "admitted") {
        r.admittedMs = this.ms(at);
        r.receiptFrame = ordinal(receiptFrame);
      } else if (stage !== "reservoir" && stage !== "captured") {
        r.endedMs = this.ms(at);
        if (r.matcher === "pending") {
          r.matcher = stage === "cancelled" ? "cancelled" : "not-run";
          r.reason = stage === "cancelled" ? "cancelled" : "pending";
        }
      }
    });
  }
  started(id: number | undefined, at: number): void {
    this.update(id, (r) => {
      r.startedMs = this.ms(at);
    });
  }
  processed(id: number | undefined, at: number): void {
    this.counters.processed = increment(this.counters.processed);
    this.update(id, (r) => {
      r.processedMs = this.ms(at);
    });
  }
  decision(
    id: number | undefined,
    accepted: boolean,
    reason: PackTraceReason,
    at: number,
  ): void {
    if (!reasons.includes(reason) || typeof accepted !== "boolean") {
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
      return;
    }
    if (accepted)
      this.counters.matcherAccepted = increment(this.counters.matcherAccepted);
    else
      this.counters.matcherRejected = increment(this.counters.matcherRejected);
    this.update(id, (r) => {
      r.matcher = accepted ? "accepted" : "rejected";
      r.reason = reason;
      r.decidedMs = this.ms(at);
    });
  }
  save(
    id: number | undefined,
    state: PackTraceSave,
    at: number,
    eventView?: number,
  ): void {
    if (!saves.includes(state)) {
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
      return;
    }
    if (state === "saved")
      this.counters.saveSucceeded = increment(this.counters.saveSucceeded);
    if (state === "failed")
      this.counters.saveFailed = increment(this.counters.saveFailed);
    if (state === "undone")
      this.counters.undoSucceeded = increment(this.counters.undoSucceeded);
    this.update(id, (r) => {
      r.save = state;
      if (eventView !== undefined) r.eventView = ordinal(eventView);
      if (state === "pending") {
        if (r.saveAttempts)
          this.counters.retries = increment(this.counters.retries);
        r.saveAttempts = increment(r.saveAttempts);
      }
      if (state === "saved") r.savedMs = this.ms(at);
      if (state === "undone") r.undoneMs = this.ms(at);
    });
  }
  copy(sourceView: number | undefined, at: number): number {
    this.counters.explicitCopies = increment(this.counters.explicitCopies);
    const id = (this.sequence = increment(this.sequence));
    return this.insert({
      id,
      kind: "explicit-copy",
      sourceMediaSeconds: null,
      sourceFrame: null,
      capturedMs: null,
      deferredMs: null,
      admittedMs: null,
      startedMs: null,
      processedMs: null,
      decidedMs: this.ms(at),
      endedMs: null,
      savedMs: null,
      undoneMs: null,
      receiptFrame: null,
      sourceView: ordinal(sourceView),
      eventView: id,
      schedule: "captured",
      matcher: "not-run",
      reason: "explicit-copy",
      save: "pending",
      saveAttempts: 1,
    });
  }
  control(state: PackTraceState): void {
    if (
      !["active", "paused", "draining", "drained", "cancelled"].includes(state)
    ) {
      this.counters.invalidMetadata = increment(this.counters.invalidMetadata);
      return;
    }
    if (state === "paused" && this.state !== "paused")
      this.counters.pauses = increment(this.counters.pauses);
    if (state === "active" && this.state === "paused")
      this.counters.resumes = increment(this.counters.resumes);
    this.state = state;
  }
  cancelResult(id: number | undefined, at: number): void {
    this.update(id, (r) => {
      if (r.matcher === "pending") {
        r.matcher = "cancelled";
        r.reason = "cancelled";
      }
      if (r.save === "pending" || r.save === "failed") r.save = "cancelled";
      r.endedMs = this.ms(at);
    });
  }
  workerError(id: number | undefined, at: number): void {
    this.update(id, (r) => {
      r.matcher = "error";
      r.reason = "worker-error";
      r.endedMs = this.ms(at);
    });
  }
  snapshot() {
    return {
      format: "tcg-pack-local-trace-v1" as const,
      scope:
        "Valid native acquisitions presented to the Pack queue; expired or late pre-admission acquisitions are excluded. Times in ms are relative to the first retained acquisition; sourceMediaSeconds is the native media clock. Event links are diagnostic record IDs, not collection IDs." as const,
      state: this.state,
      complete:
        !this.counters.overflowRecords &&
        !this.counters.unretainedUpdates &&
        !this.counters.truncatedUpdates &&
        !this.counters.invalidMetadata &&
        !this.counters.observerErrors,
      limits: {
        ...this.limits,
        effectiveMaxRecords: Math.min(
          this.limits.maxRecords,
          Math.floor(
            (this.limits.maxBytes - ENVELOPE_RESERVE_BYTES) /
              RECORD_RESERVE_BYTES,
          ),
        ),
        recordReserveBytes: RECORD_RESERVE_BYTES,
        envelopeReserveBytes: ENVELOPE_RESERVE_BYTES,
      },
      counters: { ...this.counters },
      records: [...this.records.values()].map((r) => ({ ...r })),
    };
  }
  exportJson(): string {
    const json = JSON.stringify(this.snapshot());
    if (json.length > this.limits.maxBytes) {
      this.noteFailure();
      throw new Error("Trace export exceeded its local byte limit.");
    }
    return json;
  }
}
export type PackTraceSnapshot = ReturnType<PackTrace["snapshot"]>;

/** Classification of the already-rejected production result. It cannot approve
 * a match, and deliberately never copies detection.reason or quality text. */
export function packTraceRejection(
  detection: import("./vision/types").CardDetection,
): PackTraceReason {
  const best = detection.candidates[0];
  if (detection.deferred) return "deferred";
  if (detection.quality.issues.length) return "quality-issues";
  if (detection.state === "ambiguous") return "ambiguous-identity";
  if (!best) return "no-candidate";
  if (!best.geometricallyVerified) return "geometry-unverified";
  if (!detection.autoEligible) return "ineligible";
  if (detection.state !== "verified") return "unverified-state";
  if (!best.reference.key || !best.reference.game || !best.reference.name)
    return "missing-reference";
  return "geometry-gate";
}

export function createPackTrace(
  enabled: boolean,
  factory: () => PackTrace = () => new PackTrace(),
): { trace?: PackTrace; failed: boolean } {
  if (!enabled) return { failed: false };
  try {
    return { trace: factory(), failed: false };
  } catch {
    return { failed: true };
  }
}
