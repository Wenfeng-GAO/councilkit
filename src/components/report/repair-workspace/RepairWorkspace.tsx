import { activityPresentation, goalPresentation, phaseName } from "./presentation";
import { IconInfo, IconX } from "./icons";
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
  const stopDialogRef = useRef<HTMLDialogElement>(null);
  const adviceRef = useRef<HTMLDialogElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = stopDialogRef.current;
    if (confirmStop && dialog && !dialog.open) dialog.showModal();
    if (!confirmStop && dialog?.open) {
      dialog.close();
      stopButtonRef.current?.focus();
    }
  }, [confirmStop]);

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

  const task = obs.observation?.task;
  const goal = goalPresentation(task?.goalSummary);
  const budget = task?.budget;
  const remaining =
    budget?.sourceFixMax != null && budget.sourceFixUsed != null
      ? Math.max(0, budget.sourceFixMax - budget.sourceFixUsed)
      : null;
  const needsAttention = task?.businessResult === "needs_attention";
  const ended = task?.businessResult != null;
  const approvedConfirmed =
    task?.businessResult === "approved" && obs.evidence?.gateConsistent === true;
  const tone =
    obs.connectionLost ||
    needsAttention ||
    (task?.businessResult === "approved" && obs.evidence?.gateConsistent === false)
      ? "warning"
      : approvedConfirmed
        ? "success"
        : task?.businessResult === "stopped"
          ? "neutral"
          : "running";
  const headline = vm.attention ?? vm.phaseText;
  const stage = approvedConfirmed
    ? 4
    : /review|audit/.test(task?.phase ?? "")
      ? 2
      : task?.businessResult === "approved" ||
          task?.reasonCode === "candidate_ready_awaiting_gate" ||
          /gated|integrating|finaliz/.test(task?.phase ?? "")
        ? 3
        : /active|implement|fix/.test(task?.phase ?? "")
          ? 1
          : 0;
  const stages = ["准备", "执行", "独立核验", "终验", "准出"];
  const isQuota = vm.attention?.includes("额度不足");
  const latestActivity = obs.observation?.upserts.at(-1);
  return (
    <div className="ck-repair-workspace" data-testid="repair-workspace">
      <header className="ck-repair-context">
        <div className="ck-repair-heading-row">
          <div className="ck-repair-heading">
            <p className="ck-repair-eyebrow">
              SQUAD <span>自动修复</span>
            </p>
            <h1 className="ck-repair-goal" data-testid="repair-goal" tabIndex={-1} ref={titleRef}>
              {goal.title}
            </h1>
            <div className="ck-repair-source-line">
              {goal.url ? (
                <a href={goal.url} target="_blank" rel="noreferrer">
                  查看合并请求 ↗
                </a>
              ) : sourceRunId ? (
                <a href={`/reports/${sourceRunId}`}>查看源审查 ↗</a>
              ) : null}
              {!goal.goal ? <span>具体修复目标未记录</span> : null}
            </div>
          </div>
          <div className="ck-repair-header-actions">
            <label className="ck-repair-round">
              <span className="ck-repair-sr">轮次</span>
              <select
                data-testid="repair-round-select"
                value={
                  obs.reading.round === "current"
                    ? String(obs.observation?.currentRound ?? 1)
                    : String(obs.reading.round)
                }
                onChange={(e) => {
                  const n = Number(e.currentTarget.value);
                  if (Number.isInteger(n))
                    obs.setFilter({ round: n === obs.observation?.currentRound ? "current" : n });
                }}
              >
                {rounds.map((n) => (
                  <option key={n} value={n}>
                    第 {n} 轮{n === obs.observation?.currentRound ? "（当前）" : "（历史）"}
                  </option>
                ))}
              </select>
            </label>
            <div className="ck-repair-run-details-wrap" data-testid="repair-run-details">
              <button
                type="button"
                className="ck-repair-btn quiet"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                运行详情
              </button>
              {detailsOpen && obs.observation ? (
                <div className="ck-repair-run-details">
                  <p className="ck-repair-section-label">运行记录</p>
                  <dl>
                    <dt>任务</dt>
                    <dd>{runId}</dd>
                    <dt>协议</dt>
                    <dd>{task?.protocolVersion ?? "未记录"}</dd>
                    <dt>最后阶段</dt>
                    <dd>{phaseName(task?.phase)}</dd>
                    <dt>Token 用量</dt>
                    <dd>暂无完整用量</dd>
                    <dt>剩余派工</dt>
                    <dd>{remaining == null ? "未记录" : `${remaining} 次`}</dd>
                  </dl>
                  {obs.observation.roles.map((role) => (
                    <div className="ck-repair-model-detail" key={role.roleKey}>
                      <strong>{role.label}</strong>
                      <p>请求模型：{role.requestedModel ?? "未记录"}</p>
                      <p>实际模型：{role.actualModel ?? "未记录"}</p>
                    </div>
                  ))}
                  {obs.observation.reasons.length ? (
                    <p className="ck-repair-meta">{obs.observation.reasons.join("；")}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            {!vm.isHistorical && obs.observation && task?.businessResult === null ? (
              <button
                ref={stopButtonRef}
                type="button"
                className="ck-repair-btn quiet danger"
                data-testid="repair-stop"
                disabled={!vm.canStop || obs.stopAckPending || stopPending}
                onClick={() => setConfirmStop(true)}
              >
                停止任务
              </button>
            ) : null}
            {!vm.isHistorical && needsAttention ? (
              <button
                type="button"
                className="ck-repair-btn"
                data-testid="repair-resume"
                disabled={!vm.canResume}
                title={!vm.canResume ? "当前执行状态或恢复资格尚未确认" : "恢复当前执行"}
                onClick={() => void onResume?.()}
              >
                恢复
              </button>
            ) : null}
          </div>
        </div>
        <div className={`ck-repair-statusline is-${tone}`}>
          <span className="ck-repair-status-dot" aria-hidden="true" />
          <div className="ck-repair-status-copy">
            <h2 data-testid="repair-attention">{headline}</h2>
            <p data-testid="repair-phase">
              {needsAttention
                ? "本轮未达到准出条件，活动与核验记录已保留"
                : task?.businessResult === "stopped"
                  ? "用户已停止本轮任务，历史与已用预算保留"
                  : approvedConfirmed
                    ? "候选与准出证据一致"
                    : latestActivity
                      ? `最近记录：${activityPresentation(latestActivity).title}`
                      : "等待第一条执行记录"}
            </p>
          </div>
          {needsAttention ? (
            <button
              type="button"
              className="ck-repair-btn quiet"
              data-testid={isQuota ? "repair-quota-steps" : "repair-failure-help"}
              onClick={() => adviceRef.current?.showModal()}
            >
              {isQuota ? "查看换席步骤" : "查看处理建议"} <span aria-hidden="true">↗</span>
            </button>
          ) : null}
        </div>
        <div className="ck-repair-observation-bar">
          <span data-testid="repair-process">
            <i className={`ck-repair-indicator is-${task?.process.state ?? "unknown"}`} />
            {vm.processLabel}
          </span>
          <span data-testid="repair-connection">
            <i
              className={`ck-repair-indicator ${obs.connectionLost ? "is-offline" : "is-alive"}`}
            />
            {vm.connectionLabel}
            {obs.connectionLost ? (
              <button className="ck-repair-inline-action" type="button" onClick={() => obs.retry()}>
                重新连接
              </button>
            ) : null}
          </span>
          <span data-testid="repair-last-activity">
            {task?.lastActivityTimeSource === "observed_live" ? "最近收到记录" : "最近活动"}
            <strong>{vm.lastActivityLabel}</strong>
          </span>
          {approvedConfirmed && task?.candidateSha ? (
            <span>
              候选 <code title={task.candidateSha}>{task.candidateSha.slice(0, 8)}</code> · 已核验
            </span>
          ) : null}
          {remaining != null ? (
            <span className="ck-repair-budget" data-testid="repair-budget">
              剩余派工 <strong>{remaining} 次</strong>
            </span>
          ) : null}
        </div>
        <ol className="ck-repair-stages" aria-label="修复阶段">
          {stages.map((label, i) => (
            <li
              key={label}
              className={`${i < stage ? "is-complete" : ""} ${i === stage ? "is-current" : ""}`}
              aria-current={i === stage ? "step" : undefined}
            >
              <span>{i < stage ? "✓" : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {vm.isHistorical ? (
          <p className="ck-repair-history-banner" data-testid="repair-history-banner">
            历史轮次只读{" "}
            <button type="button" onClick={() => obs.setFilter({ round: "current" })}>
              返回当前轮 →
            </button>
          </p>
        ) : null}
        {stopError || obs.error ? (
          <p className="ck-repair-error" role="alert" data-testid="repair-action-error">
            {stopError ?? obs.error}
          </p>
        ) : null}
      </header>
      <div className="ck-repair-body">
        <RepairRoles
          roles={obs.observation?.roles ?? []}
          selected={obs.reading.roleKey}
          onSelect={(roleKey) => obs.setFilter({ roleKey })}
        />
        <div
          className="ck-repair-main"
          ref={(node) => {
            scrollerRef.current = node;
          }}
        >
          <div className="ck-repair-tabs" role="tablist" aria-label="修复记录">
            <button
              type="button"
              role="tab"
              data-testid="repair-tab-activity"
              aria-selected={obs.reading.tab === "activity"}
              className={obs.reading.tab === "activity" ? "is-selected" : ""}
              onClick={() => obs.setFilter({ tab: "activity" })}
            >
              活动记录 <span>{obs.observation?.upserts.length ?? 0}</span>
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
              roles={obs.observation?.roles ?? []}
              executionEnded={ended}
              hiddenCount={
                obs.windowed.hiddenCount > 0 ||
                obs.observation?.hasMore ||
                obs.observation?.earlierCursor
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
      <dialog
        ref={stopDialogRef}
        className="ck-repair-confirm"
        aria-label="确认停止"
        onCancel={(e) => {
          e.preventDefault();
          setConfirmStop(false);
        }}
        onClose={() => setConfirmStop(false)}
      >
        <h2>停止本次执行？</h2>
        <p>已产生的活动、历史记录和已用预算都会保留。</p>
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
      </dialog>
      <dialog ref={adviceRef} className="ck-repair-drawer ck-repair-advice" aria-label="处理建议">
        <div className="ck-repair-drawer-panel">
          <header className="ck-repair-drawer-header">
            <h2 className="ck-repair-drawer-title">
              {isQuota ? "额度不足 · 换席步骤" : "修复执行未完成"}
            </h2>
            <button
              type="button"
              className="ck-repair-icon-btn"
              aria-label="关闭处理建议"
              onClick={() => adviceRef.current?.close()}
            >
              <IconX />
            </button>
          </header>
          <div className="ck-repair-drawer-body">
            <IconInfo />
            {isQuota ? (
              <>
                <p>先停止旧执行，再明确选择新的模型与席位，并使用新的会话继续。</p>
                <p>旧 session 不能跨模型恢复。v2 可同链继承预算，未提交改动不会自动复制。</p>
                <p>不会自动切换付费模型，也不会清零已用预算。</p>
              </>
            ) : (
              <>
                <p>控制器记录本次修复未能完成，尚未产生可交付的结果。</p>
                <p>请先查看最近的命令与文件活动；未记录的失败细节不会被推断成额度问题。</p>
                <p>恢复资格由控制器确认，已用预算与记录会继续保留。</p>
              </>
            )}
            <p className="ck-repair-meta">原因标识：{task?.reasonCode ?? "未记录"}</p>
            {sourceRunId ? (
              <a className="ck-repair-source-link" href={`/reports/${sourceRunId}`}>
                查看源审查 →
              </a>
            ) : null}
          </div>
        </div>
      </dialog>
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
