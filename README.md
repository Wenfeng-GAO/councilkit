# CouncilKit

Local-first rooms for multi-agent decisions.

CouncilKit is a planned macOS app for running structured discussions between local AI agents. Instead of manually copying context across chat windows, users create a room, add agents, assign a facilitator, run several discussion rounds, and generate a final Markdown report.

The core product idea is not "multi-agent chat". It is organized multi-agent decision-making with a topic, background, participants, rounds, summaries, convergence, and a durable report.

## MVP Scope

- Manage local agents: name, description, system prompt, provider, model, enable/disable, duplicate, import/export JSON.
- Configure model providers: OpenAI-compatible endpoints, Anthropic, and local/custom endpoints.
- Create discussion rooms with a topic, background, target output, mode, facilitator, participants, and max rounds.
- Run structured discussions in brainstorm, planning, or review mode.
- Let the user interrupt, add context, pause, retry, skip, or conclude.
- Generate a final Markdown report from the discussion.
- Persist rooms, agents, messages, agent runs, and reports locally.

## Product Principles

1. Local-first: agents, rooms, messages, and reports are local by default.
2. Structured: every discussion has a topic, goal, facilitator, rounds, and ending conditions.
3. Replayable: messages are stored as structured events, not just raw chat text.
4. Interruptible: the user can pause, redirect, or end the discussion at any point.
5. Focused MVP: no cloud sync, team collaboration, marketplace, mobile app, or real-time chat in V1.

## Repository Status

Implementation is in progress, driven by [VibeSpec](https://github.com/Wenfeng-GAO/vibespec) — a spec-first, checkpoint-driven workflow. Product definition (PRD), design (DESIGN), and tech plan (TECH) have been confirmed through VibeSpec and are the source of truth for current work.

The VibeSpec pipeline also persists per-phase state under `.vibespec/` (state, tasks, gate evidence).

## Technology Direction

> **Note:** Earlier design notes explored a macOS SwiftUI/SwiftData implementation. The confirmed TECH plan resolves the open "Web app vs macOS native" question in favor of a **pure-client Web app**. The SwiftUI notes under `docs/` are retained as historical context only; live implementation follows the Web stack below.

## Documentation

VibeSpec confirmed artifacts (current source of truth):

- [PRD](docs/vibespec/councilkit/PRD.md)
- [DESIGN](docs/vibespec/councilkit/DESIGN.md)
- [TECH](docs/vibespec/councilkit/TECH.md)
- [Implementation tasks](docs/vibespec/councilkit/TASKS.md)

Historical (pre-transform) exploratory notes:

- [Product document](docs/product.md)
- [Technical design](docs/technical-design.md)
- [Roadmap](docs/roadmap.md)

## Confirmed Stack (per TECH.md)

- Runtime: browser
- Language: TypeScript 5.x (strict)
- Framework: React 18 + Vite 5
- Routing: React Router 6
- Styling: Tailwind CSS 3 (dark theme built-in)
- State: Zustand (client) + TanStack Query (server)
- Persistence: IndexedDB via Dexie.js
- Tooling: Biome (lint/format), Vitest, Playwright, pnpm
- Secrets: AES-encrypted API key in localStorage

## Getting Started

```bash
pnpm install
cp .env.example .env.local   # 填入模型 API Key
pnpm dev                      # http://localhost:5173
```

验证命令（pnpm 11 在本机被前置 deps-check 阻塞时，用 .bin 等价直调）:

```bash
pnpm typecheck   # 或 ./node_modules/.bin/tsc --noEmit
pnpm lint        # 或 ./node_modules/.bin/biome check src
pnpm build
```

定义模型 API Key 的环境变量（`VITE_CLAUDE_API_KEY` / `VITE_OPENAI_API_KEY` / `VITE_DEEPSEEK_API_KEY`）后即可新建房间、添加 agent、发起多 agent 讨论。无 Key 时 agent 会静默离线，UI 正常。

## Implementation Status

T1–T12（构建 → 入口 → 模型 → db → 服务 → 工具函数 → 状态 → 布局 → 基础 UI → 页面 → 路由 → 质量收尾）全部完成，PRD P0（R1–R8）核心流程可走通：新建房间 → 添加 agent → 发起讨论（agents 互相看见并发言）→ 自动总结 → 用户追问。自动化测试与浏览器 QA 证据见 [集成验证报告](docs/vibespec/councilkit/VERIFY.md)。

## License

MIT
