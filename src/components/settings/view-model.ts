import type { RepairAction, SettingsReadinessModel } from "@/runtime/readiness";
import type {
  DriverCapabilityState,
  DriverId,
  InstallationState,
  ProfileReadinessState,
} from "@shared/runtime/contracts";

/**
 * Pure Settings view-model helpers (U6): exact plan Readiness-table vocabulary
 * (层级/状态) mapped to Chinese display text and the table's single repair
 * action label. No fetch calls, no React — unit-testable in isolation.
 */

export const DRIVER_DISPLAY_NAMES: Record<DriverId, string> = {
  "claude-stream-json": "Claude (cld CLI)",
  "codex-app-server": "Codex (app-server)",
};

export const CLAUDE_ROUTE_LABELS: Record<string, string> = {
  "ant-glm5.2": "GLM 5.2 (ant)",
  moonshot: "Kimi (moonshot)",
  deepseek: "DeepSeek",
};

export function driverDisplayName(driverId: DriverId): string {
  return DRIVER_DISPLAY_NAMES[driverId] ?? driverId;
}

/** Exact InstallationState vocabulary → (Chinese label, pill tone). */
export function installationStateView(state: InstallationState): {
  label: string;
  tone: "muted" | "info" | "success" | "error" | "warn";
} {
  switch (state) {
    case "trusted":
      return { label: "已验证可信", tone: "success" };
    case "discovering":
      return { label: "发现中", tone: "info" };
    case "discovered":
      return { label: "已发现（未信任）", tone: "warn" };
    case "changed":
      return { label: "已验证程序发生变化", tone: "warn" };
    case "not_found":
      return { label: "未找到", tone: "error" };
    case "invalid":
      return { label: "路径不安全", tone: "error" };
  }
}

/** Exact DriverCapabilityState vocabulary → (Chinese label, pill tone). */
export function driverCapabilityView(state: DriverCapabilityState): {
  label: string;
  tone: "muted" | "info" | "success" | "error" | "warn";
} {
  switch (state) {
    case "ready":
      return { label: "就绪", tone: "success" };
    case "checking":
      return { label: "正在检查登录与协议", tone: "info" };
    case "auth_required":
      return { label: "本地 CLI 尚未登录", tone: "warn" };
    case "incompatible":
      return { label: "缺少必需协议能力", tone: "error" };
  }
}

/** Exact ProfileReadinessState vocabulary → (Chinese label, pill tone). */
export function profileReadinessView(state: ProfileReadinessState): {
  label: string;
  tone: "muted" | "info" | "success" | "error" | "warn";
} {
  switch (state) {
    case "ready":
      return { label: "就绪", tone: "success" };
    case "invalid_binding":
      return { label: "绑定失效", tone: "error" };
    case "runtime_unavailable":
      return { label: "运行时不可用", tone: "warn" };
    case "model_unavailable":
      return { label: "已选 modelId 不在当前目录", tone: "warn" };
  }
}

/** Readiness table's single repair action → Chinese button label. */
export function repairActionLabel(action: RepairAction): string {
  switch (action) {
    case "restart-host":
      return "查看重启说明";
    case "install-requirements":
      return "查看安装/路径要求";
    case "revalidate":
      return "重新验证";
    case "wait":
      return "等待检查完成";
    case "cli-login":
      return "重新检查";
    case "driver-diagnostics":
      return "查看诊断/更新 CLI";
    case "edit-binding":
      return "编辑绑定";
    case "choose-model":
      return "选择可用模型";
  }
}

/** "全部 ready" gating (plan last table row): Host online + every installation
 * trusted + every driver ready + every profile ready. */
export function allSectionsReady(model: SettingsReadinessModel): boolean {
  return (
    model.host === "online" &&
    model.installations.every((item) => item.status === "trusted") &&
    model.drivers.every((item) => item.status === "ready") &&
    model.profiles.every((item) => item.status === "ready")
  );
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Shared react-query key so the Agent form and the per-profile readiness
 * probes reuse one catalog cache entry for the same driver+installation. */
export function modelCatalogQueryKey(driverId: string, installationId: string) {
  return ["host", "model-catalog", driverId, installationId] as const;
}
