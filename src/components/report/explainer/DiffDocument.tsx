import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  ExplainerFinding,
  FindingDecision,
  FrozenFileContent,
} from "@shared/runtime/review-explainer/contracts";
import { Fragment, type ReactNode } from "react";
import type { CodeLocation } from "./ExplanationDiagram";
import { FindingCard, primaryLocation } from "./FindingCard";
import { explainerUi as UI } from "./ui";

export type DiffLayout = "split" | "unified";
type Row = { old: DiffLine | null; next: DiffLine | null };
function pairLines(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.type === "context") {
      rows.push({ old: line, next: line });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].type !== "context") {
      const changed = lines[index++];
      (changed.type === "delete" ? removed : added).push(changed);
    }
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ old: removed[i] ?? null, next: added[i] ?? null });
  }
  return rows;
}

function CodeRows({
  lines,
  path,
  layout,
  focus,
  contextSide,
  known,
}: {
  lines: DiffLine[];
  path: string;
  layout: DiffLayout;
  focus: CodeLocation | null;
  contextSide?: "old" | "new";
  known?: Set<string>;
}) {
  const lineId = (side: "old" | "new", number: number | null) =>
    number === null || known?.has(`${side}:${number}`) ? undefined : UI.line(side, path, number);
  const highlighted = (line: DiffLine | null, side: "old" | "new") =>
    focus?.path === path &&
    focus.side === side &&
    (side === "old" ? line?.oldLine : line?.newLine) === focus.line;
  const split = layout === "split" && !contextSide;
  if (split)
    return (
      <div className="ck-ex-code-scroll">
        <table className="ck-ex-code split">
          <colgroup>
            <col className="number" />
            <col className="sign" />
            <col />
            <col className="number" />
            <col className="sign" />
            <col />
          </colgroup>
          <tbody>
            {pairLines(lines).map((row, index) => (
              <tr key={`${row.old?.oldLine}:${row.next?.newLine}:${index}`}>
                {(["old", "new"] as const).map((side) => {
                  const line = side === "old" ? row.old : row.next;
                  const number = (side === "old" ? line?.oldLine : line?.newLine) ?? null;
                  const className = `${line?.type ?? "absent"} ${highlighted(line, side) ? "focused" : ""} ${side === "new" ? "new-side" : ""}`;
                  return (
                    <Fragment key={side}>
                      <td className={`ln ${className}`}>{number}</td>
                      <td className={`sign ${className}`}>
                        {line?.type === "add" ? "+" : line?.type === "delete" ? "−" : ""}
                      </td>
                      <td data-testid={lineId(side, number)} className={`source ${className}`}>
                        {line?.text ?? ""}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="ck-ex-code-scroll">
      <table className="ck-ex-code unified">
        <colgroup>
          {!contextSide ? <col className="number" /> : null}
          <col className="number" />
          <col className="sign" />
          <col />
        </colgroup>
        <tbody>
          {lines.map((line, index) => {
            const side = contextSide ?? (line.type === "delete" ? "old" : "new");
            const number = side === "old" ? line.oldLine : line.newLine;
            const className = `${contextSide ? "source-context" : line.type} ${highlighted(line, side) ? "focused" : ""}`;
            return (
              <tr
                key={`${line.oldLine}:${line.newLine}:${index}`}
                className={className}
                data-testid={lineId(side, number)}
              >
                {!contextSide ? <td className="ln">{line.oldLine}</td> : null}
                <td className="ln">{contextSide === "old" ? line.oldLine : line.newLine}</td>
                <td className="sign">
                  {contextSide ? "" : line.type === "add" ? "+" : line.type === "delete" ? "−" : ""}
                </td>
                <td className="source">
                  {line.type === "context" && !contextSide ? (
                    <span data-testid={lineId("old", line.oldLine)}>{line.text}</span>
                  ) : (
                    line.text
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  files: DiffFile[];
  findings: ExplainerFinding[];
  layout: DiffLayout;
  selectedId: string | null;
  focus: CodeLocation | null;
  contexts: FrozenFileContent[];
  collapsed: Set<string>;
  saving: boolean;
  contextPending: boolean;
  decision: (finding: ExplainerFinding) => FindingDecision;
  onToggleFile: (path: string, collapsed: boolean) => void;
  onSelect: (finding: ExplainerFinding, explain: boolean) => void;
  onDecide: (id: string, decision: FindingDecision) => void;
  onContext: (finding: ExplainerFinding) => void;
}
export function DiffDocument(props: Props) {
  const renderCard = (finding: ExplainerFinding) => (
    <FindingCard
      key={finding.id}
      finding={finding}
      selected={finding.id === props.selectedId}
      decision={props.decision(finding)}
      busy={props.saving}
      onSelect={props.onSelect}
      onDecide={props.onDecide}
      onContext={props.onContext}
      contextPending={props.contextPending}
    />
  );
  const renderHunk = (file: DiffFile, hunk: DiffHunk, index: number) => {
    const contents: ReactNode[] = [];
    let chunk: DiffLine[] = [];
    for (const line of hunk.lines) {
      chunk.push(line);
      const attached = props.findings.filter((finding) => {
        const anchor = finding.anchors.find((candidate) => candidate.status === "resolved");
        return (
          anchor?.path === file.path &&
          anchor.line !== undefined &&
          (anchor.side === "old" ? line.oldLine : line.newLine) === anchor.line
        );
      });
      if (attached.length) {
        contents.push(
          <CodeRows
            key={`rows:${contents.length}`}
            lines={chunk}
            path={file.path}
            layout={file.status === "added" ? "unified" : props.layout}
            focus={props.focus}
          />,
        );
        chunk = [];
        contents.push(...attached.map(renderCard));
      }
    }
    if (chunk.length)
      contents.push(
        <CodeRows
          key={`rows:${contents.length}`}
          lines={chunk}
          path={file.path}
          layout={file.status === "added" ? "unified" : props.layout}
          focus={props.focus}
        />,
      );
    return (
      <section
        className="ck-ex-hunk"
        key={`${file.path}:${index}`}
        data-testid={UI.hunk(file.path, index)}
        aria-label={`变更片段 ${index + 1}`}
      >
        <div className="ck-ex-hunk-header">{hunk.header}</div>
        {contents}
      </section>
    );
  };
  const unanchored = props.findings.filter((finding) => !primaryLocation(finding));
  return (
    <>
      {props.files.map((file) => {
        const matching = props.findings.filter(
          (finding) => primaryLocation(finding)?.path === file.path,
        );
        const known = new Set(
          file.hunks.flatMap((hunk) =>
            hunk.lines.flatMap((line) => [
              line.oldLine !== null ? `old:${line.oldLine}` : "",
              line.newLine !== null ? `new:${line.newLine}` : "",
            ]),
          ),
        );
        return (
          <details
            className="ck-ex-file"
            key={file.path}
            data-file-path={file.path}
            open={!props.collapsed.has(file.path)}
            onToggle={(event) => props.onToggleFile(file.path, !event.currentTarget.open)}
          >
            <summary>
              <span className="ck-ex-filename">{file.path}</span>
              {file.status === "renamed" ? (
                <span className="ck-ex-rename">从 {file.oldPath}</span>
              ) : null}
              <span className="ck-ex-file-stats">
                <span className="added">+{file.additions}</span>
                <span className="removed">−{file.deletions}</span>
              </span>
            </summary>
            {file.binary ? (
              <div className="ck-ex-file-notice" data-testid={UI.binary}>
                二进制文件 · 无法按文本展示代码差异。
              </div>
            ) : (
              <>
                {file.status === "added" ? (
                  <div className="ck-ex-file-notice added" data-testid={UI.oldAbsent}>
                    新增文件 · 旧版本中不存在，以新侧完整内容展示。
                  </div>
                ) : file.status === "deleted" ? (
                  <div className="ck-ex-file-notice">删除文件 · 保留旧侧代码及评审意见。</div>
                ) : null}
                <div className="ck-ex-file-note">
                  {matching.length
                    ? `${matching.length} 条评审意见`
                    : "未附评审意见 · 不表示已审查通过"}
                </div>
                <div
                  className={`ck-ex-diff-labels ${props.layout === "unified" || file.status === "added" ? "single" : ""}`}
                >
                  <span>
                    {file.status === "added"
                      ? "新增后的内容"
                      : props.layout === "unified"
                        ? "旧行号 / 新行号 · 统一 diff"
                        : "Before · 修改前"}
                  </span>
                  {props.layout === "split" && file.status !== "added" ? (
                    <span>After · 修改后</span>
                  ) : null}
                </div>
                {file.hunks.map((hunk, index) => renderHunk(file, hunk, index))}
              </>
            )}
            {matching
              .filter((finding) => !finding.anchors.some((anchor) => anchor.status === "resolved"))
              .map(renderCard)}
            {props.contexts
              .filter((content) => content.path === file.path || content.path === file.oldPath)
              .map((content) => (
                <section
                  className="ck-ex-source-context"
                  key={`${content.path}:${content.side}`}
                  aria-label="关联源码上下文"
                >
                  <h3>
                    关联上下文 · {content.side === "old" ? "旧" : "新"}侧 ·{" "}
                    {content.sha.slice(0, 12)}
                  </h3>
                  <p>来自同一冻结版本，不计入 diff 新增行数。</p>
                  {content.availability === "available" ? (
                    <CodeRows
                      path={file.path}
                      lines={content.lines.map((line) => ({
                        type: "context",
                        text: line.text,
                        oldLine: content.side === "old" ? line.number : null,
                        newLine: content.side === "new" ? line.number : null,
                      }))}
                      contextSide={content.side}
                      known={known}
                      layout="unified"
                      focus={props.focus}
                    />
                  ) : (
                    <p>
                      {content.availability === "binary"
                        ? "二进制源码无法作为文本读取。"
                        : "这个版本不存在该文件。"}
                    </p>
                  )}
                </section>
              ))}
          </details>
        );
      })}
      {unanchored.length ? (
        <section className="ck-ex-unanchored" data-testid={UI.unanchored}>
          <h2>位置待定位</h2>
          <p>这些意见仍需处理；位置未确认，暂不附到任何代码行。</p>
          {unanchored.map((finding) => (
            <Fragment key={finding.id}>
              <p className="ck-ex-unresolved-ref">
                {finding.anchors
                  .map(
                    (anchor) =>
                      `${anchor.path ?? finding.files.join(", ")}${anchor.line ? `:${anchor.line}` : ""} · ${anchor.reason ?? "未定位"}`,
                  )
                  .join("；")}
              </p>
              {renderCard(finding)}
            </Fragment>
          ))}
        </section>
      ) : null}
    </>
  );
}
