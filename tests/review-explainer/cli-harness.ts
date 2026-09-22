/** Real CLI orchestration and disk artifacts; only agent subprocess execution is fake. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FindingsFile, parseFindingsFile } from "@shared/runtime/cli-ledger";
import { DRIVER_PROBE_PROMPT } from "../../cli/src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../../cli/src/auto/runner";
import { ReviewExit, runReview } from "../../cli/src/commands/review";
import { Store } from "../../cli/src/store/store";
import { ASSERTION, FINDING, PR_URL } from "./contract";

export function makeSink() {
  const sink = {
    json: false,
    lines: [] as string[],
    finished: undefined as unknown,
    progress(message: string) {
      sink.lines.push(message);
    },
    diag(message: string) {
      sink.lines.push(message);
    },
    async finish(value: unknown) {
      sink.finished = value;
    },
  };
  return sink;
}

export function fakeCliPath(home: string, originalPath: string | undefined): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "cld"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "cld"), 0o755);
  return `${bin}${originalPath ? `:${originalPath}` : ""}`;
}

export function seedAgents() {
  const store = new Store();
  const selection = {
    driverId: "claude-stream-json" as const,
    options: { route: "cfuse" as const },
  };
  const agents = ["Alice", "Bob"].map((name) =>
    store.createAgent({
      name,
      personaPrompt: "Inspect supplied evidence",
      modelId: "fixture-model",
      color: "#112233",
      driverSelection: selection,
    }),
  );
  return { ids: agents.map((row) => row.id), reporter: "Bob" };
}

export function claudeEnvelope(text: string): SpawnOutput {
  return {
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  };
}

export const BUSY_REPORT_LINE = `- [major] \`${FINDING.busy}\` — ${ASSERTION.busy} src/busy.go:23`;
export const NEW_REPORT_LINE = `- [major] \`${FINDING.freshSameFile}\` — ${ASSERTION.newBusyMechanism} src/busy.go:24`;

export function reportOutput(lines: string[], aggregator: boolean, assessment = ""): string {
  return [
    aggregator
      ? "## Overview\nSynthetic deterministic review\n## Consensus findings"
      : "## Findings",
    ...lines,
    aggregator ? "## Unique findings\n\n## Disagreements" : "## Verification\n未验证",
    assessment,
    "## Verdict",
    "comment",
  ].join("\n");
}

export function readLedger(home: string, runId: string): FindingsFile {
  const parsed = parseFindingsFile(
    readFileSync(join(home, "runs", runId, "findings.json"), "utf8"),
  );
  if (!parsed) throw new Error(`invalid persisted findings in ${runId}`);
  return parsed;
}

export async function runSyntheticReview(input: {
  home: string;
  repo: string;
  agents: ReturnType<typeof seedAgents>;
  prUrl?: string;
  against?: string;
  extraArgs?: string[];
  lines?: string[];
  output?: (spawn: SpawnInput, aggregator: boolean) => string;
}) {
  const calls: SpawnInput[] = [];
  const spawn: SpawnImpl = async (spec) => {
    calls.push(spec);
    if (spec.prompt === DRIVER_PROBE_PROMPT) return claudeEnvelope("ok");
    const aggregator = spec.prompt.includes("对比汇总");
    return claudeEnvelope(
      input.output?.(spec, aggregator) ??
        reportOutput(input.lines ?? [BUSY_REPORT_LINE, NEW_REPORT_LINE], aggregator),
    );
  };
  const sink = makeSink();
  try {
    await runReview(
      [
        input.prUrl ?? PR_URL,
        "--repo",
        input.repo,
        "--agents",
        JSON.stringify(input.agents.ids),
        "--aggregator",
        input.agents.reporter,
        ...(input.against ? ["--against", input.against] : []),
        ...(input.extraArgs ?? []),
      ],
      sink,
      { spawnImpl: spawn, worktreeRef: "HEAD" },
    );
  } catch (error) {
    if (!(error instanceof ReviewExit) || error.exitCode !== 0) throw error;
  }
  const outcome = sink.finished as { runId: string; status: string; exitCode: number } | undefined;
  if (!outcome?.runId || outcome.exitCode !== 0)
    throw new Error(`Review did not complete: ${JSON.stringify(sink.finished)}`);
  return { ...outcome, sink, calls, ledger: readLedger(input.home, outcome.runId) };
}

/** Real successor commit, so --against tests do not accidentally exercise the same-SHA guard. */
export function commitCandidate(repo: string, name: string): string {
  writeFileSync(join(repo, "candidate-receipt.txt"), `${name}\n`);
  execFileSync("git", ["add", "candidate-receipt.txt"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", name], { cwd: repo, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}
