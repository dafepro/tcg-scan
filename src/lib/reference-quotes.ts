import type { Card } from "../types";
import type { PriceSnapshot, PricingClient } from "./pricing";

/** Include all printing constraints, rather than just a provider's card ID. */
export function referenceQuoteIdentity(card: Card): string {
  return JSON.stringify([
    card.game,
    card.id,
    card.name,
    card.setCode,
    card.number,
    card.rarity,
  ]);
}

export function matchesReferenceIdentity(
  card: Card,
  snapshot: PriceSnapshot,
): boolean {
  const identity = snapshot.identity;
  if (
    snapshot.cardId !== card.id ||
    snapshot.game !== card.game ||
    identity.cardId !== card.id ||
    identity.game !== card.game
  )
    return false;
  return card.game === "yugioh"
    ? identity.setCode === card.setCode && identity.rarity === card.rarity
    : (!card.setCode || identity.setCode === card.setCode) &&
        (!card.number || identity.number === card.number);
}

export function readReferenceQuoteCache(
  card: Card,
  client: PricingClient,
): PriceSnapshot | null {
  try {
    const snapshot = client.readCachedPriceSnapshot(card.id, {
      game: card.game,
      finish: "Unknown",
      setCode:
        card.game === "yugioh" ? card.setCode : card.setCode || undefined,
      rarity: card.game === "yugioh" ? card.rarity : undefined,
    });
    // Cached reads have no collector-number option. Check it before displaying.
    return snapshot && matchesReferenceIdentity(card, snapshot)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

export interface ReferenceQuoteState {
  snapshot: PriceSnapshot | null;
  loading: boolean;
  attempted: boolean;
  error?: string;
}

/** One cancellable view subscription. Shared provider requests remain provider-owned. */
export function createReferenceQuoteController(
  card: Card,
  client: PricingClient,
  onState: (state: ReferenceQuoteState) => void,
) {
  let state: ReferenceQuoteState = {
    snapshot: readReferenceQuoteCache(card, client),
    loading: false,
    attempted: false,
  };
  let disposed = false;
  let request: AbortController | undefined;
  let generation = 0;
  const emit = (next: ReferenceQuoteState) => {
    state = next;
    if (!disposed) onState(next);
  };
  return {
    getState: () => state,
    load(force = false) {
      if (disposed || state.loading || (state.attempted && !force)) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const token = ++generation;
      let updated = false;
      const current = () =>
        !disposed && !controller.signal.aborted && token === generation;
      const apply = (snapshot: PriceSnapshot) => {
        if (!current()) return;
        if (!matchesReferenceIdentity(card, snapshot)) {
          emit({
            snapshot: null,
            loading: false,
            attempted: true,
            error:
              "The provider identity does not match this card. Reference prices are unavailable.",
          });
          return;
        }
        emit({
          snapshot,
          loading: snapshot.refreshing,
          attempted: true,
        });
      };
      emit({ ...state, loading: true, attempted: true, error: undefined });
      // Promise.resolve also catches an unexpected synchronous client failure.
      void Promise.resolve()
        .then(() => {
          if (!current()) return null;
          return client.getPriceSnapshot(card, {
            finish: "Unknown",
            force,
            signal: controller.signal,
            onUpdate: (snapshot) => {
              updated = true;
              apply(snapshot);
            },
          });
        })
        .then((snapshot) => {
          // A fast background refresh must not be overwritten by its stale seed.
          if (snapshot && !updated) apply(snapshot);
        })
        .catch(() => {
          if (!current()) return;
          emit({
            ...state,
            loading: false,
            error:
              "Reference lookup failed. Check your connection and try again.",
          });
        });
    },
    dispose() {
      disposed = true;
      generation++;
      request?.abort();
    },
  };
}

type VisibilityEntry = Pick<
  IntersectionObserverEntry,
  "target" | "isIntersecting" | "intersectionRatio"
>;
interface VisibilityObserver {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}
type VisibilityFactory = (
  onEntries: (entries: readonly VisibilityEntry[]) => void,
) => VisibilityObserver;

/** A single observer covers every row; offscreen entries never start requests. */
export function createReferenceVisibilityGate(
  factory: VisibilityFactory | null,
) {
  const waiting = new Map<Element, () => void>();
  let observer: VisibilityObserver | undefined;
  const remove = (element: Element) => {
    waiting.delete(element);
    observer?.unobserve(element);
    if (waiting.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
  return {
    observe(element: Element, onVisible: () => void) {
      if (!factory) return { automatic: false, dispose: () => undefined };
      try {
        observer ??= factory((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || entry.intersectionRatio <= 0) continue;
            const callback = waiting.get(entry.target);
            if (!callback) continue;
            remove(entry.target);
            callback();
          }
        });
        waiting.set(element, onVisible);
        observer.observe(element);
        return { automatic: true, dispose: () => remove(element) };
      } catch {
        remove(element);
        return { automatic: false, dispose: () => undefined };
      }
    },
  };
}

let visibilityGate:
  ReturnType<typeof createReferenceVisibilityGate> | undefined;
export function observeReferenceVisibility(
  element: Element,
  onVisible: () => void,
) {
  visibilityGate ??= createReferenceVisibilityGate(
    typeof IntersectionObserver === "undefined"
      ? null
      : (callback) =>
          new IntersectionObserver(callback, {
            root: null,
            rootMargin: "0px",
            threshold: 0.01,
          }),
  );
  return visibilityGate.observe(element, onVisible);
}

/** One minute clock, with no timer or subscription for unloaded rows. */
let clockTime = Date.now();
let clockTimer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
export function subscribeReferenceClock(listener: () => void) {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockTime = Date.now();
    clockTimer = setInterval(() => {
      clockTime = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 60_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
export const getReferenceClock = () => clockTime;

export function referenceQuoteAge(timestamp: string, now: number): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "time unavailable";
  if (time > now + 60_000) return "provider-reported future time";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
