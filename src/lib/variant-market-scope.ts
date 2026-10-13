/** Provider mappings are separate evidence from camera recognition. This module
 * never fetches prices or changes collection totals. */
export type MarketFacet =
  "design" | "language" | "edition" | "finish" | "condition";
export interface MarketFacetAssertion {
  value: string;
  source: "visual" | "user" | "catalog";
  /** A model output alone is not a validated assertion. */
  supported: boolean;
  evidenceIds: string[];
}
export interface VariantMarketMapping {
  provider: string;
  productId: string;
  variantId: string;
  catalogSnapshotId: string;
  /** Exact values the provider's product/quote actually prices. */
  facets: Partial<Record<MarketFacet, string>>;
  requiredFacets: MarketFacet[];
  verified: boolean;
  sourceUrl: string;
  verifiedAt: string;
}
export interface ScopedVariantQuote {
  provider: string;
  productId: string;
  variantId: string;
  amount: number;
  currency: "USD" | "EUR";
  metric:
    | "market-estimate"
    | "listed-low"
    | "sales-average"
    | "completed-sale"
    | "buy-offer";
  providerUpdatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}
export interface MarketScopeAssessment {
  status: "compatible-reference" | "reference-only" | "unavailable";
  reasons: string[];
  /** Even a compatible provider reference is not an authentication/appraisal. */
  physicalValuationEnabled: false;
}
const FACETS: readonly MarketFacet[] = [
  "design",
  "language",
  "edition",
  "finish",
  "condition",
];
const validText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 500;
const validDate = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const result = (
  status: MarketScopeAssessment["status"],
  ...reasons: string[]
): MarketScopeAssessment => ({
  status,
  reasons,
  physicalValuationEnabled: false,
});
/** No base-card fallback; no price amount is available to the recognizer. */
export function assessVariantMarketScope(input: {
  catalogSnapshotId: string;
  assertions: Partial<Record<MarketFacet, MarketFacetAssertion>>;
  mapping: VariantMarketMapping | null;
  quote: ScopedVariantQuote | null;
}): MarketScopeAssessment {
  const { mapping, quote, assertions } = input;
  if (!mapping || !quote)
    return result("unavailable", "detailed-variant-quote-missing");
  if (
    !Number.isFinite(quote.amount) ||
    quote.amount <= 0 ||
    !["USD", "EUR"].includes(quote.currency) ||
    ![
      "market-estimate",
      "listed-low",
      "sales-average",
      "completed-sale",
      "buy-offer",
    ].includes(quote.metric) ||
    !validDate(quote.fetchedAt) ||
    (quote.providerUpdatedAt !== null && !validDate(quote.providerUpdatedAt))
  )
    return result("unavailable", "invalid-quote");
  if (
    ![
      mapping.provider,
      mapping.productId,
      mapping.variantId,
      quote.provider,
      quote.productId,
      quote.variantId,
    ].every(validText) ||
    mapping.provider !== quote.provider ||
    mapping.productId !== quote.productId ||
    mapping.variantId !== quote.variantId
  )
    return result("unavailable", "provider-product-variant-mismatch");
  const reasons: string[] = [];
  let sourceValid = false;
  try {
    const url = new URL(mapping.sourceUrl);
    sourceValid = url.protocol === "https:" && !url.username && !url.password;
  } catch {
    /* invalid provenance */
  }
  if (!mapping.verified || !sourceValid || !validDate(mapping.verifiedAt))
    reasons.push("mapping-unverified");
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.catalogSnapshotId) ||
    mapping.catalogSnapshotId !== input.catalogSnapshotId
  )
    reasons.push("catalog-mapping-version-mismatch");
  if (quote.stale) reasons.push("quote-stale");
  if (quote.providerUpdatedAt === null) reasons.push("provider-date-unknown");
  // Every physical facet is explicit even if this provider markets it as unknown.
  const required = new Set<MarketFacet>([...FACETS, ...mapping.requiredFacets]);
  for (const facet of required) {
    if (!FACETS.includes(facet)) {
      reasons.push("unsupported-market-facet");
      continue;
    }
    const expected = mapping.facets[facet],
      actual = assertions[facet];
    if (!validText(expected)) {
      reasons.push(`mapping-${facet}-unknown`);
      continue;
    }
    if (
      !actual ||
      !validText(actual.value) ||
      actual.value.toLowerCase() === "unknown"
    ) {
      reasons.push(`${facet}-unknown`);
      continue;
    }
    if (
      actual.source === "catalog" ||
      !actual.supported ||
      !actual.evidenceIds.length ||
      actual.evidenceIds.length > 8 ||
      !actual.evidenceIds.every(validText)
    )
      reasons.push(`${facet}-not-physically-supported`);
    if (actual.value !== expected) reasons.push(`${facet}-mismatch`);
  }
  return reasons.length
    ? result("reference-only", ...reasons)
    : result("compatible-reference", "explicit-facets-and-mapping-compatible");
}
