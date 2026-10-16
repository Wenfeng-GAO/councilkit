/**
 * Screenshot-worthy end-to-end simulation of locus dedupe (Bug A / Codex P1s).
 * Feeds a synthetic multi-finding report through extractFindingsFromReport and
 * writes artifacts/locus-dedupe-sim/{report.html,ledger.json,console.txt}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingBlocking } from "@shared/runtime/cli-ledger";
import { describe, expect, it } from "vitest";
import { extractFindingsFromReport, persistFindingsFromReport } from "../src/auto/ledger";

const OUT_DIR = join(process.cwd(), "artifacts/locus-dedupe-sim");

const SYNTHETIC_REPORT = [
  "# Autonomous Review Report",
  "",
  "- Run: ck-review-locus-dedupe-sim",
  "- Task: synthetic Bug A / Codex P1 simulation (not a live jury re-run)",
  "",
  "---",
  "",
  "## 概览",
  "",
  "Synthetic multi-finding report covering paraphrase collapse, distinct",
  "root causes at one line, and contract-footing fill on collapse.",
  "",
  "## 独有发现",
  "",
  "### review-correctness",
  "",
  // Scenario A — same root cause paraphrases (expect collapse → 1)
  "- [major] 已接受重试在等待运行时未登记导致停机提前返回",
  "  位置：`pkg/runtime/session_recovery.go:446`",
  "  触发与后果：Retry 在 flightsWG.Go 前阻塞，Stop 见 WG=0 提前返回。",
  "",
  // Scenario C earlier — missing footing (will merge with consensus DenyAll)
  "- [major] DenyAll 权限策略未生效",
  "  位置：`internal/auth/policy.go:88`",
  "",
  "## 共识发现",
  "",
  // Scenario A paraphrase
  "- [major] 等待运行时的重试未被托管导致停机提前返回",
  "  位置：`session_recovery.go:446`",
  "  触发与后果：accepted Retry 等待 runtime 时未登记，停机窗口提前结束。",
  "",
  // Scenario C later — has footing (expect merge keeps INV + counterexample)
  "- [major][act-on] permission DenyAll 绕过检查",
  "  位置：`internal/auth/policy.go:88`",
  "  不变量：`INV-DENY-ALL`",
  "  反例：DenyAll 策略下仍放行 /admin",
  "",
  // Scenario B — distinct root causes / invariantIds at same line (expect stay 2)
  "- [major][act-on] 复合语句缺少输入校验允许空载荷",
  "  位置：`src/handler.ts:42`",
  "  不变量：`AC-VALIDATE`",
  "  反例：body={} 仍写入存储",
  "- [major][act-on] 复合语句跳过授权检查可越权写入",
  "  位置：`src/handler.ts:42`",
  "  不变量：`AC-AUTHORIZE`",
  "  反例：role=guest 调用写接口成功",
  "",
  "## 结论",
  "",
  "changes-requested",
  "",
].join("\n");

type RowDump = {
  title: string;
  severity: string;
  invariantId: string | null;
  counterexample: string | null;
  contractClass: string | null;
  blocking: boolean;
  files: string[];
};

function dumpRows(
  label: string,
  findings: Array<{
    title: string;
    severity: string;
    invariantId?: string | null;
    counterexample?: string | null;
    contractClass?: string | null;
    files: string[];
  }>,
): { label: string; count: number; rows: RowDump[] } {
  return {
    label,
    count: findings.length,
    rows: findings.map((row) => ({
      title: row.title,
      severity: row.severity,
      invariantId: row.invariantId ?? null,
      counterexample: row.counterexample ?? null,
      contractClass: row.contractClass ?? null,
      blocking: isFindingBlocking(row as never),
      files: row.files,
    })),
  };
}

function naiveLocusBuckets(markdown: string): {
  label: string;
  count: number;
  rows: { title: string; locus: string; severity: string }[];
} {
  // Pre-fix Bug A behavior sketch: group solely by primary file:line + severity.
  const itemRe = /^- \[(critical|major|minor|nit)\](?:\[[^\]]+\])?\s+(.+)$/gm;
  const locusRe = /((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}):(\d+)(?:-\d+)?/;
  const buckets = new Map<string, { title: string; locus: string; severity: string }>();
  let match = itemRe.exec(markdown);
  while (match) {
    const severity = match[1] ?? "major";
    const title = (match[2] ?? "").trim();
    const after = markdown.slice(match.index, match.index + 400);
    const locusMatch = locusRe.exec(after);
    const locus = locusMatch
      ? `${locusMatch[1]}:${locusMatch[2]}`
      : `no-locus:${title.slice(0, 24)}`;
    const key = `${severity}|${locus.toLowerCase().split("/").pop()}`;
    if (!buckets.has(key)) {
      buckets.set(key, { title, locus, severity });
    }
    match = itemRe.exec(markdown);
  }
  return {
    label: "BEFORE (naive locus+severity only — Bug A)",
    count: buckets.size,
    rows: [...buckets.values()],
  };
}

function renderHtml(input: {
  before: ReturnType<typeof naiveLocusBuckets>;
  afterExtract: ReturnType<typeof dumpRows>;
  afterPersist: ReturnType<typeof dumpRows>;
  checks: { name: string; pass: boolean; detail: string }[];
}): string {
  const rowTable = (rows: Array<Record<string, unknown>>, cols: string[]): string => {
    const head = cols.map((c) => `<th>${c}</th>`).join("");
    const body = rows
      .map((row) => {
        const cells = cols
          .map((c) => {
            const raw = row[c];
            const text =
              raw === null || raw === undefined
                ? "—"
                : Array.isArray(raw)
                  ? raw.join(", ")
                  : String(raw);
            return `<td>${escapeHtml(text)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("\n");
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };

  const checkList = input.checks
    .map(
      (c) =>
        `<li class="${c.pass ? "pass" : "fail"}"><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.detail)}</li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Locus dedupe e2e simulation — PR #191 / Bug A</title>
<style>
  :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 24px; background: #0b1020; color: #e8eefc; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 28px 0 10px; color: #9db7ff; }
  .meta { color: #9aa7c7; font-size: 13px; margin-bottom: 18px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 8px; }
  .card { background: #151b2f; border: 1px solid #2a3558; border-radius: 10px; padding: 14px 16px; min-width: 180px; }
  .card .n { font-size: 32px; font-weight: 700; }
  .card .l { font-size: 12px; color: #9aa7c7; margin-top: 4px; }
  .card.warn .n { color: #ffb454; }
  .card.ok .n { color: #3dd68c; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; background: #12182a; }
  th, td { border: 1px solid #2a3558; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #1a223a; color: #c7d5ff; }
  td { color: #dce6ff; }
  ul.checks { list-style: none; padding: 0; }
  ul.checks li { padding: 8px 12px; margin: 6px 0; border-radius: 8px; }
  ul.checks li.pass { background: #10261c; border: 1px solid #1f6b45; }
  ul.checks li.fail { background: #2a1216; border: 1px solid #8b2e3b; }
  code { background: #1a223a; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Locus dedupe e2e simulation</h1>
  <div class="meta">
    councilkit PR <code>#191</code> · issue <code>#190</code> Bug A · Codex P1-1 / P1-2<br/>
    Path: <code>extractFindingsFromReport</code> + <code>persistFindingsFromReport</code> on a synthetic multi-finding report
  </div>

  <div class="cards">
    <div class="card warn"><div class="n">${input.before.count}</div><div class="l">BEFORE — naive locus+severity buckets</div></div>
    <div class="card ok"><div class="n">${input.afterExtract.count}</div><div class="l">AFTER extract — root-cause gated dedupe</div></div>
    <div class="card ok"><div class="n">${input.afterPersist.count}</div><div class="l">AFTER persist — same ledger</div></div>
  </div>

  <h2>Checks</h2>
  <ul class="checks">
    ${checkList}
  </ul>

  <h2>BEFORE — naive collapse by file:line + severity only</h2>
  <p class="meta">This is the Bug A failure mode: distinct causes at one line wrongly merge.</p>
  ${rowTable(input.before.rows as never, ["severity", "locus", "title"])}

  <h2>AFTER — extractFindingsFromReport (fixed)</h2>
  ${rowTable(input.afterExtract.rows as never, ["severity", "title", "invariantId", "counterexample", "contractClass", "blocking", "files"])}

  <h2>AFTER — persistFindingsFromReport</h2>
  ${rowTable(input.afterPersist.rows as never, ["severity", "title", "invariantId", "counterexample", "contractClass", "blocking", "files"])}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

describe("locus dedupe e2e simulation", () => {
  it("proves paraphrase collapse, distinct-invariant retention, and footing fill", () => {
    const before = naiveLocusBuckets(SYNTHETIC_REPORT);
    const extracted = extractFindingsFromReport({
      markdown: SYNTHETIC_REPORT,
      runId: "ck-review-locus-dedupe-sim",
      extractedAt: "2026-10-12T00:00:00.000Z",
      sha: "b".repeat(40),
    });
    const afterExtract = dumpRows("AFTER extract", extracted.findings);

    const dir = mkdtempSync(join(tmpdir(), "ck-locus-sim-"));
    const persisted = persistFindingsFromReport({
      runDir: dir,
      runId: "ck-review-locus-dedupe-sim",
      sha: "b".repeat(40),
      markdown: SYNTHETIC_REPORT,
      reviewComplete: true,
    });
    rmSync(dir, { recursive: true, force: true });
    const afterPersist = dumpRows("AFTER persist", persisted.findings);

    const retry = extracted.findings.filter(
      (row) =>
        row.text.includes("session_recovery.go") ||
        row.title.includes("重试") ||
        row.title.includes("运行时"),
    );
    const handler = extracted.findings.filter((row) =>
      row.files.some((f) => f.includes("handler.ts")),
    );
    const deny = extracted.findings.filter(
      (row) =>
        row.title.includes("DenyAll") ||
        row.invariantId === "INV-DENY-ALL" ||
        row.text.includes("policy.go"),
    );

    const checks = [
      {
        name: "P1-1 paraphrase collapse",
        pass: retry.length === 1,
        detail: `same-root-cause paraphrases at session_recovery.go:446 → ${retry.length} finding (want 1)`,
      },
      {
        name: "P1-1 distinct invariantIds retained",
        pass: handler.length === 2 && new Set(handler.map((r) => r.invariantId)).size === 2,
        detail: `AC-VALIDATE vs AC-AUTHORIZE at handler.ts:42 → ${handler.length} findings (want 2)`,
      },
      {
        name: "P1-2 contract footing preserved on collapse",
        pass:
          deny.length === 1 &&
          deny[0]?.invariantId === "INV-DENY-ALL" &&
          Boolean(deny[0]?.counterexample) &&
          isFindingBlocking(deny[0]!),
        detail: `DenyAll merge keeps INV-DENY-ALL + counterexample; blocking=${deny[0] ? isFindingBlocking(deny[0]) : false}`,
      },
      {
        name: "Naive before wrongly under-counts distinct causes",
        pass: before.count < afterExtract.count,
        detail: `naive buckets=${before.count}, fixed extract=${afterExtract.count} (fixed keeps validation≠authorization)`,
      },
    ];

    mkdirSync(OUT_DIR, { recursive: true });
    const html = renderHtml({ before, afterExtract, afterPersist, checks });
    writeFileSync(join(OUT_DIR, "report.html"), html, "utf8");
    writeFileSync(
      join(OUT_DIR, "ledger.json"),
      `${JSON.stringify({ before, afterExtract, afterPersist, checks }, null, 2)}\n`,
      "utf8",
    );

    const lines = [
      "=== Locus dedupe e2e simulation (Bug A / Codex P1s) ===",
      "",
      `${before.label}: ${before.count}`,
      ...before.rows.map((r) => `  - [${r.severity}] ${r.locus} :: ${r.title}`),
      "",
      `${afterExtract.label}: ${afterExtract.count}`,
      ...afterExtract.rows.map(
        (r) =>
          `  - [${r.severity}] ${r.title} | inv=${r.invariantId ?? "—"} | blocking=${r.blocking}`,
      ),
      "",
      `${afterPersist.label}: ${afterPersist.count}`,
      ...afterPersist.rows.map(
        (r) =>
          `  - [${r.severity}] ${r.title} | inv=${r.invariantId ?? "—"} | blocking=${r.blocking}`,
      ),
      "",
      "Checks:",
      ...checks.map((c) => `  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
      "",
      `HTML: ${join(OUT_DIR, "report.html")}`,
    ];
    const consoleTxt = `${lines.join("\n")}\n`;
    writeFileSync(join(OUT_DIR, "console.txt"), consoleTxt, "utf8");
    // eslint-disable-next-line no-console
    console.log(consoleTxt);

    expect(checks.every((c) => c.pass)).toBe(true);
    expect(afterExtract.count).toBe(4);
    expect(afterPersist.count).toBe(4);
  });
});
