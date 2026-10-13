import { expect, it } from "vitest";
import { assessVariantMarketScope } from "./variant-market-scope";
import type {
  MarketFacet,
  MarketFacetAssertion,
  ScopedVariantQuote,
  VariantMarketMapping,
} from "./variant-market-scope";
const snapshotId = `sha256:${"a".repeat(64)}`;
const facets = {
  design: "base1-58",
  language: "en",
  edition: "unlimited",
  finish: "normal",
  condition: "near-mint",
};
function input() {
  const assertions = Object.fromEntries(
    Object.entries(facets).map(([key, value]) => [
      key,
      {
        value,
        source: "user",
        supported: true,
        evidenceIds: ["explicit-copy-review"],
      },
    ]),
  ) as Record<MarketFacet, MarketFacetAssertion>;
  const mapping: VariantMarketMapping = {
    provider: "test",
    productId: "product",
    variantId: "normal",
    catalogSnapshotId: snapshotId,
    facets,
    requiredFacets: ["design", "finish"],
    verified: true,
    sourceUrl: "https://example.com/variant",
    verifiedAt: "2026-10-13",
  };
  const quote: ScopedVariantQuote = {
    provider: "test",
    productId: "product",
    variantId: "normal",
    amount: 12,
    currency: "USD",
    metric: "market-estimate",
    providerUpdatedAt: "2026-10-12",
    fetchedAt: "2026-10-13",
    stale: false,
  };
  return { catalogSnapshotId: snapshotId, assertions, mapping, quote };
}
it("compatible references still never enable valuation or authentication", () => {
  expect(assessVariantMarketScope(input())).toEqual({
    status: "compatible-reference",
    reasons: ["explicit-facets-and-mapping-compatible"],
    physicalValuationEnabled: false,
  });
});
it.each([
  "design",
  "language",
  "edition",
  "finish",
  "condition",
] as MarketFacet[])(
  "requires the physical %s facet even if provider omits it",
  (facet) => {
    const value = input();
    delete (value.assertions as Partial<typeof value.assertions>)[facet];
    expect(assessVariantMarketScope(value).reasons).toContain(
      `${facet}-unknown`,
    );
  },
);
it("catalog defaults cannot establish the physical copy", () => {
  const value = input();
  value.assertions.edition.source = "catalog";
  expect(assessVariantMarketScope(value).status).toBe("reference-only");
});
it("same marketplace product ID cannot silently equate detailed variants", () => {
  const value = input();
  value.quote.variantId = "first-edition";
  expect(assessVariantMarketScope(value).status).toBe("unavailable");
});
it("missing detailed quote cannot fall back to root-card value", () => {
  expect(assessVariantMarketScope({ ...input(), quote: null }).status).toBe(
    "unavailable",
  );
});
it("keeps provider date and fetch date independent", () => {
  const value = input();
  value.quote.providerUpdatedAt = null;
  expect(assessVariantMarketScope(value).reasons).toContain(
    "provider-date-unknown",
  );
});
it("catalog updates invalidate crosswalk even when price is fresh", () => {
  const value = input();
  value.catalogSnapshotId = `sha256:${"b".repeat(64)}`;
  expect(assessVariantMarketScope(value).reasons).toContain(
    "catalog-mapping-version-mismatch",
  );
});
it("fresh catalog cannot conceal stale prices or unknown condition", () => {
  const value = input();
  value.quote.stale = true;
  value.assertions.condition.value = "unknown";
  expect(assessVariantMarketScope(value).reasons).toEqual(
    expect.arrayContaining(["quote-stale", "condition-unknown"]),
  );
});
it("does not silently equate different provider condition or finish keys", () => {
  const value = input();
  value.assertions.finish.value = "reverse-holo";
  expect(assessVariantMarketScope(value).reasons).toContain("finish-mismatch");
});
it("rejects invalid currency, zero price, and mismatched providers", () => {
  const value = input();
  value.quote.amount = 0;
  expect(assessVariantMarketScope(value).status).toBe("unavailable");
  value.quote.amount = 5;
  value.quote.provider = "other";
  expect(assessVariantMarketScope(value).status).toBe("unavailable");
});
