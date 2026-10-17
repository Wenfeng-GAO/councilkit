/**
 * Seats that did not take part. The conclusion names each one and why:
 * the driver was missing when the default roster was built, the seat was
 * not logged in, or the seat failed mid-run.
 */
import { DEFAULT_AGENT_SPECS } from "../init/defaults";
import { findExecutable } from "./driver-commands";
import type { AttemptResult } from "./runner";

export interface ReportAbsence {
  name: string;
  /** Text inside the parentheses, e.g. 「未找到 cld」. */
  reason: string;
}

export function formatAbsence(absence: ReportAbsence): string {
  const reason = absence.reason.replace(/\s+/g, " ").trim() || "失败";
  return `缺席：${absence.name}（${reason}）`;
}

const NOT_LOGGED_IN =
  /未登录|not logged in|please (?:run )?\S* ?login|AUTH_REQUIRED|auth(?:entication|orization)? (?:failed|error)|unauthorized|invalid api key/i;

/** Parenthetical text is Chinese. Driver diagnostics stay out of the conclusion. */
export function failureAbsenceReason(
  failure: { code?: string; message?: string; errorClass?: string } | undefined,
): string {
  const message = failure?.message?.replace(/\s+/g, " ").trim() ?? "";
  const code = failure?.code?.trim() ?? "";
  if (
    failure?.errorClass === "auth" ||
    code === "AUTH_REQUIRED" ||
    NOT_LOGGED_IN.test(message) ||
    NOT_LOGGED_IN.test(code)
  ) {
    return "未登录";
  }
  const exit = /non-zero exit (\d+)/i.exec(message);
  if (exit?.[1]) return `运行失败，退出码 ${exit[1]}`;
  if (code === "TIMEOUT" || /\btimed out\b/i.test(message)) return "运行超时";
  if (code === "ABORTED" || code === "CANCELLED") return "已取消";
  if (code === "NO_OUTPUT") return "没有产出";
  if (code === "SPAWN_ERROR") return "未能启动";
  if (/[\u4e00-\u9fff]/.test(message) && !/[A-Za-z]{3,}/.test(message)) return message.slice(0, 80);
  return "运行失败";
}

/**
 * Default jury seats whose driver was not on PATH (so init never put them in
 * the council) plus seats that ran and failed. A successful seat is not listed.
 */
export function collectReportAbsences(
  attempts: readonly Pick<AttemptResult, "agentName" | "status" | "failure">[],
  options: { env?: NodeJS.ProcessEnv; driverFound?: (executable: string) => boolean } = {},
): ReportAbsence[] {
  const driverFound =
    options.driverFound ??
    ((executable: string) => findExecutable(executable, options.env) !== null);
  const present = new Set(attempts.map((attempt) => attempt.agentName));
  const absences: ReportAbsence[] = [];
  for (const spec of DEFAULT_AGENT_SPECS) {
    if (present.has(spec.name)) continue;
    if (driverFound(spec.executable)) continue;
    absences.push({ name: spec.name, reason: `未找到 ${spec.executable}` });
  }
  for (const attempt of attempts) {
    if (attempt.status !== "failure") continue;
    absences.push({ name: attempt.agentName, reason: failureAbsenceReason(attempt.failure) });
  }
  return absences;
}
