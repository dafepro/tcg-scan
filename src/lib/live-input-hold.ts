import type { LiveCaptureLoop } from "./live-capture";
import type { LiveVideoSource } from "./live-video-source";

/** Diagnostic input hold only. The caller owns the held flag and frame epoch.
 * No printing session is accepted here: an already offered crop keeps its
 * existing ownership, while acquisition and unsaved identity evidence stop. */
export function holdLiveVideoInput(options: {
  source: Pick<LiveVideoSource, "pause">;
  capture: Pick<LiveCaptureLoop, "pause"> | null;
  interruptEvidence(): void;
  cancelPendingFrame(): void;
}) {
  options.capture?.pause();
  options.source.pause();
  options.interruptEvidence();
  options.cancelPendingFrame();
}
