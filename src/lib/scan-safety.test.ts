import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AppData } from "../types";
import type { ReferenceMetadata } from "./vision/types";
import { ScanSession } from "./scan-session";
import { addScanEvent, undoScanEvent } from "./scan-inventory";
import { parseBackup } from "./storage";
import type { CardDetection, VisionResult } from "./vision/types";

const reference = {
  key: "pokemon:base1-58",
  game: "pokemon" as const,
  name: "Pikachu",
};
function detection(x: number): CardDetection {
  return {
    quad: [
      { x, y: 0 },
      { x: x + 100, y: 0 },
      { x: x + 100, y: 140 },
      { x, y: 140 },
    ],
    state: "verified",
    reason: "Verified geometry",
    autoEligible: true,
    quality: {
      laplacianVariance: 100,
      contrast: 40,
      meanLuminance: 120,
      saturatedFraction: 0,
      sourceMinEdge: 100,
      featureCount: 100,
      issues: [],
    },
    candidates: [
      {
        key: reference.key,
        reference,
        hashDistance: 0,
        tentativeMatches: 60,
        inliers: 55,
        inlierRatio: 0.9,
        interiorInliers: 30,
        coverage: 0.7,
        medianReprojectionError: 1,
        cornerError: 0.01,
        geometricallyVerified: true,
      },
    ],
  };
}
function frame(xs: number[]): VisionResult {
  return {
    width: 1000,
    height: 720,
    detections: xs.map(detection),
    timings: { detectionMs: 1, extractionMs: 2, matchingMs: 3, totalMs: 6 },
    coverage: {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: ["safety-regression"],
    },
    budgetExhausted: false,
  };
}
function observeStable(session: ScanSession, xs: number[], timestamp: number) {
  const additions = [];
  for (let step = 0; step < 3; step++) {
    const result = session.update(frame(xs), timestamp + step * 150);
    additions.push(...result.additions);
    for (const intent of result.additions) session.acknowledge(intent.eventId);
  }
  return additions;
}
function roundTrip(collection: ReturnType<typeof addScanEvent>) {
  return parseBackup(
    JSON.stringify({ version: 1, collection, review: [], decks: [] }),
  );
}

describe("continuous scan safety regressions", () => {
  it("does not create a third copy when two identical binder cards pan together", () => {
    const session = new ScanSession("pan", "binder");
    expect(observeStable(session, [0, 200], 0)).toHaveLength(2);
    expect(observeStable(session, [110, 310], 450)).toHaveLength(0);
    expect(
      session.snapshot().filter((track) => track.visible && track.counted),
    ).toHaveLength(2);
  });

  it("does not recount one held stream card moved by a full card width", () => {
    const session = new ScanSession("move", "stream");
    expect(observeStable(session, [0], 0)).toHaveLength(1);
    expect(observeStable(session, [100], 450)).toHaveLength(0);
  });

  it("reuses the same counted identity after a short occlusion and distant reappearance", () => {
    const session = new ScanSession("occlusion", "stream");
    expect(observeStable(session, [0], 0)).toHaveLength(1);
    session.update(frame([]), 450);
    expect(observeStable(session, [400], 600)).toHaveLength(0);
  });

  it("still adds a newly visible second identical copy and no more than two", () => {
    const session = new ScanSession("second", "binder");
    expect(observeStable(session, [0], 0)).toHaveLength(1);
    expect(observeStable(session, [0, 200], 450)).toHaveLength(1);
    expect(observeStable(session, [110, 310], 900)).toHaveLength(0);
  });

  it("does not infer an observed empty interval from an unobserved long gap", () => {
    const session = new ScanSession("gap", "stream");
    observeStable(session, [0], 0);
    session.update(frame([]), 450);
    expect(session.update(frame([]), 60_000).resetAfterEmpty).toBe(false);
    expect(observeStable(session, [0], 60_150)).toHaveLength(0);
  });

  it("explicit interruption clears empty evidence while retaining counted tracks", () => {
    const session = new ScanSession("pause", "stream");
    observeStable(session, [0], 0);
    session.update(frame([]), 450);
    session.interruptEvidence();
    expect(session.update(frame([]), 60_000).resetAfterEmpty).toBe(false);
    expect(observeStable(session, [0], 60_150)).toHaveLength(0);
  });

  it("requires fresh stability observations after interruption", () => {
    const session = new ScanSession("stable-pause", "stream");
    session.update(frame([0]), 0);
    session.update(frame([0]), 150);
    session.interruptEvidence();
    expect(session.update(frame([0]), 300).additions).toHaveLength(0);
    expect(session.update(frame([0]), 450).additions).toHaveLength(0);
    expect(session.update(frame([0]), 600).additions).toHaveLength(1);
  });

  it("keeps undo suppressed through a long partial occlusion without an empty reset", () => {
    const session = new ScanSession("undo-occlusion", "stream");
    const additions = observeStable(session, [0, 200], 0);
    expect(additions).toHaveLength(2);
    session.undo(additions[0].eventId);
    for (let timestamp = 450; timestamp <= 6600; timestamp += 150)
      session.update(frame([200]), timestamp);
    expect(observeStable(session, [0, 200], 6750)).toHaveLength(0);
  });

  it("retains one unique failed-save track through partial occlusion until the epoch resets", () => {
    const session = new ScanSession("failed-retention", "stream");
    session.update(frame([0, 200]), 0);
    session.update(frame([0, 200]), 150);
    const additions = session.update(frame([0, 200]), 300).additions;
    session.acknowledge(additions[0].eventId, "Storage full");
    session.acknowledge(additions[1].eventId);
    for (let timestamp = 450; timestamp <= 6600; timestamp += 150) {
      session.update(frame([200]), timestamp);
      const snapshot = session.snapshot();
      expect(new Set(snapshot.map((track) => track.id)).size).toBe(
        snapshot.length,
      );
      expect(snapshot.filter((track) => track.status === "error")).toHaveLength(
        1,
      );
    }
    expect(observeStable(session, [0, 200], 6750)).toHaveLength(0);
    expect(session.snapshot()).toHaveLength(2);
    expect(
      session.snapshot().find((track) => track.status === "error")?.counted,
    ).toBe(false);
    session.newPage();
    expect(observeStable(session, [0, 200], 7200)).toHaveLength(2);
  });

  it("does not evict a counted card when many tentative identities appear", () => {
    const session = new ScanSession("retention", "binder");
    expect(observeStable(session, [0], 0)).toHaveLength(1);
    for (let index = 0; index < 510; index++) {
      const observation = frame([0]);
      observation.detections[0].candidates[0].reference = {
        ...reference,
        key: `pokemon:tentative-${index}`,
        name: `Tentative identity ${index}`,
      };
      expect(
        session.update(observation, 450 + index * 150).additions,
      ).toHaveLength(0);
    }
    expect(observeStable(session, [0], 77_000)).toHaveLength(0);
  });

  it("observed empty frames rearm stream but binder requires explicit new page", () => {
    for (const mode of ["stream", "binder"] as const) {
      const session = new ScanSession(`reset-${mode}`, mode);
      const initial = observeStable(session, [0, 200], 0);
      expect(initial).toHaveLength(2);
      for (let timestamp = 450; timestamp <= 1650; timestamp += 150)
        session.update(frame([]), timestamp);
      const afterEmpty = observeStable(session, [0, 200], 1800);
      expect(afterEmpty).toHaveLength(mode === "stream" ? 2 : 0);
      session.newPage();
      const next = observeStable(session, [0, 200], 2400);
      expect(next).toHaveLength(2);
      expect(
        next.every(
          (intent) => !initial.some((old) => old.eventId === intent.eventId),
        ),
      ).toBe(true);
    }
  });
});

describe("durable scan identity and exact undo", () => {
  it("preserves event identity across backup reload and makes event retry idempotent", () => {
    const original = addScanEvent([], reference, "session:page:1");
    const reloaded = roundTrip(original).collection;
    expect(reloaded[0].scanEventId).toBe("session:page:1");
    expect(addScanEvent(reloaded, reference, "session:page:1")).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      condition: "Unknown",
      finish: "Unknown",
      verification: "identity-only",
    });
    expect(reloaded[0].card.prices).toEqual([]);
  });

  it("undo removes exactly the selected identical copy after reload", () => {
    let entries = addScanEvent([], reference, "first");
    entries = addScanEvent(entries, reference, "second");
    const reloaded = roundTrip(entries).collection;
    expect(
      undoScanEvent(reloaded, "first").map((entry) => entry.scanEventId),
    ).toEqual(["second"]);
  });

  it("undo preserves a manually incremented copy and is idempotent", () => {
    const entries = addScanEvent([], reference, "incremented");
    entries[0].quantity = 2;
    const undone = undoScanEvent(entries, "incremented");
    expect(undone).toHaveLength(1);
    expect(undone[0].quantity).toBe(1);
    expect(undone[0].scanEventId).toBeUndefined();
    expect(undoScanEvent(undone, "incremented")).toEqual(undone);
  });

  it("rejects two rows sharing a scan event instead of letting one undo remove both", () => {
    const entries = addScanEvent([], reference, "duplicate");
    const second = { ...entries[0], id: "different-row-same-event" };
    expect(() => roundTrip([...entries, second])).toThrow();
  });
});

const hookAudit = vi.hoisted(() => ({
  stateCount: 0,
  commits: [] as { index: number; value: unknown }[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = hookAudit.stateCount++;
      const value =
        typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        value,
        (next: unknown) => hookAudit.commits.push({ index, value: next }),
      ];
    },
    useRef<T>(current: T) {
      return { current };
    },
    useEffect() {
      /* Durability is exercised synchronously via the actual App callbacks. */
    },
    useLayoutEffect() {
      /* Presentation attributes are covered in browser QA. */
    },
    useCallback<T>(callback: T) {
      return callback;
    },
  };
});

type ScannerCallbacks = {
  onSave: (reference: ReferenceMetadata, eventId: string) => string | undefined;
  onUndo: (eventId: string) => string | undefined;
};
function scannerCallbacks(node: unknown): ScannerCallbacks | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = scannerCallbacks(child);
      if (found) return found;
    }
  } else if (typeof node === "object" && node !== null && "props" in node) {
    const props = node.props as Partial<ScannerCallbacks> & {
      children?: unknown;
    };
    if (props.onSave && props.onUndo)
      return { onSave: props.onSave, onUndo: props.onUndo };
    return scannerCallbacks(props.children);
  }
}

describe("App durable scan callbacks", () => {
  beforeEach(() => {
    hookAudit.stateCount = 0;
    hookAudit.commits = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("commits a successful write without a fallible storage readback", () => {
    let stored: string | null = null;
    const getItem = vi.fn(() => {
      if (stored !== null)
        throw new Error("Reads became unavailable after write");
      return stored;
    });
    vi.stubGlobal("localStorage", {
      getItem,
      setItem: vi.fn((_key: string, value: string) => {
        stored = value;
      }),
    });
    const callbacks = scannerCallbacks(App());
    expect(callbacks).toBeDefined();
    expect(callbacks!.onSave(reference, "durable-readback")).toBeUndefined();
    expect(parseBackup(stored!).collection).toHaveLength(1);
    const committed = hookAudit.commits.find(
      (entry) =>
        typeof entry.value === "object" &&
        entry.value !== null &&
        "collection" in entry.value,
    )?.value as AppData;
    expect(committed.collection).toHaveLength(1);
    expect(getItem).toHaveBeenCalledTimes(2); // Initial load, then pre-write conflict check.
  });

  it("does not commit an added card when the storage write fails", () => {
    const setItem = vi.fn(() => {
      throw new Error("Quota exceeded");
    });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    const callbacks = scannerCallbacks(App());
    expect(callbacks).toBeDefined();
    expect(callbacks!.onSave(reference, "failed-write")).toContain(
      "Scan was not saved",
    );
    expect(setItem).toHaveBeenCalledOnce();
    expect(
      hookAudit.commits.some(
        (entry) =>
          typeof entry.value === "object" &&
          entry.value !== null &&
          "collection" in entry.value,
      ),
    ).toBe(false);
  });
});
