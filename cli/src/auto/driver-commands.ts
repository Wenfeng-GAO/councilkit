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

/** Extract the final delivered text from a completed subprocess. Returns null
 * when no valid final output is present (the caller treats that as an Attempt
 * failure). Non-JSON / unrecognized lines are skipped, never thrown on. */
export function extractFinalOutput(
  driverId: string,
  stdout: string,
  lastMessageFile?: string,
): string | null {
  switch (driverId) {
    case "claude-stream-json":
      return extractClaude(stdout);
    case "kimi-stream-json":
      return extractKimi(stdout);
    case "codex-app-server":
      return extractCodex(stdout, lastMessageFile);
    default:
      return null;
  }
}

/** Last `{"type":"result"}` with subtype "success" and is_error != true →
 * `.result`. */
function extractClaude(stdout: string): string | null {
  let last: string | null = null;
  for (const line of splitLines(stdout)) {
    const obj = parseJsonLine(line);
    if (obj === null) continue;
    if (obj.type !== "result") continue;
    if (obj.subtype !== "success") continue;
    if (obj.is_error === true) continue;
    last = asText(obj.result);
  }
  return last;
}

/** Last `{"role":"assistant"}` object's `.content`; `role:"meta"` resume lines
 * are skipped. */
function extractKimi(stdout: string): string | null {
  let last: string | null = null;
  for (const line of splitLines(stdout)) {
    const obj = parseJsonLine(line);
    if (obj === null) continue;
    if (obj.role !== "assistant") continue;
    const text = asText(obj.content);
    if (text !== null) last = text;
  }
  return last;
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
