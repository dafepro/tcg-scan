/** UI boundary state, reported by the scanner that owns the real session.
 * No frames, identities, timing inference or engine ownership are lifted. */
export interface ScannerLifecycle {
  phase:
    | "idle"
    | "preparing"
    | "active"
    | "paused"
    | "draining"
    | "review"
    | "ended";
  sessionId: string | null;
  savedCount: number;
}
export function needsSessionEndConfirmation(
  state: ScannerLifecycle | null,
): boolean {
  return (
    state !== null &&
    ["preparing", "active", "paused", "draining", "review"].includes(
      state.phase,
    )
  );
}
export function sameScannerLifecycle(
  a: ScannerLifecycle | null,
  b: ScannerLifecycle,
): boolean {
  return (
    a?.phase === b.phase &&
    a.sessionId === b.sessionId &&
    a.savedCount === b.savedCount
  );
}
