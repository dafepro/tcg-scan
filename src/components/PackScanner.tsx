import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Film, Pause, Play, Square, Undo2 } from "lucide-react";
import type { Game } from "../types";
import { VisionClient } from "../lib/vision";
import type { ReferenceMetadata } from "../lib/vision";
import { listLearnedPacks } from "../lib/learned-packs";
import { PackCaptureLoop } from "../lib/pack-capture";
import type { PackCaptureStats } from "../lib/pack-capture";
import { PackSession } from "../lib/pack-session";
import type { PackReceipt, PackSaveIntent } from "../lib/pack-session";
import { cameraFailureMessage } from "./continuous-scanner-ui";
import { referenceCard } from "../lib/scan-inventory";
import { ReferenceQuotes } from "./ReferenceQuotes";
import "./pack-scanner.css";

type Props = {
  game: Game;
  onSave(reference: ReferenceMetadata, eventId: string): string | undefined;
  onUndo(eventId: string): string | undefined;
  onSetup(): void;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const seconds = (value: number) => `${Math.max(0, value).toFixed(1)}s`;
const stateNames: Record<PackReceipt["status"], string> = {
  queued: "Queued",
  identifying: "Identifying",
  saving: "Saving",
  saved: "Saved",
  review: "Not identified",
  duplicate: "Repeated identity",
  dropped: "View omitted",
  cancelled: "Cancelled",
  error: "Save failed",
  undone: "Undone",
};
function metadata(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        new Error(
          "This video could not be decoded. Choose a supported MP4 or WebM.",
        ),
      );
    };
    const cancelled = () => {
      cleanup();
      reject(new DOMException("Preparation cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Video metadata took too long to load."));
    }, 15_000);
    video.addEventListener("loadedmetadata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else if (video.readyState >= 1) ready();
  });
}
export default function PackScanner({ game, onSave, onUndo, onSetup }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const loop = useRef<PackCaptureLoop | null>(null);
  const client = useRef<VisionClient | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const session = useRef<PackSession | null>(null);
  const sourceUrl = useRef<string | null>(null);
  const saveError = useRef<string | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const controlEpoch = useRef(0);
  const generation = useRef(0),
    busyRef = useRef(false),
    pausedRef = useRef(false);
  const kindRef = useRef<"camera" | "video">("camera");
  const callbacks = useRef({ onSave, onUndo });
  useEffect(() => {
    callbacks.current = { onSave, onUndo };
  }, [onSave, onUndo]);
  const [references, setReferences] = useState<number | null>(null);
  const [busy, setBusy] = useState(false),
    [active, setActive] = useState(false),
    [paused, setPaused] = useState(false),
    [draining, setDraining] = useState(false);
  const [sourceKind, setSourceKind] = useState<"camera" | "video">("camera");
  const [message, setMessage] = useState(
    "Capture each reveal. Local identification can finish after a card leaves the frame.",
  );
  const [error, setError] = useState("");
  const [receipts, setReceipts] = useState<PackReceipt[]>([]);
  const [prunedReceipts, setPrunedReceipts] = useState(0);
  const [stats, setStats] = useState<PackCaptureStats>();
  const [showAll, setShowAll] = useState(false);
  const [mediaSize, setMediaSize] = useState({ width: 1280, height: 720 });
  const refresh = () => {
    setReceipts(session.current?.snapshot() ?? []);
    setPrunedReceipts(session.current?.prunedReceiptCount ?? 0);
  };
  const release = useCallback((cancel: boolean) => {
    generation.current++;
    controlEpoch.current++;
    preparation.current?.abort();
    preparation.current = null;
    loop.current?.dispose();
    loop.current = null;
    client.current?.dispose();
    client.current = null;
    if (cancel) session.current?.cancel();
    for (const track of stream.current?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.stop();
    }
    stream.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
      video.current.removeAttribute("src");
      video.current.load();
    }
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = null;
    busyRef.current = false;
    pausedRef.current = false;
  }, []);
  const stop = useCallback(
    (
      text = "Stopped. Saved cards are kept; unsaved captured views were cancelled.",
    ) => {
      release(true);
      setBusy(false);
      setActive(false);
      setPaused(false);
      setDraining(false);
      setStats((old) =>
        old
          ? {
              ...old,
              queued: 0,
              inFlight: 0,
              retainedBytes: 0,
              captureEnded: true,
            }
          : old,
      );
      setMessage(text);
      setReceipts(session.current?.snapshot() ?? []);
    },
    [release],
  );
  useEffect(() => {
    let current = true;
    void listLearnedPacks()
      .then((packs) => {
        if (current)
          setReferences(
            packs
              .filter((pack) => pack.readiness === "ready")
              .reduce((n, pack) => n + pack.byGame[game], 0),
          );
      })
      .catch((error) => {
        if (current) {
          setReferences(0);
          setError(errorText(error));
        }
      });
    return () => {
      current = false;
      release(true);
    };
  }, [game, release]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && busyRef.current) {
        stop(
          "Preparation cancelled while the tab was hidden. Start again when ready.",
        );
      } else if (document.hidden && loop.current) {
        controlEpoch.current++;
        loop.current.pause();
        pausedRef.current = true;
        setPaused(true);
        if (kindRef.current === "video") video.current?.pause();
        setMessage(
          "Paused while the tab is hidden. Resume to continue queued identification.",
        );
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [stop]);
  function persist(intent: PackSaveIntent) {
    const current = session.current;
    if (!current || pausedRef.current) return;
    let failure: string | undefined;
    try {
      failure = callbacks.current.onSave(intent.reference, intent.eventId);
    } catch (error) {
      failure = errorText(error);
    }
    current.acknowledge(intent.eventId, failure);
    if (failure) {
      saveError.current = failure;
      setError(failure);
    } else if (
      !current.snapshot().some((receipt) => receipt.status === "error")
    ) {
      const previousSaveError = saveError.current;
      saveError.current = null;
      setError((previous) => (previous === previousSaveError ? "" : previous));
    }
  }
  async function start(file?: File) {
    if (busyRef.current || active || !references) return;
    release(true);
    busyRef.current = true;
    setBusy(true);
    setActive(false);
    setPaused(false);
    setDraining(false);
    setError("");
    saveError.current = null;
    setStats(undefined);
    setReceipts([]);
    setPrunedReceipts(0);
    setShowAll(false);
    kindRef.current = file ? "video" : "camera";
    setSourceKind(kindRef.current);
    const gen = generation.current,
      controller = new AbortController();
    preparation.current = controller;
    const current = () =>
      gen === generation.current && !controller.signal.aborted;
    const s = new PackSession(crypto.randomUUID());
    session.current = s;
    let openingCamera = !file;
    try {
      const element = video.current;
      if (!element) throw new Error("The video preview is unavailable.");
      if (!window.isSecureContext)
        throw new Error(
          "Camera and local recognition need HTTPS or localhost.",
        );
      if (file) {
        if (
          file.size === 0 ||
          file.size > 250 * 1024 * 1024 ||
          (!/^(video\/(mp4|webm)|application\/octet-stream)$/.test(file.type) &&
            !/\.(mp4|webm)$/i.test(file.name))
        )
          throw new Error("Choose a nonempty MP4 or WebM video under 250 MB.");
        setMessage(
          "Opening local video. Playback stays at its original speed.",
        );
        sourceUrl.current = URL.createObjectURL(file);
        element.src = sourceUrl.current;
        element.load();
        await metadata(element, controller.signal);
        if (!current()) return;
        if (
          !Number.isFinite(element.duration) ||
          element.duration <= 0 ||
          element.duration > 300
        )
          throw new Error("Choose a video of at most five minutes.");
        if (Math.max(element.videoWidth, element.videoHeight) > 1920)
          throw new Error(
            "Choose a video with a longest edge of 1920 pixels or less.",
          );
      } else {
        setMessage(
          "Waiting for camera access. Cancel preparation is available.",
        );
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("Camera access is unavailable in this browser.");
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
          },
          audio: false,
        });
        if (!current()) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        element.srcObject = media;
        await element.play();
        if (!current()) return;
        for (const track of media.getVideoTracks()) {
          track.onended = () => {
            if (current())
              stop(
                "Camera disconnected. Pending captured views were cancelled; saved cards remain.",
              );
          };
          track.onmute = () => {
            if (current())
              stop(
                "Camera frames were interrupted. Pending views were cancelled; start a new capture when the camera is available.",
              );
          };
        }
      }
      openingCamera = false;
      setMediaSize({
        width: element.videoWidth || 1280,
        height: element.videoHeight || 720,
      });
      setMessage("Preparing the local pack matcher…");
      const local = new VisionClient();
      client.current = local;
      const ready = await local.initialize(
        { matcher: "learned", game },
        (text) => {
          if (current()) setMessage(text);
        },
      );
      if (!current()) return;
      if (!ready.coverage.byGame[game])
        throw new Error(
          "No learned references for this game are ready. Install the database first.",
        );
      const capture = new PackCaptureLoop({
        video: element,
        client: local,
        game,
        sessionId: s.sessionId,
        sourceId: crypto.randomUUID(),
        frameLimit: 1920,
        onQueued: (view) => {
          if (current()) {
            s.queue(view);
            refresh();
          }
        },
        onIdentifying: (view, startedAt) => {
          if (current()) {
            s.identifying(view.captureId, startedAt);
            refresh();
          }
        },
        onOmitted: (captureId, reason) => {
          if (current()) {
            s.drop(captureId, reason);
            refresh();
          }
        },
        onResult: (view, result, timing) => {
          if (!current() || pausedRef.current) return;
          for (const intent of s.consume(
            view.captureId,
            result,
            timing.completedAt,
            true,
          ))
            persist(intent);
          refresh();
        },
        onStats: (value) => {
          if (current()) {
            setStats(value);
            if (value.captureEnded) {
              setDraining(true);
              setMessage(
                "Capture finished. Processing the remaining genuine captured views…",
              );
            }
          }
        },
        onError: (error) => {
          if (current()) {
            stop();
            setError(errorText(error));
          }
        },
        onDrained: () => {
          if (current()) {
            release(false);
            setBusy(false);
            setActive(false);
            setPaused(false);
            setDraining(false);
            setMessage(
              "Captured views processed. Check saved identities and any unmatched views below.",
            );
            refresh();
          }
        },
      });
      loop.current = capture;
      element.playbackRate = 1;
      await element.play();
      if (!current()) return;
      busyRef.current = false;
      setBusy(false);
      setActive(true);
      setMessage(
        file
          ? "Playing local video at 1×. Captured views may finish identifying after playback."
          : "Capturing reveals. Finish capture to process the remaining queued views.",
      );
      capture.start();
    } catch (error) {
      if (current()) {
        stop("Preparation stopped. No pending view will be saved.");
        setError(
          openingCamera ? cameraFailureMessage(error) : errorText(error),
        );
      }
    }
  }
  function finish() {
    if (!loop.current || pausedRef.current) return;
    setDraining(true);
    setMessage(
      "Capture finished. Processing the remaining genuine captured views…",
    );
    loop.current.finishCapture();
    video.current?.pause();
    for (const track of stream.current?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.stop();
    }
  }
  async function togglePause() {
    const target = loop.current,
      gen = generation.current,
      epoch = controlEpoch.current;
    if (!target || document.hidden) return;
    if (!pausedRef.current) {
      controlEpoch.current++;
      target.pause();
      pausedRef.current = true;
      setPaused(true);
      if (kindRef.current === "video") video.current?.pause();
      setMessage("Paused. Queued views and unsaved results wait for Resume.");
    } else {
      try {
        if (kindRef.current === "video" && !draining && !video.current?.ended)
          await video.current?.play();
        if (
          gen !== generation.current ||
          epoch !== controlEpoch.current ||
          target !== loop.current ||
          document.hidden ||
          !pausedRef.current
        )
          return;
        pausedRef.current = false;
        setPaused(false);
        target.resume();
        setMessage("Resumed local captured-view identification.");
      } catch (error) {
        if (
          gen === generation.current &&
          epoch === controlEpoch.current &&
          target === loop.current
        )
          setError(errorText(error));
      }
    }
  }
  function undo(receipt: PackReceipt) {
    if (!receipt.eventId) return;
    try {
      const error = callbacks.current.onUndo(receipt.eventId);
      if (error) setError(error);
      else {
        session.current?.undo(receipt.eventId);
        refresh();
      }
    } catch (error) {
      setError(errorText(error));
    }
  }
  const saved = receipts.filter((receipt) => receipt.status === "saved");
  const important = receipts.filter((receipt) =>
    ["saved", "error", "undone"].includes(receipt.status),
  );
  const shown = showAll
    ? receipts.slice(-100).reverse()
    : important.slice(-40).reverse();
  return (
    <section className="pack-scanner panel" aria-label="Pack opening scanner">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">LOCAL CAPTURED-VIEW RECOGNITION</span>
          <h2>Catch the reveal.</h2>
        </div>
        <Film size={24} />
      </div>
      <p className="section-description">
        Show one card at a time. Clear captured views can be identified after
        the card moves away.
      </p>
      <p className="recognition-caution">
        Experimental pack mode · check every card and the saved count. Blur or
        hidden detail can prevent a match.
      </p>
      <p className="pack-ready">
        {references === null
          ? "Checking installed references…"
          : `${references.toLocaleString()} learned references available for this game.`}
      </p>
      {references === 0 && (
        <button className="button primary" onClick={onSetup}>
          Set up reference database
        </button>
      )}
      <div className="pack-actions">
        {!active && !busy && (
          <>
            <button
              className="button primary"
              disabled={!references}
              onClick={() => void start()}
            >
              <Camera size={17} />
              Start pack camera
            </button>
            <label className="button subtle" aria-disabled={!references}>
              <Film size={17} />
              Scan local video
              <input
                className="sr-only"
                type="file"
                accept="video/mp4,video/webm,.mp4,.webm"
                disabled={!references}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void start(file);
                }}
              />
            </label>
          </>
        )}
        {busy && (
          <button
            className="button subtle"
            onClick={() =>
              stop("Preparation cancelled. Nothing new was saved.")
            }
          >
            Cancel preparation
          </button>
        )}
        {active && (
          <>
            <button
              className="button subtle"
              onClick={() => void togglePause()}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {paused ? "Resume pack" : "Pause pack"}
            </button>
            <button
              className="button primary"
              disabled={paused || draining || stats?.captureEnded}
              onClick={finish}
            >
              <Check size={16} />
              Finish capture
            </button>
            <button className="button subtle" onClick={() => stop()}>
              <Square size={15} />
              Stop pack
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="pack-error" role="alert">
          {error}
        </div>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      <div
        className="pack-preview"
        style={{ aspectRatio: `${mediaSize.width} / ${mediaSize.height}` }}
      >
        <video
          ref={video}
          muted
          playsInline
          preload="metadata"
          aria-label="Pack capture preview"
        />
        {active && (
          <span className="pack-preview-state">
            {paused
              ? "Paused"
              : draining
                ? "Processing captured views"
                : "Capturing"}{" "}
            · {stats?.queued ?? 0} queued
          </span>
        )}
        {!active && !busy && (
          <div className="pack-preview-placeholder">
            <Film size={28} />
            <span>
              Camera or local video · recognition stays on your device
            </span>
          </div>
        )}
      </div>
      <div className="pack-capture-status" aria-live="polite">
        <strong>{saved.length} saved</strong>
        <span>
          {stats?.queued ?? 0} queued · {stats?.inFlight ?? 0} identifying
        </span>
        {stats && (
          <span>
            {(stats.retainedBytes / 1048576).toFixed(1)} / 48 MiB captured
            pixels
          </span>
        )}
      </div>
      {!!stats?.dropped && (
        <p className="pack-warning">
          {stats.dropped} captured views were dropped because the bounded queue
          filled. Check the pack and rescan missed cards. A complete capture is
          not guaranteed.
        </p>
      )}
      {!!stats?.expiredAcquisitions && (
        <p className="pack-warning">
          {stats.expiredAcquisitions} late frame acquisitions were discarded.
          Fresh-frame retries: {stats.captureRetries} of 8. Check the pack for
          missed reveals; discarded pixels are never used to identify a card.
        </p>
      )}
      <p className="pack-help">
        Saved rows are card identities. Printing, finish and condition stay
        unconfirmed, and these entries are excluded from collection valuation.
        Repeated identical identities count once per pack; adjust quantity in
        Collection for another indistinguishable copy.
      </p>
      <button
        className="button subtle"
        aria-expanded={showAll}
        onClick={() => setShowAll((value) => !value)}
      >
        {showAll
          ? "Show saved receipts"
          : `Show recent captured-view details (${receipts.length})`}
      </button>
      <ol className="pack-receipts">
        {shown.map((receipt) => (
          <li
            className="pack-receipt"
            key={receipt.captureId}
            data-capture-id={receipt.captureId}
            data-status={receipt.status}
            data-source-time={receipt.sourceFrame.mediaTime}
            data-captured-at={receipt.capturedAt}
            data-completed-at={receipt.completedAt}
            data-saved-at={receipt.savedAt}
          >
            <header>
              <h4>
                {receipt.reference?.name ?? `Captured view ${receipt.frameId}`}
              </h4>
              <span className={`receipt-state ${receipt.status}`}>
                {stateNames[receipt.status]}
              </span>
            </header>
            <p>
              Captured at source {seconds(receipt.sourceFrame.mediaTime)}
              {receipt.completedAt !== undefined
                ? ` · result ${seconds((receipt.completedAt - receipt.capturedAt) / 1000)} later`
                : ""}
            </p>
            <p>{receipt.reason}</p>
            {receipt.reference && receipt.status === "saved" && (
              <ReferenceQuotes card={referenceCard(receipt.reference)} />
            )}
            <div className="receipt-actions">
              {receipt.status === "saved" && (
                <button className="button subtle" onClick={() => undo(receipt)}>
                  <Undo2 size={14} />
                  Undo card
                </button>
              )}
              {receipt.status === "error" && receipt.eventId && (
                <button
                  className="button subtle"
                  disabled={paused}
                  onClick={() => {
                    const intent = session.current?.retry(receipt.eventId!);
                    if (intent) {
                      persist(intent);
                      refresh();
                    }
                  }}
                >
                  Retry save
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {!shown.length && (
        <p className="pack-help">
          {showAll
            ? "Captured views will appear here."
            : "Verified saved identities will appear here. These receipts refer to captured frames, not the card currently in the preview."}
        </p>
      )}
      {prunedReceipts > 0 && (
        <p className="pack-help">
          {prunedReceipts} older unmatched, repeated or omitted view receipts
          were removed from the bounded history. Saved-card and failed-save
          receipts are retained.
        </p>
      )}
      <details>
        <summary>Capture limits and counting</summary>
        <p>
          One local matcher processes a bounded queue of up to 12 views and 48
          MiB of queued/in-flight pixels. This excludes the bounded
          capture/return buffers and model/browser memory. Similar views can be
          omitted or replaced by clearer views. These scheduling decisions do
          not prove identity or a separate physical copy. Finish capture drains
          the queue; Stop cancels unsaved views. Camera disconnection and
          changing workflows cancel the session.
        </p>
        <p>
          Local videos play at 1× and must be MP4/WebM, at most five minutes,
          under 250 MB, with a longest edge no greater than 1920 pixels.{" "}
          {sourceKind === "video"
            ? "A saved result can arrive after its card has left the video frame."
            : "Hold enough detail in view for geometric verification."}
        </p>
        {stats && (
          <p>
            Views sampled: {stats.offered}; admitted: {stats.admitted}; omitted:{" "}
            {stats.omitted}; clearer replacements: {stats.replaced}; peak
            retained: {stats.peakRetainedViews} views /{" "}
            {(stats.peakRetainedBytes / 1048576).toFixed(1)} MiB. These are
            queue measurements, not recognition confidence.
          </p>
        )}
      </details>
    </section>
  );
}
