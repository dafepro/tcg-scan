import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { deterministicCamera } from "./guided-live-fixture";
import type { GuidedFixtureWindow } from "./guided-fixture-types";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const windowFixture = window as unknown as GuidedFixtureWindow;
    windowFixture.makeGuidedCrop = (index: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 840;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#bcbcbc";
      context.fillRect(0, 0, 600, 840);
      context.fillStyle = "#333";
      context.font = "40px monospace";
      context.fillText(`025/198 ${index}`, 25, 790);
      return context.getImageData(0, 0, 600, 840);
    };
    windowFixture.guidedQA = {
      ocrReads: 0,
      guidanceAnnouncements: [],
      ocrReplies: [],
      terminated: 0,
      holdOCR: false,
      ocrText: "UNREADABLE TEST CROP",
      release() {},
    };
  });
});
import { openDisclosure, confirmSessionSwitch } from "./fixtures/disclosures";

// Control-flow tests with the existing synthetic matcher. These do not claim
// public-video recognition quality. Browser execution requires separate approval.
const clip = fileURLToPath(
  new URL("./fixtures/continuous-two-copies.mp4", import.meta.url),
);
const scanner = (page: Page) =>
  page.getByRole("region", { name: "Continuous card scanner" });
const receipts = (page: Page) => page.locator(".scan-receipts article");
const collection = (page: Page) =>
  page.evaluate(() => localStorage.getItem("tcg-scan:data:v1"));
async function choose(page: Page) {
  await openDisclosure(page, "Scan options");
  await openDisclosure(page, "Test video");
  await scanner(page)
    .getByLabel("Choose test video", { exact: true })
    .setInputFiles(clip);
}
async function previousSession(page: Page) {
  await deterministicCamera(page);
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(receipts(page)).toHaveCount(1);
  await scanner(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
}

test("Live test video pauses and resumes its source, then EOF releases it and keeps receipts", async ({
  page,
}) => {
  await deterministicCamera(page);
  await choose(page);
  await expect(receipts(page)).toHaveCount(1);
  const element = scanner(page).locator("video");
  const url = await element.evaluate((video: HTMLVideoElement) => video.src);
  await scanner(page)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  expect(
    await element.evaluate((video: HTMLVideoElement) => video.paused),
  ).toBe(true);
  const stoppedAt = await element.evaluate(
    (video: HTMLVideoElement) => video.currentTime,
  );
  await page.waitForTimeout(400);
  expect(
    await element.evaluate((video: HTMLVideoElement) => video.currentTime),
  ).toBe(stoppedAt);
  await scanner(page)
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect
    .poll(() =>
      element.evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeGreaterThan(stoppedAt);
  expect(await element.evaluate((video: HTMLVideoElement) => video.src)).toBe(
    url,
  );
  await element.evaluate((video: HTMLVideoElement) => {
    video.currentTime = video.duration - 0.1;
  });
  await expect(scanner(page)).toContainText("Test video ended.");
  await expect(element).not.toHaveAttribute("src");
  await expect(receipts(page)).toHaveCount(1);
  const saved = await collection(page);
  await page.waitForTimeout(500);
  expect(await collection(page)).toBe(saved);
});

for (const action of ["cancel", "hidden", "reject"] as const) {
  test(`Live file ${action} during playback preparation preserves the previous session`, async ({
    page,
  }) => {
    await previousSession(page);
    const saved = await collection(page);
    await page.evaluate((action) => {
      const original = HTMLMediaElement.prototype.play;
      const state = { waiting: false, release: () => {} };
      Object.assign(window, { liveFilePreparation: state });
      HTMLMediaElement.prototype.play = function () {
        if (!this.src.startsWith("blob:")) return original.call(this);
        if (action === "reject")
          return Promise.reject(new Error("Synthetic file playback denial"));
        state.waiting = true;
        return new Promise<void>((resolve) => {
          state.release = resolve;
        });
      };
    }, action);
    await choose(page);
    if (action !== "reject") {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  liveFilePreparation: { waiting: boolean };
                }
              ).liveFilePreparation.waiting,
          ),
        )
        .toBe(true);
      await expect(receipts(page)).toHaveCount(1);
      if (action === "cancel")
        await scanner(page)
          .getByRole("button", { name: "Cancel preparation", exact: true })
          .click();
      else
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
      await page.evaluate(() =>
        (
          window as unknown as {
            liveFilePreparation: { release(): void };
          }
        ).liveFilePreparation.release(),
      );
    }
    await expect(
      scanner(page).getByRole("button", { name: "Start continuous camera" }),
    ).toBeEnabled();
    await expect(scanner(page)).toContainText("1 saved this session");
    await expect(receipts(page)).toHaveCount(1);
    await expect(scanner(page).locator("video")).not.toHaveAttribute("src");
    expect(await collection(page)).toBe(saved);
  });
}

test("leaving Live file input ends its source through the normal navigation guard", async ({
  page,
}) => {
  await deterministicCamera(page);
  await choose(page);
  await expect(receipts(page)).toHaveCount(1);
  await page.evaluate(() => {
    const video =
      document.querySelector(".continuous-scanner video") ??
      document.querySelector("video");
    Object.assign(window, { previousLiveVideo: video });
  });
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await confirmSessionSwitch(page);
  expect(
    await page.evaluate(() => {
      const video = (
        window as unknown as { previousLiveVideo: HTMLVideoElement }
      ).previousLiveVideo;
      return { paused: video.paused, hasSource: video.hasAttribute("src") };
    }),
  ).toEqual({ paused: true, hasSource: false });
});

async function controlledPendingRead(page: Page) {
  await deterministicCamera(page);
  await page.route("https://api.tcgdex.net/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v2/en/cards")
      return route.fulfill({
        json: [
          { id: "sv01-025", localId: "025", name: "Pikachu" },
          { id: "sv02-026", localId: "026", name: "Pikachu" },
        ],
      });
    if (path === "/v2/en/sets")
      return route.fulfill({
        json: [
          { id: "sv01", name: "Synthetic one", cardCount: { official: 198 } },
          { id: "sv02", name: "Synthetic two", cardCount: { official: 198 } },
          { id: "A1", name: "Synthetic Pocket", cardCount: { official: 226 } },
        ],
      });
    if (path === "/v2/en/series/tcgp")
      return route.fulfill({ json: { id: "tcgp", sets: [{ id: "A1" }] } });
    return route.abort();
  });
  await page.evaluate(() => {
    const q = (window as unknown as GuidedFixtureWindow).guidedQA;
    q.holdOCR = true;
    q.release = () => {
      q.holdOCR = false;
      q.ocrReplies.splice(0).forEach((reply) => reply());
    };
  });
  await choose(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
      ),
    )
    .toBe(1);
  await scanner(page)
    .getByRole("button", { name: "Hold test input", exact: true })
    .click();
  await expect(
    scanner(page).getByRole("button", {
      name: "Resume test input",
      exact: true,
    }),
  ).toBeVisible();
}
const heldMetrics = (page: Page) =>
  page.evaluate(() => ({
    reads: (window as unknown as GuidedFixtureWindow).guidedQA.ocrReads,
    analyses: (window as unknown as { continuousFixture: { analyses: number } })
      .continuousFixture.analyses,
    time: document.querySelector("video")!.currentTime,
    paused: document.querySelector("video")!.paused,
  }));

test("Test input hold finishes its pending read and shows the actual prompt without repeated views", async ({
  page,
}) => {
  await controlledPendingRead(page);
  const held = await heldMetrics(page);
  expect(held.paused).toBe(true);
  const saved = await collection(page);
  await page.evaluate(() =>
    (window as unknown as GuidedFixtureWindow).guidedQA.release(),
  );
  await expect(page.locator(".scan-receipts")).toContainText(
    "collector number could separate the catalog matches",
  );
  await page.waitForTimeout(1800);
  expect(await heldMetrics(page)).toEqual(held);
  expect(await collection(page)).toBe(saved);
  await expect(
    scanner(page).getByRole("button", {
      name: "Resume test input",
      exact: true,
    }),
  ).toBeVisible();
  await scanner(page)
    .getByRole("button", { name: "Resume test input", exact: true })
    .click();
  await expect
    .poll(async () => (await heldMetrics(page)).time)
    .toBeGreaterThan(held.time);
  await expect
    .poll(async () => (await heldMetrics(page)).analyses)
    .toBeGreaterThan(held.analyses);
  await scanner(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
});

for (const action of ["Pause", "End session"] as const) {
  test(`${action} while test input is held cancels pending printing instead of preserving it`, async ({
    page,
  }) => {
    await controlledPendingRead(page);
    await scanner(page)
      .getByRole("button", { name: action, exact: true })
      .click();
    await expect(
      scanner(page).getByRole("button", {
        name: "Resume test input",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.evaluate(() =>
      (window as unknown as GuidedFixtureWindow).guidedQA.release(),
    );
    await page.waitForTimeout(500);
    await expect(page.locator(".scan-receipts")).not.toContainText(
      "could separate the catalog matches",
    );
    await expect(page.locator(".scan-receipts")).toContainText(
      "Printing read cancelled",
    );
    expect((await heldMetrics(page)).reads).toBe(1);
    await expect(receipts(page)).toHaveCount(1);
  });
}
