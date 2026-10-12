import { describe, expect, it } from "vitest";
import { CaptureHistory } from "./capture-history";
import type { ExitFrame } from "./vision/exit-tracker";

function frame(frameId: number, changes: Partial<ExitFrame> = {}): ExitFrame {
  return {
    width: 64,
    height: 64,
    gray: new Uint8Array(4096).fill(73),
    frameId,
    timestampMs: frameId * 100,
    ...changes,
  };
}

describe("bounded pending-capture history", () => {
  it("drains ordered prefixes without losing continuity or resetting cumulative bounds", () => {
    const history = new CaptureHistory({ maxFrames: 3 }),
      token = history.begin(frame(1));
    history.append(frame(2), token);
    expect(history.drain(token)!.map((f) => f.frameId)).toEqual([1, 2]);
    expect(history.status).toMatchObject({
      open: true,
      frames: 0,
      bytes: 0,
      recordedFrames: 2,
      latestFrameId: 2,
    });
    expect(history.append(frame(3), token)).toBe(true);
    expect(history.drain(token)!.map((f) => f.frameId)).toEqual([3]);
    expect(history.append(frame(4), token)).toBe(false);
    expect(history.status.reason).toBe("history-overflow");
  });
  it("rejects a missing sample even after the preceding buffers have been drained", () => {
    const history = new CaptureHistory(),
      token = history.begin(frame(1));
    history.drain(token);
    expect(history.append(frame(3), token)).toBe(false);
    expect(history.status.reason).toBe("sample-gap");
  });
  it("retains genuinely captured identical pixels with distinct IDs/times and drains ownership once", () => {
    const history = new CaptureHistory(),
      seed = frame(1),
      token = history.begin(seed);
    seed.gray.fill(0);
    expect(history.append(frame(2), token)).toBe(true);
    expect(history.append(frame(3), token)).toBe(true);
    const result = history.take(token)!;
    expect(result.map((f) => f.frameId)).toEqual([1, 2, 3]);
    expect(result[0].gray[0]).toBe(73);
    expect(history.status).toMatchObject({ open: false, frames: 0, bytes: 0 });
    expect(history.take(token)).toBeUndefined();
    expect(history.append(frame(4), token)).toBe(false);
  });
  it.each([
    ["count", { maxFrames: 3 }],
    ["bytes", { maxBytes: 3 * 4096 }],
    ["duration", { maxDurationMs: 200 }],
  ] as const)(
    "fails closed instead of evicting history on %s overflow",
    (_, limits) => {
      const history = new CaptureHistory(limits),
        token = history.begin(frame(1));
      expect(history.append(frame(2), token)).toBe(true);
      expect(history.append(frame(3), token)).toBe(true);
      expect(history.append(frame(4), token)).toBe(false);
      expect(history.status).toMatchObject({
        open: false,
        frames: 0,
        bytes: 0,
        reason: "history-overflow",
      });
      expect(history.take(token)).toBeUndefined();
    },
  );
  it.each([
    [frame(1), "frame-reordered"],
    [frame(2, { timestampMs: 100 }), "frame-reordered"],
    [frame(3, { timestampMs: 200 }), "sample-gap"],
    [frame(2, { timestampMs: 401 }), "sample-gap"],
    [
      frame(2, { width: 65, gray: new Uint8Array(65 * 64) }),
      "frame-size-changed",
    ],
    [frame(2, { gray: new Uint8Array(3) }), "invalid-frame"],
    [frame(2, { width: 641, gray: new Uint8Array(641 * 64) }), "invalid-frame"],
    [frame(2, { timestampMs: NaN }), "invalid-frame"],
  ])("rejects invalid or missing capture evidence", (next, reason) => {
    const history = new CaptureHistory(),
      token = history.begin(frame(1));
    expect(history.append(next as ExitFrame, token)).toBe(false);
    expect(history.status.reason).toBe(reason);
    expect(history.status.bytes).toBe(0);
  });
  it("ignores stale callbacks without cancelling a newer valid session", () => {
    const history = new CaptureHistory(),
      old = history.begin(frame(1));
    history.cancel();
    const current = history.begin(frame(10));
    expect(history.append(frame(2), old)).toBe(false);
    expect(history.take(old)).toBeUndefined();
    expect(history.append(frame(11), current)).toBe(true);
    expect(history.take(current)!.map((f) => f.frameId)).toEqual([10, 11]);
  });
  it("rejects enlarged resource budgets", () => {
    for (const limits of [
      { maxFrames: 121 },
      { maxBytes: 33 * 1024 * 1024 },
      { maxDurationMs: 12_001 },
      { maxGapMs: 501 },
    ])
      expect(() => new CaptureHistory(limits)).toThrow(/bounded/);
  });
});
