import type {
  PrintingCandidate,
  PrintingFields,
  PrintingResolution,
} from "./printing-refinement";
import type { VisionGame } from "./vision/types";
import type { PrintingRegionId } from "./printing-regions";

/** Advisory text only. This is not a physically validated discriminator rule. */
export const PRINTING_LITERAL_GUIDANCE_VERSION = "literal-guidance-v1";
export const PRINTING_LITERAL_GUIDANCE_LIMITS = Object.freeze({
  candidates: 2500,
  promptsPerEvent: 1,
  rememberedEvents: 2500,
});
type LiteralField = "collectorNumber" | "printedTotal" | "setCode" | "locale";
export interface PrintingLiteralGuidance {
  action: "prompt" | "wait" | "review" | "complete";
  reason: string;
  message: string;
  field?: LiteralField;
  regionId?: PrintingRegionId;
  version: typeof PRINTING_LITERAL_GUIDANCE_VERSION;
  /** A missing catalog value and unmodeled physical alternatives remain unknown. */
  unmodeledAlternativeRetained: true;
}
export interface PrintingLiteralGuidanceInput {
  game: VisionGame;
  candidates: readonly PrintingCandidate[];
  catalogCompleteForIdentity: boolean;
  resolution: PrintingResolution;
  /** Lifetime budget for this occurrence; Pause must not reset it. */
  promptsIssued: number;
}
const fields: readonly LiteralField[] = [
  "collectorNumber",
  "printedTotal",
  "setCode",
  "locale",
];
const normalized = (value: string) =>
  value.normalize("NFKC").trim().toUpperCase();
function fieldValue(field: LiteralField, value: string | number | undefined) {
  if (value === undefined || !String(value).trim()) return undefined;
  const text = normalized(String(value));
  if (field === "collectorNumber" || field === "printedTotal")
    return text.replace(/^([A-Z]*?)0+(?=\d)/, "$1");
  if (field === "locale") return { JA: "JP", KO: "KR", SP: "ES" }[text] ?? text;
  return text;
}
function candidateFields(candidate: PrintingCandidate): PrintingFields {
  return {
    collectorNumber: fieldValue("collectorNumber", candidate.number),
    printedTotal: fieldValue("printedTotal", candidate.printedTotal),
    setCode: fieldValue("setCode", candidate.setCode),
    locale: fieldValue("locale", candidate.locale),
  };
}
const labels: Record<LiteralField, string> = {
  collectorNumber: "collector number",
  printedTotal: "number after the slash",
  setCode: "printed set code",
  locale: "printed language marker",
};
/**
 * Chooses one request from actual known catalog disagreement and missing literal
 * text. Pixel texture/clipping statistics, prompts and candidate prices are not
 * inputs. This function neither repairs OCR nor changes candidates/acceptance.
 */
export function planPrintingLiteralGuidance(
  input: PrintingLiteralGuidanceInput,
): PrintingLiteralGuidance {
  const result = (
    action: PrintingLiteralGuidance["action"],
    reason: string,
    message: string,
    extra: Partial<Pick<PrintingLiteralGuidance, "field" | "regionId">> = {},
  ): PrintingLiteralGuidance => ({
    action,
    reason,
    message,
    ...extra,
    version: PRINTING_LITERAL_GUIDANCE_VERSION,
    unmodeledAlternativeRetained: true,
  });
  const review = (reason: string, detail: string) =>
    result(
      "review",
      reason,
      `Printing remains unconfirmed. ${detail} Review it later.`,
    );
  const { resolution, candidates } = input;
  if (resolution.state === "catalog-printing-read")
    return result(
      "complete",
      "catalog-fields-read",
      "Catalog identifiers read; physical details remain unconfirmed.",
    );
  if (
    !Number.isSafeInteger(input.promptsIssued) ||
    input.promptsIssued < 0 ||
    candidates.length > PRINTING_LITERAL_GUIDANCE_LIMITS.candidates
  )
    return review(
      "invalid-guidance-input",
      "No supported camera request is available.",
    );
  if (
    !input.catalogCompleteForIdentity ||
    !candidates.length ||
    resolution.catalogProvenance?.stale ||
    resolution.catalogProvenance?.completeWithinScope === false
  )
    return review(
      "catalog-unavailable",
      "Catalog coverage is incomplete or stale.",
    );
  if (
    resolution.reasons.some((reason) =>
      [
        "catalog-duplicate-or-missing-key",
        "catalog-identity-mismatch",
        "catalog-candidate-limit",
        "identity-catalog-missing",
        "catalog-fields-incomplete",
        "no-catalog-printing-match",
        "conflicting-observations",
      ].includes(reason),
    )
  )
    return review(
      "catalog-or-read-conflict",
      "The text or catalog needs checking.",
    );
  if (
    new Set(candidates.map((candidate) => candidate.key)).size !==
      candidates.length ||
    candidates.some(
      (candidate) => !candidate.key || candidate.game !== input.game,
    )
  )
    return review("invalid-candidate-snapshot", "The catalog needs checking.");
  const observations = resolution.evidence.slice(-8);
  if (!observations.length)
    return result(
      "wait",
      "no-literal-read",
      "Printing unconfirmed. Waiting for a local identifier read.",
    );
  if (
    observations.some((observation) => observation.game !== input.game) ||
    new Set(observations.map((observation) => observation.eventId)).size !==
      1 ||
    new Set(observations.map((observation) => observation.sessionId)).size !==
      1 ||
    observations.some((observation) =>
      observation.issues.some((issue) => issue.startsWith("conflicting-")),
    )
  )
    return review(
      "conflicting-literal-read",
      "The text or capture association needs checking.",
    );
  const observed: PrintingFields = {};
  for (const field of fields) {
    const values = new Set(
      observations.flatMap((observation) => {
        const value = fieldValue(field, observation.fields[field]);
        return value === undefined ? [] : [value];
      }),
    );
    if (values.size > 1)
      return review(
        "conflicting-literal-read",
        "The identifier reads disagree.",
      );
    if (values.size === 1) observed[field] = [...values][0];
  }
  // This is a compatibility check for advice only. Missing values never exclude
  // a catalog record, and the original candidate array is never modified.
  const compatible = candidates
    .map(candidateFields)
    .filter((candidate) =>
      fields.every(
        (field) =>
          observed[field] === undefined ||
          candidate[field] === undefined ||
          candidate[field] === observed[field],
      ),
    );
  if (!compatible.length)
    return review(
      "catalog-or-read-conflict",
      "The literal identifiers do not match the catalog.",
    );
  const supported =
    input.game === "yugioh"
      ? fields.filter((field) => field !== "printedTotal")
      : fields;
  const missing = supported.find(
    (field) =>
      observed[field] === undefined &&
      new Set(
        compatible.flatMap((candidate) =>
          candidate[field] === undefined ? [] : [candidate[field]],
        ),
      ).size > 1,
  );
  if (
    missing &&
    input.promptsIssued < PRINTING_LITERAL_GUIDANCE_LIMITS.promptsPerEvent
  ) {
    const regionId =
      input.game === "yugioh"
        ? "yugioh-set-code"
        : (`${input.game}-footer` as PrintingRegionId);
    const location =
      input.game === "yugioh"
        ? "the set-code line below the artwork"
        : "the bottom identifier line";
    return result(
      "prompt",
      "missing-separating-literal",
      `Show ${location} closer once. Its ${labels[missing]} could separate the catalog matches.`,
      { field: missing, regionId },
    );
  }
  if (resolution.reasons.includes("two-distinct-captures-required"))
    return result(
      "wait",
      "another-original-capture-required",
      "Printing unconfirmed. Checking another original capture for agreement.",
    );
  if (missing)
    return review(
      "prompt-budget-exhausted",
      "The requested view did not establish a separating identifier.",
    );
  return review(
    "no-supported-literal-disagreement",
    "No unread supported text field separates the remaining catalog matches.",
  );
}
