import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_LENGTH,
  PREFERENCES_KEY,
  loadPreferences,
  parsePreferences,
  savePreferences,
  validatePreferences,
} from "./app-preferences";
import type { PreferenceStorage } from "./app-preferences";
function memoryStorage(): PreferenceStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("separate, validated browser preferences", () => {
  it("defaults to the existing scan behavior with an ember appearance", () => {
    expect(loadPreferences(memoryStorage())).toEqual({
      preferences: {
        theme: "ember",
        motion: "system",
        debugExpanded: false,
        density: "comfortable",
        overlayDetail: "minimal",
        game: "pokemon",
        captureFlow: "live",
        liveMode: "stream",
        savePolicy: "fast",
        autoSave: true,
      },
      storageStatus: "default",
    });
  });
  it("round-trips every supported choice in a versioned envelope", () => {
    const storage = memoryStorage();
    const choices = {
      ...DEFAULT_PREFERENCES,
      theme: "cobalt" as const,
      motion: "reduced" as const,
      debugExpanded: true,
      density: "compact" as const,
      overlayDetail: "detailed" as const,
      game: "mtg" as const,
      captureFlow: "pack" as const,
      liveMode: "binder" as const,
      savePolicy: "strict" as const,
      autoSave: false,
    };
    expect(savePreferences(choices, storage)).toBe("saved");
    expect(loadPreferences(storage)).toEqual({
      preferences: choices,
      storageStatus: "saved",
    });
    expect(JSON.parse(storage.entries.get(PREFERENCES_KEY)!)).toEqual({
      version: 1,
      preferences: choices,
    });
    expect(storage.entries.size).toBe(1);
  });
  it("never changes collection, deck, or unrelated storage", () => {
    const storage = memoryStorage();
    storage.entries.set("tcg-scan:data:v1", "collection sentinel");
    storage.entries.set("another-app", "untouched");
    savePreferences({ ...DEFAULT_PREFERENCES, theme: "violet" }, storage);
    expect(storage.entries.get("tcg-scan:data:v1")).toBe("collection sentinel");
    expect(storage.entries.get("another-app")).toBe("untouched");
  });
  it.each([
    "not JSON",
    "null",
    "[]",
    "42",
    '{"version":2,"preferences":{}}',
    '{"version":"1","preferences":{}}',
    '{"version":1,"preferences":[]}',
    "x".repeat(MAX_PREFERENCES_LENGTH + 1),
  ])("falls back safely for malformed or unsupported envelopes", (raw) => {
    expect(parsePreferences(raw)).toEqual({
      preferences: DEFAULT_PREFERENCES,
      storageStatus: "invalid",
    });
  });
  it("recovers valid fields while replacing invalid/oversized fields", () => {
    const preferences = {
      ...DEFAULT_PREFERENCES,
      theme: "cobalt",
      game: "other",
      autoSave: "false",
      debugExpanded: 1,
      liveMode: "x".repeat(2000),
      captureFlow: "pack",
      savePolicy: "strict",
      overlayDetail: "detailed",
    };
    const result = parsePreferences(
      JSON.stringify({ version: 1, preferences }),
    );
    expect(result.storageStatus).toBe("invalid");
    expect(result.preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "cobalt",
      captureFlow: "pack",
      savePolicy: "strict",
      overlayDetail: "detailed",
    });
  });
  it("does not interpret unknown fields, prototypes, or accessor values", () => {
    const input = Object.create({ theme: "violet" });
    Object.defineProperty(input, "game", {
      get() {
        throw new Error("must not call getter");
      },
    });
    input.collection = [{ secret: "not preferences" }];
    input.motion = "reduced";
    expect(validatePreferences(input)).toEqual({
      ...DEFAULT_PREFERENCES,
      motion: "reduced",
    });
    expect(
      validatePreferences(
        JSON.parse('{"__proto__":{"autoSave":false},"credentials":"secret"}'),
      ),
    ).toEqual(DEFAULT_PREFERENCES);
  });
  it("preserves current valid fields on malformed partial updates", () => {
    const current = {
      ...DEFAULT_PREFERENCES,
      theme: "violet" as const,
      savePolicy: "strict" as const,
    };
    expect(
      validatePreferences({ theme: "invalid", autoSave: false }, current),
    ).toEqual({ ...current, autoSave: false });
    expect(DEFAULT_PREFERENCES.theme).toBe("ember");
  });
  it("reads no more than one preference key and never repairs storage during a read", () => {
    const storage = { getItem: vi.fn(() => "bad"), setItem: vi.fn() };
    expect(loadPreferences(storage).storageStatus).toBe("invalid");
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(PREFERENCES_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("handles denied reads, quota failures, and absent browser storage", () => {
    const denied: PreferenceStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    };
    expect(loadPreferences(denied)).toEqual({
      preferences: DEFAULT_PREFERENCES,
      storageStatus: "unavailable",
    });
    expect(savePreferences({ ...DEFAULT_PREFERENCES }, denied)).toBe(
      "unavailable",
    );
    expect(loadPreferences(null).storageStatus).toBe("unavailable");
    expect(savePreferences({ ...DEFAULT_PREFERENCES }, null)).toBe(
      "unavailable",
    );
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked getter");
      },
    });
    expect(loadPreferences().storageStatus).toBe("unavailable");
    expect(savePreferences({ ...DEFAULT_PREFERENCES })).toBe("unavailable");
  });
  it("bounds serialized preference fields even if an untyped caller injects data", () => {
    const storage = memoryStorage();
    const preferences = {
      ...DEFAULT_PREFERENCES,
      photo: "x".repeat(10000),
      theme: "bad",
      cardName: "private",
    };
    expect(savePreferences(preferences as never, storage)).toBe("saved");
    const raw = storage.entries.get(PREFERENCES_KEY)!;
    expect(raw.length).toBeLessThan(MAX_PREFERENCES_LENGTH);
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("photo");
    expect(loadPreferences(storage).preferences).toEqual(DEFAULT_PREFERENCES);
  });
});
