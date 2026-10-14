/**
 * Exact Reporter instruction text and rendered Markdown for cli/src/report.
 * Expected documents are literals, including empty bodies and blank targets.
 */
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { REPORT_SECTION_HEADINGS, reporterInstruction } from "../src/report/instruction";
import {
  assertNonEmptyMarkdown,
  renderPartialReport,
  renderSuccessReport,
} from "../src/report/render";
import type { CompletedTurn, CouncilSnapshot, RunFailure } from "../src/run/types";

const HEADINGS = [
  "## Background（背景）",
  "## Discussion goal（讨论目标）",
  "## Participating agents（参与角色）",
  "## Discussion summary（讨论摘要）",
  "## Key consensus（关键共识）",
  "## Remaining disagreements（未决分歧）",
  "## Recommendation（推荐）",
  "## Risks and objections（风险与异议）",
  "## Next actions（下一步行动）",
] as const;

const INCOMPLETE_BANNER =
  "> INCOMPLETE RUN — discussion stopped before the Reporter completed. " +
  "What follows is a deterministic partial report built from the persisted transcript; " +
  "no consensus is fabricated and the Reporter did not produce a final summary.";

const council: CouncilSnapshot = {
  id: "c-9",
  name: "Route Council",
  topic: "route local models",
  background: "cost pressure",
  targetOutput: "one-page recommendation",
  rounds: 2,
  reporterAgentId: "a-beta",
  agentIds: ["a-alpha", "a-beta"],
};

const startedAt = "2026-07-22T00:00:00.000Z";
const endedAt = "2026-07-22T00:01:00.000Z";

function instructionDocument(agents: readonly string[], targetLine?: string): string {
  const lines = [
    'You are "Beta", the Reporter of a structured multi-agent council on the topic: route local models.',
    "All ordinary discussion rounds are complete. The shared context above contains every agent's speeches.",
    "Produce the final decision report as Markdown. It MUST strictly contain the following nine sections, each starting with a level-2 Markdown heading (## …), in this exact order:",
    ...HEADINGS,
    'In "Participating agents" and throughout the report, explicitly reference the participating agents by name and cite their points:',
    ...agents.map((name) => `- ${name}`),
    "Do not fabricate consensus that the discussion did not reach. Where agents disagreed, surface the disagreement. Output only the report body.",
  ];
  if (agents.length === 0) lines.splice(lines.length - 1, 0, "");
  if (targetLine !== undefined) lines.push(targetLine);
  return lines.join("\n");
}

function successDocument(participants: string, body: string): string {
  return [
    "# Council Report",
    "",
    "- Run: ck-run-9",
    "- Council: Route Council (c-9)",
    "- Topic: route local models",
    "- Reporter: Beta",
    `- Participants: ${participants}`,
    "- Status: complete",
    `- Started: ${startedAt}`,
    `- Ended: ${endedAt}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function partialDocument(speechLines: readonly string[], failure: RunFailure): string {
  return [
    "# Council Report",
    "",
    "- Run: ck-run-9",
    "- Council: Route Council (c-9)",
    "- Topic: route local models",
    "- Reporter: Beta",
    "- Participants: Alpha, Beta",
    "- Status: incomplete",
    `- Started: ${startedAt}`,
    `- Ended: ${endedAt}`,
    "",
    INCOMPLETE_BANNER,
    "",
    "## Completed speeches",
    "",
    ...speechLines,
    "## Failure",
    "",
    `- Phase: ${failure.phase}`,
    `- Code: ${failure.code}`,
    `- Message: ${failure.message}`,
    "",
    "## Next diagnostics",
    "",
    "- Inspect `transcript.jsonl` for the persisted turns and the `run.finished` record.",
    "- Re-run with a fresh Run id after resolving the failure (V1.1 has no `--resume`).",
    "",
  ].join("\n");
}

function cliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected CliError");
}

describe("reporter instruction text", () => {
  it("lists the nine section headings in order, with the ## prefix", () => {
    expect([...REPORT_SECTION_HEADINGS]).toEqual([...HEADINGS]);
  });

  it("names every agent and appends the trimmed target output", () => {
    const text = reporterInstruction({
      council: {
        topic: "route local models",
        background: "NOT-IN-INSTRUCTION",
        targetOutput: "  one-page recommendation  ",
      },
      agentNames: ["Alpha", "Beta"],
      reporterName: "Beta",
    });
    expect(text).toBe(
      instructionDocument(["Alpha", "Beta"], "Target output: one-page recommendation"),
    );
  });

  it("omits the target line when the target is empty or only whitespace", () => {
    const blankAgents = instructionDocument([]);
    expect(
      reporterInstruction({
        council: { topic: "route local models", background: "cost pressure", targetOutput: "" },
        agentNames: [],
        reporterName: "Beta",
      }),
    ).toBe(blankAgents);
    expect(
      reporterInstruction({
        council: {
          topic: "route local models",
          background: "cost pressure",
          targetOutput: " \n\t ",
        },
        agentNames: [],
        reporterName: "Beta",
      }),
    ).toBe(blankAgents);
  });
});

describe("rendered council reports", () => {
  const base = {
    runId: "ck-run-9",
    startedAt,
    endedAt,
    council,
    reporterName: "Beta",
    participantNames: ["Alpha", "Beta"],
  };

  it("trims the reporter body and places it after the complete header", () => {
    const markdown = renderSuccessReport({
      ...base,
      reporterOutput: "  ## Next actions\n\nship it  ",
    });
    const expected = successDocument("Alpha, Beta", "## Next actions\n\nship it");
    expect(assertNonEmptyMarkdown(markdown)).toBeUndefined();
    expect(markdown).toBe(expected);
  });

  it("substitutes a placeholder when the reporter body is empty or whitespace", () => {
    const expected = successDocument("Alpha, Beta", "_(Reporter produced no body.)_");
    expect(renderSuccessReport({ ...base, reporterOutput: "" })).toBe(expected);
    expect(renderSuccessReport({ ...base, reporterOutput: " \n\t " })).toBe(expected);
    expect(assertNonEmptyMarkdown(expected)).toBeUndefined();
  });

  it("leaves the participants field blank when nobody is listed", () => {
    const markdown = renderSuccessReport({
      ...base,
      participantNames: [],
      reporterOutput: "body",
    });
    expect(markdown).toBe(successDocument("", "body"));
    expect(markdown.split("\n")[6]).toBe("- Participants: ");
  });

  it("renders a zero-turn partial report with the failure and diagnostics", () => {
    const failure: RunFailure = {
      phase: "scope",
      code: "SCOPE_CREATE_FAILED",
      message: "host gone",
    };
    const markdown = renderPartialReport({ ...base, completedTurns: [], failure });
    expect(markdown).toBe(
      partialDocument(["_No ordinary turn completed before the run stopped._", ""], failure),
    );
  });

  it("lists completed speeches in order and does not add a recommendation", () => {
    const failure: RunFailure = { phase: "turn", code: "DRIVER_CRASH", message: "beta crashed" };
    const turns: CompletedTurn[] = [
      {
        agentId: "a-alpha",
        agentName: "Alpha",
        participantId: "p-alpha",
        executionId: "e1",
        output: "I think route A.",
        round: 1,
        turnIndex: 0,
      },
      {
        agentId: "a-beta",
        agentName: "Beta",
        participantId: "p-beta",
        executionId: "e2",
        output: "line one\nline two",
        round: 2,
        turnIndex: 1,
      },
    ];
    const markdown = renderPartialReport({ ...base, completedTurns: turns, failure });
    expect(markdown).toBe(
      partialDocument(
        [
          "### Round 1 — Alpha (participant p-alpha)",
          "",
          "I think route A.",
          "",
          "### Round 2 — Beta (participant p-beta)",
          "",
          "line one\nline two",
          "",
        ],
        failure,
      ),
    );
  });

  it("rejects empty markdown with IO exit 5", () => {
    for (const markdown of ["", " ", "\n", "\t", " \n\t "]) {
      const err = cliError(() => assertNonEmptyMarkdown(markdown));
      expect(err.name).toBe("CliError");
      expect(err.exitCode).toBe(5);
      expect(err.message).toBe("rendered report is empty");
      expect(err.detail).toBeUndefined();
    }
  });
});
