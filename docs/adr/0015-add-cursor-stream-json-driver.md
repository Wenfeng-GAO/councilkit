# 0015: Add the cursor-stream-json (Cursor Agent CLI) driver

This ADR records a fifth Runtime Driver `cursor-stream-json`, backed by the
local `cursor-agent` CLI (Cursor account login, installation-managed). It
preserves ADR-0001: local Host boundary, no API-key storage, no HTTP driver.

## Why a fifth driver, and why per-turn processes

`cursor-agent --print` is single-shot headless. There is no long-lived stdin
session comparable to Claude stream-json or Codex app-server. So a discussion
turn is a short-lived process, like `kimi-stream-json` / `grok-stream-json`.
Continuity uses `--resume <session_id>` from the previous turn's JSON
`{"type":"result","session_id"}`.

## Protocol (live 2026-08-26, cursor-agent 2026.08.11)

- Catalog probe: `cursor-agent models` (text). First entry is `auto`
  (account default). Host never reads credential files.
- Discussion turn: `cursor-agent --print --output-format json --mode ask
  --trust --workspace <cwd>`, prompt on stdin. Requested `auto` / `default`
  / `configured` omit `--model` so Cursor picks the account default.
- Review/apply/fix spawn: `--print --output-format stream-json
  --stream-partial-output --force --trust --workspace <cwd>`, prompt on
  stdin. Same default-model omit rule.
- Result is a Claude-shaped JSON object:
  `{"type":"result","subtype":"success","result":"...","session_id":"..."}`.
- Live events reuse the Claude assistant/text frames plus Cursor
  `tool_call` `{subtype: started|completed}` with nested
  `tool_call.<name>.args`.
- Discussion is `--mode ask` (read-only). Review uses `--force`.

## Credentials

`installation-managed`. Discovery looks on PATH and `~/.local/bin` for
`cursor-agent` (not PATH `agent`, which may be grok). Auth is
`cursor-agent login` or `CURSOR_API_KEY`. The Host never reads Cursor
credential files.

## Consequences

- `DRIVER_IDS` grows to five. Profile options for cursor are a strict empty
  object (model lives on the Agent).
- `councilkit init` creates `review-cursor` (model `auto`) when
  `cursor-agent` is on PATH. It is not the preferred reporter.
- apply/fix still prefer grok `review-adversarial`; they fall back to
  `review-cursor` only when grok is absent.
- Review and Host share the same executable resolution (`cursor-agent`).
