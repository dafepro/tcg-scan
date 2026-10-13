import { openDisclosure } from "./fixtures/disclosures";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Deterministic UI tests. Catalog responses and camera denial are fixtures, not
// evidence of live API availability, physical-camera support, or OCR accuracy.
const stamp = "2026-10-12T00:00:00.000Z";
const card = {
  id: "00000000-0000-4000-8000-000000000001",
  game: "mtg",
  name: "Fixture Mage",
  setName: "Fixture Set",
  setCode: "tst",
  number: "1",
  rarity: "rare",
  sourceUrl: "https://scryfall.com/card/tst/1/fixture-mage",
  provider: "Scryfall",
  prices: [
    { amount: 2.5, currency: "USD", source: "Test fixture", updatedAt: stamp },
  ],
};
const entry = {
  id: "fixture-entry",
  card,
  quantity: 2,
  condition: "Near mint",
  finish: "Normal",
  addedAt: stamp,
  notes: "",
};
const backup = { version: 1, collection: [entry], review: [], decks: [] };
const mtgResponse = {
  id: card.id,
  name: card.name,
  set_name: card.setName,
  set: "tst",
  collector_number: "1",
  rarity: "rare",
  scryfall_uri: card.sourceUrl,
  prices: { usd: "2.50", eur: "2.00" },
};

async function mockCatalogs(page: Page) {
  // No third-party traffic is needed for these tests.
  await page.route("https://**/*", (route) => route.abort());
  await page.route("https://api.scryfall.com/**", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q") ?? "";
    if (query === "Offline fixture") return route.abort("internetdisconnected");
    if (query === "Empty fixture")
      return route.fulfill({
        status: 404,
        json: { object: "error", details: "No cards found." },
      });
    return route.fulfill({
      json: url.pathname.endsWith("/search")
        ? { object: "list", data: [mtgResponse] }
        : mtgResponse,
    });
  });
  await page.route("https://api.tcgdex.net/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/base1-58")
        ? {
            id: "base1-58",
            name: "Fixture Pikachu",
            localId: "58",
            set: { id: "base1", name: "Fixture Base Set" },
            rarity: "Common",
            pricing: {
              tcgplayer: {
                unit: "USD",
                normal: { marketPrice: 1.25 },
                updated: stamp,
              },
            },
          }
        : [{ id: "base1-58", name: "Fixture Pikachu", localId: "58" }],
    }),
  );
  await page.route("https://db.ygoprodeck.com/**", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 12345678,
            name: "Fixture Magician",
            ygoprodeck_url: "https://ygoprodeck.com/card/fixture-magician-1",
            card_sets: [
              { set_name: "Fixture A", set_code: "A-1" },
              { set_name: "Fixture B", set_code: "B-2" },
            ],
            card_prices: [{ tcgplayer_price: "3.50" }],
            card_images: [
              {
                image_url:
                  "https://images.ygoprodeck.com/images/cards/12345678.jpg",
              },
            ],
          },
        ],
      },
    }),
  );
}

async function open(page: Page) {
  await mockCatalogs(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Scan cards",
    }),
  ).toBeVisible();
}

async function searchMtg(page: Page, name = "Fixture Mage") {
  await openDisclosure(page, "Change game");
  await openDisclosure(page, "Find a card");
  await page.getByRole("button", { name: "Magic", exact: true }).click();
  await page.getByRole("textbox", { name: "Card name or ID" }).fill(name);
  await page.getByRole("button", { name: "Search catalog" }).click();
}

async function queueMtg(page: Page) {
  await searchMtg(page);
  await page
    .getByRole("button", { name: "Review Fixture Mage, Fixture Set" })
    .click();
  await expect(page.locator(".toast[role=status]")).toContainText(
    "Fixture Mage is ready to review.",
  );
  await page.getByRole("button", { name: /^Review(?:\s*\d+)?$/ }).click();
}

async function importData(page: Page, value: unknown) {
  await page.getByLabel("Import JSON backup", { exact: true }).setInputFiles({
    name: "fixture-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test("review is explicit, duplicate confirmed cards merge, and data survives reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.screenshot({
    path: testInfo.outputPath("scan.png"),
    fullPage: true,
  });
  await queueMtg(page);
  await expect(
    page.getByRole("heading", { name: "Fixture Mage", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "Confirm & add to collection" })
    .click();
  await expect(page.getByText("All caught up.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await queueMtg(page);
  await page
    .getByRole("button", { name: "Confirm & add to collection" })
    .click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("1 collection entries", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".quantity-control > span")).toHaveText("3");
  await expect(page.getByText("$7.50", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(page.locator(".quantity-control > span")).toHaveText("3");
  await page.screenshot({
    path: testInfo.outputPath("collection.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Pokemon candidates load detail; Yu-Gi-Oh preserves printing warning and omits artwork", async ({
  page,
}) => {
  await open(page);
  await openDisclosure(page, "Find a card");
  await page
    .getByRole("textbox", { name: "Card name or ID" })
    .fill("Fixture Pikachu");
  await page.getByRole("button", { name: "Search catalog" }).click();
  await page.getByRole("button", { name: /^Review Fixture Pikachu,/ }).click();
  await page.getByRole("button", { name: /^Review(?:\s*\d+)?$/ }).click();
  await expect(
    page.getByText("Fixture Base Set · 58", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$1.25", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await openDisclosure(page, "Change game");
  await openDisclosure(page, "Find a card");
  await page.getByRole("button", { name: "Yu-Gi-Oh!", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Card name or ID" })
    .fill("Fixture Magician");
  await page.getByRole("button", { name: "Search catalog" }).click();
  await page.getByRole("button", { name: /^Review Fixture Magician,/ }).click();
  await page.getByRole("button", { name: /^Review(?:\s*\d+)?$/ }).click();
  const review = page
    .locator(".review-card")
    .filter({ hasText: "Fixture Magician" });
  await expect(
    review.getByText(/This catalog entry may cover several printings/),
  ).toBeVisible();
  await expect(review.locator("img")).toHaveCount(0);
});

test("empty search and network failure preserve a useful recovery path", async ({
  page,
}) => {
  await open(page);
  await openDisclosure(page, "Find a card");
  await page.getByRole("button", { name: "Search catalog" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter at least 2 characters",
  );
  await searchMtg(page, "Empty fixture");
  await expect(page.locator(".results-label")).toContainText("No cards found");
  await searchMtg(page, "Offline fixture");
  await expect(page.getByRole("alert")).toContainText("Could not connect");
  await expect(
    page.getByRole("button", { name: "Search catalog" }),
  ).toBeEnabled();
  await searchMtg(page);
  await expect(
    page.getByRole("button", { name: "Review Fixture Mage, Fixture Set" }),
  ).toBeVisible();
});

test("switching games cancels an old search without stale results", async ({
  page,
}) => {
  await open(page);
  await page.route("https://api.scryfall.com/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route
      .fulfill({ json: { data: [mtgResponse] } })
      .catch(() => undefined);
  });
  await searchMtg(page);
  await page.getByRole("button", { name: "Pokémon", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Card name or ID" })
    .fill("Fixture Pikachu");
  await page.getByRole("button", { name: "Search catalog" }).click();
  await expect(
    page.getByRole("button", { name: /^Review Fixture Pikachu,/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Review Fixture Mage,/ }),
  ).toHaveCount(0);
});

test("imports require confirmation, cancel cleanly, and are idempotent", async ({
  page,
}) => {
  await open(page);
  await importData(page, backup);
  await expect(
    page.getByRole("dialog", { name: "Import this backup?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("0 collection entries", { exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await importData(page, backup);
    await page
      .getByRole("button", { name: "Import backup", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(
    page.getByText("1 collection entries", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".quantity-control > span")).toHaveText("2");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  const path = await (await download).path();
  const exported = JSON.parse(await readFile(path!, "utf8"));
  expect(exported.collection).toEqual(backup.collection);
});

test("malformed, hostile and oversized backups are rejected before rendering external content", async ({
  page,
}) => {
  await open(page);
  await importData(page, {
    ...backup,
    collection: [
      {
        ...entry,
        card: { ...card, imageUrl: "https://untrusted.example/tracker.png" },
      },
    ],
  });
  await expect(page.locator(".toast[role=status]")).toContainText(
    "unsafe link",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await importData(page, {
    ...backup,
    collection: [
      {
        ...entry,
        card: {
          ...card,
          sourceUrl: "https://user:password@scryfall.com/card/tst/1",
        },
      },
    ],
  });
  await expect(page.locator(".toast[role=status]")).toContainText(
    "unsafe link",
  );
  await importData(page, { ...backup, collection: [entry, entry] });
  await expect(page.locator(".toast[role=status]")).toContainText(
    "duplicate entry IDs",
  );
  await page.getByLabel("Import JSON backup", { exact: true }).setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{broken"),
  });
  await expect(page.locator(".toast[role=status]")).toContainText(
    "not valid JSON",
  );
  await page.getByLabel("Import JSON backup", { exact: true }).setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(10_000_001, " "),
  });
  await expect(page.locator(".toast[role=status]")).toContainText(
    "smaller than 10 MB",
  );
});

test("aggregate import limits protect the persisted collection", async ({
  page,
}) => {
  await open(page);
  await importData(page, {
    ...backup,
    decks: [
      {
        id: "existing-deck",
        name: "Existing deck",
        game: "mtg",
        text: "1 Fixture Mage",
        updatedAt: stamp,
      },
    ],
  });
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  const manyDecks = Array.from({ length: 500 }, (_, i) => ({
    id: `new-${i}`,
    name: `Fixture ${i}`,
    game: "mtg",
    text: "1 Fixture Mage",
    updatedAt: stamp,
  }));
  await importData(page, {
    version: 1,
    collection: [],
    review: [],
    decks: manyDecks,
  });
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Import this backup?" })
      .getByRole("alert"),
  ).toContainText("too many entries");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("1 collection entries", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deck checker", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Existing deck Magic", exact: true }),
  ).toBeVisible();
});

test("deck ownership and missing export use collection quantities and survive reload", async ({
  page,
}, testInfo) => {
  await open(page);
  await importData(page, backup);
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  await page.getByRole("button", { name: "Deck checker", exact: true }).click();
  await page.getByLabel("Deck name", { exact: true }).fill("Fixture deck");
  await page
    .getByLabel("Cards", { exact: true })
    .fill("4 Fixture Mage\n1 Missing Fixture");
  await expect(
    page.getByRole("heading", { name: "2 of 5 cards owned" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save deck", exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export missing cards", exact: true })
    .click();
  const path = await (await download).path();
  expect(await readFile(path!, "utf8")).toBe(
    "2 Fixture Mage\n1 Missing Fixture",
  );
  await page.screenshot({
    path: testInfo.outputPath("deck.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Deck checker", exact: true }).click();
  await page
    .getByRole("button", { name: "Fixture deck Magic", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "2 of 5 cards owned" }),
  ).toBeVisible();
});

test("CSV escapes spreadsheet formulas and quotes from an imported backup", async ({
  page,
}) => {
  await open(page);
  await importData(page, {
    ...backup,
    collection: [
      {
        ...entry,
        card: { ...card, name: '=HYPERLINK("https://example.invalid")' },
        notes: "@SUM(1+1)",
      },
    ],
  });
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  const path = await (await download).path();
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
  expect(csv).toContain('"\'@SUM(1+1)"');
});

test("dialog is named and Escape restores focus; narrow screens do not overflow", async ({
  page,
}, testInfo) => {
  await open(page);
  await page
    .getByRole("button", { name: "Data and privacy", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your cards. Your data." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close dialog", exact: true })
    .press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Data and privacy", exact: true }),
  ).toBeFocused();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("mobile-scan.png"),
    fullPage: true,
  });
});

test("camera denial leaves photo upload and manual search available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Fixture denied", "NotAllowedError");
        },
      },
    });
  });
  await open(page);
  await page
    .getByText(
      "Assisted photo / text scan · for cards outside your local packs",
      { exact: true },
    )
    .click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Camera access was not allowed",
  );
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Search by name", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Card name or ID" }),
  ).toBeFocused();
});

test("another tab cannot silently overwrite a newer saved collection", async ({
  page,
  context,
}) => {
  await open(page);
  await importData(page, backup);
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  const other = await context.newPage();
  await open(other);
  await other.getByRole("button", { name: "Collection", exact: true }).click();
  await other
    .getByRole("button", {
      name: "Increase Fixture Mage quantity",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Another tab changed this collection",
  );
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Decrease Fixture Mage quantity",
      exact: true,
    })
    .click();
  await other.reload();
  await other.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(other.locator(".quantity-control > span")).toHaveText("3");
});

test("invalid review quantities cannot be confirmed and collection removal can be cancelled", async ({
  page,
}) => {
  await open(page);
  await queueMtg(page);
  for (const quantity of ["0", "-1", "1.5", "10000"]) {
    await page.getByLabel("Quantity", { exact: true }).fill(quantity);
    await expect(
      page.getByRole("button", { name: "Confirm & add to collection" }),
    ).toBeDisabled();
  }
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Confirm & add to collection" })
    .click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Remove this entry?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep card", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fixture Mage", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search collection", exact: true })
    .fill("Nothing matches");
  await expect(
    page.getByText("No cards match these filters.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove entry", exact: true }).click();
  await expect(
    page.getByText("0 collection entries", { exact: true }),
  ).toBeVisible();
});

test("long imported names wrap safely in collection, review and decks on a narrow screen", async ({
  page,
}, testInfo) => {
  await open(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const longCard = { ...card, name: "A".repeat(500), setName: "B".repeat(500) };
  await importData(page, {
    version: 1,
    collection: [{ ...entry, card: longCard }],
    review: [
      { id: "long-review", card: longCard, origin: "search", addedAt: stamp },
    ],
    decks: [
      {
        id: "long-deck",
        name: "C".repeat(200),
        game: "mtg",
        text: `1 ${longCard.name}`,
        updatedAt: stamp,
      },
    ],
  });
  await page
    .getByRole("button", { name: "Import backup", exact: true })
    .click();
  for (const name of ["Collection", /^Review(?:\s*\d+)?$/, "Deck checker"]) {
    await page
      .getByRole("button", { name, exact: typeof name === "string" })
      .click();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      overflowing: [...document.querySelectorAll("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            className: element.className,
            right: rect.right,
            left: rect.left,
          };
        })
        .filter(
          (element) => element.right > innerWidth + 1 || element.left < -1,
        )
        .slice(0, 15),
    }));
    expect
      .soft(layout.width, `${String(name)}: ${JSON.stringify(layout)}`)
      .toBeLessThanOrEqual(layout.viewport);
    await page.screenshot({
      path: testInfo.outputPath(
        `long-name-${String(name).replace(/[^a-z0-9]/gi, "-")}.png`,
      ),
      fullPage: true,
    });
  }
});
