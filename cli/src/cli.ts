import { runAgent } from "./commands/agent";
import { runApply } from "./commands/apply";
import { runCouncilCmd } from "./commands/council";
/**
 * Command router (plan-a §8). `main.ts` strips the global flags (--json/
 * --help/--version) and hands the leaf command + its args here. Each command
 * owns its own strict parseArgs + zod validation; the router only selects.
 */
import { runDoctor } from "./commands/doctor";
import { runFix } from "./commands/fix";
import { runIdeate } from "./commands/ideate";
import { runInit } from "./commands/init";
import { runJury } from "./commands/jury";
import { runModels } from "./commands/models";
import { runRepair } from "./commands/repair";
import { runReview } from "./commands/review";
import { runRun } from "./commands/run";
import { runRuns } from "./commands/runs";
import { errors } from "./errors";
import type { OutputSink } from "./output";

export async function dispatch(command: string, args: string[], out: OutputSink): Promise<void> {
  switch (command) {
    case "jury":
      return runJury(args, out);
    case "init":
      return runInit(args, out);
    case "ideate":
      return runIdeate(args, out);
    case "doctor":
      return runDoctor(args, out);
    case "models":
      return runModels(args, out);
    case "agent":
      return runAgent(args, out);
    case "council":
      return runCouncilCmd(args, out);
    case "run":
      return runRun(args, out);
    case "runs":
      return runRuns(args, out);
    case "repair":
      return runRepair(args, out);
    case "review":
      return runReview(args, out);
    case "apply":
      return runApply(args, out);
    case "fix":
      return runFix(args, out);
    default:
      throw errors.usage(
        command === undefined
          ? "no command given. Run `councilkit --help` for usage."
          : `unknown command "${command}". Run \`councilkit --help\` for usage.`,
      );
  }
}
