import { InterruptionMark } from "@/components/report/interruption-mark";
import { Button } from "@/components/ui/Button";
import {
  EXECUTION_SERVICE_INTERRUPTION,
  RE_REVIEW_STARTING_LABEL,
} from "@shared/runtime/interruption-copy";
import { Link } from "react-router-dom";

/** Calm interruption card. The title is the page heading when `heading` is h1. */
export function ExecutionInterruptedCard({
  busy,
  onReReview,
  heading,
}: {
  busy: boolean;
  onReReview: () => void;
  heading: "h1" | "h2";
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
        <Button onClick={onReReview} disabled={busy}>
          {busy ? RE_REVIEW_STARTING_LABEL : copy.primaryAction}
        </Button>
        <Link to="/reports" data-variant="ghost" className="ck-interrupt-secondary">
          {copy.secondaryAction}
        </Link>
      </div>
    </section>
  );
}
