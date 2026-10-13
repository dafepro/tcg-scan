# Saved provider-catalog recheck

This is an explicit metadata comparison in Collection, not a new recognition,
printing resolver, physical verification, quote lookup or valuation path.

## Contract

- Each saved entry has a collapsed **Catalog recheck** panel. Opening it fetches
  nothing. One explicit action requests metadata for one identity, with at most
  one active check and one transient result for the collection.
- The adapter uses only the stored known provider, typed provider card ID and name.
  It does not recover Oracle identities, faces, artwork keys or provider IDs from
  notes, OCR or prices. Actual Pokémon/MTG/Yu-Gi-Oh saved-scan roundtrips are tested.
  Unsupported IDs have an explicit no-fetch state.
- The comparison binds the exact entry object and serialized original entry before
  awaiting. This includes entry/event IDs, saved identifiers, original catalog
  snapshot and reader/evidence versions. Byte-identical replacement also clears
  ownership; reorder alone does not. Edits/imports can conservatively invalidate
  all checks because storage validates by replacing collection objects.
- Cancel, disclosure close, navigation/unmount, delete/Undo, filtered-out entries
  and replacement invalidate pending work. A cancelled request's finalizer cannot
  clear a newer request, and late responses cannot modify or restore entries.
- Successful results say **Same provider snapshot at this check**, or require
  review for changed/stale/incomplete provider data. Legacy evidence stays
  unversioned. Errors, unavailable dates/provenance and missing coverage cannot
  become success. Scope, fetch date and check dates are disclosed separately.
- No original evidence/model version/identifier is changed. No resolver reruns.
  Quantity, verification, finish/condition, prices, `priceEligible: false` and
  collection totals are untouched.

## Refresh and cache semantics

`getPrintingCandidates(reference, { refresh: true })` bypasses the card TTL and,
for Pokémon, the set/Pocket-exclusion metadata TTL. Every provider request uses
HTTP `cache: "no-cache"` for revalidation. A refresh cannot join a normal task
that is allowed to return a TTL hit; refresh subscribers still coalesce together.
Normal scanner cache behavior stays the default.

Both modes share existing provider throttles/cooldowns, identity/pending limits,
response/total-byte/candidate/page caps, timeout budgets and cache bounds.
Subscriber cancellation stays independent. Failed refreshes may return the last
good snapshot as stale/incomplete, retaining its historical fetch date. Failure
never receives a fresh fetch time or overwrites the last good card record.

A single refresh-generation token prevents an older lookup from writing over a
newer explicit refresh, including shared Pokémon metadata. This may conservatively
skip caching unrelated older in-flight work; it never changes the snapshot
returned to its existing caller. Built-in IndexedDB writes remain atomic and
ordered by transaction creation, including concurrent writes after a cold open.
Already-issued storage writes are not claimed to be cancellable. Arbitrary custom
cache implementations and separate tabs are not globally freshness-coordinated.

## Transient first cut

Only one in-memory comparison is retained. Leaving Collection, reload and
collection replacement clear it. Version-1 backups are unchanged and continue to
contain the immutable saved evidence. There is no unbounded result history, no
fabricated evidence for legacy entries and no weakly bound persisted “current” flag.
The UI tells users that the comparison is session-only.

## Verification scope

Unit/state tests exercise semantic ordering, new siblings/fields/scopes, malformed
and missing provenance, version changes, incomplete/stale/missing coverage,
one-request bounds, cancel/restart/old-finally, reorder, byte-identical replacement,
Undo/delete and original evidence mutations. Real storage and backup roundtrips
verify unchanged quantity/value/verification/evidence and discarded check state.
Provider-client tests exercise forced auxiliary refresh, normal/refresh separation,
subscriber cancellation, bounded failures and out-of-order response/cache writes.

`tests/catalog-review.spec.ts` provides mocked-provider browser wiring tests for
keyboard/mobile/themes, same/changed/stale/legacy/unavailable states, cancellation,
navigation, deletion, import replacement, one-active checks and immutable storage.
These fixtures are not live-provider coverage, perception proof or physical
accuracy evidence. Browser execution and rendered screenshots are reported by the
separate final QA pass, not implied merely by these checked-in tests.
