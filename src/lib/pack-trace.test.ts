import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PACK_TRACE_MAX_BYTES,
  PACK_TRACE_MAX_RECORDS,
  PackTrace,
  observePackTrace,
  packTraceRejection,
  type PackTraceReason,
  type PackTraceRecord,
  type PackTraceSave,
  type PackTraceSchedule,
  type PackTraceState,
} from "./pack-trace";
import type { CardDetection } from "./vision/types";

const privateText = "PRIVATE_card-name_identity-key_camera-url_collection-id";
const asNumber = (value: unknown) => value as number;
const record = (trace: PackTrace, index = 0) => trace.snapshot().records[index];
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function detection(): CardDetection {
  return {
    quad: [
      { x: 0, y: 0 },
      { x: 64, y: 0 },
      { x: 64, y: 64 },
      { x: 0, y: 64 },
    ],
    state: "verified",
    reason: privateText,
    autoEligible: true,
    quality: {
      laplacianVariance: 100,
      contrast: 100,
      meanLuminance: 100,
      saturatedFraction: 0,
      sourceMinEdge: 64,
      featureCount: 100,
      issues: [],
    },
    candidates: [
      {
        key: privateText,
        reference: {
          key: privateText,
          name: privateText,
          game: "pokemon",
          imageUrl: privateText,
          sourceUrl: privateText,
        },
        hashDistance: 0,
        tentativeMatches: 100,
        inliers: 100,
        inlierRatio: 1,
        interiorInliers: 80,
        coverage: 1,
        medianReprojectionError: 0,
        cornerError: 0,
        geometricallyVerified: true,
      },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("bounded local Pack trace", () => {
  it("enforces the hard 2,048-record and 512-KiB configured ceilings", () => {
    expect(PACK_TRACE_MAX_RECORDS).toBe(2048);
    expect(PACK_TRACE_MAX_BYTES).toBe(512 * 1024);
    for (const maxRecords of [0, -1, 1.5, 2049, NaN, Infinity])
      expect(() => new PackTrace({ maxRecords, maxBytes: 524288 })).toThrow();
    for (const maxBytes of [0, 8959, 8960.5, 524289, NaN, Infinity])
      expect(() => new PackTrace({ maxRecords: 2048, maxBytes })).toThrow();
    expect(
      () => new PackTrace({ maxRecords: 2048, maxBytes: 524288 }),
    ).not.toThrow();
    expect(
      () => new PackTrace({ maxRecords: 1, maxBytes: 8960 }),
    ).not.toThrow();
  });

  it("reserves every future lifecycle, retains the earliest 672 records, and counts losses", () => {
    const trace = new PackTrace();
    const limits = trace.snapshot().limits;
    expect(limits.recordReserveBytes).toBe(768);
    expect(limits.envelopeReserveBytes).toBe(8192);
    const capacity = Math.floor(
      (limits.maxBytes - limits.envelopeReserveBytes) /
        limits.recordReserveBytes,
    );
    expect(capacity).toBe(672);
    const ids = Array.from({ length: 2100 }, (_, index) =>
      trace.capture(index / 30, index + 1, index * 10),
    );
    expect(ids).toEqual(Array.from({ length: 2100 }, (_, index) => index + 1));
    for (const id of ids) trace.schedule(id, "admitted", 30000, id);
    for (const id of ids.slice(0, capacity)) {
      trace.started(id, 30001);
      trace.processed(id, 30002);
      trace.decision(id, true, "verified", 30003);
      trace.save(id, "pending", 30004, id);
      trace.save(id, "failed", 30005);
      trace.save(id, "pending", 30006);
      trace.save(id, "saved", 30007);
      trace.save(id, "undone", 30008);
    }
    const snapshot = trace.snapshot();
    expect(snapshot.records).toHaveLength(capacity);
    expect(snapshot.records.map((entry) => entry.id)).toEqual(
      ids.slice(0, capacity),
    );
    expect(snapshot.records.every((entry) => entry.save === "undone")).toBe(
      true,
    );
    expect(snapshot.counters).toMatchObject({
      captured: 2100,
      admitted: 2100,
      overflowRecords: 2100 - capacity,
      unretainedUpdates: 2100 - capacity,
      truncatedUpdates: 0,
      retries: capacity,
    });
    expect(snapshot.complete).toBe(false);
    expect(bytes(trace.exportJson())).toBeLessThanOrEqual(PACK_TRACE_MAX_BYTES);
    expect(JSON.parse(trace.exportJson())).toEqual(snapshot);
  });

  it("honors smaller limits without evicting earlier acquisitions or copy events", () => {
    const configured = { maxRecords: 2, maxBytes: 524288 };
    const trace = new PackTrace(configured);
    configured.maxRecords = 2048;
    const original = trace.capture(1, 1, 100);
    const copy = trace.copy(original, 110);
    trace.capture(2, 2, 120);
    trace.save(copy, "saved", 130);
    expect(trace.snapshot()).toMatchObject({
      limits: { maxRecords: 2 },
      records: [{ id: original }, { id: copy, save: "saved" }],
      counters: { overflowRecords: 1, explicitCopies: 1 },
    });
    const byteBound = new PackTrace({ maxRecords: 2048, maxBytes: 8960 });
    byteBound.capture(0, 1, 0);
    byteBound.copy(1, 1);
    expect(byteBound.snapshot().records).toHaveLength(1);
    expect(byteBound.snapshot().counters.overflowRecords).toBe(1);
    expect(bytes(byteBound.exportJson())).toBeLessThanOrEqual(8960);
  });

  it("fits worst-width bounded numeric fields and closed enums within the 768-byte reserve", () => {
    const trace = new PackTrace();
    const id = trace.capture(0, 1, 0);
    const widestNumber = 0.0000010000000000000002;
    const worst: PackTraceRecord = {
      ...record(trace),
      id: Number.MAX_SAFE_INTEGER,
      kind: "explicit-copy",
      sourceMediaSeconds: widestNumber,
      sourceFrame: Number.MAX_SAFE_INTEGER,
      capturedMs: widestNumber,
      deferredMs: widestNumber,
      admittedMs: widestNumber,
      startedMs: widestNumber,
      processedMs: widestNumber,
      decidedMs: widestNumber,
      endedMs: widestNumber,
      savedMs: widestNumber,
      undoneMs: widestNumber,
      receiptFrame: Number.MAX_SAFE_INTEGER,
      sourceView: Number.MAX_SAFE_INTEGER,
      eventView: Number.MAX_SAFE_INTEGER,
      schedule: "replaced-by-clearer-view",
      matcher: "cancelled",
      reason: "incomplete-verification",
      save: "preview-only",
      saveAttempts: Number.MAX_SAFE_INTEGER,
    };
    expect(bytes(JSON.stringify(worst)) + 1).toBeLessThanOrEqual(768);
    trace.schedule(id, "reservoir", widestNumber);
    trace.schedule(id, "admitted", widestNumber, Number.MAX_SAFE_INTEGER);
    trace.started(id, widestNumber);
    trace.processed(id, widestNumber);
    trace.decision(id, false, "incomplete-verification", widestNumber);
    trace.save(id, "pending", widestNumber, Number.MAX_SAFE_INTEGER);
    trace.save(id, "saved", widestNumber);
    trace.save(id, "undone", widestNumber);
    trace.schedule(id, "replaced-by-clearer-view", widestNumber);
    expect(trace.snapshot().counters.truncatedUpdates).toBe(0);
    expect(record(trace).undoneMs).toBe(widestNumber);
  });

  it("reports oversized updates explicitly and preserves the last retained record", () => {
    const trace = new PackTrace();
    const id = trace.capture(0, 1, 100);
    const before = record(trace);
    // Fault injection exercises the guard against a future record-shape expansion.
    vi.spyOn(JSON, "stringify").mockReturnValueOnce("x".repeat(768));
    trace.started(id, 110);
    expect(record(trace)).toEqual(before);
    expect(trace.snapshot()).toMatchObject({
      complete: false,
      counters: {
        truncatedUpdates: 1,
        overflowRecords: 0,
        unretainedUpdates: 0,
      },
    });
    trace.started(id, 120);
    expect(record(trace).startedMs).toBe(20);
  });

  it("distinguishes missing observers from updates to unretained records", () => {
    const trace = new PackTrace();
    trace.started(undefined, 1);
    expect(trace.snapshot().counters.unretainedUpdates).toBe(0);
    trace.started(999, 1);
    trace.processed(999, 2);
    expect(trace.snapshot().counters).toMatchObject({
      unretainedUpdates: 2,
      processed: 1,
      overflowRecords: 0,
    });
  });

  it("keeps native source clocks and acquisition order separate from receipt admission order", () => {
    const trace = new PackTrace();
    const first = trace.capture(70.2, 901, 1000);
    const deferred = trace.capture(70.3, 902, 1100);
    const newer = trace.capture(70.4, 903, 1200);
    trace.schedule(first, "admitted", 1005, 1);
    trace.schedule(deferred, "reservoir", 1105);
    trace.schedule(newer, "admitted", 1205, 2);
    trace.schedule(deferred, "admitted", 1800, 3);
    trace.started(deferred, 1810);
    trace.processed(deferred, 2500);
    trace.decision(deferred, true, "verified", 2510);
    expect(trace.snapshot().records.map((entry) => entry.id)).toEqual([
      first,
      deferred,
      newer,
    ]);
    expect(record(trace, 1)).toMatchObject({
      sourceMediaSeconds: 70.3,
      sourceFrame: 902,
      capturedMs: 100,
      deferredMs: 105,
      admittedMs: 800,
      startedMs: 810,
      processedMs: 1500,
      decidedMs: 1510,
      receiptFrame: 3,
      matcher: "accepted",
      reason: "verified",
    });
    expect(record(trace, 2).receiptFrame).toBe(2);
  });

  it("preserves failed-save retry, durable save, Undo and explicit-copy diagnostic links", () => {
    const trace = new PackTrace();
    const source = trace.capture(1.5, 45, 100);
    trace.decision(source, true, "verified", 110);
    trace.save(source, "pending", 120, source);
    trace.save(source, "failed", 130);
    expect(record(trace)).toMatchObject({
      save: "failed",
      savedMs: null,
      saveAttempts: 1,
    });
    trace.save(source, "pending", 140);
    trace.save(source, "saved", 150);
    const copy = trace.copy(source, 160);
    expect(record(trace, 1)).toMatchObject({
      id: copy,
      kind: "explicit-copy",
      sourceView: source,
      eventView: copy,
      sourceMediaSeconds: null,
      sourceFrame: null,
      capturedMs: null,
      decidedMs: 60,
      matcher: "not-run",
      reason: "explicit-copy",
      save: "pending",
      saveAttempts: 1,
    });
    trace.save(copy, "saved", 170);
    trace.save(copy, "undone", 180);
    const duplicate = trace.capture(2, 60, 190);
    trace.save(duplicate, "duplicate", 200, source);
    expect(record(trace)).toMatchObject({
      save: "saved",
      savedMs: 50,
      saveAttempts: 2,
    });
    expect(record(trace, 1)).toMatchObject({
      save: "undone",
      savedMs: 70,
      undoneMs: 80,
    });
    expect(record(trace, 2)).toMatchObject({
      save: "duplicate",
      eventView: source,
    });
    expect(trace.snapshot().counters).toMatchObject({
      captured: 2,
      explicitCopies: 1,
      saveFailed: 1,
      retries: 1,
      saveSucceeded: 2,
      undoSucceeded: 1,
    });
  });

  it("records control transitions, cancellation and worker failures without inventing recognition", () => {
    const trace = new PackTrace();
    const pending = trace.capture(0, 1, 100);
    trace.control("paused");
    trace.control("paused");
    trace.control("active");
    trace.control("active");
    trace.control("draining");
    trace.control("drained");
    expect(trace.snapshot()).toMatchObject({
      state: "drained",
      counters: { pauses: 1, resumes: 1 },
    });
    trace.schedule(pending, "cancelled", 110);
    expect(record(trace)).toMatchObject({
      matcher: "cancelled",
      reason: "cancelled",
      endedMs: 10,
    });
    const verified = trace.capture(1, 2, 120);
    trace.decision(verified, true, "verified", 130);
    trace.save(verified, "pending", 140);
    trace.cancelResult(verified, 150);
    expect(record(trace, 1)).toMatchObject({
      matcher: "accepted",
      save: "cancelled",
      endedMs: 50,
    });
    const error = trace.capture(2, 3, 160);
    trace.workerError(error, 170);
    expect(record(trace, 2)).toMatchObject({
      matcher: "error",
      reason: "worker-error",
      endedMs: 70,
    });
  });

  it("returns defensive records, counters, and limits from snapshots", () => {
    const trace = new PackTrace();
    trace.capture(1, 1, 100);
    const snapshot = trace.snapshot();
    snapshot.records[0].sourceMediaSeconds = 999;
    snapshot.records[0].reason = "worker-error";
    snapshot.records.push({ ...snapshot.records[0], id: 999 });
    snapshot.counters.captured = 999;
    snapshot.limits.maxRecords = 999;
    snapshot.state = "cancelled";
    expect(trace.snapshot()).toMatchObject({
      state: "active",
      limits: { maxRecords: 2048 },
      counters: { captured: 1 },
      records: [{ id: 1, sourceMediaSeconds: 1, reason: "pending" }],
    });
    expect(trace.snapshot().records).toHaveLength(1);
  });
});

describe("Pack trace runtime sanitization and observer isolation", () => {
  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    privateText,
    null,
    {},
  ])(
    "rejects invalid numeric metadata without serializing it: %s",
    (invalid) => {
      const trace = new PackTrace();
      const id = trace.capture(
        asNumber(invalid),
        asNumber(invalid),
        asNumber(invalid),
      );
      trace.schedule(id, "admitted", asNumber(invalid), asNumber(invalid));
      trace.save(id, "saved", asNumber(invalid), asNumber(invalid));
      trace.copy(asNumber(invalid), asNumber(invalid));
      expect(record(trace)).toMatchObject({
        sourceMediaSeconds: null,
        sourceFrame: null,
        capturedMs: null,
        admittedMs: null,
        receiptFrame: null,
        eventView: null,
        savedMs: null,
      });
      expect(record(trace, 1).sourceView).toBeNull();
      expect(trace.snapshot().counters.invalidMetadata).toBeGreaterThan(0);
      expect(trace.snapshot().complete).toBe(false);
      expect(trace.exportJson()).not.toContain(privateText);
    },
  );

  it("does not coerce or invoke hostile metadata objects and rejects invalid closed enums", () => {
    const poison = {
      toJSON: vi.fn(() => {
        throw new Error(privateText);
      }),
      valueOf: vi.fn(() => {
        throw new Error(privateText);
      }),
      toString: vi.fn(() => {
        throw new Error(privateText);
      }),
    };
    const trace = new PackTrace();
    const id = trace.capture(
      asNumber(poison),
      asNumber(poison),
      asNumber(poison),
    );
    trace.schedule(id, privateText as PackTraceSchedule, 0);
    trace.decision(id, true, privateText as PackTraceReason, 0);
    trace.decision(id, privateText as unknown as boolean, "verified", 0);
    trace.save(id, privateText as PackTraceSave, 0);
    trace.control(privateText as PackTraceState);
    expect(record(trace)).toMatchObject({
      schedule: "captured",
      matcher: "pending",
      save: "none",
    });
    expect(trace.exportJson()).not.toContain(privateText);
    expect(poison.toJSON).not.toHaveBeenCalled();
    expect(poison.valueOf).not.toHaveBeenCalled();
    expect(poison.toString).not.toHaveBeenCalled();
  });

  it("accepts finite nonnegative media times while requiring positive safe integer frame links", () => {
    const trace = new PackTrace();
    const id = trace.capture(Number.MIN_VALUE, 1.5, 100);
    trace.schedule(id, "admitted", 101, 0);
    trace.save(id, "duplicate", 102, 1.5);
    trace.copy(0, 103);
    expect(record(trace)).toMatchObject({
      sourceMediaSeconds: Number.MIN_VALUE,
      sourceFrame: null,
      receiptFrame: null,
      eventView: null,
    });
    expect(record(trace, 1).sourceView).toBeNull();
    trace.started(id, 99);
    expect(record(trace).startedMs).toBeNull();
    expect(trace.snapshot().counters.invalidMetadata).toBeGreaterThanOrEqual(2);
  });

  it.each<[string, (value: CardDetection) => void, PackTraceReason]>([
    [
      "deferred",
      (value) => {
        value.deferred = true;
      },
      "deferred",
    ],
    [
      "quality",
      (value) => {
        value.quality.issues = [privateText];
      },
      "quality-issues",
    ],
    [
      "ambiguous",
      (value) => {
        value.state = "ambiguous";
      },
      "ambiguous-identity",
    ],
    [
      "no candidate",
      (value) => {
        value.candidates = [];
      },
      "no-candidate",
    ],
    [
      "geometry",
      (value) => {
        value.candidates[0].geometricallyVerified = false;
      },
      "geometry-unverified",
    ],
    [
      "ineligible",
      (value) => {
        value.autoEligible = false;
      },
      "ineligible",
    ],
    [
      "state",
      (value) => {
        value.state = "unknown";
      },
      "unverified-state",
    ],
    [
      "reference",
      (value) => {
        value.candidates[0].reference.name = "";
      },
      "missing-reference",
    ],
    ["fallback", () => {}, "geometry-gate"],
  ])(
    "classifies %s rejection without retaining detection text, identity, URLs, or images",
    (_, change, expected) => {
      const value = detection();
      change(value);
      expect(packTraceRejection(value)).toBe(expected);
      const trace = new PackTrace();
      const id = trace.capture(1, 1, 100);
      trace.decision(id, false, packTraceRejection(value), 110);
      const exported = trace.exportJson();
      expect(exported).not.toContain(privateText);
      for (const forbidden of [
        "quad",
        "quality",
        "candidates",
        "reference",
        "imageUrl",
        "sourceUrl",
        "crop",
        "identityKey",
        "collectionId",
      ])
        expect(Object.keys(record(trace))).not.toContain(forbidden);
      expect(record(trace).matcher).toBe("rejected");
    },
  );

  it("does not call absent observers and preserves a successful observer return value", () => {
    const observer = vi.fn((trace: PackTrace) => trace.capture(0, 1, 0));
    expect(observePackTrace(undefined, observer)).toBeUndefined();
    expect(observePackTrace(null, observer)).toBeUndefined();
    expect(observer).not.toHaveBeenCalled();
    expect(observePackTrace(new PackTrace(), observer)).toBe(1);
  });

  it("isolates observer exceptions and records diagnostics failure without leaking error text", () => {
    const trace = new PackTrace();
    const observer = () => {
      throw new Error(privateText);
    };
    expect(observePackTrace(trace, observer)).toBeUndefined();
    expect(trace.snapshot()).toMatchObject({
      complete: false,
      counters: { observerErrors: 1 },
    });
    expect(trace.exportJson()).not.toContain(privateText);
    vi.spyOn(trace, "noteFailure").mockImplementation(observer);
    expect(() => observePackTrace(trace, observer)).not.toThrow();
    expect(trace.capture(0, 1, 0)).toBe(1);
  });
});
