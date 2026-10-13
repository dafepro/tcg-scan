import { confirmSessionSwitch } from "./fixtures/disclosures";
import { expect, test, type Page } from "@playwright/test";
import { originalInstallerArchive } from "./fixtures/installer-archive";
import { POKEMON_REFERENCE_RELEASE } from "../src/lib/pokemon-reference-release";
const api = "**/__tcg_scan/reference/pokemon/**";
async function fresh(page: Page) {
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(() => {
    const calls = { camera: 0, worker: 0 };
    Object.assign(window, { installerCalls: calls });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        calls.camera++;
        throw new Error("Installer must not open a camera");
      },
    });
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          calls.worker++;
          throw new Error("Installer must not initialize vision");
        }
      },
    });
  });
  await page.goto("/");
  const scan = page.getByRole("region", { name: "Continuous card scanner" });
  await expect(
    scan.getByRole("button", { name: "Install Pokémon database", exact: true }),
  ).toBeVisible();
  return scan;
}
async function noVision(page: Page) {
  expect(
    await page.evaluate(
      () => (window as unknown as { installerCalls: unknown }).installerCalls,
    ),
  ).toEqual({ camera: 0, worker: 0 });
}
test("fresh setup promotes one-click database installation without camera work", async ({
  page,
}) => {
  const scan = await fresh(page);
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeDisabled();
  await expect(
    scan.getByLabel("Multi-card photo", { exact: true }),
  ).toBeDisabled();
  await expect(scan.getByLabel("Install learned reference pack")).toBeHidden();
  await expect(scan).toContainText("358 MB download");
  await noVision(page);
});
test("a static host gives an actionable ZIP fallback without starting recognition", async ({
  page,
}) => {
  await page.route(api, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Static fallback</title>",
    }),
  );
  const scan = await fresh(page);
  await scan
    .getByRole("button", { name: "Install Pokémon database", exact: true })
    .click();
  await expect(
    scan.locator("#scanner-pack-manager").getByRole("status"),
  ).toContainText("This host does not provide the installer");
  await expect(
    scan.getByRole("button", { name: "Install Pokémon database", exact: true }),
  ).toBeEnabled();
  await scan
    .getByText("Use a downloaded reference ZIP", { exact: true })
    .click();
  await expect(scan.getByLabel("Install database from ZIP")).toBeVisible();
  await noVision(page);
});
test("fixture download cancellation awaits pause and permits an explicit retry", async ({
  page,
}) => {
  let starts = 0,
    cancels = 0;
  await page.route(api, (route) => {
    const action = route.request().url().split("/").at(-1);
    if (action === "start") starts++;
    if (action === "cancel") cancels++;
    return route.fulfill({
      status: action === "start" ? 202 : 200,
      contentType: "application/json",
      body: JSON.stringify({
        state:
          action === "cancel" ? "paused" : starts > 1 ? "error" : "downloading",
        downloadedBytes: 1024,
        totalBytes: POKEMON_REFERENCE_RELEASE.sizeBytes,
        ...(starts > 1 ? { error: "Explicit retry fixture reached." } : {}),
      }),
    });
  });
  const scan = await fresh(page),
    install = scan.getByRole("button", {
      name: "Install Pokémon database",
      exact: true,
    });
  await install.click();
  await expect(
    scan.getByRole("progressbar", { name: "Pokémon database download" }),
  ).toBeVisible();
  await scan.getByRole("button", { name: "Cancel installation" }).click();
  await expect(
    scan.locator("#scanner-pack-manager").getByRole("status"),
  ).toContainText("Installation cancelled");
  expect(cancels).toBe(1);
  await expect(install).toBeEnabled();
  await install.click();
  await expect(
    scan.locator("#scanner-pack-manager").getByRole("status"),
  ).toContainText("Explicit retry fixture reached");
  expect(starts).toBe(2);
  await noVision(page);
});
test("navigation aborts fixture installation and leaves the new scanner usable", async ({
  page,
}) => {
  let cancelled = false;
  await page.route(api, (route) => {
    const action = route.request().url().split("/").at(-1);
    if (action === "cancel") cancelled = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: action === "cancel" ? "paused" : "downloading",
        downloadedBytes: 1024,
        totalBytes: POKEMON_REFERENCE_RELEASE.sizeBytes,
      }),
    });
  });
  const scan = await fresh(page);
  await scan
    .getByRole("button", { name: "Install Pokémon database", exact: true })
    .click();
  await expect(scan.getByRole("progressbar")).toBeVisible();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await confirmSessionSwitch(page);
  await expect.poll(() => cancelled).toBe(true);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(
    scan.getByRole("button", { name: "Install Pokémon database", exact: true }),
  ).toBeEnabled();
  await noVision(page);
});
test("original tiny ZIP uses real native decompression and persistent IndexedDB", async ({
  page,
}) => {
  const scan = await fresh(page);
  await scan
    .getByText("Use a downloaded reference ZIP", { exact: true })
    .click();
  await scan.getByLabel("Install database from ZIP").setInputFiles({
    name: "original-installer-fixture.zip",
    mimeType: "application/zip",
    buffer: originalInstallerArchive(),
  });
  await expect(scan).toContainText("1 installed references");
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeEnabled();
  await page.reload();
  await expect(scan).toContainText("1 installed references");
  await expect(scan).toContainText("Original installer mechanics fixture");
  await noVision(page);
});
test("malformed ZIP cannot make references ready", async ({ page }) => {
  const scan = await fresh(page);
  await scan
    .getByText("Use a downloaded reference ZIP", { exact: true })
    .click();
  await scan.getByLabel("Install database from ZIP").setInputFiles({
    name: "bad.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("This is an original invalid fixture"),
  });
  await expect(
    scan.locator("#scanner-pack-manager").getByRole("status"),
  ).toContainText("Invalid learned-pack ZIP");
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeDisabled();
  await expect(scan).toContainText("0 installed references");
  await noVision(page);
});
