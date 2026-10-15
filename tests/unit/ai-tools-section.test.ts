import { InstallationsSection } from "@/components/settings/InstallationsSection";
import type { DriverSectionItem, InstallationSectionItem } from "@/runtime/readiness";
import type { CliState, DriverId } from "@shared/runtime/contracts";
import type { DriverDescriptor } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

function descriptor(driverId: DriverId, cliState: CliState, fixCommand = ""): DriverDescriptor {
  const capability =
    cliState === "ready"
      ? ("ready" as const)
      : cliState === "not_logged_in"
        ? ("auth_required" as const)
        : cliState === "checking"
          ? ("checking" as const)
          : ("incompatible" as const);
  return { driverId, cliState, capability, fixCommand };
}

function render(cliDrivers: DriverDescriptor[], installations: InstallationSectionItem[] = []) {
  const drivers: DriverSectionItem[] = cliDrivers.map((row) => ({
    driverId: row.driverId,
    status: row.capability,
    action: null,
  }));
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(InstallationsSection, {
        hostOnline: true,
        installations,
        drivers,
        cliDrivers,
        isLoading: false,
        revalidatingId: null,
        driversRechecking: false,
        onRevalidate: () => undefined,
        onShowRequirements: () => undefined,
        onRecheckDrivers: () => undefined,
        onShowDiagnostics: () => undefined,
        onRediscover: () => undefined,
      }),
    ),
  );
}

function countTool(html: string, bin: string): number {
  return html.split(`data-cli-tool="${bin}"`).length - 1;
}

describe("Settings AI tools list (CLI-01 CMP-D2)", () => {
  it("CLI-01 CMP-D2: each of the five states renders its copy and button; a tool renders exactly once", () => {
    const html = render(
      [
        descriptor("grok-stream-json", "ready"),
        descriptor("kimi-stream-json", "not_logged_in", "kimi login"),
        descriptor("codex-app-server", "checking"),
        descriptor("claude-stream-json", "not_installed"),
        descriptor("cursor-stream-json", "check_failed", "cursor-agent --version"),
      ],
      [
        {
          installationId: "inst-grok-a",
          driverId: "grok-stream-json",
          status: "trusted",
          detail: null,
          action: null,
        },
        {
          installationId: "inst-grok-b",
          driverId: "grok-stream-json",
          status: "changed",
          detail: "fingerprint changed",
          action: "revalidate",
        },
      ],
    );

    expect(html).toContain("本机 AI 工具");
    expect(html).toContain(
      "CouncilKit 只调用你电脑上已登录的命令行工具，不读取、不保存密钥。至少需要 1 个「就绪」。",
    );
    expect(html).toContain("AI tools on this machine · at least one must be Ready");
    expect(html).toContain("就绪 Ready");
    expect(html).toContain("未登录 Not logged in");
    expect(html).toContain("未安装 Not installed");
    expect(html).toContain("检查中 Checking");
    expect(html).toContain("最多 15 秒");
    expect(html).toContain("没有任何就绪工具？也可以先");
    expect(html).toContain("看示例");
    expect(html).toContain("先看示例");
    expect(html).toContain("（内置示例 AI，不需要账号）。");

    expect(html).toContain("可以直接用");
    expect(html).toContain("建 Agent");
    expect(html).toContain("在终端运行");
    expect(html).toContain("kimi login");
    expect(html).toContain("完成后点「重新检查」");
    expect(html).toContain("正在试连一次（超过 15 秒会给出结论）");
    expect(html).toContain("PATH 上找不到");
    expect(html).toContain("cld");
    expect(html).toContain("安装说明 ↗");
    expect(html).toContain("装好后点「重新检查」");
    expect(html).toContain("检查失败");
    expect(html).toContain("15 秒内没有结果。在终端运行");
    expect(html).toContain("cursor-agent --version");
    expect(html).toContain("或点「重试」");
    expect(html).toContain("重试");
    expect(html).toContain("详情");

    expect(countTool(html, "grok")).toBe(1);
    expect(countTool(html, "kimi")).toBe(1);
    expect(countTool(html, "codex")).toBe(1);
    expect(countTool(html, "cld")).toBe(1);
    expect(countTool(html, "cursor-agent")).toBe(1);

    expect(html).toContain("Grok");
    expect(html).toContain("Kimi K3");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude");
    expect(html).toContain("Cursor");

    const grokIdx = html.indexOf('data-cli-tool="grok"');
    const kimiIdx = html.indexOf('data-cli-tool="kimi"');
    const nextGrok = html.indexOf('data-cli-tool="grok"', grokIdx + 1);
    expect(nextGrok).toBe(-1);
    expect(kimiIdx).toBeGreaterThan(grokIdx);

    expect(html).not.toContain("AUTH_REQUIRED");
    expect(html).not.toContain("INCOMPATIBLE_DRIVER");
    expect(html).not.toContain("npm install");
  });
});
