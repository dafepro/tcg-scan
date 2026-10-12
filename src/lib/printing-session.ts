import type { ReferenceMetadata } from "./vision/types";
import {
  createPrintingReader,
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
}
interface Dependencies {
  catalog(
    reference: ReferenceMetadata,
    options: { signal: AbortSignal },
  ): Promise<PrintingCatalogResult>;
  reader?: () => PrintingReader;
  isCurrent(frame: PrintingFrame): boolean;
  onStatus(eventId: string, status: string): void;
  onResolution(eventId: string, result: PrintingResolution): string | undefined;
}
/** One optional footer read at a time, independent of identity saves and vision scheduling. */
export class PrintingSession {
  private reader?: PrintingReader;
  private controller?: AbortController;
  private events = new Map<string, EventState>();
  private generation = 0;
  private disposed = false;
  constructor(private readonly dependencies: Dependencies) {}
  get busy() {
    return !!this.controller;
  }
  needs(eventId: string) {
    const event = this.events.get(eventId);
    return !event?.done && (event?.attempts ?? 0) < 6;
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
  }
  forget(eventId: string) {
    this.events.delete(eventId);
    this.cancel();
  }
  dispose() {
    this.disposed = true;
    this.cancel();
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
    const event = this.events.get(frame.eventId) ?? {
      observations: [],
      attempts: 0,
      lastAttempt: -Infinity,
      done: false,
    };
    if (frame.capturedAt - event.lastAttempt < 1500) return false;
    if (!this.events.has(frame.eventId) && this.events.size >= 30)
      this.events.delete(this.events.keys().next().value!);
    this.events.set(frame.eventId, event);
    event.attempts++;
    event.lastAttempt = frame.capturedAt;
    const controller = new AbortController(),
      generation = this.generation;
    this.controller = controller;
    const current = () =>
      !this.disposed &&
      !controller.signal.aborted &&
      generation === this.generation &&
      this.dependencies.isCurrent(frame);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const status = (message: string) => {
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
            40_000,
          );
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
      ]);
      if (!current()) return false;
      event.observations = [...event.observations, observation].slice(-8);
      const resolution = resolvePrintingEvidence({
        game: frame.reference.game,
        sessionId: frame.sessionId,
        eventId: frame.eventId,
        identityName: frame.reference.name,
        identityKey: frame.reference.identityKey,
        candidates: catalog.candidates,
        catalogCompleteForIdentity: catalog.catalogCompleteForIdentity,
        observations: event.observations,
      });
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
      } else
        status(
          catalog.error
            ? "Printing lookup unavailable. Identity remains saved."
            : event.attempts >= 6
              ? "Printing remains unconfirmed. Move closer or review it later."
              : "Identity saved. Hold a clear close-up for another printed-number read.",
        );
      return true;
    } catch {
      if (current())
        status(
          "Printed identifiers could not be read. Identity remains saved.",
        );
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.abort();
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
