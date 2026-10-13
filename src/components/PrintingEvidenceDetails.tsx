import type {
  PersistedPrintingEvidence,
  PersistedPrintingRegion,
  PrintingCatalogProvenance,
} from "../lib/printing-evidence";
import type { PrintingResolution } from "../lib/printing-refinement";
import "./printing-evidence-details.css";

export interface PrintingEvidenceDetailsProps {
  resolution?: PrintingResolution;
  evidence?: PersistedPrintingEvidence;
  summary?: string;
}
const fieldLabels: Record<string, string> = {
  collectorNumber: "Collector number",
  printedTotal: "Printed total",
  setCode: "Set code",
  locale: "Language marker",
  edition: "Edition text",
  rarity: "Rarity text",
};
const reasonLabels: Record<string, string> = {
  "same-copy-recapture-not-bound":
    "A later capture has not been linked to this same physical copy.",
  "catalog-not-queried":
    "This retained-capture read has not been checked against a printing catalog.",
  "catalog-coverage-incomplete": "Catalog coverage is incomplete.",
  "identity-catalog-missing": "No matching identity catalog is available.",
  "catalog-candidate-limit":
    "The catalog response exceeds the supported limit.",
  "catalog-duplicate-or-missing-key": "Catalog records need checking.",
  "catalog-identity-mismatch": "The catalog identity does not agree.",
  "conflicting-observations":
    "Literal reads disagree; printing stays unconfirmed.",
  "no-unambiguous-footer-evidence": "No unambiguous identifier read yet.",
  "two-distinct-captures-required":
    "Another original capture is required for agreement.",
  "catalog-fields-incomplete":
    "Some catalog fields are missing; missing is not absent.",
  "printing-or-variant-ambiguous":
    "More than one catalog printing or variant remains.",
  "no-catalog-printing-match":
    "The literal identifiers do not match the catalog.",
};
const bounded = (text: string) => text.slice(0, 2048);
const percent = (value: number) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Not recorded";
function CatalogSource({
  catalog,
}: {
  catalog?: PrintingCatalogProvenance | null;
}) {
  if (!catalog)
    return <p>Catalog source/version not recorded (legacy or unavailable).</p>;
  return (
    <details className="printing-evidence-source">
      <summary>Catalog source &amp; version</summary>
      <dl>
        <dt>Provider</dt>
        <dd>{catalog.provider}</dd>
        <dt>Lookup scope</dt>
        <dd>{catalog.scope}</dd>
        <dt>Coverage</dt>
        <dd>
          {catalog.completeWithinScope
            ? "Complete within this provider scope"
            : "Incomplete within this provider scope"}
          ; {catalog.candidateCount} records. Other physical alternatives may be
          unmodeled.
        </dd>
        <dt>Snapshot</dt>
        <dd>{catalog.snapshotId}</dd>
        <dt>Fetched</dt>
        <dd>
          {catalog.fetchedAt ?? "Not recorded"}
          {catalog.stale
            ? " · Stale response"
            : " · Historical snapshot; not a current recheck"}
        </dd>
      </dl>
    </details>
  );
}
function Region({ region }: { region: PersistedPrintingRegion }) {
  return (
    <li>
      <p>
        <strong>{region.regionId}</strong> · region configuration{" "}
        {region.registryVersion}
      </p>
      <p>
        Rectified capture region: {region.width} × {region.height} px at (
        {region.x}, {region.y}); reader input: {region.outputWidth} ×{" "}
        {region.outputHeight} px. Original source short edge:{" "}
        {region.sourceMinEdge} px.
      </p>
      <p className="printing-evidence-literal">
        {region.literalText
          ? bounded(region.literalText)
          : "No literal text read from this region."}
      </p>
      <details>
        <summary>Pixel measurements</summary>
        <p>
          Descriptive measurements only. They do not establish blur, glare,
          readability, finish, or absence of a printed feature.
        </p>
        <dl>
          <dt>Sampled pixels</dt>
          <dd>{region.sampledPixels}</dd>
          <dt>Edge energy</dt>
          <dd>{percent(region.edgeEnergy)}</dd>
          <dt>Contrast</dt>
          <dd>{percent(region.contrast)}</dd>
          <dt>Highlight-clipped pixels</dt>
          <dd>{percent(region.highlightClippedFraction)}</dd>
          <dt>Shadow-clipped pixels</dt>
          <dd>{percent(region.shadowClippedFraction)}</dd>
          <dt>Transparent pixels</dt>
          <dd>{percent(region.transparentFraction)}</dd>
        </dl>
      </details>
    </li>
  );
}
type Observation = PersistedPrintingEvidence["observations"][number] & {
  issues?: string[];
};
function Observations({ observations }: { observations: Observation[] }) {
  if (!observations.length) return <p>No literal reads recorded.</p>;
  return (
    <ol className="printing-evidence-observations">
      {observations.slice(-8).map((observation, index) => (
        <li key={`${observation.captureId}:${index}`}>
          <details>
            <summary>
              Read {index + 1} · {observation.regions?.length ?? 0} recorded
              regions
            </summary>
            <p>Uncorrected literal text:</p>
            <p className="printing-evidence-literal">
              {observation.literalText
                ? bounded(observation.literalText)
                : "No literal text read."}
            </p>
            <dl>
              {Object.entries(observation.fields)
                .filter(([field]) => fieldLabels[field])
                .map(([field, value]) => (
                  <div key={field}>
                    <dt>{fieldLabels[field]}</dt>
                    <dd>{bounded(value)}</dd>
                  </div>
                ))}
            </dl>
            {!!observation.issues?.length && (
              <p>Read issues: {observation.issues.slice(0, 12).join(", ")}</p>
            )}
            <p>
              Original capture: {observation.captureId} · session:{" "}
              {observation.sessionId} · capture clock value:{" "}
              {observation.capturedAt} ms.
            </p>
            <p>
              Source-pixel fingerprint: {observation.fingerprint}. Crops and
              rereads of this capture are not additional original captures.
            </p>
            <p>
              Reader configuration: {observation.readerVersion}. This identifies
              the configured reader, not physical accuracy.
            </p>
            {observation.regions?.length ? (
              <ul className="printing-evidence-regions">
                {observation.regions.slice(0, 2).map((region, regionIndex) => (
                  <Region
                    key={`${region.regionId}:${regionIndex}`}
                    region={region}
                  />
                ))}
              </ul>
            ) : (
              <p>Native region geometry was not recorded for this read.</p>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}
function liveObservations(resolution: PrintingResolution): Observation[] {
  return resolution.evidence.slice(-8).map((observation) => ({
    captureId: observation.frameId,
    sessionId: observation.sessionId,
    fingerprint: observation.imageFingerprint,
    capturedAt: observation.capturedAt,
    readerVersion: observation.readerVersion ?? "legacy-unversioned",
    literalText: observation.rawText,
    fields: Object.fromEntries(Object.entries(observation.fields)),
    issues: observation.issues,
    regions: observation.regions?.slice(0, 2).map((region) => ({
      ...region,
      edgeEnergy: region.metrics.sharpness,
      ...region.metrics,
      literalText: region.rawText ?? "",
    })),
  }));
}
/** No inference, fetching, HTML injection, images or inventory writes. */
export function PrintingEvidenceDetails({
  resolution,
  evidence,
  summary = "Printing evidence",
}: PrintingEvidenceDetailsProps) {
  return (
    <details className="printing-evidence-details">
      <summary>{summary}</summary>
      <div className="printing-evidence-content">
        <p>
          Catalog identifiers only. Physical printing, finish and condition may
          remain unconfirmed. Camera requests are not evidence.
        </p>
        {resolution && (
          <section aria-label="Latest local printing read">
            <strong>Latest local read</strong>
            <p>
              {resolution.state === "catalog-printing-read"
                ? "Literal identifiers match a catalog record. This read alone does not establish durable storage."
                : "Printing unconfirmed."}
            </p>
            {resolution.state === "unresolved" && (
              <ul>
                {resolution.reasons.slice(0, 12).map((reason, index) => (
                  <li key={`${reason}:${index}`}>
                    {reasonLabels[reason] ?? reason}
                  </li>
                ))}
              </ul>
            )}
            <CatalogSource catalog={resolution.catalogProvenance} />
            <Observations observations={liveObservations(resolution)} />
          </section>
        )}
        {evidence && (
          <section aria-label="Saved printing evidence">
            <strong>Saved evidence</strong>
            <p>
              Event: {evidence.eventId} · resolver: {evidence.resolverVersion} ·
              evidence schema: {evidence.schemaVersion}.
            </p>
            <CatalogSource catalog={evidence.catalog} />
            <Observations observations={evidence.observations} />
          </section>
        )}
        {!resolution && !evidence && (
          <p>
            No printing evidence recorded. Older saved identities may be
            unversioned.
          </p>
        )}
        <p>No camera images are retained in these details.</p>
      </div>
    </details>
  );
}
