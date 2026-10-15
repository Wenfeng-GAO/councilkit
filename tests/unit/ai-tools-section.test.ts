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
        onRecheckDriver: () => undefined,
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
  it("CLI-01 CMP-D2: each of the five states renders its copy and button; no cld; Chinese only", () => {
    const html = render(
      [
        descriptor("grok-stream-json", "ready"),
        descriptor("kimi-stream-json", "not_logged_in", "kimi login"),
        descriptor("codex-app-server", "not_installed"),
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
      ],
    );

    expect(html).toContain("本机 AI 工具");
    expect(html).toContain(
      "CouncilKit 只调用你电脑上已登录的命令行工具，不读取、不保存密钥。至少需要 1 个「就绪」。",
    );
    expect(html).not.toContain("AI tools on this machine");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Not logged in");
    expect(html).not.toContain("Not installed");
    expect(html).not.toContain("Checking");
    expect(html).not.toMatch(/\bRe-check\b/);
    expect(html).toContain("就绪");
    expect(html).toContain("未登录");
    expect(html).toContain("未安装");
    expect(html).toContain("检查中"); // legend
    expect(html).toContain("检查失败");
    expect(html).toContain("最多 15 秒");
    expect(html).toContain("点「重新检查」再试");

    expect(html).toContain("可以直接用");
    expect(html).toContain("建 Agent");
    expect(html).toContain("kimi login");
    expect(html).toContain("完成后点「重新检查」");
    expect(html).toContain("检查没成功");
    expect(html).toContain("cursor-agent --version");
    expect(html).toContain("或点「重新检查」");
    expect(html).not.toContain("或点「重试」");
    expect(html).not.toContain(">重试<");
    expect(html).not.toContain("cld");
    expect(html).not.toContain("Claude");

    expect(countTool(html, "grok")).toBe(1);
    expect(countTool(html, "kimi")).toBe(1);
    expect(countTool(html, "codex")).toBe(1);
    expect(countTool(html, "cursor-agent")).toBe(1);
    expect(countTool(html, "cld")).toBe(0);

    expect(html).toContain("PATH 上找不到");
    expect(html).toContain("codex");
    expect(html).toContain("装好后点「重新检查」");

    const checkingHtml = render([descriptor("grok-stream-json", "checking")], []);
    expect(checkingHtml).toContain("正在试连一次（超过 15 秒会给出结论）");
    expect(checkingHtml).toContain("检查中");
  });
});
