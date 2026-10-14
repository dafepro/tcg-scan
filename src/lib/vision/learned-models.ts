import type * as OpenCv from "@techstark/opencv-js";
import * as ort from "onnxruntime-web/wasm";
import type { LearnedModels, LearnedQueryFeatures } from "./learned-types";
import type { Quad } from "./types";

/** Pinned data and runtime. Keep in sync with prepare-vision-models.mjs. */
export const LEARNED_ASSETS = {
  "xfeat_backbone.onnx": { bytes: 187433, sha256: "86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0" },
  "xfeat_backbone.onnx.data": { bytes: 2632324, sha256: "d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9" },
  "fastweb-single-1.39.onnx": { bytes: 3185226, sha256: "05d2b90b928a5a3bf0f49aa90aa86211b2103d9c347c238fd18b4f544b3cb8ca" },
  "ort-wasm-simd-threaded.wasm": { bytes: 14239897, sha256: "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2" },
} as const;
export type LearnedAssetName = keyof typeof LEARNED_ASSETS;
export type LearnedAssetBytes = Record<LearnedAssetName, Uint8Array<ArrayBuffer>>;
type Cv = typeof OpenCv;
export interface LearnedModelOptions {
  /** Resolved against the current Worker/page URL. Cross-origin URLs are rejected. */
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { asset: LearnedAssetName; loadedBytes: number; totalBytes: number }) => void;
}
const WIDTH = 224, HEIGHT = 320, D_WIDTH = 28, D_HEIGHT = 40, CHANNELS = 64;
const f32 = Math.fround;
let verifiedRuntimeInitialized = false;
const assetNames = Object.keys(LEARNED_ASSETS) as LearnedAssetName[];
const totalAssetBytes = assetNames.reduce((n, name) => n + LEARNED_ASSETS[name].bytes, 0);
const abort = (signal?: AbortSignal) => { signal?.throwIfAborted(); };

/** SHA-256 checks are mandatory even for the trusted offline asset injection path. */
export async function verifyLearnedAsset(name: LearnedAssetName, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const expected = LEARNED_ASSETS[name];
  if (bytes.byteLength !== expected.bytes) throw new Error(`Incorrect byte count for ${name}.`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.sha256) throw new Error(`Integrity check failed for ${name}.`);
}

export async function createLearnedModels(cv: Cv, options: LearnedModelOptions = {}): Promise<LearnedModels> {
  if (typeof location === "undefined") throw new Error("Use verified local assets for offline model loading.");
  const base = new URL(options.baseUrl ?? "/vision-models/", location.href);
  if (base.origin !== location.origin || !["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Learned model assets must be served from this app's origin.");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  let loadedBytes = 0;
  const assets = {} as LearnedAssetBytes;
  // Sequential bounded reads avoid four simultaneous response-buffer copies.
  for (const name of assetNames) {
    abort(options.signal);
    const response = await fetch(new URL(name, base), { signal: options.signal, credentials: "omit", redirect: "error", mode: "same-origin" });
    if (!response.ok || !response.body) throw new Error(`Could not load local vision asset ${name} (${response.status}).`);
    const expected = LEARNED_ASSETS[name].bytes;
    const buffer = new Uint8Array(expected);
    const reader = response.body.getReader();
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (length + value.byteLength > expected) throw new Error(`Oversized vision asset ${name}.`);
        buffer.set(value, length); length += value.byteLength;
        options.onProgress?.({ asset: name, loadedBytes: loadedBytes + length, totalBytes: totalAssetBytes });
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (length !== expected) throw new Error(`Incomplete vision asset ${name}.`);
    assets[name] = buffer;
    loadedBytes += length;
  }
  return createLearnedModelsFromAssets(cv, assets, options);
}

function validateImage(image: ImageData, canonical = false): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 2 || image.height < 2 || image.width > 4096 || image.height > 4096 || image.width * image.height > 16_000_000 || image.data.length !== image.width * image.height * 4) {
    throw new Error("Vision input must be RGBA, at most 4096 pixels per side and 16 million pixels.");
  }
  if (canonical && (image.width !== 240 || image.height !== 336)) throw new Error("Learned extraction requires the unchanged 240 x 336 canonical card crop.");
}

/** Frozen RGB float32 0..255 resize. Deliberately no /255 or ImageNet transform. */
export function preprocessXFeat(cv: Cv, image: ImageData): Float32Array {
  validateImage(image, true);
  const input = cv.matFromImageData(image), rgb = new cv.Mat(), floating = new cv.Mat(), resized = new cv.Mat();
  try {
    cv.cvtColor(input, rgb, cv.COLOR_RGBA2RGB);
    rgb.convertTo(floating, cv.CV_32FC3);
    cv.resize(floating, resized, new cv.Size(WIDTH, HEIGHT), 0, 0, cv.INTER_LINEAR);
    return planar(resized.data32F, WIDTH * HEIGHT);
  } finally { input.delete(); rgb.delete(); floating.delete(); resized.delete(); }
}
function planar(rgb: ArrayLike<number>, pixels: number): Float32Array {
  const output = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) output[c * pixels + i] = rgb[i * 3 + c];
  return output;
}

/** Python's round() uses ties-to-even; Math.round() would move odd-sized tiles. */
export function roundEven(value: number): number {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
export type FastwebWindow = [number, number, number, number];
export function fastwebWindows(width: number, height: number): FastwebWindow[] {
  const windows: FastwebWindow[] = [[0, 0, width, height]];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    windows.push([roundEven(col * width / 4), roundEven(row * height / 4), roundEven(col * width / 4 + width / 2), roundEven(row * height / 4 + height / 2)]);
  }
  return windows;
}
/** Scheduling profile only; model preprocessing and corner validation are identical. */
export function proposalWindows(width: number, height: number, profile: "full" | "stream" | "pack" = "full"): FastwebWindow[] {
  if (profile !== "full" && profile !== "stream" && profile !== "pack") throw new Error("Invalid proposal profile.");
  return profile === "full" ? fastwebWindows(width, height) : [[0, 0, width, height]];
}
/** Unlike XFeat, Fastweb resizes uint8 RGB before float32 ImageNet normalization. */
function preprocessFastwebMat(cv: Cv, image: OpenCv.Mat, window: FastwebWindow): Float32Array {
  const [x0, y0, x1, y1] = window;
  const tile = image.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)), rgb = new cv.Mat(), resized = new cv.Mat();
  try {
    cv.cvtColor(tile, rgb, cv.COLOR_RGBA2RGB);
    cv.resize(rgb, resized, new cv.Size(384, 384), 0, 0, cv.INTER_LINEAR);
    const pixels = 384 * 384, output = new Float32Array(pixels * 3);
    const mean = [.485, .456, .406].map(f32), std = [.229, .224, .225].map(f32);
    for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) output[c * pixels + i] = f32(f32(f32(resized.data[i * 3 + c] / 255) - mean[c]) / std[c]);
    return output;
  } finally { tile.delete(); rgb.delete(); resized.delete(); }
}
export function preprocessFastweb(cv: Cv, image: ImageData, window: FastwebWindow): Float32Array {
  validateImage(image);
  const [x0, y0, x1, y1] = window;
  if (![x0, y0, x1, y1].every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 > image.width || y1 > image.height || x1 <= x0 || y1 <= y0) throw new Error("Invalid Fastweb window.");
  const input = cv.matFromImageData(image);
  try { return preprocessFastwebMat(cv, input, window); } finally { input.delete(); }
}

function cubic(value: number): number {
  const t = Math.abs(value), a = -.75;
  return t <= 1 ? ((a + 2) * t - (a + 3)) * t * t + 1 : t < 2 ? ((a * t - 5 * a) * t + 8 * a) * t - 4 * a : 0;
}
/** Independent port of frozen NumPy sampler: zero padding, a=-.75, align_corners=false. */
export function sampleXFeatDescriptors(dense: Float32Array, xy: Float32Array): Float32Array {
  if (dense.length !== CHANNELS * D_HEIGHT * D_WIDTH || xy.length % 2) throw new Error("Invalid dense descriptor contract.");
  const count = xy.length / 2, output = new Float32Array(count * CHANNELS);
  for (let p = 0; p < count; p++) {
    const x = f32(f32(f32(xy[p * 2] / (WIDTH - 1)) * D_WIDTH) - .5);
    const y = f32(f32(f32(xy[p * 2 + 1] / (HEIGHT - 1)) * D_HEIGHT) - .5);
    const xi = Math.floor(x), yi = Math.floor(y);
    for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) {
      const xx = xi + i, yy = yi + j;
      if (xx < 0 || xx >= D_WIDTH || yy < 0 || yy >= D_HEIGHT) continue;
      const weight = cubic(x - xx) * cubic(y - yy);
      for (let c = 0; c < CHANNELS; c++) output[p * CHANNELS + c] += weight * dense[c * D_WIDTH * D_HEIGHT + yy * D_WIDTH + xx];
    }
    let norm = 0;
    for (let c = 0; c < CHANNELS; c++) norm += output[p * CHANNELS + c] ** 2;
    norm = Math.max(Math.sqrt(norm), 1e-12);
    for (let c = 0; c < CHANNELS; c++) output[p * CHANNELS + c] /= norm;
  }
  return output;
}

/** The pinned graph has ALREADY decoded its 65-channel logits and upsampled reliability. */
export function decodeXFeatOutputs(dense: Float32Array, heat: Float32Array, reliability: Float32Array): LearnedQueryFeatures {
  if (dense.length !== CHANNELS * D_WIDTH * D_HEIGHT || heat.length !== WIDTH * HEIGHT || reliability.length !== WIDTH * HEIGHT || ![dense, heat, reliability].every(a => a.every(Number.isFinite))) throw new Error("Invalid or non-finite XFeat output.");
  const ranked: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const index = y * WIDTH + x, value = heat[index];
    if (value <= f32(.05) || (x === 0 && y === 0)) continue;
    let maximum = true;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(HEIGHT - 1, y + 2) && maximum; yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(WIDTH - 1, x + 2); xx++) if (heat[yy * WIDTH + xx] > value) { maximum = false; break; }
    }
    if (maximum) ranked.push({ x, y, score: f32(value * reliability[index]) });
  }
  ranked.sort((a, b) => b.score - a.score); // Stable row-major ties, exactly as argsort(kind='stable').
  const selected = ranked.slice(0, 500), xy = new Float32Array(selected.length * 2), points = new Float32Array(xy.length), scores = new Float32Array(selected.length);
  for (let i = 0; i < selected.length; i++) {
    const p = selected[i]; xy[i * 2] = p.x; xy[i * 2 + 1] = p.y;
    points[i * 2] = p.x * f32(240 / WIDTH); points[i * 2 + 1] = p.y * f32(336 / HEIGHT); scores[i] = p.score;
  }
  return { points, descriptors: sampleXFeatDescriptors(dense, xy), scores };
}

function tensorData(value: ort.Tensor | undefined, dimensions: readonly number[], label: string): Float32Array {
  if (!value || value.type !== "float32" || !(value.data instanceof Float32Array) || value.dims.length !== dimensions.length || value.dims.some((v, i) => v !== dimensions[i])) throw new Error(`Unexpected ${label} tensor contract.`);
  for (let i = 0; i < value.data.length; i++) if (!Number.isFinite(value.data[i])) throw new Error(`Non-finite ${label} tensor.`);
  return value.data;
}
/** Preserve original cyclic order; portrait orientation is a later canonical-warp concern. */
export function fastwebQuad(corners: Float32Array, window: FastwebWindow): Quad {
  const [x0, y0, x1, y1] = window;
  const points = Array.from({ length: 4 }, (_, i) => ({ x: f32(corners[i * 2] * (x1 - x0)), y: f32(corners[i * 2 + 1] * (y1 - y0)) }));
  const cx = f32(points.reduce((s, p) => f32(s + p.x), 0) / 4), cy = f32(points.reduce((s, p) => f32(s + p.y), 0) / 4);
  points.sort((a, b) => Math.atan2(f32(a.y - cy), f32(a.x - cx)) - Math.atan2(f32(b.y - cy), f32(b.x - cx)));
  const start = points.reduce((best, p, i) => f32(p.x + p.y) < f32(points[best].x + points[best].y) ? i : best, 0);
  return [...points.slice(start), ...points.slice(0, start)].map(p => ({ x: f32(p.x + x0), y: f32(p.y + y0) })) as Quad;
}
export function learnedPolygonIoU(cv: Cv, a: Quad, b: Quad): number {
  const ma = cv.matFromArray(4, 1, cv.CV_32FC2, a.flatMap(p => [p.x, p.y])), mb = cv.matFromArray(4, 1, cv.CV_32FC2, b.flatMap(p => [p.x, p.y]));
  const ha = new cv.Mat(), hb = new cv.Mat(), intersection = new cv.Mat();
  try {
    cv.convexHull(ma, ha); cv.convexHull(mb, hb);
    const intersect = cv.intersectConvexConvex(ha, hb, intersection, true), union = cv.contourArea(ha) + cv.contourArea(hb) - intersect;
    return union > 0 ? intersect / union : 0;
  } finally { ma.delete(); mb.delete(); ha.delete(); hb.delete(); intersection.delete(); }
}
function validQuad(cv: Cv, quad: Quad, width: number, height: number): boolean {
  if (!quad.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x < width && p.y >= 0 && p.y < height)) return false;
  const mat = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
  try { return cv.isContourConvex(mat) && cv.contourArea(mat) > 0; } finally { mat.delete(); }
}

/** Offline builder entry point. Caller supplies bytes, NEVER executable source or URLs. */
export async function createLearnedModelsFromAssets(cv: Cv, assets: LearnedAssetBytes, options: Pick<LearnedModelOptions, "signal"> = {}): Promise<LearnedModels> {
  abort(options.signal);
  for (const name of assetNames) { await verifyLearnedAsset(name, assets[name]); abort(options.signal); }
  if (ort.env.versions.web !== "1.30.0") throw new Error("Unexpected ONNX Runtime Web version.");
  // Official 1.30.0 build_args.py disables telemetry for build_wasm. The Web API has
  // no runtime telemetry toggle. Do not substitute a native/Node runtime here.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = undefined; // Embedded official glue, no CDN fallback.
  ort.env.wasm.wasmBinary = assets["ort-wasm-simd-threaded.wasm"];
  ort.env.trace = false;
  ort.env.debug = false;
  ort.env.logLevel = "error";
  const sessionOptions: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], executionMode: "sequential", graphOptimizationLevel: "all", enableProfiling: false, logSeverityLevel: 3 };
  const xfeat = await ort.InferenceSession.create(assets["xfeat_backbone.onnx"], { ...sessionOptions, externalData: [{ path: "xfeat_backbone.onnx.data", data: assets["xfeat_backbone.onnx.data"] }] }).catch(error => { ort.env.wasm.wasmBinary = undefined; throw error; });
  let fastweb: ort.InferenceSession | undefined;
  try {
    abort(options.signal);
    fastweb = await ort.InferenceSession.create(assets["fastweb-single-1.39.onnx"], sessionOptions);
    abort(options.signal);
  } catch (error) { await xfeat.release(); if (fastweb) await fastweb.release(); throw error; }
  finally { ort.env.wasm.wasmBinary = undefined; } // Release staging buffer; initialized WASM owns its memory.
  verifiedRuntimeInitialized = true;
  let disposed = false, pending: Promise<void> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => { if (disposed) throw new Error("Learned models have been disposed."); abort(options.signal); return run(); });
    // The serialization barrier must not retain the last feature result.
    pending = result.then(() => undefined, () => undefined); return result;
  };
  return {
    extract: image => serialized(async () => {
      const start = performance.now(), input = new ort.Tensor("float32", preprocessXFeat(cv, image), [1, 3, HEIGHT, WIDTH]), preprocessed = performance.now();
      let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
      try {
        outputs = await xfeat.run({ image: input }, ["descriptors", "heatmap", "reliability"]);
        abort(options.signal);
        const inferred = performance.now();
        const result = decodeXFeatOutputs(tensorData(outputs.descriptors, [1, 64, 40, 28], "descriptors"), tensorData(outputs.heatmap, [1, 1, 320, 224], "heatmap"), tensorData(outputs.reliability, [1, 1, 320, 224], "reliability"));
        const end = performance.now();
        result.timings = { preprocessingMs: preprocessed - start, inferenceMs: inferred - preprocessed, postprocessingMs: end - inferred, totalMs: end - start };
        return result;
      } finally { input.dispose(); if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose(); }
    }),
    propose: (image, profile = "full") => serialized(async () => {
      validateImage(image);
      const source = cv.matFromImageData(image), kept: Quad[] = [];
      try {
        for (const window of proposalWindows(image.width, image.height, profile)) {
          abort(options.signal);
          const input = new ort.Tensor("float32", preprocessFastwebMat(cv, source, window), [1, 3, 384, 384]);
          let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
          try {
            // presence is a CONSTANT 1; neither it nor sharpness is ever confidence.
            outputs = await fastweb!.run({ image: input }, ["corners"]);
            const corners = tensorData(outputs.corners, [1, 8], "corners");
            const quad = fastwebQuad(corners, window);
            if (validQuad(cv, quad, image.width, image.height) && !kept.some(previous => learnedPolygonIoU(cv, quad, previous) >= .70)) kept.push(quad);
          } finally { input.dispose(); if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose(); }
        }
        abort(options.signal); return kept;
      } finally { source.delete(); }
    }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await pending;
      await Promise.all([xfeat.release(), fastweb!.release()]);
    },
  };
}

/** Minimal original ONNX protobuf encoder for one bounded MatMul, not model data. */
function makeSimilarityGraph(): Uint8Array<ArrayBuffer> {
  const varint = (value: number): number[] => { const bytes: number[] = []; do { const next = value & 127; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value); return bytes; };
  const integer = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
  const message = (field: number, bytes: number[]) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
  const string = (field: number, value: string) => message(field, [...new TextEncoder().encode(value)]);
  const valueInfo = (name: string, dimensions: (number | string)[]) => {
    const shape = dimensions.flatMap(value => message(1, typeof value === "number" ? integer(1, value) : string(2, value)));
    return [...string(1, name), ...message(2, message(1, [...integer(1, 1), ...message(2, shape)]))];
  };
  const node = [...string(1, "Q"), ...string(1, "R"), ...string(2, "S"), ...string(4, "MatMul")];
  const graph = [...message(1, node), ...string(2, "bounded_descriptor_cosines"), ...message(11, valueInfo("Q", ["N", 64])), ...message(11, valueInfo("R", [64, "M"])), ...message(12, valueInfo("S", ["N", "M"]))];
  return new Uint8Array([...integer(1, 9), ...string(2, "tcg-scan-original"), ...message(7, graph), ...message(8, integer(2, 13))]);
}

export interface LearnedSimilarity {
  /** Pretransposed R is [64,M]; output is [N,M]. No matching threshold is applied. */
  multiply(query: Float32Array, referenceTransposed: Float32Array, referenceCount: number): Promise<Float32Array>;
  dispose(): Promise<void>;
}
/** Shares the already verified WASM runtime. No new downloads or custom operators. */
export async function createLearnedSimilarity(): Promise<LearnedSimilarity> {
  if (!verifiedRuntimeInitialized || ort.env.versions.web !== "1.30.0") throw new Error("Initialize verified learned models before the similarity helper.");
  const session = await ort.InferenceSession.create(makeSimilarityGraph(), { executionProviders: ["wasm"], executionMode: "sequential", graphOptimizationLevel: "all", enableProfiling: false, logSeverityLevel: 3 });
  let disposed = false, pending: Promise<void> = Promise.resolve();
  return {
    multiply: (query, referenceTransposed, referenceCount) => {
      const result = pending.then(async () => {
        if (disposed) throw new Error("Similarity helper has been disposed.");
        const count = query.length / 64;
        if (!Number.isInteger(count) || count > 500 || !Number.isInteger(referenceCount) || referenceCount < 1 || referenceCount > 2048 || referenceTransposed.length !== 64 * referenceCount || !query.every(Number.isFinite) || !referenceTransposed.every(Number.isFinite)) throw new Error("Similarity matrices exceed the bounded 500 x 64 x 2048 contract.");
        if (count === 0) return new Float32Array();
        const q = new ort.Tensor("float32", query, [count, 64]), r = new ort.Tensor("float32", referenceTransposed, [64, referenceCount]);
        let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
        try {
          outputs = await session.run({ Q: q, R: r }, ["S"]);
          // Pinned WASM backend already copies CPU output into an owned typed array.
          // Tensor.dispose clears its reference, not this array: no second 4.1MB copy.
          return tensorData(outputs.S, [count, referenceCount], "similarity");
        } finally { q.dispose(); r.dispose(); if (outputs) for (const value of Object.values(outputs)) value.dispose(); }
      });
      // Keep ordering/error recovery without retaining the last ~4 MiB matrix.
      pending = result.then(() => undefined, () => undefined); return result;
    },
    dispose: async () => { if (disposed) return; disposed = true; await pending; await session.release(); },
  };
}
