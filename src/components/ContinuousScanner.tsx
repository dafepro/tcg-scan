import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
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
import { referenceCard } from "../lib/scan-inventory";
import { ReferenceQuotes } from "./ReferenceQuotes";
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
import type { LiveCaptureContext } from "../lib/live-capture";
import type { ScanContinuityPolicy } from "../lib/scan-session";
import "./continuous-scanner.css";

type Props = {
  game: Game;
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
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const frameCapture = useRef<FrameCapture | null>(null);
  const liveCapture = useRef<LiveCaptureLoop | null>(null);
  const client = useRef<VisionClient | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const frameEpoch = useRef(0);
  const running = useRef(false);
  const pausedRef = useRef(false);
  const autoRef = useRef(true);
  const session = useRef<ScanSession | null>(null);
  const printing = useRef<PrintingSession | null>(null);
  const printedEvents = useRef(new Set<string>());
  const captureSequence = useRef(0);
  const callbacks = useRef({ onSave, onUndo, onPrinting });
  useEffect(() => {
    callbacks.current = { onSave, onUndo, onPrinting };
  }, [onSave, onUndo, onPrinting]);
  const [mode, setMode] = useState<ScanMode>("stream");
  const [savePolicy, setSavePolicy] = useState<ScanContinuityPolicy>("fast");
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState(true);
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
    cancelPrintingStatus();
    liveCapture.current?.pause();
    frameEpoch.current++;
    session.current?.interruptEvidence();
    if (timer.current) clearTimeout(timer.current);
    pausedRef.current = true;
    setPaused(true);
    setMessage("Paused. Existing tracks remain counted.");
  }, [cancelPrintingStatus]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden && running.current) pause();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [pause]);
  function stop() {
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
    if (video.current) video.current.srcObject = null;
    client.current?.dispose();
    client.current = null;
    frameCapture.current?.dispose();
    frameCapture.current = null;
    session.current?.releasePixels();
    setTracks(session.current?.snapshot() ?? []);
    setActive(false);
    setPaused(false);
    setBusy(false);
    setPhotoPreparing(false);
    setCameraPreparing(false);
    setMessage("Camera stopped. Start a new session to scan again.");
  }
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
    printing.current?.forget(item.eventId);
    const failure = callbacks.current.onUndo(item.eventId);
    if (failure) {
      setError(failure);
      return;
    }
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
        entry.eventId === item.eventId ? { ...entry, undone: true } : entry,
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
      onStatus: (eventId, status) =>
        setSaved((old) =>
          old.map((item) =>
            item.eventId === eventId && !item.undone
              ? { ...item, printingStatus: status }
              : item,
          ),
        ),
      onResolution: (eventId, resolution) => {
        const failure = callbacks.current.onPrinting(eventId, resolution);
        if (!failure) {
          printedEvents.current.add(eventId);
          setSaved((old) =>
            old.map((item) =>
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
          pausedRef.current
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
          pausedRef.current
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
  async function start() {
    if (busy || active || !packsReady || !installedCount) return;
    setCameraPreparing(true);
    setMessage(
      "Waiting for camera access. You can cancel preparation at any time.",
    );
    setBusy(true);
    setError("");
    setPhoto(undefined);
    setPhotoMatches([]);
    setTracks([]);
    setSaved([]);
    receiptEvents.current.clear();
    setSessionCount(0);
    setShowUnmatched(false);
    setMediaSize({ width: 1280, height: 720 });
    frameCapture.current?.dispose();
    frameCapture.current = null;
    setCaptureTransport("videoframe-pool");
    printedEvents.current.clear();
    const gen = ++generation.current;
    // A detector miss, glare, or unknown front is not evidence that a counted
    // physical card left. Keep the camera latch until an explicit new copy/page.
    session.current = new ScanSession(
      crypto.randomUUID(),
      mode,
      1200,
      "explicit",
    );
    preparePrinting(gen);
    let openingCamera = true;
    try {
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
      if (gen !== generation.current) return;
      openingCamera = false;
      const local = await prepare(gen);
      if (gen !== generation.current) return;
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
  async function importLearnedFiles(files: FileList | null) {
    if (!files?.length) return;
    const gen = ++generation.current;
    const controller = new AbortController();
    importController.current?.abort();
    importController.current = controller;
    setBusy(true);
    setImporting(true);
    setImportProgress(undefined);
    setImportFeedback("Checking the selected manifest and binary shards…");
    setError("");
    try {
      await importLearnedPack(Array.from(files), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (gen === generation.current) {
            setImportProgress(progress);
            setImportFeedback(progress.text);
          }
        },
      });
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
            "Installation cancelled. Remove any incomplete pack below, then select the manifest and all binary shards to retry.",
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
      <p className="section-description">
        Hold until Added. Saved identities keep printing, finish and condition
        unconfirmed.
      </p>
      <p className="recognition-caution">
        Experimental recognition · check saved counts.
      </p>
      <div className={`scanner-setup ${needsSetup ? "needs-setup" : ""}`}>
        <strong>
          {!packsReady
            ? "Checking installed references…"
            : needsSetup
              ? `Set up ${gameName} recognition`
              : `${installedCount.toLocaleString()} references ready for ${gameName}`}
        </strong>
        {needsSetup ? (
          <p>
            Install a reference pack once before scanning. Recognition is
            limited to the cards in your installed packs.
          </p>
        ) : installedCount > 0 ? (
          <ul className="coverage-summary">
            {learnedCount
              ? readyLearned.map((pack) => (
                  <li key={pack.id}>
                    {pack.name} · {pack.byGame[game].toLocaleString()}{" "}
                    references · {pack.byGameNames[game].toLocaleString()} card
                    names
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
                    {pack.name} · {pack.byGame[game].toLocaleString()}{" "}
                    references
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
            <label className="button primary" aria-disabled={active || busy}>
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
            <p className="pack-help">
              Select the learned manifest (.json) and all its binary shards
              (.bin) together. A ready learned pack takes priority for this
              game.
            </p>
            <p className="pack-storage-help">
              Packs stay in this browser after reload. Keep your source files:
              private browsing or clearing site data can remove them. Back up
              your collection separately.
            </p>
            {(importing || importFeedback) && (
              <div
                className="pack-progress"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span>{importFeedback}</span>
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
                  {pack.name} · {pack.cards.toLocaleString()} learned references
                  · {(pack.bytes / 1048576).toFixed(1)} MB
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
      <div className="live-controls">
        <label>
          Session mode
          <select
            value={mode}
            disabled={active || busy}
            onChange={(e) => setMode(e.target.value as ScanMode)}
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
            onChange={(e) =>
              setSavePolicy(e.target.value as ScanContinuityPolicy)
            }
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
              autoRef.current = e.target.checked;
              frameEpoch.current++;
              session.current?.interruptEvidence();
              liveCapture.current?.interrupt();
              if (
                activeMatcher.current !== "learned" &&
                running.current &&
                !pausedRef.current
              ) {
                if (timer.current) clearTimeout(timer.current);
                void frame(generation.current, frameEpoch.current);
              }
            }}
          />
          Auto-save strong matches
        </label>
      </div>
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
                    "Camera preparation cancelled. Nothing was added.",
                  );
                }}
              >
                Cancel preparation
              </button>
            </>
          ) : !active ? (
            <button
              className="button primary"
              onClick={() => void start()}
              disabled={busy || !packsReady || !installedCount}
            >
              <Camera size={17} />
              Start continuous camera
            </button>
          ) : (
            <>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  if (paused) {
                    pausedRef.current = false;
                    setPaused(false);
                    if (liveCapture.current) liveCapture.current.resume();
                    else void frame(generation.current);
                  } else pause();
                }}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
                {paused ? "Resume" : "Pause"}
              </button>
              <button className="button subtle" onClick={stop}>
                <Square size={15} />
                Stop
              </button>
              <button
                className="button subtle"
                disabled={busy || (mode === "stream" && !nextCopyTarget)}
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
                    !pausedRef.current
                  )
                    void frame(generation.current, frameEpoch.current);
                  setMessage(
                    mode === "binder"
                      ? "New page. Visible cards may count again."
                      : `Another ${nextReference!.name} presentation may count. Other saved identities remain counted.`,
                  );
                }}
              >
                {mode === "binder" ? "New page" : "Next copy"}
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
        {active && !cameraPreparing && (
          <p className="scanner-action-help" id="next-copy-help">
            {mode === "binder"
              ? "New page lets every card in the current view count again. Use it only after changing the page or layout."
              : nextCopyTarget
                ? `Next copy: ${nextCopyTarget.reference!.name}. Replace it with the next physical copy, then tap.`
                : visibleSettled.length > 1
                  ? "Next copy is unavailable while several counted cards are visible. Show only the card you want to count again."
                  : "Next copy becomes available when one counted card is visible. Hold it in view until identified."}
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
            autoPlay
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
          {(active || photo) && (
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
          {(active || photo) &&
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
              <li key={track.id}>
                <span className={`track-status-number track-${track.status}`}>
                  {trackNumber(track)} {statusGlyph(track.status)}
                </span>
                <div>
                  <strong>
                    {presentation.name} · {presentation.label}
                  </strong>
                  <span>{presentation.message}</span>
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
        <summary>Scanning tips and diagnostics</summary>
        <p className="recognition-caution">
          Experimental recognition · check saved counts. Physical-card accuracy
          is still being validated; only installed references can match.
        </p>
        <p className="live-rule">
          {mode === "stream"
            ? "Different card identities save automatically when auto-save is on. An identical card stays counted across gaps, blur and re-entry. Next copy rearms only the named identity. Automatic identical-copy exit/re-entry is not verified. Undo accidental repeats."
            : "Keep one page or layout in view. Brief gaps do not reset counted cards. New page allows visible cards to count again."}{" "}
          Show all four edges with background around them; separate overlapping
          cards. Printed identifiers are checked when a close-up has enough
          native detail. Edition, finish and physical condition can remain
          unconfirmed.
        </p>
        <div className="live-metrics">
          <span>
            {coverage.byGame[game].toLocaleString()} loaded references
          </span>
          <span>
            {matcher === "learned"
              ? "Learned matcher · local feature cache"
              : "Compatibility matcher · ORB"}
          </span>
          <span>
            {timings
              ? `${Math.round(timings.totalMs)} ms processing only · ${Math.round(timings.matchingMs)} ms matching. Excludes camera preparation, current-view checks and saving.`
              : "Processing timing appears after an analyzed frame."}
          </span>
        </div>
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
