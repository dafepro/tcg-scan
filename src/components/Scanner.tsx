import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Camera,
  Check,
  Circle,
  ImagePlus,
  LoaderCircle,
  Maximize,
  RotateCcw,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Video,
  X,
} from "lucide-react";
import type { Game } from "../types";
import { GAME_SHORT } from "../types";
import {
  prepareImage,
  recognizeCard,
  validateImageFile,
} from "../lib/recognition";
import type { RecognitionProgress } from "../lib/recognition";
import "./scanner.css";

interface ScannerProps {
  game: Game;
  onRecognized: (text: string) => void;
  onManualSearch: () => void;
}

type CameraState = "off" | "starting" | "on";
const INITIAL_PROGRESS: RecognitionProgress = {
  label: "Preparing your photo…",
  progress: 0,
};

function cameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    )
      return "Camera access was not allowed. Enable it in your browser’s site settings, or upload a photo below.";
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")
      return "No camera was found. Connect a camera or upload a card photo.";
    if (error.name === "NotReadableError" || error.name === "TrackStartError")
      return "Your camera is busy or unavailable. Close other apps using it, then try again.";
    if (error.name === "OverconstrainedError")
      return "This camera could not start with these settings. Try uploading a photo instead.";
  }
  return "The camera could not start. Try again, upload a photo, or search by name.";
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "This image could not be opened. Try a different JPG, PNG, or WebP photo.",
        ),
      );
    image.src = url;
  });
}

export default function Scanner({
  game,
  onRecognized,
  onManualSearch,
}: ScannerProps) {
  const [camera, setCamera] = useState<CameraState>("off");
  const [videoReady, setVideoReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState(INITIAL_PROGRESS);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [rawText, setRawText] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingDownload, setRecordingDownload] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const [recordingMessage, setRecordingMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef<AbortController | null>(null);
  const cameraRequest = useRef(0);
  const operation = useRef(0);
  const busyRef = useRef(false);
  const cameraStarting = useRef(false);
  const mounted = useRef(true);
  const previewRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingURLRef = useRef<string | null>(null);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearPreview() {
    if (previewRef.current?.startsWith("blob:"))
      URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }

  function setPreviewURL(url: string) {
    if (previewRef.current?.startsWith("blob:"))
      URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  }

  function cancelScan() {
    operation.current += 1;
    scanRef.current?.abort();
    scanRef.current = null;
    busyRef.current = false;
    setBusy(false);
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (recordingTimer.current) clearInterval(recordingTimer.current);
    recordingTimer.current = null;
    setRecording(false);
  }

  function stopCamera() {
    cameraRequest.current += 1;
    cameraStarting.current = false;
    stopRecording();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera("off");
    setVideoReady(false);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      cameraRequest.current += 1;
      scanRef.current?.abort();
      if (recordingTimer.current) clearInterval(recordingTimer.current);
      if (recorderRef.current) {
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onerror = null;
        recorderRef.current.onstop = null;
        if (recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewRef.current?.startsWith("blob:"))
        URL.revokeObjectURL(previewRef.current);
      if (recordingURLRef.current) URL.revokeObjectURL(recordingURLRef.current);
    };
  }, []);

  useEffect(() => {
    operation.current += 1;
    cameraRequest.current += 1;
    cameraStarting.current = false;
    scanRef.current?.abort();
    scanRef.current = null;
    busyRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (recordingTimer.current) clearInterval(recordingTimer.current);
    recordingTimer.current = null;
    if (previewRef.current?.startsWith("blob:"))
      URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setCamera("off");
    setVideoReady(false);
    setBusy(false);
    setPreview(null);
    setError("");
    setCandidates([]);
    setRawText("");
    setRecording(false);
  }, [game]);

  async function startCamera() {
    if (cameraStarting.current || streamRef.current) return;
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "Camera access needs HTTPS or localhost and a supported browser. You can still upload a photo or search by name.",
      );
      return;
    }
    clearPreview();
    setCandidates([]);
    setRawText("");
    const request = ++cameraRequest.current;
    cameraStarting.current = true;
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (!mounted.current || request !== cameraRequest.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      cameraStarting.current = false;
      setCamera("on");
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      for (const track of stream.getVideoTracks()) {
        track.onended = () => {
          if (streamRef.current !== stream || !mounted.current) return;
          stopCamera();
          setError(
            "The camera disconnected. Start it again or upload a photo.",
          );
        };
      }
    } catch (cause) {
      if (!mounted.current || request !== cameraRequest.current) return;
      stopCamera();
      setError(cameraError(cause));
    }
  }

  async function scanCanvas(canvas: HTMLCanvasElement, token: number) {
    const abort = new AbortController();
    scanRef.current = abort;
    try {
      const result = await recognizeCard(canvas, game, abort.signal, (next) => {
        if (mounted.current && token === operation.current) setProgress(next);
      });
      if (
        !mounted.current ||
        token !== operation.current ||
        abort.signal.aborted
      )
        return;
      setRawText(result.text);
      setCandidates(result.candidates);
      if (result.candidates.length) onRecognized(result.candidates[0]);
      else
        setError(
          "No clear card title was found. Try bright, even light, move closer, and keep the title in focus. You can also search by name.",
        );
    } catch (cause) {
      if (
        !mounted.current ||
        token !== operation.current ||
        abort.signal.aborted
      )
        return;
      setError(
        cause instanceof Error
          ? cause.message
          : "This photo could not be read. Try again or search by name.",
      );
    } finally {
      if (mounted.current && token === operation.current) {
        setBusy(false);
        busyRef.current = false;
        scanRef.current = null;
      }
    }
  }

  function beginScan() {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setProgress(INITIAL_PROGRESS);
    setError("");
    setCandidates([]);
    setRawText("");
    return ++operation.current;
  }

  async function captureCard() {
    const video = videoRef.current;
    const guide = guideRef.current;
    if (!video || !guide || video.readyState < 2 || !video.videoWidth) return;
    const token = beginScan();
    if (token === null) return;
    try {
      const videoBox = video.getBoundingClientRect();
      const guideBox = guide.getBoundingClientRect();
      // Match the displayed object-fit: cover video to the visible card guide.
      const scale = Math.max(
        videoBox.width / video.videoWidth,
        videoBox.height / video.videoHeight,
      );
      const offsetX = (video.videoWidth * scale - videoBox.width) / 2;
      const offsetY = (video.videoHeight * scale - videoBox.height) / 2;
      const sx = Math.max(0, (guideBox.left - videoBox.left + offsetX) / scale);
      const sy = Math.max(0, (guideBox.top - videoBox.top + offsetY) / scale);
      const sw = Math.min(video.videoWidth - sx, guideBox.width / scale);
      const sh = Math.min(video.videoHeight - sy, guideBox.height / scale);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error(
          "This browser could not capture the photo. Try uploading an image.",
        );
      context.drawImage(
        video,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      setPreviewURL(canvas.toDataURL("image/jpeg", 0.92));
      await scanCanvas(
        prepareImage(canvas, canvas.width, canvas.height),
        token,
      );
    } catch (cause) {
      if (token !== operation.current || !mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "The photo could not be captured. Please try again.",
      );
      setBusy(false);
      busyRef.current = false;
    }
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyRef.current) return;
    const validation = validateImageFile(file);
    if (validation) {
      setError(validation);
      return;
    }
    const token = beginScan();
    if (token === null) return;
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      if (token !== operation.current || !mounted.current) {
        URL.revokeObjectURL(url);
        return;
      }
      const canvas = prepareImage(
        image,
        image.naturalWidth,
        image.naturalHeight,
      );
      setPreviewURL(url);
      await scanCanvas(canvas, token);
    } catch (cause) {
      URL.revokeObjectURL(url);
      if (token !== operation.current || !mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "The photo could not be opened. Try another image.",
      );
      setBusy(false);
      busyRef.current = false;
    }
  }

  function scanAnother() {
    cancelScan();
    clearPreview();
    setCandidates([]);
    setRawText("");
    setError("");
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || recorderRef.current?.state === "recording") return;
    if (typeof MediaRecorder === "undefined") {
      setRecordingMessage(
        "This browser cannot record video. Card photos still work.",
      );
      return;
    }
    const mime = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    try {
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      const chunks: Blob[] = [];
      let totalBytes = 0;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunks.push(event.data);
        totalBytes += event.data.size;
        if (totalBytes >= 150 * 1024 * 1024 && recorder.state === "recording") {
          stopRecording();
          setRecordingMessage(
            "Recording stopped at the 150 MB memory limit. Your clip is ready to download.",
          );
        }
      };
      recorder.onerror = () => {
        stopRecording();
        setRecordingMessage(
          "Recording was interrupted. Any captured video will be offered for download.",
        );
      };
      recorder.onstop = () => {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (!mounted.current) return;
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "video/webm",
        });
        if (!blob.size) {
          setRecordingMessage(
            "No video was captured. Please try recording again.",
          );
          return;
        }
        if (recordingURLRef.current)
          URL.revokeObjectURL(recordingURLRef.current);
        const url = URL.createObjectURL(blob);
        recordingURLRef.current = url;
        const extension = blob.type.includes("mp4") ? "mp4" : "webm";
        setRecordingDownload({
          url,
          name: `tcg-scan-pack-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
        });
        setRecording(false);
      };
      recorder.start(2000);
      setRecording(true);
      setRecordingSeconds(0);
      setRecordingMessage(
        "Video only. Stored in this tab until you download it. Maximum 10 minutes.",
      );
      const started = Date.now();
      recordingTimer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        setRecordingSeconds(seconds);
        if (seconds >= 600) {
          stopRecording();
          setRecordingMessage("Your 10-minute clip is ready to download.");
        }
      }, 1000);
    } catch {
      setRecordingMessage(
        "Video recording is not available with this camera. You can still scan individual cards.",
      );
    }
  }

  const cameraActive = camera === "on";
  const hasPreview = Boolean(preview);
  const canRecord = cameraActive && videoReady;
  const minutes = Math.floor(recordingSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (recordingSeconds % 60).toString().padStart(2, "0");

  return (
    <section
      className="scanner-panel"
      aria-label={`${GAME_SHORT[game]} card scanner`}
    >
      <div className="scanner-heading">
        <div className="scanner-heading-title">
          <ScanLine size={18} />
          <span>Card scanner</span>
        </div>
        <span
          className={`scanner-camera-status ${cameraActive ? "is-on" : ""}`}
        >
          <span />
          {cameraActive
            ? "Camera live"
            : camera === "starting"
              ? "Connecting"
              : "Camera off"}
        </span>
      </div>

      <div
        className={`scanner-viewport ${cameraActive ? "is-live" : ""} ${hasPreview ? "has-preview" : ""}`}
      >
        <video
          ref={videoRef}
          className="scanner-video"
          autoPlay
          muted
          playsInline
          aria-label="Live camera preview"
          onLoadedData={() => setVideoReady(true)}
        />
        {preview && (
          <img
            className="scanner-preview"
            src={preview}
            alt="Your card photo, processed only on this device"
          />
        )}
        <div className="scanner-view-top">
          <span>
            <span className="scanner-view-dot" />
            {GAME_SHORT[game]}
          </span>
          <span>
            <ShieldCheck size={12} /> On-device
          </span>
        </div>

        {!hasPreview && (
          <>
            <div
              ref={guideRef}
              className={`scanner-guide ${cameraActive ? "camera-guide" : "idle-guide"}`}
              aria-hidden="true"
            >
              <i className="guide-corner top-left" />
              <i className="guide-corner top-right" />
              <i className="guide-corner bottom-left" />
              <i className="guide-corner bottom-right" />
              {!cameraActive && (
                <div className="scanner-card-illustration">
                  <div className="illustration-card-back" />
                  <div className="illustration-card-front">
                    <div className="illustration-card-top">
                      <span />
                      <Sparkles size={12} />
                    </div>
                    <div className="illustration-orbit orbit-one" />
                    <div className="illustration-orbit orbit-two" />
                    <div className="illustration-diamond">
                      <ScanLine strokeWidth={1.15} size={39} />
                    </div>
                    <div className="illustration-card-bottom">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              )}
            </div>
            {cameraActive ? (
              <div className="scanner-align-hint">
                <Maximize size={14} /> Fit one card inside the frame
              </div>
            ) : (
              <div className="scanner-idle-copy">
                <h3>
                  A little scan.
                  <br />A great discovery.
                </h3>
                <p>Turn your cards into a collection.</p>
              </div>
            )}
          </>
        )}

        {recording && (
          <span className="scanner-record-indicator">
            <span /> REC {minutes}:{seconds}
          </span>
        )}

        {busy && (
          <div
            className="scanner-progress-overlay"
            role="status"
            aria-live="polite"
          >
            <div className="scanner-progress-card">
              <LoaderCircle className="scanner-spin" size={24} />
              <strong>{progress.label}</strong>
              <p>Your photo stays on this device.</p>
              <div
                className="scanner-progress-track"
                role="progressbar"
                aria-label="Card recognition progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress.progress * 100)}
              >
                <span style={{ width: `${progress.progress * 100}%` }} />
              </div>
              <button type="button" onClick={cancelScan}>
                Cancel scan
              </button>
            </div>
          </div>
        )}

        {hasPreview && !busy && (
          <div className="scanner-preview-label">
            <Check size={14} /> Photo ready{" "}
            <button
              type="button"
              onClick={scanAnother}
              aria-label="Clear photo and scan another card"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!hasPreview && cameraActive && !busy && (
          <button
            type="button"
            className="scanner-shutter"
            onClick={() => void captureCard()}
            disabled={!videoReady}
            aria-label="Capture and read card"
          >
            <span>
              <Camera size={22} />
            </span>
          </button>
        )}
        {!cameraActive && !hasPreview && (
          <span className="scanner-viewport-note">
            ONE CARD. ENDLESS POSSIBILITIES.
          </span>
        )}
      </div>

      <div className="scanner-controls">
        {hasPreview ? (
          <button
            type="button"
            className="scanner-btn scanner-primary"
            onClick={scanAnother}
            disabled={busy}
          >
            <RotateCcw size={17} />
            Scan another
          </button>
        ) : cameraActive ? (
          <button
            type="button"
            className="scanner-btn scanner-primary"
            onClick={() => void captureCard()}
            disabled={busy || !videoReady}
          >
            <ScanLine size={18} />
            Capture card
          </button>
        ) : (
          <button
            type="button"
            className="scanner-btn scanner-primary"
            onClick={() => void startCamera()}
            disabled={busy || camera === "starting"}
          >
            {camera === "starting" ? (
              <LoaderCircle className="scanner-spin" size={17} />
            ) : (
              <Camera size={17} />
            )}
            {camera === "starting" ? "Starting camera…" : "Start camera"}
            <ArrowRight className="scanner-btn-arrow" size={16} />
          </button>
        )}
        <button
          type="button"
          className="scanner-btn scanner-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy || camera === "starting"}
        >
          <ImagePlus size={17} />
          Upload photo
        </button>
        {(cameraActive || camera === "starting") && (
          <button
            type="button"
            className="scanner-stop-camera"
            onClick={stopCamera}
            title="Stop camera"
            aria-label="Stop camera"
          >
            <Square size={15} />
          </button>
        )}
        <input
          ref={fileRef}
          className="scanner-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Choose card photo"
          onChange={(event) => void choosePhoto(event)}
        />
      </div>

      {error && (
        <div className="scanner-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onManualSearch}>
            <Search size={14} />
            Search by name
          </button>
        </div>
      )}
      {candidates.length > 0 && (
        <div className="scanner-readout">
          <div>
            <Check size={15} />
            <strong>Title read</strong>
            <span>Review the catalog matches before adding.</span>
          </div>
          <div className="scanner-name-options">
            {candidates.slice(0, 3).map((name, index) => (
              <button
                type="button"
                key={name}
                onClick={() => onRecognized(name)}
                className={index === 0 ? "primary-candidate" : ""}
              >
                {name}
                <ArrowRight size={12} />
              </button>
            ))}
          </div>
        </div>
      )}
      {rawText && (
        <details className="scanner-raw-text">
          <summary>View extracted text</summary>
          <pre>{rawText}</pre>
          <p>
            OCR text can contain mistakes. The catalog match is your choice.
          </p>
        </details>
      )}

      <div className="scanner-tips">
        <div className="scanner-tip-icon">
          <Sparkles size={15} />
        </div>
        <p>
          <strong>For the best read</strong>
          <span>One card, good light, no glare. Keep the title sharp.</span>
        </p>
      </div>
      <div className="scanner-privacy">
        <ShieldCheck size={13} />
        <p>
          Photos stay on your device. First scan downloads an English OCR model.
          The detected name is used to search the card catalog.
        </p>
      </div>

      <div className="scanner-recording-bar">
        <div>
          <Video size={17} />
          <span>
            Opening a pack?<small>Keep a local video of the moment.</small>
          </span>
        </div>
        {recording ? (
          <button type="button" onClick={stopRecording}>
            <Square size={12} fill="currentColor" />
            Stop {minutes}:{seconds}
          </button>
        ) : (
          <button type="button" onClick={startRecording} disabled={!canRecord}>
            <Circle size={12} />
            Record
          </button>
        )}
      </div>
      {(recordingMessage || recordingDownload) && (
        <div className="scanner-recording-detail">
          {recordingMessage && <p>{recordingMessage}</p>}
          {recordingDownload && (
            <a href={recordingDownload.url} download={recordingDownload.name}>
              <ArrowDownToLine size={14} />
              Download recording
            </a>
          )}
        </div>
      )}
    </section>
  );
}
