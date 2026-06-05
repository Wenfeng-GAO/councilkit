# Technical Design: CouncilKit MVP

## 1. Technical Goal

Build a local-first macOS app that lets users manage local agents, create rooms, orchestrate multi-agent round-based discussions, and generate final Markdown reports from the discussion.

Design priorities:

- Reliable local persistence.
- Replaceable model provider layer.
- Discussion orchestration independent from UI.
- Future path to Multica sync or cloud collaboration.

## 2. Recommended Stack

- App: SwiftUI.
- Persistence: SwiftData. If stronger migration control is required, use SQLite plus GRDB.
- Concurrency: Swift Concurrency with async/await for agent runs.
- Networking: URLSession.
- Secrets: Keychain for provider API keys.
- Export: Markdown in V1. PDF later.

## 3. Module Boundaries

### 3.1 App Shell

Responsibilities:

- App startup.
- Global navigation.
- Settings injection.
- Global error and state presentation.

### 3.2 Agent Management

Responsibilities:

- Agent CRUD.
- Provider configuration references.
- Prompt editing.
- Agent enable/disable.
- Agent JSON import/export.

### 3.3 Room Management

Responsibilities:

- Room CRUD.
- Room participant management.
- Room status display.
- Timeline rendering.
- Report display and export.

### 3.4 Orchestration Core

Responsibilities:

- Control discussion rounds.
- Call facilitator and discussion agents.
- Generate round summaries.
- Decide whether to continue.
- Generate final report.

This logic should not live inside SwiftUI views.

Core objects:

- `RoomOrchestrator`
- `DiscussionStateMachine`
- `AgentRunner`
- `ReportGenerator`

### 3.5 LLM Provider Layer

Responsibilities:

- Abstract model providers.
- Normalize request and response types.
- Support streaming or non-streaming output behind one interface.
- Normalize errors, retry behavior, and cancellation.

V1 providers:

- OpenAI-compatible endpoint.
- Anthropic.
- Local custom endpoint.

## 4. Data Model

### 4.1 Agent

Suggested fields:

- `id: UUID`
- `name: String`
- `description: String`
- `systemPrompt: String`
- `providerID: UUID`
- `model: String`
- `temperature: Double`
- `isEnabled: Bool`
- `createdAt: Date`
- `updatedAt: Date`

### 4.2 ProviderConfig

Suggested fields:

- `id: UUID`
- `name: String`
- `kind: ProviderKind`
- `baseURL: String?`
- `apiKeyRef: String`
- `defaultModel: String`
- `createdAt: Date`
- `updatedAt: Date`

API keys should not be stored in the business database. `apiKeyRef` points to a Keychain item.

### 4.3 Room

Suggested fields:

- `id: UUID`
- `title: String`
- `topic: String`
- `background: String`
- `mode: RoomMode`
- `status: RoomStatus`
- `facilitatorAgentID: UUID`
- `targetOutput: String`
- `currentRound: Int`
- `maxRounds: Int`
- `createdAt: Date`
- `updatedAt: Date`

### 4.4 RoomParticipant

Suggested fields:

- `id: UUID`
- `roomID: UUID`
- `agentID: UUID`
- `role: ParticipantRole`, with values `facilitator` or `discussant`
- `orderIndex: Int`
- `isActive: Bool`

### 4.5 Message

Suggested fields:

- `id: UUID`
- `roomID: UUID`
- `round: Int`
- `speakerType: SpeakerType`, with values `user`, `agent`, or `system`
- `speakerID: UUID?`
- `role: MessageRole`, with values `instruction`, `response`, `summary`, `report`, or `error`
- `content: String`
- `metadata: JSON`
- `createdAt: Date`

### 4.6 AgentRun

Suggested fields:

- `id: UUID`
- `roomID: UUID`
- `round: Int`
- `agentID: UUID`
- `status: AgentRunStatus`
- `prompt: String`
- `response: String?`
- `error: String?`
- `startedAt: Date?`
- `finishedAt: Date?`

## 5. Orchestration State Machine

Room states:

- `draft`
- `running`
- `paused`
- `concluding`
- `concluded`
- `failed`

Single-round flow:

1. `startRound(roundNumber)`
2. Call facilitator to generate the round focus.
3. Call discussants in `orderIndex` order.
4. After each agent run completes, write `Message` and `AgentRun`.
5. Call facilitator to generate the round summary.
6. Decide whether the room converged, reached `maxRounds`, or was manually concluded.
7. Continue to the next round or enter `concluding`.
8. Generate final report and set status to `concluded`.

## 6. Prompt Design

### 6.1 Facilitator Round Prompt

Inputs:

- Room topic.
- Background.
- Target output.
- Current summary.
- Previous disagreements.
- Latest user interruption.

Outputs:

- Round focus question.
- Suggested angle for each discussant.

### 6.2 Discussion Agent Prompt

Inputs:

- Agent system prompt.
- Room topic and background.
- Current round focus.
- Current discussion summary.
- Existing same-round responses.

Output structure:

- Core position.
- Agreements.
- Disagreements or risks.
- New suggestions.
- Conclusion.

### 6.3 Facilitator Summary Prompt

Output structure:

- Consensus.
- Disagreements.
- Risks.
- Next-round questions.
- Whether ending is recommended.

### 6.4 Final Report Prompt

Output structure:

- Background.
- Discussion process summary.
- Final consensus.
- Recommended plan.
- Risks and objections.
- Next steps.

## 7. Error Handling

Must handle:

- Missing API key.
- Provider network failure.
- Empty model response.
- User-cancelled run.
- One agent fails but other agents can continue.
- App restart while a room was running.

Suggested strategy:

- Record failures at `AgentRun` level.
- Do not fail the full room because one discussant fails. Mark that agent as skipped and continue.
- If the facilitator fails, pause the room and wait for the user to retry or change provider.

## 8. UI Pages

### 8.1 Rooms List

- Room title.
- Mode.
- Status.
- Updated time.
- New room button.

### 8.2 Room Detail

- Topic and background editor.
- Participants panel.
- Timeline.
- Run, pause, and conclude buttons.
- Final report panel.

### 8.3 Agents List / Agent Editor

- Agent list.
- Prompt editor.
- Provider/model selector.
- Test call button.

### 8.4 Settings

- Provider configs.
- API key management.
- Data storage location.
- Default model settings.

## 9. Implementation Milestones

### Milestone 1: Local Data and Basic UI

- SwiftUI app shell.
- Agent CRUD.
- Room CRUD.
- Local persistence.

### Milestone 2: Provider Calls

- Provider abstraction.
- API key storage in Keychain.
- Single-agent test call.

### Milestone 3: Discussion Orchestration

- `RoomOrchestrator`.
- Round state machine.
- Ordered multi-agent calls.
- Round summary.

### Milestone 4: Final Report

- Conclude flow.
- Markdown report generation.
- Report display and export.

### Milestone 5: Reliability

- Error recovery.
- Cancellation and retry.
- App restart recovery.
- Basic tests.

## 10. Testing

Unit tests:

- State machine transitions.
- Prompt construction.
- Provider response parsing.
- Report structure generation.

Integration tests:

- Create agents, create room, run one round, generate summary.
- Room continues when an agent run fails.
- Data restores after app restart.

Manual acceptance:

- At least two agents complete two rounds.
- User interruption is incorporated into the next round by the facilitator.
- Final report is readable and can be exported as Markdown.
