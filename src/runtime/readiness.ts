import type { ExecutionProfileRecord } from "@/models/execution-profile";
import type {
  DriverCapabilityState,
  DriverId,
  InstallationState,
  ProfileReadinessState,
} from "@shared/runtime/contracts";
import type { InstallationDto, ProfileReadiness } from "@shared/runtime/schemas";

/**
 * Pure mapping from Host-reported state to the Settings page sections
 * (Host → Installations/登录能力 → Execution Profiles). Status strings are the
 * exact vocabulary of the plan's Readiness mapping table; each row also gets
 * the table's single repair action. No fetch calls live here — the caller
 * supplies DTOs collected from the Host.
 */

export type HostSectionStatus = "unknown" | "online" | "unavailable";

export type RepairAction =
  | "restart-host" // 查看重启说明
  | "install-requirements" // 查看安装/路径要求
  | "revalidate" // 重新验证
  | "wait" // 禁用相关提交并等待
  | "cli-login" // 在终端登录后重新检查
  | "driver-diagnostics" // 查看诊断/更新 CLI
  | "edit-binding" // 编辑绑定
  | "choose-model"; // 选择可用模型

export interface InstallationSectionItem {
  installationId: string;
  driverId: DriverId;
  /** Exact Installation trust state (Readiness table rows). */
  status: InstallationState;
  detail: string | null;
  action: RepairAction | null;
}

export interface DriverSectionItem {
  driverId: DriverId;
  /** Exact Driver capability state (Readiness table rows). */
  status: DriverCapabilityState;
  action: RepairAction | null;
}

export interface ProfileSectionItem {
  profileId: string;
  name: string;
  /** Exact Profile readiness state (Readiness table rows). */
  status: ProfileReadinessState;
  detail: string | null;
  action: RepairAction | null;
}

export interface SettingsReadinessModel {
  host: HostSectionStatus;
  installations: InstallationSectionItem[];
  drivers: DriverSectionItem[];
  profiles: ProfileSectionItem[];
}

export interface SettingsReadinessInput {
  /** null = not probed yet ("unknown"); false = Host unreachable. */
  hostOnline: boolean | null;
  installations: InstallationDto[];
  driverCapabilities: ReadonlyArray<{ driverId: DriverId; capability: DriverCapabilityState }>;
  profiles: ExecutionProfileRecord[];
  /** Per-profile readiness keyed by profile id (missing = not established). */
  profileReadiness: Readonly<Record<string, ProfileReadiness | undefined>>;
}

function installationAction(state: InstallationState): RepairAction | null {
  switch (state) {
    case "trusted":
      return null;
    case "changed":
      return "revalidate";
    case "discovering":
      return "wait";
    case "not_found":
    case "invalid":
    case "discovered":
      // `discovered` = found but not auto-trusted; V1 defers manual approval,
      // so the only remedy is meeting the installation/path requirements.
      return "install-requirements";
  }
}

function driverAction(capability: DriverCapabilityState): RepairAction | null {
  switch (capability) {
    case "ready":
      return null;
    case "checking":
      return "wait";
    case "auth_required":
      return "cli-login";
    case "incompatible":
      return "driver-diagnostics";
  }
}

function profileAction(state: ProfileReadinessState): RepairAction | null {
  switch (state) {
    case "ready":
      return null;
    case "invalid_binding":
    case "runtime_unavailable":
      return "edit-binding";
    case "model_unavailable":
      return "choose-model";
  }
}

export function buildSettingsReadiness(input: SettingsReadinessInput): SettingsReadinessModel {
  const host: HostSectionStatus =
    input.hostOnline === null ? "unknown" : input.hostOnline ? "online" : "unavailable";
  const installations = input.installations.map((dto) => ({
    installationId: dto.installationId,
    driverId: dto.driverId,
    status: dto.state,
    detail: dto.detail,
    action: installationAction(dto.state),
  }));
  const drivers = input.driverCapabilities.map((descriptor) => ({
    driverId: descriptor.driverId,
    status: descriptor.capability,
    action: driverAction(descriptor.capability),
  }));
  const profiles = input.profiles.map((profile) => {
    const readiness = input.profileReadiness[profile.id];
    if (!readiness) {
      return {
        profileId: profile.id,
        name: profile.name,
        status: "runtime_unavailable" as const,
        detail: "Readiness has not been established (Host unavailable or not refreshed).",
        action: "edit-binding" as const,
      };
    }
    return {
      profileId: profile.id,
      name: profile.name,
      status: readiness.state,
      detail: readiness.detail,
      action: profileAction(readiness.state),
    };
  });
  return { host, installations, drivers, profiles };
}
