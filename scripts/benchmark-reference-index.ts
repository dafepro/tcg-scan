/** Offline, deterministic large-index source-image validation. Never downloads files. */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cpus, platform, arch } from "node:os";
import { parseArgs } from "node:util";
import cvModule from "@techstark/opencv-js";
import sharp from "sharp";
import { VisionEngine } from "../src/lib/vision/engine";
import type { Cv } from "../src/lib/vision/engine";
import type { FeaturePack, ReferenceMetadata, VisionTimings } from "../src/lib/vision/types";

const { values } = parseArgs({ options: { manifest: { type: "string" }, cache: { type: "string" }, output: { type: "string" }, selection: { type: "string" }, known: { type: "string", default: "64" }, "held-out": { type: "string", default: "64" }, repeats: { type: "string", default: "2" } } });
if (!values.manifest || !values.cache || !values.output) throw new Error("Required: --manifest FILE --cache DIRECTORY --output FILE");
const count = (value: string) => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("Counts must be integers from 1 to 500."); return n; };
const cv = await (cvModule as unknown as Promise<Cv>), engine = new VisionEngine(cv);
const manifest = JSON.parse(await readFile(values.manifest, "utf8")) as { packs: { file: string; sha256: string; bytes: number }[] };
const references: ReferenceMetadata[] = [];
const loadStart = performance.now();
let bytes = 0;
for (const entry of manifest.packs) {
  const raw = await readFile(join(dirname(values.manifest), basename(entry.file)));
  if (createHash("sha256").update(raw).digest("hex") !== entry.sha256) throw new Error(`Feature shard integrity failure: ${entry.file}`);
  const pack = JSON.parse(raw.toString("utf8")) as FeaturePack;
  engine.loadPack(pack); references.push(...pack.cards); bytes += raw.byteLength;
}
const loadMs = performance.now() - loadStart;
const indexedKeys = new Set(references.map(c => c.key));
const indexedIdentities = new Set(references.map(c => c.identityKey || c.key));
interface CatalogCard extends ReferenceMetadata { downloadUrl?: string }
let catalog: { cards: CatalogCard[]; coverage: { game: string; scope: string; catalogRetrievedAt?: string } } | undefined;
for (const name of (await readdir(join(values.cache, "catalogs"))).sort()) {
  const candidate = JSON.parse(await readFile(join(values.cache, "catalogs", name), "utf8"));
  if (candidate.coverage?.game === "pokemon" && candidate.coverage?.scope === "full-catalog" && (!catalog || (candidate.coverage.catalogRetrievedAt ?? "") > (catalog.coverage.catalogRetrievedAt ?? ""))) catalog = candidate;
}
if (!catalog) throw new Error("The existing offline cache has no full-catalog Pokémon metadata.");
async function cachedPath(card: CatalogCard): Promise<string | undefined> {
  const url = card.downloadUrl || card.imageUrl;
  if (!url) return;
  try {
    const pointer = JSON.parse(await readFile(join(values.cache!, "urls", createHash("sha256").update(url).digest("hex") + ".json"), "utf8"));
    if (!/^[a-f0-9]{64}$/.test(pointer.sha256)) return;
    const path = join(values.cache!, "objects", pointer.sha256); await access(path); return path;
  } catch { return; }
}
type Scope = "indexed" | "held-out-printing-known-identity" | "held-out-identity";
interface Selected { card: CatalogCard; path: string; scope: Scope }
const selected: Selected[] = [], missingIndexed: string[] = [];
const knownCount = Math.min(references.length, count(values.known!));
for (let i = 0; i < knownCount; i++) {
  const card = references[Math.floor(i * references.length / knownCount)], path = await cachedPath(card);
  if (path) selected.push({ card, path, scope: "indexed" }); else missingIndexed.push(card.key);
}
const heldOutTarget = count(values["held-out"]!), availableUnknown: Selected[] = [], availableOtherPrintings: Selected[] = [];
// Snapshot every currently cached out-of-pack image. No polling/downloads while sampling.
for (const card of catalog.cards) {
  if (indexedKeys.has(card.key)) continue;
  const path = await cachedPath(card); if (!path) continue;
  const knownIdentity = indexedIdentities.has(card.identityKey || card.key);
  (knownIdentity ? availableOtherPrintings : availableUnknown).push({ card, path, scope: knownIdentity ? "held-out-printing-known-identity" : "held-out-identity" });
}
function sample(items: Selected[], target: number): Selected[] { const n = Math.min(items.length, target); return Array.from({ length: n }, (_, i) => items[Math.floor(i * items.length / n)]); }
selected.push(...sample(availableUnknown, heldOutTarget), ...sample(availableOtherPrintings, heldOutTarget));
// Optional replay fixes the source set even while a separate cache builder grows.
if (values.selection) {
  const previous = JSON.parse(await readFile(values.selection, "utf8")) as { input: { selectedKeys: { key: string; scope: Scope }[] } };
  const cards = new Map([...catalog.cards, ...references].map(card => [card.key, card]));
  selected.length = 0;
  for (const entry of previous.input.selectedKeys) {
    const card = cards.get(entry.key);
    if (!card) throw new Error(`Replay source is absent from offline catalog: ${entry.key}`);
    const path = await cachedPath(card);
    if (!path) throw new Error(`Replay source image is not cached: ${entry.key}`);
    const actualScope: Scope = indexedKeys.has(card.key) ? "indexed" : indexedIdentities.has(card.identityKey || card.key) ? "held-out-printing-known-identity" : "held-out-identity";
    if (actualScope !== entry.scope) throw new Error(`Replay scope differs for ${entry.key}; use the original index shards.`);
    selected.push({ card, path, scope: entry.scope });
  }
}
function warp(image: ImageData, corners: number[]): ImageData {
  const source = cv.matFromImageData(image), from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, image.width - 1, 0, image.width - 1, image.height - 1, 0, image.height - 1]), to = cv.matFromArray(4, 1, cv.CV_32FC2, corners), h = cv.getPerspectiveTransform(from, to), output = new cv.Mat();
  try { cv.warpPerspective(source, output, h, new cv.Size(640, 480), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(28, 28, 28, 255)); return { data: new Uint8ClampedArray(output.data), width: 640, height: 480, colorSpace: "srgb" } as ImageData; }
  finally { source.delete(); from.delete(); to.delete(); h.delete(); output.delete(); }
}
const transforms = [
  { name: "upright-perspective", points: [180, 54, 400, 66, 416, 372, 165, 388] },
  { name: "upside-down", points: [416, 388, 165, 372, 180, 54, 400, 66] },
  { name: "150px-wide", points: [235, 100, 385, 110, 388, 320, 231, 306] },
];
interface Observation {
  key: string; identity: string; scope: Scope; transform: string; repetition: number; timings: VisionTimings;
  detections: { state: string; autoEligible: boolean; deferred: boolean; bestKey?: string; bestIdentity?: string; exactKeyRetrieved: boolean; identityRetrieved: boolean; retrievalMs: number; shortlist: string[]; inliers: number; interiorInliers: number; reason: string }[];
}
const observations: Observation[] = [];
const metadata = new Map(references.map(card => [card.key, card]));
const repeats = count(values.repeats!);
let warmupDone = false;
try {
  for (const item of selected) {
    const { data, info } = await sharp(item.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgba = { data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: "srgb" } as ImageData;
    for (const transform of transforms) {
      const image = warp(rgba, transform.points);
      if (!warmupDone) { for (let i = 0; i < 5; i++) engine.analyze(image, { game: "pokemon", budgetMs: 1000 }); warmupDone = true; }
      for (let repetition = 0; repetition < repeats; repetition++) {
        const result = engine.analyze(image, { game: "pokemon", maxCards: 9, budgetMs: 1000, includeDiagnostics: true });
        const expectedIdentity = item.card.identityKey || item.card.key;
        observations.push({ key: item.card.key, identity: expectedIdentity, scope: item.scope, transform: transform.name, repetition, timings: result.timings, detections: result.detections.map(d => ({ state: d.state, autoEligible: d.autoEligible, deferred: d.deferred ?? false, bestKey: d.candidates[0]?.key, bestIdentity: d.candidates[0] ? d.candidates[0].reference.identityKey || d.candidates[0].key : undefined, exactKeyRetrieved: d.retrieval?.shortlistKeys.includes(item.card.key) ?? false, identityRetrieved: d.retrieval?.shortlistKeys.some(key => (metadata.get(key)?.identityKey || key) === expectedIdentity) ?? false, retrievalMs: d.retrieval?.retrievalMs ?? 0, shortlist: d.retrieval?.shortlistKeys ?? [], inliers: d.candidates[0]?.inliers ?? 0, interiorInliers: d.candidates[0]?.interiorInliers ?? 0, reason: d.reason })) });
      }
    }
  }
  const percentile = (samples: number[], q: number) => { if (!samples.length) return null; const sorted = [...samples].sort((a, b) => a - b); return Math.round(sorted[Math.ceil(sorted.length * q) - 1] * 100) / 100; };
  function summarize(rows: Observation[]) {
    const once = rows.filter(row => row.repetition === 0), detected = once.filter(row => row.detections.length);
    const timings = Object.fromEntries(["detectionMs", "extractionMs", "matchingMs", "totalMs"].map(stage => { const samples = rows.map(row => row.timings[stage as keyof VisionTimings]); return [stage, { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) }]; }));
    const retrieval = rows.flatMap(row => row.detections.filter(d => d.shortlist.length).map(d => d.retrievalMs));
    return { distinctSourceImages: new Set(once.map(row => row.key)).size, distinctTransformedScenes: once.length, timedAnalyses: rows.length, scenesDetected: detected.length, exactTopReference: once.filter(row => row.detections.some(d => d.bestKey === row.key)).length, correctIdentityTop: once.filter(row => row.detections.some(d => d.bestIdentity === row.identity)).length, correctIdentityAutoEligible: once.filter(row => row.detections.some(d => d.autoEligible && d.bestIdentity === row.identity)).length, wrongIdentityAutoEligible: once.filter(row => row.detections.some(d => d.autoEligible && d.bestIdentity !== row.identity)).length, ambiguousScenes: once.filter(row => row.detections.some(d => d.state === "ambiguous")).length, qualityScenes: once.filter(row => row.detections.some(d => d.state === "quality")).length, unknownScenes: once.filter(row => row.detections.some(d => d.state === "unknown")).length, deferredScenes: once.filter(row => row.detections.some(d => d.deferred)).length, indexedExactShortlistMisses: once.filter(row => row.scope === "indexed" && row.detections.some(d => d.shortlist.length > 0) && !row.detections.some(d => d.exactKeyRetrieved)).length, indexedIdentityShortlistMisses: once.filter(row => row.scope === "indexed" && row.detections.some(d => d.shortlist.length > 0) && !row.detections.some(d => d.identityRetrieved)).length, milliseconds: { ...timings, hashRetrievalMs: { p50: percentile(retrieval, 0.5), p95: percentile(retrieval, 0.95) } } };
  }
  const report = { createdAt: new Date().toISOString(), notice: "Offline source-derived transformations, not physical-camera accuracy. Exact reference retrieval is not proof of exact printing/finish/condition. Repetitions only measure latency; outcome counts use the first repeat.", runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, opencv: "5.0.0-release.1" }, input: { manifest: values.manifest, shardHashes: manifest.packs.map(pack => pack.sha256), coverage: engine.coverage(), bytes, loadIncludingReadParseIntegrityMs: loadMs, cachedOutOfIndexIdentitiesAvailable: availableUnknown.length, cachedOtherPrintingsAvailable: availableOtherPrintings.length, missingIndexed, selectedKeys: selected.map(item => ({ key: item.card.key, scope: item.scope })) }, parameters: { image: [640, 480], referenceFeatures: 96, queryFeatures: 500, shortlist: 8, transforms: transforms.map(t => t.name), repeats, frameBudgetMs: 1000 }, all: summarize(observations), byScope: Object.fromEntries((["indexed", "held-out-printing-known-identity", "held-out-identity"] as const).map(scope => [scope, summarize(observations.filter(row => row.scope === scope))])), observations };
  await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runtime: report.runtime, input: { coverage: report.input.coverage, bytes, loadMs, knownSources: selected.filter(s => s.scope === "indexed").length, unknownIdentitySources: selected.filter(s => s.scope === "held-out-identity").length, otherPrintingSources: selected.filter(s => s.scope === "held-out-printing-known-identity").length }, all: report.all, byScope: report.byScope }, null, 2));
} finally { engine.dispose(); }
