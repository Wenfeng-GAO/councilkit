#!/usr/bin/env node
/**
 * Builds tests/fixtures/protocol-corpus/ from raw live protocol captures.
 *
 * Input: a directory of raw captures (default /tmp/ck-proto):
 *   - codex-session.jsonl     lines of {"dir":"in"|"out","msg":{...}} (JSON-RPC)
 *   - cld-init-*.json         control initialize responses from real `cld` routes
 *
 * Output (corpus is committed; raw captures are NOT — they contain PII):
 *   codex/0.144.5-normal-turn.jsonl        redacted full session
 *   codex/derived-crash-mid-turn.jsonl     truncated before turn/completed
 *   codex/derived-interrupted-turn.jsonl   terminal status rewritten
 *   codex/derived-approval-request.jsonl   server approval request injected
 *   cld/init-handshakes.json               redacted initialize responses
 *   cld/ant-glm5.2-session.jsonl           redacted full session: handshake,
 *                                          one completed turn, one cancelled
 *                                          turn (scripts/capture-cld-corpus.mjs)
 *
 * Redaction: emails, user home paths, hostnames, machine installation ids.
 * Session/thread/turn UUIDs are ephemeral and kept so frames stay
 * cross-referential.
 *
 * Usage: node scripts/build-protocol-corpus.mjs [rawDir=/tmp/ck-proto]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rawDir = process.argv[2] ?? "/tmp/ck-proto";
const outRoot = new URL("../tests/fixtures/protocol-corpus/", import.meta.url).pathname;

const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "redacted@example.invalid"],
  [/\/Users\/[^/"]+/g, "/Users/redacted"],
  [/[A-Za-z0-9-]+\.local/g, "redacted-host.local"],
  // Machine-identifying installation id on remoteControl/status/changed.
  [/"installationId":"[0-9a-f-]{36}"/g, '"installationId":"00000000-0000-4000-8000-000000000000"'],
];

function redact(value) {
  let text = JSON.stringify(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return JSON.parse(text);
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeJsonl(path, frames) {
  const lines = frames.map((frame) => JSON.stringify(redact(frame)));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return lines.length;
}

mkdirSync(join(outRoot, "codex"), { recursive: true });
mkdirSync(join(outRoot, "cld"), { recursive: true });

// --- codex: full normal session -------------------------------------------
const session = readJsonl(join(rawDir, "codex-session.jsonl"));
const normalCount = writeJsonl(join(outRoot, "codex", "0.144.5-normal-turn.jsonl"), session);

// Crash: everything up to (not incl.) the first agentMessage delta, then EOF.
const crashCut = session.findIndex(
  (f) => f.dir === "in" && f.msg?.method === "item/agentMessage/delta",
);
if (crashCut < 0) throw new Error("corpus build: no agentMessage delta found");
const crashCount = writeJsonl(
  join(outRoot, "codex", "derived-crash-mid-turn.jsonl"),
  session.slice(0, crashCut + 1),
);

// Interrupted: frames through the delta, then turn/completed with status
// "interrupted" (mirrors a turn/interrupt acknowledgement).
const throughDelta = session.slice(0, crashCut + 1);
const completedFrame = session.find((f) => f.dir === "in" && f.msg?.method === "turn/completed");
if (!completedFrame) throw new Error("corpus build: no turn/completed found");
const interrupted = [
  ...throughDelta,
  {
    dir: "out",
    msg: {
      id: 90,
      method: "turn/interrupt",
      params: { threadId: "<threadId>", turnId: "<turnId>" },
    },
  },
  JSON.parse(JSON.stringify(completedFrame, (key, value) => value)),
];
interrupted[interrupted.length - 1].msg.params.turn.status = "interrupted";
const interruptedCount = writeJsonl(
  join(outRoot, "codex", "derived-interrupted-turn.jsonl"),
  interrupted,
);

// Approval: inject a server->client approval request right after the
// turn/start response; the client (driver) answers {decision:"denied"}.
const turnStartResultIdx = session.findIndex(
  (f) => f.dir === "in" && f.msg?.id === 5 && f.msg?.result,
);
if (turnStartResultIdx < 0) throw new Error("corpus build: no turn/start result found");
const approval = [
  ...session.slice(0, turnStartResultIdx + 1),
  {
    dir: "in",
    msg: {
      id: "srv-approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "echo hi", reason: "redacted scenario" },
    },
  },
  { dir: "out", msg: { id: "srv-approval-1", result: { decision: "denied" } } },
  ...session.slice(turnStartResultIdx + 1),
];
const approvalCount = writeJsonl(
  join(outRoot, "codex", "derived-approval-request.jsonl"),
  approval,
);

// --- cld: initialize handshakes per route ----------------------------------
const ROUTE_NAME_BY_FILE = { response: "ant-glm5.2" };
const handshakes = {};
for (const file of readdirSync(rawDir)) {
  if (!file.startsWith("cld-init-") || !file.endsWith(".json")) continue;
  const stem = file.replace(/^cld-init-/, "").replace(/\.json$/, "");
  const route = ROUTE_NAME_BY_FILE[stem] ?? stem;
  handshakes[route] = redact(JSON.parse(readFileSync(join(rawDir, file), "utf8")));
}
writeFileSync(
  join(outRoot, "cld", "init-handshakes.json"),
  `${JSON.stringify(handshakes, null, 2)}\n`,
);

// --- cld: full ant-glm5.2 session (capture-cld-corpus.mjs) ------------------
let cldSessionCount = 0;
const cldSessionPath = join(rawDir, "cld-ant-glm5.2.jsonl");
if (existsSync(cldSessionPath)) {
  cldSessionCount = writeJsonl(
    join(outRoot, "cld", "ant-glm5.2-session.jsonl"),
    readJsonl(cldSessionPath),
  );
}

console.log(
  JSON.stringify({
    codex: {
      normal: normalCount,
      crash: crashCount,
      interrupted: interruptedCount,
      approval: approvalCount,
    },
    cldRoutes: Object.keys(handshakes),
    cldSession: cldSessionCount,
  }),
);
