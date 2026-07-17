#!/usr/bin/env node
/**
 * fake-cld.mjs — dependency-free fake `cld` (claude stream-json wrapper) CLI
 * for CouncilKit Runtime Host driver tests. Speaks NDJSON over stdin/stdout:
 * one JSON object per line, nothing else on stdout ever.
 *
 * Spawned by the real driver as `<this file> ant glm5.2 --print ...` via its
 * shebang; ALL argv is ignored — the fixture only reads NDJSON stdin.
 *
 * Scenario control: the supervisor's environment hygiene (envInherit allowlist
 * + fixed driver envSet) makes it impossible to pass FIXTURE_* env vars through
 * the real driver, so behavior is configured through `fake-driver-config.json`
 * in the process cwd (the Participant-dedicated driver cwd, which the test
 * controls). The file is re-read on every inbound frame, so a test can change
 * behavior between turns. Recognized keys (all optional):
 *
 *   reply             string  reply text R                 (default "Fake cld answer.")
 *   initModel         string  model in system/init + modelUsage (default "GLM-5.2[1m]")
 *   catalog           array   full replacement for the initialize models list
 *                             (default [{value:"default",resolvedModel:initModel}])
 *   noReplay          bool    never send the replay echo (driver hits DISPATCH_TIMEOUT)
 *   initNonempty     bool    system/init carries tools:["Bash"] (INCOMPATIBLE_DRIVER)
 *   hang              bool    replay + deltas but never a result (stream idle timeout)
 *   crashAfterReplay  bool    send the replay echo, then exit(3)
 *   unknownFrames     bool    interleave {"type":"weird_thing"} frames before deltas
 *   deltaDelayMs      number  delay between stream deltas   (default 8)
 *   ignoreInterrupt   bool    answer interrupt with success but never end the turn
 *   statsPath         string  stats file prefix; stats land at `<statsPath>.<pid>`
 *
 * Stats (written after every event, tmp+rename): {pid, initializes, interrupts,
 * userMessages, results}. Usage/cost in result frames are CUMULATIVE across
 * turns of this process (per turn: input += 100 + promptLength, output +=
 * reply.length, cost += 0.001) because the driver reports per-turn diffs.
 *
 * Protocol implemented (matching runtime-host/drivers/claude-stream-json.ts):
 * - control_request initialize -> control_response success with models catalog
 * - control_request interrupt  -> control_response success; with a turn in
 *   flight, an interrupted result frame ~50ms later (unless ignoreInterrupt)
 * - user message -> replay echo (uuid match), system/init on the FIRST user
 *   message of the process only, chunked stream_event deltas, then a result
 *   frame with cumulative usage and modelUsage keyed by initModel
 *
 * On stdin EOF the fixture exits 0.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const DEFAULTS = {
  reply: "Fake cld answer.",
  initModel: "GLM-5.2[1m]",
  catalog: null,
  noReplay: false,
  initNonempty: false,
  hang: false,
  crashAfterReplay: false,
  unknownFrames: false,
  deltaDelayMs: 8,
  ignoreInterrupt: false,
  statsPath: null,
};

function readConfig() {
  try {
    const raw = readFileSync(join(process.cwd(), "fake-driver-config.json"), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

const stats = { initializes: 0, interrupts: 0, userMessages: 0, results: 0 };

function writeStats(config) {
  if (!config.statsPath) return;
  try {
    const target = `${config.statsPath}.${process.pid}`;
    writeFileSync(`${target}.tmp`, JSON.stringify({ pid: process.pid, ...stats }));
    renameSync(`${target}.tmp`, target);
  } catch {
    // Stats are best-effort diagnostics; never crash over them.
  }
}

process.stdout.on("error", () => {});
process.stdin.on("error", () => {});

function send(frame) {
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // stdout is gone; the process is being torn down anyway.
  }
}

/** Cumulative counters: result frames carry process-lifetime totals. */
const cumulative = { input: 0, output: 0, cost: 0 };
let initSent = false;
let inFlight = false;
let turnTimers = [];

function clearTurnTimers() {
  for (const timer of turnTimers) clearTimeout(timer);
  turnTimers = [];
}

function chunkText(text, size = 5) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [text];
}

function emitInterruptedResult() {
  const config = readConfig();
  send({
    type: "result",
    subtype: "interrupted",
    is_error: false,
    result: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
    modelUsage: {},
  });
  stats.results += 1;
  writeStats(config);
  inFlight = false;
}

function handleControlRequest(frame, config) {
  const subtype = frame.request?.subtype;
  const requestId = frame.request_id;
  if (subtype === "initialize") {
    stats.initializes += 1;
    writeStats(config);
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          models: config.catalog ?? [{ value: "default", resolvedModel: config.initModel }],
          commands: [],
          agents: [],
        },
      },
    });
    return;
  }
  if (subtype === "interrupt") {
    stats.interrupts += 1;
    writeStats(config);
    send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: {} },
    });
    if (inFlight) {
      clearTurnTimers();
      if (config.ignoreInterrupt) {
        // ACK the interrupt but never end the turn: no more deltas, no
        // result. The upstream grace window must expire and escalate.
        inFlight = false;
      } else {
        turnTimers.push(setTimeout(emitInterruptedResult, 50));
      }
    }
    return;
  }
  // Unknown control subtypes still get a well-formed success response.
  send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: {} },
  });
}

function handleUserMessage(frame, config) {
  stats.userMessages += 1;
  writeStats(config);
  inFlight = true;
  if (config.noReplay) {
    // Total silence: no replay, no init, no deltas, no result. The driver
    // must surface DISPATCH_TIMEOUT within its dispatch window.
    return;
  }
  send({ type: "user", message: frame.message, uuid: frame.uuid });
  if (config.crashAfterReplay) {
    // Flush stdout, then die like a crashed CLI.
    process.stdout.write("", () => process.exit(3));
    setTimeout(() => process.exit(3), 100).unref();
    return;
  }
  if (!initSent) {
    initSent = true;
    send({
      type: "system",
      subtype: "init",
      tools: config.initNonempty ? ["Bash"] : [],
      mcp_servers: [],
      skills: [],
      slash_commands: [],
      model: config.initModel,
    });
  }
  const prompt = typeof frame.message?.content === "string" ? frame.message.content : "";
  const reply = config.reply;
  const chunks = chunkText(reply);
  const step = (index) => {
    if (!inFlight) return;
    if (index < chunks.length) {
      if (config.unknownFrames) send({ type: "weird_thing", foo: "bar" });
      send({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: chunks[index] },
        },
      });
      turnTimers.push(setTimeout(() => step(index + 1), config.deltaDelayMs));
      return;
    }
    if (config.hang) return; // Deltas sent, result never comes: idle timeout upstream.
    cumulative.input += 100 + prompt.length;
    cumulative.output += reply.length;
    cumulative.cost += 0.001;
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      usage: { input_tokens: cumulative.input, output_tokens: cumulative.output },
      total_cost_usd: cumulative.cost,
      modelUsage: {
        [config.initModel]: {
          inputTokens: cumulative.input,
          outputTokens: cumulative.output,
        },
      },
    });
    stats.results += 1;
    writeStats(config);
    inFlight = false;
  };
  step(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return; // malformed input is ignored, never fatal
  }
  try {
    const config = readConfig();
    if (frame?.type === "control_request") {
      handleControlRequest(frame, config);
      return;
    }
    if (frame?.type === "user") {
      handleUserMessage(frame, config);
      return;
    }
    // Any other inbound frame is ignored.
  } catch {
    // The fixture must stay alive no matter what a test throws at it.
  }
});
rl.on("close", () => process.exit(0));
