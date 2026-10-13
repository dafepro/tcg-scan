import { test, expect, type Page } from "@playwright/test";
import { prepare } from "./guided-pack-fixture";
import { deterministicCamera } from "./guided-live-fixture";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  GuidedFixtureWindow,
  GuidedSavedRow,
} from "./guided-fixture-types";
const clip = fileURLToPath(
  new URL("./fixtures/continuous-two-copies.mp4", import.meta.url),
);
const pack = (page: Page) =>
  page.getByRole("region", { name: "Pack opening scanner" });
const live = (page: Page) =>
  page.getByRole("region", { name: "Continuous card scanner" });
const saved = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("tcg-scan:data:v1") || "{}").collection ||
      [],
  ) as Promise<GuidedSavedRow[]>;
async function wiring(
  page: Page,
  options: { holdOCR?: boolean; ocrText?: string } = {},
) {
  await page.addInitScript((options) => {
    const q: GuidedFixtureWindow["guidedQA"] = ((
      window as unknown as GuidedFixtureWindow
    ).guidedQA = {
      ocrReads: 0,
      guidanceAnnouncements: [],
      ocrReplies: [],
      terminated: 0,
      holdOCR: !!options.holdOCR,
      ocrText: options.ocrText ?? "SYNTHETIC UNREADABLE TEXT",
      release() {
        this.holdOCR = false;
        this.ocrReplies.splice(0).forEach((r) => r());
      },
    });
    const observed = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const e of document.querySelectorAll(
        '.sr-only[aria-live="polite"] span',
      )) {
        if (
          !observed.has(e) &&
          e.textContent?.includes("could separate the catalog matches")
        ) {
          observed.add(e);
          q.guidanceAnnouncements.push(e.textContent);
        }
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (window as unknown as GuidedFixtureWindow).makeGuidedCrop = (n: number) => {
      const c = document.createElement("canvas");
      c.width = 600;
      c.height = 840;
      const x = c.getContext("2d")!;
      x.fillStyle = "#bcbcbc";
      x.fillRect(0, 0, 600, 840);
      x.fillStyle = "#333";
      x.font = "40px monospace";
      x.fillText("025/198 " + n, 25, 790);
      return x.getImageData(0, 0, 600, 840);
    };
  }, options);
}
async function optIn(page: Page) {
  await pack(page)
    .locator("summary")
    .filter({ hasText: "Optional printed-text read" })
    .click();
  const check = pack(page).getByRole("checkbox", {
    name: "Read a retained native capture after saving (experimental)",
  });
  await expect(check).not.toBeChecked();
  await check.check();
}
async function catalog(page: Page, mode: "total" | "number") {
  const seen: { url: string; method: string; body: string | null }[] = [];
  await page.route("https://api.tcgdex.net/**", (route) => {
    const u = new URL(route.request().url());
    seen.push({
      url: u.href,
      method: route.request().method(),
      body: route.request().postData(),
    });
    let body: unknown;
    if (u.pathname === "/v2/en/cards")
      body = [
        { id: "sv01-025", localId: "025", name: "Pikachu" },
        {
          id: mode === "number" ? "sv02-026" : "sv02-025",
          localId: mode === "number" ? "026" : "025",
          name: "Pikachu",
        },
      ];
    else if (u.pathname === "/v2/en/sets")
      body = [
        { id: "sv01", name: "Synthetic one", cardCount: { official: 198 } },
        {
          id: "sv02",
          name: "Synthetic two",
          cardCount: { official: mode === "total" ? 200 : 198 },
        },
        { id: "A1", name: "Synthetic Pocket", cardCount: { official: 226 } },
      ];
    else if (u.pathname === "/v2/en/series/tcgp")
      body = { id: "tcgp", sets: [{ id: "A1" }] };
    else return route.abort();
    return route.fulfill({ json: body });
  });
  return seen;
}
for (const mode of ["total", "number"] as const)
  test(`live candidate-specific ${mode} prompt is once per event and cannot upgrade identity`, async ({
    page,
  }, info) => {
    await wiring(page);
    await deterministicCamera(page);
    const requests = await catalog(page, mode);
    await live(page)
      .getByRole("button", { name: "Start continuous camera" })
      .click();
    const expected =
      mode === "total" ? "number after the slash" : "collector number";
    await expect(page.locator(".scan-receipts")).toContainText(
      `Its ${expected} could separate the catalog matches.`,
      { timeout: 15000 },
    );
    await expect(
      live(page).locator('.sr-only[aria-live="polite"]'),
    ).toContainText(
      `Pikachu. Show the bottom identifier line closer once. Its ${expected} could separate the catalog matches.`,
    );
    await page.screenshot({
      path: info.outputPath(`live-${mode}-active-prompt.png`),
      fullPage: true,
    });
    await live(page)
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await live(page)
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    await expect(page.locator(".scan-receipts")).toContainText(
      "The requested view did not establish a separating identifier.",
      { timeout: 15000 },
    );
    await expect(page.locator(".scan-receipts")).not.toContainText(
      "could separate the catalog matches",
    );
    const count = await page.evaluate(
      () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
    );
    await page.waitForTimeout(1800);
    expect(
      await page.evaluate(
        () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
      ),
    ).toBe(count);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as GuidedFixtureWindow).guidedQA
            .guidanceAnnouncements.length,
      ),
    ).toBe(1);
    const collection = await saved(page);
    expect(collection).toHaveLength(1);
    expect(collection[0]).toMatchObject({
      quantity: 1,
      verification: "identity-only",
      condition: "Unknown",
      finish: "Unknown",
    });
    expect(collection[0].printingRead).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.method === "GET" && !r.body)).toBe(true);
    await page.screenshot({
      path: info.outputPath(`live-${mode}-prompt-budget.png`),
      fullPage: true,
    });
    await writeFile(
      info.outputPath("observations.json"),
      JSON.stringify(
        {
          label: "Deterministic model/OCR/catalog UI wiring only",
          collection,
          ocrReads: count,
          requests,
        },
        null,
        2,
      ),
    );
    await live(page)
      .getByRole("button", { name: "End session", exact: true })
      .click();
  });
test("Pack defaults off; opt-in one-capture evidence belongs to original receipt and never duplicate copies", async ({
  page,
}, info) => {
  await wiring(page, { ocrText: "025/198" });
  await prepare(page, { holdResults: false });
  await optIn(page);
  await pack(page).getByLabel("Scan local video").setInputFiles(clip);
  await expect(pack(page)).toContainText(
    "One retained capture read. Printing remains unconfirmed.",
    { timeout: 15000 },
  );
  const original = pack(page)
    .locator(".pack-receipt")
    .filter({ hasText: "One retained capture read." });
  await original
    .locator("summary")
    .filter({ hasText: /^Printing evidence$/ })
    .click();
  await original
    .locator("summary")
    .filter({ hasText: /^Read 1/ })
    .click();
  await expect(original).toContainText("025/198");
  await expect(original).toContainText("Another original capture is required");
  const id = await original.getAttribute("data-capture-id");
  await expect(original).toContainText(`Original capture: ${id}`);
  await original.screenshot({
    path: info.outputPath("pack-original-retained-evidence.png"),
  });
  await expect(pack(page).locator("p[role=status]").first()).toContainText(
    "Captured views processed.",
    { timeout: 15000 },
  );
  await original
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
    })
    .click();
  await expect.poll(async () => (await saved(page)).length).toBe(2);
  const rows = await saved(page);
  expect(
    rows.every(
      (r: GuidedSavedRow) =>
        r.quantity === 1 &&
        r.verification === "identity-only" &&
        !r.printingRead &&
        r.finish === "Unknown" &&
        r.condition === "Unknown",
    ),
  ).toBe(true);
  await pack(page)
    .getByRole("button", { name: /Show recent captured-view details/ })
    .click();
  expect(await pack(page).locator(".pack-printing-evidence").count()).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
    ),
  ).toBe(1);
  await page.screenshot({
    path: info.outputPath("pack-original-evidence-duplicate.png"),
    fullPage: true,
  });
  await writeFile(
    info.outputPath("observations.json"),
    JSON.stringify(
      {
        label:
          "Deterministic model/OCR UI wiring only; genuine video capture loop",
        originalCapture: id,
        rows,
        ocrReads: await page.evaluate(
          () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
        ),
      },
      null,
      2,
    ),
  );
});
for (const action of ["pause", "stop", "undo"] as const)
  test(`Pack ${action} cancels delayed OCR and blocks late receipt enrichment`, async ({
    page,
  }, info) => {
    await wiring(page, { holdOCR: true, ocrText: "025/198" });
    await prepare(page, { holdResults: false });
    await optIn(page);
    await pack(page).getByLabel("Scan local video").setInputFiles(clip);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
        ),
      )
      .toBe(1);
    await expect(pack(page)).toContainText(
      "Reading this saved receipt’s retained capture locally",
    );
    if (action === "pause")
      await pack(page).getByRole("button", { name: "Pause pack" }).click();
    else if (action === "stop")
      await pack(page)
        .getByRole("button", { name: "End session", exact: true })
        .click();
    else
      await pack(page)
        .getByRole("button", { name: "Undo latest copy", exact: true })
        .click();
    const before = await saved(page);
    await page.evaluate(() =>
      (window as unknown as GuidedFixtureWindow).guidedQA.release(),
    );
    await page.waitForTimeout(200);
    expect(await saved(page)).toEqual(before);
    expect(before.length).toBe(action === "undo" ? 0 : 1);
    expect(
      before.every(
        (r: GuidedSavedRow) =>
          !r.printingRead && r.verification === "identity-only",
      ),
    ).toBe(true);
    await expect(pack(page)).not.toContainText("One retained capture read.");
    await expect(pack(page).locator(".printing-evidence-details")).toHaveCount(
      0,
    );
    await page.screenshot({
      path: info.outputPath(`pack-${action}-late-ocr.png`),
      fullPage: true,
    });
  });
