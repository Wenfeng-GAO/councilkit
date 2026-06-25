# Roadmap: CouncilKit

## Overview

This milestone closes the VibeSpec Phase 5 verify gate (real-browser evidence for VT4/VT5/VT7, currently static-fallback), hardens the model-gateway path to production (replacing the dev-only `scripts/model-proxy.mjs` → `cld ant glm5.2` route), and delivers the three P1 agent features from the PRD (R9 templates, R10 independent-answer mode, R11 mid-discussion add/remove). The journey runs foundation-first: stand up a production gateway, use it to produce real-browser verify evidence, then layer the agent features on the now-verified core. P0 R1-R8 are already shipped and code-verified under VibeSpec (2026-06-23) and are recorded below as a completed prior milestone for traceability — no new work.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Production Model Gateway** - Browser-reachable production model path replaces dev-only `cld ant glm5.2` proxy
- [ ] **Phase 2: Verification Gate Closure** - Real-browser evidence for VT4 visual / VT5 responsive+a11y / VT7 browser QA, closing VibeSpec Phase 5
- [ ] **Phase 3: Agent Templates** - Save/reuse agent configs as named templates ("技术评审团" combos)
- [ ] **Phase 4: Independent-Answer Mode** - Agents answer separately for side-by-side comparison
- [ ] **Phase 5: Mid-Discussion Agent Management** - Add/remove agents during an active discussion

## Prior Milestone (Completed — traceability only)

The VibeSpec MVP (P0 R1-R8) was delivered and code-verified on 2026-06-23 (T1-T12 + FT1/FT2; typecheck/lint/build/vitest-25 green; P0 end-to-end flow validated through ant glm5.2 via dev model-proxy). These requirements are recorded here so traceability is 100% — **no new work in this milestone**. Changing them requires an explicit CR.

| Requirement | Status | Delivered By |
|-------------|--------|--------------|
| R1 Create discussion room with topic | Validated | VibeSpec MVP (2026-06-23) |
| R2 Add agents + choose model | Validated | VibeSpec MVP (2026-06-23) |
| R3 Define agent role/stance | Validated | VibeSpec MVP (2026-06-23) |
| R4 Agents see and challenge each other | Validated | VibeSpec MVP (2026-06-23) |
| R5 Auto-generated summary on end | Validated | VibeSpec MVP (2026-06-23) |
| R6 Follow-up within same room | Validated | VibeSpec MVP (2026-06-23) |
| R7 First reply ≤ 10s (10s abort) | Validated | VibeSpec MVP (2026-06-23) |
| R8 User participates as discussant | Validated | VibeSpec MVP (2026-06-23) |

## Phase Details

### Phase 1: Production Model Gateway

**Goal**: Users can run real discussions through a production model-gateway path that the browser reaches directly, replacing the dev-only `scripts/model-proxy.mjs` → `cld ant glm5.2` route.
**Mode:** mvp
**Depends on**: Nothing (first phase of this milestone; builds on the validated MVP)
**Requirements**: GW-01
**Success Criteria** (what must be TRUE):

  1. User can enter their own model API key (and base_url) in the app's settings page, and the browser reaches the model endpoint directly — no `cld ant glm5.2` or dev proxy process running.
  2. A full discussion flow (create room → add agents → run round → auto-summary → follow-up) completes end-to-end through the production gateway with real model output visible to the user.
  3. The app runs on a clean checkout using only the user's configured API key, and `scripts/model-proxy.mjs` is no longer on the required runtime path.
  4. Gateway errors (invalid key / rate limit / upstream failure / timeout) surface a clear user-visible message and the affected agent is marked offline while other agents continue.

**Plans**: 1/5 plans executed
**Wave 1**

- [x] 01-01-PLAN.md (wave 1) — gateway 实体 + Dexie gateways 表 + 多 key AES crypto + 占位 gateway 迁移 (D-01/D-03/D-06/D-07)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 01-02-PLAN.md (wave 2, deps: 01-01) — Agent {gatewayId,model} 改造 + 双 adapter (anthropic/openai-compatible) + GatewayError 5 类契约 (D-02/D-04/D-09/D-13 header)

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-03-PLAN.md (wave 3, deps: 01-01, 01-02) — /settings 页 + 设计 token (success/warn/error/info/surface-2) + sidebar/router + agent 创建流 (D-05/D-08 + D-02 配套)

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 01-04-PLAN.md (wave 4, deps: 01-02) — 5 类错误处理 + runRound 编排 (致命扩散/全离线跳总结) + ErrorBanner/MessageBubble 双重呈现 (D-09/D-10/D-11/D-12)

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 01-05-PLAN.md (wave 5, deps: 01-02, 01-03, 01-04) — E2E 实跑 human-verify (D-13 Anthropic CORS) + SC#1/2/3/4 + dev proxy 路径清理

**UI hint**: yes

### Phase 2: Verification Gate Closure

**Goal**: The VibeSpec Phase 5 verify gate is closed with real-browser evidence for VT4 (visual consistency), VT5 (responsive + a11y), and VT7 (browser QA) — no more static-fallback.
**Mode:** mvp
**Depends on**: Phase 1 (VERIFY-03 real-API click-flow needs the production gateway path)
**Requirements**: VERIFY-01, VERIFY-02, VERIFY-03
**Success Criteria** (what must be TRUE):

  1. Semantic-color CSS variables (success/warn/error/info) are landed in the stylesheet, and real-browser screenshots show consistent visual rendering across pages and states (VT4 closed).
  2. Real-browser viewport evidence is captured at desktop and mobile breakpoints, and a real-run a11y check (keyboard navigation + aria labels) passes (VT5 closed).
  3. Real-API end-to-end click-flow screenshots (create room → run discussion → auto-summary → follow-up) are captured in a real browser using the Phase 1 gateway (VT7 closed).
  4. `docs/vibespec/councilkit/VERIFY.md` records VT4/VT5/VT7 as real-run passed, raising real-run coverage from 57% (4/7) to 100% (7/7).

**Plans**: TBD
**UI hint**: yes

### Phase 3: Agent Templates

**Goal**: Users can save a set of agent configs as a reusable named template (e.g. "技术评审团" combo) and apply it when creating new rooms.
**Mode:** mvp
**Depends on**: Phase 2 (verify gate stays closed while filling the existing /templates P1 placeholder)
**Requirements**: AGENT-01
**Success Criteria** (what must be TRUE):

  1. User can save a set of agent configs (model + role + color) as a named template from the /templates page (TemplateCard / TemplatePicker), backed by the existing `template.ts` model + Dexie.
  2. User can apply a saved template when creating a new room, auto-populating the entire agent list in one action.
  3. Saved templates persist across browser sessions (IndexedDB) and reappear on reload.
  4. User can edit and delete existing templates, with changes reflected immediately.

**Plans**: TBD
**UI hint**: yes

### Phase 4: Independent-Answer Mode

**Goal**: Users can switch a room to independent-answer mode where each agent answers the topic separately (without seeing other agents' responses) for side-by-side comparison.
**Mode:** mvp
**Depends on**: Phase 3 (sequential; **parallelizable** — touches `runRound` orchestration, independent of templates)
**Requirements**: AGENT-02
**Success Criteria** (what must be TRUE):

  1. User can toggle a room between "discuss" mode (agents see each other) and "independent" mode (agents answer separately) before or during a discussion.
  2. In independent mode, each agent's response is generated without seeing other agents' responses, and responses are shown side-by-side (ColumnCompareView) for comparison.
  3. A summary is still auto-generated at the end of an independent-mode round.
  4. The selected mode persists with the room across reloads (stored on the room).

**Plans**: TBD
**UI hint**: yes

### Phase 5: Mid-Discussion Agent Management

**Goal**: Users can add or remove agents during an active discussion without losing context or breaking the in-progress round.
**Mode:** mvp
**Depends on**: Phase 4 (sequential; **parallelizable** — touches `runRound` + agent list UI, independent of independent-answer mode)
**Requirements**: AGENT-03
**Success Criteria** (what must be TRUE):

  1. User can add a new agent to a room while a discussion is in progress, and the new agent participates from the next round.
  2. User can remove an agent mid-discussion; the removed agent stops participating in subsequent rounds and the existing message history stays intact.
  3. Prior discussion context (messages and summary) is preserved across add/remove operations.
  4. Edge cases are handled cleanly: cannot remove the last agent (guard), removing a currently-typing agent aborts its stream, and the agent list UI (AgentManagePanel) updates in real time.

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5.
Phases 3, 4, and 5 (the P1 agent features) are largely independent of each other and may be parallelized once Phase 2 closes the verify gate; the dependency chain above gives a nominal linear order.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Production Model Gateway | 1/5 | In Progress|  |
| 2. Verification Gate Closure | 0/TBD | Not started | - |
| 3. Agent Templates | 0/TBD | Not started | - |
| 4. Independent-Answer Mode | 0/TBD | Not started | - |
| 5. Mid-Discussion Agent Management | 0/TBD | Not started | - |

---
*Roadmap created: 2026-06-25 (GSD brownfield milestone — VibeSpec import)*
