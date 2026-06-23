import { RoomListItem } from "@/components/room/RoomListItem";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { listRooms } from "@/lib/db";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

export function HomePage() {
  const { data: rooms } = useQuery({ queryKey: ["rooms"], queryFn: listRooms });

  return (
    <div className="px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">讨论房间</h1>
        <Link to="/rooms/new">
          <Button>新建房间</Button>
        </Link>
      </div>
      {!rooms || rooms.length === 0 ? (
        <EmptyState title="还没有房间" hint="新建一个房间来发起多 agent 讨论。" />
      ) : (
        <div className="grid gap-2">
          {rooms.map((r) => (
            <RoomListItem key={r.id} room={r} />
          ))}
        </div>
      )}
    </div>
  );
}
