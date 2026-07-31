/**
 * Driver → spawn spec construction + final-output extraction (DESIGN §2, plan
 * §"三个 driver 的 spawn 规格"). Every driver is invoked as a fully-autonomous
 * single-shot subprocess; the CLI resolves the executable by PATH (fail-fast
 * before any spawn) and never goes through the Runtime Host.
 *
 * Flag shapes are taken from `evidence/flag-facts.md` (measured), not memory:
 *  - claude (cld): only the `cfuse` route is supported; non-cfuse → usage.
 *    prompt → stdin; extract last `{"type":"result"}` (subtype "success",
 *    is_error != true) `.result`.
 *  - kimi: `kimi -m <modelId> -p <prompt> --output-format stream-json` (no
 *    --auto/-y; full autonomy comes from config). prompt → argv. Extract last
 *    `{"role":"assistant"}.content`, skipping `role:"meta"` resume lines.
 *  - codex: `codex exec -s workspace-write --dangerously-bypass-approvals-and-sandbox
 *    --skip-git-repo-check -m <modelId> -o <workspace>/.last-message.md -`.
 *    prompt → stdin; read the last-message file, fall back to stdout.
 */
import { Buffer } from "node:buffer";
import { constants, accessSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { errors } from "../errors";
import type { AgentRecord } from "../store/schemas";

/** Fully-resolved, ready-to-spawn description of one Attempt (or the Aggregator
 * spawn, which reuses the same shape). `argv` is the complete arg list — for
 * kimi it already embeds the prompt (argv delivery); for claude/codex the prompt
 * is delivered via stdin (`promptStdin`). */
export interface AttemptSpec {
  attemptId: string;
  agentId: string;
  agentName: string;
  driverId: string;
  modelId: string;
  /** PATH-resolved absolute executable path (never a bare name). */
  executable: string;
  /** Complete argv (excludes the executable itself). */
  argv: string[];
  /** Raw prompt text; written to stdin when `promptStdin`. */
  prompt: string;
  promptStdin: boolean;
  /** Isolated working directory for this subprocess. */
  cwd: string;
  /** codex: path to the `-o` last-message file (also read for extraction). */
  lastMessageFile?: string;
}

const EXECUTABLE_BY_DRIVER: Record<string, string> = {
  "claude-stream-json": "cld",
  "kimi-stream-json": "kimi",
  "codex-app-server": "codex",
};

/** Resolve a bare executable name against PATH (X_OK regular file), or verify an
 * absolute/relative path directly. Throws a usage error (exit 2) when not found
 * so the command fails fast before spawning anything. Never shells out. */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (name.length === 0) throw errors.usage("missing executable for driver");
  if (name.includes("/")) {
    const abs = resolve(process.cwd(), name);
    if (isExecutableFile(abs)) return abs;
    throw errors.usage(`executable "${name}" not found or not executable`);
  }
  const pathDirs = (env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    // Empty PATH entries are the current directory by POSIX semantics; `resolve`
    // also absolutizes relative PATH entries so we never hand a relative
    // executable path to the spawner.
    const candidate = resolve(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw errors.usage(`executable "${name}" not found on PATH (review needs it installed)`);
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Conservative upper bound for argv delivery (kimi prompt-in-argv). Modern
 * macOS ARG_MAX is ~1 MiB; staying well under this avoids an kernel E2BIG. */
const ARGV_MAX = 1024 * 1024;

/** Reject an argv that would blow ARG_MAX with a usage error (exit 2) rather than
 * letting the spawn fail with an opaque system error. */
function assertArgvSafe(argv: string[]): void {
  const total = argv.reduce((n, a) => n + Buffer.byteLength(a, "utf8") + 1, 0);
  if (total > ARGV_MAX) {
    throw errors.usage(
      `aggregate prompt too large for argv delivery (~${total} bytes > ${ARGV_MAX}); reduce attempt count or per-attempt output size`,
    );
  }
}

/** The fixed minimal probe prompt (P1-1). Asking for an exact "ok" keeps the
 * probe output tiny; success is judged on the process succeeding with ANY
 * non-empty final output, so an extra punctuation mark never flips a healthy
 * backend to unreachable. */
export const DRIVER_PROBE_PROMPT = "Reply with exactly: ok";

interface DriverInvocation {
  argv: string[];
  promptStdin: boolean;
  lastMessageFile?: string;
}

/** Shared argv builder for the review spawn AND the health probe. The two share
 * the executable, route/model handling, prompt delivery channel and output
 * format — but the probe never inherits review-specific permission flags
 * (claude `--dangerously-skip-permissions`, codex sandbox/bypass/`-o`), so a
 * probe exercises the driver backend, not the review's escalation path. */
function buildInvocation(
  agent: AgentRecord,
  opts: { prompt: string; workspace?: string; probe: boolean },
): DriverInvocation {
  const sel = agent.driverSelection;
  const driverId = sel.driverId;
  const { prompt } = opts;
  switch (driverId) {
    case "claude-stream-json": {
      if (sel.options.route !== "cfuse") {
        throw errors.usage(
          `review only supports the cfuse route for claude-stream-json (got "${sel.options.route}")`,
        );
      }
      const argv = ["cfuse", "--print", "--verbose", "--output-format", "stream-json"];
      if (!opts.probe) argv.push("--dangerously-skip-permissions");
      return { argv, promptStdin: true };
    }
    case "kimi-stream-json": {
      // No --auto/-y (mutually exclusive with -p); config provides full autonomy.
      // Prompt is delivered as an argv element — guard its total length so a
      // budget breach surfaces as a readable usage error instead of an E2BIG
      // crash from the kernel.
      const argv = ["-m", agent.modelId, "-p", prompt, "--output-format", "stream-json"];
      assertArgvSafe(argv);
      return { argv, promptStdin: false };
    }
    case "codex-app-server": {
      if (opts.probe) {
        return {
          argv: ["exec", "--skip-git-repo-check", "-m", agent.modelId, "--json", "-"],
          promptStdin: true,
        };
      }
      const workspace = opts.workspace as string;
      const lastMessageFile = join(workspace, ".last-message.md");
      // `--json` makes stdout JSONL (`item.*` events) so the activity collector
      // can see tool calls; `-o` still carries the final message, so the final
      // deliverable does not depend on parsing the event stream.
      return {
        argv: [
          "exec",
          "-s",
          "workspace-write",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--json",
          "-m",
          agent.modelId,
          "-o",
          lastMessageFile,
          "-",
        ],
        promptStdin: true,
        lastMessageFile,
      };
    }
    default: {
      throw errors.usage(`unsupported driver "${driverId}" for review`);
    }
  }
}

/** Build a complete AttemptSpec for an agent + prompt. Fails fast with a usage
 * error on: unknown driver, claude non-cfuse route, or missing executable. */
export function buildSpawnSpec(
  agent: AgentRecord,
  opts: { attemptId: string; workspace: string; prompt: string; env?: NodeJS.ProcessEnv },
): AttemptSpec {
  const { attemptId, workspace, prompt } = opts;
  const env = opts.env ?? process.env;
  const driverId = agent.driverSelection.driverId;
  const exeName = EXECUTABLE_BY_DRIVER[driverId];
  if (exeName === undefined) {
    throw errors.usage(`unsupported driver "${driverId}" for review`);
  }
  const executable = resolveExecutable(exeName, env);
  const invocation = buildInvocation(agent, { prompt, workspace, probe: false });
  return {
    attemptId,
    agentId: agent.id,
    agentName: agent.name,
    driverId,
    modelId: agent.modelId,
    executable,
    cwd: workspace,
    prompt,
    ...invocation,
  };
}

/** Build a minimal health-probe spec for a driver (P1-1): same executable,
 * route/model and prompt delivery as the review spawn, but without the
 * review-only permission flags and without a workspace (`cwd` is the caller's
 * own working directory — no review directory is created for a probe). */
export function buildProbeSpec(
  agent: AgentRecord,
  opts: { probeId: string; cwd: string; prompt: string; env?: NodeJS.ProcessEnv },
): AttemptSpec {
  const { probeId, cwd, prompt } = opts;
  const env = opts.env ?? process.env;
  const driverId = agent.driverSelection.driverId;
  const exeName = EXECUTABLE_BY_DRIVER[driverId];
  if (exeName === undefined) {
    throw errors.usage(`unsupported driver "${driverId}" for review`);
  }
  const executable = resolveExecutable(exeName, env);
  const invocation = buildInvocation(agent, { prompt, probe: true });
  return {
    attemptId: probeId,
    agentId: agent.id,
    agentName: agent.name,
    driverId,
    modelId: agent.modelId,
    executable,
    cwd,
    prompt,
    ...invocation,
  };
}

/** Upper bound on a single final-event line retained by `FinalEventLineCollector`.
 * Generous vs the stdout head+tail cap so a large single-event NDJSON line (the
 * common claude `{"type":"result"}` / kimi `{"role":"assistant"}` delivery) is
 * captured whole instead of being split across the head/tail boundary. */
export const FINAL_EVENT_LINE_CAP = 16 * 1024 * 1024;

/** Extract the final delivered text from a completed subprocess. Returns null
 * when no valid final output is present (the caller treats that as an Attempt
 * failure). Non-JSON / unrecognized lines are skipped, never thrown on.
 *
 * `capturedFinalLine`, when present, is a complete final-event line captured by
 * `FinalEventLineCollector` during streaming — it bypasses the stdout head+tail
 * cap so a single oversized final event is not destroyed at the truncation
 * boundary (reviewer finding: head+tail split made both halves invalid JSON →
 * spurious NO_OUTPUT). */
export function extractFinalOutput(
  driverId: string,
  stdout: string,
  lastMessageFile?: string,
  capturedFinalLine?: string | null,
): string | null {
  switch (driverId) {
    case "claude-stream-json":
      if (capturedFinalLine !== undefined && capturedFinalLine !== null) {
        // A captured line that yields no usable text (error subtype, non-string
        // result) must NOT shadow the stream: fall back to scanning stdout —
        // otherwise a trailing unusable event flips a good run to NO_OUTPUT
        // (reviewer finding).
        return extractClaudeLine(capturedFinalLine) ?? extractClaude(stdout);
      }
      return extractClaude(stdout);
    case "kimi-stream-json":
      if (capturedFinalLine !== undefined && capturedFinalLine !== null) {
        return extractKimiLine(capturedFinalLine) ?? extractKimi(stdout);
      }
      return extractKimi(stdout);
    case "codex-app-server":
      return extractCodex(stdout, lastMessageFile);
    default:
      return null;
  }
}

/** Streaming line scanner retained by `defaultSpawn`. Holds the last complete
 * final-event line emitted by claude (`{"type":"result"}`) or kimi
 * (`{"role":"assistant"}`) without imposing the stdout head+tail cap, so the
 * final deliverable — which lives at the end of the stream — survives even when
 * it alone exceeds the cap. A single line longer than `lineCap` is dropped
 * (unrecoverable) and the in-flight buffer is bounded so memory never grows
 * unbounded on a runaway line. */
export class FinalEventLineCollector {
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");
  /** True while dropping the remainder of an over-cap physical line: after an
   * overflow, everything up to the next newline is the SAME line and must not
   * be parsed as a fresh event (reviewer finding). */
  private discarding = false;
  lastLine: string | null = null;

  constructor(
    private readonly driverId: string,
    private readonly lineCap: number = FINAL_EVENT_LINE_CAP,
  ) {}

  feed(chunk: Buffer): void {
    // Incremental UTF-8 decode: decoding each chunk independently with
    // toString("utf8") replaces a multi-byte character split across chunks with
    // U+FFFD, corrupting capturedFinalLine. StringDecoder buffers the incomplete
    // trailing bytes until the next chunk completes the character (reviewer
    // finding: cross-chunk multibyte corruption of the captured final line).
    this.buf += this.decoder.write(chunk);
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (this.discarding) {
        // The newline ends the over-cap physical line — resume parsing.
        this.discarding = false;
      } else {
        this.consider(line);
      }
      idx = this.buf.indexOf("\n");
    }
    // A single line longer than the cap with no newline yet is unrecoverable;
    // drop the buffered prefix (memory bound) and mark the rest of this
    // physical line for discarding — its tail must not be parsed as a new line.
    if (this.buf.length > this.lineCap) {
      this.buf = "";
      this.discarding = true;
    }
  }

  /** Flush the trailing bytes at EOF: the final NDJSON line may not end with a
   * newline. Without this, `lastLine` stays on an earlier assistant message and
   * the final deliverable is silently replaced by an older reply. */
  end(): void {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (this.discarding) {
      // EOF inside an over-cap physical line: its tail is not an event.
      this.discarding = false;
      return;
    }
    if (rest.length > 0 && rest.length <= this.lineCap) {
      this.consider(rest);
    }
  }

  private consider(line: string): void {
    if (line.length === 0 || line.length > this.lineCap) return;
    const obj = parseJsonLine(line);
    if (obj === null) return;
    // Only retain a line that yields USABLE text. A structurally-matching but
    // unusable event (claude error subtype, kimi assistant without text) must
    // not overwrite an earlier usable one — the stream's middle may be
    // truncated away by the stdout cap, leaving nothing to fall back to
    // (reviewer finding).
    if (this.driverId === "claude-stream-json" && obj.type === "result") {
      if (extractClaudeLine(line) !== null) this.lastLine = line;
    } else if (this.driverId === "kimi-stream-json" && obj.role === "assistant") {
      if (extractKimiLine(line) !== null) this.lastLine = line;
    }
  }
}

/** Last `{"type":"result"}` with subtype "success" and is_error != true →
 * `.result`. */
function extractClaude(stdout: string): string | null {
  let last: string | null = null;
  for (const line of splitLines(stdout)) {
    last = extractClaudeLine(line) ?? last;
  }
  return last;
}

/** Extract `.result` from a single captured claude result line (null if the line
 * is not a success result). */
function extractClaudeLine(line: string): string | null {
  const obj = parseJsonLine(line);
  if (obj === null) return null;
  if (obj.type !== "result") return null;
  if (obj.subtype !== "success") return null;
  if (obj.is_error === true) return null;
  return asText(obj.result);
}

/** Last `{"role":"assistant"}` object's `.content`; `role:"meta"` resume lines
 * are skipped. */
function extractKimi(stdout: string): string | null {
  let last: string | null = null;
  for (const line of splitLines(stdout)) {
    const text = extractKimiLine(line);
    if (text !== null) last = text;
  }
  return last;
}

/** Extract `.content` from a single captured kimi assistant line (null if the
 * line is not an assistant message or has no text). */
function extractKimiLine(line: string): string | null {
  const obj = parseJsonLine(line);
  if (obj === null) return null;
  if (obj.role !== "assistant") return null;
  return asText(obj.content);
}

/** codex: prefer the `-o` last-message file; fall back to the last
 * `item.completed` agent_message in the `--json` stdout event stream. Both must
 * be non-empty (after trim) to count. There is NO raw-stdout fallback: codex is
 * always invoked with `--json`, so stdout is a JSONL event stream and protocol
 * events (thread.started, turn.completed, …) are NEVER a deliverable — when no
 * agent_message exists and the `-o` file is missing/empty, the run produced no
 * output (NO_OUTPUT), not a stream dump (reviewer finding). */
function extractCodex(stdout: string, lastMessageFile?: string): string | null {
  if (lastMessageFile !== undefined) {
    const text = readFileTrimmed(lastMessageFile);
    if (text !== null) return text;
  }
  return extractCodexAgentMessage(stdout);
}

/** Last `{"type":"item.completed","item":{"type":"agent_message","text":…}}`
 * text in a codex `--json` event stream; null when no such event is present. */
function extractCodexAgentMessage(stdout: string): string | null {
  let last: string | null = null;
  for (const line of splitLines(stdout)) {
    const obj = parseJsonLine(line);
    if (obj === null) continue;
    if (obj.type !== "item.completed") continue;
    const item = obj.item as { type?: unknown; text?: unknown } | undefined;
    if (item?.type !== "agent_message") continue;
    const text = asText(item.text);
    if (text !== null) last = text;
  }
  return last;
}

function readFileTrimmed(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function splitLines(s: string): string[] {
  return s.split("\n").filter((l) => l.trim().length > 0);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce a stream-json content field (string OR array of content blocks) to a
 * single string. Null/empty → null. */
function asText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const parts = value
      .map((b) =>
        typeof b === "string"
          ? b
          : ((b as { text?: string })?.text ?? (b as { content?: string })?.content ?? ""),
      )
      .filter((p) => p.length > 0);
    const joined = parts.join("\n");
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/** Per-Attempt process summary (P2-1): how many tool calls the driver made and
 * a bounded sample of the shell commands it ran. Optional everywhere — `undefined`
 * means "no process data" (unrecognized stream), never an error. */
export interface AttemptActivity {
  toolCalls: number;
  commands: string[];
  /** True when at least one command had a proxy env prefix stripped at
   * collection time (drives the「已省略代理前缀」note in the report). */
  strippedProxy?: boolean;
}

/** One proxy env prefix to strip (case-insensitive). A command may carry several
 * consecutive prefixes (`NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' <cmd>`); all
 * leading prefixes are removed. The value MUST be quoted — an unquoted value
 * containing escaped spaces or command substitution would be partially stripped
 * and leave command fragments behind (reviewer finding); those commands are
 * left untouched instead. */
const PROXY_ENV_RE =
  /^(?:NO_PROXY|no_proxy|HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy)=(?:'[^']*'|"(?:[^"\\]|\\.)*")[ \t]+/;

/** Strip leading proxy env prefixes. Standalone assignments and prefixes
 * followed by a shell operator are NOT stripped (they are separate statements,
 * not prefixes — reviewer findings). Exported for the report renderer. */
export function stripProxyPrefix(cmd: string): { text: string; stripped: boolean } {
  let stripped = false;
  let cur = cmd;
  for (;;) {
    const next = cur.replace(PROXY_ENV_RE, "");
    if (next === cur || next.trim().length === 0) break;
    // Chained assignments separated by an operator (`A='1' B='2' && cmd`) are
    // statements, not a prefix. If an operator shows up after ANY stripping,
    // the whole chain was statement-like — revert to the original untouched
    // (reviewer finding: checking only the final remainder let `A B && cmd`
    // lose the first assignment).
    if (/^[;&|><]/.test(next.trimStart())) {
      return { text: cmd, stripped: false };
    }
    cur = next;
    stripped = true;
  }
  // The remainder is ENTIRELY assignments with no command (`NO_PROXY='1'
  // HTTPS_PROXY='2'`, or `FOO='1' BAR=2`): there was never a command to
  // prefix — revert. A remainder of `FOO='1' antcode …` (env prefix + real
  // command) is NOT caught by this: it contains a non-assignment token
  // (reviewer finding: the starts-with-assignment check reverted those too).
  if (
    stripped &&
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S*)\s*)+$/.test(cur)
  ) {
    return { text: cmd, stripped: false };
  }
  // The remainder starts with an assignment AND contains a shell operator
  // (`NO_PROXY='*' FOO='1' && cmd`): the assignments formed a statement chain,
  // not a prefix — revert. `FOO='1' antcode …` (no operator) and
  // `antcode … && echo` (no leading assignment) stay stripped. The operator
  // scan is quote-aware so `FOO='a|b' cmd` is not a false positive (reviewer
  // findings).
  if (stripped && /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(cur) && hasShellOperatorOutsideQuotes(cur)) {
    return { text: cmd, stripped: false };
  }
  return { text: cur, stripped };
}

/** True when a shell operator (`;`, `|`, `&`, `<`, `>`, including `&&`/`||`)
 * appears OUTSIDE single/double quotes. */
function hasShellOperatorOutsideQuotes(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && (ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">")) {
      return true;
    }
  }
  return false;
}

/** Upper bound on retained representative commands per Attempt. */
const ACTIVITY_MAX_COMMANDS = 10;
/** claude tool names whose `input.command`/`input.cmd` counts as a
 * representative shell command (lowercase). */
const SHELL_TOOL_NAMES = new Set(["bash", "shell"]);
/** Upper bound (Unicode code points) on a single retained command. */
const ACTIVITY_COMMAND_MAX_CHARS = 80;
/** Bound on one buffered physical line; longer lines are dropped (the collector
 * is a best-effort observer and must never grow memory without bound). */
const ACTIVITY_LINE_CAP = 16 * 1024 * 1024;

/** Incremental stream-json process observer (P2-1). Fed with raw stdout chunks
 * as they arrive, it decodes UTF-8 across chunk boundaries (StringDecoder),
 * parses JSONL line-by-line and counts tool-call events per driver:
 *  - claude: `type:"assistant"` messages — each `tool_use` content block counts
 *    (stream_event deltas are ignored so one call is never counted twice);
 *    commands come from Bash/Shell-named tools' `input.command`/`input.cmd`.
 *  - kimi: `role:"assistant"` messages — each `tool_calls[]` entry counts
 *    (`role:"tool"` results are not calls); commands come from
 *    `args.command/cmd`, including a JSON-string `function.arguments`.
 *  - codex: `item.completed` events of a known tool type (`command_execution`,
 *    `mcp_tool_call`, `web_search`); `item.started` is ignored to avoid
 *    started/completed double counting; commands come from `item.command`.
 * Non-JSON decoration lines are ignored, never fatal. `summary()` returns
 * `undefined` when no KNOWN event shape was seen (claude assistant/result,
 * kimi assistant/tool/meta, codex item.*) — an arbitrary JSON object with a
 * type/role field does not count as recognized, so an unknown format reports
 * "无过程数据" instead of a confident empty summary (reviewer finding). A
 * recognized stream without tool calls yields `{ toolCalls: 0, commands: [] }`. */
export class DriverActivityCollector {
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");
  private discarding = false;
  private toolCalls = 0;
  private readonly commands: string[] = [];
  private sawEvent = false;
  private sawStrippedProxy = false;

  constructor(private readonly driverId: string) {}

  feed(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (this.discarding) {
        this.discarding = false;
      } else {
        this.consider(line);
      }
      idx = this.buf.indexOf("\n");
    }
    if (this.buf.length > ACTIVITY_LINE_CAP) {
      this.buf = "";
      this.discarding = true;
    }
  }

  /** Flush the trailing bytes at EOF (the last JSONL line may lack a newline).
   * Idempotent: the buffer is cleared, so a second call is a no-op. */
  end(): void {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    if (rest.length > 0 && rest.length <= ACTIVITY_LINE_CAP) {
      this.consider(rest);
    }
  }

  summary(): AttemptActivity | undefined {
    if (!this.sawEvent) return undefined;
    return {
      toolCalls: this.toolCalls,
      commands: [...this.commands],
      strippedProxy: this.sawStrippedProxy || undefined,
    };
  }

  private consider(line: string): void {
    const obj = parseJsonLine(line);
    if (obj === null) return;
    switch (this.driverId) {
      case "claude-stream-json":
        this.considerClaude(obj);
        return;
      case "kimi-stream-json":
        this.considerKimi(obj);
        return;
      case "codex-app-server":
        this.considerCodex(obj);
        return;
      default:
        return;
    }
  }

  private considerClaude(obj: Record<string, unknown>): void {
    // Only the known claude event shapes mark the stream as recognized — any
    // JSON object carrying a `type` field must NOT count (reviewer finding).
    if (obj.type !== "assistant" && obj.type !== "result") return;
    this.sawEvent = true;
    if (obj.type !== "assistant") return;
    const message = obj.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content) {
      const b = block as { type?: unknown; name?: unknown; input?: unknown } | null;
      if (b?.type !== "tool_use") continue;
      this.toolCalls++;
      // Representative commands come from Bash/Shell-style tools only; other
      // tools carrying an input.command field still COUNT as tool calls but
      // are not sampled as shell commands (reviewer finding).
      if (typeof b.name !== "string" || !SHELL_TOOL_NAMES.has(b.name.toLowerCase())) continue;
      const input = b.input as { command?: unknown; cmd?: unknown } | undefined;
      this.pushCommand(input?.command ?? input?.cmd);
    }
  }

  private considerKimi(obj: Record<string, unknown>): void {
    // Only the known kimi roles mark the stream as recognized.
    if (obj.role !== "assistant" && obj.role !== "tool" && obj.role !== "meta") return;
    this.sawEvent = true;
    if (obj.role !== "assistant") return;
    if (!Array.isArray(obj.tool_calls)) return;
    for (const call of obj.tool_calls) {
      const c = call as {
        args?: { command?: unknown; cmd?: unknown };
        function?: { arguments?: unknown };
      } | null;
      this.toolCalls++;
      let command: unknown = c?.args?.command ?? c?.args?.cmd;
      if (command === undefined && typeof c?.function?.arguments === "string") {
        const args = parseJsonLine(c.function.arguments) as {
          command?: unknown;
          cmd?: unknown;
        } | null;
        command = args?.command ?? args?.cmd;
      }
      this.pushCommand(command);
    }
  }

  private considerCodex(obj: Record<string, unknown>): void {
    // Only the known codex event shapes (`item.*`) mark the stream as
    // recognized — protocol events like thread.started / turn.completed must
    // NOT count (reviewer finding).
    if (typeof obj.type !== "string" || !obj.type.startsWith("item.")) return;
    this.sawEvent = true;
    if (obj.type !== "item.completed") return;
    const item = obj.item as { type?: unknown; command?: unknown } | undefined;
    if (
      item?.type !== "command_execution" &&
      item?.type !== "mcp_tool_call" &&
      item?.type !== "web_search"
    ) {
      return;
    }
    this.toolCalls++;
    this.pushCommand(item.command);
  }

  /** Fold whitespace, truncate to 80 code points, keep the first 10 in order.
   * `toolCalls` keeps counting past the command cap — the cap bounds memory,
   * not the measurement. Proxy env prefixes are stripped BEFORE truncation —
   * truncating first would let a long prefix eat the actual command (reviewer
   * finding); the flag is surfaced via `strippedProxy` on the summary. */
  private pushCommand(raw: unknown): void {
    if (typeof raw !== "string") return;
    // Trim leading whitespace BEFORE stripping: a quoted heredoc-style command
    // (`  NO_PROXY='*' antcode …`) is still prefix-shaped, and stripping must
    // happen before the 80-char cap or the prefix eats the real command
    // (reviewer findings).
    const { text, stripped } = stripProxyPrefix(raw.trimStart());
    if (stripped) this.sawStrippedProxy = true;
    const folded = text.replace(/\s+/g, " ").trim();
    if (folded.length === 0) return;
    if (this.commands.length >= ACTIVITY_MAX_COMMANDS) return;
    const chars = Array.from(folded);
    this.commands.push(
      chars.length > ACTIVITY_COMMAND_MAX_CHARS
        ? chars.slice(0, ACTIVITY_COMMAND_MAX_CHARS).join("")
        : folded,
    );
  }
}
