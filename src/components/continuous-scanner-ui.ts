import type { ScanTrack } from "../lib/scan-session";

const STATUS_LABELS: Record<ScanTrack["status"], string> = {
  stabilizing: "Hold",
  matching: "Matching",
  added: "Added",
  review: "Matched",
  quality: "Check",
  saving: "Saving",
  error: "Error",
  undone: "Undone",
};

/** Presentation only. A rejected proposal never becomes an asserted identity. */
export function scannerTrackPresentation(
  track: Pick<ScanTrack, "status" | "reference" | "evidence" | "message">,
  photo: boolean,
  autoSave: boolean,
) {
  if (photo && !track.evidence?.autoEligible)
    return {
      name: "Unmatched region",
      label: "Not identified",
      message:
        track.message || "Try another photo with all four card edges visible.",
    };
  return {
    name: track.reference?.name ?? "Card region",
    label:
      track.status === "review"
        ? photo
          ? "Ready to save"
          : autoSave
            ? "Matched"
            : "Preview only"
        : STATUS_LABELS[track.status],
    message:
      !photo && !autoSave && track.status === "review"
        ? "Auto-save is off. Turn it on to save a fresh match; nothing is queued."
        : track.message,
  };
}

export function cameraFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (
    ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)
  )
    return "Camera permission was denied. Allow camera access in this browser’s site settings, then try Start again. You can also use a multi-card photo.";
  if (["NotFoundError", "DevicesNotFoundError"].includes(name))
    return "No camera was found. Connect a camera and try Start again, or use a multi-card photo.";
  if (["NotReadableError", "TrackStartError"].includes(name))
    return "The camera is busy or unavailable. Close other apps using it, then try Start again. You can also use a multi-card photo.";
  if (["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(name))
    return "This camera could not provide the requested video. Try another camera or use a multi-card photo.";
  if (name === "AbortError")
    return "Camera startup was interrupted. Try Start again, or use a multi-card photo.";
  return error instanceof Error ? error.message : String(error);
}
