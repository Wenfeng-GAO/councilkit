import type {
  DiffFile,
  ExplainerFinding,
  FindingDecision,
} from "@shared/runtime/review-explainer/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FilesIcon, SearchIcon } from "../workbench/icons";
import { explainerUi as UI } from "./ui";
import {
  type ReviewFilters,
  decisionLabels,
  findingDisplayStatus,
  findingDisplayTitle,
  findingMatchesFile,
  isActiveFinding,
  parentPaths,
} from "./view-model";

interface TreeNode {
  path: string;
  name: string;
  file?: DiffFile;
  children: Map<string, TreeNode>;
}
function makeTree(files: DiffFile[]) {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, children: new Map() };
        node.children.set(name, child);
      }
      node = child;
      if (index === parts.length - 1) node.file = file;
    });
  }
  return root;
}
interface Props {
  summaryTitles?: Record<string, string>;
  tab: "issues" | "files";
  onTab: (tab: "issues" | "files") => void;
  files: DiffFile[];
  findings: ExplainerFinding[];
  visibleFindings: ExplainerFinding[];
  numbers: Map<string, number>;
  filters: ReviewFilters;
  onFilters: (filters: ReviewFilters) => void;
  selectedId: string | null;
  activePath: string;
  decision: (finding: ExplainerFinding) => FindingDecision;
  onFinding: (finding: ExplainerFinding) => void;
  onFile: (file: DiffFile) => void;
  sha: string;
}
export function ReviewNavigation(props: Props) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setExpanded((old) => new Set([...old, ...parentPaths(props.activePath)]));
  }, [props.activePath]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these state changes replace the selected DOM row or reveal its parent folders.
  useLayoutEffect(() => {
    const container = list.current;
    const selected = container?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!selected || !container) return;
    const top = selected.getBoundingClientRect().top - container.getBoundingClientRect().top;
    if (top < 8) container.scrollTop += top - 8;
    else if (top + selected.offsetHeight > container.clientHeight - 8)
      container.scrollTop += top + selected.offsetHeight - container.clientHeight + 8;
  }, [props.selectedId, props.activePath, props.tab, expanded]);
  const query = props.filters.query.trim().toLocaleLowerCase();
  const files = props.files.filter(
    (file) => !query || file.path.toLocaleLowerCase().includes(query),
  );
  const openCount = (path: string, file?: DiffFile) =>
    props.findings.filter(
      (finding) =>
        isActiveFinding(finding, props.sha) &&
        (file
          ? findingMatchesFile(finding, file)
          : files.some(
              (candidate) =>
                candidate.path.startsWith(`${path}/`) && findingMatchesFile(finding, candidate),
            )),
    ).length;
  const branch = (node: TreeNode, depth = 0): React.ReactNode =>
    [...node.children.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
      .map((child) => {
        const count = openCount(child.path, child.file);
        if (child.file) {
          const file = child.file;
          return (
            <button
              key={file.path}
              type="button"
              className="ck-ex-tree-row"
              style={{ paddingLeft: 9 + depth * 12 }}
              data-testid={UI.fileRow(file.path)}
              aria-current={props.activePath === file.path ? "true" : undefined}
              title={file.path}
              onClick={() => props.onFile(file)}
            >
              <span className="ck-ex-tree-spacer" />
              <FilesIcon />
              <span className="ck-ex-tree-label">{child.name}</span>
              {count ? (
                <small>{count}</small>
              ) : (
                <small>
                  {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
                </small>
              )}
            </button>
          );
        }
        const isExpanded = !!query || expanded.has(child.path);
        return (
          <div key={child.path}>
            <button
              type="button"
              className="ck-ex-tree-row directory"
              style={{ paddingLeft: 9 + depth * 12 }}
              aria-expanded={isExpanded}
              title={child.path}
              onClick={() =>
                setExpanded((old) => {
                  const next = new Set(old);
                  if (next.has(child.path)) next.delete(child.path);
                  else next.add(child.path);
                  return next;
                })
              }
            >
              {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              <span className="ck-ex-tree-label">{child.name}</span>
              {count ? <small>{count}</small> : null}
            </button>
            {isExpanded ? branch(child, depth + 1) : null}
          </div>
        );
      });
  return (
    <nav className="ck-ex-navigation" aria-label="问题与变更文件">
      <div className="ck-ex-nav-tabs" role="tablist" aria-label="导航方式">
        {(["issues", "files"] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab}
            aria-selected={props.tab === tab}
            onClick={() => props.onTab(tab)}
          >
            {tab === "issues" ? "问题" : "文件"}
            <span>{tab === "issues" ? props.findings.length : props.files.length}</span>
          </button>
        ))}
      </div>
      <div className="ck-ex-search">
        <SearchIcon />
        <input
          type="search"
          aria-label="搜索问题或文件"
          placeholder={props.tab === "issues" ? "搜索问题、文件或编号…" : "搜索变更文件…"}
          value={props.filters.query}
          onChange={(event) => props.onFilters({ ...props.filters, query: event.target.value })}
        />
      </div>
      {props.tab === "issues" ? (
        <div className="ck-ex-nav-filters">
          <select
            aria-label="问题状态"
            value={props.filters.status}
            onChange={(event) =>
              props.onFilters({
                ...props.filters,
                status: event.target.value as ReviewFilters["status"],
              })
            }
          >
            <option value="active">未关闭</option>
            <option value="all">全部状态</option>
            <option value="closed">已验证关闭</option>
            <option value="accepted">已接受</option>
            <option value="regress">重新出现</option>
          </select>
          <select
            aria-label="严重程度"
            value={props.filters.severity}
            onChange={(event) =>
              props.onFilters({
                ...props.filters,
                severity: event.target.value as ReviewFilters["severity"],
              })
            }
          >
            <option value="all">全部等级</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="nit">Nit</option>
          </select>
          <select
            aria-label="处理决定"
            value={props.filters.decision}
            onChange={(event) =>
              props.onFilters({
                ...props.filters,
                decision: event.target.value as ReviewFilters["decision"],
              })
            }
          >
            <option value="all">全部决定</option>
            <option value="undecided">待定</option>
            <option value="will_fix">修复</option>
            <option value="wont_fix">不修复</option>
          </select>
        </div>
      ) : null}
      <div className="ck-ex-list-caption">
        <span>
          {props.tab === "issues"
            ? `${props.visibleFindings.length} 个问题`
            : `${files.length} 个变更文件`}
        </span>
        <span>{props.tab === "issues" ? "编号保持不变" : "数字 = 未关闭问题"}</span>
      </div>
      <div
        ref={list}
        className="ck-ex-navigation-scroll"
        data-testid={props.tab === "files" ? UI.fileNav : "review-explainer-findings-nav"}
      >
        {props.tab === "files" ? (
          files.length ? (
            branch(makeTree(files))
          ) : (
            <p className="ck-ex-empty">没有匹配的文件。</p>
          )
        ) : props.visibleFindings.length ? (
          props.visibleFindings.map((finding) => {
            const anchor = finding.anchors.find((item) => item.path);
            const path = anchor?.path ?? finding.files[0];
            const choice = props.decision(finding);
            return (
              <button
                key={finding.id}
                type="button"
                className="ck-ex-issue-row"
                data-testid={`review-explainer-finding-${finding.id}`}
                aria-current={props.selectedId === finding.id ? "true" : undefined}
                title={findingDisplayTitle(finding, props.summaryTitles?.[finding.id])}
                onClick={() => props.onFinding(finding)}
              >
                <span className="ck-ex-issue-meta">
                  <strong>#{props.numbers.get(finding.id)}</strong>
                  <span className={`ck-ex-severity ${finding.severity}`}>{finding.severity}</span>
                  <span className="ck-ex-issue-state">
                    {findingDisplayStatus(finding, props.sha)}
                  </span>
                </span>
                <span className="ck-ex-issue-title">
                  {findingDisplayTitle(finding, props.summaryTitles?.[finding.id])}
                </span>
                {!props.summaryTitles?.[finding.id] && finding.title.length > 80 ? (
                  <span className="ck-ex-title-source">原评审摘录</span>
                ) : null}
                <span className="ck-ex-issue-path" title={path}>
                  {path
                    ? `${path.split("/").slice(-2).join("/")}${anchor?.line ? `:${anchor.line}` : ""}`
                    : "位置尚未确认"}
                </span>
                {choice !== "undecided" ? (
                  <span className="ck-ex-issue-choice">已决定 · {decisionLabels[choice]}</span>
                ) : null}
              </button>
            );
          })
        ) : (
          <p className="ck-ex-empty">
            没有匹配的问题。
            <br />
            调整筛选或搜索后继续。
          </p>
        )}
      </div>
      <footer className="ck-ex-navigation-footer">
        冻结审查快照 · <code>{props.sha.slice(0, 7)}</code>
      </footer>
    </nav>
  );
}
