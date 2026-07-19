import { RoomListItem } from "@/components/room/RoomListItem";
import { type UsageTotals, addUsage, emptyUsageTotals } from "@/components/room/UsageBadge";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import { deleteRoomCascade, duplicateRoom, renameRoom } from "@/lib/room-admin";
import { runtimeDb } from "@/lib/runtime-db";
import type { DiscussionRoom } from "@/models/discussion/entities";
import { getAppRuntime } from "@/runtime/bootstrap";
import { runtimeKeys, useRuntimeRooms } from "@/stores/runtime-queries";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router-dom";

export type RoomSortOrder = "recent" | "cost";

/**
 * S7：房间列表排序纯函数（页面导出供单测，parseMaxRoundsInput 先例）。
 * - recent（默认）：lastActiveAt 降序。
 * - cost：全部已落库执行的 costUsd 累计降序（裁决 #7，不引入时钟窗口）；
 *   无成本数据的房间排尾。比较相等时返回 0，依赖稳定排序保持原相对顺序。
 */
export function sortRooms(
  rooms: readonly DiscussionRoom[],
  order: RoomSortOrder,
  usageByRoom?: ReadonlyMap<string, UsageTotals>,
): DiscussionRoom[] {
  return [...rooms].sort((a, b) => {
    if (order === "cost") {
      const totalsA = usageByRoom?.get(a.id);
      const totalsB = usageByRoom?.get(b.id);
      const costA = totalsA?.hasCost ? totalsA.costUsd : null;
      const costB = totalsB?.hasCost ? totalsB.costUsd : null;
      if (costA === null && costB === null) return 0;
      if (costA === null) return 1; // 无成本数据排尾
      if (costB === null) return -1;
      return costB - costA;
    }
    if (a.lastActiveAt === b.lastActiveAt) return 0;
    return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
  });
}

/**
 * S7 段 1：搜索过滤纯函数（段 2 才接搜索框 UI）。大小写不敏感的 topic 命中，
 * 或 roomId 落在消息内容命中集合 `matchedRoomIds` 内（消息扫描由调用方做，
 * content 无索引、Dexie cursor 扫描——brief 允许，千级行内可接受）。
 * 空 query 返回全量。
 */
export function filterRooms(
  rooms: readonly DiscussionRoom[],
  query: string,
  matchedRoomIds?: ReadonlySet<string>,
): DiscussionRoom[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...rooms];
  return rooms.filter(
    (room) => room.topic.toLowerCase().includes(q) || (matchedRoomIds?.has(room.id) ?? false),
  );
}

/**
 * HomePage 段 2 接线：工具行（搜索 + 排序）与每行操作组（重命名/复制/删除）。
 * 两个内联 useQuery 均以 "rt" 前缀入 key，Orchestrator 显示桥与本页操作后的
 * `invalidateQueries({ queryKey: runtimeKeys.all })` 前缀失效自动覆盖：
 * - room-usage-index：modelExecutions 一次全量聚合 per roomId（裁决 #7 的
 *   成本排序数据源），仅在排序为 cost 时启用。
 * - room-message-search：content 无索引的 Dexie cursor 全表扫描（brief 允许，
 *   千级行内可接受），useDeferredValue 吸收击键风暴 + keepPreviousData 防闪烁。
 */
export function HomePage() {
  const { data: rooms } = useRuntimeRooms();
  const { orchestrator } = getAppRuntime();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sortOrder, setSortOrder] = useState<RoomSortOrder>("recent");

  // 行操作状态：重命名 Modal / 删除确认 Modal / 复制直执。
  const [renaming, setRenaming] = useState<DiscussionRoom | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [deleting, setDeleting] = useState<DiscussionRoom | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: runtimeKeys.all });

  const usageIndexQuery = useQuery({
    queryKey: ["rt", "room-usage-index"],
    enabled: sortOrder === "cost",
    queryFn: async () => {
      const executions = await runtimeDb.modelExecutions.toArray();
      const byRoom = new Map<string, UsageTotals>();
      for (const execution of executions) {
        byRoom.set(
          execution.roomId,
          addUsage(byRoom.get(execution.roomId) ?? emptyUsageTotals(), execution.usage),
        );
      }
      return byRoom;
    },
  });

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const searchQuery = useQuery({
    queryKey: ["rt", "room-message-search", normalizedQuery],
    enabled: normalizedQuery.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const ids = new Set<string>();
      await runtimeDb.messages
        .filter((message) => message.content.toLowerCase().includes(normalizedQuery))
        .each((message) => {
          ids.add(message.roomId);
        });
      return ids;
    },
  });

  const visibleRooms = useMemo(() => {
    const filtered = filterRooms(rooms ?? [], deferredQuery, searchQuery.data);
    return sortRooms(filtered, sortOrder, usageIndexQuery.data);
  }, [rooms, deferredQuery, searchQuery.data, sortOrder, usageIndexQuery.data]);

  const openRename = (room: DiscussionRoom) => {
    setRenaming(room);
    setRenameText(room.topic);
    setRenameError(null);
  };
  const closeRename = () => setRenaming(null);

  const handleRenameSubmit = async () => {
    if (!renaming) return;
    const topic = renameText.trim();
    if (topic.length === 0) {
      setRenameError("请输入新话题。");
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      await renameRoom(runtimeDb, orchestrator, renaming.id, topic);
      setRenaming(null);
      await refresh();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenamePending(false);
    }
  };

  const handleDuplicate = async (room: DiscussionRoom) => {
    setDuplicatingId(room.id);
    setDuplicateError(null);
    try {
      await duplicateRoom(runtimeDb, orchestrator, room.id);
      await refresh();
    } catch (error) {
      setDuplicateError(
        `复制「${room.topic}」失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setDuplicatingId(null);
    }
  };

  const openDelete = (room: DiscussionRoom) => {
    setDeleting(room);
    setDeleteError(null);
  };
  const closeDelete = () => setDeleting(null);

  // releaseRuntime 的拒绝（活执行/未解决轮）是正常路径：错误必须留在确认
  // Modal 里可见（plan-a §5-6），而非无声失败。
  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await deleteRoomCascade(runtimeDb, orchestrator, deleting.id);
      setDeleting(null);
      await refresh();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <div className="px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">讨论房间</h1>
        <Link to="/rooms/new">
          <Button>新建房间</Button>
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <TextInput
          label="搜索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="话题或消息内容"
          className="w-64"
        />
        <Select
          label="排序"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value as RoomSortOrder)}
          options={[
            { value: "recent", label: "最近活跃" },
            { value: "cost", label: "按成本排序" },
          ]}
        />
      </div>
      {duplicateError ? (
        <p role="alert" className="mb-3 text-sm text-error">
          {duplicateError}
        </p>
      ) : null}
      {!rooms || rooms.length === 0 ? (
        <EmptyState
          title="还没有房间"
          hint="新建一个房间来发起多 Agent 讨论。V1 不会导入旧版本地数据，但也没有删除它。"
        />
      ) : visibleRooms.length === 0 ? (
        <EmptyState title="没有匹配的房间" hint="换个搜索关键词试试。" />
      ) : (
        <div className="grid gap-2">
          {visibleRooms.map((room) => (
            <div key={room.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <RoomListItem room={room} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => openRename(room)}
                >
                  重命名
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={duplicatingId === room.id}
                  onClick={() => void handleDuplicate(room)}
                >
                  {duplicatingId === room.id ? "复制中…" : "复制"}
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => openDelete(room)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={renaming !== null} onClose={closeRename} title="重命名房间">
        <div className="flex flex-col gap-3">
          <TextInput
            label="新话题"
            value={renameText}
            onChange={(event) => {
              setRenameText(event.target.value);
              setRenameError(null);
            }}
          />
          <p className="text-xs text-muted">
            重命名会推进共享上下文版本；进行中的生成将因上下文过期而中断。
          </p>
          {renameError ? (
            <p role="alert" className="text-sm text-error">
              {renameError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeRename}>
              取消
            </Button>
            <Button disabled={renamePending} onClick={() => void handleRenameSubmit()}>
              {renamePending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={deleting !== null} onClose={closeDelete} title="删除房间？">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg">
            将删除房间「{deleting?.topic}
            」的全部轮次、消息、总结、执行记录与报告。此操作不可撤销。
          </p>
          {deleteError ? (
            <div className="flex flex-col gap-1">
              <p role="alert" className="text-sm text-error">
                {deleteError}
              </p>
              <p className="text-xs text-muted">请先恢复或终止该房间进行中的轮次，再重试删除。</p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeDelete}>
              取消
            </Button>
            <button
              type="button"
              disabled={deletePending}
              onClick={() => void handleDeleteConfirm()}
              className="rounded border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
            >
              {deletePending ? "删除中…" : "确认删除"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
