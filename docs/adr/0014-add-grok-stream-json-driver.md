# 0014: Add the grok-stream-json (Grok CLI) driver

This ADR records a fourth Runtime Driver `grok-stream-json`, backed by the
local `grok` CLI (Grok Build TUI, installation-managed `grok login`). It
preserves ADR-0001: local Host boundary, no API-key storage, no HTTP driver.

## Why a fourth driver, and why per-turn processes

`grok -p` / `--prompt-file` is single-shot headless. There is no long-lived
stdin session comparable to Claude stream-json or Codex app-server. So a
discussion turn is a short-lived process, like `kimi-stream-json`. Continuity
uses `--resume <sessionId>` from the previous turn's JSON `sessionId`.

## Protocol (live 2026-08-18, grok 1.0.5)

- Catalog probe: `grok models` (text). Observed: default `grok-4.6`, also
  `grok-4.5`. Host never reads credential files.
- Turn: `grok --output-format json --prompt-file <cwd>/turn-prompt.txt -m <id>
  --disable-web-search --no-subagents --no-plan --cwd <participant-cwd>`.
- Result is one JSON object: `{ text, sessionId, usage, modelUsage }`.
  `modelUsage` keys may suffix the requested id (`grok-4.6-build`); that is a
  match, not a mismatch.
- `streaming-json` is ACP session-update NDJSON and is not used (noisy,
  tool/command dumps, harder to pin a deliverable).
- Discussion is final-only (no `output.delta`). Tools are soft-locked by
  contract + disabled web/subagent/plan flags. Grok has no verified empty-tools
  hard lock comparable to Claude `--tools ""`.
- Review spawn: same json format, plus `--always-approve`, isolated `--cwd`.

## Credentials

`installation-managed`. Discovery looks on PATH and `~/.grok/bin`. The Host
never reads `~/.grok` auth material.

## Consequences

- `DRIVER_IDS` grows to four. Profile options for grok are a strict empty
  object (model lives on the Agent).
- `councilkit init` creates `review-adversarial` when `grok` is on PATH.
- Review and Host share the same executable resolution (`grok`).
