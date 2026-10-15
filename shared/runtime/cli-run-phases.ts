/**
 * Closed phase lists for a CLI run.
 *
 * Progress parsing, the host JSON schemas, and the repair-phase subset all
 * read these arrays. The strings and their order are the contract.
 */
export const CLI_RUN_PROGRESS_PHASES = [
  "preflight",
  "attempts",
  "aggregating",
  "done",
  "planning",
  "plan-review",
  "plan-aggregating",
  "applying",
  "re-reviewing",
  "briefing",
  "implementing",
  "reviewing",
  "auditing",
  "snapshotting",
  "fixing",
  "integrating",
  "proposing",
  "debating",
  "repair-preparing",
  "repair-squad-repair",
  "repair-squad-verify",
  "repair-publishing",
  "repair-reviewing",
  "repair-diagnosing",
  "repair-finalizing",
] as const;
export type CliRunProgressPhase = (typeof CLI_RUN_PROGRESS_PHASES)[number];

export const CLI_RUN_PIPELINE_PHASES = [
  "planning",
  "plan-review",
  "plan-aggregating",
  "applying",
  "re-reviewing",
  "done",
] as const;
export type CliRunPipelinePhase = (typeof CLI_RUN_PIPELINE_PHASES)[number];
