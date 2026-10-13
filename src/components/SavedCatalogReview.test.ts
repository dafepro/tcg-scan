import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SavedCatalogReview } from "./SavedCatalogReview";
import { addScanEvent } from "../lib/scan-inventory";
import type { SavedCatalogReviewState } from "../lib/saved-catalog-review";

const entry = addScanEvent(
  [],
  { key: "pokemon:base1-58", game: "pokemon", name: "Pikachu" },
  "event",
)[0];
const render = (state: SavedCatalogReviewState | null = null, busy = false) =>
  renderToStaticMarkup(
    createElement(SavedCatalogReview, {
      entry,
      state,
      busy,
      onCheck: () => undefined,
      onCancel: () => undefined,
    }),
  );
describe("saved catalog progressive-disclosure UI", () => {
  it("starts collapsed with a labeled action, legacy uncertainty and session-only storage limits", () => {
    const html = render();
    expect(html).toContain(
      '<details class="saved-catalog-review"><summary>Catalog recheck</summary>',
    );
    expect(html).not.toContain(" open=");
    expect(html).toContain("Recheck provider catalog");
    expect(html).toContain("no saved catalog snapshot to compare");
    expect(html).toContain("not included in backups");
    expect(html).toContain(
      "No quantity, verification or reference-value update",
    );
    expect(html).not.toContain("<img");
  });
  it("shows check/fetch dates and provider scope without promoting same-snapshot to physical validation", () => {
    const html = render({
      entryId: entry.id,
      name: entry.card.name,
      startedAt: "2026-10-13T03:00:00Z",
      checkedAt: "2026-10-13T03:00:01Z",
      phase: "complete",
      comparison: {
        status: "same-snapshot",
        changed: false,
        stale: false,
        incomplete: false,
        legacy: false,
        current: {
          schemaVersion: 1,
          snapshotId: `sha256:${"a".repeat(64)}`,
          provider: "<script>bad()</script>",
          scope: "English provider only",
          fetchedAt: "2026-10-13T03:00:00.500Z",
          stale: false,
          completeWithinScope: true,
          candidateCount: 2,
        },
      },
    });
    expect(html).toContain("Same provider snapshot at this check.");
    expect(html).toContain("2026-10-13T03:00:00.500Z");
    expect(html).toContain("English provider only");
    expect(html).toContain("does not establish global latestness");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("up to date");
  });
  it("exposes truthful pending/cancel/error and disables other checks", () => {
    expect(
      render(
        {
          entryId: entry.id,
          name: entry.card.name,
          startedAt: "now",
          phase: "checking",
        },
        true,
      ),
    ).toContain('aria-busy="true"');
    expect(
      render(
        {
          entryId: entry.id,
          name: entry.card.name,
          startedAt: "now",
          phase: "checking",
        },
        true,
      ),
    ).toContain("Cancel catalog check");
    const error = render({
      entryId: entry.id,
      name: entry.card.name,
      startedAt: "now",
      checkedAt: "later",
      phase: "error",
      error: "timeout",
    });
    expect(error).toContain("check timed out");
    expect(error).not.toContain("Same provider snapshot");
    expect(render(null, true)).toContain("Another entry is being checked");
    expect(render(null, true)).toContain("disabled");
  });
});
