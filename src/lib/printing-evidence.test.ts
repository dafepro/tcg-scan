import { describe, expect, it } from "vitest";
import { measurePrintingRegions } from "./printing-regions";
import {
  catalogProvenance,
  parsePrintingEvidence,
  printingEvidenceCatalogStatus,
  summarizePrintingEvidence,
} from "./printing-evidence";
import { addScanEvent, refineScanPrinting } from "./scan-inventory";
import { parseBackup } from "./storage";
import { collectionCsv, referenceTotals } from "./collection";
import type {
  PrintingCandidate,
  PrintingResolution,
} from "./printing-refinement";
const candidate: PrintingCandidate = {
  key: "pokemon:base1-58",
  game: "pokemon",
  name: "Pikachu",
  number: "58",
  printedTotal: "102",
  sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-58",
};
const snapshot = (candidates = [candidate]) => ({
  candidates,
  provider: "TCGdex",
  scope: "English provider records",
  fetchedAt: "2026-10-13T00:00:00Z",
  stale: false,
  catalogCompleteForIdentity: true,
});
const resolution = (): PrintingResolution => ({
  state: "catalog-printing-read",
  reference: candidate,
  reasons: [],
  finish: "unknown",
  condition: "unknown",
  priceEligible: false,
  unconfirmed: ["finish", "condition"],
  evidence: [0, 1].map((i) => ({
    jobId: `job${i}`,
    sessionId: "session",
    eventId: "event",
    frameId: `frame${i}`,
    imageFingerprint: `fingerprint${i}`,
    capturedAt: 1000 + i * 200,
    game: "pokemon",
    rawText: "058/102",
    fields: { collectorNumber: "58", printedTotal: "102" },
    issues: [],
  })),
});
describe("content-addressed catalog evidence", () => {
  it("is order-independent and changes on added siblings or discriminating fields", async () => {
    const other = { ...candidate, key: "pokemon:base4-58" };
    const a = await catalogProvenance(snapshot([candidate, other]));
    const b = await catalogProvenance(snapshot([other, candidate]));
    expect(a.snapshotId).toBe(b.snapshotId);
    expect((await catalogProvenance(snapshot())).snapshotId).not.toBe(
      a.snapshotId,
    );
    expect(
      (
        await catalogProvenance(
          snapshot([{ ...candidate, printedTotal: "103" }]),
        )
      ).snapshotId,
    ).not.toBe(a.snapshotId);
    expect(a.completeWithinScope).toBe(true);
  });
  it("records fetched time independently from snapshot content", async () => {
    const a = await catalogProvenance(snapshot());
    const b = await catalogProvenance({
      ...snapshot(),
      fetchedAt: "2026-10-14T00:00:00Z",
    });
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.fetchedAt).not.toBe(b.fetchedAt);
  });
  it("preserves literal leading zeros, lineage and unknown reader versions without images", () => {
    const evidence = summarizePrintingEvidence("event", resolution());
    expect(evidence.observations[0].literalText).toBe("058/102");
    expect(evidence.observations[0].fields.collectorNumber).toBe("58");
    expect(evidence.observations[0].readerVersion).toBe("legacy-unversioned");
    expect(JSON.stringify(evidence)).not.toContain("imageData");
    expect(parsePrintingEvidence(evidence, "event")).toEqual(evidence);
  });
  it("requires review after catalog changes, stale data or incomplete coverage", async () => {
    const catalog = await catalogProvenance(snapshot());
    const r = resolution();
    r.catalogProvenance = catalog;
    const evidence = summarizePrintingEvidence("event", r);
    expect(printingEvidenceCatalogStatus(evidence, catalog)).toBe("current");
    expect(
      printingEvidenceCatalogStatus(evidence, { ...catalog, stale: true }),
    ).toBe("review-required");
    expect(
      printingEvidenceCatalogStatus(evidence, {
        ...catalog,
        completeWithinScope: false,
      }),
    ).toBe("review-required");
    expect(
      printingEvidenceCatalogStatus(
        evidence,
        await catalogProvenance(
          snapshot([{ ...candidate, edition: "1ST EDITION" }]),
        ),
      ),
    ).toBe("review-required");
    expect(printingEvidenceCatalogStatus(undefined, catalog)).toBe(
      "legacy-unversioned",
    );
    expect(evidence.catalog).toEqual(catalog);
  });
});
describe("safe additive evidence backup migration", () => {
  it("round-trips lineage and versions without changing quantity or valuation", async () => {
    const r = resolution();
    r.catalogProvenance = await catalogProvenance(snapshot());
    const entries = refineScanPrinting(
      addScanEvent([], candidate, "event"),
      "event",
      r,
    );
    const twice = refineScanPrinting(entries, "event", r);
    const restored = parseBackup(
      JSON.stringify({ version: 1, collection: twice, review: [], decks: [] }),
    );
    expect(restored.collection[0].printingRead?.evidence).toEqual(
      twice[0].printingRead?.evidence,
    );
    expect(restored.collection[0].quantity).toBe(1);
    expect(restored.collection).toHaveLength(1);
    expect(referenceTotals(restored.collection).priced).toBe(0);
    expect(collectionCsv(restored.collection)).not.toContain('"100"');
  });
  it("accepts old printing rows without fabricating provenance", () => {
    const entries = refineScanPrinting(
      addScanEvent([], candidate, "event"),
      "event",
      resolution(),
    );
    delete entries[0].printingRead!.evidence;
    const restored = parseBackup(
      JSON.stringify({
        version: 1,
        collection: entries,
        review: [],
        decks: [],
      }),
    );
    expect(restored.collection[0].printingRead?.evidence).toBeUndefined();
    expect(restored.collection[0].verification).toBe("identity-only");
  });
  it.each([
    "event",
    "quantity",
    "version",
    "reader",
    "lineage",
    "fields",
    "pixels",
    "catalog",
  ])("rejects malformed %s evidence", (kind) => {
    const evidence = structuredClone(
      summarizePrintingEvidence("event", resolution()),
    ) as unknown as Record<string, unknown>;
    const observations = evidence.observations as Record<string, unknown>[];
    if (kind === "event") evidence.eventId = "wrong";
    if (kind === "quantity") evidence.priceEligible = true;
    if (kind === "version") evidence.schemaVersion = 2;
    if (kind === "reader") observations[0].readerVersion = "x".repeat(301);
    if (kind === "lineage")
      observations[1].captureId = observations[0].captureId;
    if (kind === "fields") observations[0].fields = { finish: "normal" };
    if (kind === "pixels") observations[0].literalText = "x".repeat(2049);
    if (kind === "catalog") evidence.catalog = { snapshotId: "invented" };
    expect(() => parsePrintingEvidence(evidence, "event")).toThrow();
  });
});

it("persists bounded native region measurements and literal reads without pixels", () => {
  const r = resolution();
  r.evidence[0].regions = [
    {
      regionId: "pokemon-footer",
      registryVersion: "printing-regions-v1",
      frameId: "frame0",
      imageFingerprint: "fingerprint0",
      x: 0,
      y: 499,
      width: 480,
      height: 141,
      outputWidth: 480,
      outputHeight: 141,
      sourceMinEdge: 520.5,
      metrics: {
        sampledPixels: 16384,
        sharpness: 0.12,
        contrast: 0.2,
        highlightClippedFraction: 0.3,
        shadowClippedFraction: 0.1,
        transparentFraction: 0,
      },
      qualityReasons: ["highlight-clipping"],
      rawText: "058/102",
    },
  ];
  const evidence = summarizePrintingEvidence("event", r);
  expect(evidence.observations[0].regions?.[0].literalText).toBe("058/102");
  expect(evidence.observations[0].regions?.[0].sourceMinEdge).toBe(520.5);
  expect(parsePrintingEvidence(evidence, "event")).toEqual(evidence);
  const enlarged = structuredClone(evidence);
  enlarged.observations[0].regions![0].outputWidth = 1920;
  expect(() => parsePrintingEvidence(enlarged, "event")).toThrow();
  const invalid = structuredClone(evidence);
  invalid.observations[0].regions![0].highlightClippedFraction = 1.1;
  expect(() => parsePrintingEvidence(invalid, "event")).toThrow();
  const oversized = structuredClone(evidence);
  oversized.observations[0].regions![0].sampledPixels = 16385;
  expect(() => parsePrintingEvidence(oversized, "event")).toThrow();
});

it("ignores YGOPRODeck provider-array positions without erasing actual variant differences", async () => {
  const one: PrintingCandidate = {
    key: "yugioh:123:set:LOB-EN001:Ultra%20Rare:0",
    game: "yugioh",
    name: "Fixture",
    identityKey: "yugioh:123",
    setCode: "LOB-EN001",
    rarity: "Ultra Rare",
    number: "001",
  };
  const two: PrintingCandidate = {
    ...one,
    key: "yugioh:123:set:SDK-EN001:Ultra%20Rare:1",
    setCode: "SDK-EN001",
  };
  const options = {
    provider: "YGOPRODeck",
    scope: "English listed set rows",
    stale: false,
    catalogCompleteForIdentity: true,
  };
  const a = await catalogProvenance({ ...options, candidates: [one, two] });
  const b = await catalogProvenance({
    ...options,
    candidates: [
      { ...two, key: two.key.replace(/:1$/, ":0") },
      { ...one, key: one.key.replace(/:0$/, ":1") },
    ],
  });
  expect(a.snapshotId).toBe(b.snapshotId);
  expect(
    (
      await catalogProvenance({
        ...options,
        candidates: [one, { ...two, rarity: "Secret Rare" }],
      })
    ).snapshotId,
  ).not.toBe(a.snapshotId);
  expect(
    (await catalogProvenance({ ...options, candidates: [one, one, two] }))
      .snapshotId,
  ).not.toBe(a.snapshotId);
});

it("round-trips explicit native versus bounded 2× reader input and rejects forged enlargement", () => {
  const r = resolution();
  r.evidence[0].regions = measurePrintingRegions(
    {
      width: 600,
      height: 840,
      data: new Uint8ClampedArray(600 * 840 * 4),
    },
    {
      game: "pokemon",
      frameId: "frame0",
      imageFingerprint: "fingerprint0",
      sourceMinEdge: 550,
    },
  );
  const evidence = summarizePrintingEvidence("event", r);
  const regions = evidence.observations[0].regions!;
  expect(regions[0].resampling).toBe("native");
  expect(regions[1]).toMatchObject({
    width: 85,
    outputWidth: 170,
    sourceMinEdge: 550,
    resampling: "upsampled",
    pageSegmentationMode: 7,
  });
  expect(parsePrintingEvidence(evidence, "event")).toEqual(evidence);
  for (const change of [
    { resampling: undefined },
    { pageSegmentationMode: undefined },
    { resampling: "native" },
    { resampling: "downsampled" },
    { resampling: "generated" },
    { resampling: null },
    { resampling: { toString: () => "upsampled" } },
    { pageSegmentationMode: 11 },
    { outputWidth: 433 },
    { outputHeight: 119 },
    { outputWidth: 1801 },
    { width: 85.5 },
    { regionId: "pokemon-footer" },
  ]) {
    const invalid = structuredClone(evidence);
    Object.assign(invalid.observations[0].regions![1], change);
    expect(
      () => parsePrintingEvidence(invalid, "event"),
      JSON.stringify(change),
    ).toThrow();
  }
});
