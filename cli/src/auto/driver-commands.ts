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

/** Build a complete AttemptSpec for an agent + prompt. Fails fast with a usage
 * error on: unknown driver, claude non-cfuse route, or missing executable. */
export function buildSpawnSpec(
  agent: AgentRecord,
  opts: { attemptId: string; workspace: string; prompt: string; env?: NodeJS.ProcessEnv },
): AttemptSpec {
  const { attemptId, workspace, prompt } = opts;
  const env = opts.env ?? process.env;
  const sel = agent.driverSelection;
  const driverId = sel.driverId;
  const exeName = EXECUTABLE_BY_DRIVER[driverId];
  if (exeName === undefined) {
    throw errors.usage(`unsupported driver "${driverId}" for review`);
  }
  const executable = resolveExecutable(exeName, env);
  const base = {
    attemptId,
    agentId: agent.id,
    agentName: agent.name,
    driverId,
    modelId: agent.modelId,
    executable,
    cwd: workspace,
    prompt,
  };

  switch (driverId) {
    case "claude-stream-json": {
      if (sel.options.route !== "cfuse") {
        throw errors.usage(
          `review only supports the cfuse route for claude-stream-json (got "${sel.options.route}")`,
        );
      }
      return {
        ...base,
        argv: [
          "cfuse",
          "--print",
          "--verbose",
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
        ],
        promptStdin: true,
      };
    }
    case "kimi-stream-json": {
      // No --auto/-y (mutually exclusive with -p); config provides full autonomy.
      // Prompt is delivered as an argv element — guard its total length so a
      // budget breach surfaces as a readable usage error instead of an E2BIG
      // crash from the kernel.
      const argv = ["-m", agent.modelId, "-p", prompt, "--output-format", "stream-json"];
      assertArgvSafe(argv);
      return {
        ...base,
        argv,
        promptStdin: false,
      };
    }
    case "codex-app-server": {
      const lastMessageFile = join(workspace, ".last-message.md");
      return {
        ...base,
        argv: [
          "exec",
          "-s",
          "workspace-write",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
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
        return extractClaudeLine(capturedFinalLine);
      }
      return extractClaude(stdout);
    case "kimi-stream-json":
      if (capturedFinalLine !== undefined && capturedFinalLine !== null) {
        return extractKimiLine(capturedFinalLine);
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
      this.consider(line);
      idx = this.buf.indexOf("\n");
    }
    // A single line longer than the cap with no newline yet is unrecoverable;
    // drop the buffered prefix so we never hold more than `lineCap` bytes.
    if (this.buf.length > this.lineCap) this.buf = "";
  }

  /** Flush the trailing bytes at EOF: the final NDJSON line may not end with a
   * newline. Without this, `lastLine` stays on an earlier assistant message and
   * the final deliverable is silently replaced by an older reply. */
  end(): void {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (rest.length > 0 && rest.length <= this.lineCap) {
      this.consider(rest);
    }
  }

  private consider(line: string): void {
    if (line.length === 0 || line.length > this.lineCap) return;
    const obj = parseJsonLine(line);
    if (obj === null) return;
    if (this.driverId === "claude-stream-json" && obj.type === "result") {
      this.lastLine = line;
    } else if (this.driverId === "kimi-stream-json" && obj.role === "assistant") {
      this.lastLine = line;
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

/** codex: prefer the `-o` last-message file; fall back to stdout. Both must be
 * non-empty (after trim) to count. */
function extractCodex(stdout: string, lastMessageFile?: string): string | null {
  if (lastMessageFile !== undefined) {
    const text = readFileTrimmed(lastMessageFile);
    if (text !== null) return text;
  }
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? stdout : null;
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
