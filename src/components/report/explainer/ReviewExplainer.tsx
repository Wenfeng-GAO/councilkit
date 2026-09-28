import { isFindingVerifiedClosed } from "@shared/runtime/cli-ledger";
import type {
  ExplainerFinding,
  FindingAnchor,
  FindingDecision,
  FrozenFileContent,
  ReviewComparison,
  ReviewExplainerWorkspace,
} from "@shared/runtime/review-explainer/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ExternalLinkIcon,
  FilesIcon,
  InfoIcon,
  PanelLeftCloseIcon,
} from "../workbench/icons";
import { DiffDocument, type DiffLayout } from "./DiffDocument";
import type { CodeLocation } from "./ExplanationDiagram";
import { ExplanationPane } from "./ExplanationPane";
import { ReviewNavigation } from "./ReviewNavigation";
import { ExplainerRequestError, errorMessage, explainerApi } from "./api";
import { explainerUi as UI } from "./ui";
import {
  type ReviewFilters,
  findingDisplayStatus,
  findingDisplayTitle,
  findingMatchesFile,
  hasDiffLocation,
  initialReviewFilters,
  isActiveFinding,
  locationFile,
  matchesFinding,
} from "./view-model";
import "@/styles/review-explainer.css";

type Props = { runId: string; title: string; onBack: () => void };
type ComparisonMode = "full" | "last-commit";
/** A Run owns its entire UI and all pending requests; changing Runs remounts that boundary. */
export function ReviewExplainer(props: Props) {
  return <ReviewExplainerRun key={props.runId} {...props} />;
}
function anchorLocation(anchor: FindingAnchor | undefined): CodeLocation | null {
  return anchor?.path && anchor.side && anchor.line
    ? { path: anchor.path, side: anchor.side, line: anchor.line }
    : null;
}
function ReviewExplainerRun({ runId, title, onBack }: Props) {
  const [workspace, setWorkspace] = useState<ReviewExplainerWorkspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(() => window.innerWidth > 1200);
  const [paneTab, setPaneTab] = useState<"summary" | "explanation" | "original">("summary");
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 1200);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("councilkit-review-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [wrap, setWrap] = useState(false);
  const [tab, setTab] = useState<"issues" | "files">("issues");
  const [filters, setFilters] = useState<ReviewFilters>(initialReviewFilters);
  const [mode, setMode] = useState<ComparisonMode>("full");
  const [comparison, setComparison] = useState<ReviewComparison | null>(null);
  const [comparisonPending, setComparisonPending] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const [activePath, setActivePath] = useState("");
  const [focus, setFocus] = useState<CodeLocation | null>(null);
  const [locationNotice, setLocationNotice] = useState("");
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
  const pane = useRef<HTMLElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const initialized = useRef(false);
  const contextSequence = useRef(0);
  const pendingPosition = useRef<CodeLocation | null>(null);
  const collapsed = useMemo(() => new Set<string>(), []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      contextSequence.current++;
    };
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1200px)");
    const change = () => {
      setNarrow(media.matches);
      if (media.matches) setPaneOpen(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("councilkit-review-theme", theme);
    } catch {
      /* Theme remains usable without storage. */
    }
  }, [theme]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly requests the same frozen workspace again.
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    void explainerApi
      .workspace(runId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !alive.current) return;
        setWorkspace(data);
        if (!initialized.current) {
          initialized.current = true;
          const first =
            data.findings.find((finding) => finding.status === "open") ??
            data.findings.find((finding) => isActiveFinding(finding, data.identity.headSha)) ??
            data.findings[0];
          if (!data.findings.some((finding) => isActiveFinding(finding, data.identity.headSha)))
            setFilters({ ...initialReviewFilters, status: "all" });
          setSelectedId(first?.id ?? null);
          const location = first?.anchors
            .filter((anchor) => anchor.status === "resolved")
            .map(anchorLocation)
            .find((item) => item && hasDiffLocation(data.files, item));
          setActivePath(
            location
              ? (locationFile(data.files, location)?.path ?? "")
              : (data.files[0]?.path ?? ""),
          );
          if (location) {
            setFocus(location);
            pendingPosition.current = location;
            setPositionToken((token) => token + 1);
          } else if (first)
            setLocationNotice(
              first.anchors.find((anchor) => anchor.reason)?.reason ??
                "没有可确认的 Diff 位置，保留当前代码。",
            );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && alive.current) setLoadError(errorMessage(error));
      });
    return () => controller.abort();
  }, [runId, reload]);
  useEffect(() => {
    if (mode === "full") return;
    const controller = new AbortController();
    setComparison(null);
    setComparisonPending(true);
    setComparisonError("");
    void explainerApi
      .comparison(runId, "last-commit", controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !alive.current) return;
        setComparison(result);
        setActivePath((path) =>
          result.files.some((file) => file.path === path) ? path : (result.files[0]?.path ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && alive.current) setComparisonError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && alive.current) setComparisonPending(false);
      });
    return () => controller.abort();
  }, [mode, runId]);
  const decision = useCallback(
    (finding: ExplainerFinding): FindingDecision =>
      workspace?.decisions.items[finding.id]?.decision ?? finding.decision,
    [workspace],
  );
  const numbers = useMemo(
    () => new Map(workspace?.findings.map((finding, index) => [finding.id, index + 1]) ?? []),
    [workspace],
  );
  const visibleFindings = useMemo(
    () =>
      workspace?.findings.filter((finding, index) =>
        matchesFinding(finding, index + 1, decision(finding), filters, workspace.identity.headSha),
      ) ?? [],
    [workspace, filters, decision],
  );
  const navigation = tab === "issues" ? visibleFindings : (workspace?.findings ?? []);
  const selected = navigation.find((finding) => finding.id === selectedId) ?? navigation[0] ?? null;
  const selectedIndex = selected
    ? navigation.findIndex((finding) => finding.id === selected.id)
    : -1;
  const files =
    mode === "full"
      ? (workspace?.files ?? [])
      : comparison?.availability === "available"
        ? comparison.files
        : [];
  const totals = mode === "full" ? workspace?.totals : comparison?.totals;
  const fromSha = mode === "full" ? workspace?.identity.mergeBaseSha : comparison?.fromSha;
  const toSha = mode === "full" ? workspace?.identity.headSha : comparison?.toSha;
  const activeContext =
    mode === "full" ? contexts.find((content) => content.path === activePath) : undefined;
  const activeFile =
    files.find((file) => file.path === activePath) ??
    (activeContext
      ? {
          path: activeContext.path,
          oldPath: activeContext.side === "old" ? activeContext.path : null,
          newPath: activeContext.side === "new" ? activeContext.path : null,
          status: "modified" as const,
          binary: false,
          hunks: [],
          additions: 0,
          deletions: 0,
        }
      : files[0]);
  const activeFindings = activeFile
    ? (workspace?.findings.filter((finding) => findingMatchesFile(finding, activeFile)) ?? [])
    : [];
  const invalidateContext = useCallback(() => {
    contextSequence.current++;
    setContextPending(false);
    setContextError("");
  }, []);
  const revealCode = useCallback(() => {
    if (!narrow) return;
    setPaneOpen(false);
    requestAnimationFrame(() => scroller.current?.focus({ preventScroll: true }));
  }, [narrow]);
  const setPosition = useCallback((location: CodeLocation, path: string) => {
    setActivePath(path);
    setFocus(location);
    setLocationNotice("");
    pendingPosition.current = location;
    setPositionToken((token) => token + 1);
  }, []);
  const locateFinding = useCallback(
    (finding: ExplainerFinding, range: ComparisonMode = mode) => {
      invalidateContext();
      const rangeFiles =
        range === "full"
          ? (workspace?.files ?? [])
          : comparison?.availability === "available"
            ? comparison.files
            : [];
      const anchors = finding.anchors.filter((anchor) => anchor.status === "resolved");
      const candidates = anchors
        .map(anchorLocation)
        .filter((location): location is CodeLocation => !!location);
      const target = candidates.find(
        (location) =>
          (range === "full" || location.side === "new") && hasDiffLocation(rangeFiles, location),
      );
      if (target) {
        setPosition(target, locationFile(rangeFiles, target)?.path ?? target.path);
        return;
      }
      if (range === "last-commit" && candidates.some((location) => location.side === "old")) {
        const old = candidates.find((location) => location.side === "old");
        setMode("full");
        setComparisonPending(false);
        contextSequence.current++;
        setContextPending(false);
        if (old && workspace && hasDiffLocation(workspace.files, old))
          setPosition(old, locationFile(workspace.files, old)?.path ?? old.path);
        else setLocationNotice("原定位来自完整比较的旧版本；已返回全部变更，引用行不在 Diff 中。");
        return;
      }
      setFocus(null);
      setLocationNotice(
        range === "last-commit"
          ? "此问题的位置不在最后一次提交的 Diff 中。保留当前代码，可返回全部变更定位。"
          : (finding.anchors.find((anchor) => anchor.reason)?.reason ??
              "引用位置不在当前 Diff 中，保留当前代码。可查看冻结源码上下文。"),
      );
    },
    [mode, workspace, comparison, setPosition, invalidateContext],
  );
  useEffect(() => {
    if (selected?.id === selectedId) return;
    contextSequence.current++;
    setContextPending(false);
    setSelectedId(selected?.id ?? null);
    if (selected) locateFinding(selected);
    else {
      setFocus(null);
      setLocationNotice("");
    }
  }, [selected, selectedId, locateFinding]);
  useLayoutEffect(() => {
    if (!positionToken || !pendingPosition.current) return;
    const frame = requestAnimationFrame(() => {
      const location = pendingPosition.current;
      const root = view.current;
      const scroll = scroller.current;
      if (!location || !root || !scroll) return;
      const target = root.querySelector<HTMLElement>(
        `[data-testid="${CSS.escape(UI.line(location.side, location.path, location.line))}"]`,
      );
      if (!target) return;
      scroll.scrollTo({
        top: Math.max(
          0,
          scroll.scrollTop +
            target.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top -
            80,
        ),
        behavior: "auto",
      });
      const horizontal = target.closest<HTMLElement>(".ck-ex-code-scroll");
      if (horizontal) {
        if (target.tagName === "TR") horizontal.scrollLeft = 0;
        else {
          const targetRect = target.getBoundingClientRect();
          const viewport = horizontal.getBoundingClientRect();
          if (targetRect.left < viewport.left + 8 || targetRect.right > viewport.right - 8)
            horizontal.scrollTo({
              left: Math.max(0, horizontal.scrollLeft + targetRect.left - viewport.left - 10),
              behavior: "auto",
            });
        }
      }
      pendingPosition.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [positionToken]);
  const selectFinding = (finding: ExplainerFinding, explain = false) => {
    contextSequence.current++;
    setContextPending(false);
    setContextError("");
    if (tab === "issues" && !visibleFindings.some((item) => item.id === finding.id))
      setFilters({ ...initialReviewFilters, status: "all" });
    setSelectedId(finding.id);
    setPaneTab(explain ? "explanation" : "summary");
    setPaneOpen(true);
    locateFinding(finding);
  };
  const switchRange = (next: ComparisonMode) => {
    contextSequence.current++;
    setContextPending(false);
    setContextError("");
    setFocus(null);
    pendingPosition.current = null;
    setMode(next);
    setComparisonError("");
    setLocationNotice(
      next === "last-commit" ? "问题来自完整审查；部分位置可能不在当前比较范围。" : "",
    );
    if (next === "full") {
      setComparisonPending(false);
      if (selected) locateFinding(selected, "full");
      else setActivePath(workspace?.files[0]?.path ?? "");
    }
  };
  const locateContext = async (finding: ExplainerFinding, requested?: CodeLocation) => {
    const related =
      finding.anchors.find((anchor) => anchor.status === "context") ??
      finding.anchors.find((anchor) => anchor.status === "resolved");
    const location = requested ?? anchorLocation(related);
    if (!location) {
      setLocationNotice("原评审未提供可以读取的文件与行号。");
      return;
    }
    const sequence = ++contextSequence.current;
    setMode("full");
    setComparisonPending(false);
    setContextPending(true);
    setContextError("");
    try {
      const content = await explainerApi.file(runId, location.path, location.side);
      if (!alive.current || contextSequence.current !== sequence) return;
      if (content.availability !== "available")
        throw new Error(
          content.availability === "binary"
            ? "关联源码为二进制文件。"
            : "关联文件在此冻结版本中不存在。",
        );
      if (!content.lines.some((line) => line.number === location.line))
        throw new Error("引用行超出冻结源码范围，当前代码保持不变。");
      setContexts((previous) => [
        ...previous.filter((item) => !(item.path === content.path && item.side === content.side)),
        content,
      ]);
      setPosition(location, locationFile(workspace?.files ?? [], location)?.path ?? content.path);
      revealCode();
    } catch (error) {
      if (alive.current && contextSequence.current === sequence)
        setContextError(errorMessage(error));
    } finally {
      if (alive.current && contextSequence.current === sequence) setContextPending(false);
    }
  };
  const locateAnchor = (anchor: FindingAnchor) => {
    if (!selected) return;
    invalidateContext();
    const location = anchorLocation(anchor);
    if (!location || anchor.status === "unresolved") {
      setLocationNotice(anchor.reason ?? "原评审未提供可以确认的位置，当前代码保持不变。");
      return;
    }
    if (anchor.status === "context") {
      void locateContext(selected, location);
      return;
    }
    revealCode();
    if (mode === "last-commit" && location.side === "old") {
      switchRange("full");
      if (hasDiffLocation(workspace?.files ?? [], location))
        setPosition(
          location,
          locationFile(workspace?.files ?? [], location)?.path ?? location.path,
        );
      else setLocationNotice("已返回全部变更；原引用行不在 Diff 中，可查看冻结源码上下文。");
      return;
    }
    if (hasDiffLocation(files, location))
      setPosition(location, locationFile(files, location)?.path ?? location.path);
    else {
      setFocus(null);
      setLocationNotice("引用行不在当前比较的 Diff 中，保留当前代码。");
    }
  };
  const decide = async (findingId: string, choice: FindingDecision, reason?: string) => {
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
        reason,
      );
      if (!alive.current) return;
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
      try {
        const refreshed = await explainerApi.workspace(runId);
        if (!alive.current) return;
        setWorkspace(refreshed);
      } catch {
        if (alive.current) setNotice("选择已保存，但清单重新读取失败，请刷新后确认。");
        return;
      }
      setNotice(
        choice === "will_fix"
          ? "已加入修复与验收清单"
          : choice === "wont_fix"
            ? "已记录不修复，同一评审点将在后续审查中跳过"
            : "已保存为待决定",
      );
    } catch (error) {
      if (!alive.current) return;
      setSaveError(`选择未保存：${errorMessage(error)}`);
      if (error instanceof ExplainerRequestError && error.status === 409) {
        try {
          const refreshed = await explainerApi.workspace(runId);
          if (alive.current) setWorkspace(refreshed);
        } catch {
          /* Keep the last acknowledged choices. */
        }
      }
    } finally {
      if (alive.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  const fixCount =
    workspace?.findings.filter((finding) => decision(finding) === "will_fix").length ?? 0;
  const exportSelected = async () => {
    if (exporting || saving || !fixCount) return;
    setExporting(true);
    setNotice("");
    try {
      const task = await explainerApi.repairPackage(runId);
      if (!alive.current) return;
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
      if (alive.current) setSaveError(`导出失败：${errorMessage(error)}`);
    } finally {
      if (alive.current) setExporting(false);
    }
  };
  const closePane = useCallback(() => {
    setPaneOpen(false);
    requestAnimationFrame(() => restoreButton.current?.focus());
  }, []);
  useEffect(() => {
    if (!paneOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !view.current?.querySelector("dialog[open]")) {
        event.preventDefault();
        closePane();
      }
      if (event.key !== "Tab" || !narrow || view.current?.querySelector("dialog[open]")) return;
      const nodes = [
        ...(pane.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),textarea:not(:disabled),summary,[href]",
        ) ?? []),
      ].filter((element) => element.getClientRects().length);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (!pane.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    if (narrow) pane.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", keydown);
  }, [paneOpen, narrow, closePane]);
  const activeCount =
    workspace?.findings.filter((finding) => isActiveFinding(finding, workspace.identity.headSha))
      .length ?? 0;
  const openMajor =
    workspace?.findings.filter(
      (finding) =>
        isActiveFinding(finding, workspace.identity.headSha) &&
        (finding.severity === "major" || finding.severity === "critical"),
    ).length ?? 0;
  const closedCount =
    workspace?.findings.filter((finding) =>
      isFindingVerifiedClosed(finding, workspace.identity.headSha),
    ).length ?? 0;
  const acceptedCount =
    workspace?.findings.filter((finding) => finding.status === "accepted").length ?? 0;
  const decidedCount =
    workspace?.findings.filter((finding) => decision(finding) !== "undecided").length ?? 0;
  const locatedInActiveFile = focus && activeFile && locationFile([activeFile], focus);
  return (
    <div
      ref={view}
      className={`ck-explainer ck-ex-v2 ${paneOpen ? "with-pane" : ""} ${wrap ? "wrap-code" : ""}`}
      data-theme={theme}
      data-testid={UI.root}
    >
      <header className="ck-ex-header">
        <button className="ck-ex-back" type="button" onClick={onBack}>
          ← 返回报告
        </button>
        <span className="ck-ex-brand">CouncilKit</span>
        <h1 title={title}>{title}</h1>
        {workspace?.identity.prUrl ? (
          <a
            className="ck-ex-pr-link"
            href={workspace.identity.prUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="打开原始 Pull Request"
          >
            <ExternalLinkIcon />
          </a>
        ) : null}
        <div className="ck-ex-header-actions">
          <span>冻结审查快照</span>
          <button
            type="button"
            aria-label="切换主题"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? "深色" : "浅色"}
          </button>
          <button
            type="button"
            disabled={exporting || saving || !fixCount}
            onClick={() => void exportSelected()}
          >
            <ArrowDownIcon />
            导出修复清单
          </button>
        </div>
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
        <>
          <section className="ck-ex-overview" aria-label="审查概览">
            <div className="ck-ex-stats">
              <span>
                <strong>{activeCount}</strong> 未关闭
              </span>
              <span>
                其中 <strong className="removed">{openMajor}</strong> Major / Critical
              </span>
              <span>
                <strong>{closedCount}</strong> 已验证关闭
              </span>
              {acceptedCount ? (
                <span>
                  <strong>{acceptedCount}</strong> 已接受
                </span>
              ) : null}
              <span className="ck-ex-decided-count">
                <strong>
                  {decidedCount}/{workspace.findings.length}
                </strong>{" "}
                已决定
              </span>
            </div>
            <div className="ck-ex-scope">
              <label htmlFor="review-comparison">比较范围</label>
              <select
                id="review-comparison"
                aria-label="比较范围"
                value={mode}
                onChange={(event) => switchRange(event.target.value as ComparisonMode)}
              >
                <option value="full">全部变更</option>
                <option value="last-commit">最后一次提交</option>
              </select>
              <code
                data-testid={UI.identity}
                title={`${fromSha ?? "尚未获取"} → ${toSha ?? workspace.identity.headSha}`}
              >
                {fromSha?.slice(0, 7) ?? "—"} → {(toSha ?? workspace.identity.headSha).slice(0, 7)}
              </code>
            </div>
          </section>
          <div className="ck-ex-workspace">
            <ReviewNavigation
              tab={tab}
              onTab={(next) => {
                setTab(next);
                setFilters((previous) => ({ ...previous, query: "" }));
              }}
              files={files}
              findings={workspace.findings}
              visibleFindings={visibleFindings}
              numbers={numbers}
              filters={filters}
              onFilters={setFilters}
              selectedId={selected?.id ?? null}
              activePath={activeFile?.path ?? ""}
              decision={decision}
              onFinding={(finding) => selectFinding(finding)}
              onFile={(file) => {
                contextSequence.current++;
                setContextPending(false);
                setActivePath(file.path);
                pendingPosition.current = null;
                scroller.current?.scrollTo({ top: 0 });
              }}
              sha={workspace.identity.headSha}
            />
            <main className="ck-ex-main">
              <div className="ck-ex-toolbar" data-testid={UI.stickyHeader}>
                <div className="ck-ex-current-file">
                  <FilesIcon />
                  <div>
                    <span>{activeFile?.path.split("/").slice(0, -1).join("/") || "变更文件"}</span>
                    <strong title={activeFile?.path}>
                      {activeFile?.path.split("/").slice(-1)[0] ??
                        (comparisonPending ? "正在读取比较…" : "当前范围无文件")}
                    </strong>
                  </div>
                </div>
                <div className="ck-ex-toolbar-actions">
                  {activeFile ? (
                    <div className="ck-ex-current-stats">
                      <span className="added">+{activeFile.additions}</span>
                      <span className="removed">−{activeFile.deletions}</span>
                    </div>
                  ) : null}
                  <div className="ck-ex-layout" aria-label="Diff 布局">
                    <button
                      type="button"
                      data-testid={UI.layoutSplit}
                      aria-pressed={layout === "split"}
                      onClick={() => {
                        setLayout("split");
                        if (focus) {
                          pendingPosition.current = focus;
                          setPositionToken((token) => token + 1);
                        }
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
                        if (focus) {
                          pendingPosition.current = focus;
                          setPositionToken((token) => token + 1);
                        }
                      }}
                    >
                      统一
                    </button>
                  </div>
                  <button
                    type="button"
                    className="ck-ex-wrap"
                    aria-pressed={wrap}
                    onClick={() => setWrap((value) => !value)}
                  >
                    折行
                  </button>
                  {!paneOpen ? (
                    <button
                      ref={restoreButton}
                      type="button"
                      aria-label="展开问题详情"
                      onClick={() => setPaneOpen(true)}
                    >
                      <PanelLeftCloseIcon />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="ck-ex-range-meta">
                <span>
                  {mode === "full" ? "全部变更" : "最后一次提交"} · {fromSha?.slice(0, 7) ?? "—"} →{" "}
                  {(toSha ?? workspace.identity.headSha).slice(0, 7)}
                </span>
                <span>
                  {totals?.files ?? 0} 文件 <span className="added">+{totals?.additions ?? 0}</span>{" "}
                  <span className="removed">−{totals?.deletions ?? 0}</span>
                </span>
              </div>
              {activeFile ? (
                <div className="ck-ex-related">
                  <span>关联问题 {activeFindings.length}</span>
                  {activeFindings.map((finding) => (
                    <button
                      key={finding.id}
                      type="button"
                      aria-pressed={finding.id === selected?.id}
                      title={findingDisplayTitle(finding)}
                      onClick={() => selectFinding(finding)}
                    >
                      <i className={finding.severity} />#{numbers.get(finding.id)}
                      {finding.status === "closed" || finding.status === "accepted"
                        ? ` · ${findingDisplayStatus(finding, workspace.identity.headSha)}`
                        : ""}
                    </button>
                  ))}
                </div>
              ) : null}
              {selected ? (
                <div
                  className={`ck-ex-location ${locationNotice ? "unavailable" : locatedInActiveFile ? "located" : ""}`}
                  aria-live="polite"
                  data-testid="review-explainer-location"
                >
                  <InfoIcon />
                  <span>
                    {locationNotice ||
                      (locatedInActiveFile
                        ? `#${numbers.get(selected.id)} · 已定位到${focus?.side === "old" ? "旧" : "新"}版第 ${focus?.line} 行`
                        : `正在浏览其他文件 · 问题 #${numbers.get(selected.id)}`)}
                    {mode === "last-commit" ? (
                      <>
                        {" "}
                        · 问题来自完整审查{" "}
                        <button type="button" onClick={() => switchRange("full")}>
                          查看全部变更
                        </button>
                      </>
                    ) : !locatedInActiveFile && !locationNotice ? (
                      <button
                        type="button"
                        onClick={() => {
                          locateFinding(selected);
                          revealCode();
                        }}
                      >
                        返回问题位置
                      </button>
                    ) : null}
                  </span>
                </div>
              ) : null}
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
              <div
                className="ck-ex-diff-scroll ck-ex-single-file"
                ref={scroller}
                data-testid={UI.diff}
                tabIndex={-1}
                aria-label="变更代码"
              >
                {comparisonPending && mode === "last-commit" ? (
                  <p className="ck-ex-empty" aria-live="polite">
                    正在读取冻结 head 的最后一次提交…
                  </p>
                ) : mode === "last-commit" &&
                  (comparisonError || comparison?.availability === "unavailable") ? (
                  <div className="ck-ex-empty" aria-live="polite">
                    <h2>最后一次提交不可用</h2>
                    <p>{comparisonError || comparison?.reason}</p>
                    <button type="button" onClick={() => switchRange("full")}>
                      查看全部变更
                    </button>
                  </div>
                ) : activeFile ? (
                  <DiffDocument
                    files={[activeFile]}
                    findings={workspace.findings}
                    layout={layout}
                    selectedId={selected?.id ?? null}
                    focus={focus}
                    contexts={mode === "full" ? contexts : []}
                    collapsed={collapsed}
                    saving={saving}
                    contextPending={contextPending}
                    decision={decision}
                    onToggleFile={() => {}}
                    onSelect={selectFinding}
                    onDecide={(id, choice) => void decide(id, choice)}
                    onContext={(finding) => void locateContext(finding)}
                    hideInlineFindings
                    singleFile
                  />
                ) : (
                  <div className="ck-ex-empty">
                    <h2>当前比较没有文件变更</h2>
                    <p>{comparison?.notice || "审查问题与决定仍可在侧栏查看。"}</p>
                  </div>
                )}
              </div>
              <footer className="ck-ex-diff-footer">
                <span>
                  {activeContext && !files.some((file) => file.path === activeContext.path)
                    ? "冻结源码上下文 · 不计入变更统计"
                    : `${activeFile?.hunks.length ?? 0} 个变更片段 · ${files.length} 个文件`}
                </span>
                <span>未附意见不表示已审查通过</span>
              </footer>
            </main>
            {paneOpen && narrow ? (
              <button
                className="ck-ex-drawer-backdrop"
                type="button"
                aria-label="关闭问题详情"
                onClick={closePane}
              />
            ) : null}
            <aside
              ref={pane}
              className="ck-ex-pane"
              data-testid={UI.drawer}
              aria-label="问题详情"
              role={narrow && paneOpen ? "dialog" : "complementary"}
              aria-modal={narrow && paneOpen ? true : undefined}
              hidden={!paneOpen}
            >
              {selected && paneOpen ? (
                <ExplanationPane
                  key={`${runId}:${selected.id}:${paneTab}`}
                  runId={runId}
                  finding={selected}
                  headSha={workspace.identity.headSha}
                  number={numbers.get(selected.id)}
                  total={navigation.length}
                  initialTab={paneTab}
                  reason={selected.decisionReason}
                  decision={decision(selected)}
                  saving={saving}
                  contextPending={contextPending}
                  onDecide={(id, choice, reason) => void decide(id, choice, reason)}
                  onBack={closePane}
                  onPrevious={
                    selectedIndex > 0
                      ? () => selectFinding(navigation[selectedIndex - 1])
                      : undefined
                  }
                  onNext={
                    selectedIndex >= 0 && selectedIndex < navigation.length - 1
                      ? () => selectFinding(navigation[selectedIndex + 1])
                      : undefined
                  }
                  onContext={() => void locateContext(selected)}
                  onLocateAnchor={locateAnchor}
                  onLocate={(location) => {
                    invalidateContext();
                    revealCode();
                    if (mode === "full" && hasDiffLocation(files, location))
                      setPosition(location, locationFile(files, location)?.path ?? location.path);
                    else void locateContext(selected, location);
                  }}
                />
              ) : (
                <div className="ck-ex-empty">
                  <button type="button" onClick={closePane}>
                    收起详情
                  </button>
                  <h2>没有匹配的问题</h2>
                  <p>调整筛选或搜索后继续审查。</p>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
      <output className="ck-ex-notification" aria-live="polite">
        {saving
          ? "正在保存选择…"
          : notice || workspace?.notice || "决定保存到本次审查；修复意图与验证状态分别记录。"}
      </output>
    </div>
  );
}
