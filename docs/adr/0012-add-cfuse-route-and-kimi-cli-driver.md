# 0012: Add the cfuse route and the kimi-stream-json (Kimi CLI) driver

This ADR records two related runtime additions: the `cfuse` route on
`claude-stream-json` (Slice 1), and a **third** Runtime Driver
`kimi-stream-json` backed by the local `kimi` CLI under coding-plan OAuth
(Slice 2). It is an incremental revision of [ADR-0001](./0001-use-local-runtime-host-for-model-execution.md):
it changes the "only two drivers" count, but preserves every ADR-0001 decision
— local Host boundary, installation-managed credentials, no API-key storage,
no HTTP driver.

## Background

The user's environment makes the `moonshot`/`deepseek`/`ant-glm5.2` cld routes
temporarily unavailable. Only `cld cfuse` (GLM-5.2 via the `cfuse-claude-code`
backend) works. Separately, the user wants to reach Moonshot Kimi K3 via the
local `kimi` CLI's coding-plan OAuth instead of an API key. Both needs are met
inside the existing Host security model: no secret ever enters the Host
process, no API key is stored.

## Decision: cfuse route (claude-stream-json)

- `claudeRouteSchema` admits `cfuse`. `cld cfuse` transparently execs the
  `cfuse-claude-code` backend (default `~/.local/bin/cfuse-claude-code`) via
  `CLD_CFUSE_BIN`; the `claude` binary / `CLD_CLAUDE_BIN` is **not** involved.
- A `cfuse-binary` installation component role is added. A `cld` installation
  is trusted when the wrapper **plus at least one backend** (`claude-binary`
  and/or `cfuse-binary`) validates — a cfuse-only environment is no longer
  marked `invalid` for lacking `claude`. The route-specific spawn pin sets
  `CLD_CFUSE_BIN` (cfuse) or `CLD_CLAUDE_BIN` (every other route); a missing
  route component fails `INSTALLATION_INVALID` naming the missing role.
- Live cfuse handshake capture (2026-07-22, plan-a §4.1 four-way evidence) is
  uniform: the control `initialize` catalog default, the full catalog,
  `system/init.model`, and the success-result `modelUsage` key all report
  `antchat/GLM-5.2[1m]`. No `servesModel` divergence is set (canonical = the
  catalog default). Existing GLM agents carry the un-prefixed modelId
  `GLM-5.2[1m]`; since the cfuse catalog uses the `antchat/`-prefixed form,
  `modelAliases` admits the legacy id as a binding-time compatibility name
  (moonshot precedent). Execution still uses the canonical catalog default.

## Decision: kimi-stream-json driver

### Why a third driver, and why per-turn processes

Kimi has no long-lived stdin mode: `--output-format stream-json` is prompt-mode
only, and the prompt must travel via the `-p` argv (E1, E2). So a turn is a
**short-lived** `kimi [-S <sid>] -m kimi-code/k3 -p <prompt> --output-format
stream-json --skills-dir <empty>` process; the Participant-level Execution
Session is kept continuous via `-S <session_id>` resume against the CLI's own
externally-persisted session (E6, E7). This is a **controlled exception** to
the "one long-lived process per Participant" principle adopted for Claude and
Codex: one Driver instance still belongs to exactly one Participant, runs at
most one execution at a time, and never shares the session — only the process
lifecycle differs.

### Credentials: still installation-managed

The driver authenticates through the local `kimi` CLI's coding-plan OAuth. The
Host **never** reads `provider list --json` (its provider nodes carry OAuth/API
key fields). The prewarm probe runs the text `kimi provider list` (no secrets)
as a diagnostic; execution always passes an explicit `-m kimi-code/k3`. No API
key, Keychain entry or credential config is read or stored by CouncilKit.
HTTP Driver and API-key storage remain excluded (ADR-0001).

### Closed catalog, final-only, no fabricated telemetry

- Catalog = `["kimi-code/k3"]`; canonical = `kimi-code/k3`; `modelAliases = []`
  (the bare `k3` alias is not guessed); context window `1_048_576`.
- The protocol is **final-only**: a turn emits exactly
  `{"role":"assistant","content":"…"}` (authoritative) then
  `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>"}`.
  The driver emits **no `output.delta`** (the protocol has none) and reports
  **`usage: null`** (no usage field exists — never estimated).
- `effectiveModel = requestedModel` and `modelVerdict = "match"`: the only
  model evidence is the Host's exact `-m` alias. This is **CLI-alias evidence**,
  not a claim that no provider-side reroute exists; if a live frame ever
  carries a model/reroute field, it must be parsed and a mismatch pauses
  (limitation recorded, not hidden).

### Honest toolState: "unknown", never a fabricated "none"

`-p` mode makes `kimi` a tooled coding agent; the CLI offers no zero-tools
switch (E4), and the stream-json protocol carries **no tool telemetry**. A
dedicated empty-cwd probe (2026-07-22) showed no file writes from a
discussion-shaped turn under `--skills-dir <empty>` + a `DISCUSSION_CONTRACT`
instruction — but absence-of-observed-writes is mitigation, not proof. The
driver therefore reports the honest `toolState: "unknown"` on every terminal,
never a fabricated `none`. Mitigations: a Participant-dedicated cwd, an empty
`--skills-dir` (isolating user/project skills), and a `DISCUSSION_CONTRACT`
instruction prepended only on the first (cold) turn.

### Settlement, resume-miss, cancel, close

- The process must **exit before** a terminal is emitted, so the resume hint is
  collected and the exit code confirmed. `exit 0` + non-empty assistant + a
  first-turn resume hint → `completed`; empty assistant → `EMPTY_OUTPUT`;
  first turn missing the hint → `INCOMPATIBLE_DRIVER`; any other non-zero exit
  → `DRIVER_CRASH`.
- A **resume-miss** (exit≠0, stderr `Session "…" not found`) bumps
  `sessionEpoch`, surfaces a retryable `not_dispatched` failure, and is **never
  retried in place** — the next turn cold-rebases so an incremental prompt is
  never silently sent into a fresh session.
- `cancel` / `crash` / `timeout` / `close` clear the in-memory session id and
  bump `sessionEpoch` (cancel/timeout/crash end reliable continuity; the
  reconciler cold-rebases next turn). The CLI's own session files (under
  `~/.kimi-code`) are **never deleted or modified** by CouncilKit.

### E2BIG guard

The prompt travels on `-p` argv (macOS ARG_MAX ≈ 1MB). The driver rejects a
prompt over 200KB with a structured `PROTOCOL_LIMIT` / `not_dispatched` failure
**before** spawn, rather than E2BIG-crashing (D2).

## Residual risks (recorded, not deferred fixes)

- **Tool observability.** The driver cannot prove tools were unused; it reports
  `unknown` and mitigates with cwd/skills-dir/contract isolation.
- **Prompt on argv.** Other processes owned by the same macOS user could
  observe argv. The Host threat model does not defend against a same-user
  malicious process; prompts/session ids are never written to logs or
  diagnostics.
- **Session persistence is external.** The CLI persists its own session state
  outside the repo; CouncilKit holds only the in-memory id and never cleans
  that data.
- **Effective-model evidence is weak.** Only the `-m` alias is evidence; a
  future protocol frame carrying a model field should override the verdict.

## What this ADR does NOT change

Local Runtime Host boundary, installation-managed credentials, no API-key
storage, no HTTP driver, no Keychain — all unchanged from ADR-0001. Existing
`ant-glm5.2`/`moonshot`/`deepseek` routes are untouched (their current
unavailability is environmental, surfaced by the existing probe/readiness
machinery, not error-coded here).