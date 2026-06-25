<!-- GSD:project-start source:PROJECT.md -->

## Project

**CouncilKit**

CouncilKit is a local-first web app for running structured multi-agent discussions to improve decision quality. A user creates a room around a topic, adds AI agents (each backed by a model + role/stance), runs discussion rounds where agents see and challenge each other's points, and gets a durable Markdown summary. It is organized multi-agent decision-making — not multi-agent chat.

**Core Value:** Multiple agents seeing each other's responses and challenging/supplementing them produce a higher-quality synthesized conclusion than a user manually switching between model tabs and self-synthesizing.

### Constraints

- **Tech stack**: React 18 + Vite 5 + TypeScript 5 (strict) + Tailwind 3 (dark built-in) + React Router 6 + Zustand (client) + TanStack Query (server) + Dexie.js/IndexedDB + Biome + Vitest + Playwright + pnpm — locked by confirmed TECH.md (CR1 re-confirmed 2026-06-24).
- **Runtime**: Pure-client browser web app (the SwiftUI/macOS-native direction was explored and explicitly rejected in favor of a web stack).
- **Local-first**: Agents, rooms, messages, and reports are local by default. No cloud sync in V1.
- **Secrets**: API keys stored as AES-encrypted values in localStorage.
- **Model gateway**: `base_url` is configurable (CR1) — supports OpenAI-compatible endpoints, Anthropic, and local/custom endpoints. Browser cannot directly reach antchat (claude-binary auth); production needs its own path.
- **Discuss-mode config**: `workflow.discuss_mode` = discuss (default).

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

| Skill | Description | Path |
|-------|-------------|------|
| sketch-findings-councilkit | Validated design decisions, CSS patterns, and visual direction from sketch experiments. Auto-loaded during UI implementation on councilkit. | `.claude/skills/sketch-findings-councilkit/SKILL.md` |
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
