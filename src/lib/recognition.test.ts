import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractNameCandidates,
  MAX_IMAGE_BYTES,
  validateImageFile,
} from "./recognition";

describe("extractNameCandidates", () => {
  it("removes Pokémon stage and HP decorations", () => {
    expect(
      extractNameCandidates(
        "STAGE 2 Charizard ex HP 330\nEvolves from Charmeleon\nBurning Darkness 180",
        "pokemon",
      )[0],
    ).toBe("Charizard ex");
  });
  it("handles HP preceding the letters and standalone metadata", () => {
    expect(
      extractNameCandidates(
        "BASIC\nPikachu 60 HP\nWeakness\nRetreat\n025/198",
        "pokemon",
      ),
    ).toEqual(["Pikachu"]);
  });
  it("preserves names that begin with metadata words", () => {
    expect(
      extractNameCandidates(
        "Pokémon Center Lady\nTRAINER\nSupporter",
        "pokemon",
      ),
    ).toEqual(["Pokémon Center Lady"]);
  });
  it("keeps important name punctuation", () => {
    expect(
      extractNameCandidates(
        "BASIC Mr. Mime HP 90\nFarfetch’d 60 HP",
        "pokemon",
      ),
    ).toEqual(["Mr. Mime", "Farfetch'd"]);
  });
  it("keeps Magic title and strips mana symbols", () => {
    expect(
      extractNameCandidates(
        "Lightning Bolt {R}\nInstant\nLightning Bolt deals 3 damage to any target.",
        "mtg",
      ),
    ).toEqual(["Lightning Bolt"]);
  });
  it("keeps hyphenated and numeric Yu-Gi-Oh names", () => {
    expect(
      extractNameCandidates(
        "Blue-Eyes White Dragon\nATK/3000 DEF/2500\n1st Edition\nNumber 39: Utopia",
        "yugioh",
      ),
    ).toEqual(["Blue-Eyes White Dragon", "Number 39: Utopia"]);
  });
  it("deduplicates case-insensitively", () => {
    expect(
      extractNameCandidates("Pikachu\nPIKACHU\nPikachu", "pokemon"),
    ).toEqual(["Pikachu"]);
  });
  it("returns no invented name for blank, numbers, or rules", () => {
    expect(
      extractNameCandidates(
        " \n12345\nYour opponent discards a card.\nHP 100\n!!!",
        "pokemon",
      ),
    ).toEqual([]);
  });
  it("limits suggestions and ignores excessively long lines", () => {
    expect(extractNameCandidates("a".repeat(80), "mtg")).toEqual([]);
    expect(
      extractNameCandidates(
        "First\nSecond\nThird\nFourth\nFifth\nSixth",
        "mtg",
      ),
    ).toHaveLength(5);
  });
});

describe("validateImageFile", () => {
  it("accepts supported nonempty images", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"])
      expect(validateImageFile({ type, size: 2048 })).toBeNull();
  });
  it("rejects unsupported, empty, and oversized inputs with useful errors", () => {
    expect(validateImageFile({ type: "image/heic", size: 1024 })).toContain(
      "HEIC",
    );
    expect(validateImageFile({ type: "image/png", size: 0 })).toContain(
      "empty",
    );
    expect(
      validateImageFile({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }),
    ).toContain("15 MB");
  });
});

// Direct native-worker ownership lets cancellation interrupt initialization,
// including a first-run model download that never resolves.
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  reply(status: string, data: unknown = {}) {
    const packet = this.postMessage.mock.calls.at(-1)?.[0];
    this.onmessage?.({
      data: { jobId: packet.jobId, status, data },
    } as MessageEvent);
  }
}

describe("recognizeCard cancellation and worker lifecycle", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { href: "https://test.local/" },
    });
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not start a worker for an already cancelled scan", async () => {
    const { recognizeCard } = await import("./recognition");
    const controller = new AbortController();
    controller.abort();
    await expect(
      recognizeCard(
        {} as HTMLCanvasElement,
        "pokemon",
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("immediately terminates a worker stalled while loading its runtime", async () => {
    const { recognizeCard } = await import("./recognition");
    const controller = new AbortController();
    const promise = recognizeCard(
      {} as HTMLCanvasElement,
      "pokemon",
      controller.signal,
      vi.fn(),
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0].action).toBe("load");
    controller.abort();
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
  });

  it("immediately terminates a worker stalled downloading the English model", async () => {
    const { recognizeCard } = await import("./recognition");
    const controller = new AbortController();
    const promise = recognizeCard(
      {} as HTMLCanvasElement,
      "pokemon",
      controller.signal,
      vi.fn(),
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    const worker = FakeWorker.instances[0];
    worker.reply("resolve");
    await vi.waitFor(() =>
      expect(worker.postMessage.mock.calls.at(-1)?.[0].action).toBe(
        "loadLanguage",
      ),
    );
    expect(
      worker.postMessage.mock.calls.at(-1)?.[0].payload.options,
    ).toMatchObject({
      langPath: "https://test.local/ocr/",
      gzip: true,
      lstmOnly: true,
    });
    controller.abort();
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker and returns a readable error on model download failure", async () => {
    const { recognizeCard } = await import("./recognition");
    const promise = recognizeCard(
      {} as HTMLCanvasElement,
      "pokemon",
      new AbortController().signal,
      vi.fn(),
    );
    const assertion = expect(promise).rejects.toThrow("could not load");
    const worker = FakeWorker.instances[0];
    worker.reply("resolve");
    await vi.waitFor(() =>
      expect(worker.postMessage.mock.calls.at(-1)?.[0].action).toBe(
        "loadLanguage",
      ),
    );
    worker.reply("reject", "Network failure");
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates immediately on the 90-second initialization timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { href: "https://test.local/" },
    });
    try {
      const { recognizeCard } = await import("./recognition");
      const promise = recognizeCard(
        {} as HTMLCanvasElement,
        "pokemon",
        new AbortController().signal,
        vi.fn(),
      );
      const assertion = expect(promise).rejects.toThrow("took too long");
      const worker = FakeWorker.instances[0];
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the expected worker protocol and returns actual worker text without inventing matches", async () => {
    const { recognizeCard } = await import("./recognition");
    const canvas = {
      width: 100,
      height: 140,
      getContext: () => ({
        drawImage: vi.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        putImageData: vi.fn(),
      }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(new Blob(["image-bytes"], { type: "image/png" })),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    const promise = recognizeCard(
      canvas as unknown as HTMLCanvasElement,
      "pokemon",
      new AbortController().signal,
      vi.fn(),
    );
    const worker = FakeWorker.instances[0];
    for (const action of [
      "load",
      "loadLanguage",
      "initialize",
      "setParameters",
    ]) {
      await vi.waitFor(() =>
        expect(worker.postMessage.mock.calls.at(-1)?.[0].action).toBe(action),
      );
      worker.reply("resolve");
    }
    await vi.waitFor(() =>
      expect(worker.postMessage.mock.calls.at(-1)?.[0].action).toBe(
        "recognize",
      ),
    );
    const payload = worker.postMessage.mock.calls.at(-1)?.[0].payload;
    expect(payload.image).toBeInstanceOf(Uint8Array);
    expect(payload.output).toEqual({ text: true });
    worker.reply("resolve", { text: "BASIC\nHP 60\nPikachu", confidence: 95 });
    await expect(promise).resolves.toEqual({
      text: "BASIC\nHP 60\nPikachu",
      candidates: ["Pikachu"],
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("Pokémon metadata after cleanup", () => {
  it("rejects labels revealed by stage, HP, or delimiter cleanup", () => {
    expect(
      extractNameCandidates(
        "Basic Pokémon\nPokémon 60 HP\nPokémon |\nSTAGE 2 Supporter",
        "pokemon",
      ),
    ).toEqual([]);
    expect(extractNameCandidates("Basic Pokémon\nTEL", "pokemon")).toEqual([
      "TEL",
    ]);
  });
  it("preserves short real names and names containing a generic label", () => {
    expect(
      extractNameCandidates("Mew\nMuk\nPokémon Center Lady", "pokemon"),
    ).toEqual(["Mew", "Muk", "Pokémon Center Lady"]);
  });
});

describe("weak Pokémon title retry", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { href: "https://test.local/" },
    });
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    {
      name: "replaces a noisy broad crop with a clearer header",
      reads: [
        { text: "Basic Pokémon\nTEL\n60 HP 2)", confidence: 66 },
        { text: "Basic Pokémon\nPikachu\n60 HP 2", confidence: 88 },
      ],
      expected: ["Pikachu"],
    },
    {
      name: "does not discard a useful short name when later passes are empty",
      reads: [
        { text: "Mew", confidence: 50 },
        { text: "", confidence: 0 },
        { text: "", confidence: 0 },
      ],
      expected: ["Mew"],
    },
    {
      name: "falls through to the full image when both header readings are weak",
      reads: [
        { text: "TEL", confidence: 30 },
        { text: "", confidence: 0 },
        { text: "Basic Pokémon\nPikachu", confidence: 90 },
      ],
      expected: ["Pikachu"],
    },
  ])("$name", async ({ reads, expected }) => {
    const { recognizeCard } = await import("./recognition");
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(16) }));
    const canvas = {
      width: 600,
      height: 825,
      getContext: () => ({ drawImage, getImageData, putImageData: vi.fn() }),
      toBlob: (cb: (blob: Blob) => void) =>
        cb(new Blob(["png"], { type: "image/png" })),
    };
    vi.stubGlobal("document", { createElement: () => ({ ...canvas }) });
    const promise = recognizeCard(
      canvas as unknown as HTMLCanvasElement,
      "pokemon",
      new AbortController().signal,
      vi.fn(),
    );
    const worker = FakeWorker.instances[0];
    for (const action of [
      "load",
      "loadLanguage",
      "initialize",
      "setParameters",
    ]) {
      await vi.waitFor(() =>
        expect(worker.postMessage.mock.calls.at(-1)?.[0].action).toBe(action),
      );
      worker.reply("resolve");
    }
    for (let i = 0; i < reads.length; i++) {
      await vi.waitFor(() =>
        expect(
          worker.postMessage.mock.calls.filter(
            (call) => call[0].action === "recognize",
          ),
        ).toHaveLength(i + 1),
      );
      worker.reply("resolve", reads[i]);
    }
    await expect(promise).resolves.toMatchObject({ candidates: expected });
    expect(drawImage.mock.calls[0][4]).toBe(198);
    expect(drawImage.mock.calls[1][4]).toBe(116);
    expect(getImageData).toHaveBeenCalledTimes(1); // Retry preserves color.
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
