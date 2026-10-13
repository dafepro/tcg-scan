# UI contract

TCG Scan follows **Progressive Disclosure**: reveal what helps the next action; keep everything else available on demand. The card is the focus.

- Give each state one dominant action. Keep Scan, Review, Collection, and Decks reachable, plus a relevant next step. Do not build dead ends.
- Lead Scan with the camera, concise status, and session count/undo. Collapse setup after readiness; hide engineering counters in the floating Debug console.
- Default to Ember (orange, charcoal, black). Offer live, persistent theme, density, and motion choices. Use semantic color tokens, restrained motion, labeled icons, visible focus, and accessible contrast. Support keyboard, small screens, and reduced motion.
- Use all installed references for the selected game. Never demand a card set before scanning. Disclose missing coverage; never imply unsupported games work automatically.
- Count saved occurrences, not unique names. Distinguish Pause, End session, Add another copy, and New page. Never infer a fresh physical copy from a missing detection. Require explicit action when uncertain; preserve undo.
- A name match does not confirm printing, finish, or condition. Keep uncertainty visible beside the result. Reference quotes stay out of confirmed totals.
- Appearance controls must not relax recognition or save gates. Announce success only after durable storage; show actionable failures immediately.

Read `docs/ui-design.md` before UI changes. Verify all themes, interrupted flows, mobile layout, and keyboard behavior. Run applicable checks; report untested behavior honestly.
