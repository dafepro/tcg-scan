# TCG Scan interaction contract

## Design principle

**Progressive Disclosure** governs the product: show the information needed to choose or understand the next action, and keep secondary information one deliberate action away. The camera/card is the visual center. This is a practical hierarchy, not permission to hide uncertainty, failures, navigation, or destructive consequences.

The root `AGENTS.md` is the short agent-facing contract. This document supplies implementation detail. It describes target behavior; it is not evidence that every behavior has shipped.

## Layout and navigation

- Persistent destinations: Scan, Review (pending count), Collection, Decks. The current destination has a text label and selected state. Desktop uses a compact header; mobile may use a safe-area-aware bottom bar. Do not hide all navigation in a menu.
- Each view has one dominant next action; secondary controls use quieter treatment. An unavailable action has an adjacent explanation and an available recovery route.
- Scan opens with a compact title/context row, the large camera stage, a short actionable status, and the active session summary. Remove marketing hero text, duplicated instructions, workflow cards, always-open lookup panels, and broad metrics from the working surface.
- Keep a quiet Find a card link available. It opens manual lookup when needed rather than competing with the camera. A failed/uncovered match links directly to it with useful context.
- Review leads with the next unresolved card and Confirm and add. Collection leads with cards, search, quantities, and Scan more; Import/Export live under collection actions. Decks leads with the list and Check collection, then missing-card results.
- Contextual continuations include Review N cards, View collection, Scan another, and Find this card. Empty states offer a real action.
- Switching view, game or workflow while preparing, capturing, paused, draining or holding unsaved photo matches asks whether to end that session. Stay preserves it; confirmation uses normal teardown. Ended sessions navigate directly. A previous-session subtotal/recount notice survives return and denied restart until a new source successfully commits.

## Game, set, and database are different

Current code contains game tabs (Pokémon, Magic, Yu-Gi-Oh!) and reference-pack management, not a required manual expansion/set selector. The official built-in learned download is Pokémon English: 19,665 reference images representing 4,416 names in the checked release. Other providers support catalog lookup; installed recognition coverage still governs scanning.

Default to Pokémon and automatically search all its installed ready references. Show a small game/context control, not three equally prominent onboarding choices. Change game belongs in Scan options and must display honest per-game readiness. Never label a missing database as ready or imply automatic cross-game recognition. Preserve an intentionally chosen game.

Use the label Card database for setup. Before installation, show what is needed, the real download size/progress, and Install database. After installation, collapse to Ready · Pokémon with a Manage link. Put shard names, extraction failures, checksums, compatibility packs, and import formats in details. Missing coverage remains discoverable and appears at the failed-match decision point. Selecting an exact set/printing is useful only for later disambiguation; it must not precede normal scanning.

## Scan states and actions

| State                  | Dominant action     | Essential visible information                                                 |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------- |
| Database missing       | Install database    | Game, download size, local storage consequence, lookup alternative            |
| Ready / first visit    | Start camera        | One instruction: show all four edges and hold steady; photo alternative       |
| Permission / preparing | Cancel preparation  | Actual stage; do not show an invented percentage                              |
| Live                   | Pause               | Camera, per-card truthful status, saved count, Undo latest, quiet End session |
| Paused                 | Resume              | Paused label; saved counts remain unchanged                                   |
| Uncertain / poor view  | Specific correction | Move closer, reduce glare, or Find card as supported by actual evidence       |
| Saved                  | Continue scanning   | Added only after storage succeeds; card name, +1, Undo, unresolved details    |
| Ended                  | Start new session   | Session summary; new-session recount consequence; View collection             |
| Photo analyzed         | Add N matched cards | Preview and accepted results; unmatched regions never assert an identity      |
| Save blocked           | Recover storage     | Nothing added for failed receipts; export/reload route where applicable       |

Live cards and Pack opening remain distinct workflows because their capture/review behavior differs. Do not label Pack opening as Photo. Upload photo is a quieter alternate action within live scanning. If a future simplified mode switch is introduced, preserve these actual behaviors.

Scan options can hold Single cards / Binder or tabletop, the existing vetted save-policy choices, and automatic-save behavior. These affect results and require descriptive labels; they are not appearance experiments. No arbitrary confidence sliders. When auto-save is off, say Preview only and explain that results are not secretly queued for Review.

## Quantity, duplication, and session boundaries

The collection counts saved occurrences. The same name may legitimately have quantity greater than one. Presentation events are evidence of separate scan occurrences, not proof of unique physical ownership.

- Repeated frames of one continuously visible card must not repeatedly add it.
- Missing detection, glare, unknown identity, occlusion, and a detector restart do not prove that a card left or that a new physical copy arrived. Keep conservative latches until the supported occurrence mechanism or explicit user action permits a new event.
- Live **Add another copy** is scoped to the sole currently visible verified card. Replace it with the next physical copy, then request a fresh recognition event; other identities remain latched. In **Pack opening**, the identically named receipt action explicitly confirms an additional physical copy of that already matched identity. It creates a separate idempotent event, retains the original capture provenance, displays that the quantity was confirmed by you, and does not rearm automatic counting. Do not describe it as another camera observation.
- In binder mode, New page says that the new layout can count again. Require a deliberate action after changing the layout. Do not reset an entire page to solve one uncertain card.
- Simultaneously visible identical copies may count separately only when the implemented occurrence tracker can independently verify them. Do not advertise support based on a proposed design.
- Pause preserves the session and counts. End session stops capture but never removes collection items. Starting again explicitly begins a fresh counting context: Cards already scanned can count again. Changing game, workflow, or camera must not silently clear this boundary while scanning.
- A separate Clear collection action is destructive and must never be a euphemistic Reset. It needs its own explicit confirmation. Reset appearance restores appearance only.
- Undo targets the precise saved event and reports success only after durable removal. Keep last-session receipts visible after stopping; if a new session clears only the on-screen receipt list, explain that collection items remain.

A new session is committed only after source permission/playback and the local matcher are ready. Cancelled, denied or hidden-tab preparation preserves the previous session subtotal and receipts; late camera streams are stopped. A successful new session clears the on-screen session context while keeping collection entries. These boundaries require browser lifecycle regression tests after every related change.

## Truthful result hierarchy

Use short status words plus an icon/shape: Hold, Matching, Saving, Added, Check view, Preview only, Undone, Error. A colored outline alone is insufficient. Do not show rejected candidate names as asserted identities.

A recognized name may be added while printing, finish, and condition remain unknown. Display a compact Printing unconfirmed label beside that result, with optional details. A reference quote is not a verified valuation. Keep source/date/currency with quote detail and exclude unconfirmed reference quotes from confirmed collection totals.

## Themes and live appearance choices

Use semantic variables: background, surface, raised, text, muted, border, accent, accent-ink, focus, success, warning, danger. Do not retain a `lime` variable whose meaning changes by theme. Accent marks the next action and active navigation; semantic warnings/success remain independent of branding.

| Theme           | Background | Surface | Raised  | Text    | Muted   | Accent  | Accent ink |
| --------------- | ---------- | ------- | ------- | ------- | ------- | ------- | ---------- |
| Ember (default) | #0C0C0F    | #17171C | #2B2B33 | #F5F3EE | #B7B4BE | #FF9B54 | #1A1009    |
| Cobalt          | #0B0F16    | #141C28 | #27364B | #F0F4FC | #B1BFD3 | #78AEFF | #091324    |
| Violet          | #100D17    | #1B1626 | #342B46 | #F6F0FC | #C6B5D5 | #B9A0FF | #160E29    |

The implemented solid-color tokens are checked in `themes.test.ts`. Independent
source calculations found worst normal-text contrast across the tested surfaces
5.31–5.47:1, primary actions 8.23–8.97:1 and control boundaries 3.49–3.99:1.
Alpha blending, focus rings, images and actual rendered states still require pixel
checks. Themes share spacing and meaning. Success and warning remain semantic
colors independent of the selected accent.

Keep working presentation choices live and persistent: Ember / Cobalt / Violet; Comfortable / Compact density; System / Reduced motion; Minimal / Detailed scanner labels. Comfortable is the default. Minimal hides ancillary labels, never failure/uncertainty/status. System respects the OS reduced-motion setting; Reduced always disables nonessential movement. These are genuine presentation alternatives, not arbitrary numerical controls.

Use restrained 120–180 ms opacity/transform transitions for panels, selection, and saved feedback. No endless scanning sweeps, pulsing success, count-up animation, or layout shifts. Reduced motion changes states immediately. Preserve stable card/receipt positions while reading.

## Floating Debug console

Show one discreet labeled Debug button, away from camera targets and navigation. Opening it reveals tabs/sections for Appearance and Diagnostics. Desktop uses a bounded floating panel; phone uses a reachable sheet. Escape closes it and focus returns to the trigger. Close is always visible; keyboard users can reach every control without a drag interaction.

Appearance persists across reloads using a versioned, validated preference record and safe defaults. Persistence failure is nonfatal. Never mix it with collection storage or reset scanning when only a theme changes. Do not persist granted-camera state or automatically reopen the camera after a reload.

Diagnostics contains actual captured, skipped/dropped, queued, processed, and saved counts, with pipeline-specific labels, current processing state, and timings when measured. Distinguish capture queue from pending Review items. Keep reasons available on demand; do not invent counters from UI renders. UI refresh is bounded, and a closed console does not render a growing event list. Export must omit camera frames and private collection data unless separately requested.

Throughput filtering and queue scheduling are engineering behavior, not style choices. The UI must remain responsive and reveal a stalled/failed pipeline without making users interpret throughput counters.

## Acceptance checks

Verify desktop and narrow phone widths, 200% zoom, long card names, large quantities, empty states, all themes, system/reduced motion, keyboard focus order, visible labels, accessible live status, and touch targets of at least 44 CSS pixels where practical. Aim for 4.5:1 normal text and 3:1 large text/control boundaries. Ensure the floating console never covers the only primary action or traps users.

Exercise repeated Start/Pause/Resume/End, denied camera permission, cancelled preparation, navigation during analysis, storage failure, new session with the same card, explicit next copy, binder new page, undo, duplicate names, unsupported-game coverage, and theme changes during live capture. Appearance changes must not alter evidence thresholds or create inventory events. Record precisely what was tested and what remains unavailable.

## Prequeue scheduling and diagnostic semantics

Pack capture validates and consumes native source provenance before a bounded
sampled-image filter. Redundant adjacent samples may be skipped before allocating
receipt/queue metadata; changed or sharper views are admitted immediately, and
steady views refresh within 600 ms. The filter retains only two tiny sampled
representations. It never establishes identity, printing, physical-copy evidence,
or permission to save. Downstream geometric matching and durable-save gates are
unchanged. Public-video count, omission and latency regressions are required before
claiming a throughput improvement.

Adaptive backpressure separately limits pending work using measured service time
and a two-view latest/best reservoir. Reservoir replacement is a real omitted view,
not a visual-redundancy claim. Show every omission class; never present zero queue
overflow as zero total loss. Routine UI snapshots coalesce at 250 ms while durable
save/error/Undo/terminal feedback flushes immediately.

Diagnostics distinguishes captured frames, visual skips, admissions, reservoir
replacement/rejection/cancellation, queue omissions/capacity losses, processed views
and saved events. Measured dimensions/timings appear only after an
actual analysis and reset when preparing another source. Counts kept from a previous
ended session remain visible until a new session is successfully committed.


## Saved catalog review

Collection keeps a quiet, keyboard-accessible **Catalog recheck** disclosure on
saved entries. Opening it does not fetch. **Recheck provider catalog** explicitly
requests provider metadata for this one saved identity, with one active check
across the collection. Its pending state has **Cancel catalog check**; closing the
disclosure, leaving Collection, deleting/replacing/editing the entry, or filtering
it out cancels stale ownership. Reordering the same entries does not retarget work.

The result distinguishes **Same provider snapshot at this check**, changed
snapshot, stale fallback, incomplete coverage, unavailable response and
legacy/unversioned evidence. Provider scope and actual fetch/check dates remain
visible in the open panel. Same snapshot says nothing about global latestness,
physical validation, language/edition/finish/condition or collection valuation.
Original saved identifiers and evidence remain available without modification.

Only the latest comparison is retained in this view. Leaving/reloading or editing
the collection clears it; backups contain the original evidence, not this
transient result. A failed retry replaces the previous success display. Native
focusable disclosures, a collection-level polite announcement, wrapping long
snapshot IDs and 44px controls keep review usable with keyboard/mobile/themes.
