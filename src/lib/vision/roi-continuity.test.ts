import { createRequire } from "node:module";
import type * as OpenCv from "@techstark/opencv-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RoiContinuityGuard } from "./roi-continuity";
import type {
  RoiContinuityFrame,
  RoiContinuityOptions,
  RoiLatestCapture,
} from "./roi-continuity";
import type { Quad } from "./types";
import { syntheticCard } from "./test-fixtures";

let cv: typeof OpenCv;
beforeAll(async () => {
  cv = await (createRequire(import.meta.url)("@techstark/opencv-js") as Promise<
    typeof OpenCv
  >);
}, 30_000);
const WIDTH = 640,
  HEIGHT = 480,
  CARD_WIDTH = 96,
  CARD_HEIGHT = 134;
interface Card {
  x: number;
  y?: number;
  seed?: number;
}
const quad = (x = 230, y = 140): Quad => [
  { x, y },
  { x: x + CARD_WIDTH - 1, y },
  { x: x + CARD_WIDTH - 1, y: y + CARD_HEIGHT - 1 },
  { x, y: y + CARD_HEIGHT - 1 },
];

/** Original geometric art on a deliberately textureless background. */
function frame(
  id: number,
  cards: Card[] = [{ x: 230 }],
  timestampMs = id * 100,
): RoiContinuityFrame {
  const gray = new Uint8Array(WIDTH * HEIGHT).fill(65);
  for (const c of cards) {
    const art = syntheticCard(c.seed ?? 1),
      top = c.y ?? 140;
    for (let y = 0; y < CARD_HEIGHT; y++)
      for (let x = 0; x < CARD_WIDTH; x++) {
        const tx = c.x + x,
          ty = top + y;
        if (tx >= 0 && tx < WIDTH && ty >= 0 && ty < HEIGHT)
          gray[ty * WIDTH + tx] =
            art.data[
              (Math.floor((y * art.height) / CARD_HEIGHT) * art.width +
                Math.floor((x * art.width) / CARD_WIDTH)) *
                4
            ];
      }
  }
  return { width: WIDTH, height: HEIGHT, gray, frameId: id, timestampMs };
}
const latest = (
  f: RoiContinuityFrame,
  checkedAtTimestampMs = f.timestampMs,
): RoiLatestCapture => ({
  frameId: f.frameId,
  timestampMs: f.timestampMs,
  checkedAtTimestampMs,
});
function arm(options: RoiContinuityOptions = {}): RoiContinuityGuard {
  const g = new RoiContinuityGuard(cv, options);
  expect(
    g.arm({
      eventId: "verified-presentation",
      geometryVerified: true,
      quad: quad(),
      frame: frame(0),
    }),
  ).toMatchObject({ status: "pending", reason: "more-samples" });
  return g;
}

describe("card-only current ROI continuity (actual shared OpenCV)", () => {
  it("accepts a still card through two fresh captures without outside texture or invented identity observations", () => {
    const g = arm();
    try {
      const captures = [frame(1), frame(2)];
      const result = g.replay(captures, latest(captures[1]));
      expect(result).toMatchObject({
        status: "continuous",
        kind: "verified-roi-continuity",
        identityObservations: 0,
        exitEvidence: false,
        seedFrameId: 0,
        latestFrameId: 2,
        latestTimestampMs: 200,
        durationMs: 200,
        postSeedSamples: 2,
      });
      if (result.status === "continuous")
        for (let i = 0; i < 4; i++) {
          expect(result.latestQuad[i].x).toBeCloseTo(quad()[i].x, 1);
          expect(result.latestQuad[i].y).toBeCloseTo(quad()[i].y, 1);
        }
    } finally {
      g.dispose();
    }
  });

  it("accepts legitimately identical pixel buffers only when their capture IDs and times advance", () => {
    const g = arm(),
      seed = frame(0);
    try {
      const captures = [
        { ...seed, frameId: 1, timestampMs: 100 },
        { ...seed, frameId: 2, timestampMs: 200 },
      ];
      expect(g.replay(captures, latest(captures[1])).status).toBe("continuous");
    } finally {
      g.dispose();
    }
  });

  it.each([1, 2])(
    "follows original synthetic ±%i pixel translation jitter",
    (amplitude) => {
      const g = arm();
      try {
        const captures = Array.from({ length: 6 }, (_, j) => {
          const i = j + 1;
          return frame(i, [
            {
              x: 230 + (i % 2 ? amplitude : -amplitude),
              y: 140 + (i % 3 ? -amplitude : amplitude),
            },
          ]);
        });
        const result = g.replay(captures, latest(captures.at(-1)!));
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "continuous",
          latestFrameId: 6,
        });
      } finally {
        g.dispose();
      }
    },
  );

  it.each([
    { gain: 1, offset: 14 },
    { gain: 0.95, offset: 12 },
    { gain: 1, offset: -14 },
  ])(
    "tolerates bounded global lighting $gain/$offset against the immutable seed",
    (lighting) => {
      const g = arm();
      try {
        const captures = [
          frame(1, [{ x: 231, y: 141 }]),
          frame(2, [{ x: 229, y: 139 }]),
        ];
        for (const f of captures)
          for (let i = 0; i < f.gray.length; i++)
            f.gray[i] = Math.round(
              Math.max(
                0,
                Math.min(255, f.gray[i] * lighting.gain + lighting.offset),
              ),
            );
        const result = g.replay(captures, latest(captures[1]));
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "continuous",
        });
        if (result.status === "continuous") {
          expect(result.appearance.gain).toBeCloseTo(lighting.gain, 1);
          // Integer pixel rounding and subpixel LK interpolation affect the fitted
          // offset slightly; the acceptance gate itself remains unchanged.
          expect(
            Math.abs(result.appearance.offset - lighting.offset),
          ).toBeLessThan(1);
        }
      } finally {
        g.dispose();
      }
    },
  );

  it.each([
    "different-card",
    "occlusion",
    "glare",
    "blank",
    "removed",
  ] as const)("rejects %s before claiming current continuity", (mode) => {
    const g = arm();
    try {
      const changed = frame(
        2,
        mode === "removed"
          ? []
          : [{ x: 230, seed: mode === "different-card" ? 99 : 1 }],
      );
      if (mode === "blank") changed.gray.fill(65);
      if (mode === "occlusion" || mode === "glare")
        for (let y = 190; y < 225; y++)
          for (let x = 237; x < 320; x++)
            changed.gray[y * WIDTH + x] = mode === "glare" ? 255 : 35;
      const result = g.replay([frame(1), changed], latest(changed));
      expect(result).toMatchObject({
        status: "rejected",
        identityObservations: 0,
        exitEvidence: false,
      });
      expect(g.snapshot()).toMatchObject({
        active: false,
        retainedFrames: 0,
        pointCount: 0,
        appearanceAnchors: 0,
      });
      expect(g.replay([frame(3), frame(4)], latest(frame(4))).status).toBe(
        "rejected",
      );
    } finally {
      g.dispose();
    }
  });

  it("uses dense appearance anchors to reject changed flat regions with surviving feature support", () => {
    const g = arm();
    try {
      const changed = frame(2);
      // A light-colored rectangle across a relatively plain part of the card.
      for (let y = 158; y < 176; y++)
        for (let x = 253; x < 312; x++) changed.gray[y * WIDTH + x] = 190;
      expect(g.replay([frame(1), changed], latest(changed)).status).toBe(
        "rejected",
      );
    } finally {
      g.dispose();
    }
  });

  it("rejects excessive lighting change instead of normalizing all changes away", () => {
    const g = arm();
    try {
      const f = frame(1);
      for (let i = 0; i < f.gray.length; i++)
        f.gray[i] = Math.min(255, f.gray[i] + 45);
      expect(g.replay([f], latest(f))).toMatchObject({ status: "rejected" });
    } finally {
      g.dispose();
    }
  });

  it("requires two post-seed captures and a nonzero minimum duration", () => {
    const g = arm();
    try {
      expect(
        g.replay([frame(1, undefined, 40)], {
          frameId: 1,
          timestampMs: 40,
          checkedAtTimestampMs: 40,
        }),
      ).toMatchObject({ status: "pending", reason: "more-samples" });
      expect(
        g.replay([frame(2, undefined, 80)], {
          frameId: 2,
          timestampMs: 80,
          checkedAtTimestampMs: 80,
        }),
      ).toMatchObject({ status: "pending", reason: "duration-too-short" });
      expect(g.replay([frame(3)], latest(frame(3))).status).toBe("continuous");
    } finally {
      g.dispose();
    }
  });

  it.each([
    "duplicate-id",
    "duplicate-time",
    "reordered",
    "missing-frame",
    "sample-gap",
    "missing-latest",
  ] as const)(
    "rejects %s rather than extrapolating omitted captures",
    (mode) => {
      const g = arm();
      try {
        let captures = [frame(1), frame(2)];
        if (mode === "duplicate-id") captures[1].frameId = 1;
        if (mode === "duplicate-time") captures[1].timestampMs = 100;
        if (mode === "reordered") captures = [frame(2), frame(1)];
        if (mode === "missing-frame") captures[1].frameId = 3;
        if (mode === "sample-gap") captures[1].timestampMs = 500;
        const result = g.replay(
          captures,
          mode === "missing-latest" ? latest(frame(3)) : latest(captures[1]),
        );
        expect(result.status).toBe("rejected");
        expect(g.snapshot().postSeedSamples).toBe(0); // Entire batch preflight is atomic.
      } finally {
        g.dispose();
      }
    },
  );

  it("withholds stale results while retaining measured state for a genuinely fresh tail", () => {
    const g = arm();
    try {
      const captures = [frame(1), frame(2)];
      expect(g.replay(captures, latest(captures[1], 501))).toMatchObject({
        status: "pending",
        reason: "latest-capture-stale",
      });
      expect(g.snapshot().active).toBe(true);
      const tail = frame(3, undefined, 500);
      expect(g.replay([tail], latest(tail, 510)).status).toBe("continuous");
    } finally {
      g.dispose();
    }
  });

  it("includes replay processing time in its latest-frame freshness decision", () => {
    const g = arm();
    let calls = 0;
    const spy = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (calls++ === 0 ? 1000 : 1500));
    try {
      expect(g.replay([frame(1), frame(2)], latest(frame(2)))).toMatchObject({
        status: "pending",
        reason: "latest-capture-stale",
      });
    } finally {
      spy.mockRestore();
      g.dispose();
    }
  });

  it.each(["paused", "hidden", "unmounted", "source-changed"] as const)(
    "permanently cancels on %s and refuses late rearming",
    (reason) => {
      const g = arm();
      try {
        expect(g.invalidate(reason)).toMatchObject({
          status: "rejected",
          reason,
        });
        expect(g.replay([frame(1), frame(2)], latest(frame(2)))).toMatchObject({
          status: "rejected",
          reason,
        });
        expect(
          g.arm({
            eventId: "late",
            geometryVerified: true,
            quad: quad(),
            frame: frame(3),
          }),
        ).toMatchObject({ status: "rejected", reason });
        expect(g.snapshot().retainedFrames).toBe(0);
      } finally {
        g.dispose();
      }
    },
  );

  it("rejects unverified seeds, low-detail seeds, and changed resolution", () => {
    const unverified = new RoiContinuityGuard(cv),
      flat = new RoiContinuityGuard(cv),
      resized = arm();
    try {
      expect(
        unverified.arm({
          eventId: "x",
          geometryVerified: false as unknown as true,
          quad: quad(),
          frame: frame(0),
        }),
      ).toMatchObject({ status: "rejected", reason: "geometry-unverified" });
      expect(
        flat.arm({
          eventId: "x",
          geometryVerified: true,
          quad: quad(),
          frame: frame(0, []),
        }),
      ).toMatchObject({ status: "rejected", reason: "insufficient-features" });
      const f = { ...frame(1), width: 480, height: 640 };
      expect(resized.replay([f], latest(f))).toMatchObject({
        status: "rejected",
        reason: "frame-size-changed",
      });
    } finally {
      unverified.dispose();
      flat.dispose();
      resized.dispose();
    }
  });

  it("rejects preview clipping instead of projecting unseen corners", () => {
    const g = new RoiContinuityGuard(cv);
    try {
      expect(
        g.arm({
          eventId: "near-edge",
          geometryVerified: true,
          quad: quad(20),
          frame: frame(0, [{ x: 20 }]),
        }).status,
      ).toBe("pending");
      const captures = [frame(1, [{ x: 12 }]), frame(2, [{ x: 4 }])];
      expect(g.replay(captures, latest(captures[1]))).toMatchObject({
        status: "rejected",
        reason: "preview-clipped",
      });
    } finally {
      g.dispose();
    }
  });

  it("can follow camera/card translation but never emits absence or exit evidence", () => {
    const g = arm();
    try {
      const captures = [
        frame(1, [{ x: 238 }]),
        frame(2, [{ x: 246 }]),
        frame(3, [{ x: 254 }]),
      ];
      const result = g.replay(captures, latest(captures[2]));
      expect(result).toMatchObject({
        status: "continuous",
        exitEvidence: false,
        identityObservations: 0,
      });
      if (result.status === "continuous")
        expect(result.latestQuad[0].x).toBeCloseTo(254, 0);
    } finally {
      g.dispose();
    }
  });

  it("keeps identical-card ROIs independent when only one is replaced", () => {
    const a = new RoiContinuityGuard(cv),
      b = new RoiContinuityGuard(cv);
    const seed = frame(0, [{ x: 130 }, { x: 370 }]);
    try {
      for (const [guard, eventId, x] of [
        [a, "a", 130],
        [b, "b", 370],
      ] as const)
        expect(
          guard.arm({
            eventId,
            geometryVerified: true,
            quad: quad(x),
            frame: seed,
          }).status,
        ).toBe("pending");
      const captures = [
        frame(1, [{ x: 131 }, { x: 369 }]),
        frame(2, [{ x: 129 }, { x: 371, seed: 99 }]),
      ];
      expect(a.replay(captures, latest(captures[1]))).toMatchObject({
        status: "continuous",
        eventId: "a",
      });
      expect(b.replay(captures, latest(captures[1]))).toMatchObject({
        status: "rejected",
        eventId: "b",
      });
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("copies the seed and returns a detached measured quad rather than retaining caller-owned pixels", () => {
    const g = new RoiContinuityGuard(cv),
      seed = frame(0),
      geometry = quad();
    try {
      expect(
        g.arm({
          eventId: "owned-copy",
          geometryVerified: true,
          quad: geometry,
          frame: seed,
        }).status,
      ).toBe("pending");
      seed.gray.fill(0);
      geometry[0].x = 1;
      const result = g.replay([frame(1), frame(2)], latest(frame(2)));
      expect(result.status).toBe("continuous");
      if (result.status === "continuous") result.latestQuad[0].x = 1;
      const again = g.replay([frame(3)], latest(frame(3)));
      expect(again.status).toBe("continuous");
      if (again.status === "continuous")
        expect(again.latestQuad[0].x).toBeCloseTo(230, 1);
    } finally {
      g.dispose();
    }
  });

  it("supports measured delayed history in small replay batches without retaining a video ring", () => {
    const g = arm();
    try {
      for (let batch = 0; batch < 6; batch++) {
        const captures = Array.from({ length: 8 }, (_, j) => {
          const i = batch * 8 + j + 1;
          return frame(i, [{ x: 230 + (i % 2 ? 1 : -1) }]);
        });
        const last = captures.at(-1)!;
        // Intermediate batches are older than the actual newest capture.
        const result = g.replay(captures, latest(last, 4800));
        expect(result.status).toBe(batch === 5 ? "continuous" : "pending");
        expect(g.snapshot()).toMatchObject({
          retainedFrames: 1,
          postSeedSamples: (batch + 1) * 8,
        });
      }
    } finally {
      g.dispose();
    }
  });

  it("bounds points, appearance anchors, native frame retention, samples, duration, and supplied history bytes", () => {
    const g = arm({ maxSamples: 2 }),
      duration = arm({ maxDurationMs: 200 }),
      bytes = arm();
    try {
      expect(g.snapshot()).toMatchObject({ retainedFrames: 1 });
      expect(g.snapshot().pointCount).toBeLessThanOrEqual(48);
      expect(g.snapshot().appearanceAnchors).toBeLessThanOrEqual(192);
      expect(
        g.replay([frame(1), frame(2), frame(3)], latest(frame(3))),
      ).toMatchObject({ status: "rejected", reason: "history-overflow" });
      expect(
        duration.replay(
          [frame(1), frame(2, undefined, 300)],
          latest(frame(2, undefined, 300)),
        ),
      ).toMatchObject({ status: "rejected", reason: "duration-overflow" });
      const pixels = frame(0),
        history = Array.from({ length: 110 }, (_, i) => ({
          ...pixels,
          frameId: i + 1,
          timestampMs: (i + 1) * 100,
        }));
      expect(bytes.replay(history, latest(history.at(-1)!))).toMatchObject({
        status: "rejected",
        reason: "history-overflow",
      });
      expect(bytes.snapshot().retainedFrames).toBe(0);
    } finally {
      g.dispose();
      duration.dispose();
      bytes.dispose();
    }
  });

  it("reports synthetic replay cost when explicitly requested", () => {
    if (process.env.TCG_ROI_BENCHMARK !== "1") return;
    const perFrame: number[] = [],
      armTimes: number[] = [];
    for (let run = 0; run < 5; run++) {
      const g = new RoiContinuityGuard(cv);
      const seed = frame(0),
        captures = Array.from({ length: 10 }, (_, j) =>
          frame(j + 1, [{ x: 230 + ((j + 1) % 2 ? 2 : -2) }]),
        );
      try {
        const start = performance.now();
        expect(
          g.arm({
            eventId: `run-${run}`,
            geometryVerified: true,
            quad: quad(),
            frame: seed,
          }).status,
        ).toBe("pending");
        const armMs = performance.now() - start;
        const result = g.replay(captures, latest(captures.at(-1)!));
        expect(result.status).toBe("continuous");
        if (run > 0) {
          armTimes.push(armMs);
          perFrame.push(result.processingMs / captures.length);
        }
      } finally {
        g.dispose();
      }
    }
    perFrame.sort((a, b) => a - b);
    console.info(
      JSON.stringify({
        benchmark: "roi-continuity/original-synthetic",
        width: WIDTH,
        height: HEIGHT,
        measuredFrames: 40,
        batchSize: 10,
        meanPerFrameMs: perFrame.reduce((a, b) => a + b, 0) / perFrame.length,
        slowestBatchMeanPerFrameMs: perFrame.at(-1),
        meanArmMs: armTimes.reduce((a, b) => a + b, 0) / armTimes.length,
      }),
    );
  });
});
