import { useCallback, useEffect, useRef, useState } from "react";
import type { Game } from "../types";

export const PREFERENCES_KEY = "tcg-scan:preferences:v1";
export const PREFERENCES_VERSION = 1;
export const MAX_PREFERENCES_LENGTH = 4096;
export type AppTheme = "ember" | "cobalt" | "violet";
export interface AppPreferences {
  theme: AppTheme;
  motion: "system" | "reduced";
  debugExpanded: boolean;
  density: "comfortable" | "compact";
  overlayDetail: "minimal" | "detailed";
  game: Game;
  captureFlow: "live" | "pack";
  liveMode: "stream" | "binder";
  savePolicy: "fast" | "strict";
  autoSave: boolean;
}
export type PreferenceStorageStatus =
  "saved" | "default" | "invalid" | "unavailable";
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const DEFAULT_PREFERENCES: Readonly<AppPreferences> = Object.freeze({
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
});
const choices = {
  theme: ["ember", "cobalt", "violet"],
  density: ["comfortable", "compact"],
  overlayDetail: ["minimal", "detailed"],
  motion: ["system", "reduced"],
  game: ["pokemon", "mtg", "yugioh"],
  captureFlow: ["live", "pack"],
  liveMode: ["stream", "binder"],
  savePolicy: ["fast", "strict"],
} as const;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Copies known fields only. Invalid partial updates preserve their current value. */
export function validatePreferences(
  value: unknown,
  fallback: Readonly<AppPreferences> = DEFAULT_PREFERENCES,
): AppPreferences {
  const output = { ...fallback };
  if (!isRecord(value)) return output;
  for (const key of Object.keys(choices) as Array<keyof typeof choices>) {
    const field = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (
      typeof field === "string" &&
      (choices[key] as readonly string[]).includes(field)
    ) {
      Object.assign(output, { [key]: field });
    }
  }
  for (const key of ["debugExpanded", "autoSave"] as const) {
    const field = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof field === "boolean") output[key] = field;
  }
  return output;
}
function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
export function parsePreferences(raw: string | null): {
  preferences: AppPreferences;
  storageStatus: PreferenceStorageStatus;
} {
  const defaults = () => ({ ...DEFAULT_PREFERENCES });
  if (raw === null)
    return { preferences: defaults(), storageStatus: "default" };
  try {
    if (raw.length > MAX_PREFERENCES_LENGTH) throw new Error("oversized");
    const envelope: unknown = JSON.parse(raw);
    if (
      !isRecord(envelope) ||
      envelope.version !== PREFERENCES_VERSION ||
      !isRecord(envelope.preferences)
    ) {
      throw new Error("unsupported");
    }
    const preferences = validatePreferences(envelope.preferences);
    const valid = Object.entries(preferences).every(
      ([key, value]) =>
        envelope.preferences &&
        (envelope.preferences as Record<string, unknown>)[key] === value,
    );
    return { preferences, storageStatus: valid ? "saved" : "invalid" };
  } catch {
    return { preferences: defaults(), storageStatus: "invalid" };
  }
}
export function loadPreferences(
  storage: PreferenceStorage | null = browserStorage(),
) {
  try {
    if (!storage) throw new Error("unavailable");
    return parsePreferences(storage.getItem(PREFERENCES_KEY));
  } catch {
    return {
      preferences: { ...DEFAULT_PREFERENCES },
      storageStatus: "unavailable" as const,
    };
  }
}
export function savePreferences(
  preferences: AppPreferences,
  storage: PreferenceStorage | null = browserStorage(),
): PreferenceStorageStatus {
  try {
    if (!storage) throw new Error("unavailable");
    storage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        version: PREFERENCES_VERSION,
        preferences: validatePreferences(preferences),
      }),
    );
    return "saved";
  } catch {
    return "unavailable";
  }
}
/** One App-level owner; pass preferences and updatePreferences down to controls. */
export function useAppPreferences() {
  const [state, setState] = useState(loadPreferences);
  const current = useRef(state.preferences);
  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    const preferences = validatePreferences(patch, current.current);
    current.current = preferences;
    const storageStatus = savePreferences(preferences);
    setState({ preferences, storageStatus });
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PREFERENCES_KEY && event.key !== null) return;
      // Never read or write collection storage here, and never echo a remote write.
      const next = loadPreferences();
      current.current = next.preferences;
      setState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return { ...state, updatePreferences };
}
