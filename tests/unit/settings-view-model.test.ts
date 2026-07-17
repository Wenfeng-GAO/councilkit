import {
  allSectionsReady,
  driverCapabilityView,
  driverDisplayName,
  installationStateView,
  isValidHexColor,
  modelCatalogQueryKey,
  profileReadinessView,
  repairActionLabel,
} from "@/components/settings/view-model";
import type { RepairAction, SettingsReadinessModel } from "@/runtime/readiness";
import {
  DRIVER_CAPABILITY_STATES,
  INSTALLATION_STATES,
  PROFILE_READINESS_STATES,
} from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

/**
 * Settings view-model helpers (U6): exact Readiness-table vocabulary mapping,
 * the "全部 ready" gate, hex color validation and the shared catalog query key.
 */

describe("settings view-model", () => {
  it("covers every InstallationState / DriverCapabilityState / ProfileReadinessState exactly once", () => {
    for (const state of INSTALLATION_STATES) {
      expect(installationStateView(state).label.length).toBeGreaterThan(0);
    }
    for (const state of DRIVER_CAPABILITY_STATES) {
      expect(driverCapabilityView(state).label.length).toBeGreaterThan(0);
    }
    for (const state of PROFILE_READINESS_STATES) {
      expect(profileReadinessView(state).label.length).toBeGreaterThan(0);
    }
  });

  it("uses the plan row wording for the key Readiness-table states", () => {
    expect(installationStateView("changed").label).toBe("已验证程序发生变化");
    expect(driverCapabilityView("checking").label).toBe("正在检查登录与协议");
    expect(driverCapabilityView("auth_required").label).toBe("本地 CLI 尚未登录");
    expect(driverCapabilityView("incompatible").label).toBe("缺少必需协议能力");
    expect(profileReadinessView("model_unavailable").label).toBe("已选 modelId 不在当前目录");
  });

  it("maps every repair action to the table's single-action label", () => {
    const expected: Record<RepairAction, string> = {
      "restart-host": "查看重启说明",
      "install-requirements": "查看安装/路径要求",
      revalidate: "重新验证",
      wait: "等待检查完成",
      "cli-login": "重新检查",
      "driver-diagnostics": "查看诊断/更新 CLI",
      "edit-binding": "编辑绑定",
      "choose-model": "选择可用模型",
    };
    for (const action of Object.keys(expected) as RepairAction[]) {
      expect(repairActionLabel(action)).toBe(expected[action]);
    }
  });

  it("allSectionsReady requires Host online + trusted installations + ready drivers + ready profiles", () => {
    const trustedInstallation: SettingsReadinessModel["installations"][number] = {
      installationId: "i-1",
      driverId: "codex-app-server",
      status: "trusted",
      detail: null,
      action: null,
    };
    const base: SettingsReadinessModel = {
      host: "online",
      installations: [trustedInstallation],
      drivers: [{ driverId: "codex-app-server", status: "ready", action: null }],
      profiles: [{ profileId: "p-1", name: "P", status: "ready", detail: null, action: null }],
    };
    expect(allSectionsReady(base)).toBe(true);
    expect(allSectionsReady({ ...base, host: "unavailable" })).toBe(false);
    expect(allSectionsReady({ ...base, host: "unknown" })).toBe(false);
    expect(
      allSectionsReady({
        ...base,
        installations: [{ ...trustedInstallation, status: "changed", action: "revalidate" }],
      }),
    ).toBe(false);
    expect(
      allSectionsReady({
        ...base,
        drivers: [{ driverId: "codex-app-server" as const, status: "checking", action: "wait" }],
      }),
    ).toBe(false);
    expect(
      allSectionsReady({
        ...base,
        profiles: [
          {
            profileId: "p-1",
            name: "P",
            status: "model_unavailable",
            detail: null,
            action: "choose-model",
          },
        ],
      }),
    ).toBe(false);
  });

  it("validates #rrggbb hex colors (factory rule)", () => {
    expect(isValidHexColor("#4f6ef7")).toBe(true);
    expect(isValidHexColor("#AABBCC")).toBe(true);
    expect(isValidHexColor("4f6ef7")).toBe(false);
    expect(isValidHexColor("#fff")).toBe(false);
    expect(isValidHexColor("#gg0000")).toBe(false);
    expect(isValidHexColor("")).toBe(false);
  });

  it("exposes stable driver display names and a shared catalog query key", () => {
    expect(driverDisplayName("claude-stream-json")).toContain("Claude");
    expect(driverDisplayName("codex-app-server")).toContain("Codex");
    expect(modelCatalogQueryKey("codex-app-server", "inst-1")).toEqual([
      "host",
      "model-catalog",
      "codex-app-server",
      "inst-1",
      "",
    ]);
    expect(modelCatalogQueryKey("claude-stream-json", "inst-2", "moonshot")).toEqual([
      "host",
      "model-catalog",
      "claude-stream-json",
      "inst-2",
      "moonshot",
    ]);
  });
});
