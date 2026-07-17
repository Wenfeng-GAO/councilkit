# Protocol Corpus

Real CLI protocol captures, redacted (emails, home paths, hostnames, machine
ids removed). Session/thread/turn UUIDs are ephemeral and kept so frames stay
cross-referential. Rebuild from raw captures with:

```sh
node scripts/build-protocol-corpus.mjs /tmp/ck-proto
```

Raw captures live only in the local tmp dir and are never committed.

## Provenance

| File | Source | Captured | Notes |
| --- | --- | --- | --- |
| `codex/0.144.5-normal-turn.jsonl` | live `codex app-server` 0.144.5, macOS arm64 | 2026-07-17 | initialize → account/read → model/list → thread/start → one turn (`turn/completed` status `completed`). Frame format: `{"dir":"in"\|"out","msg":{...}}`. |
| `codex/derived-crash-mid-turn.jsonl` | derived from the normal capture | — | Truncated right after the first `item/agentMessage/delta`: the CLI dies mid-turn (EOF, no terminal). |
| `codex/derived-interrupted-turn.jsonl` | derived from the normal capture | — | `turn/interrupt` answered by `turn/completed` with status `interrupted`. |
| `codex/derived-approval-request.jsonl` | derived from the normal capture | — | Server→client `item/commandExecution/requestApproval` injected after `turn/start`; the Host must answer `{"decision":"denied"}` and the turn proceeds without tool output. |
| `cld/init-handshakes.json` | live `cld <route>` control `initialize` responses, all three routes | 2026-07-17 | `models[].resolvedModel` is the canonical model source; `agents` is non-empty by design (built-ins) and not part of the empty-surface contract. |
| `cld/ant-glm5.2-session.jsonl` | live `cld ant glm5.2` stream-json session (`scripts/capture-cld-corpus.mjs`) | 2026-07-17 | control `initialize` → one full turn (replay, `system/init`, `stream_event` deltas, `result` success) → one cancelled turn (interrupt answered, then `result` `error_during_execution`). Includes real `command_lifecycle` unknown frames and per-turn `system/init` repeats. |

## Coverage vs. the Stage A requirement

- normal turn: `codex/0.144.5-normal-turn.jsonl` ✓
- crash mid-turn: `codex/derived-crash-mid-turn.jsonl` ✓
- cancel/interrupted: `codex/derived-interrupted-turn.jsonl` ✓ and `cld/ant-glm5.2-session.jsonl` ✓ (live interrupt; the real cld terminal is `result` subtype `error_during_execution`, normalized to `user_cancelled` via the cancelling flag)
- approval request: `codex/derived-approval-request.jsonl` ✓
- write-before-ack / dispatch-timeout / idle-stream: covered by fixture-driven tests in `tests/host/claude-stream-json.test.ts` (deterministic timing control; live captures cannot reproduce them reliably)
- cld full-turn frames: `cld/ant-glm5.2-session.jsonl` ✓ (replay/init/stream_event/result for a completed turn and a cancelled turn)
- second codex protocol version: the installed CLI is 0.144.5; the schema dump at capture time (`/tmp/ck-proto/schema`, v1+v2) is used to hand-maintain version-tolerance in the parser. A second live sample is added when the local CLI updates.
