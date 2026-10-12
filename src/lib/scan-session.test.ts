import { describe, it, expect } from "vitest";
import {
  ScanSession,
  type ScanContinuityCandidate,
  type ScanContinuityCommit,
} from "./scan-session";
import type { CardDetection, VisionResult } from "./vision/types";
import type { RoiContinuityResult } from "./vision/roi-continuity";
function detection(x = 0, key = "one"): CardDetection {
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
        key,
        reference: { key, game: "pokemon", name: key },
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
function result(d: CardDetection[]): VisionResult {
  return {
    width: 1000,
    height: 720,
    detections: d,
    timings: { detectionMs: 1, extractionMs: 2, matchingMs: 3, totalMs: 6 },
    coverage: {
      totalReferences: 2,
      byGame: { pokemon: 2, mtg: 0, yugioh: 0 },
      packs: ["test"],
    },
    budgetExhausted: false,
  };
}
function stable(s: ScanSession, d = [detection()], start = 0) {
  s.update(result(d), start);
  s.update(result(d), start + 150);
  return s.update(result(d), start + 300);
}
function region(
  x: number,
  y: number,
  key = "one",
  width = 100,
  height = 140,
): CardDetection {
  return {
    ...detection(x, key),
    quad: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  };
}
function unclassified(card: CardDetection): CardDetection {
  return {
    ...card,
    state: "unknown",
    autoEligible: false,
    deferred: true,
    candidates: [],
  };
}
describe("physical scan sessions", () => {
  it("counts a held card exactly once across 1000 frames and ignores stale callbacks", () => {
    const s = new ScanSession("s", "stream");
    const add = stable(s).additions[0];
    expect(add).toBeTruthy();
    s.acknowledge(add.eventId);
    for (let i = 4; i < 1004; i++)
      expect(s.update(result([detection()]), i * 150).additions).toHaveLength(
        0,
      );
    expect(s.update(result([detection()]), 1).ignored).toBe(true);
  });
  it("counts simultaneous identical copies separately", () => {
    const s = new ScanSession("s", "binder");
    const update = stable(s, [detection(0), detection(200), detection(400)]);
    expect(update.additions).toHaveLength(3);
    expect(new Set(update.additions.map((x) => x.eventId)).size).toBe(3);
  });
  it("does not recount brief occlusion, then rearms after a measured empty interval", () => {
    const s = new ScanSession("s", "stream");
    const add = stable(s).additions[0];
    s.acknowledge(add.eventId);
    s.update(result([]), 500);
    s.update(result([]), 900);
    expect(s.update(result([detection()]), 1000).additions).toHaveLength(0);
    s.update(result([]), 1200);
    expect(s.update(result([]), 2500).resetAfterEmpty).toBe(true);
    expect(stable(s, [detection()], 2700).additions).toHaveLength(1);
  });
  it("binder does not reset when empty; explicit new page counts copies again", () => {
    const s = new ScanSession("s", "binder");
    const add = stable(s).additions[0];
    s.acknowledge(add.eventId);
    s.update(result([]), 500);
    s.update(result([]), 5000);
    expect(stable(s, [detection()], 5500).additions).toHaveLength(0);
    s.newPage();
    expect(stable(s, [detection()], 7000).additions).toHaveLength(1);
  });
  it("explicit camera policy never treats detector misses as a physical exit", () => {
    const s = new ScanSession("explicit", "stream", 1200, "explicit");
    const first = stable(s).additions[0];
    s.acknowledge(first.eventId);
    for (let timestamp = 500; timestamp <= 5000; timestamp += 500)
      expect(s.update(result([]), timestamp).resetAfterEmpty).toBe(false);
    expect(stable(s, [detection()], 5500).additions).toHaveLength(0);
    const different = stable(s, [detection(0, "different")], 6500).additions;
    expect(different).toHaveLength(1);
    s.acknowledge(different[0].eventId);
    expect(stable(s, [detection()], 7500).additions).toHaveLength(0);
    s.newPage();
    const next = stable(s, [detection()], 8500).additions;
    expect(next).toHaveLength(1);
    expect(next[0].eventId).not.toBe(first.eventId);
  });
  it("explicit stream policy retains simultaneous-copy capacity and undone latches", () => {
    const s = new ScanSession("copies", "stream", 1200, "explicit");
    const events = stable(s, [detection(), detection(200)]).additions;
    expect(events).toHaveLength(2);
    events.forEach((event) => s.acknowledge(event.eventId));
    s.undo(events[0].eventId);
    s.update(result([]), 500);
    s.update(result([]), 1800);
    expect(
      stable(s, [detection(), detection(200)], 2000).additions,
    ).toHaveLength(0);
    expect(
      s.snapshot().filter((track) => track.status === "undone"),
    ).toHaveLength(1);
  });
  it("Next copy rearms only the single visible identity and preserves all other latches", () => {
    const s = new ScanSession("copy-target", "stream", 1200, "explicit");
    const a = stable(s, [detection(0, "A")]).additions[0];
    s.acknowledge(a.eventId);
    const b = stable(s, [detection(0, "B")], 1000).additions[0];
    s.acknowledge(b.eventId);
    expect(stable(s, [detection(0, "A")], 2000).additions).toHaveLength(0);
    expect(s.nextCopy(a.eventId)?.name).toBe("A");
    expect(
      s.snapshot().find((track) => track.eventId === b.eventId)?.status,
    ).toBe("added");
    const secondA = stable(s, [detection(0, "A")], 3000).additions[0];
    expect(secondA.eventId).not.toBe(a.eventId);
    s.acknowledge(secondA.eventId);
    expect(stable(s, [detection(0, "B")], 4000).additions).toHaveLength(0);
    expect(s.nextCopy(a.eventId)).toBeUndefined();
  });
  it("unverified stream proposals cannot revive an old Added identity or block Next copy", () => {
    const session = new ScanSession(
      "stream-overlay",
      "stream",
      1200,
      "explicit",
    );
    const a = region(100, 100, "A", 100, 140);
    const b = region(50, 40, "B", 220, 310);
    const first = stable(session, [a]).additions[0];
    session.acknowledge(first.eventId);
    const second = stable(session, [b], 1000).additions[0];
    session.acknowledge(second.eventId);
    const current = session.update(result([unclassified(b), a]), 2000);
    expect(current.additions).toHaveLength(0);
    expect(
      current.tracks
        .filter((track) => track.visible && track.status === "added")
        .map((track) => track.reference?.name),
    ).toEqual(["A"]);
    expect(
      current.tracks.find((track) => track.eventId === second.eventId)?.visible,
    ).toBe(false);
    expect(session.nextCopy(first.eventId)?.name).toBe("A");
    const copy = stable(session, [a], 3000).additions[0];
    session.acknowledge(copy.eventId);
    expect(stable(session, [b], 4000).additions).toHaveLength(0);
  });
  it.each(["unclassified", "deferred", "weak", "unverified"])(
    "does not expose a stream Next copy target from %s evidence",
    (kind) => {
      const session = new ScanSession(
        "stream-fresh",
        "stream",
        1200,
        "explicit",
      );
      const card = detection();
      const event = stable(session, [card]).additions[0];
      session.acknowledge(event.eventId);
      const pending = detection();
      if (kind === "deferred") pending.deferred = true;
      if (kind === "weak") pending.autoEligible = false;
      if (kind === "unverified")
        pending.candidates[0].geometricallyVerified = false;
      const next = session.update(
        result([kind === "unclassified" ? unclassified(card) : pending]),
        1000,
      );
      expect(
        next.tracks.find((track) => track.eventId === event.eventId)?.visible,
      ).toBe(false);
      expect(session.nextCopy(event.eventId)).toBeUndefined();
      expect(stable(session, [card], 2000).additions).toHaveLength(0);
      expect(session.nextCopy(event.eventId)?.key).toBe("one");
    },
  );
  it("Next copy requires one visible settled target and never rearms a binder page", () => {
    for (const mode of ["stream", "binder"] as const) {
      const s = new ScanSession(mode, mode, 1200, "explicit");
      const events = stable(s, [detection(), detection(200)]).additions;
      events.forEach((event) => s.acknowledge(event.eventId));
      expect(s.nextCopy(events[0].eventId)).toBeUndefined();
      s.update(result([]), 1000);
      expect(s.nextCopy(events[0].eventId)).toBeUndefined();
      stable(s, [detection()], 2000);
      if (mode === "binder")
        expect(s.nextCopy(events[0].eventId)).toBeUndefined();
    }
  });
  it("never saves ambiguous, poor quality or unfinished shortlist detections", () => {
    for (const state of ["ambiguous", "quality", "unknown"] as const) {
      const s = new ScanSession(state, "stream");
      expect(
        stable(s, [{ ...detection(), state, autoEligible: false }]).additions,
      ).toHaveLength(0);
    }
    const s = new ScanSession("budget", "stream");
    for (let t = 0; t < 1000; t += 150)
      expect(
        s.update(
          {
            ...result([
              { ...detection(), autoEligible: false, deferred: true },
            ]),
            budgetExhausted: true,
          },
          t,
        ).additions,
      ).toHaveLength(0);
  });
  it("resets evidence on changed identity and does not relabel saved tracks", () => {
    const s = new ScanSession("s", "stream");
    s.update(result([detection(0, "a")]), 0);
    s.update(result([detection(0, "a")]), 150);
    expect(s.update(result([detection(0, "b")]), 300).additions).toHaveLength(
      0,
    );
    const add = s.update(result([detection(0, "b")]), 600);
    expect(add.additions).toHaveLength(0);
    const event = s.update(result([detection(0, "b")]), 750).additions[0];
    s.acknowledge(event.eventId);
    s.update(result([detection(0, "a")]), 900);
    expect(
      s.snapshot().find((t) => t.eventId === event.eventId)?.reference?.key,
    ).toBe("b");
  });
  it("failed durability is an error, never added; undo stays suppressed", () => {
    const s = new ScanSession("s", "stream");
    const event = stable(s).additions[0];
    s.acknowledge(event.eventId, "Storage full");
    expect(s.snapshot()[0].status).toBe("error");
    expect(s.snapshot()[0].counted).toBe(false);
    s.undo(event.eventId);
    expect(s.update(result([detection()]), 600).additions).toHaveLength(0);
  });
  it("pause auto-save keeps collecting evidence without an insertion", () => {
    const s = new ScanSession("s", "stream");
    for (let t = 0; t < 1000; t += 150)
      expect(s.update(result([detection()]), t, false).additions).toHaveLength(
        0,
      );
    expect(s.update(result([detection()]), 1200, true).additions).toHaveLength(
      1,
    );
  });
  it("lets completed binder crops progress while other regions are deferred", () => {
    const s = new ScanSession("deferred", "binder");
    const unknown = {
      ...detection(200),
      autoEligible: false,
      deferred: true,
      candidates: [],
    };
    s.update({ ...result([detection(), unknown]), budgetExhausted: true }, 0);
    s.update(
      {
        ...result([
          { ...detection(), autoEligible: false, deferred: true },
          unknown,
        ]),
        budgetExhausted: true,
      },
      150,
    );
    s.update({ ...result([detection(), unknown]), budgetExhausted: true }, 300);
    const update = s.update(
      { ...result([detection(), unknown]), budgetExhausted: true },
      600,
    );
    expect(update.additions).toHaveLength(1);
    expect(update.additions[0].reference.key).toBe("one");
  });
});

it("never rearms counting from skipped or incomplete empty detector passes", () => {
  const session = new ScanSession("incomplete", "stream");
  const saved = stable(session).additions[0];
  session.acknowledge(saved.eventId);
  expect(session.update(result([]), 500).resetAfterEmpty).toBe(false);
  const skipped = {
    ...result([]),
    detectionComplete: false,
    budgetExhausted: true,
  };
  for (let timestamp = 800; timestamp <= 5000; timestamp += 300)
    expect(session.update(skipped, timestamp).resetAfterEmpty).toBe(false);
  expect(session.update(result([detection()]), 5200).additions).toHaveLength(0);
  expect(session.update(result([]), 5500).resetAfterEmpty).toBe(false);
  expect(session.update(result([]), 6800).resetAfterEmpty).toBe(true);
  expect(stable(session, [detection()], 7000).additions).toHaveLength(1);
});

it("releases camera pixel buffers while preserving counted event metadata", () => {
  const session = new ScanSession("pixels", "binder");
  const card = detection();
  card.printingCrop = {
    width: 480,
    height: 672,
    data: new Uint8ClampedArray(480 * 672 * 4),
  } as ImageData;
  card.crop = {
    width: 240,
    height: 336,
    data: new Uint8ClampedArray(240 * 336 * 4),
  } as ImageData;
  const event = stable(session, [card]).additions[0];
  session.acknowledge(event.eventId);
  session.releasePixels();
  const track = session.snapshot()[0];
  expect(track.evidence?.crop).toBeUndefined();
  expect(track.evidence?.printingCrop).toBeUndefined();
  expect(track.counted).toBe(true);
  expect(track.eventId).toBe(event.eventId);
  expect(track.evidence?.candidates[0].key).toBe("one");
  expect(session.update(result([detection()]), 1000).additions).toHaveLength(0);
});

describe("bounded current-frame proposal selection", () => {
  const page = () =>
    Array.from({ length: 9 }, (_, i) =>
      region((i % 3) * 120, Math.floor(i / 3) * 160, `card-${i}`),
    );
  function save(session: ScanSession, cards: CardDetection[]) {
    const update = stable(session, cards);
    for (const addition of update.additions)
      session.acknowledge(addition.eventId);
    return session.snapshot();
  }

  it("keeps nine settled current regions through reordered groups and extra partial proposals", () => {
    const session = new ScanSession("nine", "binder"),
      cards = page();
    const saved = save(session, cards);
    expect(saved.filter((track) => track.counted)).toHaveLength(9);
    const partials = cards.map((card) =>
      unclassified(
        region(card.quad[0].x + 10, card.quad[0].y + 30, "unused", 45, 65),
      ),
    );
    for (let frame = 0; frame < 12; frame++) {
      const current = cards.map((card, i) =>
        i === frame % 9 ? card : unclassified(card),
      );
      const proposals = [...partials, ...current];
      const offset = frame % proposals.length;
      const update = session.update(
        result([...proposals.slice(offset), ...proposals.slice(0, offset)]),
        500 + frame * 300,
      );
      const visible = update.tracks.filter((track) => track.visible);
      expect(update.additions).toHaveLength(0);
      expect(visible).toHaveLength(9);
      expect(visible.every((track) => track.counted)).toBe(true);
      expect(new Set(visible.map((track) => track.eventId))).toEqual(
        new Set(saved.map((track) => track.eventId)),
      );
      for (const track of visible)
        expect(track.quad).toEqual(
          cards.find(
            (card) => card.candidates[0].reference.key === track.reference?.key,
          )?.quad,
        );
    }
  });

  it("keeps distinct unknown regions and fresh verified work alongside saved cards", () => {
    const session = new ScanSession("mixed", "binder"),
      known = page().slice(0, 3);
    save(session, known);
    const unknown = [
      unclassified(region(0, 160)),
      unclassified(region(120, 160)),
    ];
    const fresh = region(240, 160, "new-card");
    const partials = known.flatMap((card) =>
      Array.from({ length: 3 }, (_, i) =>
        unclassified(
          region(card.quad[0].x + 5 + i * 15, 25, "partial", 35, 60),
        ),
      ),
    );
    for (let frame = 0; frame < 3; frame++) {
      const update = session.update(
        result([...partials, ...unknown, ...known.map(unclassified), fresh]),
        500 + frame * 150,
      );
      expect(update.tracks.filter((track) => track.visible)).toHaveLength(6);
      expect(
        update.tracks.filter((track) => track.visible && track.counted),
      ).toHaveLength(3);
      expect(update.additions).toHaveLength(frame === 2 ? 1 : 0);
      if (frame === 2)
        expect(update.additions[0].reference.key).toBe("new-card");
      for (const card of unknown)
        expect(
          update.tracks.some(
            (track) =>
              track.visible &&
              !track.reference &&
              JSON.stringify(track.quad) === JSON.stringify(card.quad),
          ),
        ).toBe(true);
    }
  });

  it("uses shifted current quads and hides a missing saved region instead of borrowing a partial crop", () => {
    const session = new ScanSession("missing", "binder"),
      cards = page();
    const saved = save(session, cards);
    const shifted = cards.slice(0, 8).map((card) =>
      unclassified({
        ...card,
        quad: card.quad.map((point) => ({
          x: point.x + 10,
          y: point.y + 5,
        })) as CardDetection["quad"],
      }),
    );
    const partial = unclassified(region(265, 360, "partial", 40, 60));
    const update = session.update(result([partial, ...shifted.reverse()]), 600);
    expect(update.additions).toHaveLength(0);
    expect(
      update.tracks.filter((track) => track.visible && track.counted),
    ).toHaveLength(8);
    expect(
      update.tracks.find((track) => track.eventId === saved[8].eventId)
        ?.visible,
    ).toBe(false);
    expect(
      update.tracks.find((track) => track.visible && !track.counted)?.quad,
    ).toEqual(partial.quad);
    for (const track of update.tracks.filter((track) => track.visible))
      expect(
        [partial, ...shifted].some(
          (card) => JSON.stringify(card.quad) === JSON.stringify(track.quad),
        ),
      ).toBe(true);
    const gone = session.update(result([unclassified(region(800, 500))]), 900);
    expect(
      gone.tracks.filter((track) => track.visible && track.counted),
    ).toHaveLength(0);
  });

  it("prefers a saved full-card region over an exact tentative partial track", () => {
    const session = new ScanSession("tentative", "binder");
    const partial = unclassified(region(20, 20, "partial", 50, 70));
    const cards = [detection()];
    session.update(result([partial, unclassified(cards[0])]), 0);
    expect(session.snapshot()).toHaveLength(2);
    const update = stable(session, cards, 150);
    session.acknowledge(update.additions[0].eventId);
    const next = session.update(result([partial, unclassified(cards[0])]), 600);
    expect(next.tracks.filter((track) => track.visible)).toHaveLength(1);
    expect(next.tracks.find((track) => track.visible)?.counted).toBe(true);
    expect(next.tracks.find((track) => track.visible)?.quad).toEqual(
      cards[0].quad,
    );
  });

  it("uses polygon containment for tilted cards instead of suppressing neighboring bounding boxes", () => {
    const session = new ScanSession("tilted", "binder");
    const tilted: CardDetection = {
      ...detection(),
      quad: [
        { x: 0, y: 70 },
        { x: 50, y: 0 },
        { x: 100, y: 70 },
        { x: 50, y: 140 },
      ],
    };
    save(session, [tilted]);
    const neighbor = unclassified(region(0, 0, "neighbor", 20, 30));
    const contained = unclassified(region(40, 50, "partial", 20, 30));
    const reversed: CardDetection = {
      ...unclassified(tilted),
      quad: [...tilted.quad].reverse() as CardDetection["quad"],
    };
    const next = session.update(result([neighbor, contained, reversed]), 600);
    expect(next.tracks.filter((track) => track.visible)).toHaveLength(2);
    expect(
      next.tracks.find((track) => track.visible && track.counted)?.quad,
    ).toEqual(reversed.quad);
    expect(
      next.tracks.find((track) => track.visible && !track.counted)?.quad,
    ).toEqual(neighbor.quad);
  });

  it("preserves two identical copies independently, including a smaller contained supported copy", () => {
    const session = new ScanSession("copies", "binder");
    const cards = [region(0, 0), region(35, 35, "one", 40, 56)];
    const saved = save(session, cards);
    expect(saved.filter((track) => track.counted)).toHaveLength(2);
    const next = session.update(
      result([
        unclassified(cards[1]),
        unclassified(region(5, 5, "partial", 15, 25)),
        unclassified(cards[0]),
      ]),
      600,
    );
    expect(next.additions).toHaveLength(0);
    expect(
      next.tracks.filter((track) => track.visible && track.counted),
    ).toHaveLength(2);
    for (const track of saved)
      expect(
        next.tracks.find((current) => current.eventId === track.eventId)?.quad,
      ).toEqual(track.quad);
  });

  it("never turns proposal support or deferred frames into fresh acceptance evidence", () => {
    const session = new ScanSession("fresh-evidence", "binder"),
      card = detection();
    session.update(result([card]), 0);
    session.update(result([card]), 150);
    for (const timestamp of [300, 600, 1000, 2000, 2400])
      expect(
        session.update(result([unclassified(card)]), timestamp).additions,
      ).toHaveLength(0);
    expect(session.update(result([card]), 2600).additions).toHaveLength(0);
    expect(session.update(result([card]), 2750).additions).toHaveLength(0);
    expect(session.update(result([card]), 2900).additions).toHaveLength(1);
  });
});

type ContinuousProof = Extract<RoiContinuityResult, { status: "continuous" }>;
function continuityProof(
  candidate: ScanContinuityCandidate,
  changes: Partial<ContinuousProof> = {},
): ContinuousProof {
  return {
    status: "continuous",
    kind: "verified-roi-continuity",
    eventId: candidate.eventId,
    seedFrameId: 10,
    latestFrameId: 12,
    latestTimestampMs: candidate.seedTimestampMs + 200,
    durationMs: 200,
    postSeedSamples: 2,
    identityObservations: 0,
    exitEvidence: false,
    latestQuad: candidate.quad.map((point) => ({
      x: point.x + 1,
      y: point.y + 1,
    })) as CardDetection["quad"],
    supportingPoints: 30,
    appearance: { gain: 1, offset: 0, rms: 0 },
    processingMs: 2,
    ...changes,
  };
}
function continuityCommit(
  proof: ContinuousProof,
  changes: Partial<ScanContinuityCommit> = {},
): ScanContinuityCommit {
  return {
    autoSave: true,
    now: proof.latestTimestampMs + 10,
    seedFrameId: 10,
    latestCapture: {
      frameId: proof.latestFrameId,
      timestampMs: proof.latestTimestampMs,
    },
    ...changes,
  };
}
function fastSession() {
  const session = new ScanSession("continuity", "binder");
  session.update(result([detection()]), 0, false);
  const candidate = session.continuityCandidates("fast")[0];
  return { session, candidate, proof: continuityProof(candidate) };
}

describe("separately gated current-ROI continuity saving", () => {
  it("recovers an unsaved intent when freshness expires at the final commit fence", () => {
    const { session, candidate, proof } = fastSession();
    const intent = session.commitContinuity(
      candidate,
      proof,
      continuityCommit(proof),
    )!;
    expect(session.snapshot()[0].status).toBe("saving");
    expect(session.cancelUnsavedIntent(intent)).toBe(true);
    expect(session.snapshot()[0]).toMatchObject({
      status: "matching",
      counted: false,
      stableFrames: 0,
    });
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
    session.update(result([detection()]), 500, false);
    const fresh = session.continuityCandidates("fast")[0];
    expect(fresh.observationToken).not.toBe(candidate.observationToken);
    const freshProof = continuityProof(fresh);
    const retry = session.commitContinuity(
      fresh,
      freshProof,
      continuityCommit(freshProof),
    )!;
    expect(retry.eventId).toBe(intent.eventId);
    session.acknowledge(retry.eventId);
    expect(session.snapshot()[0]).toMatchObject({
      status: "added",
      counted: true,
    });
  });
  it("cannot cancel an acknowledged, mismatched, obsolete or already-cancelled intent", () => {
    const { session, candidate, proof } = fastSession();
    const intent = session.commitContinuity(
      candidate,
      proof,
      continuityCommit(proof),
    )!;
    expect(
      session.cancelUnsavedIntent({ ...intent, eventId: "different" }),
    ).toBe(false);
    expect(
      session.cancelUnsavedIntent({
        ...intent,
        reference: { ...intent.reference, key: "different" },
      }),
    ).toBe(false);
    session.acknowledge(intent.eventId);
    expect(session.cancelUnsavedIntent(intent)).toBe(false);
    session.undo(intent.eventId);
    expect(session.cancelUnsavedIntent(intent)).toBe(false);
    session.newPage();
    expect(session.cancelUnsavedIntent(intent)).toBe(false);
    const second = fastSession();
    const secondIntent = second.session.commitContinuity(
      second.candidate,
      second.proof,
      continuityCommit(second.proof),
    )!;
    expect(second.session.cancelUnsavedIntent(secondIntent)).toBe(true);
    expect(second.session.cancelUnsavedIntent(secondIntent)).toBe(false);
  });
  it("exposes one strong current identity seed without saving or adding votes", () => {
    const { session, candidate, proof } = fastSession();
    expect(candidate).toMatchObject({
      eventId: "continuity:0:1",
      trackId: "0:1",
      policy: "fast",
      lastVerifiedAt: 0,
      seedTimestampMs: 0,
      reference: { key: "one" },
    });
    expect(session.continuityCandidates("strict")).toHaveLength(0);
    expect(session.snapshot()[0].stableFrames).toBe(1);
    expect(session.snapshot()[0].status).toBe("stabilizing");
    const intent = session.commitContinuity(
      candidate,
      proof,
      continuityCommit(proof),
    );
    expect(intent).toMatchObject({
      eventId: candidate.eventId,
      reference: candidate.reference,
    });
    const saving = session.snapshot()[0];
    expect(saving.stableFrames).toBe(1);
    expect(saving.lastVerifiedAt).toBe(0);
    expect(saving.status).toBe("saving");
    expect(saving.counted).toBe(false);
    expect(saving.quad).toEqual(proof.latestQuad);
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
    session.acknowledge(intent!.eventId);
    expect(session.snapshot()[0]).toMatchObject({
      counted: true,
      status: "added",
      stableFrames: 1,
    });
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
  });

  it("requires three actual strong observations and 250ms for strict continuity", () => {
    const session = new ScanSession("strict", "binder");
    for (const timestamp of [0, 100, 200])
      session.update(result([detection()]), timestamp, false);
    expect(session.continuityCandidates("fast")).toHaveLength(1);
    expect(session.continuityCandidates("strict")).toHaveLength(0);
    session.update(result([detection()]), 250, false);
    const candidate = session.continuityCandidates("strict")[0],
      proof = continuityProof(candidate);
    expect(candidate.seedTimestampMs).toBe(250);
    expect(session.snapshot()[0].status).toBe("review");
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeTruthy();
    expect(session.snapshot()[0].stableFrames).toBe(4);
  });

  it("does not let merely autoEligible but non-geometric observations supply strict votes", () => {
    const session = new ScanSession("geometry", "binder"),
      malformed = detection();
    malformed.candidates[0].geometricallyVerified = false;
    session.update(result([malformed]), 0, false);
    session.update(result([malformed]), 150, false);
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    session.update(result([detection()]), 300, false);
    expect(session.snapshot()[0].stableFrames).toBe(3);
    expect(session.continuityCandidates("fast")).toHaveLength(1);
    expect(session.continuityCandidates("strict")).toHaveLength(0);
    session.update(result([detection()]), 450, false);
    expect(session.continuityCandidates("strict")).toHaveLength(0);
    session.update(result([detection()]), 600, false);
    expect(session.continuityCandidates("strict")).toHaveLength(1);
  });

  it("retains the existing ungated strict-three behavior for legacy callers", () => {
    const session = new ScanSession("legacy", "stream");
    expect(session.update(result([detection()]), 0).additions).toHaveLength(0);
    expect(session.update(result([detection()]), 150).additions).toHaveLength(
      0,
    );
    expect(session.update(result([detection()]), 300).additions).toHaveLength(
      1,
    );
    expect(session.continuityCandidates("fast")).toHaveLength(0);
  });

  it.each([
    "deferred",
    "unknown",
    "quality",
    "ambiguous",
    "not-auto",
    "no-candidate",
    "non-geometric",
  ])("does not expose %s evidence as a current seed", (kind) => {
    const { session, candidate, proof } = fastSession(),
      card = detection();
    if (kind === "deferred") card.deferred = true;
    if (kind === "unknown" || kind === "quality" || kind === "ambiguous")
      card.state = kind;
    if (kind === "not-auto") card.autoEligible = false;
    if (kind === "no-candidate") card.candidates = [];
    if (kind === "non-geometric")
      card.candidates[0].geometricallyVerified = false;
    session.update(result([card]), 100, false);
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
  });

  it("preserves strict fresh votes across deferred work but never exposes that cached seed", () => {
    const session = new ScanSession("deferred-seed", "binder");
    session.update(result([detection()]), 0, false);
    session.update(result([detection()]), 150, false);
    session.update(result([{ ...detection(), deferred: true }]), 300, false);
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    session.update(result([detection()]), 450, false);
    const candidate = session.continuityCandidates("strict")[0];
    expect(candidate.seedTimestampMs).toBe(450);
    expect(session.snapshot()[0].stableFrames).toBe(3);
  });

  it("accepts fresh geometric matching even if proposal-only geometry was cached", () => {
    const session = new ScanSession("fresh-matcher", "binder");
    session.update(
      {
        ...result([detection()]),
        scheduling: {
          processedGroups: 1,
          deferredGroups: 0,
          proposalRefresh: false,
          proposalCacheReused: true,
          softBudgetMs: 600,
          overrunMs: 0,
        },
      },
      0,
      false,
    );
    expect(session.continuityCandidates("fast")).toHaveLength(1);
  });

  it.each(["empty", "incomplete-empty", "other-identity", "new-same-identity"])(
    "invalidates an old proof when a newer source frame is %s",
    (kind) => {
      const { session, candidate, proof } = fastSession();
      const frame = result(
        kind === "other-identity"
          ? [detection(0, "other")]
          : kind === "new-same-identity"
            ? [detection()]
            : [],
      );
      if (kind === "incomplete-empty") frame.detectionComplete = false;
      session.update(frame, 100, false);
      expect(
        session.commitContinuity(candidate, proof, continuityCommit(proof)),
      ).toBeUndefined();
      if (kind === "new-same-identity") {
        const next = session.continuityCandidates("fast")[0];
        expect(next.eventId).toBe(candidate.eventId);
        expect(next.observationToken).not.toBe(candidate.observationToken);
        expect(next.seedTimestampMs).toBe(100);
      }
    },
  );

  it.each(["interrupt", "new-page", "undo"])(
    "invalidates pending seeds on %s",
    (action) => {
      const { session, candidate, proof } = fastSession();
      if (action === "interrupt") session.interruptEvidence();
      if (action === "new-page") session.newPage();
      if (action === "undo") session.undo(candidate.eventId);
      expect(session.continuityCandidates("fast")).toHaveLength(0);
      expect(
        session.commitContinuity(candidate, proof, continuityCommit(proof)),
      ).toBeUndefined();
      session.update(result([detection()]), 100, false);
      expect(
        session.commitContinuity(candidate, proof, continuityCommit(proof)),
      ).toBeUndefined();
    },
  );

  it("does not invalidate a current seed for a stale ignored inference callback", () => {
    const { session, candidate, proof } = fastSession();
    expect(session.update(result([]), 0, false).ignored).toBe(true);
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeTruthy();
  });

  it("fails closed while saving is paused and can consume the still-current seed on resume", () => {
    const { session, candidate, proof } = fastSession();
    expect(
      session.commitContinuity(
        candidate,
        proof,
        continuityCommit(proof, { autoSave: false }),
      ),
    ).toBeUndefined();
    expect(session.snapshot()[0].status).toBe("stabilizing");
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeTruthy();
  });

  it("uses the durable acknowledgement and undo latches after continuity", () => {
    for (const failure of [false, true]) {
      const { session, candidate, proof } = fastSession();
      const intent = session.commitContinuity(
        candidate,
        proof,
        continuityCommit(proof),
      )!;
      session.acknowledge(intent.eventId, failure ? "Storage full" : undefined);
      expect(session.snapshot()[0]).toMatchObject({
        status: failure ? "error" : "added",
        counted: !failure,
      });
      expect(
        session.commitContinuity(candidate, proof, continuityCommit(proof)),
      ).toBeUndefined();
      session.update(result([detection()]), 300, false);
      expect(session.continuityCandidates("fast")).toHaveLength(0);
      session.undo(intent.eventId);
      session.update(result([detection()]), 600, false);
      expect(session.continuityCandidates("fast")).toHaveLength(0);
      expect(session.snapshot()[0]).toMatchObject({
        status: "undone",
        counted: false,
      });
    }
  });

  it("keeps simultaneous identical physical copies independent", () => {
    const session = new ScanSession("two-copies", "binder");
    session.update(result([detection(), detection(200)]), 0, false);
    const candidates = session.continuityCandidates("fast");
    expect(candidates).toHaveLength(2);
    const [first, second] = candidates,
      firstProof = continuityProof(first),
      secondProof = continuityProof(second);
    expect(
      session.commitContinuity(
        second,
        firstProof,
        continuityCommit(firstProof),
      ),
    ).toBeUndefined();
    expect(
      session.commitContinuity(first, firstProof, continuityCommit(firstProof)),
    ).toBeTruthy();
    expect(
      session
        .continuityCandidates("fast")
        .map((candidate) => candidate.eventId),
    ).toEqual([second.eventId]);
    expect(
      session.commitContinuity(
        second,
        secondProof,
        continuityCommit(secondProof),
      ),
    ).toBeTruthy();
    expect(session.snapshot().map((track) => track.stableFrames)).toEqual([
      1, 1,
    ]);
  });

  it("does not retain camera buffers in candidate metadata or prevent pixel release", () => {
    const session = new ScanSession("continuity-pixels", "binder"),
      card = detection();
    card.crop = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    } as ImageData;
    card.printingCrop = card.crop;
    session.update(result([card]), 0, false);
    const candidate = session.continuityCandidates("fast")[0],
      proof = continuityProof(candidate);
    expect(candidate).not.toHaveProperty("evidence");
    expect(candidate).not.toHaveProperty("crop");
    session.releasePixels();
    expect(session.snapshot()[0].evidence?.crop).toBeUndefined();
    expect(session.snapshot()[0].evidence?.printingCrop).toBeUndefined();
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeTruthy();
  });

  it("detaches candidate and committed proof geometry from caller-owned arrays", () => {
    const { session, candidate, proof } = fastSession();
    const second = session.continuityCandidates("fast")[0];
    candidate.quad[0].x = 999;
    candidate.reference.name = "Changed externally";
    expect(second.quad[0].x).toBe(0);
    expect(second.reference.name).toBe("one");
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
    expect(
      session.commitContinuity(second, proof, continuityCommit(proof)),
    ).toBeTruthy();
    proof.latestQuad[0].x = 999;
    expect(session.snapshot()[0].quad[0].x).toBe(1);
    expect(session.snapshot()[0].reference?.name).toBe("one");
  });

  it.each([
    ["event", { eventId: "another-event" }],
    ["track", { trackId: "another-track" }],
    ["token", { observationToken: "another-token" }],
    ["seed-time", { seedTimestampMs: 1 }],
    ["verified-time", { lastVerifiedAt: 1 }],
    [
      "printing",
      { reference: { key: "other", game: "pokemon", name: "other" } },
    ],
    [
      "identity",
      {
        reference: {
          key: "one",
          game: "pokemon",
          name: "one",
          identityKey: "other",
        },
      },
    ],
    ["game", { reference: { key: "one", game: "mtg", name: "one" } }],
    ["strict-policy", { policy: "strict" }],
  ] as const)("rejects mismatched candidate %s", (_kind, changes) => {
    const { session, candidate, proof } = fastSession();
    expect(
      session.commitContinuity(
        { ...candidate, ...changes },
        proof,
        continuityCommit(proof),
      ),
    ).toBeUndefined();
    expect(session.snapshot()[0].status).toBe("stabilizing");
  });

  it.each([
    ["wrong event", { eventId: "other" }],
    ["wrong kind", { kind: "detector-presence" }],
    ["fake identity vote", { identityObservations: 1 }],
    ["exit evidence", { exitEvidence: true }],
    ["one capture", { postSeedSamples: 1, latestFrameId: 11 }],
    ["fractional capture count", { postSeedSamples: 2.5 }],
    ["missing capture", { latestFrameId: 13 }],
    ["different seed", { seedFrameId: 9 }],
    ["short duration", { durationMs: 159, latestTimestampMs: 159 }],
    ["incorrect seed duration", { durationMs: 201 }],
    ["nonfinite duration", { durationMs: NaN }],
    ["nonfinite capture time", { latestTimestampMs: NaN }],
    ["fractional capture ID", { latestFrameId: 12.5 }],
  ])("rejects proof with %s", (_kind, changes) => {
    const { session, candidate, proof } = fastSession();
    const malformed = { ...proof, ...(changes as object) } as ContinuousProof;
    expect(
      session.commitContinuity(
        candidate,
        malformed,
        continuityCommit(malformed),
      ),
    ).toBeUndefined();
    expect(session.snapshot()[0].stableFrames).toBe(1);
    expect(session.snapshot()[0].status).toBe("stabilizing");
  });

  it.each(["pending", "rejected"] as const)(
    "rejects a %s guard result",
    (status) => {
      const { session, candidate, proof } = fastSession();
      expect(
        session.commitContinuity(
          candidate,
          {
            status,
            reason:
              status === "pending" ? "more-samples" : "appearance-changed",
            eventId: candidate.eventId,
            identityObservations: 0,
            exitEvidence: false,
            processingMs: 0,
            postSeedSamples: 0,
          },
          continuityCommit(proof),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    [
      "newer latest frame",
      { latestCapture: { frameId: 13, timestampMs: 220 } },
    ],
    [
      "different latest timestamp",
      { latestCapture: { frameId: 12, timestampMs: 201 } },
    ],
    ["incorrect source seed ID", { seedFrameId: 11 }],
    ["negative source seed ID", { seedFrameId: -1 }],
    ["future capture", { now: 199 }],
    ["stale capture", { now: 500.01 }],
    ["nonfinite clock", { now: Infinity }],
  ])("rejects %s at consume time", (_kind, changes) => {
    const { session, candidate, proof } = fastSession();
    expect(
      session.commitContinuity(
        candidate,
        proof,
        continuityCommit(proof, changes as Partial<ScanContinuityCommit>),
      ),
    ).toBeUndefined();
  });

  it("accepts the exact 160ms duration and 300ms freshness boundaries", () => {
    const { session, candidate } = fastSession(),
      proof = continuityProof(candidate, {
        durationMs: 160,
        latestTimestampMs: 160,
      });
    expect(
      session.commitContinuity(
        candidate,
        proof,
        continuityCommit(proof, { now: 460 }),
      ),
    ).toBeTruthy();
  });

  it.each(["outside", "nonfinite", "crossed", "degenerate", "missing-corner"])(
    "rejects %s current geometry and seed geometry",
    (kind) => {
      const { session, candidate, proof } = fastSession(),
        quad = proof.latestQuad.map((point) => ({
          ...point,
        })) as CardDetection["quad"];
      if (kind === "outside") quad[0].x = -1;
      if (kind === "nonfinite") quad[0].x = NaN;
      if (kind === "crossed") [quad[1], quad[2]] = [quad[2], quad[1]];
      if (kind === "degenerate") quad[1] = { ...quad[0] };
      if (kind === "missing-corner") quad.pop();
      expect(
        session.commitContinuity(
          candidate,
          { ...proof, latestQuad: quad },
          continuityCommit(proof),
        ),
      ).toBeUndefined();
      // The legacy identity-result API is typed as a four-corner tuple. This
      // new proof boundary additionally rejects a malformed worker tuple.
      if (kind !== "missing-corner") {
        const invalidSeed = new ScanSession("bad-quad", "binder");
        invalidSeed.update(result([{ ...detection(), quad }]), 0, false);
        expect(invalidSeed.continuityCandidates("fast")).toHaveLength(0);
      }
    },
  );

  it("clears strict continuity votes after a long identity-verification gap", () => {
    const session = new ScanSession("gap", "binder");
    for (const timestamp of [0, 150, 300])
      session.update(result([detection()]), timestamp, false);
    expect(session.continuityCandidates("strict")).toHaveLength(1);
    session.update(result([detection()]), 2400, false);
    expect(session.continuityCandidates("fast")).toHaveLength(1);
    expect(session.continuityCandidates("strict")).toHaveLength(0);
    expect(session.snapshot()[0].stableFrames).toBe(1);
  });
});

describe("rejected current-ROI continuity feedback", () => {
  it("clears only the current pending seed and keeps its visible uncounted overlay", () => {
    const { session, candidate, proof } = fastSession();
    expect(session.rejectContinuity(candidate)).toBe(true);
    expect(session.snapshot()[0]).toMatchObject({
      eventId: candidate.eventId,
      visible: true,
      counted: false,
      status: "matching",
      message: "Card moved or obscured · checking a fresh view",
      stableFrames: 0,
      candidateKey: undefined,
      lastVerifiedAt: undefined,
    });
    expect(session.continuityCandidates("fast")).toHaveLength(0);
    expect(
      session.commitContinuity(candidate, proof, continuityCommit(proof)),
    ).toBeUndefined();
    expect(session.rejectContinuity(candidate)).toBe(false);
  });

  it("accepts a plain display reason and requires three new strict identity votes", () => {
    const session = new ScanSession("rejected-strict", "binder");
    for (const timestamp of [0, 150, 300])
      session.update(result([detection()]), timestamp, false);
    const candidate = session.continuityCandidates("strict")[0];
    expect(
      session.rejectContinuity(candidate, "View changed · checking again"),
    ).toBe(true);
    expect(session.snapshot()[0].message).toBe("View changed · checking again");
    for (const timestamp of [450, 600]) {
      session.update(result([detection()]), timestamp, false);
      expect(session.continuityCandidates("strict")).toHaveLength(0);
      expect(session.rejectContinuity(candidate)).toBe(false);
    }
    session.update(result([detection()]), 750, false);
    expect(session.snapshot()[0].stableFrames).toBe(3);
    expect(session.continuityCandidates("strict")).toHaveLength(1);
  });

  it.each([
    { eventId: "other-event" },
    { observationToken: "other-observation" },
    { trackId: "other-track" },
  ])("ignores a mismatched candidate %j", (change) => {
    const { session, candidate } = fastSession(),
      before = session.snapshot();
    expect(session.rejectContinuity({ ...candidate, ...change })).toBe(false);
    expect(session.snapshot()).toEqual(before);
    expect(session.continuityCandidates("fast")).toHaveLength(1);
  });

  it("does not let a late rejected proof clear newer evidence", () => {
    const { session, candidate } = fastSession();
    session.update(result([detection()]), 150, false);
    const before = session.snapshot(),
      current = session.continuityCandidates("fast")[0];
    expect(session.rejectContinuity(candidate)).toBe(false);
    expect(session.snapshot()).toEqual(before);
    expect(session.continuityCandidates("fast")[0]).toEqual(current);
  });

  it.each(["saving", "added", "error", "undone"])(
    "never changes a %s event",
    (status) => {
      const { session, candidate, proof } = fastSession();
      const intent = session.commitContinuity(
        candidate,
        proof,
        continuityCommit(proof),
      )!;
      if (status === "added") session.acknowledge(intent.eventId);
      if (status === "error")
        session.acknowledge(intent.eventId, "Storage full");
      if (status === "undone") session.undo(intent.eventId);
      const before = session.snapshot();
      expect(session.rejectContinuity(candidate)).toBe(false);
      expect(session.snapshot()).toEqual(before);
      expect(session.snapshot()[0].status).toBe(status);
    },
  );

  it("leaves another identical physical copy independently eligible", () => {
    const session = new ScanSession("reject-one-copy", "binder");
    session.update(result([detection(), detection(200)]), 0, false);
    const [first, second] = session.continuityCandidates("fast"),
      secondBefore = session
        .snapshot()
        .find((track) => track.id === second.trackId);
    expect(session.rejectContinuity(first)).toBe(true);
    expect(session.continuityCandidates("fast")).toEqual([second]);
    expect(
      session.snapshot().find((track) => track.id === second.trackId),
    ).toEqual(secondBefore);
    expect(session.snapshot().every((track) => track.visible)).toBe(true);
    const proof = continuityProof(second);
    expect(
      session.commitContinuity(second, proof, continuityCommit(proof)),
    ).toBeTruthy();
  });

  it.each(["interrupt", "new-page", "new-identity", "offscreen"])(
    "ignores a candidate invalidated by %s",
    (kind) => {
      const { session, candidate } = fastSession();
      if (kind === "interrupt") session.interruptEvidence();
      if (kind === "new-page") session.newPage();
      if (kind === "new-identity")
        session.update(result([detection(0, "other")]), 150, false);
      if (kind === "offscreen") session.update(result([]), 150, false);
      const before = session.snapshot();
      expect(session.rejectContinuity(candidate)).toBe(false);
      expect(session.snapshot()).toEqual(before);
    },
  );
});
