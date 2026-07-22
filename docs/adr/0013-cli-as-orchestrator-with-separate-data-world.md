# 0013: CLI as its own orchestrator with a separate data world

The V1.1 `councilkit` CLI (for coding agents and scripts) runs discussions
itself on top of the Runtime Host scope/execute/SSE/ack pipeline, and keeps
its own local store (`~/.config/councilkit/`) instead of sharing the
browser's Dexie data. The two data worlds do not interoperate in V1.1:
CLI-side static discussion configs are **Councils**, a run of one is a
**Run**, the designated final-summary agent is the **Reporter**, and a CLI
agent binds a **Driver Selection** (driverId + typed options + modelId,
resolved to an Installation at run time) rather than an **Execution
Profile**. Browser terms (Room, Facilitator, Convergence, Decision Report)
stay exclusive to the browser context. (See CONTEXT.md.)

## Considered Options

- **CLI-as-orchestrator (chosen).** Headless, works with the browser closed,
  ships independently; the cost is a simplified, second orchestration
  (fixed N rounds, full snapshots, no per-round summaries, no early
  convergence) and two non-interoperable data worlds.
- **Move orchestration into the Runtime Host.** The architecturally clean
  multi-client end state, but it means migrating the 1400-line browser
  orchestrator, the Dexie-backed round state machine, and the multi-tab
  fencing model. Deferred to V2 as its own project.
- **CLI bridges into the running browser.** Requires the browser to be
  open; fails the headless coding-agent use case. Rejected.

## Consequences

- V2 unification (host-side orchestration, shared Room model, CLI token
  endpoint) will require a migration of the CLI store and a terminology
  reconciliation; this ADR is the record that the split was deliberate,
  not an oversight.
- CLI authentication reuses the document-issued cookie + CSRF meta flow
  (no Host changes); a dedicated, revocable CLI token endpoint is deferred
  to V2 because the V1 Host has no persistence layer for token state.
- No MCP server is built; the CLI is the only automation surface.
