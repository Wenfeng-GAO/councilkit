/**
 * Test-only 「慢生成」 switch for QA black-box runs (B4, #279).
 *
 *   COUNCILKIT_SLOW_GEN=silent|drip   COUNCILKIT_SLOW_GEN_MS=<interval, default 30000>
 *
 * Set on the Runtime Host, it swaps every installation for a synthetic trusted
 * one under SLOW_GEN_PATH_PREFIX and every driver for a fake that answers
 * discussion turns at once and slows down only the report turn:
 *   silent — the report turn emits nothing; the 2-minute no-progress
 *            watchdog ends it with STREAM_IDLE_TIMEOUT.
 *   drip   — the report turn emits one chunk every interval, SLOW_GEN_CHUNKS
 *            times, then completes (5 × 30s = 2.5 min > the 2-minute window).
 * Deliberately absent from --help and the UI. Every run it produces is a demo
 * run: the CLI marks it 示例 and keeps it out of real counts.
 */

export type SlowGenMode = "silent" | "drip";

export interface SlowGenConfig {
  mode: SlowGenMode;
  intervalMs: number;
}

export const SLOW_GEN_DEFAULT_INTERVAL_MS = 30_000;
export const SLOW_GEN_CHUNKS = 5;
/** Synthetic executable paths; nothing exists or runs there. */
export const SLOW_GEN_PATH_PREFIX = "/__councilkit_slow_gen__/";

export function slowGenFromEnv(env: NodeJS.ProcessEnv = process.env): SlowGenConfig | null {
  const mode = env.COUNCILKIT_SLOW_GEN?.trim().toLowerCase();
  if (mode !== "silent" && mode !== "drip") return null;
  const raw = Number(env.COUNCILKIT_SLOW_GEN_MS);
  const intervalMs =
    Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : SLOW_GEN_DEFAULT_INTERVAL_MS;
  return { mode, intervalMs };
}

export function isSlowGenExecutablePath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(SLOW_GEN_PATH_PREFIX);
}
