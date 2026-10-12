import type { ScanTrack } from "./scan-session";

/** Scheduling hints only: a rotated/deferred group can hide a settled stream
 * overlay in the previous result. That must not prevent requesting a crop when
 * its NEXT current-frame identity is verified. The engine and offerPrinting
 * still require fresh eligible pixels; this selector supplies no evidence. */
export function pendingPrintingTracks<
  T extends Pick<ScanTrack, "eventId" | "status">,
>(
  tracks: readonly T[],
  printed: ReadonlySet<string>,
  ready: (eventId: string) => boolean,
): T[] {
  return tracks.filter(
    (track) =>
      track.status === "added" &&
      !printed.has(track.eventId) &&
      ready(track.eventId),
  );
}
