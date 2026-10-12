import { createRequire } from "node:module";
import type * as OpenCv from "@techstark/opencv-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VerifiedCardExitTracker } from "./exit-tracker";
import type {
  ExitFrame,
  ExitTrackerOptions,
  VerifiedExit,
} from "./exit-tracker";
import type { Quad } from "./types";
import { syntheticCard } from "./test-fixtures";

let cv: typeof OpenCv;
beforeAll(async () => {
  cv = await (createRequire(import.meta.url)("@techstark/opencv-js") as Promise<
    typeof OpenCv
  >);
}, 30_000);

const WIDTH = 640,
  HEIGHT = 480;
const REGION = { left: 0.3, top: 0.12, right: 0.62, bottom: 0.88 };
const CARD_WIDTH = 96,
  CARD_HEIGHT = 134;
interface PlacedCard {
  x: number;
  y?: number;
  seed?: number;
}
const quad = (x = 230, y = 100): Quad => [
  { x, y },
  { x: x + CARD_WIDTH - 1, y },
  { x: x + CARD_WIDTH - 1, y: y + CARD_HEIGHT - 1 },
  { x, y: y + CARD_HEIGHT - 1 },
];

/** Original geometric art and a deterministic textured table; no photo accuracy claim. */
function frame(
  index: number,
  cards: PlacedCard[] = [{ x: 230 }],
  timestampMs = index * 80,
): ExitFrame {
  const gray = new Uint8Array(WIDTH * HEIGHT);
  let state = 729;
  for (let y = 0; y < HEIGHT; y += 12)
    for (let x = 0; x < WIDTH; x += 12) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const value = 30 + (state % 90);
      for (let yy = y; yy < Math.min(y + 12, HEIGHT); yy++)
        for (let xx = x; xx < Math.min(x + 12, WIDTH); xx++)
          gray[yy * WIDTH + xx] = value;
    }
  for (const placed of cards) {
    const art = syntheticCard(placed.seed ?? 1),
      cy = placed.y ?? 100;
    for (let y = 0; y < CARD_HEIGHT; y++)
      for (let x = 0; x < CARD_WIDTH; x++) {
        const tx = placed.x + x,
          ty = cy + y;
        if (tx >= 0 && ty >= 0 && tx < WIDTH && ty < HEIGHT)
          gray[ty * WIDTH + tx] =
            art.data[
              (Math.floor((y * art.height) / CARD_HEIGHT) * art.width +
                Math.floor((x * art.width) / CARD_WIDTH)) *
                4
            ];
      }
  }
  return { width: WIDTH, height: HEIGHT, gray, frameId: index, timestampMs };
}

function shifted(f: ExitFrame, dx: number, dy: number): ExitFrame {
  const gray = new Uint8Array(f.gray.length).fill(60);
  for (let y = 0; y < f.height; y++)
    for (let x = 0; x < f.width; x++) {
      const sx = x - dx,
        sy = y - dy;
      if (sx >= 0 && sx < f.width && sy >= 0 && sy < f.height)
        gray[y * f.width + x] = f.gray[sy * f.width + sx];
    }
  return { ...f, gray };
}

function tracker(
  options: Partial<ExitTrackerOptions> = {},
): VerifiedCardExitTracker {
  return new VerifiedCardExitTracker(cv, { region: REGION, ...options });
}

function armed(
  options: Partial<ExitTrackerOptions> = {},
): VerifiedCardExitTracker {
  const t = tracker(options);
  expect(
    t.arm({
      eventId: "same-identity/presentation-1",
      geometryVerified: true,
      quad: quad(),
      frame: frame(0),
    }),
  ).toEqual({ armed: true });
  return t;
}

function move(t: VerifiedCardExitTracker, start = 1, end = 26): VerifiedExit[] {
  const exits: VerifiedExit[] = [];
  for (let i = start; i <= end; i++) {
    const result = t.ingest(frame(i, [{ x: 230 + i * 8 }]));
    expect(result.cancelled, `frame ${i}: ${JSON.stringify(result)}`).toEqual(
      [],
    );
    exits.push(...result.exits);
  }
  return exits;
}

describe("verified-card inner-region exit tracking (actual shared OpenCV in Node)", () => {
  it("emits one full measured exit and permits a fresh presentation event for the same identity", () => {
    const t = armed();
    try {
      const exits = move(t);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        eventId: "same-identity/presentation-1",
        kind: "verified-roi-exit",
      });
      expect(exits[0].quad.every((p) => p.x > WIDTH * REGION.right + 3)).toBe(
        true,
      );
      expect(exits[0].supportingPoints).toBeGreaterThanOrEqual(20);
      expect(
        t.arm({
          eventId: exits[0].eventId,
          geometryVerified: true,
          quad: quad(),
          frame: frame(30),
        }).reason,
      ).toBe("event-already-armed");
      expect(
        t.arm({
          eventId: "same-identity/presentation-2",
          geometryVerified: true,
          quad: quad(),
          frame: frame(30),
        }),
      ).toEqual({ armed: true });
      expect(t.snapshot().usedEvents).toBe(2);
    } finally {
      t.dispose();
    }
  });

  it("does not release for a partial exit, including a center outside the region", () => {
    const t = armed();
    try {
      expect(move(t, 1, 17)).toEqual([]); // Left edge is still inside the scan box.
      for (let i = 18; i < 21; i++)
        expect(t.ingest(frame(i, [{ x: 366 }])).exits).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it.each(["occlusion", "glare", "blank", "different-card"] as const)(
    "cancels %s without interpreting lost features as absence",
    (mode) => {
      const t = armed();
      try {
        expect(move(t, 1, 5)).toEqual([]);
        const f = frame(6, [
          { x: 278, seed: mode === "different-card" ? 99 : 1 },
        ]);
        if (mode === "blank") f.gray.fill(80);
        else if (mode !== "different-card") {
          for (let y = 100; y < 234; y++)
            for (let x = 278; x < 374; x++)
              f.gray[y * WIDTH + x] = mode === "glare" ? 255 : 35;
        }
        const result = t.ingest(f);
        expect(result.exits).toEqual([]);
        expect(result.cancelled).toHaveLength(1);
        expect(t.snapshot().active).toBe(0);
        for (let i = 7; i < 30; i++)
          expect(t.ingest(frame(i, [{ x: 230 + i * 8 }])).exits).toEqual([]);
      } finally {
        t.dispose();
      }
    },
  );

  it("does not accumulate outside evidence from repeated image buffers or stationary frames", () => {
    const t = armed();
    try {
      expect(move(t, 1, 22)).toEqual([]); // Exactly one genuinely moving outside sample.
      for (let i = 23; i < 31; i++) {
        const result = t.ingest(frame(i, [{ x: 406 }]));
        expect(result.exits).toEqual([]);
      }
      expect(t.snapshot().active).toBe(0); // Repeated capture eventually cancels the gap.
    } finally {
      t.dispose();
    }
  });

  it.each(["timestamp", "sequence", "gap"] as const)(
    "cancels a %s discontinuity",
    (mode) => {
      const t = armed();
      try {
        expect(move(t, 1, 2)).toEqual([]);
        const f = frame(
          mode === "sequence" ? 1 : 3,
          [{ x: 254 }],
          mode === "timestamp" ? 80 : mode === "gap" ? 900 : 240,
        );
        const result = t.ingest(f);
        expect(result.exits).toEqual([]);
        expect(result.cancelled[0].reason).toBe(
          mode === "gap" ? "sample-gap" : "frame-reordered",
        );
      } finally {
        t.dispose();
      }
    },
  );

  it("rejects camera pan rather than confusing whole-scene motion with a card exit", () => {
    const t = armed();
    try {
      const source = frame(1),
        panned = frame(1);
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 8; x < WIDTH; x++)
          panned.gray[y * WIDTH + x] = source.gray[y * WIDTH + x - 8];
      const result = t.ingest(panned);
      expect(result.exits).toEqual([]);
      expect(result.cancelled).toEqual([
        { eventId: "same-identity/presentation-1", reason: "camera-motion" },
      ]);
    } finally {
      t.dispose();
    }
  });

  it.each([1, 2])(
    "allows a genuine relative card exit during measured ±%i px global translation jitter",
    (amplitude) => {
      const t = armed();
      try {
        const exits: VerifiedExit[] = [];
        for (let i = 1; i <= 26; i++) {
          const dx = i % 2 ? amplitude : -amplitude,
            dy = i % 3 ? -amplitude : amplitude;
          const result = t.ingest(
            shifted(frame(i, [{ x: 230 + i * 8 }]), dx, dy),
          );
          expect(
            result.cancelled,
            `jitter frame ${i}: ${JSON.stringify(result)}`,
          ).toEqual([]);
          exits.push(...result.exits);
        }
        expect(exits).toHaveLength(1);
      } finally {
        t.dispose();
      }
    },
  );

  it("does not mistake global jitter for card-relative motion or release a stationary card", () => {
    const t = armed();
    try {
      for (let i = 1; i <= 30; i++) {
        const result = t.ingest(
          shifted(frame(i), i % 2 ? 2 : -2, i % 3 ? -2 : 2),
        );
        expect(result.exits).toEqual([]);
        expect(result.cancelled).toEqual([]);
      }
      expect(t.snapshot().active).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("bounds translation against the initial background so a slow pan cannot drift through", () => {
    const t = armed();
    try {
      for (let i = 1; i <= 2; i++)
        expect(t.ingest(shifted(frame(i), i, 0)).cancelled).toEqual([]);
      const result = t.ingest(shifted(frame(3), 3, 0));
      expect(result.exits).toEqual([]);
      expect(result.cancelled[0].reason).toBe("camera-motion");
    } finally {
      t.dispose();
    }
  });

  it("does not transfer motion to another card that covers the armed card", () => {
    const t = armed();
    try {
      expect(move(t, 1, 5)).toEqual([]);
      // A different card is placed on top at the predicted next location, then
      // continues towards the exit. Loss must never become a new track identity.
      const result = t.ingest(frame(6, [{ x: 270 }, { x: 278, seed: 99 }]));
      expect(result.exits).toEqual([]);
      expect(result.cancelled).toHaveLength(1);
      for (let i = 7; i <= 28; i++)
        expect(
          t.ingest(frame(i, [{ x: 270 }, { x: 230 + i * 8, seed: 99 }])).exits,
        ).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it("requires measured motion even when different noisy frames remain outside", () => {
    const t = armed();
    try {
      expect(move(t, 1, 22)).toEqual([]);
      for (let i = 23; i < 31; i++) {
        const f = frame(i, [{ x: 406 }]);
        // New actual pixel buffers without card motion do not supply a second
        // progressing outside sample; tiny sensor noise is not exit motion.
        for (let p = i % 2; p < f.gray.length; p += 2) f.gray[p]++;
        const result = t.ingest(f);
        expect(result.exits).toEqual([]);
        expect(result.cancelled).toEqual([]);
      }
    } finally {
      t.dispose();
    }
  });

  it("cancels abrupt unmeasured jumps and source-size changes", () => {
    for (const mode of ["jump", "size"] as const) {
      const t = armed();
      try {
        const f = frame(1, [{ x: 540 }]);
        const result = t.ingest(
          mode === "size" ? { ...f, width: 480, height: 640 } : f,
        );
        expect(result.exits).toEqual([]);
        expect(result.cancelled).toHaveLength(1);
        if (mode === "size")
          expect(result.cancelled[0].reason).toBe("frame-size-changed");
      } finally {
        t.dispose();
      }
    }
  });

  it("will not certify an exit that clips the preview before the full quad clears", () => {
    // The left preview strip is too narrow, although the right strip can fit a
    // card. Moving toward the wrong edge must cancel rather than extrapolate.
    const t = tracker({
      region: { left: 0.08, right: 0.62, top: 0.12, bottom: 0.88 },
    });
    try {
      expect(
        t.arm({
          eventId: "wrong-edge",
          geometryVerified: true,
          quad: quad(80),
          frame: frame(0, [{ x: 80 }]),
        }),
      ).toEqual({ armed: true });
      const cancelled: string[] = [];
      for (let i = 1; i < 14; i++) {
        const result = t.ingest(frame(i, [{ x: 80 - i * 8 }]));
        expect(result.exits).toEqual([]);
        cancelled.push(...result.cancelled.map((c) => c.reason));
      }
      expect(cancelled).toHaveLength(1);
      expect(cancelled).toContain("preview-clipped");
    } finally {
      t.dispose();
    }
  });

  it("refuses startup outside the inner region and unverified geometry", () => {
    const t = tracker();
    try {
      expect(
        t.arm({
          eventId: "outside",
          geometryVerified: true,
          quad: quad(410),
          frame: frame(0, [{ x: 410 }]),
        }).reason,
      ).toBe("quad-not-inside-region");
      expect(
        t.arm({
          eventId: "unverified",
          geometryVerified: false as unknown as true,
          quad: quad(),
          frame: frame(0),
        }).reason,
      ).toBe("geometry-unverified");
    } finally {
      t.dispose();
    }
  });

  it("requires a textured stationary background and enough preview guard band", () => {
    const t = tracker(),
      f = frame(0);
    try {
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++)
          if (x < 230 || x >= 326 || y < 100 || y >= 234)
            f.gray[y * WIDTH + x] = 65;
      expect(
        t.arm({
          eventId: "no-background",
          geometryVerified: true,
          quad: quad(),
          frame: f,
        }).reason,
      ).toBe("insufficient-background-features");
      const narrowGuard = tracker({
        region: { left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 },
      });
      try {
        expect(
          narrowGuard.arm({
            eventId: "no-space",
            geometryVerified: true,
            quad: quad(),
            frame: frame(0),
          }).reason,
        ).toBe("insufficient-guard-band");
      } finally {
        narrowGuard.dispose();
      }
    } finally {
      t.dispose();
    }
  });

  it.each(["paused", "hidden", "unmounted", "source-changed"] as const)(
    "%s cancels continuity and permanently consumes this event arm",
    (reason) => {
      const t = armed();
      try {
        expect(t.invalidate(reason).cancelled[0].reason).toBe(reason);
        expect(t.snapshot()).toMatchObject({
          active: 0,
          pointCount: 0,
          retainedFrames: 0,
        });
        expect(
          t.arm({
            eventId: "same-identity/presentation-1",
            geometryVerified: true,
            quad: quad(),
            frame: frame(2),
          }).reason,
        ).toBe("event-already-armed");
        expect(t.ingest(frame(3, [{ x: 430 }])).exits).toEqual([]);
      } finally {
        t.dispose();
      }
    },
  );

  it("keeps simultaneous same-identity cards independent", () => {
    const t = tracker(),
      first = frame(0, [
        { x: 230, y: 75 },
        { x: 230, y: 260 },
      ]);
    try {
      expect(
        t.arm({
          eventId: "copy-a",
          geometryVerified: true,
          quad: quad(230, 75),
          frame: first,
        }),
      ).toEqual({ armed: true });
      expect(
        t.arm({
          eventId: "copy-b",
          geometryVerified: true,
          quad: quad(230, 260),
          frame: first,
        }),
      ).toEqual({ armed: true });
      const exits: VerifiedExit[] = [];
      for (let i = 1; i <= 26; i++) {
        const result = t.ingest(
          frame(i, [
            { x: 230 + i * 8, y: 75 },
            { x: 230, y: 260 },
          ]),
        );
        expect(result.cancelled, `frame ${i}`).toEqual([]);
        exits.push(...result.exits);
      }
      expect(exits.map((e) => e.eventId)).toEqual(["copy-a"]);
      expect(t.snapshot().active).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("rejects a second event attempting to arm the same visible card", () => {
    const t = armed();
    try {
      expect(
        t.arm({
          eventId: "duplicate-physical-track",
          geometryVerified: true,
          quad: quad(),
          frame: frame(0),
        }).reason,
      ).toBe("overlapping-track");
    } finally {
      t.dispose();
    }
  });

  it("replays genuinely captured history after delayed identity/save work without using wall-clock age", () => {
    const captures = Array.from({ length: 27 }, (_, i) =>
      frame(i, [{ x: 230 + i * 8 }]),
    );
    let clock = 1_000_000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => ++clock);
    const t = tracker();
    try {
      expect(
        t.arm({
          eventId: "delayed-save",
          geometryVerified: true,
          quad: quad(),
          frame: captures[0],
        }),
      ).toEqual({ armed: true });
      const exits = captures.slice(1).flatMap((f) => t.ingest(f).exits);
      expect(exits).toHaveLength(1);
      expect(exits[0].timestampMs).toBeLessThan(3000);
    } finally {
      t.dispose();
      spy.mockRestore();
    }
  });

  it("requires a seed-ordering barrier when another track has already advanced", () => {
    const t = tracker();
    const captures = [0, 1, 2].map((i) =>
      frame(i, [
        { x: 230 + i * 8, y: 75 },
        { x: 230, y: 260 },
      ]),
    );
    try {
      expect(
        t.arm({
          eventId: "earlier",
          geometryVerified: true,
          quad: quad(230, 75),
          frame: captures[0],
        }),
      ).toEqual({ armed: true });
      expect(t.ingest(captures[1]).cancelled).toEqual([]);
      expect(
        t.arm({
          eventId: "late-seed",
          geometryVerified: true,
          quad: quad(230, 260),
          frame: captures[0],
        }).reason,
      ).toBe("seed-is-not-current-capture");
      expect(
        t.arm({
          eventId: "current-seed",
          geometryVerified: true,
          quad: quad(230, 260),
          frame: captures[1],
        }),
      ).toEqual({ armed: true });
      expect(t.ingest(captures[2]).cancelled).toEqual([]);
      expect(t.snapshot().active).toBe(2);
    } finally {
      t.dispose();
    }
  });

  it("bounds resolution, arm ledger, point count, retained frames, and active lifetime", () => {
    const t = armed({ maxEvents: 1, maxTrackAgeMs: 100 });
    try {
      expect(t.snapshot().pointCount).toBeLessThanOrEqual(96);
      expect(t.snapshot().retainedFrames).toBe(1);
      const result = t.ingest(frame(1, [{ x: 238 }], 160));
      expect(result.cancelled[0].reason).toBe("track-expired");
      expect(
        t.arm({
          eventId: "next",
          geometryVerified: true,
          quad: quad(),
          frame: frame(3),
        }).reason,
      ).toBe("capacity");
      const oversize = { ...frame(4), width: 641 };
      expect(
        t.arm({
          eventId: "oversize",
          geometryVerified: true,
          quad: quad(),
          frame: oversize,
        }).reason,
      ).toBe("invalid-frame");
    } finally {
      t.dispose();
    }
  });

  it("reports bounded per-frame cost on original synthetic controls when requested", () => {
    if (process.env.TCG_EXIT_BENCHMARK !== "1") return;
    for (const cardCount of [1, 2]) {
      const costs: number[] = [];
      let exits = 0;
      for (let run = 0; run < 4; run++) {
        const t = tracker(),
          cards = [
            { x: 230, y: 75 },
            ...(cardCount === 2 ? [{ x: 230, y: 260 }] : []),
          ];
        try {
          for (const [index, card] of cards.entries())
            expect(
              t.arm({
                eventId: `event-${index}`,
                geometryVerified: true,
                quad: quad(card.x, card.y),
                frame: frame(0, cards),
              }),
            ).toEqual({ armed: true });
          for (let i = 1; i <= 23; i++) {
            const result = t.ingest(
              frame(i, [{ x: 230 + i * 8, y: 75 }, ...cards.slice(1)]),
            );
            expect(result.cancelled).toEqual([]);
            if (run > 0) costs.push(result.processingMs); // One warmup sequence.
            exits += result.exits.length;
          }
        } finally {
          t.dispose();
        }
      }
      expect(exits).toBe(4);
      costs.sort((a, b) => a - b);
      console.info(
        JSON.stringify({
          benchmark: "verified-exit/original-synthetic",
          width: WIDTH,
          height: HEIGHT,
          cardCount,
          measuredFrames: costs.length,
          meanMs: costs.reduce((a, b) => a + b, 0) / costs.length,
          p50Ms: costs[Math.floor(costs.length * 0.5)],
          p95Ms: costs[Math.floor(costs.length * 0.95)],
          maxMs: costs.at(-1),
        }),
      );
    }
  });
});
