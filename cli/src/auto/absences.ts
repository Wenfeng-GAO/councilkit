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

export function failureAbsenceReason(
  failure: { code?: string; message?: string; errorClass?: string } | undefined,
): string {
  const message = failure?.message?.replace(/\s+/g, " ").trim() ?? "";
  if (
    failure?.errorClass === "auth" ||
    /未登录|not logged in|please (?:run )?\S* ?login|AUTH_REQUIRED/i.test(message)
  ) {
    return "未登录";
  }
  if (message.length > 0) return message.slice(0, 160);
  return failure?.code?.trim() || "失败";
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
