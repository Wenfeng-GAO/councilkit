import { formatAttemptMs } from "@/lib/seat-inspector";
import { reviewSeatTitle } from "@/lib/seat-label";
import type { ComponentType } from "react";
import {
  CircleHelpIcon,
  Layers2Icon,
  LayoutListIcon,
  SEAT_ROLE_ICONS,
  STATUS_ICONS,
  type WorkbenchIconProps,
  WrenchIcon,
} from "./icons";
import { type WorkbenchAttempt, useWorkbenchSelection } from "./selection";

/** 执行状态 → 状态文字（DETAIL-SPEC §4：中性表述，执行完成绝不暗示审查通过）。 */
const STATUS_TEXT: Record<WorkbenchAttempt["status"], string> = {
  pending: "等待启动",
  queued: "排队中",
  running: "执行中",
  success: "执行完成",
  failure: "执行失败",
  cancelled: "已取消",
};

/** 按 agentName/角色关键词匹配职责图标；匹配不到退回 CircleHelp。 */
function seatRoleIcon(agentName: string): ComponentType<WorkbenchIconProps> {
  const name = agentName.toLowerCase();
  for (const key of Object.keys(SEAT_ROLE_ICONS)) {
    if (name.includes(key)) return SEAT_ROLE_ICONS[key] ?? CircleHelpIcon;
  }
  return CircleHelpIcon;
}

function SeatRow({
  attempt,
  current,
  onSelect,
}: {
  attempt: WorkbenchAttempt;
  current: boolean;
  onSelect: (attemptId: string) => void;
}) {
  const RoleIcon = attempt.role === "aggregator" ? Layers2Icon : seatRoleIcon(attempt.agentName);
  const StatusIcon = STATUS_ICONS[attempt.status] ?? CircleHelpIcon;
  return (
    <button
      type="button"
      className="ck-wb-seat-row"
      aria-current={current}
      onClick={() => onSelect(attempt.attemptId)}
    >
      <RoleIcon className="ck-wb-icon" />
      <span className="ck-wb-seat-copy">
        <b>{reviewSeatTitle(attempt)}</b>
        <small>
          <StatusIcon
            className={`ck-wb-icon ck-wb-icon-state${attempt.status === "running" ? " ck-wb-running-icon" : ""}`}
          />
          {STATUS_TEXT[attempt.status]}
          {attempt.durationMs !== null ? (
            <span className="ck-wb-time">{formatAttemptMs(attempt.durationMs)}</span>
          ) : null}
        </small>
      </span>
    </button>
  );
}

/**
 * 248px 席位列。顺序永远按 progress.attempts 声明序（review.started 的 attempts 顺序），
 * 不因状态/完成时间重排；Aggregator 置于独立「汇总」组，不冒充额外审查席。
 */
export function SeatColumn({
  attempts,
  hasRepair,
}: {
  attempts: WorkbenchAttempt[];
  hasRepair: boolean;
}) {
  const { selected, select } = useWorkbenchSelection();
  const seats = attempts.filter((row) => row.role === "attempt");
  const aggregators = attempts.filter((row) => row.role === "aggregator");

  return (
    <aside className="ck-wb-seats" aria-label="审查席位">
      <button
        type="button"
        className="ck-wb-overview"
        aria-current={selected === "overview"}
        onClick={() => select("overview")}
      >
        <LayoutListIcon className="ck-wb-icon" />
        本轮总览
      </button>
      {hasRepair ? (
        <button
          type="button"
          className="ck-wb-overview"
          aria-current={selected === "repair"}
          onClick={() => select("repair")}
        >
          <WrenchIcon className="ck-wb-icon" />
          当前修复
        </button>
      ) : null}
      <div className="ck-wb-section-label">审查席位</div>
      {seats.map((attempt) => (
        <SeatRow
          key={attempt.attemptId}
          attempt={attempt}
          current={selected === attempt.attemptId}
          onSelect={select}
        />
      ))}
      {aggregators.length > 0 ? (
        <div className="ck-wb-aggregate">
          <div className="ck-wb-section-label">汇总</div>
          {aggregators.map((attempt) => (
            <SeatRow
              key={attempt.attemptId}
              attempt={attempt}
              current={selected === attempt.attemptId}
              onSelect={select}
            />
          ))}
        </div>
      ) : null}
    </aside>
  );
}
