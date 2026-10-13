import type { GuidedFixtureWindow } from "./guided-fixture-types";
import { openDisclosure } from "./fixtures/disclosures";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  attachNativeFrameDiagnosticsOnFailure,
  installNativeFrameDiagnostics,
} from "./fixtures/native-frame-diagnostics";

test.beforeEach(async ({ page }) => installNativeFrameDiagnostics(page));
test.afterEach(async ({ page, browser }, testInfo) => {
  await attachNativeFrameDiagnosticsOnFailure(page, browser, testInfo);
});

const fixturePack = fileURLToPath(
  new URL("./fixtures/continuous-feature-pack.json", import.meta.url),
);
const scanner = (page: Page) =>
  page.getByRole("region", { name: "Continuous card scanner" });

export async function deterministicCamera(
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
      printingCrop: (window as unknown as GuidedFixtureWindow).makeGuidedCrop(
        state.analyses,
      ),
      printingSourceMinEdge: 600,
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
          key: "pokemon:sv01-025",
          reference: {
            key: "pokemon:sv01-025",
            game: "pokemon",
            name: "Pikachu",
            identityKey: "pokemon:pikachu",
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
      postMessage(message: {
        id: number;
        type: string;
        action?: string;
        jobId?: string;
      }) {
        if (message.action) {
          const q = (window as unknown as GuidedFixtureWindow).guidedQA;
          if (message.action === "recognize") q.ocrReads++;
          const callback = this.onmessage;
          const reply = () =>
            callback?.({
              data: {
                jobId: message.jobId,
                status: "resolve",
                data: { text: q.ocrText },
              },
            } as MessageEvent);
          if (message.action === "recognize" && q.holdOCR)
            q.ocrReplies.push(reply);
          else setTimeout(reply, 0);
          return;
        }
        const result =
          message.type === "analyze"
            ? {
                width: 640,
                height: 480,
                detections: [detection(70)],
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
  await openDisclosure(page, "Compatibility import and other reference packs");
  await scanner(page)
    .getByLabel("Import feature packs")
    .setInputFiles(fixturePack);
  await expect(scanner(page)).toContainText("9 installed references");
}
