import { CLI_RUN_PIPELINE_PHASES, CLI_RUN_PROGRESS_PHASES } from "@shared/runtime/cli-run-phases";
import { REPAIR_PROGRESS_PHASES } from "@shared/runtime/repair-gate";
import { cliRunPipelineSchema, cliRunProgressSchema } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

describe("cli run phase lists", () => {
  it("keeps the progress schema on the shared list, in order", () => {
    expect(cliRunProgressSchema.shape.phase.options).toEqual([...CLI_RUN_PROGRESS_PHASES]);
  });

  it("keeps the pipeline schema on the shared list, in order", () => {
    expect(cliRunPipelineSchema.shape.phase.options).toEqual([...CLI_RUN_PIPELINE_PHASES]);
  });

  it("derives repair phases from the shared progress list", () => {
    expect([...REPAIR_PROGRESS_PHASES]).toEqual([
      "repair-preparing",
      "repair-squad-repair",
      "repair-squad-verify",
      "repair-publishing",
      "repair-reviewing",
      "repair-diagnosing",
      "repair-finalizing",
    ]);
    expect(CLI_RUN_PROGRESS_PHASES.filter((phase) => phase.startsWith("repair-"))).toEqual([
      ...REPAIR_PROGRESS_PHASES,
    ]);
  });

  it("accepts listed phases and rejects phases from the other list", () => {
    expect(cliRunProgressSchema.shape.phase.safeParse("repair-finalizing").success).toBe(true);
    expect(cliRunProgressSchema.shape.phase.safeParse("not-a-phase").success).toBe(false);
    expect(cliRunPipelineSchema.shape.phase.safeParse("planning").success).toBe(true);
    expect(cliRunPipelineSchema.shape.phase.safeParse("preflight").success).toBe(false);
  });
});
