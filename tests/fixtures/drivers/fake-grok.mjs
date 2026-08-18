#!/usr/bin/env node
/**
 * fake-grok.mjs — fake `grok` CLI for Host driver tests.
 *
 * Commands:
 *   models                         print catalog text and exit
 *   -p / --prompt-file + --output-format json   emit one JSON result
 *
 * Behavior via cwd/fake-driver-config.json (same pattern as fake-kimi).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  reply: "Fake grok answer.",
  sessionId: "session-grok-1",
  modelsExit: 0,
  modelsText: [
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
  ].join("\n"),
  emptyText: false,
  noSession: false,
  rotateSessionId: false,
  hang: false,
  delayMs: 0,
  statsPath: null,
};

function loadConfig() {
  try {
    const raw = readFileSync(join(process.cwd(), "fake-driver-config.json"), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeStats(cfg, extra) {
  if (!cfg.statsPath) return;
  const payload = {
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ...extra,
  };
  writeFileSync(`${cfg.statsPath}.${process.pid}`, JSON.stringify(payload));
}

function parseArgs(argv) {
  const out = {
    models: false,
    prompt: null,
    promptFile: null,
    outputFormat: null,
    model: null,
    resume: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "models") out.models = true;
    else if (a === "-p" || a === "--single") {
      i += 1;
      out.prompt = argv[i] ?? "";
    } else if (a === "--prompt-file") {
      i += 1;
      out.promptFile = argv[i] ?? "";
    } else if (a === "--output-format") {
      i += 1;
      out.outputFormat = argv[i] ?? "";
    } else if (a === "-m" || a === "--model") {
      i += 1;
      out.model = argv[i] ?? "";
    } else if (a === "--resume" || a === "-r") {
      i += 1;
      out.resume = argv[i] ?? "";
    }
  }
  return out;
}

const cfg = loadConfig();
const args = parseArgs(process.argv.slice(2));

if (cfg.hang) {
  setInterval(() => undefined, 60_000);
} else if (args.models) {
  writeStats(cfg, { kind: "models" });
  process.stdout.write(`${cfg.modelsText}\n`);
  process.exit(cfg.modelsExit);
} else {
  const prompt =
    args.promptFile !== null
      ? readFileSync(args.promptFile, "utf8")
      : (args.prompt ?? "");
  const sessionId = cfg.noSession
    ? null
    : cfg.rotateSessionId && args.resume
      ? `${cfg.sessionId}-rotated`
      : args.resume || cfg.sessionId;
  const text = cfg.emptyText ? "" : cfg.reply;
  const result = {
    text,
    stopReason: "end_turn",
    sessionId,
    usage: { input_tokens: 10, output_tokens: 4, total_cost_usd: 0.001 },
    modelUsage: { "grok-4.6-build": { inputTokens: 10, outputTokens: 4 } },
    promptBytes: Buffer.byteLength(prompt, "utf8"),
  };
  writeStats(cfg, { kind: "turn", resume: args.resume, model: args.model });
  const emit = () => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  };
  if (cfg.delayMs > 0) setTimeout(emit, cfg.delayMs);
  else emit();
}
