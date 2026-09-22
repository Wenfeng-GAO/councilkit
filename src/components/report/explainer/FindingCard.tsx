import type { ExplainerFinding, FindingDecision } from "@shared/runtime/review-explainer/contracts";
import { DecisionButtons } from "./DecisionButtons";
import type { CodeLocation } from "./ExplanationDiagram";
import { explainerUi as UI } from "./ui";

export function primaryLocation(finding: ExplainerFinding): CodeLocation | null {
  const anchor =
    finding.anchors.find((candidate) => candidate.status === "resolved") ??
    finding.anchors.find((candidate) => candidate.status === "context");
  return anchor?.path && anchor.side && anchor.line
    ? { path: anchor.path, side: anchor.side, line: anchor.line }
    : null;
}

export function FindingCard({
  finding,
  selected,
  decision,
  busy,
  onSelect,
  onDecide,
  onContext,
  contextPending,
}: {
  finding: ExplainerFinding;
  selected: boolean;
  decision: FindingDecision;
  busy: boolean;
  onSelect: (finding: ExplainerFinding, explain: boolean) => void;
  onDecide: (id: string, decision: FindingDecision) => void;
  onContext: (finding: ExplainerFinding) => void;
  contextPending: boolean;
}) {
  const anchor = primaryLocation(finding);
  return (
    <article
      className={`ck-ex-finding ${selected ? "selected" : ""}`}
      data-testid={UI.comment(finding.id)}
      onClick={() => onSelect(finding, false)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(finding, false);
        }
      }}
      aria-label={`评审意见：${finding.title}`}
    >
      <div className="ck-ex-finding-meta">
        <span>{finding.severity}</span>
        <code>{finding.id}</code>
        <span>
          {anchor ? `${anchor.side === "old" ? "旧" : "新"}侧 L${anchor.line}` : "位置待确认"}
        </span>
      </div>
      <h3>
        <button
          type="button"
          className="ck-ex-finding-title"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(finding, false);
          }}
        >
          {finding.title}
        </button>
      </h3>
      <p className="ck-ex-original-excerpt">{finding.text}</p>
      <div className="ck-ex-card-actions">
        <button
          type="button"
          data-testid={UI.understand}
          className="ck-ex-explain-link"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(finding, true);
          }}
        >
          看懂问题 →
        </button>
        {selected && finding.anchors.some((location) => location.status === "context") ? (
          <button
            type="button"
            disabled={contextPending}
            onClick={(event) => {
              event.stopPropagation();
              onContext(finding);
            }}
          >
            查看关联上下文
          </button>
        ) : null}
        <DecisionButtons
          decision={decision}
          disabled={busy}
          onDecide={(choice) => onDecide(finding.id, choice)}
        />
      </div>
    </article>
  );
}
