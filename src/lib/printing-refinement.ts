import type { ReferenceMetadata, VisionGame } from "./vision/types";
import type { PrintingCatalogProvenance } from "./printing-evidence";
import {
  measurePrintingRegions,
  validPrintingPixels,
  PRINTING_REGION_LIMITS,
} from "./printing-regions";
import type { PrintingRegionEvidence } from "./printing-regions";

/** Pinned configuration identity, not runtime verification of downloaded asset bytes. */
export const PRINTING_READER_VERSION =
  "tesseract-6.0.1-eng-4.0.0-oem1-psm11+7-dpi300-regions-v2";

/** Catalog metadata must describe the actual printed field, not a guessed alias. */
export interface PrintingCandidate extends ReferenceMetadata {
  /** Pokémon/MTG printed abbreviation; Yu-Gi-Oh's full printed code, e.g. LOB-EN001. */
  setCode?: string;
  /** Literal denominator (including TG/GG/SV prefixes), not the API's total card count. */
  printedTotal?: string | number;
  /** Printed language marker, or its catalog equivalent, e.g. en / EN. */
  locale?: string;
  rarity?: string;
  /** Only explicit edition evidence can match an edition-specific catalog record. */
  edition?: string;
}

export interface PrintingCapture {
  jobId: string;
  sessionId: string;
  eventId: string;
  /** ID of the ORIGINAL capture. Reuse for every crop/resize/pass of that capture. */
  frameId: string;
  capturedAt: number;
  game: VisionGame;
}
export interface PrintingFields {
  collectorNumber?: string;
  printedTotal?: string;
  setCode?: string;
  locale?: string;
  edition?: string;
  /** MTG's explicitly printed rarity letter only. Never a foil/finish inference. */
  rarity?: string;
}
export interface PrintingObservation extends PrintingCapture {
  /** Hash of the source pixels. Matching hashes cannot provide distinct-capture votes. */
  imageFingerprint: string;
  rawText: string;
  fields: PrintingFields;
  issues: string[];
  /** Optional for legacy observations; identifies the configured local reader. */
  readerVersion?: string;
  regions?: PrintingRegionEvidence[];
}
export interface PrintingResolution {
  state: "unresolved" | "catalog-printing-read";
  /** Catalog record only. This is NEVER verification of finish or condition. */
  reference?: PrintingCandidate;
  reasons: string[];
  evidence: PrintingObservation[];
  catalogProvenance?: PrintingCatalogProvenance;
  finish: "unknown";
  condition: "unknown";
  priceEligible: false;
  /** Fields that this evidence did not establish, including scope/variant caveats. */
  unconfirmed: ("language" | "edition" | "rarity" | "finish" | "condition")[];
}
export interface ResolvePrintingInput {
  game: VisionGame;
  sessionId: string;
  eventId: string;
  identityName: string;
  identityKey?: string;
  candidates: readonly PrintingCandidate[];
  /**
   * True ONLY when all known same-identity catalog printings and catalogued
   * edition/rarity alternatives were fetched, including pagination. Catalog scope
   * is not proof of physical language/edition/finish; see result.unconfirmed. A tiny reference gallery, image shortlist,
   * incomplete provider response or name-suggestion result cannot establish this.
   */
  catalogCompleteForIdentity: boolean;
  observations: readonly PrintingObservation[];
  catalogProvenance?: PrintingCatalogProvenance;
}

export const PRINTING_LIMITS = Object.freeze({
  rawText: 2048,
  candidates: 2500,
  observations: 8,
  minSourceEdge: 480,
  maxPixels: 12_000_000,
  timeoutMs: 35_000,
  idleMs: 60_000,
  minFrameGapMs: 100,
});
const LANGUAGES = new Set([
  "EN",
  "DE",
  "FR",
  "IT",
  "ES",
  "SP",
  "PT",
  "JA",
  "JP",
  "KO",
  "KR",
  "RU",
  "ZHS",
  "ZHT",
  "CN",
  "TC",
  "SC",
  "NL",
]);
const rarityNames: Record<string, string> = {
  C: "common",
  U: "uncommon",
  R: "rare",
  M: "mythic",
  L: "land",
  T: "token",
};
const compact = (value: string) => value.normalize("NFKC").trim().toUpperCase();
const numberKey = (value: string) =>
  compact(value).replace(/^([A-Z]*?)0+(?=\d)/, "$1");
const nameKey = (value: string) =>
  value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
const localeKey = (value: string) =>
  ({ JA: "JP", KO: "KR", SP: "ES" })[compact(value)] ?? compact(value);

/** Literal OCR parsing only: no O→0, guessed set symbols, or catalog-conditioned repair. */
export function parsePrintingObservation(
  input: PrintingCapture & {
    rawText: string;
    imageFingerprint: string;
    readerVersion?: string;
    regions?: PrintingRegionEvidence[];
  },
): PrintingObservation {
  const rawText = input.rawText.slice(0, PRINTING_LIMITS.rawText);
  const fields: PrintingFields = {};
  const issues: string[] = [];
  if (input.rawText.length > PRINTING_LIMITS.rawText)
    issues.push("ocr-text-truncated");
  const found = new Map<keyof PrintingFields, Set<string>>();
  function add(key: keyof PrintingFields, value: string) {
    const values = found.get(key) ?? new Set<string>();
    values.add(value);
    found.set(key, values);
  }
  // Joined OCR is display-only when source regions are available. Parse each
  // region separately so whitespace cannot join partial tokens from unrelated
  // crops (for example, "4" and "/102") into an identifier never read in one ROI.
  // Legacy observations without region records retain their original parser.
  const texts = input.regions?.length
    ? input.regions.map((region) => {
        const text = region.rawText ?? "";
        if (
          (region.rawTextTruncated || text.length > PRINTING_LIMITS.rawText) &&
          !issues.includes("ocr-text-truncated")
        )
          issues.push("ocr-text-truncated");
        return text.slice(0, PRINTING_LIMITS.rawText);
      })
    : [rawText];
  for (const regionText of texts) {
    const text = regionText.normalize("NFKC").replace(/[–−]/g, "-");
    for (const match of text.matchAll(
      /\b(1ST\s+EDITION|LIMITED\s+EDITION|UNLIMITED\s+EDITION)\b/gi,
    ))
      add("edition", compact(match[1]).replace(/\s+/g, " "));

    if (input.game === "yugioh") {
      // Accept actual hyphens only, with no speculative OCR correction or prefix expansion.
      for (const match of text.matchAll(
        /(?<![A-Z0-9])([A-Z0-9]{2,8})-([A-Z0-9]{1,8})(?![A-Z0-9])/g,
      )) {
        const marker = match[2].slice(0, 2);
        const locale = LANGUAGES.has(marker) ? marker : undefined;
        const collector = locale ? match[2].slice(2) : match[2];
        // Preserve literal legacy/promo prefixes such as E003, Y10 and SV3.
        // A digit-letter-digit OCR confusion such as 0O1 is not repaired.
        if (!/^[A-Z]*\d{1,4}$/.test(collector)) continue;
        add("setCode", match[0]);
        add("collectorNumber", numberKey(collector));
        if (locale) add("locale", localeKey(locale));
      }
    } else {
      for (const match of text.matchAll(
        /(?<![A-Za-z0-9])((?:TG|GG|SV|RC|H|SL|SH)?\d{1,4}[a-z]?)\s*\/\s*((?:TG|GG|SV|RC|H|SL|SH)?\d{1,4})(?![A-Za-z0-9])/g,
      )) {
        add("collectorNumber", numberKey(match[1]));
        add("printedTotal", numberKey(match[2]));
      }
      // A printed abbreviation is accepted only beside a literal language marker,
      // on a short isolated footer line. Symbols are never converted into set names.
      for (const line of text.split(/\r?\n/).slice(0, 35)) {
        const setLine = line
          .trim()
          .match(/^([A-Z][A-Z0-9]{1,5})\s*(?:[•·*|]\s*|\s+)([A-Z]{2,3})$/);
        if (setLine && LANGUAGES.has(setLine[2])) {
          add("setCode", setLine[1]);
          add("locale", localeKey(setLine[2]));
        }
        if (input.game === "mtg") {
          const collector = line
            .trim()
            .match(
              /^(?:([CURMLT])\s+)?(\d{1,4}[a-z]?)(?:\s*\/\s*(\d{1,4}))?(?:\s*([CURMLT]))?$/,
            );
          if (collector) {
            add("collectorNumber", numberKey(collector[2]));
            if (collector[3]) add("printedTotal", numberKey(collector[3]));
            if (collector[1]) add("rarity", rarityNames[collector[1]]);
            if (collector[4]) add("rarity", rarityNames[collector[4]]);
          }
        }
      }
    }
  }
  for (const [key, values] of found) {
    if (values.size > 1) issues.push(`conflicting-${key}`);
    else fields[key] = [...values][0];
  }
  return { ...input, rawText, fields, issues };
}

function requiredFields(game: VisionGame, fields: PrintingFields): boolean {
  if (game === "pokemon")
    return !!fields.collectorNumber && !!fields.printedTotal;
  if (game === "mtg")
    return !!fields.collectorNumber && !!fields.setCode && !!fields.locale;
  return !!fields.collectorNumber && !!fields.setCode;
}
function signature(fields: PrintingFields) {
  return JSON.stringify(
    Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
  );
}
/** Catalog compatibility only; never sufficient to accept a printing. */
export function printingCandidateRelation(
  candidate: PrintingCandidate,
  fields: PrintingFields,
): "match" | "unknown" | "mismatch" {
  let unknown = false;
  const values: PrintingFields = {
    collectorNumber:
      candidate.number === undefined ? undefined : numberKey(candidate.number),
    printedTotal:
      candidate.printedTotal === undefined
        ? undefined
        : numberKey(String(candidate.printedTotal)),
    setCode: candidate.setCode ? compact(candidate.setCode) : undefined,
    locale: candidate.locale ? localeKey(candidate.locale) : undefined,
    edition: candidate.edition ? compact(candidate.edition) : undefined,
    rarity: candidate.rarity
      ? nameKey(candidate.rarity).replace(/^mythic rare$/, "mythic")
      : undefined,
  };
  for (const key of Object.keys(fields) as (keyof PrintingFields)[]) {
    if (values[key] === undefined) unknown = true;
    else if (values[key] !== fields[key]) return "mismatch";
  }
  // The absence of an edition stamp is not evidence for an unlimited printing.
  if (candidate.edition && !fields.edition) unknown = true;
  return unknown ? "unknown" : "match";
}

/**
 * The caller owns event/session liveness and durable storage. Two different OCR
 * passes, crops or resizes of one photograph are ONE observation, not two votes.
 * This resolver never establishes physical finish, condition or a value total.
 */
export function resolvePrintingEvidence(
  input: ResolvePrintingInput,
): PrintingResolution {
  const evidence = input.observations
    .slice(-PRINTING_LIMITS.observations)
    .filter(
      (observation) =>
        observation.game === input.game &&
        observation.eventId === input.eventId &&
        observation.sessionId === input.sessionId,
    );
  const unresolved = (...reasons: string[]): PrintingResolution => ({
    state: "unresolved",
    reasons,
    evidence,
    ...(input.catalogProvenance
      ? { catalogProvenance: input.catalogProvenance }
      : {}),
    finish: "unknown",
    condition: "unknown",
    priceEligible: false,
    unconfirmed: ["language", "edition", "rarity", "finish", "condition"],
  });
  if (!input.catalogCompleteForIdentity)
    return unresolved("catalog-coverage-incomplete");
  if (!input.identityName.trim() || !input.candidates.length)
    return unresolved("identity-catalog-missing");
  if (input.candidates.length > PRINTING_LIMITS.candidates)
    return unresolved("catalog-candidate-limit");
  const keys = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.key || keys.has(candidate.key))
      return unresolved("catalog-duplicate-or-missing-key");
    keys.add(candidate.key);
    if (
      candidate.game !== input.game ||
      nameKey(candidate.name) !== nameKey(input.identityName) ||
      (input.identityKey &&
        candidate.identityKey &&
        candidate.identityKey !== input.identityKey)
    )
      return unresolved("catalog-identity-mismatch");
  }
  if (
    evidence.some((observation) =>
      observation.issues.some((issue) => issue.startsWith("conflicting-")),
    )
  )
    return unresolved("conflicting-observations");
  const good = evidence.filter(
    (observation) =>
      !observation.issues.length &&
      observation.frameId &&
      observation.imageFingerprint &&
      Number.isFinite(observation.capturedAt) &&
      requiredFields(input.game, observation.fields),
  );
  if (!good.length) return unresolved("no-unambiguous-footer-evidence");
  // Do not cherry-pick agreeing frames around a readable contradiction.
  if (
    new Set(good.map((observation) => signature(observation.fields))).size !== 1
  )
    return unresolved("conflicting-observations");
  const first = good[0];
  // Distinct source IDs/pixels are not calibrated statistical independence:
  // adjacent near-duplicate captures can share errors. This legacy gate alone
  // cannot establish physical-variant certainty or eliminate that correlation.
  const distinct = good.find(
    (other) =>
      other.frameId !== first.frameId &&
      other.imageFingerprint !== first.imageFingerprint &&
      Math.abs(other.capturedAt - first.capturedAt) >=
        PRINTING_LIMITS.minFrameGapMs,
  );
  if (!distinct) return unresolved("two-distinct-captures-required");
  const matches: PrintingCandidate[] = [];
  let incomplete = false;
  for (const candidate of input.candidates) {
    const relation = printingCandidateRelation(candidate, first.fields);
    if (relation === "unknown") incomplete = true;
    if (relation === "match") matches.push(candidate);
  }
  if (incomplete) return unresolved("catalog-fields-incomplete");
  if (matches.length !== 1)
    return unresolved(
      matches.length
        ? "printing-or-variant-ambiguous"
        : "no-catalog-printing-match",
    );
  return {
    state: "catalog-printing-read",
    reference: matches[0],
    reasons: [
      "two-distinct-captures-agree",
      "catalog-fields-match",
      "finish-and-condition-unconfirmed",
    ],
    evidence,
    ...(input.catalogProvenance
      ? { catalogProvenance: input.catalogProvenance }
      : {}),
    finish: "unknown",
    condition: "unknown",
    priceEligible: false,
    unconfirmed: [
      ...(!first.fields.locale ? ["language" as const] : []),
      ...(!first.fields.edition ? ["edition" as const] : []),
      ...(!first.fields.rarity ? ["rarity" as const] : []),
      "finish",
      "condition",
    ],
  };
}

export interface PrintingReadInput extends PrintingCapture {
  image: ImageData | HTMLCanvasElement;
  /** Native source-quad shorter edge BEFORE rectification/resizing. Not output width. */
  sourceMinEdge: number;
  signal: AbortSignal;
}
export interface PrintingReader {
  /** Busy rejects immediately; callers may retry a later frame. No hidden queue. */
  read(input: PrintingReadInput): Promise<PrintingObservation>;
  /** Cancels only this reader, never the primary vision worker. Safe to repeat. */
  dispose(): void;
  readonly busy: boolean;
}
export class PrintingReaderError extends Error {
  constructor(
    public readonly code:
      "busy" | "disposed" | "timeout" | "image-quality" | "reader-failed",
    message: string,
  ) {
    super(message);
    this.name = "PrintingReaderError";
  }
}
interface WorkerPacket {
  jobId: string;
  status: "resolve" | "reject" | "progress";
  data: unknown;
}
interface Pending {
  jobId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface ActiveJob {
  token: object;
  stop: (error: Error) => void;
}
const cancelled = () =>
  new DOMException("Printing read cancelled", "AbortError");

/** Same-origin, pinned Tesseract 6.0.1 protocol. No user-provided asset URL or remote OCR. */
export function createPrintingReader(
  options: { timeoutMs?: number; idleMs?: number } = {},
): PrintingReader {
  const timeoutMs = Math.max(
    100,
    Math.min(options.timeoutMs ?? PRINTING_LIMITS.timeoutMs, 90_000),
  );
  const idleMs = Math.max(
    100,
    Math.min(options.idleMs ?? PRINTING_LIMITS.idleMs, 300_000),
  );
  let worker: Worker | undefined;
  let pending: Pending | undefined;
  let active: ActiveJob | undefined;
  let initialized = false;
  let disposed = false;
  let sequence = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function terminate() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    initialized = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    if (pending) {
      const request = pending;
      pending = undefined;
      request.reject(cancelled());
    }
  }
  function check(token: object, signal: AbortSignal) {
    if (disposed || signal.aborted || active?.token !== token)
      throw cancelled();
  }
  function request(
    token: object,
    signal: AbortSignal,
    action: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
  ) {
    check(token, signal);
    return new Promise<unknown>((resolve, reject) => {
      if (!worker || pending) {
        reject(
          new PrintingReaderError(
            "reader-failed",
            "Printing reader is unavailable.",
          ),
        );
        return;
      }
      const jobId = `printing-${++sequence}`;
      pending = { jobId, resolve, reject };
      try {
        worker.postMessage(
          { workerId: "tcg-printing-reader", jobId, action, payload },
          transfer,
        );
      } catch {
        active?.stop(
          new PrintingReaderError(
            "reader-failed",
            "Printing reader could not receive the image.",
          ),
        );
      }
    });
  }
  async function initialize(token: object, signal: AbortSignal) {
    if (initialized) return;
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    if (
      base.origin !== window.location.origin ||
      !/^https?:$/.test(base.protocol)
    )
      throw new PrintingReaderError(
        "reader-failed",
        "Printing assets must use this app's origin.",
      );
    worker = new Worker(new URL("ocr/worker.min.js", base).href, {
      name: "tcg-printing-reader",
    });
    const thisWorker = worker;
    worker.onmessage = (event: MessageEvent<WorkerPacket>) => {
      if (
        worker !== thisWorker ||
        !pending ||
        !event.data ||
        event.data.jobId !== pending.jobId
      )
        return;
      const message = event.data;
      if (message.status === "progress") return;
      if (message.status === "reject") {
        active?.stop(
          new PrintingReaderError(
            "reader-failed",
            "The local printing reader could not read this capture.",
          ),
        );
      } else if (message.status === "resolve") {
        const current = pending;
        pending = undefined;
        current.resolve(message.data);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      active?.stop(
        new PrintingReaderError(
          "reader-failed",
          "The local printing reader could not start.",
        ),
      );
    };
    worker.onmessageerror = () =>
      active?.stop(
        new PrintingReaderError(
          "reader-failed",
          "The local printing reader was interrupted.",
        ),
      );
    const path = new URL("ocr/", base).href;
    await request(token, signal, "load", {
      options: { lstmOnly: true, corePath: path },
    });
    await request(token, signal, "loadLanguage", {
      langs: "eng",
      options: {
        langPath: path,
        gzip: true,
        lstmOnly: true,
        // Do not reuse unrelated-origin/version language data from Tesseract's default cache.
        cacheMethod: "none",
      },
    });
    await request(token, signal, "initialize", {
      langs: "eng",
      oem: 1,
      config: {},
    });
    check(token, signal);
    initialized = true;
  }
  async function perform(
    input: PrintingReadInput,
    token: object,
  ): Promise<PrintingObservation> {
    const { image, signal } = input;
    check(token, signal);
    const { width, height } = image;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 480 ||
      height < 640 ||
      width * height > PRINTING_LIMITS.maxPixels ||
      !Number.isFinite(input.sourceMinEdge) ||
      input.sourceMinEdge < PRINTING_LIMITS.minSourceEdge
    )
      throw new PrintingReaderError(
        "image-quality",
        "Printing needs a higher-resolution native card crop.",
      );
    if (
      !input.jobId ||
      !input.sessionId ||
      !input.eventId ||
      !input.frameId ||
      !Number.isFinite(input.capturedAt)
    )
      throw new PrintingReaderError(
        "reader-failed",
        "Printing capture provenance is missing.",
      );
    // Snapshot immediately. A live canvas may otherwise change while OCR loads.
    const full = document.createElement("canvas");
    full.width = width;
    full.height = height;
    const context = full.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new PrintingReaderError(
        "reader-failed",
        "This browser cannot prepare a printing crop.",
      );
    let pixels: ImageData;
    try {
      if ("data" in image) {
        if (!validPrintingPixels(image))
          throw new PrintingReaderError(
            "image-quality",
            "Invalid printing RGBA pixels.",
          );
        context.putImageData(image, 0, 0);
      } else context.drawImage(image, 0, 0);
      pixels = context.getImageData(0, 0, width, height);
      if (
        pixels.width !== width ||
        pixels.height !== height ||
        !validPrintingPixels(pixels)
      )
        throw new PrintingReaderError(
          "image-quality",
          "Invalid printing RGBA pixels.",
        );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        // Hash only this view; a nonzero byteOffset must not include unrelated pixels.
        pixels.data,
      );
      check(token, signal);
      const imageFingerprint =
        `${width}x${height}:` +
        Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      // Measure the same snapshot before OCR: no selection based on its answer.
      const regions = measurePrintingRegions(pixels, {
        ...input,
        imageFingerprint,
      });
      await initialize(token, signal);
      const texts: string[] = [];
      for (const region of regions) {
        check(token, signal);
        const crop = document.createElement("canvas");
        // Native ROI geometry is retained separately. A bounded 2× resample may
        // help this reader consume small text; it never adds native evidence.
        crop.width = region.outputWidth;
        crop.height = region.outputHeight;
        try {
          const cropContext = crop.getContext("2d");
          if (!cropContext) throw new Error("Canvas unavailable");
          cropContext.drawImage(
            full,
            region.x,
            region.y,
            region.width,
            region.height,
            0,
            0,
            crop.width,
            crop.height,
          );
          const bytes = await new Promise<Uint8Array>((resolve, reject) => {
            crop.toBlob((blob) => {
              if (!blob) {
                reject(new Error("Image encoding failed"));
                return;
              }
              void blob
                .arrayBuffer()
                .then((buffer) => resolve(new Uint8Array(buffer)), reject);
            }, "image/png");
          });
          check(token, signal);
          // Set each region explicitly: the persistent worker must not leak the
          // single-line mode into a broad region or the next game's capture.
          await request(token, signal, "setParameters", {
            params: {
              tessedit_pageseg_mode: String(region.pageSegmentationMode ?? 11),
              user_defined_dpi: "300",
            },
          });
          const data = await request(
            token,
            signal,
            "recognize",
            { image: bytes, options: {}, output: { text: true } },
            [bytes.buffer as ArrayBuffer],
          );
          check(token, signal);
          if (
            !data ||
            typeof data !== "object" ||
            !("text" in data) ||
            typeof data.text !== "string"
          )
            throw new Error("Invalid OCR result");
          region.rawText = data.text.slice(0, PRINTING_REGION_LIMITS.rawText);
          region.rawTextTruncated =
            data.text.length > PRINTING_REGION_LIMITS.rawText;
          texts.push(data.text.slice(0, PRINTING_LIMITS.rawText + 1));
        } finally {
          crop.width = 0;
          crop.height = 0;
        }
      }
      return parsePrintingObservation({
        jobId: input.jobId,
        sessionId: input.sessionId,
        eventId: input.eventId,
        frameId: input.frameId,
        capturedAt: input.capturedAt,
        game: input.game,
        imageFingerprint,
        rawText: texts.join("\n"),
        readerVersion: PRINTING_READER_VERSION,
        regions,
      });
    } finally {
      full.width = 0;
      full.height = 0;
    }
  }
  return {
    get busy() {
      return !!active;
    },
    async read(input) {
      if (disposed)
        throw new PrintingReaderError(
          "disposed",
          "Printing reader has been disposed.",
        );
      if (input.signal.aborted) throw cancelled();
      if (active)
        throw new PrintingReaderError(
          "busy",
          "Printing reader is busy; skip this frame.",
        );
      if (idleTimer) clearTimeout(idleTimer);
      const token = {};
      let rejectStopped: (error: Error) => void = () => undefined;
      const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
      });
      const stop = (error: Error) => {
        if (active?.token !== token) return;
        // Invalidate before termination, so late canvas/hash callbacks cannot restart OCR.
        active = undefined;
        rejectStopped(error);
        terminate();
      };
      active = { token, stop };
      const abort = () => stop(cancelled());
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () =>
          stop(
            new PrintingReaderError(
              "timeout",
              "Local printing read timed out.",
            ),
          ),
        timeoutMs,
      );
      try {
        const result = await Promise.race([perform(input, token), stopped]);
        check(token, input.signal);
        return result;
      } catch (error) {
        if (active?.token === token) terminate();
        throw error;
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (active?.token === token) active = undefined;
        if (!active && !disposed && worker)
          idleTimer = setTimeout(terminate, idleMs);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.stop(cancelled());
      terminate();
    },
  };
}
