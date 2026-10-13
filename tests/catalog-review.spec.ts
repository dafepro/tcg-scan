import { expect, test, type Page, type Route } from "@playwright/test";
import { createPrintingCatalog } from "../src/lib/printing-catalog";
import { addScanEvent, refineScanPrinting } from "../src/lib/scan-inventory";
import type { AppData } from "../src/types";
import type { PrintingResolution } from "../src/lib/printing-refinement";

// Mocked-provider UI/lifecycle wiring only. No live-provider, OCR or physical accuracy claim.
const KEY = "tcg-scan:data:v1";
const reference = {
  key: "pokemon:base1-58",
  game: "pokemon" as const,
  name: "Pikachu",
};
const rows = [{ id: "base1-58", localId: "58", name: "Pikachu" }];
const sets = [{ id: "base1", name: "Base Set", cardCount: { official: 102 } }];
const pocket = { id: "tcgp", sets: [{ id: "A1" }] };
function response(url: URL, changed = false) {
  if (url.pathname === "/v2/en/cards")
    return changed
      ? [...rows, { id: "base1-59", localId: "59", name: "Pikachu" }]
      : rows;
  if (url.pathname === "/v2/en/sets") return sets;
  if (url.pathname === "/v2/en/series/tcgp") return pocket;
  return undefined;
}
async function fixture(legacy = false): Promise<AppData> {
  const catalog = createPrintingCatalog({
    cache: { get: async () => undefined, put: async () => undefined },
    fetch: async (input) =>
      new Response(JSON.stringify(response(new URL(String(input)))), {
        headers: { "Content-Type": "application/json" },
      }),
    sleep: async () => undefined,
    now: () => Date.parse("2026-10-13T03:00:00Z"),
  });
  const snapshot = await catalog.getPrintingCandidates(reference);
  const resolution: PrintingResolution = {
    state: "catalog-printing-read",
    reference: snapshot.candidates[0],
    reasons: [],
    priceEligible: false,
    condition: "unknown",
    finish: "unknown",
    unconfirmed: ["edition", "finish", "condition"],
    catalogProvenance: snapshot.provenance,
    evidence: [0, 1].map((index) => ({
      jobId: `read-${index}`,
      sessionId: "fixture-session",
      eventId: "fixture-event",
      frameId: `capture-${index}`,
      imageFingerprint: `fixture-pixels-${index}`,
      capturedAt: 1000 + index * 200,
      game: "pokemon",
      rawText: "058/102",
      readerVersion: "fixture-reader-only",
      fields: { collectorNumber: "58", printedTotal: "102" },
      issues: [],
    })),
  };
  const collection = refineScanPrinting(
    addScanEvent([], reference, "fixture-event"),
    "fixture-event",
    resolution,
  );
  if (legacy) delete collection[0].printingRead!.evidence;
  return { version: 1, collection, review: [], decks: [] };
}
async function seed(page: Page, input?: AppData, theme = "ember") {
  const data = input ?? (await fixture());
  await page.addInitScript(
    ({ key, data, theme }) => {
      // Seed only once: reload must use the actually persisted collection.
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(data));
      localStorage.setItem(
        "tcg-scan:preferences:v1",
        JSON.stringify({
          version: 1,
          preferences: {
            theme,
            density: "comfortable",
            motion: "reduced",
            overlayDetail: "minimal",
            game: "pokemon",
            captureFlow: "live",
            liveMode: "stream",
            savePolicy: "fast",
            autoSave: true,
            debugExpanded: false,
          },
        }),
      );
    },
    { key: KEY, data, theme },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Collection", exact: true }).click();
}
const card = (page: Page) =>
  page.locator(".collection-card").filter({ hasText: "Pikachu" });
const panel = (page: Page) => card(page).locator(".saved-catalog-review");
const open = async (page: Page) => {
  const summary = panel(page).locator("summary").first();
  await summary.focus();
  await summary.press("Enter");
};
async function mockProvider(
  page: Page,
  handler?: (route: Route, url: URL) => Promise<boolean>,
) {
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "api.tcgdex.net") {
      await route.abort();
      return;
    }
    if (await handler?.(route, url)) return;
    const value = response(url);
    if (value === undefined) {
      await route.abort();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
}

for (const [theme, width] of [
  ["ember", 320],
  ["cobalt", 390],
  ["violet", 1440],
] as const) {
  test(`catalog recheck is explicit, keyboard-accessible and unpriced in ${theme} at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    let lookups = 0;
    await mockProvider(page, async (_, url) => {
      if (url.pathname === "/v2/en/cards") lookups++;
      return false;
    });
    await seed(page, await fixture(), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const saved = await page.evaluate((key) => localStorage.getItem(key), KEY);
    expect(lookups).toBe(0);
    await open(page);
    expect(lookups).toBe(0);
    const check = panel(page).getByRole("button", {
      name: "Recheck provider catalog",
    });
    await check.focus();
    await check.press("Enter");
    await expect(
      panel(page).getByRole("region", { name: "Catalog check result" }),
    ).toContainText("Same provider snapshot at this check.");
    await expect(page.locator(".catalog-review-announcement")).toContainText(
      "Pikachu: Same provider snapshot at this check.",
    );
    await expect(panel(page)).toContainText("Provider fetch date");
    await expect(panel(page)).toContainText("Provider and scope checked");
    await expect(panel(page)).toContainText("not included in backups");
    await expect(card(page)).toContainText("Identity only · value unavailable");
    expect(lookups).toBe(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
      saved,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await testInfo.attach(`catalog-recheck-${theme}-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const target = await check.boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await page.reload();
    await page.getByRole("button", { name: "Collection", exact: true }).click();
    await open(page);
    await expect(
      panel(page).getByRole("region", { name: "Catalog check result" }),
    ).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
      saved,
    );
  });
}

test("changed provider siblings require review without changing saved identifiers or evidence", async ({
  page,
}) => {
  await mockProvider(page, async (route, url) => {
    if (url.pathname !== "/v2/en/cards") return false;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response(url, true)),
    });
    return true;
  });
  await seed(page);
  await open(page);
  const before = await page.evaluate((key) => localStorage.getItem(key), KEY);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText(
    "Provider snapshot changed · review needed.",
  );
  await expect(panel(page)).toContainText("Old uniqueness may no longer hold");
  await expect(card(page)).toContainText(
    "Printed identifiers read: Base Set · 58",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
    before,
  );
});

test("a failed repeated refresh replaces prior success with stale/incomplete fallback and its original fetch date", async ({
  page,
}) => {
  let fail = false,
    calls = 0;
  await mockProvider(page, async (route, url) => {
    if (url.pathname !== "/v2/en/cards") return false;
    calls++;
    if (!fail) return false;
    await route.fulfill({
      contentType: "application/json",
      body: '{"malformed":true}',
    });
    return true;
  });
  await seed(page);
  await open(page);
  const check = panel(page).getByRole("button", {
    name: "Recheck provider catalog",
  });
  await check.click();
  await expect(panel(page)).toContainText(
    "Same provider snapshot at this check.",
  );
  const date = await panel(page)
    .locator("dt")
    .filter({ hasText: /^Provider fetch date$/ })
    .locator("+ dd")
    .textContent();
  fail = true;
  await check.click();
  await expect(panel(page)).toContainText("Stale fallback · review needed.");
  await expect(panel(page)).toContainText(
    "Refresh failed. This is older cached metadata",
  );
  await expect(panel(page)).toContainText(
    "Complete coverage within this provider scope could not be established",
  );
  await expect(panel(page)).not.toContainText(
    "Same provider snapshot at this check.",
  );
  await expect(
    panel(page)
      .locator("dt")
      .filter({ hasText: /^Provider fetch date$/ })
      .locator("+ dd"),
  ).toContainText(date!);
  expect(calls).toBe(2);
});

test("legacy rows remain unversioned after a successful provider fetch", async ({
  page,
}) => {
  await mockProvider(page);
  await seed(page, await fixture(true));
  await open(page);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText(
    "Legacy evidence · no saved snapshot to compare.",
  );
  const data: AppData = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    KEY,
  );
  expect(data.collection[0].printingRead?.evidence).toBeUndefined();
  expect(data.collection[0].quantity).toBe(1);
  expect(data.collection[0].verification).toBe("identity-only");
});

test("cancel, disclosure close and navigation discard pending work without reviving late responses", async ({
  page,
}) => {
  let hold = true;
  const held: Route[] = [];
  await mockProvider(page, async (route, url) => {
    if (url.pathname === "/v2/en/cards" && hold) {
      held.push(route);
      return true;
    }
    return false;
  });
  await seed(page);
  await open(page);
  const check = panel(page).getByRole("button", {
    name: "Recheck provider catalog",
  });
  await check.click();
  await expect(panel(page)).toContainText("Checking provider catalog…");
  await panel(page)
    .getByRole("button", { name: "Cancel catalog check" })
    .click();
  await expect(panel(page)).toContainText("Catalog check cancelled.");
  await check.click();
  await panel(page).locator("summary").first().click();
  await open(page);
  await expect(panel(page)).toContainText("Catalog check cancelled.");
  await check.click();
  await page.getByRole("button", { name: "Deck checker", exact: true }).click();
  hold = false;
  for (const route of held)
    await route
      .fulfill({ contentType: "application/json", body: JSON.stringify(rows) })
      .catch(() => undefined);
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await open(page);
  await expect(
    panel(page).getByRole("region", { name: "Catalog check result" }),
  ).toHaveCount(0);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText(
    "Same provider snapshot at this check.",
  );
});

test("delete during a pending recheck removes only the entry and a late response cannot restore it", async ({
  page,
}) => {
  let pending: Route | undefined;
  await mockProvider(page, async (route, url) => {
    if (url.pathname === "/v2/en/cards") {
      pending = route;
      return true;
    }
    return false;
  });
  await seed(page);
  await open(page);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await card(page).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove entry", exact: true }).click();
  await expect(page.locator(".collection-card")).toHaveCount(0);
  await pending
    ?.fulfill({ contentType: "application/json", body: JSON.stringify(rows) })
    .catch(() => undefined);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).collection,
      KEY,
    ),
  ).toEqual([]);
});

test("missing provider coverage is unavailable, not a fresh or physically verified result", async ({
  page,
}) => {
  await mockProvider(page, async (route, url) => {
    if (url.pathname !== "/v2/en/cards") return false;
    await route.fulfill({ contentType: "application/json", body: "[]" });
    return true;
  });
  await seed(page);
  await open(page);
  const before = await page.evaluate((key) => localStorage.getItem(key), KEY);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText("Catalog check unavailable.");
  await expect(panel(page)).toContainText(
    "No matching provider records were returned.",
  );
  await expect(panel(page)).not.toContainText(
    "Same provider snapshot at this check.",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
    before,
  );
});

test("only one entry can be checked and a quantity edit discards the pending comparison", async ({
  page,
}) => {
  const data = await fixture();
  const second = structuredClone(data.collection[0]);
  second.id = "scan:second";
  second.scanEventId = "second";
  second.printingRead!.evidence!.eventId = "second";
  data.collection.push(second);
  let pending: Route | undefined;
  await mockProvider(page, async (route, url) => {
    if (url.pathname === "/v2/en/cards") {
      pending = route;
      return true;
    }
    return false;
  });
  await seed(page, data);
  const first = page.locator(".collection-card").first();
  const other = page.locator(".collection-card").last();
  for (const row of [first, other])
    await row.locator(".saved-catalog-review > summary").click();
  await first.getByRole("button", { name: "Recheck provider catalog" }).click();
  await expect(
    other.getByRole("button", { name: "Recheck provider catalog" }),
  ).toBeDisabled();
  await expect(other).toContainText("Another entry is being checked.");
  await first
    .getByRole("button", { name: "Increase Pikachu quantity" })
    .click();
  await expect(
    first.getByRole("region", { name: "Catalog check result" }),
  ).toHaveCount(0);
  await expect(
    other.getByRole("button", { name: "Recheck provider catalog" }),
  ).toBeEnabled();
  await pending
    ?.fulfill({ contentType: "application/json", body: JSON.stringify(rows) })
    .catch(() => undefined);
  const saved: AppData = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    KEY,
  );
  expect(saved.collection[0].quantity).toBe(2);
  expect(saved.collection[1].quantity).toBe(1);
  expect(saved.collection[0].verification).toBe("identity-only");
  expect(saved.collection[0].printingRead!.evidence).toEqual(
    data.collection[0].printingRead!.evidence,
  );
});

test("an identical backup import replaces entry objects and discards a pending check", async ({
  page,
}) => {
  let pending: Route | undefined;
  await mockProvider(page, async (route, url) => {
    if (url.pathname === "/v2/en/cards") {
      pending = route;
      return true;
    }
    return false;
  });
  await seed(page);
  await open(page);
  const before = await page.evaluate((key) => localStorage.getItem(key)!, KEY);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await page.getByLabel("Import JSON backup").setInputFiles({
    name: "same-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(before),
  });
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  await expect(
    panel(page).getByRole("region", { name: "Catalog check result" }),
  ).toHaveCount(0);
  await pending
    ?.fulfill({ contentType: "application/json", body: JSON.stringify(rows) })
    .catch(() => undefined);
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
    before,
  );
  await expect(panel(page)).not.toContainText(
    "Same provider snapshot at this check.",
  );
});

test("offline with no catalog cache has an actionable error and preserves the backup", async ({
  page,
}) => {
  await mockProvider(page, async (route, url) => {
    if (url.pathname !== "/v2/en/cards") return false;
    await route.abort();
    return true;
  });
  await seed(page);
  await open(page);
  const before = await page.evaluate((key) => localStorage.getItem(key), KEY);
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText("Catalog check unavailable.");
  await expect(panel(page)).toContainText(
    "The provider could not be reached. Try again when connected.",
  );
  await expect(panel(page)).not.toContainText(
    "Same provider snapshot at this check.",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
    before,
  );
});

test("recheck sends only bounded provider metadata GETs with no saved evidence, OCR or upload", async ({
  page,
}) => {
  await mockProvider(page);
  await seed(page);
  await open(page);
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (request) =>
    requests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
    }),
  );
  await panel(page)
    .getByRole("button", { name: "Recheck provider catalog" })
    .click();
  await expect(panel(page)).toContainText(
    "Same provider snapshot at this check.",
  );
  const metadata = requests.filter(
    (request) =>
      new URL(request.url).hostname === "api.tcgdex.net" &&
      response(new URL(request.url)) !== undefined,
  );
  expect(metadata).toHaveLength(3);
  for (const request of metadata) {
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.url).not.toMatch(
      /fixture-event|fixture-pixels|058%2F102|fixture-reader/,
    );
  }
  expect(
    requests.some((request) =>
      /\/ocr\/|\.traineddata|image\//.test(request.url),
    ),
  ).toBe(false);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
