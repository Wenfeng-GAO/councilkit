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

This repository currently contains the product and technical design documents for the initial public project setup. Implementation has not started yet.

## Documentation

- [Product document](docs/product.md)
- [Technical design](docs/technical-design.md)
- [Roadmap](docs/roadmap.md)

## Suggested Stack

- macOS app: SwiftUI
- Persistence: SwiftData, or SQLite plus GRDB if migration control becomes important
- Concurrency: Swift Concurrency
- Networking: URLSession
- Secrets: Keychain
- Export: Markdown first, PDF later

## License

MIT
