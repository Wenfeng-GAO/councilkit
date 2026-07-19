import type { RoundPauseReason } from "@/models/discussion/entities";

/**
 * Pause-reason copy (U6): every RoundPauseReason.code maps to an exact,
 * user-facing explanation plus repair entries. The PausedPanel renders the
 * mapped copy verbatim — codes never appear raw in the UI. Pure module, unit
 * tested in tests/unit/pause-reasons.test.ts.
 */

export interface PauseRepairEntry {
  href:
    | "/settings"
    | "/settings#settings-installations"
    | "/settings#settings-agents"
    | "/rooms/new";
  label: string;
}

export interface PauseReasonCopy {
  /** One-line headline naming what happened. */
  title: string;
  /** What the product did about it (kept messages / dropped preview). */
  description: string;
  /** Repair affordances, in the order they should be tried. */
  repair: PauseRepairEntry[];
}

// S8 直达链接：段级锚点对齐 SettingsPage 的 section id（settings-installations /
// settings-agents），SettingsPage 的 hash-scroll effect 在段 2 补齐后即直达。
const SETTINGS_PROFILES: PauseRepairEntry = {
  href: "/settings#settings-installations",
  label: "前往 Runtime 设置的 Installations 段检查 Installation 与登录状态",
};
const SETTINGS_MODEL: PauseRepairEntry = {
  href: "/settings#settings-agents",
  label: "前往设置的 Agents 段检查该 Agent 的 Profile 与 modelId",
};
const NEW_ROOM: PauseRepairEntry = { href: "/rooms/new", label: "重新开始一个新房间" };

export const PAUSE_REASON_COPY: Record<RoundPauseReason["code"], PauseReasonCopy> = {
  prewarm_failed: {
    title: "执行环境预热失败",
    description: "至少一名 Participant 的本地执行环境未就绪，本轮已在任何人发言前暂停。",
    repair: [SETTINGS_PROFILES],
  },
  facilitator_unavailable: {
    title: "Facilitator 不可用",
    description: "指定的 Facilitator 无法生成总结；不会自动改用其他 Participant。",
    repair: [SETTINGS_MODEL, NEW_ROOM],
  },
  model_mismatch: {
    title: "实际模型与配置不一致",
    description: "Host 报告的 effective model 与 Agent 配置的 modelId 不符，本次输出已丢弃。",
    repair: [SETTINGS_MODEL],
  },
  tool_state_unknown: {
    title: "工具状态不可证明",
    description: "执行期间的工具活动无法被证明为安全，生成预览已丢弃、未写入讨论记录。",
    repair: [SETTINGS_PROFILES],
  },
  stale_context: {
    title: "上下文已过期",
    description: "执行期间讨论内容或 Participant 配置发生了变化，过期的结果已丢弃。",
    repair: [NEW_ROOM],
  },
  empty_output: {
    title: "模型返回空输出",
    description: "本次执行完成但没有可用正文，未写入讨论记录。",
    repair: [SETTINGS_MODEL],
  },
  needs_rebase: {
    title: "执行 Session 需要重建",
    description: "Participant 的长期 Session 无法与讨论记录衔接，本轮无法继续。",
    repair: [NEW_ROOM],
  },
  execution_failed: {
    title: "执行失败",
    description: "Host 报告执行失败，没有可提交的结果；本轮已保留之前的所有发言。",
    repair: [SETTINGS_PROFILES],
  },
  user_cancelled: {
    title: "已手动停止生成",
    description: "你停止了本次生成；未提交的输出已丢弃，本轮已提交的发言全部保留。",
    repair: [],
  },
};

/** Exact mapped copy for one pause code. */
export function pauseReasonCopy(code: RoundPauseReason["code"]): PauseReasonCopy {
  return PAUSE_REASON_COPY[code];
}
