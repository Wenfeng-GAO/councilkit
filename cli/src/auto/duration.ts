/**
 * Human-readable duration formatting for the review report and progress lines
 * (plan §"时长格式化"). Whole-second floor; the numeric `durationMs` carried by
 * ReviewOutcome / transcript records is NEVER changed — only the display string.
 *
 *  - <60s  → `48s`, `59s`, `0s`        (seconds, unpadded)
 *  - <1h   → `1m00s`, `20m50s`, `59m59s` (minutes unpadded, seconds zero-padded)
 *  - ≥1h   → `1h00m00s`, `1h02m03s`      (hours unpadded, minutes/seconds padded)
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  if (totalMinutes > 0) return `${minutes}m${pad2(seconds)}s`;
  return `${seconds}s`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
