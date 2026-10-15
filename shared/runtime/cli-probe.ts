/**
 * One readiness judgement for every seat CLI, shared by the Host (Settings
 * five-state rows, `councilkit doctor` via /health) and the CLI's pre-run
 * lightweight probe (#307 / #322).
 *
 * Exit 0 alone is NOT ready: a stub named `grok` that exits 0, or a `codex`
 * that prints garbage, must land in `check_failed`. Ready requires output in
 * the shape the real CLI prints for its probe command.
 */
import type { DriverId } from "./contracts";

export type CliProbeVerdict = "ready" | "not_logged_in" | "check_failed";

export interface CliProbeResult {
  code: number | null;
  timedOut: boolean;
  text: string;
}

export interface CliProbeSpec {
  bin: string;
  probeArgv: string[];
}

export const CLI_PROBE_SPECS: Record<DriverId, CliProbeSpec> = {
  "claude-stream-json": { bin: "cld", probeArgv: ["--version"] },
  "codex-app-server": { bin: "codex", probeArgv: ["--version"] },
  "kimi-stream-json": { bin: "kimi", probeArgv: ["provider", "list"] },
  "grok-stream-json": { bin: "grok", probeArgv: ["models"] },
  "cursor-stream-json": { bin: "cursor-agent", probeArgv: ["models"] },
};

const AUTH_REQUIRED_RE = /AUTH_REQUIRED|not logged in|please (?:run )?\S* ?login|unauthoriz/i;
const SEMVER_RE = /\b\d+\.\d+\.\d+\b/;

export function looksLikeAuthRequired(text: string): boolean {
  return AUTH_REQUIRED_RE.test(text);
}

/**
 * Does the probe output look like the real CLI? Shapes come from live runs:
 * - `cld --version` / `codex --version`: a version (`codex-cli 0.162.1`).
 * - `kimi provider list`: `Default model: kimi-code/k3` (ADR-0012).
 * - `grok models`: `Available models:` list with `grok-*` ids.
 * - `cursor-agent models`: `<id> - <label>` rows (same rule as the driver's
 *   catalog parser).
 */
export function recognizesProbeOutput(driverId: DriverId, text: string): boolean {
  switch (driverId) {
    case "claude-stream-json":
    case "codex-app-server":
      return SEMVER_RE.test(text);
    case "kimi-stream-json":
      return /Default model:\s*\S+/i.test(text) || /\bkimi-code\/\S+/.test(text);
    case "grok-stream-json":
      return /^\s*[*+-]\s+grok-\S+/m.test(text) || /Default model:\s*grok-\S+/i.test(text);
    case "cursor-stream-json":
      return /^\s*[A-Za-z0-9][A-Za-z0-9._:+@-]*\s+-\s+\S/m.test(text);
  }
}

export function classifyCliProbe(driverId: DriverId, result: CliProbeResult): CliProbeVerdict {
  if (result.timedOut) return "check_failed";
  if (looksLikeAuthRequired(result.text)) return "not_logged_in";
  if (result.code === 0 && recognizesProbeOutput(driverId, result.text)) return "ready";
  return "check_failed";
}
