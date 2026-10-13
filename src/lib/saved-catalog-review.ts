import type { Card, CollectionEntry } from "../types";
import {
  getPrintingCandidates,
  type PrintingCatalog,
  type PrintingCatalogSnapshot,
} from "./printing-catalog";
import {
  parseCatalogProvenance,
  printingEvidenceCatalogStatus,
  type PersistedPrintingEvidence,
  type PrintingCatalogProvenance,
} from "./printing-evidence";
import type { ReferenceMetadata } from "./vision/types";

const providers = { pokemon: "TCGdex", mtg: "Scryfall", yugioh: "YGOPRODeck" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uses only an explicit known provider and its typed card ID/name. Never mine
 * notes, prices, printing text or arbitrary URLs for Oracle/artwork identities. */
export function savedCatalogReference(
  card: Card,
): ReferenceMetadata | undefined {
  if (
    card.provider !== providers[card.game] ||
    !card.name.trim() ||
    card.name.length > 180 ||
    [...card.name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return;
  const valid =
    card.game === "pokemon"
      ? /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}$/.test(card.id) &&
        !card.name.includes("|")
      : card.game === "mtg"
        ? uuid.test(card.id)
        : /^\d{1,8}$/.test(card.id) && Number(card.id) > 0;
  if (!valid) return;
  return { key: `${card.game}:${card.id}`, game: card.game, name: card.name };
}

export interface SavedCatalogComparison {
  status:
    "same-snapshot" | "review-required" | "legacy-unversioned" | "unavailable";
  current?: PrintingCatalogProvenance;
  changed: boolean;
  stale: boolean;
  incomplete: boolean;
  legacy: boolean;
  error?: string;
}

/** Comparison only. No resolver rerun, physical inference, acceptance or storage write. */
export function compareSavedCatalog(
  evidence: PersistedPrintingEvidence | undefined,
  snapshot: PrintingCatalogSnapshot,
): SavedCatalogComparison {
  const legacy = !evidence?.catalog;
  const unavailable = (error: string): SavedCatalogComparison => ({
    status: "unavailable",
    changed: false,
    stale: false,
    incomplete: true,
    legacy,
    error,
  });
  let current: PrintingCatalogProvenance;
  try {
    current = parseCatalogProvenance(snapshot.provenance);
    if (
      current.provider !== snapshot.provider ||
      current.scope !== snapshot.scope ||
      current.fetchedAt !== (snapshot.fetchedAt ?? null) ||
      current.stale !== snapshot.stale ||
      current.completeWithinScope !== snapshot.catalogCompleteForIdentity ||
      current.candidateCount !== snapshot.candidates.length
    )
      return unavailable("invalid-response");
  } catch {
    return unavailable("invalid-response");
  }
  const old = evidence?.catalog;
  const changed =
    !!old &&
    (old.snapshotId !== current.snapshotId ||
      old.provider !== current.provider ||
      old.scope !== current.scope);
  const incomplete =
    !current.completeWithinScope ||
    !current.candidateCount ||
    !current.fetchedAt;
  const status = printingEvidenceCatalogStatus(evidence, current);
  return {
    status:
      !current.candidateCount || !current.fetchedAt
        ? "unavailable"
        : legacy
          ? "legacy-unversioned"
          : status === "current" && !snapshot.error && !incomplete
            ? "same-snapshot"
            : "review-required",
    current,
    changed,
    stale: current.stale,
    incomplete,
    legacy,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

export type SavedCatalogReviewState = {
  entryId: string;
  name: string;
  startedAt: string;
} & (
  | { phase: "checking" }
  | { phase: "complete"; checkedAt: string; comparison: SavedCatalogComparison }
  | { phase: "error"; checkedAt: string; error: string }
  | { phase: "cancelled" }
);
interface Binding {
  entryId: string;
  entry: CollectionEntry;
  /** Exact content binding includes event, evidence, reader versions and catalog.
   * Retained for this one comparison only; never written into a backup. */
  original: string;
}
interface Request {
  controller: AbortController;
  binding: Binding;
}
interface Options {
  catalog?: PrintingCatalog["getPrintingCandidates"];
  now?: () => number;
  timeoutMs?: number;
}

/** One explicit request and one transient result, independent of scan/save/price state. */
export class SavedCatalogReviewSession {
  private entries: readonly CollectionEntry[] = [];
  private binding?: Binding;
  private request?: Request;
  private state: SavedCatalogReviewState | null = null;
  private listeners = new Set<() => void>();
  private readonly catalog: PrintingCatalog["getPrintingCandidates"];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(options: Options = {}) {
    this.catalog = options.catalog ?? getPrintingCandidates;
    this.now = options.now ?? Date.now;
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(35_000, Math.floor(options.timeoutMs)))
        : 35_000;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private emit(state: SavedCatalogReviewState | null) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private matches(binding: Binding) {
    const matches = this.entries.filter(
      (entry) => entry.id === binding.entryId,
    );
    return (
      matches.length === 1 &&
      matches[0] === binding.entry &&
      JSON.stringify(matches[0]) === binding.original
    );
  }
  setEntries(entries: readonly CollectionEntry[]) {
    this.entries = entries;
    if (this.binding && !this.matches(this.binding)) this.clear();
  }
  /** Navigation/delete/replacement remove all transient state and abort ownership. */
  clear() {
    this.request?.controller.abort();
    this.request = undefined;
    this.binding = undefined;
    if (this.state) this.emit(null);
  }
  cancel() {
    if (!this.request) return;
    this.request.controller.abort();
    this.request = undefined;
    if (this.state)
      this.emit({
        entryId: this.state.entryId,
        name: this.state.name,
        startedAt: this.state.startedAt,
        phase: "cancelled",
      });
  }
  async start(entry: CollectionEntry): Promise<boolean> {
    if (this.request) return false;
    const binding: Binding = {
      entryId: entry.id,
      entry,
      original: JSON.stringify(entry),
    };
    if (!this.matches(binding)) return false;
    this.binding = binding;
    const context = {
      entryId: entry.id,
      name: entry.card.name,
      startedAt: new Date(this.now()).toISOString(),
    };
    const reference = savedCatalogReference(entry.card);
    if (!reference) {
      this.emit({
        ...context,
        phase: "error",
        checkedAt: context.startedAt,
        error: "unsupported-reference",
      });
      return false;
    }
    // Capture BEFORE awaiting: late responses can never compare against replacement evidence.
    const evidence = structuredClone(entry.printingRead?.evidence);
    const controller = new AbortController();
    const request = { controller, binding };
    this.request = request;
    const current = () =>
      this.request === request &&
      !controller.signal.aborted &&
      this.matches(binding);
    this.emit({ ...context, phase: "checking" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    try {
      const snapshot = await Promise.race([
        this.catalog(reference, { signal: controller.signal, refresh: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout")),
            this.timeoutMs,
          );
          stop = () => reject(new DOMException("Cancelled", "AbortError"));
          controller.signal.addEventListener("abort", stop, { once: true });
        }),
      ]);
      if (!current()) return false;
      if (snapshot.referenceKey !== reference.key)
        throw new Error("invalid-response");
      this.emit({
        ...context,
        phase: "complete",
        checkedAt: new Date(this.now()).toISOString(),
        comparison: compareSavedCatalog(evidence, snapshot),
      });
      return true;
    } catch (error) {
      if (!current()) return false;
      this.emit({
        ...context,
        phase: "error",
        checkedAt: new Date(this.now()).toISOString(),
        error:
          error instanceof Error &&
          ["timeout", "invalid-response"].includes(error.message)
            ? error.message
            : "network",
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      if (stop) controller.signal.removeEventListener("abort", stop);
      controller.abort();
      // A cancelled request's finalizer cannot clear a newer request or its result.
      if (this.request === request) this.request = undefined;
    }
  }
}

export function catalogReviewLabel(state: SavedCatalogReviewState): string {
  if (state.phase === "checking") return "Checking provider catalog…";
  if (state.phase === "cancelled") return "Catalog check cancelled.";
  if (state.phase === "error") return "Catalog check unavailable.";
  const result = state.comparison;
  if (result.status === "unavailable") return "Catalog check unavailable.";
  if (result.stale) return "Stale fallback · review needed.";
  if (result.error) return "Provider check failed · review needed.";
  if (result.incomplete) return "Incomplete provider coverage · review needed.";
  if (result.status === "legacy-unversioned")
    return "Legacy evidence · no saved snapshot to compare.";
  if (result.status === "same-snapshot")
    return "Same provider snapshot at this check.";
  return "Provider snapshot changed · review needed.";
}
