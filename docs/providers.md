# Catalog providers and pricing

This original browser-only implementation uses public, no-key HTTPS APIs. It does not scrape Quickdraw or include proprietary app code. The app has no pricing backend or guaranteed live quote feed.

## Integration contract

`searchCards(game, query, signal?)` returns at most 12 `Card` candidates. `getCard(game, id, signal?)` retrieves one catalog card. Both accept an `AbortSignal`. Abort is reported as `AbortError`; other failures are `CatalogError` with an informative message and a `code`.

- Games: `pokemon`, `mtg`, `yugioh`.
- Name searches and full catalog IDs are supported. MTG additionally accepts Scryfall search syntax, such as `set:lea cn:161`.
- Pokémon name searches return lightweight summaries. They contain an image, name, ID, collector number and set code, but no invented prices or full set name. **Call `getCard` when an assisted-search candidate is selected**, before showing its price details. The local visual path can store a descriptor identity immediately with empty prices and unconfirmed printing, then retrieve separate market quotes asynchronously.
- MTG searches return individual printings (`unique=prints`). Yu-Gi-Oh IDs identify card passcodes, not a specific physical printing.
- `prices: []` means unavailable. The UI must show “Price unavailable,” never `$0`. Only finite, positive numeric values are accepted; nulls, empty strings, negative values and zero placeholders are omitted.
- `CardPrice.source` labels the marketplace, catalog and finish/metric. `updatedAt` is the price-provider timestamp when available, otherwise the retrieval timestamp. `note` explicitly explains which one it is. Display the note with the price.
- A price is an estimate, not an appraisal or sale offer. Condition, edition, language and finish can materially change the value. Collection condition/finish controls do not automatically change the provider quote. Do not sum different currencies or claim the quote matches an unverified physical copy.

## Asynchronous market-quote contract

`pricing.ts` exposes `getPriceSnapshot(card, { signal?, force?, finish?, variantId?, onUpdate? })` and `readCachedPriceSnapshot(cardId, options?)`. A successful local visual scan is saved before requesting prices. Fresh cached quotes return immediately; stale cached quotes may return while a background request invokes `onUpdate`. `status`, age-based `freshness`, `refreshing`, retrieval time, expiry, source update time and error/backoff remain separate.

- Unknown finish exposes clearly labelled provider choices. It never silently selects a finish or a physical-card valuation. Identity-only automatic collection rows are excluded from totals and CSV price columns.
- TCGdex root quotes are catalog references, even when `variants_detailed` is absent. Selecting a detailed variant uses that card's nested variant pricing only; no fallback to unrelated root quotes. Variant IDs are not globally unique, so cache identity includes card and variant.
- Scryfall quotes are keyed to its card UUID and validated printing identity. Conflicting caller set/number metadata cannot relabel a cached quote.
- YGO set-code plus rarity can expose a `YGOPRODeck set reference` in USD. The API does not document its underlying marketplace, so none is invented. Bare passcode cache reads cannot return a cached specific-printing quote. Generic `card_prices` are explicitly catalog-wide lows.
- Missing, zero-placeholder, malformed and incompatible quotes remain unavailable. Currencies are never combined. No condition-specific multiplier, appraisal or grading claim is implemented.
- The quote module has its own bounded request queue (600 ms Scryfall, 250 ms others), cancellation, coalescing, timeouts, retry cooldown, identity validation and cache limits. The catalog and pricing queues are separate; deployments coordinating many tabs/users should share a global rate limiter.

## Magic: Scryfall

- Search: `https://api.scryfall.com/cards/search?q=…&unique=prints&order=name`
- Card: `https://api.scryfall.com/cards/{uuid}`
- USD prices use the documented `usd`, `usd_foil`, `usd_etched` fields; EUR uses `eur`, `eur_foil`. Labels identify TCGplayer or Cardmarket and finish. MTGO ticket values are not treated as currency prices.
- The first face supplies imagery when a double-faced card has no top-level image. Images are linked only from Scryfall's image origin; no card art is bundled in this repository. Preserve the full image, aspect ratio, artist attribution and copyright; do not crop, recolor, distort or watermark it.
- Scryfall's current hard limit for `/cards/search` is **2 per second**. The catalog adapter spaces its Scryfall request starts by at least 600ms per page instance and caches normalized data for 24 hours. It does not crawl the catalog or request additional result pages.
- Browser requests include `Accept: application/json`. The browser supplies its own User-Agent, which JavaScript cannot portably override. A future server implementation must send a descriptive application User-Agent and coordinate limits across users.

Official references checked 2026-10-12: [API](https://scryfall.com/docs/api), [rate limits](https://scryfall.com/docs/api/rate-limits), [card schema](https://scryfall.com/docs/api/cards), [access troubleshooting](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17).

## Pokémon: TCGdex

- Search: `https://api.tcgdex.net/v2/en/cards?name=…&pagination:page=1&pagination:itemsPerPage=12`
- Card: `https://api.tcgdex.net/v2/en/cards/{id}`, for example `base1-58`.
- Search is case-insensitive partial-name matching. An ID containing a set code and numeric collector suffix is looked up directly; hyphenated names such as “Ho-Oh” remain name searches.
- Card details contain `pricing.tcgplayer` market values in USD, with variant labels; `pricing.cardmarket` trend values are EUR. Unsupported explicit currencies are discarded. Source `updated` timestamps are preserved. Top-level card metadata dates are never substituted for price dates.
- Some cards have no marketplace data. Detailed subvariants, such as first editions and shadowless variants, are not auto-selected from photos. The top-level catalog quote can correspond to a different subvariant; verify the physical edition.
- Asset URLs are built from the provider's returned base with `/high.webp`, as documented.

Official references: [card search](https://tcgdex.dev/rest/cards), [filtering and pagination](https://tcgdex.dev/rest/filtering-sorting-pagination), [pricing](https://tcgdex.dev/markets-prices), [image formats](https://tcgdex.dev/assets). Live search/detail schemas were checked 2026-10-12.

## Yu-Gi-Oh: YGOPRODeck

- Search: `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=…&num=12&offset=0`
- Card: the same endpoint with `id={passcode}`.
- `card_prices` values are the provider's lowest across card versions. They do **not** identify an exact edition. A multi-printing card is labeled accordingly; we do not choose the first set entry and imply that it was recognized.
- Cardmarket is EUR; TCGplayer, eBay, Amazon and CoolStuffInc are USD. This response supplies no price-update timestamp, so the retrieval time is clearly labeled.
- **Artwork is intentionally omitted.** The official guide prohibits continual hotlinking and asks consumers to download/rehost art. The catalog UI ignores `card_images` and displays a text fallback. The offline reference builder downloads each source image once into a private local cache, then computes descriptors; it does not make the browser repeatedly hotlink those images. A link opens the provider's card page.
- Requests are spaced by 250ms and cached for 48 hours. The provider documents a 20 requests/second limit and a one-hour block if exceeded.

Official reference checked 2026-10-12: [YGOPRODeck API guide](https://ygoprodeck.com/api-guide/).

## Reliability, cache and privacy

Each request has a 15-second network timeout. Provider queues honor cancellation before sending requests; in-flight fetches are aborted. HTTP 429 stops automatic requests, records a cooldown (at least 60 seconds, or one hour for YGOPRODeck) and honors a longer Retry-After. There are no automatic retries. Malformed JSON, unexpected response shapes and incomplete identities produce an explicit error instead of fabricated cards. Search “not found” responses become an empty list.

Successful normalized responses are cached in memory (80 entries) and, when available, localStorage (at most 40 entries / 1,000,000 characters). MTG and Pokémon use 24-hour expiry; Yu-Gi-Oh uses 48 hours. Original price timestamps are preserved through caching. Cache values are cloned and validated on reload. A quota failure or blocked browser storage falls back to memory. There is no promise of complete offline search. Clearing site data also clears this cache; provider metadata may remain separate from collection data until then.

Queries and requested card IDs go directly from the browser to the selected provider. API fetches omit credentials and referrers. External artwork requests go to Scryfall or TCGdex and reveal the usual network request metadata to those services. Search and fetched metadata are stored in this browser's cache. Provider availability, CORS policy, data quality and licensing can change independently of this app. Limits are per page instance; a larger or multi-user deployment needs shared rate limiting, coordinated caching and review of each provider's current terms. Provider access is not a license to redistribute card artwork, logos, or underlying game intellectual property.

## Verification

`src/lib/catalog.test.ts` uses mocked `fetch` responses to cover provider mappings, source/currency/timestamp labels, missing data, ID and name search, result limits, art restrictions, unsafe URLs, provider errors, timeout, cancellation, rate limiting and bounded persistent caching. Tests do not consume the public APIs. Live endpoint smoke checks are supplemental and do not establish ongoing availability or exact price accuracy.
