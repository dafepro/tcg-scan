import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

async function syntheticCard(page: Page): Promise<Buffer> {
  // Original test artwork, generated in the browser. No personal/card photo.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 980;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 700, 980);
    context.strokeStyle = "#222";
    context.lineWidth = 4;
    context.strokeRect(12, 12, 676, 956);
    context.fillStyle = "#111";
    context.font = "bold 66px Arial";
    context.fillText("Pikachu", 45, 120);
    context.font = "28px Arial";
    context.fillText("SYNTHETIC OCR TEST", 45, 850);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("photo validation rejects empty, unsupported, oversized and corrupt files", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByText(
      "Assisted photo / text scan · for cards outside your local packs",
      { exact: true },
    )
    .click();
  const input = page.getByLabel("Choose card photo", { exact: true });
  await input.setInputFiles({
    name: "empty.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("alert")).toContainText("This image is empty");
  await input.setInputFiles({
    name: "unsupported.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("fixture"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a JPG, PNG, or WebP",
  );
  await input.setInputFiles({
    name: "large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(15 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText(
    "This image is too large",
  );
  await input.setInputFiles({
    name: "corrupt.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "This image could not be opened",
  );
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeEnabled();
});

test("cancelling an initializing reader terminates it and another photo can be selected", async ({
  page,
}) => {
  // A deliberately stalled Worker fixture isolates lifecycle behavior from OCR.
  await page.addInitScript(() => {
    type MetricsWindow = Window & {
      workerMetrics: { created: number; terminated: number };
    };
    const target = window as unknown as MetricsWindow;
    target.workerMetrics = { created: 0, terminated: 0 };
    class StalledWorker {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      constructor() {
        target.workerMetrics.created += 1;
      }
      postMessage() {
        /* Intentionally never finishes initialization. */
      }
      terminate() {
        target.workerMetrics.terminated += 1;
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: StalledWorker,
    });
  });
  await page.route("https://**/*", (route) => route.abort());
  await page.goto("/");
  await page
    .getByText(
      "Assisted photo / text scan · for cards outside your local packs",
      { exact: true },
    )
    .click();
  const image = await syntheticCard(page);
  const input = page.getByLabel("Choose card photo", { exact: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await input.setInputFiles({
      name: "synthetic-card.png",
      mimeType: "image/png",
      buffer: image,
    });
    await expect(
      page.getByRole("button", { name: "Cancel scan", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { workerMetrics: { created: number } })
              .workerMetrics.created,
        ),
      )
      .toBe(attempt);
    await page
      .getByRole("button", { name: "Cancel scan", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel scan", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Upload photo", exact: true }),
    ).toBeEnabled();
    const metrics = await page.evaluate(
      () =>
        (
          window as unknown as {
            workerMetrics: { created: number; terminated: number };
          }
        ).workerMetrics,
    );
    expect(metrics).toEqual({ created: attempt, terminated: attempt });
    await expect(page.locator(".scanner-readout")).toHaveCount(0);
  }
});

test("real browser OCR reads a synthetic PNG, searches its title and requires match review @live-ocr", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RUN_LIVE_OCR !== "1" ||
      testInfo.project.name !== "desktop-chromium",
    "Opt-in real OCR integration: RUN_LIVE_OCR=1; one desktop run using the packaged same-origin model.",
  );
  test.setTimeout(150_000);
  const external: { url: string; method: string; body: string | null }[] = [];
  const modelRequests: { url: string; method: string; body: string | null }[] =
    [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/ocr/eng.traineddata.gz"))
      modelRequests.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
      });
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).hostname !== "127.0.0.1"
    )
      external.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
      });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The optional cache uses unmodified official model bytes, never fake OCR output.
  // Keep a substituted model distinct from testing the production model file in reports.
  if (process.env.OCR_MODEL_FIXTURE) {
    const model = await readFile(process.env.OCR_MODEL_FIXTURE);
    const gzip =
      model[0] === 0x1f && model[1] === 0x8b ? model : gzipSync(model);
    testInfo.annotations.push({
      type: "model-source",
      description:
        "Cached official eng model supplied by runner; this case does not establish packaged-model delivery.",
    });
    await page.route("**/ocr/eng.traineddata.gz", (route) =>
      route.fulfill({ contentType: "application/gzip", body: gzip }),
    );
  }
  // Model and local Tesseract worker are real. Catalog identity is a fixture.
  await page.route("https://api.tcgdex.net/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/base1-58")
        ? {
            id: "base1-58",
            name: "Pikachu",
            localId: "58",
            set: { id: "base1", name: "Synthetic Test Set" },
            rarity: "Test fixture",
          }
        : [{ id: "base1-58", name: "Pikachu", localId: "58" }],
    }),
  );
  await page.goto("/");
  await page
    .getByText(
      "Assisted photo / text scan · for cards outside your local packs",
      { exact: true },
    )
    .click();
  const image = await syntheticCard(page);
  await page.getByLabel("Choose card photo", { exact: true }).setInputFiles({
    name: "synthetic-card.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.locator(".scanner-readout")).toContainText("Title read", {
    timeout: 100_000,
  });
  await expect(page.locator(".scanner-name-options")).toContainText("Pikachu");
  await expect(
    page.getByRole("textbox", { name: "Card name or ID" }),
  ).toHaveValue("Pikachu");
  await page.screenshot({
    path: testInfo.outputPath("real-ocr-synthetic-result.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Review Pikachu,/ }).click();
  await page.getByRole("button", { name: /^Review(?:\s*\d+)?$/ }).click();
  await expect(page.getByText("SCAN CANDIDATE", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm & add to collection" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("0 collection entries", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(modelRequests.length).toBeGreaterThan(0);
  for (const request of modelRequests) {
    expect(new URL(request.url).origin).toBe(new URL(page.url()).origin);
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  }
  for (const request of external) {
    expect(new URL(request.url).hostname).toBe("api.tcgdex.net");
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  }
});
