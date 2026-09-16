import { IDEATE_ROLE_LABELS } from "@/lib/ideate-roster";

/** Persona seats keep a fixed role title. Extra seats follow the bound model. */

export const REVIEW_PERSONA_LABELS: Record<string, string> = {
  "review-security": "安全审查",
  "review-correctness": "正确性审查",
  "review-maintainability": "可维护性审查",
  "review-adversarial": "对抗审查",
};

export const DRIVER_LABELS: Record<string, string> = {
  "codex-app-server": "Codex",
  "claude-stream-json": "Claude",
  "grok-stream-json": "Grok",
  "kimi-stream-json": "Kimi",
  "cursor-stream-json": "Cursor",
};

export type SeatLabelInput = {
  agentName: string;
  modelId: string;
  driverId: string;
  role?: string;
};

export function isPersonaSeat(agentName: string): boolean {
  return Object.prototype.hasOwnProperty.call(REVIEW_PERSONA_LABELS, agentName);
}

export function isGenericModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return (
    id.length === 0 ||
    id === "auto" ||
    id === "default" ||
    id === "configured" ||
    id === "-" ||
    id === "current"
  );
}

export function driverLabel(driverId: string): string {
  return DRIVER_LABELS[driverId] ?? driverId;
}

/** Visible model for a seat: concrete id, or the driver's default name. */
export function seatModelLabel(modelId: string, driverId: string): string {
  if (!isGenericModelId(modelId)) return modelId.trim();
  if (driverId === "cursor-stream-json") return "Cursor Auto";
  return driverLabel(driverId);
}

export function reviewSeatTitle(input: SeatLabelInput): string {
  if (input.role === "aggregator") return "结果汇总";
  if (REVIEW_PERSONA_LABELS[input.agentName]) return REVIEW_PERSONA_LABELS[input.agentName];
  if (IDEATE_ROLE_LABELS[input.agentName]) return IDEATE_ROLE_LABELS[input.agentName];
  return seatModelLabel(input.modelId, input.driverId);
}

/** Second line under the title. Extra seats never surface the frozen agent name. */
export function reviewSeatIdentity(input: SeatLabelInput): string {
  if (input.role === "aggregator" || isPersonaSeat(input.agentName)) {
    return `${input.agentName} · ${input.driverId}`;
  }
  return input.driverId;
}

export function reviewSeatTabLabel(
  input: SeatLabelInput,
  siblings: readonly SeatLabelInput[],
  attemptId?: string,
): string {
  const title = reviewSeatTitle(input);
  const dup =
    siblings.filter(
      (row) => reviewSeatTitle(row) === title && (row.role ?? "") === (input.role ?? ""),
    ).length > 1;
  return dup && attemptId ? `${title} · ${attemptId}` : title;
}
