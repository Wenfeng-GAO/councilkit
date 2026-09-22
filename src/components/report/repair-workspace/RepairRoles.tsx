import type { RepairRole } from "@shared/runtime/repair-observation";
import { IconActivity, IconCheck, IconCircleX, IconClock } from "./icons";
import { roleName } from "./presentation";
const LABEL = {
  active: "执行中",
  ended: "执行结束",
  failed: "执行失败",
  pending: "等待启动",
  unknown: "状态待确认",
};
export function RepairRoles({
  roles,
  selected,
  onSelect,
}: { roles: RepairRole[]; selected: string; onSelect: (key: string) => void }) {
  const active = roles.filter((r) => r.status === "active").length;
  return (
    <aside className="ck-repair-roles" data-testid="repair-role-list" aria-label="执行角色">
      <div className="ck-repair-section-label">本轮执行</div>
      <button
        type="button"
        className={`ck-repair-role${selected === "all" ? " is-selected" : ""}`}
        data-testid="repair-role-all"
        aria-pressed={selected === "all"}
        onClick={() => onSelect("all")}
      >
        <IconActivity />
        <span className="ck-repair-role-copy">
          <span className="ck-repair-role-label">全部活动</span>
          <span className="ck-repair-role-status">
            {active ? `${active} 个执行正在进行` : "查看本轮执行记录"}
          </span>
        </span>
      </button>
      <div className="ck-repair-role-divider" />
      {roles.map((role) => {
        const Icon =
          role.status === "active"
            ? IconActivity
            : role.status === "ended"
              ? IconCheck
              : role.status === "failed"
                ? IconCircleX
                : IconClock;
        return (
          <button
            key={role.roleKey}
            type="button"
            className={`ck-repair-role is-${role.status}${selected === role.roleKey ? " is-selected" : ""}`}
            data-testid={`repair-role-${role.roleKey}`}
            aria-pressed={selected === role.roleKey}
            onClick={() => onSelect(role.roleKey)}
          >
            <Icon />
            <span className="ck-repair-role-copy">
              <span className="ck-repair-role-label">{roleName(role.roleKey, role.label)}</span>
              <span className="ck-repair-role-status">{LABEL[role.status]}</span>
            </span>
          </button>
        );
      })}
      <p className="ck-repair-role-foot">选择执行，查看对应活动与证据。</p>
    </aside>
  );
}
