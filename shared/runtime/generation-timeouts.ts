/**
 * The one generation-timeout rule shared by the Runtime Host drivers, the
 * slow-gen fakes and the `councilkit run` CLI (B4, #279 / #339).
 *
 *   streaming drivers (claude, codex) emit deltas while they write. The only
 *     user-visible bound is "no model output for streamIdleMs" (120s), reset
 *     on every output frame → STREAM_IDLE_TIMEOUT. A long report that keeps
 *     emitting is never cut.
 *   one-shot drivers (kimi, grok, cursor) print the whole answer once at the
 *     end, so silence is normal. They get no idle window; the bound is "not
 *     finished within oneshotMs" (10 min) → ONESHOT_TIMEOUT. A process that
 *     exits before finishing fails at once with DRIVER_CRASH (driver code).
 *
 * `TIMEOUTS.turnMs` (1h) stays a far-away safety ceiling only.
 */
import { type DriverId, TIMEOUTS } from "./contracts";

export type DriverOutputMode = "streaming" | "oneshot";

export const DRIVER_OUTPUT_MODE: Record<DriverId, DriverOutputMode> = {
  "claude-stream-json": "streaming",
  "codex-app-server": "streaming",
  "kimi-stream-json": "oneshot",
  "grok-stream-json": "oneshot",
  "cursor-stream-json": "oneshot",
};

/** Short tool names used in the interruption copy (same as the pickers). */
export const DRIVER_TOOL_NAMES: Record<DriverId, string> = {
  "claude-stream-json": "Claude",
  "codex-app-server": "Codex",
  "kimi-stream-json": "Kimi",
  "grok-stream-json": "Grok",
  "cursor-stream-json": "Cursor",
};

export function isOneShotDriver(driverId: string | null | undefined): boolean {
  return DRIVER_OUTPUT_MODE[driverId as DriverId] === "oneshot";
}

export function driverToolName(driverId: string | null | undefined): string | null {
  return DRIVER_TOOL_NAMES[driverId as DriverId] ?? null;
}

export interface GenerationTimeouts {
  streamIdleMs: number;
  oneshotMs: number;
}

export const GENERATION_TIMEOUTS: GenerationTimeouts = {
  streamIdleMs: TIMEOUTS.streamIdleMs,
  oneshotMs: TIMEOUTS.oneshotMs,
};

/** Test-only shortening for QA / e2e (not in --help or UI). Values below 1s
 * are ignored so a typo cannot make every turn fail instantly. */
export function generationTimeoutsFromEnv(
  env: Record<string, string | undefined>,
  base: GenerationTimeouts = GENERATION_TIMEOUTS,
): GenerationTimeouts {
  const read = (name: string, fallback: number) => {
    const raw = Number(env[name]);
    return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : fallback;
  };
  return {
    streamIdleMs: read("COUNCILKIT_STREAM_IDLE_MS", base.streamIdleMs),
    oneshotMs: read("COUNCILKIT_ONESHOT_TIMEOUT_MS", base.oneshotMs),
  };
}

/** Clients that follow a Host turn (the `councilkit run` CLI) arm the same
 * rule this much later as a backstop, so the Host's own terminal (with its
 * code) normally arrives first. */
export const GENERATION_CLIENT_GRACE_MS = 30_000;

export interface GenerationRule {
  mode: DriverOutputMode;
  limitMs: number;
  code: "STREAM_IDLE_TIMEOUT" | "ONESHOT_TIMEOUT";
  message: string;
}

export function generationRule(driverId: DriverId, timeouts: GenerationTimeouts): GenerationRule {
  if (DRIVER_OUTPUT_MODE[driverId] === "oneshot") {
    return {
      mode: "oneshot",
      limitMs: timeouts.oneshotMs,
      code: "ONESHOT_TIMEOUT",
      message: "One-shot model did not finish within the limit.",
    };
  }
  return {
    mode: "streaming",
    limitMs: timeouts.streamIdleMs,
    code: "STREAM_IDLE_TIMEOUT",
    message: "No model output within the idle limit.",
  };
}

export interface GenerationWatchdog {
  /** Output arrived. Restarts a streaming window; a no-op for one-shot. */
  output(): void;
  /** Stop for good (turn settled, cancelled or the process exited). */
  clear(): void;
}

/** Arms `rule`: fires `onTimeout` once, unless cleared first. */
export function startGenerationWatchdog(
  rule: Pick<GenerationRule, "mode" | "limitMs">,
  onTimeout: () => void,
): GenerationWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (cleared) return;
      cleared = true;
      onTimeout();
    }, rule.limitMs);
  };
  arm();
  return {
    output() {
      if (!cleared && rule.mode === "streaming") arm();
    },
    clear() {
      cleared = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Duration in the interruption copy. Under a minute → whole seconds
 * (「45 秒」); whole minutes → minutes (「2 分钟」「10 分钟」); anything else
 * stays in whole seconds, never a decimal (90s → 「90 秒」). Rounds to the
 * nearest second, minimum 1.
 */
export function formatLimitZh(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/** English twin of formatLimitZh (「10 min」 / 「45 s」 / 「90 s」). */
export function formatLimitEn(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
