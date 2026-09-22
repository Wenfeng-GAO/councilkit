import type { FindingDecision } from "@shared/runtime/review-explainer/contracts";
import { explainerUi as UI } from "./ui";

export function DecisionButtons({
  decision,
  disabled,
  onDecide,
}: {
  decision: FindingDecision;
  disabled: boolean;
  onDecide: (decision: FindingDecision) => void;
}) {
  return (
    <div className="ck-ex-decisions" aria-label="是否修复">
      <button
        type="button"
        data-testid={UI.willFix}
        aria-pressed={decision === "will_fix"}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("will_fix");
        }}
      >
        打算修复
      </button>
      <button
        type="button"
        data-testid={UI.wontFix}
        aria-pressed={decision === "wont_fix"}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("wont_fix");
        }}
      >
        不修复
      </button>
      {decision !== "undecided" ? (
        <button
          type="button"
          className="ck-ex-withdraw"
          data-testid={UI.undecided}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDecide("undecided");
          }}
        >
          撤回选择
        </button>
      ) : (
        <span className="ck-ex-muted">待决定</span>
      )}
    </div>
  );
}
