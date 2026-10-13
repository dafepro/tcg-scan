import type { GuidedFixtureWindow } from "./guided-fixture-types";
import { expect, test, type Page } from "@playwright/test";
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

export async function prepare(
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
      action?: string;
      jobId?: string;
      workerId?: string;
      id: number;
      type: string;
      image?: { width: number; height: number; data: Uint8ClampedArray };
      options?: { mode?: string; includePrintingCrops?: boolean };
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
        if (request.action) {
          const q = (window as unknown as GuidedFixtureWindow).guidedQA;
          if (request.action === "recognize") q.ocrReads++;
          const reply = () =>
            callback?.({
              data: {
                jobId: request.jobId,
                status: "resolve",
                data: { text: q.ocrText },
              },
            } as MessageEvent);
          if (request.action === "recognize" && q.holdOCR)
            q.ocrReplies.push(reply);
          else setTimeout(reply, 0);
          return;
        }
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
              printingCrop: request.options?.includePrintingCrops
                ? (window as unknown as GuidedFixtureWindow).makeGuidedCrop(
                    state.analyses,
                  )
                : undefined,
              printingSourceMinEdge: 600,
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
        (window as unknown as GuidedFixtureWindow).guidedQA.terminated++;
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
