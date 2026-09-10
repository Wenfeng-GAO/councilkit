import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import { repairPackageSchema } from "@shared/runtime/repair-package";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRepair } from "../src/commands/repair";
import type { OutputSink } from "../src/output";

const id = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
let home: string;
let previous: string | undefined;
const sink: OutputSink = { json: true, progress: () => {}, diag: () => {}, finish: async () => {} };
function seed(options: { incomplete?: boolean; longTranscript?: boolean } = {}) {
  const dir = join(home, "runs", id);
  mkdirSync(dir, { recursive: true });
  const transcript = [
    {
      kind: "review.started",
      runId: id,
      startedAt: "2026-09-07",
      task: { pr: "https://github.com/acme/repo/pull/1" },
    },
    ...(options.longTranscript
      ? [{ kind: "attempt.finished", output: "x".repeat(512 * 1024) }]
      : []),
    {
      kind: "review.finished",
      status: "completed",
      incomplete: options.incomplete ?? false,
      endedAt: "2026-09-07",
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  writeFileSync(join(dir, "transcript.jsonl"), `${transcript}\n`);
  writeFileSync(join(dir, "report.md"), "# review\n");
  writeFileSync(
    join(dir, "findings.json"),
    JSON.stringify({
      version: 1,
      runId: id,
      extractedAt: "2026-09-07",
      sha: "a".repeat(40),
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "close claim",
          severity: "major",
          status: "closed",
          text: "unverified",
          source: "consensus",
          reviewer: "R",
          files: ["src/file.ts"],
        },
      ],
    }),
  );
  return dir;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-repair-"));
  previous = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});
afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
describe("repair export CLI", () => {
  it("exports a complete run with a long transcript, without mutating its ledger", async () => {
    const dir = seed({ longTranscript: true });
    const before = readFileSync(join(dir, "findings.json"), "utf8");
    const out = join(home, "repair.json");
    await runRepair(["export", "--run", id, "--out", out], sink);
    const task = repairPackageSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(task.findings[0]?.id).toBe("F-1");
    expect(task.source.sha).toBe("a".repeat(40));
    expect(readFileSync(join(dir, "findings.json"), "utf8")).toBe(before);
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(true);
  });
  it("rejects partial runs, corrupt locks, and unknown clusters", async () => {
    const dir = seed({ incomplete: true });
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("完整");
    seed();
    await expect(
      runRepair(
        ["export", "--run", id, "--out", join(home, "repair.json"), "--cluster", "missing"],
        sink,
      ),
    ).rejects.toThrow("cluster");
    writeFileSync(join(dir, "plan.lock.json"), "broken");
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("plan.lock");
  });
  it("rejects contradictory failed live state even with a completed transcript", async () => {
    const dir = seed();
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        version: 1,
        status: "failed",
        progress: { phase: "done", attempts: [], updatedAt: "2026-09-07" },
        pipeline: null,
      }),
    );
    expect(readCliRun(id)?.status).toBe("failed");
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("完整");
  });
  it("refuses history output and refuses overwriting an existing file", async () => {
    const dir = seed();
    await expect(
      runRepair(["export", "--run", id, "--out", join(dir, "export.json")], sink),
    ).rejects.toThrow("history");
    const out = join(home, "repair.json");
    writeFileSync(out, "precious");
    await expect(runRepair(["export", "--run", id, "--out", out], sink)).rejects.toThrow(
      "new file",
    );
    expect(readFileSync(out, "utf8")).toBe("precious");
  });
  it("does not accept symlinked ledger evidence or corrupt trailing completion", async () => {
    const dir = seed();
    const ledger = join(dir, "findings.json");
    const original = readFileSync(ledger);
    writeFileSync(join(home, "other.json"), original);
    rmSync(ledger);
    symlinkSync(join(home, "other.json"), ledger);
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(false);
    rmSync(ledger);
    writeFileSync(ledger, original);
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${readFileSync(join(dir, "transcript.jsonl"), "utf8")}broken`,
    );
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(false);
  });
  it("exports two IDs with a shared rootCause from a valid sidecar and refuses a corrupt sidecar", async () => {
    const dir = seed();
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    findings.findings.push({
      id: "F-2",
      title: "alias",
      severity: "major",
      status: "open",
      text: "same hole",
      source: "unique",
      reviewer: "R",
      files: ["src/file.ts"],
    });
    writeFileSync(join(dir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
    const bytes = readFileSync(join(dir, "findings.json"), "utf8");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
    writeFileSync(
      join(dir, "finding-groups.v1.json"),
      `${JSON.stringify({
        version: 1,
        kind: "councilkit-finding-groups",
        source: {
          runId: id,
          sha: "a".repeat(40),
          findingsSha256: hash,
          againstRunId: null,
        },
        groups: [
          {
            rootCauseId: "RC-STABLE-CANCEL",
            findingIds: ["F-1", "F-2"],
            aliases: ["F-2"],
            basis: "shared fixture root",
          },
        ],
      })}\n`,
    );
    const out = join(home, "repair-shared.json");
    await runRepair(["export", "--run", id, "--out", out], sink);
    const task = repairPackageSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(task.findings.map((row) => row.id).sort()).toEqual(["F-1", "F-2"]);
    expect(task.findings.every((row) => row.rootCause === "RC-STABLE-CANCEL")).toBe(true);
    writeFileSync(join(dir, "finding-groups.v1.json"), `${JSON.stringify({ version: 99 })}\n`);
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair-bad.json")], sink),
    ).rejects.toThrow(/finding-groups/);
  });
});
