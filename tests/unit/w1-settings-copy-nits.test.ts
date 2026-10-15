/**
 * @vitest-environment jsdom
 *
 * #318 / #321 / #323 (designer + QA follow-ups on #309):
 * - #318 copy that marks commands with backticks renders them as code; no
 *   literal backtick reaches the screen. Copyable commands never wrap.
 * - #321 a row's 「重新检查」 re-checks only that row; the top button is
 *   「全部重新检查」.
 * - #323 the home page how-to no longer mentions cld.
 */
import { Landing } from "@/components/home/Landing";
import { InstallationsSection } from "@/components/settings/InstallationsSection";
import { EmptyState } from "@/components/shared/EmptyState";
import { renderInlineCode } from "@/components/shared/InlineCode";
import { HOST_DOWN_HINT } from "@/lib/host-status";
import type { CliState, DriverId } from "@shared/runtime/contracts";
import type { DriverDescriptor } from "@shared/runtime/schemas";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ROWS: DriverDescriptor[] = [
  descriptor("grok-stream-json", "check_failed", "grok --version"),
  descriptor("kimi-stream-json", "not_logged_in", "kimi login"),
  descriptor("codex-app-server", "not_installed"),
  descriptor("cursor-stream-json", "check_failed", "cursor-agent --version"),
];

function sectionProps(overrides: Record<string, unknown> = {}) {
  return {
    hostOnline: true,
    installations: [],
    drivers: ROWS.map((row) => ({ driverId: row.driverId, status: row.capability, action: null })),
    cliDrivers: ROWS,
    isLoading: false,
    revalidatingId: null,
    driversRechecking: false,
    onRevalidate: () => undefined,
    onShowRequirements: () => undefined,
    onRecheckDriver: () => undefined,
    onShowDiagnostics: () => undefined,
    ...overrides,
  };
}

describe("#318 backtick copy renders as code", () => {
  it("#318 empty-state title/hint: no literal backticks, command in <code>", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "还没有报告。先看一份示例，或运行 `councilkit init` 后回来。",
        hint: HOST_DOWN_HINT,
      }),
    );
    expect(html).not.toContain("`");
    expect(html).toContain('<code class="font-command whitespace-nowrap">councilkit init</code>');
    expect(html).toContain('<code class="font-command whitespace-nowrap">pnpm start</code>');
    expect(html).toContain(
      '<code class="font-command whitespace-nowrap">node scripts/install-service.mjs</code>',
    );
  });

  it("#318 renderInlineCode: plain text untouched, unpaired backtick never shown", () => {
    expect(renderInlineCode("没有命令")).toBe("没有命令");
    const html = renderToStaticMarkup(createElement("p", null, renderInlineCode("运行 `a b")));
    expect(html).not.toContain("`");
    expect(html).toContain("运行 a b");
  });

  it("#318 cursor-agent --version chip never wraps (nowrap at 1280)", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(InstallationsSection, sectionProps())),
    );
    const chip = html.match(/<button[^>]*title="复制"[^>]*>cursor-agent --version<\/button>/)?.[0];
    expect(chip).toBeDefined();
    expect(chip).toContain("whitespace-nowrap");
    expect(html).not.toContain("`");
  });
});

describe("#321 row 「重新检查」 only re-checks that row", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function mount(props: Record<string, unknown>) {
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(MemoryRouter, null, createElement(InstallationsSection, sectionProps(props))),
      );
    });
  }
  const rowButton = (bin: string) =>
    container.querySelector(`[data-cli-tool="${bin}"] button:not([title])`) as HTMLButtonElement;

  it("#321 clicking a row's button asks for that driver only", () => {
    const onRecheckDriver = vi.fn();
    mount({ onRecheckDriver });
    act(() => rowButton("cursor-agent").click());
    expect(onRecheckDriver.mock.calls).toEqual([["cursor-stream-json"]]);
  });

  it("#321 while one row re-checks, the other rows keep their label and stay clickable", () => {
    mount({ recheckingDriverIds: new Set<DriverId>(["grok-stream-json"]) });
    expect(rowButton("grok").textContent).toBe("正在重新检查…");
    expect(rowButton("grok").disabled).toBe(true);
    for (const bin of ["kimi", "codex", "cursor-agent"]) {
      expect(rowButton(bin).textContent, bin).toBe("重新检查");
      expect(rowButton(bin).disabled, bin).toBe(false);
    }
  });
});

describe("#323 home page has no cld", () => {
  it("#323 how-to 01 lists grok / kimi / codex / cursor-agent; no cld anywhere", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Landing)));
    expect(html).not.toMatch(/\bcld\b/);
    const how = html.slice(html.indexOf("扫描 PATH 上的"), html.indexOf("写入安全"));
    for (const bin of ["grok", "kimi", "codex", "cursor-agent"]) expect(how).toContain(bin);
  });
});
