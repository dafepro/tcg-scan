import { useEffect, useId, useRef, useState } from "react";
import { Activity, ChevronDown, Settings2, Trash2, X } from "lucide-react";
import type {
  AppPreferences,
  AppTheme,
  PreferenceStorageStatus,
} from "../lib/app-preferences";
import { diagnostics, useDiagnostics } from "../lib/diagnostics";
import type { DiagnosticFields } from "../lib/diagnostics";
import "./debug-console.css";

interface DebugConsoleProps {
  preferences: AppPreferences;
  onPreferencesChange: (patch: Partial<AppPreferences>) => void;
  storageStatus?: PreferenceStorageStatus;
}
const themes: Array<{ value: AppTheme; label: string }> = [
  { value: "ember", label: "Ember" },
  { value: "cobalt", label: "Cobalt" },
  { value: "violet", label: "Violet" },
];
const fieldLabels: Record<keyof DiagnosticFields, string> = {
  printingState: "Printing result",
  printingReason: "Printing unresolved reason",
  printingRegions: "Measured text regions",
  printingObservations: "Capture IDs observed",
  printingNativeEdge: "Native source short edge",
  printingRegionWidth: "Last text region width",
  printingRegionHeight: "Last text region height",
  printingHighlightPercent: "Bright-clipped pixels (%)",
  printingEdgeEnergyPercent: "Adjacent-pixel contrast (%)",
  status: "State",
  game: "Game",
  captureFlow: "Capture",
  mode: "Mode",
  matcher: "Matcher",
  transport: "Transport",
  savePolicy: "Save policy",
  storage: "Storage",
  reason: "Reason",
  active: "Camera active",
  paused: "Paused",
  autoSave: "Auto-save",
  busy: "Preparing",
  detectionComplete: "Detection complete",
  budgetExhausted: "Budget exhausted",
  presentationSnapshots: "UI snapshots",
  presentationMs: "Published snapshot prep",
  presentationMaxMs: "Slowest published snapshot",
  admitted: "Admitted to matcher queue",
  backpressureDeferred: "Routed to reservoir",
  backpressureRejected: "Backpressure discarded",
  queueRejected: "Queue admission rejected",
  queueOmitted: "Downstream queue omissions",
  queueReplaced: "Queued clearer replacements",
  reservoirCancelled: "Reservoir views cancelled",
  reservoirReplaced: "Reservoir views replaced",
  reservoirPromoted: "Reservoir views promoted",
  reservoirViews: "Reservoir views",
  adaptivePendingLimit: "Pending work target",
  workerServiceMs: "Estimated worker service",
  queueWaitMs: "Last queue wait",
  captureToResultMs: "Last capture to result",
  captured: "Captured",
  skipped: "Skipped",
  dropped: "Dropped",
  processed: "Processed",
  retries: "Retries",
  tracks: "Tracks",
  verified: "Verified",
  ambiguous: "Ambiguous",
  unknown: "Unknown",
  saved: "Saved",
  pending: "Pending",
  references: "References",
  matcherReferences: "Last matcher coverage",
  detections: "Detections",
  width: "Analyzed width",
  height: "Analyzed height",
  queueDepth: "Queue",
  bytes: "Bytes",
  progress: "Progress",
  detectionMs: "Detection",
  extractionMs: "Extraction",
  matchingMs: "Matching",
  totalMs: "Last frame",
};
function displayField(
  key: keyof DiagnosticFields,
  value: string | number | boolean,
) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.endsWith("Ms"))
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
    if (key === "progress") return `${Math.round(value * 100)}%`;
    return value.toLocaleString();
  }
  return value.replaceAll("-", " ");
}
function Fields({ fields }: { fields: Readonly<DiagnosticFields> }) {
  return (
    <dl className="debug-fields">
      {(
        Object.entries(fields) as Array<
          [keyof DiagnosticFields, string | number | boolean]
        >
      ).map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabels[key]}</dt>
          <dd>{displayField(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}
function RuntimeDiagnostics() {
  const snapshot = useDiagnostics();
  const [announcement, setAnnouncement] = useState("");
  return (
    <div className="debug-runtime">
      <p className="debug-help">
        Current app observations. Missing values have not been measured. Events
        stay in memory on this device. Published snapshot prep measures only the
        periodic UI data snapshots, not all application work or browser
        rendering. Printing-region measurements describe pixels, not calibrated
        readability, glare or finish.
      </p>
      <div className="debug-snapshots">
        {Object.entries(snapshot.latest).map(([source, fields]) => (
          <section
            className="debug-source"
            key={source}
            aria-label={`${source} diagnostics`}
          >
            <h3>
              <span className="debug-observation-dot" />
              {source}
            </h3>
            <Fields fields={fields} />
          </section>
        ))}
        {Object.keys(snapshot.latest).length === 0 && (
          <p className="debug-empty">
            No runtime observations yet. Use the scanner to see its measured
            state here.
          </p>
        )}
      </div>
      <div className="debug-events-heading">
        <h3>
          Recent events <span>{snapshot.events.length} / 128</span>
        </h3>
        <button
          className="debug-clear"
          type="button"
          disabled={!snapshot.events.length}
          onClick={() => {
            diagnostics.clear();
            setAnnouncement(
              "Diagnostic events cleared. Your collection is unchanged.",
            );
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          Clear events
        </button>
      </div>
      <p className="debug-sr-only" role="status">
        {announcement}
      </p>
      {snapshot.events.length ? (
        <ol className="debug-events" aria-label="Recent diagnostic events">
          {[...snapshot.events].reverse().map((entry) => (
            <li key={entry.id}>
              <details>
                <summary>
                  <time dateTime={new Date(entry.timestamp).toISOString()}>
                    {new Date(entry.timestamp).toLocaleTimeString(undefined, {
                      hour12: false,
                    })}
                  </time>
                  <span>
                    {entry.source} · {entry.event}
                  </span>
                  <ChevronDown size={13} aria-hidden="true" />
                </summary>
                {Object.keys(entry.fields).length ? (
                  <Fields fields={entry.fields} />
                ) : (
                  <p className="debug-help">State transition recorded.</p>
                )}
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="debug-empty">No events in this session.</p>
      )}
      <p className="debug-privacy">
        No photos, card names, URLs, or raw error messages are logged.
      </p>
    </div>
  );
}
export default function DebugConsole({
  preferences,
  onPreferencesChange,
  storageStatus,
}: DebugConsoleProps) {
  const panelId = useId();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opening = useRef(false);
  const [section, setSection] = useState<"options" | "runtime">("options");
  useEffect(() => {
    if (preferences.debugExpanded && opening.current) {
      heading.current?.focus();
      opening.current = false;
    }
  }, [preferences.debugExpanded]);
  useEffect(() => {
    if (!preferences.debugExpanded) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      onPreferencesChange({ debugExpanded: false });
      trigger.current?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [preferences.debugExpanded, onPreferencesChange]);
  const close = () => {
    onPreferencesChange({ debugExpanded: false });
    trigger.current?.focus();
  };
  return (
    <aside
      className="debug-console"
      data-expanded={preferences.debugExpanded}
      aria-label="Options and diagnostics"
    >
      {preferences.debugExpanded && (
        <section
          className="debug-panel"
          id={panelId}
          aria-labelledby={headingId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className="debug-panel-heading">
            <div>
              <p className="debug-eyebrow">Your workspace</p>
              <h2 tabIndex={-1} ref={heading} id={headingId}>
                Options & debug
              </h2>
            </div>
            <button
              className="debug-close"
              type="button"
              aria-label="Close options and debug"
              onClick={close}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div className="debug-sections" aria-label="Console sections">
            <button
              type="button"
              aria-pressed={section === "options"}
              onClick={() => setSection("options")}
            >
              <Settings2 size={15} aria-hidden="true" />
              Options
            </button>
            <button
              type="button"
              aria-pressed={section === "runtime"}
              onClick={() => setSection("runtime")}
            >
              <Activity size={15} aria-hidden="true" />
              Live diagnostics
            </button>
          </div>
          <div className="debug-panel-body">
            {section === "options" ? (
              <div className="debug-options">
                <fieldset className="debug-theme-group">
                  <legend>Color theme</legend>
                  <div className="debug-theme-options">
                    {themes.map((theme) => (
                      <label
                        key={theme.value}
                        className="debug-theme-choice"
                        data-theme-choice={theme.value}
                      >
                        <input
                          type="radio"
                          name={`${panelId}-theme`}
                          value={theme.value}
                          checked={preferences.theme === theme.value}
                          onChange={() =>
                            onPreferencesChange({ theme: theme.value })
                          }
                        />
                        <span
                          className="debug-theme-swatch"
                          aria-hidden="true"
                        />
                        <span>{theme.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="debug-select-label">
                  <span>Layout density</span>
                  <select
                    value={preferences.density}
                    onChange={(event) =>
                      onPreferencesChange({
                        density: event.target
                          .value as AppPreferences["density"],
                      })
                    }
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </label>
                <label className="debug-select-label">
                  <span>Scanner overlay</span>
                  <select
                    value={preferences.overlayDetail}
                    onChange={(event) =>
                      onPreferencesChange({
                        overlayDetail: event.target
                          .value as AppPreferences["overlayDetail"],
                      })
                    }
                  >
                    <option value="minimal">Minimal labels</option>
                    <option value="detailed">Detailed labels</option>
                  </select>
                </label>
                <label className="debug-select-label">
                  <span>Motion</span>
                  <select
                    value={preferences.motion}
                    onChange={(event) =>
                      onPreferencesChange({
                        motion: event.target.value as AppPreferences["motion"],
                      })
                    }
                  >
                    <option value="system">System default</option>
                    <option value="reduced">Reduce motion</option>
                  </select>
                </label>
                <p className="debug-help">
                  Scanner choices are remembered automatically. Appearance
                  controls do not change recognition or save checks.
                </p>
                <p
                  className={`debug-storage-note ${storageStatus === "unavailable" || storageStatus === "invalid" ? "debug-storage-warning" : ""}`}
                  role="status"
                >
                  {storageStatus === "unavailable"
                    ? "Browser storage is unavailable. Choices apply for this visit only."
                    : storageStatus === "invalid"
                      ? "Some saved choices could not be read. Safe defaults are in use."
                      : storageStatus === "saved"
                        ? "Choices saved in this browser."
                        : "Choices will be saved in this browser."}
                </p>
              </div>
            ) : (
              <RuntimeDiagnostics />
            )}
          </div>
        </section>
      )}
      <button
        ref={trigger}
        type="button"
        className="debug-trigger"
        aria-expanded={preferences.debugExpanded}
        aria-controls={preferences.debugExpanded ? panelId : undefined}
        onClick={() => {
          if (preferences.debugExpanded) close();
          else {
            opening.current = true;
            onPreferencesChange({ debugExpanded: true });
          }
        }}
      >
        <Settings2 size={17} aria-hidden="true" />
        <span>Options & debug</span>
        {preferences.debugExpanded && (
          <ChevronDown size={15} aria-hidden="true" />
        )}
      </button>
    </aside>
  );
}
