/**
 * Test-only 「慢生成」 switch for QA black-box runs (B4, #279 / #339).
 *
 *   COUNCILKIT_SLOW_GEN=silent|drip|buffered|crash
 *   COUNCILKIT_SLOW_GEN_MS=<ms, default 30000>   (drip interval / buffered emit time)
 *   COUNCILKIT_STREAM_IDLE_MS / COUNCILKIT_ONESHOT_TIMEOUT_MS shorten the limits.
 *
 * Set on the Runtime Host, it swaps every installation for a synthetic trusted
 * one under SLOW_GEN_PATH_PREFIX and every driver for a fake that answers
 * discussion turns at once and slows down only the report turn. The fake keeps
 * the real driver's timeout rule (generation-timeouts.ts): a Claude/Codex seat
 * is streaming (2-min no-output), a Kimi/Grok/Cursor seat is one-shot (10 min).
 *   silent   — the report turn emits nothing: streaming → STREAM_IDLE_TIMEOUT
 *              at streamIdleMs; one-shot → ONESHOT_TIMEOUT at oneshotMs.
 *   drip     — one chunk every COUNCILKIT_SLOW_GEN_MS, SLOW_GEN_CHUNKS times,
 *              then completes (5 × 30s = 2.5 min > the 2-minute window).
 *   buffered — like a one-shot CLI: nothing, then the whole report at once at
 *              COUNCILKIT_SLOW_GEN_MS. Before the limit → completes; after →
 *              the limit fires first.
 *   crash    — the model process "exits" SLOW_GEN_CRASH_AT_MS (5s) into the
 *              report turn → DRIVER_CRASH, the 「进程意外退出」 card at once.
 * Deliberately absent from --help and the UI. Every run it produces is a demo
 * run: the CLI marks it 示例 and keeps it out of real counts.
 */

export const SLOW_GEN_MODES = ["silent", "drip", "buffered", "crash"] as const;
export type SlowGenMode = (typeof SLOW_GEN_MODES)[number];

export interface SlowGenConfig {
  mode: SlowGenMode;
  intervalMs: number;
}

/** Fixed, documented second at which `crash` mode exits mid-report. */
export const SLOW_GEN_CRASH_AT_MS = 5_000;
export const SLOW_GEN_DEFAULT_INTERVAL_MS = 30_000;
export const SLOW_GEN_CHUNKS = 5;
/** Synthetic executable paths; nothing exists or runs there. */
export const SLOW_GEN_PATH_PREFIX = "/__councilkit_slow_gen__/";

export function slowGenFromEnv(env: NodeJS.ProcessEnv = process.env): SlowGenConfig | null {
  const mode = env.COUNCILKIT_SLOW_GEN?.trim().toLowerCase();
  if (!SLOW_GEN_MODES.includes(mode as SlowGenMode)) return null;
  const raw = Number(env.COUNCILKIT_SLOW_GEN_MS);
  const intervalMs =
    Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : SLOW_GEN_DEFAULT_INTERVAL_MS;
  return { mode: mode as SlowGenMode, intervalMs };
}

export function isSlowGenExecutablePath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(SLOW_GEN_PATH_PREFIX);
}
