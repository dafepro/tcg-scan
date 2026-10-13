import type {
  PrintingCandidate,
  PrintingResolution,
} from "./printing-refinement";

/** Content-addressed provider snapshot, never a claim of universal physical coverage. */
export interface PrintingCatalogProvenance {
  schemaVersion: 1;
  snapshotId: string;
  provider: string;
  scope: string;
  fetchedAt: string | null;
  stale: boolean;
  completeWithinScope: boolean;
  candidateCount: number;
}
export interface PersistedPrintingRegion {
  regionId: string;
  registryVersion: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  sourceMinEdge: number;
  sampledPixels: number;
  edgeEnergy: number;
  contrast: number;
  highlightClippedFraction: number;
  shadowClippedFraction: number;
  transparentFraction: number;
  literalText: string;
}
export interface PersistedPrintingEvidence {
  schemaVersion: 1;
  resolverVersion: "literal-printing-v1";
  state: "catalog-printing-read";
  eventId: string;
  catalog: PrintingCatalogProvenance | null;
  observations: {
    captureId: string;
    sessionId: string;
    fingerprint: string;
    capturedAt: number;
    readerVersion: string;
    literalText: string;
    fields: Record<string, string>;
    regions?: PersistedPrintingRegion[];
  }[];
  /** These facts remain catalog identifiers, not authentication or physical valuation. */
  priceEligible: false;
}
const FIELDS = new Set([
  "collectorNumber",
  "printedTotal",
  "setCode",
  "locale",
  "edition",
  "rarity",
]);

/** Sorted semantic content makes the version independent of provider row ordering. */
export async function catalogProvenance(input: {
  candidates: readonly PrintingCandidate[];
  provider: string;
  scope: string;
  fetchedAt?: string;
  stale: boolean;
  catalogCompleteForIdentity: boolean;
}): Promise<PrintingCatalogProvenance> {
  const rows = input.candidates
    .map((row) => [
      // YGOPRODeck's adapter adds an array position for unique resolver keys.
      // Provider row order is not physical identity; retain the stable ID/code/rarity.
      row.game === "yugioh"
        ? row.key.replace(/^(yugioh:\d{1,8}:set:[^:]+:[^:]+):\d+$/, "$1")
        : row.key,
      row.game,
      row.name,
      row.identityKey ?? null,
      row.number ?? null,
      row.printedTotal ?? null,
      row.setCode ?? null,
      row.locale ?? null,
      row.edition ?? null,
      row.rarity ?? null,
      row.setName ?? null,
      row.sourceUrl ?? null,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const bytes = new TextEncoder().encode(
    JSON.stringify([1, input.provider, input.scope, rows]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    schemaVersion: 1,
    snapshotId:
      "sha256:" +
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    provider: input.provider,
    scope: input.scope,
    fetchedAt: input.fetchedAt ?? null,
    stale: input.stale,
    completeWithinScope: input.catalogCompleteForIdentity,
    candidateCount: rows.length,
  };
}

/** No camera pixels persist. Old readers remain explicitly unversioned. */
export function summarizePrintingEvidence(
  eventId: string,
  resolution: PrintingResolution,
): PersistedPrintingEvidence {
  return {
    schemaVersion: 1,
    resolverVersion: "literal-printing-v1",
    state: "catalog-printing-read",
    eventId,
    catalog: resolution.catalogProvenance ?? null,
    observations: resolution.evidence.slice(-8).map((observation) => ({
      captureId: observation.frameId,
      sessionId: observation.sessionId,
      fingerprint: observation.imageFingerprint,
      capturedAt: observation.capturedAt,
      readerVersion: observation.readerVersion ?? "legacy-unversioned",
      literalText: observation.rawText.slice(0, 2048),
      ...(observation.regions
        ? {
            regions: observation.regions.slice(0, 2).map((region) => ({
              regionId: region.regionId,
              registryVersion: region.registryVersion,
              x: region.x,
              y: region.y,
              width: region.width,
              height: region.height,
              outputWidth: region.outputWidth,
              outputHeight: region.outputHeight,
              sourceMinEdge: region.sourceMinEdge,
              sampledPixels: region.metrics.sampledPixels,
              edgeEnergy: region.metrics.sharpness,
              contrast: region.metrics.contrast,
              highlightClippedFraction: region.metrics.highlightClippedFraction,
              shadowClippedFraction: region.metrics.shadowClippedFraction,
              transparentFraction: region.metrics.transparentFraction,
              literalText: (region.rawText ?? "").slice(0, 2048),
            })),
          }
        : {}),
      fields: Object.fromEntries(
        Object.entries(observation.fields).filter(
          ([key, value]) => FIELDS.has(key) && typeof value === "string",
        ),
      ),
    })),
    priceEligible: false,
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error("Invalid printing evidence text.");
  return value;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 100);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Invalid printing evidence date.");
  return result;
}
export function parseCatalogProvenance(
  value: unknown,
): PrintingCatalogProvenance {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.stale !== "boolean" ||
    typeof value.completeWithinScope !== "boolean" ||
    !Number.isSafeInteger(value.candidateCount) ||
    Number(value.candidateCount) < 0 ||
    Number(value.candidateCount) > 2500 ||
    typeof value.snapshotId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.snapshotId)
  )
    throw new Error("Invalid printing catalog provenance.");
  return {
    schemaVersion: 1,
    snapshotId: value.snapshotId,
    provider: text(value.provider, 100),
    scope: text(value.scope, 2000),
    fetchedAt: timestamp(value.fetchedAt),
    stale: value.stale,
    completeWithinScope: value.completeWithinScope,
    candidateCount: Number(value.candidateCount),
  };
}
function parseRegions(value: unknown): PersistedPrintingRegion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2)
    throw new Error("Invalid printing regions.");
  return value.map((raw) => {
    if (!object(raw)) throw new Error("Invalid printing region.");
    const dimension = (key: string, zero = false) => {
      const value = raw[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < (zero ? 0 : 1) ||
        value > 16384
      )
        throw new Error("Invalid printing region dimensions.");
      return value;
    };
    const fraction = (key: string) => {
      const value = raw[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      )
        throw new Error("Invalid printing region measurement.");
      return value;
    };
    if (
      !Number.isSafeInteger(raw.sampledPixels) ||
      Number(raw.sampledPixels) < 1 ||
      Number(raw.sampledPixels) > 16384 ||
      typeof raw.literalText !== "string" ||
      raw.literalText.length > 2048
    )
      throw new Error("Invalid printing region observation.");
    const width = dimension("width"),
      height = dimension("height"),
      outputWidth = dimension("outputWidth"),
      outputHeight = dimension("outputHeight");
    if (outputWidth > width || outputHeight > height)
      throw new Error("Printing region cannot claim enlarged native detail.");
    return {
      regionId: text(raw.regionId, 100),
      registryVersion: text(raw.registryVersion, 100),
      x: dimension("x", true),
      y: dimension("y", true),
      width,
      height,
      outputWidth,
      outputHeight,
      sourceMinEdge: dimension("sourceMinEdge"),
      sampledPixels: Number(raw.sampledPixels),
      edgeEnergy: fraction("edgeEnergy"),
      contrast: fraction("contrast"),
      highlightClippedFraction: fraction("highlightClippedFraction"),
      shadowClippedFraction: fraction("shadowClippedFraction"),
      transparentFraction: fraction("transparentFraction"),
      literalText: raw.literalText,
    };
  });
}

/** Imported provenance is historical data, never permission to upgrade valuation. */
export function parsePrintingEvidence(
  value: unknown,
  eventId?: string,
): PersistedPrintingEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.resolverVersion !== "literal-printing-v1" ||
    value.state !== "catalog-printing-read" ||
    value.priceEligible !== false ||
    !Array.isArray(value.observations) ||
    value.observations.length < 2 ||
    value.observations.length > 8
  )
    throw new Error("Invalid printing evidence.");
  const storedEvent = text(value.eventId, 200);
  if (eventId && storedEvent !== eventId)
    throw new Error("Printing evidence belongs to another scan.");
  const observations = value.observations.map((raw) => {
    if (
      !object(raw) ||
      !object(raw.fields) ||
      Object.keys(raw.fields).some((key) => !FIELDS.has(key)) ||
      typeof raw.capturedAt !== "number" ||
      !Number.isFinite(raw.capturedAt) ||
      raw.capturedAt < 0 ||
      typeof raw.literalText !== "string" ||
      raw.literalText.length > 2048
    )
      throw new Error("Invalid printing observation.");
    return {
      captureId: text(raw.captureId, 300),
      sessionId: text(raw.sessionId, 200),
      fingerprint: text(raw.fingerprint, 300),
      capturedAt: raw.capturedAt,
      readerVersion: text(raw.readerVersion, 300),
      ...(raw.regions === undefined
        ? {}
        : { regions: parseRegions(raw.regions) }),
      literalText: raw.literalText,
      fields: Object.fromEntries(
        Object.entries(raw.fields).map(([key, field]) => [
          key,
          text(field, 200),
        ]),
      ),
    };
  });
  if (
    new Set(observations.map((row) => row.sessionId)).size !== 1 ||
    new Set(observations.map((row) => row.captureId)).size < 2 ||
    new Set(observations.map((row) => row.fingerprint)).size < 2
  )
    throw new Error("Invalid printing observation lineage.");
  return {
    schemaVersion: 1,
    resolverVersion: "literal-printing-v1",
    state: "catalog-printing-read",
    eventId: storedEvent,
    catalog:
      value.catalog === null ? null : parseCatalogProvenance(value.catalog),
    observations,
    priceEligible: false,
  };
}

/** A catalog addition can invalidate old uniqueness. Never overwrite history/user choices. */
export function printingEvidenceCatalogStatus(
  evidence: PersistedPrintingEvidence | undefined,
  current: PrintingCatalogProvenance,
): "current" | "review-required" | "legacy-unversioned" {
  if (!evidence?.catalog) return "legacy-unversioned";
  return evidence.catalog.snapshotId === current.snapshotId &&
    evidence.catalog.provider === current.provider &&
    evidence.catalog.scope === current.scope &&
    current.completeWithinScope &&
    !current.stale
    ? "current"
    : "review-required";
}
