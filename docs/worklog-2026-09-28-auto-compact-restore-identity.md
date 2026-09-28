# Worklog — a dead ticket's resume row must not shadow the live one (2026-09-28)

Worktree: `worktrees/chat-on-steroids-auto-compact-overnight`, branch
`fix/auto-compact-goal-overnight`, base `bc9ff0c` (2.1.47).

## Why

Automatic Compact & Resume has not been proven live on this stack yet, so this lane audited the
whole transaction: filing (level + liveness), the page's stop/settle barrier, source/destination
send checkpoints, the durable handoff, pickups, Stop/cancel, reload recovery, restart restore and
the control projections. The audit found one concrete, provable identity gap.

## Confirmed defect

`bridge.ts::planCommandRestore` seeded `resumeTokens` **before** applying the staleness verdict
that drops a row from the transport queue. The seed feeds `rememberToken` at startup, which is the
identity `resumeJobFor` (app, page and Night Build owner-control projections) and
`cancelResumeNow` look up first.

A committed ticket's resume-command row can outlive the crash that lost its retirement write, and
it stays older than the transport TTL because the row is created when the brief is captured while
an automatic handover may take up to six hours to land. After the next restart, a **live** ticket
for the same session (an automatic one in the regression) was then shadowed by that dead row:

- `resumeJobFor(sessionId)` reported the finished ticket's stage (`done`) instead of the live
  ticket's `handoff-pending`, so the app, the composer control and Night Build read the wrong
  transaction.
- `cancelResumeNow`/`cancelSessionCompactionNow` refused (`cancelled: false`) because the
  remembered token was already `committed`, so the user could not cancel the open ticket until the
  dead WAL record aged out (up to 2 × the continuation TTL).

Reproduced by a temporary probe, then by the committed regression, which fails on the unpatched
tree and passes with the fix. The neighboring case (a resume row this restore *keeps* is still the
remembered continuation, so a polling page is told "that finished") is pinned by a second test.

## Change

- `src/main/bridge.ts::planCommandRestore` — the resume token is added to `resumeTokens` only for
  rows the plan actually keeps; a dropped (stale) row no longer votes on the session's current
  ticket. The `resumeTokens` field doc now says what it always meant.
- `AGENTS.md` §14 — one sentence recording the rule.
- `test/bridge.test.ts` — two regressions (stale shadow; kept-transport terminal reporting).

## Evidence

- `npx vitest run test/bridge.test.ts -t "resume row shadow|kept resume transport"` — 2 passed
  with the fix; the shadow test failed on `git stash` of `src/main/bridge.ts` (1 failed, 1
  passed), which is the pre-patch behavior.
- `npx vitest run test/bridge.test.ts test/continuation.test.ts test/resume.test.ts
  test/goal-resume-handoff.test.ts test/session-finish.test.ts` — 658 passed (bridge 520).
- `npx vitest run test/content-script.test.ts test/session.test.ts test/goal.test.ts
  test/night-build-chat-owner-control-v1.test.ts test/night-build-chat-control-v3.test.ts
  test/input-delivery-integration.test.ts` — 1253 passed.
- `npx vitest run --exclude test/mcp-shutdown.test.ts` then
  `npx vitest run test/mcp-shutdown.test.ts` — 5590 passed | 129 skipped in the main run, then
  6 passed in the isolated shutdown run.
- `npm run typecheck`, `npm run verify:privacy` (117 commits, 0 tags), `npm run verify:notices`
  (152 packages, 7 catalog entries, 730 pinned native archives) and `git diff --check` — clean.

No install, package, publish, push, merge or release step was run, and no other worktree's tracked
content was touched. This worktree had no `node_modules`; dependencies were hardlink-copied from
the identical-lockfile sibling `worktrees/chat-on-steroids-chat-turn-drift-v1` only so the suites
could run (gitignored build material in both trees).

## What was audited and found sound (not exhaustive)

- Automatic filing: level + live work, current binding/session id, worker/Pro/blocked/Stop/
  dismissed/superseded fences, `compactionFilings` single-flight, exact-turn refusal latch and its
  lift on a later turn/frontend.
- Safe boundary: the page's native-receipt wait, Stop-once, local-tool settle and fail-closed
  refusals in `extension/content.js`; 2.1.45's ignored-Stop wait preserved.
- Source/destination send custody: `not-attempted` → `attempted-unresolved` →
  `dispatched-unresolved` → `sent`, the per-token checkpoint lock, one exclusive dispatch, and the
  exact-document claim in `/commands/redeem`.
- Projections and pickups: `queueBrowserRecovery` refuses blocked/stopped chats for every trigger
  (asking/writing phases), the opening phase re-queues only while the destination send is
  unattempted, and the phase budgets are bounded.
- Stop/cancel: `stopSessionTurn` cancels the session's continuation before the stop command; a
  committed/committing ticket refuses cancel with `cancelled: false`.
- Goal move/retire on commit and on restart repair (`publishCommittedProjection`), including the
  pending-reply tombstone and the objective/switch move.
