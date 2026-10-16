import { InterruptionMark } from "@/components/report/interruption-mark";
import { Button } from "@/components/ui/Button";
import {
  EXECUTION_SERVICE_INTERRUPTION,
  RE_REVIEW_STARTING_LABEL,
} from "@shared/runtime/interruption-copy";
import { Link } from "react-router-dom";
import { CircleAlertIcon } from "./workbench/icons";

/** Calm interruption card. The title is the page heading when `heading` is h1. */
export function ExecutionInterruptedCard({
  busy,
  onReReview,
  heading,
  error = null,
  errorDetail = null,
}: {
  busy: boolean;
  onReReview: () => void;
  heading: "h1" | "h2";
  /** Shown immediately under the primary button. */
  error?: string | null;
  /** Raw diagnostic inside「详情」, under the same alert. */
  errorDetail?: string | null;
}) {
  const Title = heading;
  const copy = EXECUTION_SERVICE_INTERRUPTION;
  return (
    <section className="ck-interrupt" aria-label={copy.title}>
      <Title className="ck-interrupt-heading">
        <InterruptionMark />
        <span>{copy.title}</span>
      </Title>
      <p>{copy.detail}</p>
      <div className="ck-interrupt-actions">
        <div className="ck-interrupt-primary">
          <Button onClick={onReReview} disabled={busy}>
            {busy ? RE_REVIEW_STARTING_LABEL : copy.primaryAction}
          </Button>
          {error ? (
            <p className="ck-action-error" role="alert">
              <CircleAlertIcon className="ck-wb-icon ck-wb-icon-state" />
              {error}
            </p>
          ) : null}
          {errorDetail ? (
            <details className="ck-action-detail">
              <summary>详情</summary>
              <pre>{errorDetail}</pre>
            </details>
          ) : null}
        </div>
        <Link to="/reports" data-variant="ghost" className="ck-interrupt-secondary">
          {copy.secondaryAction}
        </Link>
      </div>
    </section>
  );
}
