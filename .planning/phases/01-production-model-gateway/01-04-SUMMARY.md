---
phase: 01-production-model-gateway
plan: 04
plan_id: 01-04
subsystem: gateway-error-orchestration
tags: [gateway, error-handling, runRound, ui, d11-a11y]
requires: [01-02, 01-03]
provides:
  - round-errors.ts helpers (isFatal/classifyRoundErrors/formatInlineHeader/Body/formatGatewayOfflineInline)
  - discussion store error state (agentErrors/agentErrorGateway/roundErrorSummary + setters)
  - runRound 5-class error orchestration (D-09/D-11/D-12)
  - ErrorBanner (role=alert) + MessageBubble inline error (role=status)
affects:
  - src/stores/queries.ts (runRound refactor; summary-agent selection now per first success)
  - src/components/room/DiscussionStream.tsx (mounts ErrorBanner; passes error props)
  - src/app/pages/RoomPage.tsx (legacy lastError line removed)
tech_stack:
  added: []
  patterns:
    - "5-class gateway error taxonomy (invalid_key/rate_limit/upstream/timeout/network)"
    - "Fatal-spread pattern (gatewayOffline Set in runRound, per-agent propagation skip)"
    - "Dual presentation (top banner role=alert + inline bubble role=status)"
    - "All-offline skip-summary (D-12) + partial-success summary-from-survivor"
key_files:
  created:
    - src/lib/round-errors.ts
    - src/components/room/ErrorBanner.tsx
    - tests/unit/round-errors.test.ts
  modified:
    - src/stores/discussion.ts
    - src/stores/queries.ts
    - src/components/message/MessageBubble.tsx
    - src/components/room/DiscussionStream.tsx
    - src/app/pages/RoomPage.tsx
decisions:
  - "Maintain AgentStatus singular 'offline' (no offline-fatal/offline-recoverable split); UI differentiates via agentErrors.kind + agentErrorGateway"
  - "Store combined agentErrorGateway {name,baseUrl} (not just gatewayName) to satisfy UI-SPEC network copy requiring baseUrl (T-04-01)"
  - "propagation detected via message==='网关已离线' sentinel (set by runRound); MessageBubble renders formatGatewayOfflineInline() accordingly"
  - "summary agent = first successful sender (not agents[0]) so offline lead agent still yields summary from survivor"
  - "ErrorBanner aggregates multi-class errors in one container; container tone = error if any fatal line, else warn"
metrics:
  duration: 6 min
  completed: 2026-06-25
  tasks: 2
  files: 8
status: complete
---

# Phase 01 Plan 04: Gateway Error Orchestration & Dual Presentation Summary

JWT-less gateway runtime: 5-class error handling chain from dispatchStream → runRound → discussion store → ErrorBanner + MessageBubble inline block. Fatal `invalid_key` propagates across same-gateway siblings without firing extra requests; all-offline rounds skip summary generation; partial-success rounds summarize from the surviving agent.

## What Was Built

### Task 1 — round-errors helpers + discussion store extension + runRound refactor (TDD)

**src/lib/round-errors.ts (NEW)** — pure classification + copywriting helpers:
- `AgentRoundError` / `FatalGatewayEntry` / `RoundErrorSummary` interfaces
- `isFatal(error)` — `invalid_key` only (D-11)
- `classifyRoundErrors(errors, allOffline)` — dedupes fatal gateways with per-gateway agent count; collects recoverable kinds distinct; returns `null` on empty input
- `formatInlineHeader(error)` — 5-class header strings matching UI-SPEC verbatim (`⚠ 密钥无效，已离线` / `⚠ 限流，已暂停` / `⚠ 上游故障` / `⚠ 请求超时` / `⚠ 网络错误`)
- `formatInlineBody(error, gateway)` — 5-class body strings; `network` body uses `gateway.baseUrl` (T-04-01 mitigation: never inject upstream `GatewayError.message` raw)
- `formatGatewayOfflineInline()` — D-11 propagation copy `{header, body(gatewayName)}`

**src/stores/discussion.ts** — extended state:
- `agentErrors: Record<string, GatewayError>`, `agentErrorGateway: Record<string, InlineGatewayInfo|undefined>`, `roundErrorSummary: RoundErrorSummary | null`
- `setAgentError(agentId, error, gateway?)`, `setRoundErrorSummary`, `clearRoundErrors`, `clearRoundErrorSummary`
- `reset()` clears all three new fields; `lastError` kept for backwards compatibility

**src/stores/queries.ts runRound** — full orchestration rewrite:
- `gatewayOffline: Set<string>` accumulator; per-agent pre-check skips same-gateway successors with propagation sentinel (no dispatch call)
- chunk.kind branching: string → accumulate delta; GatewayError → setAgentError + isFatal → add to set + break (no further chunk consumption)
- defensive try/catch wraps dispatchStream (Network fallback kind)
- end-of-round: `classifyRoundErrors` produces summary → setRoundErrorSummary if non-null
- D-12 all-offline → skip `generateSummary` entirely (no `db.summaries.add`, no `setSummary`)
- D-12 partial-success → `summaryAgent = agents.find(a => a.id === allMessages[0].senderId) ?? agents[0]` (uses survivor, not lead)
- D-12 `generateSummary` throw → catch appends `summaryFailed: {message}` to existing summary (or constructs bare summaryFailed summary); round.running cleared via `finally`
- 10s timeout unchanged (R7) — `src/lib/stream.ts` not touched

**tests/unit/round-errors.test.ts (NEW)** — 12 tests, all green:
- `isFatal` truth table (invalid_key → true; 4 recoverable kinds → false)
- `classifyRoundErrors` empty → null; dedup+count fatal gateways; collect recoverable kinds; propagate `allOfflineNoSummary` flag
- `formatInlineHeader`/`Body` 5-class headers verbatim + name/baseUrl interpolation
- `formatGatewayOfflineInline` propagation
- runRound mock suite (mock dispatchStream/generateSummary/db/gateways):
  - fatal-spread: a1(g1) invalid_key → a2(g1) propagated (no dispatch call, only 2 calls for a1+a3)
  - all-offline: 2 agents fail → generateSummary not invoked, allOfflineNoSummary=true, summaries.add not called
  - partial-success: a1 fails, a2 succeeds → generateSummary called with a2.gatewayId+model (not a1 / agents[0])
  - summary-failure: generateSummary rejects → catch fallback, `summaryFailed.message` captured, running=false

### Task 2 — ErrorBanner + inline MessageBubble + DiscussionStream wiring + RoomPage cleanup

**src/components/room/ErrorBanner.tsx (NEW)** — role=`alert` top-of-room aggregator:
- props `{summary, onDismiss}`; internal `visible` state reset on `summary` change (auto-reshow per round)
- 3-state tone per UI-SPEC: `allOfflineNoSummary` → warn 「本轮无有效发言，未生成总结。」; `summaryFailed` → warn 「总结生成失败：{msg}」; each `fatalGateway` → error 「网关「{name}」已离线：密钥无效。该网关下 {N} 个 agent 本轮已跳过。」; `recoverableCount > 0` → warn 「{N} 个 agent 本轮出错（限流 / 上游 / 超时 / 网络），其余 agent 继续。」
- container tone = error if any fatal line present, else warn
- dismissible `×` button with `aria-label="关闭"`

**src/components/message/MessageBubble.tsx** — extended props `error?/gateway?/errorPropagated?`:
- inline block rendered below content when `error` set
- propagation sentinel detected via `message.includes('网关已离线')` → renders `formatGatewayOfflineInline()`
- otherwise `formatInlineHeader(error)` + `formatInlineBody(error, gateway)`
- tone: `invalid_key` (incl. propagation) → `border-error bg-error/10`; recoverable → `border-warn bg-warn/10`
- header `text-sm font-semibold`, body `text-xs` per UI-SPEC typography
- `role="status"` (a11y: accompanies known agent slot, not alert-per-message)

**src/components/room/DiscussionStream.tsx**:
- reads `agentErrors/agentErrorGateway/roundErrorSummary/clearRoundErrorSummary` from store
- mounts `<ErrorBanner summary={roundErrorSummary} onDismiss={clearRoundErrorSummary} />` at top
- passes `error/gateway/errorPropagated` props to agent MessageBubbles (only for `senderType==='agent'`)
- drops legacy `部分 agent 离线，已跳过。` line (replaced by ErrorBanner)
- empty-state now also accounts for `roundErrorSummary` (banner present + empty stream still allowed)

**src/app/pages/RoomPage.tsx**:
- removed old `lastError ? <p>错误: {lastError}</p>` display (ErrorBanner supersedes)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical functionality] agentErrorGateway stored as combined `{name, baseUrl}` (not just `gatewayName`)**
- Found during: Task 1 store design
- Issue: UI-SPEC `network` body copy requires `{gateway.baseUrl}` interpolation (T-04-01 mitigation explicitly mandates baseUrl injection; raw `GatewayError.message` forbidden). Plan proposed `agentErrorGatewayName: Record<string,string>` only.
- Fix: store `agentErrorGateway: Record<string, InlineGatewayInfo | undefined>` carrying both fields; `setAgentError(agentId, error, gateway?: InlineGatewayInfo)` signature accordingly. `MessageBubble` and `formatInlineBody` consume both.
- Files: src/stores/discussion.ts, src/components/message/MessageBubble.tsx, src/lib/round-errors.ts
- Commit: 3df03c0

**2. [Rule 1 - Bug] Removed unused `getRoundsByRoom` import from queries.ts**
- Found during: Task 1 verification (tsc noUnusedLocals error TS6133)
- Issue: import was present historically but unused after refactor.
- Fix: trimmed import statement.
- Files: src/stores/queries.ts
- Commit: 3df03c0

**3. [Rule 3 - Blocking] Biome lint: `useSemanticElements` flagged `<div role="status">`; `useExhaustiveDependencies` flagged `useEffect([summary])`**
- Found during: Task 2 verification
- Fix: added scoped `biome-ignore` comments with rationale (semantic preference for explicit role for AT; summary-driven effect intentionally omits setVisible dep).
- Files: src/components/message/MessageBubble.tsx, src/components/room/ErrorBanner.tsx
- Commit: 9091005

### Decisions Made

- D1: `AgentStatus` type unchanged (no `offline-fatal`/`offline-recoverable` split) — UI differentiates via store-level `agentErrors.kind` + `agentErrorGateway`. Avoids downstream AgentStatus migration.
- D2: Propagation detection via `GatewayError.message === '...网关已离线'` substring (sentinel set by runRound). Acceptable since real-adapter `GatewayError.message` never contains this phrase; documented for future hardening (could migrate to a dedicated `propagated` flag).
- D3: Summary agent selected from first successful sender, not `agents[0]` — ensures the discussion still produces a summary even if the lead agent is the one that went offline.
- D4: 10s timeout (`src/lib/stream.ts`) untouched per R7 / D-12 lock. Plan honored exactly.

## TDD Gate Compliance

RED → GREEN → (no REFACTOR needed). Git log gate check:

1. `test(01-04): add failing test for 5-class round error orchestration` (145b98a) — RED gate; vitest output confirmed 1 failed suite (`Cannot find module '@/lib/round-errors'`).
2. `feat(01-04): 5-class gateway error orchestration in runRound + helpers` (3df03c0) — GREEN gate; 12/12 tests pass after implementation.

No RED skip. No premature-pass during RED. Gate sequence compliant.

## Verification (honest)

| Check | Result |
|-------|--------|
| `./node_modules/.bin/tsc --noEmit` | PASS (0 errors) |
| `./node_modules/.bin/biome check src tests` | PASS (0 errors after scoped biome-ignore comments) |
| `./node_modules/.bin/vitest run` | PASS — 102/102 tests (5 suites, including new `round-errors.test.ts` with 12 tests) |
| `role="alert"` present in ErrorBanner | YES (line 72) |
| `role="status"` present in MessageBubble | YES (line 81) |
| `aria-label="关闭"` on dismiss button | YES |
| 10s timeout untouched (R7/D-12 lock) | CONFIRMED — `src/lib/stream.ts` not modified |

Note: Full browser manual verification (seed bad key, observe red inline + fatal banner; seed timeout, observe yellow inline + warn banner; all-agents-fail → no summary) deferred to P05 per plan's `<verification>` section.

## Threat Flags

None beyond the plan's `<threat_model>`. T-04-01 (formatInlineBody baseUrl injection) implemented as specified; T-04-03 (gatewayOffline Set) prevents repeated 401s within a round; T-04-04 (Zustand immutable setters) honored. No new network endpoints, auth paths, or schema changes introduced.

## Known Stubs

None. All error copy wires live `gateway.name` / `gateway.baseUrl` from `db.gateways`. No hardcoded mock data; no `TODO`/`FIXME`/placeholder text in the error-presentation path.

## Self-Check: PASSED

Files exist:
- src/lib/round-errors.ts ✓
- src/components/room/ErrorBanner.tsx ✓
- src/stores/discussion.ts (modified) ✓
- src/stores/queries.ts (modified) ✓
- src/components/message/MessageBubble.tsx (modified) ✓
- src/components/room/DiscussionStream.tsx (modified) ✓
- src/app/pages/RoomPage.tsx (modified) ✓
- tests/unit/round-errors.test.ts ✓

Commits exist:
- 145b98a (test/RED) ✓
- 3df03c0 (feat/GREEN Task 1) ✓
- 9091005 (feat Task 2) ✓
