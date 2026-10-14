import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronRight,
  Download,
  FolderOpen,
  Pause,
  Play,
  ScanLine,
  Square,
  Undo2,
  Upload,
} from "lucide-react";
import type { Game } from "../types";
import { VisionClient } from "../lib/vision";
import type {
  CardDetection,
  ReferenceMetadata,
  VisionCoverage,
  VisionResult,
  Quad,
} from "../lib/vision";
import { ScanSession } from "../lib/scan-session";
import type { ScanMode, ScanTrack } from "../lib/scan-session";
import {
  importReferencePack,
  listReferencePacks,
  loadReferencePack,
  loadPrebuiltPackManifest,
  installPrebuiltPack,
  removeReferencePack,
} from "../lib/reference-packs";
import type {
  PrebuiltPackEntry,
  StoredPackMetadata,
} from "../lib/reference-packs";
import {
  importLearnedPack,
  listLearnedPacks,
  removeLearnedPack,
} from "../lib/learned-packs";
import type {
  LearnedImportProgress,
  LearnedPackMetadata,
} from "../lib/learned-packs";
import { importLearnedArchive } from "../lib/learned-archive";
import {
  installPokemonDatabase,
  usesStaticDatabaseInstall,
} from "../lib/database-install";
import {
  POKEMON_REFERENCE_RELEASE,
  type PokemonReferenceDownloadStatus,
} from "../lib/pokemon-reference-release";
import { referenceCard } from "../lib/scan-inventory";
import { ReferenceQuotes } from "./ReferenceQuotes";
import { PrintingEvidenceDetails } from "./PrintingEvidenceDetails";
import {
  cameraFailureMessage,
  scannerTrackPresentation,
} from "./continuous-scanner-ui";
import { preflightImage } from "../lib/image-header";
import {
  CaptureCompatibilityError,
  CaptureRateLimitError,
  CaptureResolutionError,
  FrameCapture,
} from "../lib/frame-capture";
import { PrintingSession } from "../lib/printing-session";
import type { PrintingResolution } from "../lib/printing-refinement";
import { getPrintingCandidates } from "../lib/printing-catalog";
import { pendingPrintingTracks } from "../lib/printing-scheduler";
import { captureClock, LiveCaptureLoop } from "../lib/live-capture";
import { LiveVideoSource } from "../lib/live-video-source";
import { holdLiveVideoInput } from "../lib/live-input-hold";
import type { LiveCaptureContext } from "../lib/live-capture";
import type { ScanContinuityPolicy } from "../lib/scan-session";
import "./continuous-scanner.css";
import type { AppPreferences } from "../lib/app-preferences";
import { diagnostics } from "../lib/diagnostics";
import { printingDiagnosticFields } from "../lib/printing-diagnostics";
import type { ScannerLifecycle } from "../lib/scanner-lifecycle";

type Props = {
  game: Game;
  preferences: AppPreferences;
  onSessionState?(state: ScannerLifecycle): void;
  onFindCard?(): void;
  onPreferencesChange(patch: Partial<AppPreferences>): void;
  onSave: (reference: ReferenceMetadata, eventId: string) => string | undefined;
  onUndo: (eventId: string) => string | undefined;
  onPrinting: (
    eventId: string,
    resolution: PrintingResolution,
  ) => string | undefined;
};
type Saved = {
  eventId: string;
  reference: ReferenceMetadata;
  undone?: boolean;
  printingStatus?: string;
  printingReference?: ReferenceMetadata;
  /** Bounded text/measurements only, retired with this receipt or Undo. */
  printingResolution?: PrintingResolution;
};
const EMPTY: VisionCoverage = {
  totalReferences: 0,
  byGame: { pokemon: 0, mtg: 0, yugioh: 0 },
  packs: [],
};
const trackNumber = (track: ScanTrack) =>
  track.id.startsWith("photo")
    ? String(Number(track.id.slice(5)) + 1)
    : track.id.split(":").at(-1);
const statusGlyph = (status: ScanTrack["status"]) =>
  status === "added"
    ? "✓"
    : status === "undone"
      ? "↶"
      : status === "quality" || status === "error"
        ? "!"
        : status === "review"
          ? "?"
          : "…";
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export default function ContinuousScanner({
  game,
  onSave,
  onUndo,
  onPrinting,
  preferences,
  onPreferencesChange,
  onSessionState,
  onFindCard,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const frameCapture = useRef<FrameCapture | null>(null);
  const liveCapture = useRef<LiveCaptureLoop | null>(null);
  const client = useRef<VisionClient | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileSource = useRef<LiveVideoSource | null>(null);
  const [sourceKind, setSourceKind] = useState<"camera" | "video">("camera");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const frameEpoch = useRef(0);
  const running = useRef(false);
  const pausedRef = useRef(false);
  const inputHeldRef = useRef(false);
  const [inputHeld, setInputHeld] = useState(false);
  const autoRef = useRef(preferences.autoSave);
  const session = useRef<ScanSession | null>(null);
  const printing = useRef<PrintingSession | null>(null);
  const printedEvents = useRef(new Set<string>());
  const captureSequence = useRef(0);
  const newSessionPending = useRef(false);
  const callbacks = useRef({ onSave, onUndo, onPrinting });
  useEffect(() => {
    callbacks.current = { onSave, onUndo, onPrinting };
  }, [onSave, onUndo, onPrinting]);
  const [mode, setMode] = useState<ScanMode>(preferences.liveMode);
  const [savePolicy, setSavePolicy] = useState<ScanContinuityPolicy>(
    preferences.savePolicy,
  );
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState(preferences.autoSave);
  const [busy, setBusy] = useState(false);
  const [photoPreparing, setPhotoPreparing] = useState(false);
  const [cameraPreparing, setCameraPreparing] = useState(false);
  const [message, setMessage] = useState(
    "Hold cards still with all four edges in view. Wait for Added before moving on.",
  );
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: "" });
  const announce = (text: string) =>
    setAnnouncement((old) => ({ sequence: old.sequence + 1, text }));
  useEffect(() => {
    if (error)
      setAnnouncement((old) => ({ sequence: old.sequence + 1, text: error }));
  }, [error]);
  const [coverage, setCoverage] = useState<VisionCoverage>(EMPTY);
  const [packs, setPacks] = useState<StoredPackMetadata[]>([]);
  const [packsReady, setPacksReady] = useState(false);
  const [learnedPacks, setLearnedPacks] = useState<LearnedPackMetadata[]>([]);
  const [matcher, setMatcher] = useState<"orb" | "learned">("orb");
  const activeMatcher = useRef<"orb" | "learned">("orb");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<LearnedImportProgress>();
  const [downloadProgress, setDownloadProgress] =
    useState<PokemonReferenceDownloadStatus>();
  const [importFeedback, setImportFeedback] = useState("");
  const importController = useRef<AbortController | null>(null);
  const [available, setAvailable] = useState<PrebuiltPackEntry[]>([]);
  const [tracks, setTracks] = useState<ScanTrack[]>([]);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [mediaSize, setMediaSize] = useState({ width: 1280, height: 720 });
  const [saved, setSaved] = useState<Saved[]>([]);
  const receiptEvents = useRef(new Map<string, boolean>());
  const [sessionCount, setSessionCount] = useState(0);
  const [timings, setTimings] = useState<VisionResult["timings"]>();
  const [captureTransport, setCaptureTransport] = useState("videoframe-pool");
  const [photo, setPhoto] = useState<string>();
  const [tightPhoto, setTightPhoto] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const photoUrl = useRef<string | undefined>(undefined);
  const [photoMatches, setPhotoMatches] = useState<CardDetection[]>([]);
  const photoEvents = useRef(new WeakMap<CardDetection, string>());
  const [packOpen, setPackOpen] = useState(false);
  const refreshPacks = useCallback(
    async (includeLegacy = false) => {
      try {
        const learned = await listLearnedPacks();
        setLearnedPacks(learned);
        // The learned catalog is metadata-only. Avoid reading legacy JSON feature
        // shards merely to paint the scanner when a learned pack is ready.
        if (
          includeLegacy ||
          !learned.some((p) => p.readiness === "ready" && p.byGame[game] > 0)
        )
          setPacks(await listReferencePacks());
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setPacksReady(true);
      }
    },
    [game],
  );
  useEffect(() => {
    void refreshPacks();
    const c = new AbortController();
    const lifecycleGeneration = generation;
    void loadPrebuiltPackManifest(c.signal)
      .then((m) => setAvailable(m.packs))
      .catch(() => {});
    return () => {
      c.abort();
      importController.current?.abort();
      printing.current?.dispose();
      liveCapture.current?.dispose();
      liveCapture.current = null;
      lifecycleGeneration.current++;
      fileSource.current?.dispose();
      fileSource.current = null;
      running.current = false;
      if (timer.current) clearTimeout(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
      client.current?.dispose();
      frameCapture.current?.dispose();
      frameCapture.current = null;
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    };
  }, [refreshPacks]);
  const cancelPrintingStatus = useCallback(() => {
    printing.current?.cancel();
    setSaved((old) =>
      old.map((item) =>
        item.printingStatus === "Reading printed identifiers locally…"
          ? {
              ...item,
              printingStatus:
                "Printing read cancelled. Saved identity is unchanged.",
            }
          : item,
      ),
    );
  }, []);
  const pause = useCallback(() => {
    inputHeldRef.current = false;
    setInputHeld(false);
    cancelPrintingStatus();
    liveCapture.current?.pause();
    fileSource.current?.pause();
    frameEpoch.current++;
    session.current?.interruptEvidence();
    if (timer.current) clearTimeout(timer.current);
    pausedRef.current = true;
    setPaused(true);
    setMessage("Paused. Existing tracks remain counted.");
  }, [cancelPrintingStatus]);
  const stop = useCallback(() => {
    inputHeldRef.current = false;
    setInputHeld(false);
    liveCapture.current?.dispose();
    liveCapture.current = null;
    cancelPrintingStatus();
    printing.current?.dispose();
    printing.current = null;
    generation.current++;
    running.current = false;
    pausedRef.current = false;
    if (timer.current) clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    fileSource.current?.dispose();
    fileSource.current = null;
    if (video.current) video.current.srcObject = null;
    client.current?.dispose();
    client.current = null;
    frameCapture.current?.dispose();
    frameCapture.current = null;
    session.current?.releasePixels();
    if (!newSessionPending.current)
      setTracks(session.current?.snapshot() ?? []);
    newSessionPending.current = false;
    setActive(false);
    setPaused(false);
    setBusy(false);
    setPhotoPreparing(false);
    setCameraPreparing(false);
    setMessage("Session ended. Start a new session to scan again.");
  }, [cancelPrintingStatus]);
  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return;
      if (newSessionPending.current) {
        stop();
        setMessage(
          "Preparation cancelled while this tab was hidden. Your previous session is kept.",
        );
      } else if (running.current) pause();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [pause, stop]);
  async function prepare(gen: number) {
    if (gen !== generation.current) throw new Error("Session cancelled.");
    const local = new VisionClient();
    const check = () => {
      if (gen !== generation.current) {
        local.dispose();
        throw new Error("Session cancelled.");
      }
    };
    client.current?.dispose();
    client.current = local;
    const learned = await listLearnedPacks();
    check();
    const useLearned = learned.some(
      (p) => p.readiness === "ready" && p.byGame[game] > 0,
    );
    setMatcher(useLearned ? "learned" : "orb");
    activeMatcher.current = useLearned ? "learned" : "orb";
    setMessage(
      useLearned
        ? "Starting local learned recognition…"
        : "Starting compatibility OpenCV recognition…",
    );
    const ready = await local.initialize(
      { matcher: useLearned ? "learned" : "orb", game },
      (progress) => {
        if (gen === generation.current) setMessage(progress);
      },
    );
    check();
    if (useLearned) {
      setCoverage(ready.coverage);
      return local;
    }
    const installed = await listReferencePacks();
    check();
    let next = EMPTY;
    for (const p of installed) {
      check();
      if (!p.byGame[game] || p.readiness !== "ready") continue;
      setMessage(`Loading ${p.name} locally…`);
      const pack = await loadReferencePack(p.id);
      check();
      if (pack) next = await local.loadPack(pack);
    }
    check();
    setCoverage(next);
    return local;
  }
  function save(reference: ReferenceMetadata, eventId: string) {
    const failure = callbacks.current.onSave(reference, eventId);
    if (failure) {
      setError(failure);
      return failure;
    }
    if (!receiptEvents.current.has(eventId)) {
      receiptEvents.current.set(eventId, true);
      const total = [...receiptEvents.current.values()].filter(Boolean).length;
      setSessionCount(total);
      setSaved((old) => [{ eventId, reference }, ...old].slice(0, 30));
      announce(`Added ${reference.name}. ${total} saved this session.`);
    }
    return failure;
  }
  function undoSaved(item: Saved) {
    if (item.undone || receiptEvents.current.get(item.eventId) !== true) return;
    const failure = callbacks.current.onUndo(item.eventId);
    if (failure) {
      setError(failure);
      return;
    }
    // onUndo is synchronous: retire work before yielding, but do not reset
    // the existing prompt budget when durable removal fails.
    printing.current?.forget(item.eventId);
    session.current?.undo(item.eventId);
    setTracks((old) =>
      old.map((track) =>
        track.eventId === item.eventId
          ? { ...track, counted: false, status: "undone", message: "Undone" }
          : track,
      ),
    );
    setSaved((old) =>
      old.map((entry) =>
        entry.eventId === item.eventId
          ? {
              ...entry,
              undone: true,
              printingResolution: undefined,
              printingStatus: undefined,
            }
          : entry,
      ),
    );
    receiptEvents.current.set(item.eventId, false);
    const total = [...receiptEvents.current.values()].filter(Boolean).length;
    setSessionCount(total);
    announce(`Undid ${item.reference.name}. ${total} saved this session.`);
  }
  function preparePrinting(gen: number) {
    printing.current?.dispose();
    printing.current = new PrintingSession({
      catalog: getPrintingCandidates,
      onDiagnostics: (eventId, resolution) => {
        if (
          gen !== generation.current ||
          receiptEvents.current.get(eventId) !== true
        )
          return;
        diagnostics.record(
          "printing",
          "scan",
          printingDiagnosticFields(resolution),
        );
        setSaved((old) =>
          gen !== generation.current ||
          receiptEvents.current.get(eventId) !== true
            ? old
            : old.map((item) =>
                item.eventId === eventId && !item.undone
                  ? { ...item, printingResolution: resolution }
                  : item,
              ),
        );
      },
      isCurrent: (f) =>
        gen === generation.current &&
        running.current &&
        !pausedRef.current &&
        session.current?.id === f.sessionId &&
        !!session.current
          .snapshot()
          .find(
            (t) =>
              t.eventId === f.eventId &&
              t.status === "added" &&
              t.counted &&
              t.reference?.name === f.reference.name,
          ),
      onGuidance: (eventId, message) => {
        if (
          gen !== generation.current ||
          receiptEvents.current.get(eventId) !== true
        )
          return;
        const track = session.current
          ?.snapshot()
          .find((item) => item.eventId === eventId);
        if (track?.reference) announce(`${track.reference.name}. ${message}`);
      },
      onStatus: (eventId, status) =>
        setSaved((old) =>
          gen !== generation.current ||
          receiptEvents.current.get(eventId) !== true
            ? old
            : old.map((item) =>
                item.eventId === eventId && !item.undone
                  ? { ...item, printingStatus: status }
                  : item,
              ),
        ),
      onResolution: (eventId, resolution) => {
        if (
          gen !== generation.current ||
          !running.current ||
          pausedRef.current ||
          receiptEvents.current.get(eventId) !== true ||
          resolution.evidence.some(
            (observation) =>
              observation.eventId !== eventId ||
              observation.sessionId !== session.current?.id,
          )
        )
          return "Printing read cancelled. Saved identity is unchanged.";
        const failure = callbacks.current.onPrinting(eventId, resolution);
        if (!failure) {
          printedEvents.current.add(eventId);
          setSaved((old) =>
            gen !== generation.current ||
            receiptEvents.current.get(eventId) !== true
              ? old
              : old.map((item) =>
                  item.eventId === eventId && !item.undone
                    ? { ...item, printingReference: resolution.reference }
                    : item,
                ),
          );
        }
        return failure;
      },
    });
  }
  function offerPrinting(
    snapshot: ScanTrack[],
    capturedAt: number,
    frameId: string,
    scan: ScanSession,
  ) {
    if (inputHeldRef.current) return;
    for (const track of snapshot) {
      const evidence = track.evidence;
      if (
        track.visible &&
        track.status === "added" &&
        track.reference &&
        !printedEvents.current.has(track.eventId) &&
        printing.current?.ready(track.eventId, capturedAt) &&
        evidence?.autoEligible &&
        evidence.printingCrop &&
        (evidence.printingSourceMinEdge ?? 0) >= 480 &&
        evidence.candidates[0]?.reference.name === track.reference.name
      ) {
        void printing.current.offer({
          sessionId: scan.id,
          eventId: track.eventId,
          frameId,
          capturedAt,
          reference: track.reference,
          image: evidence.printingCrop,
          sourceMinEdge: evidence.printingSourceMinEdge!,
        });
        if (printing.current.busy) break;
      }
    }
  }
  async function learnedFrame(
    context: LiveCaptureContext,
    local: VisionClient,
    gen: number,
  ) {
    const epoch = frameEpoch.current,
      scan = session.current;
    const current = () =>
      context.isCurrent() &&
      gen === generation.current &&
      epoch === frameEpoch.current &&
      running.current &&
      !pausedRef.current &&
      !inputHeldRef.current &&
      session.current === scan;
    if (!scan || !current()) return;
    const { capturedAt, image, transport } = context.capture;
    const printingTargets = printing.current?.busy
      ? []
      : pendingPrintingTracks(
          scan.snapshot(),
          printedEvents.current,
          (eventId) => printing.current?.ready(eventId, capturedAt) === true,
        );
    try {
      const result = await local.analyze(image, {
        game,
        mode,
        maxCards: mode === "binder" ? 9 : 3,
        budgetMs: 750,
        previewBurstObservations: savePolicy === "fast" ? 1 : 3,
        includePrintingCrops: printingTargets.length > 0,
        maxPrintingCrops: 1,
        printingRegions: printingTargets.slice(0, 2).map((t) => t.quad),
      });
      if (!current()) return;
      setSize({ width: result.width, height: result.height });
      setTimings(result.timings);
      const update = scan.update(result, capturedAt, false);
      if (update.resetAfterEmpty) printing.current?.cancel();
      const candidates =
        autoRef.current && transport === "videoframe-pool"
          ? scan.continuityCandidates(savePolicy)
          : [];
      const candidateIds = new Set(candidates.map((c) => c.eventId));
      setTracks(
        scan.snapshot().map((t) =>
          candidateIds.has(t.eventId)
            ? {
                ...t,
                status: "stabilizing",
                message: "Strong match · checking the current card view",
              }
            : t,
        ),
      );
      if (candidates.length && context.history.status.open) {
        // Capture continues independently while the worker matches. These are
        // real ordered samples, never copies relabeled as fresh identity votes.
        while (
          current() &&
          context.history.status.open &&
          context.history.status.recordedFrames < 3
        )
          await new Promise((resolve) => setTimeout(resolve, 40));
        const batchId = `${scan.id}:${epoch}:${context.frameId}`;
        let first = true;
        const pending = new Map(
          candidates.map((candidate) => [candidate.eventId, candidate]),
        );
        while (
          current() &&
          autoRef.current &&
          context.history.status.open &&
          pending.size
        ) {
          const frames = context.history.drain(context.historyToken);
          if (!frames?.length) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            continue;
          }
          const latest = frames.at(-1)!;
          const seeds = first
            ? candidates.map((candidate) => ({
                eventId: candidate.eventId,
                quad: candidate.quad.map((p) => ({
                  x: (p.x * context.graySize.width) / result.width,
                  y: (p.y * context.graySize.height) / result.height,
                })) as Quad,
              }))
            : undefined;
          const checked = await local.verifyContinuity({
            batchId,
            ...(seeds ? { seeds } : {}),
            frames,
            latestFrameId: latest.frameId,
            latestTimestampMs: latest.timestampMs,
          });
          first = false;
          if (!current() || checked.batchId !== batchId) return;
          const newest = context.latest();
          for (const proof of checked.results) {
            const candidate = proof.eventId
              ? pending.get(proof.eventId)
              : undefined;
            if (!candidate) continue;
            if (proof.status === "rejected") {
              scan.rejectContinuity(
                candidate,
                proof.reason === "preview-clipped"
                  ? "Move the whole card farther inside the frame"
                  : proof.reason === "insufficient-features"
                    ? "Need clearer card detail · improve focus and lighting"
                    : proof.reason === "sample-gap" ||
                        proof.reason === "missing-frame" ||
                        proof.reason === "history-overflow" ||
                        proof.reason === "duration-overflow"
                      ? "Camera check interrupted · checking a fresh view"
                      : undefined,
              );
              pending.delete(candidate.eventId);
              continue;
            }
            if (
              proof.status !== "continuous" ||
              !newest ||
              newest.frameId !== proof.latestFrameId ||
              newest.timestampMs !== proof.latestTimestampMs
            )
              continue;
            const nativeProof = {
              ...proof,
              latestQuad: proof.latestQuad.map((p) => ({
                x: (p.x * result.width) / context.graySize.width,
                y: (p.y * result.height) / context.graySize.height,
              })) as Quad,
            };
            const intent = scan.commitContinuity(candidate, nativeProof, {
              autoSave: autoRef.current,
              now: captureClock(),
              seedFrameId: context.frameId,
              latestCapture: newest,
            });
            if (intent) {
              if (current()) {
                const failure = save(intent.reference, intent.eventId);
                scan.acknowledge(intent.eventId, failure);
              } else {
                scan.cancelUnsavedIntent(intent);
              }
              pending.delete(candidate.eventId);
            }
          }
          setTracks(scan.snapshot());
        }
        if (current())
          for (const candidate of pending.values())
            scan.rejectContinuity(candidate);
      }
      if (!current()) return;
      offerPrinting(
        scan.snapshot(),
        capturedAt,
        `${gen}:${context.frameId}`,
        scan,
      );
      setMessage(
        transport === "compatibility"
          ? "Compatibility preview only: automatic current-view verification needs a current browser. Use assisted photo capture to save."
          : result.detections.length
            ? `${result.detections.length} card regions · fresh local matches and current-view checks`
            : "Looking for card edges. Keep cards separated, flat and well lit.",
      );
    } finally {
      scan.releasePixels();
      if (current()) setTracks(scan.snapshot());
      if (!local.busy) await local.resetContinuity().catch(() => {});
    }
  }
  async function frame(gen: number, epoch = frameEpoch.current) {
    if (
      !running.current ||
      gen !== generation.current ||
      epoch !== frameEpoch.current
    )
      return;
    if (
      !pausedRef.current &&
      !inputHeldRef.current &&
      video.current &&
      video.current.readyState >= 2 &&
      client.current &&
      !frameCapture.current?.busy &&
      !client.current.busy
    ) {
      const v = video.current;
      // Preserve more source detail for small binder slots; feature extraction
      // still runs on bounded canonical crops in the worker.
      const frameLimit = mode === "binder" ? 2880 : 1920;
      const local = client.current;
      try {
        const capture = (frameCapture.current ??= new FrameCapture());
        const pixels = await capture.capture(v, frameLimit, (bytes) =>
          local.takeFrameBuffer(bytes),
        );
        if (
          gen !== generation.current ||
          epoch !== frameEpoch.current ||
          !running.current ||
          pausedRef.current ||
          inputHeldRef.current
        )
          return;
        setCaptureTransport(pixels.transport);
        const capturedAt = pixels.capturedAt,
          frameId = `${gen}:${++captureSequence.current}`;
        const printingTargets = printing.current?.busy
          ? []
          : (session.current?.snapshot() ?? []).filter(
              (t) =>
                t.visible &&
                t.status === "added" &&
                !printedEvents.current.has(t.eventId) &&
                printing.current?.ready(t.eventId, capturedAt),
            );
        const result = await local.analyze(pixels.image, {
          game,
          mode,
          maxCards: mode === "binder" ? 9 : 3,
          budgetMs: 750,
          includePrintingCrops: printingTargets.length > 0,
          maxPrintingCrops: 1,
          printingRegions: printingTargets.slice(0, 2).map((t) => t.quad),
        });
        if (
          gen !== generation.current ||
          epoch !== frameEpoch.current ||
          !running.current ||
          pausedRef.current ||
          inputHeldRef.current
        )
          return;
        setSize({ width: result.width, height: result.height });
        setTimings(result.timings);
        const update = session.current!.update(
          result,
          performance.now(),
          autoRef.current,
        );
        for (const intent of update.additions) {
          const failure = save(intent.reference, intent.eventId);
          session.current!.acknowledge(intent.eventId, failure);
        }
        const snapshot = session.current!.snapshot();
        if (update.resetAfterEmpty) printing.current?.cancel();
        for (const track of snapshot) {
          const evidence = track.evidence;
          if (
            track.visible &&
            track.status === "added" &&
            track.reference &&
            !printedEvents.current.has(track.eventId) &&
            printing.current?.ready(track.eventId, capturedAt) &&
            evidence?.autoEligible &&
            evidence.printingCrop &&
            (evidence.printingSourceMinEdge ?? 0) >= 480 &&
            evidence.candidates[0]?.reference.name === track.reference.name
          ) {
            void printing.current?.offer({
              sessionId: session.current!.id,
              eventId: track.eventId,
              frameId,
              capturedAt,
              reference: track.reference,
              image: evidence.printingCrop,
              sourceMinEdge: evidence.printingSourceMinEdge!,
            });
            if (printing.current?.busy) break;
          }
        }
        session.current!.releasePixels();
        setTracks(session.current!.snapshot());
        setMessage(
          update.resetAfterEmpty
            ? "Ready for the next physical copy."
            : result.detections.length
              ? `${result.detections.length} card region${result.detections.length === 1 ? "" : "s"} · ${result.coverage.byGame[game].toLocaleString()} local references`
              : "Looking for card edges. Keep cards separated, flat and well lit.",
        );
      } catch (e) {
        if (gen === generation.current && epoch === frameEpoch.current) {
          if (!(e instanceof CaptureRateLimitError)) {
            if (
              e instanceof CaptureCompatibilityError ||
              e instanceof CaptureResolutionError
            )
              stop();
            else pause();
            setError(errorMessage(e));
          }
        }
      }
    }
    if (
      running.current &&
      !pausedRef.current &&
      !inputHeldRef.current &&
      gen === generation.current &&
      epoch === frameEpoch.current
    ) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => void frame(gen, epoch),
        frameCapture.current?.minimumIntervalMs ?? 120,
      );
    }
  }
  async function start(file?: File) {
    if (
      busy ||
      active ||
      newSessionPending.current ||
      !packsReady ||
      !installedCount
    )
      return;
    newSessionPending.current = true;
    diagnostics.reset("live");
    diagnostics.reset("printing");
    setTimings(undefined);
    setCameraPreparing(true);
    setSourceKind(file ? "video" : "camera");
    setMessage(
      file
        ? "Opening local test video. You can cancel preparation at any time."
        : "Waiting for camera access. You can cancel preparation at any time.",
    );
    setBusy(true);
    setError("");
    frameCapture.current?.dispose();
    frameCapture.current = null;
    setCaptureTransport("videoframe-pool");
    const gen = ++generation.current;
    let openingCamera = !file;
    try {
      const element = video.current;
      if (!element) throw new Error("The video preview is unavailable.");
      if (file) {
        const source = new LiveVideoSource(
          element,
          () => {
            if (gen !== generation.current) return;
            const preparing = newSessionPending.current;
            stop();
            setMessage(
              preparing
                ? "Video ended during preparation. Your previous session is kept."
                : "Test video ended. Saved cards remain in your collection.",
            );
          },
          (error) => {
            if (gen !== generation.current) return;
            stop();
            setError(error.message);
          },
        );
        fileSource.current = source;
        await source.open(file, mode === "binder" ? 2880 : 1920);
      } else {
        if (!window.isSecureContext)
          throw new Error(
            "Camera access needs HTTPS or localhost. Open this app on a secure address, or use a multi-card photo.",
          );
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "This browser does not support camera access. Try a current browser, or use a multi-card photo.",
          );
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: {
              ideal: mode === "binder" ? 2880 : 1920,
              max: mode === "binder" ? 2880 : 1920,
            },
            height: {
              ideal: mode === "binder" ? 1620 : 1080,
              max: mode === "binder" ? 2880 : 1920,
            },
          },
          audio: false,
        });
        if (gen !== generation.current) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = media;
        running.current = true;
        setActive(true);
        for (const t of media.getVideoTracks()) {
          t.onended = () => {
            if (running.current && gen === generation.current) {
              pause();
              setError("Camera disconnected. Stop and restart to reconnect.");
            }
          };
          t.onmute = () => {
            if (running.current && gen === generation.current) {
              pause();
              setError(
                "Camera frames interrupted. Resume only when the camera is available again.",
              );
            }
          };
        }
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play();
        }
      }
      if (gen !== generation.current) return;
      openingCamera = false;
      const local = await prepare(gen);
      if (gen !== generation.current) return;
      if (file && !(await fileSource.current?.play())) return;
      if (gen !== generation.current) return;
      running.current = true;
      pausedRef.current = false;
      inputHeldRef.current = false;
      setInputHeld(false);
      setPaused(false);
      setActive(true);
      // Commit a new session only after permission, playback and model readiness.
      // Cancelled/failed preparation leaves the previous subtotal and receipts intact.
      session.current = new ScanSession(
        crypto.randomUUID(),
        mode,
        1200,
        "explicit",
      );
      setPhoto(undefined);
      setPhotoMatches([]);
      setTracks([]);
      setSaved([]);
      receiptEvents.current.clear();
      setSessionCount(0);
      setShowUnmatched(false);
      printedEvents.current.clear();
      preparePrinting(gen);
      newSessionPending.current = false;
      setBusy(false);
      setCameraPreparing(false);
      setMessage(
        activeMatcher.current === "learned"
          ? savePolicy === "fast"
            ? "Scanning continuously. Strong matches get a fresh current-view check before saving."
            : "Scanning continuously. Three identity checks plus a fresh current-view check before saving."
          : "Scanning continuously. Hold each card still for three verified observations.",
      );
      if (activeMatcher.current === "learned" && video.current) {
        const loop = new LiveCaptureLoop({
          video: video.current,
          client: local,
          frameLimit: mode === "binder" ? 2880 : 1920,
          onFrame: (context) => learnedFrame(context, local, gen),
          onTransport: (transport) => {
            if (gen === generation.current) setCaptureTransport(transport);
          },
          onError: (e) => {
            if (gen !== generation.current) return;
            if (
              e instanceof CaptureCompatibilityError ||
              e instanceof CaptureResolutionError
            )
              stop();
            else pause();
            setError(errorMessage(e));
          },
        });
        liveCapture.current?.dispose();
        liveCapture.current = loop;
        loop.start();
      } else void frame(gen);
    } catch (e) {
      if (gen === generation.current) {
        stop();
        setError(openingCamera ? cameraFailureMessage(e) : errorMessage(e));
      }
    }
  }
  function holdTestInput() {
    const source = fileSource.current;
    if (
      !source ||
      !running.current ||
      pausedRef.current ||
      newSessionPending.current ||
      inputHeldRef.current
    )
      return;
    inputHeldRef.current = true;
    setInputHeld(true);
    holdLiveVideoInput({
      source,
      capture: liveCapture.current,
      interruptEvidence: () => {
        frameEpoch.current++;
        session.current?.interruptEvidence();
      },
      cancelPendingFrame: () => {
        if (timer.current) clearTimeout(timer.current);
      },
    });
    setMessage(
      "Test input held. Already-started printing reads can finish; no new views are captured. Resume test input when ready.",
    );
  }
  async function resume() {
    const gen = generation.current;
    const epoch = frameEpoch.current;
    try {
      if (fileSource.current && !(await fileSource.current.play())) return;
      if (
        gen !== generation.current ||
        epoch !== frameEpoch.current ||
        !running.current
      )
        return;
      pausedRef.current = false;
      inputHeldRef.current = false;
      setInputHeld(false);
      setPaused(false);
      setError("");
      setMessage(
        sourceKind === "video"
          ? "Playing local test video at 1×."
          : "Scanning resumed.",
      );
      if (liveCapture.current) liveCapture.current.resume();
      else void frame(gen);
    } catch (error) {
      if (gen !== generation.current || epoch !== frameEpoch.current) return;
      pause();
      setError(errorMessage(error));
    }
  }
  async function importPacks(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError("");
    setImportFeedback("Installing compatibility references in this browser…");
    try {
      for (const f of Array.from(files)) await importReferencePack(f);
      await refreshPacks(true);
      setMessage(
        "Reference packs installed in this browser. Start the camera to load them.",
      );
      setImportFeedback("Compatibility references installed in this browser.");
    } catch (e) {
      setError(errorMessage(e));
      setImportFeedback(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function importLearnedFiles(files: FileList | null, archive = false) {
    if (!files?.length || active || importController.current) return;
    const gen = ++generation.current;
    const controller = new AbortController();
    importController.current = controller;
    setBusy(true);
    setImporting(true);
    setImportProgress(undefined);
    setDownloadProgress(undefined);
    setImportFeedback(
      archive
        ? "Checking the reference ZIP. No extraction is needed…"
        : "Checking the selected manifest and binary shards…",
    );
    setError("");
    try {
      const options = {
        signal: controller.signal,
        onProgress: (progress: LearnedImportProgress) => {
          if (gen === generation.current) {
            setImportProgress(progress);
            setImportFeedback(progress.text);
          }
        },
      };
      if (archive) await importLearnedArchive(files[0], options);
      else await importLearnedPack(Array.from(files), options);
      if (gen !== generation.current) return;
      await refreshPacks();
      setImportFeedback(
        "Learned references installed in this browser. You can start scanning now.",
      );
      setMessage("References ready. Hold cards still until Added.");
    } catch (e) {
      if (gen === generation.current) {
        if (controller.signal.aborted)
          setImportFeedback(
            "Installation cancelled. Remove any incomplete pack below, then choose the reference ZIP again to retry.",
          );
        else {
          setError(errorMessage(e));
          setImportFeedback(errorMessage(e));
        }
        await refreshPacks();
      }
    } finally {
      if (gen === generation.current) {
        importController.current = null;
        setImporting(false);
        setBusy(false);
      }
    }
  }
  async function installDatabase() {
    if (active || importController.current || game !== "pokemon") return;
    const gen = ++generation.current;
    const controller = new AbortController();
    importController.current = controller;
    setBusy(true);
    setImporting(true);
    setImportProgress(undefined);
    setDownloadProgress(undefined);
    setImportFeedback("Starting the Pokémon database installation…");
    setError("");
    try {
      await installPokemonDatabase({
        signal: controller.signal,
        onDownloadProgress: (progress) => {
          if (gen !== generation.current) return;
          setDownloadProgress(progress);
          setImportFeedback(
            progress.state === "verifying"
              ? "Checking the downloaded database integrity…"
              : progress.state === "ready"
                ? usesStaticDatabaseInstall()
                  ? "Pokémon database installed in this browser."
                  : "Download checked. Installing references in this browser…"
                : `Downloading Pokémon references: ${(progress.downloadedBytes / 1_000_000).toFixed(1)} / ${(progress.totalBytes / 1_000_000).toFixed(1)} MB`,
          );
        },
        onProgress: (progress) => {
          if (gen !== generation.current) return;
          setImportProgress(progress);
          setImportFeedback(progress.text);
        },
      });
      if (gen !== generation.current) return;
      await refreshPacks();
      setImportFeedback("Pokémon database ready. You can start scanning now.");
      setMessage("References ready. Hold cards still until Added.");
    } catch (e) {
      if (gen !== generation.current) return;
      const feedback = controller.signal.aborted
        ? usesStaticDatabaseInstall()
          ? "Installation cancelled. No partial database is ready for scanning. Choose Install Pokémon database to restart the download."
          : "Installation cancelled. The app server keeps the download progress. Choose Install Pokémon database to continue."
        : errorMessage(e);
      setImportFeedback(feedback);
      if (!controller.signal.aborted) setError(feedback);
      await refreshPacks();
    } finally {
      if (gen === generation.current) {
        importController.current = null;
        setImporting(false);
        setBusy(false);
      }
    }
  }
  async function install(p: PrebuiltPackEntry) {
    setBusy(true);
    setError("");
    try {
      await installPrebuiltPack(p);
      await refreshPacks(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function analyzePhoto(file?: File) {
    if (!file || !packsReady || !installedCount) return;
    stop();
    setBusy(true);
    setPhotoPreparing(true);
    diagnostics.reset("live");
    diagnostics.reset("printing");
    setTimings(undefined);
    setShowUnmatched(false);
    setError("");
    setPhotoMatches([]);
    setTracks([]);
    setPhoto(undefined);
    const gen = ++generation.current;
    try {
      if (
        !/^image\/(png|jpeg|webp)$/.test(file.type) ||
        file.size > 20 * 1024 * 1024
      )
        throw new Error("Choose a JPG, PNG or WebP image under 20 MB.");
      await preflightImage(file);
      if (gen !== generation.current) return;
      const bitmap = await createImageBitmap(file);
      if (gen !== generation.current) {
        bitmap.close();
        return;
      }
      const scale = Math.min(
        1,
        4096 / Math.max(bitmap.width, bitmap.height),
        Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        bitmap.close();
        throw new Error("Image processing unavailable.");
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      // Display a bounded local thumbnail rather than decoding the full original
      // again in <img> while the high-resolution worker owns its input.
      const preview = document.createElement("canvas");
      const previewScale = Math.min(
        1,
        1280 / Math.max(canvas.width, canvas.height),
      );
      preview.width = Math.max(1, Math.round(canvas.width * previewScale));
      preview.height = Math.max(1, Math.round(canvas.height * previewScale));
      setMediaSize({ width: preview.width, height: preview.height });
      preview
        .getContext("2d")
        ?.drawImage(canvas, 0, 0, preview.width, preview.height);
      const previewBlob = await new Promise<Blob>((resolve, reject) =>
        preview.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("Image preview unavailable.")),
          "image/jpeg",
          0.9,
        ),
      );
      preview.width = preview.height = 0;
      if (gen !== generation.current) {
        canvas.width = canvas.height = 0;
        return;
      }
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
      photoUrl.current = URL.createObjectURL(previewBlob);
      setPhoto(photoUrl.current);
      let local: VisionClient;
      try {
        local = await prepare(gen);
      } catch (failure) {
        canvas.width = canvas.height = 0;
        throw failure;
      }
      const input = context.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
      const result = await local.analyze(input, {
        game,
        mode: "photo",
        maxCards: 9,
        budgetMs: 15_000,
        region:
          tightPhoto && activeMatcher.current === "orb"
            ? [
                { x: 0, y: 0 },
                { x: input.width - 1, y: 0 },
                { x: input.width - 1, y: input.height - 1 },
                { x: 0, y: input.height - 1 },
              ]
            : undefined,
      });
      if (gen !== generation.current) return;
      setSize({ width: result.width, height: result.height });
      setTimings(result.timings);
      const photoBatch = crypto.randomUUID();
      result.detections.forEach((d, i) =>
        photoEvents.current.set(d, `photo:${photoBatch}:${i}`),
      );
      setPhotoMatches(result.detections.filter((d) => d.autoEligible));
      setTracks(
        result.detections.map((d, i) => ({
          id: `photo${i}`,
          eventId: photoEvents.current.get(d)!,
          quad: d.quad,
          status: d.autoEligible ? "review" : "quality",
          message: d.autoEligible ? "Visual match · ready to save" : d.reason,
          reference: d.autoEligible ? d.candidates[0]?.reference : undefined,
          evidence: d,
          firstSeen: 0,
          lastSeen: 0,
          stableSince: 0,
          stableFrames: 1,
          visible: true,
          counted: false,
        })),
      );
      setMessage(
        `${result.detections.filter((d) => d.autoEligible).length} matched card${result.detections.filter((d) => d.autoEligible).length === 1 ? "" : "s"} · ${result.detections.length} detector regions. ${result.budgetExhausted ? "Some regions need another photo." : "Only identified matches can be saved."}`,
      );
    } catch (e) {
      if (gen === generation.current) setError(errorMessage(e));
    } finally {
      if (gen === generation.current) {
        setBusy(false);
        setPhotoPreparing(false);
      }
    }
  }
  function savePhoto() {
    const remaining: CardDetection[] = [];
    let count = 0;
    for (const d of photoMatches) {
      const eventId = photoEvents.current.get(d);
      if (!eventId) {
        remaining.push(d);
        continue;
      }
      const failure = save(d.candidates[0].reference, eventId);
      if (failure) {
        remaining.push(d);
      } else {
        count++;
        setTracks((old) =>
          old.map((t) =>
            t.eventId === eventId
              ? {
                  ...t,
                  counted: true,
                  status: "added",
                  message: "Added · printing / finish unconfirmed",
                }
              : t,
          ),
        );
      }
    }
    setPhotoMatches(remaining);
    setMessage(
      `${count} visual matches saved with unconfirmed printing, condition and finish.${remaining.length ? ` ${remaining.length} could not be saved; resolve the error before retrying.` : ""}`,
    );
  }
  const readyLegacy = packs.filter(
    (pack) => pack.readiness === "ready" && pack.byGame[game] > 0,
  );
  const readyLearned = learnedPacks.filter(
    (pack) => pack.readiness === "ready" && pack.byGame[game] > 0,
  );
  const legacyCount = readyLegacy.reduce((n, pack) => n + pack.byGame[game], 0);
  const learnedCount = readyLearned.reduce(
    (n, pack) => n + pack.byGame[game],
    0,
  );
  const installedCount = learnedCount || legacyCount;
  const gameName = {
    pokemon: "Pokémon",
    mtg: "Magic: The Gathering",
    yugioh: "Yu-Gi-Oh!",
  }[game];
  const needsSetup = packsReady && installedCount === 0;
  const packPanelOpen = needsSetup || packOpen;
  const officialDatabaseReady = readyLearned.some(
    (pack) => pack.checksum === POKEMON_REFERENCE_RELEASE.manifestSha256,
  );
  const visibleSettled = tracks.filter(
    (track) =>
      track.visible &&
      track.reference &&
      ["added", "undone", "error"].includes(track.status),
  );
  const nextCopyTarget =
    visibleSettled.length === 1 ? visibleSettled[0] : undefined;
  const shownTracks = tracks.filter(
    (track) =>
      track.visible &&
      (!photo || showUnmatched || track.evidence?.autoEligible),
  );
  const unmatchedCount = photo
    ? tracks.filter((track) => track.visible && !track.evidence?.autoEligible)
        .length
    : 0;
  const recentSaved = saved.find((item) => !item.undone);
  const uploadDisabled = busy || active || !packsReady || !installedCount;
  useEffect(() => {
    diagnostics.update("live", {
      game,
      mode: photo ? "photo" : mode,
      matcher,
      savePolicy,
      active,
      paused,
      autoSave: auto,
      busy,
      references: installedCount,
      matcherReferences: coverage.byGame[game],
      tracks: tracks.filter((track) => track.visible).length,
      verified: tracks.filter(
        (track) => track.visible && track.evidence?.autoEligible,
      ).length,
      saved: sessionCount,
      status: error
        ? "failed"
        : busy
          ? "preparing"
          : paused
            ? "paused"
            : inputHeld
              ? "waiting"
              : active
                ? "running"
                : "idle",
      ...(timings
        ? {
            width: size.width,
            height: size.height,
            detectionMs: timings.detectionMs,
            extractionMs: timings.extractionMs,
            matchingMs: timings.matchingMs,
            totalMs: timings.totalMs,
          }
        : {}),
    });
  }, [
    game,
    mode,
    photo,
    matcher,
    savePolicy,
    active,
    paused,
    inputHeld,
    auto,
    busy,
    installedCount,
    coverage,
    tracks,
    sessionCount,
    size,
    error,
    timings,
  ]);
  useEffect(() => {
    diagnostics.record(
      "live",
      error ? "error" : paused ? "pause" : active ? "start" : "stop",
      {
        status: error
          ? "failed"
          : paused
            ? "paused"
            : active
              ? "running"
              : "stopped",
        ...(error ? { reason: "scan-failed" as const } : {}),
      },
    );
  }, [active, paused, error]);
  useEffect(() => {
    onSessionState?.({
      phase: busy
        ? "preparing"
        : paused
          ? "paused"
          : active
            ? "active"
            : photoMatches.length
              ? "review"
              : session.current || sessionCount
                ? "ended"
                : "idle",
      sessionId: session.current?.id ?? null,
      savedCount: sessionCount,
    });
  }, [active, paused, busy, sessionCount, photoMatches.length, onSessionState]);
  useEffect(
    () => () => {
      diagnostics.reset("live");
      diagnostics.reset("printing");
    },
    [],
  );

  const databasePanel = (
    <div
      className={`scanner-setup ${needsSetup ? "needs-setup" : ""} ${packPanelOpen ? "expanded" : ""}`}
    >
      <strong>
        {!packsReady
          ? "Checking installed references…"
          : needsSetup
            ? `Set up ${gameName} recognition`
            : `Ready · ${gameName}`}
      </strong>
      {needsSetup ? (
        <p>
          Install a reference pack once before scanning. Recognition is limited
          to the cards in your installed packs.
        </p>
      ) : installedCount > 0 ? (
        <ul className="coverage-summary">
          {learnedCount
            ? readyLearned.map((pack) => (
                <li key={pack.id}>
                  {pack.name} · {pack.byGame[game].toLocaleString()} references
                  · {pack.byGameNames[game].toLocaleString()} card names
                  <span>
                    {pack.coverage.scope === "full-catalog"
                      ? "Full-catalog source"
                      : "Partial reference coverage"}{" "}
                    · {pack.coverage.missingImages.toLocaleString()} missing
                    images · {pack.coverage.failedImages.toLocaleString()}{" "}
                    extraction failures
                  </span>
                </li>
              ))
            : readyLegacy.map((pack) => (
                <li key={pack.id}>
                  {pack.name} · {pack.byGame[game].toLocaleString()} references
                  <span>
                    {pack.coverage?.scope === "full-catalog"
                      ? "Full-catalog source"
                      : "Partial reference coverage"}
                    {pack.coverage?.shard
                      ? ` · shard ${pack.coverage.shard.index}/${pack.coverage.shard.total}`
                      : ""}
                    . Only installed images can match.
                  </span>
                </li>
              ))}
        </ul>
      ) : null}
      {needsSetup ? (
        <p className="pack-help">
          0 installed references for {gameName}. Install a pack below.
        </p>
      ) : (
        <button
          className="pack-toggle"
          aria-expanded={packPanelOpen}
          aria-controls="scanner-pack-manager"
          onClick={() => {
            setPackOpen(!packOpen);
            if (!packOpen) void refreshPacks(true);
          }}
        >
          <FolderOpen size={16} />
          {installedCount.toLocaleString()} installed references · manage
          offline packs
        </button>
      )}
      {packPanelOpen && (
        <div className="pack-manager" id="scanner-pack-manager">
          {game === "pokemon" && (
            <div className="database-install">
              <button
                className="button primary"
                disabled={
                  active ||
                  busy ||
                  officialDatabaseReady ||
                  !POKEMON_REFERENCE_RELEASE.url
                }
                onClick={() => void installDatabase()}
              >
                <Download size={16} />
                {officialDatabaseReady
                  ? "Pokémon database installed"
                  : "Install Pokémon database"}
              </button>
              <p className="pack-help">
                {usesStaticDatabaseInstall() ? "Up to" : "One-time"}{" "}
                {(
                  (usesStaticDatabaseInstall()
                    ? POKEMON_REFERENCE_RELEASE.referenceBytes
                    : POKEMON_REFERENCE_RELEASE.sizeBytes) / 1_000_000
                ).toFixed(0)}{" "}
                MB download ·{" "}
                {POKEMON_REFERENCE_RELEASE.referenceCount.toLocaleString()}{" "}
                English paper-card references. The app handles every file for
                you.
              </p>
            </div>
          )}
          <details className="pack-compatibility">
            <summary>Use a downloaded reference ZIP</summary>
            <label className="button subtle" aria-disabled={active || busy}>
              <Upload size={16} />
              Install database from ZIP
              <input
                className="sr-only"
                type="file"
                accept="application/zip,.zip"
                disabled={active || busy}
                onChange={(e) => {
                  void importLearnedFiles(e.target.files, true);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="pack-help">
              Choose one complete reference ZIP. The app checks and installs
              everything locally; you don’t need to extract or manage its files.
            </p>
            {POKEMON_REFERENCE_RELEASE.url && game === "pokemon" && (
              <a
                href={POKEMON_REFERENCE_RELEASE.url}
                target="_blank"
                rel="noreferrer"
              >
                Download the complete Pokémon reference ZIP
              </a>
            )}
          </details>
          <details className="pack-compatibility">
            <summary>Advanced: individual reference files</summary>
            <label className="button subtle" aria-disabled={active || busy}>
              <Upload size={16} />
              Install learned reference pack
              <input
                className="sr-only"
                type="file"
                accept="application/json,application/octet-stream,.json,.bin"
                multiple
                disabled={active || busy}
                onChange={(e) => {
                  void importLearnedFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <p>
              Select one learned manifest and all its binary shards together.
            </p>
          </details>
          <p className="pack-storage-help">
            References stay in this browser after reload. Private browsing or
            clearing site data can remove them. Reinstall the Pokémon database
            here if needed; keep any custom reference ZIPs. Back up your
            collection separately.
          </p>
          {(importing || importFeedback) && (
            <div
              className="pack-progress"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span>{importFeedback}</span>
              {importing && downloadProgress && !importProgress && (
                <progress
                  aria-label="Pokémon database download"
                  max={downloadProgress.totalBytes}
                  value={downloadProgress.downloadedBytes}
                />
              )}
              {importing && importProgress && importProgress.total > 0 && (
                <>
                  <progress
                    aria-label="Learned reference installation"
                    max={importProgress.total}
                    value={importProgress.completed}
                  />
                  <span>
                    {importProgress.completed.toLocaleString()} /{" "}
                    {importProgress.total.toLocaleString()} references
                  </span>
                </>
              )}
            </div>
          )}
          {importing && (
            <button
              className="button subtle"
              onClick={() => importController.current?.abort()}
            >
              Cancel installation
            </button>
          )}
          {learnedPacks.map((pack) => (
            <div key={pack.id} className="pack-row">
              <span>
                {pack.name} · {pack.cards.toLocaleString()} learned references ·{" "}
                {(pack.bytes / 1048576).toFixed(1)} MB
                <small>
                  {pack.readiness}
                  {pack.readiness !== "ready"
                    ? " · unavailable for scanning; remove and retry installation"
                    : ""}
                  {pack.error ? ` · ${pack.error}` : ""}
                </small>
              </span>
              <button
                disabled={active || busy}
                onClick={() =>
                  void removeLearnedPack(pack.id)
                    .then(() => refreshPacks(true))
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Remove
              </button>
            </div>
          ))}
          <details className="pack-compatibility">
            <summary>Compatibility import and other reference packs</summary>
            <p>
              Import compatible JSON feature packs if you don’t have a learned
              pack. No full-game pack is bundled.
            </p>
            <label className="button subtle" aria-disabled={active || busy}>
              <Upload size={16} />
              Import feature packs
              <input
                className="sr-only"
                type="file"
                accept="application/json,.json"
                multiple
                disabled={active || busy}
                onChange={(e) => {
                  void importPacks(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            {available
              .filter((pack) => !pack.game || pack.game === game)
              .map((pack) => (
                <button
                  key={pack.id}
                  className="button subtle"
                  disabled={active || busy}
                  onClick={() => void install(pack)}
                >
                  <Download size={15} />
                  {pack.name} · {pack.cards.toLocaleString()} references
                </button>
              ))}
            {packs.map((pack) => (
              <div key={pack.id} className="pack-row">
                <span>
                  {pack.name} · {pack.cards.toLocaleString()} references ·{" "}
                  {(pack.bytes / 1048576).toFixed(1)} MB
                  <small>
                    {pack.coverage?.scope === "full-catalog"
                      ? "Full-catalog source"
                      : (pack.coverage?.scope ?? "custom coverage")}{" "}
                    · {pack.readiness}
                    {pack.coverage?.shard &&
                      ` · shard ${pack.coverage.shard.index}/${pack.coverage.shard.total}`}
                    {pack.coverage?.availableImages !== undefined &&
                      ` · source has ${pack.coverage.availableImages.toLocaleString()} image references`}
                    {pack.coverage &&
                      ` · ${pack.coverage.missingImages} missing images, ${pack.coverage.failedImages} extraction failures`}
                    {pack.error && ` · ${pack.error}`}
                  </small>
                </span>
                <button
                  disabled={active || busy}
                  onClick={() =>
                    void removeReferencePack(pack.id)
                      .then(() => refreshPacks(true))
                      .catch((e) => setError(errorMessage(e)))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </details>
          <small>Stop the camera before changing reference packs.</small>
        </div>
      )}
    </div>
  );

  return (
    <section
      className="continuous-scanner panel"
      aria-label="Continuous card scanner"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">LOCAL VISUAL RECOGNITION</span>
          <h2>Scan. Hold. Collected.</h2>
        </div>
        <ScanLine size={23} />
      </div>
      <p className="recognition-caution">
        Experimental · printing unconfirmed · check saved counts.
      </p>
      {needsSetup ? (
        databasePanel
      ) : (
        <p className="scanner-ready-chip">
          {!packsReady ? "Checking card database…" : `Ready · ${gameName}`}
        </p>
      )}
      <details className="scan-options">
        <summary>
          Scan options{" "}
          <span>
            {mode === "binder"
              ? "Binder · separate visible copies"
              : "One card at a time"}
            {!auto ? " · preview only" : ""}
          </span>
          <ChevronRight
            className="disclosure-arrow"
            size={16}
            aria-hidden="true"
          />
        </summary>
        <div className="live-controls">
          <label>
            Session mode
            <select
              value={mode}
              disabled={active || busy}
              onChange={(e) => {
                const next = e.target.value as ScanMode;
                setMode(next);
                onPreferencesChange({ liveMode: next });
              }}
            >
              <option value="stream">One card after another</option>
              <option value="binder">Binder / tabletop · up to 9</option>
            </select>
          </label>
          <label>
            Save policy
            <select
              value={savePolicy}
              disabled={active || busy}
              onChange={(e) => {
                const next = e.target.value as ScanContinuityPolicy;
                setSavePolicy(next);
                onPreferencesChange({ savePolicy: next });
              }}
            >
              <option value="fast">Quick · strong match + current view</option>
              <option value="strict">Strict · 3 matches + current view</option>
            </select>
          </label>
          <label className="auto-toggle">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => {
                setAuto(e.target.checked);
                onPreferencesChange({ autoSave: e.target.checked });
                autoRef.current = e.target.checked;
                frameEpoch.current++;
                session.current?.interruptEvidence();
                liveCapture.current?.interrupt();
                if (
                  activeMatcher.current !== "learned" &&
                  running.current &&
                  !pausedRef.current &&
                  !inputHeldRef.current
                ) {
                  if (timer.current) clearTimeout(timer.current);
                  void frame(generation.current, frameEpoch.current);
                }
              }}
            />
            Auto-save strong matches
          </label>
        </div>
        {!needsSetup && databasePanel}
        <details className="pack-compatibility">
          <summary>Test video</summary>
          <p className="scanner-action-help">
            Run a local MP4 or WebM through Live scanning at 1×. The same
            recognition and save rules apply, including auto-save to your
            collection. Up to five minutes, 250 MB, and{" "}
            {mode === "binder" ? "2880" : "1920"} pixels on the longest edge.
          </p>
          <label className="button subtle" aria-disabled={!!uploadDisabled}>
            <Upload size={16} />
            Choose test video
            <input
              className="sr-only"
              type="file"
              accept="video/mp4,video/webm,.mp4,.webm"
              disabled={!!uploadDisabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void start(file);
              }}
            />
          </label>
        </details>
        <p className="scanner-action-help">
          Pause keeps this session. Ending and starting a new session resets its
          count and may count the same cards again. Your collection is kept.
        </p>
      </details>
      <div className="scanner-camera-controls">
        <div className="live-actions">
          {cameraPreparing ? (
            <>
              <button className="button primary" disabled>
                <Camera size={17} />
                Preparing local scanner…
              </button>
              <button
                className="button subtle"
                onClick={() => {
                  stop();
                  setMessage(
                    "Preparation cancelled. Your previous session is kept.",
                  );
                }}
              >
                Cancel preparation
              </button>
            </>
          ) : !active ? (
            <button
              className={
                photoMatches.length ? "button secondary" : "button primary"
              }
              onClick={() => void start()}
              disabled={busy || !packsReady || !installedCount}
            >
              <Camera size={17} />
              Start continuous camera
            </button>
          ) : (
            <>
              <button
                className={inputHeld ? "button subtle" : "button primary"}
                disabled={busy}
                onClick={() => {
                  if (paused) void resume();
                  else pause();
                }}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
                {paused ? "Resume" : "Pause"}
              </button>
              {sourceKind === "video" && !paused && (
                <button
                  className={inputHeld ? "button primary" : "button subtle"}
                  disabled={busy}
                  aria-describedby="test-input-hold-help"
                  onClick={() => {
                    if (inputHeld) void resume();
                    else holdTestInput();
                  }}
                >
                  {inputHeld ? "Resume test input" : "Hold test input"}
                </button>
              )}
              <button className="button subtle" onClick={stop}>
                <Square size={15} />
                End session
              </button>
              <button
                className="button subtle"
                disabled={
                  busy || inputHeld || (mode === "stream" && !nextCopyTarget)
                }
                aria-describedby="next-copy-help"
                onClick={() => {
                  const nextReference =
                    mode === "stream" && nextCopyTarget
                      ? session.current?.nextCopy(nextCopyTarget.eventId)
                      : undefined;
                  if (mode === "stream" && !nextReference) return;
                  frameEpoch.current++;
                  if (timer.current) clearTimeout(timer.current);
                  cancelPrintingStatus();
                  if (mode === "binder") session.current?.newPage();
                  setTracks(session.current?.snapshot() ?? []);
                  liveCapture.current?.interrupt();
                  if (
                    !liveCapture.current &&
                    running.current &&
                    !pausedRef.current &&
                    !inputHeldRef.current
                  )
                    void frame(generation.current, frameEpoch.current);
                  setMessage(
                    mode === "binder"
                      ? "New page. Visible cards may count again."
                      : `Another ${nextReference!.name} presentation may count. Other saved identities remain counted.`,
                  );
                }}
              >
                {mode === "binder" ? "New page" : "Add another copy"}
              </button>
            </>
          )}
          {photoPreparing && (
            <button
              className="button subtle"
              onClick={() => {
                stop();
                setTracks([]);
                setPhotoMatches([]);
                setMessage("Photo analysis cancelled. Nothing was added.");
              }}
            >
              Cancel analysis
            </button>
          )}
          <label className="button subtle" aria-disabled={!!uploadDisabled}>
            <Upload size={16} />
            Multi-card photo
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!!uploadDisabled}
              onChange={(e) => {
                void analyzePhoto(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {photoMatches.length > 0 && (
            <button
              className="button primary"
              disabled={busy}
              onClick={savePhoto}
            >
              Save {photoMatches.length} visual matches
            </button>
          )}
        </div>
        {active && sourceKind === "video" && (
          <p className="scanner-action-help" id="test-input-hold-help">
            {inputHeld
              ? "Test input held. Already-started printing reads can finish; no new views are captured. Resume test input to continue."
              : "Local test video · 1× · Live save rules. Hold test input stops new views while already-started printing reads finish. Pause cancels those reads."}
          </p>
        )}
        {active && !cameraPreparing && (
          <p className="scanner-action-help" id="next-copy-help">
            {mode === "binder"
              ? "New page lets every card in the current view count again. Use it only after changing the page or layout."
              : nextCopyTarget
                ? `Add another copy: ${nextCopyTarget.reference!.name}. Replace it with the next physical copy, then tap.`
                : visibleSettled.length > 1
                  ? "Show only the card you want to count again before adding another copy."
                  : "To add another identical copy, show one counted card until identified, then choose Add another copy."}
          </p>
        )}
        {!active && sessionCount > 0 && (
          <p className="scanner-action-help">
            Starting again begins a new session and may count the same cards
            again. Your saved collection stays.
          </p>
        )}
        {!auto && (
          <p className="scanner-action-help">
            Preview only: auto-save is off. Nothing is queued for Review. Turn
            it on to save fresh camera matches.
          </p>
        )}
      </div>
      {error && <p className="live-error">{error}</p>}
      <div className="live-session-summary" aria-label="Session saves">
        <strong>{sessionCount} saved this session</strong>
        {recentSaved && (
          <div>
            <span>Latest: {recentSaved.reference.name}</span>
            <button
              className="button subtle"
              onClick={() => undoSaved(recentSaved)}
            >
              <Undo2 size={14} />
              Undo latest
            </button>
          </div>
        )}
      </div>
      <div className="live-stage-shell">
        <div
          className="live-stage"
          style={{
            aspectRatio: `${mediaSize.width}/${mediaSize.height}`,
            maxWidth: `calc(var(--scanner-preview-height) * ${mediaSize.width / mediaSize.height})`,
          }}
        >
          <video
            ref={video}
            muted
            playsInline
            className={photo ? "hidden-video" : ""}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (element.videoWidth && element.videoHeight)
                setMediaSize({
                  width: element.videoWidth,
                  height: element.videoHeight,
                });
            }}
          />
          {photo && <img src={photo} alt="Selected multi-card capture" />}
          {!active && !photo && (
            <div className="live-idle">
              <ScanLine size={36} />
              <strong>Your camera, your collection.</strong>
              <span>
                {needsSetup
                  ? "Install references above to start"
                  : "Show all four edges with a little background"}
              </span>
            </div>
          )}
          {!cameraPreparing && (active || photo) && (
            <svg
              className="live-overlay"
              viewBox={`0 0 ${size.width} ${size.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {shownTracks.map((track) => (
                <polygon
                  key={track.id}
                  points={track.quad
                    .map((point) => `${point.x},${point.y}`)
                    .join(" ")}
                  className={`track-${track.status}`}
                />
              ))}
            </svg>
          )}
          {!cameraPreparing &&
            (active || photo) &&
            shownTracks.map((track) => {
              const x = Math.min(...track.quad.map((point) => point.x));
              const y = Math.min(...track.quad.map((point) => point.y));
              const presentation = scannerTrackPresentation(
                track,
                !!photo,
                auto,
              );
              return (
                <div
                  key={track.id}
                  className={`track-label track-${track.status}`}
                  style={{
                    left: `${Math.max(0, Math.min(98, (x / size.width) * 100))}%`,
                    top: `${Math.max(0, Math.min(96, (y / size.height) * 100))}%`,
                    maxWidth: `${Math.max(8, ((Math.max(...track.quad.map((point) => point.x)) - x) / size.width) * 100)}%`,
                  }}
                  aria-hidden="true"
                >
                  <b>{trackNumber(track)}</b>{" "}
                  <span>{statusGlyph(track.status)}</span>
                  <span className="track-badge-word">
                    {" "}
                    {presentation.label}
                  </span>
                </div>
              );
            })}
          {active && paused && <div className="live-paused">Paused</div>}
        </div>
      </div>
      <p className="live-status">{message}</p>
      {onFindCard && (needsSetup || error || unmatchedCount > 0) && (
        <button className="button subtle" onClick={onFindCard}>
          Find a card manually <ChevronRight size={15} />
        </button>
      )}
      {photo && unmatchedCount > 0 && (
        <div className="photo-unmatched">
          <span>
            {unmatchedCount} unmatched detector region
            {unmatchedCount === 1 ? "" : "s"}; these were not saved. Regions can
            overlap and aren’t a card count.
          </span>
          <label className="inline-option">
            <input
              type="checkbox"
              checked={showUnmatched}
              onChange={(event) => setShowUnmatched(event.target.checked)}
            />
            Show unmatched regions
          </label>
        </div>
      )}
      {shownTracks.length > 0 && (
        <ul className="track-status-list" aria-label="Tracked card regions">
          {shownTracks.map((track) => {
            const presentation = scannerTrackPresentation(track, !!photo, auto);
            return (
              <li
                key={track.id}
                className={`track-status-row track-${track.status}`}
              >
                <span className={`track-status-number track-${track.status}`}>
                  {trackNumber(track)} {statusGlyph(track.status)}
                </span>
                <div>
                  <strong>
                    {presentation.name} · {presentation.label}
                  </strong>
                  <span className="track-detail-message">
                    {presentation.message}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!active && !learnedCount && installedCount > 0 && (
        <label className="tight-photo-option">
          <input
            type="checkbox"
            checked={tightPhoto}
            disabled={busy}
            onChange={(e) => setTightPhoto(e.target.checked)}
          />
          Uploaded photo is one entire card with no background (use its four
          image corners)
        </label>
      )}
      {active && captureTransport === "compatibility" && (
        <p className="recognition-caution">
          Compatibility preview only. Automatic current-view verification needs
          a current browser; use a multi-card photo to save identified matches.
        </p>
      )}
      <details className="scanner-details">
        <summary>Scanning tips and recognition limits</summary>
        <p className="recognition-caution">
          Experimental recognition · check saved counts. Physical-card accuracy
          is still being validated; only installed references can match.
        </p>
        <p className="live-rule">
          {mode === "stream"
            ? "Different card identities save automatically when auto-save is on. An identical card stays counted across gaps, blur and re-entry. Add another copy rearms only the named identity. Automatic identical-copy exit/re-entry is not verified. Undo accidental repeats."
            : "Keep one page or layout in view. Brief gaps do not reset counted cards. New page allows visible cards to count again."}{" "}
          Show all four edges with background around them; separate overlapping
          cards. Printed identifiers are checked when a close-up has enough
          native detail. Edition, finish and physical condition can remain
          unconfirmed.
        </p>
      </details>
      {saved.length > 0 && (
        <div className="scan-receipts">
          <h3>Latest saves this session</h3>
          <p className="receipt-window">
            Showing the latest {saved.length} receipts (up to 30). Earlier saves
            remain in Collection. Undone cards are excluded from the session
            total.
          </p>
          {saved.map((item) => (
            <article key={item.eventId}>
              <div>
                <strong>{item.reference.name}</strong>
                <small>
                  {item.undone
                    ? "Undone"
                    : "Saved locally · condition and finish unknown"}
                </small>
                {!item.undone && item.printingStatus && (
                  <small>{item.printingStatus}</small>
                )}
                {!item.undone && item.printingReference && (
                  <small>
                    Read catalog: {item.printingReference.setName} ·{" "}
                    {item.printingReference.number}
                  </small>
                )}
                {!item.undone && item.printingResolution && (
                  <PrintingEvidenceDetails
                    resolution={item.printingResolution}
                  />
                )}
                {!item.undone && (
                  <ReferenceQuotes
                    card={referenceCard(
                      item.printingReference ?? item.reference,
                    )}
                  />
                )}
              </div>
              <button
                className="button subtle"
                disabled={item.undone}
                onClick={() => undoSaved(item)}
              >
                <Undo2 size={14} />
                Undo
              </button>
            </article>
          ))}
        </div>
      )}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={announcement.sequence}>{announcement.text}</span>
      </div>
    </section>
  );
}
