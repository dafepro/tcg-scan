import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");

function properties(selector: string): Record<string, string> {
  const block = css.slice(css.indexOf(selector)).split("}")[0];
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z-]+):\s*(#[\da-f]{6})/gi)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}
function luminance(color: string): number {
  return [1, 3, 5]
    .map((offset) => {
      const v = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: string, b: string): number {
  const light = luminance(a),
    dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}
const defaults = properties(':root[data-theme="ember"]');
describe("semantic dark themes", () => {
  for (const theme of ["ember", "cobalt", "violet"]) {
    it(`${theme} has readable text, muted labels and primary actions`, () => {
      const tokens = {
        ...defaults,
        ...properties(`:root[data-theme="${theme}"]`),
      };
      for (const foreground of ["--text", "--muted", "--dim"]) {
        for (const background of [
          "--bg",
          "--panel",
          "--panel-soft",
          "--panel-raised",
        ]) {
          expect(
            contrast(tokens[foreground], tokens[background]),
            `${foreground}/${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(tokens["--accent-ink"], tokens["--accent"]),
      ).toBeGreaterThanOrEqual(7);
      for (const background of ["--bg", "--panel", "--panel-soft"])
        expect(
          contrast(tokens["--control-border"], tokens[background]),
        ).toBeGreaterThanOrEqual(3);
      for (const state of ["success", "warning", "danger"]) {
        expect(
          contrast(tokens[`--${state}`], tokens[`--${state}-soft`]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it("honors system and explicit reduced motion without hiding status", () => {
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).toContain(':root[data-motion="reduced"]');
    expect(css).toContain("animation-iteration-count: 1 !important");
    expect(css).toContain('data-density="compact"');
    expect(css).toContain('data-overlay-detail="minimal"');
  });
});
