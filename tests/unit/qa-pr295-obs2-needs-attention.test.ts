/**
 * QA-PR295-OBS2 (#289, #288): a real task-mode review with open critical /
 * major findings showed 「需要处理」 = 0 in the list, while the report page and
 * `runs list` had no count at all. Fixture is QA's real grok run
 * (qa-env/runs/20261015-2323-councilkit-pr295/real-run-headB): 7 findings
 * (2 critical, 4 major, 1 minor), all open, all out_of_spec, sha null, no PR;
 * aggregator blockingCount 4.
 *
 * Rule (eng decision): 需要处理 = unresolved blocking + critical/major problems,
 * counted after dedupe; blocking source of truth = aggregator blockingCount.
 * The list, the report page and `runs list` read ONE shared function.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FindingLedger } from "@/components/report/FindingLedger";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { caseNeedsAttention, caseStatusAxis } from "@/lib/report-groups";
import { parseReviewReport } from "@/lib/review-report";
import { computeRunAttention } from "@shared/runtime/attention-counts";
import { listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { countRealRunsNeedingAttention } from "@shared/runtime/demo-report";
import { cliRunDetailResponseSchema, cliRunsListResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN_ID = "ck-review-188cdfd8-2e7e-482a-af6e-87141ce17a91";
const FIXTURE = join(__dirname, "../fixtures/qa-pr295-task-run");
const EXPECTED = { needsAttention: 6, blocking: 4 };

describe("QA-PR295-OBS2 需要处理 counts a real task-mode run's open majors", () => {
  let home: string;
  let oldHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-obs2-"));
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("summary carries the shared attention counts", () => {
    const runs = cliRunsListResponseSchema.parse({ runs: listCliRuns(process.env) }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.attention).toMatchObject(EXPECTED);
  });

  it("list: the case lands under 「需要处理」", () => {
    const runs = cliRunsListResponseSchema.parse({ runs: listCliRuns(process.env) }).runs;
    expect(caseStatusAxis(runs)?.attention).toBe(true);
  });

  it("report page shows the same 需要处理 / 阻塞 numbers", () => {
    const detail = cliRunDetailResponseSchema.parse(readCliRun(RUN_ID, process.env));
    const html = renderToStaticMarkup(createElement(FindingLedger, { run: detail }));
    expect(html).toContain(`${EXPECTED.needsAttention} 需要处理`);
    expect(html).toContain(`${EXPECTED.blocking} 阻塞`);
  });
});

describe("computeRunAttention rules (#289)", () => {
  const f = (id: string, severity: string, status = "open", contractClass = "out_of_spec") =>
    ({
      id,
      severity,
      status,
      title: id,
      text: id,
      contractClass,
      source: "unique",
      reviewer: "r",
      files: [],
    }) as never;

  it("counts open critical/major problems, skips minor and resolved, regardless of SHA", () => {
    const findings = [
      f("a", "critical"),
      f("b", "major"),
      f("c", "minor"),
      f("d", "major", "accepted"),
    ];
    expect(computeRunAttention({ findings, sha: null }).needsAttention).toBe(2);
    expect(computeRunAttention({ findings, sha: "a".repeat(40) }).needsAttention).toBe(2);
  });

  it("blocking comes from the aggregator; ledger only as a fallback", () => {
    const findings = [f("a", "major", "open", "in_contract")];
    const progress = {
      attempts: [
        {
          role: "aggregator",
          result: { parseStatus: "parsed", summary: "", findingCount: 1, blockingCount: 3 },
        },
      ],
    } as never;
    expect(computeRunAttention({ findings, progress })).toMatchObject({
      blocking: 3,
      blockingSource: "aggregator",
    });
    expect(computeRunAttention({ findings }).blockingSource).toBe("ledger");
  });
});

describe("similar-bug sweep: every 需要处理 consumer reads the shared count", () => {
  let home: string;
  let oldHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-obs2-sweep-"));
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("demo-report realRunNeedsAttention / caseNeedsAttention / overview gate agree", () => {
    const runs = cliRunsListResponseSchema.parse({ runs: listCliRuns(process.env) }).runs;
    expect(countRealRunsNeedingAttention(runs)).toBe(1);
    expect(caseNeedsAttention(runs)).toBe(true);
    const demo = runs.map((run) => ({ ...run, demo: true }));
    expect(countRealRunsNeedingAttention(demo)).toBe(0);
    const detail = cliRunDetailResponseSchema.parse(readCliRun(RUN_ID, process.env));
    const html = renderToStaticMarkup(
      createElement(OverviewView, {
        run: detail,
        parsed: parseReviewReport(detail.markdown),
        hasRepair: false,
        onOpenRepair: () => {},
      } as never),
    );
    expect(html).toContain(`${EXPECTED.blocking} 个阻塞问题，待处理`);
  });
});
