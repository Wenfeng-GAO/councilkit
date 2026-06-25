# CouncilKit

## What This Is

CouncilKit is a local-first web app for running structured multi-agent discussions to improve decision quality. A user creates a room around a topic, adds AI agents (each backed by a model + role/stance), runs discussion rounds where agents see and challenge each other's points, and gets a durable Markdown summary. It is organized multi-agent decision-making — not multi-agent chat.

## Core Value

Multiple agents seeing each other's responses and challenging/supplementing them produce a higher-quality synthesized conclusion than a user manually switching between model tabs and self-synthesizing.

## Requirements

### Validated

Shipped and code-verified in the VibeSpec MVP (T1–T12 + FT1/FT2, 2026-06-23). typecheck/lint/build/vitest(25) green; P0 R1–R8 end-to-end flow validated through the real model path (ant glm5.2 via dev model-proxy).

- ✓ **R1**: User can create a discussion room with a topic — MVP
- ✓ **R2**: User can add agents and choose the underlying model (Claude / DeepSeek / GPT) — MVP
- ✓ **R3**: User can define an agent's role/stance (e.g. 产品经理 / 反对者 / 乐观主义者) — MVP
- ✓ **R4**: Agents see each other's messages and challenge/supplement them — MVP
- ✓ **R5**: A summary/decision digest is auto-generated when a discussion ends — MVP
- ✓ **R6**: User can continue a discussion (follow-up questions) within the same room — MVP
- ✓ **R7**: First agent reply arrives within 10s (stream 10s abort) — MVP (mechanism in place; real-run latency depends on API)
- ✓ **R8**: User can participate as a discussant; agents see and respond to user messages — MVP

### Active

Next milestone — to be confirmed with user. Hypotheses until scoped.

- [ ] Close VibeSpec Phase 5 verify gate with real-browser evidence (VT4 visual consistency / VT5 responsive+a11y / VT7 browser QA) — currently static-fallback
- [ ] Production model-gateway path (current `scripts/model-proxy.mjs` is dev-only via `cld ant glm5.2`; prod needs own API key direct or backend proxy)
- [ ] P1: Save and reuse agent configurations / "技术评审团" combos (R9)
- [ ] P1: Independent-answer mode — agents answer independently for side-by-side comparison (R10)
- [ ] P1: Add/remove agents mid-discussion (R11)
- [ ] P2: Export discussion record + summary as Markdown/PDF (R13)

### Out of Scope

From PRD "不做什么" — documented to prevent re-adding.

- Multi-user collaboration (multiple humans sharing a room) — personal tool; collaboration adds complexity. Reconsider after user validation shows clear demand.
- Auto-select best model/role — MVP keeps user in manual control; recommend only after enough usage data.
- Model fine-tuning/training — out of product range; use existing model APIs.
- Workflow automation (AutoGen-like task orchestration) — CouncilKit is a discussion tool, not a task-orchestration framework.
- Voice/video discussions — text is core; multimodal adds complexity. Reconsider when tech matures and demand exists.
- Cloud sync / team collaboration / marketplace / mobile app / real-time chat — excluded from V1 (local-first focused MVP).

## Context

- **Planning provenance**: This project was built under [VibeSpec](https://github.com/Wenfeng-GAO/vibespec) (spec-first, checkpoint-driven). Confirmed artifacts live in `docs/vibespec/councilkit/` (PRD / DESIGN / TECH / TASKS / VERIFY) and remain the source of truth for product definition; VibeSpec per-phase state lives under `.vibespec/`. GSD was adopted afterwards (brownfield) to drive the next milestone — VibeSpec artifacts are imported here, not replaced.
- **Current state**: VibeSpec Phase 5 (verify) is at `ready-for-confirm`. P0 R1–R8 code-complete. 3 of 7 verification dimensions (VT4/VT5/VT7) degraded to static-fallback because the build/verify environment had no browser or real API key — real-run coverage 57%.
- **Design direction** (from `sketch-findings-councilkit` skill + `.planning/sketches/`): 极简克制暗色 UI — Linear/Notion/Vercel aesthetic, 微信/飞书 group-chat feel. 260px sidebar (nav + room list, collapsible to 60px), left/right split chat (agents left dark bubbles + colored avatars, user right indigo bubble), agent as first-class entity (list → edit-page CRUD), concurrent streaming with typing badges. Deep-gray gradient bg, indigo primary, agent color system (purple/green/orange). ACP connection is mock-only in V1.
- **Validated model path**: antchat gateway has claude-binary-specific auth (browser can't fetch directly even with copied token/headers). Dev validation routes `/api/claude/v1/messages` → `scripts/model-proxy.mjs` (:8788) → `cld ant glm5.2 --print`, emitting Anthropic SSE the existing `stream.ts` parses unchanged.
- **Environment quirk**: pnpm 11 no longer reads `package.json`'s `pnpm` field; `pnpm run` is blocked by a deps-check / ignored-builds conflict. Validation commands use `./node_modules/.bin/{tsc,biome,vite,vitest}` directly — semantically equivalent, non-blocking.

## Constraints

- **Tech stack**: React 18 + Vite 5 + TypeScript 5 (strict) + Tailwind 3 (dark built-in) + React Router 6 + Zustand (client) + TanStack Query (server) + Dexie.js/IndexedDB + Biome + Vitest + Playwright + pnpm — locked by confirmed TECH.md (CR1 re-confirmed 2026-06-24).
- **Runtime**: Pure-client browser web app (the SwiftUI/macOS-native direction was explored and explicitly rejected in favor of a web stack).
- **Local-first**: Agents, rooms, messages, and reports are local by default. No cloud sync in V1.
- **Secrets**: API keys stored as AES-encrypted values in localStorage.
- **Model gateway**: `base_url` is configurable (CR1) — supports OpenAI-compatible endpoints, Anthropic, and local/custom endpoints. Browser cannot directly reach antchat (claude-binary auth); production needs its own path.
- **Discuss-mode config**: `workflow.discuss_mode` = discuss (default).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Web app over macOS SwiftUI native | Confirmed in TECH.md — resolves the "Web vs native" open question; browser runtime lowers friction | ✓ Good |
| CR1: model `base_url` configurable + multi-gateway + API contract | Reuse Anthropic-compatible gateways; support more providers without code change | ✓ Good (closed 2026-06-24, re-verified consistent) |
| Dev model-proxy via `cld ant glm5.2` | antchat gateway has claude-binary-specific auth; browser can't fetch directly._PROXY emits Anthropic SSE so `stream.ts` parses unchanged | — Pending (dev-only; production path undecided) |
| T4 rescope: `dispatchMessage` moved T4→T5 | VibeSpec Step 3.5 review found it depended on T5 service impls — task attribution error | ✓ Good (mechanism drove boundary correction) |
| ACP connection mock-only in V1 | Real ACP integration deferred until mock validates; triggers in `.planning/seeds/acp-real-integration.md` | — Pending |
| GSD adopted brownfield (this doc) | Drive next milestone with GSD phase/verify tooling; VibeSpec artifacts remain source of truth for product definition | — Pending |

---
*Last updated: 2026-06-25 after GSD brownfield initialization (VibeSpec import)*

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
