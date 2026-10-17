/**
 * Seats that did not take part.
 *
 * Source of truth is the council record's `skippedSeats` (written by
 * `councilkit init`, #380) plus seats that failed while running. There is
 * no report-time PATH probe: a seat that ran, including review-security on
 * standalone cfuse, is not absent.
 *
 * A council saved before `skippedSeats` existed has no field. Each defined
 * seat that never produced an attempt is still listed, with an unrecorded
 * reason, so a seat is never dropped silently.
 */
import type { SkippedSeat } from "../store/schemas";
import { executableForDriver } from "./driver-commands";
import type { AttemptResult } from "./runner";

export interface ReportAbsence {
  name: string;
  /** Tool the seat runs on, e.g. grok, cursor-agent, cfuse. */
  tool: string;
  reason: string;
}

export interface DefinedSeat {
  name: string;
  tool: string;
}

export interface AbsenceRoster {
  /**
   * Undefined when the council file has no `skippedSeats` field.
   * An empty array means init recorded that nothing was skipped.
   */
  skippedSeats?: readonly SkippedSeat[];
  definedSeats?: readonly DefinedSeat[];
}

type AbsenceAttempt = Pick<AttemptResult, "agentName" | "status" | "failure" | "driverId">;

const UNRECORDED_REASON = "原因未记录，重新运行 `councilkit init` 可以看到原因";

export function formatAbsence(absence: ReportAbsence): string {
  const reason = absence.reason.replace(/\s+/g, " ").trim() || "失败";
  const tool = absence.tool.replace(/\s+/g, " ").trim() || "未知工具";
  return `缺席：${absence.name}（${tool}）：${reason}。`;
}

/** Grey line under the absence list. M is the number of seats that finished. */
export function formatAbsenceNote(presentCount: number): string {
  return `这份报告只汇总了其余 ${presentCount} 席的结果，缺席的这几席负责查的问题可能没被发现。`;
}

export function toolNameForSelection(selection: {
  driverId: string;
  options: object;
}): string {
  if ("route" in selection.options && selection.options.route === "cfuse") return "cfuse";
  return executableForDriver(selection.driverId) ?? selection.driverId;
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

export function skippedSeatReason(seat: Pick<SkippedSeat, "driver" | "reason">): string {
  if (seat.reason === "missing") return `没有安装 ${seat.driver}`;
  if (seat.reason === "logged-out") return "未登录";
  return `没有配置 ${seat.driver} 模型`;
}

function toolForAttempt(attempt: AbsenceAttempt, roster: AbsenceRoster): string {
  const defined = roster.definedSeats?.find((seat) => seat.name === attempt.agentName);
  if (defined?.tool) return defined.tool;
  return executableForDriver(attempt.driverId) ?? attempt.driverId;
}

/**
 * `skippedSeats` plus runtime failures. When the field is missing, defined
 * seats with no attempt are listed too. A successful attempt is never absent.
 */
export function collectReportAbsences(
  attempts: readonly AbsenceAttempt[],
  roster: AbsenceRoster = {},
): ReportAbsence[] {
  const byName = new Map<string, AbsenceAttempt>();
  for (const attempt of attempts) byName.set(attempt.agentName, attempt);

  const absences: ReportAbsence[] = [];
  const named = new Set<string>();

  for (const seat of roster.skippedSeats ?? []) {
    const ran = byName.get(seat.seat);
    if (ran?.status === "success" || ran?.status === "failure") continue;
    if (named.has(seat.seat)) continue;
    absences.push({ name: seat.seat, tool: seat.driver, reason: skippedSeatReason(seat) });
    named.add(seat.seat);
  }

  for (const attempt of attempts) {
    if (attempt.status !== "failure" || named.has(attempt.agentName)) continue;
    absences.push({
      name: attempt.agentName,
      tool: toolForAttempt(attempt, roster),
      reason: failureAbsenceReason(attempt.failure),
    });
    named.add(attempt.agentName);
  }

  for (const seat of roster.definedSeats ?? []) {
    if (named.has(seat.name) || byName.has(seat.name)) continue;
    absences.push({ name: seat.name, tool: seat.tool, reason: UNRECORDED_REASON });
    named.add(seat.name);
  }

  return absences;
}
