import { useSyncExternalStore } from "react";

export const MAX_DIAGNOSTIC_EVENTS = 128;
export const DIAGNOSTIC_SOURCES = [
  "app",
  "live",
  "pack",
  "vision",
  "storage",
  "printing",
] as const;
export const DIAGNOSTIC_EVENTS = [
  "mount",
  "ready",
  "start",
  "stop",
  "pause",
  "resume",
  "capture",
  "scan",
  "save",
  "undo",
  "error",
  "warning",
  "import",
  "download",
  "settings",
  "search",
] as const;
export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];
export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENTS)[number];
const enumFields = {
  printingState: ["unresolved", "catalog-printing-read"],
  printingReason: [
    "catalog-coverage-incomplete",
    "identity-catalog-missing",
    "catalog-candidate-limit",
    "catalog-duplicate-or-missing-key",
    "catalog-identity-mismatch",
    "conflicting-observations",
    "no-unambiguous-footer-evidence",
    "two-distinct-captures-required",
    "catalog-fields-incomplete",
    "printing-or-variant-ambiguous",
    "no-catalog-printing-match",
    "catalog-fields-match",
    "unknown",
  ],
  status: [
    "idle",
    "preparing",
    "ready",
    "running",
    "paused",
    "stopped",
    "success",
    "blocked",
    "failed",
    "unavailable",
    "processing",
    "complete",
    "cancelled",
    "waiting",
  ],
  game: ["pokemon", "mtg", "yugioh"],
  captureFlow: ["live", "pack"],
  mode: ["stream", "binder", "photo"],
  matcher: ["orb", "learned"],
  transport: ["videoframe-pool", "imagebitmap", "canvas", "photo"],
  savePolicy: ["fast", "strict"],
  storage: ["saved", "default", "invalid", "unavailable", "conflict"],
  reason: [
    "camera-denied",
    "camera-unavailable",
    "storage-blocked",
    "storage-conflict",
    "engine-failed",
    "capture-failed",
    "save-failed",
    "import-failed",
    "download-failed",
    "scan-failed",
    "cancelled",
    "unknown",
  ],
} as const;
const booleanFields = [
  "active",
  "paused",
  "autoSave",
  "busy",
  "detectionComplete",
  "budgetExhausted",
] as const;
const numericBounds = {
  printingRegions: 2,
  printingObservations: 8,
  printingNativeEdge: 16384,
  printingRegionWidth: 16384,
  printingRegionHeight: 16384,
  printingHighlightPercent: 100,
  printingEdgeEnergyPercent: 100,
  presentationSnapshots: 1e9,
  presentationMs: 3600000,
  presentationMaxMs: 3600000,
  admitted: 1e9,
  backpressureDeferred: 1e9,
  backpressureRejected: 1e9,
  queueRejected: 1e9,
  queueOmitted: 1e9,
  queueReplaced: 1e9,
  reservoirCancelled: 1e9,
  reservoirReplaced: 1e9,
  reservoirPromoted: 1e9,
  reservoirViews: 10000,
  adaptivePendingLimit: 10000,
  workerServiceMs: 3600000,
  queueWaitMs: 3600000,
  captureToResultMs: 3600000,
  captured: 1e9,
  skipped: 1e9,
  dropped: 1e9,
  processed: 1e9,
  retries: 1e9,
  tracks: 10000,
  verified: 10000,
  ambiguous: 10000,
  unknown: 10000,
  saved: 1e9,
  pending: 10000,
  references: 1e9,
  matcherReferences: 1e9,
  detections: 10000,
  width: 16384,
  height: 16384,
  queueDepth: 10000,
  bytes: 2 ** 40,
  progress: 1,
  detectionMs: 3600000,
  extractionMs: 3600000,
  matchingMs: 3600000,
  totalMs: 3600000,
} as const;
export type DiagnosticFields = Partial<
  { [K in keyof typeof enumFields]: (typeof enumFields)[K][number] } & {
    [K in (typeof booleanFields)[number]]: boolean;
  } & { -readonly [K in keyof typeof numericBounds]: number }
>;
export interface DiagnosticEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly source: DiagnosticSource;
  readonly event: DiagnosticEventName;
  readonly fields: Readonly<DiagnosticFields>;
}
export interface DiagnosticSnapshot {
  readonly events: readonly DiagnosticEvent[];
  readonly latest: Readonly<
    Partial<Record<DiagnosticSource, Readonly<DiagnosticFields>>>
  >;
}
/** No free-text field exists: URLs, card data, photos, credentials and raw errors are dropped. */
export function sanitizeDiagnosticFields(input: unknown): DiagnosticFields {
  const output: DiagnosticFields = {};
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return output;
  const own = (key: string): unknown => {
    try {
      return Object.getOwnPropertyDescriptor(input, key)?.value;
    } catch {
      return undefined;
    }
  };
  for (const key of Object.keys(enumFields) as Array<keyof typeof enumFields>) {
    const value = own(key);
    if (
      typeof value === "string" &&
      (enumFields[key] as readonly string[]).includes(value)
    )
      Object.assign(output, { [key]: value });
  }
  for (const key of booleanFields) {
    const value = own(key);
    if (typeof value === "boolean") output[key] = value;
  }
  for (const key of Object.keys(numericBounds) as Array<
    keyof typeof numericBounds
  >) {
    const value = own(key);
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= numericBounds[key]
    ) {
      output[key] =
        key.endsWith("Ms") ||
        key === "progress" ||
        key === "printingHighlightPercent" ||
        key === "printingEdgeEnergyPercent"
          ? Math.round(value * 100) / 100
          : Math.floor(value);
    }
  }
  return output;
}
const emptySnapshot = (): DiagnosticSnapshot =>
  Object.freeze({ events: Object.freeze([]), latest: Object.freeze({}) });
function fieldsEqual(
  a: DiagnosticFields | undefined,
  b: DiagnosticFields,
): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
export function createDiagnosticsStore(options: { now?: () => number } = {}) {
  let snapshot = emptySnapshot();
  let nextId = 1;
  const listeners = new Set<() => void>();
  const recent = new Map<string, { timestamp: number; signature: string }>();
  const now = options.now ?? Date.now;
  const sourceAllowed = (source: unknown): source is DiagnosticSource =>
    typeof source === "string" &&
    (DIAGNOSTIC_SOURCES as readonly string[]).includes(source);
  const notify = () => listeners.forEach((listener) => listener());
  const mergeLatest = (source: DiagnosticSource, fields: DiagnosticFields) => {
    const next = { ...snapshot.latest[source], ...fields };
    // A current healthy state supersedes a prior failure reason. Historical
    // events remain immutable; omitted counters/timings still retain last data.
    if (
      fields.status &&
      !fields.reason &&
      !["failed", "blocked", "unavailable"].includes(fields.status)
    )
      delete next.reason;
    if (fieldsEqual(snapshot.latest[source], next)) return false;
    snapshot = Object.freeze({
      ...snapshot,
      latest: Object.freeze({
        ...snapshot.latest,
        [source]: Object.freeze(next),
      }),
    });
    return true;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(source: DiagnosticSource, fields: DiagnosticFields): void {
      if (!sourceAllowed(source)) return;
      if (mergeLatest(source, sanitizeDiagnosticFields(fields))) notify();
    },
    record(
      source: DiagnosticSource,
      event: DiagnosticEventName,
      fields: DiagnosticFields = {},
    ): boolean {
      if (
        !sourceAllowed(source) ||
        !(DIAGNOSTIC_EVENTS as readonly string[]).includes(event)
      )
        return false;
      const clean = Object.freeze(sanitizeDiagnosticFields(fields));
      const changed = mergeLatest(source, clean);
      const rawTime = now();
      const timestamp =
        Number.isFinite(rawTime) && rawTime >= 0
          ? Math.min(rawTime, 8640000000000000)
          : 0;
      const key = `${source}:${event}`;
      const previous = recent.get(key);
      const signature = JSON.stringify(clean);
      const elapsed = previous ? timestamp - previous.timestamp : Infinity;
      // Limit frame events, and collapse identical repeated state/error chatter.
      if (
        previous &&
        elapsed >= 0 &&
        ((elapsed < 250 && (event === "scan" || event === "capture")) ||
          (elapsed < 1000 && previous.signature === signature))
      ) {
        if (changed) notify();
        return false;
      }
      recent.set(key, { timestamp, signature });
      const entry: DiagnosticEvent = Object.freeze({
        id: nextId++,
        timestamp,
        source,
        event,
        fields: clean,
      });
      snapshot = Object.freeze({
        ...snapshot,
        events: Object.freeze(
          [...snapshot.events, entry].slice(-MAX_DIAGNOSTIC_EVENTS),
        ),
      });
      notify();
      return true;
    },
    reset(source: DiagnosticSource): void {
      if (!sourceAllowed(source) || !snapshot.latest[source]) return;
      const latest = { ...snapshot.latest };
      delete latest[source];
      snapshot = Object.freeze({ ...snapshot, latest: Object.freeze(latest) });
      notify();
    },
    clear(): void {
      recent.clear();
      snapshot = Object.freeze({ ...snapshot, events: Object.freeze([]) });
      notify();
    },
  };
}
export const diagnostics = createDiagnosticsStore();
export function useDiagnostics() {
  return useSyncExternalStore(
    diagnostics.subscribe,
    diagnostics.getSnapshot,
    diagnostics.getSnapshot,
  );
}
