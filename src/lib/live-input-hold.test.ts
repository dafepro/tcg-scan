import { afterEach, describe, expect, it, vi } from "vitest";
import { holdLiveVideoInput } from "./live-input-hold";
import { LiveCaptureLoop } from "./live-capture";
import type { LiveCaptureContext } from "./live-capture";
import { PrintingSession } from "./printing-session";
import { parsePrintingObservation } from "./printing-refinement";
import type { PrintingReadInput } from "./printing-refinement";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function harness() {
  const ocr = gate(),
    matcher = gate();
  let held = false,
    paused = false,
    running = true,
    epoch = 0,
    frames = 0;
  const reference = {
    key: "pokemon:a",
    name: "Pikachu",
    game: "pokemon" as const,
    identityKey: "pokemon:pikachu",
    number: "25",
    printedTotal: 198,
  };
  const read = vi.fn(async (input: PrintingReadInput) => {
    await ocr.promise;
    return parsePrintingObservation({
      ...input,
      imageFingerprint: input.frameId,
      rawText: "",
    });
  });
  const readerDisposed = vi.fn();
  const guidance = vi.fn(),
    diagnostics = vi.fn(),
    refined = vi.fn(() => undefined);
  const printing = new PrintingSession({
    reader: () => ({ read, dispose: readerDisposed, busy: false }),
    catalog: async () => ({
      candidates: [reference, { ...reference, key: "pokemon:b", number: "26" }],
      catalogCompleteForIdentity: true,
      scope: "Controlled test catalog",
    }),
    // An input hold intentionally does not revoke ownership of already offered pixels.
    isCurrent: () => running && !paused,
    onStatus: vi.fn(),
    onGuidance: guidance,
    onDiagnostics: diagnostics,
    onResolution: refined,
  });
  const commits = vi.fn();
  const capture = vi.fn(async () => ({
    image: { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) },
    capturedAt: ++frames * 2000,
    transport: "videoframe-pool" as const,
  }));
  const onFrame = vi.fn(async (context: LiveCaptureContext) => {
    const frameEpoch = epoch;
    if (held) return;
    void printing.offer({
      reference,
      sessionId: "session",
      eventId: "saved-event",
      frameId: `native-${context.frameId}`,
      capturedAt: context.capture.capturedAt,
      sourceMinEdge: 600,
      image: { width: 600, height: 840 } as ImageData,
    });
    await matcher.promise;
    if (context.isCurrent() && frameEpoch === epoch && !held) commits();
  });
  const loop = new LiveCaptureLoop({
    video: {} as HTMLVideoElement,
    client: { busy: false, takeFrameBuffer: (n) => new ArrayBuffer(n) },
    frameLimit: 1920,
    capture: { capture, dispose: vi.fn(), minimumIntervalMs: 120 },
    onFrame,
    onTransport: vi.fn(),
    onError: vi.fn(),
  });
  const source = { pause: vi.fn() };
  const interruptEvidence = vi.fn(() => {
    epoch++;
  });
  const cancelPendingFrame = vi.fn();
  return {
    loop,
    printing,
    capture,
    onFrame,
    source,
    interruptEvidence,
    cancelPendingFrame,
    ocr,
    matcher,
    guidance,
    diagnostics,
    refined,
    read,
    readerDisposed,
    commits,
    hold() {
      held = true;
      holdLiveVideoInput({
        source,
        capture: loop,
        interruptEvidence,
        cancelPendingFrame,
      });
    },
    resume() {
      held = false;
      loop.resume();
    },
    pause() {
      held = false;
      paused = true;
      printing.cancel();
      loop.pause();
      source.pause();
      epoch++;
    },
    end() {
      held = false;
      running = false;
      printing.dispose();
      loop.dispose();
      epoch++;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("diagnostic input hold with the real Live loop and PrintingSession", () => {
  it("lets a pending read produce its real prompt without new views or stale identity commits", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.printing.busy).toBe(true);
    h.hold();
    const captures = h.capture.mock.calls.length;
    expect(h.source.pause).toHaveBeenCalledOnce();
    expect(h.interruptEvidence).toHaveBeenCalledOnce();
    expect(h.cancelPendingFrame).toHaveBeenCalledOnce();
    expect(h.readerDisposed).not.toHaveBeenCalled();
    h.ocr.release();
    h.matcher.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.guidance).toHaveBeenCalledExactlyOnceWith(
      "saved-event",
      expect.stringContaining("collector number"),
    );
    expect(
      h.diagnostics.mock.calls[0][1].evidence.map(
        (item: { frameId: string }) => item.frameId,
      ),
    ).toEqual(["native-1"]);
    expect(h.capture).toHaveBeenCalledTimes(captures);
    expect(h.onFrame).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.commits).not.toHaveBeenCalled();
    expect(h.refined).not.toHaveBeenCalled();
    // Neither printing completion nor the real prompt auto-resumes input.
    expect(vi.getTimerCount()).toBe(0);
    h.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.capture).toHaveBeenCalledTimes(captures + 1);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(
      h.diagnostics.mock.calls[1][1].evidence.map(
        (item: { frameId: string }) => item.frameId,
      ),
    ).toEqual(["native-1", "native-2"]);
    expect(h.guidance).toHaveBeenCalledOnce();
    h.end();
  });

  it.each(["pause", "end"] as const)(
    "ordinary %s while held still cancels pending printing and blocks late results",
    async (action) => {
      vi.useFakeTimers();
      const h = harness();
      h.loop.start();
      await vi.advanceTimersByTimeAsync(0);
      h.hold();
      h[action]();
      expect(h.readerDisposed).toHaveBeenCalledOnce();
      h.ocr.release();
      h.matcher.release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.guidance).not.toHaveBeenCalled();
      expect(h.diagnostics).not.toHaveBeenCalled();
      expect(h.refined).not.toHaveBeenCalled();
      expect(h.commits).not.toHaveBeenCalled();
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.capture).toHaveBeenCalledOnce();
      h.end();
    },
  );
});
