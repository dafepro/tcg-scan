import type * as OpenCv from "@techstark/opencv-js";
import {
  bounds,
  boxIntersectionOverUnion,
  distance,
  hullArea,
  isConvexQuad,
  median,
  polygonArea,
} from "./geometry";
import type { Point, Quad } from "./types";

/** Normalized coordinates in the UNMIRRORED captured frame, also shown in the UI. */
export interface ExitScanRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Caller downsizes once. No canvas, detector, model, network, or runtime loader here. */
export interface ExitFrame {
  width: number;
  height: number;
  gray: Uint8Array;
  /** Monotonically increasing capture sequence, not inference completion order. */
  frameId: number;
  /** Monotonic capture time, not wall-clock or inference completion time. */
  timestampMs: number;
}

export interface VerifiedExitSeed {
  eventId: string;
  /** This assertion must come from the existing geometric identity verifier. */
  geometryVerified: true;
  /** Pixel coordinates in exactly this low-resolution frame, in boundary order. */
  quad: Quad;
  frame: ExitFrame;
}

export interface ExitTrackerOptions {
  region: ExitScanRegion;
  maxTracks?: number;
  maxEvents?: number;
  maxSampleGapMs?: number;
  maxTrackAgeMs?: number;
}

export type ExitInvalidationReason =
  | "paused"
  | "hidden"
  | "unmounted"
  | "source-changed"
  | "explicit"
  | "invalid-frame"
  | "frame-reordered"
  | "sample-gap"
  | "frame-size-changed"
  | "camera-motion"
  | "background-lost"
  | "feature-lost"
  | "geometry-lost"
  | "appearance-changed"
  | "preview-clipped"
  | "track-overlap"
  | "track-expired"
  | "runtime-error";

export interface VerifiedExit {
  eventId: string;
  frameId: number;
  timestampMs: number;
  quad: Quad;
  supportingPoints: number;
  /** An ROI exit is not proof that this physical copy left the entire camera. */
  kind: "verified-roi-exit";
}

export interface ExitUpdate {
  exits: VerifiedExit[];
  cancelled: { eventId: string; reason: ExitInvalidationReason }[];
  ignored: boolean;
  processingMs: number;
}

type Cv = typeof OpenCv;
type Mat = OpenCv.Mat;
type Affine = [number, number, number, number, number, number];
interface Feature {
  origin: Point;
  current: Point;
  /** Small immutable seed patch; never relearn a replacement card. */
  patch: number[];
}
interface Track {
  eventId: string;
  originalQuad: Quad;
  quad: Quad;
  features: Feature[];
  originalCount: number;
  armedAt: number;
  motionSamples: number;
  outsideSamples: number;
  outsideSince?: number;
}
interface Flow {
  point: Point;
  valid: boolean;
}

const MAX_EDGE = 640;
const CARD_POINTS = 48;
const BACKGROUND_POINTS = 48;
const MIN_CARD_POINTS = 20;
const MIN_BACKGROUND_POINTS = 16;
const PATCH_RADIUS = 3;
const FRAME_MARGIN = 10;
const EXIT_MARGIN = 3;
const MIN_MOTION = 0.6;
const MAX_GLOBAL_TRANSLATION = 2.25;
const MAX_GLOBAL_STEP = 4.5;
const MAX_BACKGROUND_RESIDUAL = 0.65;
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const cloneQuad = (q: Quad): Quad => q.map((p) => ({ ...p })) as Quad;
const transform = (a: Affine, p: Point): Point => ({
  x: a[0] * p.x + a[1] * p.y + a[2],
  y: a[3] * p.x + a[4] * p.y + a[5],
});
const center = (q: Quad): Point => ({
  x: q.reduce((s, p) => s + p.x, 0) / 4,
  y: q.reduce((s, p) => s + p.y, 0) / 4,
});
const finitePoint = (p: Point) =>
  Number.isFinite(p?.x) && Number.isFinite(p?.y);
const pixelsEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function insideQuad(p: Point, q: Quad, inset = 0): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i],
      b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < inset * distance(a, b)) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

function sample(
  data: Uint8Array,
  width: number,
  height: number,
  p: Point,
): number {
  const x = Math.floor(p.x),
    y = Math.floor(p.y),
    dx = p.x - x,
    dy = p.y - y;
  if (x < 0 || y < 0 || x + 1 >= width || y + 1 >= height) return NaN;
  return (
    data[y * width + x] * (1 - dx) * (1 - dy) +
    data[y * width + x + 1] * dx * (1 - dy) +
    data[(y + 1) * width + x] * (1 - dx) * dy +
    data[(y + 1) * width + x + 1] * dx * dy
  );
}

function patch(
  data: Uint8Array,
  width: number,
  height: number,
  p: Point,
  a: Affine = IDENTITY,
): number[] {
  const result: number[] = [];
  for (let y = -PATCH_RADIUS; y <= PATCH_RADIUS; y++)
    for (let x = -PATCH_RADIUS; x <= PATCH_RADIUS; x++)
      result.push(
        sample(data, width, height, transform(a, { x: p.x + x, y: p.y + y })),
      );
  return result;
}

function patchMatches(before: number[], after: number[]): boolean {
  // A conservative immutable appearance anchor. No brightness normalization that
  // could turn a saturated/blank patch into apparently valid tracking evidence.
  let error = 0,
    sum = 0,
    squares = 0;
  for (let i = 0; i < before.length; i++) {
    if (!Number.isFinite(after[i])) return false;
    error += (before[i] - after[i]) ** 2;
    sum += after[i];
    squares += after[i] ** 2;
  }
  return (
    Math.sqrt(error / before.length) <= 20 &&
    Math.sqrt(
      Math.max(0, squares / before.length - (sum / before.length) ** 2),
    ) >= 8
  );
}

function spatialSupport(points: Point[], quad: Quad): boolean {
  if (
    points.length < MIN_CARD_POINTS ||
    hullArea(points) / polygonArea(quad) < 0.42
  )
    return false;
  const b = bounds(quad),
    c = center(quad),
    occupied = new Set<number>();
  for (const p of points)
    occupied.add((p.x >= c.x ? 1 : 0) + (p.y >= c.y ? 2 : 0));
  const p = bounds(points);
  return (
    occupied.size === 4 &&
    p.width >= b.width * 0.65 &&
    p.height >= b.height * 0.65
  );
}

/**
 * A fail-closed, bounded exit-evidence experiment. It DOES NOT identify cards or
 * count inventory. Unknown/no-match/empty detector results are never inputs.
 *
 * Only the same continuously measured textured card leaving a visible inner ROI
 * can emit an exit. The full quad must remain in the preview guard band. Loss,
 * pauses, camera motion, or uncertainty cancel the arm without releasing a latch.
 * Use one instance inside the existing CV worker and dispose it on unmount.
 */
export class VerifiedCardExitTracker {
  private readonly tracks = new Map<string, Track>();
  // Never evict IDs: eviction would silently allow a second exit for one event.
  // When full, refuse new arms until an explicitly new scan session is created.
  private readonly usedEvents = new Set<string>();
  private background: Feature[] = [];
  private backgroundCount = 0;
  private backgroundTranslation: Point = { x: 0, y: 0 };
  private previous?: Mat;
  private frame?: Omit<ExitFrame, "gray">;
  private lastFrameId = -1;
  private lastTimestamp = -Infinity;
  private disposed = false;
  private readonly options: Required<ExitTrackerOptions>;

  constructor(
    private readonly cv: Cv,
    options: ExitTrackerOptions,
  ) {
    const r = options.region;
    if (
      !r ||
      !Object.values(r).every(Number.isFinite) ||
      r.left <= 0 ||
      r.top <= 0 ||
      r.right >= 1 ||
      r.bottom >= 1 ||
      r.left >= r.right ||
      r.top >= r.bottom
    )
      throw new Error(
        "Exit tracking needs a finite inner scan region and visible guard band.",
      );
    this.options = {
      region: { ...r },
      maxTracks: options.maxTracks ?? 9,
      maxEvents: options.maxEvents ?? 1024,
      maxSampleGapMs: options.maxSampleGapMs ?? 300,
      maxTrackAgeMs: options.maxTrackAgeMs ?? 30_000,
    };
    for (const [name, value, maximum] of [
      ["maxTracks", this.options.maxTracks, 9],
      ["maxEvents", this.options.maxEvents, 4096],
      ["maxSampleGapMs", this.options.maxSampleGapMs, 500],
      ["maxTrackAgeMs", this.options.maxTrackAgeMs, 60_000],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`Invalid bounded exit option: ${name}.`);
    if (
      typeof cv.calcOpticalFlowPyrLK !== "function" ||
      typeof cv.cornerMinEigenVal !== "function" ||
      typeof cv.estimateAffine2D !== "function"
    )
      throw new Error(
        "The shared OpenCV runtime lacks the required optical flow/geometry exports.",
      );
  }

  private validFrame(f: ExitFrame): boolean {
    return (
      !!f &&
      Number.isSafeInteger(f.width) &&
      Number.isSafeInteger(f.height) &&
      f.width >= 64 &&
      f.height >= 64 &&
      Math.max(f.width, f.height) <= MAX_EDGE &&
      f.gray instanceof Uint8Array &&
      f.gray.length === f.width * f.height &&
      Number.isSafeInteger(f.frameId) &&
      f.frameId >= 0 &&
      Number.isFinite(f.timestampMs) &&
      f.timestampMs >= 0
    );
  }

  private region(f: Pick<ExitFrame, "width" | "height">): Quad {
    const r = this.options.region;
    return [
      { x: r.left * f.width, y: r.top * f.height },
      { x: r.right * f.width, y: r.top * f.height },
      { x: r.right * f.width, y: r.bottom * f.height },
      { x: r.left * f.width, y: r.bottom * f.height },
    ];
  }

  private visible(q: Quad, f: Pick<ExitFrame, "width" | "height">): boolean {
    return q.every(
      (p) =>
        finitePoint(p) &&
        p.x >= FRAME_MARGIN &&
        p.y >= FRAME_MARGIN &&
        p.x <= f.width - 1 - FRAME_MARGIN &&
        p.y <= f.height - 1 - FRAME_MARGIN,
    );
  }

  private outside(q: Quad, f: ExitFrame): boolean {
    const r = this.region(f);
    // Conservative separating-axis proof; a mere center crossing never suffices.
    return (
      q.every((p) => p.x < r[0].x - EXIT_MARGIN) ||
      q.every((p) => p.x > r[1].x + EXIT_MARGIN) ||
      q.every((p) => p.y < r[0].y - EXIT_MARGIN) ||
      q.every((p) => p.y > r[2].y + EXIT_MARGIN)
    );
  }

  private selectFeatures(gray: Mat, q?: Quad): Feature[] {
    const cv = this.cv,
      eigen = new cv.Mat();
    try {
      // The installed build omits goodFeaturesToTrack. cornerMinEigenVal is its
      // Shi–Tomasi score; select grid-distributed maxima with distance suppression.
      cv.cornerMinEigenVal(gray, eigen, 3, 3, cv.BORDER_DEFAULT);
      const b = q
        ? bounds(q)
        : { x: 0, y: 0, width: gray.cols, height: gray.rows };
      const region = this.region({ width: gray.cols, height: gray.rows });
      const cells: { point: Point; score: number }[] = [];
      let peak = 0;
      for (let row = 0; row < 6; row++)
        for (let col = 0; col < 8; col++) {
          let best: { point: Point; score: number } | undefined;
          const left = Math.max(
            FRAME_MARGIN,
            Math.ceil(b.x + (col * b.width) / 8),
          );
          const right = Math.min(
            gray.cols - FRAME_MARGIN,
            Math.floor(b.x + ((col + 1) * b.width) / 8),
          );
          const top = Math.max(
            FRAME_MARGIN,
            Math.ceil(b.y + (row * b.height) / 6),
          );
          const bottom = Math.min(
            gray.rows - FRAME_MARGIN,
            Math.floor(b.y + ((row + 1) * b.height) / 6),
          );
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) {
              const point = { x, y };
              if (q ? !insideQuad(point, q, 6) : insideQuad(point, region))
                continue;
              const score = eigen.data32F[y * gray.cols + x];
              if (score > (best?.score ?? 0)) best = { point, score };
            }
          if (best) {
            peak = Math.max(peak, best.score);
            cells.push(best);
          }
        }
      const selected: Feature[] = [];
      for (const { point, score } of cells.sort((a, b) => b.score - a.score)) {
        if (
          score < Math.max(0.0002, peak * 0.015) ||
          selected.some((f) => distance(f.origin, point) < 6)
        )
          continue;
        const values = patch(gray.data, gray.cols, gray.rows, point);
        if (!patchMatches(values, values)) continue;
        selected.push({ origin: point, current: { ...point }, patch: values });
        if (selected.length >= (q ? CARD_POINTS : BACKGROUND_POINTS)) break;
      }
      return selected;
    } finally {
      eigen.delete();
    }
  }

  private backgroundSupport(
    features: Feature[],
    f: Pick<ExitFrame, "width" | "height">,
  ): boolean {
    if (
      features.length < MIN_BACKGROUND_POINTS ||
      features.length < this.backgroundCount * 0.7
    )
      return false;
    const points = features.map((p) => p.current);
    const quadrants = new Set(
      points.map(
        (p) => (p.x >= f.width / 2 ? 1 : 0) + (p.y >= f.height / 2 ? 2 : 0),
      ),
    );
    return (
      quadrants.size === 4 && hullArea(points) >= f.width * f.height * 0.35
    );
  }

  /**
   * Arm only after geometric identity verification, using that exact capture.
   * Delayed processing is allowed: capture time, not wall-clock age, drives the
   * tracker. Replay earlier history first; never rewind existing active tracks.
   */
  arm(seed: VerifiedExitSeed): { armed: boolean; reason?: string } {
    if (this.disposed) return { armed: false, reason: "disposed" };
    const { frame: f, eventId, quad: q } = seed;
    if (seed.geometryVerified !== true)
      return { armed: false, reason: "geometry-unverified" };
    if (!this.validFrame(f)) return { armed: false, reason: "invalid-frame" };
    if (typeof eventId !== "string" || !eventId || eventId.length > 256)
      return { armed: false, reason: "invalid-event" };
    if (this.usedEvents.has(eventId))
      return { armed: false, reason: "event-already-armed" };
    if (
      this.usedEvents.size >= this.options.maxEvents ||
      this.tracks.size >= this.options.maxTracks
    )
      return { armed: false, reason: "capacity" };
    if (
      !Array.isArray(q) ||
      q.length !== 4 ||
      !q.every(finitePoint) ||
      !isConvexQuad(q) ||
      polygonArea(q) < 1200 ||
      !q.every((p) => insideQuad(p, this.region(f), EXIT_MARGIN)) ||
      !this.visible(q, f)
    )
      return { armed: false, reason: "quad-not-inside-region" };
    if (
      [...this.tracks.values()].some(
        (t) => boxIntersectionOverUnion(t.quad, q) > 0.05,
      )
    )
      return { armed: false, reason: "overlapping-track" };
    const b = bounds(q),
      r = this.region(f);
    if (
      Math.max(r[0].x, f.width - r[1].x) <
        b.width + FRAME_MARGIN + EXIT_MARGIN + 4 &&
      Math.max(r[0].y, f.height - r[2].y) <
        b.height + FRAME_MARGIN + EXIT_MARGIN + 4
    )
      return { armed: false, reason: "insufficient-guard-band" };
    if (this.previous && this.frame) {
      if (
        f.frameId !== this.frame.frameId ||
        f.timestampMs !== this.frame.timestampMs ||
        f.width !== this.frame.width ||
        f.height !== this.frame.height ||
        !pixelsEqual(f.gray, this.previous.data)
      )
        return { armed: false, reason: "seed-is-not-current-capture" };
    } else if (
      f.frameId <= this.lastFrameId ||
      f.timestampMs <= this.lastTimestamp
    )
      return { armed: false, reason: "stale-seed" };

    const gray = this.cv.matFromArray(
      f.height,
      f.width,
      this.cv.CV_8UC1,
      f.gray,
    );
    try {
      const features = this.selectFeatures(gray, q);
      if (
        !spatialSupport(
          features.map((p) => p.current),
          q,
        )
      )
        return { armed: false, reason: "insufficient-card-features" };
      const background = this.previous
        ? this.background
        : this.selectFeatures(gray);
      if (!this.backgroundSupport(background, f))
        return { armed: false, reason: "insufficient-background-features" };
      if (!this.previous) {
        this.previous = gray.clone();
        this.frame = {
          width: f.width,
          height: f.height,
          frameId: f.frameId,
          timestampMs: f.timestampMs,
        };
        this.background = background;
        this.backgroundCount = background.length;
      }
      this.lastFrameId = f.frameId;
      this.lastTimestamp = f.timestampMs;
      this.usedEvents.add(eventId);
      this.tracks.set(eventId, {
        eventId,
        originalQuad: cloneQuad(q),
        quad: cloneQuad(q),
        features,
        originalCount: features.length,
        armedAt: f.timestampMs,
        motionSamples: 0,
        outsideSamples: 0,
      });
      return { armed: true };
    } finally {
      gray.delete();
    }
  }

  private opticalFlow(before: Mat, after: Mat, points: Point[]): Flow[] {
    const cv = this.cv;
    const input = cv.matFromArray(
      points.length,
      1,
      cv.CV_32FC2,
      points.flatMap((p) => [p.x, p.y]),
    );
    const output = new cv.Mat(),
      back = new cv.Mat(),
      status = new cv.Mat(),
      backStatus = new cv.Mat();
    const error = new cv.Mat(),
      backError = new cv.Mat();
    try {
      const size = new cv.Size(15, 15),
        criteria = new cv.TermCriteria(
          cv.TermCriteria_COUNT | cv.TermCriteria_EPS,
          20,
          0.01,
        );
      cv.calcOpticalFlowPyrLK(
        before,
        after,
        input,
        output,
        status,
        error,
        size,
        2,
        criteria,
        0,
        0.0001,
      );
      cv.calcOpticalFlowPyrLK(
        after,
        before,
        output,
        back,
        backStatus,
        backError,
        size,
        2,
        criteria,
        0,
        0.0001,
      );
      return points.map((point, i) => {
        const next = { x: output.data32F[i * 2], y: output.data32F[i * 2 + 1] };
        const reverse = { x: back.data32F[i * 2], y: back.data32F[i * 2 + 1] };
        return {
          point: next,
          valid:
            !!status.data[i] &&
            !!backStatus.data[i] &&
            finitePoint(next) &&
            finitePoint(reverse) &&
            error.data32F[i] <= 12 &&
            backError.data32F[i] <= 12 &&
            distance(point, reverse) <= 0.65 &&
            distance(point, next) <= 24,
        };
      });
    } finally {
      input.delete();
      output.delete();
      back.delete();
      status.delete();
      backStatus.delete();
      error.delete();
      backError.delete();
    }
  }

  private fit(
    features: Feature[],
  ): { affine: Affine; inliers: Feature[] } | undefined {
    if (features.length < MIN_CARD_POINTS) return undefined;
    const cv = this.cv,
      mask = new cv.Mat();
    const from = cv.matFromArray(
      features.length,
      1,
      cv.CV_32FC2,
      features.flatMap((p) => [p.origin.x, p.origin.y]),
    );
    const to = cv.matFromArray(
      features.length,
      1,
      cv.CV_32FC2,
      features.flatMap((p) => [p.current.x, p.current.y]),
    );
    let matrix: Mat | undefined;
    try {
      matrix = cv.estimateAffine2D(
        from,
        to,
        mask,
        cv.RANSAC,
        0.9,
        100,
        0.995,
        10,
      ) as Mat;
      if (matrix.rows !== 2 || matrix.cols !== 3) return undefined;
      const affine = Array.from(matrix.data64F) as Affine;
      if (!affine.every(Number.isFinite)) return undefined;
      const sx = Math.hypot(affine[0], affine[3]),
        sy = Math.hypot(affine[1], affine[4]);
      const shear =
        Math.abs(affine[0] * affine[1] + affine[3] * affine[4]) / (sx * sy);
      // This is deliberately not a perspective/large rotation reacquisition model.
      if (
        sx < 0.92 ||
        sx > 1.08 ||
        sy < 0.92 ||
        sy > 1.08 ||
        shear > 0.05 ||
        affine[0] * affine[4] - affine[1] * affine[3] <= 0 ||
        Math.abs(Math.atan2(affine[3], affine[0])) > 0.18
      )
        return undefined;
      const inliers = features.filter(
        (p, i) =>
          mask.data[i] &&
          distance(transform(affine, p.origin), p.current) <= 0.9,
      );
      if (inliers.length < features.length * 0.9) return undefined;
      return { affine, inliers };
    } finally {
      from.delete();
      to.delete();
      mask.delete();
      matrix?.delete();
    }
  }

  private clearPixels(): void {
    this.previous?.delete();
    this.previous = undefined;
    this.frame = undefined;
    this.background = [];
    this.backgroundCount = 0;
    this.backgroundTranslation = { x: 0, y: 0 };
  }

  /** Always call on pause, hidden page, source switch, or unmount. Never rearms. */
  invalidate(reason: ExitInvalidationReason = "explicit"): ExitUpdate {
    const cancelled = [...this.tracks.keys()].map((eventId) => ({
      eventId,
      reason,
    }));
    this.tracks.clear();
    this.clearPixels();
    return { exits: [], cancelled, ignored: false, processingMs: 0 };
  }

  ingest(f: ExitFrame): ExitUpdate {
    const start = performance.now();
    const finish = (result: ExitUpdate): ExitUpdate => ({
      ...result,
      processingMs: performance.now() - start,
    });
    const empty = (): ExitUpdate => ({
      exits: [],
      cancelled: [],
      ignored: true,
      processingMs: 0,
    });
    if (this.disposed || !this.previous || !this.frame || !this.tracks.size)
      return finish(empty());
    if (!this.validFrame(f)) return finish(this.invalidate("invalid-frame"));
    if (f.frameId <= this.lastFrameId || f.timestampMs <= this.lastTimestamp)
      return finish(this.invalidate("frame-reordered"));
    if (f.width !== this.frame.width || f.height !== this.frame.height)
      return finish(this.invalidate("frame-size-changed"));
    if (f.timestampMs - this.frame.timestampMs > this.options.maxSampleGapMs)
      return finish(this.invalidate("sample-gap"));
    this.lastFrameId = f.frameId;
    this.lastTimestamp = f.timestampMs;
    // A repeated camera buffer does not advance flow, elapsed outside evidence, or
    // last genuinely observed frame time. Eventually the sample-gap rule cancels.
    if (pixelsEqual(f.gray, this.previous.data)) return finish(empty());

    const current = this.cv.matFromArray(
      f.height,
      f.width,
      this.cv.CV_8UC1,
      f.gray,
    );
    const result: ExitUpdate = {
      exits: [],
      cancelled: [],
      ignored: false,
      processingMs: 0,
    };
    const pendingExits: VerifiedExit[] = [];
    try {
      const tracks = [...this.tracks.values()];
      const all = [...this.background, ...tracks.flatMap((t) => t.features)];
      const flow = this.opticalFlow(
        this.previous,
        current,
        all.map((p) => p.current),
      );
      const background: Feature[] = [];
      for (let i = 0; i < this.background.length; i++) {
        const feature = this.background[i],
          measured = flow[i];
        if (!measured.valid) continue;
        const translation: Affine = [
          1,
          0,
          measured.point.x - feature.origin.x,
          0,
          1,
          measured.point.y - feature.origin.y,
        ];
        if (
          !patchMatches(
            feature.patch,
            patch(f.gray, f.width, f.height, feature.origin, translation),
          )
        )
          continue;
        background.push({ ...feature, current: measured.point });
      }
      if (!this.backgroundSupport(background, f))
        return finish(this.invalidate("background-lost"));
      // Small measured whole-frame translations are compensated, not counted as
      // card motion. This is an absolute bound against the original background,
      // not a per-frame drift allowance. A slow pan cannot accumulate unseen.
      const translation = {
        x: median(background.map((p) => p.current.x - p.origin.x)),
        y: median(background.map((p) => p.current.y - p.origin.y)),
      };
      if (
        Math.abs(translation.x) > MAX_GLOBAL_TRANSLATION ||
        Math.abs(translation.y) > MAX_GLOBAL_TRANSLATION ||
        Math.abs(translation.x - this.backgroundTranslation.x) >
          MAX_GLOBAL_STEP ||
        Math.abs(translation.y - this.backgroundTranslation.y) > MAX_GLOBAL_STEP
      )
        return finish(this.invalidate("camera-motion"));
      const stableBackground = background.filter(
        (p) =>
          distance(p.current, {
            x: p.origin.x + translation.x,
            y: p.origin.y + translation.y,
          }) <= MAX_BACKGROUND_RESIDUAL,
      );
      if (
        background.length - stableBackground.length >= 3 ||
        !this.backgroundSupport(stableBackground, f)
      )
        return finish(this.invalidate("camera-motion"));
      this.background = stableBackground;

      let offset =
        all.length - tracks.reduce((n, t) => n + t.features.length, 0);
      for (const track of tracks) {
        const observed = track.features.flatMap((feature, i) =>
          flow[offset + i].valid
            ? [{ ...feature, current: flow[offset + i].point }]
            : [],
        );
        offset += track.features.length;
        const cancel = (reason: ExitInvalidationReason) => {
          this.tracks.delete(track.eventId);
          result.cancelled.push({ eventId: track.eventId, reason });
        };
        if (f.timestampMs - track.armedAt > this.options.maxTrackAgeMs) {
          cancel("track-expired");
          continue;
        }
        if (observed.length < track.originalCount * 0.85) {
          cancel("feature-lost");
          continue;
        }
        const fit = this.fit(observed);
        if (!fit) {
          cancel("geometry-lost");
          continue;
        }
        const quad = track.originalQuad.map((p) =>
          transform(fit.affine, p),
        ) as Quad;
        if (!this.visible(quad, f)) {
          cancel("preview-clipped");
          continue;
        }
        if (
          !isConvexQuad(quad) ||
          quad.some((p, i) => distance(p, track.quad[i]) > 24)
        ) {
          cancel("geometry-lost");
          continue;
        }
        const supported = fit.inliers.filter((p) =>
          patchMatches(
            p.patch,
            patch(f.gray, f.width, f.height, p.origin, fit.affine),
          ),
        );
        if (supported.length < track.originalCount * 0.85) {
          cancel("appearance-changed");
          continue;
        }
        if (
          !spatialSupport(
            supported.map((p) => p.origin),
            track.originalQuad,
          ) ||
          !spatialSupport(
            supported.map((p) => p.current),
            quad,
          )
        ) {
          cancel("geometry-lost");
          continue;
        }
        const previousCenter = center(track.quad),
          currentCenter = center(quad);
        const motion = distance(
          {
            x: previousCenter.x - this.backgroundTranslation.x,
            y: previousCenter.y - this.backgroundTranslation.y,
          },
          {
            x: currentCenter.x - translation.x,
            y: currentCenter.y - translation.y,
          },
        );
        if (motion >= MIN_MOTION) track.motionSamples++;
        const compensatedQuad = quad.map((p) => ({
          x: p.x - translation.x,
          y: p.y - translation.y,
        })) as Quad;
        if (this.outside(quad, f) && this.outside(compensatedQuad, f)) {
          if (motion >= MIN_MOTION) {
            track.outsideSamples++;
            track.outsideSince ??= f.timestampMs;
          }
        } else {
          track.outsideSamples = 0;
          track.outsideSince = undefined;
        }
        track.quad = quad;
        track.features = supported;
        if (
          track.outsideSamples >= 2 &&
          track.motionSamples >= 3 &&
          track.outsideSince !== undefined &&
          f.timestampMs - track.outsideSince >= 60 &&
          motion >= MIN_MOTION
        ) {
          pendingExits.push({
            eventId: track.eventId,
            kind: "verified-roi-exit",
            frameId: f.frameId,
            timestampMs: f.timestampMs,
            quad: cloneQuad(quad),
            supportingPoints: supported.length,
          });
        }
      }
      // Do not let independently armed tracks merge into one apparent card.
      // Validate all current quads before emitting any pending exits.
      const remaining = [...this.tracks.values()],
        overlaps = new Set<string>();
      for (let i = 0; i < remaining.length; i++)
        for (let j = i + 1; j < remaining.length; j++) {
          if (
            boxIntersectionOverUnion(remaining[i].quad, remaining[j].quad) >
            0.05
          ) {
            overlaps.add(remaining[i].eventId);
            overlaps.add(remaining[j].eventId);
          }
        }
      for (const eventId of overlaps) {
        this.tracks.delete(eventId);
        result.cancelled.push({ eventId, reason: "track-overlap" });
      }
      for (const exit of pendingExits)
        if (this.tracks.has(exit.eventId)) {
          result.exits.push(exit);
          this.tracks.delete(exit.eventId);
        }
      this.previous.delete();
      this.previous = current.clone();
      this.backgroundTranslation = translation;
      this.frame = {
        width: f.width,
        height: f.height,
        frameId: f.frameId,
        timestampMs: f.timestampMs,
      };
      if (!this.tracks.size) this.clearPixels();
      return finish(result);
    } catch {
      return finish(this.invalidate("runtime-error"));
    } finally {
      current.delete();
    }
  }

  /** Bounded diagnostics; no retained historical frames or private camera pixels. */
  snapshot(): {
    active: number;
    usedEvents: number;
    pointCount: number;
    retainedFrames: number;
  } {
    return {
      active: this.tracks.size,
      usedEvents: this.usedEvents.size,
      pointCount:
        this.background.length +
        [...this.tracks.values()].reduce((n, t) => n + t.features.length, 0),
      retainedFrames: this.previous ? 1 : 0,
    };
  }

  dispose(): void {
    this.invalidate("unmounted");
    this.disposed = true;
  }
}
