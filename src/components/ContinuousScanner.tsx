import { useEffect, useRef, useState } from "react";
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
import { referenceCard } from "../lib/scan-inventory";
import { getPriceSnapshot } from "../lib/pricing";
import type { PriceSnapshot } from "../lib/pricing";
import "./continuous-scanner.css";

type Props = {
  game: Game;
  onSave: (reference: ReferenceMetadata, eventId: string) => string | undefined;
  onUndo: (eventId: string) => string | undefined;
};
type Saved = {
  eventId: string;
  reference: ReferenceMetadata;
  undone?: boolean;
};
const EMPTY: VisionCoverage = {
  totalReferences: 0,
  byGame: { pokemon: 0, mtg: 0, yugioh: 0 },
  packs: [],
};
const STATUS_LABELS: Record<ScanTrack["status"], string> = {
  stabilizing: "Hold",
  matching: "Matching",
  added: "Added",
  review: "Review",
  quality: "Check",
  saving: "Saving",
  error: "Error",
  undone: "Undone",
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
function Quote({ reference }: { reference: ReferenceMetadata }) {
  const [snapshot, setSnapshot] = useState<PriceSnapshot>();
  useEffect(() => {
    const c = new AbortController();
    const update = (s: PriceSnapshot) => {
      if (!c.signal.aborted) setSnapshot(s);
    };
    void getPriceSnapshot(referenceCard(reference), {
      finish: "Unknown",
      signal: c.signal,
      onUpdate: update,
    })
      .then(update)
      .catch(() => {});
    return () => c.abort();
  }, [reference]);
  if (!snapshot) return <small>Market quotes loading separately…</small>;
  return (
    <div className="live-quotes">
      <small>{snapshot.status} · printing and finish unconfirmed</small>
      {snapshot.quotes.slice(0, 3).map((q, i) => (
        <small key={`${q.source}:${q.variant}:${i}`}>
          <a href={q.sourceUrl} target="_blank" rel="noreferrer">
            {q.source}
          </a>{" "}
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: q.currency,
          }).format(q.amount)}{" "}
          · {q.variant} · {q.scope} estimate
          {q.providerUpdatedAt
            ? ` · source ${new Date(q.providerUpdatedAt).toLocaleDateString()}`
            : ""}
        </small>
      ))}
      {!snapshot.quotes.length && (
        <small>Price unavailable. Your scan is already saved.</small>
      )}
      {snapshot.fetchedAt && (
        <small>Retrieved {new Date(snapshot.fetchedAt).toLocaleString()}</small>
      )}
      {snapshot.error && <small>{snapshot.error}</small>}
    </div>
  );
}
export default function ContinuousScanner({ game, onSave, onUndo }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const client = useRef<VisionClient | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const frameEpoch = useRef(0);
  const running = useRef(false);
  const pausedRef = useRef(false);
  const autoRef = useRef(true);
  const session = useRef<ScanSession | null>(null);
  const callbacks = useRef({ onSave, onUndo });
  useEffect(() => {
    callbacks.current = { onSave, onUndo };
  }, [onSave, onUndo]);
  const [mode, setMode] = useState<ScanMode>("stream");
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [photoPreparing, setPhotoPreparing] = useState(false);
  const [message, setMessage] = useState(
    "Load a reference pack, then start a continuous camera session.",
  );
  const [error, setError] = useState("");
  const [coverage, setCoverage] = useState<VisionCoverage>(EMPTY);
  const [packs, setPacks] = useState<StoredPackMetadata[]>([]);
  const [available, setAvailable] = useState<PrebuiltPackEntry[]>([]);
  const [tracks, setTracks] = useState<ScanTrack[]>([]);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [saved, setSaved] = useState<Saved[]>([]);
  const [timings, setTimings] = useState<VisionResult["timings"]>();
  const [photo, setPhoto] = useState<string>();
  const [tightPhoto, setTightPhoto] = useState(false);
  const photoUrl = useRef<string | undefined>(undefined);
  const [photoMatches, setPhotoMatches] = useState<CardDetection[]>([]);
  const photoEvents = useRef(new WeakMap<CardDetection, string>());
  const [packOpen, setPackOpen] = useState(false);
  async function refreshPacks() {
    try {
      setPacks(await listReferencePacks());
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void refreshPacks();
    const c = new AbortController();
    const lifecycleGeneration = generation;
    void loadPrebuiltPackManifest(c.signal)
      .then((m) => setAvailable(m.packs))
      .catch(() => {});
    return () => {
      c.abort();
      lifecycleGeneration.current++;
      running.current = false;
      if (timer.current) clearTimeout(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
      client.current?.dispose();
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    };
  }, []);
  function pause() {
    frameEpoch.current++;
    session.current?.interruptEvidence();
    if (timer.current) clearTimeout(timer.current);
    pausedRef.current = true;
    setPaused(true);
    setMessage("Paused. Existing tracks remain counted.");
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden && running.current) pause();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  function stop() {
    generation.current++;
    running.current = false;
    pausedRef.current = false;
    if (timer.current) clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    client.current?.dispose();
    client.current = null;
    setActive(false);
    setPaused(false);
    setBusy(false);
    setPhotoPreparing(false);
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
    setMessage("Starting local OpenCV recognition…");
    await local.initialize();
    check();
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
    if (!failure)
      setSaved((old) =>
        old.some((x) => x.eventId === eventId)
          ? old
          : [{ eventId, reference }, ...old].slice(0, 30),
      );
    return failure;
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
      !client.current.busy
    ) {
      const v = video.current;
      // Preserve more source detail for small binder slots; feature extraction
      // still runs on bounded canonical crops in the worker.
      const frameLimit = mode === "binder" ? 1920 : 1280;
      const scale = Math.min(
        1,
        frameLimit / Math.max(v.videoWidth, v.videoHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context) {
        context.drawImage(v, 0, 0, canvas.width, canvas.height);
        try {
          const result = await client.current.analyze(
            context.getImageData(0, 0, canvas.width, canvas.height),
            { game, maxCards: mode === "binder" ? 9 : 3, budgetMs: 750 },
          );
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
            setError(errorMessage(e));
            pause();
          }
        }
      }
    }
    if (
      running.current &&
      !pausedRef.current &&
      gen === generation.current &&
      epoch === frameEpoch.current
    )
      timer.current = setTimeout(() => void frame(gen, epoch), 120);
  }
  async function start() {
    if (busy || active) return;
    setBusy(true);
    setError("");
    setPhoto(undefined);
    setPhotoMatches([]);
    setTracks([]);
    setSaved([]);
    const gen = ++generation.current;
    session.current = new ScanSession(crypto.randomUUID(), mode);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera needs HTTPS or localhost and a supported browser.",
        );
      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: mode === "binder" ? 1920 : 1280 },
          height: { ideal: mode === "binder" ? 1080 : 720 },
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
      for (const t of media.getVideoTracks())
        t.onended = () => {
          if (running.current && gen === generation.current) {
            pause();
            setError("Camera disconnected. Stop and restart to reconnect.");
          }
        };
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      if (gen !== generation.current) return;
      await prepare(gen);
      if (gen !== generation.current) return;
      setBusy(false);
      setMessage(
        "Scanning continuously. Hold each card still for three verified observations.",
      );
      void frame(gen);
    } catch (e) {
      if (gen === generation.current) {
        stop();
        setError(errorMessage(e));
      }
    }
  }
  async function importPacks(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError("");
    try {
      for (const f of Array.from(files)) await importReferencePack(f);
      await refreshPacks();
      setMessage(
        "Reference packs installed on this device. Start the camera to load them.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function install(p: PrebuiltPackEntry) {
    setBusy(true);
    setError("");
    try {
      await installPrebuiltPack(p);
      await refreshPacks();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function analyzePhoto(file?: File) {
    if (!file) return;
    stop();
    setBusy(true);
    setPhotoPreparing(true);
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
      const bitmap = await createImageBitmap(file);
      if (gen !== generation.current) {
        bitmap.close();
        return;
      }
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        bitmap.close();
        throw new Error("Image processing unavailable.");
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
      photoUrl.current = URL.createObjectURL(file);
      setPhoto(photoUrl.current);
      const local = await prepare(gen);
      const result = await local.analyze(
        context.getImageData(0, 0, canvas.width, canvas.height),
        {
          game,
          maxCards: 9,
          budgetMs: 1000,
          region: tightPhoto
            ? [
                { x: 0, y: 0 },
                { x: canvas.width - 1, y: 0 },
                { x: canvas.width - 1, y: canvas.height - 1 },
                { x: 0, y: canvas.height - 1 },
              ]
            : undefined,
        },
      );
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
          status: d.autoEligible
            ? "review"
            : d.state === "quality"
              ? "quality"
              : "matching",
          message: d.autoEligible ? "Visual match · ready to save" : d.reason,
          reference: d.candidates[0]?.reference,
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
        `${result.detections.length} regions detected. ${result.budgetExhausted ? "Some regions need another capture; only fully verified matches are selectable." : "Review this still capture before saving its matches."}`,
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
        setError(failure);
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
  const installedCount = packs.reduce((n, p) => n + p.byGame[game], 0);
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
        One camera session. Strong, stable visual matches save automatically.
        Unknown cards stay visible for review.
      </p>
      <p className="recognition-caution">
        Experimental recognition · check saved counts. Physical-card accuracy is
        still being validated; only installed references can match.
      </p>
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
        <label className="auto-toggle">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              autoRef.current = e.target.checked;
            }}
          />
          Auto-save strong matches
        </label>
      </div>
      <div
        className="live-stage"
        style={{ aspectRatio: `${size.width}/${size.height}` }}
      >
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          className={photo ? "hidden-video" : ""}
        />
        {photo && <img src={photo} alt="Selected multi-card capture" />}
        {!active && !photo && (
          <div className="live-idle">
            <ScanLine size={48} />
            <strong>Your camera, your collection.</strong>
            <span>
              {installedCount
                ? `${installedCount.toLocaleString()} references installed for this game`
                : "No references installed for this game yet"}
            </span>
          </div>
        )}
        {(active || photo) && (
          <svg
            className="live-overlay"
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-hidden="true"
          >
            {tracks
              .filter((t) => t.visible)
              .map((t) => (
                <polygon
                  key={t.id}
                  points={t.quad.map((p) => `${p.x},${p.y}`).join(" ")}
                  className={`track-${t.status}`}
                />
              ))}
          </svg>
        )}
        {(active || photo) &&
          tracks
            .filter((t) => t.visible)
            .map((t) => {
              const x = Math.min(...t.quad.map((p) => p.x));
              const y = Math.min(...t.quad.map((p) => p.y));
              return (
                <div
                  key={t.id}
                  className={`track-label track-${t.status}`}
                  style={{
                    left: `${Math.max(0, Math.min(75, (x / size.width) * 100))}%`,
                    top: `${Math.max(0, (y / size.height) * 100)}%`,
                    maxWidth: `${Math.max(8, ((Math.max(...t.quad.map((p) => p.x)) - x) / size.width) * 100)}%`,
                  }}
                  aria-hidden="true"
                >
                  <b>{trackNumber(t)}</b> <span>{statusGlyph(t.status)}</span>
                  <span className="track-badge-word">
                    {" "}
                    {STATUS_LABELS[t.status]}
                  </span>
                </div>
              );
            })}
        {active && paused && <div className="live-paused">Paused</div>}
      </div>
      {tracks.some((t) => t.visible) && (
        <ul className="track-status-list" aria-label="Tracked card regions">
          {tracks
            .filter((t) => t.visible)
            .map((t) => (
              <li key={t.id}>
                <span className={`track-status-number track-${t.status}`}>
                  {trackNumber(t)} {statusGlyph(t.status)}
                </span>
                <div>
                  <strong>
                    {t.reference?.name ?? "Card region"} ·{" "}
                    {STATUS_LABELS[t.status]}
                  </strong>
                  <span>{t.message}</span>
                </div>
              </li>
            ))}
        </ul>
      )}
      <div className="live-actions">
        {!active ? (
          <button
            className="button primary"
            onClick={() => void start()}
            disabled={busy}
          >
            <Camera size={17} />
            {busy ? "Preparing local scanner…" : "Start continuous camera"}
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
                  void frame(generation.current);
                } else pause();
              }}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}{" "}
              {paused ? "Resume" : "Pause"}
            </button>
            <button className="button subtle" onClick={stop}>
              <Square size={15} />
              Stop
            </button>
            {mode === "binder" && (
              <button
                className="button subtle"
                onClick={() => {
                  frameEpoch.current++;
                  if (timer.current) clearTimeout(timer.current);
                  session.current?.newPage();
                  setTracks([]);
                  if (running.current && !pausedRef.current)
                    void frame(generation.current, frameEpoch.current);
                  setMessage("New page. Visible cards may count again.");
                }}
              >
                New page
              </button>
            )}
          </>
        )}
        {photoPreparing && (
          <button
            className="button subtle"
            onClick={() => {
              stop();
              setMessage("Photo analysis cancelled. Nothing was added.");
            }}
          >
            Cancel analysis
          </button>
        )}
        <label className="button subtle">
          <Upload size={16} />
          Multi-card photo
          <input
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy || active}
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
      {!active && (
        <label className="tight-photo-option">
          <input
            type="checkbox"
            checked={tightPhoto}
            disabled={busy}
            onChange={(e) => setTightPhoto(e.target.checked)}
          />{" "}
          Uploaded photo is one entire card with no background (use its four
          image corners)
        </label>
      )}
      <p className="live-status" role="status">
        {message}
      </p>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="live-metrics">
        <span>{coverage.byGame[game].toLocaleString()} loaded references</span>
        <span>
          {timings
            ? `${Math.round(timings.totalMs)} ms last local frame · ${Math.round(timings.matchingMs)} ms matching`
            : "Timing appears after a real analyzed frame"}
        </span>
      </div>
      <p className="live-rule">
        {mode === "stream"
          ? "Remove all cards for at least 1.2 seconds before the next copy. No detected cards for that long rearms counting, so prolonged blur or glare can also cause a repeat. Undo accidental repeats."
          : "Keep one page / layout in view. Brief gaps do not reset counted cards. Tap New page only when changing the layout."}{" "}
        Printing, finish and physical condition stay unconfirmed. Show all four
        card edges with background around them; separate overlapping cards.
      </p>
      <button
        className="pack-toggle"
        aria-expanded={packOpen}
        onClick={() => setPackOpen(!packOpen)}
      >
        <FolderOpen size={16} />
        {installedCount.toLocaleString()} installed references · manage offline
        packs
      </button>
      {packOpen && (
        <div className="pack-manager">
          <p>
            Recognition only covers loaded references. Packs contain local
            visual descriptors, not a cloud photo service. No full-game pack is
            bundled. Build one with the included index builder or import
            compatible shards.
          </p>
          <label className="button subtle">
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
          {available.map((p) => (
            <button
              key={p.id}
              className="button subtle"
              disabled={active || busy}
              onClick={() => void install(p)}
            >
              <Download size={15} />
              {p.name} · {p.cards.toLocaleString()} references
            </button>
          ))}
          {packs.map((p) => (
            <div key={p.id} className="pack-row">
              <span>
                {p.name} · {p.cards.toLocaleString()} references ·{" "}
                {(p.bytes / 1048576).toFixed(1)} MB
                <small>
                  {p.coverage?.scope === "full-catalog"
                    ? "Whole-catalog source"
                    : (p.coverage?.scope ?? "custom coverage")}{" "}
                  · {p.readiness}
                  {p.coverage?.shard &&
                    ` · shard ${p.coverage.shard.index}/${p.coverage.shard.total}`}
                  {p.coverage?.availableImages !== undefined &&
                    ` · source has ${p.coverage.availableImages.toLocaleString()} image references`}
                  {p.coverage &&
                    ` · ${p.coverage.missingImages} missing images, ${p.coverage.failedImages} extraction failures`}
                </small>
              </span>
              <button
                disabled={active || busy}
                onClick={() =>
                  void removeReferencePack(p.id)
                    .then(refreshPacks)
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Remove
              </button>
            </div>
          ))}
          <small>
            Installed packs stay in this browser. Export your collection
            separately. Stop the camera before changing reference packs.
          </small>
        </div>
      )}
      {saved.length > 0 && (
        <div className="scan-receipts">
          <h3>Added this session</h3>
          {saved.map((s) => (
            <article key={s.eventId}>
              <div>
                <strong>{s.reference.name}</strong>
                <small>
                  {s.undone
                    ? "Undone"
                    : "Saved locally · condition and finish unknown"}
                </small>
                {!s.undone && <Quote reference={s.reference} />}
              </div>
              <button
                className="button subtle"
                disabled={s.undone}
                onClick={() => {
                  const failure = callbacks.current.onUndo(s.eventId);
                  if (failure) {
                    setError(failure);
                    return;
                  }
                  session.current?.undo(s.eventId);
                  setTracks((old) =>
                    old.map((t) =>
                      t.eventId === s.eventId
                        ? {
                            ...t,
                            counted: false,
                            status: "undone",
                            message: "Undone",
                          }
                        : t,
                    ),
                  );
                  setSaved((old) =>
                    old.map((x) =>
                      x.eventId === s.eventId ? { ...x, undone: true } : x,
                    ),
                  );
                }}
              >
                <Undo2 size={14} />
                Undo
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
