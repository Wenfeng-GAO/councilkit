# Product Document: CouncilKit MVP

## 1. One-Sentence Positioning

Build a local-first macOS app that lets users place multiple local agents into the same room, run facilitated and round-based brainstorm, planning, or review sessions around one topic, and generate a readable Markdown decision report at the end.

The MVP is not "multi-agent chat". It is organized multi-agent collaborative decision-making.

## 2. Target Users

### 2.1 Independent Developers / Founders

People who need multiple AI perspectives on product direction, technical architecture, or MVP scope, but do not want to manually copy context between different chat windows.

### 2.2 Product Managers / Project Owners

People who want to run quick multi-perspective reviews where agents examine a problem from user, engineering, business, risk, and interaction angles, then converge into an execution recommendation.

### 2.3 Heavy AI Users

People who already have reusable agents and want to keep them as local assets that can be reused across different discussion rooms.

## 3. Product Principles

1. Local-first: agents, rooms, messages, and reports are stored locally by default.
2. Organized: each discussion must have a topic, background, target output, facilitator, rounds, and ending conditions.
3. Replayable: all messages are stored structurally, not only as raw chat text.
4. Interruptible: users can pause, add context, redirect, or conclude early.
5. Converge before expanding: V1 avoids real-time collaboration, cloud sync, plugin marketplaces, and complex permissions.

## 4. Core Use Cases

### 4.1 Brainstorm: Diverge and Cluster Directions

The user enters an open prompt, for example: "What should the MVP for a multi-agent discussion room include?"

Flow:

1. The facilitator proposes the first-round focus.
2. Agents propose ideas from different perspectives.
3. The facilitator clusters, deduplicates, and names directions.
4. A second round expands the most promising directions.
5. The final report outputs actionable direction options and priority recommendations.

### 4.2 Planning: Turn a Goal into an Execution Plan

The user enters a goal, for example: "Design the development plan for a macOS app."

Flow:

1. The facilitator clarifies constraints and target output.
2. Agents contribute from product, engineering, risk, interaction, and testing perspectives.
3. The facilitator organizes dependencies, milestones, and risks.
4. The final report outputs an execution plan, milestones, and next tasks.

### 4.3 Review: Evaluate a Plan or Design

The user provides a PRD, architecture design, code summary, or article outline.

Flow:

1. The facilitator defines review dimensions.
2. Agents review independently without directly calling each other.
3. The facilitator summarizes critical issues, open questions, and improvement suggestions.
4. The final report outputs a risk list, revisions, and a recommendation on whether to proceed.

## 5. MVP Scope

### 5.1 Agent Management

Required:

- Create agents.
- Edit agent name, description, system prompt, model provider, and model name.
- Delete agents.
- Enable or disable agents.
- Duplicate agents.
- Import and export agent JSON.
- Test whether a single agent can be called successfully.

Not in V1:

- Agent marketplace.
- Agent plugin system.
- Long-term agent memory.
- Complex tool permissions.
- Shared team agents.

### 5.2 Providers and Settings

Required:

- Configure OpenAI-compatible endpoints.
- Configure Anthropic.
- Configure local or custom endpoints.
- Save default provider and model.
- Store API keys in the system Keychain, not in the business database.

Not in V1:

- Detailed cost analytics.
- Automatic provider routing.
- Multi-account team administration.

### 5.3 Room Management

Required:

- Create rooms.
- Delete rooms.
- Edit room title, topic, background, and target output.
- Add or remove agents from a room.
- Assign one facilitator agent.
- Select discussion mode: brainstorm, planning, or review.
- Set max rounds.
- View room discussion history.
- Persist rooms and messages after app restart.

Not in V1:

- Real-time multi-user collaboration.
- Cloud sync.
- Room template marketplace.
- Agent private chat.

### 5.4 Discussion Flow

Required:

- User starts a discussion.
- Facilitator agent generates the first-round focus.
- Discussion agents speak in order.
- Facilitator summarizes consensus, disagreement, risks, and next-round questions after each round.
- User can interrupt to redirect, add background, or conclude early.
- The app generates a final report when max rounds are reached, the facilitator recommends convergence, or the user manually concludes.

Key rules:

- Only the facilitator schedules discussion flow.
- Discussion agents do not directly call each other.
- Each round has an explicit round number.
- Each message records speaker, role, round, timestamp, and metadata.
- If a discussion agent fails, it can be marked skipped and the room can continue. If the facilitator fails, the room should pause for user action.

### 5.5 Final Report

Required Markdown report sections:

- Background.
- Discussion goal.
- Participating agents.
- Discussion summary.
- Key consensus.
- Remaining disagreements.
- Recommendation.
- Risks and objections.
- Next actions.

Not in V1:

- PDF export.
- Report version management.
- Public share links.

These can be V1.1 features.

## 6. Information Architecture

Primary navigation:

1. Rooms: discussion room list and detail.
2. Agents: local agent management.
3. Settings: provider keys, default model, and data location.

Room detail layout:

- Left: room list.
- Top: room title, mode, status, and actions.
- Center: discussion timeline.
- Right: participants, current round, facilitator summary, and report entry.

Agents page:

- Agent list.
- Agent editor.
- System prompt editor.
- Provider and model selector.
- Test call button.
- JSON import/export actions.

Settings page:

- Provider configuration.
- API key management.
- Default model.
- Data storage location.

## 7. Core Objects and States

### 7.1 Room States

- `draft`: created but not started.
- `running`: discussion is active.
- `paused`: user paused the room or action is required.
- `concluding`: final report is being generated.
- `concluded`: final report has been generated.
- `failed`: a critical step failed and needs user handling.

### 7.2 Agent Run States

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`
- `cancelled`

### 7.3 Message Types

- `user_instruction`: user interruption or added context.
- `facilitator_focus`: facilitator proposes the current round focus.
- `agent_response`: discussion agent response.
- `facilitator_summary`: facilitator round summary.
- `report`: final report.
- `error`: error record.

## 8. Key User Journeys

### 8.1 First Use

1. User opens the app.
2. User configures a provider key in Settings.
3. User creates two or three agents.
4. User tests agent calls.
5. User creates the first room.
6. User selects facilitator and discussion agents.
7. User starts the discussion.

### 8.2 Full Discussion

1. User enters topic, background, and target output.
2. Facilitator generates the first-round focus.
3. Agents speak in order.
4. Facilitator summarizes the round.
5. User adds an extra constraint.
6. Facilitator incorporates the new constraint into the next round.
7. Second round continues.
8. User ends the discussion, or facilitator recommends ending.
9. App generates a Markdown report.

### 8.3 Failure Recovery

1. One agent call fails.
2. Timeline shows the failure reason.
3. User can retry the agent, skip the agent, or pause the room.
4. If the app restarts, the room restores to the latest persisted state.

## 9. Acceptance Criteria

V1 is complete when a user can:

1. Create two or three local agents.
2. Configure at least one usable provider.
3. Create a room with topic and background.
4. Assign one facilitator agent and multiple discussion agents.
5. Start the discussion and complete at least two full rounds.
6. Add a user interruption that is incorporated into the next round.
7. End the discussion and generate a Markdown decision report.
8. Restart the app and still see historical rooms and messages.
9. See an error when an agent fails and choose retry or skip.

## 10. Non-Goals

V1 does not include:

- Slack or Discord-style real-time chat.
- Multica platform sync.
- Scheduled automations.
- Complex organization permissions.
- Private chat between agents.
- Web app.
- Mobile app.
- Agent marketplace.
- PDF export.

## 11. Future Versions

### V1.1

- PDF export.
- Room templates.
- Report version management.
- More providers.
- Better retry and cancellation UX.

### V1.2

- Discussion process visualization.
- Key disagreement tracking.
- Agent response quality scoring.
- Reusable facilitator strategies.

### V2

- Multica sync.
- Team collaboration.
- Cloud rooms.
- Agent marketplace.
- Automated discussion workflows.
