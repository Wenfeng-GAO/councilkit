---
date: 2026-07-08
topic: councilkit-discussion-mvp
---

# CouncilKit Discussion MVP Requirements

## Problem Frame

CouncilKit already has a confirmed PRD/DESIGN/TECH set and a Web implementation that can call model services, but the weekly planning context still repeats "complete councilkit mvp" because the product is not yet closed as a felt, reviewable user outcome.

The MVP should therefore stop expanding toward the full "multi-agent discussion room app" vision and prove one narrow promise: a user can create a room, run a real multi-agent discussion, see agents respond to each other, get a useful summary, ask a follow-up, and reload the room without losing the discussion.

## User Scenarios

**Scenario 1: First discussion**
- A user has a concrete thinking task, such as naming a project or reviewing a technical plan.
- They create a room, enter a topic and optional background, add two or three agents with distinct roles, and start the first round.
- The agents speak in order, later agents can refer to earlier agents, and the app generates a round summary.

**Scenario 2: Continue from a result**
- After reading the first round, the user asks a follow-up or adds a constraint.
- The next round includes the user message, prior summary, and current topic, then agents respond to the new direction.
- The user can see the follow-up, agent replies, and updated summary as one continuous room history.

**Scenario 3: Local dev validation**
- For MVP validation, the project can use the existing local model proxy path to reach `ant glm5.2` through `cld`.
- The validation goal is not production model hosting; it is proving the browser app's discussion loop with a real model path.

## Requirements

**Core Discussion Flow**
- R1. The user can create a room in under 30 seconds by entering a topic, optional background, and at least two role-defined agents.
- R2. Starting a round creates a durable round lifecycle: active while agents run, completed when persisted messages and summary are saved, and recoverable after refresh.
- R3. Agents speak in a deterministic order, and each agent receives the room topic, prior summary when available, user follow-up when present, and all earlier messages in the current round.
- R4. Each completed round has an independent summary that is displayed with that round and is not delegated to the last discussion agent.
- R5. The user can submit a follow-up after a round; the follow-up is visible in the room and becomes context for the next agent round.

**Reliability and Failure Behavior**
- R6. If one agent times out, returns empty content, or fails, the room marks that agent offline and continues with the remaining agents.
- R7. If all agents fail in a round, the app shows a clear retryable failure state instead of pretending a useful summary was generated.
- R8. The final displayed transcript remains stable after streamed output finishes; completed messages must not disappear because query state is stale.

**Model Path and Verification**
- R9. The MVP has one verified local model route for real discussion validation, using the existing dev model proxy when direct browser access is not possible.
- R10. Model selection copy and behavior must be honest: the UI should not imply fully production-ready multi-provider routing unless the route is actually configured and verified.
- R11. MVP completion requires automated coverage for orchestration state and at least one browser-level QA path for create room -> start round -> summary -> follow-up -> reload.

## Success Criteria

- A user can complete the first-discussion scenario with two agents and a summary without editing code.
- The first visible agent output appears within 10 seconds, or the agent is explicitly marked offline and skipped.
- A second agent demonstrably responds to the first agent's content, proving that this is a discussion rather than independent answers.
- A follow-up from the user creates a new round where agents respond to the user message.
- Refreshing or reopening the room preserves rounds, agent messages, user messages, and summaries.
- A verification note records the exact browser scenario, model route, screenshots or observations, and any remaining limitations.

## Scope Boundaries

- No macOS/Tauri packaging in this MVP; the confirmed current implementation is a browser Web app.
- No team collaboration, cloud sync, account system, sharing, marketplace, or mobile support.
- No agent template management beyond existing P1 placeholders.
- No independent-answer comparison mode unless it falls out naturally from existing code without expanding scope.
- No production model proxy commitment; the local proxy is a dev validation bridge only.
- No PDF/Markdown export for this MVP closure.
- No new execution issues should be split before user review of this brainstorm and plan.

## Key Decisions

- Treat "MVP complete" as one end-to-end, reload-safe browser workflow rather than broad parity with the historical product document.
- Keep the Web stack in `README.md` and `docs/vibespec/councilkit/TECH.md` as the source of truth; historical macOS design docs remain non-authoritative.
- Preserve sequential agent turns for MVP because they make "agent B saw agent A" easy to verify and reduce concurrency complexity.
- Use current model proxy work as validation infrastructure, not as product architecture.
- Prioritize state correctness and visible user flow over adding more agent management features.

## Dependencies / Assumptions

- The existing repo state on `main` is the planning baseline.
- `docs/vibespec/councilkit/PRD.md`, `DESIGN.md`, `TECH.md`, and `model-path-validation.md` are current source material.
- Real model validation depends on a configured local `cld` route or direct provider keys.
- The July monthly plan was unavailable in issue context, so weekly and prior month notes are treated only as motivation, not as additional product requirements.

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R2, R8][Technical] Which current state/query boundary causes completed streamed messages to disappear or fail to rehydrate?
- [Affects R9, R10][Technical] Should MVP keep the current provider enum or introduce explicit provider/model-name separation now?
- [Affects R11][Technical] What is the smallest reliable browser QA harness for this repo, given existing scripts and model proxy constraints?

## Next Steps

-> `/ce:plan` for structured implementation planning.
