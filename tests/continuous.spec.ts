import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixturePack = fileURLToPath(
  new URL("./fixtures/continuous-feature-pack.json", import.meta.url),
);
const fixtureClip = fileURLToPath(
  new URL("./fixtures/continuous-two-copies.mp4", import.meta.url),
);
const scanner = (page: Page) =>
  page.getByRole("region", { name: "Continuous card scanner" });
const receipts = (page: Page) => page.locator(".scan-receipts article");

async function deterministicCamera(
  page: Page,
  options: { hold?: boolean; storageFailure?: boolean } = {},
) {
  // Control-flow fixtures only: matching evidence is stubbed, not measured CV accuracy.
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(({ hold, storageFailure }) => {
    type State = {
      analyses: number;
      terminated: number;
      stopped: number;
      releases: (() => void)[];
      release: () => void;
    };
    const state: State = {
      analyses: 0,
      terminated: 0,
      stopped: 0,
      releases: [],
      release() {
        this.releases.splice(0).forEach((f) => f());
      },
    };
    Object.assign(window, { continuousFixture: state });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#456";
        ctx.fillRect(0, 0, 640, 480);
        const media = canvas.captureStream(15);
        let shade = 0;
        const repaint = setInterval(() => {
          ctx.fillStyle = `rgb(${shade++ % 255}, 80, 90)`;
          ctx.fillRect(0, 0, 640, 480);
        }, 66);
        for (const track of media.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            state.stopped++;
            clearInterval(repaint);
            stop();
          };
        }
        return media;
      },
    });
    if (storageFailure) {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "tcg-scan:data:v1" && JSON.parse(value).collection?.length)
          throw new DOMException(
            "Fixture quota exceeded",
            "QuotaExceededError",
          );
        return original.call(this, key, value);
      };
    }
    const coverage = {
      totalReferences: 1,
      byGame: { pokemon: 1, mtg: 0, yugioh: 0 },
      packs: ["Synthetic worker fixture"],
    };
    const detection = (x: number) => ({
      quad: [
        { x, y: 70 },
        { x: x + 130, y: 70 },
        { x: x + 130, y: 252 },
        { x, y: 252 },
      ],
      state: "verified",
      reason: "Synthetic worker fixture",
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
          key: "pokemon:fixture",
          reference: {
            key: "pokemon:fixture",
            game: "pokemon",
            name: "Synthetic control-flow card",
            identityKey: "fixture:one",
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
    });
    class FixtureWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(message: { id: number; type: string }) {
        const result =
          message.type === "analyze"
            ? {
                width: 640,
                height: 480,
                detections: [detection(70), detection(330)],
                timings: {
                  detectionMs: 1,
                  extractionMs: 1,
                  matchingMs: 1,
                  totalMs: 3,
                },
                coverage,
                budgetExhausted: false,
              }
            : message.type === "initialize"
              ? { engine: "Synthetic worker fixture", coverage }
              : coverage;
        const callback = this.onmessage;
        const reply = () =>
          callback?.({ data: { id: message.id, result } } as MessageEvent);
        if (message.type === "analyze") {
          state.analyses++;
          if (hold) {
            state.releases.push(reply);
            return;
          }
        }
        setTimeout(reply, 0);
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
  // Install our original descriptor fixture through the real import path.
  // A Worker stub must not bypass the production zero-coverage setup guard.
  await scanner(page)
    .getByLabel("Import feature packs")
    .setInputFiles(fixturePack);
  await expect(scanner(page)).toContainText(
    "9 installed references",
  );
}
const metrics = (page: Page) =>
  page.evaluate(() => {
    const x = (
      window as unknown as {
        continuousFixture: {
          analyses: number;
          terminated: number;
          stopped: number;
        };
      }
    ).continuousFixture;
    return {
      analyses: x.analyses,
      terminated: x.terminated,
      stopped: x.stopped,
    };
  });
const release = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { continuousFixture: { release: () => void } }
    ).continuousFixture.release(),
  );

test("empty selected-game coverage promotes setup without opening camera or worker", async ({
  page,
}) => {
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(() => {
    const calls = { camera: 0, worker: 0 };
    Object.assign(window, { emptyCoverageCalls: calls });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        calls.camera++;
        throw new Error("Empty coverage must not request camera access");
      },
    });
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          calls.worker++;
          throw new Error("Empty coverage must not initialize a worker");
        }
      },
    });
  });
  await page.goto("/");
  const scan = scanner(page);
  await expect(
    scan.getByText("Set up Pokémon recognition", { exact: true }),
  ).toBeVisible();
  await expect(scan.getByLabel("Install learned reference pack")).toBeVisible();
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeDisabled();
  await expect(scan.getByLabel("Multi-card photo", { exact: true })).toBeDisabled();
  // Coverage is per selected game, even when another game's fixture is ready.
  await scan.getByLabel("Import feature packs").setInputFiles(fixturePack);
  await expect(scan).toContainText("9 installed references");
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Magic", exact: true }).click();
  await expect(
    scan.getByText("Set up Magic: The Gathering recognition", { exact: true }),
  ).toBeVisible();
  await expect(
    scan.getByRole("button", { name: "Start continuous camera" }),
  ).toBeDisabled();
  await expect(scan.getByLabel("Multi-card photo", { exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as {
          emptyCoverageCalls: { camera: number; worker: number };
        }).emptyCoverageCalls,
    ),
  ).toEqual({ camera: 0, worker: 0 });
});

test("continuous controls preserve two copies, suppress undo, and rearm only on New page", async ({
  page,
}) => {
  await deterministicCamera(page);
  await page.getByLabel("Session mode").selectOption("binder");
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(receipts(page)).toHaveCount(2);
  const before = (await metrics(page)).analyses;
  await expect
    .poll(async () => (await metrics(page)).analyses)
    .toBeGreaterThan(before + 4);
  await expect(receipts(page)).toHaveCount(2);
  await scanner(page)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await receipts(page).first().getByRole("button", { name: "Undo" }).click();
  await expect(receipts(page).first()).toContainText("Undone");
  await scanner(page)
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  const resumed = (await metrics(page)).analyses;
  await expect
    .poll(async () => (await metrics(page)).analyses)
    .toBeGreaterThan(resumed + 4);
  await expect(receipts(page)).toHaveCount(2);
  await scanner(page)
    .getByRole("button", { name: "New page", exact: true })
    .click();
  await expect(receipts(page)).toHaveCount(4);
  await scanner(page)
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).stopped).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("3 collection entries", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Identity only · value unavailable", { exact: true }),
  ).toHaveCount(3);
});

test("late in-flight analysis cannot save after Stop or navigation", async ({
  page,
}) => {
  await deterministicCamera(page, { hold: true });
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  for (let n = 1; n <= 2; n++) {
    await expect.poll(async () => (await metrics(page)).analyses).toBe(n);
    await release(page);
  }
  await expect.poll(async () => (await metrics(page)).analyses).toBe(3);
  await page.waitForTimeout(300); // Pending third observation would otherwise complete stabilization.
  await scanner(page)
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await release(page);
  await expect(receipts(page)).toHaveCount(0);
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  for (let n = 4; n <= 5; n++) {
    await expect.poll(async () => (await metrics(page)).analyses).toBe(n);
    await release(page);
  }
  await expect.poll(async () => (await metrics(page)).analyses).toBe(6);
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await release(page);
  await expect(
    page.getByText("0 collection entries", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await metrics(page)).stopped).toBe(2);
});

test("New page rejects a pending prior-page stabilization frame", async ({
  page,
}) => {
  await deterministicCamera(page, { hold: true });
  await page.getByLabel("Session mode").selectOption("binder");
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  for (let n = 1; n <= 2; n++) {
    await expect.poll(async () => (await metrics(page)).analyses).toBe(n);
    await release(page);
  }
  await expect.poll(async () => (await metrics(page)).analyses).toBe(3);
  await page.waitForTimeout(300);
  await scanner(page)
    .getByRole("button", { name: "New page", exact: true })
    .click();
  await release(page);
  await expect.poll(async () => (await metrics(page)).analyses).toBe(4);
  await expect(receipts(page)).toHaveCount(0);
  await scanner(page)
    .getByRole("button", { name: "Stop", exact: true })
    .click();
});

test("storage failure never shows a successful automatic save", async ({
  page,
}) => {
  await deterministicCamera(page, { storageFailure: true });
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(scanner(page)).toContainText("Scan was not saved");
  await expect(receipts(page)).toHaveCount(0);
  await scanner(page)
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("0 collection entries", { exact: true }),
  ).toBeVisible();
});

test("real local worker auto-adds two synthetic video regions once @live-vision", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RUN_LIVE_VISION !== "1" ||
      testInfo.project.name !== "desktop-chromium",
    "Opt-in genuine OpenCV integration on original synthetic mechanics fixtures; not a camera benchmark.",
  );
  test.setTimeout(120_000);
  const external: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (r) => {
    if (/^https:\/\//.test(r.url()))
      external.push({ url: r.url(), method: r.method(), body: r.postData() });
  });
  await page.route("https://**/*", (r) => r.abort());
  await page.route("**/qa-fixture.mp4", async (r) =>
    r.fulfill({ body: await readFile(fixtureClip), contentType: "video/mp4" }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.src = "/qa-fixture.mp4";
        video.style.cssText =
          "width:160px;position:fixed;right:0;top:30px;z-index:1000";
        const label = document.createElement("div");
        label.textContent = "SYNTHETIC VIDEO REPLAY · QA ONLY";
        label.style.cssText =
          "position:fixed;right:0;top:0;background:#ffd36c;color:#111;z-index:1001;padding:6px";
        document.body.append(video, label);
        await video.play();
        return (
          video as HTMLVideoElement & { captureStream: () => MediaStream }
        ).captureStream();
      },
    });
  });
  await page.goto("/");
  // Fresh contexts have no packs: setup opens after metadata finishes loading.
  // Do not race the temporary pre-load Manage button as it disappears.
  await scanner(page)
    .getByLabel("Import feature packs")
    .setInputFiles(fixturePack);
  await expect(scanner(page)).toContainText(
    "9 installed references",
  );
  await scanner(page)
    .getByRole("button", { name: "Start continuous camera" })
    .click();
  await expect(receipts(page)).toHaveCount(2, { timeout: 95_000 });
  await expect(page.locator(".track-label.track-added")).toHaveCount(2);
  await page.waitForTimeout(6000); // More than one complete replay cycle must not recount held cards.
  await expect(receipts(page)).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("real-vision-synthetic-autoadd.png"),
    fullPage: true,
  });
  await scanner(page)
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByText("2 collection entries", { exact: true }),
  ).toBeVisible();
  // Public-ID pricing may be attempted after durable save. No frame/image upload.
  expect(
    external.every(
      (r) =>
        new URL(r.url).hostname === "api.tcgdex.net" &&
        r.method === "GET" &&
        r.body === null,
    ),
  ).toBe(true);
});
