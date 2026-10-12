import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Card } from "../types";
import {
  getPriceSnapshot,
  readCachedPriceSnapshot,
  type PriceQuote,
  type PriceSnapshot,
} from "../lib/pricing";
import {
  createReferenceQuoteController,
  getReferenceClock,
  observeReferenceVisibility,
  readReferenceQuoteCache,
  referenceQuoteAge,
  referenceQuoteIdentity,
  subscribeReferenceClock,
  type ReferenceQuoteState,
} from "../lib/reference-quotes";
import "./reference-quotes.css";

const pricing = { getPriceSnapshot, readCachedPriceSnapshot };
const variantLabels: Record<PriceQuote["variant"], string> = {
  normal: "Normal",
  foil: "Foil",
  "reverse-holo": "Reverse holo",
  "etched-foil": "Etched foil",
  "first-edition-normal": "First edition · normal",
  "first-edition-foil": "First edition · foil",
  "unlimited-normal": "Unlimited · normal",
  "unlimited-foil": "Unlimited · foil",
  unspecified: "Variant unspecified",
};

function statusLabel(snapshot: PriceSnapshot | null, now: number) {
  if (!snapshot) return "Not loaded";
  const stale =
    snapshot.freshness === "stale" ||
    (!!snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now);
  if (snapshot.status === "offline")
    return snapshot.quotes.length
      ? `Offline · ${stale ? "stale" : "cached"}`
      : "Offline · unavailable";
  if (!snapshot.quotes.length) return "Unavailable";
  if (stale) return "Stale cache";
  return snapshot.status === "live" ? "Fresh reference" : "Fresh cache";
}

function QuoteRow({ quote }: { quote: PriceQuote }) {
  return (
    <li className="reference-quotes-row">
      <div className="reference-quotes-line">
        <a
          href={quote.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={quote.source}
        >
          {quote.source.split(" · ")[0]}
          <span className="reference-quotes-sr-only">
            {" "}
            (opens in a new tab)
          </span>
        </a>
        <strong>
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: quote.currency,
            currencyDisplay: "code",
          }).format(quote.amount)}
        </strong>
      </div>
      <div className="reference-quotes-context">
        {variantLabels[quote.variant]} ·{" "}
        {quote.scope === "catalog" ? "Catalog" : "Printing"} reference
      </div>
    </li>
  );
}

/** New prop objects with the same pricing identity preserve the current lookup. */
export function ReferenceQuotes({ card }: { card: Card }) {
  return (
    <ReferenceQuotesPanel key={referenceQuoteIdentity(card)} card={card} />
  );
}

function ReferenceQuotesPanel({ card }: { card: Card }) {
  const { id, game, name, setCode, number, rarity } = card;
  const requestCard = useMemo<Card>(
    () => ({
      id,
      game,
      name,
      setCode,
      number,
      rarity,
      setName: "",
      sourceUrl: "",
      provider: "",
      prices: [],
    }),
    [id, game, name, setCode, number, rarity],
  );
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<
    typeof createReferenceQuoteController
  > | null>(null);
  const [state, setState] = useState<ReferenceQuoteState>(() => ({
    snapshot: readReferenceQuoteCache(requestCard, pricing),
    loading: false,
    attempted: false,
  }));
  const [automatic, setAutomatic] = useState(true);
  const hasTimes = !!(state.snapshot?.fetchedAt || state.snapshot?.retryAt);
  const subscribeClock = useCallback(
    (notify: () => void) =>
      hasTimes ? subscribeReferenceClock(notify) : () => undefined,
    [hasTimes],
  );
  const now = useSyncExternalStore(
    subscribeClock,
    getReferenceClock,
    getReferenceClock,
  );

  useEffect(() => {
    const view = createReferenceQuoteController(requestCard, pricing, setState);
    controller.current = view;
    setState(view.getState());
    const visible = container.current
      ? observeReferenceVisibility(container.current, () => view.load())
      : null;
    setAutomatic(visible?.automatic ?? false);
    return () => {
      visible?.dispose();
      view.dispose();
      if (controller.current === view) controller.current = null;
    };
  }, [requestCard]);

  const snapshot = state.snapshot;
  const quotes =
    snapshot?.quotes.filter(
      (quote) => Number.isFinite(quote.amount) && quote.amount > 0,
    ) ?? [];
  const error = state.error ?? snapshot?.error;
  const retryAt = snapshot?.retryAt ? Date.parse(snapshot.retryAt) : 0;
  const coolingDown = retryAt > now;
  const label = state.loading
    ? quotes.length
      ? `${statusLabel(snapshot, now)} · refreshing`
      : "Loading references"
    : state.error
      ? quotes.length
        ? `${statusLabel(snapshot, now)} · refresh failed`
        : "Unavailable"
      : statusLabel(snapshot, now);
  const rows = (values: PriceQuote[]) => (
    <ul className="reference-quotes-list">
      {values.map((quote, index) => (
        <QuoteRow
          key={`${quote.source}:${quote.currency}:${quote.variant}:${index}`}
          quote={quote}
        />
      ))}
    </ul>
  );

  return (
    <div
      ref={container}
      className="reference-quotes"
      role="group"
      aria-label={`Market reference quotes for ${name}`}
    >
      <div className="reference-quotes-heading">
        <strong>Market references</strong>
        <span className="reference-quotes-status" role="status">
          {label}
        </span>
      </div>
      <p className="reference-quotes-caution">
        Physical printing &amp; finish unconfirmed. Comparison only; excluded
        from valuation.
      </p>
      {quotes.length > 0 ? (
        <>
          {rows(quotes.slice(0, 2))}
          {quotes.length > 2 && (
            <details className="reference-quotes-more">
              <summary>Show {quotes.length - 2} more comparison quotes</summary>
              {rows(quotes.slice(2))}
            </details>
          )}
        </>
      ) : (
        <p className="reference-quotes-empty">
          {state.loading
            ? "Looking up reference prices…"
            : state.attempted || snapshot || state.error
              ? "Reference price unavailable. No value has been applied."
              : automatic
                ? "References load when this card is in view."
                : "Load reference prices when you need them."}
        </p>
      )}
      {snapshot?.fetchedAt && (
        <p className="reference-quotes-fetched">
          Fetched{" "}
          <time
            dateTime={snapshot.fetchedAt}
            title={new Date(snapshot.fetchedAt).toLocaleString()}
          >
            {referenceQuoteAge(snapshot.fetchedAt, now)}
          </time>
          .
        </p>
      )}
      {quotes.length > 0 && (
        <details className="reference-quotes-provenance">
          <summary>Source dates &amp; context</summary>
          <p>
            Fetch time records this app’s retrieval, not the provider’s price
            update. Physical condition is not priced.
          </p>
          {snapshot?.fetchedAt && (
            <p>
              Fetched:{" "}
              <time dateTime={snapshot.fetchedAt}>
                {new Date(snapshot.fetchedAt).toLocaleString()}
              </time>
            </p>
          )}
          <ul className="reference-quotes-list">
            {quotes.map((quote, index) => (
              <li
                className="reference-quotes-provenance-row"
                key={`${quote.source}:${quote.currency}:${quote.variant}:${index}`}
              >
                <strong>
                  {quote.source} · {quote.currency}
                </strong>
                <p className="reference-quotes-time">
                  {quote.providerUpdatedAt ? (
                    <>
                      Provider updated{" "}
                      <time dateTime={quote.providerUpdatedAt}>
                        {referenceQuoteAge(quote.providerUpdatedAt, now)} ·{" "}
                        {new Date(quote.providerUpdatedAt).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    "Provider update time not supplied"
                  )}
                </p>
                <p>{quote.note}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="reference-quotes-error">{error}</p>}
      {coolingDown && snapshot?.retryAt && (
        <p className="reference-quotes-time">
          Retry after{" "}
          <time dateTime={snapshot.retryAt}>
            {new Date(snapshot.retryAt).toLocaleString()}
          </time>
          .
        </p>
      )}
      <button
        type="button"
        className="reference-quotes-refresh"
        disabled={state.loading || coolingDown}
        onClick={() => controller.current?.load(true)}
        aria-label={`${state.attempted || snapshot ? "Refresh" : "Load"} reference prices for ${name}`}
      >
        {state.loading
          ? "Loading…"
          : state.attempted || snapshot
            ? "Refresh"
            : "Load references"}
      </button>
    </div>
  );
}
