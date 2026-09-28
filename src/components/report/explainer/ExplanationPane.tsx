import type {
  ExplainerFinding,
  ExplanationResult,
  FindingAnchor,
  FindingDecision,
} from "@shared/runtime/review-explainer/contracts";
import { useEffect, useRef, useState } from "react";
import { DecisionButtons } from "./DecisionButtons";
import { type CodeLocation, ExplanationDiagram } from "./ExplanationDiagram";
import { ExplainerRequestError, errorMessage, explainerApi } from "./api";
import { displayDecisionReason, displayFindingTitle } from "./finding-presentation";
import { explainerUi as UI } from "./ui";
import { findingDisplayStatus } from "./view-model";
import "@/styles/review-explainer-details.css";

type PaneTab = "summary" | "explanation" | "original";
interface ExplanationPaneProps {
  runId: string;
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
  const [status, setStatus] = useState<"reading" | "empty" | "generating" | "ready" | "failed">(
    "reading",
  );
  const [result, setResult] = useState<ExplanationResult | null>(null);
  const [failure, setFailure] = useState("");
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
  useEffect(() => {
    let alive = true;
    const request = ++requestVersion.current;
    void explainerApi
      .explanation(runId, finding.id)
      .then((value) => {
        if (alive && request === requestVersion.current) {
          setResult(value);
          setStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (!alive || request !== requestVersion.current) return;
        if (error instanceof ExplainerRequestError && error.status === 404) setStatus("empty");
        else {
          setStatus("failed");
          setFailure(errorMessage(error));
        }
      });
    return () => {
      alive = false;
      requestVersion.current += 1;
    };
  }, [runId, finding.id]);
  const generate = async () => {
    if (generationRef.current) return;
    generationRef.current = true;
    const request = ++requestVersion.current;
    setStatus("generating");
    setFailure("");
    try {
      const value = await explainerApi.explanation(runId, finding.id, true);
      if (request !== requestVersion.current) return;
      setResult(value);
      setStatus("ready");
    } catch (error) {
      if (request !== requestVersion.current) return;
      setStatus("failed");
      setFailure(errorMessage(error));
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
  const title = displayFindingTitle(finding);
  const payload = result?.payload;
  const hasContext = finding.anchors.some((anchor) => anchor.status === "context");
  const copySuggestion = async () => {
    if (!payload?.suggestedCode) return;
    try {
      await navigator.clipboard.writeText(payload.suggestedCode.after);
      setCopied(true);
    } catch {
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
                {result.cached ? "已缓存的解释" : "解释已生成"} · {result.provenance.modelId}
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
            {status === "reading" ? (
              <p>读取已缓存的解释…</p>
            ) : status === "generating" ? (
              <>
                <h3>正在生成解释…</h3>
                <p>使用原始评审与冻结源码，仅调用解释模型。</p>
              </>
            ) : status === "failed" ? (
              <>
                <h3>解释生成失败</h3>
                <p role="alert">{failure || "解释输出不可用，请重试。"}</p>
                <button
                  type="button"
                  className="ck-ex-primary"
                  data-testid={UI.retry}
                  onClick={() => void generate()}
                >
                  重试解释
                </button>
              </>
            ) : (
              <>
                <h3>按需理解这条意见</h3>
                <p>结合原始评审与对应源码，解释触发前提、后果和建议改法。已有结果会复用缓存。</p>
                <button
                  type="button"
                  className="ck-ex-primary"
                  data-testid={UI.generate}
                  onClick={() => void generate()}
                >
                  生成解释
                </button>
              </>
            )}
            {status !== "reading" && status !== "generating" ? (
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
