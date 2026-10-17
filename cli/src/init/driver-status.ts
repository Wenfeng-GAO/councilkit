/**
 * Per-driver first-run status for `councilkit init` (#374, #371).
 *
 * Version and login probes are best-effort and never throw. Login is checked
 * only when it cannot start a sign-in: a known status subcommand, a credential
 * file's presence (the file is not read), or `CURSOR_API_KEY`. `cfuse auth
 * status` is not called — that subcommand does not report status and can hang.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../auto/driver-commands";

export type LoginState = "logged-in" | "logged-out" | "unknown";

export interface DriverStatus {
  driver: string;
  found: boolean;
  path: string | null;
  version: string | null;
  login: LoginState;
  /** One sentence with the exact command, when the driver is missing or logged out. */
  next: string | null;
  /** `cld` only: `cfuse-claude-code` or `cfuse-claude` path used as `CLD_CFUSE_BIN`. */
  backendPath?: string | null;
}

const PROBE_TIMEOUT_MS = 2_000;

/** `cld` is not published by this repo. The binary name on PATH must be `cld`. */
export const CLD_INSTALL_NEXT =
  "Install the cld CLI so an executable named `cld` is on PATH, then run `cld login`. cfuse is a route of cld (with ant, moonshot, and deepseek); that route runs `cfuse-claude-code` via CLD_CFUSE_BIN, and a binary named `cfuse-claude` is accepted as that backend.";

export const CODEX_INSTALL_NEXT =
  "Install the Codex CLI with `npm install -g @openai/codex` so `codex` is on PATH, then run `codex login`.";

export const KIMI_INSTALL_NEXT =
  "Install the kimi CLI so `kimi` is on PATH (also checked in ~/.kimi-code/bin), then run `kimi login`.";

export const GROK_INSTALL_NEXT =
  "Install the grok CLI so `grok` is on PATH (also checked in ~/.grok/bin), then run `grok login`.";

export const CURSOR_INSTALL_NEXT =
  "Install cursor-agent with `curl https://cursor.com/install -fsS | bash` so `cursor-agent` is on PATH, then run `cursor-agent login` (or set CURSOR_API_KEY).";

export const CFUSE_INSTALL_NEXT =
  'Install the standalone cfuse CLI so `cfuse` is on PATH. `councilkit init` uses it as the review-security seat (`cfuse -p "…" --output-format text --skip-update`) when `cld` is absent.';

const LOGIN_NEXT: Record<string, string> = {
  cld: "Run `cld login`.",
  codex: "Run `codex login`.",
  kimi: "Run `kimi login`.",
  grok: "Run `grok login`.",
  "cursor-agent": "Run `cursor-agent login` (or set CURSOR_API_KEY).",
};

const INSTALL_NEXT: Record<string, string> = {
  cld: CLD_INSTALL_NEXT,
  cfuse: CFUSE_INSTALL_NEXT,
  codex: CODEX_INSTALL_NEXT,
  kimi: KIMI_INSTALL_NEXT,
  grok: GROK_INSTALL_NEXT,
  "cursor-agent": CURSOR_INSTALL_NEXT,
};

/** Seat executables, in the order `init` prints them. */
export const KNOWN_DRIVER_NAMES = [
  "cld",
  "cfuse",
  "kimi",
  "grok",
  "cursor-agent",
  "codex",
] as const;

export type KnownDriverName = (typeof KNOWN_DRIVER_NAMES)[number];

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  return home && home.length > 0 ? home : homedir();
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function runProbe(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number | null; stdout: string; timedOut: boolean } {
  try {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timedOut =
      (result.error !== undefined &&
        (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ||
      result.signal === "SIGTERM";
    const stdout = typeof result.stdout === "string" ? result.stdout.slice(0, 500) : "";
    return { code: result.status, stdout, timedOut };
  } catch {
    return { code: null, stdout: "", timedOut: false };
  }
}

function cheapVersion(executable: string, env: NodeJS.ProcessEnv): string | null {
  const probe = runProbe(executable, ["--version"], env);
  if (probe.timedOut) return null;
  const line =
    probe.stdout
      .split("\n")
      .find((row) => row.trim().length > 0)
      ?.trim() ?? "";
  if (line.length === 0 || line.length > 120) return null;
  if (line.includes("Error:") || /^\s+at /.test(line)) return null;
  return line;
}

function classifyStatusOutput(stdout: string, code: number | null, timedOut: boolean): LoginState {
  if (timedOut || code === null) return "unknown";
  const text = stdout.toLowerCase();
  if (text.includes("not logged in") || text.includes("not logged-in")) return "logged-out";
  if (code === 0 && (text.includes("logged in") || text.includes("logged-in"))) return "logged-in";
  if (code !== 0) return "logged-out";
  return "unknown";
}

function loginFor(driver: KnownDriverName, executable: string, env: NodeJS.ProcessEnv): LoginState {
  const home = homeOf(env);
  if (driver === "grok") {
    const grokHome = env.GROK_HOME?.trim() || join(home, ".grok");
    return pathExists(join(grokHome, "auth.json")) ? "logged-in" : "logged-out";
  }
  if (driver === "kimi") {
    return pathExists(join(home, ".kimi-code", "credentials")) ? "logged-in" : "logged-out";
  }
  if (driver === "cld") {
    const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    return pathExists(join(configHome, "cld", "env")) ? "logged-in" : "unknown";
  }
  if (driver === "cfuse") return "unknown";
  if (driver === "cursor-agent" && (env.CURSOR_API_KEY?.trim().length ?? 0) > 0) return "logged-in";
  if (driver === "codex") {
    const probe = runProbe(executable, ["login", "status"], env);
    return classifyStatusOutput(probe.stdout, probe.code, probe.timedOut);
  }
  if (driver === "cursor-agent") {
    const probe = runProbe(executable, ["status"], env);
    return classifyStatusOutput(probe.stdout, probe.code, probe.timedOut);
  }
  return "unknown";
}

function backendExecutable(env: NodeJS.ProcessEnv): { name: string; path: string } | null {
  const code = findExecutable("cfuse-claude-code", env);
  if (code !== null) return { name: "cfuse-claude-code", path: code };
  const alias = findExecutable("cfuse-claude", env);
  if (alias !== null) return { name: "cfuse-claude", path: alias };
  return null;
}

function nextFor(input: {
  driver: KnownDriverName;
  found: boolean;
  login: LoginState;
  cldFound: boolean;
  standalone: { path: string } | null;
  backend: { name: string; path: string } | null;
}): string | null {
  const { driver, found, login, cldFound, standalone, backend } = input;
  if (!found) {
    if (driver === "cld" && backend !== null && standalone === null) {
      return `Found \`${backend.name}\` at ${backend.path}, but cld is required to use it. ${CLD_INSTALL_NEXT}`;
    }
    if (driver === "cld" && standalone !== null) {
      return `Standalone cfuse was found at ${standalone.path} and is used as the review-security seat (\`cfuse -p "…" --output-format text --skip-update\`). cld is not installed, so the cld routes are unavailable. ${CLD_INSTALL_NEXT}`;
    }
    // Standalone cfuse is an alternate for the security seat, not a second
    // required CLI, once `cld` or a cld backend binary is already present.
    if (driver === "cfuse" && (cldFound || backend !== null)) return null;
    return INSTALL_NEXT[driver] ?? null;
  }
  if (login === "logged-out") return LOGIN_NEXT[driver] ?? null;
  if (driver === "cld" && backend === null && standalone === null) {
    return "cld is installed, but the cfuse route backend was not found. Put `cfuse-claude-code` (or `cfuse-claude`) on PATH; CouncilKit sets CLD_CFUSE_BIN to that binary.";
  }
  return null;
}

export function collectDriverStatus(env: NodeJS.ProcessEnv = process.env): DriverStatus[] {
  let backend: { name: string; path: string } | null = null;
  let standalonePath: string | null = null;
  try {
    backend = backendExecutable(env);
    standalonePath = findExecutable("cfuse", env);
  } catch {
    backend = null;
    standalonePath = null;
  }
  const standalone = standalonePath === null ? null : { path: standalonePath };
  let cldFound = false;
  try {
    cldFound = findExecutable("cld", env) !== null;
  } catch {
    cldFound = false;
  }
  return KNOWN_DRIVER_NAMES.map((driver) => {
    let path: string | null = null;
    try {
      path = findExecutable(driver, env);
    } catch {
      path = null;
    }
    if (path === null) {
      return {
        driver,
        found: false,
        path: null,
        version: null,
        login: "unknown" as const,
        next: nextFor({
          driver,
          found: false,
          login: "unknown",
          cldFound,
          standalone,
          backend,
        }),
        ...(driver === "cld" ? { backendPath: backend?.path ?? null } : {}),
      };
    }
    let version: string | null = null;
    let login: LoginState = "unknown";
    try {
      version = cheapVersion(path, env);
      login = loginFor(driver, path, env);
    } catch {
      version = null;
      login = "unknown";
    }
    return {
      driver,
      found: true,
      path,
      version,
      login,
      next: nextFor({ driver, found: true, login, cldFound, standalone, backend }),
      ...(driver === "cld" ? { backendPath: backend?.path ?? null } : {}),
    };
  });
}

export function driverStatusByName(
  rows: readonly DriverStatus[],
  name: KnownDriverName,
): DriverStatus {
  const row = rows.find((item) => item.driver === name);
  if (row === undefined) {
    return { driver: name, found: false, path: null, version: null, login: "unknown", next: null };
  }
  return row;
}
