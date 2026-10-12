import type {
  CardDetection,
  Point,
  Quad,
  ReferenceMetadata,
  VisionResult,
} from "./vision/types";
import type { RoiContinuityResult } from "./vision/roi-continuity";
import { isConvexQuad } from "./vision/geometry";
export type ScanMode = "stream" | "binder";
export type TrackStatus =
  | "stabilizing"
  | "matching"
  | "added"
  | "review"
  | "quality"
  | "saving"
  | "error"
  | "undone";
export interface ScanTrack {
  id: string;
  eventId: string;
  quad: Quad;
  status: TrackStatus;
  message: string;
  reference?: ReferenceMetadata;
  evidence?: CardDetection;
  firstSeen: number;
  lastSeen: number;
  stableSince: number;
  stableFrames: number;
  candidateKey?: string;
  lastVerifiedAt?: number;
  visible: boolean;
  counted: boolean;
}
export interface ScanIntent {
  eventId: string;
  trackId: string;
  reference: ReferenceMetadata;
}
export type ScanContinuityPolicy = "fast" | "strict";
/** One exact CURRENT identity observation, not a cached/deferred proposal.
 * Coordinates remain in the native identity frame. Arming the worker requires
 * the genuinely captured seed with exactly seedTimestampMs. */
export interface ScanContinuityCandidate extends ScanIntent {
  policy: ScanContinuityPolicy;
  quad: Quad;
  lastVerifiedAt: number;
  seedTimestampMs: number;
  observationToken: string;
}
export interface ScanContinuityCommit {
  autoSave: boolean;
  /** Present monotonic time, read when consuming the worker result. */
  now: number;
  /** ID of the actual captured seed supplied to the worker. */
  seedFrameId: number;
  /** Latest genuine sampled capture at commit time, not at request time. */
  latestCapture: { frameId: number; timestampMs: number };
}
interface ContinuityObservation {
  candidate: Omit<ScanContinuityCandidate, "policy">;
  identityKey: string;
  frames: number;
  since: number;
  width: number;
  height: number;
}
export interface SessionUpdate {
  tracks: ScanTrack[];
  additions: ScanIntent[];
  ignored: boolean;
  resetAfterEmpty: boolean;
}
const center = (q: Quad) => ({
  x: q.reduce((s, p) => s + p.x, 0) / 4,
  y: q.reduce((s, p) => s + p.y, 0) / 4,
});
const area = (q: Quad) =>
  Math.abs(
    q.reduce(
      (s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y,
      0,
    ),
  ) / 2;
const identity = (r?: ReferenceMetadata) =>
  r ? `${r.game}:${r.identityKey ?? r.key}` : undefined;
const cloneQuad = (quad: Quad): Quad =>
  quad.map((point) => ({ ...point })) as Quad;
const sameQuad = (a: Quad, b: Quad) =>
  Array.isArray(a) &&
  a.length === 4 &&
  a.every((point, index) => point?.x === b[index].x && point?.y === b[index].y);
const validQuad = (quad: Quad, width: number, height: number) =>
  Number.isFinite(width) &&
  Number.isFinite(height) &&
  width > 0 &&
  height > 0 &&
  Array.isArray(quad) &&
  quad.length === 4 &&
  quad.every(
    (point) =>
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < width &&
      point.y < height,
  ) &&
  isConvexQuad(quad);
const isSettled = (t: ScanTrack) =>
  t.counted ||
  t.status === "saving" ||
  t.status === "undone" ||
  t.status === "error";
/** Convex polygon clipping, rather than bounding boxes that overlap across
 * neighboring tilted cards. This is geometry only, never identity evidence. */
function intersectionArea(a: Quad, b: Quad): number {
  let polygon: Point[] = a;
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const direction = Math.sign(cross(b[0], b[1], b[2]));
  if (!direction) return 0;
  for (let i = 0; i < 4 && polygon.length; i++) {
    const start = b[i],
      end = b[(i + 1) % 4],
      input = polygon;
    polygon = [];
    let previous = input[input.length - 1],
      previousSide = direction * cross(start, end, previous);
    for (const point of input) {
      const side = direction * cross(start, end, point);
      if (side >= 0 !== previousSide >= 0) {
        const fraction = previousSide / (previousSide - side);
        polygon.push({
          x: previous.x + fraction * (point.x - previous.x),
          y: previous.y + fraction * (point.y - previous.y),
        });
      }
      if (side >= 0) polygon.push(point);
      previous = point;
      previousSide = side;
    }
  }
  return (
    Math.abs(
      polygon.reduce((sum, point, i) => {
        const next = polygon[(i + 1) % polygon.length];
        return sum + point.x * next.y - next.x * point.y;
      }, 0),
    ) / 2
  );
}
/** An unclassified partial crop must not borrow a saved card's full overlay. */
function geometrySupport(a: Quad, b: Quad): number {
  const aa = area(a),
    bb = area(b);
  if (Math.min(aa, bb) / Math.max(aa, bb, 1) < 0.65) return 0;
  const intersection = intersectionArea(a, b),
    overlap = intersection / Math.max(1, aa + bb - intersection);
  return overlap >= 0.5 ? overlap : 0;
}
/** Learned preview rotates groups and can return more than nine proposals.
 * Select from the entire CURRENT frame before bounding Hungarian assignment.
 * No cached quad is inserted and no candidate becomes eligible through ranking. */
function selectDetections(detections: CardDetection[], tracks: ScanTrack[]) {
  const ranked = detections.map((detection) => {
    const candidate = detection.candidates[0]?.reference;
    let support = 0;
    for (const track of tracks) {
      if (
        !track.reference ||
        (candidate && identity(candidate) !== identity(track.reference))
      )
        continue;
      support = Math.max(support, geometrySupport(detection.quad, track.quad));
    }
    return {
      detection,
      support,
      priority:
        detection.autoEligible && candidate && !detection.deferred
          ? 3
          : support
            ? 2
            : candidate
              ? 1
              : 0,
      size: area(detection.quad),
      center: center(detection.quad),
    };
  });
  // Only candidate-free, unsupported partial regions can be suppressed, and
  // only by a larger CURRENT supported region. Distinct verified copies and
  // unresolved identity candidates are never collapsed by identity or overlap.
  const distinct = ranked.filter(
    (entry) =>
      entry.priority > 0 ||
      !ranked.some(
        (other) =>
          other.priority >= 2 &&
          entry.size < other.size * 0.8 &&
          intersectionArea(entry.detection.quad, other.detection.quad) /
            Math.max(1, entry.size) >=
            0.9,
      ),
  );
  distinct.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.support - a.support ||
      b.size - a.size ||
      a.center.y - b.center.y ||
      a.center.x - b.center.x,
  );
  return distinct.slice(0, 9).map(({ detection }) => detection);
}
/** Rectangular Hungarian assignment. Dummy columns represent new physical tracks. */
function assignTracks(
  detections: CardDetection[],
  tracks: ScanTrack[],
  mode: ScanMode,
): number[] {
  const n = detections.length,
    m = tracks.length + n;
  if (!n) return [];
  const costs = detections.map((d) => {
    const c = center(d.quad),
      size = Math.sqrt(area(d.quad)),
      candidate = d.candidates[0]?.reference;
    return [
      ...tracks.map((t) => {
        // Stream latches remember counted identities, not their continued
        // physical presence. An unclassified outer proposal must not revive an
        // old Added overlay or block the currently verified Next copy target.
        // Binder mode may retain geometry-supported labels while groups rotate.
        if (
          mode === "stream" &&
          isSettled(t) &&
          (!d.autoEligible ||
            d.deferred ||
            d.state !== "verified" ||
            !d.candidates[0]?.geometricallyVerified ||
            !candidate ||
            identity(t.reference) !== identity(candidate))
        )
          return 1e6;
        const tc = center(t.quad),
          distance =
            Math.hypot(c.x - tc.x, c.y - tc.y) /
            Math.max(size, Math.sqrt(area(t.quad)), 1);
        const same =
          !!candidate && identity(t.reference) === identity(candidate);
        // Counted identical identities take priority within an epoch. This retains
        // simultaneous-copy capacity without recounting camera pans or short gaps.
        if (same) return (isSettled(t) ? 0 : 2) + Math.min(distance, 8) / 10;
        if (t.reference && candidate) return 1e6;
        if (t.reference) {
          const support = geometrySupport(d.quad, t.quad);
          return support ? 3 + (1 - support) + distance / 10 : 1e6;
        }
        return distance < 0.75 ? 4 + distance : 1e6;
      }),
      ...Array(n).fill(10),
    ];
  });
  const u = new Float64Array(n + 1),
    v = new Float64Array(m + 1),
    p = new Int32Array(m + 1),
    way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity),
      used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= m; j++)
        if (!used[j]) {
          const cur = costs[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const assigned = Array(n).fill(-1);
  for (let j = 1; j <= m; j++)
    if (p[j]) assigned[p[j] - 1] = j - 1 < tracks.length ? j - 1 : -1;
  return assigned;
}
/** Ordered physical-presentation tracking, independent of React and camera.
 * Legacy detector rearming is optional. Learned camera sessions require an
 * explicit newPage() because missing proposals do not establish physical exit.
 * Pixels cannot distinguish an identical physical copy on re-entry.
 */
export class ScanSession {
  private tracks: ScanTrack[] = [];
  private sequence = 0;
  private lastFrame = -Infinity;
  private emptySince: number | undefined;
  private epoch = 0;
  private observationSequence = 0;
  private continuityObservations = new Map<string, ContinuityObservation>();
  constructor(
    readonly id: string,
    readonly mode: ScanMode,
    readonly emptyResetMs = 1200,
    readonly emptyResetPolicy: "detector" | "explicit" = "detector",
  ) {}
  snapshot() {
    return this.tracks.map((t) => ({ ...t }));
  }
  /** Opt-in path only. Legacy update(..., true) keeps its three-check policy.
   * A deferred frame can preserve prior votes, but can never supply a seed.
   * A cached detector proposal alone is not identity evidence; completed fresh
   * geometric matching from that frame is still required. */
  continuityCandidates(
    policy: ScanContinuityPolicy,
  ): ScanContinuityCandidate[] {
    if (policy !== "fast" && policy !== "strict") return [];
    return this.tracks.flatMap((track) => {
      const observation = this.continuityObservations.get(track.id);
      if (
        !observation ||
        !this.currentContinuityObservation(track, observation)
      )
        return [];
      if (
        policy === "strict" &&
        (observation.frames < 3 ||
          this.lastFrame - observation.since < 250 ||
          track.stableFrames < 3 ||
          this.lastFrame - track.stableSince < 250)
      )
        return [];
      return [
        {
          ...observation.candidate,
          policy,
          reference: { ...observation.candidate.reference },
          quad: cloneQuad(observation.candidate.quad),
        },
      ];
    });
  }
  /** Consume real worker continuity once. The caller must map latestQuad back
   * into the native identity frame and reject obsolete source generations.
   * This never creates an identity vote, increments stableFrames, proves
   * absence, or rearms a counted event. */
  commitContinuity(
    candidate: ScanContinuityCandidate,
    proof: RoiContinuityResult,
    context: ScanContinuityCommit,
  ): ScanIntent | undefined {
    const track = this.tracks.find((t) => t.id === candidate.trackId),
      observation = this.continuityObservations.get(candidate.trackId);
    if (
      !context.autoSave ||
      !track ||
      !observation ||
      !this.currentContinuityObservation(track, observation) ||
      !this.continuityCandidates(candidate.policy).some(
        (current) => current.observationToken === candidate.observationToken,
      ) ||
      candidate.observationToken !== observation.candidate.observationToken ||
      candidate.eventId !== track.eventId ||
      candidate.lastVerifiedAt !== track.lastVerifiedAt ||
      candidate.seedTimestampMs !== observation.candidate.seedTimestampMs ||
      !sameQuad(candidate.quad, observation.candidate.quad) ||
      candidate.reference.key !== observation.candidate.reference.key ||
      identity(candidate.reference) !== observation.identityKey ||
      proof.status !== "continuous" ||
      proof.kind !== "verified-roi-continuity" ||
      proof.identityObservations !== 0 ||
      proof.exitEvidence !== false ||
      proof.eventId !== candidate.eventId ||
      !Number.isSafeInteger(context.seedFrameId) ||
      context.seedFrameId < 0 ||
      proof.seedFrameId !== context.seedFrameId ||
      !Number.isSafeInteger(proof.latestFrameId) ||
      !Number.isSafeInteger(proof.postSeedSamples) ||
      proof.postSeedSamples < 2 ||
      proof.latestFrameId - proof.seedFrameId !== proof.postSeedSamples ||
      proof.latestFrameId !== context.latestCapture.frameId ||
      proof.latestTimestampMs !== context.latestCapture.timestampMs ||
      !Number.isFinite(proof.durationMs) ||
      proof.durationMs < 160 ||
      proof.latestTimestampMs - candidate.seedTimestampMs !==
        proof.durationMs ||
      !Number.isFinite(context.now) ||
      !Number.isFinite(proof.latestTimestampMs) ||
      context.now < proof.latestTimestampMs ||
      context.now - proof.latestTimestampMs > 300 ||
      !validQuad(proof.latestQuad, observation.width, observation.height)
    )
      return undefined;
    track.quad = cloneQuad(proof.latestQuad);
    track.status = "saving";
    track.message = "Saving locally";
    this.continuityObservations.delete(track.id);
    return {
      eventId: track.eventId,
      trackId: track.id,
      reference: { ...observation.candidate.reference },
    };
  }
  /** A rejected guard cannot be recreated from its old identity seed. Only the
   * exact still-current observation loses its pending identity votes; settled
   * events and newer observations are untouched. reason is display text. */
  rejectContinuity(
    candidate: ScanContinuityCandidate,
    reason = "Card moved or obscured · checking a fresh view",
  ): boolean {
    const track = this.tracks.find((t) => t.id === candidate.trackId),
      observation = this.continuityObservations.get(candidate.trackId);
    if (
      !track ||
      !observation ||
      !this.currentContinuityObservation(track, observation) ||
      candidate.eventId !== track.eventId ||
      candidate.observationToken !== observation.candidate.observationToken
    )
      return false;
    this.continuityObservations.delete(track.id);
    track.stableFrames = 0;
    track.stableSince = track.lastSeen;
    track.candidateKey = undefined;
    track.lastVerifiedAt = undefined;
    track.status = "matching";
    track.message = reason;
    return true;
  }
  private currentContinuityObservation(
    track: ScanTrack,
    observation: ContinuityObservation,
  ): boolean {
    const detection = track.evidence;
    return (
      !isSettled(track) &&
      track.visible &&
      track.lastSeen === this.lastFrame &&
      track.lastVerifiedAt === this.lastFrame &&
      observation.candidate.seedTimestampMs === this.lastFrame &&
      sameQuad(track.quad, observation.candidate.quad) &&
      track.candidateKey === observation.identityKey &&
      track.reference?.key === observation.candidate.reference.key &&
      identity(track.reference) === observation.identityKey &&
      !!detection?.autoEligible &&
      sameQuad(detection.quad, observation.candidate.quad) &&
      !detection.deferred &&
      detection.state === "verified" &&
      detection.candidates[0]?.geometricallyVerified === true &&
      detection.candidates[0].reference.key ===
        observation.candidate.reference.key &&
      identity(detection.candidates[0].reference) === observation.identityKey
    );
  }
  private observeContinuity(
    track: ScanTrack,
    detection: CardDetection,
    timestamp: number,
    width: number,
    height: number,
  ) {
    const match = detection.candidates[0];
    if (
      !match?.geometricallyVerified ||
      detection.state !== "verified" ||
      !validQuad(detection.quad, width, height)
    ) {
      this.continuityObservations.delete(track.id);
      return;
    }
    const previous = this.continuityObservations.get(track.id),
      identityKey = identity(match.reference)!,
      continuing =
        previous?.identityKey === identityKey &&
        timestamp - previous.candidate.seedTimestampMs <= 2000;
    this.continuityObservations.set(track.id, {
      candidate: {
        eventId: track.eventId,
        trackId: track.id,
        reference: { ...match.reference },
        quad: cloneQuad(detection.quad),
        lastVerifiedAt: timestamp,
        seedTimestampMs: timestamp,
        observationToken: `${this.id}:${++this.observationSequence}`,
      },
      identityKey,
      frames: continuing ? previous.frames + 1 : 1,
      since: continuing ? previous.since : timestamp,
      width,
      height,
    });
  }
  /** Keep counting metadata, never retain camera pixels for settled/offscreen tracks. */
  releasePixels() {
    for (const track of this.tracks)
      if (track.evidence) {
        const {
          crop: _crop,
          printingCrop: _printingCrop,
          hypotheses: _hypotheses,
          ...metadata
        } = track.evidence;
        void _crop;
        void _printingCrop;
        void _hypotheses;
        track.evidence = metadata;
      }
  }
  interruptEvidence() {
    this.emptySince = undefined;
    this.continuityObservations.clear();
    for (const t of this.tracks)
      if (!isSettled(t)) {
        t.stableFrames = 0;
        t.candidateKey = undefined;
        t.lastVerifiedAt = undefined;
      }
  }
  newPage() {
    this.tracks = [];
    this.emptySince = undefined;
    this.continuityObservations.clear();
    this.epoch++;
  }
  /** Explicit stream exception for one visible settled identity. Preserve all
   * other identities' counted/undone/error latches; no detector absence claim. */
  nextCopy(eventId: string): ReferenceMetadata | undefined {
    if (this.mode !== "stream") return undefined;
    const visible = this.tracks.filter(
      (track) =>
        track.visible &&
        track.reference &&
        ["added", "undone", "error"].includes(track.status),
    );
    const target =
      visible.length === 1 && visible[0].eventId === eventId
        ? visible[0]
        : undefined;
    if (!target?.reference) return undefined;
    const key = identity(target.reference);
    this.tracks = this.tracks.filter(
      (track) => identity(track.reference) !== key,
    );
    this.emptySince = undefined;
    this.interruptEvidence();
    return { ...target.reference };
  }
  update(
    result: VisionResult,
    timestamp: number,
    autoSave = true,
  ): SessionUpdate {
    if (!Number.isFinite(timestamp) || timestamp <= this.lastFrame)
      return {
        tracks: this.snapshot(),
        additions: [],
        ignored: true,
        resetAfterEmpty: false,
      };
    if (timestamp - this.lastFrame > 2000) this.emptySince = undefined;
    this.lastFrame = timestamp;
    let resetAfterEmpty = false;
    const detections = selectDetections(result.detections, this.tracks);
    if (!detections.length && result.detectionComplete !== false) {
      this.emptySince ??= timestamp;
      if (
        this.mode === "stream" &&
        this.emptyResetPolicy === "detector" &&
        timestamp - this.emptySince >= this.emptyResetMs &&
        this.tracks.length
      ) {
        this.newPage();
        this.emptySince = timestamp;
        resetAfterEmpty = true;
      }
    } else this.emptySince = undefined;
    this.tracks.forEach((t) => {
      t.visible = false;
    });
    const assigned = assignTracks(detections, this.tracks, this.mode),
      previousTracks = [...this.tracks];
    const additions: ScanIntent[] = [];
    for (const [index, detection] of detections.entries()) {
      const candidate = detection.candidates[0]?.reference;
      let track = previousTracks[assigned[index]];
      if (!track) {
        const n = ++this.sequence;
        track = {
          id: `${this.epoch}:${n}`,
          eventId: `${this.id}:${this.epoch}:${n}`,
          quad: detection.quad,
          status: "matching",
          message: "Matching locally",
          firstSeen: timestamp,
          lastSeen: timestamp,
          stableSince: timestamp,
          stableFrames: 0,
          visible: true,
          counted: false,
        };
        this.tracks.push(track);
      }
      track.visible = true;
      track.quad = detection.quad;
      const gap = timestamp - (track.lastVerifiedAt ?? track.lastSeen);
      track.lastSeen = timestamp;
      track.evidence = detection;
      if (isSettled(track)) continue;
      if (detection.deferred) {
        track.message = "Hold steady · continuing local verification";
        continue;
      }
      if (!detection.autoEligible || !candidate) {
        this.continuityObservations.delete(track.id);
        track.stableFrames = 0;
        track.candidateKey = undefined;
        track.status =
          detection.state === "quality"
            ? "quality"
            : detection.state === "ambiguous"
              ? "review"
              : "matching";
        track.message = detection.reason;
        continue;
      }
      const candidateKey = identity(candidate)!;
      if (track.candidateKey !== candidateKey || gap > 2000) {
        track.stableFrames = 0;
        track.stableSince = timestamp;
      }
      track.lastVerifiedAt = timestamp;
      track.candidateKey = candidateKey;
      track.reference = candidate;
      track.stableFrames++;
      track.status = "stabilizing";
      track.message = `Hold steady · ${Math.min(track.stableFrames, 3)}/3 checks`;
      this.observeContinuity(
        track,
        detection,
        timestamp,
        result.width,
        result.height,
      );
      if (track.stableFrames >= 3 && timestamp - track.stableSince >= 250) {
        if (!autoSave) {
          track.status = "review";
          track.message = "Match ready · automatic saving is paused";
          continue;
        }
        track.status = "saving";
        track.message = "Saving locally";
        additions.push({
          eventId: track.eventId,
          trackId: track.id,
          reference: candidate,
        });
      }
    }
    // Settled events survive the whole epoch. Only disposable tentative tracks
    // age out or enter a rolling bound; never duplicate an object in both lists.
    const settled = this.tracks.filter(isSettled);
    const tentative = this.tracks
      .filter((t) => !isSettled(t))
      .filter((t) => t.visible || timestamp - t.lastSeen < 5000)
      .slice(-100);
    this.tracks = [...settled, ...tentative];
    const liveTracks = new Set(this.tracks.map((track) => track.id));
    for (const trackId of this.continuityObservations.keys())
      if (!liveTracks.has(trackId)) this.continuityObservations.delete(trackId);
    return {
      tracks: this.snapshot(),
      additions,
      ignored: false,
      resetAfterEmpty,
    };
  }
  acknowledge(eventId: string, error?: string) {
    const t = this.tracks.find((t) => t.eventId === eventId);
    if (!t || t.status !== "saving") return;
    this.continuityObservations.delete(t.id);
    t.counted = !error;
    t.status = error ? "error" : "added";
    t.message = error ?? "Added · printing / finish unconfirmed";
  }
  /** Roll back only an unpersisted intent when its final current-view fence
   * expires. Never undo durable/acknowledged events or reuse the old proof. */
  cancelUnsavedIntent(intent: ScanIntent): boolean {
    const track = this.tracks.find(
      (candidate) => candidate.id === intent.trackId,
    );
    if (
      !track ||
      track.eventId !== intent.eventId ||
      track.counted ||
      track.status !== "saving" ||
      track.reference?.key !== intent.reference.key ||
      identity(track.reference) !== identity(intent.reference)
    )
      return false;
    this.continuityObservations.delete(track.id);
    track.stableFrames = 0;
    track.stableSince = track.lastSeen;
    track.candidateKey = undefined;
    track.lastVerifiedAt = undefined;
    track.status = "matching";
    track.message = "Current-view check expired · checking a fresh capture";
    return true;
  }
  undo(eventId: string) {
    const t = this.tracks.find((t) => t.eventId === eventId);
    if (t) {
      this.continuityObservations.delete(t.id);
      t.counted = false;
      t.status = "undone";
      t.message =
        this.emptyResetPolicy === "explicit"
          ? "Undone · stays excluded until Next copy or New page"
          : "Undone · remove card before scanning again";
    }
  }
}
