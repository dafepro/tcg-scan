import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import type * as OpenCv from "@techstark/opencv-js";
import {
  createLearnedModels, createLearnedModelsFromAssets, createLearnedSimilarity, decodeXFeatOutputs, fastwebQuad,
  fastwebWindows, learnedPolygonIoU, LEARNED_ASSETS, preprocessFastweb,
  preprocessXFeat, roundEven, sampleXFeatDescriptors, verifyLearnedAsset,
} from "./learned-models";
import type { LearnedAssetBytes } from "./learned-models";
import type { Quad } from "./types";

let cv: typeof OpenCv;
beforeAll(async () => { cv = await createRequire(import.meta.url)("@techstark/opencv-js"); }, 30_000);
afterEach(() => vi.unstubAllGlobals());
const rgba = (width = 240, height = 336, level = 127): ImageData => ({ width, height, data: new Uint8ClampedArray(width * height * 4).map((_, i) => i % 4 === 3 ? 255 : level), colorSpace: "srgb" });
const outputs = () => ({ dense: new Float32Array(64 * 40 * 28).fill(.125), heat: new Float32Array(320 * 224), reliability: new Float32Array(320 * 224).fill(1) });

describe("frozen learned preprocessing and postprocessing", () => {
  it.each(["/", "/tcg-scan/"])("resolves same-origin model data from an app base %s rather than the worker assets directory", async base => {
    vi.stubGlobal("location", new URL(`https://app.example${base}assets/vision.worker.js`));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(createLearnedModels(cv, { baseUrl: `${base}vision-models/` })).rejects.toThrow(/Could not load/);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://app.example${base}vision-models/xfeat_backbone.onnx`);
  });
  it("keeps RGB0..255, canonical240x336, float-before-bilinear224x320", () => {
    const input = rgba(); for (let i = 0; i < input.data.length; i += 4) { input.data[i] = 23; input.data[i + 1] = 90; input.data[i + 2] = 211; }
    const result = preprocessXFeat(cv, input), n = 224 * 320;
    expect(result.length).toBe(n * 3);
    for (const [c, expected] of [23, 90, 211].entries()) expect(result.slice(c * n, (c + 1) * n).every(v => Math.abs(v - expected) < .0001)).toBe(true);
    expect(() => preprocessXFeat(cv, rgba(336, 240))).toThrow(/canonical/);
  });
  it("uses uint8-before-resize and float32 ImageNet normalization for Fastweb", () => {
    const result = preprocessFastweb(cv, rgba(), [0, 0, 240, 336]);
    const expected = [.485, .456, .406].map((mean, i) => Math.fround(Math.fround(Math.fround(127 / 255) - Math.fround(mean)) / Math.fround([.229, .224, .225][i])));
    for (const [c, value] of expected.entries()) expect(result[c * 384 * 384]).toBe(value);
    expect(() => preprocessFastweb(cv, rgba(), [0, 0, 500, 336])).toThrow(/window/);
    expect(() => preprocessFastweb(cv, rgba(4097, 2), [0, 0, 2, 2])).toThrow(/4096/);
  });
  it("uses ties-to-even and the exact full+row-major3x3 windows for odd frames", () => {
    expect([.5, 1.5, 2.5, 3.5].map(roundEven)).toEqual([0, 2, 2, 4]);
    expect([-.5, -1.5, -2.5, -3.5].map(roundEven)).toEqual([0, -2, -2, -4]);
    expect(fastwebWindows(5, 7)).toEqual([[0, 0, 5, 7], [0, 0, 2, 4], [1, 0, 4, 4], [2, 0, 5, 4], [0, 2, 2, 5], [1, 2, 4, 5], [2, 2, 5, 5], [0, 4, 2, 7], [1, 4, 4, 7], [2, 4, 5, 7]]);
  });
  it("does not decode the graph heatmap twice; NMS5, strict float32 .05, origin excluded", () => {
    const { dense, heat, reliability } = outputs();
    heat[0] = .9; heat[4] = .05; heat[10] = .4; heat[12] = .5; heat[20] = .3;
    const result = decodeXFeatOutputs(dense, heat, reliability);
    expect(result.scores).toEqual(new Float32Array([.5, .3]));
    expect(Array.from(result.points)).toEqual([Math.fround(12 * Math.fround(240 / 224)), 0, Math.fround(20 * Math.fround(240 / 224)), 0]);
    expect(result.descriptors.every(v => Math.abs(v - .125) < .000001)).toBe(true);
  });
  it("ranks heatmap times full-resolution reliability with stable row-major ties", () => {
    const { dense, heat, reliability } = outputs();
    for (const index of [10, 20, 30]) heat[index] = .5;
    reliability[10] = .2;
    expect(Array.from(decodeXFeatOutputs(dense, heat, reliability).points).filter((_, i) => i % 2 === 0)).toEqual([20, 30, 10].map(x => Math.fround(x * Math.fround(240 / 224))));
  });
  it("retains at most500 query points and fails closed on non-finite tensors", () => {
    const { dense, heat, reliability } = outputs(); heat.fill(.2);
    expect(decodeXFeatOutputs(dense, heat, reliability).points).toHaveLength(1000);
    heat[0] = NaN; expect(() => decodeXFeatOutputs(dense, heat, reliability)).toThrow(/non-finite/);
    expect(() => decodeXFeatOutputs(dense.subarray(1), heat, reliability)).toThrow();
  });
  it("samples bicubic dense descriptors with zero padding and unit renormalization", () => {
    const dense = new Float32Array(64 * 40 * 28); dense.fill(1, 0, 40 * 28);
    const result = sampleXFeatDescriptors(dense, new Float32Array([0, 0, 223, 319, 112, 160]));
    for (let i = 0; i < 3; i++) { expect(result[i * 64]).toBe(1); expect(result.slice(i * 64 + 1, (i + 1) * 64).every(v => v === 0)).toBe(true); }
    expect(() => sampleXFeatDescriptors(dense, new Float32Array(3))).toThrow();
  });
  it("keeps a Fastweb cycle without adding portrait rotation and uses polygon IoU", () => {
    const quad = fastwebQuad(new Float32Array([.1, .1, .9, .1, .9, .9, .1, .9]), [100, 200, 500, 400]);
    expect(quad[0]).toEqual({ x: 140, y: 220 }); expect(quad[1]).toEqual({ x: 460, y: 220 });
    expect(learnedPolygonIoU(cv, quad, quad)).toBe(1);
    const b = quad.map(p => ({ x: p.x + 1000, y: p.y })) as Quad;
    expect(learnedPolygonIoU(cv, quad, b)).toBe(0);
  });
});

describe("model integrity and network boundaries", () => {
  it("rejects wrong byte counts and same-size wrong bytes before inference", async () => {
    await expect(verifyLearnedAsset("xfeat_backbone.onnx", new Uint8Array(10))).rejects.toThrow(/byte count/);
    await expect(verifyLearnedAsset("xfeat_backbone.onnx", new Uint8Array(LEARNED_ASSETS["xfeat_backbone.onnx"].bytes))).rejects.toThrow(/Integrity/);
  });
  it("rejects cross-origin and credential-bearing model paths without a request", async () => {
    vi.stubGlobal("location", new URL("https://app.example/worker.js")); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const baseUrl of ["https://other.example/models/", "https://user:secret@app.example/models/", "data:text/plain,test"]) await expect(createLearnedModels(cv, { baseUrl })).rejects.toThrow(/origin/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fetches without credentials/redirects and rejects oversized model responses", async () => {
    vi.stubGlobal("location", new URL("https://app.example/worker.js"));
    const fetcher = vi.fn(async () => new Response(new Uint8Array(LEARNED_ASSETS["xfeat_backbone.onnx"].bytes + 1))); vi.stubGlobal("fetch", fetcher);
    await expect(createLearnedModels(cv)).rejects.toThrow(/Oversized/);
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: "omit", redirect: "error", mode: "same-origin" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation before reads/session creation", async () => {
    vi.stubGlobal("location", new URL("https://app.example/worker.js"));const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(createLearnedModels(cv, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** Optional artifact-backed regression: only explicitly supplied development controls, no downloads. */
const parityDirectory = process.env.TCG_VISION_PARITY_DIR;
describe.skipIf(!parityDirectory)("actual pinned ORT Web WASM development parity", () => {
  it("matches frozen canonical controls and rejects blank controls", async () => {
    const assetDirectory = process.env.TCG_VISION_ASSET_DIR ?? "public/vision-models";
    const assets = Object.fromEntries(await Promise.all(Object.keys(LEARNED_ASSETS).map(async name => [name, new Uint8Array(await readFile(`${assetDirectory}/${name}`))]))) as LearnedAssetBytes;
    const unexpectedNetwork = vi.fn(() => { throw new Error("Inference attempted an unexpected network request."); });
    vi.stubGlobal("fetch", unexpectedNetwork);
    const models = await createLearnedModelsFromAssets(cv, assets);
    try {
      for (const stem of ["xfeat-0", "xfeat-1", "xfeat-2", "blank-0", "blank-127", "blank-255"]) {
        const image: ImageData = { data: new Uint8ClampedArray(await readFile(`${parityDirectory}/${stem}.rgba`)), width: 240, height: 336, colorSpace: "srgb" };
        const result = await models.extract(image);
        const expected = new Float32Array(new Uint8Array(await readFile(`${parityDirectory}/${stem}.points.f32`)).buffer);
        const pairs = (a: Float32Array) => Array.from({ length: a.length / 2 }, (_, i) => `${a[i * 2]},${a[i * 2 + 1]}`).sort();
        expect(pairs(result.points)).toEqual(pairs(expected));
      }
          const similarity = await createLearnedSimilarity();
      const query = new Float32Array(2 * 64), reference = new Float32Array(64 * 3);
      query[0] = 1; query[65] = 1; reference[0] = .5; reference[1] = .75; reference[2] = 1; reference[3] = -.5; reference[4] = .25; reference[5] = .125;
      const result = await similarity.multiply(query, reference, 3);
      expect([...result]).toEqual([.5, .75, 1, -.5, .25, .125]);
      await similarity.multiply(new Float32Array(64), new Float32Array(64), 1);
      expect([...result]).toEqual([.5, .75, 1, -.5, .25, .125]); // Prior output survives tensor disposal/subsequent runs.
      expect((await similarity.multiply(new Float32Array(), reference, 3)).length).toBe(0);
      await expect(similarity.multiply(new Float32Array(501 * 64), reference, 3)).rejects.toThrow(/bounded/);
      await expect(similarity.multiply(query, new Float32Array(2049 * 64), 2049)).rejects.toThrow(/bounded/);
      query[0] = NaN; await expect(similarity.multiply(query, reference, 3)).rejects.toThrow(/bounded/);
      query[0] = 1;
      const queued = [similarity.multiply(query, reference, 3), similarity.multiply(new Float32Array(64), new Float32Array(64), 1)];
      const recovered = await Promise.all(queued);
      expect([...recovered[0]]).toEqual([.5, .75, 1, -.5, .25, .125]);
      expect([...recovered[1]]).toEqual([0]); // A rejected run does not poison the value-free ordering barrier.
      await similarity.dispose(); await expect(similarity.multiply(new Float32Array(64), new Float32Array(64), 1)).rejects.toThrow(/disposed/);
      expect([...result]).toEqual([.5, .75, 1, -.5, .25, .125]); // Session disposal leaves caller-owned output intact.
      expect(unexpectedNetwork).not.toHaveBeenCalled();
    } finally { await models.dispose(); }
    await expect(models.extract(rgba())).rejects.toThrow(/disposed/);
  }, 60_000);
});
