import type { RepairOperation } from "@shared/runtime/repair-observation";

export function goalPresentation(value?: string | null) {
  const text = value?.trim() ?? "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("not a source URL");
    const match = url.pathname.match(/\/([^/]+)\/(?:pull_requests|pull)\/(\d+)/);
    return {
      title: match ? `${decodeURIComponent(match[1])} #${match[2]}` : "自动修复",
      goal: null,
      url: url.href,
    };
  } catch {
    return { title: text || "自动修复", goal: text || null, url: null };
  }
}

export function roleName(key: string, label?: string): string {
  const names: Record<string, string> = {
    builder: "编排与开发",
    orchestrator: "编排",
    planner_a: "规划",
    planner_b: "独立规划",
    coder: "开发",
    reviewer: "独立评审",
    verifier: "独立验证",
  };
  return names[key] ?? label ?? key;
}
export function phaseName(phase?: string | null): string {
  const names: Record<string, string> = {
    active: "执行中",
    intent: "准备执行",
    preparing: "准备执行",
    "repair-preparing": "准备执行",
    planning: "规划中",
    implementing: "编码修复中",
    fixing: "修复中",
    auditing: "核对改动",
    snapshotting: "保存候选",
    reviewing: "独立核验中",
    "repair-reviewing": "独立核验中",
    reviewed: "核验结束",
    integrating: "最终核验中",
    "repair-finalizing": "最终核验中",
    closed: "执行结束",
    gated: "核验结束",
    done: "执行结束",
  };
  return (phase && names[phase]) || "等待执行状态";
}
export function relativeTime(value: string | null | undefined, now: string): string {
  const at = value ? Date.parse(value) : NaN;
  const end = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(end)) return "未记录";
  const secs = Math.max(0, Math.floor((end - at) / 1000));
  if (secs < 10) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}
export function eventTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function compactPath(raw: string): string {
  const text = raw.replace(/\\/g, "/").replace(/^['"]|['"]$/g, "");
  const worktree =
    text.match(/\/\.worktrees\/[^/]+\/(.+)$/) ?? text.match(/\/repair-workspaces\/[^/]+\/(.+)$/);
  if (worktree) return worktree[1];
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text))
    return text.split("/").filter(Boolean).slice(-3).join("/");
  return text;
}
function compactPaths(text: string) {
  return text.replace(/\/(?:Users|home|private|var|tmp)\/[^\s'";]+/g, compactPath);
}
export function activityPresentation(op: RepairOperation, executionEnded = false) {
  const raw = op.summary.replace(/\s+未记录(?:\s+未记录)*$/, "").trim();
  let title = raw || "活动记录";
  let context = "";
  if (op.kind === "file") {
    const match = raw.match(/^(读取|修改|写入|创建)\s+(.+)$/);
    if (match) {
      const pathText =
        match[2].match(/^(.*?\.[A-Za-z0-9_+-]{1,12})(?=\s|$)/)?.[1] ?? match[2].split("\n")[0];
      const path = compactPath(pathText);
      const parts = path.split("/");
      title = `${match[1]} ${parts.pop() ?? path}`;
      context = parts.join("/");
    }
  } else if (op.kind === "command") {
    context = compactPaths(raw.replace(/^shellToolCall\s*/i, ""));
    title = /\b(?:go test|vitest|playwright|pytest|npm test|pnpm test)\b/.test(context)
      ? "运行测试"
      : /\bgofmt\b/.test(context)
        ? "格式化代码"
        : "执行命令";
  } else if (op.kind === "tool") {
    const tools: Record<string, string> = {
      grepToolCall: "搜索代码",
      readToolCall: "读取文件",
      editToolCall: "修改文件",
      globToolCall: "查找文件",
      shellToolCall: "执行命令",
    };
    const name = raw.match(/^(\w+ToolCall)\b/)?.[1];
    if (name) {
      title = tools[name] ?? "工具操作";
      context = compactPaths(raw.slice(name.length).trim());
    }
  }
  const status = {
    started: executionEnded ? "记录未收尾" : "执行中",
    completed: "已执行",
    failed: "执行失败",
    unfinished: "记录未收尾",
    unknown: "状态未知",
  }[op.status];
  return { title: compactPaths(title), context, status, time: eventTime(op.occurredAt) };
}
