import { runAgent } from "./commands/agent";
import { runCouncilCmd } from "./commands/council";
/**
 * Command router (plan-a §8). `main.ts` strips the global flags (--json/
 * --help/--version) and hands the leaf command + its args here. Each command
 * owns its own strict parseArgs + zod validation; the router only selects.
 */
import { runDoctor } from "./commands/doctor";
import { runModels } from "./commands/models";
import { runReview } from "./commands/review";
import { runRun } from "./commands/run";
import { errors } from "./errors";
import type { OutputSink } from "./output";

export async function dispatch(command: string, args: string[], out: OutputSink): Promise<void> {
  switch (command) {
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
    case "review":
      return runReview(args, out);
    default:
      throw errors.usage(
        command === undefined
          ? "no command given. Run `councilkit --help` for usage."
          : `unknown command "${command}". Run \`councilkit --help\` for usage.`,
      );
  }
}
