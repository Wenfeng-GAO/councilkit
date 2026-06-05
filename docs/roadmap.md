# Roadmap

## Current Status

CouncilKit is in project setup and design. The initial repository contains product and technical documentation. Application implementation has not started yet.

## V1: Local MVP

Goal: prove that a local macOS app can run structured multi-agent discussions and produce a useful final report.

### Milestone 1: App Shell and Persistence

- Create SwiftUI app shell.
- Add primary navigation for Rooms, Agents, and Settings.
- Add local persistence model.
- Implement basic room and agent CRUD.

### Milestone 2: Provider Layer

- Add provider configuration model.
- Store API keys in Keychain.
- Implement OpenAI-compatible provider.
- Implement Anthropic provider.
- Add single-agent test call.

### Milestone 3: Room Orchestration

- Implement `RoomOrchestrator`.
- Implement round state machine.
- Call facilitator and discussion agents in order.
- Persist messages and agent runs.
- Add retry, skip, pause, and cancel behavior.

### Milestone 4: Summaries and Reports

- Generate facilitator round summaries.
- Track consensus, disagreements, risks, and next questions.
- Generate final Markdown report.
- Add report display and Markdown export.

### Milestone 5: Reliability Pass

- Recover rooms after app restart.
- Handle provider failures.
- Handle empty responses and missing keys.
- Add state machine and prompt tests.
- Run manual two-agent, two-round acceptance scenario.

## V1.1

- PDF export.
- Room templates.
- Report version history.
- More provider options.
- Better cancellation and retry UX.

## V1.2

- Discussion process visualization.
- Key disagreement tracking.
- Reusable facilitator strategies.
- Agent response quality scoring.

## V2

- Multica sync.
- Team collaboration.
- Cloud rooms.
- Agent marketplace.
- Automated discussion workflows.
