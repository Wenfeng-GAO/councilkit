import type {
  ExplainerFinding,
  ExplanationResult,
  FindingDecision,
} from "@shared/runtime/review-explainer/contracts";
import { useEffect, useRef, useState } from "react";
import { DecisionButtons } from "./DecisionButtons";
import { type CodeLocation, ExplanationDiagram } from "./ExplanationDiagram";
import { ExplainerRequestError, errorMessage, explainerApi } from "./api";
import { explainerUi as UI } from "./ui";

export function ExplanationPane({
  runId,
  finding,
  decision,
  saving,
  contextPending,
  onDecide,
  onBack,
  onContext,
  onLocate,
}: {
  runId: string;
  finding: ExplainerFinding;
  decision: FindingDecision;
  saving: boolean;
  contextPending: boolean;
  onDecide: (id: string, decision: FindingDecision) => void;
  onBack: () => void;
  onContext: () => void;
  onLocate: (location: CodeLocation) => void;
}) {
  const [tab, setTab] = useState<"explanation" | "original">("explanation");
  const [status, setStatus] = useState<"reading" | "empty" | "generating" | "ready" | "failed">(
    "reading",
  );
  const [result, setResult] = useState<ExplanationResult | null>(null);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const generationRef = useRef(false);
  useEffect(() => {
    if (diagramOpen && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [diagramOpen]);
  const closeDiagram = () => {
    dialog.current?.close();
    setDiagramOpen(false);
  };
  useEffect(() => {
    let alive = true;
    void explainerApi
      .explanation(runId, finding.id)
      .then((value) => {
        if (alive) {
          setResult(value);
          setStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (error instanceof ExplainerRequestError && error.status === 404) setStatus("empty");
        else {
          setStatus("failed");
          setFailure(errorMessage(error));
        }
      });
    return () => {
      alive = false;
    };
  }, [runId, finding.id]);
  const generate = async () => {
    if (generationRef.current) return;
    generationRef.current = true;
    setStatus("generating");
    setFailure("");
    try {
      const value = await explainerApi.explanation(runId, finding.id, true);
      setResult(value);
      setStatus("ready");
    } catch (error) {
      setStatus("failed");
      setFailure(errorMessage(error));
    } finally {
      generationRef.current = false;
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
          <code>{finding.id}</code>
          <button type="button" onClick={onBack}>
            返回代码
          </button>
        </div>
        <h2>{finding.title}</h2>
        <div className="ck-ex-tabs" role="tablist" aria-label="评审解释">
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
        {tab === "original" ? (
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
        <DecisionButtons
          decision={decision}
          disabled={saving}
          onDecide={(choice) => onDecide(finding.id, choice)}
        />
        <p>打算修复不等于已修好；不修复仅跳过同一评审点。</p>
      </footer>
      <dialog
        ref={dialog}
        className="ck-ex-dialog"
        aria-label="放大图解"
        onClose={() => setDiagramOpen(false)}
      >
        <header>
          <h2>{finding.title}</h2>
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
