import { expect, test } from "@playwright/test";
const KEY = "tcg-scan:data:v1";
const fixture = () => ({
  version: 1,
  review: [],
  decks: [],
  collection: [
    {
      id: "scan:evidence-fixture",
      scanEventId: "evidence-fixture",
      quantity: 1,
      verification: "identity-only",
      condition: "Unknown",
      finish: "Unknown",
      addedAt: "2026-10-13T00:00:00Z",
      notes: "",
      card: {
        id: "base1-58",
        game: "pokemon",
        name: "Evidence fixture",
        setName: "Base Set",
        setCode: "base1",
        number: "58",
        rarity: "Unknown",
        sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-58",
        provider: "TCGdex",
        prices: [],
      },
      printingRead: {
        referenceId: "base1-58",
        setName: "Base Set",
        setCode: "base1",
        number: "58",
        sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-58",
        readAt: "2026-10-13T00:00:00Z",
        unconfirmed: ["edition", "finish", "condition"],
        evidence: {
          schemaVersion: 1,
          resolverVersion: "literal-printing-v1",
          state: "catalog-printing-read",
          eventId: "evidence-fixture",
          priceEligible: false,
          catalog: {
            schemaVersion: 1,
            snapshotId: `sha256:${"a".repeat(64)}`,
            provider: "Original test catalog",
            scope: "Synthetic UI fixture only",
            fetchedAt: "2026-10-13T00:00:00Z",
            stale: false,
            completeWithinScope: true,
            candidateCount: 2,
          },
          observations: [0, 1].map((index) => ({
            captureId: `capture-${index}`,
            sessionId: "session",
            fingerprint: `pixels-${index}`,
            capturedAt: 1000 + index * 200,
            readerVersion: "configured-fixture-reader",
            literalText:
              '058/102 <img src="https://never-load.invalid/" onerror="window.evidenceInjected=true">',
            fields: { collectorNumber: "58", printedTotal: "102" },
            regions: [
              {
                regionId: "pokemon-footer",
                registryVersion: "printing-regions-v1",
                x: 0,
                y: 499,
                width: 480,
                height: 141,
                outputWidth: 480,
                outputHeight: 141,
                sourceMinEdge: 520.5,
                sampledPixels: 16384,
                edgeEnergy: 0.0042,
                contrast: 0.2,
                highlightClippedFraction: 0.1,
                shadowClippedFraction: 0,
                transparentFraction: 0,
                literalText: "058/102",
              },
            ],
          })),
        },
      },
    },
  ],
});
test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (route) => route.abort());
});
for (const width of [320, 1440]) {
  test(`saved printing evidence is accessible, literal and unpriced at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      ({ key, data }) => localStorage.setItem(key, JSON.stringify(data)),
      { key: KEY, data: fixture() },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Collection", exact: true }).click();
    const card = page
      .locator(".collection-card")
      .filter({ hasText: "Evidence fixture" });
    await expect(card).toContainText("Identity only · value unavailable");
    const summary = card
      .locator("summary")
      .filter({ hasText: /^Printing evidence$/ });
    await summary.focus();
    await summary.press("Enter");
    const evidence = card.getByRole("region", {
      name: "Saved printing evidence",
    });
    await expect(evidence).toBeVisible();
    await evidence
      .locator("summary")
      .filter({ hasText: /^Read 1/ })
      .click();
    await expect(evidence).toContainText(
      '058/102 <img src="https://never-load.invalid/"',
    );
    await expect(page.locator("img[onerror]")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).evidenceInjected,
      ),
    ).toBeUndefined();
    await expect(evidence).toContainText("configured-fixture-reader");
    await expect(evidence).toContainText("480 × 141 px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await summary.focus();
    await summary.press("Enter");
    await expect(evidence).toBeHidden();
    const saved = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      KEY,
    );
    expect(saved.collection[0].quantity).toBe(1);
    expect(saved.collection[0].verification).toBe("identity-only");
    expect(saved.collection[0].printingRead.evidence.priceEligible).toBe(false);
  });
}
test("legacy printing rows do not fabricate saved evidence", async ({
  page,
}) => {
  const data = fixture();
  delete (data.collection[0].printingRead as { evidence?: unknown }).evidence;
  await page.addInitScript(
    ({ key, data }) => localStorage.setItem(key, JSON.stringify(data)),
    { key: KEY, data },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  const card = page
    .locator(".collection-card")
    .filter({ hasText: "Evidence fixture" });
  await expect(card).toContainText("Printed identifiers read");
  await expect(
    card.locator("summary").filter({ hasText: /^Printing evidence$/ }),
  ).toHaveCount(0);
  await expect(card).toContainText("Identity only · value unavailable");
});
