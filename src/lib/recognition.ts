import type { Game } from "../types";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateImageFile(
  file: Pick<File, "type" | "size">,
): string | null {
  if (!IMAGE_TYPES.has(file.type))
    return "Choose a JPG, PNG, or WebP image. For HEIC photos, export a JPG first.";
  if (file.size === 0)
    return "This image is empty. Please choose another photo.";
  if (file.size > MAX_IMAGE_BYTES)
    return "This image is too large. Choose a photo smaller than 15 MB.";
  return null;
}

/** Suggestions only: never treats OCR text as a verified catalog identity. */
export function extractNameCandidates(text: string, game: Game): string[] {
  const candidates: string[] = [];
  const lines = text
    .normalize("NFKC")
    .split(/[\r\n]+/)
    .slice(0, 35);
  for (const raw of lines) {
    let line = raw
      .replace(/[™®©]/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (game === "pokemon") {
      if (
        /^(?:pok[eé]mon|energy|trainer|item|supporter|stadium|ability)\s*[:·]?$/i.test(
          line,
        )
      )
        continue;
      if (
        /^(?:evolves? from|put .+ on|weakness|resistance|retreat|illus\.?|illustrator|rule box|[vV](?:star|max)? rule)\b/i.test(
          line,
        )
      )
        continue;
      line = line
        .replace(
          /^(?:basic|stage\s*[12]|restored|[vV](?:star|max))\s*[:·|]?\s*/i,
          "",
        )
        .replace(/\s*(?:HP\s*\d{1,4}|\d{1,4}\s*HP)\b.*$/i, "")
        .replace(/\s+HP\s*$/i, "")
        .replace(/\s+\d{2,4}\s*$/, "")
        .trim();
    } else if (game === "mtg") {
      if (
        /^(?:(?:legendary|basic|snow|artifact|enchantment|creature|instant|sorcery|land|planeswalker|battle|token)\b(?:.*[—–]|\s*$)|(?:flying|trample|haste|vigilance|lifelink|deathtouch|reach|flash|ward|defender)\s*$|illustrated by|illus\.?|copyright|wizards of)/i.test(
          line,
        )
      )
        continue;
      line = line
        .replace(/\s*(?:\{[\w/]+\}\s*)+$/g, "")
        .replace(/\s+\d{1,2}\s*$/, "")
        .trim();
    } else {
      if (
        /^(?:\[|spell card|trap card|monster card|spellcaster|dragon\s*\/|warrior\s*\/|atk\s*[/:]|def\s*[/:]|1st edition|limited edition|konami|kazuki|this card|if this|you can)\b/i.test(
          line,
        )
      )
        continue;
      line = line
        .replace(/\s*\[(?:spell|trap|.*?\/.*?)\s*(?:card)?\].*$/i, "")
        .trim();
    }
    line = line.replace(/^[|:;-]+|[|:;-]+$/g, "").trim();
    if (line.length < 3 || line.length > 65 || !/[\p{L}]{2}/u.test(line))
      continue;
    if (
      /^(?:basic|stage\s*\d|hp|energy|trainer|spell|trap|[\d\s/.-]+)$/i.test(
        line,
      )
    )
      continue;
    if (
      /\d{2,}\/\d{2,}|\b(?:damage|opponent|discard|attach|shuffle|draw|copyright)\b/i.test(
        line,
      )
    )
      continue;
    if (line.split(" ").length > 9 || /[{}<>\\]/.test(line)) continue;
    // Text-heavy rules boxes should not outrank title text.
    if (
      /[!?]\s+[A-Z]/.test(line) ||
      /\b(?:your|their|whenever|choose|during|target|controls?)\b/i.test(line)
    )
      continue;
    if (
      !candidates.some(
        (candidate) =>
          candidate.toLocaleLowerCase() === line.toLocaleLowerCase(),
      )
    )
      candidates.push(line);
    if (candidates.length === 5) break;
  }
  return candidates;
}

export interface RecognitionProgress {
  label: string;
  progress: number;
}
export interface RecognitionResult {
  text: string;
  candidates: string[];
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
}

/** Downscales very large images and enhances the title without hard thresholding. */
export function prepareImage(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  if (width < 32 || height < 32)
    throw new Error(
      "This image is too small to read. Choose a sharper, larger photo.",
    );
  if (width * height > 40_000_000)
    throw new Error(
      "This image is too large to process safely. Resize it below 40 megapixels.",
    );
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(
      "Your browser could not prepare this image. Try another browser.",
    );
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function prepareTitle(image: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const cropHeight = Math.max(1, Math.round(image.height * 0.24));
  const scale = Math.min(3, 1600 / image.width);
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(cropHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return image;
  context.drawImage(
    image,
    0,
    0,
    image.width,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray =
      pixels.data[i] * 0.299 +
      pixels.data[i + 1] * 0.587 +
      pixels.data[i + 2] * 0.114;
    const enhanced = Math.max(0, Math.min(255, (gray - 128) * 1.25 + 128));
    pixels.data[i] = enhanced;
    pixels.data[i + 1] = enhanced;
    pixels.data[i + 2] = enhanced;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

interface WorkerPacket {
  jobId: string;
  status: "resolve" | "reject" | "progress";
  data: unknown;
}

function canvasBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("This browser could not prepare the card photo."));
        return;
      }
      void blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}

/**
 * Images remain on-device. Only the English language model is downloaded.
 *
 * We own the native worker BEFORE initialization so even a stalled first-load
 * model fetch can be terminated immediately. Tesseract 6 createWorker hides its
 * native handle until initialization finishes. This small protocol adapter is
 * matched to the pinned tesseract.js 6.0.1 worker (see src/createWorker.js).
 */
export async function recognizeCard(
  image: HTMLCanvasElement,
  game: Game,
  signal: AbortSignal,
  onProgress: (progress: RecognitionProgress) => void,
): Promise<RecognitionResult> {
  throwIfAborted(signal);
  const base = new URL(import.meta.env.BASE_URL, window.location.href).href;
  const worker = new Worker(`${base}ocr/worker.min.js`, {
    name: "tcg-card-reader",
  });
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let phase = "loading";
  let stopped = false;
  let sequence = 0;
  let rejectStopped: (error: Error) => void = () => undefined;
  const stopPromise = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  const stop = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    const reason = error ?? new DOMException("Scan ended", "AbortError");
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    if (error) rejectStopped(error);
  };
  const abort = () => stop(new DOMException("Scan cancelled", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(
    () =>
      stop(
        new Error(
          "The card reader took too long. Check your connection for the first model download, or try a smaller photo.",
        ),
      ),
    90_000,
  );

  worker.onmessage = (event: MessageEvent<WorkerPacket>) => {
    if (stopped) return;
    const message = event.data;
    if (message.status === "progress") {
      const data = message.data as { status?: string; progress?: number };
      const fraction = Math.max(0, Math.min(1, data.progress || 0));
      if (data.status === "recognizing text") {
        onProgress({
          label:
            phase === "title"
              ? "Reading the card title…"
              : "Reading the rest of the card…",
          progress:
            phase === "title" ? 0.35 + fraction * 0.35 : 0.72 + fraction * 0.25,
        });
      } else if (data.status?.includes("language")) {
        onProgress({
          label: "Loading English reader (downloads on first scan)…",
          progress: 0.08 + fraction * 0.2,
        });
      }
      return;
    }
    const request = pending.get(message.jobId);
    if (!request) return;
    if (message.status === "reject") {
      stop(
        new Error(
          phase === "loading"
            ? "The on-device reader could not load. Check your internet connection, then try again."
            : "This photo could not be read. Try a sharper photo or search by name.",
        ),
      );
    } else {
      pending.delete(message.jobId);
      request.resolve(message.data);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stop(
      new Error(
        "The on-device reader could not start. Check your connection or try another browser.",
      ),
    );
  };
  worker.onmessageerror = () =>
    stop(new Error("The card reader was interrupted. Please try again."));

  function request<T = unknown>(
    action: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    throwIfAborted(signal);
    if (stopped)
      return Promise.reject(new DOMException("Scan ended", "AbortError"));
    return new Promise((resolve, reject) => {
      const jobId = `scan-${++sequence}`;
      pending.set(jobId, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage(
          { workerId: "tcg-reader", jobId, action, payload },
          transfer,
        );
      } catch {
        stop(
          new Error(
            "The card reader could not receive this photo. Please try again.",
          ),
        );
      }
    });
  }

  async function work(): Promise<RecognitionResult> {
    onProgress({ label: "Loading on-device card reader…", progress: 0.04 });
    await request("load", {
      options: { lstmOnly: true, corePath: `${base}ocr/` },
    });
    await request("loadLanguage", {
      langs: "eng",
      options: {
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        gzip: true,
        lstmOnly: true,
      },
    });
    await request("initialize", { langs: "eng", oem: 1, config: {} });
    await request("setParameters", {
      params: { tessedit_pageseg_mode: "11", user_defined_dpi: "300" },
    });
    phase = "title";
    const titleBytes = await canvasBytes(prepareTitle(image));
    throwIfAborted(signal);
    const title = await request<{ text: string }>(
      "recognize",
      { image: titleBytes, options: {}, output: { text: true } },
      [titleBytes.buffer as ArrayBuffer],
    );
    let text = title.text;
    let candidates = extractNameCandidates(text, game);
    if (!candidates.length) {
      phase = "full";
      const fullBytes = await canvasBytes(image);
      throwIfAborted(signal);
      const full = await request<{ text: string }>(
        "recognize",
        { image: fullBytes, options: {}, output: { text: true } },
        [fullBytes.buffer as ArrayBuffer],
      );
      text = full.text;
      candidates = extractNameCandidates(text, game);
    }
    onProgress({
      label: candidates.length
        ? "Title read. Check the catalog matches."
        : "No clear title found.",
      progress: 1,
    });
    return { text, candidates };
  }

  try {
    return await Promise.race([work(), stopPromise]);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    stop();
  }
}
