import { InfoIcon } from "@/components/report/workbench/icons";

/** Locked sentence inserted into the Chinese「结论」section when the reporter changes. */
export const REPORTER_FAILOVER_LINE = /^汇总席改由 (.+)（原定 (.+) 没能运行）。$/;

export function splitReporterFailover(body: string): { note: string | null; rest: string } {
  const lines = body.split("\n");
  const note = lines.find((line) => REPORTER_FAILOVER_LINE.test(line.trim()))?.trim() ?? null;
  if (note === null) return { note: null, rest: body };
  return {
    note,
    rest: lines
      .filter((line) => line.trim() !== note)
      .join("\n")
      .trim(),
  };
}

/** Grey info line. Not the amber conflict treatment. */
export function ReporterFailoverNote({ text }: { text: string }) {
  return (
    <p className="ck-reporter-failover">
      <InfoIcon className="ck-wb-icon" />
      <span>{text}</span>
    </p>
  );
}
