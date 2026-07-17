#!/usr/bin/env node
/**
 * fake-codex-app-server.mjs — dependency-free fake `codex app-server --listen
 * stdio://` for CouncilKit Runtime Host driver tests. Speaks JSON-RPC 2.0 as
 * NDJSON over stdin/stdout, nothing else on stdout ever.
 *
 * Spawned by the real driver as `<this file> app-server --listen stdio://` via
 * its shebang; ALL argv is ignored.
 *
 * Scenario control: identical mechanism to fake-cld.mjs — the supervisor's
 * environment hygiene blocks FIXTURE_* env vars, so behavior is configured
 * through `fake-driver-config.json` in the process cwd, re-read on every
 * inbound frame. Recognized keys (all optional):
 *
 *   reply                string  agent message text R   (default "Fake codex answer.")
 *   approval             bool    turn/start also emits a server->client
 *                                item/commandExecution/requestApproval; the turn
 *                                continues once the client answers
 *   reroute              bool    emit model/rerouted (gpt-5.6-sol -> gpt-5.5)
 *                                after the turn/start response
 *   crashAfterTurnStart  bool    exit(3) on turn/start WITHOUT responding
 *                                (dispatch state stays "unknown" upstream)
 *   hang                 bool    deltas but no item/completed + turn/completed
 *   unknownNotifications bool    interleave unknown notifications before deltas
 *   compacted            bool    emit thread/compacted after the first delta
 *   deltaDelayMs         number  delay between deltas   (default 8)
 *   statsPath            string  stats file prefix; stats land at `<statsPath>.<pid>`
 *
 * Stats (written after every event, tmp+rename): {pid, initializes,
 * accountReads, modelLists, threadStarts, turnStarts, interrupts,
 * approvalsReceived, approvalDecisions[]}.
 *
 * Protocol implemented (matching runtime-host/drivers/codex-app-server.ts):
 * - initialize / account/read / model/list / thread/start handshake
 * - turn/start -> {turn:{id}} then, in order: item/agentMessage/delta xN,
 *   item/completed (authoritative text), thread/tokenUsage/updated (per-turn
 *   `last` usage + modelContextWindow 258400), turn/completed completed
 * - turn/interrupt -> {} then turn/completed interrupted
 * - approval server requests carry their own id and are answered by the client
 *
 * On stdin EOF the fixture exits 0.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const DEFAULTS = {
  reply: "Fake codex answer.",
  approval: false,
  reroute: false,
  crashAfterTurnStart: false,
  hang: false,
  unknownNotifications: false,
  compacted: false,
  deltaDelayMs: 8,
  statsPath: null,
};

const APPROVAL_ID = "srv-approval-1";

function readConfig() {
  try {
    const raw = readFileSync(join(process.cwd(), "fake-driver-config.json"), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

const stats = {
  initializes: 0,
  accountReads: 0,
  modelLists: 0,
  threadStarts: 0,
  turnStarts: 0,
  interrupts: 0,
  approvalsReceived: 0,
  approvalDecisions: [],
};

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

function respond(id, result) {
  send({ id, result });
}

function notify(method, params) {
  send({ method, params });
}

function chunkText(text, size = 5) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [text];
}

let threadCounter = 0;
let turnCounter = 0;
let threadModel = null;
/** @type {{ id: string, timers: NodeJS.Timeout[] } | null} */
let currentTurn = null;
let pendingApprovalResume = null;

function clearTurnTimers(turn) {
  for (const timer of turn.timers) clearTimeout(timer);
  turn.timers = [];
}

function finishTurnSuccess(config) {
  const turn = currentTurn;
  if (!turn) return;
  currentTurn = null;
  const reply = config.reply;
  notify("item/completed", { item: { type: "agentMessage", text: reply } });
  const inputTokens = 500 + turnCounter; // per-turn value, never cumulative
  const outputTokens = reply.length;
  notify("thread/tokenUsage/updated", {
    tokenUsage: {
      total: { inputTokens: 1000 * turnCounter + inputTokens, outputTokens: outputTokens * turnCounter },
      last: { inputTokens, outputTokens },
      modelContextWindow: 258400,
    },
  });
  notify("turn/completed", { turn: { id: turn.id, status: "completed" } });
}

function scheduleDeltas(config) {
  const chunks = chunkText(config.reply);
  const step = (index) => {
    if (!currentTurn) return;
    if (index < chunks.length) {
      if (config.unknownNotifications) notify("some/unknownThing", { x: 1 });
      notify("item/agentMessage/delta", { delta: chunks[index] });
      currentTurn.timers.push(setTimeout(() => step(index + 1), config.deltaDelayMs));
      return;
    }
    if (config.hang) return; // Deltas sent, terminal never comes: idle timeout upstream.
    finishTurnSuccess(config);
  };
  step(0);
}

function scheduleCompactedTurn(config) {
  // One delta, then the runtime "compacts" the thread mid-turn.
  const chunks = chunkText(config.reply);
  notify("item/agentMessage/delta", { delta: chunks[0] });
  const turn = currentTurn;
  turn?.timers.push(
    setTimeout(() => {
      notify("thread/compacted", {});
      currentTurn = null;
    }, config.deltaDelayMs),
  );
}

function handleRequest(frame, config) {
  const { id, method, params } = frame;
  switch (method) {
    case "initialize": {
      stats.initializes += 1;
      writeStats(config);
      respond(id, { userAgent: "fake-codex/0.144.5", codexHome: "/tmp/fake-codex-home" });
      return;
    }
    case "account/read": {
      stats.accountReads += 1;
      writeStats(config);
      respond(id, {
        account: { type: "chatgpt", email: "fake@example.com" },
        requiresOpenaiAuth: false,
      });
      return;
    }
    case "model/list": {
      stats.modelLists += 1;
      writeStats(config);
      respond(id, {
        data: [
          {
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "fake flagship model",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
          },
          {
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "fake fallback model",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
          {
            model: "gpt-5.6-internal",
            displayName: "hidden model",
            description: "must be filtered out of the catalog",
            hidden: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      });
      return;
    }
    case "thread/start": {
      stats.threadStarts += 1;
      writeStats(config);
      threadCounter += 1;
      threadModel = typeof params?.model === "string" ? params.model : "gpt-5.6-sol";
      respond(id, { thread: { id: `thr_${threadCounter}` }, model: threadModel });
      return;
    }
    case "turn/start": {
      stats.turnStarts += 1;
      writeStats(config);
      if (config.crashAfterTurnStart) {
        // Crash after the request bytes were accepted but before any response:
        // the driver's dispatch state stays "unknown" for this turn.
        process.exit(3);
      }
      turnCounter += 1;
      const turnId = `turn_${turnCounter}`;
      currentTurn = { id: turnId, timers: [] };
      respond(id, { turn: { id: turnId } });
      if (config.reroute) {
        notify("model/rerouted", {
          fromModel: threadModel ?? "gpt-5.6-sol",
          toModel: "gpt-5.5",
          reason: "high demand",
        });
      }
      if (config.compacted) {
        scheduleCompactedTurn(config);
        return;
      }
      if (config.approval) {
        pendingApprovalResume = () => scheduleDeltas(readConfig());
        send({
          id: APPROVAL_ID,
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "item-1",
            command: ["/bin/echo", "fake"],
            reason: "fake approval request",
          },
        });
        return;
      }
      scheduleDeltas(config);
      return;
    }
    case "turn/interrupt": {
      stats.interrupts += 1;
      writeStats(config);
      respond(id, {});
      const turn = currentTurn;
      if (turn) {
        clearTurnTimers(turn);
        currentTurn = null;
        setTimeout(() => {
          notify("turn/completed", { turn: { id: turn.id, status: "interrupted" } });
        }, 30);
      }
      return;
    }
    default: {
      // Unknown requests get an empty success result, mirroring an open set.
      respond(id, {});
    }
  }
}

function handleClientResponse(frame, config) {
  if (frame.id !== APPROVAL_ID) return;
  stats.approvalsReceived += 1;
  stats.approvalDecisions.push(frame.result ?? null);
  writeStats(config);
  const resume = pendingApprovalResume;
  pendingApprovalResume = null;
  if (resume) resume();
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
    if (typeof frame?.method === "string" && frame.id !== undefined) {
      handleRequest(frame, config);
      return;
    }
    if (typeof frame?.method === "string") {
      return; // notifications (e.g. "initialized") are ignored
    }
    if (frame?.id !== undefined) {
      handleClientResponse(frame, config);
    }
  } catch {
    // The fixture must stay alive no matter what a test throws at it.
  }
});
rl.on("close", () => process.exit(0));
