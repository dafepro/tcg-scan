import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PackScanner from "./PackScanner";

describe("Pack optional printing UI gate", () => {
  it("starts unchecked and discloses the unmeasured throughput and one-view limits", () => {
    const html = renderToStaticMarkup(
      createElement(PackScanner, {
        game: "pokemon",
        onSave: () => undefined,
        onUndo: () => undefined,
        onSetup: () => undefined,
      }),
    );
    const checkbox = html.match(/<input[^>]+type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toContain("checked");
    expect(html).toContain("Off by default while throughput is being tested");
    expect(html).toContain("One view cannot confirm");
    expect(html).toContain("at most 30 crops per session");
    expect(html).toContain("at least 1.5 seconds");
    expect(html).toContain("40 seconds");
  });
});

describe("Pack bounded diagnostic UI gate", () => {
  it("starts trace opt-in unchecked behind a disclosure and describes its scope", () => {
    const html = renderToStaticMarkup(
      createElement(PackScanner, {
        game: "pokemon",
        onSave: () => undefined,
        onUndo: () => undefined,
        onSetup: () => undefined,
      }),
    );
    const trace = html.match(
      /<details class="pack-trace-options">[\s\S]*?<\/details>/,
    )?.[0];
    expect(trace).toBeDefined();
    expect(trace).not.toMatch(/<details[^>]* open|<input[^>]* checked/);
    expect(trace).toContain("Local session trace (optional)");
    expect(trace).toContain("512");
    expect(trace).toContain("672");
    expect(trace).toContain("Nothing is uploaded or persisted automatically");
    expect(trace).toContain("Failed preparation keeps the previous trace");
    expect(trace).toContain("No trace was recorded for the current session");
    expect(trace).not.toContain("Export local trace JSON");
  });
});
