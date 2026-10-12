/** Offline benchmark. Original synthetic artwork; no API requests or camera claims. */
import { cpus, platform, arch, totalmem } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import cvModule from "@techstark/opencv-js";
import sharp from "sharp";
import { VisionEngine } from "../src/lib/vision/engine";
import type { Cv } from "../src/lib/vision/engine";
import { extractReferenceFeatures } from "../src/lib/vision/features";
import { syntheticCard, syntheticScene } from "../src/lib/vision/test-fixtures";
import type { FeaturePack, VisionResult } from "../src/lib/vision/types";

const { values } = parseArgs({ options: {
  output: { type: "string" },
  "single-runs": { type: "string", default: "60" },
  "binder-runs": { type: "string", default: "20" },
  pack: { type: "string" },
  "reference-image": { type: "string" },
  "reference-key": { type: "string" },
} });
const cv = await (cvModule as unknown as Promise<Cv>);
const engine = new VisionEngine(cv);
const repetitions = (value: string) => {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("Run counts must be integers from 1 to 1000.");
  return count;
};
const pack: FeaturePack = {
  version: 1, algorithm: "orb-phash-v1", width: 240, height: 336,
  name: "Eight original geometric cards",
  cards: Array.from({ length: 8 }, (_, i) => ({ key: `original-${i + 1}`, game: "pokemon", name: `Original shapes ${i + 1}` })),
  features: Array.from({ length: 8 }, (_, i) => extractReferenceFeatures(cv, syntheticCard(i + 1), `original-${i + 1}`)),
};
function toImage(mat: OpenCvMat): ImageData { return { data: new Uint8ClampedArray(mat.data), width: mat.cols, height: mat.rows, colorSpace: "srgb" } as ImageData; }
type OpenCvMat = InstanceType<Cv["Mat"]>;
function binder(): ImageData {
  const frame = new cv.Mat(720, 960, cv.CV_8UC4, new cv.Scalar(40, 50, 55, 255));
  try {
    for (let i = 0; i < 9; i++) {
      const image = syntheticCard(i === 7 ? 99 : i === 8 ? 8 : i + 1);
      const source = cv.matFromImageData(image), resized = new cv.Mat();
      const region = frame.roi(new cv.Rect(175 + i % 3 * 235, 18 + Math.floor(i / 3) * 235, 144, 202));
      try {
        cv.resize(source, resized, new cv.Size(144, 202), 0, 0, cv.INTER_AREA);
        if (i === 8) cv.rectangle(resized, new cv.Point(9, 12), new cv.Point(135, 189), new cv.Scalar(255, 255, 255, 255), -1);
        resized.copyTo(region);
      } finally { source.delete(); resized.delete(); region.delete(); }
    }
    return toImage(frame);
  } finally { frame.delete(); }
}
function summary(result: VisionResult) {
  return { found: result.detections.length, budgetExhausted: result.budgetExhausted, states: result.detections.map(d => ({ state: d.state, autoEligible: d.autoEligible, printingAmbiguous: d.printingAmbiguous ?? false, deferred: d.deferred ?? false, key: d.candidates[0]?.key ?? null, inliers: d.candidates[0]?.inliers ?? 0, interiorInliers: d.candidates[0]?.interiorInliers ?? 0, reason: d.reason })) };
}
function measure(image: ImageData, runs: number) {
  for (let i = 0; i < 5; i++) engine.analyze(image, { budgetMs: 1000 });
  const timings: VisionResult["timings"][] = [];
  let last: VisionResult | undefined;
  for (let i = 0; i < runs; i++) { last = engine.analyze(image, { budgetMs: 1000 }); timings.push(last.timings); }
  const percentile = (stage: keyof VisionResult["timings"], q: number) => {
    const sorted = timings.map(t => t[stage]).sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] * 100) / 100;
  };
  return { runs, warmupFrames: 5, milliseconds: Object.fromEntries(["detectionMs", "extractionMs", "matchingMs", "totalMs"].map(stage => [stage, { p50: percentile(stage as keyof VisionResult["timings"], 0.5), p95: percentile(stage as keyof VisionResult["timings"], 0.95) }])), lastFrame: summary(last!) };
}
function perspective(image: ImageData, corners: number[]): ImageData {
  const source = cv.matFromImageData(image), from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, image.width - 1, 0, image.width - 1, image.height - 1, 0, image.height - 1]), to = cv.matFromArray(4, 1, cv.CV_32FC2, corners);
  const transform = cv.getPerspectiveTransform(from, to), output = new cv.Mat();
  try {
    cv.warpPerspective(source, output, transform, new cv.Size(960, 720), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(43, 53, 60, 255));
    return toImage(output);
  } finally { source.delete(); from.delete(); to.delete(); transform.delete(); output.delete(); }
}
try {
  const started = performance.now(); engine.loadPack(pack);
  const report: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    warning: "Offline synthetic/source-image transformations. These are not physical-camera accuracy, mobile throughput, calibrated probabilities, or full-catalog recall measurements.",
    runtime: { node: process.version, os: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostMemoryGiB: Math.round(totalmem() / 1024 ** 3), opencv: "@techstark/opencv-js 5.0.0-release.1" },
    parameters: { input: [960, 720], singleInput: [640, 520], canonical: [240, 336], queryOrbFeatures: 500, referenceOrbFeatures: 96, shortlist: 8, perFrameBudgetMs: 1000, indexReferences: 8, indexLoadMs: performance.now() - started },
    single: measure(syntheticScene(syntheticCard(1)), repetitions(values["single-runs"]!)),
    nineCardBinder: measure(binder(), repetitions(values["binder-runs"]!)),
    outOfIndex: summary(engine.analyze(syntheticScene(syntheticCard(99)), { budgetMs: 1000 })),
  };
  const first = { ...pack.cards[0], artworkKey: "shared-art" }, second = { ...first, key: "same-art-printing-b" };
  engine.loadPack({ ...pack, cards: [first, second], features: [pack.features[0], { ...pack.features[0], key: second.key }] });
  report.sharedArtwork = summary(engine.analyze(syntheticScene(syntheticCard(1)), { budgetMs: 1000 }));
  engine.loadPack({ ...pack, cards: [{ ...first, identityKey: "same-card" }, { ...second, identityKey: "same-card" }], features: [pack.features[0], { ...pack.features[0], key: second.key }] });
  report.sharedIdentityDifferentPrintings = summary(engine.analyze(syntheticScene(syntheticCard(1)), { budgetMs: 1000 }));
  if (values.pack || values["reference-image"]) {
    if (!values.pack || !values["reference-image"] || !values["reference-key"]) throw new Error("Supply --pack, --reference-image, and --reference-key together.");
    engine.clear(); engine.loadPack(JSON.parse(await readFile(values.pack, "utf8")) as FeaturePack);
    const { data, info } = await sharp(values["reference-image"]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const source = { data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: "srgb" } as ImageData;
    report.sourceImage = { expectedKey: values["reference-key"], coverage: engine.coverage(), tightOriginal: summary(engine.analyze(source, { budgetMs: 1000 })), explicitWholeImageRegion: summary(engine.analyze(source, { budgetMs: 1000, region: [{ x: 0, y: 0 }, { x: source.width - 1, y: 0 }, { x: source.width - 1, y: source.height - 1 }, { x: 0, y: source.height - 1 }] })), cases: Object.fromEntries([
      ["perspective", [315, 120, 605, 150, 635, 595, 290, 550]],
      ["upsideDown", [625, 585, 300, 555, 325, 135, 610, 125]],
      ["150pxWidth", [395, 210, 545, 220, 548, 430, 391, 416]],
    ].map(([name, corners]) => [name, summary(engine.analyze(perspective(source, corners as number[]), { budgetMs: 1000 }))])) };
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) await writeFile(values.output, json);
  console.log(json);
} finally { engine.dispose(); }
