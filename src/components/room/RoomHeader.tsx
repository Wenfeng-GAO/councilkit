import type { Room } from "@/models";

interface RoomHeaderProps {
  room: Room;
}

export function RoomHeader({ room }: RoomHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-edge px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-fg">{room.topic}</h1>
        <p className="text-xs text-muted">
          状态: {room.status} · 轮次: {room.roundIds.length}
        </p>
      </div>
    </header>
  );
}
