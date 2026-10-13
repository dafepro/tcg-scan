import { openDisclosure, openReadyPackManager } from "./fixtures/disclosures";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  attachNativeFrameDiagnosticsOnFailure,
  installNativeFrameDiagnostics,
} from "./fixtures/native-frame-diagnostics";

// UI/control-flow coverage only. The camera pixels and worker replies below are
// original fixtures; supplied timing values are not a recognition benchmark.
const preferencesKey = "tcg-scan:preferences:v1";
const collectionKey = "tcg-scan:data:v1";
const packPath = fileURLToPath(
  new URL("./fixtures/continuous-feature-pack.json", import.meta.url),
);
const consolePanel = (page: Page) =>
  page.getByRole("region", { name: "Options & debug", exact: true });
const trigger = (page: Page) =>
  page.getByRole("button", { name: "Options & debug", exact: true });
const scanner = (page: Page) =>
  page.getByRole("region", { name: "Continuous card scanner" });
const fixtureBackup = {
  version: 1,
  collection: [
    {
      id: "preferences-preserved-entry",
      card: {
        id: "base1-58",
        game: "pokemon",
        name: "Private fixture card",
        setName: "Fixture set",
        setCode: "base1",
        number: "58",
        rarity: "Common",
        sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-58",
        provider: "TCGdex",
        prices: [],
      },
      quantity: 2,
      condition: "Unknown",
      finish: "Unknown",
      addedAt: "2026-10-12T00:00:00.000Z",
      notes: "Private fixture note",
    },
  ],
  review: [],
  decks: [],
};

test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (route) => route.abort());
  await installNativeFrameDiagnostics(page);
});
test.afterEach(async ({ page, browser }, testInfo) => {
  await attachNativeFrameDiagnosticsOnFailure(page, browser, testInfo);
});

async function openConsole(page: Page) {
  if ((await trigger(page).getAttribute("aria-expanded")) !== "true")
    await trigger(page).click();
  await expect(consolePanel(page)).toBeVisible();
}
const field = (region: Locator, label: string) =>
  region
    .locator(".debug-fields > div")
    .filter({
      has: region.page().locator("dt", { hasText: new RegExp(`^${label}$`) }),
    })
    .locator("dd");
const storedCollection = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), collectionKey);

async function seedCollection(
  page: Page,
  preferences: string | null = null,
  blocked = false,
) {
  await page.addInitScript(
    ({ dataKey, prefsKey, data, raw, blocked }) => {
      if (!localStorage.getItem(dataKey))
        localStorage.setItem(dataKey, JSON.stringify(data));
      if (raw !== null && !localStorage.getItem(prefsKey))
        localStorage.setItem(prefsKey, raw);
      if (blocked) {
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key === prefsKey)
            throw new DOMException(
              "Fixture preference access blocked",
              "SecurityError",
            );
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key === prefsKey)
            throw new DOMException(
              "Fixture preference write blocked",
              "QuotaExceededError",
            );
          return set.call(this, key, value);
        };
      }
    },
    {
      dataKey: collectionKey,
      prefsKey: preferencesKey,
      data: fixtureBackup,
      raw: preferences,
      blocked,
    },
  );
}

async function fixtureCamera(page: Page) {
  await page.addInitScript(() => {
    const stats = {
      opened: 0,
      created: 0,
      terminated: 0,
      stopped: 0,
      analyses: 0,
    };
    Object.assign(window, { preferencesFixture: stats });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        stats.opened++;
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext("2d")!;
        let shade = 0;
        const paint = () => {
          context.fillStyle = `rgb(${shade++ % 255},80,90)`;
          context.fillRect(0, 0, 640, 480);
        };
        paint();
        const stream = canvas.captureStream(15),
          timer = setInterval(paint, 66);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stats.stopped++;
            clearInterval(timer);
            stop();
          };
        }
        return stream;
      },
    });
    const coverage = {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: ["Synthetic preferences worker"],
    };
    class PreferencesWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      constructor() {
        stats.created++;
      }
      postMessage(message: { id: number; type: string }) {
        if (message.type === "analyze") stats.analyses++;
        const result =
          message.type === "initialize"
            ? { engine: "Synthetic preferences worker", coverage }
            : message.type !== "analyze"
              ? coverage
              : {
                  width: 640,
                  height: 480,
                  coverage,
                  budgetExhausted: false,
                  detectionComplete: true,
                  timings: {
                    detectionMs: 8.1,
                    extractionMs: 8.1,
                    matchingMs: 7.3,
                    totalMs: 23.5,
                  },
                  detections: [
                    {
                      quad: [
                        { x: 100, y: 70 },
                        { x: 230, y: 70 },
                        { x: 230, y: 252 },
                        { x: 100, y: 252 },
                      ],
                      state: "verified",
                      reason: "Synthetic preferences fixture",
                      autoEligible: true,
                      quality: {
                        laplacianVariance: 100,
                        contrast: 40,
                        meanLuminance: 120,
                        saturatedFraction: 0,
                        sourceMinEdge: 130,
                        featureCount: 96,
                        issues: [],
                      },
                      candidates: [
                        {
                          key: "pokemon:preferences-fixture",
                          reference: {
                            key: "pokemon:preferences-fixture",
                            game: "pokemon",
                            name: "Synthetic preferences card",
                            identityKey: "fixture:preferences",
                          },
                          hashDistance: 0,
                          tentativeMatches: 60,
                          inliers: 55,
                          inlierRatio: 0.9,
                          interiorInliers: 30,
                          coverage: 0.7,
                          medianReprojectionError: 1,
                          cornerError: 0.01,
                          geometricallyVerified: true,
                        },
                      ],
                    },
                  ],
                };
        const callback = this.onmessage;
        setTimeout(
          () =>
            callback?.({ data: { id: message.id, result } } as MessageEvent),
          0,
        );
      }
      terminate() {
        stats.terminated++;
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: PreferencesWorker,
    });
  });
  await page.goto("/");
  await openDisclosure(page, "Compatibility import and other reference packs");
  await scanner(page)
    .getByLabel("Import feature packs")
    .setInputFiles(packPath);
  await expect(scanner(page)).toContainText("9 installed references");
}
const cameraStats = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          preferencesFixture: {
            opened: number;
            created: number;
            terminated: number;
            stopped: number;
            analyses: number;
          };
        }
      ).preferencesFixture,
  );

for (const [name, value, accent] of [
  ["Ember", "ember", "#ff9b54"],
  ["Cobalt", "cobalt", "#78aeff"],
  ["Violet", "violet", "#b9a0ff"],
] as const) {
  test(`${name} changes the rendered theme and persists across reload`, async ({
    page,
  }) => {
    await page.goto("/");
    await openConsole(page);
    await consolePanel(page).getByRole("radio", { name }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    expect(
      await page
        .locator("html")
        .evaluate((node) =>
          getComputedStyle(node).getPropertyValue("--accent").trim(),
        ),
    ).toBe(accent);
    await page.reload();
    await expect(consolePanel(page)).toBeVisible();
    await expect(consolePanel(page).getByRole("radio", { name })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  });
}

test("density, overlay and reduced-motion settings survive navigation and reload", async ({
  page,
}) => {
  await page.goto("/");
  await openConsole(page);
  await consolePanel(page).getByLabel("Layout density").selectOption("compact");
  await consolePanel(page)
    .getByLabel("Scanner overlay")
    .selectOption("detailed");
  await consolePanel(page)
    .getByRole("combobox", { name: "Motion", exact: true })
    .selectOption("reduced");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("html")).toHaveAttribute(
    "data-overlay-detail",
    "detailed",
  );
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  expect(
    await consolePanel(page).evaluate(
      (node) => getComputedStyle(node).animationName,
    ),
  ).toBe("none");
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(consolePanel(page)).toBeVisible();
  await page.reload();
  await expect(consolePanel(page).getByLabel("Layout density")).toHaveValue(
    "compact",
  );
  await expect(consolePanel(page).getByLabel("Scanner overlay")).toHaveValue(
    "detailed",
  );
  await expect(
    consolePanel(page).getByRole("combobox", { name: "Motion", exact: true }),
  ).toHaveValue("reduced");
});

test("keyboard opens the panel and Escape restores its trigger focus", async ({
  page,
}) => {
  await page.goto("/");
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(
    consolePanel(page).getByRole("heading", { name: "Options & debug" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(consolePanel(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(consolePanel(page)).toHaveCount(0);
});

test("floating options and diagnostics fit a 320px viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await openConsole(page);
  for (const section of ["Options", "Live diagnostics"]) {
    await consolePanel(page)
      .getByRole("button", { name: section, exact: true })
      .click();
    const box = await consolePanel(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await consolePanel(page).evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `preferences-${section.replaceAll(" ", "-")}-320.png`,
      ),
    });
  }
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await expect(trigger(page)).toBeVisible();
});

test("malformed preferences use safe defaults without changing the collection", async ({
  page,
}) => {
  await seedCollection(page, "{malformed fixture");
  await page.goto("/");
  const before = await storedCollection(page);
  expect(before.collection).toEqual(fixtureBackup.collection);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  // Opening the panel is itself a valid preference edit and can repair storage.
  await openConsole(page);
  await consolePanel(page).getByRole("radio", { name: "Violet" }).check();
  expect(await storedCollection(page)).toEqual(before);
  await page.reload();
  expect(await storedCollection(page)).toEqual(before);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "violet");
});

test("blocked preference storage remains usable and cannot erase collection data", async ({
  page,
}) => {
  await seedCollection(page, null, true);
  await page.goto("/");
  const before = await storedCollection(page);
  await openConsole(page);
  await expect(consolePanel(page)).toContainText(
    "Choices apply for this visit only",
  );
  await consolePanel(page).getByRole("radio", { name: "Cobalt" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cobalt");
  expect(await storedCollection(page)).toEqual(before);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  expect(await storedCollection(page)).toEqual(before);
});

test("scanner game, workflow, mode and save choices persist through their UI", async ({
  page,
}) => {
  await page.goto("/");
  await openDisclosure(page, "Change game");
  await page.getByRole("button", { name: "Magic", exact: true }).click();
  await openDisclosure(page, "Scan options");
  await scanner(page).getByLabel("Session mode").selectOption("binder");
  await scanner(page).getByLabel("Save policy").selectOption("strict");
  await scanner(page).getByLabel("Auto-save strong matches").uncheck();
  await page.getByRole("button", { name: "Pack opening", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Pack opening scanner" }),
  ).toBeVisible();
  await openDisclosure(page, "Change game");
  await expect(
    page.getByRole("button", { name: "Magic", exact: true }),
  ).toHaveClass(/selected/);
  await page
    .getByRole("button", { name: "Live cards / binder", exact: true })
    .click();
  await openDisclosure(page, "Scan options");
  await expect(scanner(page).getByLabel("Session mode")).toHaveValue("binder");
  await expect(scanner(page).getByLabel("Save policy")).toHaveValue("strict");
  await expect(
    scanner(page).getByLabel("Auto-save strong matches"),
  ).not.toBeChecked();
});

test("appearance changes preserve the running camera, counted event and session", async ({
  page,
}) => {
  await fixtureCamera(page);
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(page.locator(".scan-receipts article")).toHaveCount(1);
  const before = await storedCollection(page),
    stats = await cameraStats(page);
  await openConsole(page);
  for (const name of ["Cobalt", "Violet", "Ember"])
    await consolePanel(page).getByRole("radio", { name }).check();
  await consolePanel(page).getByLabel("Layout density").selectOption("compact");
  await consolePanel(page)
    .getByRole("combobox", { name: "Motion", exact: true })
    .selectOption("reduced");
  await consolePanel(page)
    .getByLabel("Scanner overlay")
    .selectOption("detailed");
  await expect(scanner(page).locator(".track-badge-word")).toBeVisible();
  await consolePanel(page)
    .getByLabel("Scanner overlay")
    .selectOption("minimal");
  await expect(scanner(page).locator(".track-badge-word")).toBeHidden();
  await expect
    .poll(async () => (await cameraStats(page)).analyses)
    .toBeGreaterThan(stats.analyses);
  expect(await cameraStats(page)).toMatchObject({
    opened: 1,
    created: 1,
    stopped: 0,
    terminated: 0,
  });
  expect(await storedCollection(page)).toEqual(before);
  await expect(scanner(page)).toContainText("1 saved this session");
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: /^(Stop|End session)$/ })
    .click();
  await expect.poll(async () => (await cameraStats(page)).stopped).toBe(1);
  await expect.poll(async () => (await cameraStats(page)).terminated).toBe(1);
});

test("diagnostics display observed fixture values, omit unmeasured timings and clear safely", async ({
  page,
}) => {
  await seedCollection(page);
  await fixtureCamera(page);
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  const live = page.getByRole("region", {
    name: "live diagnostics",
    exact: true,
  });
  await expect(field(live, "Last frame")).toHaveCount(0);
  await expect(field(live, "Matching")).toHaveCount(0);
  await expect(consolePanel(page)).toContainText(
    "Missing values have not been measured",
  );
  await expect(consolePanel(page)).not.toContainText("Private fixture card");
  await expect(consolePanel(page)).not.toContainText("Private fixture note");
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(page.locator(".scan-receipts article")).toHaveCount(1);
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  await expect(field(live, "Last frame")).toHaveText("23.5 ms");
  await expect(field(live, "Matching")).toHaveText("7.3 ms");
  await expect(field(live, "Saved")).toHaveText("1");
  await expect(field(live, "Camera active")).toHaveText("Yes");
  await expect(consolePanel(page)).not.toContainText(
    "Synthetic preferences card",
  );
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  await expect(field(live, "Paused")).toHaveText("Yes");
  const before = await storedCollection(page);
  await consolePanel(page)
    .getByRole("button", { name: "Clear events" })
    .click();
  await expect(consolePanel(page)).toContainText("No events in this session");
  await expect(consolePanel(page)).toContainText(
    "Diagnostic events cleared. Your collection is unchanged",
  );
  expect(await storedCollection(page)).toEqual(before);
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: /^(Stop|End session)$/ })
    .click();
});

test("new source preparation clears measured dimensions and timings while keeping collection", async ({
  page,
}) => {
  await fixtureCamera(page);
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  const live = page.getByRole("region", {
    name: "live diagnostics",
    exact: true,
  });
  await expect(field(live, "Analyzed width")).toHaveCount(0);
  await expect(field(live, "Analyzed height")).toHaveCount(0);
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(page.locator(".scan-receipts article")).toHaveCount(1);
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  await expect(field(live, "Analyzed width")).toHaveText("640");
  await expect(field(live, "Analyzed height")).toHaveText("480");
  await expect(field(live, "Last frame")).toHaveText("23.5 ms");
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
  const before = await storedCollection(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => new Promise<MediaStream>(() => {}),
    });
  });
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await openConsole(page);
  await consolePanel(page)
    .getByRole("button", { name: "Live diagnostics" })
    .click();
  for (const name of [
    "Analyzed width",
    "Analyzed height",
    "Last frame",
    "Matching",
  ])
    await expect(field(live, name)).toHaveCount(0);
  await expect(field(live, "Preparing")).toHaveText("Yes");
  expect(await storedCollection(page)).toEqual(before);
  await consolePanel(page)
    .getByRole("button", { name: "Close options and debug" })
    .click();
  await scanner(page)
    .getByRole("button", { name: "Cancel preparation", exact: true })
    .click();
  expect(await storedCollection(page)).toEqual(before);
});

test("ready Live controls and collapsed setup are inspectable at phone sizes", async ({
  page,
}, testInfo) => {
  await fixtureCamera(page);
  const toggle = await openReadyPackManager(page);
  await toggle.click();
  await page.locator("summary").filter({ hasText: "Scan options" }).click();
  await expect(scanner(page).locator(".scanner-ready-chip")).toHaveText(
    "Ready · Pokémon",
  );
  const geometry = [];
  for (const [width, height] of [
    [320, 640],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(
      scanner(page).getByRole("button", { name: "Start continuous camera" }),
    ).toBeEnabled();
    geometry.push(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        preview: document
          .querySelector(".live-stage")
          ?.getBoundingClientRect()
          .toJSON(),
      })),
    );
    await page.screenshot({
      path: testInfo.outputPath(`ready-live-${width}.png`),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await testInfo.attach("ready-live-layout", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  expect(await cameraStats(page)).toMatchObject({ opened: 0, created: 0 });
});
