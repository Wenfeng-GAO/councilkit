#!/usr/bin/env node
/**
 * fake-cursor.mjs — fake `cursor-agent` CLI for Host driver tests.
 *
 * Commands:
 *   models                         print catalog text and exit
 *   --print --output-format json   read prompt from stdin, emit one result JSON
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  reply: "Fake cursor answer.",
  sessionId: "session-cursor-1",
  modelsExit: 0,
  modelsText: [
    "Available models",
    "",
    "auto - Auto (default)",
    "composer-2.5 - Composer 2.5",
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
    print: false,
    outputFormat: null,
    model: null,
    resume: null,
    mode: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "models" || a === "--list-models") out.models = true;
    else if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--output-format") {
      i += 1;
      out.outputFormat = argv[i] ?? "";
    } else if (a === "--model") {
      i += 1;
      out.model = argv[i] ?? "";
    } else if (a === "--resume") {
      i += 1;
      out.resume = argv[i] ?? "";
    } else if (a === "--mode") {
      i += 1;
      out.mode = argv[i] ?? "";
    }
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
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
  const prompt = readStdin();
  const sessionId = cfg.noSession
    ? null
    : cfg.rotateSessionId && args.resume
      ? `${cfg.sessionId}-rotated`
      : args.resume || cfg.sessionId;
  const text = cfg.emptyText ? "" : cfg.reply;
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
    model: args.model ?? "auto",
    promptBytes: Buffer.byteLength(prompt, "utf8"),
  };
  writeStats(cfg, { kind: "turn", resume: args.resume, model: args.model, mode: args.mode });
  const emit = () => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  };
  if (cfg.delayMs > 0) setTimeout(emit, cfg.delayMs);
  else emit();
}
