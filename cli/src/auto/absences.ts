/**
 * Seats that did not take part.
 *
 * With `skippedSeats` on the council record (written by `councilkit init`,
 * #380): those rows, plus runtime failures among seats that were supposed to
 * run. Do not invent template seats init did not record.
 *
 * Without that field, a built-in template name (`pr-jury`, `product-jury`)
 * uses the template roster — old init deleted missing-driver seats from the
 * config, so the config cannot reveal them. Any other council uses the seats
 * saved in the config. `--agents` never consults a template: only the named
 * seats can be absent.
 *
 * There is no report-time PATH probe. A seat that ran, including
 * review-security on standalone cfuse, is not absent.
 */
import { DEFAULT_AGENT_SPECS, PR_JURY_COUNCIL_NAME } from "../init/defaults";
import { IDEATE_AGENT_SPECS, PRODUCT_JURY_COUNCIL_NAME } from "../init/ideate-defaults";
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
  /** Saved council name. Template baseline applies only when `skippedSeats` is absent. */
  councilName?: string;
  /** `--agents` subset. Unspecified default seats are not absent. */
  explicitAgents?: boolean;
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

/** 「本次指定 N 席：{席位名、…}」 for an explicit `--agents` subset. */
export function formatRequestedSeats(names: readonly string[]): string {
  return `本次指定 ${names.length} 席：${names.join("、")}`;
}

const NOT_LOGGED_IN =
  /未登录|not logged in|please (?:run )?\S* ?login|AUTH_REQUIRED|auth(?:entication|orization)? (?:failed|error)|unauthorized|invalid api key/i;

/** Parenthetical text is Chinese. Driver diagnostics stay out of the conclusion. */
export function failureAbsenceReason(
  failure: { code?: string; message?: string; errorClass?: string } | undefined,
): string {
  const message = failure?.message?.replace(/\s+/g, " ").trim() ?? "";
  const code = failure?.code?.trim() ?? "";
  if (code === "NOT_FOUND" || /没有找到/.test(message)) {
    const named = /没有找到\s*(\S+)/.exec(message);
    const tool = named?.[1]?.replace(/。$/, "");
    return tool ? `没有找到 ${tool}` : "没有找到工具";
  }
  const pathMiss = /executable "([^"]+)" not found/i.exec(message);
  if (pathMiss?.[1]) return `没有找到 ${pathMiss[1]}`;
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

function templateBaseline(councilName: string | undefined): DefinedSeat[] | null {
  if (councilName === PR_JURY_COUNCIL_NAME) {
    return DEFAULT_AGENT_SPECS.map((spec) => ({
      name: spec.name,
      tool: toolNameForSelection(spec.driverSelection),
    }));
  }
  if (councilName === PRODUCT_JURY_COUNCIL_NAME) {
    return IDEATE_AGENT_SPECS.map((spec) => ({
      name: spec.name,
      tool: toolNameForSelection(spec.driverSelection),
    }));
  }
  return null;
}

function toolForAttempt(attempt: AbsenceAttempt, roster: AbsenceRoster): string {
  const defined = roster.definedSeats?.find((seat) => seat.name === attempt.agentName);
  if (defined?.tool) return defined.tool;
  const template = templateBaseline(roster.councilName)?.find(
    (seat) => seat.name === attempt.agentName,
  );
  if (template?.tool) return template.tool;
  return executableForDriver(attempt.driverId) ?? attempt.driverId;
}

function inRequestedSet(name: string, roster: AbsenceRoster): boolean {
  if (!roster.explicitAgents || !roster.definedSeats) return true;
  return roster.definedSeats.some((seat) => seat.name === name);
}

/**
 * Absences for one report.
 *
 * `skippedSeats` present: those rows plus runtime failures. No template fill-in.
 * Field absent and the council is a built-in template: template seats that
 * never ran, with an unrecorded reason. Field absent otherwise: config seats
 * that never ran. `--agents` uses only the seats that were named.
 * A successful attempt is never absent.
 */
export function collectReportAbsences(
  attempts: readonly AbsenceAttempt[],
  roster: AbsenceRoster = {},
): ReportAbsence[] {
  const byName = new Map<string, AbsenceAttempt>();
  for (const attempt of attempts) byName.set(attempt.agentName, attempt);

  const absences: ReportAbsence[] = [];
  const named = new Set<string>();
  const fieldPresent = roster.skippedSeats !== undefined;

  if (fieldPresent) {
    for (const seat of roster.skippedSeats ?? []) {
      if (!inRequestedSet(seat.seat, roster)) continue;
      const ran = byName.get(seat.seat);
      if (ran?.status === "success" || ran?.status === "failure") continue;
      if (named.has(seat.seat)) continue;
      absences.push({ name: seat.seat, tool: seat.driver, reason: skippedSeatReason(seat) });
      named.add(seat.seat);
    }
  }

  for (const attempt of attempts) {
    if (attempt.status !== "failure" || named.has(attempt.agentName)) continue;
    if (!inRequestedSet(attempt.agentName, roster)) continue;
    absences.push({
      name: attempt.agentName,
      tool: toolForAttempt(attempt, roster),
      reason: failureAbsenceReason(attempt.failure),
    });
    named.add(attempt.agentName);
  }

  if (!fieldPresent) {
    const baseline = roster.explicitAgents
      ? (roster.definedSeats ?? [])
      : (templateBaseline(roster.councilName) ?? roster.definedSeats ?? []);
    for (const seat of baseline) {
      if (named.has(seat.name) || byName.has(seat.name)) continue;
      absences.push({ name: seat.name, tool: seat.tool, reason: UNRECORDED_REASON });
      named.add(seat.name);
    }
  }

  return absences;
}
