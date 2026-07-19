import { StatusPill } from "@/components/shared/StatusPill";
import type { DiscussionRoom, RoomRunState } from "@/models/discussion/entities";
import { Link } from "react-router-dom";

interface RoomListItemProps {
  room: DiscussionRoom;
}

const RUN_STATE_PILL: Record<RoomRunState, { tone: "muted" | "info" | "warn"; text: string }> = {
  idle: { tone: "muted", text: "空闲" },
  running: { tone: "info", text: "运行中" },
  paused: { tone: "warn", text: "已暂停调度" },
};

export function RoomListItem({ room }: RoomListItemProps) {
  const pill = RUN_STATE_PILL[room.runState];
  const concluded = room.status === "concluded";
  return (
    <Link
      to={`/rooms/${room.id}${concluded ? "#report" : ""}`}
      className="block rounded border border-edge bg-surface px-4 py-3 hover:border-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-fg">{room.topic}</p>
        <div className="flex items-center gap-1.5">
          <StatusPill tone={pill.tone} text={pill.text} />
          {concluded ? <StatusPill tone="success" text="已结束" /> : null}
        </div>
      </div>
      <p className="text-xs text-muted">{new Date(room.lastActiveAt).toLocaleString()}</p>
      {concluded ? <span className="text-xs text-accent">查看报告 →</span> : null}
    </Link>
  );
}
