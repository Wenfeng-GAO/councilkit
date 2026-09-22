import type {
  ExplainerFinding,
  FindingDecision,
  FrozenFileContent,
  ReviewExplainerWorkspace,
} from "@shared/runtime/review-explainer/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DiffDocument, type DiffLayout } from "./DiffDocument";
import type { CodeLocation } from "./ExplanationDiagram";
import { ExplanationPane } from "./ExplanationPane";
import { primaryLocation } from "./FindingCard";
import { ExplainerRequestError, errorMessage, explainerApi } from "./api";
import { explainerUi as UI } from "./ui";
import "@/styles/review-explainer.css";

export function ReviewExplainer({
  runId,
  title,
  onBack,
}: { runId: string; title: string; onBack: () => void }) {
  const [workspace, setWorkspace] = useState<ReviewExplainerWorkspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  const [layout, setLayout] = useState<DiffLayout>(() =>
    window.innerWidth < 950 ? "unified" : "split",
  );
  const [activePath, setActivePath] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [focus, setFocus] = useState<CodeLocation | null>(null);
  const [contexts, setContexts] = useState<FrozenFileContent[]>([]);
  const [contextPending, setContextPending] = useState(false);
  const [contextError, setContextError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [positionToken, setPositionToken] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const pendingPosition = useRef<{
    location?: CodeLocation;
    path?: string;
    findingId?: string;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly requests a reread of the same run.
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    void explainerApi
      .workspace(runId, controller.signal)
      .then((data) => {
        setWorkspace(data);
        setActivePath(data.files[0]?.path ?? "");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      });
    return () => controller.abort();
  }, [runId, reload]);

  const decision = useCallback(
    (finding: ExplainerFinding): FindingDecision =>
      workspace?.decisions.items[finding.id]?.decision ?? finding.decision,
    [workspace],
  );
  const onToggleFile = useCallback((path: string, hide: boolean) => {
    setCollapsed((previous) => {
      if (previous.has(path) === hide) return previous;
      const next = new Set(previous);
      if (hide) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  const requestLocation = (location: CodeLocation) => {
    const canonical =
      workspace?.files.find(
        (file) => (location.side === "old" ? file.oldPath : file.newPath) === location.path,
      )?.path ?? location.path;
    // Expand the display file without rewriting the frozen source reference.
    const target = location;
    setActivePath(canonical);
    setFocus(target);
    onToggleFile(canonical, false);
    pendingPosition.current = { location: target };
    setPositionToken((token) => token + 1);
  };
  const selectFinding = (finding: ExplainerFinding, explain: boolean) => {
    setSelectedId(finding.id);
    if (explain) setPaneOpen(true);
    const anchor = primaryLocation(finding);
    if (anchor) requestLocation(anchor);
    else {
      pendingPosition.current = { findingId: finding.id };
      setPositionToken((token) => token + 1);
    }
  };
  useLayoutEffect(() => {
    if (positionToken === 0) return;
    const pending = pendingPosition.current;
    if (!pending || !scroller.current || !view.current) return;
    const frame = requestAnimationFrame(() => {
      const root = view.current;
      const scroll = scroller.current;
      if (!root || !scroll) return;
      const selector = pending.location
        ? `[data-testid="${CSS.escape(UI.line(pending.location.side, pending.location.path, pending.location.line))}"]`
        : pending.path
          ? `[data-file-path="${CSS.escape(pending.path)}"]`
          : `[data-testid="${CSS.escape(UI.comment(pending.findingId ?? ""))}"]`;
      const target = root.querySelector<HTMLElement>(selector);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      scroll.scrollTo({
        top: Math.max(0, scroll.scrollTop + targetRect.top - scrollRect.top - 80),
        behavior: "auto",
      });
      pendingPosition.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [positionToken]);

  const locateContext = async (finding: ExplainerFinding, requested?: CodeLocation) => {
    const related = finding.anchors.find(
      (anchor) => anchor.status === "context" && anchor.path && anchor.side && anchor.line,
    );
    const location =
      requested ??
      (related?.path && related.side && related.line
        ? { path: related.path, side: related.side, line: related.line }
        : primaryLocation(finding));
    if (!location || contextPending) return;
    setContextPending(true);
    setContextError("");
    try {
      const content = await explainerApi.file(runId, location.path, location.side);
      if (content.availability !== "available")
        throw new Error(
          content.availability === "binary"
            ? "关联源码为二进制文件。"
            : "关联文件在此冻结版本中不存在。",
        );
      setContexts((previous) => [
        ...previous.filter((item) => !(item.path === content.path && item.side === content.side)),
        content,
      ]);
      setPaneOpen(false);
      requestLocation(location);
    } catch (error) {
      setContextError(errorMessage(error));
    } finally {
      setContextPending(false);
    }
  };
  const decide = async (findingId: string, choice: FindingDecision) => {
    if (!workspace || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const saved = await explainerApi.decide(
        runId,
        findingId,
        choice,
        workspace.decisions.revision,
      );
      setWorkspace((previous) =>
        previous
          ? {
              ...previous,
              decisions: saved,
              revision: saved.revision,
              findings: previous.findings.map((finding) => ({
                ...finding,
                decision:
                  saved.items[finding.id]?.decision ??
                  (finding.id === findingId ? choice : finding.decision),
              })),
            }
          : previous,
      );
      // The Host resolves confirmed aliases; consume its projection instead of
      // duplicating canonical-ID rules in the browser.
      try {
        setWorkspace(await explainerApi.workspace(runId));
      } catch {
        setNotice("选择已保存，但清单重新读取失败，请刷新后确认。");
        return;
      }
      setNotice(
        choice === "will_fix"
          ? "已加入修复与验收清单"
          : choice === "wont_fix"
            ? "已记录不修复，同一评审点将在后续审查中跳过"
            : "已撤回选择，恢复待决定",
      );
    } catch (error) {
      setSaveError(`选择未保存：${errorMessage(error)}`);
      if (error instanceof ExplainerRequestError && error.status === 409) {
        try {
          setWorkspace(await explainerApi.workspace(runId));
        } catch {
          /* Keep the last acknowledged choices visible. */
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const exportSelected = async () => {
    if (
      exporting ||
      saving ||
      !workspace?.findings.some((finding) => decision(finding) === "will_fix")
    )
      return;
    setExporting(true);
    setNotice("");
    try {
      const task = await explainerApi.repairPackage(runId);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(task, null, 2)}\n`], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${runId}-selected-repair.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("已导出修复清单，保留原始断言与验收依据");
    } catch (error) {
      setSaveError(`导出失败：${errorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  };
  const selected = workspace?.findings.find((finding) => finding.id === selectedId) ?? null;
  const fix = workspace?.findings.filter((finding) => decision(finding) === "will_fix") ?? [];
  const skip = workspace?.findings.filter((finding) => decision(finding) === "wont_fix") ?? [];
  const undecided =
    workspace?.findings.filter((finding) => decision(finding) === "undecided") ?? [];
  const findingsList = (rows: ExplainerFinding[], label: string, testId: string) => (
    <section className="ck-ex-decision-list" data-testid={testId}>
      <h3>
        {label}
        <span>{rows.length}</span>
      </h3>
      {rows.length ? (
        <ul>
          {rows.map((finding) => (
            <li key={finding.id}>
              <button type="button" onClick={() => selectFinding(finding, false)}>
                <span>{finding.title}</span>
                <code>{finding.id}</code>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>暂无</p>
      )}
    </section>
  );

  return (
    <div ref={view} className={`ck-explainer ${paneOpen ? "with-pane" : ""}`} data-testid={UI.root}>
      <header className="ck-ex-header">
        <div className="ck-ex-crumb">
          <button type="button" onClick={onBack}>
            ← 返回评审报告
          </button>
          <span>CouncilKit</span>
        </div>
        <div className="ck-ex-title">
          <h1>{title}</h1>
          <span>评审解读</span>
        </div>
        {workspace ? (
          <p data-testid={UI.identity}>
            <span>冻结比较区间</span>
            <code>
              {workspace.identity.baseSha.slice(0, 12)} → {workspace.identity.headSha.slice(0, 12)}
            </code>
            <span>不跟随最新提交变化</span>
          </p>
        ) : null}
      </header>
      {loadError || workspace?.availability === "missing" ? (
        <main className="ck-ex-load-state" data-testid={UI.missing}>
          <h2>冻结源码不可用</h2>
          <p>{loadError || workspace?.notice || "缺少本次审查保存的 diff。"}</p>
          <button type="button" onClick={() => setReload((number) => number + 1)}>
            重新读取
          </button>
        </main>
      ) : !workspace ? (
        <main className="ck-ex-load-state" aria-live="polite">
          正在读取完整 PR diff…
        </main>
      ) : (
        <div className="ck-ex-workspace">
          <nav className="ck-ex-navigation" aria-label="完整文件与评审清单">
            <div className="ck-ex-file-nav" data-testid={UI.fileNav}>
              <h2>
                全部文件 <span>{workspace.totals.files}</span>
              </h2>
              <div className="ck-ex-file-buttons">
                {workspace.files.map((file) => {
                  const count = workspace.findings.filter((finding) => {
                    const location = primaryLocation(finding);
                    return (
                      location !== null &&
                      location.path === (location.side === "old" ? file.oldPath : file.newPath)
                    );
                  }).length;
                  return (
                    <button
                      type="button"
                      key={file.path}
                      data-testid={UI.fileRow(file.path)}
                      aria-current={activePath === file.path ? "true" : undefined}
                      onClick={() => {
                        setActivePath(file.path);
                        setPaneOpen(false);
                        onToggleFile(file.path, false);
                        pendingPosition.current = { path: file.path };
                        setPositionToken((token) => token + 1);
                      }}
                    >
                      <span>{file.path}</span>
                      <small>
                        <span className="added">+{file.additions}</span>
                        <span className="removed">−{file.deletions}</span>
                        <span>{count ? `${count} 条意见` : "未附意见"}</span>
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ck-ex-lists">
              {findingsList(fix, "修复与验收", UI.listFix)}
              {findingsList(skip, "下轮跳过", UI.listSkip)}
              {findingsList(undecided, "待决定", UI.listUndecided)}
            </div>
          </nav>
          <main className="ck-ex-main">
            <div className="ck-ex-toolbar" data-testid={UI.stickyHeader}>
              <div>
                <strong>完整 PR diff</strong>
                <span>
                  {workspace.totals.files} 文件 · {workspace.totals.hunks} 处变更
                </span>
              </div>
              <div className="ck-ex-toolbar-actions">
                <div className="ck-ex-layout" aria-label="Diff 布局">
                  <button
                    type="button"
                    data-testid={UI.layoutSplit}
                    aria-pressed={layout === "split"}
                    onClick={() => {
                      setLayout("split");
                      if (focus) requestLocation(focus);
                    }}
                  >
                    并排
                  </button>
                  <button
                    type="button"
                    data-testid={UI.layoutUnified}
                    aria-pressed={layout === "unified"}
                    onClick={() => {
                      setLayout("unified");
                      if (focus) requestLocation(focus);
                    }}
                  >
                    统一
                  </button>
                </div>
                <button
                  type="button"
                  disabled={exporting || saving || fix.length === 0}
                  title={fix.length === 0 ? "先选择需要修复的评审点" : undefined}
                  onClick={() => void exportSelected()}
                >
                  导出修复清单
                </button>
              </div>
            </div>
            {saveError ? (
              <div className="ck-ex-error" role="alert" data-testid={UI.saveError}>
                {saveError}
              </div>
            ) : null}
            {contextError ? (
              <div className="ck-ex-error" role="alert">
                关联源码读取失败：{contextError}
              </div>
            ) : null}
            <div className="ck-ex-diff-scroll" ref={scroller} data-testid={UI.diff}>
              <p className="ck-ex-diff-intro">全部改动与冻结行号 · 未附评审意见不表示已审查通过</p>
              <DiffDocument
                files={workspace.files}
                findings={workspace.findings}
                layout={layout}
                selectedId={selectedId}
                focus={focus}
                contexts={contexts}
                collapsed={collapsed}
                saving={saving}
                contextPending={contextPending}
                decision={decision}
                onToggleFile={onToggleFile}
                onSelect={selectFinding}
                onDecide={(id, choice) => void decide(id, choice)}
                onContext={(finding) => void locateContext(finding)}
              />
              <p className="ck-ex-end">
                已展示全部 {workspace.totals.files} 个文件与 {workspace.totals.hunks} 个变更片段
              </p>
            </div>
          </main>
          <aside
            className="ck-ex-pane"
            data-testid={UI.drawer}
            aria-label="评审解释"
            hidden={!paneOpen}
          >
            {selected && paneOpen ? (
              <ExplanationPane
                key={`${runId}:${selected.id}`}
                runId={runId}
                finding={selected}
                decision={decision(selected)}
                saving={saving}
                contextPending={contextPending}
                onDecide={(id, choice) => void decide(id, choice)}
                onBack={() => {
                  setPaneOpen(false);
                  const anchor = primaryLocation(selected);
                  if (anchor) requestLocation(anchor);
                }}
                onContext={() => void locateContext(selected)}
                onLocate={(location) => {
                  setPaneOpen(false);
                  if (
                    view.current?.querySelector(
                      `[data-testid="${CSS.escape(UI.line(location.side, location.path, location.line))}"]`,
                    )
                  )
                    requestLocation(location);
                  else void locateContext(selected, location);
                }}
              />
            ) : null}
          </aside>
        </div>
      )}
      <output className="ck-ex-notification" aria-live="polite">
        {saving ? "正在保存选择…" : notice}
      </output>
    </div>
  );
}
