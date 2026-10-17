/**
 * Default seats `init` does not create (#380 onboarding standard 3).
 *
 * A seat is skipped when its driver binary is missing or the login probe
 * says logged-out. Login `unknown` still creates the seat. `ideate-challenger`
 * is also skipped when Codex is usable but no model is configured.
 */
import type { SkippedSeat } from "../store/schemas";
import type { DefaultAgentSpec } from "./defaults";
import {
  type DriverStatus,
  type KnownDriverName,
  LOGIN_NEXT,
  driverStatusByName,
} from "./driver-status";
import type { IdeateAgentSpec } from "./ideate-defaults";

/** Writes the top-level `model = "..."` that `init` reads from Codex config. */
export const CODEX_MODEL_COMMAND =
  'printf \'model = "<model-id>"\\n\' >> "${CODEX_HOME:-$HOME/.codex}/config.toml"';

export const CODEX_MODEL_NEXT = `${CODEX_MODEL_COMMAND} && councilkit init`;

export function formatSkippedSeatLine(seat: SkippedSeat): string {
  const reason =
    seat.reason === "missing"
      ? `未找到 ${seat.driver}`
      : seat.reason === "logged-out"
        ? `${seat.driver} 未登录`
        : `未配置 ${seat.driver} 模型`;
  const action =
    seat.reason === "missing"
      ? "安装后重新运行 init"
      : seat.reason === "logged-out"
        ? `运行 \`${seat.driver} login\` 后重新运行 init`
        : "配置模型后重新运行 init";
  return `未创建席位 ${seat.seat}：${reason}（${action}）`;
}

function blockFor(
  driver: KnownDriverName,
  rows: readonly DriverStatus[],
): "missing" | "logged-out" | null {
  const row = driverStatusByName(rows, driver);
  if (!row.found) return "missing";
  if (row.login === "logged-out") return "logged-out";
  return null;
}

function makeSkip(
  seat: string,
  driver: string,
  reason: "missing" | "logged-out",
  rows: readonly DriverStatus[],
): SkippedSeat {
  const row = rows.find((item) => item.driver === driver);
  const next =
    reason === "logged-out"
      ? (LOGIN_NEXT[driver] ?? `Run \`${driver} login\`.`)
      : (row?.next ?? `Install \`${driver}\`, then run \`councilkit init\`.`);
  return { seat, driver, reason, next };
}

/** `null` when the review seat can be created. */
export function reviewSkip(
  spec: DefaultAgentSpec,
  rows: readonly DriverStatus[],
): SkippedSeat | null {
  if (spec.name === "review-security") {
    const cld = blockFor("cld", rows);
    // Standalone cfuse fills the seat only when cld itself is absent.
    // A logged-out cld still wins at spawn time, so the seat stays skipped.
    if (cld === null) return null;
    if (cld === "missing" && blockFor("cfuse", rows) === null) return null;
    return makeSkip(spec.name, "cld", cld, rows);
  }
  const block = blockFor(spec.executable, rows);
  if (block === null) return null;
  return makeSkip(spec.name, spec.executable, block, rows);
}

/** Driver-level skip. Model discovery is a separate `no-model` skip. */
export function ideateDriverSkip(
  spec: IdeateAgentSpec,
  rows: readonly DriverStatus[],
): SkippedSeat | null {
  const block = blockFor(spec.executable, rows);
  if (block === null) return null;
  return makeSkip(spec.name, spec.executable, block, rows);
}

export function codexModelSkip(): SkippedSeat {
  return {
    seat: "ideate-challenger",
    driver: "codex",
    reason: "no-model",
    next: CODEX_MODEL_NEXT,
  };
}
