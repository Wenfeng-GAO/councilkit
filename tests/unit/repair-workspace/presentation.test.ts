import { describe, expect, it } from "vitest";
import {
  activityPresentation,
  goalPresentation,
  relativeTime,
  roleName,
} from "@/components/report/repair-workspace/presentation";
import type { RepairOperation } from "@shared/runtime/repair-observation";
const op = (patch: Partial<RepairOperation>): RepairOperation => ({
  eventId: "event",
  sourceId: "source",
  sourceGeneration: "one",
  executionRef: "exec",
  round: 1,
  roleKey: "builder",
  operationId: "op",
  revision: 1,
  occurredAt: null,
  receivedAt: "2026-09-22T12:00:00Z",
  kind: "file",
  status: "completed",
  summary:
    "读取 /Users/test/.config/councilkit/repair-workspaces/run/.worktrees/task/pkg/runtime/manager/session_manager.go",
  detailRef: "event",
  truncated: false,
  ...patch,
});
describe("repair presentation", () => {
  it("uses a short proven PR identity instead of a URL as the main title", () => {
    expect(
      goalPresentation("https://code.alipay.com/paas-core/agentrun/pull_requests/128"),
    ).toEqual({
      title: "agentrun #128",
      goal: null,
      url: "https://code.alipay.com/paas-core/agentrun/pull_requests/128",
    });
  });
  it("preserves a real goal and never invents one", () => {
    expect(goalPresentation("恢复会话")).toMatchObject({ title: "恢复会话", goal: "恢复会话" });
    expect(goalPresentation(null).title).toBe("自动修复");
  });
  it("keeps the raw operation intact but removes machine prefixes from the row", () => {
    const source = op({});
    const row = activityPresentation(source);
    expect(row.title).toBe("读取 session_manager.go");
    expect(row.context).toBe("pkg/runtime/manager");
    expect(row.status).toBe("已执行");
    expect(source.summary).toContain("/Users/test/");
  });
  it("keeps long command contents in the source and presents an operation rather than an internal class", () => {
    const source = op({
      kind: "command",
      summary: "shellToolCall go test -mod=vendor -count=1 ./pkg/runtime/manager/",
      status: "started",
    });
    expect(activityPresentation(source).title).toBe("运行测试");
    expect(activityPresentation(source).context).not.toContain("shellToolCall");
    expect(activityPresentation(source, true).status).toBe("记录未收尾");
  });
  it("does not turn returned file content into the filename", () => {
    const row = activityPresentation(
      op({ summary: "读取 /fixture/pkg/session.go package manager" }),
    );
    expect(row.title).toBe("读取 session.go");
  });
  it("does not claim that a completed tool succeeded", () => {
    expect(activityPresentation(op({})).status).not.toBe("成功");
  });
  it("formats dates and unknown times without exposing an ISO blob", () => {
    expect(relativeTime("2026-09-22T12:00:00Z", "2026-09-22T12:04:00Z")).toBe("4 分钟前");
    expect(relativeTime(null, "2026-09-22T12:04:00Z")).toBe("未记录");
  });
  it("translates known roles and leaves distinct custom labels intact", () => {
    expect(roleName("builder")).toBe("编排与开发");
    expect(roleName("custom", "安全审查")).toBe("安全审查");
  });
});
