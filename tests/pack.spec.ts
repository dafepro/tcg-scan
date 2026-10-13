import { confirmSessionSwitch } from "./fixtures/disclosures";
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { originalInstallerArchive } from "./fixtures/installer-archive";
import {
  attachNativeFrameDiagnosticsOnFailure,
  installNativeFrameDiagnostics,
} from "./fixtures/native-frame-diagnostics";

test.beforeEach(async ({ page }) => installNativeFrameDiagnostics(page));
test.afterEach(async ({ page, browser }, testInfo) => {
  await attachNativeFrameDiagnosticsOnFailure(page, browser, testInfo);
});

/** Control-flow tests only. The original five-second geometric clip is decoded by
 * the browser and captured by production VideoFrame/rVFC code. Only model results
 * are explicitly mocked; these tests make no card-recognition accuracy claim. */
const fixtureClip = fileURLToPath(
  new URL("./fixtures/continuous-two-copies.mp4", import.meta.url),
);
const scan = (page: Page) =>
  page.getByRole("region", { name: "Pack opening scanner" });
interface PackFixture {
  analyses: number;
  terminated: number;
  transferredBytes: number;
  holdResults: boolean;
  holdNextPlay: boolean;
  storageFailure: boolean;
  hidden: boolean;
  attemptedEventIds: string[];
  replies: (() => void)[];
  plays: (() => void)[];
  releaseResults(): void;
  releasePlay(): void;
  setHidden(value: boolean): void;
}
type FixtureWindow = Window & { packFixture: PackFixture };

async function prepare(
  page: Page,
  options: { holdResults?: boolean; storageFailure?: boolean } = {},
) {
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(({ holdResults = true, storageFailure = false }) => {
    const state: PackFixture = {
      analyses: 0,
      terminated: 0,
      transferredBytes: 0,
      holdResults,
      holdNextPlay: false,
      storageFailure,
      hidden: false,
      attemptedEventIds: [],
      replies: [],
      plays: [],
      releaseResults() {
        this.holdResults = false;
        this.replies.splice(0).forEach((reply) => reply());
      },
      releasePlay() {
        this.plays.splice(0).forEach((resolve) => resolve());
      },
      setHidden(value) {
        this.hidden = value;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };
    Object.assign(window, { packFixture: state });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state.hidden,
    });
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const native = nativePlay.call(this);
      if (!state.holdNextPlay) return native;
      state.holdNextPlay = false;
      // Delay only JS settlement, after real native playback has started.
      return native.then(
        () => new Promise<void>((resolve) => state.plays.push(resolve)),
      );
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "tcg-scan:data:v1") {
        const collection = JSON.parse(value).collection as {
          scanEventId?: string;
        }[];
        for (const entry of collection ?? []) {
          if (entry.scanEventId)
            state.attemptedEventIds.push(entry.scanEventId);
        }
        if (state.storageFailure && collection?.length)
          throw new DOMException(
            "Synthetic quota failure",
            "QuotaExceededError",
          );
      }
      return setItem.call(this, key, value);
    };
    const coverage = {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: ["Synthetic pack lifecycle fixture"],
    };
    type Request = {
      id: number;
      type: string;
      image?: { width: number; height: number; data: Uint8ClampedArray };
      options?: { mode?: string };
    };
    class FixtureWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(input: Request, transfers: Transferable[] = []) {
        // Exercise actual ownership transfer/detachment, including the returned
        // pool buffer, rather than letting the mock retain caller aliases.
        const request = structuredClone(input, { transfer: transfers });
        const callback = this.onmessage;
        if (request.type !== "analyze") {
          setTimeout(
            () =>
              callback?.({
                data: {
                  id: request.id,
                  result:
                    request.type === "initialize"
                      ? { engine: "Synthetic pack lifecycle fixture", coverage }
                      : coverage,
                },
              } as MessageEvent),
            0,
          );
          return;
        }
        if (request.options?.mode !== "pack" || !request.image)
          throw new Error(
            "The synthetic pack fixture received a non-pack frame",
          );
        const { width, height, data } = request.image;
        state.analyses++;
        state.transferredBytes += data.byteLength;
        const result = {
          width,
          height,
          detections: [
            {
              quad: [
                { x: width * 0.2, y: height * 0.1 },
                { x: width * 0.6, y: height * 0.1 },
                { x: width * 0.6, y: height * 0.9 },
                { x: width * 0.2, y: height * 0.9 },
              ],
              state: "verified",
              reason: "Synthetic control-flow evidence only",
              autoEligible: true,
              quality: {
                laplacianVariance: 100,
                contrast: 40,
                meanLuminance: 120,
                saturatedFraction: 0,
                sourceMinEdge: 240,
                featureCount: 96,
                issues: [],
              },
              candidates: [
                {
                  key: "pokemon:installer-fixture",
                  reference: {
                    key: "pokemon:installer-fixture",
                    game: "pokemon",
                    name: "Synthetic pack lifecycle card",
                    identityKey: "fixture:pack-one",
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
          timings: {
            detectionMs: 1,
            extractionMs: 1,
            matchingMs: 1,
            totalMs: 3,
          },
          coverage,
          budgetExhausted: false,
          detectionComplete: true,
        };
        const reply = () => {
          const frameBuffer = data.buffer as ArrayBuffer;
          const response = structuredClone(
            { id: request.id, result, frameBuffer },
            { transfer: [frameBuffer] },
          );
          // Deliberately permit late delivery after terminate: production client
          // generation/disposal guards must reject the captured callback.
          callback?.({ data: response } as MessageEvent);
        };
        if (state.holdResults) state.replies.push(reply);
        else setTimeout(reply, 0);
      }
      terminate() {
        state.terminated++;
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: FixtureWorker,
    });
  }, options);
  await page.goto("/");
  const live = page.getByRole("region", { name: "Continuous card scanner" });
  await live
    .getByText("Use a downloaded reference ZIP", { exact: true })
    .click();
  await live.getByLabel("Install database from ZIP").setInputFiles({
    name: "original-pack-lifecycle-fixture.zip",
    mimeType: "application/zip",
    buffer: originalInstallerArchive(),
  });
  await expect(live).toContainText("1 installed references");
  await page.getByRole("button", { name: "Pack opening", exact: true }).click();
  await expect(scan(page)).toContainText("1 learned references available");
}
async function startVideo(page: Page, expectedAnalyses = 1) {
  await scan(page).locator('input[type="file"]').setInputFiles(fixtureClip);
  await expect(
    scan(page).getByRole("button", { name: "Pause pack" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await metrics(page)).analyses)
    .toBeGreaterThanOrEqual(expectedAnalyses);
}
const metrics = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as FixtureWindow).packFixture;
    return {
      analyses: s.analyses,
      terminated: s.terminated,
      transferredBytes: s.transferredBytes,
      pendingResults: s.replies.length,
      pendingPlays: s.plays.length,
      attemptedEventIds: s.attemptedEventIds,
    };
  });
const collection = (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("tcg-scan:data:v1") ?? "{}")
        .collection ?? []) as {
        scanEventId: string;
        quantity: number;
        verification: string;
      }[],
  );
const releaseResults = (page: Page) =>
  page.evaluate(async () => {
    (window as unknown as FixtureWindow).packFixture.releaseResults();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
const settleCallbacks = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
async function deferredResume(page: Page) {
  await scan(page).getByRole("button", { name: "Pause pack" }).click();
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).packFixture.holdNextPlay = true;
  });
  await scan(page).getByRole("button", { name: "Resume pack" }).click();
  await expect.poll(async () => (await metrics(page)).pendingPlays).toBe(1);
}

async function openTerminalDiagnostics(page: Page) {
  await page
    .getByRole("button", { name: "Options & debug", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Live diagnostics", exact: true })
    .click();
}

async function terminalDiagnostics(page: Page, processed: number) {
  // Open the panel before the terminal action, then read the final snapshot
  // once, without adding a second wait or UI interaction for the 250ms timer.
  const values = await page
    .getByRole("region", { name: "pack diagnostics", exact: true })
    .evaluate((region) =>
      Object.fromEntries(
        [...region.querySelectorAll(".debug-fields > div")].map((row) => [
          row.querySelector("dt")?.textContent,
          row.querySelector("dd")?.textContent,
        ]),
      ),
    );
  expect(values).toMatchObject({
    Pending: "0",
    Queue: "0",
    Bytes: "0",
    "Camera active": "No",
    State: "stopped",
  });
  expect(Number(values.Processed?.replaceAll(",", ""))).toBe(processed);
  expect(Number(values.Captured?.replaceAll(",", ""))).toBeGreaterThanOrEqual(
    Math.max(1, processed),
  );
  await page
    .getByRole("button", { name: "Close options and debug", exact: true })
    .click();
}

test("pack natural end drains real captured frames and saves one durable identity", async ({
  page,
}) => {
  await prepare(page);
  await startVideo(page);
  await expect(scan(page).locator(".pack-preview-state")).toContainText(
    "Processing captured views",
    { timeout: 10_000 },
  );
  expect(await collection(page)).toHaveLength(0);
  await openTerminalDiagnostics(page);
  await releaseResults(page);
  await expect(scan(page)).toContainText("Captured views processed");
  await terminalDiagnostics(page, (await metrics(page)).analyses);
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect((await metrics(page)).transferredBytes).toBeGreaterThan(0);
  expect((await metrics(page)).analyses).toBeGreaterThan(1);
  expect(await collection(page)).toMatchObject([
    { quantity: 1, verification: "identity-only" },
  ]);
  await expect(
    scan(page).locator("canvas, .track-label, .scan-overlay"),
  ).toHaveCount(0);
  await page.reload();
  expect(await collection(page)).toHaveLength(1);
});

for (const visibility of ["hidden", "hide-then-show"] as const) {
  test(`a deferred pack Resume stays paused after ${visibility}`, async ({
    page,
  }) => {
    await prepare(page);
    await startVideo(page);
    await deferredResume(page);
    await releaseResults(page); // The completed result is held by the paused loop.
    await page.evaluate((showAgain) => {
      const state = (window as unknown as FixtureWindow).packFixture;
      state.setHidden(true);
      if (showAgain) state.setHidden(false);
      state.releasePlay();
    }, visibility === "hide-then-show");
    await settleCallbacks(page);
    await expect(
      scan(page).getByRole("button", { name: "Resume pack" }),
    ).toBeVisible();
    await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
      "0 saved this session",
    );
    expect(await collection(page)).toHaveLength(0);
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).packFixture.setHidden(false),
    );
    await scan(page).getByRole("button", { name: "Resume pack" }).click();
    await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
      "1 saved this session",
    );
    await scan(page)
      .getByRole("button", { name: "End session", exact: true })
      .click();
  });
}

test("Stop cancels a deferred pack Resume and late worker completion", async ({
  page,
}) => {
  await prepare(page);
  await startVideo(page);
  await deferredResume(page);
  await scan(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).packFixture;
    state.releasePlay();
    state.releaseResults();
  });
  await settleCallbacks(page);
  await expect(
    scan(page).getByRole("button", { name: "Start pack camera" }),
  ).toBeEnabled();
  await expect(scan(page).locator(".pack-error")).toHaveCount(0);
  expect(await collection(page)).toHaveLength(0);
  expect((await metrics(page)).terminated).toBe(1);
  await expect(scan(page).locator(".pack-capture-status")).toContainText(
    "0 queued · 0 identifying",
  );
});

test("an old deferred Resume cannot resume or save into a replacement pack", async ({
  page,
}) => {
  await prepare(page);
  await startVideo(page);
  await deferredResume(page);
  await scan(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await startVideo(page, 2);
  await scan(page).getByRole("button", { name: "Pause pack" }).click();
  await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).packFixture;
    state.releaseResults();
    state.releasePlay();
  });
  await settleCallbacks(page);
  await expect(
    scan(page).getByRole("button", { name: "Resume pack" }),
  ).toBeVisible();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "0 saved this session",
  );
  await expect(scan(page).locator(".pack-error")).toHaveCount(0);
  expect(await collection(page)).toHaveLength(0);
  await scan(page).getByRole("button", { name: "Resume pack" }).click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect(await collection(page)).toHaveLength(1);
  await scan(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
});

test("a failed pack save retries its same durable event after drain and Undo survives reload", async ({
  page,
}) => {
  await prepare(page, { holdResults: false, storageFailure: true });
  await startVideo(page);
  await expect(scan(page)).toContainText("Scan was not saved");
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "0 saved this session",
  );
  expect(await collection(page)).toHaveLength(0);
  const failedId = (await metrics(page)).attemptedEventIds[0];
  expect(failedId).toBeTruthy();
  await expect(scan(page)).toContainText("Captured views processed", {
    timeout: 10_000,
  });
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).packFixture.storageFailure = false;
  });
  await scan(page).getByRole("button", { name: "Retry save" }).click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    failedId,
  ]);
  expect(new Set((await metrics(page)).attemptedEventIds)).toEqual(
    new Set([failedId]),
  );
  await expect(scan(page).locator(".pack-error")).toHaveCount(0);
  await scan(page)
    .getByRole("button", { name: "Undo latest copy", exact: true })
    .click();
  await expect(scan(page).locator(".receipt-state.undone")).toHaveText(
    "Undone",
  );
  expect(await collection(page)).toHaveLength(0);
  await page.reload();
  expect(await collection(page)).toHaveLength(0);
});

test("explicit Stop cancels a draining queue instead of saving its late result", async ({
  page,
}) => {
  await prepare(page);
  await startVideo(page);
  await scan(page).getByRole("button", { name: "Finish capture" }).click();
  await expect(scan(page).locator(".pack-preview-state")).toContainText(
    "Processing captured views",
  );
  await openTerminalDiagnostics(page);
  // The debug panel is nonmodal; the session control remains keyboard usable.
  await scan(page)
    .getByRole("button", { name: "End session", exact: true })
    .press("Enter");
  await terminalDiagnostics(page, 0);
  await releaseResults(page);
  await expect(scan(page).locator(".pack-capture-status")).toContainText(
    "0 queued · 0 identifying",
  );
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "0 saved this session",
  );
  expect(await collection(page)).toHaveLength(0);
  await expect(
    scan(page).getByRole("button", { name: "Start pack camera" }),
  ).toBeEnabled();
});

test("changing workflows cancels pack pixels and rejects the previous worker callback", async ({
  page,
}) => {
  await prepare(page);
  await startVideo(page);
  await page
    .getByRole("button", { name: "Live cards / binder", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "End this scanning session and switch?",
  });
  await expect(dialog).toBeVisible();
  expect((await metrics(page)).terminated).toBe(0);
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(scan(page)).toBeVisible();
  expect((await metrics(page)).terminated).toBe(0);
  await page
    .getByRole("button", { name: "Live cards / binder", exact: true })
    .click();
  await confirmSessionSwitch(page);
  await releaseResults(page);
  expect(await collection(page)).toHaveLength(0);
  expect((await metrics(page)).terminated).toBe(1);
  await expect(
    page.getByRole("region", { name: "Continuous card scanner" }),
  ).toBeVisible();
});

async function savedPack(page: Page) {
  await prepare(page, { holdResults: false });
  await startVideo(page);
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  await scan(page)
    .getByRole("button", { name: "Finish capture", exact: true })
    .click();
  await expect(scan(page)).toContainText("Captured views processed");
  expect(await collection(page)).toHaveLength(1);
}

test("Pack explicit copies use separate durable events and Undo reverses only the latest copy", async ({
  page,
}) => {
  await savedPack(page);
  const original = (await collection(page))[0].scanEventId;
  await scan(page)
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
      exact: true,
    })
    .click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "2 saved this session",
  );
  const two = await collection(page);
  expect(two).toHaveLength(2);
  expect(
    two.every(
      (entry) => entry.quantity === 1 && entry.verification === "identity-only",
    ),
  ).toBe(true);
  const firstExtra = two.find(
    (entry) => entry.scanEventId !== original,
  )!.scanEventId;
  expect(firstExtra).toBeTruthy();
  await expect(
    scan(page).locator('.pack-receipt[data-status="saved"]'),
  ).toHaveCount(1);
  await expect(
    scan(page).locator('.pack-receipt[data-status="saved"] .session-quantity'),
  ).toHaveText("× 2");
  await expect(
    scan(page).locator('.pack-receipt[data-status="saved"]'),
  ).toHaveAttribute("data-quantity-origin", "user-confirmed");
  await scan(page)
    .getByRole("button", { name: "Undo latest copy", exact: true })
    .click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    original,
  ]);
  await releaseResults(page); // A late repeat cannot restore the undone copy.
  expect(await collection(page)).toHaveLength(1);
  await scan(page)
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
      exact: true,
    })
    .click();
  const next = await collection(page),
    secondExtra = next.find(
      (entry) => entry.scanEventId !== original,
    )!.scanEventId;
  expect(next).toHaveLength(2);
  expect(secondExtra).not.toBe(firstExtra);
  await page.reload();
  expect(
    (await collection(page)).map((entry) => entry.scanEventId).sort(),
  ).toEqual([original, secondExtra].sort());
});

test("a failed explicit copy retries one event without rearming repeated frames", async ({
  page,
}) => {
  await savedPack(page);
  const original = (await collection(page))[0].scanEventId;
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).packFixture.storageFailure = true;
  });
  await scan(page)
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
      exact: true,
    })
    .click();
  await expect(
    scan(page).locator('.pack-receipt[data-status="error"]'),
  ).toContainText("Scan was not saved");
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    original,
  ]);
  const failed = [...new Set((await metrics(page)).attemptedEventIds)].filter(
    (id) => id !== original,
  );
  expect(failed).toHaveLength(1);
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).packFixture.storageFailure = false;
  });
  await scan(page)
    .getByRole("button", { name: "Retry save", exact: true })
    .click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "2 saved this session",
  );
  expect(
    (await collection(page)).map((entry) => entry.scanEventId).sort(),
  ).toEqual([original, failed[0]].sort());
  // One failed write, then the durable commit and the existing React
  // persistence effect write the same successful snapshot. These are writes,
  // not quantity increments; the exact two-event collection is asserted above.
  expect(
    (await metrics(page)).attemptedEventIds.filter((id) => id === failed[0]),
  ).toHaveLength(3);
  await releaseResults(page);
  expect(await collection(page)).toHaveLength(2);
  await scan(page)
    .getByRole("button", { name: "Undo latest copy", exact: true })
    .click();
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    original,
  ]);
});

test("invalid replacement video preserves the completed Pack subtotal and receipts", async ({
  page,
}) => {
  await savedPack(page);
  const before = await collection(page);
  await scan(page)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "invalid.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Original invalid fixture"),
    });
  await expect(scan(page).locator(".pack-error")).toContainText(
    "Choose a nonempty MP4 or WebM",
  );
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  await expect(
    scan(page).locator('.pack-receipt[data-status="saved"]'),
  ).toHaveCount(1);
  expect(await collection(page)).toEqual(before);
});

test("denied Pack camera preparation preserves a completed video session", async ({
  page,
}) => {
  await savedPack(page);
  const before = await collection(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException(
          "Synthetic pack restart denied",
          "NotAllowedError",
        );
      },
    });
  });
  await scan(page)
    .getByRole("button", { name: "Start pack camera", exact: true })
    .click();
  await expect(scan(page).locator(".pack-error")).toBeVisible();
  await expect(
    scan(page).getByRole("button", { name: "Start pack camera", exact: true }),
  ).toBeEnabled();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect(await collection(page)).toEqual(before);
});

test("detailed Pack receipts undo the selected copy rather than the latest copy", async ({
  page,
}) => {
  await savedPack(page);
  const original = (await collection(page))[0].scanEventId;
  await scan(page)
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
      exact: true,
    })
    .click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "2 saved this session",
  );
  const child = (await collection(page)).find(
    (entry) => entry.scanEventId !== original,
  )!.scanEventId;
  await scan(page)
    .getByRole("button", { name: /Show recent captured-view details/ })
    .click();
  const originalRow = scan(page).locator(
    '.pack-receipt[data-status="saved"][data-quantity-origin="captured"]',
  );
  await expect(originalRow).toHaveCount(1);
  await originalRow
    .getByRole("button", { name: "Undo this copy", exact: true })
    .click();
  await expect(scan(page).locator(".pack-capture-status strong")).toHaveText(
    "1 saved this session",
  );
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    child,
  ]);
  await expect(
    scan(page).locator(
      '.pack-receipt[data-status="saved"][data-quantity-origin="user-confirmed"]',
    ),
  ).toHaveCount(1);
  await releaseResults(page);
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    child,
  ]);
  await page.reload();
  expect((await collection(page)).map((entry) => entry.scanEventId)).toEqual([
    child,
  ]);
});
