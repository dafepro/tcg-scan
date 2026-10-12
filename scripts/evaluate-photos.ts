/** Local-only, whole-photograph evaluation. No downloads, crops, or inferred ground truth. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import cvModule from "@techstark/opencv-js";
import sharp from "sharp";
import { VisionEngine } from "../src/lib/vision/engine";
import type { Cv } from "../src/lib/vision/engine";
import { evidenceRank } from "../src/lib/vision/scoring";
import type { FeaturePack, VisionGame } from "../src/lib/vision/types";

const HELP = `Whole-photograph, offline vision diagnostics

node --import tsx scripts/evaluate-photos.ts --manifest photos.json \\
  --pack features.json [--pack another-shard.json] --output results.json

Alternatively use --pack-manifest index-manifest.json. Its packs[].file entries
are resolved by basename beside that manifest, matching build:index output.
Photo file paths are relative to the photo manifest; command-line paths are
relative to the working directory. All inputs must already exist locally.

Photo manifest: {"photos":[{"id":"scene-1","file":"photo.jpg",
  "expected_count":1,"expected_card_ids":["game:card-id"],
  "expected_card_names":["Card name"],"labels":{"notes":"optional"}}]}
Optional per-photo sha256 and dimensions {width,height} are verified when given.
Labels are copied to the report, never used to crop, retrieve, or match cards.
No accuracy or exact-printing score is inferred from names or detection counts.

Options: --budget-ms 1000 (80–1000), --max-cards 9 (1–9),
         --game pokemon|mtg|yugioh, --help
Only downscaling to the engine's 4096-pixel side / 16,000,000-pixel area limits
is applied. Stored pixel orientation is retained. This tool does not apply EXIF auto-rotation.
Reports include caller-provided local paths, labels and reference metadata.
Review and sanitize them before sharing; no images are embedded in reports.
`;

type JsonObject = Record<string, unknown>;
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}
function localPath(value: unknown, base: string, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    value.startsWith("//")
  ) {
    throw new Error(`${label} must be a nonempty local file path, not a URL.`);
  }
  return resolve(base, value);
}
function integer(
  value: string,
  maximum: number,
  label: string,
  minimum = 1,
): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  return number;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function checkHash(expected: unknown, actual: string, label: string): void {
  if (expected === undefined) return;
  if (
    typeof expected !== "string" ||
    !/^[a-f\d]{64}$/i.test(expected) ||
    expected.toLowerCase() !== actual
  )
    throw new Error(`SHA-256 verification failed for ${label}.`);
}
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    pack: { type: "string", multiple: true },
    "pack-manifest": { type: "string" },
    output: { type: "string" },
    "budget-ms": { type: "string", default: "1000" },
    "max-cards": { type: "string", default: "9" },
    game: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(HELP);
} else {
  if (
    !values.manifest ||
    !values.output ||
    (!values.pack?.length && !values["pack-manifest"])
  )
    throw new Error(HELP);
  if (values.pack?.length && values["pack-manifest"])
    throw new Error("Use either --pack or --pack-manifest, not both.");
  const budgetMs = integer(values["budget-ms"]!, 1000, "--budget-ms", 80);
  const maxCards = integer(values["max-cards"]!, 9, "--max-cards");
  if (values.game && !["pokemon", "mtg", "yugioh"].includes(values.game))
    throw new Error("--game must be pokemon, mtg, or yugioh.");
  const game = values.game as VisionGame | undefined;
  const manifestPath = localPath(values.manifest, process.cwd(), "--manifest");
  const outputPath = localPath(values.output, process.cwd(), "--output");
  const manifest = object(await readJson(manifestPath), "Photo manifest");
  if (!Array.isArray(manifest.photos) || !manifest.photos.length)
    throw new Error("Photo manifest must contain a nonempty photos array.");
  const photos = manifest.photos.map((value, i) => {
    const entry = object(value, `photos[${i}]`);
    const file = localPath(
      entry.file,
      dirname(manifestPath),
      `photos[${i}].file`,
    );
    if (
      entry.expected_count !== undefined &&
      (!Number.isInteger(entry.expected_count) ||
        Number(entry.expected_count) < 0)
    )
      throw new Error(
        `photos[${i}].expected_count must be a nonnegative integer.`,
      );
    for (const key of ["expected_card_ids", "expected_card_names"] as const) {
      if (
        entry[key] !== undefined &&
        (!Array.isArray(entry[key]) ||
          !(entry[key] as unknown[]).every((item) => typeof item === "string"))
      )
        throw new Error(`photos[${i}].${key} must be an array of strings.`);
    }
    return {
      entry,
      file,
      id: typeof entry.id === "string" ? entry.id : `photo-${i + 1}`,
    };
  });
  if (new Set(photos.map((photo) => photo.id)).size !== photos.length)
    throw new Error("Photo IDs must be unique.");
  const shards: {
    file: string;
    expectedHash?: unknown;
    expectedBytes?: unknown;
  }[] = [];
  let packManifestPath: string | undefined;
  if (values["pack-manifest"]) {
    packManifestPath = localPath(
      values["pack-manifest"],
      process.cwd(),
      "--pack-manifest",
    );
    const index = object(await readJson(packManifestPath), "Pack manifest");
    if (!Array.isArray(index.packs) || !index.packs.length)
      throw new Error("Pack manifest must contain a nonempty packs array.");
    for (const value of index.packs) {
      const entry = object(value, "Pack manifest entry");
      // Build manifests contain browser paths such as /packs/shard.json.
      const checked = localPath(
        entry.file,
        dirname(packManifestPath),
        "Pack shard",
      );
      shards.push({
        file: resolve(dirname(packManifestPath), basename(checked)),
        expectedHash: entry.sha256,
        expectedBytes: entry.bytes,
      });
    }
  } else {
    for (const file of values.pack!)
      shards.push({ file: localPath(file, process.cwd(), "--pack") });
  }
  const inputPaths = [
    manifestPath,
    ...photos.map((photo) => photo.file),
    ...shards.map((shard) => shard.file),
    ...(packManifestPath ? [packManifestPath] : []),
  ];
  if (inputPaths.includes(outputPath))
    throw new Error("Output must not overwrite an input file.");
  const cv = await (cvModule as unknown as Promise<Cv>);
  const engine = new VisionEngine(cv);
  const packInputs: {
    file: string;
    sha256: string;
    bytes: number;
    name: string;
  }[] = [];
  const runs = [];
  try {
    for (const shard of shards) {
      const bytes = await readFile(shard.file),
        hash = sha256(bytes);
      checkHash(shard.expectedHash, hash, shard.file);
      if (
        shard.expectedBytes !== undefined &&
        shard.expectedBytes !== bytes.length
      )
        throw new Error(`Byte count verification failed for ${shard.file}.`);
      const pack = JSON.parse(bytes.toString("utf8")) as FeaturePack;
      engine.loadPack(pack);
      packInputs.push({
        file: shard.file,
        sha256: hash,
        bytes: bytes.length,
        name: pack.name,
      });
    }
    for (const photo of photos) {
      const bytes = await readFile(photo.file),
        hash = sha256(bytes);
      checkHash(photo.entry.sha256, hash, photo.file);
      const original = await sharp(bytes, {
        limitInputPixels: 80_000_000,
      }).metadata();
      if (photo.entry.dimensions !== undefined) {
        const dimensions = object(
          photo.entry.dimensions,
          `${photo.id}.dimensions`,
        );
        if (
          dimensions.width !== original.width ||
          dimensions.height !== original.height
        )
          throw new Error(
            `Stored image dimensions differ from labels for ${photo.id}.`,
          );
      }
      if (!original.width || !original.height)
        throw new Error(`Image dimensions unavailable for ${photo.id}.`);
      const scale = Math.min(
        1,
        4096 / original.width,
        4096 / original.height,
        Math.sqrt(16_000_000 / (original.width * original.height)),
      );
      const targetWidth = Math.max(1, Math.floor(original.width * scale));
      const targetHeight = Math.max(1, Math.floor(original.height * scale));
      const { data, info } = await sharp(bytes, {
        limitInputPixels: 80_000_000,
      })
        .resize({
          width: targetWidth,
          height: targetHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const image = {
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height,
        colorSpace: "srgb",
      } as ImageData;
      const result = engine.analyze(image, {
        budgetMs,
        maxCards,
        game,
        includeDiagnostics: true,
      });
      runs.push({
        id: photo.id,
        file: photo.file,
        sha256: hash,
        mode: "whole-photo",
        manualRegion: false,
        originalDimensions: { width: original.width, height: original.height },
        inputDimensions: { width: info.width, height: info.height },
        sourceExifOrientation: original.orientation ?? null,
        suppliedLabels: {
          expectedCount: photo.entry.expected_count ?? null,
          expectedCardIds: photo.entry.expected_card_ids ?? null,
          expectedCardNames: photo.entry.expected_card_names ?? null,
          expectedOrder: photo.entry.expected_order ?? null,
          labels: photo.entry.labels ?? null,
        },
        observedCounts: {
          automaticDetections: result.detections.length,
          autoEligibleDetections: result.detections.filter(
            (d) => d.autoEligible,
          ).length,
        },
        result: {
          ...result,
          detections: result.detections.map((detection) => ({
            ...detection,
            rankedCandidates: detection.candidates.map((candidate, index) => ({
              rank: index + 1,
              evidenceRankingScore: evidenceRank(candidate),
              ...candidate,
            })),
          })),
        },
      });
    }
    const report = {
      createdAt: new Date().toISOString(),
      notice:
        "Reports contain caller-provided local paths, labels, and reference metadata; sanitize before sharing. Local whole-photograph observations only. Supplied labels are not independently verified. Detection counts do not establish localization recall or identity accuracy without spatial adjudication. Auto eligibility is identity-only; a top reference key does not confirm physical printing, language, finish, condition, or authenticity. Ranking scores are not probabilities. Single-run host timings are not mobile performance measurements.",
      parameters: {
        budgetMs,
        maxCards,
        game: game ?? "all",
        includeDiagnostics: true,
        maxInputSide: 4096,
        maxInputPixels: 16_000_000,
        exifAutoRotation: false,
        manualRoi: false,
      },
      runtime: { node: process.version, opencv: "@techstark/opencv-js" },
      inputs: {
        photoManifest: manifestPath,
        packs: packInputs,
        coverage: engine.coverage(),
      },
      runs,
    };
    await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          output: outputPath,
          photos: runs.length,
          coverage: engine.coverage(),
          observations: runs.map((run) => ({
            id: run.id,
            ...run.observedCounts,
            budgetExhausted: run.result.budgetExhausted,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    engine.dispose();
  }
}
