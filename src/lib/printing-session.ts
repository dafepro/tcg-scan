import {
  planPrintingLiteralGuidance,
  PRINTING_LITERAL_GUIDANCE_LIMITS,
} from "./printing-literal-guidance";
import type { ReferenceMetadata } from "./vision/types";
import type { PrintingCatalogProvenance } from "./printing-evidence";
import {
  createPrintingReader,
  printingCandidateRelation,
  resolvePrintingEvidence,
} from "./printing-refinement";
import type {
  PrintingCandidate,
  PrintingObservation,
  PrintingReader,
  PrintingResolution,
} from "./printing-refinement";

export interface PrintingCatalogResult {
  candidates: PrintingCandidate[];
  catalogCompleteForIdentity: boolean;
  scope: string;
  provenance?: PrintingCatalogProvenance;
  error?: string;
}
export interface PrintingFrame {
  sessionId: string;
  eventId: string;
  frameId: string;
  capturedAt: number;
  reference: ReferenceMetadata;
  image: ImageData;
  sourceMinEdge: number;
}
interface EventState {
  observations: PrintingObservation[];
  attempts: number;
  lastAttempt: number;
  done: boolean;
  confirmationDeadline?: number;
}
interface ConfirmationBudget {
  firstOfferedAt: number;
  candidateSeen: boolean;
  granted: boolean;
  blocked: boolean;
}
const CONFIRMATION_LIMITS = Object.freeze({
  rememberedEvents: 2500,
  occurrenceMs: 90_000,
  afterGrantMs: 20_000,
});
interface Dependencies {
  /** Monotonic elapsed time, independent of media capture timestamps. */
  now?(): number;
  catalog(
    reference: ReferenceMetadata,
    options: { signal: AbortSignal },
  ): Promise<PrintingCatalogResult>;
  reader?: () => PrintingReader;
  isCurrent(frame: PrintingFrame): boolean;
  onStatus(eventId: string, status: string): void;
  /** Announces the one actionable camera request, never routine reader progress. */
  onGuidance?(eventId: string, message: string): void;
  /** Bounded unresolved reasons and native region measurements, including reads
   * that do not qualify for onResolution. Reporting cannot affect acceptance. */
  onDiagnostics?(eventId: string, result: PrintingResolution): void;
  onResolution(eventId: string, result: PrintingResolution): string | undefined;
}
/** One optional footer read at a time, independent of identity saves and vision scheduling. */
export class PrintingSession {
  private reader?: PrintingReader;
  private controller?: AbortController;
  private activeEventId?: string;
  /** No pixels. Keep the advisory budget through Pause/cancel; bound the session. */
  private promptedEvents = new Map<string, string>();
  private promptBudgetSaturated = false;
  private events = new Map<string, EventState>();
  /** No pixels/evidence. Never evicted or renewed by Pause, Undo or cache churn. */
  private confirmationBudgets = new Map<string, ConfirmationBudget>();
  private readonly now: () => number;
  private generation = 0;
  private disposed = false;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => performance.now());
  }
  get busy() {
    return !!this.controller;
  }
  needs(eventId: string) {
    const event = this.events.get(eventId);
    return (
      !event?.done &&
      ((event?.attempts ?? 0) < 6 ||
        (event?.attempts === 6 &&
          event.confirmationDeadline !== undefined &&
          !this.confirmationBudgets.get(eventId)?.blocked &&
          this.now() < event.confirmationDeadline))
    );
  }
  ready(eventId: string, capturedAt: number) {
    return (
      !this.disposed &&
      !this.busy &&
      this.needs(eventId) &&
      Number.isFinite(capturedAt) &&
      capturedAt - (this.events.get(eventId)?.lastAttempt ?? -Infinity) >= 1500
    );
  }
  /** Pause/new page never lets old OCR observations become fresh votes. */
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.events.clear();
    for (const budget of this.confirmationBudgets.values())
      budget.blocked = true;
    this.activeEventId = undefined;
  }
  forget(eventId: string) {
    this.events.delete(eventId);
    this.promptedEvents.delete(eventId);
    const budget = this.confirmationBudgets.get(eventId);
    if (budget) budget.blocked = true;
    // Undo of a different receipt must not cancel another occurrence's reader.
    if (this.activeEventId === eventId) {
      this.generation++;
      this.controller?.abort();
      this.controller = undefined;
      this.reader?.dispose();
      this.reader = undefined;
      this.activeEventId = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    this.promptedEvents.clear();
    this.confirmationBudgets.clear();
  }
  async offer(frame: PrintingFrame): Promise<boolean> {
    if (
      !this.ready(frame.eventId, frame.capturedAt) ||
      !this.dependencies.isCurrent(frame)
    )
      return false;
    if (
      frame.sourceMinEdge < 480 ||
      frame.image.width < 480 ||
      frame.image.height < 640
    )
      return false;
    let budget = this.confirmationBudgets.get(frame.eventId);
    if (
      !budget &&
      this.confirmationBudgets.size < CONFIRMATION_LIMITS.rememberedEvents
    ) {
      budget = {
        firstOfferedAt: this.now(),
        candidateSeen: false,
        granted: false,
        blocked: false,
      };
      this.confirmationBudgets.set(frame.eventId, budget);
    }
    const event: EventState = this.events.get(frame.eventId) ?? {
      observations: [],
      attempts: 0,
      lastAttempt: -Infinity,
      done: false,
    };
    if (frame.capturedAt - event.lastAttempt < 1500) return false;
    if (!this.events.has(frame.eventId) && this.events.size >= 30) {
      const evictedId = this.events.keys().next().value!;
      const evictedBudget = this.confirmationBudgets.get(evictedId);
      if (evictedBudget) evictedBudget.blocked = true;
      this.events.delete(evictedId);
    }
    this.events.set(frame.eventId, event);
    const confirmationRead = event.attempts === 6;
    // Consume before asynchronous work: failure, cancellation or a stale result
    // cannot reissue this occurrence's one extra opportunity.
    if (confirmationRead && budget) budget.blocked = true;
    event.attempts++;
    event.lastAttempt = frame.capturedAt;
    const controller = new AbortController(),
      generation = this.generation;
    this.controller = controller;
    this.activeEventId = frame.eventId;
    const current = () =>
      !this.disposed &&
      !controller.signal.aborted &&
      generation === this.generation &&
      this.dependencies.isCurrent(frame);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const status = (message: string) => {
      if (!current()) return;
      try {
        this.dependencies.onStatus(frame.eventId, message);
      } catch {
        /* UI reporting cannot strand reader ownership. */
      }
    };
    try {
      this.reader ??= (this.dependencies.reader ?? createPrintingReader)();
      status("Reading printed identifiers locally…");
      const work = Promise.all([
        this.dependencies.catalog(frame.reference, {
          signal: controller.signal,
        }),
        this.reader.read({
          ...frame,
          game: frame.reference.game,
          jobId: `${frame.frameId}:printing`,
          signal: controller.signal,
        }),
      ]);
      const [catalog, observation] = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Printing refinement timed out")),
            confirmationRead
              ? Math.max(0, event.confirmationDeadline! - this.now())
              : 40_000,
          );
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
      ]);
      if (!current()) return false;
      if (confirmationRead && !(this.now() < event.confirmationDeadline!)) {
        status(
          "Printing remains unconfirmed. No more automatic reads for this occurrence; review it later.",
        );
        return false;
      }
      event.observations = [...event.observations, observation].slice(-8);
      const resolveInput = {
        game: frame.reference.game,
        sessionId: frame.sessionId,
        eventId: frame.eventId,
        identityName: frame.reference.name,
        identityKey: frame.reference.identityKey,
        candidates: catalog.candidates,
        catalogCompleteForIdentity: catalog.catalogCompleteForIdentity,
        catalogProvenance: catalog.provenance,
        observations: event.observations,
      };
      const resolution = resolvePrintingEvidence(resolveInput);
      // The resolver checks distinct captures before catalog compatibility. Its
      // waiting reason alone therefore cannot justify a confirmation read.
      // Validate the actual latest observation in isolation, then use the same
      // catalog relation as the resolver. Never manufacture a second vote.
      const latest = resolvePrintingEvidence({
        ...resolveInput,
        observations: [observation],
      });
      const relations = latest.reasons.includes(
        "two-distinct-captures-required",
      )
        ? catalog.candidates.map((candidate) =>
            printingCandidateRelation(candidate, observation.fields),
          )
        : [];
      const uniqueLiteral =
        relations.filter((relation) => relation === "match").length === 1 &&
        !relations.includes("unknown");
      if (budget) {
        if (
          event.attempts === 6 &&
          !budget.blocked &&
          !budget.granted &&
          !budget.candidateSeen &&
          uniqueLiteral &&
          !catalog.provenance?.stale &&
          catalog.provenance?.completeWithinScope !== false &&
          resolution.reasons.includes("two-distinct-captures-required")
        ) {
          const now = this.now();
          const expiresAt = Math.min(
            budget.firstOfferedAt + CONFIRMATION_LIMITS.occurrenceMs,
            now + CONFIRMATION_LIMITS.afterGrantMs,
          );
          if (
            Number.isFinite(now) &&
            now >= budget.firstOfferedAt &&
            now < expiresAt
          ) {
            budget.granted = true;
            event.confirmationDeadline = expiresAt;
          }
        }
        budget.candidateSeen ||= uniqueLiteral;
      }
      try {
        if (this.dependencies.onDiagnostics)
          this.dependencies.onDiagnostics(
            frame.eventId,
            structuredClone(resolution),
          );
      } catch {
        /* Optional diagnostics cannot alter persistence or reader ownership. */
      }
      if (
        !current() ||
        (confirmationRead && !(this.now() < event.confirmationDeadline!))
      )
        return false;
      if (resolution.state === "catalog-printing-read") {
        const failure = this.dependencies.onResolution(
          frame.eventId,
          resolution,
        );
        if (!current()) return false;
        event.done = !failure;
        status(
          failure ??
            "Printed catalog identifiers read. Edition, finish and condition may still be unconfirmed.",
        );
      } else {
        const guidance = planPrintingLiteralGuidance({
          game: frame.reference.game,
          candidates: catalog.candidates,
          catalogCompleteForIdentity: catalog.catalogCompleteForIdentity,
          resolution,
          promptsIssued:
            this.promptBudgetSaturated ||
            this.promptedEvents.get(frame.eventId) === frame.sessionId
              ? PRINTING_LITERAL_GUIDANCE_LIMITS.promptsPerEvent
              : 0,
        });
        if (guidance.action === "prompt") {
          this.promptedEvents.set(frame.eventId, frame.sessionId);
          if (
            this.promptedEvents.size >=
            PRINTING_LITERAL_GUIDANCE_LIMITS.rememberedEvents
          )
            this.promptBudgetSaturated = true;
          try {
            this.dependencies.onGuidance?.(frame.eventId, guidance.message);
          } catch {
            /* Accessibility reporting cannot alter reader or evidence ownership. */
          }
          if (!current()) return false;
        }
        // Review stops optional camera work only. It cannot change identity,
        // quantity, the independent evidence resolver, or stored metadata.
        // Transient unavailable catalogs and initially empty single-candidate
        // reads retain the existing bounded passive retry path. No camera prompt
        // is needed merely to preserve the baseline two-capture resolver.
        if (
          guidance.action === "review" &&
          guidance.reason !== "catalog-unavailable" &&
          // A prompt requests a changed view. The immediately following capture
          // may still precede the user response; retain the existing six-read
          // budget instead of terminating on that first no-gain view.
          guidance.reason !== "prompt-budget-exhausted" &&
          (guidance.reason !== "no-supported-literal-disagreement" ||
            resolution.reasons.includes("printing-or-variant-ambiguous"))
        ) {
          event.done = true;
          if (budget) budget.blocked = true;
        }
        status(
          catalog.error
            ? "Printing lookup unavailable. Identity remains saved."
            : event.attempts >= 6 && !this.needs(frame.eventId)
              ? "Printing remains unconfirmed. No more automatic reads for this occurrence; review it later."
              : guidance.reason === "prompt-budget-exhausted"
                ? "Printing unconfirmed. Waiting for the requested view within the remaining read budget."
                : guidance.message,
        );
      }
      return true;
    } catch {
      if (budget) budget.blocked = true;
      if (current())
        status(
          "Printed identifiers could not be read. Identity remains saved.",
        );
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.abort();
      if (this.controller === controller) {
        this.controller = undefined;
        this.activeEventId = undefined;
      }
    }
  }
}
