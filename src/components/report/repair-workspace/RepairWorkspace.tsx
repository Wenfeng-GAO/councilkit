import { filterOperations } from "@shared/runtime/repair-observation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RepairActivity } from "./RepairActivity";
import { RepairEventDrawer } from "./RepairEventDrawer";
import { RepairEvidencePanel } from "./RepairEvidence";
import { RepairRoles } from "./RepairRoles";
import { buildRepairViewModel } from "./repairViewModel";
import { useRepairObservation } from "./useRepairObservation";

export function RepairWorkspace({
  runId,
  sourceRunId,
  onStop,
  onResume,
  stopPending = false,
}: {
  runId: string;
  sourceRunId?: string | null;
  onStop?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  stopPending?: boolean;
}) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const getScroller = useCallback(() => listRef.current ?? scrollerRef.current, []);
  const obs = useRepairObservation({ runId, getScroller });
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmStop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConfirmStop(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmStop]);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stopOnceRef = useRef(false);

  const selectedOp = useMemo(() => {
    if (!obs.reading.selectedEventId || !obs.observation) return null;
    return obs.observation.upserts.find((op) => op.eventId === obs.reading.selectedEventId) ?? null;
  }, [obs.observation, obs.reading.selectedEventId]);

  const vm = buildRepairViewModel({
    observation: obs.observation,
    connectionLost: obs.connectionLost,
    selectedRound: obs.reading.round,
    filter: {
      roleKey: obs.reading.roleKey,
      kind: obs.reading.kind,
      query: obs.reading.query,
    },
    stopAckPending: obs.stopAckPending || stopPending,
    evidenceGateConsistent: obs.evidence?.gateConsistent,
  });

  const filteredWindow = filterOperations(obs.windowed.window, {
    roleKey: obs.reading.roleKey,
    kind: obs.reading.kind,
    query: obs.reading.query,
  });

  const rounds = useMemo(() => {
    const current = obs.observation?.currentRound ?? 1;
    return Array.from({ length: current }, (_, i) => i + 1);
  }, [obs.observation?.currentRound]);

  const confirmAndStop = async () => {
    if (stopOnceRef.current) return;
    stopOnceRef.current = true;
    obs.setStopAckPending(true);
    setConfirmStop(false);
    try {
      setStopError(null);
      await onStop?.();
    } catch {
      // Re-read; do not auto-retry paid execution.
      obs.setStopAckPending(false);
      stopOnceRef.current = false;
      setStopError("停止失败，结果待确认");
    }
  };

  return (
    <div
      className="ck-repair-workspace"
      data-testid="repair-workspace"
    >
      <header className="ck-repair-context">
        <h1 className="ck-repair-goal" data-testid="repair-goal" tabIndex={-1} ref={titleRef}>
          {vm.goalText}
          {vm.goalText === "目标未记录" && sourceRunId ? (
            <a className="ck-repair-source-link" href={`/reports/${sourceRunId}`}>
              查看源审查
            </a>
          ) : null}
        </h1>
        <p className="ck-repair-phase" data-testid="repair-phase">
          {vm.phaseText}
        </p>
        <p className="ck-repair-last" data-testid="repair-last-activity">
          最近活动 {vm.lastActivityLabel}
        </p>
        {obs.observation?.task.budget ? (
          <p className="ck-repair-meta">
            剩余{" "}
            {Math.max(
              0,
              (obs.observation.task.budget.sourceFixMax ?? 0) -
                (obs.observation.task.budget.sourceFixUsed ?? 0),
            )}{" "}
            次 · 暂无完整用量 · 上下文
          </p>
        ) : null}
        <p className="ck-repair-attention" data-testid="repair-attention">
          {vm.attention ?? "当前不需要处理"}
        </p>
        {vm.attention === "已准出" ? (
          <p className="ck-repair-meta">
            SHA {obs.evidence?.candidateSha ?? obs.observation?.task.candidateSha ?? "未记录"} · 核验{" "}
            {obs.evidence?.verifiedAt ?? "未记录"}
          </p>
        ) : null}
        {vm.attention?.includes("额度不足") ? (
          <button type="button" className="ck-repair-btn" data-testid="repair-quota-steps">
            查看换席步骤。旧 session 不能跨模型恢复；v2 可同链继承预算，未提交改动不会自动复制。
          </button>
        ) : null}
        {obs.observation && obs.observation.reasons.length > 0 ? (
          <p className="ck-repair-meta">{obs.observation.reasons.join("；")}</p>
        ) : null}
        <p data-testid="repair-process" className="ck-repair-meta">
          {vm.processLabel}
        </p>
        <p data-testid="repair-connection" className="ck-repair-meta">
          {vm.connectionLabel}
          {obs.connectionLost ? (
            <button type="button" className="ck-repair-btn" onClick={() => obs.retry()}>
              重新连接
            </button>
          ) : null}
        </p>
        <label className="ck-repair-round">
          轮次
          <select
            data-testid="repair-round-select"
            value={obs.reading.round === "current" ? String(obs.observation?.currentRound ?? 1) : String(obs.reading.round)}
            onChange={(e) => {
              const n = Number(e.currentTarget.value);
              if (!Number.isInteger(n)) return;
              const current = obs.observation?.currentRound;
              obs.setFilter({ round: current !== undefined && n === current ? "current" : n });
            }}
          >
            {rounds.map((n) => (
              <option key={n} value={n}>
                第 {n} 轮{n === (obs.observation?.currentRound ?? 1) ? "（当前）" : "（历史）"}
              </option>
            ))}
          </select>
        </label>
        {vm.isHistorical ? (
          <p className="ck-repair-banner" data-testid="repair-history-banner">
            历史轮次只读
          </p>
        ) : null}
        <div className="ck-repair-run-details-wrap" data-testid="repair-run-details">
        <button
          type="button"
          className="ck-repair-btn"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          运行详情
        </button>
        {detailsOpen && obs.observation ? (
          <div className="ck-repair-run-details">
            <p>请求模型与实际模型以角色为准；未知不写默认。</p>
            <p>协议 {obs.observation.task.protocolVersion ?? "未记录"}</p>
            <p>
              预算{" "}
              {obs.observation.task.budget
                ? `剩余 ${Math.max(0, (obs.observation.task.budget.sourceFixMax ?? 0) - (obs.observation.task.budget.sourceFixUsed ?? 0))} 次 · 暂无完整用量`
                : "未记录"}
            </p>
            {obs.observation.roles.map((role) => (
              <p key={role.roleKey}>
                {role.label}: 请求 {role.requestedModel ?? "未记录"} / 实际 {role.actualModel ?? "未记录"}
              </p>
            ))}
          </div>
        ) : null}
        </div>
      </header>

      <div className="ck-repair-body">
        <RepairRoles
          roles={obs.observation?.roles ?? []}
          selected={obs.reading.roleKey}
          onSelect={(roleKey) => obs.setFilter({ roleKey })}
        />
        <div className="ck-repair-main" ref={(node) => { scrollerRef.current = node; }}>
          <div className="ck-repair-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              data-testid="repair-tab-activity"
              aria-selected={obs.reading.tab === "activity"}
              className={obs.reading.tab === "activity" ? "is-selected" : ""}
              onClick={() => obs.setFilter({ tab: "activity" })}
            >
              活动
            </button>
            <button
              type="button"
              role="tab"
              data-testid="repair-tab-evidence"
              aria-selected={obs.reading.tab === "evidence"}
              className={obs.reading.tab === "evidence" ? "is-selected" : ""}
              onClick={() => obs.setFilter({ tab: "evidence" })}
            >
              验收与改动
            </button>
          </div>
          {obs.reading.tab === "activity" ? (
            <RepairActivity
              operations={filteredWindow}
              hiddenCount={
                obs.windowed.hiddenCount > 0 || obs.observation?.hasMore || obs.observation?.earlierCursor
                  ? Math.max(obs.windowed.hiddenCount, 1)
                  : 0
              }
              newCount={obs.reading.newCount}
              pinned={obs.reading.pinned}
              emptyReason={vm.emptyReason}
              filter={{
                roleKey: obs.reading.roleKey,
                kind: obs.reading.kind,
                query: obs.reading.query,
              }}
              onFilter={(patch) => obs.setFilter(patch)}
              onClearFilter={obs.clearFilter}
              onToggleFollow={obs.toggleFollow}
              onViewNew={obs.viewNew}
              onLoadEarlier={obs.loadEarlier}
              listRef={listRef}
              onOpen={(eventId, trigger) => {
                setReturnFocus(trigger);
                obs.setFilter({ selectedEventId: eventId });
              }}
            />
          ) : (
            <RepairEvidencePanel
              evidence={obs.evidence}
              onExport={(format) => void obs.downloadEvidence(format)}
            />
          )}
        </div>
      </div>

      <footer className="ck-repair-controls">
        {obs.observation?.task.businessResult === "approved" ? null : (
          <button
            type="button"
            className="ck-repair-btn danger"
            data-testid="repair-stop"
            disabled={!vm.canStop || obs.stopAckPending || stopPending}
            onClick={() => setConfirmStop(true)}
          >
            停止任务
          </button>
        )}
        <button
          type="button"
          className="ck-repair-btn"
          data-testid="repair-resume"
          disabled={!vm.canResume}
          onClick={() => void onResume?.()}
        >
          恢复
        </button>
        {stopError ? <p className="ck-repair-error">{stopError}</p> : null}
        {obs.error ? <p className="ck-repair-error">{obs.error}</p> : null}
      </footer>

      {confirmStop ? (
        <div className="ck-repair-confirm" role="dialog" aria-modal="true" aria-label="确认停止">
          <p>停止当前执行。将保留历史记录和已用预算。</p>
          <div className="ck-repair-confirm-actions">
            <button
              type="button"
              className="ck-repair-btn"
              data-testid="repair-stop-cancel"
              onClick={() => setConfirmStop(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="ck-repair-btn danger"
              data-testid="repair-stop-confirm"
              onClick={() => void confirmAndStop()}
            >
              确认停止
            </button>
          </div>
        </div>
      ) : null}

      <RepairEventDrawer
        open={obs.reading.selectedEventId !== null}
        runId={runId}
        operation={selectedOp}
        returnFocus={returnFocus}
        workspaceTitleRef={titleRef}
        onClose={() => obs.setFilter({ selectedEventId: null })}
      />
    </div>
  );
}
