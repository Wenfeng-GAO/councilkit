import type { RepairOperation } from "@shared/runtime/repair-observation";
import { IconActivity, IconArrowDown, IconFiles, IconSearch } from "./icons";

const KIND_LABEL: Record<RepairOperation["kind"], string> = {
  progress: "进展",
  tool: "工具",
  file: "文件",
  command: "命令",
  state: "状态",
};

export function RepairActivity({
  operations,
  hiddenCount,
  newCount,
  pinned,
  emptyReason,
  filter,
  onFilter,
  onClearFilter,
  onToggleFollow,
  onViewNew,
  onLoadEarlier,
  onOpen,
  listRef,
}: {
  operations: RepairOperation[];
  hiddenCount: number;
  newCount: number;
  pinned: boolean;
  emptyReason: "waiting" | "filter" | "none";
  filter: { roleKey: string; kind: string; query: string };
  onFilter: (patch: Partial<{ roleKey: string; kind: string; query: string }>) => void;
  onClearFilter: () => void;
  onToggleFollow: () => void;
  onViewNew: () => void;
  onLoadEarlier: () => void;
  onOpen: (eventId: string, trigger: HTMLElement) => void;
  listRef: { current: HTMLUListElement | null };
}) {
  return (
    <section className="ck-repair-activity" aria-label="活动">
      <div className="ck-repair-toolbar">
        <label className="ck-repair-filter">
          <span className="ck-repair-sr">角色筛选</span>
          <select
            data-testid="repair-filter-role"
            value={filter.roleKey}
            onChange={(e) => onFilter({ roleKey: e.target.value })}
          >
            <option value="all">全部角色</option>
            <option value="builder">编排与开发</option>
            <option value="reviewer">独立评审</option>
            <option value="verifier">独立验证</option>
          </select>
        </label>
        <label className="ck-repair-filter">
          <span className="ck-repair-sr">类型筛选</span>
          <select
            data-testid="repair-filter-kind"
            value={filter.kind}
            onChange={(e) => onFilter({ kind: e.target.value })}
          >
            <option value="all">全部类型</option>
            <option value="tool">工具</option>
            <option value="progress">进展</option>
            <option value="state">状态</option>
          </select>
        </label>
        <label className="ck-repair-filter ck-repair-filter-query">
          <IconSearch />
          <span className="ck-repair-sr">关键词</span>
          <input
            data-testid="repair-filter-query"
            value={filter.query}
            placeholder="搜索已加载记录"
            onChange={(e) => onFilter({ query: e.target.value })}
          />
        </label>
        <button type="button" data-testid="repair-filter-clear" className="ck-repair-btn" onClick={onClearFilter}>
          清除筛选
        </button>
        <button
          type="button"
          data-testid="repair-follow-toggle"
          className="ck-repair-btn"
          onClick={onToggleFollow}
        >
          {pinned ? "暂停跟随" : "恢复跟随"}
        </button>
        {newCount > 0 ? (
          <button type="button" data-testid="repair-new-count" className="ck-repair-btn accent" onClick={onViewNew}>
            有{newCount}条新活动 · 查看
          </button>
        ) : null}
      </div>
      <p className="ck-repair-meta">
        已加载 {operations.length} 条
        {hiddenCount > 0 ? ` · 有更早记录` : ""}
        （仅搜索已加载范围）
      </p>
      {hiddenCount > 0 ? (
        <button type="button" data-testid="repair-load-earlier" className="ck-repair-btn" onClick={onLoadEarlier}>
          <IconArrowDown /> 加载更早
        </button>
      ) : null}
      {emptyReason === "waiting" ? (
        <p data-testid="repair-empty" className="ck-repair-empty">
          等待首条记录
        </p>
      ) : null}
      {emptyReason === "filter" ? (
        <p data-testid="repair-empty" className="ck-repair-empty">
          已加载记录中无匹配项。可清除筛选。
        </p>
      ) : null}
      <ul
        className="ck-repair-activity-list"
        data-testid="repair-activity-list"
        ref={(node) => {
          listRef.current = node;
        }}
      >
        {operations.map((op) => (
          <li key={op.eventId}>
            <button
              type="button"
              className="ck-repair-activity-row"
              data-testid={`repair-activity-row-${op.eventId}`}
              data-event-id={op.eventId}
              onClick={(e) => onOpen(op.eventId, e.currentTarget)}
            >
              {op.kind === "file" ? <IconFiles /> : <IconActivity />}
              <span className="ck-repair-row-kind">{KIND_LABEL[op.kind]}</span>
              <span className="ck-repair-row-role">{op.roleKey}</span>
              <span className="ck-repair-row-summary">{op.summary}</span>
              <span className="ck-repair-row-time">{op.occurredAt ?? "未记录"}</span>
              <span className="ck-repair-row-status">{op.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
