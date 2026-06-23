import type { Room } from "@/models";
import { Link } from "react-router-dom";

interface RoomListItemProps {
  room: Room;
}

export function RoomListItem({ room }: RoomListItemProps) {
  return (
    <Link
      to={`/rooms/${room.id}`}
      className="block rounded border border-edge bg-surface px-4 py-3 hover:border-accent"
    >
      <p className="truncate text-sm font-medium text-fg">{room.topic}</p>
      <p className="text-xs text-muted">
        {new Date(room.lastActiveAt).toLocaleString()} · {room.roundIds.length} 轮
      </p>
    </Link>
  );
}
