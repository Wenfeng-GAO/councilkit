/**
 * `councilkit demo` — write one completed sample review.
 *
 * No model calls, no network, and no read of the caller's code. A clean
 * machine can open the printed report URL and see a realistic decision.
 *
 * CI-03 will call `councilkit demo --json` and grep `"demo": true`.
 */
import { DEMO_SAMPLE_TITLE } from "@shared/runtime/demo-report";
import { materializeDemo } from "@shared/runtime/materialize-demo";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { parseFlags } from "./parse";

export { buildDemoReportMarkdown } from "@shared/runtime/materialize-demo";

export async function runDemo(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    { flags: { json: { type: "boolean" }, new: { type: "boolean" } }, allowPositionals: 0 },
    argv,
  );
  let result: ReturnType<typeof materializeDemo>;
  try {
    result = materializeDemo({ forceNew: values.new === true });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "CliError") throw cause;
    throw errors.io("demo: failed to write the sample run", {
      cause: cause instanceof Error ? cause.name : "IOFailure",
    });
  }
  await out.finish(
    {
      runId: result.runId,
      demo: true,
      reportUrl: result.reportUrl,
      title: DEMO_SAMPLE_TITLE,
      ...(result.reused ? { reused: true } : {}),
    },
    () =>
      result.reused ? `示例报告已存在 ${result.reportUrl}` : `示例报告已生成 ${result.reportUrl}`,
  );
}
