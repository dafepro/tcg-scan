import type {
  CardDetection,
  Quad,
  ReferenceMetadata,
  VisionResult,
} from "./vision/types";
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
const isSettled = (t: ScanTrack) =>
  t.counted ||
  t.status === "saving" ||
  t.status === "undone" ||
  t.status === "error";
/** Rectangular Hungarian assignment. Dummy columns represent new physical tracks. */
function assignTracks(
  detections: CardDetection[],
  tracks: ScanTrack[],
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
 * Stream rearms after >=1.2 seconds of observed empty frames. Binder requires
 * newPage(). Pixels cannot distinguish an identical physical copy on re-entry.
 */
export class ScanSession {
  private tracks: ScanTrack[] = [];
  private sequence = 0;
  private lastFrame = -Infinity;
  private emptySince: number | undefined;
  private epoch = 0;
  constructor(
    readonly id: string,
    readonly mode: ScanMode,
    readonly emptyResetMs = 1200,
  ) {}
  snapshot() {
    return this.tracks.map((t) => ({ ...t }));
  }
  interruptEvidence() {
    this.emptySince = undefined;
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
    this.epoch++;
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
    const detections = result.detections.slice(0, 9);
    if (!detections.length) {
      this.emptySince ??= timestamp;
      if (
        this.mode === "stream" &&
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
    const assigned = assignTracks(detections, this.tracks),
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
    t.counted = !error;
    t.status = error ? "error" : "added";
    t.message = error ?? "Added · printing / finish unconfirmed";
  }
  undo(eventId: string) {
    const t = this.tracks.find((t) => t.eventId === eventId);
    if (t) {
      t.counted = false;
      t.status = "undone";
      t.message = "Undone · remove card before scanning again";
    }
  }
}
