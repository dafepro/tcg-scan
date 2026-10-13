import { memo, useEffect, useRef, useState } from "react";
import {
  PACK_TRACE_EFFECTIVE_RECORDS,
  PACK_TRACE_MAX_BYTES,
  PACK_TRACE_MAX_RECORDS,
  type PackTrace,
  type PackTraceSnapshot,
} from "../lib/pack-trace";

type Props = {
  trace: PackTrace | null;
  initializationFailed: boolean;
  enabled: boolean;
  locked: boolean;
  onEnabled(value: boolean): void;
};
/** Explicit snapshots only: no history copies or growing list renders on the
 * camera hot path. The displayed snapshot remains frozen until Refresh. */
export const PackTraceDetails = memo(function PackTraceDetails({
  trace,
  initializationFailed,
  enabled,
  locked,
  onEnabled,
}: Props) {
  const [snapshot, setSnapshot] = useState<PackTraceSnapshot | null>(null);
  const [owner, setOwner] = useState(trace);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const downloadUrl = useRef<string | null>(null);
  const downloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function releaseDownload() {
    if (downloadTimer.current) clearTimeout(downloadTimer.current);
    downloadTimer.current = null;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
  }
  useEffect(() => releaseDownload, []);
  // A successful new session drops the old snapshot as well as the old store.
  if (owner !== trace) {
    setOwner(trace);
    setSnapshot(null);
    setPage(0);
    setError("");
  }
  function inspect() {
    try {
      setSnapshot(trace?.snapshot() ?? null);
      setPage(0);
      setError("");
    } catch {
      setError(
        "The local trace could not be inspected. Scanning is unchanged.",
      );
    }
  }
  function download() {
    if (!trace) return;
    let url: string | undefined;
    try {
      releaseDownload();
      const json = trace.exportJson();
      url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      downloadUrl.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = "tcg-pack-local-trace.json";
      link.click();

      // Allow the browser to start the explicit local download, then release it.
      downloadTimer.current = setTimeout(releaseDownload, 1000);
      setError("");
    } catch {
      releaseDownload();
      setError("The local trace could not be exported. Scanning is unchanged.");
    }
  }
  const start = from.trim() === "" ? -Infinity : Number(from);
  const end = to.trim() === "" ? Infinity : Number(to);
  const validRange = !Number.isNaN(start) && !Number.isNaN(end) && start <= end;
  const rows =
    snapshot?.records.filter(
      (record) =>
        validRange &&
        (record.sourceMediaSeconds === null
          ? from === "" && to === ""
          : record.sourceMediaSeconds >= start &&
            record.sourceMediaSeconds <= end),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  const shownPage = Math.min(page, pages - 1);
  return (
    <details className="pack-trace-options">
      <summary>Local session trace (optional)</summary>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={locked}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        Record bounded diagnostics for the next Pack session
      </label>
      <p>
        Off by default. Records only numeric view links, native media times and
        recognition/save outcomes in memory. No images, card names, OCR text,
        notes, provider payloads, URLs or network data. Nothing is uploaded or
        persisted automatically.
      </p>
      <p>
        Up to {PACK_TRACE_MAX_RECORDS.toLocaleString()} records and{" "}
        {PACK_TRACE_MAX_BYTES / 1024} KiB, whichever limit binds first. Full
        lifecycle space is reserved per record, so this version retains at most{" "}
        {PACK_TRACE_EFFECTIVE_RECORDS} records. Overflow is counted; a truncated
        trace cannot explain every view.
      </p>
      <p>
        Pause keeps the trace. End cancels pending work; saved and undone links
        remain. A successfully started new session replaces it. Failed
        preparation keeps the previous trace. Leaving Pack or reloading discards
        it. Export first if needed. An explicit extra copy is labeled as a user
        action, never another observed view.
      </p>
      {initializationFailed && (
        <p role="alert">
          Local diagnostics could not start. This session is scanning without a
          trace.
        </p>
      )}
      {trace ? (
        <>
          <p>
            Trace is available for this session. Inspect or export explicitly;
            displayed results are a snapshot, not live updates. Expired or late
            acquisitions discarded before queue admission are outside this
            trace.
          </p>
          <div className="pack-actions">
            <button className="button subtle" onClick={inspect}>
              {snapshot ? "Refresh trace snapshot" : "Inspect local trace"}
            </button>
            <button className="button subtle" onClick={download}>
              Export local trace JSON
            </button>
          </div>
        </>
      ) : (
        <p>
          No trace was recorded for the current session. Enable it before
          starting a new session.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <div
          className="pack-trace-inspection"
          aria-label="Local trace snapshot"
        >
          <p>
            Snapshot: {snapshot.state} · {snapshot.records.length} retained
            records · {snapshot.counters.captured} valid acquisitions ·{" "}
            {snapshot.counters.processed} processed ·{" "}
            {snapshot.counters.matcherRejected} matcher rejections ·{" "}
            {snapshot.counters.saveSucceeded} successful saves.
          </p>
          <p role="status">
            {snapshot.complete
              ? "No diagnostic truncation recorded within the stated scope. This does not guarantee every card was captured or saved."
              : "Incomplete diagnostic trace. Missing records or updates prevent complete conclusions."}{" "}
            Overflow records: {snapshot.counters.overflowRecords}; unretained
            updates: {snapshot.counters.unretainedUpdates}; truncated updates:{" "}
            {snapshot.counters.truncatedUpdates}; invalid metadata:{" "}
            {snapshot.counters.invalidMetadata}; observer errors:{" "}
            {snapshot.counters.observerErrors}.
          </p>
          <div className="pack-trace-filter">
            <label>
              Source time from (seconds)
              <input
                type="number"
                min="0"
                step="any"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Source time through (seconds)
              <input
                type="number"
                min="0"
                step="any"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          </div>
          {!validRange && (
            <p role="alert">Choose an end time at or after the start time.</p>
          )}
          <p>
            {rows.length} matching records · page {shownPage + 1} of {pages}.
            Source order is acquisition order; processing may differ after
            reservoir promotion. All links refer to this trace only.
          </p>
          <ol className="pack-trace-records">
            {rows.slice(shownPage * 50, (shownPage + 1) * 50).map((record) => (
              <li key={record.id}>
                <strong>
                  View {record.id}
                  {record.kind === "explicit-copy"
                    ? " · user-confirmed extra copy"
                    : ` · source ${record.sourceMediaSeconds}s`}
                </strong>
                <span>
                  {record.schedule} · matcher {record.matcher}: {record.reason}{" "}
                  · save {record.save}
                </span>
                <span>
                  Receipt frame {record.receiptFrame ?? "none"} · event view{" "}
                  {record.eventView ?? "none"} · original view{" "}
                  {record.sourceView ?? "none"}
                </span>
                <span>
                  Relative ms: captured {record.capturedMs ?? "none"}; deferred{" "}
                  {record.deferredMs ?? "none"}; admitted{" "}
                  {record.admittedMs ?? "none"}; started{" "}
                  {record.startedMs ?? "none"}; processed{" "}
                  {record.processedMs ?? "none"}; decided{" "}
                  {record.decidedMs ?? "none"}; ended {record.endedMs ?? "none"}
                  ; saved {record.savedMs ?? "none"}; undone{" "}
                  {record.undoneMs ?? "none"}.
                </span>
              </li>
            ))}
          </ol>
          <div className="pack-actions">
            <button
              className="button subtle"
              disabled={shownPage === 0}
              onClick={() => setPage(shownPage - 1)}
            >
              Previous trace page
            </button>
            <button
              className="button subtle"
              disabled={shownPage + 1 >= pages}
              onClick={() => setPage(shownPage + 1)}
            >
              Next trace page
            </button>
          </div>
        </div>
      )}
    </details>
  );
});
