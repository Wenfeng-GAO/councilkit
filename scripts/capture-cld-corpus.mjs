#!/usr/bin/env node
/**
 * Captures a real `cld ant glm5.2` stream-json session as {dir,msg} NDJSON
 * for the protocol corpus (tests/fixtures/protocol-corpus/cld/). The raw
 * capture lands in /tmp/ck-proto/cld-ant-glm5.2.jsonl; run
 * scripts/build-protocol-corpus.mjs afterwards to redact it into the repo.
 *
 * Recorded sequence (dir convention: "out" = host->stdin, "in" = stdout->host):
 *   1. control_request initialize -> control_response (handshake)
 *   2. user turn "Reply with exactly: OK" -> replay, system/init, stream_event
 *      deltas, result (full successful turn)
 *   3. user turn "Count from 1 to 300..." -> first text delta, then
 *      control_request interrupt -> interrupted result (cancel mid-stream)
 *
 * argv mirrors runtime-host/drivers/claude-stream-json.ts buildArgv exactly
 * (no persona), so the capture matches the driver's real traffic.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT_PATH = process.argv[2] ?? "/tmp/ck-proto/cld-ant-glm5.2.jsonl";

const DISCUSSION_CONTRACT = [
  "You are one Participant in a structured CouncilKit discussion.",
  "Stay in the persona given above and answer only the final instruction.",
  "Do not use tools; plain reasoned text is the whole deliverable.",
].join(" ");

const argv = [
  "ant",
  "glm5.2",
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--no-session-persistence",
  "--safe-mode",
  "--disable-slash-commands",
  "--no-chrome",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--system-prompt",
  DISCUSSION_CONTRACT,
];

const frames = [];
const child = spawn("cld", argv, {
  env: { ...process.env, CLD_SKIP_UPDATE_CHECK: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", () => {});

function record(dir, msg) {
  frames.push({ dir, msg });
}

function send(msg) {
  record("out", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

// ---------------------------------------------------------------------------
// Sequenced capture state machine
// ---------------------------------------------------------------------------
let phase = "initialize";
let turn2DeltaSeen = false;

function onFrame(msg) {
  record("in", msg);
  if (phase === "initialize" && msg.type === "control_response") {
    phase = "turn1";
    send({
      type: "user",
      message: { role: "user", content: "Reply with exactly: OK" },
      uuid: "capture-turn-1-user",
    });
    return;
  }
  if (phase === "turn1" && msg.type === "result") {
    phase = "turn2";
    send({
      type: "user",
      message: {
        role: "user",
        content: "Count from 1 to 300, one number per line, no other text.",
      },
      uuid: "capture-turn-2-user",
    });
    return;
  }
  if (phase === "turn2" && !turn2DeltaSeen && msg.type === "stream_event") {
    const delta = msg.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      turn2DeltaSeen = true;
      send({
        type: "control_request",
        request_id: "capture-interrupt-1",
        request: { subtype: "interrupt" },
      });
    }
    return;
  }
  if (phase === "turn2" && turn2DeltaSeen && msg.type === "result") {
    phase = "done";
    child.stdin.end();
  }
}

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\n");
  while (index !== -1) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (line.trim()) {
      try {
        onFrame(JSON.parse(line));
      } catch {
        // Non-JSON stdout lines are not part of the protocol; skip.
      }
    }
    index = buf.indexOf("\n");
  }
});

child.on("exit", (code, signal) => {
  writeFileSync(OUT_PATH, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
  const kinds = frames.reduce((acc, f) => {
    const key = `${f.dir}:${f.msg.type ?? f.msg.subtype ?? "?"}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[exit] code=${code} signal=${signal} phase=${phase}`);
  console.log(`[saved] ${frames.length} frames -> ${OUT_PATH}`);
  console.log(JSON.stringify(kinds, null, 2));
  process.exit(phase === "done" ? 0 : 1);
});

send({ type: "control_request", request_id: "capture-init-1", request: { subtype: "initialize" } });
setTimeout(() => {
  console.error(`[timeout] phase=${phase}`);
  child.kill("SIGKILL");
}, 120_000).unref();
