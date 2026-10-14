import {
  planPrintingLiteralGuidance,
  PRINTING_LITERAL_GUIDANCE_LIMITS,
} from "./printing-literal-guidance";
import type { ReferenceMetadata } from "./vision/types";
import type { PrintingCatalogProvenance } from "./printing-evidence";
import {
  PRINTING_SCHEDULING_LIMITS,
  preferPrintingView,
  printingViewChanged,
  printingViewSettled,
  rememberPrintingView,
  samplePrintingView,
} from "./printing-scheduler";
import type {
  PrintingViewSample,
  RecentPrintingView,
} from "./printing-scheduler";
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
  confirmationTimer?: ReturnType<typeof setTimeout>;
  lastView?: PrintingViewSample;
  /** A genuine complete literal still needs the resolver's second capture. */
  awaitingAgreement?: boolean;
  recentViews?: RecentPrintingView[];
}
interface PendingFrame {
  frame: PrintingFrame;
  view: PrintingViewSample;
  offeredAt: number;
  settledAtCapture: boolean;
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
  onGuidanceComplete?(eventId: string): void;
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
  /** At most one pending original per occurrence, two total. Never OCR votes. */
  private pending = new Map<string, PendingFrame>();
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private generation = 0;
  private disposed = false;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => performance.now());
  }
  get busy() {
    return !!this.controller;
  }
  get retainedCaptures() {
    return this.pending.size;
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
    return !this.busy && this.wantsFrame(eventId, capturedAt);
  }
  /** Request eligible native crops even while OCR is busy. Actual admission
   * still requires the caller's fresh verified identity and all pixel gates. */
  wantsFrame(eventId: string, capturedAt: number) {
    return (
      !this.disposed &&
      this.needs(eventId) &&
      Number.isFinite(capturedAt) &&
      capturedAt - (this.events.get(eventId)?.lastAttempt ?? -Infinity) >= 1500
    );
  }
  priority(eventId: string) {
    return (
      (this.promptedEvents.has(eventId) ? 100 : 0) -
      (this.events.get(eventId)?.attempts ?? 0)
    );
  }
  /** Hold-input retires not-yet-started views without cancelling an active read. */
  discardPending(eventId?: string) {
    if (eventId === undefined) {
      this.pending.clear();
      for (const event of this.events.values()) event.recentViews = [];
    } else this.pending.delete(eventId);
    this.schedulePendingExpiry();
  }
  private schedulePendingExpiry() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    if (!this.pending.size) return;
    const expiresAt = Math.min(
      ...[...this.pending.values()].map(
        (entry) => entry.offeredAt + PRINTING_SCHEDULING_LIMITS.retainedMs,
      ),
    );
    this.pendingTimer = setTimeout(
      () => {
        const now = this.now();
        for (const [eventId, entry] of this.pending)
          if (now - entry.offeredAt >= PRINTING_SCHEDULING_LIMITS.retainedMs)
            this.pending.delete(eventId);
        this.schedulePendingExpiry();
      },
      Math.max(1, expiresAt - this.now()),
    );
  }
  private retain(frame: PrintingFrame, view: PrintingViewSample) {
    // Engine crops are <=960×1344. Do not retain arbitrary large caller images.
    if (frame.image.width * frame.image.height > 1_400_000) return;
    const previous = this.pending.get(frame.eventId);
    const lastRead = this.events.get(frame.eventId)?.lastView;
    if (
      previous &&
      lastRead &&
      printingViewChanged(lastRead, previous.view) &&
      !printingViewChanged(lastRead, view) &&
      view.sourceMinEdge < previous.view.sourceMinEdge * 1.08
    )
      return;
    if (
      previous &&
      (frame.capturedAt <= previous.frame.capturedAt ||
        (this.now() - previous.offeredAt <
          PRINTING_SCHEDULING_LIMITS.retainedMs &&
          !preferPrintingView(previous.view, view)))
    )
      return;
    if (
      !previous &&
      this.pending.size >= PRINTING_SCHEDULING_LIMITS.retainedCaptures
    ) {
      const victim = [...this.pending.entries()].sort(
        (a, b) =>
          this.priority(a[0]) - this.priority(b[0]) ||
          a[1].offeredAt - b[1].offeredAt,
      )[0];
      if (this.priority(victim[0]) > this.priority(frame.eventId)) return;
      this.pending.delete(victim[0]);
    }
    const recentViews = this.events.get(frame.eventId)?.recentViews ?? [];
    const latest = recentViews.at(-1);
    this.pending.set(frame.eventId, {
      frame,
      view,
      offeredAt: this.now(),
      settledAtCapture:
        latest?.frameId === frame.frameId &&
        latest.capturedAt === frame.capturedAt &&
        printingViewSettled(recentViews),
    });
    this.schedulePendingExpiry();
  }
  private drainPending() {
    if (this.disposed || this.busy) return;
    const entries = [...this.pending.entries()].sort(
      (a, b) =>
        this.priority(b[0]) - this.priority(a[0]) ||
        a[1].offeredAt - b[1].offeredAt,
    );
    for (const [eventId, entry] of entries) {
      this.discardPending(eventId);
      if (
        this.now() - entry.offeredAt >= PRINTING_SCHEDULING_LIMITS.retainedMs ||
        !this.wantsFrame(eventId, entry.frame.capturedAt) ||
        !this.dependencies.isCurrent(entry.frame)
      )
        continue;
      // Original frame/time/pixels remain unchanged. A retained view is never
      // relabeled as the current camera frame or counted as a second OCR pass.
      void this.readOfferedFrame(entry.frame, entry.settledAtCapture).finally(
        () => this.drainPending(),
      );
      if (this.busy) break;
    }
  }
  private finishGuidance(eventId: string) {
    const event = this.events.get(eventId);
    if (event?.confirmationTimer) clearTimeout(event.confirmationTimer);
    if (event) event.confirmationTimer = undefined;
    this.discardPending(eventId);
    try {
      this.dependencies.onGuidanceComplete?.(eventId);
    } catch {
      /* UI reporting cannot alter evidence or reader ownership. */
    }
  }
  /** Separate lexical scope deliberately retains no PrintingFrame/image or
   * active-read closure. Undoing another event cannot disable this expiry. */
  private scheduleConfirmationExpiry(
    eventId: string,
    event: EventState,
    budget: ConfirmationBudget,
  ) {
    const expire = () => {
      if (this.disposed || this.events.get(eventId) !== event) return;
      const remaining = event.confirmationDeadline! - this.now();
      if (remaining > 0) {
        event.confirmationTimer = setTimeout(expire, remaining);
        return;
      }
      event.done = true;
      budget.blocked = true;
      this.finishGuidance(eventId);
      try {
        this.dependencies.onStatus(
          eventId,
          "Printing remains unconfirmed. No more automatic reads for this occurrence; review it later.",
        );
      } catch {
        /* Status reporting does not change the deadline. */
      }
    };
    event.confirmationTimer = setTimeout(
      expire,
      Math.max(0, event.confirmationDeadline! - this.now()),
    );
  }
  /** Pause/new page never lets old OCR observations become fresh votes. */
  cancel() {
    this.generation++;
    this.discardPending();
    this.controller?.abort();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    for (const event of this.events.values())
      if (event.confirmationTimer) clearTimeout(event.confirmationTimer);
    this.events.clear();
    for (const budget of this.confirmationBudgets.values())
      budget.blocked = true;
    this.activeEventId = undefined;
  }
  forget(eventId: string) {
    this.discardPending(eventId);
    const event = this.events.get(eventId);
    if (event?.confirmationTimer) clearTimeout(event.confirmationTimer);
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
      // The retired offer no longer owns the controller, so its finally must
      // not drain. Start another still-current retained occurrence here instead.
      this.drainPending();
    }
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    this.promptedEvents.clear();
    this.confirmationBudgets.clear();
  }
  async offer(frame: PrintingFrame): Promise<boolean> {
    return this.readOfferedFrame(frame);
  }
  private async readOfferedFrame(
    frame: PrintingFrame,
    settledAtCapture = false,
  ): Promise<boolean> {
    if (
      !this.wantsFrame(frame.eventId, frame.capturedAt) ||
      !this.dependencies.isCurrent(frame)
    )
      return false;
    if (
      frame.sourceMinEdge < 480 ||
      frame.image.width < 480 ||
      frame.image.height < 640
    )
      return false;
    const view = samplePrintingView(
      frame.image,
      frame.reference.game,
      frame.sourceMinEdge,
    );
    if (!view) return false;
    const previousEvent = this.events.get(frame.eventId);
    if (previousEvent)
      previousEvent.recentViews = rememberPrintingView(
        previousEvent.recentViews ?? [],
        { frameId: frame.frameId, capturedAt: frame.capturedAt, view },
      );
    if (this.busy) {
      this.retain(frame, view);
      return false;
    }
    if (
      previousEvent?.awaitingAgreement &&
      previousEvent.lastView?.repeatKey === view.repeatKey
    )
      return false;
    if (
      previousEvent?.lastView &&
      !previousEvent.awaitingAgreement &&
      frame.capturedAt - previousEvent.lastAttempt <
        PRINTING_SCHEDULING_LIMITS.unchangedRefreshMs &&
      (!printingViewChanged(previousEvent.lastView, view) ||
        (this.promptedEvents.has(frame.eventId) &&
          !settledAtCapture &&
          !(
            previousEvent.recentViews?.at(-1)?.frameId === frame.frameId &&
            previousEvent.recentViews.at(-1)!.capturedAt === frame.capturedAt &&
            printingViewSettled(previousEvent.recentViews ?? [])
          )))
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
      const evicted = this.events.get(evictedId);
      if (evicted?.confirmationTimer) clearTimeout(evicted.confirmationTimer);
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
    event.lastView = view;
    event.recentViews = [
      { frameId: frame.frameId, capturedAt: frame.capturedAt, view },
    ];
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
    const finishGuidance = () => {
      if (!current()) return;
      this.finishGuidance(frame.eventId);
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
        finishGuidance();
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
      event.awaitingAgreement = resolution.reasons.includes(
        "two-distinct-captures-required",
      );
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
            this.scheduleConfirmationExpiry(frame.eventId, event, budget);
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
      if (!current()) return false;
      if (confirmationRead && !(this.now() < event.confirmationDeadline!)) {
        finishGuidance();
        return false;
      }
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
        if (event.done || !this.needs(frame.eventId)) finishGuidance();
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
          // Already retained captures predate this request. They cannot be the
          // user's response and must not immediately spend another read.
          this.discardPending(frame.eventId);
          event.recentViews = [];
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
        if (event.done || !this.needs(frame.eventId)) finishGuidance();
      }
      return true;
    } catch {
      if (budget) budget.blocked = true;
      if (current())
        status(
          "Printed identifiers could not be read. Identity remains saved.",
        );
      if (!this.needs(frame.eventId)) finishGuidance();
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.abort();
      if (this.controller === controller) {
        this.controller = undefined;
        this.activeEventId = undefined;
        this.drainPending();
      }
    }
  }
}
