/**
 * QA-PR295-OBS2 (#289, #288): a real task-mode review with open critical /
 * major findings showed 「需要处理」 = 0 in the list, while the report page and
 * `runs list` had no count at all. Fixture is QA's real grok run
 * (qa-env/runs/20261015-2323-councilkit-pr295/real-run-headB): 7 findings
 * (2 critical, 4 major, 1 minor), all open, all out_of_spec, sha null, no PR;
 * aggregator blockingCount 4.
 *
 * Rule (eng decision): 需要处理 = unresolved blocking + critical/major problems,
 * counted after dedupe. 阻塞 = ledger blocking problems: 规格外 (out_of_spec)
 * never blocks (QA-PR295-OBS3), so this run is 6 需要处理 · 0 阻塞.
 * The list, the report page and `runs list` read ONE shared function.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FindingLedger } from "@/components/report/FindingLedger";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { caseNeedsAttention, caseStatusAxis } from "@/lib/report-groups";
import { parseReviewReport } from "@/lib/review-report";
import { computeRunAttention, formatAttentionLabel } from "@shared/runtime/attention-counts";
import { listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { countRealRunsNeedingAttention } from "@shared/runtime/demo-report";
import { cliRunDetailResponseSchema, cliRunsListResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN_ID = "ck-review-188cdfd8-2e7e-482a-af6e-87141ce17a91";
const FIXTURE = join(__dirname, "../fixtures/qa-pr295-task-run");
const EXPECTED = { needsAttention: 6, blocking: 0 };

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

  it("QA-PR295-OBS3 阻塞 comes from the ledger; 规格外 majors never block; aggregator is diagnostic", () => {
    const findings = [f("a", "critical"), f("b", "major")];
    const progress = {
      attempts: [
        {
          role: "aggregator",
          result: { parseStatus: "parsed", summary: "", findingCount: 9, blockingCount: 4 },
        },
      ],
    } as never;
    expect(computeRunAttention({ findings, progress })).toMatchObject({
      needsAttention: 2,
      blocking: 0,
      aggregatorBlocking: 4,
    });
    // Legacy findings.json without contractClass keeps the severity-only gate.
    const legacy = [
      {
        id: "c",
        severity: "major",
        status: "open",
        title: "c",
        text: "c",
        source: "unique",
        reviewer: "r",
        files: [],
      },
    ] as never;
    expect(computeRunAttention({ findings: legacy }).blocking).toBe(1);
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
    // QA-PR295-OBS3: every finding is 规格外, so the ledger gate must not claim blocking.
    expect(html).not.toContain("个阻塞问题，待处理");
  });
});

describe("#304 designer: two-line summary and list-card counts", () => {
  it("report summary: line 1 「N 需要处理 · M 阻塞」, line 2 problems + severities, no 规格外 in summary", () => {
    const home = mkdtempSync(join(tmpdir(), "ck-304-"));
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    try {
      const detail = cliRunDetailResponseSchema.parse(
        readCliRun(RUN_ID, { ...process.env, COUNCILKIT_HOME: home }),
      );
      const html = renderToStaticMarkup(createElement(FindingLedger, { run: detail }));
      expect(html).toContain('<p class="ck-finding-list-summary-primary">6 需要处理 · 0 阻塞</p>');
      expect(html).toContain(
        '<p class="ck-finding-list-summary-secondary">7 个问题 · 2 致命 · 4 重大 · 1 次要</p>',
      );
      const summary = html.slice(
        html.indexOf('class="ck-finding-list-summary"'),
        html.indexOf("</div>", html.indexOf('class="ck-finding-list-summary"')),
      );
      expect(summary).not.toContain("规格外");
      expect(summary).not.toContain("建议修订规格");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("formatAttentionLabel is the one label for cards and the report page", () => {
    expect(formatAttentionLabel({ needsAttention: 6, blocking: 0 })).toBe("6 需要处理 · 0 阻塞");
  });
});
