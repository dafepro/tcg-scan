import type * as OpenCv from "@techstark/opencv-js";
import {
  bounds,
  distance,
  hullArea,
  isConvexQuad,
  polygonArea,
} from "./geometry";
import type { Point, Quad } from "./types";

/** Real captures from one sampled stream; assign consecutive IDs at capture. */
export interface RoiContinuityFrame {
  width: number;
  height: number;
  gray: Uint8Array;
  frameId: number;
  timestampMs: number;
}

export interface RoiContinuitySeed {
  eventId: string;
  /** Only the existing unchanged geometric identity verifier may assert this. */
  geometryVerified: true;
  quad: Quad;
  frame: RoiContinuityFrame;
}

/** All timestamps use the same monotonic capture clock, including checkedAt. */
export interface RoiLatestCapture {
  frameId: number;
  timestampMs: number;
  checkedAtTimestampMs: number;
}

export interface RoiContinuityOptions {
  maxSamples?: number;
  maxDurationMs?: number;
  maxSampleGapMs?: number;
  minDurationMs?: number;
  maxLatestAgeMs?: number;
}

export type RoiContinuityReason =
  | "more-samples"
  | "duration-too-short"
  | "latest-capture-stale"
  | "not-armed"
  | "already-armed"
  | "geometry-unverified"
  | "invalid-seed"
  | "invalid-frame"
  | "frame-reordered"
  | "missing-frame"
  | "sample-gap"
  | "frame-size-changed"
  | "history-overflow"
  | "duration-overflow"
  | "invalid-latest"
  | "missing-latest"
  | "insufficient-features"
  | "feature-lost"
  | "geometry-lost"
  | "appearance-changed"
  | "preview-clipped"
  | "paused"
  | "hidden"
  | "unmounted"
  | "source-changed"
  | "explicit"
  | "runtime-error";

interface ResultBase {
  eventId?: string;
  processingMs: number;
  postSeedSamples: number;
  /** Continuity is neither another identity inference nor an absence signal. */
  identityObservations: 0;
  exitEvidence: false;
}

export type RoiContinuityResult = ResultBase &
  (
    | { status: "pending" | "rejected"; reason: RoiContinuityReason }
    | {
        status: "continuous";
        kind: "verified-roi-continuity";
        seedFrameId: number;
        latestFrameId: number;
        latestTimestampMs: number;
        durationMs: number;
        latestQuad: Quad;
        supportingPoints: number;
        appearance: { gain: number; offset: number; rms: number };
      }
  );

type Cv = typeof OpenCv;
type Mat = OpenCv.Mat;
type Affine = [number, number, number, number, number, number];
interface Feature {
  origin: Point;
  current: Point;
}
interface AppearanceAnchor {
  point: Point;
  values: number[];
}
interface Appearance {
  gain: number;
  offset: number;
  rms: number;
}

const MAX_POINTS = 48,
  MIN_POINTS = 20;
const MAX_EDGE = 640,
  MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const MARGIN = 8,
  PATCH_RADIUS = 2;
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const cloneQuad = (q: Quad): Quad => q.map((p) => ({ ...p })) as Quad;
const finitePoint = (p: Point) =>
  Number.isFinite(p?.x) && Number.isFinite(p?.y);
const transform = (a: Affine, p: Point): Point => ({
  x: a[0] * p.x + a[1] * p.y + a[2],
  y: a[3] * p.x + a[4] * p.y + a[5],
});

function inside(p: Point, q: Quad, inset: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i],
      b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (
      Math.abs(cross) < inset * distance(a, b) ||
      (sign && sign !== Math.sign(cross))
    )
      return false;
    sign = Math.sign(cross);
  }
  return true;
}

function support(points: Point[], q: Quad): boolean {
  if (points.length < MIN_POINTS || hullArea(points) < polygonArea(q) * 0.42)
    return false;
  const b = bounds(q),
    p = bounds(points);
  const center = {
    x: q.reduce((n, c) => n + c.x, 0) / 4,
    y: q.reduce((n, c) => n + c.y, 0) / 4,
  };
  const quadrants = new Set(
    points.map((p) => (p.x >= center.x ? 1 : 0) + (p.y >= center.y ? 2 : 0)),
  );
  return (
    quadrants.size === 4 &&
    p.width >= b.width * 0.65 &&
    p.height >= b.height * 0.65
  );
}

function sample(
  f: Pick<RoiContinuityFrame, "gray" | "width" | "height">,
  p: Point,
): number {
  const x = Math.floor(p.x),
    y = Math.floor(p.y),
    dx = p.x - x,
    dy = p.y - y;
  if (x < 0 || y < 0 || x + 1 >= f.width || y + 1 >= f.height) return NaN;
  return (
    f.gray[y * f.width + x] * (1 - dx) * (1 - dy) +
    f.gray[y * f.width + x + 1] * dx * (1 - dy) +
    f.gray[(y + 1) * f.width + x] * (1 - dx) * dy +
    f.gray[(y + 1) * f.width + x + 1] * dx * dy
  );
}

function patch(
  f: Pick<RoiContinuityFrame, "gray" | "width" | "height">,
  p: Point,
  a: Affine,
): number[] {
  const values: number[] = [];
  for (let y = -PATCH_RADIUS; y <= PATCH_RADIUS; y++)
    for (let x = -PATCH_RADIUS; x <= PATCH_RADIUS; x++)
      values.push(sample(f, transform(a, { x: p.x + x, y: p.y + y })));
  return values;
}

/**
 * Single-presentation, card-only continuity experiment. Reuses the supplied CV
 * runtime; never loads a model/runtime, detects an identity, or proves an exit.
 * Each accepted replay proves only continuity through its named latest capture.
 * The caller must still reject stale session generations/results before saving.
 */
export class RoiContinuityGuard {
  private readonly options: Required<RoiContinuityOptions>;
  private terminal?: RoiContinuityReason;
  private seed?: {
    eventId: string;
    quad: Quad;
    frameId: number;
    timestampMs: number;
  };
  private current?: Omit<RoiContinuityFrame, "gray">;
  private previous?: Mat;
  private features: Feature[] = [];
  private originalCount = 0;
  private anchors: AppearanceAnchor[] = [];
  private quad?: Quad;
  private appearance: Appearance = { gain: 1, offset: 0, rms: 0 };
  private samples = 0;
  private lastCheckedAt = -Infinity;

  constructor(
    private readonly cv: Cv,
    options: RoiContinuityOptions = {},
  ) {
    this.options = {
      maxSamples: options.maxSamples ?? 120,
      maxDurationMs: options.maxDurationMs ?? 12_000,
      maxSampleGapMs: options.maxSampleGapMs ?? 300,
      minDurationMs: options.minDurationMs ?? 160,
      maxLatestAgeMs: options.maxLatestAgeMs ?? 300,
    };
    for (const [name, value, min, max] of [
      ["maxSamples", this.options.maxSamples, 2, 120],
      ["maxDurationMs", this.options.maxDurationMs, 160, 12_000],
      ["maxSampleGapMs", this.options.maxSampleGapMs, 1, 500],
      ["minDurationMs", this.options.minDurationMs, 100, 500],
      ["maxLatestAgeMs", this.options.maxLatestAgeMs, 1, 500],
    ] as const)
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`Invalid bounded continuity option: ${name}.`);
    if (this.options.minDurationMs > this.options.maxDurationMs)
      throw new Error("Continuity duration bounds conflict.");
    if (
      typeof cv.cornerMinEigenVal !== "function" ||
      typeof cv.calcOpticalFlowPyrLK !== "function" ||
      typeof cv.estimateAffine2D !== "function"
    )
      throw new Error("The existing OpenCV runtime lacks continuity exports.");
  }

  private result(
    status: "pending" | "rejected",
    reason: RoiContinuityReason,
    processingMs = 0,
  ): RoiContinuityResult {
    return {
      status,
      reason,
      eventId: this.seed?.eventId,
      postSeedSamples: this.samples,
      identityObservations: 0,
      exitEvidence: false,
      processingMs,
    };
  }

  private valid(f: RoiContinuityFrame): boolean {
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

  private visible(
    q: Quad,
    f: Pick<RoiContinuityFrame, "width" | "height">,
  ): boolean {
    return q.every(
      (p) =>
        finitePoint(p) &&
        p.x >= MARGIN &&
        p.y >= MARGIN &&
        p.x <= f.width - MARGIN - 1 &&
        p.y <= f.height - MARGIN - 1,
    );
  }

  private select(gray: Mat, q: Quad): Feature[] {
    const eigen = new this.cv.Mat(),
      b = bounds(q);
    try {
      this.cv.cornerMinEigenVal(gray, eigen, 3, 3, this.cv.BORDER_DEFAULT);
      const candidates: { point: Point; score: number }[] = [];
      let peak = 0;
      for (let row = 0; row < 6; row++)
        for (let col = 0; col < 8; col++) {
          let best: { point: Point; score: number } | undefined;
          for (
            let y = Math.ceil(b.y + (row * b.height) / 6);
            y < Math.floor(b.y + ((row + 1) * b.height) / 6);
            y++
          )
            for (
              let x = Math.ceil(b.x + (col * b.width) / 8);
              x < Math.floor(b.x + ((col + 1) * b.width) / 8);
              x++
            ) {
              const point = { x, y };
              if (!inside(point, q, 6)) continue;
              const score = eigen.data32F[y * gray.cols + x];
              if (score > (best?.score ?? 0)) best = { point, score };
            }
          if (best) {
            peak = Math.max(peak, best.score);
            candidates.push(best);
          }
        }
      const features: Feature[] = [];
      for (const { point, score } of candidates.sort(
        (a, b) => b.score - a.score,
      )) {
        if (
          score < Math.max(0.0002, peak * 0.015) ||
          features.some((p) => distance(p.origin, point) < 6)
        )
          continue;
        features.push({ origin: point, current: { ...point } });
        if (features.length === MAX_POINTS) break;
      }
      return features;
    } finally {
      eigen.delete();
    }
  }

  private makeAnchors(f: RoiContinuityFrame, q: Quad): AppearanceAnchor[] {
    const anchors: AppearanceAnchor[] = [];
    // Dense card-interior anchors cover flat areas too, so tracking a surviving
    // textured corner cannot conceal a large blank/glared/occluded region.
    for (let row = 0; row < 16; row++)
      for (let col = 0; col < 12; col++) {
        const u = (col + 0.5) / 12,
          v = (row + 0.5) / 16;
        const point = {
          x:
            (1 - v) * ((1 - u) * q[0].x + u * q[1].x) +
            v * ((1 - u) * q[3].x + u * q[2].x),
          y:
            (1 - v) * ((1 - u) * q[0].y + u * q[1].y) +
            v * ((1 - u) * q[3].y + u * q[2].y),
        };
        if (inside(point, q, PATCH_RADIUS + 1))
          anchors.push({ point, values: patch(f, point, IDENTITY) });
      }
    return anchors;
  }

  arm(seed: RoiContinuitySeed): RoiContinuityResult {
    if (this.terminal) return this.result("rejected", this.terminal);
    if (this.seed) return this.result("rejected", "already-armed");
    if (seed.geometryVerified !== true)
      return this.invalidate("geometry-unverified");
    const f = seed.frame,
      q = seed.quad;
    if (
      !this.valid(f) ||
      typeof seed.eventId !== "string" ||
      !seed.eventId ||
      seed.eventId.length > 256 ||
      !Array.isArray(q) ||
      q.length !== 4 ||
      !q.every(finitePoint) ||
      !isConvexQuad(q) ||
      polygonArea(q) < 1200
    )
      return this.invalidate("invalid-seed");
    if (!this.visible(q, f)) return this.invalidate("preview-clipped");
    const gray = this.cv.matFromArray(
      f.height,
      f.width,
      this.cv.CV_8UC1,
      f.gray,
    );
    let retained = false;
    try {
      const features = this.select(gray, q);
      if (
        !support(
          features.map((p) => p.origin),
          q,
        )
      )
        return this.invalidate("insufficient-features");
      const anchors = this.makeAnchors({ ...f, gray: gray.data }, q);
      if (anchors.length < 100) return this.invalidate("insufficient-features");
      this.seed = {
        eventId: seed.eventId,
        quad: cloneQuad(q),
        frameId: f.frameId,
        timestampMs: f.timestampMs,
      };
      this.current = {
        width: f.width,
        height: f.height,
        frameId: f.frameId,
        timestampMs: f.timestampMs,
      };
      this.features = features;
      this.originalCount = features.length;
      this.anchors = anchors;
      this.quad = cloneQuad(q);
      this.previous = gray;
      retained = true;
      return this.result("pending", "more-samples");
    } catch {
      return this.invalidate("runtime-error");
    } finally {
      if (!retained) gray.delete();
    }
  }

  private flow(before: Mat, after: Mat): Feature[] {
    const cv = this.cv,
      input = cv.matFromArray(
        this.features.length,
        1,
        cv.CV_32FC2,
        this.features.flatMap((p) => [p.current.x, p.current.y]),
      );
    const output = new cv.Mat(),
      backward = new cv.Mat(),
      status = new cv.Mat(),
      backStatus = new cv.Mat(),
      errors = new cv.Mat(),
      backErrors = new cv.Mat();
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
        errors,
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
        backward,
        backStatus,
        backErrors,
        size,
        2,
        criteria,
        0,
        0.0001,
      );
      return this.features.flatMap((p, i) => {
        const current = {
          x: output.data32F[i * 2],
          y: output.data32F[i * 2 + 1],
        };
        const back = {
          x: backward.data32F[i * 2],
          y: backward.data32F[i * 2 + 1],
        };
        return status.data[i] &&
          backStatus.data[i] &&
          finitePoint(current) &&
          finitePoint(back) &&
          errors.data32F[i] <= 35 &&
          backErrors.data32F[i] <= 35 &&
          distance(p.current, back) <= 0.7 &&
          distance(p.current, current) <= 24
          ? [{ origin: p.origin, current }]
          : [];
      });
    } finally {
      input.delete();
      output.delete();
      backward.delete();
      status.delete();
      backStatus.delete();
      errors.delete();
      backErrors.delete();
    }
  }

  private fit(
    features: Feature[],
  ): { affine: Affine; inliers: Feature[] } | undefined {
    if (features.length < MIN_POINTS) return undefined;
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
      const a = Array.from(matrix.data64F) as Affine;
      if (!a.every(Number.isFinite)) return undefined;
      const sx = Math.hypot(a[0], a[3]),
        sy = Math.hypot(a[1], a[4]);
      if (
        sx < 0.92 ||
        sx > 1.08 ||
        sy < 0.92 ||
        sy > 1.08 ||
        a[0] * a[4] - a[1] * a[3] <= 0 ||
        Math.abs(a[0] * a[1] + a[3] * a[4]) / (sx * sy) > 0.05 ||
        Math.abs(Math.atan2(a[3], a[0])) > 0.18
      )
        return undefined;
      const inliers = features.filter(
        (p, i) =>
          mask.data[i] && distance(transform(a, p.origin), p.current) <= 0.9,
      );
      if (inliers.length < features.length * 0.9) return undefined;
      return { affine: a, inliers };
    } finally {
      from.delete();
      to.delete();
      mask.delete();
      matrix?.delete();
    }
  }

  private compareAppearance(
    f: RoiContinuityFrame,
    a: Affine,
  ): Appearance | undefined {
    const observed = this.anchors.map((anchor) => patch(f, anchor.point, a));
    let n = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0;
    for (let i = 0; i < this.anchors.length; i++)
      for (let j = 0; j < this.anchors[i].values.length; j++) {
        const x = this.anchors[i].values[j],
          y = observed[i][j];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
        n++;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
    const meanX = sx / n,
      meanY = sy / n,
      varX = sxx / n - meanX ** 2,
      varY = syy / n - meanY ** 2;
    const cov = sxy / n - meanX * meanY,
      gain = cov / varX,
      offset = meanY - gain * meanX;
    if (
      varX < 100 ||
      varY < 100 ||
      gain < 0.8 ||
      gain > 1.2 ||
      Math.abs(offset) > 24 ||
      cov / Math.sqrt(varX * varY) < 0.97
    )
      return undefined;
    let totalError = 0,
      bad = 0;
    for (let i = 0; i < this.anchors.length; i++) {
      let error = 0;
      for (let j = 0; j < this.anchors[i].values.length; j++)
        error +=
          (observed[i][j] - (gain * this.anchors[i].values[j] + offset)) ** 2;
      totalError += error;
      if (Math.sqrt(error / observed[i].length) > 15) bad++;
    }
    const rms = Math.sqrt(totalError / n);
    if (rms > 9 || bad > 2) return undefined;
    return { gain, offset, rms };
  }

  private advance(f: RoiContinuityFrame): RoiContinuityReason | undefined {
    const gray = this.cv.matFromArray(
      f.height,
      f.width,
      this.cv.CV_8UC1,
      f.gray,
    );
    let retained = false;
    try {
      const observed = this.flow(this.previous!, gray);
      if (observed.length < this.originalCount * 0.85) return "feature-lost";
      const fit = this.fit(observed);
      if (!fit || fit.inliers.length < this.originalCount * 0.85)
        return "geometry-lost";
      const q = this.seed!.quad.map((p) => transform(fit.affine, p)) as Quad;
      if (!this.visible(q, f)) return "preview-clipped";
      if (
        !isConvexQuad(q) ||
        q.some((p, i) => distance(p, this.quad![i]) > 24) ||
        !support(
          fit.inliers.map((p) => p.origin),
          this.seed!.quad,
        ) ||
        !support(
          fit.inliers.map((p) => p.current),
          q,
        )
      )
        return "geometry-lost";
      const appearance = this.compareAppearance(
        { ...f, gray: gray.data },
        fit.affine,
      );
      if (!appearance) return "appearance-changed";
      this.previous!.delete();
      this.previous = gray;
      retained = true;
      this.features = fit.inliers;
      this.quad = q;
      this.appearance = appearance;
      this.samples++;
      this.current = {
        width: f.width,
        height: f.height,
        frameId: f.frameId,
        timestampMs: f.timestampMs,
      };
      return undefined;
    } finally {
      if (!retained) gray.delete();
    }
  }

  /**
   * Supplied history is consumed synchronously in order, never retained as a ring.
   * Validate the entire batch before advancing; no partial proof on a bad suffix.
   * Fresh identical pixels are valid if their capture IDs/timestamps truly advance.
   */
  replay(
    frames: readonly RoiContinuityFrame[],
    latest: RoiLatestCapture,
  ): RoiContinuityResult {
    const start = performance.now();
    const finish = (r: RoiContinuityResult): RoiContinuityResult => ({
      ...r,
      processingMs: performance.now() - start,
    });
    if (this.terminal) return finish(this.result("rejected", this.terminal));
    if (!this.seed || !this.current || !this.previous)
      return finish(this.result("rejected", "not-armed"));
    const reject = (reason: RoiContinuityReason) =>
      finish(this.invalidate(reason));
    if (
      !Array.isArray(frames) ||
      frames.length + this.samples > this.options.maxSamples
    )
      return reject("history-overflow");
    let previous = this.current,
      bytes = this.current.width * this.current.height;
    for (const f of frames) {
      if (!this.valid(f)) return reject("invalid-frame");
      bytes += f.gray.byteLength;
      if (bytes > MAX_REPLAY_BYTES) return reject("history-overflow");
      if (f.width !== previous.width || f.height !== previous.height)
        return reject("frame-size-changed");
      if (
        f.frameId <= previous.frameId ||
        f.timestampMs <= previous.timestampMs
      )
        return reject("frame-reordered");
      if (f.frameId !== previous.frameId + 1) return reject("missing-frame");
      if (f.timestampMs - previous.timestampMs > this.options.maxSampleGapMs)
        return reject("sample-gap");
      if (f.timestampMs - this.seed.timestampMs > this.options.maxDurationMs)
        return reject("duration-overflow");
      previous = f;
    }
    if (
      !latest ||
      !Number.isSafeInteger(latest.frameId) ||
      !Number.isFinite(latest.timestampMs) ||
      !Number.isFinite(latest.checkedAtTimestampMs) ||
      latest.checkedAtTimestampMs < latest.timestampMs ||
      latest.checkedAtTimestampMs < this.lastCheckedAt
    )
      return reject("invalid-latest");
    if (
      latest.frameId !== previous.frameId ||
      latest.timestampMs !== previous.timestampMs
    )
      return reject("missing-latest");
    this.lastCheckedAt = latest.checkedAtTimestampMs;
    try {
      for (const f of frames) {
        const reason = this.advance(f);
        if (reason) return reject(reason);
      }
    } catch {
      return reject("runtime-error");
    }
    if (this.samples < 2) return finish(this.result("pending", "more-samples"));
    const durationMs = this.current.timestampMs - this.seed.timestampMs;
    if (durationMs < this.options.minDurationMs)
      return finish(this.result("pending", "duration-too-short"));
    // Expensive replay can make an otherwise current batch stale. Keep the
    // measured state but withhold proof until a fresh tail has been replayed.
    if (
      latest.checkedAtTimestampMs +
        performance.now() -
        start -
        latest.timestampMs >
      this.options.maxLatestAgeMs
    )
      return finish(this.result("pending", "latest-capture-stale"));
    return finish({
      status: "continuous",
      kind: "verified-roi-continuity",
      eventId: this.seed.eventId,
      seedFrameId: this.seed.frameId,
      latestFrameId: this.current.frameId,
      latestTimestampMs: this.current.timestampMs,
      latestQuad: cloneQuad(this.quad!),
      supportingPoints: this.features.length,
      durationMs,
      appearance: { ...this.appearance },
      postSeedSamples: this.samples,
      identityObservations: 0,
      exitEvidence: false,
      processingMs: 0,
    });
  }

  /** Permanent for this guard. Late saved results/captures must use no old guard. */
  invalidate(reason: RoiContinuityReason = "explicit"): RoiContinuityResult {
    this.terminal ??= reason;
    this.previous?.delete();
    this.previous = undefined;
    this.features = [];
    this.anchors = [];
    this.quad = undefined;
    return this.result("rejected", this.terminal);
  }

  snapshot(): {
    active: boolean;
    pointCount: number;
    appearanceAnchors: number;
    retainedFrames: number;
    postSeedSamples: number;
  } {
    return {
      active: !!this.previous && !this.terminal,
      pointCount: this.features.length,
      appearanceAnchors: this.anchors.length,
      retainedFrames: this.previous ? 1 : 0,
      postSeedSamples: this.samples,
    };
  }

  dispose(): void {
    this.invalidate("unmounted");
  }
}
