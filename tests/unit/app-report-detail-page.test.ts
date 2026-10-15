import "./app-dom-install";

import { createRequire } from "node:module";
import { ReportDetailPage } from "@/app/pages/ReportDetailPage";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE } from "@/lib/host-status";
import { RuntimeClientError } from "@/runtime/client";
import { type ReactNode, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton } from "./app-dom-install";
import {
  deferred,
  mountRouted,
  setDocumentVisibility,
  settle,
  waitForText,
} from "./app-page-harness";

const REVIEW_MD = `# Autonomous Review Report

- Task: review PR https://code.alipay.com/paas-core/agentrun/pull_requests/126

---

## 共识发现

- [major][必现] 非文本内容被错误转换为 live-only preview。
- [minor] Java SDK 将 seq 改为可空 Long。

## 结论

changes-requested
`;

type Launch = {
  name: string;
  sourceBranch: string;
  base: string;
  isolationMode: "collaborative";
};

const scene = vi.hoisted(() => ({
  repairError: "",
  pipelineError: "",
  against: "",
  follow: "",
  active: "",
  stale: "",
  pendingAction: "",
  branch: "",
  copiedLabel: "",
}));

const client = vi.hoisted(() => ({
  getCliRun: vi.fn(),
  listCliRuns: vi.fn(),
  listCliRepairProfiles: vi.fn(),
  saveCliRepairProfile: vi.fn(),
  startCliRepair: vi.fn(),
  stopCliRepair: vi.fn(),
  resumeCliRepair: vi.fn(),
  startCliRunAction: vi.fn(),
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client, orchestrator: {} }),
}));

vi.mock("@/components/layout/AppShell", async () => {
  const { createElement: h } = await import("react");
  return { AppShell: (props: { children?: ReactNode }) => h("div", null, props.children) };
});

vi.mock("@/components/report/workbench/ReviewWorkbench", async () => {
  const { createElement: h } = await import("react");
  return {
    ReviewWorkbench: (props: {
      stale: boolean;
      onRefetch: () => void;
      againstState: { status: string };
      repair: {
        error: string | null;
        profiles: Array<{ name: string }>;
        activeRepair: { runId: string } | null;
        sourceBranchDefault: string;
        baseDefault: string;
        hintSource: string | null;
        bridgeAvailable: boolean;
        bridgeLoading: boolean;
        bridgeReason: string | null;
        outerUsed: number;
        outerMax: number;
        pending: boolean;
        onStart: (profile?: string) => void;
        onStop: () => void;
        onResume: () => void;
        onSaveProfile: (launch?: Launch) => void;
      };
      pipeline: {
        error: string | null;
        busy: boolean;
        pendingAction: string | null;
        followUpRun: { runId: string } | null;
        onFix: () => void;
        onReReview: () => void;
      };
    }) => {
      scene.repairError = props.repair.error ?? "";
      scene.pipelineError = props.pipeline.error ?? "";
      scene.against = props.againstState.status;
      scene.follow = props.pipeline.followUpRun?.runId ?? "";
      scene.active = props.repair.activeRepair?.runId ?? "";
      scene.stale = props.stale ? "yes" : "no";
      scene.pendingAction = props.pipeline.pendingAction ?? "";
      scene.branch = props.repair.sourceBranchDefault;
      return h(
        "section",
        { "aria-label": "审查工作台" },
        h("p", null, `against:${props.againstState.status}`),
        h("p", null, `stale:${props.stale ? "yes" : "no"}`),
        h("p", null, `repair-error:${props.repair.error ?? ""}`),
        h("p", null, `pipeline-error:${props.pipeline.error ?? ""}`),
        h("p", null, `profiles:${props.repair.profiles.map((item) => item.name).join(",")}`),
        h("p", null, `active:${props.repair.activeRepair?.runId ?? ""}`),
        h("p", null, `branch:${props.repair.sourceBranchDefault}`),
        h("p", null, `base:${props.repair.baseDefault}`),
        h("p", null, `hint:${props.repair.hintSource ?? ""}`),
        h("p", null, `bridge:${props.repair.bridgeAvailable ? "yes" : "no"}`),
        h("p", null, `bridge-loading:${props.repair.bridgeLoading ? "yes" : "no"}`),
        h("p", null, `bridge-reason:${props.repair.bridgeReason ?? ""}`),
        h("p", null, `outer:${props.repair.outerUsed}/${props.repair.outerMax}`),
        h("p", null, `pending:${props.repair.pending ? "yes" : "no"}`),
        h("p", null, `busy:${props.pipeline.busy ? "yes" : "no"}`),
        h("p", null, `pending-action:${props.pipeline.pendingAction ?? ""}`),
        h("p", null, `follow:${props.pipeline.followUpRun?.runId ?? ""}`),
        h("button", { type: "button", onClick: props.onRefetch }, "刷新工作台"),
        h("button", { type: "button", onClick: () => props.repair.onStart("default") }, "启动修复"),
        h(
          "button",
          { type: "button", onClick: () => props.repair.onStart(undefined) },
          "启动默认修复",
        ),
        h("button", { type: "button", onClick: props.repair.onStop }, "停止修复"),
        h("button", { type: "button", onClick: props.repair.onResume }, "继续修复"),
        h(
          "button",
          {
            type: "button",
            onClick: () =>
              props.repair.onSaveProfile({
                name: "saved",
                sourceBranch: "fix/a",
                base: "main",
                isolationMode: "collaborative",
              }),
          },
          "保存授权",
        ),
        h(
          "button",
          { type: "button", onClick: () => props.repair.onSaveProfile(undefined) },
          "保存空授权",
        ),
        h("button", { type: "button", onClick: props.pipeline.onFix }, "发起修复"),
        h("button", { type: "button", onClick: props.pipeline.onReReview }, "发起复审"),
      );
    },
  };
});

vi.mock("@/components/report/repair-workspace/RepairWorkspace", async () => {
  const { createElement: h } = await import("react");
  return {
    RepairWorkspace: (props: {
      runId: string;
      sourceRunId: string | null;
      stopPending: boolean;
      onStop: () => Promise<void>;
      onResume: () => Promise<void>;
    }) =>
      h(
        "section",
        { "aria-label": "修复工作区" },
        h("p", null, `repair-run:${props.runId}`),
        h("p", null, `source:${props.sourceRunId ?? ""}`),
        h("p", null, `stop-pending:${props.stopPending ? "yes" : "no"}`),
        h("button", { type: "button", onClick: () => void props.onStop() }, "停止自动修复"),
        h("button", { type: "button", onClick: () => void props.onResume() }, "继续自动修复"),
      ),
  };
});

function marker(name: string) {
  return async () => {
    const { createElement: h } = await import("react");
    return {
      [name]: (props: {
        run?: { runId?: string };
        runId?: string;
        markdown?: string;
        integrity?: { incomplete: boolean };
        open?: boolean;
        content?: string;
        selectedId?: string | null;
        onInspect?: (id: string) => void;
        onSelect?: (id: string) => void;
        onClose?: () => void;
        runs?: unknown[];
      }) =>
        h(
          "div",
          null,
          h(
            "p",
            null,
            `${name}:${props.run?.runId ?? props.runId ?? ""}${props.markdown || props.content ? `:${props.markdown || props.content}` : ""}${props.integrity ? ":yes" : ""}${props.open ? ":open" : ":closed"}${props.selectedId ? `:${props.selectedId}` : ""}${props.runs ? `:${props.runs.length}` : ""}`,
          ),
          props.onInspect
            ? h(
                "button",
                { type: "button", onClick: () => props.onInspect?.("seat-9") },
                `检查${name}`,
              )
            : null,
          props.onSelect
            ? h(
                "button",
                { type: "button", onClick: () => props.onSelect?.("attempt-1") },
                "查看席位",
              )
            : null,
          props.onClose
            ? h("button", { type: "button", onClick: props.onClose }, "关闭席位")
            : null,
        ),
    };
  };
}

vi.mock("@/components/report/IdeateIntegrityCard", marker("IdeateIntegrityCard"));
vi.mock("@/components/report/PrCaseSummary", marker("PrCaseSummary"));
vi.mock("@/components/report/SquadWorkspace", marker("SquadWorkspace"));
vi.mock("@/components/report/LiveReviewProgress", marker("LiveReviewProgress"));
vi.mock("@/components/report/FindingLedger", marker("FindingLedger"));
vi.mock("@/components/report/FixPipeline", async () => {
  const actual = await vi.importActual<typeof import("@/components/report/FixPipeline")>(
    "@/components/report/FixPipeline",
  );
  const { createElement: h } = await import("react");
  return {
    ...actual,
    FixPlanDocument: (props: { markdown: string }) => h("p", null, `plan:${props.markdown}`),
  };
});
vi.mock("@/components/report/ReviewReportView", marker("ReviewReportView"));
vi.mock("@/components/markdown/SafeMarkdown", marker("SafeMarkdown"));
vi.mock("@/components/report/RepairExportCard", marker("RepairExportCard"));
vi.mock("@/components/report/SeatInspector", marker("SeatInspector"));

function detail(partial: Record<string, unknown>) {
  return {
    runId: "run-discuss",
    kind: "discuss",
    status: "completed",
    title: "讨论标题",
    startedAt: "2026-08-18T10:03:21.946Z",
    endedAt: null,
    hasReport: true,
    hasPlan: true,
    hasFindings: false,
    hasPlanLock: false,
    reportUrl: "http://127.0.0.1:43127/reports/run-discuss",
    progress: null,
    pipeline: null,
    handoff: null,
    markdown: REVIEW_MD,
    truncated: false,
    planMarkdown: "",
    planTruncated: false,
    findings: [],
    planLock: null,
    landings: [],
    documents: [],
    findingGroups: null,
    reviewEvidence: null,
    ...partial,
  };
}

const assigned: string[] = [];
const timers: Array<{ delay: number; run: () => void }> = [];
const clipboard = { text: "", fail: false };

// jsdom's Location#assign is non-configurable, but navigation is a no-op that
// only emits a virtual-console error. Record the URL on the shared impl.
const locationRequire = createRequire(import.meta.url);
const { implementation: LocationImpl } = locationRequire(
  "jsdom/lib/jsdom/living/window/Location-impl.js",
) as { implementation: { prototype: { assign: (url: string) => void } } };
const originalLocationAssign = LocationImpl.prototype.assign;
LocationImpl.prototype.assign = function assign(this: unknown, url: string) {
  assigned.push(String(url));
  return originalLocationAssign.call(this, url);
};

describe("ReportDetailPage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  beforeEach(() => {
    assigned.length = 0;
    timers.length = 0;
    clipboard.text = "";
    clipboard.fail = false;
    setDocumentVisibility("visible");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (clipboard.fail) throw new Error("denied");
          clipboard.text = value;
        },
      },
    });
    const original = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && typeof delay === "number" && delay >= 1500) {
        timers.push({ delay, run: () => handler(...args) });
        return 1;
      }
      return original(handler, delay, ...(args as []));
    }) as typeof window.setTimeout);
    client.getCliRun.mockReset();
    client.listCliRuns.mockReset();
    client.listCliRepairProfiles.mockReset();
    client.saveCliRepairProfile.mockReset();
    client.startCliRepair.mockReset();
    client.stopCliRepair.mockReset();
    client.resumeCliRepair.mockReset();
    client.startCliRunAction.mockReset();
    client.listCliRuns.mockResolvedValue({ runs: [] });
    client.listCliRepairProfiles.mockResolvedValue({
      profiles: [],
      sourceBranchHint: "",
      baseHint: "",
      hintSource: null,
      bridgeAvailable: false,
      bridgeReason: null,
    });
  });

  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
    vi.mocked(window.setTimeout).mockRestore();
    setDocumentVisibility("visible");
  });

  async function open(runId: string, row: Record<string, unknown> | Promise<unknown>) {
    client.getCliRun.mockImplementation((id: string) => {
      if (id !== runId) return Promise.resolve(detail({ runId: id, markdown: "# 其它\n" }));
      return Promise.resolve(row);
    });
    const view = await mountRouted(
      `/reports/${runId}`,
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(view);
    return view;
  }

  it("shows pending, host-down, and missing-report states", async () => {
    const pending = deferred<ReturnType<typeof detail>>();
    client.getCliRun.mockReturnValue(pending.promise);
    const view = await mountRouted(
      "/reports/run-discuss",
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(view);
    expect(view.container.textContent).toContain("正在打开报告…");
    pending.reject(new TypeError("Failed to fetch"));
    await waitForText(view.container, HOST_DOWN_TITLE);
    expect(view.container.textContent).toContain(HOST_DOWN_HINT.replace(/`/g, ""));
    await view.unmount();
    mounted.splice(0);

    client.getCliRun.mockRejectedValue(new Error("missing"));
    const missing = await mountRouted(
      "/reports/run-discuss",
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(missing);
    await waitForText(missing.container, "找不到这份报告");
    expect(missing.container.textContent).toContain("run id 无效，或 report.md 尚未写入。");
  });

  it("copies markdown, comment, resume, apply, and the fix prompt", async () => {
    const view = await open(
      "run-discuss",
      detail({
        progress: {
          attempts: [
            { id: "a1", role: "attempt", status: "failure" },
            { id: "a2", role: "attempt", status: "success" },
          ],
        },
        planMarkdown: "先改解析。",
        truncated: true,
      }),
    );
    await waitForText(view.container, "复制 Markdown");
    expect(view.container.textContent).toContain("← CLI 报告");
    expect(view.container.textContent).toContain("报告超过 2MB，已截断显示。");
    expect(view.container.textContent).toContain("plan:先改解析。");
    expect(view.container.textContent).toContain("ReviewReportView:");
    expect(view.container.textContent).toContain("1 个席位失败。复制「重跑失败席」只重跑失败的");
    expect(view.container.textContent).toContain("RepairExportCard:run-discuss");

    await clickButton(view.container, "复制 Markdown");
    await settle();
    expect(clipboard.text).toContain("# Autonomous Review Report");
    expect(view.container.textContent).toContain("已复制");
    expect(timers.map((timer) => timer.delay)).toContain(1600);
    await (await import("react")).act(async () => {
      timers.find((timer) => timer.delay === 1600)?.run();
    });
    expect(view.container.textContent).toContain("复制 Markdown");

    await clickButton(view.container, "复制 PR 评论");
    await settle();
    expect(clipboard.text).toBe(
      [
        "CouncilKit Jury：changes-requested",
        "",
        "讨论标题",
        "",
        "## 共识发现",
        "- [major][必现] 非文本内容被错误转换为 live-only preview。",
        "- [minor] Java SDK 将 seq 改为可空 Long。",
        "",
        "请按 critical/major 优先修复，并在评论里说明验证命令。",
        "",
      ].join("\n"),
    );
    await clickButton(view.container, "复制重跑失败席");
    await settle();
    expect(clipboard.text).toBe(
      "councilkit review https://code.alipay.com/paas-core/agentrun/pull_requests/126 --resume run-discuss",
    );
    await clickButton(view.container, "复制 apply 命令");
    await settle();
    expect(clipboard.text).toBe("councilkit apply --run run-discuss");
    await clickButton(view.container, "复制修复 Prompt");
    await settle();
    expect(
      clipboard.text.startsWith(
        "你是这个仓库的实现 agent。下面是 CouncilKit 多模型陪审团产出的 Markdown 报告。",
      ),
    ).toBe(true);
    expect(clipboard.text).toContain(
      "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
    );
    expect(clipboard.text).toContain(
      "8. 裁决是 changes-requested 或未给出：在合并前必须处理完所有 critical / major。",
    );
    expect(clipboard.text).toContain(
      "注意：报告在 2MB 处被截断，附录可能不完整。缺的 finding 不要臆造。",
    );

    clipboard.fail = true;
    await clickButton(view.container, "复制 Markdown");
    await settle();
    expect(view.container.textContent).toContain("复制 Markdown");
    expect(view.container.textContent).not.toContain("已复制");
  });

  it("renders squad, ideate, plain markdown, and an unfinished report", async () => {
    const squad = await open(
      "run-squad",
      detail({
        runId: "run-squad",
        kind: "squad",
        markdown: "# 笔记\n\n不是审查。\n",
        planMarkdown: "方案",
        progress: { attempts: [{ id: "s1", role: "attempt", status: "success" }] },
      }),
    );
    await waitForText(squad.container, "SquadWorkspace:run-squad");
    expect(squad.container.textContent).not.toContain("复制修复 Prompt");
    expect(squad.container.textContent).not.toContain("plan:方案");
    expect(squad.container.textContent).not.toContain("SafeMarkdown");
    await clickButton(squad.container, "检查SquadWorkspace");
    expect(squad.container.textContent).toContain("SeatInspector:run-squad:open:seat-9");
    await clickButton(squad.container, "关闭席位");
    expect(squad.container.textContent).toContain("SeatInspector:run-squad:closed");
    await squad.unmount();
    mounted.splice(0);

    const ideate = await open(
      "run-ideate",
      detail({
        runId: "run-ideate",
        kind: "ideate",
        markdown: "# 创意\n",
        ideateIntegrity: { incomplete: true },
        status: "running",
        hasReport: false,
        planMarkdown: "",
      }),
    );
    await waitForText(ideate.container, "← 产品创意");
    expect(ideate.container.querySelector('a[href="/ideate"]')?.textContent).toBe("← 产品创意");
    expect(ideate.container.textContent).toContain("IdeateIntegrityCard::yes");
    expect(ideate.container.textContent).not.toContain("还没有 report.md");
    await ideate.unmount();
    mounted.splice(0);

    const failed = await open(
      "run-failed",
      detail({
        runId: "run-failed",
        kind: "unknown",
        status: "failed",
        hasReport: false,
        markdown: "   ",
        planMarkdown: "",
      }),
    );
    await waitForText(failed.container, "还没有 report.md");
    expect(failed.container.textContent).toContain("这次 run 可能失败在写报告之前。");
    expect(failed.container.textContent).toContain("RepairExportCard:run-failed");
  });

  it("keeps the previous record when a later read fails", async () => {
    const view = await open("run-discuss", detail({ markdown: "# 笔记\n\n正文\n" }));
    await waitForText(view.container, "SafeMarkdown::# 笔记");
    client.getCliRun.mockRejectedValue(new Error("stale"));
    const { act } = await import("react");
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["cli-runs", "run-discuss"] });
    });
    await waitForText(view.container, "更新失败，当前显示上次成功读取的记录。");
    expect(view.container.textContent).toContain("SafeMarkdown::# 笔记");
    expect(view.container.textContent).toContain("正文");
    await clickButton(view.container, "重新读取");
    await settle();
    expect(view.container.textContent).toContain("更新失败，当前显示上次成功读取的记录。");
    expect(client.getCliRun.mock.calls.filter((call) => call[0] === "run-discuss").length).toBe(3);
  });

  it("drives the review workbench repair and follow-up actions", async () => {
    const against = deferred<ReturnType<typeof detail>>();
    client.getCliRun.mockImplementation((id: string) => {
      if (id === "against-1") return against.promise;
      return Promise.resolve(
        detail({
          runId: "run-review",
          kind: "review",
          markdown: REVIEW_MD,
          outerUsed: 2,
          outerMax: 10,
          lastError: null,
          reviewEvidence: {
            complete: true,
            sha: "a".repeat(40),
            prUrl: "https://github.com/acme/repo/pull/9",
            againstRunId: "against-1",
            blockingIds: [],
            unverifiedFixIds: [],
            openIds: [],
          },
          pipeline: {
            phase: "done",
            applyStatus: null,
            planVerdict: null,
            followUpRunId: "follow-1",
          },
        }),
      );
    });
    client.listCliRuns.mockResolvedValue({
      runs: [
        detail({
          runId: "repair-live",
          kind: "repair",
          status: "running",
          sourceRunId: "run-review",
          markdown: "",
        }),
        detail({ runId: "follow-1", kind: "review", title: "复审", markdown: "" }),
        detail({
          runId: "same-pr",
          kind: "review",
          markdown: "",
          reviewEvidence: { prUrl: "https://github.com/acme/repo/pull/9" },
        }),
      ],
    });
    client.listCliRepairProfiles.mockResolvedValue({
      profiles: [{ name: "default" }],
      sourceBranchHint: "feature/x",
      baseHint: "main",
      hintSource: "pr",
      bridgeAvailable: true,
      bridgeReason: "bridge-ok",
    });
    const view = await mountRouted(
      "/reports/run-review",
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(view);
    await waitForText(view.container, "profiles:default");
    expect(view.container.textContent).toContain("against:loading");
    expect(view.container.textContent).toContain("active:repair-live");
    expect(view.container.textContent).toContain("branch:feature/x");
    expect(view.container.textContent).toContain("base:main");
    expect(view.container.textContent).toContain("hint:pr");
    expect(view.container.textContent).toContain("bridge:yes");
    expect(view.container.textContent).toContain("bridge-reason:bridge-ok");
    expect(view.container.textContent).toContain("outer:2/10");
    expect(view.container.textContent).toContain("follow:follow-1");
    expect(view.container.textContent).toContain("bridge-loading:no");

    against.resolve(detail({ runId: "against-1", hasFindings: true, findings: [{ id: "f1" }] }));
    await waitForText(view.container, "against:ready");

    client.startCliRepair.mockResolvedValue({ runId: "ck-repair-new" });
    await clickButton(view.container, "启动修复");
    await settle();
    expect(client.startCliRepair.mock.calls).toEqual(
      [{ from: "run-review", profile: "default" }].map((row) => [row]),
    );
    expect(assigned).toEqual(["/reports/ck-repair-new"]);

    assigned.length = 0;
    client.startCliRepair.mockResolvedValueOnce({ runId: "run-review" });
    await clickButton(view.container, "启动默认修复");
    await settle();
    expect(client.startCliRepair.mock.calls.at(-1)).toEqual([
      { from: "run-review", profile: "default" },
    ]);
    expect(assigned).toEqual([]);

    client.stopCliRepair.mockResolvedValue({ ok: true });
    await clickButton(view.container, "停止修复");
    await settle();
    expect(client.stopCliRepair.mock.calls).toEqual([["run-review"]]);

    client.resumeCliRepair.mockResolvedValue({ ok: true });
    await clickButton(view.container, "继续修复");
    await settle();
    expect(client.resumeCliRepair.mock.calls).toEqual([["run-review"]]);

    client.saveCliRepairProfile.mockResolvedValue({ name: "saved" });
    client.startCliRepair.mockResolvedValueOnce({ runId: "ck-repair-saved" });
    await clickButton(view.container, "保存授权");
    await settle();
    expect(client.saveCliRepairProfile.mock.calls).toEqual([
      [
        {
          name: "saved",
          prUrl: "https://github.com/acme/repo/pull/9",
          repo: "github.com/acme/repo",
          sourceBranch: "fix/a",
          base: "main",
          capabilities: ["push-source-branch"],
          protocolVersion: "v2",
          isolationMode: "collaborative",
        },
      ],
    ]);
    expect(assigned).toContain("/reports/ck-repair-saved");

    await clickButton(view.container, "保存空授权");
    await waitForText(view.container, "repair-error:缺少启动摘要。");

    client.startCliRunAction.mockRejectedValueOnce(new RuntimeClientError(409, "conflict", "busy"));
    await clickButton(view.container, "发起修复");
    await waitForText(view.container, "pipeline-error:这条 run 已有进行中的修复或审查。");
    expect(timers.some((timer) => timer.delay === 1500)).toBe(true);

    client.startCliRunAction.mockRejectedValueOnce(new RuntimeClientError(404, "missing", "nope"));
    await clickButton(view.container, "发起复审");
    await waitForText(
      view.container,
      "pipeline-error:Host 还没有加载修复接口。请重启 Host（pnpm dev 或 pnpm start）后再点内置修复。",
    );

    client.startCliRunAction.mockRejectedValueOnce(
      new RuntimeClientError(403, "forbidden", "scope"),
    );
    await clickButton(view.container, "发起修复");
    await waitForText(view.container, "pipeline-error:没有权限启动修复（scope）。");

    client.startCliRunAction.mockRejectedValueOnce(new RuntimeClientError(500, "boom", ""));
    await clickButton(view.container, "发起修复");
    await waitForText(
      view.container,
      "pipeline-error:无法启动 councilkit。可先确认已 pnpm build:cli，并重启 Host。",
    );

    client.startCliRunAction.mockRejectedValueOnce("nope");
    await clickButton(view.container, "发起修复");
    await waitForText(view.container, "pipeline-error:启动失败");

    client.startCliRunAction.mockResolvedValueOnce({ ok: true });
    await clickButton(view.container, "发起复审");
    await settle();
    expect(client.startCliRunAction.mock.calls.at(-1)).toEqual(["run-review", "re-review"]);

    client.listCliRepairProfiles.mockRejectedValueOnce(
      new RuntimeClientError(405, "missing", "old"),
    );
    await clickButton(view.container, "刷新工作台");
    await settle();
    await settle();
  });

  it("reports a review that has no PR identity and an unavailable ledger", async () => {
    client.getCliRun.mockImplementation((id: string) =>
      Promise.resolve(
        detail({
          runId: id,
          kind: "review",
          markdown: REVIEW_MD,
          reviewEvidence: {
            complete: false,
            sha: null,
            prUrl: "",
            againstRunId: "against-missing",
            blockingIds: [],
            unverifiedFixIds: [],
            openIds: [],
          },
        }),
      ),
    );
    client.getCliRun.mockImplementation((id: string) => {
      if (id === "against-missing") return Promise.reject(new Error("gone"));
      return Promise.resolve(
        detail({
          runId: "run-review",
          kind: "review",
          reviewEvidence: {
            complete: false,
            sha: null,
            prUrl: "",
            againstRunId: "against-missing",
            blockingIds: [],
            unverifiedFixIds: [],
            openIds: [],
          },
        }),
      );
    });
    const view = await mountRouted(
      "/reports/run-review",
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(view);
    await waitForText(view.container, "against:unavailable");
    await clickButton(view.container, "保存授权");
    await waitForText(
      view.container,
      "repair-error:这份审查没有可用的 PR 身份，无法保存修复授权。",
    );
  });

  it("stops and resumes an automatic repair from its own shell", async () => {
    const gate = deferred<{ ok: true }>();
    client.stopCliRepair.mockReturnValue(gate.promise);
    client.resumeCliRepair.mockResolvedValue({ ok: true });
    const view = await open(
      "run-repair",
      detail({
        runId: "run-repair",
        kind: "repair",
        sourceRunId: "run-review",
        markdown: "",
      }),
    );
    await waitForText(view.container, "repair-run:run-repair");
    expect(view.container.querySelector('a[href="/reports/run-review"]')?.textContent).toBe(
      "查看源审查 ↗",
    );
    expect(view.container.querySelector('a[href="/reports"]')?.textContent).toBe("← 报告");
    await clickButton(view.container, "停止自动修复");
    await settle();
    expect(view.container.textContent).toContain("stop-pending:yes");
    gate.resolve({ ok: true });
    await settle();
    expect(client.stopCliRepair.mock.calls).toEqual([["run-repair"]]);
    await clickButton(view.container, "继续自动修复");
    await settle();
    expect(client.resumeCliRepair.mock.calls).toEqual([["run-repair"]]);
    await view.unmount();
    mounted.splice(0);

    const bare = await open(
      "run-repair-2",
      detail({ runId: "run-repair-2", kind: "repair", sourceRunId: null, markdown: "" }),
    );
    await waitForText(bare.container, "repair-run:run-repair-2");
    expect(bare.container.textContent).not.toContain("查看源审查");
  });

  it("refetches when a hidden page becomes visible and ignores an empty run id", async () => {
    setDocumentVisibility("hidden");
    client.getCliRun.mockResolvedValue(
      detail({ runId: "run-review", kind: "review", status: "running" }),
    );
    const view = await mountRouted(
      "/reports/run-review",
      "/reports/:runId",
      createElement(ReportDetailPage),
    );
    mounted.push(view);
    await waitForText(view.container, "启动修复");
    const reads = client.getCliRun.mock.calls.length;
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    await settle();
    expect(client.getCliRun.mock.calls.length).toBe(reads + 1);

    await view.unmount();
    mounted.splice(0);
    client.getCliRun.mockClear();
    const empty = await mountRouted("/plain", "/plain", createElement(ReportDetailPage));
    mounted.push(empty);
    expect(empty.container.textContent).toContain("正在打开报告…");
    expect(client.getCliRun.mock.calls).toEqual([]);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(client.getCliRun.mock.calls).toEqual([]);
  });
});
