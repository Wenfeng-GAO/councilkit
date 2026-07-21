#!/usr/bin/env node
/**
 * fake-kimi.mjs — dependency-free fake `kimi` CLI for CouncilKit Runtime Host
 * driver tests. Speaks the kimi-code `--output-format stream-json` protocol:
 * newline-delimited JSON on stdout, nothing else on stdout ever.
 *
 * Spawned by the real driver as `<this file> [-S <sid>] -m <model> -p <prompt>
 * --output-format stream-json --skills-dir <dir>` via its shebang. The fixture
 * parses argv (`-S`, `-m`, `-p`, `--output-format`, `--skills-dir`) to drive its
 * behavior; it reads NO stdin in prompt mode (kimi prompt mode is one-shot).
 *
 * Two command shapes (matching runtime-host/drivers/kimi-stream-json.ts):
 *  - `provider list` (text): prints the OAuth provider + default model lines
 *    and exits 0. The driver's prewarm runs this as a diagnostic probe.
 *  - prompt mode (`-p ... --output-format stream-json`): emits the final-only
 *    frames `{"role":"assistant","content":"..."}` then
 *    `{"role":"meta","type":"session.resume_hint","session_id":"..."}`, and
 *    exits 0. No streaming deltas, no usage (matching E7).
 *
 * Scenario control: the supervisor's environment hygiene blocks FIXTURE_* env
 * vars, so behavior is configured via `fake-driver-config.json` in the process
 * cwd (the Participant-dedicated driver cwd the test controls). Re-read on
 * every turn/command. Recognized keys (all optional):
 *
 *   reply             string  assistant content        (default "Fake kimi answer.")
 *   sessionId         string  session_id in resume hint (default "session-fake-1";
 *                         the fixture always echoes the same id on resume unless
 *                         `rotateSessionId` is set, which diverges on turn 2)
 *   providerDefault   string  `Default model:` line     (default "kimi-code/k3")
 *   providerExit      number  exit code for `provider list` (default 0; non-zero
 *                         simulates OAuth/auth unavailable)
 *   noResumeHint      bool    omit the meta resume_hint frame (first-turn only)
 *   emptyAssistant    bool    emit `{"role":"assistant","content":""}` (EMPTY_OUTPUT)
 *   noAssistant       bool    emit no assistant frame, just the hint (EMPTY_OUTPUT)
 *   rotateSessionId   bool    resume turn returns a different session id (divergence)
 *   badJson           bool    emit a malformed (non-JSON) line before the assistant
 *                         frame — off-protocol tool-stdout leak (E10); turn still
 *                         completes but the terminal toolState becomes "unknown"
 *   toolTurn          bool    emit a tooled turn: assistant tool_calls frame →
 *                         role:"tool" frame → a bare non-JSON stdout line → the
 *                         final assistant content frame. Terminal toolState="completed".
 *   resumeMiss        bool    exit 1 with stderr `Session "..." not found` when a
 *                         `-S` is present (resume-miss race)
 *   crashAfterAssistant bool  emit assistant then exit(3) (DRIVER_CRASH on exit)
 *   hang              bool    emit nothing and never exit (idle/turn timeout)
 *   ignoreSigterm     bool    ignore SIGTERM so the watchdog escalates to SIGKILL
 *   delayExitStdoutMs number  after emitting frames, hold stdout open for this many
 *                         ms before flushThenExit (F2: exit control frame races the
 *                         stdout drain; 0 = close immediately)
 *   delayMs           number  delay before emitting frames (default 0)
 *   statsPath         string  stats file prefix; stats land at `<statsPath>.<pid>`
 *
 * Stats (written after every event, tmp+rename): {pid, providerLists, turns,
 * resumeIds[], models[], promptBytes[], usedSkillsDir, hadSid}.
 *
 * On a normal prompt turn the fixture exits 0 after the frames (mirroring the
 * real CLI's per-turn short-lived process model).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  reply: "Fake kimi answer.",
  sessionId: "session-fake-1",
  providerDefault: "kimi-code/k3",
  providerExit: 0,
  providerHang: false,
  noResumeHint: false,
  emptyAssistant: false,
  noAssistant: false,
  rotateSessionId: false,
  badJson: false,
  toolTurn: false,
  resumeMiss: false,
  crashAfterAssistant: false,
  hang: false,
  ignoreSigterm: false,
  delayMs: 0,
  delayExitStdoutMs: 0,
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

const stats = {
  providerLists: 0,
  turns: 0,
  resumeIds: [],
  models: [],
  promptBytes: [],
  usedSkillsDir: false,
  hadSid: false,
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
process.stderr.on("error", () => {});

/**
 * Node's `process.exit` does NOT wait for piped stdout to drain — a fixture
 * that writes then `process.exit(0)`s can lose buffered output (and the
 * watchdog then sees no clean exit) when its stdout is a pipe (which it is via
 * the watchdog). This waits for the write callback / drain before exiting.
 */
function flushThenExit(code) {
  const done = () => {
    try {
      process.exit(code);
    } catch {
      // already tearing down
    }
  };
  try {
    const flushed = process.stdout.write("", () => {
      // Give the pipe a tick to flush the final bytes, then exit.
      setTimeout(done, 5);
    });
    if (!flushed) {
      process.stdout.once("drain", () => setTimeout(done, 5));
    }
  } catch {
    done();
  }
  // Safety net so the fixture never hangs if no drain event arrives.
  setTimeout(done, 200).unref();
}

function send(frame) {
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // stdout is gone; the process is being torn down anyway.
  }
}

function parseArgv(argv) {
  const out = { sid: null, model: null, prompt: null, outputFormat: null, skillsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-S" || a === "--session") {
      out.sid = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "-m" || a === "--model") {
      out.model = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "-p" || a === "--prompt") {
      out.prompt = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--output-format") {
      out.outputFormat = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--skills-dir") {
      out.skillsDir = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function providerList(config) {
  stats.providerLists += 1;
  writeStats(config);
  if (config.providerHang) {
    // Simulate an OAuth-interactive hang: stay alive forever, never exit, never
    // write the default line. The driver's probe deadline (F5) must fire.
    return new Promise(() => {
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => {});
    });
  }
  if (config.providerExit !== 0) {
    process.stderr.write(`error: provider list exited (code ${config.providerExit})\n`);
    flushThenExit(config.providerExit);
    return;
  }
  process.stdout.write("managed:kimi-code  type=kimi  models=3  source=oauth\n");
  process.stdout.write(`\nDefault model: ${config.providerDefault}\n`);
  flushThenExit(0);
}

async function runTurn(config, parsed) {
  stats.turns += 1;
  stats.hadSid = parsed.sid !== null;
  if (parsed.sid) stats.resumeIds.push(parsed.sid);
  if (parsed.model) stats.models.push(parsed.model);
  if (parsed.prompt !== null) stats.promptBytes.push(Buffer.byteLength(parsed.prompt, "utf8"));
  stats.usedSkillsDir = parsed.skillsDir !== null;
  writeStats(config);

  if (config.hang) {
    // Emit nothing and never exit: the upstream idle/turn timer fires. Stay
    // alive by waiting on stdin (like the real prompt-mode CLI holds open its
    // stdin) so Node does not auto-exit an idle event loop.
    return new Promise(() => {
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => {});
    });
  }

  if (config.resumeMiss && parsed.sid !== null) {
    process.stderr.write(`error: failed to run prompt: Session "${parsed.sid}" not found.\n`);
    flushThenExit(1);
    return;
  }

  if (config.delayMs > 0) await sleep(config.delayMs);

  if (config.toolTurn) {
    // A tooled turn (E10): assistant tool_calls frame → role:"tool" frame → a
    // bare non-JSON tool-stdout line → final assistant content frame. The
    // driver records tool activity (tool_calls + role:"tool") + off-protocol,
    // and maps the terminal toolState to "completed".
    send({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", name: "read_file", args: { path: "/tmp/x" } },
      ],
    });
    send({ role: "tool", tool_call_id: "call_1", content: "file contents here" });
    process.stdout.write("THIS IS A BARE TOOL STDOUT LINE (not json)\n");
  } else if (config.badJson) {
    process.stdout.write("{not valid json\n");
  }

  if (!config.noAssistant) {
    const content = config.emptyAssistant ? "" : config.reply;
    send({ role: "assistant", content });
  }

  if (config.crashAfterAssistant) {
    flushThenExit(3);
    return;
  }

  if (!config.noResumeHint) {
    // Resume turn: optionally diverge the session id (protocol break).
    const sid =
      parsed.sid && config.rotateSessionId
        ? "session-fake-diverged"
        : config.sessionId;
    send({
      role: "meta",
      type: "session.resume_hint",
      session_id: sid,
      command: `kimi -r ${sid}`,
      content: `To resume this session: kimi -r ${sid}`,
    });
  }

  // F2: optionally hold stdout open for a few ms after the frames are written
  // before closing — emulates a process whose exit control frame lands before
  // the stdout pipe drains, exercising the driver's exit/stdout-drain ordering.
  if (config.delayExitStdoutMs > 0) {
    await sleep(config.delayExitStdoutMs);
  }

  flushThenExit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const config = readConfig();

  if (config.ignoreSigterm) {
    process.on("SIGTERM", () => {
      // Swallow SIGTERM: forces the watchdog/host SIGKILL escalation path.
    });
  }

  // `provider list` subcommand (prewarm probe).
  if (argv[0] === "provider" && argv[1] === "list") {
    await providerList(config);
    return;
  }

  // Prompt mode.
  const parsed = parseArgv(argv);
  await runTurn(config, parsed);
}

main().catch(() => process.exit(1));