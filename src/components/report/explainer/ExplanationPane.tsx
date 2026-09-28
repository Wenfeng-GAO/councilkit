import type {
  ExplainerFinding,
  ExplanationAgents,
  ExplanationResult,
  FindingAnchor,
  FindingDecision,
} from "@shared/runtime/review-explainer/contracts";
import { useEffect, useRef, useState } from "react";
import { DecisionButtons } from "./DecisionButtons";
import { type CodeLocation, ExplanationDiagram } from "./ExplanationDiagram";
import { ExplainerRequestError, errorMessage, explainerApi } from "./api";
import {
  displayDecisionReason,
  displayFindingTitle,
  explanationSummaryTitle,
} from "./finding-presentation";
import { explainerUi as UI } from "./ui";
import { findingDisplayStatus } from "./view-model";
import "@/styles/review-explainer-details.css";

type PaneTab = "summary" | "explanation" | "original";
class ExplanationAgentChangedError extends Error {
  constructor() {
    super("返回的解释与所选 Agent / 模型不一致，请重新加载配置后生成。");
  }
}
function verifyExplanationAgent(
  value: ExplanationResult,
  agentId: string,
  modelId: string,
  driverId: string,
) {
  if (
    value.provenance.agentId !== agentId ||
    value.provenance.modelId !== modelId ||
    value.provenance.driverId !== driverId
  )
    throw new ExplanationAgentChangedError();
}
function agentConfigurationChanged(error: unknown) {
  return (
    error instanceof ExplanationAgentChangedError ||
    (error instanceof ExplainerRequestError &&
      error.status === 409 &&
      error.code === "EXECUTION_CONFLICT")
  );
}

interface ExplanationPaneProps {
  runId: string;
  explanationAgents: ExplanationAgents | null;
  agentsLoading: boolean;
  agentsError: string;
  selectedAgentId: string | null;
  onAgentChange: (agentId: string) => void;
  onRetryAgents: () => void;
  summaryTitle?: string;
  onSummary: (findingId: string, agentKey: string, title: string | null) => void;
  finding: ExplainerFinding;
  decision: FindingDecision;
  saving: boolean;
  contextPending: boolean;
  onDecide: (id: string, decision: FindingDecision, reason?: string) => void;
  onBack: () => void;
  onContext: () => void;
  onLocate: (location: CodeLocation) => void;
  number?: number;
  total?: number;
  initialTab?: PaneTab;
  reason?: string;
  headSha?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  onLocateAnchor?: (anchor: FindingAnchor) => void;
}

export function ExplanationPane(props: ExplanationPaneProps) {
  // A new finding owns fresh drafts and requests, even if the parent keeps the pane mounted.
  return <ExplanationPaneContent key={`${props.runId}:${props.finding.id}`} {...props} />;
}

function ExplanationPaneContent({
  runId,
  explanationAgents,
  agentsLoading,
  agentsError,
  selectedAgentId,
  onAgentChange,
  onRetryAgents,
  summaryTitle,
  onSummary,
  finding,
  decision,
  saving,
  contextPending,
  onDecide,
  onBack,
  onContext,
  onLocate,
  number,
  total,
  initialTab = "summary",
  reason,
  headSha,
  onPrevious,
  onNext,
  onLocateAnchor,
}: ExplanationPaneProps) {
  const [tab, setTab] = useState<PaneTab>(initialTab);
  const savedNote = displayDecisionReason(reason);
  const [note, setNote] = useState(savedNote);
  const priorSavedNote = useRef(savedNote);
  const noteDirty = note !== savedNote;
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    const previous = priorSavedNote.current;
    setNote((current) => (current === previous ? savedNote : current));
    priorSavedNote.current = savedNote;
  }, [savedNote]);
  const [requestStatus, setStatus] = useState<
    "blocked" | "reading" | "empty" | "generating" | "ready" | "failed"
  >("blocked");
  const [cacheReload, setCacheReload] = useState(0);
  const [failurePhase, setFailurePhase] = useState<"cache" | "generate">("cache");
  const [storedResult, setResult] = useState<ExplanationResult | null>(null);
  const [resultAgentKey, setResultAgentKey] = useState("");
  const [requestAgentKey, setRequestAgentKey] = useState("");
  const [failure, setFailure] = useState("");
  const [configurationChanged, setConfigurationChanged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const generationRef = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    if (diagramOpen && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [diagramOpen]);
  const closeDiagram = () => {
    dialog.current?.close();
    setDiagramOpen(false);
  };
  const selectedAgent = explanationAgents?.agents.find((item) => item.id === selectedAgentId);
  const agent = selectedAgent?.available ? selectedAgent : undefined;
  const agentKey = agent ? JSON.stringify([agent.id, agent.driverId, agent.modelId]) : "";
  const agentId = agent?.id;
  const modelId = agent?.modelId;
  const driverId = agent?.driverId;
  const result = resultAgentKey === agentKey ? storedResult : null;
  const status =
    requestAgentKey === agentKey
      ? requestStatus
      : !agent || agentsLoading || agentsError
        ? "blocked"
        : "reading";
  const modelLabel = agent
    ? `${agent.name} · ${agent.modelId}`
    : selectedAgent
      ? `${selectedAgent.name} · ${selectedAgent.modelId}（不可用）`
      : selectedAgentId
        ? `${selectedAgentId}（已不可用）`
        : "尚未选择解释 Agent";
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentKey contains driver/model identity and cacheReload explicitly rereads a failed cache lookup.
  useEffect(() => {
    let alive = true;
    const request = ++requestVersion.current;
    generationRef.current = false;
    setRequestAgentKey(agentKey);
    setResult(null);
    setFailure("");
    setConfigurationChanged(false);
    setCopied(false);
    dialog.current?.close();
    setDiagramOpen(false);
    if (!agentId || !modelId || !driverId || agentsLoading || agentsError) {
      setStatus("blocked");
      return () => {
        alive = false;
        requestVersion.current++;
      };
    }
    setStatus("reading");
    void explainerApi
      .explanation(runId, finding.id, false, agentId, { modelId, driverId })
      .then((value) => {
        if (alive && request === requestVersion.current) {
          verifyExplanationAgent(value, agentId, modelId, driverId);
          setResult(value);
          setResultAgentKey(agentKey);
          setStatus("ready");
          onSummary(finding.id, agentKey, explanationSummaryTitle(value.payload));
        }
      })
      .catch((error: unknown) => {
        if (!alive || request !== requestVersion.current) return;
        if (error instanceof ExplainerRequestError && error.status === 404) {
          setStatus("empty");
          onSummary(finding.id, agentKey, null);
        } else {
          setStatus("failed");
          setFailurePhase("cache");
          setFailure(errorMessage(error));
          setConfigurationChanged(agentConfigurationChanged(error));
          if (agentConfigurationChanged(error)) onSummary(finding.id, agentKey, null);
        }
      });
    return () => {
      alive = false;
      requestVersion.current++;
    };
  }, [
    runId,
    finding.id,
    agentId,
    modelId,
    driverId,
    agentKey,
    agentsLoading,
    agentsError,
    cacheReload,
    onSummary,
  ]);
  const generate = async () => {
    if (
      generationRef.current ||
      !agentId ||
      !modelId ||
      !driverId ||
      agentsLoading ||
      agentsError ||
      configurationChanged
    )
      return;
    generationRef.current = true;
    const request = ++requestVersion.current;
    setStatus("generating");
    setFailure("");
    setFailurePhase("generate");
    try {
      const value = await explainerApi.explanation(runId, finding.id, true, agentId, {
        modelId,
        driverId,
      });
      if (request !== requestVersion.current) return;
      verifyExplanationAgent(value, agentId, modelId, driverId);
      setResult(value);
      setResultAgentKey(agentKey);
      setStatus("ready");
      onSummary(finding.id, agentKey, explanationSummaryTitle(value.payload));
    } catch (error) {
      if (request !== requestVersion.current) return;
      setStatus("failed");
      setFailure(errorMessage(error));
      setConfigurationChanged(agentConfigurationChanged(error));
      if (agentConfigurationChanged(error)) onSummary(finding.id, agentKey, null);
    } finally {
      if (request === requestVersion.current) generationRef.current = false;
    }
  };
  const locate = (location: CodeLocation) => {
    closeDiagram();
    onLocate(location);
  };
  const context = () => {
    closeDiagram();
    onContext();
  };
  const locateAnchor = (anchor: FindingAnchor) => {
    closeDiagram();
    if (onLocateAnchor) onLocateAnchor(anchor);
    else if (anchor.status === "context") onContext();
    else if (anchor.status === "resolved" && anchor.path && anchor.side && anchor.line) {
      onLocate({ path: anchor.path, side: anchor.side, line: anchor.line });
    }
  };
  const generatedTitle = summaryTitle ?? (result ? explanationSummaryTitle(result.payload) : null);
  const title = displayFindingTitle(finding, generatedTitle);
  const payload = result?.payload;
  const hasContext = finding.anchors.some((anchor) => anchor.status === "context");
  const copySuggestion = async () => {
    if (!payload?.suggestedCode) return;
    const request = requestVersion.current;
    try {
      await navigator.clipboard.writeText(payload.suggestedCode.after);
      if (request === requestVersion.current) setCopied(true);
    } catch {
      if (request !== requestVersion.current) return;
      setCopied(false);
      setFailure("复制未成功，请手动选择建议代码。");
    }
  };

  return (
    <>
      <header className="ck-ex-pane-header">
        <div className="ck-ex-pane-top">
          <span className="ck-ex-summary-number">
            {number === undefined ? "问题详情" : `问题 #${number}`}
            {total === undefined ? null : <small> · 当前范围 {total} 条</small>}
          </span>
          <div className="ck-ex-summary-navigation">
            {number !== undefined ? (
              <>
                <button
                  type="button"
                  disabled={!onPrevious}
                  onClick={onPrevious}
                  aria-label="上一个问题"
                >
                  ‹
                </button>
                <button type="button" disabled={!onNext} onClick={onNext} aria-label="下一个问题">
                  ›
                </button>
              </>
            ) : null}
            <button type="button" onClick={onBack}>
              返回代码
            </button>
          </div>
        </div>
        <div className="ck-ex-summary-badges">
          <span className={`ck-ex-summary-severity ${finding.severity}`}>{finding.severity}</span>
          <span className="ck-ex-summary-status">{findingDisplayStatus(finding, headSha)}</span>
        </div>
        <h2 title={finding.title}>{title}</h2>
        {!generatedTitle && finding.title.length > 80 ? (
          <p className="ck-ex-title-source">原评审摘录 · 生成解释后显示简明标题</p>
        ) : generatedTitle ? (
          <p className="ck-ex-title-source">解释摘要 · {agent?.name}</p>
        ) : null}
        <div className="ck-ex-tabs" role="tablist" aria-label="评审解释">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "summary"}
            onClick={() => setTab("summary")}
          >
            概览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "explanation"}
            onClick={() => setTab("explanation")}
          >
            看懂问题
          </button>
          <button
            type="button"
            role="tab"
            data-testid={UI.original}
            aria-selected={tab === "original"}
            onClick={() => setTab("original")}
          >
            原始评审
          </button>
        </div>
      </header>
      <div className="ck-ex-pane-body">
        {tab !== "original" ? (
          <section
            className={`ck-ex-agent-config${tab === "summary" ? " compact" : ""}`}
            aria-label="解释模型配置"
          >
            <div className="ck-ex-agent-heading">
              <label htmlFor={`explanation-agent-${finding.id}`}>解释 Agent</label>
              <button type="button" onClick={onRetryAgents} disabled={agentsLoading}>
                {agentsLoading ? "读取中…" : "重新加载配置"}
              </button>
            </div>
            {agentsLoading ? (
              <p className="ck-ex-muted">正在读取本次 Run 可用的解释 Agent…</p>
            ) : agentsError ? (
              <div className="ck-ex-agent-error" role="alert">
                <p>解释配置读取失败：{agentsError}</p>
                <button type="button" onClick={onRetryAgents}>
                  重试配置
                </button>
              </div>
            ) : (
              <>
                <select
                  id={`explanation-agent-${finding.id}`}
                  aria-label="解释 Agent"
                  value={selectedAgentId ?? ""}
                  onChange={(event) => onAgentChange(event.target.value)}
                >
                  <option value="" disabled>
                    {explanationAgents?.defaultAgentId
                      ? "请选择可用的解释 Agent"
                      : "没有默认 Agent，请选择"}
                  </option>
                  {selectedAgentId && !selectedAgent ? (
                    <option value={selectedAgentId} disabled>
                      先前选择已不可用 · {selectedAgentId}
                    </option>
                  ) : null}
                  {explanationAgents?.agents.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.available}>
                      {item.name} · {item.modelId}
                      {item.available ? "" : "（不可用）"}
                    </option>
                  ))}
                </select>
                {agent ? (
                  <p className="ck-ex-agent-model" data-testid="review-explainer-selected-model">
                    <strong>{agent.name}</strong>
                    <code>{agent.modelId}</code>
                    <span>{agent.driverId}</span>
                  </p>
                ) : (
                  <p className="ck-ex-agent-unavailable">
                    {selectedAgentId
                      ? `${selectedAgent?.name ?? selectedAgentId}：${selectedAgent?.reason ?? (selectedAgent ? "本地配置或执行器不可用" : "该 Agent 已被删除或不在当前配置中")}。请明确重新选择，不会自动切换到默认模型。`
                      : "请明确选择一个可用的解释 Agent；不会自动替换为其他模型。"}
                  </p>
                )}
                <p className="ck-ex-agent-source">
                  默认来源：
                  {explanationAgents?.defaultSource === "pr-jury-reporter"
                    ? "pr-jury 的 Reporter"
                    : explanationAgents?.defaultSource === "run-aggregator"
                      ? "本次 Run 的 Aggregator"
                      : explanationAgents?.defaultSource === "injected"
                        ? "受控执行器"
                        : "未配置"}
                  {agent && agent.id !== explanationAgents?.defaultAgentId
                    ? " · 当前为手动选择"
                    : ""}
                </p>
                {explanationAgents?.notice ? (
                  <p className="ck-ex-agent-unavailable">{explanationAgents.notice}</p>
                ) : null}
                {explanationAgents?.agents.some((item) => !item.available) ? (
                  <details className="ck-ex-agent-unavailable-list">
                    <summary>不可用 Agent 与原因</summary>
                    <ul>
                      {explanationAgents.agents
                        .filter((item) => !item.available)
                        .map((item) => (
                          <li key={item.id}>
                            <strong>{item.name}</strong> · {item.modelId}
                            <br />
                            {item.reason || "本地配置或执行器不可用"}
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
            {tab === "summary" && agent && !agentsLoading && !agentsError ? (
              <div className="ck-ex-agent-action">
                <button
                  type="button"
                  disabled={status === "reading" || status === "generating"}
                  onClick={() => {
                    if (configurationChanged) {
                      onRetryAgents();
                      return;
                    }
                    setTab("explanation");
                    if (status === "empty" || (status === "failed" && failurePhase === "generate"))
                      void generate();
                  }}
                >
                  {configurationChanged
                    ? "重新加载配置"
                    : status === "ready"
                      ? "查看解释"
                      : status === "generating"
                        ? "正在生成解释…"
                        : status === "reading"
                          ? "读取已缓存的解释…"
                          : status === "failed" && failurePhase === "cache"
                            ? "查看读取错误"
                            : status === "failed"
                              ? "重试解释"
                              : "生成解释"}
                </button>
                <span>{modelLabel}</span>
              </div>
            ) : null}
          </section>
        ) : null}
        {tab === "summary" ? (
          <FindingSummary
            finding={finding}
            headSha={headSha}
            contextPending={contextPending}
            onLocateAnchor={locateAnchor}
            canLocateUnresolved={Boolean(onLocateAnchor)}
          />
        ) : tab === "original" ? (
          <section aria-label="原始评审">
            <p className="ck-ex-kicker">原始断言 · 保留完整上下文</p>
            <h3 className="ck-ex-original-title">{finding.title}</h3>
            <p className="ck-ex-prose">{finding.text}</p>
            <p className="ck-ex-muted">
              {finding.reviewer ? `来源：${finding.reviewer} · ` : ""}
              {finding.source} · {finding.severity}
            </p>
            {finding.anchors.map((anchor, index) => (
              <p
                className="ck-ex-source-ref"
                key={`${anchor.path ?? "unknown"}:${anchor.side}:${anchor.line}:${index}`}
              >
                {anchor.path ?? "未提供文件"}
                {anchor.line ? ` · ${anchor.side === "old" ? "旧" : "新"}侧 L${anchor.line}` : ""}
                {anchor.reason ? ` · ${anchor.reason}` : ""}
              </p>
            ))}
            <p className="ck-ex-muted">修复意图与原评审是否已验证关闭分别记录。</p>
          </section>
        ) : status === "ready" && payload ? (
          <>
            <p className="ck-ex-kicker">这条评审在说什么</p>
            <p className="ck-ex-lead">{payload.assertion}</p>
            {payload.preconditions?.length ? (
              <section className="ck-ex-explanation-section">
                <h3>触发前提</h3>
                <ul>
                  {payload.preconditions.map((text, index) => (
                    <li key={`${index}:${text}`}>{text}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="ck-ex-explanation-section">
              <h3>已有证据</h3>
              {payload.evidence.length ? (
                <ul>
                  {payload.evidence.map((text, index) => (
                    <li key={`${index}:${text}`}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p className="ck-ex-muted">解释未提供独立验证证据。</p>
              )}
            </section>
            <section className="ck-ex-explanation-section">
              <h3>条件推演</h3>
              {payload.inference.length ? (
                <ul>
                  {payload.inference.map((text, index) => (
                    <li key={`${index}:${text}`}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p className="ck-ex-muted">未补充条件推演。</p>
              )}
            </section>
            {payload.suggestedCode ? (
              <section data-testid={UI.suggested} className="ck-ex-suggestion">
                <h3>
                  建议改法 <span>尚未验证</span>
                </h3>
                <div>
                  <h4>原写法</h4>
                  <pre>{payload.suggestedCode.before}</pre>
                </div>
                <div className="after">
                  <h4>建议写法</h4>
                  <pre>{payload.suggestedCode.after}</pre>
                </div>
                <button type="button" onClick={() => void copySuggestion()}>
                  {copied ? "已复制" : "复制建议代码"}
                </button>
                <p className="ck-ex-muted">没有修改源码；此建议不构成修复验证。</p>
              </section>
            ) : null}
            {payload.canvas ? (
              <section>
                <div className="ck-ex-diagram-heading">
                  <h3>静态图解</h3>
                  <button type="button" onClick={() => setDiagramOpen(true)}>
                    放大图
                  </button>
                </div>
                <ExplanationDiagram model={payload.canvas} onLocate={locate} />
              </section>
            ) : (
              <div data-testid={UI.canvasFallback} className="ck-ex-prose">
                {payload.steps?.length ? (
                  <ol>
                    {payload.steps.map((text, index) => (
                      <li key={`${index}:${text}`}>{text}</li>
                    ))}
                  </ol>
                ) : (
                  <p>这条解释采用文字与代码对比，无需额外图形。</p>
                )}
              </div>
            )}
            {hasContext ? (
              <button
                type="button"
                className="ck-ex-context-action"
                disabled={contextPending}
                onClick={context}
              >
                查看关联上下文
              </button>
            ) : null}
            <details className="ck-ex-provenance">
              <summary>
                {result.cached ? "已缓存的解释" : "解释已生成"} ·{" "}
                {result.provenance.agentName ?? agent?.name} · {result.provenance.modelId}
              </summary>
              <p>
                {result.provenance.mode === "injected" ? "受控执行边界" : "模型执行"} ·{" "}
                {result.provenance.driverId}
              </p>
              <p>
                源码 {result.provenance.headSha.slice(0, 12)} · {result.provenance.generatedAt}
              </p>
              <code>{result.provenance.executionId}</code>
            </details>
          </>
        ) : (
          <section className="ck-ex-generation-state" aria-live="polite">
            {status === "blocked" ? (
              <>
                <h3>解释模型尚未就绪</h3>
                <p>
                  {agentsLoading
                    ? "读取配置后将自动检查所选 Agent 的缓存，不会自动生成。"
                    : agentsError
                      ? "请先重试读取上方的解释配置。"
                      : "请先在上方明确选择一个可用的解释 Agent。"}
                </p>
              </>
            ) : status === "reading" ? (
              <p>读取 {modelLabel} 的缓存解释…</p>
            ) : status === "generating" ? (
              <>
                <h3>正在生成解释…</h3>
                <p>正在调用 {modelLabel}，结合原始评审与冻结源码生成解释。</p>
              </>
            ) : status === "failed" ? (
              <>
                <h3>{failurePhase === "cache" ? "解释缓存读取失败" : "解释生成失败"}</h3>
                <p role="alert">{failure || "解释输出不可用，请重试。"}</p>
                <button
                  type="button"
                  className="ck-ex-primary"
                  data-testid={UI.retry}
                  disabled={!agent || agentsLoading || !!agentsError}
                  onClick={() =>
                    configurationChanged
                      ? onRetryAgents()
                      : failurePhase === "cache"
                        ? setCacheReload((value) => value + 1)
                        : void generate()
                  }
                >
                  {configurationChanged
                    ? "重新加载配置"
                    : failurePhase === "cache"
                      ? "重试读取缓存"
                      : "重试解释"}
                </button>
                <p className="ck-ex-generation-model">{modelLabel}</p>
              </>
            ) : (
              <>
                <h3>按需理解这条意见</h3>
                <p>结合原始评审与对应源码，解释触发前提、后果和建议改法。已有结果会复用缓存。</p>
                <button
                  type="button"
                  className="ck-ex-primary"
                  data-testid={UI.generate}
                  disabled={!agent || agentsLoading || !!agentsError || configurationChanged}
                  onClick={() => void generate()}
                >
                  生成解释
                </button>
                <p className="ck-ex-generation-model">{modelLabel}</p>
              </>
            )}
            {status !== "blocked" && status !== "reading" && status !== "generating" ? (
              <div data-testid={UI.canvasFallback} className="ck-ex-original-fallback">
                <h4>原始评审 · 尚未生成解释</h4>
                <p>{finding.text}</p>
              </div>
            ) : null}
          </section>
        )}
      </div>
      <footer className="ck-ex-pane-footer">
        <div className="ck-ex-note-heading">
          <h3>处理决定</h3>
          <span>保存至此 PR</span>
        </div>
        <DecisionButtons
          decision={decision}
          disabled={saving}
          onDecide={(choice) => onDecide(finding.id, choice, note)}
        />
        <label className="ck-ex-note-label" htmlFor={`finding-note-${finding.id}`}>
          备注（可选）
        </label>
        <textarea
          id={`finding-note-${finding.id}`}
          className="ck-ex-note-input"
          aria-label="处理备注"
          rows={2}
          maxLength={2000}
          value={note}
          disabled={saving}
          placeholder="记录处理原因或后续安排"
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="ck-ex-note-actions">
          <output aria-live="polite">
            {saving
              ? "正在保存…"
              : noteDirty
                ? "备注尚未保存"
                : savedNote
                  ? "备注已保存"
                  : "备注按需填写"}
          </output>
          <button
            type="button"
            disabled={saving || !noteDirty}
            onClick={() => onDecide(finding.id, decision, note)}
          >
            保存备注
          </button>
        </div>
        <p>处理决定不改变核验状态。</p>
      </footer>
      <dialog
        ref={dialog}
        className="ck-ex-dialog"
        aria-label="放大图解"
        onClose={() => setDiagramOpen(false)}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={closeDiagram}>
            关闭图解
          </button>
        </header>
        {diagramOpen && payload?.canvas ? (
          <ExplanationDiagram model={payload.canvas} onLocate={locate} />
        ) : null}
        {diagramOpen && hasContext ? (
          <button type="button" disabled={contextPending} onClick={context}>
            查看关联上下文
          </button>
        ) : null}
      </dialog>
    </>
  );
}

function FindingSummary({
  finding,
  headSha,
  contextPending,
  onLocateAnchor,
  canLocateUnresolved,
}: {
  finding: ExplainerFinding;
  headSha?: string;
  contextPending: boolean;
  onLocateAnchor: (anchor: FindingAnchor) => void;
  canLocateUnresolved: boolean;
}) {
  const verification = finding.verification;
  const stale = !!headSha && verification?.candidateSha !== headSha;
  const outcomes = {
    verified_closed: "核验结论：已关闭",
    still_open: "核验结论：仍成立",
    not_evaluated: "尚未核验",
  };
  const methods = {
    regression_test: "回归测试",
    code_trace: "代码追踪",
    not_evaluated: "未执行核验",
  };
  return (
    <div className="ck-ex-summary">
      <p className="ck-ex-summary-source">
        {{ consensus: "共识问题", unique: "独立发现", unknown: "来源未分类" }[finding.source]}
        {finding.reviewer ? ` · ${finding.reviewer}` : ""}
      </p>
      <section className="ck-ex-summary-section" aria-label="最近一次核验">
        <div className="ck-ex-summary-heading">
          <h3>最近一次核验</h3>
          {verification ? <span>{methods[verification.method]}</span> : null}
        </div>
        {verification ? (
          <>
            <p
              className={`ck-ex-summary-outcome ${stale ? "not_evaluated" : verification.outcome}`}
            >
              {stale
                ? `历史${outcomes[verification.outcome]} · 待验证当前提交`
                : outcomes[verification.outcome]}
            </p>
            <p className="ck-ex-prose">{verification.reason}</p>
            <h4 className="ck-ex-summary-label">验证证据</h4>
            <p className="ck-ex-summary-evidence">{verification.evidence}</p>
            {verification.command ? (
              <pre className="ck-ex-summary-command">{verification.command}</pre>
            ) : null}
            {verification.locations?.length ? (
              <div className="ck-ex-summary-references">
                {verification.locations.map((location, index) => (
                  <code key={`${index}:${location}`}>{location}</code>
                ))}
              </div>
            ) : null}
            <p className="ck-ex-summary-source">
              {verification.reviewer} · 提交{" "}
              <code title={verification.candidateSha}>
                {verification.candidateSha.slice(0, 12)}
              </code>
              <br />
              <span title={`Run: ${verification.runId} · Attempt: ${verification.attemptId}`}>
                {verification.runComplete ? "该次评审已完成" : "该次评审未完成"}
              </span>
            </p>
            <p className="ck-ex-muted">该结论对应上述提交，处理决定另行记录。</p>
          </>
        ) : (
          <p className="ck-ex-muted">未提供核验记录，请结合原始评审与源码判断。</p>
        )}
        {finding.acceptedReason ? (
          <p className="ck-ex-summary-evidence">接受不修原因：{finding.acceptedReason}</p>
        ) : null}
      </section>
      <section className="ck-ex-summary-section" aria-label="关联位置">
        <div className="ck-ex-summary-heading">
          <h3>关联位置</h3>
          <span>{finding.anchors.length} 处引用</span>
        </div>
        {finding.anchors.length ? (
          finding.anchors.map((anchor, index) => (
            <button
              type="button"
              className={`ck-ex-summary-anchor ${anchor.status}`}
              key={`${anchor.path ?? "unknown"}:${anchor.side}:${anchor.line}:${index}`}
              disabled={
                (anchor.status === "context" && contextPending) ||
                (anchor.status === "unresolved" && !canLocateUnresolved)
              }
              onClick={() => onLocateAnchor(anchor)}
            >
              <span>
                {anchor.path ?? "原评审未提供可确认的位置"}
                {anchor.line
                  ? `:${anchor.line}${anchor.endLine && anchor.endLine > anchor.line ? `–${anchor.endLine}` : ""}`
                  : ""}
              </span>
              <small>
                {anchor.side ? `${anchor.side === "old" ? "旧" : "新"}侧 · ` : ""}
                {anchor.status === "resolved"
                  ? "定位代码"
                  : anchor.status === "context"
                    ? "查看冻结上下文"
                    : "无法定位"}
                {anchor.reason ? ` · ${anchor.reason}` : ""}
              </small>
            </button>
          ))
        ) : (
          <p className="ck-ex-muted">暂无确认位置，原始评审与当前代码仍可阅读。</p>
        )}
        {finding.files.length ? (
          <details className="ck-ex-summary-files">
            <summary>原评审引用文件</summary>
            {finding.files.map((file) => (
              <code key={file}>{file}</code>
            ))}
          </details>
        ) : null}
      </section>
      <details className="ck-ex-summary-original">
        <summary>完整原始评审</summary>
        <p className="ck-ex-summary-original-title">{finding.title}</p>
        <p className="ck-ex-prose">{finding.text}</p>
        <p className="ck-ex-summary-source">
          Finding ID · <code>{finding.id}</code>
        </p>
      </details>
    </div>
  );
}
