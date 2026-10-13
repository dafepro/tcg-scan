import type { CollectionEntry } from "../types";
import {
  catalogReviewLabel,
  savedCatalogReference,
  type SavedCatalogReviewState,
} from "../lib/saved-catalog-review";
import "./saved-catalog-review.css";

const errors: Record<string, string> = {
  network: "The provider could not be reached. Try again when connected.",
  timeout: "The check timed out. Try again later.",
  "rate-limit": "The provider asked us to wait. Try again later.",
  "not-found": "No matching provider records were returned.",
  "invalid-response": "The provider response could not be validated.",
  "identity-mismatch":
    "The provider response did not match the saved identity.",
  "invalid-pagination": "The provider's complete result could not be verified.",
  "unsafe-url": "The provider returned an unsupported destination.",
  limit: "The provider response exceeded the safe lookup limits.",
  busy: "The metadata service is busy. Try again later.",
  "unsupported-reference":
    "This entry has no supported provider card ID. Its saved evidence is still available.",
};

export function SavedCatalogReview({
  entry,
  state,
  busy,
  onCheck,
  onCancel,
}: {
  entry: CollectionEntry;
  state: SavedCatalogReviewState | null;
  busy: boolean;
  onCheck: () => void;
  onCancel: () => void;
}) {
  const evidence = entry.printingRead?.evidence;
  const checking = state?.phase === "checking";
  const comparison = state?.phase === "complete" ? state.comparison : undefined;
  const current = comparison?.current;
  const error = state?.phase === "error" ? state.error : comparison?.error;
  const supported = !!savedCatalogReference(entry.card);
  return (
    <details
      className="saved-catalog-review"
      onToggle={(event) => {
        if (!event.currentTarget.open && checking) onCancel();
      }}
    >
      <summary>Catalog recheck</summary>
      <div className="saved-catalog-review-content">
        <p>
          Compare this saved entry with {entry.card.provider} metadata on
          demand. This checks provider coverage, not physical printing, finish,
          condition or value.
        </p>
        {!evidence?.catalog && (
          <p>
            Legacy or unversioned evidence: no saved catalog snapshot to
            compare. A lookup cannot create missing original evidence.
          </p>
        )}
        {evidence?.catalog && (
          <details>
            <summary>Original saved catalog</summary>
            <dl>
              <dt>Provider and scope</dt>
              <dd>
                {evidence.catalog.provider} · {evidence.catalog.scope}
              </dd>
              <dt>Original fetch date</dt>
              <dd>{evidence.catalog.fetchedAt ?? "Not recorded"}</dd>
              <dt>Original snapshot</dt>
              <dd>{evidence.catalog.snapshotId}</dd>
            </dl>
          </details>
        )}
        {state && (
          <section aria-label="Catalog check result" aria-busy={checking}>
            <strong>{catalogReviewLabel(state)}</strong>
            <dl>
              <dt>Check started</dt>
              <dd>{state.startedAt}</dd>
              {"checkedAt" in state && (
                <>
                  <dt>Check finished</dt>
                  <dd>{state.checkedAt}</dd>
                </>
              )}
            </dl>
            {error && (
              <p>
                {errors[error] ??
                  "The provider check could not be completed. Try again later."}
              </p>
            )}
            {comparison?.changed && (
              <p>
                The snapshot content or provider scope differs from the saved
                evidence. Old uniqueness may no longer hold; review the original
                identifiers.
              </p>
            )}
            {comparison?.stale && (
              <p>
                Refresh failed. This is older cached metadata, not a successful
                fresh provider check.
              </p>
            )}
            {comparison?.incomplete && (
              <p>
                Complete coverage within this provider scope could not be
                established.
              </p>
            )}
            {current && (
              <dl>
                <dt>Provider and scope checked</dt>
                <dd>
                  {current.provider} · {current.scope}
                </dd>
                <dt>Provider fetch date</dt>
                <dd>
                  {current.fetchedAt ?? "Not available"}
                  {current.stale ? " · Older cached response" : ""}
                </dd>
                <dt>Records in this response</dt>
                <dd>{current.candidateCount}</dd>
                <dt>Compared snapshot</dt>
                <dd>{current.snapshotId}</dd>
              </dl>
            )}
            {comparison?.status === "same-snapshot" && (
              <p>
                The provider returned the same semantic snapshot at this check.
                This does not establish global latestness, complete physical
                coverage or physical validation.
              </p>
            )}
          </section>
        )}
        <button
          className="button secondary"
          type="button"
          disabled={!checking && (busy || !supported)}
          onClick={checking ? onCancel : onCheck}
        >
          {checking ? "Cancel catalog check" : "Recheck provider catalog"}
        </button>
        {!supported && <p>{errors["unsupported-reference"]}</p>}
        {busy && !checking && (
          <p>
            Another entry is being checked. Cancel it or wait before checking
            this one.
          </p>
        )}
        <p>
          One check at a time. The latest result is kept only while this
          Collection view stays open. Leaving, reloading or editing the
          collection clears it; it is not included in backups.
        </p>
        <p>
          Original evidence and identifiers stay unchanged. No quantity,
          verification or reference-value update is made.
        </p>
      </div>
    </details>
  );
}
