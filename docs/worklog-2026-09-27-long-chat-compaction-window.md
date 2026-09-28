# Worklog — long-chat automatic compaction window (2026-09-27)

Worktree: `worktrees/chat-on-steroids-chat-turn-drift-v1` (2.1.43 local snapshot).

## Why

Automatic compaction was firing at the shipped 400,000 local-estimate trigger (amber 400k / red
533k). On the owner's real workload one conversation recorded well over 1.3M local units, so the
trigger was interrupting and re-fronting healthy long chats roughly a third of the way in. The
owner asked for a practical trigger in the ~700–800k band. The number is a **local recorder
heuristic** (`estimateTokens`: four characters per token over recorded events), never ChatGPT
provider context occupancy.

## What changed

- `src/main/config.ts`
  - `DEFAULT_CONTEXT_WINDOW` 400,000 → **750,000** (mid-band; ×4/3 red line is exactly
    1,000,000, the relation the settings panel derives). `sessions.advisoryTokens`,
    `sessions.limitTokens` and `compaction.autoTokens` all follow the one number.
  - One-time migration for configs that never chose their own numbers: the 400k/533,333 meter
    pair and an `autoTokens` of exactly 300,000 or 400,000 move to the new default. The `auto`
    switch is preserved verbatim (explicit Off stays Off). Any typed threshold stays.
  - Comments restate the history and the local-unit truth.
- `src/main/session/continuation.ts`
  - `latchAutomaticRefusal(entry)`: persists the existing exact-turn `autoCompactionRefusal`
    latch when an automatic ticket is retired. Pre-send loss already did this; explicit cancel
    (`abortContinuationNow`) and the sync sweep/handover expiry (`abortContinuation`) now do
    too, so the unchanged working turn cannot refile a fresh ticket behind the user's decision.
  - `abortContinuationNow` writes the latch before the abort and re-checks the transaction
    after the await (same abortable-state set plus the synchronous commit lock), so a commit
    that started during the latch is never aborted by a stale cancel.
- `src/main/agents.ts` — the worker revive ceiling comment no longer claims to be "the same
  400k figure the app uses"; the worker ceiling is its own lifecycle policy.
- `AGENTS.md` — checked-baseline row and §15 describe the new numbers and the all-abandonment latch.
- `src/renderer/chat.ts` — `urgentFrom` doc comment tracks the current default pair.

## Behavior

- Auto-compaction (owner-enabled; still off on a fresh install) now files at 750k local units
  while the exact chat is working, with every existing fence: not a worker, not exact Pro, not
  blocked, current binding, live work.
- A cancelled/failed/exhausted automatic ticket refuses only its exact conversation + source
  turn; a later turn or frontend lifts it. Manual Compact & Resume is unaffected and stays
  available in the same turn (covered by a bridge regression).
- Rebind still resets `contextTokens` to 0, and the refusal latch's conversation id no longer
  matches after a successful move, so no repeat compaction is created by the recalibration.

## Evidence

- `npx vitest run` (full suite minus `mcp-shutdown`) — green after pinning the
  `test/night-build-bridge.test.ts` fixture's local lines explicitly (its projection count test
  had been reading the shipped default).
- `npx vitest run test/continuation.test.ts test/session.test.ts test/config.test.ts test/feature-parity.test.ts test/context-meter.test.ts test/resume.test.ts test/goal.test.ts test/goal-resume-handoff.test.ts test/night-build-bridge-v2.test.ts test/night-build-chat-control-v3.test.ts test/session-usage.test.ts` — green.
- `npx vitest run test/bridge.test.ts` (518) and `test/content-script.test.ts` (717) — green.
- `npm run typecheck` — clean.
- New regressions: config migration/crossing (config, session), refusal latch across a store
  reset (continuation), cancel-stays-cancelled + manual-available + new-turn-refile (bridge).

No install, package, publish, push, merge or release step was run. The live user config was not
touched; the migration applies when a later build loads it.
