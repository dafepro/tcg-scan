/** Advisory only: this module cannot accept evidence, remove candidates, or price a card. */
export const PRINTING_GUIDANCE_LIMITS = Object.freeze({
  candidates: 64,
  rules: 64,
  regions: 24,
  tasks: 24,
  promptHistory: 12,
  promptsPerEncounter: 4,
  noGainPerAction: 2,
  pendingWatchdogMs: 8_000,
});

export type PrintingExpectation =
  | { state: "value"; value: string }
  | { state: "absent" }
  | { state: "missing" };

export type PrintingViewAction =
  | "move-closer"
  | "hold-still"
  | "move-reflection"
  | "uncover"
  | "reframe"
  | "tilt"
  | "show-back";

export interface PrintingGuidanceCandidate {
  id: string;
  game: string;
  template: string;
  language: string;
  family: string;
}

export interface PrintingDiscriminatorRule {
  id: string;
  version: string;
  facet: string;
  source: {
    urls: readonly string[];
    sourceDate: string;
    reviewedBy: string;
    reviewedAt: string;
  };
  supportedSlice: {
    game: string;
    templates: readonly string[];
    languages: readonly string[];
    families: readonly string[];
    excludedCandidateIds: readonly string[];
    evaluationSlice: string;
  };
  calibration: {
    version: string;
    modelVersion: string;
    physicalImagesValidated: boolean;
  };
  region: {
    id: string;
    side: "front" | "back";
    /** Normalized coordinates in the reviewed template, not CSS/display pixels. */
    rect: { x: number; y: number; width: number; height: number };
  };
  observationType:
    | "literal-text"
    | "glyph"
    | "color-polarity"
    | "stamp"
    | "temporal-material"
    | "back-design";
  /** An omitted entry is missing metadata, never an absent physical feature. */
  expectations: Readonly<Record<string, PrintingExpectation>>;
  observability: {
    minNativeShortEdge: number;
    minFocus: number;
    minVisibleFraction: number;
    maxGlareFraction: number;
    maxOcclusionFraction: number;
    allowedAngles: readonly string[];
    negative: {
      validated: boolean;
      minVisibleFraction: number;
      maxGlareFraction: number;
      maxOcclusionFraction: number;
    };
  };
  actions: readonly {
    kind: PrintingViewAction;
    /** Ordered cost buckets, not estimated user success probabilities. */
    cost: "low" | "medium" | "high";
  }[];
}

/** No symbol, stamp, polarity, foil, or other candidate rule is deployed by default. */
export const DEFAULT_PRINTING_DISCRIMINATORS: readonly PrintingDiscriminatorRule[] =
  Object.freeze([]);

interface GuidanceLineage {
  encounterId: string;
  generation: number;
  catalogVersion: string;
  modelVersion: string;
}

export interface PrintingGuidanceRegion extends GuidanceLineage {
  captureId: string;
  /** Crops/resizes of the same physical observation keep the same source ID. */
  sourceCaptureId: string;
  regionId: string;
  capturedAt: number;
  pixels: "native" | "resampled" | "generated";
  association: "verified-front" | "continuous" | "user-confirmed" | "unbound";
  /** Mapping into original native pixels; enlargement cannot increase native detail. */
  originalRect: { x: number; y: number; width: number; height: number };
  sourceWidth: number;
  sourceHeight: number;
  focus: number;
  visibleFraction: number;
  glareFraction: number;
  occlusionFraction: number;
  angle: string;
  material?: {
    distinctViews: number;
    validatedMotion: boolean;
    sleeveGlareExcluded: boolean;
  };
}

export interface PrintingGuidanceTask extends GuidanceLineage {
  ruleId: string;
  ruleVersion: string;
  sourceCaptureId: string;
  startedAt: number;
  state: "pending" | "observed" | "unreadable" | "failed";
}

export interface PrintingGuidancePrompt extends GuidanceLineage {
  ruleId: string;
  ruleVersion: string;
  action: PrintingViewAction;
  issuedAt: number;
  outcome: "pending" | "improved" | "irrelevant" | "no-gain";
}

export interface PrintingGuidanceInput extends GuidanceLineage {
  now: number;
  active: boolean;
  candidates: readonly PrintingGuidanceCandidate[];
  /** Provider lookup coverage only; never proves all physical versions are modeled. */
  coverage: "known-complete" | "known-incomplete" | "unknown";
  /** Supplied by the independent resolver; a completed prompt cannot confirm a facet. */
  unconfirmedFacets: readonly string[];
  candidateSnapshot: {
    encounterId: string;
    generation: number;
    catalogVersion: string;
  };
  rules?: readonly PrintingDiscriminatorRule[];
  regions: readonly PrintingGuidanceRegion[];
  tasks: readonly PrintingGuidanceTask[];
  promptHistory: readonly PrintingGuidancePrompt[];
  /** Encounter-wide counter must survive bounded history eviction. */
  totalPromptsIssued: number;
  liveAssociation: "continuous" | "user-confirmed" | "unbound";
  literalContradiction?: boolean;
}

export type PrintingGuidanceReason =
  | "inactive"
  | "invalid-input"
  | "stale-candidates"
  | "unknown-coverage"
  | "candidate-contradiction"
  | "no-candidate-disagreement"
  | "unsupported-discriminator"
  | "association-required"
  | "existing-region-readable"
  | "equivalent-read-pending"
  | "useful-view"
  | "prompt-pending"
  | "prompt-budget-exhausted"
  | "read-timeout"
  | "no-useful-view";

export interface PrintingGuidancePlan extends GuidanceLineage {
  action: "read" | "prompt" | "wait" | "partial";
  reason: PrintingGuidanceReason;
  /** Provider completeness is never universal physical-version completeness. */
  unmodeledAlternativeRetained: true;
  ruleId?: string;
  ruleVersion?: string;
  regionId?: string;
  captureId?: string;
  sourceCaptureId?: string;
  viewAction?: PrintingViewAction;
  allowNegativeObservation?: boolean;
  message?: string;
}

const messages: Record<PrintingViewAction, string> = {
  "move-closer": "Move closer to the highlighted region.",
  "hold-still": "Hold still briefly so the highlighted region is sharp.",
  "move-reflection": "Move the reflection away from the highlighted region.",
  uncover: "Uncover the highlighted region.",
  reframe: "Keep the entire highlighted region in view.",
  tilt: "Tilt slowly to show the highlighted surface across the supported angles.",
  "show-back": "Show the back while keeping this same card associated.",
};

const fraction = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 1;
const nonempty = (value: string) => value.trim().length > 0;
function validSourceUrl(value: string) {
  if (
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Source dates and review timestamps use an unambiguous date or UTC ISO timestamp. */
function validProvenanceDate(value: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value))
    return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return false;
  const canonical = new Date(timestamp).toISOString();
  return value.length === 10
    ? canonical.slice(0, 10) === value
    : canonical === value || canonical.replace(".000Z", "Z") === value;
}
const sameLineage = (a: GuidanceLineage, b: GuidanceLineage) =>
  a.encounterId === b.encounterId &&
  a.generation === b.generation &&
  a.catalogVersion === b.catalogVersion &&
  a.modelVersion === b.modelVersion;
const boundBack = (association: PrintingGuidanceRegion["association"]) =>
  association === "continuous" || association === "user-confirmed";

function validRule(
  rule: PrintingDiscriminatorRule,
  input: PrintingGuidanceInput,
) {
  const q = rule.observability;
  const rect = rule.region.rect;
  return (
    [
      rule.id,
      rule.version,
      rule.facet,
      rule.region.id,
      rule.source.sourceDate,
      rule.source.reviewedBy,
      rule.source.reviewedAt,
      rule.calibration.version,
      rule.supportedSlice.evaluationSlice,
    ].every(nonempty) &&
    rule.source.urls.length > 0 &&
    rule.source.urls.every(validSourceUrl) &&
    validProvenanceDate(rule.source.sourceDate, input.now) &&
    validProvenanceDate(rule.source.reviewedAt, input.now) &&
    rule.calibration.physicalImagesValidated &&
    rule.calibration.modelVersion === input.modelVersion &&
    [rect.x, rect.y, rect.width, rect.height].every(fraction) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= 1 &&
    rect.y + rect.height <= 1 &&
    Number.isFinite(q.minNativeShortEdge) &&
    q.minNativeShortEdge > 0 &&
    [
      q.minFocus,
      q.minVisibleFraction,
      q.maxGlareFraction,
      q.maxOcclusionFraction,
      q.negative.minVisibleFraction,
      q.negative.maxGlareFraction,
      q.negative.maxOcclusionFraction,
    ].every(fraction) &&
    q.allowedAngles.length > 0 &&
    input.candidates.every(
      (candidate) =>
        candidate.game === rule.supportedSlice.game &&
        rule.supportedSlice.templates.includes(candidate.template) &&
        rule.supportedSlice.languages.includes(candidate.language) &&
        rule.supportedSlice.families.includes(candidate.family) &&
        !rule.supportedSlice.excludedCandidateIds.includes(candidate.id),
    ) &&
    (rule.region.side === "back") === (rule.observationType === "back-design")
  );
}

function separation(
  rule: PrintingDiscriminatorRule,
  candidates: readonly PrintingGuidanceCandidate[],
) {
  const values = candidates.map(({ id }) => {
    const expectation = rule.expectations[id];
    if (!expectation || expectation.state === "missing") return undefined;
    if (expectation.state === "absent") return "absent";
    return nonempty(expectation.value)
      ? `value:${expectation.value}`
      : undefined;
  });
  let pairs = 0;
  for (let a = 0; a < values.length; a++)
    for (let b = a + 1; b < values.length; b++)
      if (
        values[a] !== undefined &&
        values[b] !== undefined &&
        values[a] !== values[b]
      )
        pairs++;
  return pairs;
}

function validRegion(
  region: PrintingGuidanceRegion,
  input: PrintingGuidanceInput,
) {
  const rect = region.originalRect;
  return (
    sameLineage(region, input) &&
    region.association !== "unbound" &&
    nonempty(region.captureId) &&
    nonempty(region.sourceCaptureId) &&
    Number.isFinite(region.capturedAt) &&
    region.capturedAt <= input.now &&
    [
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      region.sourceWidth,
      region.sourceHeight,
    ].every((value) => Number.isFinite(value) && value >= 0) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= region.sourceWidth &&
    rect.y + rect.height <= region.sourceHeight &&
    [
      region.focus,
      region.visibleFraction,
      region.glareFraction,
      region.occlusionFraction,
    ].every(fraction)
  );
}

function qualityNeeds(
  rule: PrintingDiscriminatorRule,
  region: PrintingGuidanceRegion,
) {
  const q = rule.observability;
  const negative = Object.values(rule.expectations).some(
    (value) => value.state === "absent",
  );
  const visible = negative
    ? Math.max(q.minVisibleFraction, q.negative.minVisibleFraction)
    : q.minVisibleFraction;
  const glare = negative
    ? Math.min(q.maxGlareFraction, q.negative.maxGlareFraction)
    : q.maxGlareFraction;
  const occlusion = negative
    ? Math.min(q.maxOcclusionFraction, q.negative.maxOcclusionFraction)
    : q.maxOcclusionFraction;
  const needs: PrintingViewAction[] = [];
  if (region.occlusionFraction > occlusion) needs.push("uncover");
  if (region.glareFraction > glare) needs.push("move-reflection");
  if (region.visibleFraction < visible) needs.push("reframe");
  if (region.focus < q.minFocus) needs.push("hold-still");
  // Moving closer with already poor focus is not useful advice.
  else if (
    Math.min(region.originalRect.width, region.originalRect.height) <
    q.minNativeShortEdge
  )
    needs.push("move-closer");
  if (!q.allowedAngles.includes(region.angle))
    needs.push(
      rule.observationType === "temporal-material" ? "tilt" : "reframe",
    );
  if (
    rule.observationType === "temporal-material" &&
    (!region.material?.validatedMotion ||
      !region.material.sleeveGlareExcluded ||
      !Number.isInteger(region.material.distinctViews) ||
      region.material.distinctViews < 2)
  )
    needs.push("tilt");
  return needs;
}

/**
 * Deterministic next-step advice. The caller owns cancellation, task scheduling,
 * prompt bookkeeping, association, and every independent evidence/acceptance gate.
 */
export function planPrintingGuidance(
  input: PrintingGuidanceInput,
): PrintingGuidancePlan {
  const base: GuidanceLineage = {
    encounterId: input.encounterId,
    generation: input.generation,
    catalogVersion: input.catalogVersion,
    modelVersion: input.modelVersion,
  };
  const result = (
    action: PrintingGuidancePlan["action"],
    reason: PrintingGuidanceReason,
    extra: Partial<PrintingGuidancePlan> = {},
  ): PrintingGuidancePlan => ({
    ...base,
    action,
    reason,
    unmodeledAlternativeRetained: true,
    ...extra,
  });
  if (!input.active) return result("partial", "inactive");
  const rules = input.rules ?? DEFAULT_PRINTING_DISCRIMINATORS;
  const limits = PRINTING_GUIDANCE_LIMITS;
  if (
    !Number.isFinite(input.now) ||
    !Number.isInteger(input.generation) ||
    input.generation < 0 ||
    ![input.encounterId, input.catalogVersion, input.modelVersion].every(
      nonempty,
    ) ||
    input.candidates.length > limits.candidates ||
    rules.length > limits.rules ||
    input.regions.length > limits.regions ||
    input.tasks.length > limits.tasks ||
    input.promptHistory.length > limits.promptHistory ||
    !Number.isInteger(input.totalPromptsIssued) ||
    input.totalPromptsIssued < input.promptHistory.length ||
    input.candidates.some(
      (candidate) =>
        ![
          candidate.id,
          candidate.game,
          candidate.template,
          candidate.language,
          candidate.family,
        ].every(nonempty),
    ) ||
    new Set(input.candidates.map((candidate) => candidate.id)).size !==
      input.candidates.length ||
    new Set(rules.map((rule) => rule.id)).size !== rules.length
  )
    return result("partial", "invalid-input");
  if (
    input.candidateSnapshot.encounterId !== input.encounterId ||
    input.candidateSnapshot.generation !== input.generation ||
    input.candidateSnapshot.catalogVersion !== input.catalogVersion
  )
    return result("partial", "stale-candidates");
  if (input.literalContradiction)
    return result("partial", "candidate-contradiction", {
      message:
        "Printed evidence conflicts with these candidates. Recheck identity and capture association.",
    });
  if (input.coverage === "unknown")
    return result("partial", "unknown-coverage");
  if (input.candidates.length < 2 || input.unconfirmedFacets.length === 0)
    return result("partial", "no-candidate-disagreement");

  const choices = rules
    .filter(
      (rule) =>
        validRule(rule, input) &&
        input.unconfirmedFacets.includes(rule.facet) &&
        (!input.candidates.some(
          ({ id }) => rule.expectations[id]?.state === "absent",
        ) ||
          rule.observability.negative.validated),
    )
    .map((rule) => ({ rule, gain: separation(rule, input.candidates) }))
    .filter(({ gain }) => gain > 0)
    .sort((a, b) => b.gain - a.gain || a.rule.id.localeCompare(b.rule.id));
  if (choices.length === 0)
    return result("partial", "unsupported-discriminator");

  const regions = input.regions.filter((region) => validRegion(region, input));
  const tasks = input.tasks.filter(
    (task) =>
      sameLineage(task, input) &&
      Number.isFinite(task.startedAt) &&
      task.startedAt <= input.now,
  );
  const prompts = input.promptHistory.filter(
    (prompt) =>
      sameLineage(prompt, input) &&
      Number.isFinite(prompt.issuedAt) &&
      prompt.issuedAt <= input.now,
  );
  const pending: PrintingDiscriminatorRule[] = [];
  const viewChoices: {
    rule: PrintingDiscriminatorRule;
    action: PrintingViewAction;
    score: number;
  }[] = [];
  let timedOut = false;
  let unbound = false;
  for (const { rule, gain } of choices) {
    const metadata = {
      ruleId: rule.id,
      ruleVersion: rule.version,
      regionId: rule.region.id,
    };
    const ruleTasks = tasks.filter(
      (task) => task.ruleId === rule.id && task.ruleVersion === rule.version,
    );
    const currentPending = ruleTasks.some(
      (task) =>
        task.state === "pending" &&
        input.now - task.startedAt < limits.pendingWatchdogMs,
    );
    timedOut ||= ruleTasks.some(
      (task) =>
        task.state === "pending" &&
        !currentPending &&
        input.now - task.startedAt >= limits.pendingWatchdogMs,
    );
    if (currentPending) {
      pending.push(rule);
      continue;
    }
    const usable = regions
      .filter(
        (region) =>
          region.regionId === rule.region.id &&
          (rule.region.side !== "back" || boundBack(region.association)),
      )
      .sort(
        (a, b) =>
          b.capturedAt - a.capturedAt || a.captureId.localeCompare(b.captureId),
      );
    // Search all retained captures: a newer glare view must not discard a good text crop.
    for (const region of usable) {
      if (
        region.pixels === "generated" ||
        qualityNeeds(rule, region).length > 0 ||
        ruleTasks.some(
          (task) => task.sourceCaptureId === region.sourceCaptureId,
        )
      )
        continue;
      return result("read", "existing-region-readable", {
        ...metadata,
        captureId: region.captureId,
        sourceCaptureId: region.sourceCaptureId,
        allowNegativeObservation:
          rule.observability.negative.validated &&
          region.visibleFraction >=
            rule.observability.negative.minVisibleFraction &&
          region.glareFraction <=
            rule.observability.negative.maxGlareFraction &&
          region.occlusionFraction <=
            rule.observability.negative.maxOcclusionFraction,
      });
    }
    if (rule.region.side === "back" && !boundBack(input.liveAssociation)) {
      unbound = true;
      continue;
    }
    // Quality of reconstructed pixels cannot justify any request or evidence read.
    const latest = usable.find((region) => region.pixels !== "generated");
    const needs = latest
      ? qualityNeeds(rule, latest)
      : rule.region.side === "back"
        ? ["show-back" as const]
        : ["reframe" as const];
    for (const action of rule.actions) {
      if (
        !needs.includes(action.kind) ||
        (action.kind === "tilt" &&
          (rule.observationType !== "temporal-material" ||
            needs.some((need) => need !== "tilt"))) ||
        (action.kind === "show-back" && rule.region.side !== "back")
      )
        continue;
      const history = prompts.filter(
        (prompt) =>
          prompt.ruleId === rule.id &&
          prompt.ruleVersion === rule.version &&
          prompt.action === action.kind,
      );
      if (
        history.some(
          (prompt) =>
            prompt.outcome === "improved" || prompt.outcome === "irrelevant",
        ) ||
        history.filter((prompt) => prompt.outcome === "no-gain").length >=
          limits.noGainPerAction
      )
        continue;
      const cost = { low: 1, medium: 2, high: 3 }[action.cost];
      viewChoices.push({ rule, action: action.kind, score: gain / cost });
    }
  }
  if (pending.length > 0)
    return result("wait", "equivalent-read-pending", {
      ruleId: pending[0].id,
      ruleVersion: pending[0].version,
      regionId: pending[0].region.id,
    });
  if (
    prompts.some(
      (prompt) =>
        prompt.outcome === "pending" &&
        input.now - prompt.issuedAt < limits.pendingWatchdogMs &&
        viewChoices.some(
          ({ rule, action }) =>
            rule.id === prompt.ruleId &&
            rule.version === prompt.ruleVersion &&
            action === prompt.action,
        ),
    )
  )
    return result("wait", "prompt-pending");
  // A forgotten pending prompt consumes its attempt, but must not create an infinite wait/re-prompt loop.
  const retired = viewChoices.filter(
    ({ rule, action }) =>
      !prompts.some(
        (prompt) =>
          prompt.ruleId === rule.id &&
          prompt.ruleVersion === rule.version &&
          prompt.action === action &&
          prompt.outcome === "pending" &&
          input.now - prompt.issuedAt >= limits.pendingWatchdogMs,
      ),
  );
  if (input.totalPromptsIssued >= limits.promptsPerEncounter)
    return result("partial", "prompt-budget-exhausted", {
      message: "The remaining detail is unconfirmed. You can review it later.",
    });
  retired.sort(
    (a, b) =>
      b.score - a.score ||
      a.rule.id.localeCompare(b.rule.id) ||
      a.action.localeCompare(b.action),
  );
  const next = retired[0];
  if (next)
    return result("prompt", "useful-view", {
      ruleId: next.rule.id,
      ruleVersion: next.rule.version,
      regionId: next.rule.region.id,
      viewAction: next.action,
      message: messages[next.action],
    });
  return result(
    "partial",
    timedOut
      ? "read-timeout"
      : unbound
        ? "association-required"
        : "no-useful-view",
    {
      message: "The remaining detail is unconfirmed.",
    },
  );
}
