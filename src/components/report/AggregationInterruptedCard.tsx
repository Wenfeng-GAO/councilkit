import { Button } from "@/components/ui/Button";
import {
  type InterruptionCode,
  REAGGREGATE_BUSY,
  driftAggregationCard,
  interruptionReason,
} from "@shared/runtime/interruption-copy";
import { Link } from "react-router-dom";

/** Aggregator interruption. Drift uses the designer card; other reasons use the reason enum. */
export function AggregationInterruptedCard({
  tool,
  completedSeats,
  code,
  busy,
  onReaggregate,
}: {
  tool: string;
  completedSeats: number;
  code: InterruptionCode;
  busy: boolean;
  onReaggregate: () => void;
}) {
  const driftCopy = driftAggregationCard(tool, completedSeats);
  const drift = code === "DRIVER_DRIFT";
  const title = drift ? driftCopy.title : "审查汇总被中断";
  const detail = drift ? driftCopy.detail : interruptionReason(code, tool);
  return (
    <section className="ck-interrupt" aria-label={title}>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div className="ck-interrupt-actions">
        <Button onClick={onReaggregate} disabled={busy}>
          {busy ? REAGGREGATE_BUSY : driftCopy.primaryAction}
        </Button>
        <Link to="/reports" data-variant="ghost" className="ck-interrupt-secondary">
          {driftCopy.secondaryAction}
        </Link>
      </div>
      <p className="ck-interrupt-hint">{driftCopy.hint}</p>
    </section>
  );
}
