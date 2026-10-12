import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrintingReader,
  parsePrintingObservation,
  PRINTING_LIMITS,
  resolvePrintingEvidence,
} from "./printing-refinement";
import type {
  PrintingCandidate,
  PrintingObservation,
  PrintingReadInput,
  ResolvePrintingInput,
} from "./printing-refinement";
import type { VisionGame } from "./vision/types";

function observation(
  rawText = "025/198",
  overrides: Partial<PrintingObservation> = {},
): PrintingObservation {
  return {
    ...parsePrintingObservation({
      game: "pokemon",
      jobId: "job-1",
      sessionId: "session-1",
      eventId: "event-1",
      frameId: "frame-1",
      capturedAt: 1000,
      imageFingerprint: "pixels-1",
      rawText,
    }),
    ...overrides,
  };
}
function candidate(
  overrides: Partial<PrintingCandidate> = {},
): PrintingCandidate {
  return {
    key: "pokemon:one",
    game: "pokemon",
    name: "Pikachu",
    number: "25",
    printedTotal: 198,
    ...overrides,
  };
}
function resolve(overrides: Partial<ResolvePrintingInput> = {}) {
  return resolvePrintingEvidence({
    game: "pokemon",
    sessionId: "session-1",
    eventId: "event-1",
    identityName: "Pikachu",
    candidates: [candidate()],
    catalogCompleteForIdentity: true,
    observations: [
      observation(),
      observation("025/198", {
        frameId: "frame-2",
        capturedAt: 1300,
        imageFingerprint: "pixels-2",
      }),
    ],
    ...overrides,
  });
}

describe("literal footer observations", () => {
  it("preserves observed legacy, promo and numeric-prefix Yu-Gi-Oh codes literally", () => {
    for (const [code, number, locale] of [
      ["LOB-E003", "E3", undefined],
      ["LDK2-ENY10", "Y10", "EN"],
      ["LEDD-ENA01", "A1", "EN"],
      ["MVP1-ENSV3", "SV3", "EN"],
      ["MVP1-ENSE3", "SE3", "EN"],
      ["YGLD-ENC09", "C9", "EN"],
      ["2021-EN001", "1", "EN"],
    ]) {
      const parsed = parsePrintingObservation({
        ...observation(),
        game: "yugioh",
        rawText: code!,
      });
      expect(parsed.fields).toEqual({
        setCode: code,
        collectorNumber: number,
        ...(locale ? { locale } : {}),
      });
    }
    expect(
      parsePrintingObservation({
        ...observation(),
        game: "yugioh",
        rawText: "LOB-EN0O1",
      }).fields,
    ).toEqual({});
  });

  it("reads numerator/denominator and explicit printed code/language without guessing symbols", () => {
    const read = observation("Illus. Example\n025/198\nSVI EN\n©2023 Pokémon");
    expect(read.fields).toEqual({
      collectorNumber: "25",
      printedTotal: "198",
      setCode: "SVI",
      locale: "EN",
    });
    expect(read.issues).toEqual([]);
    expect(observation("025/198 ★ ●").fields).toEqual({
      collectorNumber: "25",
      printedTotal: "198",
    });
  });
  it("preserves subset prefixes and secret rare numerators above the denominator", () => {
    expect(observation("TG01/TG30").fields).toEqual({
      collectorNumber: "TG1",
      printedTotal: "TG30",
    });
    expect(observation("213/198").fields).toEqual({
      collectorNumber: "213",
      printedTotal: "198",
    });
  });
  it("does not repair letters into numbers or hallucinate from years, attack stats, or copyright", () => {
    for (const text of [
      "O25/198",
      "025/I98",
      "2024 © Nintendo",
      "ATK/3000 DEF/2500",
      "set: jungle",
      "198",
    ])
      expect(observation(text).fields).toEqual({});
  });
  it("flags competing collector text and truncates raw evidence", () => {
    expect(observation("025/198 024/198").issues).toContain(
      "conflicting-collectorNumber",
    );
    const read = observation("025/198 " + "x".repeat(5000));
    expect(read.rawText).toHaveLength(PRINTING_LIMITS.rawText);
    expect(read.issues).toContain("ocr-text-truncated");
  });
  it("reads actual Yu-Gi-Oh codes and explicit edition stamps, not the eight-digit passcode", () => {
    const read = parsePrintingObservation({
      ...observation(),
      game: "yugioh",
      rawText: "LOB-EN001\n89631139\n1st Edition",
    });
    expect(read.fields).toEqual({
      collectorNumber: "1",
      setCode: "LOB-EN001",
      locale: "EN",
      edition: "1ST EDITION",
    });
    expect(
      parsePrintingObservation({ ...read, rawText: "LOB EN001 89631139" })
        .fields,
    ).toEqual({});
    expect(
      parsePrintingObservation({ ...read, rawText: "LOB-001" }).fields,
    ).toEqual({ collectorNumber: "1", setCode: "LOB-001" });
  });
  it("reads isolated Magic collector, printed set abbreviation, language and rarity", () => {
    const read = parsePrintingObservation({
      ...observation(),
      game: "mtg",
      rawText: "0123 R\nLTR • EN\n©2023 Wizards",
    });
    expect(read.fields).toEqual({
      collectorNumber: "123",
      setCode: "LTR",
      locale: "EN",
      rarity: "rare",
    });
    expect(
      parsePrintingObservation({ ...read, rawText: "0123 R\nLTR" }).fields
        .setCode,
    ).toBeUndefined();
    expect(
      parsePrintingObservation({ ...read, rawText: "0123R\nLTR EN" }).fields,
    ).toEqual(read.fields);
  });
});

describe("conservative catalog printing resolution", () => {
  it("requires two captures and matching catalog fields while keeping price/finish/condition unknown", () => {
    const result = resolve();
    expect(result.state).toBe("catalog-printing-read");
    expect(result.reference?.key).toBe("pokemon:one");
    expect(result).toMatchObject({
      priceEligible: false,
      finish: "unknown",
      condition: "unknown",
    });
    expect(result.unconfirmed).toEqual([
      "language",
      "edition",
      "rarity",
      "finish",
      "condition",
    ]);
  });
  it("never promotes a unique number from an incomplete tiny gallery", () => {
    expect(resolve({ catalogCompleteForIdentity: false }).reasons).toContain(
      "catalog-coverage-incomplete",
    );
    expect(
      resolve({
        observations: [
          observation("025"),
          observation("025", { frameId: "frame-2" }),
        ],
      }).state,
    ).toBe("unresolved");
  });
  it.each([
    [
      "same frame",
      {
        frameId: "frame-1",
        capturedAt: 2000,
        imageFingerprint: "pixels-resized",
      },
    ],
    [
      "same pixels",
      { frameId: "different", capturedAt: 2000, imageFingerprint: "pixels-1" },
    ],
    [
      "same capture time",
      { frameId: "different", capturedAt: 1000, imageFingerprint: "pixels-2" },
    ],
  ])("does not count %s as independent", (_, second) => {
    expect(
      resolve({ observations: [observation(), observation("025/198", second)] })
        .reasons,
    ).toContain("two-independent-captures-required");
  });
  it("ignores stale event/session/game callbacks", () => {
    for (const stale of [
      { eventId: "old" },
      { sessionId: "old" },
      { game: "mtg" as const },
    ])
      expect(
        resolve({
          observations: [
            observation(),
            observation("025/198", {
              ...stale,
              frameId: "frame-2",
              capturedAt: 2000,
              imageFingerprint: "pixels-2",
            }),
          ],
        }).state,
      ).toBe("unresolved");
  });
  it("refuses conflicting reads and does not cherry-pick an agreeing pair", () => {
    const reads = [
      observation(),
      observation("025/198", {
        frameId: "f2",
        capturedAt: 2000,
        imageFingerprint: "p2",
      }),
      observation("026/198", {
        frameId: "f3",
        capturedAt: 3000,
        imageFingerprint: "p3",
      }),
    ];
    expect(resolve({ observations: reads }).reasons).toContain(
      "conflicting-observations",
    );
    reads[2] = observation("025/198 026/198");
    expect(resolve({ observations: reads }).reasons).toContain(
      "conflicting-observations",
    );
  });
  it("does not discard a possibly matching candidate with missing metadata", () => {
    expect(
      resolve({
        candidates: [
          candidate(),
          candidate({ key: "unknown", printedTotal: undefined }),
        ],
      }).reasons,
    ).toContain("catalog-fields-incomplete");
    expect(
      resolve({ candidates: [candidate({ printedTotal: undefined })] }).state,
    ).toBe("unresolved");
    // A known contradictory denominator legitimately excludes an otherwise incomplete candidate.
    expect(
      resolve({
        candidates: [
          candidate(),
          candidate({ key: "different", number: undefined, printedTotal: 159 }),
        ],
      }).state,
    ).toBe("catalog-printing-read");
  });
  it("leaves identical collector/edition/foil/rarity catalog alternatives unresolved", () => {
    for (const variant of [
      { rarity: "Holo Rare" },
      { edition: "1ST EDITION" },
      {},
    ]) {
      expect(
        resolve({
          candidates: [
            candidate(),
            candidate({ key: "alternate", ...variant }),
          ],
        }).state,
      ).toBe("unresolved");
    }
    expect(
      resolve({ candidates: [candidate({ edition: "UNLIMITED EDITION" })] })
        .state,
    ).toBe("unresolved");
  });
  it("does not silently ignore explicitly read code, language, or rarity without metadata", () => {
    const reads = [
      observation("025/198\nSVI EN"),
      observation("025/198\nSVI EN", {
        frameId: "f2",
        capturedAt: 2000,
        imageFingerprint: "p2",
      }),
    ];
    expect(resolve({ observations: reads }).reasons).toContain(
      "catalog-fields-incomplete",
    );
    const result = resolve({
      candidates: [candidate({ setCode: "SVI", locale: "en" })],
      observations: reads,
    });
    expect(result.state).toBe("catalog-printing-read");
    expect(result.unconfirmed).not.toContain("language");
  });
  it("rejects mixed identity, duplicate-key, and oversized candidate responses", () => {
    expect(resolve({ candidates: [candidate({ name: "Raichu" })] }).state).toBe(
      "unresolved",
    );
    expect(
      resolve({ candidates: [candidate(), candidate()] }).reasons,
    ).toContain("catalog-duplicate-or-missing-key");
    expect(
      resolve({
        candidates: Array.from({ length: 2501 }, (_, i) =>
          candidate({ key: String(i) }),
        ),
      }).reasons,
    ).toContain("catalog-candidate-limit");
  });
  it("uses full Yu-Gi-Oh code and keeps same-code rarity variants ambiguous", () => {
    const one = parsePrintingObservation({
      ...observation(),
      game: "yugioh",
      rawText: "LOB-EN001",
    });
    const observations = [
      one,
      { ...one, frameId: "f2", capturedAt: 2000, imageFingerprint: "p2" },
    ];
    const base = candidate({
      game: "yugioh",
      number: "001",
      setCode: "LOB-EN001",
      locale: "en",
      rarity: "Ultra Rare",
    });
    expect(
      resolve({ game: "yugioh", candidates: [base], observations }).state,
    ).toBe("catalog-printing-read");
    expect(
      resolve({
        game: "yugioh",
        candidates: [
          base,
          {
            ...base,
            key: "foil-alternative",
            rarity: "Quarter Century Secret Rare",
          },
        ],
        observations,
      }).state,
    ).toBe("unresolved");
  });
  it("requires Magic set code and language in addition to collector number", () => {
    const one = parsePrintingObservation({
      ...observation(),
      game: "mtg",
      rawText: "0123 R\nLTR EN",
    });
    const observations = [
      one,
      { ...one, frameId: "f2", capturedAt: 2000, imageFingerprint: "p2" },
    ];
    const base = candidate({
      game: "mtg",
      number: "123",
      setCode: "ltr",
      locale: "en",
      rarity: "Rare",
    });
    expect(
      resolve({ game: "mtg", candidates: [base], observations }).state,
    ).toBe("catalog-printing-read");
    expect(
      resolve({
        game: "mtg",
        candidates: [{ ...base, locale: undefined }],
        observations,
      }).state,
    ).toBe("unresolved");
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  static auto = true;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((message: { action: string; jobId: string }) => {
    if (FakeWorker.auto)
      queueMicrotask(() =>
        this.reply(
          message.jobId,
          message.action === "recognize"
            ? { text: "025/198", confidence: 99 }
            : {},
        ),
      );
  });
  constructor(public url: string) {
    FakeWorker.instances.push(this);
  }
  reply(jobId: string, data: unknown = {}, status = "resolve") {
    this.onmessage?.({ data: { jobId, status, data } } as MessageEvent);
  }
}
function readInput(
  overrides: Partial<PrintingReadInput> = {},
): PrintingReadInput {
  return {
    jobId: "job-1",
    sessionId: "session-1",
    eventId: "event-1",
    frameId: "frame-1",
    capturedAt: 1000,
    game: "pokemon",
    sourceMinEdge: 600,
    signal: new AbortController().signal,
    image: { width: 600, height: 840 } as HTMLCanvasElement,
    ...overrides,
  };
}

describe("persistent bounded local printing reader", () => {
  let canvases: HTMLCanvasElement[];
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.auto = true;
    canvases = [];
    vi.stubGlobal("window", {
      location: { href: "https://test.local/", origin: "https://test.local" },
    });
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) },
    });
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: vi.fn(),
            putImageData: vi.fn(),
            getImageData: () => ({ data: new Uint8ClampedArray(16) }),
          }),
          toBlob: (callback: (blob: Blob) => void) =>
            callback(new Blob(["local-image-bytes"], { type: "image/png" })),
        } as unknown as HTMLCanvasElement;
        canvases.push(canvas);
        return canvas;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("reuses one initialized worker, pinned same-origin assets, and bytes instead of image URLs", async () => {
    const reader = createPrintingReader();
    const first = await reader.read(readInput());
    const second = await reader.read(
      readInput({ jobId: "job-2", frameId: "frame-2" }),
    );
    expect(first.fields).toEqual({
      collectorNumber: "25",
      printedTotal: "198",
    });
    expect(second.jobId).toBe("job-2");
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    expect(worker.url).toBe("https://test.local/ocr/worker.min.js");
    const messages = worker.postMessage.mock.calls.map(
      ([message]) => message,
    ) as unknown as { action: string; payload: Record<string, unknown> }[];
    expect(messages.map((m) => m.action)).toEqual([
      "load",
      "loadLanguage",
      "initialize",
      "setParameters",
      "recognize",
      "recognize",
    ]);
    expect(messages[0].payload).toEqual({
      options: { lstmOnly: true, corePath: "https://test.local/ocr/" },
    });
    expect(messages[1].payload).toMatchObject({
      options: { langPath: "https://test.local/ocr/", cacheMethod: "none" },
    });
    expect(messages[4].payload.image).toBeInstanceOf(Uint8Array);
    expect(
      canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
    ).toBe(true);
    reader.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("skips a burst while busy without growing a queue or cancelling the running job", async () => {
    FakeWorker.auto = false;
    const reader = createPrintingReader();
    const controller = new AbortController();
    const running = reader.read(readInput({ signal: controller.signal }));
    const aborted = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(reader.busy).toBe(true);
    for (let i = 0; i < 100; i++)
      await expect(reader.read(readInput())).rejects.toMatchObject({
        code: "busy",
      });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminate).not.toHaveBeenCalled();
    controller.abort();
    await aborted;
    expect(reader.busy).toBe(false);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    reader.dispose();
  });
  it("times out stalled initialization, then starts a clean worker for the next job", async () => {
    vi.useFakeTimers();
    FakeWorker.auto = false;
    const reader = createPrintingReader({ timeoutMs: 100 });
    const result = reader.read(readInput());
    const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    FakeWorker.auto = true;
    await reader.read(readInput({ jobId: "retry" }));
    expect(FakeWorker.instances).toHaveLength(2);
    reader.dispose();
  });
  it("aborts while hashing without later creating a worker", async () => {
    let finishHash: (value: ArrayBuffer) => void = () => undefined;
    vi.stubGlobal("crypto", {
      subtle: {
        digest: () =>
          new Promise<ArrayBuffer>((resolve) => {
            finishHash = resolve;
          }),
      },
    });
    const reader = createPrintingReader();
    const controller = new AbortController();
    const running = reader.read(readInput({ signal: controller.signal }));
    const assertion = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    finishHash(new ArrayBuffer(32));
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(0);
    reader.dispose();
  });
  it("rejects low native resolution even if the caller enlarged the canvas", async () => {
    const reader = createPrintingReader();
    await expect(
      reader.read(readInput({ sourceMinEdge: 240 })),
    ).rejects.toMatchObject({ code: "image-quality" });
    await expect(
      reader.read(
        readInput({ image: { width: 240, height: 336 } as HTMLCanvasElement }),
      ),
    ).rejects.toMatchObject({ code: "image-quality" });
    expect(FakeWorker.instances).toHaveLength(0);
    reader.dispose();
  });
  it("ignores mismatched worker packets and stops on a reject without exposing remote messages", async () => {
    FakeWorker.auto = false;
    const reader = createPrintingReader();
    const running = reader.read(readInput());
    const assertion = expect(running).rejects.toMatchObject({
      code: "reader-failed",
    });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    const jobId = worker.postMessage.mock.calls[0][0].jobId;
    worker.reply("stale-job", { text: "999/999" });
    expect(reader.busy).toBe(true);
    worker.reply(jobId, "https://attacker.example/upload-photo", "reject");
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
    reader.dispose();
  });
  it("reclaims the idle worker and disposes idempotently", async () => {
    vi.useFakeTimers();
    const reader = createPrintingReader({ idleMs: 100 });
    await reader.read(readInput());
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await reader.read(readInput());
    expect(FakeWorker.instances).toHaveLength(2);
    reader.dispose();
    reader.dispose();
    await expect(reader.read(readInput())).rejects.toMatchObject({
      code: "disposed",
    });
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
  });
  it("disposes an active job and cannot restart from a delayed image encoder", async () => {
    let finishEncoding: ((blob: Blob) => void) | undefined;
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        }),
        toBlob: (callback: (blob: Blob) => void) => {
          finishEncoding = callback;
        },
      }),
    });
    const reader = createPrintingReader();
    const running = reader.read(readInput());
    const assertion = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(finishEncoding).toBeDefined());
    const worker = FakeWorker.instances[0];
    reader.dispose();
    await assertion;
    finishEncoding!(new Blob(["late-bytes"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(
      worker.postMessage.mock.calls.map(([message]) => message.action),
    ).not.toContain("recognize");
  });
  it("rejects a foreign-origin asset base before creating any worker", async () => {
    vi.stubGlobal("window", {
      location: { href: "https://foreign.test/", origin: "https://test.local" },
    });
    const reader = createPrintingReader();
    await expect(reader.read(readInput())).rejects.toMatchObject({
      code: "reader-failed",
    });
    expect(FakeWorker.instances).toHaveLength(0);
    reader.dispose();
  });
  it("rejects a pre-aborted job without allocating a worker", async () => {
    const reader = createPrintingReader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.read(readInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
    reader.dispose();
  });
});

/**
 * Original generated footer controls, not card-art or physical-photo accuracy.
 * Opt in: PRINTING_REAL_OCR=1 npx vitest run src/lib/printing-refinement.test.ts
 * Requires locally staged /ocr assets and the existing Playwright Chromium.
 */
it.runIf(process.env.PRINTING_REAL_OCR === "1")(
  "reads original footer controls with the real local browser OCR worker",
  async () => {
    const { createServer } = await import("vite");
    const { chromium } = await import("@playwright/test");
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {}),
      });
      const page = await browser.newPage();
      const remote: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== new URL(origin).origin)
          remote.push(request.url());
      });
      await page.route(`${origin}/printing-control`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Original local OCR controls</title>",
        }),
      );
      await page.goto(`${origin}/printing-control`);
      const reads = await page.evaluate(async (moduleUrl) => {
        const { createPrintingReader } = (await import(
          /* @vite-ignore */ moduleUrl
        )) as typeof import("./printing-refinement");
        const reader = createPrintingReader();
        const results = [];
        try {
          for (const game of ["pokemon", "mtg", "yugioh"] as VisionGame[]) {
            const canvas = document.createElement("canvas");
            canvas.width = 850;
            canvas.height = 1190;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, 850, 1190);
            ctx.fillStyle = "#789";
            ctx.fillRect(70, 160, 710, 400);
            ctx.fillStyle = "black";
            ctx.font = "28px Arial";
            if (game === "pokemon") {
              ctx.fillText("025/198", 90, 1070);
              ctx.fillText("SVI EN", 90, 1120);
            }
            if (game === "mtg") {
              ctx.fillText("0123 R", 90, 1070);
              ctx.fillText("LTR EN", 90, 1120);
            }
            if (game === "yugioh") {
              ctx.fillText("LOB-EN001", 580, 730);
              ctx.fillText("1st Edition", 90, 1130);
            }
            const read = await reader.read({
              game,
              jobId: game,
              sessionId: "controls",
              eventId: game,
              frameId: game,
              capturedAt: Date.now(),
              sourceMinEdge: 850,
              image: canvas,
              signal: new AbortController().signal,
            });
            results.push(read);
          }
        } finally {
          reader.dispose();
        }
        return results;
      }, `${origin}/src/lib/printing-refinement.ts`);
      expect(remote).toEqual([]);
      expect(reads[0].fields).toMatchObject({
        collectorNumber: "25",
        printedTotal: "198",
      });
      if (reads[0].fields.setCode !== undefined)
        expect(reads[0].fields.setCode).toBe("SVI");
      if (reads[0].fields.locale !== undefined)
        expect(reads[0].fields.locale).toBe("EN");
      expect(reads[1].fields).toMatchObject({
        collectorNumber: "123",
        setCode: "LTR",
        locale: "EN",
        rarity: "rare",
      });
      if (/\bLOB-EN0O1\b/.test(reads[2].rawText)) {
        expect(reads[2].fields).toEqual({ edition: "1ST EDITION" });
      } else {
        expect(reads[2].fields).toMatchObject({
          collectorNumber: "1",
          setCode: "LOB-EN001",
          locale: "EN",
          edition: "1ST EDITION",
        });
      }
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  120_000,
);

/** Local-model fallback where browser IPC is unavailable; does not test the browser adapter. */
it.runIf(process.env.PRINTING_NODE_OCR === "1")(
  "reads reliable local-model controls and abstains on glyph/spacing ambiguities",
  async () => {
    const { createWorker } = await import("tesseract.js");
    const { default: sharp } = await import("sharp");
    const { resolve: pathResolve } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const model = await readFile(pathResolve("public/ocr/eng.traineddata.gz"));
    expect(createHash("sha256").update(model).digest("hex")).toBe(
      "ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468",
    );
    const worker = await createWorker("eng", 1, {
      langPath: pathResolve("public/ocr"),
      cacheMethod: "none",
      gzip: true,
      workerPath: pathResolve(
        "node_modules/tesseract.js/src/worker-script/node/index.js",
      ),
      corePath: pathResolve(
        "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
      ),
    });
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: "11" as import("tesseract.js").PSM,
        user_defined_dpi: "300",
      });
      const fixtures: {
        game: VisionGame;
        lines: string[];
        expected: Record<string, string>;
      }[] = [
        {
          game: "pokemon",
          lines: ["025/198", "SVI EN"],
          expected: {
            collectorNumber: "25",
            printedTotal: "198",
            setCode: "SVI",
            locale: "EN",
          },
        },
        {
          game: "mtg",
          lines: ["0123 R", "LTR EN"],
          expected: {
            collectorNumber: "123",
            setCode: "LTR",
            locale: "EN",
            rarity: "rare",
          },
        },
        {
          game: "yugioh",
          lines: ["LOB-EN001", "1st Edition"],
          expected: {
            collectorNumber: "1",
            setCode: "LOB-EN001",
            locale: "EN",
            edition: "1ST EDITION",
          },
        },
      ];
      for (const fixture of fixtures) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="220"><rect width="850" height="220" fill="white"/>${fixture.lines.map((line, i) => `<text x="90" y="${70 + i * 60}" font-family="sans-serif" font-size="28" fill="black">${line}</text>`).join("")}</svg>`;
        const png = await sharp(Buffer.from(svg)).png().toBuffer();
        const read = await worker.recognize(png);
        const parsed = parsePrintingObservation({
          ...observation(),
          game: fixture.game,
          rawText: read.data.text,
        });
        // The pinned model may fuse the tightly spaced Pokémon marker into SVIEN.
        // Do not repair that into a guessed code/language; still require its clear fraction.
        const ambiguousYgo =
          fixture.game === "yugioh" && /\bLOB-EN0O1\b/.test(read.data.text);
        const expected =
          fixture.game === "pokemon"
            ? { collectorNumber: "25", printedTotal: "198" }
            : ambiguousYgo
              ? { edition: "1ST EDITION" }
              : fixture.expected;
        expect(
          parsed.fields,
          `${fixture.game} literal OCR: ${read.data.text}`,
        ).toMatchObject(expected);
        for (const [field, value] of Object.entries(parsed.fields))
          expect(value).toBe(fixture.expected[field]);
        if (/\bSVIEN\b/.test(read.data.text)) {
          expect(parsed.fields.setCode).toBeUndefined();
          expect(parsed.fields.locale).toBeUndefined();
        }
        if (ambiguousYgo) {
          expect(parsed.fields).toEqual({ edition: "1ST EDITION" });
          const unresolved = resolve({
            game: "yugioh",
            candidates: [candidate({ game: "yugioh" })],
            observations: [parsed],
          });
          expect(unresolved.state).toBe("unresolved");
        }
        expect(parsed.issues).toEqual([]);
      }
    } finally {
      await worker.terminate();
    }
  },
  90_000,
);
