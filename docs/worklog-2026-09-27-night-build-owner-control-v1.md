# Worklog — Night Build cross-app owner control v1 (2026-09-27)

Worktree: `worktrees/chat-on-steroids-chat-turn-drift-v1` (2.1.43 local snapshot).

## Why

Night Build can already read a conversation, send and cancel a Send through the frozen
`night-build-chat-control-v3` lane. It could not act on the owner controls that keep a long chat
usable: the global automatic-compaction switch, the per-chat Off/Goal/Loop mode, manual
Compact & Resume, or cancelling a compaction whose brief is still being written.

v3 is a shipped contract. Installed Night Build 0.1.67 validates `protocolVersion: 3`, the
`x-night-build-chat-protocol` header, the exact capability list (`state`, `model-catalog`,
`attachment-stage`, `configured-send`, `fresh-send`, `cancel-send`) and
`night-build-chat-control-v3.json`. Expanding v3 would make that client reject the generation.
Owner controls therefore ship as a separate versioned loopback generation.

## Protocol

`night-build-chat-owner-control-v1` — its own discovery file, token, header and port, sharing
the v2/v3 `instanceId`/`startedAt` generation so a stale v3 file cannot prove this one's
identity.

| Request | Effect |
| --- | --- |
| `GET /owner/state?conversation=<handle>` | Projection for one exact chat. |
| `POST /owner/conversations/<handle>/auto-compaction` `{enabled}` | App-wide switch through `updateConfig`, plus the durable automatic-ticket cancellation an Off requires. |
| `POST /owner/conversations/<handle>/mode` `{mode: off\|goal\|loop}` | Existing per-chat Goal/Loop owner (`setSessionAutomation`). |
| `POST /owner/conversations/<handle>/compaction` | Manual ticket through `compactSession` (202). |
| `POST /owner/conversations/<handle>/compaction/cancel` | Durable abort through `cancelSessionCompactionNow`; returns `cancelled` truthfully. |

Capabilities: `owner-state`, `auto-compaction-set`, `conversation-mode-set`, `compact-resume`,
`compact-cancel`.

State fields deliberately separate five facts:

- `autoCompaction.configured` — the app-wide saved switch;
- `autoCompaction.effective` — configured **and** this exact chat's model/role eligible
  (`automaticCompactionAllowed`), before the live threshold/work gates;
- `autoCompaction.triggerTokens` — the local recorder threshold in locally estimated units,
  never provider context occupancy; no estimate is on the wire;
- `mode` — the effective chat mode from `conversationAutomationMode`, with `blocked`
  (`worker`/`blocked`/null);
- `compaction.{active,state,automatic,phase,startedAt,cancelAvailable,startAvailable,error}` —
  the durable continuation and whether abort can still change it.

## What changed

- `src/shared/night-build-chat-owner-control-v1.ts` — protocol constants, discovery and state
  types.
- `src/main/night-build-chat-owner-control-v1.ts` — loopback server with the same hardened
  mechanics as v3 (loopback-only bind, bearer compare, protocol/Origin fences, exact-body
  parsing, discovery ownership check, bounded drain on stop).
- `src/main/night-build-chat-owner-control-v1-source.ts` — resolves the opaque handle at
  operation time, revalidates around awaits, and calls only existing owners. No parallel
  switch, objective or continuation ledger.
- `src/main/bridge.ts` — exports the shared pieces the lane reuses:
  `conversationAutomationMode` (one mode projection for app UI, browser sheet and owner
  control), `setAutomaticCompactionNow` (config + durable Off cancellation),
  `cancelSessionCompactionNow` (cancel result), `compactionPhaseOf`.
- `src/main/index.ts` — starts the owner-control lane beside v3 under the same v2 generation
  when v2 started, and stops it in the admission/drain phase.
- `test/night-build-chat-owner-control-v1.test.ts` — protocol fences, error mapping, frozen v3
  literals, and the real owners.

## Identity and safety

Requests resolve the existing opaque Night Build handle to the exact session + conversation
before reading or mutating, again immediately before the owner call, and again after it. A
handle that went stale, a session that moved, a superseded source chat, a worker/helper chat or
a blocked chat fails closed; a mutation never lands on a different chat because the original
moved. Auto-compaction fences mirror the browser sheet: a worker chat changes nothing; a blocked
chat may turn Off only. Cancel reports `cancelled: false` with `cancelAvailable: false` when the
commit crossed the abort boundary.

## Evidence

- `npx vitest run test/night-build-chat-owner-control-v1.test.ts` — 20 passed.
- `npx vitest run test/night-build-chat-control-v3.test.ts test/night-build-chat-transport-v1.test.ts test/night-build-chat-transport-v2.test.ts test/night-build-bridge.test.ts test/night-build-bridge-v2.test.ts` — 85 passed (v3 capability/discovery assertions unchanged).
- `npx vitest run test/bridge.test.ts` — 518 passed.
- `npx vitest run test/continuation.test.ts test/resume.test.ts test/goal.test.ts test/goal-resume-handoff.test.ts test/session.test.ts test/config.test.ts test/ipc.test.ts` — 543 passed.
- `npx vitest run test/context-meter.test.ts test/feature-parity.test.ts test/session-usage.test.ts test/input-delivery-integration.test.ts test/completion-input-integration.test.ts test/task-request.test.ts test/swarm.test.ts` — 292 passed.
- `npm run typecheck` — clean.

No install, package, publish, push, merge or release step was run. Night Build itself was not
touched; the client contract is the protocol table above.
