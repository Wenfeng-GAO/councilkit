import type { RepairRole } from "@shared/runtime/repair-observation";
import { IconActivity, IconCheck, IconCircleX, IconClock } from "./icons";

function StatusIcon({ status }: { status: RepairRole["status"] }) {
  if (status === "active") return <IconActivity />;
  if (status === "ended") return <IconCheck />;
  if (status === "failed") return <IconCircleX />;
  return <IconClock />;
}

function statusLabel(status: RepairRole["status"]): string {
  switch (status) {
    case "active":
      return "活动中";
    case "ended":
      return "已结束";
    case "failed":
      return "失败";
    case "pending":
      return "待启动";
    default:
      return "未知";
  }
}

export function RepairRoles({
  roles,
  selected,
  onSelect,
}: {
  roles: RepairRole[];
  selected: string;
  onSelect: (roleKey: string) => void;
}) {
  const items = [{ roleKey: "all", label: "全部活动", status: "active" as const }, ...roles];
  return (
    <aside className="ck-repair-roles" data-testid="repair-role-list" aria-label="执行角色">
      {items.map((role) => {
        const key = role.roleKey;
        const label = "label" in role ? role.label : "全部活动";
        const status = "status" in role ? role.status : "active";
        return (
          <button
            key={key}
            type="button"
            className={`ck-repair-role${selected === key ? " is-selected" : ""}`}
            data-testid={`repair-role-${key}`}
            aria-pressed={selected === key}
            onClick={() => onSelect(key)}
          >
            <StatusIcon status={status} />
            <span className="ck-repair-role-label">{label}</span>
            <span className="ck-repair-role-status">{statusLabel(status)}</span>
          </button>
        );
      })}
    </aside>
  );
}
